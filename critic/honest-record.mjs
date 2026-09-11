/**
 * WHAT A THERAPIST ACTUALLY READS, after a session that did not finish.
 *
 * Two things this drives in the real app and photographs:
 *
 *   1. HISTORY. Three camera sessions for one patient — one complete, two cut short (one the
 *      therapist stopped, one the tablet took away). The trend card must say how many ended early
 *      instead of averaging a nine-rep walk-out into "72 %, no change", and each row must say WHICH
 *      exit it was.
 *   2. THE PAUSE OVERLAY. Hide the tab mid-song: the run pauses itself, and the dialog a returning
 *      therapist reads must lead with WHY it stopped — not with the chart generator's note-density
 *      arithmetic, which used to be the biggest block on it.
 *
 *   node critic/honest-record.mjs [--headed]
 *
 * Writes critic/screenshots/honest-history.png and critic/screenshots/honest-pause.png.
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SHOT_DIR = resolve(HERE, 'screenshots');
const EXECUTABLE = '/opt/pw-browsers/chromium';
const PORT = Number(process.env.HONEST_PORT ?? 5392);
const BASE = `http://localhost:${PORT}`;
const headed = process.argv.includes('--headed');
const log = (...m) => console.log('[honest]', ...m);

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

/** Three sessions for one patient: a full one, a therapist stop, and an interrupted one. */
function seed() {
  const PATIENT = 'p-seed';
  const laneOf = (rom, acc, reps) => ({
    lane: 0,
    movement: 'knee_extension',
    side: 'left',
    movementName: 'Left knee extension',
    hits: Math.round(reps * acc), perfects: 2, goods: 2, misses: 2, judged: reps, accuracy: acc, reps,
    timingBiasMs: null, timingBiasMadMs: null,
    romMean: rom, romBest: rom + 0.08, romSamples: reps, romUncertain: 0,
    calibratedMin: 20, calibratedMax: 80, calibrationManual: false,
    compensationKind: null, compensationMonitored: false, compensationFlags: 0, compensationWorst: null,
  });
  const s = (id, at, rom, acc, reps, durationSec, completed, endReason) => ({
    id, patientId: PATIENT, patientName: 'Alice Fernandez',
    startedAt: at, endedAt: at + durationSec * 1000, durationSec,
    mode: 'leg', difficulty: 'medium', windowScale: 1, inputMode: 'camera',
    songId: 'demo-groove', songTitle: 'Groove Circuit', artist: 'Beat Rehab demo', attribution: '',
    score: 900, stars: 3, accuracy: acc, starAccuracy: acc, maxCombo: 6, totalNotes: reps,
    hits: Math.round(reps * acc), perfects: 2, goods: 2, misses: 2, reps,
    answerRate: 1, health: 1,
    timingBiasMs: null, timingBiasMadMs: null, latencyOffsetMs: 120, suggestedLatencyMs: null,
    completed, endReason, lanes: [laneOf(rom, acc, reps)],
  });
  const day = 86_400_000;
  const now = Date.now();
  return {
    patients: [{ id: PATIENT, name: 'Alice Fernandez', createdAt: now - 9 * day, lastUsedAt: now }],
    active: PATIENT,
    history: [
      s('s3', now - 1 * day, 0.4, 0.5, 9, 12, false, 'abandoned'),
      s('s2', now - 3 * day, 0.62, 0.66, 33, 41, false, 'quit'),
      s('s1', now - 6 * day, 0.72, 0.8, 88, 97, true, 'chart'),
    ],
  };
}

async function main() {
  mkdirSync(SHOT_DIR, { recursive: true });
  log(`starting vite on :${PORT}`);
  const server = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: process.env,
  });
  server.stderr.on('data', (d) => process.env.HONEST_VERBOSE && process.stderr.write(`[vite] ${d}`));
  await waitForServer(BASE);

  const browser = await chromium.launch({
    executablePath: EXECUTABLE,
    headless: !headed,
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--use-gl=swiftshader'],
  });
  const failures = [];
  const report = {};
  try {
    // ------------------------------------------------------------------ 1. History
    {
      const page = await browser.newPage({ viewport: { width: 1280, height: 1100 } });
      await page.goto(`${BASE}/?input=keyboard`, { waitUntil: 'domcontentloaded' });
      const data = seed();
      await page.evaluate((d) => {
        localStorage.setItem('beatRehab:patients', JSON.stringify(d.patients));
        localStorage.setItem('beatRehab:activePatient', JSON.stringify(d.active));
        localStorage.setItem('beatRehab:history', JSON.stringify(d.history));
      }, data);
      await page.goto(`${BASE}/?input=keyboard`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!window.__beatRehab, null, { timeout: 20_000 });
      await page.evaluate(() => window.__beatRehab.store.getState().goto('history'));
      await page.waitForSelector('[data-testid="rom-trend"]', { timeout: 20_000 });
      await page.waitForTimeout(400);
      await page.screenshot({ path: resolve(SHOT_DIR, 'honest-history.png'), fullPage: true });

      const badge = await page.locator('.trend-card .badge').first().textContent();
      const trend = await page.evaluate(() => {
        const t = window.__beatRehab.store.getState();
        return { historyLength: t.history.length };
      });
      // The card must count the aborted runs, and the delta must come from the full sessions.
      log('trend badge:', JSON.stringify(badge));
      report.badge = badge;
      report.history = trend.historyLength;
      if (!/ended early/.test(badge ?? '')) failures.push(`trend card badge does not name the aborted runs: ${badge}`);

      const rows = await page.locator('[data-testid^="trend-points-"]').first();
      await rows.click();
      await page.waitForTimeout(200);
      const rowText = await page.locator('.trend-points table tbody').first().textContent();
      log('rows:', JSON.stringify(rowText?.replace(/\s+/g, ' ').trim().slice(0, 200)));
      if (!/interrupted/.test(rowText ?? '')) failures.push('the interrupted run is not named as such in the per-session rows');
      if (!/stopped by therapist/.test(rowText ?? '')) failures.push('the therapist-stopped run is not distinguished');
      await page.screenshot({ path: resolve(SHOT_DIR, 'honest-history-rows.png'), fullPage: true });
      await page.close();
    }

    // ------------------------------------------------------------- 2. the self-pause overlay
    {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      await page.goto(`${BASE}/?input=autoplay`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1200);
      await page.goto(`${BASE}/?input=autoplay`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!window.__beatRehab, null, { timeout: 20_000 });
      await page.getByTestId('start-session').click();
      await page.getByTestId('mode-leg').click();
      await page.waitForSelector('[data-testid="setup-start"]');
      await page.getByTestId('setup-start').click();
      await page.waitForSelector('[data-testid="play-canvas"]', { timeout: 30_000 });
      await page.waitForFunction(() => window.__beatRehab?.getScore?.()?.phase === 'playing', null, { timeout: 90_000 });
      await page.waitForTimeout(2500);

      // The tablet goes to sleep / the therapist switches app: the page is hidden.
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await page.waitForSelector('[data-testid="paused-by-page"]', { timeout: 15_000 });
      await page.waitForTimeout(400);
      await page.screenshot({ path: resolve(SHOT_DIR, 'honest-pause.png') });

      const notes = page.locator('[data-testid="pause-chart-notes"]');
      const hasNotes = (await notes.count()) > 0;
      const open = hasNotes ? await notes.evaluate((el) => el.hasAttribute('open')) : false;
      const overlayText = await page.getByTestId('pause-overlay').textContent();
      log('chart notes present:', hasNotes, 'open:', open);
      report.pause = { hasNotes, open };
      if (hasNotes && open) failures.push('the chart-generator notes are expanded on the pause dialog again');
      if (!/paused itself/.test(overlayText ?? '')) failures.push('the pause dialog does not say why it paused');
      if (/notes\/beat/.test(overlayText ?? '') && !hasNotes) {
        failures.push('the note-density string is loose on the pause dialog');
      }
      await page.close();
    }
  } finally {
    await browser.close();
    server.kill('SIGTERM');
  }

  console.log(JSON.stringify(report, null, 2));
  if (failures.length > 0) {
    for (const f of failures) console.error('[honest] FAIL', f);
    process.exit(1);
  }
  log('PASSED');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
