/**
 * Capture a labelled set of gameplay frames for the visual critics.
 *
 *   node critic/frames.mjs                    # 1920x1080, writes critic/frames/*.png
 *   node critic/frames.mjs --out critic/frames-r2
 *   node critic/frames.mjs --url http://localhost:5173
 *
 * Frames are captured at moments that actually exercise the highway:
 *   stream   — a dense run of approaching notes, nothing being hit (readability)
 *   hit      — the frame right after a PERFECT (burst / flash / popup juice)
 *   miss     — the frame right after a miss (is the failure legible?)
 *   combo    — a high multiplier stretch (HUD under load)
 *   armed    — a lane meter part-way to threshold (the rehab-specific biofeedback)
 * plus the full-screen `intro` attribution card.
 *
 * The runner is driven through window.__beatRehab so the frames are the real
 * engine + renderer, not a mock.
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const EXECUTABLE = '/opt/pw-browsers/chromium';

const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const OUT = resolve(ROOT, arg('--out', 'critic/frames'));
const PORT = Number(process.env.FRAMES_PORT ?? 5178);
const urlArg = arg('--url', null);
const BASE = urlArg ?? `http://localhost:${PORT}`;
const WIDTH = Number(arg('--width', 1920));
const HEIGHT = Number(arg('--height', 1080));

const log = (...m) => console.log('[frames]', ...m);

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
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    server.stderr.on('data', (d) => process.stderr.write(`[vite] ${d}`));
    await waitForServer(BASE);
  }

  const browser = await chromium.launch({
    executablePath: EXECUTABLE,
    headless: true,
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--use-gl=swiftshader'],
  });

  const shots = [];
  try {
    const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e.message)));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

    // Warm the dep optimizer so its reload does not land mid-capture.
    await page.goto(`${BASE}/?input=autoplay`, { waitUntil: 'load' });
    await page.waitForTimeout(1500);

    // 4 lanes is the therapist's richest prescription and the hardest layout to read.
    const url = `${BASE}/?input=autoplay&mode=leg&lanes=seated_march:left,seated_march:right,knee_extension:left,knee_extension:right&difficulty=medium&seed=7`;
    log('opening', url);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.__beatRehab, null, { timeout: 30_000 });

    await page.getByTestId('start-session').click().catch(() => {});
    await page.getByTestId('mode-leg').click().catch(() => {});
    await page.waitForSelector('[data-testid="setup-start"]', { timeout: 20_000 });
    await page.getByTestId('setup-start').click();
    await page.waitForSelector('[data-testid="play-canvas"]', { timeout: 30_000 });
    await page.waitForFunction(() => window.__beatRehab?.getScore?.()?.phase === 'playing', null, { timeout: 120_000 });

    const shoot = async (name) => {
      const path = resolve(OUT, `${name}.png`);
      await page.screenshot({ path });
      shots.push(name);
      log('->', path);
    };

    // intro: the attribution lower-third is still up in the first seconds.
    await page.waitForTimeout(700);
    await shoot('intro');

    // stream: let the bot build a few seconds of traffic, then catch a plain approach frame.
    await page.waitForTimeout(4000);
    await shoot('stream');

    // combo: the autoplay bot only climbs, so a few more seconds gives a high multiplier.
    await page.waitForTimeout(6000);
    const hud = await page.evaluate(() => window.__beatRehab.getScore());
    log('hud at combo frame', JSON.stringify({ combo: hud.combo, mult: hud.multiplier, score: hud.score }));
    await shoot('combo');

    // hit: poll at high rate until the HUD reports a hit landed on this very frame.
    await page.evaluate(() => {
      window.__frameProbe = { lastHits: window.__beatRehab.getScore().hits };
    });
    await page.waitForFunction(
      () => {
        const h = window.__beatRehab.getScore();
        if (h.hits > window.__frameProbe.lastHits) {
          window.__frameProbe.lastHits = h.hits;
          return true;
        }
        return false;
      },
      null,
      { timeout: 20_000, polling: 16 },
    );
    await shoot('hit');

    // miss: stop the bot feeding the engine so the next notes are genuinely missed.
    const stopped = await page.evaluate(() => {
      const runner = window.__beatRehab.getRunner?.();
      const input = runner?.input;
      if (input && typeof input.stop === 'function') {
        input.stop();
        return true;
      }
      return false;
    });
    log('input stopped for the miss frame:', stopped);
    await page.waitForFunction(
      () => {
        const h = window.__beatRehab.getScore();
        return h.misses > 0;
      },
      null,
      { timeout: 20_000, polling: 16 },
    );
    await page.waitForTimeout(60); // let the miss visual reach its readable phase
    await shoot('miss');
    const after = await page.evaluate(() => window.__beatRehab.getScore());
    log('final hud', JSON.stringify({ hits: after.hits, misses: after.misses, combo: after.combo }));

    if (errors.length) log('page errors:', errors.slice(0, 5).join(' | '));
  } finally {
    await browser.close();
    if (server) {
      server.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 300));
      if (!server.killed) server.kill('SIGKILL');
    }
  }
  log('captured', shots.join(', '), 'into', OUT);
}

main().catch((e) => {
  console.error('[frames] crashed', e);
  process.exit(1);
});
