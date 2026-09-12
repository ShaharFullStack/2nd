/**
 * What the hands-free target DRAWS and WHERE IT PUTS IT — the half of this feature that no amount of
 * dwell maths can get right on its own.
 *
 * Four of these are load-bearing rather than decorative:
 *
 *  - WHERE THE TARGET IS. A circle placed where a limb already rests is not a confirm gesture, it is a
 *    trap: the ROM pair used to sit 0.1804 frame-heights from the seated fixture's resting knee with an
 *    exit radius of 0.2175, so a patient who reached the target and then RELAXED could not stop the
 *    ring filling. "Placement" tests below measure every circle the screens place against the resting
 *    position of every limb `dwellLimbs` can return, in both modes, including the hysteresis band.
 *  - WHAT IT COSTS TO REACH. The app prescribes the posture ("rest your forearm on the table with your
 *    palm facing the camera") and then has to be holdable FROM it, by an affected limb, late in a
 *    fatigued session. The lift a target demands is measured here, against the rest the fixtures
 *    describe, not asserted in a comment.
 *  - THE MIRROR, AND THE CROP. The preview is always CSS-mirrored (that is what a patient expects of a
 *    camera) and the landmarks are not; and `.camera-frame` is a 4:3 box with `object-fit: cover`, so
 *    on the 16:9 sensor most laptops actually hand back, 12.5 % of each side of the frame is not on the
 *    glass at all. A target drawn without accounting for either lands on the opposite side of the
 *    frame, or half a radius from where it is measured — bugs that are invisible to every unit test and
 *    to a symmetric test pattern, and obvious the moment a person sits in the chair.
 *  - "NOT TRACKED" IS A STATE, NOT AN ABSENCE. A ring that has simply stopped filling looks exactly
 *    like one the patient is not holding still enough for. It has to say which, without relying on
 *    colour, because this is drawn for a patient at two metres with the vision they have.
 */
import { describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import {
  DwellLegend,
  DwellTarget,
  PREVIEW_ASPECT,
  dwellCadence,
  dwellCircleFits,
  pairedDwellTargets,
  previewPlacement,
  singleDwellTarget,
  toneOf,
} from './DwellTarget.tsx';
import type { DwellChoice, DwellSession } from './DwellTarget.tsx';
import {
  DWELL_CLEAR_EXTRA,
  DWELL_DEFAULTS,
  DwellHabitat,
  DwellLayout,
  DwellTracker,
  dwellAxisFor,
  dwellDistance,
  dwellEngaged,
  dwellLimbs,
  dwellTargetClear,
  dwellTargetsOverlap,
  pickDwellLimb,
  retargetForAspect,
} from '../vision/dwell.ts';
import type { DwellCircle, DwellPoint, DwellState } from '../vision/dwell.ts';
import { handPose, reNormalizeAspect, seatedPose, translateLandmarks } from '../vision/fixtures.ts';
import { POSE } from '../vision/landmarks.ts';
import type { DetectionResult } from '../vision/mediapipe.ts';
import type { Mode, Side } from '../engine/types.ts';
import { useStore } from '../state/store.ts';

function state(over: Partial<DwellState> = {}): DwellState {
  return {
    progress: 0,
    inside: false,
    withinEntry: false,
    tracked: true,
    holding: false,
    confirmed: false,
    confirmations: 0,
    blocked: null,
    pointer: { x: 0.5, y: 0.5 },
    lostSec: 0,
    remainingSec: DWELL_DEFAULTS.holdSec,
    target: { x: 0.27, y: 0.3, radius: 0.15 },
    xScale: PREVIEW_ASPECT,
    ...over,
  };
}

const CHOICE: DwellChoice = {
  id: 'go',
  target: { x: 0.27, y: 0.3, radius: 0.15 },
  label: 'Continue',
  onConfirm: () => {},
};

function draw(over: Partial<DwellState> | null, choice: DwellChoice = CHOICE, reducedMotion = false) {
  cleanup();
  render(
    <DwellTarget
      choice={choice}
      state={over === null ? undefined : state({ target: choice.target, ...over })}
      reducedMotion={reducedMotion}
      xScale={PREVIEW_ASPECT}
      testId="t"
    />,
  );
  return screen.getByTestId('t');
}

/* ================= where the targets go ================= */

/** Every circle the screens actually place, per mode. */
function placements(mode: Mode): DwellCircle[] {
  return [singleDwellTarget(mode), ...pairedDwellTargets(mode)];
}

/** The aspects the app can actually be handed: a square sensor, the 4:3 it asks for, the 16:9 it gets. */
const ASPECTS = [1, 4 / 3, 16 / 9];
const FPS = 30;

/**
 * A REPETITION AS A PATIENT PERFORMS ONE. The critic's profile: a 4 s rise, 1.5 s held at the top and a
 * 3 s descent, which is a hemiparetic pace and slower than anything this app paces (the ROM screen
 * gives no pace at all — "Lift your knee as high as is comfortable, lower it" — and the chart's lane
 * spacing is 1.2 s). The brisk profile is the other end of the same instruction.
 */
const SLOW_REP = { riseSec: 4, holdSec: 1.5, fallSec: 3 };
const BRISK_REP = { riseSec: 0.5, holdSec: 0.2, fallSec: 0.5 };

function repAmount(t: number, profile: { riseSec: number; holdSec: number; fallSec: number }): number {
  const span = profile.riseSec + profile.holdSec + profile.fallSec;
  const cycle = ((t % (span + 0.8)) + span + 0.8) % (span + 0.8);
  if (cycle <= 0) return 0;
  if (cycle < profile.riseSec) return 0.5 * (1 - Math.cos(Math.PI * (cycle / profile.riseSec)));
  if (cycle < profile.riseSec + profile.holdSec) return 1;
  const fall = cycle - profile.riseSec - profile.holdSec;
  if (fall >= profile.fallSec) return 0;
  return 0.5 * (1 + Math.cos(Math.PI * (fall / profile.fallSec)));
}

/* ---------------- the whole pipeline, as the hook runs it ---------------- */

interface DriveOutcome {
  confirms: number;
  /** Frames on which some ring was stood down because a limb lives there. */
  standDowns: number;
  /** How many times the layout moved a circle off the patient. */
  moves: number;
  maxProgress: number;
  /** Frames on which the pipeline was actually following a limb: a sweep where nothing is tracked
   * proves nothing at all, so every case below asserts this. */
  tracked: number;
  frames: number;
  /** The layout at the end, and whether each circle clears every limb in view. */
  finalClear: boolean[];
  /** True when the layout reports there is nowhere on the axis that clears AND fits beside the other
   * ring: an honest dead end for that circle, which the legend has to own rather than a ring that
   * looks holdable. */
  unplaceable: boolean;
}

/**
 * EXACTLY WHAT `useDwellTargets` DOES, minus React and the camera.
 *
 * The habitat, the layout (gate + relocation) and the trackers are the shipping classes, driven frame
 * by frame off synthetic landmarks through the shipping `dwellLimbs`/`pickDwellLimb`. A test that
 * reimplemented any of that would prove something about the test.
 */
function drive(opts: {
  mode: Mode;
  aspect: number;
  authored: DwellCircle[];
  seconds: number;
  frame: (t: number) => DetectionResult;
  fps?: number;
  mirrored?: boolean;
}): DriveOutcome {
  const { mode, aspect, authored, seconds, frame } = opts;
  const fps = opts.fps ?? FPS;
  const ids = authored.map((_, i) => `t${i}`);
  const habitat = new DwellHabitat();
  const clearOpts = {
    xScale: aspect,
    axis: dwellAxisFor(mode),
    exitRatio: DWELL_DEFAULTS.exitRatio,
    extra: DWELL_CLEAR_EXTRA,
    fits: (c: DwellCircle) => dwellCircleFits(c, aspect),
  };
  const layout = new DwellLayout(
    authored.map((c, i) => ({ id: ids[i], authored: c })),
    clearOpts,
  );
  const trackers = new Map(ids.map((id) => [id, new DwellTracker(layout.circleFor(id) as DwellCircle, { xScale: aspect })]));
  let previous: DwellPoint | null = null;
  let previousKey: string | null = null;
  const out: DriveOutcome = { confirms: 0, standDowns: 0, moves: 0, maxProgress: 0, tracked: 0, frames: 0, finalClear: [], unplaceable: false };
  let summaries = habitat.all(0, aspect);

  for (let i = 0; i <= Math.round(seconds * fps); i++) {
    const t = i / fps;
    const limbs = dwellLimbs(frame(t), mode, opts.mirrored ?? false, aspect);
    let busy = false;
    for (const tracker of trackers.values()) {
      const st = tracker.state;
      if (st.progress > 0 || st.blocked === 'refractory') busy = true;
    }
    if (!busy) {
      // The same rule the hook applies: a hold is never evidence about where a limb lives, and in leg
      // mode neither is a hand sitting inside one of these circles (`dwellEngaged`).
      const engagedCounts = dwellAxisFor(mode) === 'radial';
      for (const l of limbs) {
        if (engagedCounts && dwellEngaged(l.point, layout.circles(), aspect, DWELL_DEFAULTS.exitRatio)) continue;
        habitat.noteOne(l.key, l.point, t, l.scale ?? null);
      }
    }
    summaries = habitat.all(t, aspect);
    const survey = layout.survey(summaries, t, busy);
    out.unplaceable = [...survey.placeable.values()].some((ok) => !ok);
    if (survey.moved) {
      out.moves += 1;
      for (const [id, tracker] of trackers) tracker.setTarget(layout.circleFor(id) as DwellCircle, aspect);
    }
    for (const [id, tracker] of trackers) tracker.setOccupied(survey.occupied.get(id) === true);
    const limb = pickDwellLimb(limbs, layout.circles(), { xScale: aspect, previous, previousKey });
    out.frames += 1;
    if (limb) out.tracked += 1;
    previous = limb?.point ?? null;
    previousKey = limb?.key ?? null;
    for (const tracker of trackers.values()) {
      const state = tracker.update(limb?.point ?? null, t, limb?.key ?? null);
      if (state.confirmed) out.confirms += 1;
      if (state.blocked === 'occupied') out.standDowns += 1;
      out.maxProgress = Math.max(out.maxProgress, state.progress);
    }
  }
  out.finalClear = layout.circles().map((c) => dwellTargetClear(c, summaries, clearOpts).clear);
  return out;
}

/* ---------------- the bodies the pipeline is driven with ---------------- */

const LEG_MOVEMENTS = ['seated_march', 'knee_extension', 'ankle_dorsiflexion', 'hip_abduction'] as const;
const HAND_MOVEMENTS = ['hand_open_close', 'wrist_extension', 'finger_opposition', 'finger_spread'] as const;

/** Where a seated patient's hands are while their LEGS are working. */
const HAND_RESTS: Array<{ what: string; left: DwellPoint; right: DwellPoint }> = [
  { what: 'in the lap', left: { x: 0.58, y: 0.72 }, right: { x: 0.42, y: 0.72 } },
  { what: 'on the thighs', left: { x: 0.64, y: 0.62 }, right: { x: 0.36, y: 0.62 } },
  { what: 'on chair arms, high', left: { x: 0.7, y: 0.45 }, right: { x: 0.3, y: 0.45 } },
  { what: 'folded, near the midline', left: { x: 0.54, y: 0.55 }, right: { x: 0.46, y: 0.55 } },
];

/**
 * One frame of a seated patient performing `movement` at `amount`, with the documented compensations,
 * and with their hands where a seated patient's hands are.
 */
function legFrame(opts: {
  movement: (typeof LEG_MOVEMENTS)[number];
  side: Side;
  amount: number;
  compensation: 'none' | 'circumduction' | 'trunk lean' | 'heel lift';
  hands: { left: DwellPoint; right: DwellPoint };
  aspect: number;
  dx?: number;
  dy?: number;
}): DetectionResult {
  const { movement, side, amount, compensation, hands, aspect } = opts;
  const params: Record<string, number | Side> = { side };
  if (movement === 'seated_march') params.kneeLift = amount;
  if (movement === 'knee_extension') params.kneeExtension = amount;
  if (movement === 'ankle_dorsiflexion') params.toeLift = amount;
  if (movement === 'hip_abduction') params.abduction = amount;
  // The compensations this app exists to OBSERVE and promises never to penalise. Hip circumduction
  // carries the knee sideways as it rises, which is what put it inside a dwell circle in the first
  // place; the trunk lean takes the whole upper body (and therefore the arms) with it.
  if (compensation === 'circumduction') params.abduction = ((params.abduction as number) ?? 0) + amount;
  if (compensation === 'trunk lean') params.trunkLean = amount;
  if (compensation === 'heel lift') params.heelLift = amount;
  const pose = translateLandmarks(seatedPose(params as Parameters<typeof seatedPose>[0]), opts.dx ?? 0, opts.dy ?? 0);
  // A trunk lean moves the arms with the trunk; everything else leaves the hands where they were.
  const sway = compensation === 'trunk lean' ? amount * 0.17 : 0;
  pose[POSE.LEFT_WRIST] = { x: hands.left.x + sway + (opts.dx ?? 0), y: hands.left.y + (opts.dy ?? 0), z: 0, visibility: 0.95 };
  pose[POSE.RIGHT_WRIST] = { x: hands.right.x + sway + (opts.dx ?? 0), y: hands.right.y + (opts.dy ?? 0), z: 0, visibility: 0.95 };
  return { tMs: 0, pose: reNormalizeAspect(pose, PREVIEW_ASPECT, aspect), hands: [] };
}

/** One frame of a hand performing `movement` at `amount`, with the forearm-lift compensation. */
function handFrame(opts: {
  movement: (typeof HAND_MOVEMENTS)[number];
  amount: number;
  centerX: number;
  scale: number;
  dy: number;
  aspect: number;
  compensate?: boolean;
}): DetectionResult {
  const { movement, amount, centerX, scale, dy, aspect } = opts;
  const params: Record<string, number> = { centerX, scale };
  if (movement === 'hand_open_close') params.openness = amount;
  if (movement === 'wrist_extension') params.wristExtension = amount;
  if (movement === 'finger_opposition') params.pinch = amount;
  if (movement === 'finger_spread') params.spread = amount;
  // Forearm lift: the compensation for a wrist that will not extend. It translates the whole hand up
  // by a palm length, which is the biggest thing that happens to a palm centroid in this mode.
  if (opts.compensate) params.wristRaise = amount;
  const raw = translateLandmarks(handPose(params as Parameters<typeof handPose>[0]), 0, dy);
  return { tMs: 0, pose: null, hands: [{ landmarks: reNormalizeAspect(raw, PREVIEW_ASPECT, aspect), label: 'Left', score: 0.95 }] };
}

describe('THE PRESCRIBED EXERCISE MAY NOT ANSWER FOR THE PATIENT', () => {
  /**
   * THE DEFECT THIS FILE EXISTS FOR, DRIVEN RATHER THAN ARGUED.
   *
   * A seated march performed with hip circumduction carried a knee into a dwell circle and held it
   * there. It confirmed at the camera check (skipping a screen), during a ROM measurement (throwing
   * the patient off their own calibration) and on the pause dialog (ending the session, with no undo).
   * The pace was the app's own: a 4 s rise, 1.5 s at the top, a 3 s descent, on the FIRST repetition.
   *
   * So: every movement a therapist can prescribe, both sides, slow and brisk, with and without each
   * documented compensation, with the patient's hands in every place a seated patient's hands are, at
   * every frame aspect the app can be handed — against every circle the screens place, through the
   * shipping pipeline. Nothing may confirm, and nothing may even get close.
   */
  it('leg mode: no prescribed movement, at any pace, with any compensation, confirms anything', () => {
    const failures: string[] = [];
    let runs = 0;
    for (const aspect of ASPECTS) {
      for (const movement of LEG_MOVEMENTS) {
        for (const side of ['left', 'right'] as Side[]) {
          for (const profile of [SLOW_REP, BRISK_REP]) {
            for (const compensation of ['none', 'circumduction', 'trunk lean', 'heel lift'] as const) {
              for (const rest of HAND_RESTS) {
                runs += 1;
                const seconds = profile === SLOW_REP ? 12 : 8;
                const outcome = drive({
                  mode: 'leg',
                  aspect,
                  authored: pairedDwellTargets('leg'),
                  seconds,
                  frame: (t) =>
                    legFrame({
                      movement,
                      side,
                      amount: repAmount(t, profile),
                      compensation,
                      hands: rest,
                      aspect,
                    }),
                });
                if (outcome.tracked < outcome.frames * 0.9) {
                  failures.push(`${movement}/${side} @${aspect.toFixed(2)}: nothing was being tracked — the case proves nothing`);
                }
                if (outcome.confirms > 0) {
                  failures.push(
                    `${movement}/${side} @${aspect.toFixed(2)}, ${compensation}, hands ${rest.what}, ` +
                      `${profile === SLOW_REP ? 'slow' : 'brisk'}: ${outcome.confirms} confirm(s), ` +
                      `ring reached ${(outcome.maxProgress * 100).toFixed(0)}%`,
                  );
                }
              }
            }
          }
        }
      }
    }
    expect(runs).toBeGreaterThan(300);
    expect(failures.join('\n')).toBe('');
  }, 120_000);

  it('hand mode: no prescribed movement, at any size, framing or pace, confirms anything', () => {
    const failures: string[] = [];
    let runs = 0;
    for (const aspect of ASPECTS) {
      for (const movement of HAND_MOVEMENTS) {
        for (const profile of [SLOW_REP, BRISK_REP]) {
          for (const compensate of [false, true]) {
            for (const scale of [0.8, 1.3, 1.6]) {
              for (const centerX of [0.35, 0.5, 0.72]) {
                for (const dy of [-0.1, 0, 0.1]) {
                  runs += 1;
                  const outcome = drive({
                    mode: 'hand',
                    aspect,
                    authored: pairedDwellTargets('hand'),
                    seconds: profile === SLOW_REP ? 12 : 8,
                    frame: (t) => handFrame({ movement, amount: repAmount(t, profile), centerX, scale, dy, aspect, compensate }),
                  });
                  if (outcome.tracked < outcome.frames * 0.9) {
                    failures.push(`${movement} @${aspect.toFixed(2)} scale ${scale} x ${centerX} dy ${dy}: nothing tracked`);
                  }
                  if (outcome.confirms > 0) {
                    failures.push(
                      `${movement} @${aspect.toFixed(2)}, scale ${scale}, x ${centerX}, dy ${dy}, ` +
                        `${compensate ? 'with forearm lift' : 'no compensation'}: ${outcome.confirms} confirm(s), ` +
                        `ring reached ${(outcome.maxProgress * 100).toFixed(0)}%`,
                    );
                  }
                }
              }
            }
          }
        }
      }
    }
    expect(runs).toBeGreaterThan(500);
    expect(failures.join('\n')).toBe('');
  }, 120_000);

  it('SITTING STILL confirms nothing either, wherever the patient’s limbs happen to be', () => {
    // The other half of the same question, and the one a fixture sweep used to answer badly: a body
    // that is not moving at all, over a range of framings wide enough to contain both escapes the
    // critic found. Where the authored circle lands on a limb, the app must stand it down and move it
    // — never sit on the limb and fill.
    const failures: string[] = [];
    const stranded: string[] = [];
    let usable = 0;
    let cases = 0;
    for (const aspect of ASPECTS) {
      for (const rest of HAND_RESTS) {
        for (const dx of [-0.06, 0, 0.06]) {
          for (const dy of [-0.06, 0, 0.06]) {
            const outcome = drive({
              mode: 'leg',
              aspect,
              authored: pairedDwellTargets('leg'),
              seconds: 8,
              frame: () =>
                legFrame({ movement: 'seated_march', side: 'left', amount: 0, compensation: 'none', hands: rest, aspect, dx, dy }),
            });
            const where = `leg @${aspect.toFixed(2)} hands ${rest.what} (${dx}, ${dy})`;
            cases += 1;
            if (outcome.finalClear.every(Boolean)) usable += 1;
            if (outcome.tracked < outcome.frames * 0.9) failures.push(`${where}: nothing tracked`);
            if (outcome.confirms > 0) failures.push(`${where}: ${outcome.confirms} confirm(s)`);
            // Either every ring ends up clear of the patient, or the geometry genuinely has no room
            // for one — a ring left stood down when it could have been moved is a dead end.
            if (!outcome.finalClear.every(Boolean) && !outcome.unplaceable) stranded.push(where);
          }
        }
      }
      for (const scale of [0.8, 1, 1.3, 1.6]) {
        for (const centerX of [0.35, 0.5, 0.65, 0.72]) {
          for (const dy of [-0.15, -0.1, 0, 0.1]) {
            const outcome = drive({
              mode: 'hand',
              aspect,
              authored: pairedDwellTargets('hand'),
              seconds: 8,
              frame: () => handFrame({ movement: 'hand_open_close', amount: 1, centerX, scale, dy, aspect }),
            });
            const where = `hand @${aspect.toFixed(2)} scale ${scale} x ${centerX} dy ${dy}`;
            cases += 1;
            if (outcome.finalClear.every(Boolean)) usable += 1;
            if (outcome.tracked < outcome.frames * 0.9) failures.push(`${where}: nothing tracked`);
            if (outcome.confirms > 0) failures.push(`${where}: ${outcome.confirms} confirm(s)`);
            if (!outcome.finalClear.every(Boolean) && !outcome.unplaceable) stranded.push(where);
          }
        }
      }
    }
    expect(failures.join('\n')).toBe('');
    expect(stranded.join('\n')).toBe('');
    // …and the dichotomy is not satisfied by giving up: the overwhelming majority of these bodies end
    // with every ring clear and holdable. A fix that made the gesture unavailable would pass the two
    // assertions above and fail this one.
    expect(usable / cases).toBeGreaterThan(0.97);
  }, 120_000);

  it('the escapes the critic found by hand are inside the sweep, and are caught', () => {
    // 1. A leg-mode hand resting at (0.70, 0.45): 0.1327 from the primary centre, exit radius 0.1438 —
    //    inside the hysteresis band, which no amount of "the fixture rests it lower" makes untrue.
    const near = dwellDistance({ x: 0.7, y: 0.45 }, singleDwellTarget('leg'), PREVIEW_ASPECT);
    expect(near).toBeCloseTo(0.1327, 3);
    expect(near).toBeLessThan(singleDwellTarget('leg').radius * DWELL_DEFAULTS.exitRatio);
    // What the band is and is not: a limb may WOBBLE through it, and may not LIVE in it. A hand that
    // rests there, leaves (which opens the entry gate), and comes back to exactly the same place —
    // the worst version of this, and the one that shipped once — cannot fill the ring: the band clock
    // stops the hold within `bandGraceSec`, and a hold may only ever COMPLETE inside the drawn circle.
    const legs = drive({
      mode: 'leg',
      aspect: PREVIEW_ASPECT,
      authored: pairedDwellTargets('leg'),
      seconds: 30,
      frame: (t) => {
        // 4 s at rest in the band, 1.5 s away, repeatedly: the patient reaching for something and
        // putting their hand back exactly where it was.
        const away = t % 5.5 >= 4;
        const left = away ? { x: 0.55, y: 0.72 } : { x: 0.7, y: 0.45 };
        return legFrame({
          movement: 'seated_march',
          side: 'left',
          amount: 0,
          compensation: 'none',
          hands: { left, right: { x: 0.3, y: 0.45 } },
          aspect: PREVIEW_ASPECT,
        });
      },
    });
    expect(legs.confirms).toBe(0);
    // The other hand rests just OUTSIDE the smaller ring's band, which is exactly the case the measured
    // gate is for: it is stood down, and then moved somewhere clear rather than left dead.
    expect(legs.standDowns).toBeGreaterThan(0);
    expect(legs.moves).toBeGreaterThan(0);

    // 2. A hand-mode palm at 1.6x scale with the framing 0.1 of a frame high: 0.0967 from the primary
    //    centre — INSIDE the drawn circle. `handPose` puts a resting palm at y 0.63 by construction,
    //    and nothing in the app enforces that, which is exactly why this is measured live now.
    const palm = handFrame({ movement: 'hand_open_close', amount: 1, centerX: 0.72, scale: 1.6, dy: -0.1, aspect: PREVIEW_ASPECT });
    const point = dwellLimbs(palm, 'hand', false, PREVIEW_ASPECT)[0].point;
    expect(dwellDistance(point, singleDwellTarget('hand'), PREVIEW_ASPECT)).toBeLessThan(singleDwellTarget('hand').radius);
    const hands = drive({
      mode: 'hand',
      aspect: PREVIEW_ASPECT,
      authored: pairedDwellTargets('hand'),
      seconds: 8,
      frame: (t) =>
        handFrame({ movement: 'wrist_extension', amount: repAmount(t, SLOW_REP), centerX: 0.72, scale: 1.6, dy: -0.1, aspect: PREVIEW_ASPECT }),
    });
    expect(hands.confirms).toBe(0);
    expect(hands.standDowns).toBeGreaterThan(0);
  });

  it('…and the same pipeline DOES confirm a deliberate hold, so none of the above is vacuous', () => {
    // Leg mode: the patient's hands rest in their lap while a leg works, and then one hand is raised
    // into the ring and held there. This is the gesture; everything above is not.
    const target = singleDwellTarget('leg');
    const raised = drive({
      mode: 'leg',
      aspect: PREVIEW_ASPECT,
      authored: [target],
      seconds: 14,
      frame: (t) => {
        // 6 s of marching with the hands down, then a 1 s reach and a long hold.
        const reach = Math.max(0, Math.min(1, (t - 6) / 1));
        const from = { x: 0.58, y: 0.72 };
        const hand = { x: from.x + (target.x - from.x) * reach, y: from.y + (target.y - from.y) * reach };
        return legFrame({
          movement: 'seated_march',
          side: 'left',
          amount: repAmount(t, SLOW_REP),
          compensation: 'circumduction',
          hands: { left: hand, right: { x: 0.42, y: 0.72 } },
          aspect: PREVIEW_ASPECT,
        });
      },
    });
    expect(raised.confirms).toBeGreaterThanOrEqual(1);

    // Hand mode: the prescribed hand slides along the table into the circle and stays.
    const handTarget = singleDwellTarget('hand');
    const slid = drive({
      mode: 'hand',
      aspect: PREVIEW_ASPECT,
      authored: [handTarget],
      seconds: 16,
      frame: (t) => {
        const reach = Math.max(0, Math.min(1, (t - 6) / 1.5));
        return handFrame({
          movement: 'hand_open_close',
          amount: repAmount(t, SLOW_REP),
          centerX: 0.5 + (handTarget.x - 0.5) * reach,
          scale: 1,
          dy: (handTarget.y - 0.63) * reach,
          aspect: PREVIEW_ASPECT,
        });
      },
    });
    expect(slid.confirms).toBeGreaterThanOrEqual(1);
  });
});

describe('reach: the hold has to be performable from the posture the app prescribes', () => {
  /** The nearest point of a circle to `p`, and the lift (upward y travel) needed to get there. */
  function approach(p: DwellPoint, c: DwellCircle, aspect: number) {
    const d = dwellDistance(p, c, aspect);
    const edge = { x: c.x + (p.x - c.x) * (c.radius / d), y: c.y + (p.y - c.y) * (c.radius / d) };
    return { travel: d - c.radius, lift: p.y - edge.y };
  }

  it('hand mode: the lift off the table is a slide, not an arm held in the upper third of the frame', () => {
    // The prescribed rest: forearm on the table, palm to the camera (fixtures.handPose default).
    const rest = dwellLimbs(
      handFrame({ movement: 'hand_open_close', amount: 1, centerX: 0.5, scale: 1, dy: 0, aspect: PREVIEW_ASPECT }),
      'hand',
      false,
      PREVIEW_ASPECT,
    )[0].point;
    expect(rest.y).toBeCloseTo(0.63, 2);

    const now = approach(rest, singleDwellTarget('hand'), PREVIEW_ASPECT);
    // What it used to be: the single target at (0.5, 0.3) r 0.18 — straight up, unsupported, in the
    // upper third of the frame; and the pair at (0.73, 0.3) r 0.15, 0.45 frame-heights from the palm.
    const beforePair = approach(rest, { x: 0.73, y: 0.3, radius: 0.15 }, PREVIEW_ASPECT);
    expect(now.travel).toBeLessThan(beforePair.travel);
    expect(now.lift).toBeLessThan(beforePair.lift);
    // No target asks the patient to hold a hand in the upper third of the frame.
    for (const target of placements('hand')) expect(target.y + target.radius).toBeGreaterThan(1 / 3);
    // And the lift is bounded: a raise of about a fifth of the frame height, the rest of the movement
    // being a slide out to the side, which the table carries.
    expect(now.lift).toBeLessThan(0.2);
    expect(now.lift).toBeGreaterThan(0.1); // …and it is a real move, not a twitch
  });

  it('leg mode: a raised hand reaches it from the lap, which is the only gesture leg mode has left', () => {
    const target = singleDwellTarget('leg');
    // A hand resting in the lap, raised: no exercise, no holding a limb against gravity in a posture
    // the prescription cares about. Since the knees stopped being pointers this is the whole gesture,
    // so it has to be performable — by an unaffected arm if the affected one will not do it.
    for (const rest of HAND_RESTS) {
      const travel = approach(rest.left, target, PREVIEW_ASPECT).travel;
      expect(travel, `from ${rest.what}`).toBeLessThan(0.45);
    }
    // …and it is a deliberate move rather than a twitch: the nearest resting hand is still outside the
    // band by more than the margin the gate demands.
    const nearest = Math.min(...HAND_RESTS.map((r) => dwellDistance(r.left, target, PREVIEW_ASPECT)));
    expect(nearest).toBeGreaterThan(target.radius);
  });
});

/* ================= drawn is measured ================= */

describe('the circle tested is the circle drawn', () => {
  /** Where the ring lands, in pixels, inside a preview box of `boxW` x `boxH`. */
  function drawnRing(el: HTMLElement, boxW: number, boxH: number) {
    const heightPct = Number.parseFloat(el.style.height);
    const elementH = (heightPct / 100) * boxH;
    return {
      cx: (Number.parseFloat(el.style.left) / 100) * boxW,
      cy: (Number.parseFloat(el.style.top) / 100) * boxH,
      // The SVG viewBox is 176 tall and the ring radius is 46 of it.
      r: (46 / 176) * elementH,
    };
  }

  /**
   * Where a landmark lands on the glass: the <video> is `object-fit: cover` in a 4:3 box, so a 16:9
   * frame is scaled to the box HEIGHT and 12.5 % is cropped off each side.
   */
  function drawnLandmark(p: DwellPoint, aspect: number, boxW: number, boxH: number) {
    const visX = Math.min(1, PREVIEW_ASPECT / aspect);
    const visY = Math.min(1, aspect / PREVIEW_ASPECT);
    return { x: (1 - (p.x - (1 - visX) / 2) / visX) * boxW, y: ((p.y - (1 - visY) / 2) / visY) * boxH };
  }

  const BOX_W = 800;
  const BOX_H = 600;

  for (const aspect of ASPECTS) {
    it(`holds on a ${aspect === 1 ? '1:1' : aspect === 4 / 3 ? '4:3' : '16:9'} sensor: every point the tracker calls inside is drawn inside`, () => {
      const authored = singleDwellTarget('hand');
      const circle = retargetForAspect(authored, aspect);
      cleanup();
      render(<DwellTarget choice={{ ...CHOICE, target: authored }} state={state({ target: circle, xScale: aspect })} testId="t" />);
      const ring = drawnRing(screen.getByTestId('t'), BOX_W, BOX_H);

      // One frame HEIGHT in pixels: on a frame taller than the box, cover scales it up and part of it
      // is off the glass, so this is not the box height.
      const perHeight = BOX_H * previewPlacement(circle, aspect).heightScale;

      // A grid of places a limb could be, tested both ways: what the tracker decides and what the
      // patient can see must never disagree.
      let checked = 0;
      for (let x = 0.15; x <= 0.85; x += 0.025) {
        for (let y = 0.1; y <= 0.9; y += 0.025) {
          const p = { x, y };
          const where = `${x.toFixed(3)},${y.toFixed(3)} @${aspect.toFixed(2)}`;
          const measured = dwellDistance(p, circle, aspect);
          const drawn = drawnLandmark(p, aspect, BOX_W, BOX_H);
          const drawnPx = Math.hypot(drawn.x - ring.cx, drawn.y - ring.cy);
          // The same distance, in the same units, to within a rounding of the inline percentages.
          expect(drawnPx / perHeight, where).toBeCloseTo(measured, 3);
          // …and therefore the same verdict. Points within a pixel of the edge are the rounding of the
          // inline percentages, not a disagreement, so the classification is asserted off the boundary.
          if (Math.abs(measured - circle.radius) < 0.005) continue;
          checked += 1;
          expect(drawnPx <= ring.r, where).toBe(measured <= circle.radius);
        }
      }
      expect(checked).toBeGreaterThan(500);
      // …and the ring is the size the target says, in frame heights.
      expect(ring.r / perHeight).toBeCloseTo(circle.radius, 3);
    });
  }

  it('a 16:9 sensor moves the drawn ring — the old fixed 4:3 was out by half a pair radius', () => {
    // Detector x 0.27 on a 16:9 frame is CSS-left 19.3 % of the box, not 27 %: the crop takes 12.5 %
    // off each side. Drawing it at 27 % (as a hard-coded 4:3 did) puts the ring 0.058 of the frame
    // width from where the tracker is testing — half the radius of a pair target.
    const placed = previewPlacement({ x: 0.27, y: 0.5, radius: 0.12 }, 16 / 9);
    expect(placed.x).toBeCloseTo((0.27 - 0.125) / 0.75, 6);
    expect(Math.abs(placed.x - 0.27)).toBeGreaterThan(0.07);
    expect(placed.heightScale).toBe(1);
  });

  it('a taller-than-4:3 frame is cropped top and bottom instead, and the ring grows with it', () => {
    const placed = previewPlacement({ x: 0.5, y: 0.4, radius: 0.12 }, 1);
    expect(placed.x).toBe(0.5);
    expect(placed.y).toBeCloseTo((0.4 - 0.125) / 0.75, 6);
    expect(placed.heightScale).toBeCloseTo(4 / 3, 6);
  });

  it('falls back to the authored 4:3 frame when there is no camera to ask', () => {
    expect(previewPlacement({ x: 0.72, y: 0.37, radius: 0.115 }, Number.NaN)).toEqual({ x: 0.72, y: 0.37, heightScale: 1 });
  });
});

describe('where the ring is drawn', () => {
  it('flips x, because the preview under it is mirrored and the landmarks are not', () => {
    const el = draw({});
    // Detector x 0.27 → drawn at 73 % across the mirrored preview, where the patient's limb appears.
    expect(el.style.left).toBe('73%');
    expect(el.style.top).toBe('30%');
  });

  it('draws at the detector x when it is told the preview is not mirrored', () => {
    cleanup();
    render(<DwellTarget choice={CHOICE} state={state()} mirrored={false} xScale={PREVIEW_ASPECT} testId="t" />);
    expect(screen.getByTestId('t').style.left).toBe('27%');
  });

  it('is sized so the ring diameter is the target diameter in frame heights', () => {
    // The wrapper is taller than the ring (it carries the caption), so the RING centre — not the box
    // centre — is what sits on the target, and the height accounts for the extra room.
    const el = draw({});
    const heightPct = Number.parseFloat(el.style.height);
    expect(heightPct).toBeGreaterThan(2 * CHOICE.target.radius * 100);
    expect(el.style.transform).toMatch(/translate\(-50%, -29\.5\d*%\)/);
  });

  /**
   * A low target and the preview's own clipping: with the caption always hanging below the ring its
   * second line was cut in half by the bottom edge of the frame at 1024x768 — seen in the running app,
   * not deduced. Below the half-way line the caption goes ABOVE the ring instead.
   */
  it('keeps the whole target inside the frame by flipping the caption above a low ring', () => {
    const low = { ...CHOICE, target: { x: 0.5, y: 0.55, radius: 0.18 } };
    cleanup();
    render(<DwellTarget choice={low} state={state({ target: low.target })} xScale={PREVIEW_ASPECT} testId="t" />);
    const el = screen.getByTestId('t');
    const heightPct = Number.parseFloat(el.style.height);
    const centreOffset = Number.parseFloat(/-([\d.]+)%\)$/.exec(el.style.transform)?.[1] ?? '0');
    const top = 55 - (centreOffset / 100) * heightPct;
    // The caption is above, so the ring centre is near the BOTTOM of the box…
    expect(centreOffset).toBeGreaterThan(50);
    // …and the whole thing fits between the top and bottom edges of the preview.
    expect(top).toBeGreaterThan(0);
    expect(top + heightPct).toBeLessThan(100);
  });

  it('keeps a high ring inside the frame too, with the caption below it', () => {
    const high = { ...CHOICE, target: { x: 0.5, y: 0.3, radius: 0.18 } };
    cleanup();
    render(<DwellTarget choice={high} state={state({ target: high.target })} xScale={PREVIEW_ASPECT} testId="t" />);
    const el = screen.getByTestId('t');
    const heightPct = Number.parseFloat(el.style.height);
    const centreOffset = Number.parseFloat(/-([\d.]+)%\)$/.exec(el.style.transform)?.[1] ?? '0');
    const top = 30 - (centreOffset / 100) * heightPct;
    expect(centreOffset).toBeLessThan(50);
    expect(top).toBeGreaterThan(0);
    expect(top + heightPct).toBeLessThan(100);
  });

  it('every target the screens actually place fits inside the preview, on every sensor', () => {
    for (const aspect of ASPECTS) {
      for (const mode of ['hand', 'leg'] as const) {
        for (const authored of placements(mode)) {
          const target = retargetForAspect(authored, aspect);
          cleanup();
          render(
            <DwellTarget choice={{ ...CHOICE, target: authored }} state={state({ target, xScale: aspect })} testId="t" />,
          );
          const el = screen.getByTestId('t');
          const h = Number.parseFloat(el.style.height);
          const off = Number.parseFloat(/-([\d.]+)%\)$/.exec(el.style.transform)?.[1] ?? '0');
          const where = `${mode} @${aspect.toFixed(2)} ${JSON.stringify(target)}`;
          const top = Number.parseFloat(el.style.top) - (off / 100) * h;
          expect(top, where).toBeGreaterThan(0);
          expect(top + h, where).toBeLessThan(100);
          // …and horizontally, using the box's own aspect against the 4:3 preview.
          const widthPctOfFrameWidth = ((h / 100) * (140 / 176) / PREVIEW_ASPECT) * 100;
          const leftPct = Number.parseFloat(el.style.left) - widthPctOfFrameWidth / 2;
          expect(leftPct, where).toBeGreaterThan(0);
          expect(leftPct + widthPctOfFrameWidth, where).toBeLessThan(100);
        }
      }
    }
  });
});

describe('the layouts the screens ask for', () => {
  it('places the pair apart in both modes, hysteresis bands included, on every sensor', () => {
    for (const mode of ['hand', 'leg'] as const) {
      for (const aspect of ASPECTS) {
        const [a, b] = pairedDwellTargets(mode).map((c) => retargetForAspect(c, aspect)) as [DwellCircle, DwellCircle];
        expect(dwellTargetsOverlap(a, b, DWELL_DEFAULTS.exitRatio, aspect), `${mode} @${aspect}`).toBe(false);
        expect(a.y).toBe(b.y);
      }
    }
  });

  it('puts the forward action in the same place whether it is alone or one of a pair', () => {
    // A patient who learned "the left circle" at the camera check finds it there at every step after.
    for (const mode of ['hand', 'leg'] as const) {
      const single = singleDwellTarget(mode);
      const [go] = pairedDwellTargets(mode);
      expect(single).toEqual(go);
      // Detector x > 0.5 is drawn on the LEFT of the mirrored preview.
      expect(single.x).toBeGreaterThan(0.5);
    }
  });

  it('makes the secondary action a different SIZE, not just a different word', () => {
    for (const mode of ['hand', 'leg'] as const) {
      const [go, back] = pairedDwellTargets(mode);
      expect(back.radius).toBeLessThan(go.radius * 0.85);
    }
  });
});

/* ================= telling the two targets apart ================= */

describe('two targets that mean opposite things', () => {
  const [go, back] = pairedDwellTargets('leg');

  it('renders a different silhouette for each, without being told which is which', () => {
    // Results asks for two targets and names neither: the tone is read off the circle it asked for.
    expect(toneOf({ ...CHOICE, target: go })).toBe('go');
    expect(toneOf({ ...CHOICE, target: back })).toBe('back');
    expect(toneOf({ ...CHOICE, target: go, tone: 'back' })).toBe('back');

    const forward = draw({}, { ...CHOICE, id: 'again', label: 'Play again', target: go });
    expect(forward.dataset.tone).toBe('go');
    expect(forward.querySelector('rect')).toBeNull();
    const backward = draw({}, { ...CHOICE, id: 'new', label: 'New session', target: back });
    expect(backward.dataset.tone).toBe('back');
    // A square backing plate and a second, inner ring: two cues that survive being 1/5 the size.
    expect(backward.querySelector('.dwell-plate')).not.toBeNull();
    expect(backward.querySelector('.dwell-inner')).not.toBeNull();
    expect(forward.querySelector('.dwell-inner')).toBeNull();
  });

  it('carries a tone MARK, so a screenshot at a fifth of the size says which is which', () => {
    // Size tells the two rings apart; it does not say which one carries on. At 1/5 scale the caption
    // is not readable at all, so the difference has to be a shape inside the ring: a double chevron
    // onward, a back-pointing chevron with a tail. It is there in every phase — it is what the ring
    // IS, not what it is doing — and it is drawn well inside the circle that is actually tested.
    const forward = draw({}, { ...CHOICE, target: go });
    const mark = forward.querySelector('[data-mark]');
    expect(mark?.getAttribute('data-mark')).toBe('go');
    expect(mark?.querySelectorAll('path')).toHaveLength(2);
    const backward = draw({ tracked: false }, { ...CHOICE, target: back });
    expect(backward.querySelector('[data-mark]')?.getAttribute('data-mark')).toBe('back');
    // Different SHAPES, not the same shape in two colours.
    const shapes = (el: HTMLElement) =>
      [...el.querySelectorAll('[data-mark] path')].map((p) => p.getAttribute('d')).join('|');
    expect(shapes(forward)).not.toBe(shapes(backward));
  });

  it('draws the secondary visibly smaller', () => {
    const forward = draw({}, { ...CHOICE, target: go });
    const backward = draw({}, { ...CHOICE, target: back });
    expect(Number.parseFloat(backward.style.height)).toBeLessThan(Number.parseFloat(forward.style.height) * 0.85);
  });

  it('says which one it is in the accessible name, not only in the picture', () => {
    draw({}, { ...CHOICE, id: 'new', label: 'New session', target: back });
    expect(screen.getByRole('img').getAttribute('aria-label')).toMatch(/goes back; the smaller circle/);
  });
});

describe('every state says which one it is, and never by colour alone', () => {
  it('nothing tracked: its own glyph, its own dash pattern and words that name the problem', () => {
    const el = draw({ tracked: false, lostSec: 3 });
    expect(el.dataset.phase).toBe('lost');
    expect(el.textContent).toContain('✕');
    expect(el.textContent).toContain('not seeing you');
    expect(el.querySelector('.dwell-track')?.getAttribute('stroke-dasharray')).toBeTruthy();
  });

  it('tracked and waiting: come-in glyph, a solid ring, no arc', () => {
    const el = draw({ tracked: true });
    expect(el.dataset.phase).toBe('enter');
    expect(el.textContent).toContain('hold here');
    expect(el.querySelector('.dwell-track')?.getAttribute('stroke-dasharray')).toBeNull();
    expect(screen.queryByTestId('t-arc')).toBeNull();
  });

  it('holding: the ring carries an arc AND a countdown, so the wait is a number and not a guess', () => {
    const el = draw({ tracked: true, inside: true, withinEntry: true, holding: true, progress: 0.5, remainingSec: 0.9 });
    expect(el.dataset.phase).toBe('holding');
    expect(el.dataset.progress).toBe('0.500');
    expect(el.textContent).toContain('keep holding');
    // Rounded UP: "1" must never sit over a ring that still needs 1.4 s.
    expect(el.textContent).toContain('1');
    const arc = screen.getByTestId('t-arc');
    const circumference = Number(arc.getAttribute('stroke-dasharray'));
    expect(Number(arc.getAttribute('stroke-dashoffset'))).toBeCloseTo(circumference * 0.5, 6);
  });

  it('a ring standing on a limb that lives there says THAT, and says it before the hold states', () => {
    // Not "hold harder" and not "the camera cannot see you": the two things a patient could do about
    // those are both useless here. The ring is on top of a limb that lives there, nothing it does can
    // count, and the layout is moving it. It has its own glyph and its own dash pattern, like every
    // other state, because this is drawn for a patient at two metres with the vision they have.
    const el = draw({ tracked: true, inside: true, withinEntry: true, blocked: 'occupied', progress: 0.4 });
    expect(el.dataset.phase).toBe('occupied');
    expect(el.textContent).toContain('⊘');
    expect(el.textContent).toContain('a limb rests here');
    expect(el.querySelector('.dwell-track')?.getAttribute('stroke-dasharray')).toBeTruthy();
    // …and it does not read as a hold in progress, whatever progress has not decayed away yet.
    expect(el.textContent).not.toContain('keep holding');
    // A limb that is not being tracked at all is still "not seeing you" first: a target cannot be
    // said to be standing on a limb the camera is not reporting.
    expect(draw({ tracked: false, blocked: 'occupied' }).dataset.phase).toBe('lost');
  });

  it('a limb already parked in the target is told to move out and back, not left with a dead ring', () => {
    const el = draw({ tracked: true, inside: true, withinEntry: true, blocked: 'entry' });
    expect(el.dataset.phase).toBe('reenter');
    expect(el.textContent).toContain('move out, then back');
  });

  it('just confirmed: a tick, and no half-filled ring left over from the answered question', () => {
    const el = draw({ tracked: true, inside: true, blocked: 'refractory', progress: 0 });
    expect(el.dataset.phase).toBe('done');
    expect(el.textContent).toContain('✓');
    expect(screen.queryByTestId('t-arc')).toBeNull();
  });

  it('a target that is not available yet says so instead of pretending to be holdable', () => {
    const el = draw(null, { ...CHOICE, enabled: false, disabledNote: 'Not yet' });
    expect(el.dataset.phase).toBe('off');
    expect(el.textContent).toContain('Not yet');
    expect(el.textContent).toContain('not available yet');
    expect(screen.queryByTestId('t-arc')).toBeNull();
  });

  it('the accessible name carries the action and the state together', () => {
    draw({ tracked: false });
    expect(screen.getByRole('img').getAttribute('aria-label')).toMatch(/^Continue \(.*\): not seeing you$/);
  });

  it('publishes the circle it was MEASURED against for a harness to aim at', () => {
    const authored = singleDwellTarget('leg');
    const circle = retargetForAspect(authored, 16 / 9);
    cleanup();
    render(<DwellTarget choice={{ ...CHOICE, target: authored }} state={state({ target: circle, xScale: 16 / 9 })} testId="t" />);
    const el = screen.getByTestId('t');
    expect(Number(el.dataset.dwellX)).toBeCloseTo(circle.x, 6);
    expect(Number(el.dataset.dwellY)).toBe(circle.y);
    expect(Number(el.dataset.dwellRadius)).toBe(circle.radius);
    expect(Number(el.dataset.dwellXscale)).toBeCloseTo(16 / 9, 6);
  });
});

describe('dwellCircleFits', () => {
  // The placement solver asks this before it moves a ring anywhere, so it has to agree with the
  // component: the same crop, the same viewBox, the same caption flip at the half-way line.
  it('agrees with what the component actually lays out, at every aspect', () => {
    for (const aspect of ASPECTS) {
      for (const y of [0.05, 0.12, 0.2, 0.35, 0.5, 0.62, 0.8, 0.95]) {
        for (const x of [0.08, 0.2, 0.5, 0.8, 0.94]) {
          const circle = { x, y, radius: 0.115 };
          cleanup();
          render(<DwellTarget choice={{ ...CHOICE, target: circle }} state={state({ target: circle, xScale: aspect })} testId="t" />);
          const el = screen.getByTestId('t');
          const h = Number.parseFloat(el.style.height);
          const off = Number.parseFloat(/-([\d.]+)%\)$/.exec(el.style.transform)?.[1] ?? '0');
          const top = Number.parseFloat(el.style.top) - (off / 100) * h;
          const widthPct = ((h / 100) * (140 / 176) / PREVIEW_ASPECT) * 100;
          // `left` is the MIRRORED position; the fit is symmetric, so measure it on the drawn one.
          const leftPct = Number.parseFloat(el.style.left) - widthPct / 2;
          const drawnWhole = top > 0 && top + h < 100 && leftPct > 0 && leftPct + widthPct < 100;
          expect(dwellCircleFits(circle, aspect), `${x},${y} @${aspect.toFixed(2)}`).toBe(drawnWhole);
        }
      }
    }
  });

  it('refuses a circle it cannot compute a placement for', () => {
    expect(dwellCircleFits({ x: 0.5, y: 0.5, radius: 0.115 }, Number.NaN)).toBe(true); // falls back to 4:3
    expect(dwellCircleFits({ x: 0.5, y: 0.5, radius: 0.9 }, PREVIEW_ASPECT)).toBe(false);
  });
});

describe('reducedMotion', () => {
  it('stills the ring without taking away the arc — the arc is the measurement, not decoration', () => {
    const el = draw({ tracked: true, inside: true, holding: true, progress: 0.4 }, CHOICE, true);
    expect(el.className).toContain('still');
    expect(screen.getByTestId('t-arc')).toBeTruthy();
  });

  it('leaves it animated when the setting is off', () => {
    expect(draw({ tracked: true }).className).not.toContain('still');
  });
});

/* ================= the frame rate the device actually has ================= */

describe('dwellCadence', () => {
  it('a 30 fps camera gets exactly the timings that were hard-coded before', () => {
    const c = dwellCadence(1 / 30);
    expect(c.staleSec).toBe(0.2);
    expect(c.graceSec).toBe(0.4);
    expect(c.maxStepSec).toBe(0.25);
  });

  it('a 4 fps camera gets a window wider than its own frame interval', () => {
    // The bug this exists for: at 0.2 s flat, every gap between two working frames was a stall, so the
    // watchdog fed the trackers nothing and the legend announced a camera that had gone.
    const c = dwellCadence(0.25);
    expect(c.staleSec).toBeGreaterThan(0.25);
    expect(c.graceSec).toBeGreaterThan(0.25);
    expect(c.maxStepSec).toBeGreaterThanOrEqual(0.25);
  });

  it('still calls a camera that has really stopped stopped, within a second and a half', () => {
    const c = dwellCadence(10);
    expect(c.staleSec).toBeLessThanOrEqual(1.2);
    expect(c.graceSec).toBeLessThanOrEqual(2);
  });

  it('survives a device that has not said anything yet', () => {
    expect(dwellCadence(0)).toEqual(dwellCadence(1 / 30));
    expect(dwellCadence(Number.NaN)).toEqual(dwellCadence(1 / 30));
  });
});

/* ================= the sentence beside the preview ================= */

function session(over: Partial<DwellSession> = {}): DwellSession {
  // A session with a tracker in it: the legend distinguishes "no frames", "nothing to confirm yet"
  // (no live trackers) and "here is what to hold", and the first two have their own tests below.
  return { states: { go: state() }, limb: null, live: true, xScale: PREVIEW_ASPECT, frameIntervalSec: 1 / 30, ...over };
}

describe('DwellLegend', () => {
  it('names the limb it is following, because a patient cannot otherwise tell which one it is watching', () => {
    cleanup();
    render(
      <DwellLegend
        session={session({ limb: { point: { x: 0.3, y: 0.3 }, side: 'right', label: 'your right hand', key: 'hand:right', scale: null } })}
        what="the circle to go on"
      />,
    );
    expect(screen.getByTestId('dwell-legend-limb').textContent).toBe('Following your right hand');
    // The point of accepting either side: the affected limb cannot be asked to hold still for 2 s.
    expect(screen.getByTestId('dwell-legend').textContent).toMatch(/Either side may do this, including the unaffected one/);
  });

  it('says a hand is unidentified rather than guessing which one it is', () => {
    cleanup();
    render(
      <DwellLegend session={session({ limb: { point: { x: 0.3, y: 0.3 }, side: null, label: 'a hand', key: 'hand:#1', scale: null } })} what="x" />,
    );
    expect(screen.getByTestId('dwell-legend-limb').textContent).toBe('Following a hand');
    expect(screen.getByTestId('dwell-legend-unidentified').textContent).toMatch(/cannot be told from the camera/);
  });

  it('with nothing in view it says so, and does not claim a limb', () => {
    cleanup();
    render(<DwellLegend session={session()} what="x" />);
    expect(screen.getByTestId('dwell-legend').dataset.state).toBe('searching');
    expect(screen.getByTestId('dwell-legend-limb').textContent).toMatch(/No hand/);
  });

  it('asks for a hand in both modes, and says WHY a knee cannot answer in leg mode', () => {
    // The claim has to match `dwellLimbs`, which stopped returning knees: a patient told to hold a
    // knee in the circle would be holding it against a ring that cannot see it. And the reason is
    // worth a sentence — it is the same reason their march is not a confirm.
    useStore.getState().setMode('leg');
    cleanup();
    render(<DwellLegend session={session()} what="x" />);
    const leg = screen.getByTestId('dwell-legend');
    expect(leg.textContent).toMatch(/Move a hand into the circle/);
    expect(leg.textContent).not.toMatch(/a hand or a knee/);
    expect(screen.getByTestId('dwell-legend-limbs').textContent).toMatch(/your knees are doing the exercise/);
    useStore.getState().setMode('hand');
    cleanup();
    render(<DwellLegend session={session()} what="x" />);
    const el = screen.getByTestId('dwell-legend');
    expect(el.textContent).not.toMatch(/knee/);
    expect(el.textContent).toMatch(/a hand/);
    useStore.getState().setMode('leg');
  });

  it('agrees with the rings: when they say "move out, then back", so does it', () => {
    // Two contradictory instructions, one of them in 16 px type, is how the last version read: the big
    // sentence said "put the limb inside the circle and keep it there" beside a ring that could not
    // start until the limb had left.
    cleanup();
    render(<DwellLegend session={session({ states: { go: state({ blocked: 'entry', inside: true, tracked: true }) } })} what="x" />);
    const el = screen.getByTestId('dwell-legend');
    expect(el.dataset.state).toBe('reenter');
    expect(el.textContent).toMatch(/move it out, then back in/);
    expect(el.textContent).not.toMatch(/Move .* into the circle and keep it/);
  });

  it('when every ring is standing on a limb it says so, instead of telling the patient to hold', () => {
    // "Move a hand into the circle and keep it there" beside a ring that cannot count anything is an
    // instruction that cannot be followed. The rings are moving themselves; the sentence says that,
    // and says what to do if they cannot find room.
    cleanup();
    render(<DwellLegend session={session({ states: { go: state({ blocked: 'occupied', tracked: true }) } })} what="x" />);
    const el = screen.getByTestId('dwell-legend');
    expect(el.dataset.state).toBe('occupied');
    expect(el.textContent).toMatch(/on top of/);
    expect(el.textContent).toMatch(/moving itself somewhere clear/);
    expect(el.textContent).toMatch(/the buttons still work/i);
    expect(el.textContent).not.toMatch(/Move a hand into the circle and keep it/);
  });

  it('says a slow camera is slow, rather than letting the ring look broken', () => {
    cleanup();
    render(<DwellLegend session={session({ frameIntervalSec: 0.25 })} what="x" />);
    const slow = screen.getByTestId('dwell-legend-slow').textContent ?? '';
    expect(slow).toMatch(/about 4 frames a second/);
    // At 4 fps the hold still takes the time the ring says, and the legend may say so.
    expect(slow).toMatch(/same time to fill/);
    cleanup();
    render(<DwellLegend session={session({ frameIntervalSec: 1 / 30 })} what="x" />);
    expect(screen.queryByTestId('dwell-legend-slow')).toBeNull();
  });

  it('…and stops promising the countdown once the camera is slower than the ring can count', () => {
    // Below about 1.7 frames a second the step cap bites: the ring fills as the frames arrive, which
    // is slower than the number inside it. Saying "it still takes the same time" there would be a lie.
    cleanup();
    render(<DwellLegend session={session({ frameIntervalSec: 1.0 })} what="x" />);
    const slow = screen.getByTestId('dwell-legend-slow').textContent ?? '';
    expect(slow).toMatch(/about 1 frame a second/);
    expect(slow).not.toMatch(/same time to fill/);
    expect(slow).toMatch(/longer than the countdown/);
  });

  it('with frames arriving but nothing confirmable, it says THAT rather than blaming the camera', () => {
    // The camera-check readiness gate, or a range that has not been measured yet. Saying "no camera
    // frames are arriving" over a preview the patient can plainly see working is a plain untruth.
    cleanup();
    render(<DwellLegend session={session({ states: {} })} what="x" />);
    const el = screen.getByTestId('dwell-legend');
    expect(el.dataset.state).toBe('waiting');
    expect(el.textContent).toMatch(/Nothing to confirm yet/);
    expect(el.textContent).not.toMatch(/No camera frames/);
  });

  it('with no frames arriving it refuses to offer a hands-free path at all', () => {
    // The honest failure: a camera that has stalled cannot be held over, and a ring that sits there
    // implying it can is the promise this app is not allowed to make.
    cleanup();
    render(<DwellLegend session={session({ live: false })} what="x" />);
    const el = screen.getByTestId('dwell-legend');
    expect(el.dataset.state).toBe('offline');
    expect(el.textContent).toMatch(/Hands-free is not available right now/);
    expect(el.textContent).toMatch(/Use the buttons/);
  });
});
