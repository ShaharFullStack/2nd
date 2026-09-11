/**
 * Proves, in the running app, the three claims a therapist reads or a patient hears — and that they
 * hold in the configuration that actually ships.
 *
 *  1. THE MIX CARD IS CONDITIONAL. Both demo songs have four stems and `assignLaneStems` always
 *     reserves one for the bed, so EVERY four-lane session (a bilateral hand session) shares one
 *     instrument. The card must not claim "a miss in one lane never touches another lane's
 *     instrument" there — and the shared stem must really bottom out at one step, not at −9 dB.
 *  2. THE PACING CONTROL IS COHERENT ON A CLINIC TABLET. −/number/+/badge stay on one row at
 *     1024x768 and 820x1180, and the value displayed is the value in force at the floor.
 *  3. THE ROM NUDGE STATES ITS TARGET. Proportional, bounded by the patient's own best, and never
 *     printing "0.33 → 0.33".
 *
 *   node critic/verify-fairness.mjs [--url http://localhost:5173] [--headed]
 *
 * Writes critic/screenshots/fairness-*.png and exits non-zero if any claim fails.
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SHOTS = resolve(HERE, 'screenshots');
const argv = process.argv.slice(2);
const arg = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const PORT = Number(process.env.FAIRNESS_PORT ?? 5312);
const urlArg = arg('--url', null);
const BASE = urlArg ?? `http://localhost:${PORT}`;
const log = (...m) => console.log('[fairness]', ...m);

async function waitForServer(url, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up */ }
    if (Date.now() > deadline) throw new Error(`server ${url} never came up`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function stopServer(server) {
  if (!server || server.exitCode !== null) return;
  const exited = new Promise((r) => server.once('exit', r));
  try { process.kill(-server.pid, 'SIGTERM'); } catch { server.kill('SIGTERM'); }
  const died = await Promise.race([exited.then(() => true), new Promise((r) => setTimeout(() => r(false), 3000))]);
  if (!died) { try { process.kill(-server.pid, 'SIGKILL'); } catch { server.kill('SIGKILL'); } }
  server.stdout?.destroy(); server.stderr?.destroy(); server.unref();
}

const HAND4 = 'hand_open_close:left,hand_open_close:right,finger_spread:left,finger_spread:right';

async function gotoSetup(page, { lanes, width, height }) {
  await page.setViewportSize({ width, height });
  await page.goto(`${BASE}/?input=keyboard&mode=hand&lanes=${lanes}&difficulty=medium&seed=3`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__beatRehab, null, { timeout: 30_000 });
  // A camera session needs a real patient; a keyboard one may use the device-test record.
  await page.evaluate(() => window.__beatRehab.gotoScreen('setup'));
  await page.waitForSelector('[data-testid="setup-mix"]', { timeout: 30_000 });
  // The card renders before the song catalog resolves; the CLAIM needs the manifest's stems.
  await page.waitForSelector('[data-testid="mix-claim"]', { timeout: 30_000 });
  await page.waitForSelector('[data-testid="dose-reps-per-min"]', { timeout: 30_000 });
}

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  let server = null;
  if (!urlArg) {
    server = spawn(resolve(ROOT, 'node_modules/.bin/vite'), ['--port', String(PORT), '--strictPort'], {
      cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env: process.env, detached: true,
    });
    server.stdout.resume();
    server.stderr.on('data', (d) => process.stderr.write(`[vite] ${d}`));
    await waitForServer(BASE);
  }
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium',
    headless: !argv.includes('--headed'),
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--use-gl=swiftshader'],
  });
  const failures = [];
  const check = (ok, what) => { log(ok ? 'ok  ' : 'FAIL', what); if (!ok) failures.push(what); };

  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

    // ---- 1. the mix card, four lanes on a four-stem song (what ships) --------------------------
    await gotoSetup(page, { lanes: HAND4, width: 1280, height: 900 });
    const shared = await page.evaluate(() => ({
      claim: document.querySelector('[data-testid="mix-claim"]').textContent.replace(/\s+/g, ' ').trim(),
      summary: document.querySelector('[data-testid="mix-summary"]').textContent.replace(/\s+/g, ' ').trim(),
      lanes: window.__beatRehab.getState().lanes.length,
    }));
    log('4-lane claim:', shared.claim);
    check(shared.lanes === 4, `four lanes are prescribed (got ${shared.lanes})`);
    check(!/never touches another lane/.test(shared.claim), 'the shared-stem card does NOT claim per-lane independence');
    check(/every lane shares/.test(shared.summary), 'the shared-stem card says every lane shares one instrument');
    check(/no further/.test(shared.claim), 'the shared-stem card caps the consequence at one step');
    check(/3 lanes or fewer/.test(shared.claim), 'the shared-stem card says what would have to change');
    await page.locator('[data-testid="setup-mix"]').scrollIntoViewIfNeeded();
    await page.locator('[data-testid="setup-mix"]').screenshot({ path: resolve(SHOTS, 'fairness-mix-4lane.png') });

    // ---- 2. the same card with two lanes: the per-lane claim is true and made -------------------
    await gotoSetup(page, { lanes: 'hand_open_close:left,hand_open_close:right', width: 1280, height: 900 });
    const perLane = await page.evaluate(() =>
      document.querySelector('[data-testid="mix-claim"]').textContent.replace(/\s+/g, ' ').trim());
    log('2-lane claim:', perLane);
    check(/never touches another lane/.test(perLane), 'the per-lane card makes the per-lane claim');
    check(/at most 9 dB/.test(perLane), 'the per-lane card states the floor of a run');
    await page.locator('[data-testid="setup-mix"]').scrollIntoViewIfNeeded();
    await page.locator('[data-testid="setup-mix"]').screenshot({ path: resolve(SHOTS, 'fairness-mix-2lane.png') });

    // ---- 3. the pacing control at clinic-tablet widths ------------------------------------------
    for (const [w, h] of [[1440, 900], [1280, 800], [1024, 768], [820, 1180]]) {
      await gotoSetup(page, { lanes: HAND4, width: w, height: h });
      const geo = await page.evaluate(() => {
        const box = (sel) => {
          const r = document.querySelector(sel).getBoundingClientRect();
          return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
        };
        document.querySelector('[data-testid="setup-pacing"]').scrollIntoView({ block: 'center' });
        return {
          down: box('[data-testid="pacing-down"]'),
          num: box('[data-testid="pacing-number"]'),
          up: box('[data-testid="pacing-up"]'),
          badge: box('[data-testid="pacing-value"]'),
          docWidth: document.documentElement.scrollWidth,
          viewWidth: document.documentElement.clientWidth,
        };
      });
      const ys = [geo.down.y, geo.num.y, geo.up.y, geo.badge.y];
      const spread = Math.max(...ys) - Math.min(...ys);
      check(spread <= Math.max(geo.down.h, geo.num.h), `${w}x${h}: −/number/+/badge share one row (y spread ${spread} px)`);
      check(geo.down.x < geo.num.x && geo.num.x < geo.up.x && geo.up.x < geo.badge.x, `${w}x${h}: the stepper reads left to right`);
      check(geo.docWidth <= geo.viewWidth + 1, `${w}x${h}: the page does not scroll sideways (${geo.docWidth} vs ${geo.viewWidth})`);
      // The control, in place on the screen it lives on — scrolled to, not cropped out.
      await page.locator('[data-testid="setup-dose"]').scrollIntoViewIfNeeded();
      await page.screenshot({ path: resolve(SHOTS, `fairness-pacing-${w}x${h}.png`) });
    }

    // ---- 4. the pacing displayed IS the pacing prescribed, at the floor -------------------------
    await gotoSetup(page, { lanes: HAND4, width: 1280, height: 800 });
    for (let i = 0; i < 20; i++) {
      if (await page.locator('[data-testid="pacing-down"]').isDisabled()) break;
      await page.click('[data-testid="pacing-down"]');
    }
    const floor = await page.evaluate(() => ({
      stored: window.__beatRehab.getState().laneRestSec,
      shown: Number(document.querySelector('[data-testid="pacing-number"]').value),
      badge: document.querySelector('[data-testid="pacing-value"]').textContent.replace(/\s+/g, ' ').trim(),
      downDisabled: document.querySelector('[data-testid="pacing-down"]').disabled,
      repsPerMin: Number(document.querySelector('[data-testid="dose-reps-per-min"]').textContent),
    }));
    log('at the floor:', JSON.stringify(floor));
    check(Math.abs(floor.stored - floor.shown) < 1e-9, `the field shows the pacing in force (${floor.shown} vs ${floor.stored})`);
    check(floor.downDisabled, 'the "−" button is dead at the floor, not silently clamping');
    const ceiling = Math.round(60 / floor.stored);
    check(floor.badge.includes(`≤${ceiling} reps/min`), `the badge's ceiling is computed from the pacing in force (${floor.badge})`);
    check(floor.repsPerMin > 0, `the dose card is measured on the chart that will be played (${floor.repsPerMin} reps/min per limb)`);

    // ---- 5. the shared stem's REAL Web Audio gain in a four-lane session ------------------------
    await page.goto(`${BASE}/?input=autoplay&mode=hand&lanes=${HAND4}&difficulty=easy&seed=3`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.__beatRehab, null, { timeout: 30_000 });
    await page.getByTestId('start-session').click().catch(() => {});
    await page.getByTestId('mode-hand').click().catch(() => {});
    await page.waitForSelector('[data-testid="setup-start"]', { timeout: 30_000 });
    await page.getByTestId('setup-start').click({ timeout: 30_000 });
    await page.waitForSelector('[data-testid="play-canvas"]', { timeout: 60_000 });
    await page.waitForFunction(() => window.__beatRehab?.getScore?.()?.phase === 'playing', null, { timeout: 120_000 });
    const audio = await page.evaluate(async () => {
      const mixer = window.__beatRehab.runtime.peekAudio()?.mixer;
      if (!mixer) return null;
      const assignment = mixer.laneStems;
      // The bilateral case the review named: the weak left hand misses a run while the right hits.
      for (let i = 0; i < 6; i++) mixer.onLaneMiss(i % 2 === 0 ? 0 : 2);
      await new Promise((r) => setTimeout(r, 250));
      const deep = { lane0: mixer.getLaneStemGain(0), lane1: mixer.getLaneStemGain(1), lane3: mixer.getLaneStemGain(3) };
      const bed = {};
      for (const id of mixer.stemIds) bed[id] = mixer.getStemGain(id);
      mixer.onLaneHit(1, 1);
      await new Promise((r) => setTimeout(r, 250));
      return { assignment, deep, bed, afterHit: mixer.getLaneStemGain(0) };
    });
    if (!audio) { failures.push('no mixer on the runtime — the four-lane session ran silent'); }
    else {
      log('four-lane audio:', JSON.stringify(audio));
      check(audio.assignment?.mode === 'shared', `a four-lane session on a shipped song is shared (${audio.assignment?.mode})`);
      check(audio.deep.lane0 > 0.6, `six misses across lanes leave the shared stem at ${audio.deep.lane0.toFixed(3)} — one step, not nine dB`);
      check(audio.deep.lane0 < 0.95, `the shared stem really did dip (${audio.deep.lane0.toFixed(3)})`);
      check(Object.values(audio.bed).every((g) => g > 0.99), 'no stem volume control moved');
      check(audio.afterHit > 0.95, `the next hit in any lane brings it straight back (${audio.afterHit.toFixed(3)})`);
    }
    await page.screenshot({ path: resolve(SHOTS, 'fairness-play-4lane.png') });

    // ---- 6. the ROM nudge states the target it will set, in the movement's units ----------------
    // Seeded as a clinic tablet really is: a patient with a range saved from a previous session,
    // reused on this one (the path no live calibrator ever measured).
    await page.setViewportSize({ width: 1024, height: 768 });
    // No ?input=keyboard here: a dev input bypasses the camera screens, and the ROM screen is one.
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.__beatRehab);
    await page.evaluate(() => {
      const now = Date.now();
      localStorage.setItem('beatRehab:patients', JSON.stringify([{ id: 'p-rom', name: 'R. Nudge', createdAt: now, lastUsedAt: now }]));
      localStorage.setItem('beatRehab:activePatient', JSON.stringify('p-rom'));
      localStorage.setItem('beatRehab:calibrations', JSON.stringify({
        'p-rom': {
          // degrees, with the best rep this patient actually produced on record
          'knee_extension:left': { min: 20, max: 48, samples: 400, movement: 'knee_extension', peaks: [44, 47, 50], at: now - 86_400_000 },
          // a ratio range so small that a 5 % step is invisible at the printed precision
          'seated_march:right': { min: 0.30, max: 0.32, samples: 400, movement: 'seated_march', peaks: [0.31, 0.32, 0.40], at: now - 86_400_000 },
        },
      }));
    });
    await page.goto(`${BASE}/?mode=leg&lanes=knee_extension:left,seated_march:right`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.__beatRehab);
    await page.evaluate(() => window.__beatRehab.gotoScreen('rom'));
    await page.waitForSelector('[data-testid="rom-reuse"]', { timeout: 30_000 });
    await page.click('[data-testid="rom-reuse"]');
    await page.waitForSelector('[data-testid="rom-nudge-harder"]', { timeout: 10_000 });
    const readNudge = () => page.evaluate(() => ({
      harder: document.querySelector('[data-testid="rom-nudge-harder"]').textContent.trim(),
      harderDead: document.querySelector('[data-testid="rom-nudge-harder"]').disabled,
      easier: document.querySelector('[data-testid="rom-nudge-easier"]').textContent.trim(),
    }));
    const deg1 = await readNudge();
    log('knee nudge:', JSON.stringify(deg1));
    check(/48° → 49°|48° → 50°/.test(deg1.harder), `Harder names the target it will set: "${deg1.harder}"`);
    check(!/(\d+(?:\.\d+)?°) → \1$/.test(deg1.harder), 'Harder never prints the same number twice');
    await page.locator('[data-testid="rom-nudge-harder"]').scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(SHOTS, 'fairness-rom-nudge-deg.png') });
    for (let i = 0; i < 6; i++) {
      if (await page.locator('[data-testid="rom-nudge-harder"]').isDisabled()) break;
      await page.click('[data-testid="rom-nudge-harder"]');
    }
    const capped = await readNudge();
    log('knee nudge, capped:', JSON.stringify(capped));
    check(capped.harderDead, 'Harder stops at the best rep this patient actually produced');
    check(/best \(50°\)/.test(capped.harder), `and says so, in degrees: "${capped.harder}"`);

    // the ratio lane: either a visible move or a dead button, never "0.32 → 0.32"
    await page.click('[data-testid="rom-next"]');
    await page.waitForSelector('[data-testid="rom-reuse"]', { timeout: 10_000 });
    await page.click('[data-testid="rom-reuse"]');
    await page.waitForSelector('[data-testid="rom-nudge-harder"]', { timeout: 10_000 });
    const ratio = await readNudge();
    log('march nudge:', JSON.stringify(ratio));
    const identity = /(\d+\.\d+) → \1\b/.test(ratio.harder) || /(\d+\.\d+) → \1\b/.test(ratio.easier);
    check(!identity, `a ratio nudge never says it will turn a number into itself: "${ratio.harder}" / "${ratio.easier}"`);
    // ...and "Easier" never offers a BIGGER top than the patient's own range on a lane already
    // smaller than the minimum usable range.
    const raised = /target (\d+\.\d+) → (\d+\.\d+)/.exec(ratio.easier);
    check(raised === null || Number(raised[2]) <= Number(raised[1]), `Easier never raises the target: "${ratio.easier}"`);
    await page.locator('[data-testid="rom-nudge-harder"]').scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(SHOTS, 'fairness-rom-nudge-ratio.png') });
    // ---- 7. the Results screen: work first, and a card that agrees with itself -----------------
    // Two patients in the history, so the comparison has to be patient-scoped to be right.
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.__beatRehab);
    const results = await page.evaluate(() => {
      const day = 86_400_000;
      const lane = (p) => ({
        lane: 0, movement: 'knee_extension', side: 'left', movementName: 'Left Knee extension',
        hits: 30, perfects: 12, goods: 18, misses: 10, judged: 40, accuracy: 0.75, reps: 34,
        timingBiasMs: 20, timingBiasMadMs: 12, romMean: 0.55, romBest: 0.7, romSamples: 34, romUncertain: 0,
        calibratedMin: 20, calibratedMax: 80, calibrationManual: false,
        compensationKind: null, compensationMonitored: false, compensationFlags: 0, compensationWorst: null,
        attempted: 34, surplus: 2, ...p,
      });
      const session = (p) => ({
        id: 'x', patientId: 'p-a', patientName: 'A. Patient', startedAt: Date.now() - day, endedAt: Date.now() - day + 120_000,
        durationSec: 120, mode: 'leg', difficulty: 'medium', windowScale: 1, inputMode: 'camera',
        songId: 'demo-groove', songTitle: 'Demo Groove', artist: 'A', attribution: 'CC BY',
        score: 4200, stars: 3, accuracy: 0.75, starAccuracy: 0.7, maxCombo: 14, totalNotes: 40,
        hits: 30, perfects: 12, goods: 18, misses: 10, reps: 34, answerRate: 34 / 40, surplusMovements: 2,
        laneRestSec: 1.2, timingBiasMs: 20, timingBiasMadMs: 12, latencyOffsetMs: 120, suggestedLatencyMs: null,
        completed: true, lanes: [lane({})], ...p,
      });
      const older = session({ id: 'a1', startedAt: Date.now() - 7 * day, endedAt: Date.now() - 7 * day + 110_000, reps: 24, lanes: [lane({ reps: 24, romBest: 0.55, romMean: 0.42 })] });
      const otherPatient = session({ id: 'b1', patientId: 'p-b', patientName: 'B. Other', reps: 99, lanes: [lane({ reps: 99, romBest: 0.99 })] });
      const today = session({ id: 'a2', startedAt: Date.now(), endedAt: Date.now() + 120_000 });
      window.__beatRehab.store.setState({ lastResult: today, history: [today, otherPatient, older] });
      window.__beatRehab.gotoScreen('results');
      return true;
    });
    check(results === true, 'the results screen was seeded with two patients of history');
    await page.waitForSelector('[data-testid="results-screen"]', { timeout: 20_000 });
    const card = await page.evaluate(() => {
      const txt = (sel) => document.querySelector(sel)?.textContent.replace(/\s+/g, ' ').trim() ?? null;
      const headings = [...document.querySelectorAll('.eyebrow')].map((e) => e.textContent.trim());
      return {
        consistency: txt('[data-testid="results-consistency"]'),
        firstHeadings: headings.slice(0, 4),
        detailsOpen: [...document.querySelectorAll('details')].map((d) => d.open),
        gradeInFirstScreen: headings.slice(0, 4).some((h) => /score|star|accuracy/i.test(h)),
      };
    });
    log('results headings:', JSON.stringify(card.firstHeadings));
    check(!card.gradeInFirstScreen, `the first figures are work, not a grade (${card.firstHeadings.join(' / ')})`);
    check(/34 of the 40 notes offered/.test(card.consistency), `the count matches the percentage (${card.consistency?.slice(0, 120)})`);
    check(/Counted from the first note/.test(card.consistency), 'the card says how its figure differs from the live gauge');
    check(card.detailsOpen.every((o) => o === false), 'the clinical detail stays folded away');
    await page.screenshot({ path: resolve(SHOTS, 'fairness-results.png') });
  } finally {
    await browser.close();
    await stopServer(server);
  }

  if (failures.length) {
    console.error(`\n[fairness] FAILED ${failures.length} check(s):`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  log('PASSED');
}

main().catch((err) => { console.error(err); process.exit(1); });
