import { chromium } from 'playwright';
const OUT = '/tmp/claude-0/-home-user-2nd/a10f947c-ef5b-515c-aee2-bf90f9d49567/scratchpad/shots';
const BASE = 'http://localhost:5188';
const EXE = '/opt/pw-browsers/chromium';

const TABLET = { width: 1024, height: 768 };

function lane(i, movement, side, opts = {}) {
  return {
    lane: i, movement, side, label: `${side === 'left' ? 'L' : 'R'} ${movement}`,
    hits: 40, perfects: 25, goods: 15, misses: 8, judged: 48, accuracy: opts.acc ?? 0.83, reps: 52,
    timingBiasMs: 12, timingBiasMadMs: 20,
    romMean: opts.rom ?? 0.72, romBest: (opts.rom ?? 0.72) + 0.15, romSamples: opts.rom === null ? 0 : 50, romUncertain: 2,
    calibratedMin: 0, calibratedMax: opts.span ?? 1, calibrationManual: false,
    compensationKind: 'heel_lift', compensationMonitored: true, compensationFlags: opts.flags ?? 1,
    compensationWorst: 0.02,
    ...(opts.fingertip ? { fingertip: opts.fingertip } : {}),
  };
}
function session(n, at, lanes, patch = {}) {
  return {
    id: `s${n}`, startedAt: at, endedAt: at + 180000, durationSec: 97, mode: 'leg', difficulty: 'medium',
    windowScale: 1, inputMode: 'camera', songId: 'demo-groove', songTitle: 'Demo Groove', artist: 'A',
    attribution: 'x', score: 1200 + n * 100, stars: 3, accuracy: 0.8, starAccuracy: 0.78, maxCombo: 20,
    totalNotes: 100, hits: 80, perfects: 50, goods: 30, misses: 20, reps: 104, health: 0.8,
    timingBiasMs: 12, timingBiasMadMs: 20, latencyOffsetMs: 120, suggestedLatencyMs: null,
    completed: true, lanes, ...patch,
  };
}

const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--no-sandbox', '--use-gl=swiftshader'] });

async function shot(page, name, full = true) {
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: full });
  console.log('shot', name);
}

// ---------- 1. Setup screen, camera mode, tablet ----------
{
  const page = await browser.newPage({ viewport: TABLET });
  page.on('console', (m) => m.type() === 'error' && console.log('  [console error]', m.text()));
  await page.goto(`${BASE}/?input=keyboard&screen=setup`);
  await page.waitForSelector('[data-testid="setup-start"]');
  await page.waitForTimeout(800);
  await shot(page, '01-setup-leg-tablet');

  // hand mode with finger opposition on two lanes
  await page.evaluate(() => {
    const s = window.__beatRehab.store.getState();
    s.setMode('hand');
    s.setLanes([
      { index: 0, movement: 'finger_opposition', side: 'left' },
      { index: 1, movement: 'finger_opposition', side: 'right', fingertip: 'pinky' },
      { index: 2, movement: 'hand_open_close', side: 'left' },
    ]);
  });
  await page.waitForTimeout(500);
  await shot(page, '02-setup-fingertip-tablet');
  console.log('lanes after set:', JSON.stringify(await page.evaluate(() => window.__beatRehab.store.getState().lanes)));
  console.log('calibrationKeys:', JSON.stringify(await page.evaluate(() => Object.keys(window.__beatRehab.store.getState().savedCalibrations))));

  // click pinky on lane 0 and check store + calibration reset
  await page.click('[data-testid="lane-0-tip-ring"]');
  await page.waitForTimeout(300);
  console.log('lane0 after ring click:', JSON.stringify(await page.evaluate(() => window.__beatRehab.store.getState().lanes[0])));
  await shot(page, '03-setup-fingertip-after-click');
  await page.close();
}

// ---------- 2. History with trends ----------
{
  const page = await browser.newPage({ viewport: TABLET });
  page.on('console', (m) => m.type() === 'error' && console.log('  [console error]', m.text()));
  await page.goto(`${BASE}/?input=keyboard`);
  await page.waitForFunction(() => !!window.__beatRehab);
  await page.evaluate(({ }) => {}, {});
  await page.evaluate(() => {
    const mk = (n, at, lanes, patch = {}) => ({
      id: `s${n}`, startedAt: at, endedAt: at + 180000, durationSec: 97, mode: 'leg', difficulty: 'medium',
      windowScale: 1, inputMode: 'camera', songId: 'demo-groove', songTitle: 'Demo Groove', artist: 'A',
      attribution: 'x', score: 1200 + n * 100, stars: 3, accuracy: 0.8, starAccuracy: 0.78, maxCombo: 20,
      totalNotes: 100, hits: 80, perfects: 50, goods: 30, misses: 20, reps: 104, health: 0.8,
      timingBiasMs: 12, timingBiasMadMs: 20, latencyOffsetMs: 120, suggestedLatencyMs: null,
      completed: true, lanes, ...patch,
    });
    const lane = (i, movement, side, opts = {}) => ({
      lane: i, movement, side, label: opts.label ?? `${side === 'left' ? 'L' : 'R'} ${movement}`,
      hits: 40, perfects: 25, goods: 15, misses: 8, judged: 48, accuracy: opts.acc ?? 0.83, reps: 52,
      timingBiasMs: 12, timingBiasMadMs: 20,
      romMean: opts.rom === undefined ? 0.72 : opts.rom,
      romBest: opts.rom === undefined ? 0.87 : (opts.rom === null ? null : opts.rom + 0.15),
      romSamples: opts.rom === null ? 0 : 50, romUncertain: 2,
      calibratedMin: 0, calibratedMax: opts.span ?? 1, calibrationManual: false,
      compensationKind: 'heel_lift', compensationMonitored: true, compensationFlags: 1, compensationWorst: 0.02,
      ...(opts.fingertip ? { fingertip: opts.fingertip } : {}),
    });
    const day = 86400000;
    const now = Date.now();
    const hist = [];
    // newest first
    const roms = [0.86, 0.83, 0.78, null, 0.71, 0.66, 0.62, 0.55];
    const accs = [0.91, 0.88, 0.86, 0.70, 0.81, 0.77, 0.72, 0.66];
    for (let k = 0; k < 8; k++) {
      hist.push(mk(k, now - k * 3 * day, [
        lane(0, 'knee_extension', 'left', { rom: roms[k], acc: accs[k], label: 'L knee extension', span: k >= 4 ? 40 : 55 }),
        lane(1, 'finger_opposition', 'right', { rom: roms[k] === null ? null : roms[k] * 0.8, acc: accs[k] - 0.1, fingertip: 'pinky', label: 'R little-finger pinch' }),
      ]));
    }
    const s = window.__beatRehab.store.getState();
    useStoreSet(s, hist);
    function useStoreSet(state, h) {
      window.__beatRehab.store.setState({ history: h });
    }
    state_noop();
    function state_noop() {}
    window.__beatRehab.store.getState().goto('history');
  });
  await page.waitForSelector('[data-testid="rom-trend"]');
  await page.waitForTimeout(500);
  await shot(page, '04-history-trends-tablet');
  // 2m readability crop: top of trend area only
  await page.screenshot({ path: `${OUT}/05-history-trends-viewport.png` });
  await page.click('[data-testid="trend-window-4"]');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/06-history-trends-last4.png` });
  await page.close();
}

// ---------- 3. Results with latency handover ----------
{
  const page = await browser.newPage({ viewport: TABLET });
  page.on('console', (m) => m.type() === 'error' && console.log('  [console error]', m.text()));
  await page.goto(`${BASE}/?input=keyboard`);
  await page.waitForFunction(() => !!window.__beatRehab);
  await page.evaluate(() => {
    const lane = (i, movement, side) => ({
      lane: i, movement, side, label: `${side === 'left' ? 'L' : 'R'} ${movement}`,
      hits: 40, perfects: 25, goods: 15, misses: 28, judged: 68, accuracy: 0.59, reps: 92,
      timingBiasMs: 210, timingBiasMadMs: 22, romMean: 0.7, romBest: 0.9, romSamples: 60, romUncertain: 1,
      calibratedMin: 0, calibratedMax: 55, calibrationManual: false,
      compensationKind: 'heel_lift', compensationMonitored: true, compensationFlags: 3, compensationWorst: 0.03,
    });
    const r = {
      id: 'x1', startedAt: Date.now() - 200000, endedAt: Date.now(), durationSec: 97, mode: 'leg',
      difficulty: 'medium', windowScale: 1, inputMode: 'camera', songId: 'demo-groove',
      songTitle: 'Demo Groove', artist: 'A', attribution: 'x', score: 900, stars: 2, accuracy: 0.59,
      starAccuracy: 0.55, maxCombo: 9, totalNotes: 136, hits: 80, perfects: 50, goods: 30, misses: 56,
      reps: 184, health: 0.4, timingBiasMs: 210, timingBiasMadMs: 22, latencyOffsetMs: 120,
      suggestedLatencyMs: 330, completed: true,
      lanes: [lane(0, 'knee_extension', 'left'), lane(1, 'seated_march', 'right')],
    };
    window.__beatRehab.store.setState({ lastResult: r });
    window.__beatRehab.store.getState().goto('results');
  });
  await page.waitForSelector('[data-testid="latency-handover"]');
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/07-results-latency.png` });
  console.log('latency before apply (sec):', await page.evaluate(() => window.__beatRehab.store.getState().latencyOffsetSec));
  await page.click('[data-testid="apply-latency"]');
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/08-results-latency-applied.png` });
  console.log('latency after apply (sec):', await page.evaluate(() => window.__beatRehab.store.getState().latencyOffsetSec));
  console.log('ls latency:', await page.evaluate(() => localStorage.getItem('beatrehab.latency') ?? Object.keys(localStorage).map(k=>k+'='+localStorage.getItem(k)).join('|')));
  await page.close();
}

// ---------- 4. Camera fallback ----------
{
  const ctx = await browser.newContext({ viewport: TABLET });
  const page = await ctx.newPage();
  page.on('console', (m) => m.type() === 'error' && console.log('  [console error]', m.text()));
  await page.goto(`${BASE}/?input=camera&screen=camera`);
  await page.waitForTimeout(4000);
  await page.screenshot({ path: `${OUT}/09-camera-fallback.png`, fullPage: true });
  const txt = await page.evaluate(() => document.body.innerText.slice(0, 900));
  console.log('--- camera screen text ---\n' + txt);
  const has = await page.$('[data-testid="camera-fallback"]');
  console.log('fallback present:', !!has);
  if (has) {
    await page.click('[data-testid="camera-retry"]');
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${OUT}/10-camera-fallback-retry.png`, fullPage: true });
    console.log('after retry text:', (await page.evaluate(() => document.body.innerText.slice(0, 400))));
  }
  await ctx.close();
}

await browser.close();
