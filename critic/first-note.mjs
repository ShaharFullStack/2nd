/**
 * HOW LONG A THERAPIST WAITS BEFORE THE PATIENT CAN MOVE — measured, not remembered.
 *
 * A rhythm game is judged on how fast you get to play, and a clinic tablet is on clinic wifi with a
 * patient already in position. This is the harness behind the numbers in README ("Time to the first
 * note"): a PRODUCTION build, served by `vite preview`, driven over a throttled link (8 Mbit/s down,
 * 40 ms latency, HTTP cache disabled — a tablet that has never seen this song), from the Home screen
 * to the first note of the song actually being answered.
 *
 * Two figures per scenario, both from inside the page:
 *   - BYTES AFTER START: every byte the page pulls after the therapist presses Start. This is the
 *     part the patient stands through; anything downloaded before it was free.
 *   - START → FIRST NOTE: from the Start click to the autoplay bot answering note one
 *     (`getScore().hits > 0`), which includes the load, the count-in and the first note's travel.
 *
 * The scenarios are the real range: pressing Start the instant Setup appears (the worst case, and
 * the one a re-play or a demo hits), and the same run after the therapist has spent a few seconds
 * writing the prescription, which is what the song prefetch is for. A camera session has the camera
 * check, the ROM calibration and the latency calibration between Setup and Play, so it is always
 * further down this table than the longest dwell here.
 *
 *   node critic/first-note.mjs                 # build, then measure every scenario
 *   node critic/first-note.mjs --no-build      # reuse the dist/ that is already there
 *   node critic/first-note.mjs --dwell 0,20    # only these dwells (seconds on Setup before Start)
 *   node critic/first-note.mjs --no-repeat     # skip the "second session on the same tablet" row
 *
 * Prints a markdown table; nothing is written to the repo.
 */
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const EXECUTABLE = '/opt/pw-browsers/chromium';
const PORT = Number(process.env.FIRSTNOTE_PORT ?? 5431);
const BASE = `http://localhost:${PORT}`;
const args = process.argv.slice(2);
const skipBuild = args.includes('--no-build');
const dwells = args.includes('--dwell')
  ? args[args.indexOf('--dwell') + 1].split(',').map(Number)
  : [0, 6, 20];
const log = (...m) => console.log('[first-note]', ...m);

/** 8 Mbit/s down, 40 ms of latency — a clinic's shared wifi, not a developer's fibre. */
const THROTTLE = {
  offline: false,
  downloadThroughput: (8 * 1024 * 1024) / 8,
  uploadThroughput: (8 * 1024 * 1024) / 8,
  latency: 40,
};

function run(cmd, cmdArgs) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, cmdArgs, { cwd: ROOT, stdio: 'inherit', env: process.env });
    p.on('exit', (code) => (code === 0 ? res() : rej(new Error(`${cmd} exited ${code}`))));
  });
}

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

/** Home → Leg → (dwell) → Start → first note, on a page that is already open. */
async function oneRun(page, dwellSec, bytesNow) {
  await page.getByTestId('start-session').click();
  await page.getByTestId('mode-leg').click();
  await page.waitForSelector('[data-testid="setup-start"]', { timeout: 120_000 });
  if (dwellSec > 0) await page.waitForTimeout(dwellSec * 1000);
  const bytesBeforeStart = bytesNow();
  const t0 = Date.now();
  await page.getByTestId('setup-start').click();
  // The bot answers note one the moment it is answerable: load, count-in and travel included.
  await page.waitForFunction(() => (window.__beatRehab.getScore()?.hits ?? 0) > 0, null, { timeout: 180_000 });
  return { ms: Date.now() - t0, afterStart: bytesNow() - bytesBeforeStart };
}

async function measure(browser, dwellSec, { repeat = false, clearAppCache = false } = {}) {
  // A FRESH CONTEXT PER SCENARIO: an incognito context with the cache disabled at the protocol level
  // is the only honest version of "a tablet that has never played this song".
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await cdp.send('Network.emulateNetworkConditions', THROTTLE);

  let bytes = 0;
  cdp.on('Network.dataReceived', (e) => {
    bytes += e.encodedDataLength > 0 ? e.encodedDataLength : e.dataLength;
  });
  cdp.on('Network.loadingFinished', (e) => {
    // dataReceived carries the body; loadingFinished's total includes headers for the last chunk.
    if (e.encodedDataLength === 0) return;
  });

  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message)));

  await page.goto(`${BASE}/?input=autoplay`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__beatRehab, null, { timeout: 120_000 });
  let run = await oneRun(page, dwellSec, () => bytes);

  if (repeat) {
    // THE NEXT PATIENT ON THE SAME TABLET. A full page load (the HTTP cache is still disabled, so
    // the bundle really is fetched again) in the SAME origin, which is what keeps the app's own stem
    // cache. This is the common case in a clinic and it used to cost the same 12 MB as the first.
    //
    // `clearAppCache` empties Cache Storage in between, which is exactly how this path behaved
    // before `src/session/stemCache.ts` existed — so the "before" half of the README's table is
    // measured here rather than assumed.
    if (clearAppCache) {
      await page.evaluate(async () => {
        if (typeof caches === 'undefined') return;
        for (const key of await caches.keys()) await caches.delete(key);
      });
    }
    await page.goto(`${BASE}/?input=autoplay`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.__beatRehab, null, { timeout: 120_000 });
    if (clearAppCache) {
      await page.evaluate(async () => {
        if (typeof caches === 'undefined') return;
        for (const key of await caches.keys()) await caches.delete(key);
      });
    }
    run = await oneRun(page, dwellSec, () => bytes);
  }

  await context.close();
  return { dwellSec, repeat, ...run, errors };
}

const mb = (n) => `${(n / 1_000_000).toFixed(2)} MB`;

async function main() {
  if (!skipBuild) {
    log('building the production bundle');
    await run('npm', ['run', 'build']);
  }
  log(`serving dist/ on :${PORT}`);
  const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  server.stderr.on('data', (d) => process.stderr.write(`[preview] ${d}`));
  await waitForServer(BASE);

  const browser = await chromium.launch({
    executablePath: EXECUTABLE,
    headless: true,
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--use-gl=swiftshader'],
  });

  const rows = [];
  try {
    for (const dwell of dwells) {
      log(`measuring: ${dwell} s on the Setup screen before Start`);
      const r = await measure(browser, dwell);
      log(`  ${mb(r.afterStart)} after Start · ${(r.ms / 1000).toFixed(1)} s to the first note` + (r.errors.length ? ` · page errors: ${r.errors[0]}` : ''));
      rows.push(r);
    }
    if (!args.includes('--no-repeat')) {
      for (const clearAppCache of [true, false]) {
        log(`measuring: a second session on the same tablet (reloaded, no dwell)${clearAppCache ? ', with the app stem cache emptied first' : ''}`);
        const r = await measure(browser, 0, { repeat: true, clearAppCache });
        log(`  ${mb(r.afterStart)} after Start · ${(r.ms / 1000).toFixed(1)} s to the first note` + (r.errors.length ? ` · page errors: ${r.errors[0]}` : ''));
        rows.push({ ...r, clearAppCache });
      }
    }
  } finally {
    await browser.close();
    server.kill('SIGTERM');
  }

  console.log('\n| Setup dwell before Start | bytes after Start | Start → first note |');
  console.log('| --- | --- | --- |');
  for (const r of rows) {
    const when = r.repeat
      ? `none — second session on the same tablet (reloaded)${r.clearAppCache ? ', stem cache emptied' : ''}`
      : r.dwellSec === 0
        ? 'none (Start pressed on sight)'
        : `${r.dwellSec} s`;
    console.log(`| ${when} | ${mb(r.afterStart)} | ${(r.ms / 1000).toFixed(1)} s |`);
  }
  console.log('\n8 Mbit/s down, 40 ms latency, HTTP cache disabled, production build via vite preview.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
