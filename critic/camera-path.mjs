/**
 * Walks the CAMERA path (camera check → ROM calibration → latency) against Chromium's fake webcam,
 * which produces a synthetic pattern with no person in it. Nothing can be calibrated from that, so
 * this asserts the screens survive a camera that yields no landmarks — the failure mode that would
 * otherwise strand a clinic mid-session — and captures screenshots for review.
 *
 *   node critic/camera-path.mjs [--headed] [--url http://localhost:5173]
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SHOT_DIR = resolve(HERE, 'screenshots');
const PORT = Number(process.env.SMOKE_PORT ?? 5174);
const args = process.argv.slice(2);
const urlArg = args.includes('--url') ? args[args.indexOf('--url') + 1] : null;
const BASE = urlArg ?? `http://localhost:${PORT}`;

async function waitForServer(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up */
    }
    if (Date.now() > deadline) throw new Error(`server ${url} never came up`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

const log = (...m) => console.log('[camera]', ...m);

async function main() {
  mkdirSync(SHOT_DIR, { recursive: true });
  let server = null;
  if (!urlArg) {
    server = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stderr.on('data', (d) => process.stderr.write(`[vite] ${d}`));
    await waitForServer(BASE);
  }
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium',
    headless: !args.includes('--headed'),
    args: [
      '--no-sandbox',
      '--autoplay-policy=no-user-gesture-required',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--use-gl=swiftshader',
    ],
  });
  const failures = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    await page.context().grantPermissions(['camera'], { origin: BASE });

    await page.goto(`${BASE}/`, { waitUntil: 'load' });
    await page.waitForTimeout(1200);
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.__beatRehab, null, { timeout: 20_000 });

    await page.getByTestId('start-session').click();
    await page.getByTestId('mode-leg').click();
    await page.getByTestId('setup-start').click();
    log('on camera check');
    await page.waitForSelector('[data-testid="camera-continue"]', { timeout: 15_000 });
    await page.waitForTimeout(9000); // model download + first inferences
    await page.screenshot({ path: resolve(SHOT_DIR, 'camera-check.png') });

    const vision = await page.evaluate(() => {
      const v = window.__beatRehab.runtime.peekVision?.();
      if (!v) return null;
      const s = v.getStatus();
      return { running: v.isRunning(), reason: s.reason, fps: s.fps, delegate: s.delegate, message: s.message };
    });
    log('vision', JSON.stringify(vision));
    if (!vision) failures.push('no VisionInput was created by the camera check');
    else if (!vision.running) failures.push(`vision not running (${vision.reason}: ${vision.message})`);

    await page.getByTestId('camera-continue').click();
    await page.waitForSelector('[data-testid="rom-redo"]', { timeout: 10_000 });
    await page.waitForTimeout(3000);
    await page.screenshot({ path: resolve(SHOT_DIR, 'rom-calibration.png') });
    log('on ROM calibration');

    // Nothing is calibratable from a test pattern, so the Next button must stay disabled rather than
    // letting an uncalibrated lane into the session.
    const nextDisabled = await page.getByTestId('rom-next').isDisabled();
    if (!nextDisabled) failures.push('ROM screen offered to continue with no calibration');

    if (errors.length) failures.push(`page errors: ${errors.slice(0, 4).join(' | ')}`);
  } catch (err) {
    failures.push(`threw: ${err?.stack ?? err}`);
  } finally {
    await browser.close();
    if (server) server.kill('SIGTERM');
  }
  if (failures.length) {
    console.error('[camera] FAILED');
    for (const f of failures) console.error('  -', f);
    process.exit(1);
  }
  console.log('[camera] PASSED');
  process.exit(0);
}
main();
