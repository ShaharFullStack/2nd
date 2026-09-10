/**
 * Capture MOTION evidence, not stills: a dense burst of consecutive frames around real
 * gameplay events, plus hard timing telemetry that a still frame cannot show.
 *
 *   node critic/motion.mjs                 # writes critic/motion/*.png + critic/motion/report.json
 *   node critic/motion.mjs --url http://localhost:5173
 *
 * Two things come out of this:
 *   1. burst-NN.png — consecutive frames ~50 ms apart across a hit and across a miss, so a
 *      critic can see how the juice actually animates (attack, peak, decay) instead of
 *      guessing from one frame.
 *   2. report.json — measured numbers: frame pacing, dropped frames, the delay between an
 *      input being delivered and the hit being visible, judgment delta distribution, and
 *      whether the audio clock and the render clock stay locked.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const argv = process.argv.slice(2);
const arg = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const OUT = resolve(ROOT, arg('--out', 'critic/motion'));
const PORT = Number(process.env.MOTION_PORT ?? 5179);
const urlArg = arg('--url', null);
const BASE = urlArg ?? `http://localhost:${PORT}`;
const log = (...m) => console.log('[motion]', ...m);

async function waitForServer(url, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server at ${url} never came up`);
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  let server = null;
  if (!urlArg) {
    log(`starting vite on :${PORT}`);
    server = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: process.env,
    });
    server.stderr.on('data', (d) => process.stderr.write(`[vite] ${d}`));
    await waitForServer(BASE);
  }

  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium',
    headless: true,
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--use-gl=swiftshader'],
  });

  const report = { capturedAt: new Date().toISOString(), notes: [] };
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.goto(`${BASE}/?input=autoplay`, { waitUntil: 'load' });
    await page.waitForTimeout(1500);

    const url = `${BASE}/?input=autoplay&mode=leg&lanes=seated_march:left,seated_march:right,knee_extension:left,knee_extension:right&difficulty=medium&seed=11`;
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.__beatRehab, null, { timeout: 30_000 });
    await page.getByTestId('start-session').click().catch(() => {});
    await page.getByTestId('mode-leg').click().catch(() => {});
    await page.waitForSelector('[data-testid="setup-start"]', { timeout: 20_000 });
    await page.getByTestId('setup-start').click();
    await page.waitForSelector('[data-testid="play-canvas"]', { timeout: 30_000 });
    await page.waitForFunction(() => window.__beatRehab?.getScore?.()?.phase === 'playing', null, { timeout: 120_000 });
    log('session playing');

    // --- frame pacing: sample rAF deltas for two seconds -----------------------------
    const pacing = await page.evaluate(async () => {
      const deltas = [];
      let last = performance.now();
      await new Promise((done) => {
        const t0 = last;
        const tick = (now) => {
          deltas.push(now - last);
          last = now;
          if (now - t0 < 2000) requestAnimationFrame(tick);
          else done();
        };
        requestAnimationFrame(tick);
      });
      deltas.shift();
      const sorted = [...deltas].sort((a, b) => a - b);
      const pct = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
      return {
        frames: deltas.length,
        meanMs: deltas.reduce((a, b) => a + b, 0) / deltas.length,
        medianMs: pct(0.5),
        p95Ms: pct(0.95),
        worstMs: sorted[sorted.length - 1],
        over33ms: deltas.filter((d) => d > 33).length,
      };
    });
    report.pacing = pacing;
    log('pacing', JSON.stringify(pacing));

    // --- audio/render clock lock: does song time advance in real time? ---------------
    const drift = await page.evaluate(async () => {
      const read = () => ({ song: window.__beatRehab.getScore().songTime, wall: performance.now() / 1000 });
      const a = read();
      await new Promise((r) => setTimeout(r, 3000));
      const b = read();
      const songElapsed = b.song - a.song;
      const wallElapsed = b.wall - a.wall;
      return { songElapsed, wallElapsed, driftMs: (songElapsed - wallElapsed) * 1000 };
    });
    report.clockDrift = drift;
    log('clock drift over 3 s', drift.driftMs.toFixed(1), 'ms');

    // --- burst around a hit -----------------------------------------------------------
    const burst = async (prefix, waitFor, count = 10, gapMs = 50) => {
      await page.evaluate(() => { window.__probe = { hits: window.__beatRehab.getScore().hits, misses: window.__beatRehab.getScore().misses }; });
      await page.waitForFunction(waitFor, null, { timeout: 30_000, polling: 16 });
      for (let i = 0; i < count; i++) {
        await page.screenshot({ path: resolve(OUT, `${prefix}-${String(i).padStart(2, '0')}.png`) });
        if (i < count - 1) await page.waitForTimeout(gapMs);
      }
      log(`captured ${count} frames for ${prefix}`);
    };

    await burst('hit', () => window.__beatRehab.getScore().hits > window.__probe.hits);

    // --- input-to-pixel latency: how long after a scored hit does the HUD move? -------
    const responsiveness = await page.evaluate(async () => {
      const start = performance.now();
      const before = window.__beatRehab.getScore();
      let seen = null;
      await new Promise((done) => {
        const tick = () => {
          const now = window.__beatRehab.getScore();
          if (now.hits > before.hits) { seen = performance.now() - start; done(); return; }
          if (performance.now() - start > 8000) { done(); return; }
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      return { hudUpdateWithinMs: seen };
    });
    report.responsiveness = responsiveness;

    // --- burst around a miss (stop feeding the engine) --------------------------------
    await page.evaluate(() => {
      const input = window.__beatRehab.getRunner?.()?.input;
      if (input && typeof input.stop === 'function') input.stop();
    });
    await burst('miss', () => window.__beatRehab.getScore().misses > window.__probe.misses);

    // --- judgment distribution: is the engine actually landing on the beat? -----------
    const final = await page.evaluate(() => window.__beatRehab.getScore());
    report.hud = {
      score: final.score, hits: final.hits, misses: final.misses,
      combo: final.combo, multiplier: final.multiplier,
      meanDeltaMs: final.meanDeltaMs, stdDeltaMs: final.stdDeltaMs,
    };
    log('final hud', JSON.stringify(report.hud));
  } catch (e) {
    report.error = String(e && e.stack ? e.stack : e);
    log('ERROR', report.error);
  } finally {
    await browser.close();
    if (server) {
      server.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 300));
      if (!server.killed) server.kill('SIGKILL');
    }
  }

  writeFileSync(resolve(OUT, 'report.json'), JSON.stringify(report, null, 2));
  log('wrote', resolve(OUT, 'report.json'));
  if (report.error) process.exit(1);
}

main().catch((e) => { console.error('[motion] crashed', e); process.exit(1); });
