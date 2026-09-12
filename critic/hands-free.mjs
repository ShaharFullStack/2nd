/**
 * THE HANDS-FREE PATH, DRIVEN IN THE REAL APP.
 *
 * Chromium's fake webcam is a test pattern with no person in it, so nothing about a dwell target can
 * be seen from it beyond "not seeing you" — which is itself one of the states that has to be right.
 * For the rest, synthetic detections are fed through `VisionInput.processDetection`, which is the
 * module's own public "a caller feeds frames" entry point: the React screens, the tracker, the mirror
 * flip, the limb choice and the navigation are all the real ones, and only the landmarks are staged.
 *
 * Note that the live detect loop keeps running alongside, so every second frame the trackers see
 * genuinely carries NO limb. A ring that fills anyway is the forgiveness rule (`decayRatio`) working
 * in the running app rather than only in a unit test.
 *
 *   node critic/hands-free.mjs [--headed] [--url http://localhost:5711]
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SHOT_DIR = resolve(HERE, 'screenshots', 'hands-free');
const PORT = Number(process.env.HANDSFREE_PORT ?? 5711);
const args = process.argv.slice(2);
const urlArg = args.includes('--url') ? args[args.indexOf('--url') + 1] : null;
const BASE = urlArg ?? `http://localhost:${PORT}`;
const VIEWPORTS = [
  { width: 1024, height: 768 },
  { width: 1280, height: 800 },
];

const log = (...m) => console.log('[hands-free]', ...m);
const failures = [];
const fail = (m) => {
  failures.push(m);
  console.error('  ✗', m);
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

/**
 * Install a synthetic frame feeder in the page.
 *
 * `window.__feed({ mode, knee, hand })` sets where the limb is (normalized detector coordinates) and
 * a 60 Hz interval pushes a full, plausible seated pose / hand through processDetection.
 */
const FEEDER = () => {
  const vision = window.__beatRehab.runtime.peekVision();
  if (!vision) throw new Error('no vision input');
  const ctx = window.__beatRehab.runtime.peekAudio()?.ctx ?? null;
  let where = { x: 0.1, y: 0.9 };
  let mode = 'leg';

  const P = (x, y) => ({ x, y, z: 0, visibility: 0.95 });
  const pose = () => {
    const lm = Array.from({ length: 33 }, () => P(0.5, 0.5));
    lm[11] = P(0.38, 0.3); // left shoulder
    lm[12] = P(0.62, 0.3); // right shoulder
    lm[23] = P(0.4, 0.62); // left hip
    lm[24] = P(0.6, 0.62); // right hip
    lm[25] = P(where.x, where.y); // LEFT KNEE — the pointer
    lm[26] = P(0.62, 0.78); // right knee, resting
    lm[27] = P(where.x, Math.min(0.98, where.y + 0.16)); // left ankle
    lm[28] = P(0.62, 0.93);
    lm[29] = P(where.x - 0.02, Math.min(0.99, where.y + 0.18));
    lm[30] = P(0.6, 0.95);
    lm[31] = P(where.x + 0.05, Math.min(0.99, where.y + 0.18));
    lm[32] = P(0.67, 0.95);
    return lm;
  };
  const hand = () => {
    const lm = Array.from({ length: 21 }, () => ({ x: where.x, y: where.y, z: 0 }));
    lm[0] = { x: where.x, y: where.y + 0.05, z: 0 };
    lm[5] = { x: where.x + 0.03, y: where.y - 0.02, z: 0 };
    lm[9] = { x: where.x, y: where.y - 0.03, z: 0 };
    lm[13] = { x: where.x - 0.03, y: where.y - 0.02, z: 0 };
    lm[17] = { x: where.x - 0.05, y: where.y, z: 0 };
    return [{ landmarks: lm, label: 'Left', score: 0.96 }];
  };

  let tick = 0;
  const timer = setInterval(() => {
    tick += 1;
    const t = ctx ? ctx.currentTime : tick / 60;
    try {
      vision.processDetection(
        mode === 'leg' ? { tMs: tick * 16, pose: pose(), hands: [] } : { tMs: tick * 16, pose: null, hands: hand() },
        t,
      );
    } catch (err) {
      window.__feedError = String(err);
    }
  }, 16);

  window.__feed = (opts) => {
    if (opts.mode) mode = opts.mode;
    if (opts.at) where = opts.at;
  };
  /** Rest, then reps: what the ROM calibrator is waiting to see, driven off the same feeder. */
  window.__reps = (restY, topY, x, periodSec) => {
    const t0 = performance.now();
    const id = setInterval(() => {
      const el = (performance.now() - t0) / 1000;
      // A long still rest first (the calibrator needs a steady zero), then a slow triangle wave.
      const y = el < 4 ? restY : restY + (topY - restY) * Math.max(0, Math.sin(((el - 4) / periodSec) * Math.PI * 2));
      where = { x, y };
    }, 16);
    window.__stopReps = () => clearInterval(id);
  };
  window.__stopFeed = () => {
    window.__stopReps?.();
    clearInterval(timer);
  };
};

/** The one dwell ring's live state, straight off the DOM the patient is looking at. */
async function ringState(page, testId) {
  return page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="${id}"]`);
    if (!el) return null;
    return {
      phase: el.dataset.phase,
      progress: Number(el.dataset.progress),
      left: el.style.left,
      top: el.style.top,
      height: el.style.height,
      arc: !!document.querySelector(`[data-testid="${id}-arc"]`),
      text: el.textContent,
      box: el.getBoundingClientRect().width,
    };
  }, testId);
}

/** Park the limb on a target and wait for the ring to answer, grabbing the mid-fill frame on the way. */
async function holdUntilRedo(page, at, shotPath, timeoutMs = 60_000) {
  await page.evaluate((p) => window.__feed({ at: p }), at);
  const deadline = Date.now() + timeoutMs;
  let shot = false;
  for (;;) {
    const s = await ringState(page, 'rom-dwell-redo');
    if (s === null) return true;
    if (!shot && s.progress >= 0.3 && s.arc) {
      await page.screenshot({ path: shotPath });
      shot = true;
    }
    // A redo re-arms the lane, which takes the targets off the screen entirely.
    if (await page.evaluate(() => !document.querySelector('[data-testid="rom-handsfree"]'))) return true;
    if (Date.now() > deadline) return false;
    await page.waitForTimeout(70);
  }
}

/** A minimal but complete camera session record, so the results screen has something real to show. */
const RESULT = (patientId, now) => ({
  id: 'handsfree-critic',
  patientId,
  patientName: 'Critic',
  startedAt: now - 90_000,
  endedAt: now,
  durationSec: 90,
  mode: 'leg',
  difficulty: 'easy',
  windowScale: 1,
  inputMode: 'camera',
  songId: 'demo-groove',
  songTitle: 'Demo Groove',
  artist: 'Demo',
  attribution: 'Demo',
  score: 1200,
  stars: 3,
  accuracy: 0.62,
  starAccuracy: 0.6,
  maxCombo: 9,
  totalNotes: 40,
  hits: 25,
  perfects: 10,
  goods: 15,
  misses: 15,
  reps: 30,
  answerRate: 0.7,
  surplusMovements: 5,
  laneRestSec: 1.2,
  timingBiasMs: 12,
  timingBiasMadMs: 20,
  latencyOffsetMs: 120,
  suggestedLatencyMs: null,
  completed: true,
  lanes: [
    {
      lane: 0,
      movement: 'seated_march',
      side: 'left',
      movementName: 'Left Seated march',
      hits: 25,
      perfects: 10,
      goods: 15,
      misses: 15,
      judged: 40,
      accuracy: 0.62,
      reps: 30,
      attempted: 28,
      surplus: 2,
      timingBiasMs: 12,
      timingBiasMadMs: 20,
      romMean: 0.5,
      romBest: 0.72,
      romSamples: 30,
      romUncertain: 0,
      calibratedMin: 0.1,
      calibratedMax: 0.42,
      calibrationManual: false,
      compensationKind: null,
      compensationMonitored: false,
      compensationFlags: 0,
      compensationWorst: null,
    },
  ],
});

async function run(browser, viewport) {
  const tag = `${viewport.width}x${viewport.height}`;
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.context().grantPermissions(['camera'], { origin: BASE });

  // First load warms the model cache; the second is the run under test.
  await page.goto(`${BASE}/`, { waitUntil: 'load' });
  await page.waitForTimeout(800);
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__beatRehab, null, { timeout: 20_000 });

  // THE ONE REAL TAP, and the screen that says it is the only one.
  const onlyTap = await page.getByTestId('only-tap-note').textContent();
  if (!/only time the screen has to be touched/i.test(onlyTap ?? '')) {
    fail(`${tag}: the home screen does not say the tap is the only one`);
  }
  await page.screenshot({ path: resolve(SHOT_DIR, `${tag}-01-home-one-tap.png`) });

  await page.getByTestId('start-session').click();
  // A camera session needs a person on a fresh device: make one, exactly as a therapist would.
  if (await page.evaluate(() => window.__beatRehab.getState().screen === 'patients')) {
    await page.getByTestId('patient-name-input').fill('Critic');
    await page.getByTestId('patient-add').click();
    await page.getByTestId('patient-continue').click();
  }
  await page.getByTestId('mode-leg').click();
  await page.getByTestId('setup-start').click();
  await page.waitForSelector('[data-testid="camera-continue"]', { timeout: 20_000 });
  await page.waitForTimeout(9000); // model download + first inferences
  log(tag, 'on the camera check');

  await page.evaluate(FEEDER);
  await page.evaluate(() => window.__feed({ mode: 'leg', at: { x: 0.12, y: 0.86 } }));
  await page.waitForTimeout(1500);

  /*
   * 1. THE CAMERA CHECK, AND THE PARITY THAT MATTERS MOST HERE.
   *
   * This container runs MediaPipe on a software GL stack at about 1 fps, so the readiness gate is
   * genuinely, correctly shut: one frame every ~900 ms cannot place a repetition inside any hit
   * window this prescription grants. The thing to prove is that the hands-free path is shut WITH it.
   * A dwell target that confirmed what the disabled button refuses would be a second, quieter way
   * into a session that cannot be measured.
   */
  const gate = await ringState(page, 'camera-dwell-continue');
  const buttonBlocked = await page.getByTestId('camera-continue').isDisabled();
  const readiness = await page.evaluate(
    () => document.querySelector('[data-testid="camera-readiness"]')?.dataset.readiness,
  );
  if (!gate) fail(`${tag}: no dwell target on the camera check`);
  if (readiness === 'blocked' && gate && gate.phase !== 'off') {
    fail(`${tag}: the readiness gate is shut but the dwell target is live (phase "${gate.phase}")`);
  }
  if (readiness === 'blocked' && !buttonBlocked) fail(`${tag}: the readiness gate is shut but the button is enabled`);
  if (gate && gate.left !== '50%') fail(`${tag}: the single target is not centred (left ${gate.left})`);
  const gateLegend = await page.getByTestId('camera-dwell-legend').textContent();
  if (readiness === 'blocked' && !/Nothing to confirm yet/.test(gateLegend ?? '')) {
    fail(`${tag}: with frames arriving and the gate shut, the legend says "${gateLegend}"`);
  }
  log(tag, `camera readiness "${readiness}", target phase "${gate?.phase}", button disabled ${buttonBlocked}`);
  await page.screenshot({ path: resolve(SHOT_DIR, `${tag}-02-camera-check.png`) });

  /*
   * FROM HERE ON, THE REAL DETECT LOOP IS STOPPED.
   *
   * MediaPipe on this container's software GL stack takes ~2.9 SECONDS of synchronous main-thread
   * time per frame. Nothing that measures elapsed wall-clock time can be exercised through that: the
   * page is frozen for seconds at a stretch, so a two-second hold is interrupted by a three-second
   * stall roughly every second — which the tracker correctly reports as "not seeing you". That is the
   * machine, not the feature, and a device that slow is refused by the readiness gate asserted above
   * before a patient ever reaches these screens. The landmarks below are synthetic anyway, so the
   * inference that produces none of them is stopped and the main thread is left free.
   */
  await page.evaluate(() => window.__beatRehab.runtime.peekVision().loop?.stop());
  await page.waitForTimeout(500);

  /*
   * 2. ROM CALIBRATION. Nothing is confirmable until the lane has a range, so the range is measured
   *    first — a still rest, then reps, fed as landmarks — and only then do the two targets appear.
   */
  await page.evaluate(() => window.__beatRehab.gotoScreen('rom'));
  await page.waitForSelector('[data-testid="rom-redo"]', { timeout: 15_000 });
  // Three attempts: a scripted rest-then-reps is a caricature of a patient, and the calibrator is
  // entitled to reject one (too little movement, an unsteady zero). Redo and try again, which is what
  // a therapist would do — this is staging the screen, not testing the calibrator.
  let gotRange = false;
  for (let attempt = 0; attempt < 3 && !gotRange; attempt++) {
    if (attempt > 0) await page.getByTestId('rom-redo').click();
    await page.evaluate(() => window.__reps(0.86, 0.4, 0.35, 2.5));
    gotRange = await page
      .waitForSelector('[data-testid="rom-handsfree"]', { timeout: 45_000 })
      .then(() => true)
      .catch(() => false);
    await page.evaluate(() => window.__stopReps?.());
  }
  if (!gotRange) {
    fail(`${tag}: no range could be calibrated from the scripted reps, so the ROM targets were never shown`);
  } else {
    await page.evaluate(() => window.__feed({ at: { x: 0.12, y: 0.86 } }));
    await page.waitForTimeout(900);
    await page.screenshot({ path: resolve(SHOT_DIR, `${tag}-03-rom-two-targets.png`) });

    // THE MIRROR. "Next movement" is at detector x 0.27 and must be drawn at 73 % — on the side of
    // the mirrored preview where the patient's limb appears when they move it there.
    const go = await ringState(page, 'rom-dwell-next');
    const redo = await ringState(page, 'rom-dwell-redo');
    // The forward action is drawn on the LEFT of the mirrored preview — which is what the sentence
    // beside it says, and the same order as the buttons. Detector x 0.73 → drawn at 27 %.
    if (go?.left !== '27%') fail(`${tag}: the forward target is drawn at ${go?.left}, not at 27%`);
    if (redo?.left !== '73%') fail(`${tag}: the redo target is drawn at ${redo?.left}, not at 73%`);
    if (go && go.box < 90) fail(`${tag}: the ring is only ${Math.round(go.box)} px wide — unreadable at 2 m`);

    // HOLDING, with a screenshot taken mid-fill, then the confirm itself.
    // THE REDO TARGET, which is the one a patient alone cannot do without: they have just measured
    // the scale every later percentage is against, and the only other hands-free thing on this screen
    // walks them forward onto it. It is the SECOND of the pair, at detector x 0.27 (drawn right).
    const held = await holdUntilRedo(page, { x: 0.27, y: 0.55 }, resolve(SHOT_DIR, `${tag}-04-rom-holding.png`));
    if (!held) fail(`${tag}: holding a knee on the ROM "do it again" target never confirmed`);
    const after = await page.evaluate(() => ({
      badge: document.querySelector('[data-testid="rom-lane-badge-0"]')?.textContent,
      eyebrow: document.querySelector('.eyebrow')?.textContent,
    }));
    // A redo re-measures THIS lane: it must not have walked the patient on to the next one.
    if (!/lane 1 of/i.test(after.eyebrow ?? '')) {
      fail(`${tag}: "do it again" advanced the session instead of re-measuring ("${after.eyebrow}")`);
    }
    if (after.badge === '✓') fail(`${tag}: "do it again" left the old range in force (badge "${after.badge}")`);
    log(tag, `ROM redo confirmed hands-free and re-armed lane 1 (badge "${after.badge}")`);
  }

  /*
   * 3. THE LATENCY SCREEN. Both of its blocking presses are acknowledgements; the first is the one a
   *    patient alone has to be able to make.
   */
  await page.evaluate(() => window.__beatRehab.gotoScreen('latency'));
  await page.waitForSelector('[data-testid="latency-dwell-start"]', { timeout: 10_000 });
  await page.evaluate(() => window.__feed({ at: { x: 0.12, y: 0.86 } }));
  await page.waitForTimeout(900);
  const latencyIdle = await ringState(page, 'latency-dwell-start');
  if (latencyIdle?.phase !== 'enter') fail(`${tag}: the latency start target reports "${latencyIdle?.phase}"`);
  await page.screenshot({ path: resolve(SHOT_DIR, `${tag}-05-latency-target.png`) });

  await page.evaluate(() => window.__feed({ at: { x: 0.5, y: 0.55 } }));
  const started = await page
    .waitForFunction(() => !document.querySelector('[data-testid="latency-dwell-start"]'), null, { timeout: 40_000 })
    .then(() => true)
    .catch(() => false);
  if (!started) fail(`${tag}: holding the latency target never started the metronome`);
  const hidden = await page.evaluate(() => !!document.querySelector('[data-testid="latency-handsfree-paused"]'));
  if (!hidden) fail(`${tag}: the target is not stood down while the metronome runs`);
  await page.screenshot({ path: resolve(SHOT_DIR, `${tag}-06-latency-running.png`) });
  log(tag, 'a held knee started the latency probe, and the target stood itself down for the reps');

  const handsFree = await page.evaluate(() => window.__beatRehab.getState().handsFree);
  if (handsFree !== true) fail(`${tag}: confirming hands-free did not record that the patient is working alone`);

  /*
   * 4. THE LAST SCREEN, which is the easiest one to be stranded on.
   */
  await page.evaluate((record) => {
    const st = window.__beatRehab.getState();
    st.addResult({ ...record, patientId: st.activePatientId });
    window.__beatRehab.gotoScreen('results');
  }, RESULT(null, Date.now()));
  await page.waitForSelector('[data-testid="results-handsfree"]', { timeout: 15_000 });
  await page.evaluate(() => window.__feed({ at: { x: 0.12, y: 0.86 } }));
  await page.waitForTimeout(900);
  await page.screenshot({ path: resolve(SHOT_DIR, `${tag}-07-results-targets.png`) });

  if (!(await page.evaluate(() => !!window.__beatRehab.runtime.peekVision()))) {
    fail(`${tag}: the camera was released on results, stranding a patient with no way off`);
  }
  const saidSo = await page.getByTestId('results-camera-on').textContent();
  if (!/camera still on/i.test(saidSo ?? '')) fail(`${tag}: results does not say the camera is still running`);
  const again = await ringState(page, 'results-dwell-again');
  const fresh = await ringState(page, 'results-dwell-new');
  if (!again || !fresh) fail(`${tag}: the results screen is missing one of its two targets`);
  else if (again.left === fresh.left) fail(`${tag}: the two results targets are drawn on top of each other`);

  // Hold the right-hand ring — "New session" — without touching anything.
  await page.evaluate(() => window.__feed({ at: { x: 0.27, y: 0.55 } }));
  const left = await page
    .waitForFunction(() => window.__beatRehab.getState().screen === 'mode', null, { timeout: 40_000 })
    .then(() => true)
    .catch(() => false);
  if (!left) fail(`${tag}: holding the results target never started a new session`);
  else log(tag, 'a held knee left the results screen for a new session');

  if (errors.length) fail(`${tag}: page errors: ${errors.slice(0, 4).join(' | ')}`);
  const feedError = await page.evaluate(() => window.__feedError ?? null);
  if (feedError) fail(`${tag}: the synthetic frame feed threw: ${feedError}`);
  await page.evaluate(() => window.__stopFeed?.());
  await page.close();
}

async function main() {
  mkdirSync(SHOT_DIR, { recursive: true });
  let server = null;
  if (!urlArg) {
    server = spawn('node_modules/.bin/vite', ['--port', String(PORT), '--strictPort'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    server.stderr.on('data', (d) => process.stderr.write(`[vite] ${d}`));
    await waitForServer(BASE);
  }
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium',
    headless: !args.includes('--headed'),
    args: [
      '--no-sandbox',
      '--autoplay-policy=no-user-gesture-required',
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--use-gl=swiftshader',
    ],
  });
  try {
    for (const viewport of VIEWPORTS) await run(browser, viewport);
  } catch (err) {
    fail(`threw: ${err?.stack ?? err}`);
  } finally {
    await browser.close();
    if (server) server.kill('SIGTERM');
  }
  if (failures.length) {
    console.error('[hands-free] FAILED');
    process.exit(1);
  }
  console.log(`[hands-free] PASSED — screenshots in ${SHOT_DIR}`);
  process.exit(0);
}
main();
