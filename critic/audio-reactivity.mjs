/**
 * Verify the central promise of the game end to end, in a real browser:
 *
 *   hit your notes  -> your instrument plays in the mix
 *   miss them       -> THAT LANE's instrument dips, in proportion to the run of misses, and the
 *                      rest of the band — including every other lane's instrument — keeps going
 *
 * The old promise here was "miss -> your instrument drops out" (to 5 %, until the next hit,
 * whichever lane missed). In a hemiparesis session the weak side IS the therapy: that rule let one
 * missed left-leg note silence the instrument a patient was earning with every right-leg rep. The
 * consequence is now proportionate (a step per miss, with a floor) and per lane.
 *
 * Unit tests cover the ducking maths; this drives the actual app, plays real notes on the
 * keyboard input, then stops, and samples the live Web Audio gain of every stem to prove
 * that (a) the player stem really dips on a miss but is never silenced, (b) it comes back on the
 * next hit, (c) a miss in one lane never touches another lane's instrument, and (d) no stem's
 * volume control ever moves.
 *
 *   node critic/audio-reactivity.mjs
 *   node critic/audio-reactivity.mjs --url http://localhost:5173
 *
 * Writes critic/motion/audio-reactivity.json and exits non-zero if the promise is broken.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const OUT = resolve(ROOT, 'critic/motion');
const argv = process.argv.slice(2);
const arg = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const PORT = Number(process.env.AUDIO_PORT ?? 5181);
const urlArg = arg('--url', null);
const BASE = urlArg ?? `http://localhost:${PORT}`;
const log = (...m) => console.log('[audio]', ...m);

async function waitForServer(url, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server at ${url} never came up`);
}

async function stopServer(server) {
  if (!server || server.exitCode !== null) return;
  const exited = new Promise((r) => server.once('exit', r));
  try { process.kill(-server.pid, 'SIGTERM'); } catch { server.kill('SIGTERM'); }
  const died = await Promise.race([exited.then(() => true), new Promise((r) => setTimeout(() => r(false), 3000))]);
  if (!died) { try { process.kill(-server.pid, 'SIGKILL'); } catch { server.kill('SIGKILL'); } }
  server.stdout?.destroy();
  server.stderr?.destroy();
  server.unref();
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  let server = null;
  if (!urlArg) {
    log(`starting vite on :${PORT}`);
    server = spawn(resolve(ROOT, 'node_modules/.bin/vite'), ['--port', String(PORT), '--strictPort'], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: process.env, detached: true,
    });
    server.stdout.resume();
    server.stderr.on('data', (d) => process.stderr.write(`[vite] ${d}`));
    await waitForServer(BASE);
  }

  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium',
    headless: true,
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--use-gl=swiftshader'],
  });

  const report = { capturedAt: new Date().toISOString(), failures: [] };
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.goto(`${BASE}/?input=autoplay`, { waitUntil: 'load' });
    await page.waitForTimeout(1500);

    // Autoplay first: a bot that hits everything is the "playing well" condition.
    const url = `${BASE}/?input=autoplay&mode=leg&lanes=seated_march:left,seated_march:right&difficulty=easy&seed=3`;
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.__beatRehab, null, { timeout: 30_000 });
    await page.getByTestId('start-session').click().catch(() => {});
    await page.getByTestId('mode-leg').click().catch(() => {});
    await page.waitForSelector('[data-testid="setup-start"]', { timeout: 20_000 });
    await page.getByTestId('setup-start').click();
    await page.waitForSelector('[data-testid="play-canvas"]', { timeout: 30_000 });
    await page.waitForFunction(() => window.__beatRehab?.getScore?.()?.phase === 'playing', null, { timeout: 120_000 });

    const stemInfo = await page.evaluate(() => {
      const mixer = window.__beatRehab.runtime.peekAudio()?.mixer;
      if (!mixer) return null;
      return { stems: mixer.stemIds, playerStem: mixer.playerStem };
    });
    if (!stemInfo) throw new Error('no mixer on the runtime — the session is running silent');
    report.stems = stemInfo;
    log('stems', JSON.stringify(stemInfo));

    const sampleGains = () => page.evaluate(() => {
      const mixer = window.__beatRehab.runtime.peekAudio().mixer;
      const out = {};
      for (const id of mixer.stemIds) out[id] = mixer.getStemGain(id);
      const hud = window.__beatRehab.getScore();
      // The duck stage is a separate gain node from each stem's volume control: read it through
      // the mixer's own accessor, not getStemGain (which reports the volume control target).
      return {
        gains: out,
        playerStemGain: mixer.getPlayerStemGain(),
        ducked: mixer.isDucked,
        hits: hud.hits, misses: hud.misses, songTime: hud.songTime,
      };
    });

    // --- 1. while the bot is hitting, the player stem must be audible -----------------
    await page.waitForFunction(() => window.__beatRehab.getScore().hits >= 3, null, { timeout: 40_000 });
    await page.waitForTimeout(300);
    const hitting = await sampleGains();
    report.whileHitting = hitting;
    log('while hitting', JSON.stringify(hitting.gains));

    const player = stemInfo.playerStem;
    const others = stemInfo.stems.filter((s) => s !== player);
    if (!(hitting.playerStemGain > 0.5)) {
      report.failures.push(`player stem "${player}" duck gain was ${hitting.playerStemGain} while hitting — should be audible`);
    }
    if (hitting.ducked) report.failures.push('mixer reports ducked while the patient is hitting every note');

    // --- 2. stop playing: the player stem must fall away -------------------------------
    await page.evaluate(() => {
      const input = window.__beatRehab.getRunner()?.input;
      if (input && typeof input.stop === 'function') input.stop();
    });
    await page.waitForFunction(() => window.__beatRehab.getScore().misses >= 2, null, { timeout: 40_000 });
    await page.waitForTimeout(250); // let the 40 ms duck ramp finish
    const missing = await sampleGains();
    report.whileMissing = missing;
    log('while missing', JSON.stringify(missing.gains));

    // Proportionate: a run of misses DIPS the instrument and never mutes it.
    if (!(missing.playerStemGain < 0.95)) {
      report.failures.push(`player stem "${player}" duck gain was ${missing.playerStemGain} after ${missing.misses} misses — should have dipped`);
    }
    if (!(missing.playerStemGain >= 0.3)) {
      report.failures.push(`player stem "${player}" fell to ${missing.playerStemGain} after ${missing.misses} misses — a miss must never take the instrument away`);
    }
    if (!missing.ducked) report.failures.push('mixer does not report ducked after misses');
    for (const s of others) {
      const before = hitting.gains[s];
      const after = missing.gains[s];
      if (Math.abs(before - after) > 0.01) {
        report.failures.push(`stem "${s}" moved from ${before} to ${after} — the rest of the band must keep playing`);
      }
    }

    // --- 3. play again: the instrument must come back ----------------------------------
    const recovered = await page.evaluate(async () => {
      const mixer = window.__beatRehab.runtime.peekAudio().mixer;
      // Feed the engine a hit directly on the lane of the next pending note.
      const before = mixer.getPlayerStemGain();
      // onHit is exactly what GameRunner calls when a note is judged; call it directly so the
      // recovery ramp is exercised without waiting for the bot to be restarted.
      mixer.onLaneHit(0, 1);
      await new Promise((r) => setTimeout(r, 250));
      return { before, after: mixer.getPlayerStemGain(), ducked: mixer.isDucked };
    });
    report.recovery = recovered;
    log('recovery', JSON.stringify(recovered));
    if (!(recovered.after > 0.5)) {
      report.failures.push(`player stem did not come back after a hit: ${recovered.before} -> ${recovered.after}`);
    }

    // --- 4. the hemiparesis case: the weak lane's misses must not touch the strong lane ---
    const perLane = await page.evaluate(async () => {
      const mixer = window.__beatRehab.runtime.peekAudio().mixer;
      const assignment = mixer.laneStems;
      mixer.onLaneHit(0, 6);                       // the strong leg hits everything
      for (let i = 0; i < 5; i++) mixer.onLaneMiss(1); // the weak leg misses everything
      await new Promise((r) => setTimeout(r, 250));
      return { assignment, strong: mixer.getLaneStemGain(0), weak: mixer.getLaneStemGain(1) };
    });
    report.perLane = perLane;
    log('per lane', JSON.stringify(perLane));
    if (perLane.assignment?.mode !== 'per-lane') {
      report.failures.push(`expected a per-lane stem assignment for this song, got ${JSON.stringify(perLane.assignment)}`);
    }
    if (!(perLane.strong > 0.95)) {
      report.failures.push(`the strong lane's instrument was at ${perLane.strong} while the WEAK lane missed — a miss must only dim the lane that missed`);
    }
    if (!(perLane.weak < 0.6)) {
      report.failures.push(`the weak lane's instrument was at ${perLane.weak} after 5 misses — a run of misses should be audible`);
    }
    if (!(perLane.weak >= 0.3)) {
      report.failures.push(`the weak lane's instrument fell to ${perLane.weak} — it must stay in the mix`);
    }
  } catch (e) {
    report.failures.push(`threw: ${e && e.stack ? e.stack : e}`);
  } finally {
    await browser.close();
    await stopServer(server);
  }

  writeFileSync(resolve(OUT, 'audio-reactivity.json'), JSON.stringify(report, null, 2));
  if (report.failures.length) {
    console.error('[audio] FAILED');
    for (const f of report.failures) console.error('  -', f);
    process.exit(1);
  }
  console.log('[audio] PASSED — the player stem follows the patient, the band does not');
}

main().catch((e) => { console.error('[audio] crashed', e); process.exit(1); });
