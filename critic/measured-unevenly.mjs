/**
 * THE CONFOUND, DRIVEN IN THE REAL APP: a rise that is the camera, not the patient.
 *
 * Seeds a shared tablet the way a clinic's really looks — two patients, twelve stored sessions for
 * the one on screen — where the patient's MOST RECENT session was measured on a degraded stream
 * (11.8 fps median, landmarks usable for 62 % of the session) and the earlier ones were tracked
 * good, fair, or not recorded at all. That is the case where a ROM trend rising 21 % → 71 % and a
 * green "▲ +40 pts" chip are the equipment presented as the patient.
 *
 * What it asserts, in the running app, at the clinic tablet size and two larger ones:
 *   1. no comparison anywhere on Results or the trend renders as a plain win when the two sessions
 *      it spans were not measured alike (no `badge-ok` on a qualified chip, and the reason is inside
 *      the chip rather than in a grey line under it);
 *   2. the degraded point is MARKED ON THE PLOT (ringed) and graded in the session-by-session list;
 *   3. the sentence under the plots counts the sessions actually plotted, at every window size;
 *   4. nothing clips at 1024x768 — measured, not eyeballed.
 *
 *   node critic/measured-unevenly.mjs [--headed]
 *
 * Writes critic/screenshots/uneven-{results,trend}-{1024,1280,1920}.png (whole page) and
 * uneven-{results,trend}-card-*.png (the card the claim is about, on its own).
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
const PORT = Number(process.env.UNEVEN_PORT ?? 5417);
const BASE = process.argv.includes('--url') ? process.argv[process.argv.indexOf('--url') + 1] : `http://localhost:${PORT}`;
const headed = process.argv.includes('--headed');
const log = (...m) => console.log('[uneven]', ...m);

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

/** Tracking blocks, in the three states a stored record can be in. */
const GOOD = { samples: 190, fpsMedian: 29.6, fpsLow: 27.1, inferenceMsMedian: 11.4, trackedFraction: 0.99, lowFpsFraction: 0, delegate: 'GPU', worstReason: null };
const FAIR = { samples: 186, fpsMedian: 21.3, fpsLow: 16.4, inferenceMsMedian: 23.8, trackedFraction: 0.93, lowFpsFraction: 0.08, delegate: 'CPU', worstReason: 'low_visibility' };
const POOR = { samples: 178, fpsMedian: 11.8, fpsLow: 7.9, inferenceMsMedian: 61.2, trackedFraction: 0.62, lowFpsFraction: 0.71, delegate: 'CPU', worstReason: 'no_landmarks' };

const main = async () => {
  mkdirSync(SHOT_DIR, { recursive: true });
  let server = null;
  if (!process.argv.includes('--url')) {
    log(`starting vite on :${PORT}`);
    server = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    server.stderr.on('data', (d) => process.stderr.write(`[vite] ${d}`));
    await waitForServer(BASE);
  }

  const browser = await chromium.launch({
    executablePath: EXECUTABLE,
    headless: !headed,
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--use-gl=swiftshader'],
  });
  const failures = [];
  const check = (ok, what) => {
    if (!ok) failures.push(what);
    log(ok ? 'ok  ' : 'FAIL', what);
  };

  try {
    // Vite's dependency optimizer force-reloads (and 404s a stale pre-bundle) the first time a cold
    // dev server is hit; warm it here so that is not read as a fault of the screen under test.
    const warm = await browser.newPage({ viewport: { width: 1024, height: 768 } });
    await warm.goto(`${BASE}/?input=keyboard`, { waitUntil: 'load' });
    await warm.waitForTimeout(1500);
    await warm.close();

    for (const width of [1024, 1280, 1920]) {
      const height = width === 1024 ? 768 : width === 1280 ? 800 : 1080;
      const page = await browser.newPage({ viewport: { width, height } });
      const errors = [];
      page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
      // A 404 for the favicon is the dev server, not the screen under test.
      page.on('console', (m) => {
        if (m.type() !== 'error') return;
        if (/favicon/i.test(m.text())) return;
        errors.push(m.text());
      });
      page.on('response', (r) => {
        if (r.status() >= 400 && !/favicon/i.test(r.url())) errors.push(`HTTP ${r.status()} ${r.url()}`);
      });
      await page.goto(`${BASE}/?input=keyboard`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!window.__beatRehab, null, { timeout: 30_000 });

      // ---- the seeded clinic tablet ------------------------------------------------
      await page.evaluate(({ GOOD, FAIR, POOR }) => {
        const day = 86_400_000;
        const now = Date.now();
        const lane = (i, side, rom, acc, reps) => ({
          lane: i,
          movement: 'seated_march',
          side,
          movementName: `${side === 'left' ? 'Left' : 'Right'} Seated march`,
          hits: Math.round(acc * 90), perfects: Math.round(acc * 40), goods: Math.round(acc * 50),
          misses: 90 - Math.round(acc * 90), judged: 90, accuracy: acc,
          reps, attempted: Math.round(reps * 0.9), surplus: reps - Math.round(reps * 0.9),
          timingBiasMs: 38, timingBiasMadMs: 26,
          romMean: rom, romBest: Math.min(1, rom + 0.12), romSamples: Math.round(reps * 0.9), romUncertain: 1,
          calibratedMin: 0.1, calibratedMax: 0.34, calibrationManual: false,
          compensationKind: 'trunk_lean', compensationMonitored: true, compensationFlags: 3, compensationWorst: 0.06,
        });
        const session = (id, daysAgo, rom, acc, reps, tracking) => {
          const at = now - daysAgo * day;
          const lanes = [lane(0, 'left', rom, acc, reps), lane(1, 'right', rom + 0.1, acc + 0.05, reps + 8)];
          const hits = lanes.reduce((a, l) => a + l.hits, 0);
          const judged = lanes.reduce((a, l) => a + l.judged, 0);
          return {
            id, patientId: 'p_maria', patientName: 'Maria Okonkwo',
            startedAt: at, endedAt: at + 97_000, durationSec: 97,
            mode: 'leg', difficulty: 'medium', windowScale: 1, inputMode: 'camera',
            songId: 'demo-groove', songTitle: 'Groove Circuit', artist: 'Beat Rehab demo', attribution: 'CC0 1.0',
            score: 3800, stars: 2, accuracy: hits / judged, starAccuracy: hits / judged, maxCombo: 7,
            totalNotes: judged, hits, perfects: lanes.reduce((a, l) => a + l.perfects, 0),
            goods: lanes.reduce((a, l) => a + l.goods, 0), misses: lanes.reduce((a, l) => a + l.misses, 0),
            reps: lanes.reduce((a, l) => a + l.reps, 0), answerRate: 0.78,
            surplusMovements: lanes.reduce((a, l) => a + l.surplus, 0), laneRestSec: 1.2,
            timingBiasMs: 38, timingBiasMadMs: 26, latencyOffsetMs: 90, suggestedLatencyMs: 110,
            completed: true, endReason: 'chart', lanes,
            ...(tracking ? { tracking } : {}),
          };
        };
        // Newest first, as the store keeps it. TODAY is the poor-tracked one, and it is what the
        // rise is made of: 0.21 → 0.71 with the last point measured at 11.8 fps.
        const history = [
          session('s_today', 0, 0.71, 0.74, 96, POOR),
          session('s_w1', 7, 0.33, 0.62, 74, GOOD),
          session('s_w2', 14, 0.27, 0.58, 66, FAIR),
          session('s_w3', 21, 0.21, 0.5, 58, null),
          session('s_w4', 28, 0.24, 0.52, 55, GOOD),
          session('s_w5', 35, 0.22, 0.49, 51, GOOD),
          // a second patient on the same tablet, so nothing here is a single-patient special case
          { ...session('s_other', 2, 0.5, 0.6, 60, GOOD), id: 's_other', patientId: 'p_dan', patientName: 'Dan Petrov' },
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
      }, { GOOD, FAIR, POOR });

      // ---- Results ------------------------------------------------------------------
      await page.evaluate(() => window.__beatRehab.gotoScreen('results'));
      await page.waitForSelector('[data-testid="results-range"]');
      await page.waitForTimeout(400);
      await page.screenshot({ path: resolve(SHOT_DIR, `uneven-results-${width}.png`), fullPage: true });
      // The card on its own as well as the page: a chip qualifier is a few hundred pixels of a
      // 3000 px full-page shot, and "look at the screenshots" has to mean the thing being claimed.
      await page.locator('[data-testid="results-range"]').screenshot({ path: resolve(SHOT_DIR, `uneven-results-card-${width}.png`) });

      const results = await page.evaluate(() => {
        const t = (id) => document.querySelector(`[data-testid="${id}"]`);
        const chip = t('results-range-gain-0');
        const improved = t('results-range-improved-0') ?? t('results-range-improved-1');
        return {
          gainText: chip?.textContent ?? null,
          gainClass: chip?.className ?? null,
          improvedText: improved?.textContent ?? null,
          improvedClass: improved?.className ?? null,
          note: t('results-comparison-note')?.textContent ?? null,
          repsDelta: t('results-reps-delta')?.textContent ?? null,
          greenQualified: [...document.querySelectorAll('[data-qualified="true"]')].some((e) => e.className.includes('badge-ok')),
        };
      });
      check(results.gainText !== null, `${width}: the range card prints a change against last session`);
      check(!(results.gainClass ?? '').includes('badge-ok'), `${width}: that change is NOT painted as a win`);
      check((results.gainText ?? '').includes('measured unevenly'), `${width}: the chip itself says the two sessions differ (${results.gainText})`);
      check(!results.greenQualified, `${width}: no qualified chip anywhere is green`);
      check((results.note ?? '').includes('camera rather than the patient'), `${width}: the conditions of both sessions are stated beside the chips`);
      check((results.repsDelta ?? '').includes('measured unevenly'), `${width}: the rep delta carries the same qualifier`);
      if (results.improvedText !== null) {
        check(!(results.improvedClass ?? '').includes('badge-ok'), `${width}: "biggest gain today" is not green on an uneven comparison`);
        check(results.improvedText.includes('biggest change'), `${width}: it is called a change, not a gain (${results.improvedText})`);
      }

      // ---- the trend ----------------------------------------------------------------
      await page.evaluate(() => window.__beatRehab.gotoScreen('history'));
      await page.waitForSelector('[data-testid="rom-trend"]');
      await page.waitForTimeout(400);
      await page.screenshot({ path: resolve(SHOT_DIR, `uneven-trend-${width}.png`), fullPage: true });
      await page.locator('[data-testid="trend-seated_march:left"]').screenshot({ path: resolve(SHOT_DIR, `uneven-trend-card-${width}.png`) });

      const trend = await page.evaluate(() => {
        const t = (id) => document.querySelector(`[data-testid="${id}"]`);
        const romDelta = t('trend-rom-delta-seated_march:left');
        return {
          romText: romDelta?.textContent ?? null,
          romClass: romDelta?.className ?? null,
          rings: document.querySelectorAll('[data-testid^="spark-flag-"]').length,
          bars: document.querySelectorAll('[data-testid^="bars-flag-"]').length,
          cardLine: t('trend-tracking-seated_march:left')?.textContent ?? null,
          mix: t('trend-tracking-mix')?.textContent ?? null,
          pointGrades: [...document.querySelectorAll('[data-testid^="trend-point-tracking-seated_march:left-"]')].map((e) => e.textContent),
          greenQualified: [...document.querySelectorAll('[data-qualified="true"]')].some((e) => e.className.includes('badge-ok')),
        };
      });
      check(!(trend.romClass ?? '').includes('badge-ok'), `${width}: the ROM trend delta is not green across a degraded point`);
      check((trend.romText ?? '').includes('measured unevenly'), `${width}: the trend chip says why (${trend.romText})`);
      check(trend.rings > 0, `${width}: the degraded point is ringed on the line (${trend.rings} rings)`);
      check(trend.bars > 0, `${width}: and outlined in the accuracy columns (${trend.bars})`);
      check((trend.cardLine ?? '').includes('degraded'), `${width}: the card says how many of its own sessions were degraded`);
      check(!trend.greenQualified, `${width}: no qualified chip on the trend is green`);

      // the per-point grades are open in the fold; expand it and read them
      await page.evaluate(() => {
        for (const d of document.querySelectorAll('details.trend-points')) d.setAttribute('open', '');
      });
      await page.waitForTimeout(200);
      const grades = await page.evaluate(() =>
        [...document.querySelectorAll('[data-testid^="trend-point-tracking-seated_march:left-"]')].map((e) => e.textContent),
      );
      check(grades.includes('poor') && grades.includes('not recorded'), `${width}: every session is graded in the list (${grades.join(', ')})`);

      // the mix sentence must describe the window on screen, not the whole stored history
      const mixes = {};
      for (const n of [4, 8]) {
        await page.click(`[data-testid="trend-window-${n}"]`);
        await page.waitForTimeout(200);
        mixes[n] = await page.evaluate(() => document.querySelector('[data-testid="trend-tracking-mix"]')?.textContent ?? '');
      }
      check(mixes[4].includes('4 camera session'), `${width}: "Last 4" counts 4 sessions (${mixes[4].slice(0, 70)}…)`);
      check(mixes[8].includes('6 camera session'), `${width}: "Last 8" counts the 6 that exist (${mixes[8].slice(0, 70)}…)`);
      await page.click('[data-testid="trend-window-8"]');

      // ---- nothing clips at any of these widths --------------------------------------
      const overflow = await page.evaluate(() => {
        const bad = [];
        for (const el of document.querySelectorAll('body *')) {
          // SVG children scale with their viewBox and report scrollWidth in user units; the <svg>
          // element itself is measured like any other box.
          if (el instanceof SVGElement && el.tagName.toLowerCase() !== 'svg') continue;
          const style = getComputedStyle(el);
          if (style.overflowX === 'auto' || style.overflowX === 'scroll') continue;
          if (el.scrollWidth > el.clientWidth + 2 && el.clientWidth > 0) {
            bad.push(`${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ')[0]} ${el.clientWidth}<${el.scrollWidth}`);
          }
        }
        return { bad: bad.slice(0, 6), bodyScrolls: document.body.scrollWidth > window.innerWidth + 2 };
      });
      check(overflow.bad.length === 0, `${width}: nothing overflows its box outside a scroller (${overflow.bad.join('; ')})`);
      check(!overflow.bodyScrolls, `${width}: the page does not scroll horizontally`);
      check(errors.length === 0, `${width}: no console errors (${errors.slice(0, 3).join(' | ')})`);
      await page.close();
    }
  } finally {
    await browser.close();
    if (server) server.kill('SIGTERM');
  }

  if (failures.length > 0) {
    console.error(`\n[uneven] FAILED (${failures.length}):`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  log('PASS — every comparison across a differently-measured session says so where it is made');
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
