/**
 * EVERY DEAD END A PATIENT ALONE COULD BE LEFT IN, DRIVEN AND MEASURED.
 *
 *   node critic/handsfree-dead-ends.mjs
 *
 * `critic/handsfree.mjs` proves the happy path: a patient gets from the camera check into the song
 * with one tap, made before they were in position. It deliberately does NOT exercise the device
 * readiness gate (it widens the timing windows so the gate cannot fire), which is exactly where the
 * feature was found to fail. This harness is the other half: it FORCES the states a patient alone can
 * be trapped in and proves each of them now has a hands-free way FORWARD and a hands-free way BACK,
 * with the controls measured above the fold at 1024x768.
 *
 *   1. THE BLOCKED CAMERA CHECK. The container's own inference cost (seconds per frame) closes the
 *      readiness gate for real — no mocking. Asserts: the therapist's gate still closes; both dwell
 *      targets are alive (not the structurally-dead `enabled:false` ring, whose progress is pinned at
 *      0 and which no amount of holding can fill); both are inside the viewport along with the
 *      sentence saying what going on anyway costs; the RESTART is confirmed by holding a limb; and
 *      the GO ON ANYWAY is confirmed by holding a limb and lands on the ROM screen.
 *   2. ROM, IN THE STATE A CONFIRM LANDS IN. Asserts the back circle is alive during the rest hold
 *      (where there is nothing measured and the forward circle is correctly dead), that it says
 *      "Camera check" on the first lane and "Back a movement" on a later one, and that an advance
 *      made hands-free can be UNDONE hands-free.
 *   3a. STOPPING THE SONG MID-PLAY WITH NOTHING BUT A LIMB. The patient stops moving; the rest offer
 *      appears in the strip the board gives up for it; holding its circle pauses the song (never ends
 *      it), and a second hold carries on. Asserts the offer and its ring are on screen, that the ring
 *      is big enough to aim at from a metre (it was ~11 px of radius in the old 129x97 reserved panel,
 *      about 0.4° against a 1.5° floor), and that no part of the board is behind the panel — the two
 *      halves that used to be traded against each other.
 *   3. THE SONG STOPPING ITSELF. Hides the page (the lifecycle event, not an input), asserts the run
 *      pauses itself and that the dialog carries a live pair of targets on screen, then RESUMES the
 *      song by holding a limb.
 *   3c. ENDING THE SESSION, WHICH IS THE ONE DESTRUCTIVE SELECT ON THE SCREEN. Asserts that one hold
 *      only ASKS, that the second hold only starts a countdown, that NOTHING has reached the patient's
 *      history or their trend at either stage, that the grace window's only target is the way back —
 *      and then takes the ending back with a limb and proves the song came back with the record still
 *      empty, before going through it deliberately.
 *   3b. THE ONE THING THAT CANNOT BE DONE HANDS-FREE. Suspends the AudioContext the way a browser
 *      does and asserts the screen SAYS so in those words, and that the whole screen is the control.
 *      This is the only place the harness performs a second touch — the point being that it must.
 *   4. RESULTS. Asserts a camera session keeps its camera and offers both targets, and still offers
 *      to turn the camera off.
 *   5. The same screens at 1280x800.
 *
 * HOW THE PATIENT IS SIMULATED: synthetic MediaPipe landmarks (src/vision/fixtures.ts) fed to the
 * live VisionInput through `processDetection`, exactly as critic/handsfree.mjs does.
 *
 * AND IT IS A HAND THAT ANSWERS, because in leg mode nothing else can. `dwellLimbs` returns the HANDS
 * (a seated patient puts a knee somewhere only by performing a prescribed leg movement), and this
 * harness used to drive a rig with no arms at all: every arm landmark sat on the fixture's unplaced
 * (0.5, 0.2) placeholder, so the only way to aim anything was to TRANSLATE THE WHOLE BODY, which
 * dragged the knees, the hips and that placeholder around the frame — and out of it, which is exactly
 * why `camera-dwell-restart`, `rom-dwell-next`, `rest-dwell-stop` and `pause-dwell-resume` reported
 * "never confirmed; ring reached 0%". It was a harness that could not perform the gesture it was
 * testing, which is not evidence of anything.
 *
 * So the rig now has arms (`SEATED_HAND_RESTS`, `handAt`): both hands rest on the thighs, and a hold is
 * performed the way the app asks for it — one hand raised from its resting position to the ring and
 * held there, with the legs still marching. Nothing else in the figure moves while it happens.
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const ROOT = '/home/user/2nd';
const OUT = '/tmp/claude-0/-home-user-2nd/a10f947c-ef5b-515c-aee2-bf90f9d49567/scratchpad/shots';
const PORT = Number(process.env.PORT ?? 5732);
const BASE = `http://localhost:${PORT}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...m) => console.log('[drive]', ...m);
mkdirSync(OUT, { recursive: true });

async function waitForServer(url, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(url)).ok) return; } catch {}
    await wait(250);
  }
  throw new Error('server never came up');
}

const LANES = [
  { movement: 'seated_march', side: 'left' },
  { movement: 'seated_march', side: 'right' },
];

async function installBody(page) {
  const ok = await page.evaluate(async () => {
    const api = window.__beatRehab;
    if (!api) return 'no __beatRehab';
    const fx = await import('/src/vision/fixtures.ts');
    const lm = await import('/src/vision/landmarks.ts');
    const body = {
      side: 'left', lift: 0, dx: 0, dy: 0, injected: 0,
      /** Which hand is doing the reaching, and where it is (null = both hands on the thighs). */
      handSide: 'left', hand: null,
      /** What is holding the resting hands up: furniture ('chair_arms') the leg cannot move, or the
       *  thighs, which carry the hand and are therefore refused as a pointer (`DwellCoupling`). */
      support: 'chair_arms',
      points: () => ({
        knee: body.side === 'left' ? lm.POSE.LEFT_KNEE : lm.POSE.RIGHT_KNEE,
      }),
      pose: () => fx.seatedPose({ kneeLift: body.lift, side: body.side, hands: body.support, handAt: body.hand ?? undefined }),
      /** Both hands back on the thighs: out of every ring, which is what opens the entry gate. */
      rest: () => { body.hand = null; },
      /** Pick the hand that will reach, and put it at that hand's own resting position. */
      reach: (side) => { body.handSide = side; body.hand = { side, ...fx.SEATED_HAND_RESTS[body.support][side] }; },
      at: (name) => {
        if (name === 'wrist') {
          // READ THE POSE, NEVER THE REST TABLE: a hand resting on the THIGH is carried by hip
          // flexion and circumduction (`SEATED_HAND_SUPPORTS`), so the table's number is where the
          // hand would be if the leg were down. That assumption is what this harness inherited.
          const idx = body.handSide === 'left' ? lm.POSE.LEFT_WRIST : lm.POSE.RIGHT_WRIST;
          const p = body.pose()[idx];
          return { x: p.x + body.dx, y: p.y + body.dy };
        }
        const idx = body.points()[name];
        const p = body.pose()[idx];
        return { x: p.x + body.dx, y: p.y + body.dy };
      },
      aim: (name, x, y) => {
        // A HAND MOVES BY ITSELF. Only the knee has to be aimed by translating the scene, and that is
        // the fallback this harness keeps only to show that a knee cannot confirm.
        if (name === 'wrist') { body.hand = { side: body.handSide, x: x - body.dx, y: y - body.dy }; return true; }
        const idx = body.points()[name];
        const p = body.pose()[idx];
        body.dx = x - p.x; body.dy = y - p.y; return true;
      },
      tick: () => {
        const vision = api.runtime.peekVision?.();
        const ctx = api.runtime.peekAudio?.()?.ctx;
        if (!vision || !ctx) return;
        const raw = body.pose();
        const moved = body.dx || body.dy ? fx.translateLandmarks(raw, body.dx, body.dy) : raw;
        try {
          vision.processDetection({ tMs: performance.now(), pose: moved, poseWorld: fx.seatedPoseWorld({ kneeLift: body.lift, side: body.side }), hands: [] }, ctx.currentTime);
          body.injected++;
        } catch (e) { body.lastError = String(e); }
      },
    };
    body.timer = setInterval(body.tick, 22);
    window.__hfBody = body;
    return 'ok';
  });
  if (ok !== 'ok') throw new Error(ok);
}

async function quietCamera(page) {
  return page.evaluate(() => new Promise((res) => {
    const t0 = performance.now();
    const id = setInterval(() => {
      const v = window.__beatRehab.runtime.peekVision?.();
      const st = v?.getStats?.();
      if (st && st.frames >= 1) {
        clearInterval(id);
        if (st.inferenceMs < 120) return res(null);
        v.loop?.stop?.();
        return res(`stopped the real detect loop after ${st.inferenceMs.toFixed(0)} ms/frame`);
      }
      if (performance.now() - t0 > 120000) { clearInterval(id); res('no camera frame'); }
    }, 10);
  }));
}

const glide = async (page, limb, x, y, steps = 6) => {
  const from = await page.evaluate((l) => window.__hfBody.at(l), limb);
  for (let i = 1; i <= steps; i++) {
    const k = i / steps;
    await page.evaluate(({ l, tx, ty }) => window.__hfBody.aim(l, tx, ty), { l: limb, tx: from.x + (x - from.x) * k, ty: from.y + (y - from.y) * k });
    await wait(60);
  }
};

/** Where a testid element sits, and whether it is inside the viewport. */
const box = (page, id) => page.evaluate((i) => {
  const el = document.querySelector(`[data-testid="${i}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height), vh: window.innerHeight, visible: r.top >= 0 && r.bottom <= window.innerHeight && r.width > 0 };
}, id);

/** Where a target is drawn right now, in the video coordinates the landmarks are in. */
const readTarget = (page, id) => page.evaluate((i) => {
  const el = document.querySelector(`[data-testid="${i}"]`);
  if (!el) return null;
  return {
    x: Number(el.getAttribute('data-dwell-x')),
    y: Number(el.getAttribute('data-dwell-y')),
    r: Number(el.getAttribute('data-dwell-radius')),
    p: Number(el.getAttribute('data-progress')),
    phase: el.getAttribute('data-phase'),
  };
}, id);

/** Hold a limb on a target until `settled()`. Returns how. */
async function hold(page, id, settled, budgetMs = 40000) {
  const first = await readTarget(page, id);
  if (!first) throw new Error(`no target ${id}`);
  const deadline = Date.now() + budgetMs;
  let best = 0, filling = null;
  // A HAND FIRST, because in leg mode a hand is the only thing the circles follow. The knee is tried
  // afterwards purely to show what the fix claims: it cannot confirm, and it is not allowed to.
  for (const limb of ['wrist', 'knee']) {
    if (Date.now() > deadline) break;
    if (limb === 'wrist') {
      // The patient reaches with the nearer hand, from where that hand rests. Starting at rest is what
      // makes the hold an ENTRY rather than a limb that happened to be sitting in the ring.
      await page.evaluate((x) => window.__hfBody.reach(x >= 0.5 ? 'left' : 'right'), first.x);
    } else {
      await page.evaluate(() => window.__hfBody.rest());
      await glide(page, limb, first.x, Math.min(0.95, first.y + 0.22), 4);
    }
    await wait(700);
    if (await settled()) return { how: 'settled before the hold', best };
    let aim = await readTarget(page, id) ?? first;
    await glide(page, limb, aim.x, aim.y, 6);
    let until = Date.now() + 5000;
    while (Date.now() < until && Date.now() < deadline) {
      await wait(120);
      if (await settled()) return { how: `held the ${limb} on ${id} at ${aim.x.toFixed(2)},${aim.y.toFixed(2)}`, best: Math.max(best, 1), filling };
      const p = await readTarget(page, id);
      if (!p) break;
      if (p.p > best) best = p.p;
      if (p.p >= 0.25 && p.p <= 0.9 && filling === null) filling = p.p;
      if (p.p > 0.02) until = deadline;
      // THE RING IS ALLOWED TO MOVE (`DwellLayout` slides a circle off a limb that lives under it), and
      // a patient can see it move. A harness that keeps holding the old spot is measuring nothing.
      if (Math.hypot((p.x - aim.x) * (4 / 3), p.y - aim.y) > p.r * 0.3) {
        aim = p;
        await glide(page, limb, aim.x, aim.y, 3);
      }
    }
  }
  // WHY it did not fill, in the app's own words: a ring standing on a limb, a limb the exercise is
  // carrying and a limb nobody is holding are three different faults with three different remedies,
  // and "reached 0 %" tells them apart from none of them.
  const why = await page.evaluate((target) => {
    const el = document.querySelector(`[data-testid="${target}"]`);
    const legend = document.querySelector('[data-coupled]:not([data-coupled=""])');
    return {
      phase: el?.getAttribute('data-phase') ?? null,
      block: el?.getAttribute('data-dwell-block') ?? null,
      coupled: legend?.getAttribute('data-coupled') ?? null,
    };
  }, id);
  throw new Error(
    `${id} never confirmed; ring reached ${(best * 100).toFixed(0)}% (phase ${why.phase ?? '?'}` +
      `${why.block ? `, blocked: ${why.block}` : ''}${why.coupled ? `; measured ${why.coupled}` : ''})`,
  );
}

const screenOf = (page) => page.evaluate(() => window.__beatRehab.getState().screen);
const shoot = async (page, n) => { const p = resolve(OUT, `${n}.png`); await page.screenshot({ path: p }); log('->', p); };

async function main() {
  const server = spawn(resolve(ROOT, 'node_modules/.bin/vite'), ['--port', String(PORT), '--strictPort'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  server.stdout.resume();
  server.stderr.on('data', (d) => process.stderr.write(`[vite] ${d}`));
  await waitForServer(BASE);

  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium',
    headless: true,
    args: ['--no-sandbox', '--use-gl=swiftshader', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  });
  const failures = [];
  const notes = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      const where = m.location()?.url ?? '';
      if (/favicon/i.test(m.text()) || /favicon/i.test(where)) return;
      errors.push(`${m.text()} @ ${where}`);
    });
    await page.context().grantPermissions(['camera'], { origin: BASE });
    await page.goto(`${BASE}/`, { waitUntil: 'load' });
    await wait(1500);
    await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => !!window.__beatRehab, null, { timeout: 30000 });

    await page.evaluate((lanes) => {
      const now = Date.now();
      window.__beatRehab.store.setState({ patients: [{ id: 'p_hf', name: 'Alone', createdAt: now - 8.64e7, lastUsedAt: now }], activePatientId: 'p_hf' });
      const s = window.__beatRehab.store.getState();
      s.setInputMode('camera'); s.setMode('leg');
      s.setLanes(lanes.map((l, i) => ({ index: i, movement: l.movement, side: l.side })));
      s.setDifficulty('hard');        // narrowest windows: the gate the critic reported
      s.setWindowScale(1);
      s.updateSettings({ mirrored: false });
    }, LANES);

    await page.getByTestId('start-session').click();  // the one real gesture (AudioContext)
    await page.waitForFunction(() => !!window.__beatRehab.runtime.peekAudio?.(), null, { timeout: 15000 });
    await page.evaluate(() => window.__beatRehab.gotoScreen('camera'));
    await page.waitForFunction(() => window.__beatRehab.getState().screen === 'camera', null, { timeout: 10000 });
    await page.waitForFunction(() => !!window.__beatRehab.runtime.peekVision?.(), null, { timeout: 90000 });
    const quieted = await quietCamera(page);
    if (quieted) notes.push(quieted);
    await installBody(page);
    await page.waitForFunction(() => (window.__hfBody?.injected ?? 0) > 5, null, { timeout: 60000 });

    // ---- 1. THE BLOCKED GATE -----------------------------------------------------------------
    await page.waitForFunction(() => document.querySelector('[data-testid="camera-readiness"]')?.getAttribute('data-readiness') === 'blocked', null, { timeout: 60000 })
      .catch(() => failures.push('could not force the blocked-gate state at all'));
    const verdict = await page.evaluate(() => ({
      kind: document.querySelector('[data-testid="camera-readiness"]')?.getAttribute('data-readiness'),
      headline: document.querySelector('[data-testid="camera-readiness-headline"]')?.textContent,
      badge: document.querySelector('[data-testid="camera-readiness-badge"]')?.textContent,
      buttonDisabled: document.querySelector('[data-testid="camera-continue"]')?.disabled,
    }));
    log('verdict:', JSON.stringify(verdict));
    notes.push(`blocked headline: ${verdict.headline}`);
    if (verdict.buttonDisabled !== true) failures.push('the therapist gate did not close on a blocked device');
    /**
     * ...AND THE GATE MAY NOT BE THE ONLY BUTTON ON THE SCREEN. The dwell legend under the preview
     * ends "If your hands are out of the picture, use the buttons", and on a blocked device the only
     * button above the fold was the gated one: the buttons that DID work were in the readiness card
     * in the right column, ~400 px below the fold at 1024x768. A caption may not point at a disabled
     * control. So the escape now sits beside the gate it escapes, above the fold, and is asserted as
     * such — enabled, on screen, and not the primary green button.
     */
    const escape = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="camera-continue-anyway"]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        disabled: el.disabled === true,
        primary: el.className.includes('btn-primary'),
        text: el.textContent,
        visible: r.top >= 0 && r.bottom <= window.innerHeight && r.width > 0,
        top: Math.round(r.top),
      };
    });
    log('above-the-fold escape', JSON.stringify(escape));
    if (!escape) failures.push('a blocked camera check offers no working forward BUTTON above the fold, while its legend says to use the buttons');
    else {
      if (escape.disabled) failures.push('the above-the-fold escape from the blocked gate is itself disabled');
      if (!escape.visible) failures.push(`the escape from the blocked gate is off screen at 1024x768 (top ${escape.top})`);
      if (escape.primary) failures.push('the escape from a blocked device is the primary green button — the gate is meant to stop somebody walking forward unaware');
      if (!/anyway/i.test(escape.text ?? '')) failures.push(`the escape reads "${escape.text}" rather than saying it is going on anyway`);
    }

    const go = await box(page, 'camera-dwell-continue');
    const back = await box(page, 'camera-dwell-restart');
    const note = await box(page, 'camera-blocked-note');
    const legend = await box(page, 'camera-dwell-legend');
    const limb = await box(page, 'camera-dwell-legend-limb');
    log('go', JSON.stringify(go), 'back', JSON.stringify(back));
    log('note', JSON.stringify(note), 'legend', JSON.stringify(legend), 'limb', JSON.stringify(limb));
    /**
     * THE LIMB BADGE IS ASSERTED LIKE ANYTHING ELSE, which is the fix for this harness itself.
     *
     * It used to PRINT the legend's box and assert nothing about it, and at 1280x800 it explicitly
     * excluded the legend from the visibility check (`t.i !== 'camera-dwell-legend'`) — so it printed
     * `visible: false` for the sentence naming the limb and passed. Measured while it was passing:
     * the camera check's legend ran 667–963 on a 768 px screen with the badge at 842–875, i.e. off
     * the bottom, and a patient who cannot touch the tablet cannot scroll to it. What is lost there
     * is the difference between "hold it there longer" and "it is watching the other leg", so it is
     * exactly as load-bearing as the rings, and it is now checked as such on every screen and size.
     */
    for (const [n, b] of [
      ['forward target', go],
      ['back target', back],
      ['what it costs', note],
      ['the legend (what the circles do)', legend],
      ['the limb badge (WHICH limb the app is following)', limb],
    ]) {
      if (!b) failures.push(`${n} is not on the blocked camera check at all`);
      else if (!b.visible) failures.push(`${n} is NOT above the fold at 1024x768 (top ${b.top}, bottom ${b.bottom}, viewport ${b.vh})`);
    }
    const phases = await page.evaluate(() => ({
      go: document.querySelector('[data-testid="camera-dwell-continue"]')?.getAttribute('data-phase'),
      back: document.querySelector('[data-testid="camera-dwell-restart"]')?.getAttribute('data-phase'),
    }));
    log('phases', JSON.stringify(phases));
    if (phases.go === 'off') failures.push('the forward target is still structurally dead on a blocked device');
    if (phases.back === 'off') failures.push('the restart target is dead on a blocked device');
    await shoot(page, '01-camera-blocked-1024');

    // 1b. the back target: restart the camera, hands free.
    const before = await page.evaluate(() => window.__beatRehab.runtime.peekVision?.());
    let restarted = false;
    try {
      await hold(page, 'camera-dwell-restart', async () =>
        (await page.evaluate(() => !!document.querySelector('[data-testid="camera-starting"]'))) === true, 30000);
      restarted = true;
    } catch (e) { failures.push(`hands-free RESTART: ${e.message}`); }
    if (restarted) {
      log('restart confirmed hands-free');
      await shoot(page, '02-camera-restarting');
      // The camera comes back; re-install the body against the NEW vision input.
      await page.waitForFunction(() => !document.querySelector('[data-testid="camera-starting"]'), null, { timeout: 120000 }).catch(() => {});
      await quietCamera(page);
      await page.waitForFunction(() => (window.__hfBody?.injected ?? 0) > 0, null, { timeout: 30000 }).catch(() => {});
      await wait(2500);
    }

    // 1c. the forward target: go on anyway.
    try {
      const r = await hold(page, 'camera-dwell-continue', async () => (await screenOf(page)) === 'rom', 45000);
      log('forward:', r.how, 'caught filling at', r.filling);
      if (r.filling === null) notes.push('did not catch the camera ring part-full (it filled between polls)');
    } catch (e) { failures.push(`hands-free GO ON ANYWAY from a blocked device: ${e.message}`); }
    await shoot(page, '03-rom-lane1');

    // ---- 2. ROM: a way BACK in the state a confirm lands in ------------------------------------
    const romBack = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="rom-dwell-redo"]');
      const fw = document.querySelector('[data-testid="rom-dwell-next"]');
      return el ? { label: el.textContent, phase: el.getAttribute('data-phase'), fwPhase: fw?.getAttribute('data-phase') } : null;
    });
    log('rom lane 1 back target:', JSON.stringify(romBack));
    if (!romBack) failures.push('ROM lane 1 has no back target while the range is being measured');
    else {
      if (romBack.phase === 'off') failures.push('ROM back target is dead during the rest hold');
      if (!/Camera check/.test(romBack.label ?? '')) failures.push(`ROM lane 1 back target is "${romBack.label}", not the screen before it`);
    }
    const romBackBox = await box(page, 'rom-dwell-redo');
    if (romBackBox && !romBackBox.visible) failures.push(`ROM back target is below the fold (top ${romBackBox.top}/${romBackBox.vh})`);
    // Same rule on the range screen, where the badge measured 988 on a 768 px screen.
    const romLimb = await box(page, 'rom-dwell-legend-limb');
    if (!romLimb) failures.push('the ROM legend does not say which limb is being followed at all');
    else if (!romLimb.visible) failures.push(`the ROM limb badge is off screen at 1024x768 (top ${romLimb.top}, bottom ${romLimb.bottom}, viewport ${romLimb.vh})`);

    // Measure lane 1 for real, then hold forward to lane 2, then hold BACK to lane 1.
    const still = () => page.evaluate(() => {
      window.__hfBody.dx = 0; window.__hfBody.dy = 0; window.__hfBody.side = 'left'; window.__hfBody.lift = 0;
      window.__hfBody.rest();   // hands back on the thighs: a rest hold is not a hand held up at a ring
    });
    const rep = async () => {
      for (let i = 1; i <= 8; i++) { await page.evaluate((l) => { window.__hfBody.lift = l; }, i / 8); await wait(40); }
      await wait(260);
      for (let i = 7; i >= 0; i--) { await page.evaluate((l) => { window.__hfBody.lift = l; }, i / 8); await wait(40); }
      await wait(420);
    };
    const stuck = () => page.evaluate(() => !!document.querySelector('[data-testid="rom-dwell-redo"]')?.textContent?.includes('Do it again'));
    // Arriving from a dwell hold, the limb has just been parked on a circle — which is movement inside
    // the rest window. That is exactly the state the hands-free REDO exists for, so use it.
    await still();
    await wait(2500);
    if (await stuck()) {
      log('lane 1 arrived stuck (the rest hold caught the confirm itself) — using the hands-free redo');
      try {
        await hold(page, 'rom-dwell-redo', async () => (await stuck()) === false, 40000);
        log('redo confirmed hands-free');
      } catch (e) { failures.push(`hands-free REDO of a stuck ROM lane: ${e.message}`); }
      await still();
    }
    // Hold still until the screen asks for the repetitions, then do them.
    const asked = await page.waitForFunction(() => /now move/i.test(document.body.innerText), null, { timeout: 40000 })
      .then(() => true).catch(() => false);
    if (!asked) failures.push('the rest hold never completed on lane 1');
    const dl = Date.now() + 90000;
    while (Date.now() < dl) {
      if (await page.evaluate(() => window.__beatRehab.getState().calibrations[0] !== null)) break;
      await rep();
    }
    const cal0 = await page.evaluate(() => window.__beatRehab.getState().calibrations[0]);
    if (!cal0) failures.push('lane 1 never produced an accepted range');
    await shoot(page, '04-rom-lane1-measured');

    try {
      await hold(page, 'rom-dwell-next', async () =>
        (await page.evaluate(() => /lane 2 of 2/i.test(document.body.innerText))) === true, 60000);
      log('advanced to lane 2 hands-free (this is the accidental advance the critic reproduced)');
    } catch (e) { failures.push(`ROM forward: ${e.message}`); }
    const lane2Back = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="rom-dwell-redo"]');
      return el ? { label: el.textContent, phase: el.getAttribute('data-phase') } : null;
    });
    log('lane 2 back target:', JSON.stringify(lane2Back));
    if (!lane2Back || lane2Back.phase === 'off') failures.push('landing on ROM lane 2 there is no live back target — the critic\'s finding 2');
    if (!/Back a movement/.test(lane2Back?.label ?? '')) failures.push(`lane 2 back target is "${lane2Back?.label}", not "Back a movement"`);
    await shoot(page, '05-rom-lane2-back-available');
    await still();
    await wait(1500);
    try {
      await hold(page, 'rom-dwell-redo', async () =>
        (await page.evaluate(() => /lane 1 of 2/i.test(document.body.innerText))) === true, 60000);
      log('UNDID the advance hands-free: back on lane 1');
    } catch (e) { failures.push(`hands-free UNDO of a ROM advance: ${e.message}`); }
    await shoot(page, '06-rom-back-on-lane1');

    // ---- 3. PLAY: the song stops itself, and the patient has to be able to start it again ---------
    // The therapist's part (lane 2's range) goes through the store, as on every other screen this
    // harness does not claim anything about.
    await page.evaluate(() => {
      const st = window.__beatRehab.getState();
      const first = st.calibrations[0];
      st.setCalibration(1, { ...first, capturedAt: Date.now() });
      window.__beatRehab.runtime.peekVision()?.setCalibration(1, { ...first, capturedAt: Date.now() });
    });
    await page.evaluate(() => window.__beatRehab.gotoScreen('play'));
    const playing = await page.waitForFunction(() => window.__beatRehab.getScore?.()?.phase === 'playing', null, { timeout: 180000 })
      .then(() => true).catch(() => false);
    if (!playing) {
      const st = await page.evaluate(() => ({ screen: window.__beatRehab.getState().screen, hud: window.__beatRehab.getScore?.() ?? null }));
      failures.push(`never reached a playing song: ${JSON.stringify(st)}`);
      await shoot(page, '07-play-stuck');
    } else {
      await shoot(page, '07-playing');

      // ---- 3a. STOPPING MID-SONG, HANDS-FREE ---------------------------------------------------
      // The patient is in pain / in spasm / frightened, alone, with the song still running. There is
      // no target on the highway (a live one there is pressed by the exercise itself — see the note
      // beside REST_OFFER_STILL_SEC in Play.tsx); the offer appears only after a stretch in which the
      // prescribed movement demonstrably did not happen. So: stop moving the synthetic body — which
      // is what it is already doing — wait for a note to be judged, and assert the offer arrives.
      await page.waitForFunction(() => {
        const h = window.__beatRehab.getScore?.();
        return !!h && (h.hits + h.misses) > 0;
      }, null, { timeout: 60000 }).catch(() => failures.push('no note was ever judged during play'));
      const offered = await page
        .waitForFunction(() => !!document.querySelector('[data-testid="rest-offer"]'), null, { timeout: 40000 })
        .then(() => true)
        .catch(() => false);
      if (!offered) failures.push('a patient alone who stops moving mid-song is offered no hands-free way to stop');
      else {
        const offer = await box(page, 'rest-offer');
        const ring = await box(page, 'rest-dwell-stop');
        log('rest offer', JSON.stringify(offer), 'ring', JSON.stringify(ring));
        for (const [n, b] of [['the rest offer', offer], ['its circle', ring]]) {
          if (!b) failures.push(`${n} is not on the play screen`);
          else if (!b.visible) failures.push(`${n} is off screen at 1024x768 (top ${b.top}, bottom ${b.bottom}, viewport ${b.vh})`);
        }
        /**
         * AND IT HAS TO BE BIG ENOUGH TO AIM AT. Measured in the running app at 1024x768 before this
         * was fixed: the offer lived in the renderer's reserved panel, which gave it a 129x97 preview
         * and a ring of ~11 px radius — about 0.4° of visual angle at a metre, against an
         * assistive-technology floor of 1.5°. "Never covers the board" had been bought by making the
         * only mid-song safety control invisible. The board now MAKES ROOM (the canvas is narrowed and
         * the renderer re-laid-out into what is left), so this asserts both halves: the ring has its
         * degrees, and no part of the board is behind the panel.
         */
        const ringSize = await page.evaluate(() => {
          const host = document.querySelector('[data-testid="rest-dwell-stop"]');
          const track = host?.querySelector('.dwell-track');
          const canvas = document.querySelector('[data-testid="play-canvas"]');
          const panel = document.querySelector('[data-testid="rest-offer"]');
          if (!track || !canvas || !panel) return null;
          const t = track.getBoundingClientRect();
          const c = canvas.getBoundingClientRect();
          const p = panel.getBoundingClientRect();
          return {
            ringRadiusPx: Math.round((t.width / 2) * 10) / 10,
            preview: (() => { const f = host.closest('.camera-frame')?.getBoundingClientRect(); return f ? `${Math.round(f.width)}x${Math.round(f.height)}` : null; })(),
            canvas: `${Math.round(c.width)}x${Math.round(c.height)} at ${Math.round(c.left)}`,
            boardBehindThePanel: !(p.right <= c.left + 1 || p.left >= c.right - 1 || p.bottom <= c.top + 1 || p.top >= c.bottom - 1),
          };
        });
        log('rest ring', JSON.stringify(ringSize));
        if (!ringSize) failures.push('could not measure the rest offer\'s ring at all');
        else {
          // ~0.35 mm per CSS px on a clinic tablet: 35 px of radius is ~1.4°, i.e. the floor with the
          // slack the layout is allowed to take out of it on a 1024-wide board.
          if (ringSize.ringRadiusPx < 35) {
            failures.push(`the mid-song safety control's ring is ${ringSize.ringRadiusPx} px of radius in a ${ringSize.preview} preview — under the 1.5° floor a patient has to aim at it from a metre`);
          }
          if (ringSize.boardBehindThePanel) {
            failures.push('the rest offer is drawn over the board — a note behind it would be recorded as unanswered');
          }
        }
        await shoot(page, '07b-rest-offer');

        // THE HANDS-FREE "NO": one repetition of the prescribed movement takes the offer away. This is
        // what makes the offer refusable without touching anything — and it is the same test that
        // keeps the circle off the screen while the patient is working.
        for (const l of [0.25, 0.5, 0.75, 1, 0.75, 0.5, 0.25, 0]) {
          await page.evaluate((v) => { window.__hfBody.lift = v; }, l);
          await wait(70);
        }
        const gone = await page
          .waitForFunction(() => !document.querySelector('[data-testid="rest-offer"]'), null, { timeout: 8000 })
          .then(() => true)
          .catch(() => false);
        if (!gone) failures.push('a repetition did not take the rest offer off the screen — it cannot be refused by carrying on');
        else log('one repetition put the offer away, as the offer says it will');
        // ...and it comes back when the patient stops again.
        const again = await page
          .waitForFunction(() => !!document.querySelector('[data-testid="rest-offer"]'), null, { timeout: 40000 })
          .then(() => true)
          .catch(() => false);
        if (!again) failures.push('the rest offer never came back after the patient stopped again');

        try {
          await hold(page, 'rest-dwell-stop', async () =>
            (await page.evaluate(() => window.__beatRehab.getScore?.()?.phase === 'paused')) === true, 45000);
          log('STOPPED the song hands-free, mid-song, with nothing but a limb');
        } catch (e) { failures.push(`hands-free STOP during play: ${e.message}`); }
        await shoot(page, '07c-stopped-by-hold');
        // ...and what it stopped into is the reversible one: the pause dialog, not the end of the
        // session. Carry on again so the rest of this harness runs from a playing song.
        try {
          await hold(page, 'pause-dwell-resume', async () =>
            (await page.evaluate(() => window.__beatRehab.getScore?.()?.phase === 'playing')) === true, 45000);
          log('carried on again hands-free — a stop by hold costs a pause, never the session');
        } catch (e) { failures.push(`carrying on after a hands-free stop: ${e.message}`); }
      }

      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await page.waitForFunction(() => window.__beatRehab.getScore?.()?.phase === 'paused', null, { timeout: 10000 })
        .catch(() => failures.push('the run did not pause itself when the page was hidden'));
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await wait(1500);
      const byPage = await page.evaluate(() => !!document.querySelector('[data-testid="paused-by-page"]'));
      if (!byPage) failures.push('the pause dialog does not say the page paused it');
      const pauseTargets = await page.evaluate(() => ['pause-dwell-resume', 'pause-dwell-end'].map((i) => {
        const el = document.querySelector(`[data-testid="${i}"]`);
        if (!el) return { i, missing: true };
        const r = el.getBoundingClientRect();
        return { i, phase: el.getAttribute('data-phase'), top: Math.round(r.top), bottom: Math.round(r.bottom), visible: r.top >= 0 && r.bottom <= window.innerHeight };
      }));
      log('pause targets', JSON.stringify(pauseTargets));
      for (const t of pauseTargets) {
        if (t.missing) failures.push(`the pause dialog has no ${t.i} — a stopped song a patient alone cannot restart`);
        else if (t.phase === 'off') failures.push(`${t.i} is dead on the pause dialog`);
        else if (!t.visible) failures.push(`${t.i} is not on screen at 1024x768 (top ${t.top}, bottom ${t.bottom})`);
      }
      await shoot(page, '08-paused-handsfree');
      try {
        await hold(page, 'pause-dwell-resume', async () => (await page.evaluate(() => window.__beatRehab.getScore?.()?.phase === 'playing')) === true, 45000);
        log('RESUMED the song hands-free after the tablet hid itself');
      } catch (e) { failures.push(`hands-free RESUME of a page-pause: ${e.message}`); }

      // ---- 3b. THE ONE THING THAT GENUINELY NEEDS A FINGER -----------------------------------
      // Suspend the AudioContext the way the browser does. Nothing in front of a camera can undo it.
      await page.evaluate(() => window.__beatRehab.runtime.peekAudio()?.ctx.suspend?.());
      const stalled = await page.waitForFunction(() => !!document.querySelector('[data-testid="clock-stalled"]'), null, { timeout: 30000 })
        .then(() => true).catch(() => false);
      if (!stalled) failures.push('suspending the audio context raised no "the clock has stopped" screen at all');
      else {
        const say = await page.evaluate(() => {
          const el = document.querySelector('[data-testid="clock-stalled"]');
          const r = el.getBoundingClientRect();
          return {
            tag: el.tagName,
            covers: Math.round(r.width) >= window.innerWidth - 2 && Math.round(r.height) >= window.innerHeight - 2,
            text: el.textContent,
          };
        });
        log('stalled overlay:', say.tag, 'covers viewport:', say.covers);
        if (say.tag !== 'BUTTON' || !say.covers) failures.push('the stalled-clock screen is not itself the control (a small button in the middle of a wall)');
        if (!/cannot do it|needs a hand|only a touch/i.test(say.text)) failures.push(`the stalled-clock screen does not say plainly that this one cannot be done hands-free: "${say.text?.slice(0, 160)}"`);
        await shoot(page, '08b-clock-stalled');
        // The ONE gesture. It is the point: a browser will not start sound without one.
        await page.getByTestId('clock-stalled').click();
        const back = await page.waitForFunction(() => !document.querySelector('[data-testid="clock-stalled"]'), null, { timeout: 20000 })
          .then(() => true).catch(() => false);
        if (!back) failures.push('touching the stalled-clock screen did not restart the clock');
        else log('the one touch restarted the clock, as the screen says it must');
      }

      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));
        Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      });
      await page.waitForFunction(() => window.__beatRehab.getScore?.()?.phase === 'paused', null, { timeout: 10000 }).catch(() => {});

      // ---- 3c. ENDING THE SESSION IS DESTRUCTIVE, SO IT IS ASKED TWICE AND THEN UNDOABLE -------
      // The round-three critic reproduced a FALSE dwell confirm of this exact circle at 3.30 s into
      // the first repetition of a seated march with hip circumduction — the compensation this app
      // promises never to penalise — and the app filed a truncated session the patient never chose to
      // end, into their history and their trend, with no undo. What is driven here is the whole gate,
      // INCLUDING the undo: confirm the end, then take it back with a limb and prove the session came
      // back with nothing written; then do it again and let it through.
      const recordNow = () => page.evaluate(() => ({
        history: window.__beatRehab.getState().history.length,
        last: window.__beatRehab.getState().lastResult !== null,
        phase: window.__beatRehab.getScore?.()?.phase ?? null,
      }));
      const before = await recordNow();
      try {
        await hold(page, 'pause-dwell-end', async () => !!(await page.$('[data-testid="end-confirm"]')), 45000);
        log('the end circle ASKS: one hold raises "Stop the session here?" and writes nothing');
      } catch (e) { failures.push(`the end circle did not raise the confirmation step: ${e.message}`); }
      const asked = await recordNow();
      if (asked.history !== before.history || asked.last !== before.last) {
        failures.push(`one hold on the end circle already wrote to the record (history ${before.history} -> ${asked.history})`);
      }
      if (asked.phase === 'ended') failures.push('one hold on the end circle already finished the run');
      await shoot(page, '08c-end-asked');

      // THE SECOND HOLD, on the smaller circle on the other side of the preview.
      try {
        await hold(page, 'pause-dwell-end-confirm', async () => !!(await page.$('[data-testid="end-grace"]')), 45000);
        log('the second hold starts a countdown — and still writes nothing');
      } catch (e) { failures.push(`the second hold did not reach the grace window: ${e.message}`); }
      const counting = await recordNow();
      if (counting.history !== before.history || counting.last !== before.last) {
        failures.push(`the grace window had already written to the record (history ${before.history} -> ${counting.history})`);
      }
      if (counting.phase === 'ended') failures.push('the grace window had already finished the run');
      const graceTargets = await page.evaluate(() => ({
        keep: document.querySelector('[data-testid="pause-dwell-keep"]')?.getAttribute('data-phase') ?? null,
        endStill: !!document.querySelector('[data-testid="pause-dwell-end-confirm"]'),
        left: document.querySelector('[data-testid="end-grace-left"]')?.textContent ?? null,
      }));
      log('grace window', JSON.stringify(graceTargets));
      if (graceTargets.keep === null) failures.push('the grace window offers no hands-free way back at all');
      else if (graceTargets.keep === 'off') failures.push('the grace window\'s way back is a dead ring');
      if (graceTargets.endStill) failures.push('the grace window still offers the destructive circle — a second chance to confirm inside its own undo window');
      if (!graceTargets.left) failures.push('the grace window does not say how long is left');
      await shoot(page, '08d-end-grace');

      // THE UNDO, WITH A LIMB: the session comes back and nothing was written.
      try {
        await hold(page, 'pause-dwell-keep', async () =>
          (await page.evaluate(() => window.__beatRehab.getScore?.()?.phase === 'playing')) === true, 45000);
        log('TOOK THE ENDING BACK hands-free — the patient got their session back');
      } catch (e) { failures.push(`the ending could not be undone hands-free: ${e.message}`); }
      const undone = await recordNow();
      if (undone.history !== before.history || undone.last !== before.last) {
        failures.push(`an ending that was taken back still left a record behind (history ${before.history} -> ${undone.history})`);
      }
      if (undone.phase !== 'playing') failures.push(`taking the ending back did not give the song back (phase ${undone.phase})`);
      await shoot(page, '08e-end-undone');

      // ...and then, deliberately, all the way through.
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));
        Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      });
      await page.waitForFunction(() => window.__beatRehab.getScore?.()?.phase === 'paused', null, { timeout: 10000 }).catch(() => {});
      try {
        await hold(page, 'pause-dwell-end', async () => !!(await page.$('[data-testid="end-confirm"]')), 45000);
        await hold(page, 'pause-dwell-end-confirm', async () => !!(await page.$('[data-testid="end-grace"]')), 45000);
        // Nothing more to hold: the window runs out by itself, which is the hands-free "yes".
        await page.waitForFunction(() => window.__beatRehab.getState().screen === 'results', null, { timeout: 30000 });
        log('ENDED the session hands-free: two holds and a grace window nobody took back');
      } catch (e) { failures.push(`hands-free END from the pause dialog: ${e.message}`); }
    }

    // ---- 4. RESULTS: the last screen ----------------------------------------------------------
    if ((await screenOf(page)) !== 'results') await page.evaluate(() => window.__beatRehab.gotoScreen('results'));
    await wait(3000);
    const res = await page.evaluate(() => ({
      handsFree: window.__beatRehab.getState().handsFree,
      block: !!document.querySelector('[data-testid="results-handsfree"]'),
      cameraBadge: document.querySelector('[data-testid="results-camera-on"]')?.textContent,
      again: document.querySelector('[data-testid="results-dwell-again"]')?.getAttribute('data-phase'),
      newOne: document.querySelector('[data-testid="results-dwell-new"]')?.getAttribute('data-phase'),
      newLabel: document.querySelector('[data-testid="results-dwell-new"]')?.textContent,
      handBack: document.querySelector('[data-testid="results-handback-note"]')?.textContent,
      off: !!document.querySelector('[data-testid="results-camera-off"]'),
    }));
    log('results:', JSON.stringify(res));
    if (!res.handsFree) failures.push('a camera session did not keep the camera for the results screen');
    if (!res.block) failures.push('the results screen offers nothing hands-free');
    if (res.again === 'off' || res.again === undefined) failures.push('results "play again" target is missing or dead');
    if (res.newOne === 'off' || res.newOne === undefined) failures.push('results "new session" target is missing or dead');
    if (!res.off) failures.push('the results screen does not offer to turn the camera off');
    // WHAT THE SECOND CIRCLE CLAIMS. It goes to the mode screen, which has no camera and no targets,
    // so "New session" was a hold that promised the patient something only a therapist can do.
    if (!/Hand back/.test(res.newLabel ?? '')) failures.push(`the results back circle still reads "${res.newLabel}" — it hands the tablet back, it does not start a session`);
    if (!/camera is turned off/.test(res.handBack ?? '')) failures.push('the results screen does not say what holding that circle actually does');
    for (const [n, b] of [
      ['the results legend', await box(page, 'results-dwell-legend')],
      ['the results limb badge', await box(page, 'results-dwell-legend-limb')],
    ]) {
      if (!b) failures.push(`${n} is missing`);
      else if (!b.visible) failures.push(`${n} is off screen at 1024x768 (top ${b.top}, bottom ${b.bottom}, viewport ${b.vh})`);
    }
    await shoot(page, '09-results-handsfree');

    // ---- 5. the other clinic-tablet size --------------------------------------------------------
    await page.setViewportSize({ width: 1280, height: 800 });
    await wait(1000);
    await shoot(page, '10-results-1280');
    await page.evaluate(() => window.__beatRehab.gotoScreen('camera'));
    await wait(5000);
    const wide = await page.evaluate(() =>
      ['camera-dwell-continue', 'camera-dwell-restart', 'camera-dwell-legend', 'camera-dwell-legend-limb'].map((i) => {
        const el = document.querySelector(`[data-testid="${i}"]`);
        if (!el) return { i, missing: true };
        const r = el.getBoundingClientRect();
        return { i, top: Math.round(r.top), bottom: Math.round(r.bottom), visible: r.top >= 0 && r.bottom <= window.innerHeight };
      }),
    );
    log('1280x800 camera check:', JSON.stringify(wide));
    // NOTHING IS EXEMPT HERE ANY MORE. The exemption was `t.i !== 'camera-dwell-legend'`, and it was
    // the reason this harness printed `visible: false` for the legend and passed anyway.
    for (const t of wide) {
      if (t.missing) failures.push(`${t.i} missing at 1280x800`);
      else if (!t.visible) failures.push(`${t.i} below the fold at 1280x800 (top ${t.top}, bottom ${t.bottom})`);
    }
    await shoot(page, '11-camera-1280');

    if (errors.length) failures.push(`page errors: ${errors.slice(0, 3).join(' | ')}`);
  } catch (e) {
    failures.push(`threw: ${e?.stack ?? e}`);
    const pages = browser.contexts().flatMap((c) => c.pages());
    if (pages[0]) await pages[0].screenshot({ path: resolve(OUT, '99-stopped.png') }).catch(() => {});
  } finally {
    await browser.close();
    try { process.kill(-server.pid, 'SIGKILL'); } catch {}
  }
  console.log('\n[drive] notes:'); for (const n of notes) console.log('  -', n);
  if (failures.length) { console.error('\n[drive] FAILED'); for (const f of failures) console.error('  -', f); process.exit(1); }
  console.log('\n[drive] PASSED');
}
main().catch((e) => { console.error('crashed', e); process.exit(1); });
