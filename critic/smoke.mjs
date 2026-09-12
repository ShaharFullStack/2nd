/**
 * End-to-end smoke test: boot the app with the autoplay bot, click through Home → Mode → Setup → Play,
 * let the bot play for a few seconds and assert the engine actually scored.
 *
 *   node critic/smoke.mjs            # headless, starts its own vite dev server
 *   node critic/smoke.mjs --headed   # watch it
 *   node critic/smoke.mjs --url http://localhost:5173   # use a server that is already running
 *
 * Writes critic/screenshots/play-autoplay.png.
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SHOT_DIR = resolve(HERE, 'screenshots');
const SHOT = resolve(SHOT_DIR, 'play-autoplay.png');
const INTRO_SHOT = resolve(SHOT_DIR, 'play-intro.png');
const RESULTS_SHOT = resolve(SHOT_DIR, 'results.png');
const HOME_SHOT = resolve(SHOT_DIR, 'home.png');
const SETUP_SHOT = resolve(SHOT_DIR, 'setup.png');
const HISTORY_SHOT = resolve(SHOT_DIR, 'history.png');
const EXECUTABLE = '/opt/pw-browsers/chromium';
const PORT = Number(process.env.SMOKE_PORT ?? 5173);

const args = process.argv.slice(2);
const headed = args.includes('--headed');
const urlArg = args.includes('--url') ? args[args.indexOf('--url') + 1] : null;
const BASE = urlArg ?? `http://localhost:${PORT}`;
const PLAY_SECONDS = Number(process.env.SMOKE_PLAY_SECONDS ?? 6);

function log(...m) {
  console.log('[smoke]', ...m);
}

async function waitForServer(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: 'GET' });
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server at ${url} did not come up`);
}

/**
 * END THE SESSION FROM THE PAUSE DIALOG — THREE DELIBERATE ACTS, NOT ONE.
 *
 * Ending a run writes a truncated summary into the patient's history and their trend and leaves the
 * runner `ended`, which nothing in the app comes back from; the round-three critic reproduced a FALSE
 * dwell confirm of that exact control. So it now asks ("End & see results…"), then asks again ("Yes,
 * stop the session"), and then holds the session open for a grace window in which the only hands-free
 * target is the way back — nothing is written until that window expires or "Stop now" is pressed.
 * Walking all three here is also the assertion that the first two write nothing: the results screen
 * is waited for only after the last of them.
 */
async function endSession(page) {
  await page.getByTestId('end-session').click();
  await page.waitForSelector('[data-testid="end-confirm"]', { timeout: 5000 });
  await page.getByTestId('end-confirm-btn').click();
  await page.waitForSelector('[data-testid="end-grace"]', { timeout: 5000 });
  await page.getByTestId('end-now').click();
}

async function main() {
  mkdirSync(SHOT_DIR, { recursive: true });

  let server = null;
  if (!urlArg) {
    log(`starting vite on :${PORT}`);
    server = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    server.stdout.on('data', (d) => process.env.SMOKE_VERBOSE && process.stdout.write(`[vite] ${d}`));
    server.stderr.on('data', (d) => process.stderr.write(`[vite] ${d}`));
    await waitForServer(BASE);
  }

  const browser = await chromium.launch({
    executablePath: EXECUTABLE,
    headless: !headed,
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--use-gl=swiftshader'],
  });

  const failures = [];
  let exitCode = 0;
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    let consoleErrors = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));
    page.on('response', (res) => {
      const url = res.url();
      if (res.status() >= 400 && !url.endsWith('/favicon.ico')) consoleErrors.push(`HTTP ${res.status()} ${url}`);
    });

    // First hit warms Vite's dependency optimizer, which force-reloads the page mid-boot the first
    // time it runs. Do that before the measured run so its reload is not mistaken for a fault.
    log('warming the dev server');
    await page.goto(`${BASE}/?input=autoplay`, { waitUntil: 'load' });
    await page.waitForTimeout(1500);

    log('opening', `${BASE}/?input=autoplay`);
    await page.goto(`${BASE}/?input=autoplay`, { waitUntil: 'domcontentloaded' });
    consoleErrors = [];

    await page.waitForFunction(() => !!window.__beatRehab, null, { timeout: 20_000 });
    log('debug handle present');

    await page.screenshot({ path: HOME_SHOT });
    await page.getByTestId('start-session').click();
    await page.getByTestId('mode-leg').click();
    await page.waitForSelector('[data-testid="setup-start"]');
    await page.waitForTimeout(400); // let the song catalog land so the shot shows it
    await page.screenshot({ path: SETUP_SHOT });
    await page.getByTestId('setup-start').click();
    log('clicked through to Play');

    await page.waitForSelector('[data-testid="play-canvas"]', { timeout: 20_000 });

    // Wait until the runner has actually started the song (the stems are a big local download).
    await page.waitForFunction(
      () => {
        const hud = window.__beatRehab?.getScore?.();
        return !!hud && (hud.phase === 'playing' || hud.phase === 'countdown');
      },
      null,
      { timeout: 90_000 },
    );
    log('session started, playing for', PLAY_SECONDS, 's');

    // Catch the Guitar-Hero style attribution card while it is still on screen.
    await page.waitForFunction(() => window.__beatRehab?.getScore?.()?.phase === 'playing', null, { timeout: 20_000 });
    await page.waitForTimeout(900);
    await page.screenshot({ path: INTRO_SHOT });
    log('screenshot ->', INTRO_SHOT);

    await page.waitForTimeout(PLAY_SECONDS * 1000);

    const hud = await page.evaluate(() => window.__beatRehab.getScore());
    log('hud', JSON.stringify(hud));

    await page.screenshot({ path: SHOT, fullPage: false });
    log('screenshot ->', SHOT);

    if (!hud) failures.push('no HUD snapshot from window.__beatRehab.getScore()');
    else {
      if (!(hud.score > 0)) failures.push(`score was ${hud.score}, expected > 0`);
      if (!(hud.hits > 0)) failures.push(`hits was ${hud.hits}, expected > 0`);
      if (hud.phase !== 'playing') failures.push(`phase was ${hud.phase}, expected playing`);
      if (hud.clockStalled) failures.push('audio clock stalled');
    }

    // Pause / resume must keep the session alive (the therapist's most-used control).
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-testid="pause-overlay"]', { timeout: 5000 });
    const pausedTime = await page.evaluate(() => window.__beatRehab.getScore().songTime);
    await page.waitForTimeout(400);
    const stillPaused = await page.evaluate(() => window.__beatRehab.getScore().songTime);
    if (Math.abs(stillPaused - pausedTime) > 0.05) failures.push('song clock kept running while paused');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(600);
    const resumed = await page.evaluate(() => window.__beatRehab.getScore());
    if (resumed.phase !== 'playing') failures.push(`did not resume (phase ${resumed.phase})`);
    log('pause/resume ok');

    // End the session from the pause overlay and check the therapist's report is produced and stored.
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-testid="pause-overlay"]', { timeout: 5000 });
    await endSession(page);
    await page.waitForSelector('[data-testid="results-screen"]', { timeout: 10_000 });
    await page.screenshot({ path: RESULTS_SHOT });
    log('screenshot ->', RESULTS_SHOT);

    const stored = await page.evaluate(() => {
      const s = window.__beatRehab.getState();
      return { last: s.lastResult, history: s.history.length };
    });
    if (!stored.last) failures.push('no session result was produced');
    else {
      if (!(stored.last.score > 0)) failures.push(`stored score ${stored.last.score}`);
      if (!(stored.last.reps > 0)) failures.push(`stored reps ${stored.last.reps}`);
      if (stored.last.lanes.length !== 2) failures.push(`stored lanes ${stored.last.lanes.length}`);
      if (stored.last.completed !== false) failures.push('a session ended early should not be marked complete');
    }
    if (!(stored.history >= 1)) failures.push('result was not saved to history');
    log('results saved', JSON.stringify({ score: stored.last?.score, reps: stored.last?.reps, history: stored.history }));

    // "Play again" must start a fresh run from song time 0 (a second song on the same mixer).
    await page.getByTestId('play-again').click();
    await page.waitForFunction(
      () => {
        const hud = window.__beatRehab?.getScore?.();
        return !!hud && (hud.phase === 'playing' || hud.phase === 'countdown') && hud.songTime < 2;
      },
      null,
      { timeout: 60_000 },
    );
    await page.waitForFunction(() => window.__beatRehab?.getScore?.()?.phase === 'playing', null, { timeout: 30_000 });
    await page.waitForTimeout(1500);
    const again = await page.evaluate(() => window.__beatRehab.getScore());
    log('replay hud', JSON.stringify({ phase: again.phase, songTime: again.songTime.toFixed(2), hits: again.hits }));
    if (again.songTime > 8) failures.push(`replay started at song time ${again.songTime}, expected near 0`);
    if (again.phase !== 'playing' && again.phase !== 'countdown') failures.push(`replay phase ${again.phase}`);
    await page.keyboard.press('Escape');
    await page.waitForSelector('[data-testid="pause-overlay"]', { timeout: 5000 });
    await endSession(page);
    await page.waitForSelector('[data-testid="results-screen"]', { timeout: 10_000 });

    await page.getByTestId('open-history-from-results').click();
    await page.waitForSelector('[data-testid="history-screen"]', { timeout: 10_000 });
    await page.screenshot({ path: HISTORY_SHOT });
    log('screenshot ->', HISTORY_SHOT);

    const fatal = consoleErrors.filter((t) => !/favicon|Download the React DevTools/i.test(t));
    if (fatal.length > 0) failures.push(`console errors: ${fatal.slice(0, 5).join(' | ')}`);
  } catch (err) {
    failures.push(`threw: ${err && err.stack ? err.stack : err}`);
  } finally {
    await browser.close();
    if (server) {
      server.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 300));
      if (!server.killed) server.kill('SIGKILL');
    }
  }

  if (failures.length > 0) {
    console.error('[smoke] FAILED');
    for (const f of failures) console.error('  -', f);
    exitCode = 1;
  } else {
    console.log('[smoke] PASSED');
  }
  process.exit(exitCode);
}

main().catch((err) => {
  console.error('[smoke] crashed', err);
  process.exit(1);
});
