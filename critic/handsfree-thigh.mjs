/**
 * THE HAND ON THE THIGH: the third round's defect, driven in the running app, and refused.
 *
 *   node critic/handsfree-thigh.mjs [--url http://localhost:5781] [--headed]
 *
 * WHAT THIS IS FOR. Rounds one and two of this feature removed the knee as a dwell pointer on the
 * premise that "the leg prescription does not move the hands". It does, whenever the hand is resting
 * on the thigh: hip flexion rotates the thigh about the hip, so a hand at fraction f along the
 * hip->knee segment rises by f x the knee's travel, and hip circumduction — the compensation this app
 * promises never to penalise — swings it sideways at the same time. Driven through the shipping
 * classes, that carried hand confirmed the PRIMARY circle at t = 3.23 s and the SECONDARY at 3.30 s,
 * on the first repetition, at every frame rate and in every frame aspect. On the pause dialog the
 * secondary circle is `id: 'end'` -> quit -> a truncated RunSummary in the patient's record. Not
 * undoable.
 *
 * The fix has two halves and this harness drives both:
 *   - THE INSTRUCTION. `POSTURE_INFO.seated_leg` now asks for a support the leg cannot move — a chair
 *     arm, an armrest, a table — and says why the thigh is not one.
 *   - THE MEASUREMENT, because an instruction is not evidence that it was followed. `DwellCoupling`
 *     fits each candidate pointer's frame-to-frame travel onto the travel of the segments the
 *     prescription moves — knee, ankle and foot, hip-relative, one coefficient across both axes — over
 *     a rolling readiness window. A limb the exercise is carrying is not followed while any other limb
 *     is in the picture, and when it is the only limb there is, the rings stand down and say so.
 *
 * WHAT IS DRIVEN, in three parts:
 *   A. THE SWEEP, in the page, against the shipping modules imported from the dev server — the same
 *      classes `useDwellTargets` runs, at its own 80 ms survey cadence: f = 0.7 / 0.85 / 1.0, left and
 *      right, circumduction 0.5 and 1.0, 12 / 15 / 24 / 30 fps, 4:3 / 16:9 / 1:1, mirrored and not,
 *      with and without a second hand to fall back on. The critic's own 2 / 2.5 / 2 / 10 s duty cycle.
 *      ZERO confirms is the claim; the failure was NON-MONOTONIC in f and in the frame rate, so this
 *      sweeps rather than spot-checks.
 *   B. THE SAME ATTACK END TO END on the camera check, where a confirm skips a screen: a thigh-resting
 *      hand, a marching leg, and the app is required to stay where it is and to say why.
 *   C. THE CONTROL. The same body with its hands on the CHAIR ARMS raises one to the ring and holds:
 *      the app must confirm. A refusal that refuses everything is not a fix, it is the end of the
 *      hands-free path.
 * And it takes the screenshots the size claim is read off (1024x768 and 1280x800, plus a 1/5-scale
 * raster via deviceScaleFactor, which is where two rings that differ only in diameter stop being
 * tellable apart).
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const OUT = resolve(HERE, 'handsfree-thigh');
// The pre-installed Chromium: the path is the binary itself (a symlink), not a browser directory —
// the other harnesses use the same one.
const EXECUTABLE = process.env.PW_CHROMIUM ?? '/opt/pw-browsers/chromium';
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const PORT = Number(process.env.THIGH_PORT ?? 5781);
const urlArg = arg('--url', null);
const BASE = urlArg ?? `http://localhost:${PORT}`;
const log = (...m) => console.log('[thigh]', ...m);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const shots = [];
const failures = [];
const notes = [];

async function waitForServer(base) {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(base, { method: 'GET' });
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await wait(500);
  }
  throw new Error(`dev server never came up at ${base}`);
}

async function shoot(page, name) {
  const path = resolve(OUT, `${name}.png`);
  await page.screenshot({ path });
  shots.push(path);
  log('->', path);
}

/**
 * Just the preview, which is where the rings are — and the only picture in which their size can be
 * judged against each other rather than against the whole screen. At `deviceScaleFactor` 0.2 the
 * LAYOUT is unchanged (CSS pixels are the same) and only the raster is a fifth, which is what a
 * reviewer sees in a thumbnail and roughly what a patient sees from across a room.
 */
async function shootPreview(page, name) {
  const box = page.locator('.camera-frame').first();
  const path = resolve(OUT, `${name}.png`);
  await box.screenshot({ path }).catch(() => null);
  shots.push(path);
  log('->', path);
}

/* ---------------- A. the sweep, in the page, against the shipping classes ---------------- */

/**
 * Everything below runs IN THE BROWSER against the modules the dev server serves, so what is swept is
 * the code that ships rather than a copy of it: `DwellHabitat`, `DwellCoupling`, `DwellEngagement`,
 * `DwellLayout`, `DwellTracker`, `dwellLimbs`, `dwellReferences`, `pickDwellLimb` and the screens' own
 * `pairedDwellTargets` / `dwellCircleFits`, wired exactly as `useDwellTargets` wires them — including
 * its 80 ms survey cadence, which is a variable the frame rate interacts with.
 */
const SWEEP = async ({ seconds }) => {
  const dwell = await import('/src/vision/dwell.ts');
  const fx = await import('/src/vision/fixtures.ts');
  const ui = await import('/src/ui/DwellTarget.tsx');
  const {
    DWELL_CLEAR_EXTRA,
    DWELL_DEFAULTS,
    DwellCoupling,
    DwellEngagement,
    DwellHabitat,
    DwellLayout,
    DwellTracker,
    dwellAxisFor,
    dwellLimbs,
    dwellOrigin,
    dwellReferences,
    pickDwellLimb,
  } = dwell;
  const CRITIC = { riseSec: 2, holdSec: 2.5, fallSec: 2, restSec: 10 };
  const amountAt = (t) => {
    const span = CRITIC.riseSec + CRITIC.holdSec + CRITIC.fallSec;
    const cycle = ((t % (span + CRITIC.restSec)) + span + CRITIC.restSec) % (span + CRITIC.restSec);
    if (cycle < CRITIC.riseSec) return 0.5 * (1 - Math.cos(Math.PI * (cycle / CRITIC.riseSec)));
    if (cycle < CRITIC.riseSec + CRITIC.holdSec) return 1;
    const fall = cycle - CRITIC.riseSec - CRITIC.holdSec;
    return fall >= CRITIC.fallSec ? 0 : 0.5 * (1 + Math.cos(Math.PI * (fall / CRITIC.fallSec)));
  };

  function run(c) {
    const aspect = c.aspect;
    const authored = ui.pairedDwellTargets('leg');
    const ids = ['go', 'back'];
    const habitat = new DwellHabitat();
    const coupling = new DwellCoupling();
    const engagement = new DwellEngagement();
    const opts = {
      xScale: aspect,
      axis: dwellAxisFor('leg'),
      exitRatio: DWELL_DEFAULTS.exitRatio,
      extra: DWELL_CLEAR_EXTRA,
      fits: (circle) => ui.dwellCircleFits(circle, aspect),
    };
    const layout = new DwellLayout(authored.map((circle, i) => ({ id: ids[i], authored: circle })), opts);
    const trackers = new Map(ids.map((id) => [id, new DwellTracker(layout.circleFor(id), { xScale: aspect })]));
    const lanes = [{ index: 0, movement: 'seated_march', side: c.side }];
    let previous = null;
    let previousKey = null;
    let lastSurvey = -Infinity;
    let occupied = new Map();
    let confirms = 0;
    let firstConfirm = Infinity;
    let refused = 0;
    let stoodDown = 0;
    let tracked = 0;
    let frames = 0;
    let maxProgress = 0;
    let why = null;
    for (let i = 0; i <= Math.round(seconds * c.fps); i++) {
      const t = i / c.fps;
      const amount = amountAt(t);
      const built = fx.seatedPose({
        side: c.side,
        kneeLift: amount,
        abduction: c.circ * amount,
        hands: 'thighs',
        handThighFraction: c.f,
        hideHand: c.only ? (c.side === 'left' ? 'right' : 'left') : undefined,
      });
      const posed = c.mirror ? fx.mirrorPoseLandmarks(built) : built;
      const detection = { tMs: t * 1000, pose: fx.reNormalizeAspect(posed, 4 / 3, aspect), hands: [] };
      const limbs = dwellLimbs(detection, 'leg', c.mirror, aspect);
      const references = dwellReferences(detection, 'leg', { lanes, mirrored: c.mirror, xScale: aspect });
      let busy = false;
      for (const tr of trackers.values()) {
        const st = tr.state;
        if (st.progress > 0 || st.blocked === 'refractory') busy = true;
      }
      const origin = dwellOrigin(detection);
      for (const l of limbs) coupling.noteOne(l.key, l.point, references, t, aspect, origin);
      if (busy) engagement.noteAnswering(t);
      const carried = coupling.coupledKeys(t);
      // Per limb, as the hook does it: a limb the exercise is carrying is not living anywhere, and a
      // limb inside a drawn ring is the entry gate's business (`DwellEngagement`).
      for (const l of limbs) {
        if (carried.has(l.key)) continue;
        if (engagement.gesture(l.key, l.point, layout.circles(), t, aspect, DWELL_DEFAULTS.exitRatio)) continue;
        habitat.noteOne(l.key, l.point, t, l.scale ?? null);
      }
      const summaries = habitat.all(t, aspect);
      if (t - lastSurvey >= 0.08 - 1e-9) {
        lastSurvey = t;
        const survey = layout.survey(summaries, t, busy);
        occupied = survey.occupied;
        if (survey.moved) for (const [id, tr] of trackers) tr.setTarget(layout.circleFor(id), aspect);
      }
      for (const [id, tr] of trackers) tr.setOccupied(occupied.get(id) === true);
      if (carried.size > 0) {
        refused += 1;
        for (const key of carried) {
          const v = coupling.verdict(key, t);
          if (v) why = `${key} follows ${v.reference} (r2 ${v.r2.toFixed(2)}, ${v.explained.toFixed(3)} explained)`;
        }
      }
      const limb = pickDwellLimb(limbs, layout.circles(), { xScale: aspect, previous, previousKey, avoid: carried });
      for (const tr of trackers.values()) tr.setCoupled(limb ? carried.has(limb.key) : false);
      previous = limb?.point ?? null;
      previousKey = limb?.key ?? null;
      frames += 1;
      if (limb) tracked += 1;
      for (const tr of trackers.values()) {
        const st = tr.update(limb?.point ?? null, t, limb?.key ?? null);
        if (st.confirmed) {
          confirms += 1;
          firstConfirm = Math.min(firstConfirm, t);
        }
        if (st.blocked === 'coupled') stoodDown += 1;
        maxProgress = Math.max(maxProgress, st.progress);
      }
    }
    return { confirms, firstConfirm, refused, stoodDown, tracked, frames, maxProgress, why };
  }

  const cases = [];
  for (const aspect of [4 / 3, 16 / 9, 1]) {
    for (const side of ['left', 'right']) {
      for (const f of [0.7, 0.85, 1]) {
        for (const circ of [0.5, 1]) {
          for (const fps of [12, 15, 24, 30]) {
            for (const mirror of [false, true]) {
              for (const only of [false, true]) cases.push({ aspect, side, f, circ, fps, mirror, only });
            }
          }
        }
      }
    }
  }
  const bad = [];
  let refusedEverywhere = 0;
  let stoodDownWhenAlone = 0;
  let alone = 0;
  let untracked = 0;
  for (const c of cases) {
    const r = run(c);
    const where = `${c.side} march, circ ${c.circ}, f=${c.f}, ${c.fps} fps, @${c.aspect.toFixed(2)}${c.mirror ? ', mirrored' : ''}${c.only ? ', that hand only' : ''}`;
    if (r.tracked < r.frames * 0.9) untracked += 1;
    if (r.confirms > 0) bad.push(`${where}: ${r.confirms} confirm(s) from t=${r.firstConfirm.toFixed(2)} s, ring reached ${(r.maxProgress * 100).toFixed(0)}%`);
    if (r.refused > 0) refusedEverywhere += 1;
    if (c.only) {
      alone += 1;
      if (r.stoodDown > 0) stoodDownWhenAlone += 1;
    }
  }
  return { runs: cases.length, bad, refusedEverywhere, stoodDownWhenAlone, alone, untracked, sample: run(cases[0]).why };
};

/** The same sweep with the coupling gate taken out: the negative control. */
const CONTROL = async () => {
  const dwell = await import('/src/vision/dwell.ts');
  const fx = await import('/src/vision/fixtures.ts');
  const ui = await import('/src/ui/DwellTarget.tsx');
  const { DWELL_CLEAR_EXTRA, DWELL_DEFAULTS, DwellEngagement, DwellHabitat, DwellLayout, DwellTracker, dwellAxisFor, dwellLimbs, pickDwellLimb } = dwell;
  const amountAt = (t) => {
    const cycle = ((t % 16.5) + 16.5) % 16.5;
    if (cycle < 2) return 0.5 * (1 - Math.cos(Math.PI * (cycle / 2)));
    if (cycle < 4.5) return 1;
    const fall = cycle - 4.5;
    return fall >= 2 ? 0 : 0.5 * (1 + Math.cos(Math.PI * (fall / 2)));
  };
  const aspect = 4 / 3;
  const authored = ui.pairedDwellTargets('leg');
  const habitat = new DwellHabitat();
  const engagement = new DwellEngagement();
  const opts = { xScale: aspect, axis: dwellAxisFor('leg'), exitRatio: DWELL_DEFAULTS.exitRatio, extra: DWELL_CLEAR_EXTRA, fits: (c) => ui.dwellCircleFits(c, aspect) };
  const layout = new DwellLayout(authored.map((c, i) => ({ id: `t${i}`, authored: c })), opts);
  const trackers = new Map(['t0', 't1'].map((id) => [id, new DwellTracker(layout.circleFor(id), { xScale: aspect })]));
  let previous = null;
  let previousKey = null;
  let lastSurvey = -Infinity;
  let occupied = new Map();
  let confirms = 0;
  let firstConfirm = Infinity;
  for (let i = 0; i <= 20 * 30; i++) {
    const t = i / 30;
    const amount = amountAt(t);
    const detection = {
      tMs: t * 1000,
      pose: fx.seatedPose({ side: 'left', kneeLift: amount, abduction: amount, hands: 'thighs', handThighFraction: 1 }),
      hands: [],
    };
    const limbs = dwellLimbs(detection, 'leg', false, aspect);
    let busy = false;
    for (const tr of trackers.values()) {
      const st = tr.state;
      if (st.progress > 0 || st.blocked === 'refractory') busy = true;
    }
    if (busy) engagement.noteAnswering(t);
    if (!busy) {
      for (const l of limbs) {
        if (engagement.gesture(l.key, l.point, layout.circles(), t, aspect, DWELL_DEFAULTS.exitRatio)) continue;
        habitat.noteOne(l.key, l.point, t, l.scale ?? null);
      }
    }
    const summaries = habitat.all(t, aspect);
    if (t - lastSurvey >= 0.08 - 1e-9) {
      lastSurvey = t;
      const survey = layout.survey(summaries, t, busy);
      occupied = survey.occupied;
      if (survey.moved) for (const [id, tr] of trackers) tr.setTarget(layout.circleFor(id), aspect);
    }
    for (const [id, tr] of trackers) tr.setOccupied(occupied.get(id) === true);
    // NO `avoid`, NO `setCoupled`: the app as it was before this round.
    const limb = pickDwellLimb(limbs, layout.circles(), { xScale: aspect, previous, previousKey });
    previous = limb?.point ?? null;
    previousKey = limb?.key ?? null;
    for (const tr of trackers.values()) {
      const st = tr.update(limb?.point ?? null, t, limb?.key ?? null);
      if (st.confirmed) {
        confirms += 1;
        firstConfirm = Math.min(firstConfirm, t);
      }
    }
  }
  return { confirms, firstConfirm };
};

/* ---------------- the body in front of the real camera ---------------- */

async function installBody(page) {
  const ok = await page.evaluate(async () => {
    const api = window.__beatRehab;
    if (!api) return 'no window.__beatRehab';
    const fx = await import('/src/vision/fixtures.ts');
    const lm = await import('/src/vision/landmarks.ts');
    const body = {
      side: 'left',
      /** 'thighs' = the attack; 'chair_arms' = the support the app asks for. */
      support: 'thighs',
      f: 1,
      circ: 1,
      /** One hand out of the picture, so the carried hand is the only pointer there is. */
      only: false,
      /** The rep profile's phase clock, driven by the harness. */
      amount: 0,
      hand: null,
      handSide: 'left',
      injected: 0,
      pose: () =>
        fx.seatedPose({
          side: body.side,
          kneeLift: body.amount,
          abduction: body.circ * body.amount,
          hands: body.support,
          handThighFraction: body.f,
          hideHand: body.only ? (body.side === 'left' ? 'right' : 'left') : undefined,
          handAt: body.hand ?? undefined,
        }),
      /** Where a wrist actually is, read off the pose — never off the rest table. */
      wristAt: (side) => {
        const p = body.pose()[side === 'left' ? lm.POSE.LEFT_WRIST : lm.POSE.RIGHT_WRIST];
        return { x: p.x, y: p.y };
      },
      aimHand: (side, x, y) => {
        body.handSide = side;
        body.hand = { side, x, y };
      },
      release: () => {
        body.hand = null;
      },
      tick: () => {
        const vision = api.runtime.peekVision?.();
        const ctx = api.runtime.peekAudio?.()?.ctx;
        if (!vision || !ctx) return;
        try {
          vision.processDetection({ tMs: performance.now(), pose: body.pose(), hands: [] }, ctx.currentTime);
          body.injected++;
        } catch (e) {
          body.lastError = String(e);
        }
      },
    };
    body.timer = setInterval(body.tick, 22);
    window.__thighBody = body;
    return 'ok';
  });
  if (ok !== 'ok') throw new Error(`could not put a patient in front of the camera: ${ok}`);
}

/** Drive the critic's duty cycle for `seconds`, from the harness's clock. */
async function march(page, seconds) {
  const t0 = Date.now();
  while (Date.now() - t0 < seconds * 1000) {
    const t = (Date.now() - t0) / 1000;
    const cycle = t % 16.5;
    const amount =
      cycle < 2
        ? 0.5 * (1 - Math.cos(Math.PI * (cycle / 2)))
        : cycle < 4.5
          ? 1
          : cycle < 6.5
            ? 0.5 * (1 + Math.cos(Math.PI * ((cycle - 4.5) / 2)))
            : 0;
    await page.evaluate((a) => {
      window.__thighBody.amount = a;
    }, amount);
    await wait(60);
  }
}

const dwellState = (page, id) =>
  page.evaluate((testid) => {
    const el = document.querySelector(`[data-testid="${testid}"]`);
    const legend = document.querySelector('[data-testid="camera-dwell-legend"]');
    return {
      found: !!el,
      phase: el?.getAttribute('data-phase') ?? null,
      block: el?.getAttribute('data-dwell-block') ?? null,
      progress: Number(el?.getAttribute('data-progress') ?? 0),
      x: Number(el?.getAttribute('data-dwell-x') ?? NaN),
      y: Number(el?.getAttribute('data-dwell-y') ?? NaN),
      legendState: legend?.getAttribute('data-state') ?? null,
      coupled: legend?.getAttribute('data-coupled') ?? '',
      rooms: legend?.getAttribute('data-rooms') ?? '',
      carried: document.querySelector('[data-testid="camera-dwell-legend-carried"]')?.textContent ?? null,
      limb: document.querySelector('[data-testid="camera-dwell-legend-limb"]')?.textContent ?? null,
      screen: window.__beatRehab.getState().screen,
    };
  }, id);

async function toCameraCheck(page) {
  await page.goto(`${BASE}/`, { waitUntil: 'load' });
  await wait(1200);
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__beatRehab, null, { timeout: 30_000 });
  await page.evaluate(() => {
    const now = Date.now();
    window.__beatRehab.store.setState({
      patients: [{ id: 'p_thigh', name: 'Thigh-rest patient', createdAt: now - 86_400_000, lastUsedAt: now }],
      activePatientId: 'p_thigh',
    });
    const s = window.__beatRehab.store.getState();
    s.setInputMode('camera');
    s.setMode('leg');
    s.setLanes([
      { index: 0, movement: 'seated_march', side: 'left' },
      { index: 1, movement: 'seated_march', side: 'right' },
    ]);
    s.setDifficulty('easy');
    s.setWindowScale(4);
    s.updateSettings({ mirrored: false });
  });
  await page.getByTestId('start-session').click();
  await page.waitForFunction(() => !!window.__beatRehab.runtime.peekAudio?.(), null, { timeout: 20_000 });
  await page.evaluate(() => window.__beatRehab.gotoScreen('camera'));
  await page.waitForFunction(() => window.__beatRehab.getState().screen === 'camera', null, { timeout: 15_000 });
  await page.waitForFunction(() => !!window.__beatRehab.runtime.peekVision?.(), null, { timeout: 90_000 });
  /**
   * The container's own inference costs SECONDS a frame and starves every timer on the page, so the
   * real detect loop is stopped after its first frame and the injected patient becomes the only frame
   * source — exactly as critic/handsfree.mjs does it, and for the same reason. The camera really is
   * opened and really measured; what is switched off is repeated inference on a webcam with nobody in
   * it. On a machine with a GPU this does nothing and the loop keeps running.
   */
  const stopped = await page.evaluate(
    () =>
      new Promise((done) => {
        const t0 = performance.now();
        const id = setInterval(() => {
          const vision = window.__beatRehab.runtime.peekVision?.();
          const stats = vision?.getStats?.();
          if (stats && stats.frames >= 1) {
            clearInterval(id);
            if (stats.inferenceMs < 120) return done(null);
            if (!vision.loop || typeof vision.loop.stop !== 'function') return done('the detect loop could not be reached to quiet it');
            vision.loop.stop();
            return done(`one camera frame costs ${stats.inferenceMs.toFixed(0)} ms here, so the real detect loop was stopped after ${vision.getStats().frames} frame(s) and the injected patient is the only frame source`);
          }
          if (performance.now() - t0 > 120_000) {
            clearInterval(id);
            done('the camera never produced a frame to measure this machine with');
          }
        }, 10);
      }),
  );
  if (stopped) notes.push(stopped);
  await installBody(page);
  await page.waitForFunction(() => (window.__thighBody?.injected ?? 0) > 5, null, { timeout: 60_000 });
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  let server = null;
  if (!urlArg) {
    log(`starting vite on :${PORT}`);
    server = spawn(resolve(ROOT, 'node_modules/.bin/vite'), ['--port', String(PORT), '--strictPort'], {
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
    args: ['--no-sandbox', '--use-gl=swiftshader', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
    await page.context().grantPermissions(['camera'], { origin: BASE });
    page.on('pageerror', (e) => failures.push(`pageerror: ${e.message}`));

    // ---- A. the sweep, against the shipping modules -----------------------------------------
    await page.goto(`${BASE}/`, { waitUntil: 'load' });
    await page.waitForFunction(() => !!window.__beatRehab, null, { timeout: 30_000 });
    log('sweeping the thigh-carried body against the shipping classes…');
    const sweep = await page.evaluate(SWEEP, { seconds: 20 });
    log(
      `sweep: ${sweep.runs} cases, ${sweep.bad.length} confirmed, the gate refused a limb in ` +
        `${sweep.refusedEverywhere}/${sweep.runs}, stood a ring down in ${sweep.stoodDownWhenAlone}/${sweep.alone} ` +
        `one-handed cases; example verdict: ${sweep.sample}`,
    );
    if (sweep.bad.length > 0) failures.push(`the thigh-carried hand CONFIRMED in ${sweep.bad.length} of ${sweep.runs} cases:\n    ${sweep.bad.slice(0, 12).join('\n    ')}`);
    if (sweep.untracked > 0) failures.push(`${sweep.untracked} sweep cases had nothing tracked — those cases prove nothing`);
    if (sweep.refusedEverywhere < sweep.runs) failures.push(`the coupling gate never fired in ${sweep.runs - sweep.refusedEverywhere} cases: something else is holding those up`);
    if (sweep.stoodDownWhenAlone < sweep.alone) failures.push(`${sweep.alone - sweep.stoodDownWhenAlone} one-handed cases never stood the ring down, so the patient was not told`);

    const control = await page.evaluate(CONTROL);
    log(`control (coupling gate removed): ${control.confirms} confirm(s), first at t=${control.firstConfirm.toFixed(2)} s`);
    if (control.confirms === 0) {
      failures.push(
        'THE CONTROL DID NOT CONFIRM: with the coupling gate taken out, the thigh-carried hand must still fill the ring — ' +
          'otherwise the sweep above is not evidence about the gate and something else is holding it up.',
      );
    }
    notes.push(`with the gate removed the same body confirms at t=${control.firstConfirm.toFixed(2)} s, which is what the sweep is measured against`);

    // ---- B. the attack, end to end on the camera check ---------------------------------------
    await toCameraCheck(page);
    await page.evaluate(() => {
      Object.assign(window.__thighBody, { support: 'thighs', f: 1, circ: 1, only: false, side: 'left' });
    });
    await march(page, 26);
    const attacked = await dwellState(page, 'camera-dwell-continue');
    log(`camera check after 26 s of a thigh-carried march: ${JSON.stringify(attacked)}`);
    await shoot(page, '01-camera-check-thigh-refused-1024');
    if (attacked.screen !== 'camera') failures.push(`the thigh-carried march LEFT THE CAMERA CHECK (now on "${attacked.screen}") — the exercise answered for the patient`);
    if (attacked.progress > 0.5) failures.push(`the ring filled to ${(attacked.progress * 100).toFixed(0)}% under a carried hand`);
    /**
     * HOW THE REFUSAL SHOWS UP WITH TWO HANDS IN THE PICTURE: the pick moves to the hand the exercise
     * is NOT carrying, which is the better outcome — the patient keeps a way through. So either the
     * verdict is published (the carried hand is the one being followed, and the ring says so) or the
     * app is following the other hand. What may never happen is the carried hand answering.
     */
    const followingOther = /right hand/i.test(attacked.limb ?? '');
    if (!attacked.coupled && !followingOther) {
      failures.push(
        `the app neither measured the carried hand nor moved to the other one (following "${attacked.limb}", coupled ` +
          `"${attacked.coupled}"), so the refusal — if any — is luck`,
      );
    }
    notes.push(
      attacked.coupled
        ? `two-handed attack: the carried hand was refused and the ring said so (${attacked.coupled})`
        : `two-handed attack: the app passed the carried left hand over and followed "${attacked.limb?.trim()}" instead`,
    );

    // …and with that hand the ONLY one in the picture, the rings must stand down and say why.
    await page.evaluate(() => {
      Object.assign(window.__thighBody, { only: true });
    });
    await march(page, 22);
    const alone = await dwellState(page, 'camera-dwell-continue');
    log(`one-handed, thigh-carried: ${JSON.stringify(alone)}`);
    await shoot(page, '02-camera-check-one-hand-carried-1024');
    if (alone.screen !== 'camera') failures.push(`one-handed thigh-carried march LEFT THE CAMERA CHECK (now "${alone.screen}")`);
    if (alone.block !== 'coupled') {
      failures.push(`with the carried hand the only pointer, the ring reports "${alone.block ?? 'nothing'}" instead of standing down as coupled`);
    }
    if (!/moving with your exercise/i.test(alone.carried ?? '')) {
      failures.push(`the legend does not tell the patient their hand is being carried (it reads "${(alone.carried ?? '(nothing)').slice(0, 120)}")`);
    } else if (!/arm of the chair|armrest|table/i.test(alone.carried ?? '')) {
      failures.push('the legend names the fault but not the remedy (a support the leg does not move)');
    }

    // ---- C. the control: the same patient, hands on the chair arms, CAN confirm ---------------
    await page.evaluate(() => {
      Object.assign(window.__thighBody, { support: 'chair_arms', only: false });
      window.__thighBody.amount = 0;
    });
    await wait(3000);
    const ring = await dwellState(page, 'camera-dwell-continue');
    log(`chair-arm control, ring at ${ring.x?.toFixed(3)},${ring.y?.toFixed(3)} phase ${ring.phase} rooms ${ring.rooms}`);
    // Raise the hand to the ring and hold it there while the leg goes on working.
    const held = await (async () => {
      const deadline = Date.now() + 40_000;
      let best = 0;
      while (Date.now() < deadline) {
        const now = await dwellState(page, 'camera-dwell-continue');
        if (now.screen !== 'camera') return { confirmed: true, best: 1 };
        if (!Number.isFinite(now.x)) break;
        best = Math.max(best, now.progress);
        await page.evaluate(({ x, y }) => window.__thighBody.aimHand('left', x, y), { x: now.x, y: now.y });
        await wait(150);
      }
      return { confirmed: false, best };
    })();
    log(`chair-arm hold: ${held.confirmed ? 'confirmed' : `never confirmed, best ${(held.best * 100).toFixed(0)}%`}`);
    if (!held.confirmed) {
      const why = await dwellState(page, 'camera-dwell-continue');
      failures.push(
        `THE CONTROL FAILED: a hand resting on the chair arm — the support the app asks for — raised to the ring and held ` +
          `there never confirmed (best ${(held.best * 100).toFixed(0)}%, phase ${why.phase}, blocked ${why.block ?? 'nothing'}, ` +
          `rooms ${why.rooms}). A refusal that refuses the supported gesture is not a fix.`,
      );
    }

    // ---- the pictures the size claim is read off ---------------------------------------------
    await page.evaluate(() => {
      Object.assign(window.__thighBody, { support: 'chair_arms', only: false });
      window.__thighBody.release();
      window.__thighBody.amount = 0;
    });
    await page.evaluate(() => window.__beatRehab.gotoScreen('camera')).catch(() => {});
    await wait(2500);
    await shoot(page, '03-rings-1024x768');
    await shootPreview(page, '06-preview-1024x768');
    const wide = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await wide.context().grantPermissions(['camera'], { origin: BASE });
    await wide.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await wide.waitForFunction(() => !!window.__beatRehab, null, { timeout: 30_000 });
    await wide.evaluate(() => {
      const s = window.__beatRehab.store.getState();
      s.setInputMode('camera');
      s.setMode('leg');
      s.updateSettings({ mirrored: false });
    });
    await wide.getByTestId('start-session').click().catch(() => {});
    await wide.evaluate(() => window.__beatRehab.gotoScreen('camera'));
    await wait(3000);
    await shoot(wide, '04-rings-1280x800');
    // …and at a fifth of the raster, which is where two rings that differ only in diameter stop being
    // tellable apart. The LAYOUT is unchanged (CSS pixels are the same); only the pixels are fewer.
    const small = await browser.newPage({ viewport: { width: 1024, height: 768 }, deviceScaleFactor: 0.2 });
    await small.context().grantPermissions(['camera'], { origin: BASE });
    await small.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await small.waitForFunction(() => !!window.__beatRehab, null, { timeout: 30_000 });
    await small.evaluate(() => {
      const s = window.__beatRehab.store.getState();
      s.setInputMode('camera');
      s.setMode('leg');
      s.updateSettings({ mirrored: false });
    });
    await small.getByTestId('start-session').click().catch(() => {});
    await small.evaluate(() => window.__beatRehab.gotoScreen('camera'));
    await wait(3000);
    await shoot(small, '05-rings-1024x768-at-one-fifth');
    await shootPreview(small, '07-preview-at-one-fifth');
  } catch (e) {
    failures.push(`threw: ${e.message}`);
  } finally {
    await browser.close().catch(() => {});
    if (server) {
      try {
        process.kill(-server.pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
    }
  }

  if (notes.length) {
    console.log('[thigh] notes:');
    for (const n of notes) console.log('  -', n);
  }
  console.log('[thigh] screenshots:');
  for (const s of shots) console.log('  ', s);
  if (failures.length) {
    console.error('[thigh] FAILED');
    for (const f of failures) console.error('  -', f);
    process.exitCode = 1;
    return;
  }
  console.log('[thigh] PASSED — a hand the exercise is carrying cannot answer, and a hand on furniture still can.');
}

main().catch((e) => {
  console.error('[thigh] crashed', e);
  process.exitCode = 1;
});
