/**
 * THE FIVE CLAIMS THIS ROUND IS ABOUT, DRIVEN IN THE REAL APP.
 *
 * 1. SAVED MEANS SAVED. The Results screen's "Saved to history" badge was a constant in the markup.
 *    Here `localStorage.setItem` is made to refuse (quota full — realistic on a shared tablet, where
 *    the 100-session cap is per patient) BEFORE the session is recorded through the store's real
 *    write path, and the badge has to say so and offer the therapist something to do about it.
 * 2. THE ENDING AND THE ENGINE AGREE. A real autoplay session is driven to its chart end and the
 *    board's own receptor state is read out of the live renderer: the ending counts reps, so it may
 *    not blank every lane to "nothing registers".
 * 3. SEVERAL SONGS IN ONE VISIT ARE ONE VISIT. A seeded clinic tablet with three runs inside one
 *    40-minute slot, two the week before and singles further back.
 * 4. THE SUB-RESOLUTION CAPTION STATES THE TRUE BOUND (0.005 on a body-scaled ratio, not 1.00).
 * 5. "TODAY, MOVEMENT BY MOVEMENT" CARRIES THE SAME QUALIFIERS AS THE REST OF THE SCREEN.
 *
 *   node critic/verify-record-kept.mjs [--headed]
 *
 * Writes critic/screenshots/record/*.png at 1024x768 and 1280x800.
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SHOT_DIR = resolve(HERE, 'screenshots', 'record');
const EXECUTABLE = '/opt/pw-browsers/chromium';
const PORT = Number(process.env.RECORD_PORT ?? 5629);
const BASE = `http://localhost:${PORT}`;
const headed = process.argv.includes('--headed');
const log = (...m) => console.log('[record]', ...m);

const GOOD = { samples: 190, fpsMedian: 29.6, fpsLow: 27.1, inferenceMsMedian: 11.4, trackedFraction: 0.99, lowFpsFraction: 0, delegate: 'GPU', worstReason: null };
const POOR = { samples: 178, fpsMedian: 11.8, fpsLow: 7.9, inferenceMsMedian: 61.2, trackedFraction: 0.62, lowFpsFraction: 0.71, delegate: 'CPU', worstReason: 'no_landmarks' };

async function waitForServer(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server at ${url} did not come up`);
}

/**
 * A clinic tablet as it really looks: two patients, and the one on screen has three runs inside one
 * appointment today, two a week ago and singles before that. Today's session is the poor-tracked one
 * so every cross-session comparison on Results has to carry a qualifier.
 */
const SEED = ({ GOOD, POOR }) => {
  const day = 86_400_000;
  const min = 60_000;
  const now = Date.now();
  const midday = new Date(now);
  midday.setHours(11, 0, 0, 0);
  const noonToday = midday.getTime();

  const lane = (i, movement, side, romMean, romBest, reps, cal) => ({
    lane: i,
    movement,
    side,
    movementName: `${side === 'left' ? 'Left' : 'Right'} ${movement === 'seated_march' ? 'Seated march' : 'Knee extension'}`,
    hits: Math.round(reps * 0.5), perfects: Math.round(reps * 0.2), goods: Math.round(reps * 0.3),
    misses: Math.round(reps * 0.4), judged: Math.round(reps * 0.9), accuracy: 0.55,
    reps, attempted: Math.round(reps * 0.8), surplus: Math.round(reps * 0.2),
    timingBiasMs: 34, timingBiasMadMs: 22,
    romMean, romBest, romSamples: Math.round(reps * 0.9), romUncertain: 1,
    calibratedMin: cal[0], calibratedMax: cal[1], calibrationManual: false,
    compensationKind: movement === 'seated_march' ? 'trunk_lean' : null,
    compensationMonitored: movement === 'seated_march',
    compensationFlags: movement === 'seated_march' ? 2 : 0,
    compensationWorst: movement === 'seated_march' ? 0.05 : null,
  });

  const session = (id, startedAt, { romMarch, romKnee, reps, tracking, songTitle = 'Groove Circuit', completed = true, endReason = 'chart' }) => {
    const lanes = [
      lane(0, 'seated_march', 'left', romMarch - 0.08, romMarch, reps, [0.1, 0.5]),
      lane(1, 'knee_extension', 'right', romKnee - 0.1, romKnee, reps + 6, [90, 140]),
    ];
    const hits = lanes.reduce((a, l) => a + l.hits, 0);
    const judged = lanes.reduce((a, l) => a + l.judged, 0);
    return {
      id, patientId: 'p_maria', patientName: 'Maria Okonkwo',
      startedAt, endedAt: startedAt + 97_000, durationSec: 97,
      mode: 'leg', difficulty: 'medium', windowScale: 1, inputMode: 'camera',
      songId: 'demo-groove', songTitle, artist: 'Beat Rehab demo', attribution: 'Demo stems, CC0 1.0',
      score: 3800, stars: 2, accuracy: hits / judged, starAccuracy: hits / judged, maxCombo: 7,
      totalNotes: judged, hits,
      perfects: lanes.reduce((a, l) => a + l.perfects, 0),
      goods: lanes.reduce((a, l) => a + l.goods, 0),
      misses: lanes.reduce((a, l) => a + l.misses, 0),
      reps: lanes.reduce((a, l) => a + l.reps, 0),
      answerRate: 0.78, surplusMovements: lanes.reduce((a, l) => a + l.surplus, 0), laneRestSec: 1.2,
      timingBiasMs: 34, timingBiasMadMs: 22, latencyOffsetMs: 90, suggestedLatencyMs: null,
      completed, endReason, lanes,
      ...(tracking ? { tracking } : {}),
    };
  };

  // TODAY: one appointment, three songs — 11:00, 11:19, 11:36. The last is the one on Results, and
  // its march range is 0.01 of the calibrated range above the previous session's: under the 0.01 a
  // body-scaled ratio is printed to, which is the case the sub-resolution caption exists for.
  const today = [
    session('s_today_c', noonToday + 36 * min, { romMarch: 0.61, romKnee: 0.82, reps: 96, tracking: POOR, songTitle: 'Groove Circuit' }),
    session('s_today_b', noonToday + 19 * min, { romMarch: 0.58, romKnee: 0.8, reps: 88, tracking: GOOD, songTitle: 'Groove Circuit' }),
    session('s_today_a', noonToday, { romMarch: 0.55, romKnee: 0.79, reps: 74, tracking: GOOD, songTitle: 'Groove Circuit' }),
  ];
  // LAST WEEK: two songs in one visit, one of them stopped early.
  const lastWeek = [
    session('s_w1_b', noonToday - 7 * day + 22 * min, { romMarch: 0.6, romKnee: 0.78, reps: 41, tracking: GOOD, completed: false, endReason: 'quit' }),
    session('s_w1_a', noonToday - 7 * day, { romMarch: 0.6, romKnee: 0.77, reps: 70, tracking: GOOD }),
  ];
  const older = [
    session('s_w2', noonToday - 14 * day, { romMarch: 0.52, romKnee: 0.71, reps: 62, tracking: GOOD }),
    session('s_w3', noonToday - 21 * day, { romMarch: 0.47, romKnee: 0.68, reps: 55, tracking: null }),
  ];
  const other = { ...session('s_dan', noonToday - 2 * day, { romMarch: 0.5, romKnee: 0.6, reps: 60, tracking: GOOD }), id: 's_dan', patientId: 'p_dan', patientName: 'Dan Petrov' };

  const history = [...today, ...lastWeek, ...older, other];
  window.__beatRehab.store.setState({
    patients: [
      { id: 'p_maria', name: 'Maria Okonkwo', createdAt: now - 90 * day, lastUsedAt: now },
      { id: 'p_dan', name: 'Dan Petrov', createdAt: now - 20 * day, lastUsedAt: now - 2 * day },
    ],
    activePatientId: 'p_maria',
    history,
    lastResult: null,
    lastSave: null,
  });
  return { latest: history[0] };
};

const main = async () => {
  mkdirSync(SHOT_DIR, { recursive: true });
  log(`starting vite on :${PORT}`);
  const server = spawn('node_modules/.bin/vite', ['--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
  server.stderr.on('data', (d) => process.stderr.write(`[vite] ${d}`));
  await waitForServer(BASE);

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
    const warm = await browser.newPage({ viewport: { width: 1024, height: 768 } });
    await warm.goto(`${BASE}/?input=keyboard`, { waitUntil: 'load' });
    await warm.waitForTimeout(1800);
    await warm.close();

    for (const [width, height] of [[1024, 768], [1280, 800]]) {
      const tag = `${width}`;
      const page = await browser.newPage({ viewport: { width, height } });
      const errors = [];
      page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
      page.on('console', (m) => {
        if (m.type() !== 'error') return;
        if (/favicon/i.test(m.text())) return;
        errors.push(m.text());
      });
      await page.goto(`${BASE}/?input=keyboard`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!window.__beatRehab, null, { timeout: 30_000 });
      await page.evaluate(SEED, { GOOD, POOR });

      // ---- 3. one visit, three songs -------------------------------------------------
      await page.evaluate(() => window.__beatRehab.gotoScreen('history'));
      await page.waitForSelector('[data-testid="history-table"]');
      await page.waitForTimeout(400);
      await page.screenshot({ path: resolve(SHOT_DIR, `history-${tag}.png`), fullPage: true });
      await page.locator('[data-testid="history-table"]').screenshot({ path: resolve(SHOT_DIR, `history-table-${tag}.png`) });

      const visits = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('[data-testid="history-table"] tr.visit-row')];
        const wrap = document.querySelector('[data-testid="history-table"]');
        return {
          headers: rows.map((r) => r.textContent.replace(/\s+/g, ' ').trim()),
          runs: document.querySelectorAll('[data-testid="history-table"] tbody tr:not(.visit-row)').length,
          eyebrow: document.querySelector('[data-testid="history-screen"]').textContent.match(/\d+ runs in \d+ visits/)?.[0] ?? null,
          legend: document.querySelector('[data-testid="history-visit-legend"]')?.textContent ?? null,
          overflow: wrap ? wrap.scrollWidth - wrap.clientWidth : -1,
        };
      });
      log(`  visit headers: ${JSON.stringify(visits.headers, null, 0)}`);
      check(visits.headers.length === 4, `${tag}: 8 runs group into 4 visits (got ${visits.headers.length})`);
      check(visits.runs === 8, `${tag}: every run is still its own row (${visits.runs})`);
      check(/3 songs/.test(visits.headers[0] ?? ''), `${tag}: today's appointment is one header over three songs`);
      check(/–/.test(visits.headers[0] ?? ''), `${tag}: and it states the span of the appointment`);
      check(visits.eyebrow === '8 runs in 4 visits', `${tag}: runs and visits are counted separately (${visits.eyebrow})`);
      check(/inferred/.test(visits.legend ?? ''), `${tag}: the grouping says it was inferred from the clock`);

      // ---- 4 + 5. the Results screen's comparisons -----------------------------------
      await page.evaluate(() => {
        const s = window.__beatRehab.store.getState();
        window.__beatRehab.store.setState({ lastResult: s.history[0] });
        window.__beatRehab.gotoScreen('results');
      });
      await page.waitForSelector('[data-testid="results-today"]');
      await page.waitForTimeout(400);
      await page.screenshot({ path: resolve(SHOT_DIR, `results-${tag}.png`), fullPage: true });
      await page.locator('[data-testid="results-range"]').screenshot({ path: resolve(SHOT_DIR, `results-range-${tag}.png`) });
      await page.locator('[data-testid="results-today"]').screenshot({ path: resolve(SHOT_DIR, `results-today-${tag}.png`) });

      const today = await page.evaluate(() => {
        const t = (id) => document.querySelector(`[data-testid="${id}"]`);
        return {
          qualifier: t('results-today-qualifier')?.textContent ?? null,
          note: t('results-today-comparison-note')?.textContent ?? null,
          qualifiedDeltas: document.querySelectorAll('[data-testid="results-today"] .delta-qualified').length,
          range: t('results-range')?.textContent ?? '',
        };
      });
      check(!!today.qualifier, `${tag}: the per-movement card header carries the tracking qualifier (${today.qualifier})`);
      check(today.qualifiedDeltas > 0, `${tag}: and every delta inside it is qualified (${today.qualifiedDeltas})`);
      check(!!today.note, `${tag}: the reason sits under the rows it qualifies`);
      check(/under 0\.005/.test(today.range), `${tag}: a sub-resolution ratio change states the true bound`);
      check(!/under 1\.00/.test(today.range), `${tag}: and never "under 1.00"`);

      // ---- 1. the badge that claims the record exists --------------------------------
      // The saved case first, through the store's real write path.
      await page.evaluate(() => {
        const s = window.__beatRehab.store.getState();
        const r = { ...s.history[0], id: `s_live_${Date.now()}` };
        s.addResult(r);
        window.__beatRehab.gotoScreen('results');
      });
      await page.waitForSelector('[data-testid="results-save-state"]');
      await page.waitForTimeout(250);
      await page.locator('[data-testid="results-save"]').screenshot({ path: resolve(SHOT_DIR, `save-ok-${tag}.png`) });
      const okBadge = await page.evaluate(() => document.querySelector('[data-testid="results-save-state"]').textContent);
      check(/Saved to history/.test(okBadge), `${tag}: a write that landed says so (${okBadge})`);

      // ...and now with the quota refusing every write, exactly as a full tablet does.
      await page.evaluate(() => {
        window.__realSetItem = Storage.prototype.setItem;
        Storage.prototype.setItem = function () {
          throw new DOMException('quota exceeded', 'QuotaExceededError');
        };
        const s = window.__beatRehab.store.getState();
        s.addResult({ ...s.history[0], id: `s_refused_${Date.now()}` });
        window.__beatRehab.gotoScreen('results');
      });
      await page.waitForSelector('[data-testid="results-save-problem"]');
      await page.waitForTimeout(250);
      await page.screenshot({ path: resolve(SHOT_DIR, `save-refused-page-${tag}.png`), fullPage: true });
      await page.locator('[data-testid="results-save"]').screenshot({ path: resolve(SHOT_DIR, `save-refused-${tag}.png`) });

      const refused = await page.evaluate(() => {
        const t = (id) => document.querySelector(`[data-testid="${id}"]`);
        return {
          badge: t('results-save-state')?.textContent ?? null,
          cls: t('results-save-state')?.className ?? null,
          card: t('results-save')?.textContent ?? '',
          retry: !!t('results-save-retry'),
          exportBtn: !!t('results-save-export'),
          free: !!t('results-save-free-space'),
        };
      });
      check(/NOT saved/.test(refused.badge ?? ''), `${tag}: a refused write says NOT saved (${refused.badge})`);
      check((refused.cls ?? '').includes('badge-bad'), `${tag}: and it is not green`);
      check(refused.retry && refused.exportBtn && refused.free, `${tag}: the therapist is given a retry, an export and a way to free space`);
      check(/only copy of this session/.test(refused.card), `${tag}: and told that leaving the screen loses the session`);

      // The retry reports the SECOND verdict, not the first.
      await page.evaluate(() => { Storage.prototype.setItem = window.__realSetItem; });
      await page.click('[data-testid="results-save-retry"]');
      await page.waitForTimeout(250);
      const afterRetry = await page.evaluate(() => ({
        badge: document.querySelector('[data-testid="results-save-state"]').textContent,
        note: document.querySelector('[data-testid="results-save-note"]')?.textContent ?? null,
      }));
      await page.locator('[data-testid="results-save"]').screenshot({ path: resolve(SHOT_DIR, `save-retried-${tag}.png`) });
      check(/Saved to history/.test(afterRetry.badge), `${tag}: the retry flips the badge only when it lands (${afterRetry.badge})`);
      check(/attempt 2/.test(afterRetry.badge), `${tag}: and says how many tries it took`);

      check(errors.length === 0, `${tag}: no console or page errors (${errors.slice(0, 2).join(' | ')})`);
      await page.close();
    }

    // ---- 2. the ending, driven by the real runner ------------------------------------
    for (const [width, height] of [[1024, 768], [1280, 800]]) {
      const tag = `${width}`;
      const page = await browser.newPage({ viewport: { width, height } });
      const errors = [];
      page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
      await page.goto(`${BASE}/?input=autoplay&seed=7`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!window.__beatRehab, null, { timeout: 30_000 });
      await page.evaluate(() => window.__beatRehab.startPlayNow({ songId: 'demo-groove' }));
      await page.waitForSelector('canvas');
      await page.waitForFunction(() => window.__beatRehab.getRunner()?.getPhase() === 'playing', null, { timeout: 30_000 });
      await page.waitForTimeout(2500);

      const beforeReps = await page.evaluate(() => window.__beatRehab.getScore().reps);
      // The chart runs out. Everything after this is the real runner's own ending.
      await page.evaluate(() => window.__beatRehab.getRunner().endOfChart());
      await page.waitForTimeout(1700);
      await page.screenshot({ path: resolve(SHOT_DIR, `finale-${tag}.png`) });

      const fin = await page.evaluate(() => {
        const r = window.__beatRehab.getRunner();
        const looks = [];
        for (let i = 0; i < 4; i++) {
          const l = r.highway.receptorLookOf(i);
          if (l) looks.push({ lane: i, suspended: l.suspended === true });
        }
        return { phase: r.getPhase(), looks, spec: r.finaleSpec ? r.finaleSpec() : null, reps: r.hud().reps };
      });
      log(`  phase ${fin.phase}; receptors ${JSON.stringify(fin.looks)}`);
      check(fin.phase === 'finale', `${tag}: the real runner is playing its ending`);
      check(fin.looks.length > 0 && fin.looks.every((l) => !l.suspended), `${tag}: no lane is blanked to "nothing registers" while the ending counts`);
      check(/still counting/.test(fin.spec?.heroNote ?? ''), `${tag}: the card says the count is still running (${fin.spec?.heroNote})`);
      check(/no notes left/.test(fin.spec?.heroNote ?? ''), `${tag}: and what has actually stopped`);
      check(/movements still count/.test(fin.spec?.hint ?? ''), `${tag}: the hint says the same thing in a sentence`);
      check(fin.reps >= beforeReps, `${tag}: the rep count did not reset when the chart ran out`);

      // Later in the sequence, with the hint on screen.
      await page.waitForTimeout(2600);
      await page.screenshot({ path: resolve(SHOT_DIR, `finale-late-${tag}.png`) });
      check(errors.length === 0, `${tag}: the ending raised no page errors (${errors.slice(0, 2).join(' | ')})`);
      await page.close();
    }
  } finally {
    await browser.close();
    server.kill('SIGTERM');
  }

  if (failures.length > 0) {
    console.error(`\n[record] ${failures.length} FAILED:\n - ${failures.join('\n - ')}`);
    process.exit(1);
  }
  log('PASSED');
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
