/**
 * ROUND-2 VERIFICATION, IN THE RUNNING APP.
 *
 *  1. HOME never headlines a maximum across a mixed prescription: every movement is named beside
 *     its own figure, and the unaffected limb's 65° is not the card's only number.
 *  2. Every clinically load-bearing column on Results and History is either on screen or announced
 *     by a live cue (clientWidth vs scrollWidth, measured, plus the arrows actually scrolling).
 *  3. Cards fill their grid cells — no card shorter than ~85 % of its row.
 *  4. The song-end sequence leads with the work: the hero figure is bigger than the score.
 *
 *   node critic/verify-ending-and-headline.mjs [--headed]
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SHOT_DIR = resolve(HERE, 'screenshots', 'round2');
const PORT = Number(process.env.PORT ?? 5491);
const args = process.argv.slice(2);
const BASE = `http://localhost:${PORT}`;
const log = (...m) => console.log('[round2]', ...m);
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

/**
 * A REAL HEMIPARETIC PRESCRIPTION. The affected side is the LEFT seated march (a small, hard-won
 * body-scaled ratio inside a 0.10–0.42 calibrated range); the unaffected side is the RIGHT knee
 * extension, which reaches 65° without trying. Any max across the two is the right knee.
 */
function lane(i, movement, side, { reps, romMean, romBest, min, max, acc, comp }) {
  return {
    lane: i, movement, side,
    movementName: `${side === 'left' ? 'Left' : 'Right'} ${movement === 'seated_march' ? 'Seated march' : movement === 'knee_extension' ? 'Knee extension' : 'Ankle dorsiflexion'}`,
    hits: Math.round(reps * acc), perfects: Math.round(reps * acc * 0.5), goods: Math.round(reps * acc * 0.5),
    misses: reps - Math.round(reps * acc), judged: reps, accuracy: acc,
    reps, attempted: Math.round(reps * 0.9), surplus: 2,
    timingBiasMs: 42, timingBiasMadMs: 60,
    romMean, romBest, romSamples: reps, romUncertain: 1,
    calibratedMin: min, calibratedMax: max, calibrationManual: false,
    compensationKind: comp ?? null, compensationMonitored: !!comp, compensationFlags: comp ? 3 : 0,
    compensationWorst: comp ? 0.22 : null,
  };
}

function session(i, { at, completed = true, patientId, patientName, march, knee, ankle }) {
  const lanes = [
    lane(0, 'seated_march', 'left', march),
    lane(1, 'knee_extension', 'right', knee),
    ...(ankle ? [lane(2, 'ankle_dorsiflexion', 'left', ankle)] : []),
  ];
  const reps = lanes.reduce((n, l) => n + l.reps, 0);
  const hits = lanes.reduce((n, l) => n + l.hits, 0);
  const judged = lanes.reduce((n, l) => n + l.judged, 0);
  return {
    id: `sess-${patientId}-${i}`, patientId, patientName,
    startedAt: at, endedAt: at + 97_000, durationSec: completed ? 97 : 23,
    mode: 'leg', difficulty: 'medium', windowScale: 1, inputMode: 'camera',
    songId: 'demo-groove', songTitle: 'Demo Groove', artist: 'Bosca Ceoil',
    attribution: '"Demo Groove" by Bosca Ceoil (ccmixter.org) is licensed under CC BY 4.0',
    score: 1200 + i * 900, stars: 2, accuracy: hits / judged, starAccuracy: hits / judged,
    maxCombo: 9 + i, totalNotes: judged + 12, hits, perfects: Math.round(hits / 2), goods: Math.round(hits / 2),
    misses: judged - hits, reps, answerRate: 0.62, surplusMovements: 6, laneRestSec: 1.2,
    timingBiasMs: 44, timingBiasMadMs: 61, latencyOffsetMs: 140, suggestedLatencyMs: 160,
    completed, ...(completed ? {} : { endReason: 'quit' }),
    tracking: {
      samples: 180, fpsMedian: 27.5, fpsLow: 19, inferenceMsMedian: 22, trackedFraction: 0.94,
      lowFpsFraction: 0.08, delegate: 'GPU', worstReason: null,
    },
    lanes,
  };
}

function seed() {
  const base = Date.now() - 40 * DAY;
  const mk = (i, at, completed, k) =>
    session(i, {
      at, completed, patientId: 'p-rowan', patientName: 'Rowan Iyer',
      march: { reps: 42 + i * 3, romMean: 0.52 + k, romBest: 0.62 + k, min: 0.10, max: 0.42, acc: 0.31 },
      knee: { reps: 39 + i * 2, romMean: 0.82, romBest: 0.91, min: 8, max: 70, acc: 0.74 },
      ankle: { reps: 21 + i, romMean: 0.40 + k, romBest: 0.48 + k, min: 2, max: 24, acc: 0.22, comp: 'heel_lift' },
    });
  const rowan = [
    mk(0, base, true, 0),
    mk(1, base + 7 * DAY, true, 0.03),
    mk(2, base + 14 * DAY, false, 0.01),
    mk(3, base + 21 * DAY, true, 0.06),
    mk(4, base + 33 * DAY, true, 0.09),
  ];
  const other = [
    session(9, {
      at: base + 30 * DAY, patientId: 'p-devi', patientName: 'Devi Okonkwo',
      march: { reps: 30, romMean: 0.6, romBest: 0.7, min: 0.1, max: 0.5, acc: 0.5 },
      knee: { reps: 30, romMean: 0.7, romBest: 0.8, min: 10, max: 75, acc: 0.6 },
    }),
  ];
  return {
    patients: [
      { id: 'p-rowan', name: 'Rowan Iyer', createdAt: base - DAY, lastUsedAt: base + 33 * DAY },
      { id: 'p-devi', name: 'Devi Okonkwo', createdAt: base - DAY, lastUsedAt: base + 30 * DAY },
    ],
    history: [...rowan, ...other].sort((a, b) => b.startedAt - a.startedAt),
  };
}

/** Every horizontal scroller on the page, with the header cells that sit outside its viewport. */
const overflowProbe = () => {
  const out = [];
  for (const el of document.querySelectorAll('.table-wrap')) {
    const box = el.getBoundingClientRect();
    const heads = [...el.querySelectorAll('th')].map((th) => ({
      text: (th.textContent || '').trim(),
      right: Math.round(th.getBoundingClientRect().right),
      left: Math.round(th.getBoundingClientRect().left),
    }));
    const cue = el.parentElement?.querySelector('[data-testid$="scroll-cue"]');
    out.push({
      testId: el.getAttribute('data-testid'),
      clientWidth: el.clientWidth,
      scrollWidth: el.scrollWidth,
      right: Math.round(box.right),
      cue: cue ? (cue.textContent || '').trim().slice(0, 120) : null,
      cueButtons: cue ? [...cue.querySelectorAll('button')].map((b) => Math.round(b.getBoundingClientRect().height)) : [],
      heads: heads.map((h) => h.text),
      clipped: heads.filter((h) => h.right > Math.round(box.right) + 1).map((h) => h.text),
    });
  }
  return out;
};

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

      // ---- HOME ---------------------------------------------------------------------------
      await page.evaluate(() => window.__beatRehab.gotoScreen('home'));
      await page.waitForSelector('[data-testid="home-last-ranges"]');
      const home = await page.evaluate(() => {
        const card = document.querySelector('[data-testid="home-last-ranges"]');
        return { text: (card.textContent || '').replace(/\s+/g, ' ').trim() };
      });
      log('HOME ranges:', home.text.slice(0, 260));
      if (w === 1024) {
        check(/Left Seated march/.test(home.text), 'Home names the affected movement');
        check(/Right Knee extension/.test(home.text), 'Home names the unaffected movement beside it');
        check(!/Best range/.test(await page.textContent('body')), 'Home no longer prints an unlabelled "Best range"');
      }
      await page.screenshot({ path: resolve(SHOT_DIR, `home-${w}.png`), fullPage: true });
      {
        const card = await page.$('[data-testid="home-last-ranges"]');
        await card.scrollIntoViewIfNeeded();
        await page.waitForTimeout(200);
        await page.screenshot({ path: resolve(SHOT_DIR, `home-card-${w}.png`) });
        const wrapped = await page.evaluate(() => {
          const rows = [...document.querySelectorAll('[data-testid^="home-last-range-"]')];
          return rows.map((r) => ({ h: Math.round(r.getBoundingClientRect().height), t: (r.textContent || '').replace(/\s+/g, ' ').trim() }));
        });
        for (const r of wrapped) log(`  home row (${r.h} px): ${r.t}`);
      }

      // ---- RESULTS ------------------------------------------------------------------------
      await page.evaluate((r) => window.__beatRehab.store.setState({ lastResult: r }), data.history[0]);
      await page.evaluate(() => window.__beatRehab.gotoScreen('results'));
      await page.waitForSelector('[data-testid="results-range"]');
      await page.evaluate(() => { const d = document.querySelector('[data-testid="results-clinical"]'); if (d) d.open = true; });
      await page.waitForTimeout(250);
      const resultsOverflow = await page.evaluate(overflowProbe);
      for (const t of resultsOverflow) {
        const over = t.scrollWidth - t.clientWidth > 4;
        log(`  results ${t.testId}: client ${t.clientWidth} scroll ${t.scrollWidth} clipped=[${t.clipped}] cue=${t.cue ? 'yes' : 'no'} btnH=${t.cueButtons}`);
        check(!over || (t.cue && t.cueButtons.every((b) => b >= 44)), `${w}: results table ${t.testId} announces its overflow with 44px targets`);
      }
      const cards = await page.evaluate(() => {
        const rows = new Map();
        for (const c of document.querySelectorAll('.card-grid > .card')) {
          const b = c.getBoundingClientRect();
          const key = Math.round(b.top);
          if (!rows.has(key)) rows.set(key, []);
          rows.get(key).push({ id: c.getAttribute('data-testid'), h: Math.round(b.height) });
        }
        return [...rows.values()].filter((r) => r.length > 1);
      });
      for (const row of cards) {
        const tallest = Math.max(...row.map((c) => c.h));
        for (const c of row) check(c.h >= tallest * 0.85, `${w}: results card ${c.id} fills its cell (${c.h} of ${tallest} px)`);
      }
      for (const id of ['results-reps', 'results-today-table', 'results-clinical-table']) {
        const el = await page.$(`[data-testid="${id}"]`);
        if (!el) continue;
        await el.scrollIntoViewIfNeeded();
        await page.waitForTimeout(200);
        await page.screenshot({ path: resolve(SHOT_DIR, `results-${id}-${w}.png`) });
      }

      // ---- HISTORY ------------------------------------------------------------------------
      await page.evaluate(() => window.__beatRehab.gotoScreen('history'));
      await page.waitForSelector('[data-testid="history-table"]');
      await page.evaluate(() => { for (const d of document.querySelectorAll('details.trend-points')) d.open = true; });
      await page.waitForTimeout(300);
      const histOverflow = await page.evaluate(overflowProbe);
      for (const t of histOverflow) {
        const over = t.scrollWidth - t.clientWidth > 4;
        log(`  history ${t.testId}: client ${t.clientWidth} scroll ${t.scrollWidth} clipped=[${t.clipped}] cue=${t.cue ? 'yes' : 'no'} btnH=${t.cueButtons}`);
        check(!over || (t.cue && t.cueButtons.every((b) => b >= 44)), `${w}: history table ${t.testId} announces its overflow with 44px targets`);
      }
      // The arrows really move the scroller.
      const moved = await page.evaluate(() => {
        const el = [...document.querySelectorAll('.table-wrap')].find((e) => e.scrollWidth - e.clientWidth > 8);
        if (!el) return null;
        const cue = el.parentElement.querySelector('[data-testid$="scroll-cue"]');
        const before = el.scrollLeft;
        cue.querySelectorAll('button')[1].click();
        return new Promise((r) => setTimeout(() => r({ before, after: el.scrollLeft, id: el.getAttribute('data-testid') }), 700));
      });
      if (moved) check(moved.after > moved.before, `${w}: the right arrow scrolls ${moved.id} (${moved.before} → ${moved.after})`);
      const historyHead = await page.evaluate(() => [...document.querySelectorAll('[data-testid="history-table"] thead th')].map((t) => t.textContent.trim()));
      log('  history columns:', historyHead.join(' | '));
      const trendHead = (histOverflow.find((t) => (t.testId || '').startsWith('trend-points-table-')) || {}).heads || null;
      log('  trend point columns:', trendHead && trendHead.join(' | '));
      if (w === 1024) {
        check(historyHead[2] === 'Movements performed', 'History leads with the work');
        check(trendHead && trendHead[1] === 'Reps', 'the per-movement list puts Reps right after the date');
      }
      // ...and again with the scoring columns unfolded, which is what really overflows.
      await page.click('[data-testid="history-toggle-scoring"]');
      await page.waitForTimeout(350);
      const histScored = await page.evaluate(overflowProbe);
      for (const t of histScored.filter((x) => x.testId === 'history-table')) {
        log(`  history+scoring: client ${t.clientWidth} scroll ${t.scrollWidth} clipped=[${t.clipped}] cue=${t.cue ? 'yes' : 'no'}`);
        check(t.heads.slice(0, 5).join('|') === 'When|Session|Movements performed|Range worked|Length', 'the work columns stay first when scoring is shown');
        const over = t.scrollWidth - t.clientWidth > 4;
        check(!over || (t.cue && t.cueButtons.every((b) => b >= 44)), `${w}: history+scoring announces its overflow`);
        check(!t.clipped.includes('Movements performed') && !t.clipped.includes('Range worked'), `${w}: reps and range are on screen even with scoring shown`);
      }
      {
        const el = await page.$('[data-testid="history-table"]');
        await el.scrollIntoViewIfNeeded();
        await page.waitForTimeout(200);
        await page.screenshot({ path: resolve(SHOT_DIR, `history-scoring-${w}.png`) });
      }
      await page.click('[data-testid="history-toggle-scoring"]');
      await page.waitForTimeout(200);
      for (const id of ['trend-seated_march:left', 'trend-points-table-seated_march:left', 'history-table']) {
        const el = await page.$(`[data-testid="${id}"]`);
        if (!el) continue;
        await el.scrollIntoViewIfNeeded();
        await page.waitForTimeout(200);
        await page.screenshot({ path: resolve(SHOT_DIR, `history-${id.replace(':', '-')}-${w}.png`) });
      }
      await page.close();
    }

    // ---- THE ENDING, at the real play-canvas size for each clinic viewport ------------------
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
      log(`play canvas at ${w}x${h}: ${geom.w}x${geom.h} at (${geom.x},${geom.y})`);

      const result = await page.evaluate(async (g) => {
        const hwMod = await import('/src/render/Highway.ts');
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(g.w * g.dpr);
        canvas.height = Math.round(g.h * g.dpr);
        canvas.style.cssText = `position:fixed;left:${g.x}px;top:${g.y}px;width:${g.w}px;height:${g.h}px;z-index:99999;background:#05070f`;
        document.body.appendChild(canvas);
        const hw = new hwMod.Highway(canvas, { laneCount: 3 });
        hw.resize(g.w, g.h, g.dpr);
        // A WORST-CASE CLINIC SESSION: 142 movements, 6 notes answered, 0 points.
        const SPEC = {
          title: 'SONG COMPLETE', subtitle: 'Demo Groove', score: 0,
          stats: [
            { value: '142', label: 'MOVEMENTS' }, { value: '6/189', label: 'NOTES ANSWERED' },
            { value: '2', label: 'LONGEST RUN' }, { value: '1:37', label: 'TIME MOVING' },
          ],
          achievement: '142 movements performed',
          achievementNote: 'Every rep counted, whether or not it landed on a note.',
          hint: 'Tap the screen or press any key for the report',
        };
        const frame = hwMod.makeFrame({
          lanes: [{ movement: 'seated_march', side: 'left' }, { movement: 'knee_extension', side: 'right' }, { movement: 'ankle_dorsiflexion', side: 'left' }],
          songTime: 97, thresholdFraction: 0.5,
        });
        window.__fin = { hw, frame, SPEC, mod: hwMod };
        hw.startFinale(SPEC);
        while (!hw.finaleDone()) { hw.advanceFinale(1 / 60); hw.draw(frame); }
        return { end: hw.finaleElapsed(), sec: hwMod.FINALE_SEC };
      }, geom);
      check(result.end >= result.sec, `${w}: the ending ends itself (${result.end.toFixed(2)} s of ${result.sec} s)`);
      await page.screenshot({ path: resolve(SHOT_DIR, `finale-${w}-end.png`) });

      for (const at of [1.5, 3.2, 4.6]) {
        await page.evaluate((target) => {
          const { hw, frame, SPEC } = window.__fin;
          hw.clearFinale();
          hw.startFinale(SPEC);
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
