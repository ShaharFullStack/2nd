/**
 * Proves the two therapist-facing claims IN THE RUNNING APP, not only in jsdom:
 *
 *  1. An offset applied on the Results screen survives the latency screen that every next session
 *     passes through — including a page reload in between, which is what a clinic tablet really does.
 *  2. Inside one trend card, the accuracy column and the ROM point for a session sit at the same x,
 *     on bunched real dates.
 *
 *   node critic/verify-therapist-gaps.mjs [--headed] [--url http://localhost:5173]
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SHOT_DIR = resolve(HERE, 'screenshots');
const PORT = Number(process.env.SMOKE_PORT ?? 5177);
const args = process.argv.slice(2);
const urlArg = args.includes('--url') ? args[args.indexOf('--url') + 1] : null;
const BASE = urlArg ?? `http://localhost:${PORT}`;
const log = (...m) => console.log('[gaps]', ...m);

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

const DAY = 86_400_000;

/** Four sessions in one week, a fourteen-week gap, two more: the shape that exposed the axis bug. */
function bunchedHistory() {
  const base = Date.now() - 140 * DAY;
  const days = [0, 2, 4, 6, 104, 106];
  return days
    .map((d, i) => ({
      id: `v${i}`,
      startedAt: base + d * DAY,
      endedAt: base + d * DAY + 120_000,
      durationSec: 120,
      mode: 'leg',
      difficulty: 'medium',
      windowScale: 1,
      inputMode: 'camera',
      songId: 'demo-groove',
      songTitle: 'Demo Groove',
      artist: 'A',
      attribution: '',
      score: 1000 + i,
      stars: 3,
      accuracy: 0.45 + i * 0.08,
      starAccuracy: 0.5,
      maxCombo: 8,
      totalNotes: 40,
      hits: 30,
      perfects: 15,
      goods: 15,
      misses: 10,
      reps: 30,
      health: 1,
      timingBiasMs: null,
      timingBiasMadMs: null,
      latencyOffsetMs: 120,
      suggestedLatencyMs: null,
      completed: true,
      lanes: [
        {
          lane: 0,
          movement: 'knee_extension',
          side: 'left',
          label: 'L knee extension',
          hits: 30,
          perfects: 15,
          goods: 15,
          misses: 10,
          judged: 40,
          accuracy: 0.45 + i * 0.08,
          reps: 30,
          timingBiasMs: null,
          timingBiasMadMs: null,
          romMean: 0.45 + i * 0.06,
          romBest: 0.6 + i * 0.05,
          romSamples: 30,
          romUncertain: 0,
          calibratedMin: 20,
          calibratedMax: 80,
          calibrationManual: false,
          compensationKind: null,
          compensationMonitored: false,
          compensationFlags: 0,
          compensationWorst: null,
        },
      ],
    }))
    .reverse();
}

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
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--use-gl=swiftshader'],
  });
  const failures = [];
  const check = (ok, what) => {
    log(ok ? 'ok  ' : 'FAIL', what);
    if (!ok) failures.push(what);
  };

  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    // No `?input=keyboard`: the latency screen is camera-only and App bounces a dev input off it.
    await page.goto(`${BASE}/`);
    await page.waitForFunction(() => !!window.__beatRehab);

    // ---- 1. the applied offset survives the latency screen -------------------------------------
    // Exactly what the Results hand-over does: "use 280 ms next session".
    const applied = await page.evaluate(() =>
      window.__beatRehab.store.getState().applySuggestedLatency(280, 'Demo Groove, today'),
    );
    check(applied && applied.appliedMs === 280, `Results applied 280 ms (got ${JSON.stringify(applied)})`);

    // Close the tablet and open it again: the next session is a fresh page load.
    await page.reload();
    await page.waitForFunction(() => !!window.__beatRehab);
    const afterReload = await page.evaluate(() => {
      const s = window.__beatRehab.getState();
      return { ms: Math.round(s.latencyOffsetSec * 1000), measured: s.latencyMeasured, note: s.latencyNote, setAt: s.latencySetAt };
    });
    check(afterReload.ms === 280, `280 ms survives the reload (got ${afterReload.ms})`);
    check(afterReload.measured === true, 'the reload keeps "measured"');
    check(/Demo Groove/.test(afterReload.note), `the reload keeps the provenance note (got "${afterReload.note}")`);

    await page.evaluate(() => window.__beatRehab.gotoScreen('latency'));
    await page.waitForSelector('[data-testid="latency-skip"]');
    const skipText = (await page.textContent('[data-testid="latency-skip"]')).trim();
    check(/keep 280 ms/i.test(skipText), `the skip button names what it keeps: "${skipText}"`);
    const provenance = (await page.textContent('[data-testid="latency-provenance"]')).trim();
    check(/Demo Groove/.test(provenance), `the sidebar names where 280 ms came from: "${provenance.slice(0, 90)}…"`);
    await page.screenshot({ path: resolve(SHOT_DIR, 'verify-latency-keeps.png') });

    await page.click('[data-testid="latency-skip"]');
    await page.waitForFunction(() => window.__beatRehab.getState().screen === 'play');
    const afterSkip = await page.evaluate(() => ({
      ms: Math.round(window.__beatRehab.getState().latencyOffsetSec * 1000),
      stored: localStorage.getItem('beatRehab:latency'),
    }));
    check(afterSkip.ms === 280, `skipping KEPT 280 ms in the store (got ${afterSkip.ms})`);
    check(afterSkip.stored === '0.28', `skipping KEPT 0.28 in localStorage (got ${afterSkip.stored})`);

    // ... and that is the value Play hands the engine: `inputLatencySec: inputMode === 'camera'
    // ? st.latencyOffsetSec : 0` (src/ui/Play.tsx), so on a camera session the run is judged at 280 ms.
    const judged = await page.evaluate(() => {
      const s = window.__beatRehab.getState();
      return { inputMode: s.inputMode, sec: s.latencyOffsetSec };
    });
    check(
      judged.inputMode === 'camera' && Math.abs(judged.sec - 0.28) < 1e-6,
      `the session about to play is judged at 0.28 s (${JSON.stringify(judged)})`,
    );

    // A device that has never had a latency still gets the default offered.
    await page.evaluate(() => {
      localStorage.clear();
    });
    await page.reload();
    await page.waitForFunction(() => !!window.__beatRehab);
    await page.evaluate(() => window.__beatRehab.gotoScreen('latency'));
    await page.waitForSelector('[data-testid="latency-skip"]');
    const freshSkip = (await page.textContent('[data-testid="latency-skip"]')).trim();
    check(/use 120 ms/i.test(freshSkip), `a fresh device is offered the default: "${freshSkip}"`);

    // ---- 2. one horizontal axis per trend card --------------------------------------------------
    await page.evaluate((history) => {
      localStorage.setItem('beatRehab:history', JSON.stringify(history));
    }, bunchedHistory());
    await page.reload();
    await page.waitForFunction(() => !!window.__beatRehab);
    await page.evaluate(() => window.__beatRehab.gotoScreen('history'));
    await page.waitForSelector('[data-testid="trend-knee_extension:left"]');

    const geometry = await page.evaluate(() => {
      const card = document.querySelector('[data-testid="trend-knee_extension:left"]');
      const line = card.querySelector('svg[aria-label*="range of motion"]');
      const bars = card.querySelector('svg[aria-label*="accuracy"]');
      const points = (line.querySelector('polyline').getAttribute('points') || '')
        .split(' ')
        .map((p) => Number(p.split(',')[0]));
      const cols = [...bars.querySelectorAll('rect')].map(
        (r) => Number(r.getAttribute('x')) + Number(r.getAttribute('width')) / 2,
      );
      return { points, cols, cardWidth: card.getBoundingClientRect().width, grid: card.parentElement.getBoundingClientRect().width };
    });
    const maxDrift = Math.max(...geometry.cols.map((c, i) => Math.abs(c - geometry.points[i])));
    check(geometry.cols.length === geometry.points.length, 'a column per plotted session');
    check(maxDrift < 0.5, `column and point share an x (worst drift ${maxDrift.toFixed(2)} user units)`);
    const gaps = geometry.points.slice(1).map((x, i) => x - geometry.points[i]);
    check(Math.max(...gaps) > gaps[0] * 10, 'the fourteen-week gap really is the widest gap on the axis');
    check(
      geometry.cardWidth > geometry.grid * 0.9,
      `a single movement card uses the width (card ${Math.round(geometry.cardWidth)} of ${Math.round(geometry.grid)} px)`,
    );
    await page.screenshot({ path: resolve(SHOT_DIR, 'verify-trend-shared-axis.png') });
    // The stacked pair on its own, which is where the cross-read happens.
    const card = await page.$('[data-testid="trend-knee_extension:left"]');
    await card.screenshot({ path: resolve(SHOT_DIR, 'verify-trend-card.png') });

    // ---- 3. the quiet prose is legible ---------------------------------------------------------
    const dim = await page.evaluate(() => {
      const el = document.querySelector('[data-testid^="trend-denominator-"]');
      const cs = getComputedStyle(el);
      return { size: parseFloat(cs.fontSize), color: cs.color, text: el.textContent.slice(0, 60) };
    });
    check(dim.size >= 16, `the ROM denominator disclosure is ${dim.size} px`);
    check(dim.color === 'rgb(159, 171, 199)', `... in the AA colour (${dim.color})`);

    // ---- 4. the camera-failure screen still reads after the type-size change -------------------
    // This browser was launched with no fake device, so getUserMedia really does fail here.
    await page.evaluate(() => window.__beatRehab.gotoScreen('camera'));
    await page.waitForSelector('[data-testid="camera-retry"]', { timeout: 30_000 });
    const fallback = await page.evaluate(() => {
      const small = [...document.querySelectorAll('.dim')].map((el) => ({
        size: parseFloat(getComputedStyle(el).fontSize),
        text: el.textContent.trim().slice(0, 50),
      }));
      const targets = [...document.querySelectorAll('button')].map((b) => b.getBoundingClientRect().height);
      return { smallest: Math.min(...small.map((s) => s.size)), shortest: Math.min(...targets), n: small.length };
    });
    check(fallback.smallest >= 16, `every quiet line on the camera-failure screen is >= 16 px (min ${fallback.smallest})`);
    check(fallback.shortest >= 44, `every button on it is >= 44 px tall (min ${fallback.shortest})`);
    await page.screenshot({ path: resolve(SHOT_DIR, 'verify-camera-fallback-type.png') });
  } finally {
    await browser.close();
    if (server) server.kill('SIGTERM');
  }

  if (failures.length > 0) {
    console.error('[gaps] FAILED:\n  ' + failures.join('\n  '));
    process.exit(1);
  }
  log('PASSED');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
