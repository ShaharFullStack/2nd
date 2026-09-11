/**
 * AUDITIONING A SONG, MEASURED — INCLUDING BEHIND A PROXY THAT STRIPS `Range`.
 *
 * Two runs against the real app:
 *
 *   1. NORMAL. The dev server honours Range, so the audition should transfer roughly the twelve
 *      seconds it plays, in a handful of ranged requests.
 *   2. RANGE-STRIPPED. Every stem request is answered 200 with the WHOLE file, which is what a
 *      hospital proxy does. The audition must then: cancel each refused stream instead of letting it
 *      arrive, probe ONE stem rather than all of them, say on screen that it is loading the whole
 *      song, and stay stoppable throughout.
 *
 * Bytes are counted in the route handler, so the number printed is what the page actually asked for
 * and would have received.
 *
 *   node critic/audition-cost.mjs [--headed]
 *
 * Writes critic/screenshots/audition-*.png.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SHOT_DIR = resolve(HERE, 'screenshots');
const EXECUTABLE = '/opt/pw-browsers/chromium';
const PORT = Number(process.env.AUDITION_PORT ?? 5391);
const BASE = `http://localhost:${PORT}`;
const headed = process.argv.includes('--headed');

const log = (...m) => console.log('[audition]', ...m);
const mb = (n) => `${(n / 1_000_000).toFixed(2)} MB`;

async function waitForServer(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server at ${url} did not come up`);
}

/** Click through Home → Mode → Setup and wait for the song catalog. */
async function toSetup(page) {
  await page.goto(`${BASE}/?input=keyboard`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__beatRehab, null, { timeout: 20_000 });
  await page.getByTestId('start-session').click();
  await page.getByTestId('mode-leg').click();
  await page.waitForSelector('[data-testid="setup-start"]');
  await page.waitForSelector('[data-testid^="preview-demo"]');
  await page.waitForTimeout(300);
}

async function main() {
  mkdirSync(SHOT_DIR, { recursive: true });
  log(`starting vite on :${PORT}`);
  const server = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  server.stderr.on('data', (d) => process.env.AUDITION_VERBOSE && process.stderr.write(`[vite] ${d}`));
  await waitForServer(BASE);

  const browser = await chromium.launch({
    executablePath: EXECUTABLE,
    headless: !headed,
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--use-gl=swiftshader'],
  });

  const failures = [];
  const report = {};
  try {
    // ------------------------------------------------------------------ 1. the server ranges
    {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      let bytes = 0;
      let requests = 0;
      page.on('response', async (res) => {
        if (!/\/songs\/.*\/stems\//.test(res.url())) return;
        requests++;
        try {
          bytes += (await res.body()).byteLength;
        } catch {
          /* cancelled before the body landed — which is the point, and costs nothing */
        }
      });
      await toSetup(page);
      const t0 = Date.now();
      await page.getByTestId('preview-demo-groove').click();
      await page.waitForFunction(
        () => (document.querySelector('[data-testid="preview-demo-groove"]')?.textContent ?? '').includes('Stop') &&
          (document.querySelector('[data-testid="preview-status-demo-groove"]')?.textContent ?? '').includes('Playing'),
        null,
        { timeout: 30_000 },
      );
      report.normal = { bytes, requests, ms: Date.now() - t0 };
      log(`ranged audition: ${mb(bytes)} over ${requests} stem requests in ${report.normal.ms} ms`);
      await page.screenshot({ path: resolve(SHOT_DIR, 'audition-normal.png') });
      if (bytes > 8_000_000) failures.push(`ranged audition transferred ${mb(bytes)} — it should be a few MB`);
      await page.close();
    }

    // ------------------------------------------------------- 2. a proxy that ignores Range headers
    {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      let bytes = 0;
      let requests = 0;
      const rangeAsked = [];
      // A stream the page CANCELS shows up as a failed request. That is the fix, observed directly:
      // the probe the server answered with a whole file must be aborted, not consumed.
      const aborted = [];
      page.on('requestfailed', (req) => {
        if (/\/songs\/.*\/stems\//.test(req.url())) aborted.push(req.failure()?.errorText ?? 'failed');
      });
      // The proxy: every stem request is answered with the whole file and status 200, Range ignored.
      await page.route('**/songs/**/stems/**', async (route) => {
        const req = route.request();
        requests++;
        rangeAsked.push(req.headers().range ?? 'none');
        const file = resolve(ROOT, 'public', new URL(req.url()).pathname.replace(/^\//, ''));
        let body;
        try {
          body = readFileSync(file);
        } catch {
          await route.abort();
          return;
        }
        // A HEAD carries no body — the manifest's stem-existence probes must not be counted as traffic.
        if (req.method() === 'HEAD') {
          await route.fulfill({ status: 200, headers: { 'content-type': 'audio/wav', 'content-length': String(body.byteLength) } });
          return;
        }
        bytes += body.byteLength;
        await route.fulfill({ status: 200, headers: { 'content-type': 'audio/wav' }, body });
      });

      await toSetup(page);
      await page.getByTestId('preview-demo-groove').click();
      // The fallback is a whole-song load: wait for the screen to SAY so.
      await page.waitForFunction(
        () => (document.querySelector('[data-testid="preview-status-demo-groove"]')?.textContent ?? '').length > 0,
        null,
        { timeout: 30_000 },
      );
      // The fallback is a whole-song download: give it long enough to have said so.
      await page.waitForFunction(
        () => /Whole song/.test(document.querySelector('[data-testid="preview-status-demo-groove"]')?.textContent ?? ''),
        null,
        { timeout: 60_000 },
      ).catch(() => undefined);
      const status = await page.getByTestId('preview-status-demo-groove').textContent();
      const button = page.getByTestId('preview-demo-groove');
      const label = await button.textContent();
      const disabled = await button.isDisabled();
      const otherDisabled = await page.getByTestId('preview-demo-sunrise').isDisabled();
      await page.screenshot({ path: resolve(SHOT_DIR, 'audition-no-range.png') });

      log('status line :', JSON.stringify(status));
      log('button      :', JSON.stringify(label), 'disabled=', disabled, 'other disabled=', otherDisabled);
      log('range asked :', JSON.stringify(rangeAsked));
      log(`stem requests: ${requests}, offered bytes ${mb(bytes)}`);

      // The probe must be ONE request, not one per stem.
      const probes = rangeAsked.filter((r) => r.startsWith('bytes=0-8191')).length;
      if (probes !== 1) failures.push(`expected exactly 1 range probe against a Range-stripping server, saw ${probes}`);
      log('aborted     :', JSON.stringify(aborted));
      if (aborted.length < 1) failures.push('the refused whole-file stream was not cancelled — it downloaded into the void');
      if (disabled) failures.push('the button being pressed is disabled — there is no way to cancel');
      if (!/Stop/.test(label ?? '')) failures.push(`the pressed button reads ${JSON.stringify(label)}, not a Stop`);
      if (!otherDisabled) failures.push('the other Listen button should be held while a press is in flight');
      if (!/MB|kB/.test(status ?? '')) failures.push('no byte figure on screen while it downloads');
      if (!/Whole song/.test(status ?? '')) failures.push('the screen does not say it fell back to the whole song');

      // …and pressing it again must actually stop it.
      await button.click();
      await page.waitForFunction(
        () => (document.querySelector('[data-testid="preview-demo-groove"]')?.textContent ?? '').includes('Listen'),
        null,
        { timeout: 15_000 },
      );
      const afterBytes = bytes;
      await page.waitForTimeout(1200);
      log(`after cancel: ${mb(bytes - afterBytes)} more offered (should be ~0)`);
      await page.screenshot({ path: resolve(SHOT_DIR, 'audition-cancelled.png') });
      report.stripped = { requests, offeredBytes: bytes, probes, abortedStreams: aborted.length, status, label, disabled, otherDisabled };
      await page.close();
    }
  } finally {
    await browser.close();
    server.kill('SIGTERM');
  }

  console.log(JSON.stringify(report, null, 2));
  if (failures.length > 0) {
    for (const f of failures) console.error('[audition] FAIL', f);
    process.exit(1);
  }
  log('PASSED');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
