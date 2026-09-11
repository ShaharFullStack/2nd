/**
 * THE ENDING REPLACES THE GAME CHROME. IT DOES NOT SIT ON TOP OF IT.
 *
 * The song-end sequence draws a 0.88 curtain over the board and then reads the session out. At 0.88
 * the live HUD underneath was dimmed and perfectly readable, and it stayed for the whole 6.6 s —
 * observed at 1024x768 and 1280x800: the COMBO block, its multiplier badge, the ANSWERED gauge and
 * the rolling six-digit score all still on screen beside the card counting the same session out
 * properly. Two score readouts on one screen, one settling and one frozen, is the game contradicting
 * itself in the last thing the patient sees.
 *
 * This drives a REAL autoplay session to the end of a real chart and, at two clinic sizes:
 *   1. intercepts every string the renderer rasterises during the sequence and asserts that none of
 *      the live HUD labels ('SCORE', 'COMBO', 'ANSWERED', the multiplier badge) is among them,
 *      while the card's own strings are;
 *   2. photographs the board mid-sequence so the claim can be looked at rather than asserted;
 *   3. checks that a tap on the play screen's own PAUSE control does NOT skip the payoff, and that a
 *      tap anywhere else does;
 *   4. re-reads the hero figure off the card and off the report, which must be the same number.
 *
 *   node critic/ending-chrome.mjs
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SHOTS = resolve(HERE, 'screenshots', 'ending');
const PORT = Number(process.env.PORT ?? 5488);
const BASE = `http://localhost:${PORT}`;
const log = (...m) => console.log('[chrome]', ...m);
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

/** Record every string the renderer rasterises from now on (the sprite cache is the choke point). */
const TAP_TEXT = () => {
  const hw = window.__beatRehab.getRunner().highway;
  const proto = Object.getPrototypeOf(hw.text);
  if (!proto.__realGet) {
    proto.__realGet = proto.get;
    window.__drawnText = [];
    proto.get = function patched(text, style) {
      window.__drawnText.push(String(text));
      return proto.__realGet.call(this, text, style);
    };
  }
  window.__drawnText.length = 0;
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
    headless: true,
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--use-gl=swiftshader'],
  });
  try {
    for (const [w, h] of [[1024, 768], [1280, 800]]) {
      const page = await browser.newPage({ viewport: { width: w, height: h } });
      page.on('pageerror', (e) => log('  pageerror:', e.message));
      await page.goto(`${BASE}/?input=autoplay&seed=7`);
      await page.waitForFunction(() => !!window.__beatRehab);
      await page.evaluate(() => window.__beatRehab.startPlayNow({ songId: 'demo-sunrise', difficulty: 'medium' }));
      await page.waitForSelector('canvas');
      await page.waitForFunction(() => !!window.__beatRehab.getRunner(), null, { timeout: 30_000 });

      // Mid-song, with the chrome definitely live: what the HUD rasterises while the song is on.
      await page.waitForFunction(() => (window.__beatRehab.getRunner()?.songTime() ?? 0) > 12, null, { timeout: 120_000 });
      await page.evaluate(TAP_TEXT);
      await page.waitForTimeout(1200);
      const playing = await page.evaluate(() => [...new Set(window.__drawnText)]);
      await page.screenshot({ path: resolve(SHOTS, `chrome-playing-${w}.png`) });
      for (const label of ['SCORE', 'COMBO', 'ANSWERED']) {
        check(playing.includes(label), `${w}: '${label}' is drawn while the song is playing`);
      }

      // …and what it rasterises once the ending is on.
      await page.waitForFunction(() => window.__beatRehab.getRunner()?.getPhase() === 'finale', null, { timeout: 180_000 });
      await page.evaluate(TAP_TEXT);
      await page.waitForTimeout(1500);
      await page.screenshot({ path: resolve(SHOTS, `chrome-finale-a-${w}.png`) });
      // …and again once the score has settled and the hint is up (the last beat of the sequence),
      // so the frame that is looked at is the one carrying every line the card ever shows.
      await page.waitForFunction(() => (window.__beatRehab.getRunner()?.highway.finaleElapsed() ?? 0) > 4.9, null, { timeout: 15_000 });
      const finale = await page.evaluate(() => [...new Set(window.__drawnText)]);
      await page.screenshot({ path: resolve(SHOTS, `chrome-finale-b-${w}.png`) });

      for (const label of ['SCORE', 'COMBO', 'ANSWERED', 'x1', 'x2', 'x3', 'x4']) {
        check(!finale.includes(label), `${w}: '${label}' is NOT drawn over the payoff`);
      }
      check(finale.includes('SONG COMPLETE'), `${w}: the card itself is drawing (SONG COMPLETE)`);
      check(
        finale.some((t) => /MOVEMENTS/.test(t)),
        `${w}: and the hero figure's label with it`,
      );
      // Suppressing the chrome must not have suppressed the payoff's own last beats.
      check(
        finale.some((t) => /for the report/.test(t)),
        `${w}: the hint that anything moves on is still drawn`,
      );
      check(
        finale.some((t) => /NOTES ANSWERED|SONG LENGTH/.test(t)),
        `${w}: the session's other counts are still drawn`,
      );

      // A tap on the play screen's own PAUSE control is that control's, not the skip's.
      const spec = await page.evaluate(() => {
        const r = window.__beatRehab.getRunner();
        return { hero: r.highway.finale?.stats?.[0] ?? null, elapsed: r.highway.finaleElapsed() };
      });
      log(`    ${w}: hero on the card ${JSON.stringify(spec.hero)} at t=${spec.elapsed.toFixed(2)}s`);
      await page.click('.pause-btn', { force: true });
      await page.waitForTimeout(250);
      const afterPause = await page.evaluate(() => window.__beatRehab.getRunner()?.getPhase() ?? 'gone');
      check(afterPause === 'finale', `${w}: tapping PAUSE during the ending does not skip to the report (phase ${afterPause})`);

      // Anything else still does.
      await page.mouse.click(Math.round(w / 2), Math.round(h * 0.8));
      await page.waitForFunction(() => window.__beatRehab.getState().screen === 'results', null, { timeout: 10_000 });
      const report = await page.evaluate(() => {
        const r = window.__beatRehab.getState().lastResult;
        return { reps: r.reps, score: r.score, completed: r.completed, endReason: r.endReason };
      });
      check(report.completed === true && report.endReason === 'chart', `${w}: the record is still a completed chart run`);
      check(
        spec.hero !== null && String(report.reps) === String(spec.hero.value),
        `${w}: the card's hero (${spec.hero?.value}) is the report's movements performed (${report.reps})`,
      );
      await page.screenshot({ path: resolve(SHOTS, `chrome-report-${w}.png`), fullPage: false });
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
