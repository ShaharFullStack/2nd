/**
 * FROM THE THERAPIST PRESSING START TO THE PATIENT'S FIRST SCORED NOTE.
 *
 *   node critic/first-scored-note.mjs [--port 5791] [--headed]
 *
 * The product owner's complaint was measured, so the fix is measured the same way: a four-lane hand
 * prescription demanded twelve maximum-effort repetitions from an impaired hand, four rest holds and
 * an eight-beat metronome before a single note of music. This harness walks BOTH paths through the
 * real app — the controlled `measured` one (what shipped) and the new `in_song` default — and
 * reports two figures for each:
 *
 *  - DEMANDED WORK, which is exact and does not depend on this machine: the screens the patient is
 *    taken through, the maximum-effort repetitions and rest holds each one requires of them, and the
 *    metronome beats. This is the figure the complaint was about.
 *  - WALL-CLOCK SECONDS from the Start press to the first scored note. REAL for the app — the store,
 *    the screens, the song load, the audio clock and the count-in are all the shipping code — and
 *    SIMULATED for the patient: the body in front of the camera is injected fixture landmarks moving
 *    at one fixed, clinically plausible cadence (`REP_MS`), not a human. It is a fair comparison of
 *    the two paths at one cadence, not a claim about any particular patient.
 *
 * MediaPipe inference costs seconds per frame in this container, so — exactly as critic/handsfree.mjs
 * does — the real camera is opened and measured once and its detect loop is then stopped, leaving the
 * injected patient as the only frame source. Opening the camera is therefore inside the wall clock;
 * repeated real inference is not, on EITHER path, so the comparison between them is unaffected.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { chromiumExecutable } from './browser-path.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const OUT = resolve(HERE, 'first-scored-note');

const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const PORT = Number(arg('--port', 5791));
const BASE = `http://localhost:${PORT}`;
const HEADED = argv.includes('--headed');

/** One repetition of the injected patient: up, held at the top, down, then a pause at rest. */
const REP_MS = { up: 320, hold: 200, down: 320, rest: 700 };

const log = (...m) => console.log('[first-note]', ...m);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const PRESCRIPTIONS = {
  hand4: {
    label: 'HAND, four lanes',
    mode: 'hand',
    lanes: [
      { movement: 'hand_open_close', side: 'left' },
      { movement: 'hand_open_close', side: 'right' },
      { movement: 'finger_opposition', side: 'left' },
      { movement: 'finger_opposition', side: 'right' },
    ],
  },
  leg2: {
    label: 'LEG, two lanes',
    mode: 'leg',
    lanes: [
      { movement: 'seated_march', side: 'left' },
      { movement: 'seated_march', side: 'right' },
    ],
  },
};

async function waitForServer(url, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    await wait(250);
  }
  throw new Error(`server at ${url} never came up`);
}

async function stopServer(server) {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  const exited = new Promise((r) => server.once('exit', r));
  try {
    process.kill(-server.pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
  await Promise.race([exited, wait(4000)]);
  try {
    process.kill(-server.pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
}

/**
 * The real camera is opened and really measured — one inference — and then, if that one frame cost
 * more than a frame budget, its loop is stopped. Same decision, same reason and same words as
 * critic/handsfree.mjs: nothing hands-free or timed can happen through 5 s of main-thread inference
 * per frame, and the cause is the machine, not the app.
 */
function quietCameraIfStarved(page) {
  return page.evaluate(
    () =>
      new Promise((resolve) => {
        const t0 = performance.now();
        const id = setInterval(() => {
          const vision = window.__beatRehab.runtime.peekVision?.();
          const stats = vision?.getStats?.();
          if (stats && stats.frames >= 1) {
            clearInterval(id);
            if (stats.inferenceMs < 120) return resolve(null);
            if (!vision.loop || typeof vision.loop.stop !== 'function') return resolve('the detect loop could not be reached to quiet it');
            vision.loop.stop();
            return resolve(`one camera frame costs ${stats.inferenceMs.toFixed(0)} ms here, so the real detect loop was stopped after ${stats.frames} frame(s); the injected patient is the only frame source from here on`);
          }
          if (performance.now() - t0 > 120_000) {
            clearInterval(id);
            resolve('the camera never produced a frame to measure this machine with');
          }
        }, 10);
      }),
  );
}

/**
 * Put a patient in front of the camera: fixture landmarks pushed into the LIVE VisionInput through
 * its own `processDetection` — the entry point the real detect loop calls, on the real audio clock.
 * Everything downstream (feature extraction, the filter, the calibrator, the lane triggers, the
 * in-song learner) is the shipping code.
 *
 * Both limbs move together at `amount`, and in hand mode both movements of the hand move together,
 * so whichever lanes the prescription names are all being performed by one number.
 */
async function installBody(page, mode) {
  const ok = await page.evaluate(async (m) => {
    const api = window.__beatRehab;
    if (!api) return 'no window.__beatRehab';
    let fx;
    let lm;
    try {
      fx = await import('/src/vision/fixtures.ts');
      lm = await import('/src/vision/landmarks.ts');
    } catch (e) {
      return `could not load the landmark fixtures: ${String(e)}`;
    }
    const body = {
      mode: m,
      /** 0 = at rest, 1 = this patient's comfortable maximum. */
      amount: 0,
      /** The landmark slots that belong to the RIGHT leg, for merging two one-sided rigs into one. */
      rightLeg: [lm.POSE.RIGHT_HIP, lm.POSE.RIGHT_KNEE, lm.POSE.RIGHT_ANKLE, lm.POSE.RIGHT_HEEL, lm.POSE.RIGHT_FOOT_INDEX],
      injected: 0,
      lastError: null,
      tick: () => {
        const vision = api.runtime.peekVision?.();
        const ctx = api.runtime.peekAudio?.()?.ctx;
        if (!vision || !ctx) return;
        try {
          const a = body.amount;
          if (body.mode === 'hand') {
            const hand = (centerX) => fx.handPose({ openness: a, pinch: a, centerX });
            vision.processDetection(
              {
                tMs: performance.now(),
                pose: null,
                // mirrored=false: MediaPipe's "Left" label is the patient's RIGHT hand
                // (vision/mediapipe.ts labelToPatientSide).
                hands: [
                  { landmarks: hand(0.65), label: 'Left', score: 0.99 },
                  { landmarks: hand(0.35), label: 'Right', score: 0.99 },
                ],
              },
              ctx.currentTime,
            );
          } else {
            // BOTH KNEES MARCH TOGETHER. `seatedPose` lifts one side, so the right leg's landmarks
            // are copied out of a right-sided rig into the left-sided one — one frame with both legs
            // up, rather than alternating frames (which the lane filter would average to half a rep).
            const left = fx.seatedPose({ kneeLift: a, side: 'left', hands: 'chair_arms' });
            const right = fx.seatedPose({ kneeLift: a, side: 'right', hands: 'chair_arms' });
            const pose = left.slice();
            for (const idx of body.rightLeg) pose[idx] = right[idx];
            const leftW = fx.seatedPoseWorld({ kneeLift: a, side: 'left' });
            const rightW = fx.seatedPoseWorld({ kneeLift: a, side: 'right' });
            const world = leftW.slice();
            for (const idx of body.rightLeg) world[idx] = rightW[idx];
            vision.processDetection({ tMs: performance.now(), pose, poseWorld: world, hands: [] }, ctx.currentTime);
          }
          body.injected++;
        } catch (e) {
          body.lastError = String(e);
        }
      },
    };
    // ~45 Hz, comfortably above a webcam's own rate.
    body.timer = setInterval(body.tick, 22);
    window.__body = body;
    return 'ok';
  }, mode);
  if (ok !== 'ok') throw new Error(`could not put a patient in front of the camera: ${ok}`);
}

const setAmount = (page, amount) => page.evaluate((a) => { window.__body.amount = a; }, amount);

/** One comfortable maximum-effort repetition, at the harness's fixed cadence. */
async function rep(page) {
  const steps = 8;
  for (let i = 1; i <= steps; i++) {
    await setAmount(page, i / steps);
    await wait(REP_MS.up / steps);
  }
  await wait(REP_MS.hold);
  for (let i = steps - 1; i >= 0; i--) {
    await setAmount(page, i / steps);
    await wait(REP_MS.down / steps);
  }
  await wait(REP_MS.rest);
}

const screenOf = (page) => page.evaluate(() => window.__beatRehab.getState().screen);
const hud = (page) => page.evaluate(() => window.__beatRehab.getScore?.() ?? null);

/** Press a button if it is on screen and enabled; returns whether it was pressed. */
async function press(page, testId) {
  const el = page.getByTestId(testId);
  if ((await el.count()) === 0) return false;
  if (await el.first().isDisabled().catch(() => false)) return false;
  await el.first().click({ timeout: 5000 }).catch(() => undefined);
  return true;
}

/**
 * One run of one prescription on one path, timed from the Start press on the setup screen to the
 * first note the patient actually scores.
 */
async function measure(page, key, calibrationMode) {
  const p = PRESCRIPTIONS[key];
  const work = { screens: [], maxEffortReps: 0, restHolds: 0, metronomeBeats: 0, dwellHolds: 0 };

  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__beatRehab, null, { timeout: 30_000 });
  await page.evaluate(
    ({ lanes, mode, calibrationMode }) => {
      const now = Date.now();
      localStorage.clear();
      window.__beatRehab.store.setState({
        patients: [{ id: 'p_m', name: 'Measured patient', createdAt: now - 86_400_000, lastUsedAt: now }],
        activePatientId: 'p_m',
        // A patient with no history: the hardest case for the in-song path, because there is no
        // saved range to seed from.
        savedCalibrations: {},
        calibrationsByPatient: {},
        history: [],
      });
      const s = window.__beatRehab.store.getState();
      s.setInputMode('camera');
      s.setMode(mode);
      s.setLanes(lanes.map((l, i) => ({ index: i, movement: l.movement, side: l.side })));
      s.setDifficulty('easy');
      s.setWindowScale(4); // a slow tablet's windows, so the gate under test is the calibration one
      s.setCalibrationMode(calibrationMode);
      s.updateSettings({ mirrored: false });
    },
    { lanes: p.lanes, mode: p.mode, calibrationMode },
  );

  // The gesture the AudioContext needs, before the clock starts: the therapist opening the session.
  await page.getByTestId('start-session').click();
  await page.waitForFunction(() => !!window.__beatRehab.runtime.peekAudio?.(), null, { timeout: 15_000 });
  await page.evaluate(() => window.__beatRehab.gotoScreen('setup'));
  await page.waitForFunction(() => window.__beatRehab.getState().screen === 'setup', null, { timeout: 10_000 });
  await page.getByTestId('setup-start').waitFor({ timeout: 15_000 });

  // ---- THE CLOCK STARTS HERE: the therapist presses Start on the setup screen. ----------------
  const t0 = Date.now();
  await page.getByTestId('setup-start').click();

  await page.waitForFunction(() => window.__beatRehab.getState().screen === 'camera', null, { timeout: 20_000 });
  work.screens.push('camera check');
  await page.waitForFunction(() => !!window.__beatRehab.runtime.peekVision?.(), null, { timeout: 120_000 });
  const quieted = await quietCameraIfStarved(page);
  await installBody(page, p.mode);
  await page.waitForFunction(() => (window.__body?.injected ?? 0) > 5, null, { timeout: 60_000 });

  // Forward off the camera check. On a container the device verdict is "blocked" (real inference at
  // ~5 s a frame), which closes the green button; the escape beside it is the therapist's way on and
  // is the same press on both paths, so it does not distort the comparison.
  // The device verdict starts as `measuring` (which disables the green button and offers no escape
  // yet) and settles within a second or two of readings, so this keeps trying until the screen
  // actually moves rather than pressing once into a control that is not there yet.
  const leaveCamera = Date.now() + 90_000;
  while ((await screenOf(page)) === 'camera' && Date.now() < leaveCamera) {
    if (!(await press(page, 'camera-continue'))) {
      if (!(await press(page, 'camera-continue-anyway'))) await press(page, 'camera-readiness-continue-anyway');
    }
    await wait(500);
  }
  if ((await screenOf(page)) === 'camera') throw new Error('the camera check never offered a way forward');

  if (calibrationMode === 'measured') {
    await page.waitForFunction(() => window.__beatRehab.getState().screen === 'rom', null, { timeout: 30_000 });
    for (let lane = 0; lane < p.lanes.length; lane++) {
      work.screens.push(`range of motion, lane ${lane + 1}`);
      // THE REST HOLD: the patient holds still until the screen accepts the zero.
      work.restHolds++;
      await setAmount(page, 0);
      await page.waitForFunction(
        () => {
          const steps = [...document.querySelectorAll('.rom-steps li')];
          return steps.length >= 2 && steps[1].getAttribute('aria-current') === 'step';
        },
        null,
        { timeout: 40_000 },
      ).catch(() => undefined);
      // THE REPETITIONS: as many as the calibrator needs, at comfortable maximum.
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        const done = await page.evaluate((l) => window.__beatRehab.getState().calibrations[l] !== null, lane);
        if (done) break;
        await rep(page);
        work.maxEffortReps++;
      }
      // …and the therapist confirms the lane.
      await press(page, 'rom-next');
      await page.waitForFunction(
        (l) => {
          const st = window.__beatRehab.getState();
          return st.screen !== 'rom' || st.calibrations.filter((c) => c !== null).length > l;
        },
        lane,
        { timeout: 8000 },
      ).catch(() => undefined);
    }
    await page.waitForFunction(() => window.__beatRehab.getState().screen === 'latency', null, { timeout: 40_000 }).catch(() => undefined);
    if ((await screenOf(page)) === 'latency') {
      work.screens.push('latency metronome');
      work.metronomeBeats = 8;
      await press(page, 'latency-start');
      // Eight beats at 60 BPM: eight seconds of movement from the limb that is about to do the work.
      for (let b = 0; b < 10; b++) await rep(page);
      await wait(600);
      if (!(await press(page, 'latency-accept'))) await press(page, 'latency-skip');
      await page.waitForFunction(() => window.__beatRehab.getState().screen === 'play', null, { timeout: 8000 }).catch(() => undefined);
    }
  }

  await page.waitForFunction(() => window.__beatRehab.getState().screen === 'play', null, { timeout: 60_000 });
  work.screens.push('the song');

  // The patient plays: continuous repetitions until one of them scores.
  const playDeadline = Date.now() + 180_000;
  let first = null;
  let repsInSong = 0;
  while (Date.now() < playDeadline) {
    const h = await hud(page);
    if (h && h.hits >= 1) {
      first = Date.now();
      break;
    }
    await rep(page);
    repsInSong++;
  }
  const h = await hud(page);
  if (first === null) throw new Error(`no note was scored within 180 s (hud ${JSON.stringify(h)}, body ${JSON.stringify(await page.evaluate(() => ({ injected: window.__body?.injected, err: window.__body?.lastError })))})`);

  const ranges = await page.evaluate(() => {
    const v = window.__beatRehab.runtime.peekVision?.();
    return (v?.getLaneDebug?.() ?? []).map((l) => ({
      lane: l.lane,
      method: l.calibration?.measurement?.method ?? null,
      min: l.calibration?.min ?? null,
      max: l.calibration?.max ?? null,
    }));
  });

  await page.screenshot({ path: resolve(OUT, `${key}-${calibrationMode}.png`) });
  await page.evaluate(() => {
    clearInterval(window.__body?.timer);
    window.__beatRehab.runtime.disposeVision?.();
  });

  return {
    prescription: p.label,
    path: calibrationMode,
    secondsToFirstScoredNote: (first - t0) / 1000,
    work: { ...work, repsInSongBeforeFirstScore: repsInSong },
    ranges,
    quieted,
    songTimeAtFirstScore: h?.songTime ?? null,
  };
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  let server = null;
  const results = [];
  let browser = null;
  try {
    log(`starting vite on :${PORT}`);
    server = spawn(resolve(ROOT, 'node_modules/.bin/vite'), ['--port', String(PORT), '--strictPort'], {
      cwd: ROOT,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stdout.on('data', () => undefined);
    server.stderr.on('data', (d) => process.stderr.write(`[vite] ${d}`));
    await waitForServer(BASE);

    browser = await chromium.launch({
      headless: !HEADED,
      executablePath: chromiumExecutable,
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
      ],
    });
    const context = await browser.newContext({ permissions: ['camera'], viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    page.on('pageerror', (e) => console.warn('[page error]', e.message));

    for (const key of ['hand4', 'leg2']) {
      for (const mode of ['measured', 'in_song']) {
        log(`measuring ${key} / ${mode}…`);
        const r = await measure(page, key, mode);
        results.push(r);
        log(`  ${r.prescription} · ${r.path}: ${r.secondsToFirstScoredNote.toFixed(1)} s, ${r.work.maxEffortReps} max-effort rep(s), ${r.work.restHolds} rest hold(s), ${r.work.metronomeBeats} metronome beat(s)`);
      }
    }
  } finally {
    await browser?.close().catch(() => undefined);
    await stopServer(server);
  }

  writeFileSync(resolve(OUT, 'report.json'), JSON.stringify(results, null, 2));
  console.log('\n[first-note] TIME AND EFFORT FROM START TO THE FIRST SCORED NOTE\n');
  for (const r of results) {
    console.log(`  ${r.prescription} — ${r.path === 'measured' ? 'BEFORE (measure it first)' : 'AFTER (learn it in the song)'}`);
    console.log(`    ${r.secondsToFirstScoredNote.toFixed(1)} s wall clock (app real, patient simulated at a fixed cadence)`);
    console.log(`    screens the patient is taken through: ${r.work.screens.join(' -> ')}`);
    console.log(`    maximum-effort repetitions demanded before the song: ${r.work.maxEffortReps}`);
    console.log(`    rest holds: ${r.work.restHolds} · metronome beats: ${r.work.metronomeBeats}`);
    console.log(`    ranges in force at the first scored note: ${r.ranges.map((x) => `lane ${x.lane + 1} ${x.method ?? 'none'}`).join(', ')}`);
    console.log('');
  }
  console.log(`[first-note] report -> ${resolve(OUT, 'report.json')}`);
}

main().catch((e) => {
  console.error('[first-note] FAILED', e);
  process.exitCode = 1;
});
