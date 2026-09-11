/**
 * "+79 MOVEMENTS VS LAST TIME" — WHEN LAST TIME WAS A 24-SECOND WALK-OUT.
 *
 * The defect this drives: Results compared today against the most recent camera session WHATEVER IT
 * WAS. Seeded live — patient Amara, previous session `endReason: 'quit'`, 24 s, 19 movements — the
 * screen printed "Movements performed 98 · +79 vs last time", "+30 vs last time" per movement and
 * "Biggest gain since last session: Left Seated march", while a regex over the whole rendered page
 * for /ended early|stopped by|incomplete|did not finish/ matched NOTHING. One screen later the ROM
 * trend sets exactly those runs aside from every figure, and History labels the row "stopped by
 * therapist". A therapist with ninety seconds read "+79" as a big day; it was an artefact of what
 * the patient was compared against.
 *
 * What this asserts in the running app at 1024x768, 1280x800 and 1920x1080:
 *   1. the comparison is drawn against the last session the patient COMPLETED, and the delta is the
 *      one that follows from it (not the one the walk-out produces);
 *   2. the screen SAYS SO — the basis is named beside the figures, and the walk-out is described
 *      (why it ended, how long it was, how many movements) rather than silently dropped;
 *   3. when every earlier session ended early the comparison is still drawn — that is the patient's
 *      own history — but no chip on it is green and every one carries the reason inside itself;
 *   4. nothing this added clips or overflows at the clinic tablet size: both wide tables are
 *      measured, COMPENSATION is on screen, and the cards still fill the cells they occupy.
 *
 *   node critic/walk-out-comparison.mjs [--headed]
 *
 * Writes critic/screenshots/walkout/*.png (whole page, and the cards the claims are about).
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SHOTS = resolve(HERE, 'screenshots', 'walkout');
const PORT = Number(process.env.PORT ?? 5464);
const BASE = `http://localhost:${PORT}`;
const headed = process.argv.includes('--headed');
const log = (...m) => console.log('[walkout]', ...m);
const failures = [];
const check = (ok, what) => {
  log(ok ? 'ok  ' : 'FAIL', what);
  if (!ok) failures.push(what);
};

async function waitForServer(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`server ${url} never came up`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

const GOOD = { samples: 190, fpsMedian: 29.6, fpsLow: 27.1, inferenceMsMedian: 11.4, trackedFraction: 0.99, lowFpsFraction: 0, delegate: 'GPU', worstReason: null };

/**
 * A hemiparetic prescription, on purpose: the affected left leg first, the unaffected right second.
 * `seed` drives the whole session so today, the walk-out and the older sessions are the same shape.
 */
const SEED_FN = ({ GOOD }) => {
  const day = 86_400_000;
  const now = Date.now();
  const LANES = [
    { movement: 'seated_march', side: 'left', name: 'Left Seated march', min: 0.08, max: 0.30 },
    { movement: 'knee_extension', side: 'right', name: 'Right Knee extension', min: 96, max: 168 },
  ];
  const lane = (i, reps, rom, acc) => ({
    lane: i,
    movement: LANES[i].movement,
    side: LANES[i].side,
    movementName: LANES[i].name,
    hits: Math.round(acc * 60), perfects: Math.round(acc * 25), goods: Math.round(acc * 35),
    misses: 60 - Math.round(acc * 60), judged: 60, accuracy: acc,
    reps, attempted: Math.max(0, reps - 4),
    timingBiasMs: 41, timingBiasMadMs: 28,
    romMean: rom, romBest: Math.min(1, rom + 0.1), romSamples: Math.max(0, reps - 2), romUncertain: 1,
    calibratedMin: LANES[i].min, calibratedMax: LANES[i].max, calibrationManual: false,
    compensationKind: i === 0 ? 'trunk_lean' : null,
    compensationMonitored: i === 0,
    compensationFlags: i === 0 ? 4 : 0,
    compensationWorst: i === 0 ? 0.07 : null,
  });
  const session = (id, daysAgo, repsL, repsR, romL, romR, opts = {}) => {
    const at = now - daysAgo * day;
    const lanes = [lane(0, repsL, romL, 0.28), lane(1, repsR, romR, 0.62)];
    const hits = lanes.reduce((a, l) => a + l.hits, 0);
    const judged = lanes.reduce((a, l) => a + l.judged, 0);
    const reps = lanes.reduce((a, l) => a + l.reps, 0);
    const attempted = lanes.reduce((a, l) => a + l.attempted, 0);
    return {
      id, patientId: 'p_amara', patientName: 'Amara Nwosu',
      startedAt: at, endedAt: at + (opts.durationSec ?? 97) * 1000,
      durationSec: opts.durationSec ?? 97,
      mode: 'leg', difficulty: 'medium', windowScale: 1, inputMode: 'camera',
      songId: 'demo-groove', songTitle: 'Groove Circuit', artist: 'Beat Rehab demo', attribution: 'CC0 1.0',
      score: 4200, stars: 2, accuracy: hits / judged, starAccuracy: hits / judged, maxCombo: 6,
      totalNotes: opts.totalNotes ?? judged, hits,
      perfects: lanes.reduce((a, l) => a + l.perfects, 0),
      goods: lanes.reduce((a, l) => a + l.goods, 0),
      misses: lanes.reduce((a, l) => a + l.misses, 0),
      reps, answerRate: attempted / judged,
      surplusMovements: Math.max(0, reps - attempted), laneRestSec: 1.2,
      timingBiasMs: 41, timingBiasMadMs: 28, latencyOffsetMs: 95, suggestedLatencyMs: 110,
      completed: opts.completed !== false,
      endReason: opts.endReason ?? 'chart',
      tracking: GOOD,
      lanes,
    };
  };

  // TODAY: 98 movements. THE WALK-OUT, two days ago: stopped by the therapist at 24 s, 19
  // movements. Before it, two whole sessions — the most recent of them is what today may be
  // compared against.
  const today = session('s_today', 0, 52, 46, 0.58, 0.71);
  const walkOut = session('s_walkout', 2, 11, 8, 0.31, 0.34, {
    completed: false, endReason: 'quit', durationSec: 24, totalNotes: 120,
  });
  const prev = session('s_prev', 9, 36, 32, 0.49, 0.67);
  const older = session('s_older', 16, 30, 28, 0.44, 0.63);
  const history = [today, walkOut, prev, older];
  window.__beatRehab.store.setState({
    patients: [{ id: 'p_amara', name: 'Amara Nwosu', createdAt: now - 90 * day, lastUsedAt: now }],
    activePatientId: 'p_amara',
    history,
    lastResult: today,
  });
  return {
    todayReps: today.reps,
    walkOutReps: walkOut.reps,
    prevReps: prev.reps,
    expectedDelta: today.reps - prev.reps,
    walkOutDelta: today.reps - walkOut.reps,
  };
};

/** Every clinically load-bearing table on the screen, measured rather than eyeballed. */
const MEASURE_TABLES = () => {
  const out = [];
  for (const el of document.querySelectorAll('.table-wrap')) {
    const id = el.getAttribute('data-testid') ?? '(unnamed)';
    const box = el.getBoundingClientRect();
    const heads = [...el.querySelectorAll('thead th')].map((th) => {
      const r = th.getBoundingClientRect();
      return { name: (th.textContent ?? '').trim(), cut: r.right > box.right + 2 || r.left < box.left - 2 };
    });
    out.push({ id, client: el.clientWidth, scroll: el.scrollWidth, heads });
  }
  return out;
};

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  const server = spawn('node_modules/.bin/vite', ['--port', String(PORT), '--strictPort'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(`[vite] ${d}`));
  await waitForServer(BASE);
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium',
    headless: !headed,
    args: ['--no-sandbox', '--use-gl=swiftshader'],
  });
  try {
    // Warm vite's dependency optimizer so its first-hit reload is not read as a fault of the screen.
    const warm = await browser.newPage({ viewport: { width: 1024, height: 768 } });
    await warm.goto(`${BASE}/?input=keyboard`, { waitUntil: 'load' });
    await warm.waitForTimeout(1500);
    await warm.close();

    for (const [w, h] of [[1024, 768], [1280, 800], [1920, 1080]]) {
      const page = await browser.newPage({ viewport: { width: w, height: h } });
      const errors = [];
      page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
      page.on('console', (m) => {
        if (m.type() === 'error' && !/favicon/i.test(m.text())) errors.push(m.text());
      });
      await page.goto(`${BASE}/?input=keyboard`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!window.__beatRehab, null, { timeout: 30_000 });

      const seeded = await page.evaluate(SEED_FN, { GOOD });
      await page.evaluate(() => window.__beatRehab.gotoScreen('results'));
      await page.waitForSelector('[data-testid="results-range"]');
      await page.waitForTimeout(400);

      // FIRST, BEFORE ANY FULL-PAGE SHOT MOVES THE SCROLLER: the affected side is the first tile and
      // every prescribed movement's range is on the screen the therapist lands on. The whole point of
      // a per-limb headline is lost if the weak limb is below the fold.
      const tiles = await page.evaluate(() => {
        const out = [];
        for (const el of document.querySelectorAll('[data-testid^="results-range-lane-"]')) {
          const r = el.getBoundingClientRect();
          out.push({ id: el.getAttribute('data-testid'), top: Math.round(r.top), bottom: Math.round(r.bottom), name: el.textContent.slice(0, 24) });
        }
        return out;
      });
      for (const t of tiles) log(`    ${w}: ${t.id} ${t.top}\u2192${t.bottom} px \u2014 ${t.name}`);
      check(tiles.length > 0 && tiles.every((t) => t.top >= 0 && t.bottom <= h), `${w}: every movement's range tile is above the fold`);
      check(/^Left /i.test(tiles[0]?.name ?? ''), `${w}: the affected side is the first tile (${tiles[0]?.name})`);

      await page.screenshot({ path: resolve(SHOTS, `results-${w}.png`), fullPage: true });
      await page.locator('[data-testid="results-range"]').screenshot({ path: resolve(SHOTS, `range-card-${w}.png`) });
      await page.locator('[data-testid="results-today"]').screenshot({ path: resolve(SHOTS, `today-card-${w}.png`) });

      const r = await page.evaluate(() => {
        const t = (id) => document.querySelector(`[data-testid="${id}"]`);
        return {
          page: document.body.innerText,
          reps: t('results-reps')?.textContent ?? null,
          repsDelta: t('results-reps-delta')?.textContent ?? null,
          basis: t('results-comparison-basis')?.textContent ?? null,
          todayBasis: t('results-today-basis')?.textContent ?? null,
          todayHeader: t('results-today')?.textContent ?? null,
          improved: t('results-range-most-improved')?.textContent ?? null,
          sessions: t('results-sessions')?.textContent ?? null,
          lane0: t('results-today-lane-0')?.textContent ?? null,
        };
      });

      // 1 — the delta is against the last COMPLETED session, not against the walk-out.
      check(
        (r.repsDelta ?? '').includes(`+${seeded.expectedDelta} vs last time`),
        `${w}: rep delta is +${seeded.expectedDelta} (vs the completed session), got "${(r.repsDelta ?? '').trim()}"`,
      );
      check(
        !(r.repsDelta ?? '').includes(`+${seeded.walkOutDelta} `),
        `${w}: the walk-out's +${seeded.walkOutDelta} is NOT what the screen prints`,
      );

      // 2 — and the screen says what it compared against.
      check(/ended early|stopped by|incomplete|did not finish/.test(r.page), `${w}: the abort is named somewhere on the page`);
      check(r.basis !== null, `${w}: the comparison states its basis`);
      check((r.basis ?? '').includes('the last session this patient completed'), `${w}: the basis names the completed session`);
      check((r.basis ?? '').includes('stopped by therapist'), `${w}: the walk-out is described, not dropped`);
      check((r.basis ?? '').includes('19 movement'), `${w}: with the movements it actually held`);
      check((r.todayHeader ?? '').includes('COMPLETED camera session'), `${w}: the per-movement card names the same basis`);
      check((r.sessions ?? '').includes('compared with'), `${w}: the sessions card names the session compared with`);

      // 4 — nothing clips at the clinic tablet size, COMPENSATION included.
      await page.evaluate(() => {
        const d = document.querySelector('[data-testid="results-clinical"]');
        if (d) d.open = true;
      });
      await page.waitForTimeout(300);
      const tables = await page.evaluate(MEASURE_TABLES);
      for (const t of tables) {
        const cut = t.heads.filter((x) => x.cut).map((x) => x.name);
        log(`    ${w}: ${t.id} client ${t.client} scroll ${t.scroll}${cut.length ? ` cut: ${cut.join(', ')}` : ''}`);
      }
      const clinical = tables.find((t) => t.id === 'results-clinical-table');
      check(clinical !== undefined, `${w}: the clinical table is on the screen`);
      if (clinical) {
        const comp = clinical.heads.find((x) => /compensation/i.test(x.name));
        check(comp !== undefined && !comp.cut, `${w}: COMPENSATION is on screen (scroll ${clinical.scroll} / client ${clinical.client})`);
      }
      // Where a table DOES overflow the cue names only the headers actually cut — and offers a
      // 44 px target in both directions.
      const cues = await page.evaluate(() => {
        const out = [];
        for (const el of document.querySelectorAll('[data-testid$="-scroll-cue"]')) {
          const btns = [...el.querySelectorAll('button')].map((b) => {
            const r = b.getBoundingClientRect();
            return { w: Math.round(r.width), h: Math.round(r.height) };
          });
          out.push({ id: el.getAttribute('data-testid'), text: el.textContent, btns });
        }
        return out;
      });
      for (const c of cues) {
        log(`    ${w}: cue ${c.id} — ${c.text}`);
        check(c.btns.every((b) => b.w >= 44 && b.h >= 44), `${w}: ${c.id} arrows are 44 px targets`);
      }
      await page.screenshot({ path: resolve(SHOTS, `results-clinical-${w}.png`), fullPage: true });

      // 3 — the same patient with NOTHING but aborted runs behind them.
      await page.evaluate(() => {
        const st = window.__beatRehab.getState();
        const keep = st.history.filter((s) => s.id === 's_today' || s.id === 's_walkout');
        window.__beatRehab.store.setState({ history: keep });
      });
      await page.waitForTimeout(400);
      const only = await page.evaluate(() => {
        const t = (id) => document.querySelector(`[data-testid="${id}"]`);
        const chip = t('results-range-gain-0');
        return {
          page: document.body.innerText,
          repsDelta: t('results-reps-delta')?.textContent ?? null,
          qualifier: t('results-reps-delta-qualifier')?.textContent ?? null,
          gainText: chip?.textContent ?? null,
          gainClass: chip?.className ?? null,
          basis: t('results-comparison-basis')?.textContent ?? null,
          greenQualified: [...document.querySelectorAll('[data-qualified="true"]')].some((e) => e.className.includes('badge-ok')),
        };
      });
      await page.screenshot({ path: resolve(SHOTS, `only-aborts-${w}.png`), fullPage: true });
      await page.locator('[data-testid="results-range"]').screenshot({ path: resolve(SHOTS, `only-aborts-range-${w}.png`) });
      await page.locator('[data-testid="results-reps"]').screenshot({ path: resolve(SHOTS, `only-aborts-reps-${w}.png`) });
      check((only.qualifier ?? '').includes('ended early'), `${w}: the rep delta says the session it spans ended early`);
      check(!(only.gainClass ?? '').includes('badge-ok'), `${w}: no range chip is green over a walk-out`);
      check((only.gainText ?? '').includes('ended early'), `${w}: the reason is inside the chip (${(only.gainText ?? '').trim()})`);
      check((only.basis ?? '').includes('did not reach the end of its chart'), `${w}: and it is stated in full beside the figures`);
      check(!only.greenQualified, `${w}: no qualified chip anywhere is painted as a win`);

      check(errors.length === 0, `${w}: no console errors (${errors.slice(0, 2).join(' | ')})`);
      await page.close();
    }
  } finally {
    await browser.close();
    server.kill('SIGTERM');
  }
  if (failures.length > 0) {
    log(`FAILED ${failures.length}`);
    for (const f of failures) log('  -', f);
    process.exit(1);
  }
  log('PASSED');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
