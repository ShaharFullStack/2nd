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
  DWELL_CLEAR_MARGIN,
  DWELL_DEFAULTS,
  DWELL_LIMB_REACH,
  DWELL_MAX_REACH,
  DwellCoupling,
  DwellEngagement,
  DwellHabitat,
  DwellLayout,
  DwellTracker,
  dwellAxisFor,
  dwellDistance,
  dwellLimbs,
  dwellOrigin,
  dwellPlaceable,
  dwellReferences,
  dwellTargetClear,
  dwellTargetsOverlap,
  dwellWithinLimbReach,
  pickDwellLimb,
  placeDwellCircle,
  retargetForAspect,
} from '../vision/dwell.ts';
import type { DwellCircle, DwellHabitatSummary, DwellPoint, DwellState } from '../vision/dwell.ts';
import {
  SEATED_HAND_RESTS,
  SEATED_HAND_SUPPORTS,
  handPose,
  mirrorPoseLandmarks,
  reNormalizeAspect,
  seatedHandsOutOfView,
  seatedPose,
  translateLandmarks,
} from '../vision/fixtures.ts';
import type { SeatedHandRest } from '../vision/fixtures.ts';
import type { DetectionResult } from '../vision/mediapipe.ts';
import type { LaneSpec, Mode, Side } from '../engine/types.ts';
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
/** The hook's watchdog interval (DwellTarget.tsx `WATCHDOG_MS`), in seconds: the survey cadence. */
const WATCHDOG_SEC = 0.08;

/**
 * A REPETITION AS A PATIENT PERFORMS ONE. The critic's profile: a 4 s rise, 1.5 s held at the top and a
 * 3 s descent, which is a hemiparetic pace and slower than anything this app paces (the ROM screen
 * gives no pace at all — "Lift your knee as high as is comfortable, lower it" — and the chart's lane
 * spacing is 1.2 s). The brisk profile is the other end of the same instruction.
 */
const SLOW_REP = { riseSec: 4, holdSec: 1.5, fallSec: 3 };
const BRISK_REP = { riseSec: 0.5, holdSec: 0.2, fallSec: 0.5 };
/**
 * THE CRITIC'S OWN DUTY CYCLE: 2 s up, 2.5 s at the top, 2 s down, 10 s of rest. It is the profile that
 * confirmed the primary circle at t = 3.23 s with a hand on the thigh — the long hold at the top is
 * what fills a ring, and the long rest is what makes the excursion a small enough minority of the
 * habitat window to leave the order statistics where they were.
 */
const CRITIC_REP = { riseSec: 2, holdSec: 2.5, fallSec: 2, restSec: 10 };

function repAmount(t: number, profile: { riseSec: number; holdSec: number; fallSec: number; restSec?: number }): number {
  const rest = profile.restSec ?? 0.8;
  const span = profile.riseSec + profile.holdSec + profile.fallSec;
  const cycle = ((t % (span + rest)) + span + rest) % (span + rest);
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
  /**
   * Frames on which a ring was STOOD DOWN because the limb it follows is moving with the exercise —
   * which only happens when there is no other limb to follow.
   */
  coupledFrames: number;
  /**
   * Frames on which the coupling gate refused SOME limb, whether or not that cost the screen its
   * pointer. With two hands in the picture the gate usually shows up as the pick moving to the other
   * hand rather than as a stood-down ring, and a sweep that only counted stand-downs would read a
   * working gate as an absent one.
   */
  refusedFrames: number;
  /** Whichever limb the coupling gate refused, and the movement it was following. */
  coupledBy: string | null;
  /** Every circle the layout ever put a ring at, so a test can bound where one may be relocated to. */
  visited: DwellCircle[];
  /** When the first confirm happened, in seconds — Infinity when nothing ever confirmed. */
  firstConfirmSec: number;
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
  /**
   * One frame of the patient. `circles` is where the rings ARE at that instant, because the layout
   * moves them: a test that aimed a hand at the AUTHORED position would be aiming at a ring that is no
   * longer there, and would "prove" that a deliberate hold does not work. The harnesses read the same
   * thing off `data-dwell-x/y` for the same reason.
   */
  frame: (t: number, circles: DwellCircle[]) => DetectionResult;
  fps?: number;
  mirrored?: boolean;
  /** The prescription in force, so the coupling gate correlates against the lane features it would. */
  lanes?: LaneSpec[];
  /**
   * TAKE THE COUPLING GATE OUT — the app as it was before this round. Only one test passes it, and it
   * is the one that proves the sweep below can actually fail: a proof whose negative control is not
   * run is a proof that the variable under test was pinned, which is how this feature was lost three
   * times.
   */
  withoutCouplingGate?: boolean;
}): DriveOutcome {
  const { mode, aspect, authored, seconds, frame } = opts;
  const fps = opts.fps ?? FPS;
  const mirrored = opts.mirrored ?? false;
  const ids = authored.map((_, i) => `t${i}`);
  const habitat = new DwellHabitat();
  const coupling = new DwellCoupling();
  const engagement = new DwellEngagement();
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
  const out: DriveOutcome = {
    confirms: 0,
    standDowns: 0,
    moves: 0,
    maxProgress: 0,
    tracked: 0,
    frames: 0,
    finalClear: [],
    unplaceable: false,
    coupledFrames: 0,
    coupledBy: null,
    refusedFrames: 0,
    visited: layout.circles(),
    firstConfirmSec: Infinity,
  };
  let summaries = habitat.all(0, aspect);
  let occupied = new Map<string, boolean>();
  // THE HOOK SURVEYS ON ITS WATCHDOG, NOT ON EVERY FRAME (`WATCHDOG_MS` = 80 ms), so a fast camera
  // does not re-measure the layout four times between two decisions and a slow one is not surveyed
  // less often than the patient moves. Driving the survey once per frame here would be a different
  // program from the one that ships — and the frame rate is one of the variables under test.
  let lastSurvey = -Infinity;

  for (let i = 0; i <= Math.round(seconds * fps); i++) {
    const t = i / fps;
    const detection = frame(t, layout.circles());
    const limbs = dwellLimbs(detection, mode, mirrored, aspect);
    const references = dwellReferences(detection, mode, { lanes: opts.lanes, mirrored, xScale: aspect });
    const origin = dwellOrigin(detection);
    let busy = false;
    for (const tracker of trackers.values()) {
      const st = tracker.state;
      if (st.progress > 0 || st.blocked === 'refractory') busy = true;
    }
    // The same two rules the hook applies. The HABITAT leaves out a hold and the frames around it (a
    // reach must not teach it that the limb lives on the ring), bounded in time by `DwellEngagement`
    // because a limb still there three seconds later is not answering. The COUPLING record takes every
    // frame: leaving out the engaged ones starved it of the rise that carries the hand into the ring.
    for (const l of limbs) coupling.noteOne(l.key, l.point, references, t, aspect, origin);
    if (busy) engagement.noteAnswering(t);
    const carried = opts.withoutCouplingGate ? new Set<string>() : coupling.coupledKeys(t);
    {
      // Per limb, exactly as the hook does it: a blanket "somebody is answering, record nothing"
      // silences the record for the limbs the gate most needs to know about.
      const engagedCounts = dwellAxisFor(mode) === 'radial';
      for (const l of limbs) {
        // A limb the exercise is carrying is not living anywhere: its travel belongs to the exercise,
        // and recording it made every ring unplaceable for twenty seconds (see the note in the hook).
        if (carried.has(l.key)) continue;
        if (engagedCounts && engagement.gesture(l.key, l.point, layout.circles(), t, aspect, DWELL_DEFAULTS.exitRatio)) continue;
        habitat.noteOne(l.key, l.point, t, l.scale ?? null);
      }
    }
    summaries = habitat.all(t, aspect);
    if (t - lastSurvey >= WATCHDOG_SEC - 1e-9) {
      lastSurvey = t;
      const survey = layout.survey(summaries, t, busy);
      occupied = survey.occupied;
      out.unplaceable = [...survey.placeable.values()].some((ok) => !ok);
      if (survey.moved) {
        out.moves += 1;
        for (const [id, tracker] of trackers) tracker.setTarget(layout.circleFor(id) as DwellCircle, aspect);
        out.visited = [...out.visited, ...layout.circles()];
      }
    }
    for (const [id, tracker] of trackers) tracker.setOccupied(occupied.get(id) === true);
    if (carried.size > 0) {
      out.refusedFrames += 1;
      for (const key of carried) {
        const v = coupling.verdict(key, t);
        if (v) out.coupledBy = `${key} follows ${v.reference} (r2 ${v.r2.toFixed(2)}, ${v.explained.toFixed(3)} explained)`;
      }
    }
    const limb = pickDwellLimb(limbs, layout.circles(), { xScale: aspect, previous, previousKey, avoid: carried });
    const verdict = limb && carried.has(limb.key) ? coupling.verdict(limb.key, t) : null;
    for (const tracker of trackers.values()) tracker.setCoupled(verdict !== null);
    out.frames += 1;
    if (limb) out.tracked += 1;
    previous = limb?.point ?? null;
    previousKey = limb?.key ?? null;
    for (const tracker of trackers.values()) {
      const state = tracker.update(limb?.point ?? null, t, limb?.key ?? null);
      if (state.confirmed) {
        out.confirms += 1;
        out.firstConfirmSec = Math.min(out.firstConfirmSec, t);
      }
      if (state.blocked === 'occupied') out.standDowns += 1;
      if (state.blocked === 'coupled') out.coupledFrames += 1;
      out.maxProgress = Math.max(out.maxProgress, state.progress);
    }
  }
  out.finalClear = layout.circles().map((c) => dwellTargetClear(c, summaries, clearOpts).clear);
  return out;
}

/* ---------------- the bodies the pipeline is driven with ---------------- */

const LEG_MOVEMENTS = ['seated_march', 'knee_extension', 'ankle_dorsiflexion', 'hip_abduction'] as const;
const HAND_MOVEMENTS = ['hand_open_close', 'wrist_extension', 'finger_opposition', 'finger_spread'] as const;

/**
 * Where a seated patient's hands are while their LEGS are working — AND WHAT IS HOLDING THEM UP.
 *
 * THIS ARRAY USED TO BE THE BUG IN THIS FILE. It listed four world-fixed points and `legFrame` wrote
 * them straight into the wrist landmarks, with a y that did not depend on `amount` at all: the sweep
 * varied movement, side, pace, compensation, aspect and rest position and HARD-CODED THE ONE QUANTITY
 * UNDER TEST. Worse, the "thigh" hand was listed at y 0.62 against hips at y 0.60 — a hand at the HIP,
 * the single point on the thigh that a hip flexion does not move.
 *
 * So the positions and the supports now come from the shipping rig (`SEATED_HAND_RESTS`,
 * `SEATED_HAND_SUPPORTS`), which carries a thigh-resting hand with the thigh, and `legFrame` no longer
 * writes wrists at all.
 */
const HAND_RESTS: Array<{ what: string; rest: SeatedHandRest; left: DwellPoint; right: DwellPoint }> = [
  { what: 'in the lap (on the proximal thighs)', rest: 'lap', ...SEATED_HAND_RESTS.lap },
  { what: 'on the thighs', rest: 'thighs', ...SEATED_HAND_RESTS.thighs },
  { what: 'on chair arms, high', rest: 'chair_arms', ...SEATED_HAND_RESTS.chair_arms },
  { what: 'folded, near the midline', rest: 'folded', ...SEATED_HAND_RESTS.folded },
];

/** Where along the hip->knee segment a thigh-resting hand is put, when the sweep varies it. */
const THIGH_FRACTIONS = [0.7, 0.85, 1];

/**
 * One frame of a seated patient performing `movement` at `amount`, with the documented compensations,
 * and with their hands where a seated patient's hands are — CARRIED BY WHATEVER IS HOLDING THEM.
 *
 * `hand` puts ONE hand at an explicit point (the reach that IS the gesture); everything else is the
 * rig's own arms, so a hand on the thigh rises with the knee and a hand on the chair arm does not.
 */
function legFrame(opts: {
  movement: (typeof LEG_MOVEMENTS)[number];
  side: Side;
  amount: number;
  compensation: 'none' | 'circumduction' | 'trunk lean' | 'heel lift';
  /** Which support the resting hands are on (default: the thighs, the worst case and the common one). */
  rest?: SeatedHandRest | 'out_of_view';
  /** One hand out of the picture: a patient with only ONE hand the camera can see. */
  hideHand?: Side;
  /** How far along the thigh a thigh-supported hand sits (default: the rest position's own fraction). */
  thighFraction?: number;
  /** One hand raised to a point, and which one. */
  hand?: { side: Side; x: number; y: number } | null;
  /**
   * Hip circumduction as an explicit amount, so a sweep can vary HOW MUCH of it there is rather than
   * only whether it is there (`compensation: 'circumduction'` ties it to the rep amount). It swings the
   * knee out — and, through the thigh, any hand resting on it.
   */
  circumduction?: number;
  aspect: number;
  dx?: number;
  dy?: number;
  /**
   * The frames were flipped BEFORE detection (`mirrored: true`), which is what the app's own mirror
   * toggle does. It swaps the LABELS as well as the coordinates, so the patient's left limb arrives in
   * the RIGHT_* slots — the half of mirroring that a sign flip alone cannot catch.
   */
  mirror?: boolean;
}): DetectionResult {
  const { movement, side, amount, compensation, aspect } = opts;
  const params: Record<string, unknown> = { side, hands: opts.rest ?? 'thighs' };
  if (opts.thighFraction !== undefined) params.handThighFraction = opts.thighFraction;
  if (opts.hideHand) params.hideHand = opts.hideHand;
  if (opts.hand) params.handAt = opts.hand;
  if (movement === 'seated_march') params.kneeLift = amount;
  if (movement === 'knee_extension') params.kneeExtension = amount;
  if (movement === 'ankle_dorsiflexion') params.toeLift = amount;
  if (movement === 'hip_abduction') params.abduction = amount;
  // The compensations this app exists to OBSERVE and promises never to penalise. Hip circumduction
  // carries the knee sideways as it rises, which is what put it inside a dwell circle in the first
  // place — and, through the thigh, carries a hand resting on it too.
  if (compensation === 'circumduction') params.abduction = ((params.abduction as number) ?? 0) + amount;
  if (opts.circumduction !== undefined) params.abduction = ((params.abduction as number) ?? 0) + opts.circumduction;
  if (compensation === 'trunk lean') params.trunkLean = amount;
  if (compensation === 'heel lift') params.heelLift = amount;
  const built = translateLandmarks(seatedPose(params as Parameters<typeof seatedPose>[0]), opts.dx ?? 0, opts.dy ?? 0);
  const pose = opts.mirror ? mirrorPoseLandmarks(built) : built;
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
                // WHERE ALONG THE THIGH the hand sits, for the rests a thigh is holding up. The
                // critic found this non-monotonic in f (a hand mid-thigh escaping where a hand at the
                // knee did not), so it is swept rather than spot-checked.
                const fractions = SEATED_HAND_SUPPORTS[rest.rest].support === 'thigh' ? THIGH_FRACTIONS : [undefined];
                for (const thighFraction of fractions) {
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
                        rest: rest.rest,
                        thighFraction,
                        aspect,
                      }),
                  });
                  if (outcome.tracked < outcome.frames * 0.9) {
                    failures.push(`${movement}/${side} @${aspect.toFixed(2)}: nothing was being tracked — the case proves nothing`);
                  }
                  if (outcome.confirms > 0) {
                    failures.push(
                      `${movement}/${side} @${aspect.toFixed(2)}, ${compensation}, hands ${rest.what}` +
                        `${thighFraction === undefined ? '' : ` f=${thighFraction}`}, ` +
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
    }
    expect(runs).toBeGreaterThan(300);
    expect(failures.join('\n')).toBe('');
  }, 120_000);

  /**
   * THE THIRD ROUND'S DEFECT, DRIVEN AS THE CRITIC DROVE IT, AND WITH ITS NEGATIVE CONTROL.
   *
   * Rounds one and two removed the knee as a pointer on the premise that "the leg prescription does not
   * move the hands". A hand resting on the THIGH is carried by the thigh: hip flexion rotates the thigh
   * about the hip, so a hand at fraction f along the hip->knee segment rises by f x the knee's travel,
   * and circumduction swings it sideways at the same time. Driven through these same shipping classes,
   * the primary circle confirmed at t = 3.23 s (left march, circumduction, f = 1.0) and the SECONDARY —
   * which on the pause dialog is `id: 'end'` -> quit -> a truncated record in the patient's history —
   * at t = 3.30 s. 90 of a 324-case duty-cycle sweep confirmed, at every frame rate, in both aspects,
   * mirrored and not, on the first repetition every time.
   *
   * The failure was NON-MONOTONIC in f and in the frame rate (the right side at f = 0.85 confirmed at
   * 12 fps where f = 1.0 did not), so this sweeps rather than spot-checks: f, side, the amount of
   * circumduction, four frame rates, three aspects, and both mirror conventions — with the critic's own
   * 2 / 2.5 / 2 / 10 s duty cycle and the app's own 80 ms survey cadence.
   */
  it('A HAND ON THE THIGH CANNOT ANSWER: the critic’s attack, swept, confirms nothing', () => {
    const failures: string[] = [];
    let runs = 0;
    let caught = 0;
    let stoodDown = 0;
    let oneHanded = 0;
    for (const aspect of ASPECTS) {
      for (const side of ['left', 'right'] as Side[]) {
        for (const f of THIGH_FRACTIONS) {
          for (const circumduction of [0.5, 1]) {
            for (const fps of [12, 15, 24, 30]) {
              for (const mirror of [false, true]) {
                // …and WITH OR WITHOUT A SECOND HAND TO FALL BACK ON. Two hands and the gate shows up
                // as the pick moving to the one the exercise is not carrying; ONE hand (the other out
                // of the picture, which is a framing the camera check has to warn about and cannot
                // prevent) and there is nothing to fall back on, so the rings must stand down instead.
                for (const only of [false, true]) {
                  runs += 1;
                  const outcome = drive({
                    mode: 'leg',
                    aspect,
                    fps,
                    mirrored: mirror,
                    authored: pairedDwellTargets('leg'),
                    seconds: 20,
                    lanes: [{ index: 0, movement: 'seated_march', side }],
                    frame: (t) => {
                      const amount = repAmount(t, CRITIC_REP);
                      return legFrame({
                        movement: 'seated_march',
                        side,
                        amount,
                        compensation: 'none',
                        // The circumduction is applied directly so its AMOUNT can be swept: the knee
                        // swings out by `circumduction` x the lift, carrying the hand with it.
                        rest: 'thighs',
                        thighFraction: f,
                        hideHand: only ? (side === 'left' ? 'right' : 'left') : undefined,
                        aspect,
                        mirror,
                        circumduction: circumduction * amount,
                      });
                    },
                  });
                  const where = `${side} march, circ ${circumduction}, f=${f}, ${fps} fps, @${aspect.toFixed(2)}${mirror ? ', mirrored' : ''}${only ? ', that hand only' : ''}`;
                  if (outcome.tracked < outcome.frames * 0.9) failures.push(`${where}: nothing was being tracked — the case proves nothing`);
                  if (outcome.confirms > 0) failures.push(`${where}: ${outcome.confirms} confirm(s), ring reached ${(outcome.maxProgress * 100).toFixed(0)}%`);
                  // …and it is the COUPLING MEASUREMENT that stops it, not luck about where the rings
                  // ended up: the hand is measured travelling with the prescribed movement, and
                  // refused as a pointer.
                  if (outcome.refusedFrames > 0) caught += 1;
                  if (only) {
                    oneHanded += 1;
                    // With no other limb to follow, the ring stands down and says why (phase
                    // 'coupled'), rather than quietly following a limb it will not count.
                    if (outcome.coupledFrames > 0) stoodDown += 1;
                  }
                }
              }
            }
          }
        }
      }
    }
    expect(runs).toBeGreaterThan(560);
    expect(failures.join('\n')).toBe('');
    // Every single case is caught by the measurement, in every framing and at every frame rate.
    expect(caught).toBe(runs);
    // And in every one-handed case the patient is TOLD, instead of being left with a dead ring.
    expect(stoodDown).toBe(oneHanded);
  }, 600_000);

  it('…and WITHOUT the coupling gate the same attack confirms, so the sweep above can fail', () => {
    /**
     * THE NEGATIVE CONTROL, which is the whole reason this round exists: three times running, the test
     * that was supposed to prove this feature safe had pinned the variable under test, and passed. So
     * the gate is switched off here and the same body is driven through the same classes. If this ever
     * stops confirming, the sweep above has stopped being evidence and something else is holding it up.
     */
    const attack = (withoutCouplingGate: boolean, f = 1, fps = 30) =>
      drive({
        mode: 'leg',
        aspect: PREVIEW_ASPECT,
        fps,
        authored: pairedDwellTargets('leg'),
        seconds: 20,
        lanes: [{ index: 0, movement: 'seated_march', side: 'left' }],
        withoutCouplingGate,
        frame: (t) => {
          const amount = repAmount(t, CRITIC_REP);
          return legFrame({
            movement: 'seated_march',
            side: 'left',
            amount,
            compensation: 'none',
            rest: 'thighs',
            thighFraction: f,
            aspect: PREVIEW_ASPECT,
            circumduction: amount,
          });
        },
      });
    const unguarded = attack(true);
    expect(unguarded.confirms).toBeGreaterThanOrEqual(1);
    // …ON THE FIRST REPETITION, which is what made it a shipping defect rather than a curiosity: the
    // rise is 2 s and the top is held for 2.5 s, so the ring is full before the leg comes back down.
    expect(unguarded.firstConfirmSec).toBeLessThan(CRITIC_REP.riseSec + CRITIC_REP.holdSec + CRITIC_REP.fallSec);
    const guarded = attack(false);
    expect(guarded.confirms).toBe(0);
    expect(guarded.refusedFrames).toBeGreaterThan(0);
    // And the verdict names what the hand was following, so the screen can say something true.
    expect(guarded.coupledBy).toMatch(/hand:left follows/);
  });

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
                legFrame({ movement: 'seated_march', side: 'left', amount: 0, compensation: 'none', rest: rest.rest, aspect, dx, dy }),
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
    /**
     * 1. A leg-mode hand resting at (0.70, 0.45) — a high chair arm — used to sit 0.1327 from the
     *    primary centre against an exit radius of 0.1438: inside the hysteresis band, so the layout had
     *    to move the ring on every leg-mode screen for the support the app itself asks for. That is now
     *    fixed at the source: the authored position (0.78, 0.23) CLEARS that hand, band and margin
     *    included, which is what let the ring grow to a size a patient can see.
     */
    const legTarget = singleDwellTarget('leg');
    const oldPlacement = { x: 0.72, y: 0.32, radius: 0.115 };
    expect(dwellDistance({ x: 0.7, y: 0.45 }, oldPlacement, PREVIEW_ASPECT)).toBeCloseTo(0.1327, 3);
    expect(dwellDistance({ x: 0.7, y: 0.45 }, oldPlacement, PREVIEW_ASPECT)).toBeLessThan(oldPlacement.radius * DWELL_DEFAULTS.exitRatio);
    const now = dwellDistance({ x: 0.7, y: 0.45 }, legTarget, PREVIEW_ASPECT);
    expect(now).toBeGreaterThan(legTarget.radius * DWELL_DEFAULTS.exitRatio + DWELL_CLEAR_MARGIN);
    // What the band is and is not: a limb may WOBBLE through it, and may not LIVE in it. A hand that
    // rests there, leaves (which opens the entry gate), and comes back to exactly the same place —
    // the worst version of this, and the one that shipped once — cannot fill the ring: the band clock
    // stops the hold within `bandGraceSec`, and a hold may only ever COMPLETE inside the drawn circle.
    /**
     * A hand that rests IN THE BAND — outside the drawn circle, inside the hysteresis — leaves (which
     * opens the entry gate) and comes back to exactly the same place. The worst version of the escape,
     * and the one that shipped once. It cannot fill the ring: the band clock stops the hold within
     * `bandGraceSec`, a hold may only ever COMPLETE inside the drawn circle, and the habitat learns
     * that a limb lives there and moves the ring off it.
     */
    const band = (c: DwellCircle) => {
      // 0.19 from the centre: past the radius (0.15), inside the band (0.15 x 1.25 + 0.03 = 0.2175).
      const d = 0.19;
      return { x: c.x - (d * 0.6) / PREVIEW_ASPECT, y: c.y + d * 0.8 };
    };
    const legs = drive({
      mode: 'leg',
      aspect: PREVIEW_ASPECT,
      authored: pairedDwellTargets('leg'),
      seconds: 30,
      frame: (t) => {
        const home = band(singleDwellTarget('leg'));
        const away = t % 5.5 >= 4;
        const left = away ? { x: 0.55, y: 0.72 } : home;
        return legFrame({
          movement: 'seated_march',
          side: 'left',
          amount: 0,
          compensation: 'none',
          rest: 'chair_arms',
          hand: { side: 'left', ...left },
          aspect: PREVIEW_ASPECT,
        });
      },
    });
    expect(dwellDistance(band(singleDwellTarget('leg')), singleDwellTarget('leg'), PREVIEW_ASPECT)).toBeGreaterThan(
      singleDwellTarget('leg').radius,
    );
    expect(dwellDistance(band(singleDwellTarget('leg')), singleDwellTarget('leg'), PREVIEW_ASPECT)).toBeLessThan(
      singleDwellTarget('leg').radius * DWELL_DEFAULTS.exitRatio + DWELL_CLEAR_MARGIN,
    );
    expect(legs.confirms).toBe(0);
    // …and the ring does not sit there dead either: it is stood down and then moved somewhere clear.
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

  it('THE RESIDUAL, STATED: a hand INSIDE the drawn circle can still answer by leaving and returning', () => {
    /**
     * WHAT THIS GESTURE CANNOT DEFEND AGAINST, measured rather than left as a hope.
     *
     * A patient whose hand rests inside a ring — up beside the shoulder, on a table at that height —
     * takes it out and puts it back, and the ring fills. The habitat cannot save them: every frame of
     * a limb that lives inside a drawn circle is either part of a hold that is accumulating or part of
     * the reach into it, and excluding those frames is what stops the reach itself from teaching the
     * record that the limb lives on the ring (the circularity in `DwellHabitat`'s own header). So the
     * protections for this body are, in order: the AUTHORED POSITIONS, which clear every rest position
     * the app instructs by more than the whole hysteresis band (see the reach test below); the ENTRY
     * GATE, which makes the limb leave the drawn circle and come back, so a confirm needs a real
     * excursion and not a tremor; the BAND CLOCK, which covers the much larger set of positions just
     * outside the circle; and the 1.8 s hold itself.
     *
     * It is asserted here so that it is a known quantity and not a surprise: one confirm per
     * out-and-back, not a ring filling on its own. If a future change makes this body confirm WITHOUT
     * leaving the circle first, this test is the one that will say so.
     */
    const target = singleDwellTarget('leg');
    const inRing = { x: target.x - 0.02, y: target.y + 0.01 };
    expect(dwellDistance(inRing, target, PREVIEW_ASPECT)).toBeLessThan(target.radius);
    const parked = drive({
      mode: 'leg',
      aspect: PREVIEW_ASPECT,
      authored: [target],
      seconds: 20,
      // It never leaves: the entry gate alone holds the ring at zero for the whole run.
      frame: () =>
        legFrame({ movement: 'seated_march', side: 'left', amount: 0, compensation: 'none', rest: 'chair_arms', hand: { side: 'left', ...inRing }, aspect: PREVIEW_ASPECT }),
    });
    expect(parked.confirms).toBe(0);
    expect(parked.maxProgress).toBe(0);

    // …and when it DOES leave and come back, that is the gesture, and it is one confirm per excursion.
    const cycling = drive({
      mode: 'leg',
      aspect: PREVIEW_ASPECT,
      authored: [target],
      seconds: 30,
      frame: (t) =>
        legFrame({
          movement: 'seated_march',
          side: 'left',
          amount: 0,
          compensation: 'none',
          rest: 'chair_arms',
          hand: { side: 'left', ...(t % 5.5 >= 4 ? { x: 0.55, y: 0.72 } : inRing) },
          aspect: PREVIEW_ASPECT,
        }),
    });
    expect(cycling.confirms).toBeGreaterThan(0);
    expect(cycling.confirms).toBeLessThanOrEqual(6);
  });

  it('…and the same pipeline DOES confirm a deliberate hold, so none of the above is vacuous', () => {
    // Leg mode: the patient's hands rest in their lap while a leg works, and then one hand is raised
    // into the ring and held there. This is the gesture; everything above is not.
    const target = singleDwellTarget('leg');
    const raised = drive({
      mode: 'leg',
      aspect: PREVIEW_ASPECT,
      authored: [target],
      seconds: 16,
      lanes: [{ index: 0, movement: 'seated_march', side: 'left' }],
      frame: (t, circles) => {
        // 6 s of marching with the hands on the CHAIR ARMS — the support the app now asks for, and the
        // one a hold can be made from — then a 1 s reach and a long hold. The reach aims at WHERE THE
        // RING IS, because the layout may have moved it off the resting hand; aiming at the authored
        // spot would be aiming at a circle that is not there.
        const ring = circles[0];
        const reach = Math.max(0, Math.min(1, (t - 6) / 1));
        const from = SEATED_HAND_RESTS.chair_arms.left;
        const hand = { x: from.x + (ring.x - from.x) * reach, y: from.y + (ring.y - from.y) * reach };
        return legFrame({
          movement: 'seated_march',
          side: 'left',
          amount: repAmount(t, SLOW_REP),
          compensation: 'circumduction',
          rest: 'chair_arms',
          hand: { side: 'left', ...hand },
          aspect: PREVIEW_ASPECT,
        });
      },
    });
    expect(raised.confirms).toBeGreaterThanOrEqual(1);
    // And the hand that made it was never refused as a pointer: a hand on furniture is independent of
    // the leg, which is the whole reason the app asks for that support.
    expect(raised.coupledFrames).toBe(0);

    // Hand mode: the prescribed hand slides along the table into the circle and stays.
    const handTarget = singleDwellTarget('hand');
    const slid = drive({
      mode: 'hand',
      aspect: PREVIEW_ASPECT,
      authored: [handTarget],
      seconds: 16,
      frame: (t, circles) => {
        const ring = circles[0];
        const reach = Math.max(0, Math.min(1, (t - 6) / 1.5));
        return handFrame({
          movement: 'hand_open_close',
          amount: repAmount(t, SLOW_REP),
          centerX: 0.5 + (ring.x - 0.5) * reach,
          scale: 1,
          dy: (ring.y - 0.63) * reach,
          aspect: PREVIEW_ASPECT,
        });
      },
    });
    expect(slid.confirms).toBeGreaterThanOrEqual(1);
  });

  it('…and the FIXTURE RIG can perform it, which is what the critic harnesses have to drive', () => {
    /**
     * The proof above builds its hands itself (`legFrame` overwrites the wrist landmarks), so it could
     * pass while the shared rig had no arms at all — and it did: `seatedPose` left every arm landmark on
     * an unplaced (0.5, 0.2) placeholder, so critic/handsfree.mjs and critic/handsfree-dead-ends.mjs,
     * which inject that rig, could only aim a KNEE and could not perform the one gesture leg mode has.
     * A harness that cannot drive the supported gesture is not evidence, so the rig itself is driven
     * here: hands on the thighs (`SEATED_HAND_RESTS`), one raised to the ring, the legs marching with
     * the circumduction that used to fire this by accident.
     */
    const from = SEATED_HAND_RESTS.chair_arms.left;
    const fixture = drive({
      mode: 'leg',
      aspect: PREVIEW_ASPECT,
      authored: pairedDwellTargets('leg'),
      seconds: 14,
      frame: (t, circles) => {
        const ring = circles[0];
        const reach = Math.max(0, Math.min(1, (t - 6) / 1));
        return {
          tMs: t * 1000,
          // The hands rest on the CHAIR ARMS, not the thighs: a thigh-resting hand is carried by the
          // leg and the coupling gate refuses it, which is the point of the case below.
          pose: seatedPose({
            kneeLift: repAmount(t, SLOW_REP),
            abduction: repAmount(t, SLOW_REP),
            side: 'left',
            hands: 'chair_arms',
            handAt: { side: 'left', x: from.x + (ring.x - from.x) * reach, y: from.y + (ring.y - from.y) * reach },
          }),
          hands: [],
        };
      },
    });
    expect(fixture.confirms).toBeGreaterThanOrEqual(1);

    // AND THE FRAMING THE APP USED TO ASK FOR: hips, knees and feet in view, hands out of the picture.
    // Nothing is being followed, so nothing can be held — no pointer, no progress, no confirm. This is
    // the state POSTURE_INFO.seated_leg invited and the camera check now has to announce before the
    // patient is left alone with it.
    const framed = drive({
      mode: 'leg',
      aspect: PREVIEW_ASPECT,
      authored: pairedDwellTargets('leg'),
      seconds: 14,
      frame: (t) => ({ tMs: t * 1000, pose: seatedHandsOutOfView({ kneeLift: repAmount(t, SLOW_REP), side: 'left' }), hands: [] }),
    });
    expect(framed.tracked).toBe(0);
    expect(framed.maxProgress).toBe(0);
    expect(framed.confirms).toBe(0);
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
    // THE LIFT is what the table cannot help with, and it is what this test is about: less of it than
    // either of the positions this replaced. The TRAVEL is now slightly further, and deliberately —
    // the ring had to move out to clear a resting palm by the lateral floor once it was big enough to
    // see — but it is travel ACROSS a table that is carrying the forearm, which is the axis the mode
    // exists on, and it is still well inside the reach bound every other placement is held to.
    expect(now.travel).toBeLessThan(DWELL_LIMB_REACH);
    expect(now.travel - beforePair.travel).toBeLessThan(0.05);
    expect(now.lift).toBeLessThan(beforePair.lift);
    // No target asks the patient to hold a hand in the upper third of the frame.
    for (const target of placements('hand')) expect(target.y + target.radius).toBeGreaterThan(1 / 3);
    // And the lift is bounded: a raise of about a fifth of the frame height, the rest of the movement
    // being a slide out to the side, which the table carries.
    expect(now.lift).toBeLessThan(0.2);
    expect(now.lift).toBeGreaterThan(0.1); // …and it is a real move, not a twitch
  });

  it('leg mode: a raised hand reaches it from every rest, which is the only gesture leg mode has left', () => {
    const target = singleDwellTarget('leg');
    // A hand resting somewhere, raised: no exercise, no holding a limb against gravity in a posture
    // the prescription cares about. Since the knees stopped being pointers this is the whole gesture,
    // so it has to be performable — by an unaffected arm if the affected one will not do it. 0.45 is
    // the same bound `DWELL_LIMB_REACH` holds a RELOCATED ring to, so the two agree.
    for (const rest of HAND_RESTS) {
      const travel = approach(rest.left, target, PREVIEW_ASPECT).travel;
      expect(travel, `from ${rest.what}`).toBeLessThan(DWELL_LIMB_REACH);
    }
    /**
     * AND WHERE A REST POSITION IS INSIDE THE AUTHORED RING, THE GATE OWNS IT — which is a change of
     * claim, made deliberately when the ring grew to a size a patient can see (it is now 0.16, and a
     * hand on a high chair arm sits 0.133 from the primary centre). This test used to assert the
     * geometry away: "the nearest resting hand is still outside the drawn circle". That was only ever
     * true for the four rest positions in this file, at one framing, and the app has to hold for a
     * body it has never seen. So what is asserted is what actually protects the patient: a ring
     * standing on where a limb LIVES accumulates nothing, and the layout moves it somewhere it does
     * not — measured, per body, in "SITTING STILL confirms nothing either".
     */
    // No rest position is inside the drawn circle, and none is even inside the BAND: that is what the
    // authored position had to buy to let the ring grow (see the radius note in DwellTarget.tsx).
    for (const rest of HAND_RESTS) {
      const d = dwellDistance(rest.left, target, PREVIEW_ASPECT);
      expect(d, rest.what).toBeGreaterThan(target.radius * DWELL_DEFAULTS.exitRatio + DWELL_CLEAR_MARGIN);
    }
    // And where a body DOES live on the ring — a lower armrest, a chair the clinic did not choose —
    // the gate owns it: the ring accumulates nothing and the layout moves it somewhere it does not.
    const onTheRing = { x: target.x - 0.02, y: target.y + 0.02 };
    const habitat = new DwellHabitat();
    for (let i = 0; i <= 60; i++) habitat.noteOne('hand:left', onTheRing, i * 0.1);
    const summaries = habitat.all(6, PREVIEW_ASPECT);
    const opts = { xScale: PREVIEW_ASPECT, axis: dwellAxisFor('leg'), extra: DWELL_CLEAR_EXTRA, fits: (c: DwellCircle) => dwellCircleFits(c, PREVIEW_ASPECT) };
    expect(dwellTargetClear(target, summaries, opts).clear).toBe(false);
    const moved = placeDwellCircle(target, summaries, opts);
    expect(moved.placeable).toBe(true);
    expect(dwellTargetClear(moved.circle, summaries, opts).clear).toBe(true);
    // …and where it moves to is still reachable from that hand, and still not overhead.
    expect(dwellPlaceable(moved.circle)).toBe(true);
    expect(approach(onTheRing, moved.circle, PREVIEW_ASPECT).travel).toBeLessThan(DWELL_LIMB_REACH);
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
          /**
           * THE CIRCLE THE LAYOUT WOULD ACTUALLY PUT THERE, not the authored one.
           *
           * On a sensor TALLER than the 4:3 preview the crop magnifies the frame onto the glass, and a
           * hand-mode ring authored far enough out to clear a resting palm lands with its caption off
           * the edge. `DwellLayout.reset` solves that once, against no habitat — so what has to be
           * drawable whole is what the layout opens with, and this drives it rather than assuming the
           * authored number survives every sensor.
           */
          const layout = new DwellLayout([{ id: 'one', authored }], {
            xScale: aspect,
            axis: dwellAxisFor(mode),
            fits: (c: DwellCircle) => dwellCircleFits(c, aspect),
          });
          const target = layout.circleFor('one') as DwellCircle;
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

/* ================= the ring may move off the patient, and must be able to come back ================= */

describe('a relocated ring is bounded, and comes home', () => {
  /**
   * TRACED IN THE RUNNING APP, and the second half of this round's report: a thigh-coupled hand at a
   * slow pace tripped `occupied`, and `placeDwellCircle` slid the primary (0.72, 0.32) -> (0.72, 0.215)
   * -> (0.787, 0.14). With a 0.115 radius that is the top quarter of the frame at the far edge, 0.518
   * frame heights from the resting hand that has to reach it — the position DwellTarget.tsx condemns in
   * its own words — and `DwellLayout` never moved a circle back, so it stayed there for the life of the
   * screen.
   */
  const opts = (aspect: number) => ({
    xScale: aspect,
    axis: dwellAxisFor('leg'),
    exitRatio: DWELL_DEFAULTS.exitRatio,
    extra: DWELL_CLEAR_EXTRA,
    crowdedGraceSec: 0.5,
    moveIntervalSec: 1.5,
    fits: (c: DwellCircle) => dwellCircleFits(c, aspect),
  });

  /**
   * Run a layout for `seconds` with one hand living wherever `where` says at that instant — noted every
   * step, because a limb the habitat has not seen for five seconds stops constraining anything (which
   * is correct, and which makes a hand fed once look like a hand that left the room).
   */
  function run(
    layout: DwellLayout,
    habitat: DwellHabitat,
    where: (t: number) => DwellPoint,
    from: number,
    to: number,
    aspect: number,
    busy = false,
  ): { moves: number; last: DwellHabitatSummary[] } {
    let moves = 0;
    let last: DwellHabitatSummary[] = [];
    for (let t = from; t <= to; t += 0.08) {
      habitat.noteOne('hand:left', where(t), t);
      last = habitat.all(t, aspect);
      if (layout.survey(last, t, busy).moved) moves += 1;
    }
    return { moves, last };
  }

  it('moves off a hand that lives on the ring, and STAYS INSIDE THE BOUNDS while doing it', () => {
    const aspect = PREVIEW_ASPECT;
    const authored = pairedDwellTargets('leg');
    const layout = new DwellLayout(authored.map((c, i) => ({ id: `t${i}`, authored: c })), opts(aspect));
    const habitat = new DwellHabitat();
    const { moves, last } = run(layout, habitat, () => ({ x: 0.7, y: 0.34 }), 0, 20, aspect);
    expect(moves).toBeGreaterThan(0);
    for (const circle of layout.circles()) {
      // Not overhead, still reachable, and not on the far side of the preview from where it was.
      expect(dwellPlaceable(circle)).toBe(true);
      expect(dwellWithinLimbReach(circle, last, aspect)).toBe(true);
    }
    const primary = layout.circleFor('t0') as DwellCircle;
    expect(Math.hypot((primary.x - authored[0].x) * aspect, primary.y - authored[0].y)).toBeLessThanOrEqual(DWELL_MAX_REACH + 1e-9);
    // The traced landing spot is refused outright now, by the rule and not by luck.
    expect(dwellPlaceable({ x: 0.787, y: 0.14, radius: 0.115 })).toBe(false);
  });

  it('AND COMES BACK when the patient moves their hand away', () => {
    const aspect = PREVIEW_ASPECT;
    const authored = pairedDwellTargets('leg');
    const layout = new DwellLayout(authored.map((c, i) => ({ id: `t${i}`, authored: c })), opts(aspect));
    // The patient's hand lives on the primary for twenty seconds…
    const habitat = new DwellHabitat();
    run(layout, habitat, () => ({ x: 0.7, y: 0.34 }), 0, 20, aspect);
    const displaced = layout.circleFor('t0') as DwellCircle;
    expect(displaced.y).not.toBeCloseTo(authored[0].y, 6);
    // …and then they put it back in their lap. Nothing is crowded any more, which is exactly the state
    // in which the old code stopped solving — so the ring stayed out at the edge for the rest of the
    // session and the patient had to go and find it.
    const { moves } = run(layout, habitat, () => ({ x: 0.58, y: 0.72 }), 20.08, 80, aspect);
    expect(moves).toBeGreaterThan(0);
    const home = layout.circleFor('t0') as DwellCircle;
    expect(home.x).toBeCloseTo(authored[0].x, 6);
    expect(home.y).toBeCloseTo(authored[0].y, 6);
  });

  it('will not wander home in the middle of somebody’s hold, or jitter on the way', () => {
    const aspect = PREVIEW_ASPECT;
    const authored = pairedDwellTargets('leg');
    const layout = new DwellLayout(authored.map((c, i) => ({ id: `t${i}`, authored: c })), opts(aspect));
    const habitat = new DwellHabitat();
    run(layout, habitat, () => ({ x: 0.7, y: 0.34 }), 0, 20, aspect);
    const displaced = layout.circleFor('t0') as DwellCircle;
    // `busy` = a hold is accumulating. Moving the ring would throw away the ring they are filling.
    const held = run(layout, habitat, () => ({ x: 0.58, y: 0.72 }), 20.08, 50, aspect, true);
    expect(held.moves).toBe(0);
    expect(layout.circleFor('t0')).toEqual(displaced);
    // And a homecoming waits out the same quiet interval a move does, so a ring never flickers: a
    // 30-second walk home is a handful of steps, not one per survey.
    const free = run(layout, habitat, () => ({ x: 0.58, y: 0.72 }), 50.08, 80, aspect);
    expect(free.moves).toBeGreaterThan(0);
    expect(free.moves).toBeLessThan(12);
  });

  it('never opens with a circle it cannot draw whole on the camera it was given', () => {
    // A taller-than-4:3 sensor crops the top and bottom, so a ring authored far out has its caption
    // off the glass. `reset` solves that once, against no habitat: this is where a screen OPENS.
    for (const aspect of ASPECTS) {
      for (const mode of ['hand', 'leg'] as const) {
        const layout = new DwellLayout(
          pairedDwellTargets(mode).map((c, i) => ({ id: `t${i}`, authored: c })),
          { ...opts(aspect), axis: dwellAxisFor(mode) },
        );
        for (const circle of layout.circles()) {
          expect(dwellCircleFits(circle, aspect), `${mode} @${aspect.toFixed(2)} ${JSON.stringify(circle)}`).toBe(true);
        }
        expect(dwellTargetsOverlap(layout.circles()[0], layout.circles()[1], DWELL_DEFAULTS.exitRatio, aspect)).toBe(false);
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
    /**
     * AND THE TWO SETS OF SIZES MAY NOT OVERLAP ACROSS MODES. `toneOf` reads the tone off the radius
     * for screens that do not say which ring is which (Results asks for two and names neither), and
     * the modes have different primary sizes because their clearance rules do. If a secondary ever
     * grew past a primary, the forward ring of one mode would draw itself as the one that goes back —
     * with the back-pointing mark, on the screen where one of the two ends the session.
     */
    const primaries = (['hand', 'leg'] as const).map((m) => singleDwellTarget(m).radius);
    const secondaries = (['hand', 'leg'] as const).map((m) => pairedDwellTargets(m)[1].radius);
    expect(Math.max(...secondaries)).toBeLessThan(Math.min(...primaries));
    for (const mode of ['hand', 'leg'] as const) {
      const [go, back] = pairedDwellTargets(mode);
      expect(toneOf({ ...CHOICE, target: go })).toBe('go');
      expect(toneOf({ ...CHOICE, target: back })).toBe('back');
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

  it('BIG ENOUGH TO SEE AND AIM AT — measured in pixels on the tablet this is built for', () => {
    /**
     * WHAT THIS FIXES. `index.css` caps the preview at 33vh on a short viewport so the legend fits, so
     * at 1024x768 the preview is 337x253 and the old 0.115 radius drew a 58 px circle: about 0.6
     * degrees of visual angle at a metre, against assistive-technology guidance of 1.5 degrees and up
     * (>= 26 mm, ~100 px on a 10-inch tablet) for a dwell-activated control. The ring the entire
     * hands-free path depends on was less than half the smallest size a low-vision patient is expected
     * to be able to acquire.
     *
     * What bounds it is the GATE, not the layout: every unit of radius costs 1.25 units of clear water
     * (the exit band) in a frame that already contains two hands, two knees and a chair, and hand mode
     * pays a further 0.75 palm lengths of measured wander on the only axis it may count. The numbers
     * below are the largest the sitting-still sweep can still place for every body it drives.
     */
    const PREVIEW_H_768 = 253; // 33vh of 768, the cap in index.css
    const PREVIEW_H_800 = 264;
    const diameter = (c: DwellCircle, boxH: number) => 2 * c.radius * boxH;
    const leg = pairedDwellTargets('leg');
    const hand = pairedDwellTargets('hand');
    expect(diameter(leg[0], PREVIEW_H_768)).toBeGreaterThan(74);
    expect(diameter(leg[0], PREVIEW_H_800)).toBeGreaterThan(78);
    expect(diameter(hand[0], PREVIEW_H_768)).toBeGreaterThan(64);
    // Both secondaries are a real circle to hold as well as a small one to look at: bigger than the
    // 46 px the old secondary drew, and smaller than every primary (which is what `toneOf` reads).
    for (const pair of [leg, hand]) {
      expect(diameter(pair[1], PREVIEW_H_768)).toBeGreaterThan(46);
      expect(pair[1].radius).toBeLessThan(Math.min(leg[0].radius, hand[0].radius));
    }
    // …and every one of them is nearly double what it was, which is the claim being made.
    for (const pair of [leg, hand]) expect(pair[0].radius).toBeGreaterThan(0.115 * 1.1);
  });

  it('the tone mark is a FILLED shape most of the ring wide, so identity survives 1/5 scale', () => {
    /**
     * At a fifth of the size — a screenshot, or a patient across the room — the primary ring is about
     * 16 px across and the secondary 11 px. The old mark was a 22-unit-wide chevron pair stroked at 4
     * units: under 4 px at that scale, which is what made the two rings "two grey dots differing only
     * in diameter". Size says they are different; only the mark says WHICH, and one of them ends the
     * session. So it is filled rather than stroked (a solid shape survives a bilinear downscale where a
     * thin line vanishes), it spans nearly half the ring, and it is the only thing in the lower half.
     */
    for (const tone of ['go', 'back'] as const) {
      const el = draw({}, { ...CHOICE, target: pairedDwellTargets('leg')[tone === 'go' ? 0 : 1], tone });
      const mark = el.querySelector('[data-mark]') as SVGGElement;
      expect(mark.getAttribute('data-mark')).toBe(tone);
      // FILLED, not stroked: the fill is a colour and the stroke is only the dark halo under it.
      expect(mark.getAttribute('fill')).toMatch(/#f|#ffffff/i);
      expect(Number(mark.getAttribute('stroke-width'))).toBeLessThan(4);
      // Its extent, read off the actual path/rect geometry, against the ring radius (46 viewBox units).
      const xs: number[] = [];
      for (const node of mark.querySelectorAll('path')) {
        for (const m of (node.getAttribute('d') ?? '').matchAll(/(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)/g)) xs.push(Number(m[1]));
      }
      for (const node of mark.querySelectorAll('rect')) {
        xs.push(Number(node.getAttribute('x')), Number(node.getAttribute('x')) + Number(node.getAttribute('width')));
      }
      const width = Math.max(...xs) - Math.min(...xs);
      expect(width, tone).toBeGreaterThan(2 * 46 * 0.4);
      // …and still well inside the circle that is actually tested: nothing may imply a bigger target.
      expect(Math.max(...xs.map(Math.abs)), tone).toBeLessThan(46 - 8);
    }
    // The two are different SHAPES, in every phase — it is what the ring is, not what it is doing.
    const shapeOf = (el: HTMLElement) =>
      [...el.querySelectorAll('[data-mark] path, [data-mark] rect')]
        .map((n) => n.getAttribute('d') ?? `${n.getAttribute('x')}/${n.getAttribute('width')}`)
        .join('|');
    const go = shapeOf(draw({}, { ...CHOICE, tone: 'go' }));
    for (const over of [{ tracked: false }, { blocked: 'occupied' as const }, { blocked: 'coupled' as const }, { holding: true, progress: 0.5 }]) {
      expect(shapeOf(draw(over, { ...CHOICE, tone: 'back' }))).not.toBe(go);
      expect(draw(over, { ...CHOICE, tone: 'back' }).querySelector('[data-mark]')).not.toBeNull();
    }
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
  return { states: { go: state() }, limb: null, coupled: null, rooms: {}, live: true, xScale: PREVIEW_ASPECT, frameIntervalSec: 1 / 30, ...over };
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
    expect(screen.getByTestId('dwell-legend').textContent).toMatch(/Either side will do, the unaffected one included/);
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
    expect(screen.getByTestId('dwell-legend-limbs').textContent).toMatch(/a knee in the circle cannot be told from a repetition/);
    // …and it names the support the hand has to be on, and rules out the one the leg carries.
    expect(screen.getByTestId('dwell-legend-limbs').textContent).toMatch(/not your thigh, which your leg carries/);
    useStore.getState().setMode('hand');
    cleanup();
    render(<DwellLegend session={session()} what="x" />);
    const el = screen.getByTestId('dwell-legend');
    expect(el.textContent).not.toMatch(/knee/);
    expect(el.textContent).toMatch(/a hand/);
    useStore.getState().setMode('leg');
  });

  it('with NO limb in view it says what to do about the PICTURE, in the first line', () => {
    /**
     * The gap the leg-mode fix left. A patient framed as `POSTURE_INFO.seated_leg` used to ask — hips,
     * knees and feet — has no hand in the picture, so no ring can fill; and since `dwellLimbs` stopped
     * returning knees there is nothing else that could. "Move a hand into the circle and keep it there"
     * is an instruction about the circle when the problem is the picture, and the one sentence that
     * said so lived in the small print at the bottom of the block, below the fold at 1024x768.
     *
     * So it is the FIRST line, beside the badge, and it names the remedy the patient can act on alone.
     */
    useStore.getState().setMode('leg');
    cleanup();
    render(<DwellLegend session={session({ states: { go: state({ tracked: false }) } })} what="the left circle to go on" />);
    const el = screen.getByTestId('dwell-legend');
    expect(el.dataset.state).toBe('searching');
    const say = screen.getByTestId('dwell-legend-bring-hand').textContent ?? '';
    expect(say).toMatch(/Bring a hand into the picture/);
    expect(say).toMatch(/arm of the chair|table/);
    expect(say).toMatch(/NOT on your thigh/);
    expect(say).toMatch(/the left circle to go on/);
    expect(say).toMatch(/knees cannot do this/);
    // …and it is the first thing in the block, which is what makes it visible without scrolling on a
    // 768 px tablet: the limb badge that says "No hand in view" comes after it.
    const first = el.querySelector('strong');
    expect(first?.contains(screen.getByTestId('dwell-legend-bring-hand'))).toBe(true);
    expect(el.textContent?.indexOf('Bring a hand')).toBeLessThan(el.textContent?.indexOf('No hand in view') ?? -1);
    // It must not tell a patient with nothing in the picture to hold anything yet.
    expect(el.textContent).not.toMatch(/Move a hand into the circle and keep it/);
    // …and the small print does not repeat the explanation the first line now carries (which is what
    // pushed the block off the bottom of a 768 px screen), but still says the buttons are there.
    const small = screen.getByTestId('dwell-legend-limbs').textContent ?? '';
    expect(small).toMatch(/Either side will do/);
    /**
     * AND IT NO LONGER POINTS AT A CONTROL THAT MAY BE SWITCHED OFF.
     *
     * "If no hand can come into the picture, the buttons still work" was false in the one state where
     * a stranded patient reads it: on a blocked device the camera check sets `disabled={readiness.gate}`
     * on its forward button, so the only thing left IS the circle. Unless the screen says otherwise
     * (`touch`), the sentence promises no particular button.
     */
    expect(small).toMatch(/has to be done on the screen/);
    expect(small).toMatch(/can have its own button switched off/);
    expect(small).not.toMatch(/buttons still work/i);

    // It is the RINGS' state, not the pick's: a hand that drops out for one frame leaves `limb` null
    // while every ring is still tracking, and there the legend goes on telling the patient to hold.
    cleanup();
    render(<DwellLegend session={session()} what="x" />);
    expect(screen.queryByTestId('dwell-legend-bring-hand')).toBeNull();
    expect(screen.getByTestId('dwell-legend').textContent).toMatch(/Move a hand into the circle/);

    useStore.getState().setMode('hand');
    cleanup();
    render(<DwellLegend session={session({ states: { go: state({ tracked: false }) } })} what="x" />);
    expect(screen.getByTestId('dwell-legend-bring-hand').textContent).toMatch(/Bring your hand back into the picture/);
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
    expect(el.textContent).toMatch(/Restarting the camera/);
    // Not "use the buttons": see the note in the test above. A screen that KNOWS its button is off
    // says so instead, and a screen that knows it works may promise it.
    expect(el.textContent).not.toMatch(/Use the buttons/);
    cleanup();
    render(<DwellLegend session={session({ live: false })} what="x" touch="off" />);
    expect(screen.getByTestId('dwell-legend-touch').textContent).toMatch(/switched off at the moment/);
    cleanup();
    render(<DwellLegend session={session({ live: false })} what="x" touch="on" />);
    expect(screen.getByTestId('dwell-legend-touch').textContent).toMatch(/A button on this screen does the same thing/);
  });

  it('SAYS THE BUTTON IS OFF where the screen has switched it off, instead of promising it', () => {
    /**
     * `DwellTarget.tsx:1008` and `:1011` used to read "If your hands are out of the picture, use the
     * buttons." and "the buttons still work." — beside a camera check that disables its own forward
     * button on a blocked device (`CameraCheck.tsx`, `disabled={readiness.gate}`). A patient alone on a
     * blocked device, with no hand in the picture, was being pointed at a greyed-out control: the one
     * state in which that sentence is the only thing left to act on, and it was not true.
     */
    useStore.getState().setMode('leg');
    cleanup();
    render(<DwellLegend session={session({ states: { go: state({ tracked: false }) } })} what="x" touch="off" />);
    const blocked = screen.getByTestId('dwell-legend-limbs').textContent ?? '';
    expect(blocked).toMatch(/switched off at the moment/);
    expect(blocked).toMatch(/the circles are the only way on/);
    expect(blocked).not.toMatch(/buttons still work/i);
    cleanup();
    render(<DwellLegend session={session()} what="x" touch="on" />);
    expect(screen.getByTestId('dwell-legend-limbs').textContent).toMatch(/A button on this screen does the same thing/);
  });

  it('a hand the EXERCISE is carrying is named, with the remedy, not told to hold harder', () => {
    // The measured verdict (`DwellCoupling`) reaching the patient: a hand resting on the thigh is
    // carried by hip flexion, so nothing it does can be told from a repetition. "Move a hand into the
    // circle and keep it there" is an instruction that cannot be followed by a limb that is not an
    // independent witness — what the patient can act on is the SUPPORT.
    useStore.getState().setMode('leg');
    cleanup();
    render(
      <DwellLegend
        session={session({
          states: { go: state({ blocked: 'coupled', tracked: true }) },
          limb: { point: { x: 0.64, y: 0.5 }, side: 'left', label: 'your left hand', key: 'hand:left', scale: null },
          coupled: {
            key: 'hand:left',
            coupled: true,
            explained: 0.19,
            r2: 0.99,
            fraction: 0.7,
            reference: 'lane:0:seated_march:left/y',
            samples: 40,
            settled: true,
          },
        })}
        what="the left circle to go on"
      />,
    );
    const el = screen.getByTestId('dwell-legend');
    expect(el.dataset.state).toBe('coupled');
    const say = screen.getByTestId('dwell-legend-carried').textContent ?? '';
    expect(say).toMatch(/Your left hand is moving with your exercise/);
    expect(say).toMatch(/carried by your leg/);
    expect(say).toMatch(/arm of the chair|armrest|table/);
    expect(say).toMatch(/other hand will do/);
    expect(el.textContent).not.toMatch(/Move .* into the circle and keep it/);
  });
});
