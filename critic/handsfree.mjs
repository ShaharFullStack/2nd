/**
 * HANDS-FREE: can a patient whose hands are the input device get from the camera check into the
 * song without touching the tablet?
 *
 *   node critic/handsfree.mjs [--url http://localhost:5712] [--headed]
 *
 * WHY THIS HARNESS EXISTS. In hand mode the patient's hands ARE the controller; in leg mode they
 * are seated out of reach of the screen. Every click between the camera check and the first note
 * therefore breaks the pose the app just asked them to hold — or needs a second person. The
 * dwell-to-confirm gesture ("hold a hand or a knee over the on-screen target until it fills") is
 * the answer, and this is the independent proof that it works for a body rather than for a mouse.
 *
 * THE BUDGET: ONE real user input, ever.
 *   The browser will not start an AudioContext without a genuine user gesture (src/session/runtime.ts
 *   :478 — `ctx.resume()` never settles without one, which is why the camera check times out into the
 *   "the browser is waiting for a tap" screen). That tap is the therapist's, on Home, before the
 *   patient is in position. From then on this harness performs ZERO clicks, taps and key presses,
 *   and a listener installed before the page's own code counts every trusted input event to prove it.
 *   Home -> mode -> setup are the THERAPIST's screens and are not part of the claim; the harness
 *   walks them through the store (`window.__beatRehab`), which is not an input either.
 *
 * HOW THE PATIENT IS SIMULATED. Not the mouse: synthetic MediaPipe landmarks of a seated patient
 * (src/vision/fixtures.ts, the rig the vision unit tests use) are fed to the live VisionInput through
 * its public `processDetection(result, ctxTime)` — the same entry point the real detect loop calls,
 * on the same AudioContext clock. Everything downstream is the shipping code: feature extraction,
 * the unit-free filter, the ROM calibrator, the lane triggers and whatever the dwell target derives
 * its pointer from. The harness moves a limb and waits; it never calls a confirm handler. The one
 * thing it cannot do is produce photons, so Chromium's fake webcam supplies the real camera the app
 * opens, and its (person-free) frames interleave with the injected ones.
 *
 * WHAT IT LOOKS FOR. A dwell target is any visible element carrying a data-testid that is either a
 * `.dwell-target` or publishes a fill (`data-progress`, `data-dwell-progress` or `aria-valuenow`);
 * the legend beside it is deliberately not one. Each step names the testids that can confirm it
 * (`camera-dwell-continue`, `rom-dwell-next`, `latency-dwell-start`, `latency-dwell-accept` /
 * `latency-dwell-carry-on`) and falls back to the only target on screen, saying so when it does.
 *
 * WHERE IT AIMS, best first — the first one available is used and named in the summary:
 *   1. `data-dwell-x` / `data-dwell-y`: the target's centre in the same normalized video coordinates
 *      the landmarks are in. Nothing is guessed.
 *   2. the ring's own drawn position — its inline left/top inside `.camera-frame`. That is the circle
 *      the PATIENT can see, which is the thing that has to be reachable; the preview is CSS-mirrored
 *      and the harness is not told which sense, so it tries both and reports which one worked.
 *   3. the ring measured against the preview's box.
 * Nothing on screen, or a target that says nothing about where it is, FAILS with that sentence.
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const OUT = resolve(HERE, 'handsfree');
const EXECUTABLE = '/opt/pw-browsers/chromium';

const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const PORT = Number(process.env.HANDSFREE_PORT ?? 5712);
const urlArg = arg('--url', null);
const BASE = urlArg ?? `http://localhost:${PORT}`;

/** The prescription the patient is put through: two lanes, so "every prescribed lane" means more than one. */
const LANES = [
  { movement: 'seated_march', side: 'left' },
  { movement: 'seated_march', side: 'right' },
];

const log = (...m) => console.log('[handsfree]', ...m);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Steps of the hands-free flow, each with how it was confirmed. Printed at the end. */
const steps = [];
const shots = [];
const record = (step, how) => {
  steps.push({ step, how });
  log(`step: ${step} — ${how}`);
};

/** A missing piece of the feature under test, as opposed to a broken harness. */
class NotBuiltYet extends Error {}

async function waitForServer(url, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up */
    }
    await wait(250);
  }
  throw new Error(`server at ${url} never came up`);
}

/**
 * Tear the dev server down for real — the pattern from critic/frames.mjs, which exists because the
 * `npx vite` wrapper left orphans holding this process's stdio pipes. Signals the whole process
 * group and waits for the actual `exit`.
 */
async function stopServer(server) {
  if (server.exitCode !== null || server.signalCode !== null) return;
  const exited = new Promise((r) => server.once('exit', r));
  const signalGroup = (sig) => {
    try {
      process.kill(-server.pid, sig);
    } catch {
      try {
        server.kill(sig);
      } catch {
        /* already gone */
      }
    }
  };
  signalGroup('SIGTERM');
  const died = await Promise.race([exited.then(() => true), wait(3000).then(() => false)]);
  if (!died) {
    log('vite did not stop on SIGTERM, escalating to SIGKILL');
    signalGroup('SIGKILL');
    await Promise.race([exited, wait(2000)]);
  }
  server.stdout?.destroy();
  server.stderr?.destroy();
  server.unref();
}

// ---------------------------------------------------------------------------------------------
// The input ledger: installed before any app code runs, counts every TRUSTED input event.
// ---------------------------------------------------------------------------------------------

const INPUT_LEDGER = () => {
  const ledger = { gestures: [], events: [] };
  const PRESS = new Set(['pointerdown', 'mousedown', 'touchstart', 'keydown']);
  for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click', 'touchstart', 'keydown', 'keyup']) {
    window.addEventListener(
      type,
      (e) => {
        if (!e.isTrusted) return; // a synthetic event is not a finger
        const at = performance.now();
        const target = e.target instanceof Element ? e.target.closest('[data-testid]')?.getAttribute('data-testid') ?? e.target.tagName : '?';
        ledger.events.push({ type, at, target });
        // One press of one button fires pointerdown AND mousedown: coalesce anything inside 120 ms
        // into the single gesture a person actually made.
        if (!PRESS.has(type)) return;
        const last = ledger.gestures[ledger.gestures.length - 1];
        if (last && at - last.at < 120) return;
        ledger.gestures.push({ type, at, target });
      },
      true,
    );
  }
  window.__handsfreeLedger = ledger;
};

// ---------------------------------------------------------------------------------------------
// The body: synthetic landmarks fed to the live VisionInput.
// ---------------------------------------------------------------------------------------------

/**
 * Install the frame driver. From here on the page has a patient in front of the camera: a seated
 * figure whose active knee is at `lift` (0 = resting, 1 = fully raised) and whose whole scene can be
 * translated by (dx, dy) so a named landmark can be put anywhere in frame.
 */
async function installBody(page) {
  const ok = await page.evaluate(async () => {
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
      side: 'left',
      lift: 0,
      dx: 0,
      dy: 0,
      injected: 0,
      lastError: null,
      /** Landmark indices this harness can aim with, in the order it tries them. */
      points: () => ({
        knee: body.side === 'left' ? lm.POSE.LEFT_KNEE : lm.POSE.RIGHT_KNEE,
        ankle: body.side === 'left' ? lm.POSE.LEFT_ANKLE : lm.POSE.RIGHT_ANKLE,
        wrist: body.side === 'left' ? lm.POSE.LEFT_WRIST : lm.POSE.RIGHT_WRIST,
        nose: lm.POSE.NOSE,
      }),
      pose: () => fx.seatedPose({ kneeLift: body.lift, side: body.side }),
      /** Where a named landmark currently is, in normalized camera coordinates. */
      at: (name) => {
        const idx = body.points()[name];
        if (idx === undefined) return null;
        const p = body.pose()[idx];
        return { x: p.x + body.dx, y: p.y + body.dy };
      },
      /** Translate the scene so `name` sits at (x, y). The features are body-scaled, so this is free. */
      aim: (name, x, y) => {
        const idx = body.points()[name];
        if (idx === undefined) return false;
        const p = body.pose()[idx];
        body.dx = x - p.x;
        body.dy = y - p.y;
        return true;
      },
      tick: () => {
        const vision = api.runtime.peekVision?.();
        const ctx = api.runtime.peekAudio?.()?.ctx;
        if (!vision || !ctx) return;
        const raw = body.pose();
        const moved = body.dx || body.dy ? fx.translateLandmarks(raw, body.dx, body.dy) : raw;
        try {
          vision.processDetection(
            {
              tMs: performance.now(),
              pose: moved,
              poseWorld: fx.seatedPoseWorld({ kneeLift: body.lift, side: body.side }),
              hands: [],
            },
            ctx.currentTime,
          );
          body.injected++;
        } catch (e) {
          body.lastError = String(e);
        }
      },
    };
    // ~45 Hz: comfortably above the camera's own rate, so the injected patient is the majority of
    // what every screen measures rather than a minority inside the fake webcam's empty frames.
    body.timer = setInterval(body.tick, 22);
    window.__hfBody = body;
    return 'ok';
  });
  if (ok !== 'ok') throw new Error(`could not put a patient in front of the camera: ${ok}`);
}

/**
 * A container with no graphics acceleration runs MediaPipe's own inference at over a second a frame,
 * on the main thread — which starves every timer on the page, including the one feeding the patient
 * in (23 injected frames in 15 seconds instead of 680) and the dwell watchdog, which feeds its
 * trackers nothing whenever frames are more than 0.2 s apart. Nothing hands-free can happen through
 * that, and the cause is the machine, not the app.
 *
 * So: let the real camera open and run ONE real inference — which is what measures this machine — and
 * if that one frame cost more than a frame budget, stop the detect loop there. The device was really
 * opened and really measured; what is switched off is repeated inference on a webcam with no person
 * in it, after which the injected patient is the only frame source.
 *
 * Stopping after the FIRST frame is deliberate: `DetectLoop` only computes a frame RATE from the
 * second frame onward, so the camera check is left with an inference time and no fps — and its
 * device-readiness gate (which compares one frame interval against the widest hit window the
 * prescription grants, and would close on a machine this slow) has nothing to judge. That gate is a
 * true statement about a device, it is not the gesture under test, and a harness that let it decide
 * would pass or fail with the container's load average. What it costs this run is stated in the
 * summary: the readiness verdict is not exercised here. On a machine with a GPU none of this fires
 * and the loop keeps running.
 */
async function quietCameraIfStarved(page) {
  return page.evaluate(
    () =>
      new Promise((resolve) => {
        const t0 = performance.now();
        // A 10 ms timer, not a Playwright poll: inference blocks the main thread, so this callback runs
        // the instant the first one returns — before the loop can schedule a second.
        const id = setInterval(() => {
          const vision = window.__beatRehab.runtime.peekVision?.();
          const stats = vision?.getStats?.();
          if (stats && stats.frames >= 1) {
            clearInterval(id);
            if (stats.inferenceMs < 120) return resolve(null); // fast enough: leave the real loop alone
            if (!vision.loop || typeof vision.loop.stop !== 'function') {
              return resolve(`one camera frame costs ${stats.inferenceMs.toFixed(0)} ms on this machine and the detect loop could not be reached to quiet it`);
            }
            vision.loop.stop();
            const after = vision.getStats();
            return resolve(
              `one camera frame costs ${stats.inferenceMs.toFixed(0)} ms on this machine (${vision.getStatus().delegate}), which starves the page, so the real detect loop was stopped after ${after.frames} frame(s) and the injected patient is the only frame source from here on. The camera check is therefore left with no frame RATE to judge this device by, and its device-readiness gate is not exercised by this run.`,
            );
          }
          if (performance.now() - t0 > 120_000) {
            clearInterval(id);
            resolve('the camera never produced a frame to measure this machine with');
          }
        }, 10);
      }),
  );
}

const setLimb = (page, patch) =>
  page.evaluate((p) => {
    Object.assign(window.__hfBody, p);
  }, patch);

/** One comfortable repetition: up over ~320 ms, held, down again, then a pause at rest. */
async function rep(page) {
  for (let i = 1; i <= 8; i++) {
    await setLimb(page, { lift: i / 8 });
    await wait(40);
  }
  await wait(260);
  for (let i = 7; i >= 0; i--) {
    await setLimb(page, { lift: i / 8 });
    await wait(40);
  }
  await wait(420);
}

// ---------------------------------------------------------------------------------------------
// The dwell gesture.
// ---------------------------------------------------------------------------------------------
/**
 * Everything the page can tell us about the dwell target for one action, or why there is none.
 * Runs in the page; `ids` are the data-testids this step can be confirmed by, best first.
 */
const probeDwell = ({ ids }) => {
  const num = (el, ...names) => {
    for (const n of names) {
      const v = el.getAttribute(n);
      if (v !== null && v !== '' && Number.isFinite(Number(v))) return Number(v);
    }
    return null;
  };
  const progressOf = (el) => {
    const v = num(el, 'data-progress', 'data-dwell-progress', 'aria-valuenow');
    return v === null ? null : v > 1 ? v / 100 : v;
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  /** A dwell TARGET: something the patient can hold a limb on. Never the legend beside it. */
  const isTarget = (el) =>
    visible(el) && (el.classList.contains('dwell-target') || el.hasAttribute('data-dwell-x') || progressOf(el) !== null);
  const all = Array.from(document.querySelectorAll('[data-testid]')).filter(isTarget);

  let pick = null;
  let matchedBy = null;
  for (const id of ids) {
    const el = document.querySelector(`[data-testid="${id}"]`);
    if (el && isTarget(el)) {
      pick = el;
      matchedBy = id;
      break;
    }
  }
  const assumed = !pick && all.length === 1;
  if (assumed) {
    pick = all[0];
    matchedBy = pick.getAttribute('data-testid');
  }
  if (!pick) {
    return {
      found: false,
      onScreen: all.map((el) => el.getAttribute('data-testid')),
      buttons: Array.from(document.querySelectorAll('button[data-testid]'))
        .filter((b) => !b.disabled)
        .map((b) => b.getAttribute('data-testid')),
    };
  }

  // WHERE TO PUT THE LIMB, in the normalized video coordinates the landmarks are in.
  const pct = (v) => (typeof v === 'string' && v.endsWith('%') ? Number(v.slice(0, -1)) / 100 : null);
  let aim = null;
  if (num(pick, 'data-dwell-x') !== null && num(pick, 'data-dwell-y') !== null) {
    aim = { xs: [num(pick, 'data-dwell-x')], y: num(pick, 'data-dwell-y'), from: 'data-dwell-x/data-dwell-y' };
  } else if (pct(pick.style.left) !== null && pct(pick.style.top) !== null) {
    // Where the ring is DRAWN, read off the app's own placement. The preview is CSS-mirrored, and the
    // harness is not told which sense that is, so both are offered.
    const l = pct(pick.style.left);
    aim = { xs: [1 - l, l], y: pct(pick.style.top), from: 'the ring the patient can see, from its own drawn position' };
  } else {
    const frame = pick.closest('.camera-frame') ?? document.querySelector('.camera-frame');
    const f = frame?.getBoundingClientRect();
    const b = pick.getBoundingClientRect();
    if (f && f.width > 0) {
      const cx = (b.x + b.width / 2 - f.x) / f.width;
      const cy = (b.y + b.height / 2 - f.y) / f.height;
      aim = { xs: [1 - cx, cx], y: cy, from: 'the ring measured against the camera preview' };
    }
  }

  return {
    found: true,
    matchedBy,
    assumed,
    aim,
    progress: progressOf(pick),
    phase: pick.getAttribute('data-phase'),
    hasProgress: progressOf(pick) !== null,
  };
};

const readDwell = (page, ids) => page.evaluate(probeDwell, { ids });

/** Move the limb there over several frames — a patient does not teleport, and the app watches for it. */
async function glide(page, limb, x, y, steps = 6) {
  const from = await page.evaluate((l) => window.__hfBody.at(l), limb);
  if (!from) return;
  for (let i = 1; i <= steps; i++) {
    const k = i / steps;
    await page.evaluate(({ l, tx, ty }) => window.__hfBody.aim(l, tx, ty), {
      l: limb,
      tx: from.x + (x - from.x) * k,
      ty: from.y + (y - from.y) * k,
    });
    await wait(60);
  }
}

/**
 * Hold a limb on the dwell target until the app acts on it. No click, no tap, no key press.
 *
 * The limb is first parked well AWAY from the target: a knee at rest can already be sitting where the
 * ring is drawn, and a hold that starts from there is not a choice the patient made.
 */
async function dwellConfirm(page, { what, ids, settled, budgetMs = 30_000 }) {
  const probe = await readDwell(page, ids);
  if (!probe.found) {
    throw new NotBuiltYet(
      `no dwell target for "${what}". Nothing on this screen matches ${ids.map((i) => `[data-testid="${i}"]`).join(' or ')}, ` +
        `and there is no single unambiguous dwell target to fall back on (dwell targets on screen: ` +
        `${probe.onScreen.length ? probe.onScreen.join(', ') : 'none'}). The way on from here is ` +
        `${probe.buttons.join(', ')} — every one of them a button that needs a hand on it. Without a dwell target the ` +
        `patient cannot pass this screen without touching the tablet, which is what this harness exists to catch.`,
    );
  }
  if (probe.assumed) log(`  (assuming "${probe.matchedBy}" is the target that confirms ${what})`);
  if (!probe.aim) {
    throw new NotBuiltYet(
      `the dwell target for "${what}" ("${probe.matchedBy}") does not say WHERE it is. It publishes neither ` +
        `data-dwell-x/data-dwell-y (its centre in the normalized video coordinates the landmarks are in) nor an inline ` +
        `left/top placement inside .camera-frame, so a harness cannot aim a limb at it — only a mouse.`,
    );
  }

  const deadline = Date.now() + budgetMs;
  let best = 0;
  let usedX = null;
  // Leg mode parks a knee, hand mode a palm; the harness offers the pose landmark each mode follows.
  for (const limb of ['knee', 'wrist']) {
    for (const x of probe.aim.xs) {
      if (Date.now() > deadline) break;
      // Out of the target first, so the hold is an entry and not where the limb happened to be.
      await glide(page, limb, 0.5, 0.04, 4);
      await wait(400);
      if (await settled()) return { how: 'confirmed before the hold began', progress: best };
      await glide(page, limb, x, probe.aim.y, 6);

      // Hold. A dwell IS a hold: nothing moves again until the target says something.
      let holdUntil = Date.now() + 4500;
      let filling = false;
      while (Date.now() < holdUntil && Date.now() < deadline) {
        await wait(120);
        if (await settled()) {
          return {
            how: `held the ${limb} on the ring at ${x.toFixed(2)},${probe.aim.y.toFixed(2)} (${probe.aim.from}) until it filled`,
            progress: Math.max(best, 1),
          };
        }
        const p = await readDwell(page, ids);
        if (!p.found) break;
        if (p.progress !== null && p.progress > best) {
          best = p.progress;
          usedX = x;
        }
        // Filling: this is the right place to stand. Hold to the whole budget instead of moving on.
        if (p.progress !== null && p.progress > 0.02 && !filling) {
          filling = true;
          holdUntil = deadline;
        }
      }
    }
  }
  if (await settled()) return { how: 'the target confirmed', progress: best };
  const p = await readDwell(page, ids);
  throw new NotBuiltYet(
    `the dwell target for "${what}" never confirmed. It is on screen ("${probe.matchedBy}", phase "${p.phase ?? '?'}") and the ` +
      `harness held a limb on it${usedX !== null ? ` at x=${usedX.toFixed(2)}, y=${probe.aim.y.toFixed(2)}` : ''} for ` +
      `${Math.round(budgetMs / 1000)} s, but the ring only ever reached ${(best * 100).toFixed(0)}%` +
      `${p.found && !p.hasProgress ? ' (it publishes no data-progress, so the harness could not see it filling at all)' : ''}. ` +
      `Either the target does not take its pointer from the tracked body, or it is drawn somewhere other than where it ` +
      `is measured.`,
  );
}

// ---------------------------------------------------------------------------------------------

const screenOf = (page) => page.evaluate(() => window.__beatRehab.getState().screen);
const onScreen = (page, name) => screenOf(page).then((s) => s === name);

async function shoot(page, name) {
  const path = resolve(OUT, `${name}.png`);
  await page.screenshot({ path });
  shots.push(path);
  log('->', path);
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  let server = null;
  if (!urlArg) {
    log(`starting vite on :${PORT}`);
    const VITE_BIN = resolve(ROOT, 'node_modules/.bin/vite');
    server = spawn(VITE_BIN, ['--port', String(PORT), '--strictPort'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
      detached: true,
    });
    server.stdout.resume();
    server.stderr.on('data', (d) => process.stderr.write(`[vite] ${d}`));
    await waitForServer(BASE);
  }

  const browser = await chromium.launch({
    executablePath: EXECUTABLE,
    headless: !argv.includes('--headed'),
    args: [
      '--no-sandbox',
      '--use-gl=swiftshader',
      // A real camera the app can open, with no person in it. The patient is injected separately.
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
    ],
  });

  const failures = [];
  let taps = 0;
  let quieted = null;
  let ledger = { gestures: [], events: [] };
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.addInitScript(INPUT_LEDGER);
    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    // The dev server's missing favicon is the dev server, not the screen under test.
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      if (/favicon/i.test(m.text()) || /favicon/i.test(m.location()?.url ?? '')) return;
      errors.push(m.text());
    });
    await page.context().grantPermissions(['camera'], { origin: BASE });

    // Warm the dep optimizer so its reload cannot land mid-run (and so the last navigation of the
    // run happens before the input ledger starts counting for real).
    await page.goto(`${BASE}/`, { waitUntil: 'load' });
    await wait(1500);
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.__beatRehab, null, { timeout: 30_000 });

    // The therapist's part of the visit, done through the store: a patient in the chair and a
    // prescription. Not an input, and not what this harness claims anything about.
    await page.evaluate((lanes) => {
      const now = Date.now();
      window.__beatRehab.store.setState({
        patients: [{ id: 'p_hf', name: 'Hands-free patient', createdAt: now - 86_400_000, lastUsedAt: now }],
        activePatientId: 'p_hf',
      });
      const s = window.__beatRehab.store.getState();
      s.setInputMode('camera');
      s.setMode('leg');
      s.setLanes(lanes.map((l, i) => ({ index: i, movement: l.movement, side: l.side })));
      s.setDifficulty('easy');
      // The therapist's window scale, at its widest. The camera check GATES a device whose frames are
      // further apart than the widest hit window the prescription grants — a real and correct gate, and
      // on a headless container doing software inference at under 2 fps it fires every time. Widening
      // the windows is what a therapist does with a slow tablet, and it keeps the gate from standing in
      // for the gesture this harness is actually about.
      s.setWindowScale(4);
      s.updateSettings({ mirrored: false });
    }, LANES);

    // ---- THE ONE TAP -------------------------------------------------------------------------
    // On Home, before the patient is in position. This is the gesture the AudioContext needs.
    await page.getByTestId('start-session').click();
    taps += 1;
    await shoot(page, '01-home-the-one-tap');
    await page.waitForFunction(() => !!window.__beatRehab.runtime.peekAudio?.(), null, { timeout: 15_000 });
    record('the therapist taps Start on Home', 'the only real user input of the run; it is what lets AudioContext.resume() settle');

    // From here the patient is in position and nothing may be touched.
    await page.evaluate(() => window.__beatRehab.gotoScreen('camera'));
    await page.waitForFunction(() => window.__beatRehab.getState().screen === 'camera', null, { timeout: 10_000 });

    // ---- the patient appears in front of the camera -------------------------------------------
    await page.waitForFunction(() => !!window.__beatRehab.runtime.peekVision?.(), null, { timeout: 90_000 });
    // Watch for the FIRST real camera frame and decide there whether this machine can afford to keep
    // inferring (see quietCameraIfStarved). It is armed before anything else touches the page: every
    // second spent waiting here is another second of inference, and the decision has to be made while
    // the loop has produced exactly one frame.
    quieted = await quietCameraIfStarved(page);
    if (quieted) log('  ', quieted);
    await installBody(page);
    await page.waitForFunction(() => (window.__hfBody?.injected ?? 0) > 5, null, { timeout: 60_000 });
    // "Sees the patient" is asked of the screen, not of a private flag: the hands-free legend names
    // the limb its targets are following, and that sentence is the patient's only evidence that the
    // gesture is available to them at all.
    const seen = await page
      .waitForFunction(
        () => document.querySelector('[data-testid="camera-dwell-legend"]')?.getAttribute('data-state') === 'tracking',
        null,
        { timeout: 60_000 },
      )
      .then(() => true)
      .catch(() => false);
    const limb = await page
      .getByTestId('camera-dwell-legend-limb')
      .textContent()
      .catch(() => null);
    const vstatus = await page.evaluate(() => {
      const s = window.__beatRehab.runtime.peekVision()?.getStatus?.();
      return s ? { tracking: s.tracking, reason: s.reason, untracked: s.untrackedLanes.length } : null;
    });
    if (!seen) failures.push(`the camera check never reported a limb to hold on the target (VisionInput says ${JSON.stringify(vstatus)})`);
    record(
      'the camera check sees the patient',
      `the hands-free legend reads "${(limb ?? '(nothing)').trim()}" off the injected landmarks; VisionInput reason "${vstatus?.reason}", ${vstatus?.untracked} lane(s) untracked`,
    );

    // The device's own verdict has to clear before the gesture is even reachable. It is about the
    // camera, not the gesture, so a blocked gate is reported as a blocked DEVICE.
    const ungated = await page
      .waitForFunction(() => document.querySelector('[data-testid="camera-continue"]')?.disabled === false, null, { timeout: 40_000 })
      .then(() => true)
      .catch(() => false);
    if (!ungated) {
      const why = await page.evaluate(() => document.querySelector('[data-testid="camera-readiness-headline"]')?.textContent ?? '(no headline)');
      failures.push(`the camera check still gates the way forward on this DEVICE, before any gesture: ${why}`);
    }

    // ---- camera check -> ROM, hands free ------------------------------------------------------
    await shoot(page, '02-camera-check');
    const toRom = await dwellConfirm(page, {
      what: 'going on from the camera check',
      ids: ['camera-dwell-continue', 'dwell-camera-continue'],
      settled: () => onScreen(page, 'rom'),
    });
    await shoot(page, '03-camera-check-confirmed');
    record('camera check confirmed hands-free', `${toRom.how}; the app went to the ROM screen on its own`);

    // ---- ROM calibration, lane by lane --------------------------------------------------------
    const laneCount = LANES.length;
    for (let i = 0; i < laneCount; i++) {
      const side = LANES[i].side;
      // Back to rest, in the middle of the frame, and hold still until the screen stops saying so.
      await glide(page, 'knee', 0.5, 0.5, 4);
      await setLimb(page, { side, lift: 0, dx: 0, dy: 0 });
      // The screen's own eyebrow, which is what the patient is reading. (It is CSS-uppercased, so the
      // match is case-insensitive.)
      const asked = await page
        .waitForFunction(() => /now move/i.test(document.body.innerText), null, { timeout: 25_000 })
        .then(() => true)
        .catch(() => false);
      if (!asked) failures.push(`lane ${i + 1}: the rest hold never completed, so the screen never asked for the reps`);
      // Then repetitions until the screen has its three — a patient keeps going until it says stop,
      // and a fixed count is a guess about how many of them the calibrator will see.
      const repDeadline = Date.now() + 40_000;
      let reps = 0;
      let accepted = false;
      while (Date.now() < repDeadline) {
        accepted = await page.evaluate((lane) => window.__beatRehab.getState().calibrations[lane] !== null, i);
        if (accepted) break;
        await rep(page);
        reps += 1;
      }
      const badge = await page.getByTestId(`rom-lane-badge-${i}`).textContent().catch(() => '?');
      if (!accepted) {
        failures.push(`lane ${i + 1} (${side} seated march) never produced a range the runtime accepted (badge "${badge}")`);
      }
      await shoot(page, `04-rom-lane-${i + 1}`);
      record(
        `lane ${i + 1} (${side} seated march) calibrated`,
        `${reps} repetition(s) performed by the injected body; store.calibrations[${i}] ${accepted ? 'holds an accepted range' : 'is still null'}, lane badge "${badge}"`,
      );
      // "Moved on" means the LAST lane handed over to the latency screen, and any other lane handed
      // the ● (the screen's own marker for the lane being measured) to the next one down the list.
      const last = i + 1 >= laneCount;
      const settled = last
        ? () => onScreen(page, 'latency')
        : () =>
            page.evaluate(
              (lane) => document.querySelector(`[data-testid="rom-lane-badge-${lane}"]`)?.textContent?.trim() === '●',
              i + 1,
            );
      const confirm = await dwellConfirm(page, {
        what: last ? 'going on from the last lane to the latency check' : `going on from lane ${i + 1} to lane ${i + 2}`,
        ids: ['rom-dwell-next', 'dwell-rom-next'],
        settled,
      });
      record(`lane ${i + 1} accepted hands-free`, `${confirm.how}; the app moved on with no click`);
    }

    // ---- latency ------------------------------------------------------------------------------
    await shoot(page, '05-latency');
    const intoPlay = () => onScreen(page, 'play');
    let latencyHow = '';
    const started = await dwellConfirm(page, {
      what: 'starting the latency metronome',
      ids: ['latency-dwell-start', 'dwell-latency-start'],
      // The probe is running once the screen stops offering a target to start it.
      settled: () => page.evaluate(() => !document.querySelector('[data-testid="latency-dwell-start"]')),
    });
    latencyHow = `${started.how} to start the metronome; `;
    // Move on every click: eight beats at 60 BPM, made with the calibrated lane-1 movement.
    await setLimb(page, { side: LANES[0].side, dx: 0, dy: 0 });
    for (let b = 0; b < 10; b++) await rep(page);
    await wait(800);
    // Whichever way off the screen the measurement earned: the offset it measured, or carrying on
    // with the one in force. Both are the patient saying yes with the same gesture.
    const accepted = await dwellConfirm(page, {
      what: 'leaving the latency check for the song',
      ids: ['latency-dwell-accept', 'latency-dwell-carry-on', 'dwell-latency-accept'],
      settled: intoPlay,
      budgetMs: 45_000,
    });
    latencyHow += accepted.how;
    record('latency check passed hands-free', latencyHow);

    // ---- play ---------------------------------------------------------------------------------
    const playing = await page
      .waitForFunction(() => ['countdown', 'playing'].includes(window.__beatRehab.getScore?.()?.phase), null, { timeout: 180_000 })
      .then(() => true)
      .catch(() => false);
    await page.waitForFunction(() => window.__beatRehab.getScore?.()?.phase === 'playing', null, { timeout: 60_000 }).catch(() => {});
    await shoot(page, '06-play');
    const hud = await page.evaluate(() => window.__beatRehab.getScore?.() ?? null);
    if (!playing || hud?.phase !== 'playing') failures.push(`the session never reached a running Play screen (phase: ${hud?.phase ?? 'no runner'})`);
    record('the song is playing', `runner phase "${hud?.phase ?? 'none'}" on the Play screen, reached without a second input`);

    // ---- the claims ---------------------------------------------------------------------------
    const finalScreen = await screenOf(page);
    if (finalScreen !== 'play') failures.push(`ended on the "${finalScreen}" screen, not play`);

    const cal = await page.evaluate(() => {
      const st = window.__beatRehab.getState();
      const vision = window.__beatRehab.runtime.peekVision?.();
      return {
        lanes: st.lanes.length,
        calibrated: st.calibrations.map((c) => c !== null),
        refused: vision?.getInvalidCalibrations?.() ?? [],
        // The app's own record that it was driven by a body and not a finger.
        handsFree: st.handsFree,
      };
    });
    cal.calibrated.forEach((done, i) => {
      if (!done) failures.push(`lane ${i + 1} entered the song with no calibration`);
    });
    if (cal.refused.length) {
      for (const r of cal.refused) failures.push(`lane ${r.lane + 1}'s calibration was refused by the engine: ${r.reason}`);
    }
    if (cal.handsFree !== true) failures.push('the app never recorded that this session was driven hands-free (store.handsFree is false)');

    ledger = await page.evaluate(() => window.__handsfreeLedger);
    if (errors.length) failures.push(`page errors: ${errors.slice(0, 4).join(' | ')}`);
  } catch (err) {
    if (err instanceof NotBuiltYet) failures.push(`NOT BUILT YET: ${err.message}`);
    else failures.push(`threw: ${err?.stack ?? err}`);
    try {
      const pages = browser.contexts().flatMap((c) => c.pages());
      if (pages[0]) {
        ledger = await pages[0].evaluate(() => window.__handsfreeLedger ?? { gestures: [], events: [] }).catch(() => ledger);
        await pages[0].screenshot({ path: resolve(OUT, '99-where-it-stopped.png') });
        shots.push(resolve(OUT, '99-where-it-stopped.png'));
      }
    } catch {
      /* nothing to capture */
    }
  } finally {
    await browser.close();
    if (server) await stopServer(server);
  }

  // ---- the summary ----------------------------------------------------------------------------
  const gestures = ledger.gestures ?? [];
  console.log('');
  console.log('[handsfree] real user inputs performed:', gestures.length, `(budget: 1 — the audio gesture)`);
  for (const g of gestures) console.log(`  - ${g.type} on ${g.target} at ${Math.round(g.at)} ms`);
  if (gestures.length !== 1) {
    failures.push(`${gestures.length} real user input(s) reached the page; exactly 1 (the Home tap) is allowed`);
  }
  if (taps !== 1) failures.push(`the harness performed ${taps} taps of its own; exactly 1 is allowed`);
  console.log('');
  console.log('[handsfree] steps:');
  for (const s of steps) console.log(`  ${s.step}\n      confirmed by: ${s.how}`);
  console.log('');
  if (quieted) {
    console.log('[handsfree] what this run could not do for real:');
    console.log(`  - ${quieted}`);
    console.log('');
  }
  console.log('[handsfree] screenshots:');
  for (const s of shots) console.log(`  ${s}`);
  console.log('');

  if (failures.length) {
    console.error('[handsfree] FAILED');
    for (const f of failures) console.error('  -', f);
    process.exit(1);
  }
  console.log('[handsfree] PASSED — the patient got from the camera check into the song on one tap, made before they were in position.');
  process.exit(0);
}

main().catch((e) => {
  console.error('[handsfree] crashed', e);
  process.exit(1);
});
