/**
 * ROUND-3 VERIFICATION, IN THE RUNNING APP.
 *
 *  1. No screen says "same as last time" and "biggest gain today" about one number, and the
 *     unaffected limb is never named as the day's achievement on a sub-resolution change.
 *  2. Every wide table's cue names ONLY the columns it measured as clipped — never one the
 *     therapist is looking straight at — with 44 px targets that really page the scroller.
 *  3. Every card fills the cell it occupies, at all three clinic sizes.
 *  4. The ending leads with the work, counts the movements made DURING it, names no limb, and
 *     fits its hint on the canvas.
 *
 *   node critic/verify-round3-ending.mjs [--headed]
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SHOT_DIR = resolve(HERE, 'screenshots', 'round3');
const PORT = Number(process.env.PORT ?? 5493);
const args = process.argv.slice(2);
const BASE = `http://localhost:${PORT}`;
const log = (...m) => console.log('[round3]', ...m);
const DAY = 86_400_000;

const failures = [];
const check = (ok, what) => {
  log(ok ? 'ok  ' : 'FAIL', what);
  if (!ok) failures.push(what);
};

async function waitForServer(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up */ }
    if (Date.now() > deadline) throw new Error(`server ${url} never came up`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

const NAMES = { seated_march: 'Seated march', knee_extension: 'Knee extension', ankle_dorsiflexion: 'Ankle dorsiflexion' };

function lane(i, movement, side, { reps, romMean, romBest, min, max, acc, comp }) {
  const hits = Math.round(reps * acc);
  return {
    lane: i, movement, side,
    movementName: `${side === 'left' ? 'Left' : 'Right'} ${NAMES[movement]}`,
    hits, perfects: Math.round(hits / 2), goods: hits - Math.round(hits / 2),
    misses: reps - hits, judged: reps, accuracy: acc,
    reps, attempted: Math.round(reps * 0.9), surplus: Math.max(0, reps - Math.round(reps * 0.9)),
    timingBiasMs: 42, timingBiasMadMs: 60,
    romMean, romBest, romSamples: reps, romUncertain: 1,
    calibratedMin: min, calibratedMax: max, calibrationManual: false,
    compensationKind: comp ?? null, compensationMonitored: !!comp, compensationFlags: comp ? 3 : 0,
    compensationWorst: comp ? 0.22 : null,
  };
}

function session(i, { at, completed = true, patientId, patientName, march, knee, ankle }) {
  const lanes = [lane(0, 'seated_march', 'left', march), lane(1, 'knee_extension', 'right', knee), lane(2, 'ankle_dorsiflexion', 'left', ankle)];
  const reps = lanes.reduce((n, l) => n + l.reps, 0);
  const hits = lanes.reduce((n, l) => n + l.hits, 0);
  const judged = lanes.reduce((n, l) => n + l.judged, 0);
  const attempted = lanes.reduce((n, l) => n + l.attempted, 0);
  return {
    id: `sess-${patientId}-${i}`, patientId, patientName,
    startedAt: at, endedAt: at + 97_000, durationSec: completed ? 97 : 23,
    mode: 'leg', difficulty: 'medium', windowScale: 1, inputMode: 'camera',
    songId: 'demo-groove', songTitle: 'Demo Groove', artist: 'Bosca Ceoil',
    attribution: '"Demo Groove" by Bosca Ceoil (ccmixter.org) is licensed under CC BY 4.0',
    score: 1200 + i * 900, stars: 2, accuracy: hits / judged, starAccuracy: hits / judged,
    maxCombo: 9 + i, totalNotes: judged + 12, hits, perfects: Math.round(hits / 2), goods: hits - Math.round(hits / 2),
    misses: judged - hits, reps, answerRate: attempted / judged, surplusMovements: reps - attempted, laneRestSec: 1.2,
    timingBiasMs: 44, timingBiasMadMs: 61, latencyOffsetMs: 140, suggestedLatencyMs: 160,
    completed, ...(completed ? {} : { endReason: 'quit' }),
    tracking: { samples: 180, fpsMedian: 27.5, fpsLow: 19, inferenceMsMedian: 22, trackedFraction: 0.94, lowFpsFraction: 0.08, delegate: 'GPU', worstReason: null },
    lanes,
  };
}

/**
 * THE CASE THE CRITIC FOUND. Today's knee extension is 0.15° above last session's — under one
 * degree AND under half a point of its own 62° range, i.e. unmeasurable — while the affected left
 * march is exactly flat and the ankle went backwards. Before the fix this rendered "same as last
 * time" and "biggest gain today" on one tile, and the card header named the unaffected limb.
 */
function seed() {
  const base = Date.now() - 40 * DAY;
  const mk = (i, at, completed, kneeBest) =>
    session(i, {
      at, completed, patientId: 'p-rowan', patientName: 'Rowan Iyer',
      march: { reps: 42, romMean: 0.52, romBest: 0.62, min: 0.10, max: 0.42, acc: 0.31 },
      knee: { reps: 39, romMean: 0.82, romBest: kneeBest, min: 8, max: 70, acc: 0.74 },
      ankle: { reps: 21, romMean: 0.40 - i * 0.02, romBest: 0.48 - i * 0.02, min: 2, max: 24, acc: 0.22, comp: 'heel_lift' },
    });
  const KNEE_SPAN = 62;
  const rowan = [
    mk(0, base, true, 0.90),
    mk(1, base + 7 * DAY, true, 0.905),
    mk(2, base + 14 * DAY, false, 0.90),
    mk(3, base + 21 * DAY, true, 0.91 - 0.15 / KNEE_SPAN), // last session
    mk(4, base + 33 * DAY, true, 0.91), // today: +0.15°, unmeasurable
  ];
  return {
    patients: [{ id: 'p-rowan', name: 'Rowan Iyer', createdAt: base - DAY, lastUsedAt: base + 33 * DAY }],
    history: [...rowan].sort((a, b) => b.startedAt - a.startedAt),
  };
}

/** Every horizontal scroller, its measured clipping, and what its cue actually says. */
const overflowProbe = () => {
  const out = [];
  for (const el of document.querySelectorAll('.table-wrap')) {
    const box = el.getBoundingClientRect();
    const heads = [...el.querySelectorAll('thead th')].map((th) => ({
      text: (th.textContent || '').trim(),
      right: th.getBoundingClientRect().right,
      left: th.getBoundingClientRect().left,
    }));
    const cue = el.parentElement?.querySelector('[data-testid$="scroll-cue"]');
    out.push({
      testId: el.getAttribute('data-testid'),
      clientWidth: el.clientWidth,
      scrollWidth: el.scrollWidth,
      cue: cue ? (cue.textContent || '').replace(/\s+/g, ' ').trim() : null,
      cueButtons: cue ? [...cue.querySelectorAll('button')].map((b) => {
        const r = b.getBoundingClientRect();
        return [Math.round(r.width), Math.round(r.height)];
      }) : [],
      heads: heads.map((h) => h.text),
      clippedRight: heads.filter((h) => h.right > box.right + 2).map((h) => h.text),
      clippedLeft: heads.filter((h) => h.left < box.left - 2).map((h) => h.text),
    });
  }
  return out;
};

/** Column names the cue mentions, out of the table's own headers. */
function namedInCue(t) {
  if (!t.cue) return [];
  return t.heads.filter((h) => h && t.cue.includes(h));
}

async function main() {
  mkdirSync(SHOT_DIR, { recursive: true });
  let server = null;
  if (!args.includes('--url')) {
    server = spawn('node_modules/.bin/vite', ['--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stderr.on('data', (d) => process.stderr.write(`[vite] ${d}`));
    await waitForServer(BASE);
  }
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium',
    headless: !args.includes('--headed'),
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--use-gl=swiftshader'],
  });
  const data = seed();

  try {
    for (const [w, h] of [[1024, 768], [1280, 800], [1920, 1080]]) {
      const page = await browser.newPage({ viewport: { width: w, height: h } });
      await page.goto(`${BASE}/`);
      await page.waitForFunction(() => !!window.__beatRehab);
      await page.evaluate((d) => {
        localStorage.setItem('beatRehab:patients', JSON.stringify(d.patients));
        localStorage.setItem('beatRehab:history', JSON.stringify(d.history));
        localStorage.setItem('beatRehab:activePatient', JSON.stringify('p-rowan'));
      }, data);
      await page.reload();
      await page.waitForFunction(() => !!window.__beatRehab);
      await page.evaluate(() => window.__beatRehab.store.getState().selectPatient?.('p-rowan'));
      await page.waitForTimeout(300);

      // ---- RESULTS ----------------------------------------------------------------------
      await page.evaluate((r) => window.__beatRehab.store.setState({ lastResult: r }), data.history[0]);
      await page.evaluate(() => window.__beatRehab.gotoScreen('results'));
      await page.waitForSelector('[data-testid="results-range"]');
      await page.evaluate(() => { const d = document.querySelector('[data-testid="results-clinical"]'); if (d) d.open = true; });
      await page.waitForTimeout(300);

      const tiles = await page.evaluate(() => {
        const out = [];
        for (const t of document.querySelectorAll('[data-testid^="results-range-lane-"]')) {
          out.push({
            id: t.getAttribute('data-testid'),
            text: (t.textContent || '').replace(/\s+/g, ' ').trim(),
            gain: t.querySelector('[data-testid^="results-range-gain-"]')?.textContent?.trim() ?? null,
            gainClass: t.querySelector('[data-testid^="results-range-gain-"]')?.className ?? null,
            improved: !!t.querySelector('[data-testid^="results-range-improved-"]'),
            h: Math.round(t.getBoundingClientRect().height),
          });
        }
        const header = document.querySelector('[data-testid="results-range-most-improved"]');
        return { out, header: header ? header.textContent.trim() : null };
      });
      for (const t of tiles.out) log(`  ${w} ${t.id}: gain="${t.gain}" class="${t.gainClass}" improved=${t.improved}`);
      log(`  ${w} most-improved header:`, tiles.header);
      for (const t of tiles.out) {
        check(!(t.improved && /same as last time/.test(t.gain ?? '')),
          `${w}: ${t.id} does not say "same as last time" and "biggest gain today" at once`);
        check(!(/same as last time/.test(t.gain ?? '') && /badge-ok/.test(t.gainClass ?? '')),
          `${w}: ${t.id} does not colour "same as last time" as a gain`);
      }
      check(tiles.header === null, `${w}: no limb is named "biggest gain" on an unmeasurable change (header: ${tiles.header})`);

      const resultsOverflow = await page.evaluate(overflowProbe);
      for (const t of resultsOverflow) {
        const over = t.scrollWidth - t.clientWidth > 4;
        const named = namedInCue(t);
        log(`  ${w} results ${t.testId}: client ${t.clientWidth} scroll ${t.scrollWidth} clippedR=[${t.clippedRight}] named=[${named}] btn=${JSON.stringify(t.cueButtons)}`);
        check(!over || (t.cue && t.cueButtons.every(([bw, bh]) => bw >= 44 && bh >= 44)), `${w}: ${t.testId} announces its overflow with 44px targets`);
        for (const n of named) {
          check(t.clippedRight.includes(n) || t.clippedLeft.includes(n), `${w}: ${t.testId} cue names "${n}", which really is off screen`);
        }
        if (over) check(named.length > 0 || t.clippedRight.length === 0, `${w}: ${t.testId} cue names the clipped columns`);
      }

      const cards = await page.evaluate(() => {
        const rows = new Map();
        for (const c of document.querySelectorAll('.card-grid > .card')) {
          const b = c.getBoundingClientRect();
          const key = Math.round(b.top);
          if (!rows.has(key)) rows.set(key, []);
          rows.get(key).push({ id: c.getAttribute('data-testid'), h: Math.round(b.height), pad: Math.round(b.bottom - (c.lastElementChild?.getBoundingClientRect().bottom ?? b.bottom)) });
        }
        return [...rows.values()].filter((r) => r.length > 1);
      });
      for (const row of cards) {
        const tallest = Math.max(...row.map((c) => c.h));
        for (const c of row) {
          log(`  ${w} card ${c.id}: ${c.h} px of ${tallest}, ${c.pad} px below its last child`);
          check(c.h >= tallest * 0.85, `${w}: card ${c.id} fills its cell (${c.h} of ${tallest} px)`);
          check(c.pad <= 40, `${w}: card ${c.id} has no dead space below its content (${c.pad} px)`);
        }
      }
      for (const id of ['results-range', 'results-reps', 'results-today-table', 'results-clinical-table']) {
        const el = await page.$(`[data-testid="${id}"]`);
        if (!el) continue;
        await el.scrollIntoViewIfNeeded();
        await page.waitForTimeout(200);
        await page.screenshot({ path: resolve(SHOT_DIR, `results-${id}-${w}.png`) });
      }

      // ---- HISTORY ----------------------------------------------------------------------
      await page.evaluate(() => window.__beatRehab.gotoScreen('history'));
      await page.waitForSelector('[data-testid="history-table"]');
      await page.evaluate(() => { for (const d of document.querySelectorAll('details.trend-points')) d.open = true; });
      await page.waitForTimeout(350);
      const hist = await page.evaluate(overflowProbe);
      for (const t of hist) {
        const over = t.scrollWidth - t.clientWidth > 4;
        const named = namedInCue(t);
        log(`  ${w} history ${t.testId}: client ${t.clientWidth} scroll ${t.scrollWidth} clippedR=[${t.clippedRight}] named=[${named}]`);
        check(!over || (t.cue && t.cueButtons.every(([bw, bh]) => bw >= 44 && bh >= 44)), `${w}: ${t.testId} announces its overflow with 44px targets`);
        for (const n of named) {
          check(t.clippedRight.includes(n) || t.clippedLeft.includes(n), `${w}: ${t.testId} cue names "${n}", which really is off screen`);
        }
      }
      // The arrows page the scroller, and the cue then re-measures.
      const moved = await page.evaluate(() => {
        const el = [...document.querySelectorAll('.table-wrap')].find((e) => e.scrollWidth - e.clientWidth > 8);
        if (!el) return null;
        const cue = el.parentElement.querySelector('[data-testid$="scroll-cue"]');
        const before = el.scrollLeft;
        const text = cue.textContent.trim();
        cue.querySelectorAll('button')[1].click();
        return new Promise((r) => setTimeout(() => r({
          before, after: el.scrollLeft, id: el.getAttribute('data-testid'),
          text, after_text: cue.textContent.replace(/\s+/g, ' ').trim(),
        }), 800));
      });
      if (moved) {
        log(`  ${w} arrow: ${moved.id} ${moved.before} → ${moved.after}`);
        log(`     cue before: ${moved.text}`);
        log(`     cue after : ${moved.after_text}`);
        check(moved.after > moved.before, `${w}: the right arrow scrolls ${moved.id}`);
        check(moved.text !== moved.after_text, `${w}: the cue re-measures after the scroller moves`);
      }
      for (const id of ['history-table', 'trend-points-table-knee_extension:right']) {
        const el = await page.$(`[data-testid="${id}"]`);
        if (!el) continue;
        await el.scrollIntoViewIfNeeded();
        await page.waitForTimeout(200);
        await page.screenshot({ path: resolve(SHOT_DIR, `history-${id.replace(/[:]/g, '-')}-${w}.png`) });
      }
      await page.close();
    }

    // ---- THE ENDING -----------------------------------------------------------------------
    for (const [w, h] of [[1024, 768], [1280, 800], [1920, 1080]]) {
      const page = await browser.newPage({ viewport: { width: w, height: h } });
      await page.goto(`${BASE}/?input=autoplay&seed=7`);
      await page.waitForFunction(() => !!window.__beatRehab);
      await page.evaluate(() => window.__beatRehab.startPlayNow({ songId: 'demo-groove' }));
      await page.waitForSelector('canvas');
      await page.waitForTimeout(2500);
      const geom = await page.evaluate(() => {
        const c = document.querySelector('canvas');
        const b = c.getBoundingClientRect();
        return { w: Math.round(b.width), h: Math.round(b.height), x: Math.round(b.x), y: Math.round(b.y), dpr: devicePixelRatio };
      });
      log(`play canvas at ${w}x${h}: ${geom.w}x${geom.h}`);

      const built = await page.evaluate(async (g) => {
        const hwMod = await import('/src/render/Highway.ts');
        const grMod = await import('/src/session/GameRunner.ts');
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(g.w * g.dpr);
        canvas.height = Math.round(g.h * g.dpr);
        canvas.style.cssText = `position:fixed;left:${g.x}px;top:${g.y}px;width:${g.w}px;height:${g.h}px;z-index:99999;background:#05070f`;
        document.body.appendChild(canvas);
        const hw = new hwMod.Highway(canvas, { laneCount: 3 });
        hw.resize(g.w, g.h, g.dpr);

        // THE HARD CASE: a mixed hemiparetic prescription in which the UNAFFECTED knee is the only
        // lane that reached its whole calibrated range, and the patient answered 6 of 189 notes.
        const ach = grMod.sessionAchievement({
          reps: 142, hits: 6, judged: 189, maxCombo: 2,
          lanes: [
            { name: 'Left Seated march', bestPeak: 0.34 },
            { name: 'Right Knee extension', bestPeak: 0.96 },
            { name: 'Left Ankle dorsiflexion', bestPeak: 0.41 },
          ],
        });
        const spec = (reps) => ({
          title: 'SONG COMPLETE', subtitle: 'Demo Groove', score: 0,
          stats: [
            { value: String(reps), label: 'MOVEMENTS' }, { value: '6/189', label: 'NOTES ANSWERED' },
            { value: '2', label: 'LONGEST RUN' }, { value: '1:37', label: 'TIME MOVING' },
          ],
          achievement: ach.text, achievementNote: ach.note,
          hint: 'Ease off when you’re ready · tap the screen or press any key for the report',
        });
        const frame = hwMod.makeFrame({
          lanes: [{ movement: 'seated_march', side: 'left' }, { movement: 'knee_extension', side: 'right' }, { movement: 'ankle_dorsiflexion', side: 'left' }],
          songTime: 97, thresholdFraction: 0.5,
        });
        window.__fin = { hw, frame, spec, mod: hwMod };
        return { ach, sec: hwMod.FINALE_SEC, guard: hwMod.FINALE_SKIP_GUARD_SEC };
      }, geom);
      log('  achievement:', JSON.stringify(built.ach));
      if (w === 1024) {
        check(!/left|right|knee|march|ankle/i.test(built.ach.text), 'the ending names no limb in its one sentence');
        check(/1 of 3 movements/.test(built.ach.text), 'it counts the movements that reached full range instead of ranking them');
        check(/Right Knee extension 96%/.test(built.ach.note ?? ''), 'and the figure sits beside the movement it belongs to');
      }

      // The patient keeps marching through the payoff: the hero figure follows them.
      const live = await page.evaluate(async (target) => {
        const { hw, frame, spec } = window.__fin;
        hw.clearFinale();
        hw.startFinale(spec(142));
        let reps = 142;
        while (hw.finaleElapsed() < target) {
          hw.advanceFinale(1 / 60);
          if (Math.random() < 0.012) hw.updateFinale(spec(++reps));
          hw.draw(frame);
        }
        return reps;
      }, 4.6);
      log(`  hero figure after 4.6 s of the payoff: ${live} movements`);
      await page.screenshot({ path: resolve(SHOT_DIR, `finale-${w}-live.png`) });

      for (const at of [1.4, 3.0, 4.4, 6.2]) {
        await page.evaluate((target) => {
          const { hw, frame, spec } = window.__fin;
          hw.clearFinale();
          hw.startFinale(spec(142));
          while (hw.finaleElapsed() < target) { hw.advanceFinale(1 / 60); hw.draw(frame); }
        }, at);
        await page.screenshot({ path: resolve(SHOT_DIR, `finale-${w}-at-${String(at).replace('.', 'p')}.png`) });
      }
      await page.close();
    }
  } finally {
    await browser.close();
    server?.kill('SIGTERM');
  }
  log(failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} FAILED`);
  for (const f of failures) log('  -', f);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
