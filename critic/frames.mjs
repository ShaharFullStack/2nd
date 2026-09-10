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

/**
 * Tear the dev server down for real. Signals the child's whole process group (vite spawns
 * workers of its own), then waits for the actual `exit` event rather than trusting
 * `child.killed` — that flag only reports that a signal was *sent*, so the old
 * `if (!server.killed)` escalation could never fire. Escalates to SIGKILL if it lingers.
 */
async function stopServer(server) {
  if (server.exitCode !== null || server.signalCode !== null) return;

  const exited = new Promise((r) => server.once('exit', r));
  const signalGroup = (sig) => {
    try {
      process.kill(-server.pid, sig); // negative pid => the whole group
    } catch {
      try {
        server.kill(sig);
      } catch {
        /* already gone */
      }
    }
  };

  signalGroup('SIGTERM');
  const died = await Promise.race([
    exited.then(() => true),
    new Promise((r) => setTimeout(() => r(false), 3000)),
  ]);
  if (!died) {
    log('vite did not stop on SIGTERM, escalating to SIGKILL');
    signalGroup('SIGKILL');
    await Promise.race([exited, new Promise((r) => setTimeout(r, 2000))]);
  }
  // Drop the stdio handles so nothing is left holding the event loop open.
  server.stdout?.destroy();
  server.stderr?.destroy();
  server.unref();
}

async function main() {
  mkdirSync(OUT, { recursive: true });

  let server = null;
  if (!urlArg) {
    log(`starting vite on :${PORT}`);
    // Spawn the real vite binary, not `npx vite`: npx sits in between as a wrapper, so a
    // signal sent to the child only kills the wrapper and leaves vite running as an orphan
    // holding our stdio pipes — which keeps this process's event loop alive forever after
    // the last frame is captured. `detached` puts vite in its own process group so teardown
    // can signal the whole group.
    const VITE_BIN = resolve(ROOT, 'node_modules/.bin/vite');
    server = spawn(VITE_BIN, ['--port', String(PORT), '--strictPort'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
      detached: true,
    });
    // Drain both streams: an unread pipe fills at 64KB and blocks vite mid-run.
    server.stdout.resume();
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

    // stream: a plain approach frame — but taken deep enough into the song that the HUD is showing
    // what it is for. At +4 s the bot is still at combo 7 / x1 / 3-digit score, i.e. the game in its
    // least interesting state, which is exactly what the last blind round called out.
    await page.waitForTimeout(9000);
    await shoot('stream');

    // combo: the autoplay bot only climbs, so a few more seconds gives a high multiplier.
    await page.waitForTimeout(6000);
    // getScore() is null once the runner has been torn down (song over, or the shell navigated
    // away). That is worth reporting, not worth crashing a capture over.
    const hud = await page.evaluate(() => window.__beatRehab.getScore?.() ?? null);
    log('hud at combo frame', hud ? JSON.stringify({ combo: hud.combo, mult: hud.multiplier, score: hud.score }) : 'no runner');
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
    if (server) await stopServer(server);
  }
  log('captured', shots.join(', '), 'into', OUT);
}

main().catch((e) => {
  console.error('[frames] crashed', e);
  process.exit(1);
});
