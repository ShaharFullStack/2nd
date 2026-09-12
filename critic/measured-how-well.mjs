/**
 * HOW WELL WAS IT MEASURED — the three claims, driven in the real app.
 *
 * 1. THE CAMERA CHECK STATES AND GATES. Against Chromium's fake webcam (a synthetic pattern with no
 *    person in it — the same thing a therapist sees when the patient is not yet in the chair, and the
 *    same thing the reviewer's 1-2 fps laptop produced) the screen must say what this device will and
 *    will not support and must NOT let the session walk forward into a calibration that cannot be
 *    measured. With a way out, because a gate that is a dead end is worse than no gate.
 *
 * 2. THE CALIBRATED RANGE CARRIES HOW IT WAS MEASURED. It is the denominator of every ROM figure this
 *    app prints, exports and trends, and a range from three ragged reps on an 11 fps stream is not the
 *    same denominator as one from a clean stream. The grade is shown where the range is accepted and
 *    where last session's is offered back for reuse.
 *
 * 3. A TREND CARD'S HEADER AND ITS CHANGE BADGES NAME THE SAME SESSIONS. The header counts the
 *    sessions the card PLOTS; each change badge spans its own two ENDS. Both statements are true and
 *    they used to wear the same words, so a green delta could sit four lines under "measured
 *    unevenly". The header now says which set it is counting and whether it reaches the ends.
 *
 *   node critic/measured-how-well.mjs [--headed] [--url http://localhost:5419]
 *
 * Writes critic/screenshots/howwell-*.png at 1024x768 and 1280x800.
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
const PORT = Number(process.env.HOWWELL_PORT ?? 5619);
const useUrl = process.argv.includes('--url');
const BASE = useUrl ? process.argv[process.argv.indexOf('--url') + 1] : `http://localhost:${PORT}`;
const headed = process.argv.includes('--headed');
const log = (...m) => console.log('[howwell]', ...m);

const SIZES = [
  { width: 1024, height: 768 },
  { width: 1280, height: 800 },
];

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

/** Session tracking blocks, in the three states a stored record can be in. */
const GOOD = { samples: 190, fpsMedian: 29.6, fpsLow: 27.1, inferenceMsMedian: 11.4, trackedFraction: 0.99, lowFpsFraction: 0, delegate: 'GPU', worstReason: null };
const POOR = { samples: 178, fpsMedian: 11.8, fpsLow: 7.9, inferenceMsMedian: 61.2, trackedFraction: 0.62, lowFpsFraction: 0.71, delegate: 'CPU', worstReason: 'no_landmarks' };

/** Calibration measurement blocks: a clean denominator and a ragged one. */
const CAL_GOOD = { frames: 168, tracked: 167, trackedFraction: 0.994, fpsMedian: 29.4, fpsLow: 27.2, durationSec: 5.7, reps: 3, repSpread: 0.018, repSpreadFraction: 0.075 };
const CAL_POOR = { frames: 131, tracked: 82, trackedFraction: 0.626, fpsMedian: 11.2, fpsLow: 7.4, durationSec: 11.7, reps: 3, repSpread: 0.106, repSpreadFraction: 0.442 };

const main = async () => {
  mkdirSync(SHOT_DIR, { recursive: true });
  let server = null;
  if (!useUrl) {
    log(`starting vite on :${PORT}`);
    server = spawn('node_modules/.bin/vite', ['--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    server.stderr.on('data', (d) => process.stderr.write(`[vite] ${d}`));
    await waitForServer(BASE);
  }

  const browser = await chromium.launch({
    executablePath: EXECUTABLE,
    headless: !headed,
    args: [
      '--no-sandbox',
      '--autoplay-policy=no-user-gesture-required',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--use-gl=swiftshader',
    ],
  });
  const failures = [];
  const check = (ok, what) => {
    if (!ok) failures.push(what);
    log(ok ? 'ok  ' : 'FAIL', what);
  };

  try {
    // Vite's dependency optimizer force-reloads a cold dev server on first hit.
    const warm = await browser.newPage({ viewport: SIZES[0] });
    await warm.goto(`${BASE}/?input=keyboard`, { waitUntil: 'load' });
    await warm.waitForTimeout(2000);
    await warm.close();

    for (const { width, height } of SIZES) {
      const page = await browser.newPage({ viewport: { width, height } });
      const errors = [];
      page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
      page.on('console', (m) => {
        if (m.type() !== 'error') return;
        if (/favicon/i.test(m.text())) return;
        errors.push(m.text());
      });
      page.on('response', (r) => {
        if (r.status() >= 400 && !/favicon/i.test(r.url())) errors.push(`HTTP ${r.status()} ${r.url()}`);
      });
      await page.context().grantPermissions(['camera'], { origin: BASE });
      await page.goto(`${BASE}/?input=keyboard`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!window.__beatRehab, null, { timeout: 30_000 });

      /* ---------- a shared clinic tablet: two patients, several sessions each ---------- */
      await page.evaluate(({ GOOD, POOR, CAL_GOOD, CAL_POOR }) => {
        const day = 86_400_000;
        const now = Date.now();
        const lane = (i, movement, side, rom, acc, reps, cal, calMeasurement) => ({
          lane: i, movement, side,
          movementName: `${side === 'left' ? 'Left' : 'Right'} ${movement === 'seated_march' ? 'Seated march' : 'Knee extension'}`,
          hits: Math.round(acc * 90), perfects: Math.round(acc * 40), goods: Math.round(acc * 50),
          misses: 90 - Math.round(acc * 90), judged: 90, accuracy: acc,
          reps, attempted: Math.round(reps * 0.9), surplus: reps - Math.round(reps * 0.9),
          timingBiasMs: 38, timingBiasMadMs: 26,
          romMean: rom, romBest: Math.min(1, rom + 0.1), romSamples: Math.round(reps * 0.9), romUncertain: 1,
          calibratedMin: cal[0], calibratedMax: cal[1], calibrationManual: false,
          calibrationMeasurement: calMeasurement,
          compensationKind: movement === 'seated_march' ? 'trunk_lean' : null,
          compensationMonitored: movement === 'seated_march', compensationFlags: 2, compensationWorst: 0.05,
        });
        const session = (id, daysAgo, lanes, tracking) => {
          const at = now - daysAgo * day;
          const hits = lanes.reduce((a, l) => a + l.hits, 0);
          const judged = lanes.reduce((a, l) => a + l.judged, 0);
          return {
            id, patientId: 'p_maria', patientName: 'Maria Okonkwo',
            startedAt: at, endedAt: at + 97_000, durationSec: 97,
            mode: 'leg', difficulty: 'medium', windowScale: 1, inputMode: 'camera',
            songId: 'demo-groove', songTitle: 'Groove Circuit', artist: 'Beat Rehab demo', attribution: 'CC0 1.0',
            score: 3800, stars: 2, accuracy: hits / judged, starAccuracy: hits / judged, maxCombo: 7,
            totalNotes: judged, hits,
            perfects: lanes.reduce((a, l) => a + l.perfects, 0),
            goods: lanes.reduce((a, l) => a + l.goods, 0),
            misses: lanes.reduce((a, l) => a + l.misses, 0),
            reps: lanes.reduce((a, l) => a + l.reps, 0), answerRate: 0.78,
            surplusMovements: lanes.reduce((a, l) => a + l.surplus, 0), laneRestSec: 1.2,
            timingBiasMs: 38, timingBiasMadMs: 26, latencyOffsetMs: 90, suggestedLatencyMs: 110,
            completed: true, endReason: 'chart', lanes,
            ...(tracking ? { tracking } : {}),
          };
        };
        // Seated march: the degraded session sits IN THE MIDDLE, so the ends are like-for-like and the
        // card's change badges are NOT qualified — the case where the two statements diverged.
        // Knee extension: the degraded session is the LATEST, so the change badges do carry it.
        const march = (rom, acc, reps, m) => [lane(0, 'seated_march', 'left', rom, acc, reps, [0.1, 0.34], m)];
        const knee = (rom, acc, reps, m) => [lane(1, 'knee_extension', 'right', rom, acc, reps, [18, 62], m)];
        const history = [
          session('s_today', 0, [...march(0.62, 0.72, 88, CAL_GOOD), ...knee(0.68, 0.7, 80, CAL_POOR)], POOR),
          session('s_w1', 7, [...march(0.55, 0.66, 78, CAL_GOOD), ...knee(0.6, 0.66, 72, CAL_GOOD)], GOOD),
          session('s_w2', 14, [...march(0.3, 0.5, 52, CAL_POOR), ...knee(0.5, 0.6, 64, CAL_GOOD)], POOR),
          session('s_w3', 21, [...march(0.44, 0.6, 66, CAL_GOOD), ...knee(0.47, 0.58, 60, CAL_GOOD)], GOOD),
          session('s_w4', 28, [...march(0.41, 0.57, 61, CAL_GOOD), ...knee(0.44, 0.55, 58, CAL_GOOD)], GOOD),
          { ...session('s_other', 2, march(0.5, 0.6, 60, CAL_GOOD), GOOD), id: 's_other', patientId: 'p_dan', patientName: 'Dan Petrov' },
        ];
        window.__beatRehab.store.setState({
          patients: [
            { id: 'p_maria', name: 'Maria Okonkwo', createdAt: now - 60 * day, lastUsedAt: now },
            { id: 'p_dan', name: 'Dan Petrov', createdAt: now - 20 * day, lastUsedAt: now - 2 * day },
          ],
          activePatientId: 'p_maria',
          history,
          lastResult: history[0],
        });
      }, { GOOD, POOR, CAL_GOOD, CAL_POOR });

      /* ---------- 3. the trend: header badge vs change badge ---------- */
      await page.evaluate(() => window.__beatRehab.gotoScreen('history'));
      await page.waitForSelector('[data-testid="rom-trend"]', { timeout: 20_000 });
      await page.waitForTimeout(400);
      await page.screenshot({ path: resolve(SHOT_DIR, `howwell-trend-${width}.png`), fullPage: true });
      for (const key of ['seated_march:left', 'knee_extension:right']) {
        const card = page.locator(`[data-testid="trend-${key}"]`);
        if (await card.count()) {
          await card.screenshot({ path: resolve(SHOT_DIR, `howwell-trend-card-${key.replace(/[:]/g, '-')}-${width}.png`) });
        }
      }

      const trend = await page.evaluate(() => {
        const read = (key) => {
          const badge = document.querySelector(`[data-testid="trend-tracking-badge-${key}"]`);
          const scope = document.querySelector(`[data-testid="trend-tracking-scope-${key}"]`);
          const delta = document.querySelector(`[data-testid="trend-rom-delta-${key}"]`);
          return {
            badge: badge?.textContent ?? null,
            badgeClass: badge?.className ?? null,
            scope: scope?.textContent ?? null,
            delta: delta?.textContent ?? null,
            deltaQualified: delta?.getAttribute('data-qualified') ?? null,
            deltaClass: delta?.className ?? null,
          };
        };
        return { march: read('seated_march:left'), knee: read('knee_extension:right') };
      });

      // The middle-degraded card: the header does NOT borrow the chips' words, and says why.
      check(trend.march.badge === 'uneven between the ends', `${width}: middle-degraded card does not wear the delta's phrase (got ${trend.march.badge})`);
      check(trend.march.deltaQualified === null, `${width}: its change badge is unqualified — its own two ends were measured alike`);
      check((trend.march.scope ?? '').includes('BOTH of those were tracked good'), `${width}: and the header says so, naming the two dates the change spans`);
      // The end-degraded card: the words agree again.
      check(trend.knee.badge === 'measured unevenly', `${width}: end-degraded card wears the delta's phrase (got ${trend.knee.badge})`);
      check(trend.knee.deltaQualified === 'true', `${width}: and its change badge really is carrying it`);
      check(!(trend.knee.deltaClass ?? '').includes('badge-ok'), `${width}: a qualified change badge is never green`);
      check(
        [...(trend.march.scope ?? ''), ...(trend.knee.scope ?? '')].length > 0 &&
          (trend.knee.scope ?? '').includes('each change badge says so on itself'),
        `${width}: the end-degraded header points at the badges rather than restating them`,
      );

      /* ---------- 2. the calibrated range carries how it was measured ---------- */
      await page.evaluate(({ CAL_POOR }) => {
        window.__beatRehab.store.setState({
          mode: 'leg',
          lanes: [{ index: 0, movement: 'seated_march', side: 'left' }],
          calibrations: [null],
          savedCalibrations: {
            'seated_march:left': {
              min: 0.104, max: 0.344, samples: 131, movement: 'seated_march', mirrored: false,
              patient: 'p_maria', capturedAt: Date.now() - 6 * 86_400_000, posture: 'seated',
              rest: { still: true, spread: 0.008, drift: 0.002, durationSec: 2.1, samples: 63 },
              measurement: CAL_POOR,
            },
          },
        });
        window.__beatRehab.gotoScreen('rom');
      }, { CAL_POOR });
      await page.waitForSelector('[data-testid="rom-reuse-quality-chip"]', { timeout: 20_000 });
      await page.waitForTimeout(300);
      await page.screenshot({ path: resolve(SHOT_DIR, `howwell-rom-reuse-${width}.png`), fullPage: true });

      const reuse = await page.evaluate(() => ({
        chip: document.querySelector('[data-testid="rom-reuse-quality-chip"]')?.textContent ?? null,
        chipClass: document.querySelector('[data-testid="rom-reuse-quality-chip"]')?.className ?? null,
        note: document.querySelector('[data-testid="rom-reuse-quality-note"]')?.textContent ?? null,
      }));
      check(reuse.chip === 'measured poor', `${width}: the range offered for reuse is graded where it is offered (got ${reuse.chip})`);
      check(!(reuse.chipClass ?? '').includes('badge-ok'), `${width}: a ragged denominator is never painted as clean`);
      check((reuse.note ?? '').includes('11 fps'), `${width}: the conditions are stated in numbers`);
      check(/too low/.test(reuse.note ?? ''), `${width}: and WHICH WAY the frame rate biases the range`);
      check(/denominator/i.test(reuse.note ?? ''), `${width}: reusing it is named as adopting it as today's denominator`);

      await page.getByTestId('rom-reuse').click();
      await page.waitForSelector('[data-testid="rom-accepted-quality-chip"]', { timeout: 10_000 });
      await page.waitForTimeout(300);
      await page.screenshot({ path: resolve(SHOT_DIR, `howwell-rom-accepted-${width}.png`), fullPage: true });
      const accepted = await page.evaluate(() => ({
        chip: document.querySelector('[data-testid="rom-accepted-quality-chip"]')?.textContent ?? null,
        lane: document.querySelector('[data-testid="rom-lane-quality-0"]')?.textContent ?? null,
      }));
      check(accepted.chip === 'measured poor', `${width}: the accepted range keeps its grade (got ${accepted.chip})`);
      check(accepted.lane === 'measured poor', `${width}: and every lane in the list carries its own`);

      /* ---------- 1. the camera check states and gates ---------- */
      await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!window.__beatRehab, null, { timeout: 30_000 });
      await page.getByTestId('start-session').click();
      // The seeded patients survive in localStorage; pick the active one and go.
      if (await page.getByTestId('patient-continue').count()) {
        await page.getByTestId('patient-continue').click();
      } else {
        await page.getByTestId('patient-name-input').fill('Maria Okonkwo');
        await page.getByTestId('patient-add').click();
        await page.getByTestId('patient-continue').click();
      }
      await page.getByTestId('mode-leg').click();
      await page.getByTestId('setup-start').click();
      log(`${width}: on the camera check, waiting for the model and the readings`);
      await page.waitForSelector('[data-testid="camera-readiness"]', { timeout: 30_000 });
      // The fake webcam is a synthetic pattern: the model runs, finds nobody, and the screen has to
      // reach a settled verdict about that rather than flicker.
      await page.waitForFunction(
        () => document.querySelector('[data-testid="camera-readiness"]')?.getAttribute('data-readiness') !== 'measuring',
        null,
        { timeout: 60_000 },
      );
      await page.waitForTimeout(600);
      await page.screenshot({ path: resolve(SHOT_DIR, `howwell-camera-${width}.png`), fullPage: true });
      await page.locator('[data-testid="camera-readiness"]').screenshot({ path: resolve(SHOT_DIR, `howwell-camera-card-${width}.png`) });

      const camera = await page.evaluate(() => {
        const panel = document.querySelector('[data-testid="camera-readiness"]');
        const cont = document.querySelector('[data-testid="camera-continue"]');
        return {
          kind: panel?.getAttribute('data-readiness') ?? null,
          headline: document.querySelector('[data-testid="camera-readiness-headline"]')?.textContent ?? null,
          wont: document.querySelector('[data-testid="camera-readiness-wont"]')?.textContent ?? null,
          action: document.querySelector('[data-testid="camera-readiness-action"]')?.textContent ?? null,
          continueDisabled: cont ? cont.hasAttribute('disabled') : null,
          hasKeyboardWayOut: !!document.querySelector('[data-testid="camera-readiness-keyboard"]'),
          hasRetry: !!document.querySelector('[data-testid="camera-readiness-retry"]'),
          starting: document.querySelector('[data-testid="camera-starting"]')?.textContent ?? null,
        };
      });
      check(camera.kind === 'blocked', `${width}: a camera with nobody in it is reported as blocked (got ${camera.kind})`);
      check(camera.continueDisabled === true, `${width}: and the way forward is GATED, not merely warned about`);
      check(/cannot be calibrated/i.test(camera.wont ?? ''), `${width}: the panel says what the next screen cannot do`);
      check(camera.hasKeyboardWayOut && camera.hasRetry, `${width}: the gate is not a dead end — retry and a keyboard run are both offered`);

      // And the download figure the waiting overlay quotes, on a cold start, is the measured one.
      const overlayText = await page.evaluate(() => {
        const el = document.querySelector('[data-testid="camera-starting"]');
        return el ? el.textContent : null;
      });
      if (overlayText) check(/17 MB|19 MB/.test(overlayText), `${width}: the wait overlay quotes the measured first-run transfer`);

      const clipped = await page.evaluate(() => {
        const out = [];
        for (const el of document.querySelectorAll('[data-testid^="camera-readiness"], [data-testid^="trend-tracking"], [data-testid^="rom-"]')) {
          if (el.scrollWidth > el.clientWidth + 2 && getComputedStyle(el).overflowX === 'visible') {
            out.push(`${el.dataset.testid}: ${el.scrollWidth} > ${el.clientWidth}`);
          }
        }
        return out;
      });
      check(clipped.length === 0, `${width}: nothing in the new panels overflows its box (${clipped.join('; ')})`);

      check(errors.length === 0, `${width}: no console errors (${errors.slice(0, 3).join(' | ')})`);
      await page.close();
    }
  } finally {
    await browser.close();
    if (server) server.kill();
  }

  if (failures.length > 0) {
    console.error(`\n[howwell] ${failures.length} FAILED:`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  log(`all checks passed; screenshots in ${SHOT_DIR}`);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
