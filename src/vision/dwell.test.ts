/**
 * The dwell maths, frame by frame.
 *
 * Every case here is a patient this feature exists for: a hand that shakes, a landmark that drops out
 * on a 12 fps clinic webcam, a knee already resting where the target is drawn, a limb parked on the
 * boundary of the circle. The failure mode each test pins down is the same one — a hands-free path
 * that works for a steady hand and strands everybody else.
 *
 * AND ONE THAT IS WORSE THAN STRANDING ANYBODY: a confirm the patient did not make. The file used to
 * have 42 cases and none of them was "the limb went back to where it was resting", which is exactly
 * what happened in the running app — the hysteresis band reached the resting knee, so relaxing out of
 * the target kept the ring filling and the session advanced itself. See "relaxing back to rest".
 *
 * AND THEN IT HAPPENED AGAIN, THREE TIMES, BECAUSE OF A TEST IN THIS FILE. The case below used to be a
 * 200 ms crossing of the target, with the comment "Nothing in this app asks for a rep slower than
 * that". That is backwards: nothing in this app asks for a rep FASTER than that either. The ROM screen
 * asks for an unpaced comfortable repetition from a hemiparetic limb ("Lift your knee as high as is
 * comfortable, lower it"), the chart's own lane spacing is 1.2 s, and a critic driving a 4 s rise, a
 * 1.5 s hold at the top and a 3 s descent got a confirm on the FIRST repetition at the camera check,
 * during a ROM measurement, and on the pause dialog — where it ended the session. A rep is now driven
 * as a REP: `REP_PROFILE` below, and the whole-pipeline version of it in DwellTarget.test.tsx.
 */
import { describe, expect, it } from 'vitest';
import {
  DWELL_CLEAR_EXTRA,
  DWELL_CLEAR_MARGIN,
  DWELL_DEFAULTS,
  DWELL_HABITAT_FORGET_SEC,
  DWELL_HABITAT_INTERVAL_SEC,
  DWELL_LATERAL_FLOOR_PALMS,
  DwellHabitat,
  DwellTracker,
  dwellClearance,
  dwellDistance,
  dwellLimbs,
  dwellTargetClear,
  dwellTargetsOverlap,
  pickDwellLimb,
  placeDwellCircle,
  retargetForAspect,
} from './dwell.ts';
import type { DwellCircle, DwellHabitatSummary, DwellLimb, DwellPoint, DwellState } from './dwell.ts';
import { seatedPose } from './fixtures.ts';
import { HAND, POSE, POSE_LANDMARK_COUNT } from './landmarks.ts';
import type { Landmark } from './landmarks.ts';
import type { DetectionResult, HandDetection } from './mediapipe.ts';

const TARGET: DwellCircle = { x: 0.5, y: 0.3, radius: 0.15 };
const FPS = 30;
const STEP = 1 / FPS;

/** Run `frames` updates at 30 fps, feeding `at(i)` each time. Returns the last state. */
function run(
  tracker: DwellTracker,
  frames: number,
  at: (i: number, t: number) => DwellPoint | null,
  start = 0,
  key?: string,
): { last: DwellState; states: DwellState[] } {
  const states: DwellState[] = [];
  for (let i = 0; i < frames; i++) {
    const t = start + i * STEP;
    states.push(tracker.update(at(i, t), t, key));
  }
  return { last: states[states.length - 1], states };
}

/** A pointer sitting still at the centre of the target. */
const CENTRE: DwellPoint = { x: TARGET.x, y: TARGET.y };
/** Well outside every radius, where a limb is before the patient moves it in. */
const AWAY: DwellPoint = { x: 0.1, y: 0.85 };

/**
 * A REPETITION, AS A PATIENT PERFORMS ONE — not as a unit test finds convenient.
 *
 * The pace the critic drove and the app itself invites: the ROM screen's instruction is "Lift your
 * knee as high as is comfortable, lower it" with no pacing at all, and `SessionConfig.laneRestSec`
 * bottoms out at 0.4 s but defaults to 1.2 s. A hemiparetic rise is slow, the top is HELD (that is
 * where the therapist wants the range), and the descent is slower still under eccentric control.
 */
export const REP_PROFILE = Object.freeze({ riseSec: 4, holdSec: 1.5, fallSec: 3 });

/** 0..1 through one repetition of `profile` at time `t` (smooth ends, flat top; 0 between reps). */
function repAmount(t: number, profile: { riseSec: number; holdSec: number; fallSec: number }): number {
  if (t <= 0) return 0;
  if (t < profile.riseSec) {
    const k = t / profile.riseSec;
    return 0.5 * (1 - Math.cos(Math.PI * k));
  }
  if (t < profile.riseSec + profile.holdSec) return 1;
  const fall = t - profile.riseSec - profile.holdSec;
  if (fall >= profile.fallSec) return 0;
  return 0.5 * (1 + Math.cos(Math.PI * (fall / profile.fallSec)));
}

/**
 * The ordinary path: come from outside, park in the middle, confirm once the minimum hold is up.
 * Every other test starts from this same "armed by having been outside" state.
 */
function armed(opts = {}): DwellTracker {
  const tracker = new DwellTracker(TARGET, opts);
  tracker.update(AWAY, 0);
  return tracker;
}

describe('the minimum hold', () => {
  it('confirms after holdSec of holding and not one frame before', () => {
    const tracker = armed({ holdSec: 1.8 });
    const { states } = run(tracker, 80, () => CENTRE, STEP);
    const confirmAt = states.findIndex((s) => s.confirmed);
    const firstHold = states.findIndex((s) => s.holding);
    expect(confirmAt).toBeGreaterThanOrEqual(0);
    // Measured from the frame the hold actually began: the smoothing window still holds a sample or
    // two from where the limb came FROM, which is the tremor filter doing its job, not lost time.
    const heldSec = (confirmAt - firstHold + 1) * STEP;
    expect(heldSec).toBeGreaterThanOrEqual(1.8);
    expect(heldSec).toBeLessThan(1.8 + STEP * 1.5);
    expect(states.slice(0, confirmAt).every((s) => !s.confirmed)).toBe(true);
  });

  it('reports progress that a ring can be drawn from, and time still to hold', () => {
    const tracker = armed({ holdSec: 2 });
    const { last } = run(tracker, 30, () => CENTRE, STEP); // 1.0 s from the edge of the frame
    expect(last.progress).toBeGreaterThan(0.4);
    expect(last.progress).toBeLessThan(0.55);
    expect(last.remainingSec).toBeCloseTo((1 - last.progress) * 2, 6);
    expect(last.holding).toBe(true);
    expect(last.tracked).toBe(true);
    expect(last.inside).toBe(true);
    expect(last.withinEntry).toBe(true);
    // The state carries the circle it was measured against, so a renderer cannot draw a different one.
    expect(last.target).toEqual(TARGET);
  });

  it('A REAL REPETITION THROUGH A TARGET FILLS IT — which is why the fix is not in this class', () => {
    /**
     * The test that used to be here crossed the target in 200 ms and argued from a comment that no rep
     * is slower than that. Backwards: nothing in this app asks for a rep FASTER than that either. The
     * ROM screen asks for an unpaced comfortable repetition from a hemiparetic limb, and the chart's
     * own lane spacing is 1.2 s. Driven as a REPETITION — `REP_PROFILE`, a 4 s rise, 1.5 s held at the
     * top and a 3 s descent — a pointer that travels into a target and dwells there spends 3.6 s
     * inside it, and 1.8 s of that is a confirm.
     *
     * This is measured here, as a fact about the geometry, because it is the load-bearing reason for
     * the shape of the fix: no hold length, no hysteresis rule and no cleverness inside this class can
     * separate "the patient held the circle" from "the patient did the exercise the circle was
     * standing in". Only two things can, and both are outside this file:
     *   - the pointer is a limb THE PRESCRIPTION DOES NOT MOVE (`dwellLimbs` drops the knees), and
     *   - the target clears the limb's MEASURED habitat (`setOccupied`, driven by `DwellHabitat`).
     * A longer hold is not one of them: a longer hold is worse for a fatigued patient and this rep
     * would still fill it, as the second half of this case shows.
     */
    const inside = (holdSec: number) => {
      const tracker = armed({ holdSec });
      let confirms = 0;
      let t = STEP;
      let insideSec = 0;
      const span = REP_PROFILE.riseSec + REP_PROFILE.holdSec + REP_PROFILE.fallSec + 1.2;
      for (let i = 0; i * STEP <= span; i++) {
        const amount = repAmount(i * STEP, REP_PROFILE);
        const p = { x: AWAY.x + (CENTRE.x - AWAY.x) * amount, y: AWAY.y + (CENTRE.y - AWAY.y) * amount };
        const state = tracker.update(p, t);
        if (state.withinEntry) insideSec += STEP;
        if (state.confirmed) confirms += 1;
        t += STEP;
      }
      return { confirms, insideSec };
    };
    const rep = inside(DWELL_DEFAULTS.holdSec);
    expect(rep.insideSec).toBeGreaterThan(3);
    expect(rep.confirms).toBe(1);
    // A three-second hold — already too long to ask of a fatigued arm — does not fix it either.
    expect(inside(3).confirms).toBe(1);
  });

  it('the same repetition confirms NOTHING once the target is measured against where the limb lives', () => {
    // The fix, in miniature: the app records where each limb has been (`DwellHabitat`) and refuses to
    // count a hold on a target that does not clear it. Here the rep's own top IS where the target is,
    // so within a fraction of a second of the limb arriving there the record says so and the ring
    // stands down. This is the same loop `useDwellTargets` runs, with one limb and one target.
    const habitat = new DwellHabitat();
    const tracker = armed();
    let confirms = 0;
    let t = STEP;
    let standDowns = 0;
    const span = REP_PROFILE.riseSec + REP_PROFILE.holdSec + REP_PROFILE.fallSec + 1.2;
    for (let rep = 0; rep < 3; rep++) {
      for (let i = 0; i * STEP <= span; i++) {
        const amount = repAmount(i * STEP, REP_PROFILE);
        const p = { x: AWAY.x + (CENTRE.x - AWAY.x) * amount, y: AWAY.y + (CENTRE.y - AWAY.y) * amount };
        habitat.noteOne('hand:left', p, t);
        const summaries = habitat.all(t, 1);
        const room = dwellTargetClear(TARGET, summaries, { xScale: 1 });
        tracker.setOccupied(!room.clear);
        if (!room.clear) standDowns += 1;
        if (tracker.update(p, t, 'hand:left').confirmed) confirms += 1;
        t += STEP;
      }
    }
    expect(confirms).toBe(0);
    expect(standDowns).toBeGreaterThan(0);
  });

  it('a tab that was backgrounded for a minute resumes with one step, not a confirm', () => {
    const tracker = armed({ maxStepSec: 0.25 });
    tracker.update(CENTRE, STEP);
    const after = tracker.update(CENTRE, 60);
    expect(after.confirmed).toBe(false);
    expect(after.progress).toBeLessThanOrEqual(0.25 / DWELL_DEFAULTS.holdSec + STEP / DWELL_DEFAULTS.holdSec + 1e-9);
  });

  it('a clock that goes backwards or stops advances nothing', () => {
    const tracker = armed();
    run(tracker, 10, () => CENTRE, STEP);
    const before = tracker.state.progress;
    expect(tracker.update(CENTRE, 0.05).progress).toBeCloseTo(before, 6);
    expect(tracker.update(CENTRE, Number.NaN).progress).toBeCloseTo(before, 6);
  });
});

describe('hysteresis at the boundary', () => {
  it('needs the entry radius to get in but the bigger exit radius to get out', () => {
    const tracker = armed({ smoothingSec: 0 });
    const justOutside = { x: TARGET.x + TARGET.radius * 1.05, y: TARGET.y };
    const inBand = { x: TARGET.x + TARGET.radius * 1.15, y: TARGET.y };
    const beyondExit = { x: TARGET.x + TARGET.radius * 1.4, y: TARGET.y };

    expect(tracker.update(justOutside, STEP).inside).toBe(false);
    expect(tracker.update(CENTRE, 2 * STEP).inside).toBe(true);
    // Inside the hysteresis band: a wobble past the drawn edge does NOT end the hold.
    expect(tracker.update(inBand, 3 * STEP).inside).toBe(true);
    expect(tracker.update(inBand, 3 * STEP).withinEntry).toBe(false);
    expect(tracker.update(beyondExit, 4 * STEP).inside).toBe(false);
    // …and getting back in needs the entry radius again, not the band.
    expect(tracker.update(inBand, 5 * STEP).inside).toBe(false);
  });

  it('a hand parked on the drawn edge still completes the hold', () => {
    // The patient with poor proprioception: they put the hand where the ring is, not where its centre
    // is, and it drifts ±25 % of a radius across the boundary the whole time.
    const tracker = armed({ smoothingSec: 0 });
    const { states } = run(
      tracker,
      70,
      (i) => ({ x: TARGET.x + TARGET.radius * (1 + 0.25 * Math.sin(i)), y: TARGET.y }),
      STEP,
    );
    expect(states.some((s) => s.confirmed)).toBe(true);
  });

  it('the band is a wobble, not a place to live: parking in it stops the fill', () => {
    // Hysteresis exists so a tremor does not end a hold. It is not a licence to keep filling a ring
    // over a limb that has come to rest OUTSIDE the circle the patient can see.
    const tracker = armed({ smoothingSec: 0, bandGraceSec: 0.35 });
    run(tracker, 10, () => CENTRE, STEP);
    const earned = tracker.state.progress;
    const inBand = { x: TARGET.x + TARGET.radius * 1.15, y: TARGET.y };
    const parked = run(tracker, 60, () => inBand, 1);
    // For the first third of a second it is still counted as holding — that is the wobble tolerance…
    expect(parked.states[3].holding).toBe(true);
    // …and after that it is not, and the ring gives the time back instead of taking it.
    expect(parked.last.holding).toBe(false);
    expect(parked.last.inside).toBe(false);
    expect(parked.last.progress).toBeLessThan(earned);
    expect(parked.states.some((s) => s.confirmed)).toBe(false);
  });

  it('a hold can only COMPLETE inside the drawn circle, never out in the band', () => {
    // Filled to the brim by a real hold, then the limb drifts into the band on the very last frame.
    const tracker = armed({ holdSec: 1, smoothingSec: 0, bandGraceSec: 5 });
    const inBand = { x: TARGET.x + TARGET.radius * 1.15, y: TARGET.y };
    const { states } = run(tracker, 60, (i) => (i < 20 ? CENTRE : inBand), STEP);
    // The band kept `inside` true (bandGraceSec is long here) and the ring is full…
    expect(states.some((s) => s.inside && !s.withinEntry)).toBe(true);
    // …and it still did not confirm out there.
    expect(states.some((s) => s.confirmed)).toBe(false);
    // Back inside the drawn circle, it completes at once — nothing was thrown away, only withheld.
    const back = run(tracker, 4, () => CENTRE, 3);
    expect(back.states.some((s) => s.confirmed)).toBe(true);
  });
});

describe('relaxing back to rest', () => {
  /**
   * THE FAILURE THAT SHIPPED. The ROM pair sat at (0.73, 0.55) with radius 0.15 and an exitRatio of
   * 1.45; the repo's own seated fixture rests a knee at (0.6, 0.60), which is 0.1804 frame-heights
   * away — outside the circle the patient is shown, inside the hysteresis band. A patient who reached
   * the target and then simply let the knee go back to rest kept filling the ring, and the app
   * advanced the session by itself. Nothing in the file caught it, because nothing tested a limb
   * going home.
   */
  const KNEE_TARGET: DwellCircle = { x: 0.73, y: 0.55, radius: 0.15 };
  const REST: DwellPoint = { x: 0.6, y: 0.6 };
  const ASPECT = 4 / 3;

  it('the geometry that made it possible is measured, not assumed', () => {
    const d = dwellDistance(REST, KNEE_TARGET, ASPECT);
    expect(d).toBeCloseTo(0.1804, 3);
    expect(d).toBeGreaterThan(KNEE_TARGET.radius); // outside the drawn circle…
    expect(d).toBeLessThan(KNEE_TARGET.radius * 1.45); // …inside the old band.
  });

  it('a limb that enters and then goes home does not confirm, even from inside the band', () => {
    // The exact sequence the critic drove in the running app: in, then let go.
    const tracker = new DwellTracker(KNEE_TARGET, { xScale: ASPECT, smoothingSec: 0 });
    run(tracker, 10, () => REST, 0); // arrives at rest: outside, so the entry gate opens
    run(tracker, 20, () => ({ x: 0.73, y: 0.55 }), 0.5); // a deliberate move into the target
    const relaxed = run(tracker, 200, () => REST, 1.5); // …and back to rest, doing nothing else
    expect(relaxed.states.some((s) => s.confirmed)).toBe(false);
    expect(relaxed.last.progress).toBe(0);
    expect(relaxed.last.holding).toBe(false);
  });

  it('and with the old exit ratio the ring FILLS UP over a limb that is doing nothing', () => {
    // The mechanism, reproduced: with the band reaching rest and nothing clocking how long the pointer
    // spends out there, a limb that has gone home keeps earning the hold. Two independent changes stop
    // it now — the placement (DwellTarget.test.tsx) and, if a placement ever slipped again, the band
    // clock plus the rule that a hold may only COMPLETE inside the drawn circle.
    const old = new DwellTracker(KNEE_TARGET, { xScale: ASPECT, smoothingSec: 0, exitRatio: 1.45, bandGraceSec: 1e6 });
    run(old, 10, () => REST, 0);
    run(old, 6, () => ({ x: 0.73, y: 0.55 }), 0.5);
    const relaxed = run(old, 200, () => REST, 0.7);
    expect(relaxed.last.inside).toBe(true); // "inside" a circle the patient can see it is outside of
    expect(relaxed.last.progress).toBe(1); // a full ring, earned by sitting still
    expect(relaxed.last.withinEntry).toBe(false); // …which is the only reason it does not fire

    // The shipping defaults instead give the time back.
    const now = new DwellTracker(KNEE_TARGET, { xScale: ASPECT, smoothingSec: 0 });
    run(now, 10, () => REST, 0);
    run(now, 6, () => ({ x: 0.73, y: 0.55 }), 0.5);
    expect(run(now, 200, () => REST, 0.7).last.progress).toBe(0);
  });
});

describe('tremor tolerance: the pointer is smoothed before containment is tested', () => {
  it('a hand whose MEAN is inside keeps holding even though single frames are not', () => {
    // 6 Hz tremor, amplitude 1.2 radii — every other raw sample is outside the circle.
    const amplitude = TARGET.radius * 1.2;
    const shake = (i: number): DwellPoint => ({ x: TARGET.x + (i % 2 === 0 ? amplitude : -amplitude), y: TARGET.y });

    const raw = new DwellTracker(TARGET, { smoothingSec: 0 });
    raw.update(AWAY, 0);
    const rawRun = run(raw, 70, shake, STEP);
    expect(rawRun.states.some((s) => s.confirmed)).toBe(false);

    const smoothed = armed({ smoothingSec: 0.25 });
    const smoothRun = run(smoothed, 70, shake, STEP);
    expect(smoothRun.states.some((s) => s.confirmed)).toBe(true);
  });

  it('smoothing does not let a limb that has genuinely left keep the hold going', () => {
    const tracker = armed({ smoothingSec: 0.25 });
    run(tracker, 40, () => CENTRE, STEP);
    const held = tracker.state.progress;
    // Gone, and stays gone: within a couple of window lengths it is neither inside nor tracked.
    const { last } = run(tracker, 40, () => AWAY, 2);
    expect(last.inside).toBe(false);
    expect(last.holding).toBe(false);
    expect(last.progress).toBeLessThan(held);
  });
});

describe('one buffer, one limb', () => {
  /**
   * THE POINTER MUST NEVER BE A BLEND OF TWO LIMBS. The smoothing window used to average whatever
   * arrived, with no record of which limb produced each sample: for a symmetrically seated patient in
   * front of a centred target, the mean of a left-knee sample and a right-knee sample is the midline —
   * dead centre of the target — and the ring filled over a point where NEITHER knee was.
   */
  const LEFT: DwellPoint = { x: 0.5 - 0.2, y: TARGET.y };
  const RIGHT: DwellPoint = { x: 0.5 + 0.2, y: TARGET.y };

  it('two limbs alternating cannot fill a ring neither of them is inside', () => {
    const tracker = new DwellTracker(TARGET, { xScale: 1, smoothingSec: 0.25, requireEntry: false });
    const states: DwellState[] = [];
    for (let i = 0; i < 200; i++) {
      const left = i % 2 === 0;
      states.push(tracker.update(left ? LEFT : RIGHT, i * STEP, left ? 'knee:left' : 'knee:right'));
    }
    expect(states.some((s) => s.confirmed)).toBe(false);
    expect(states.every((s) => !s.withinEntry)).toBe(true);
    // The pointer is always one limb or the other, never the midline between them.
    expect(states.every((s) => !s.pointer || Math.abs(s.pointer.x - TARGET.x) > 0.15)).toBe(true);
  });

  it('…which is exactly what happened when the buffer was not bound to a limb', () => {
    // Same frames, no limb key: the mean of the two is the midline and the ring fills over nothing.
    const tracker = new DwellTracker(TARGET, { xScale: 1, smoothingSec: 0.25, requireEntry: false });
    const states: DwellState[] = [];
    for (let i = 0; i < 200; i++) states.push(tracker.update(i % 2 === 0 ? LEFT : RIGHT, i * STEP));
    expect(states.some((s) => s.confirmed)).toBe(true);
  });

  it('a limb handing over to another one does not inherit its hysteresis', () => {
    // The hand-over happens when the new limb comes INSIDE a target (`pickDwellLimb` never hands the
    // pick from a limb inside one to a limb outside every one), so the hold is not thrown away — but
    // the new limb has to satisfy the ENTRY radius itself. A limb that takes over while sitting in the
    // band, where the previous limb was allowed to wobble, is not holding anything.
    const tracker = new DwellTracker(TARGET, { xScale: 1, smoothingSec: 0 });
    run(tracker, 10, () => AWAY, 0, 'knee:left');
    const filling = run(tracker, 30, () => CENTRE, 0.5, 'knee:left');
    expect(filling.last.progress).toBeGreaterThan(0.4);
    expect(filling.last.inside).toBe(true);

    const inBand = { x: TARGET.x + TARGET.radius * 1.15, y: TARGET.y };
    const handover = run(tracker, 30, () => inBand, 1.6, 'knee:right');
    expect(handover.states.every((s) => !s.confirmed)).toBe(true);
    expect(handover.last.inside).toBe(false);
    expect(handover.last.progress).toBeLessThan(filling.last.progress);
  });

  it('the entry gate is not re-armed by the hand-over itself — that made the gesture impossible', () => {
    // Seen in the running app: the app follows whichever limb is nearest, so the hand-over happens at
    // the exact moment the new limb crosses into the circle. Re-arming the gate there meant the very
    // movement that should have opened it closed it instead, and the ring sat at "move out, then back"
    // for as long as the patient held it.
    const tracker = new DwellTracker(TARGET, { xScale: 1, smoothingSec: 0, holdSec: 1 });
    run(tracker, 10, () => ({ x: 0.2, y: 0.6 }), 0, 'hand:left'); // a limb outside: the gate opens
    const arriving = run(tracker, 60, () => CENTRE, 0.5, 'knee:left'); // …a different limb moves in
    expect(arriving.states.some((s) => s.confirmed)).toBe(true);
  });
});

describe('forgiveness: a dropped landmark must not reset the hold', () => {
  it('decays instead of resetting, and decays more slowly than it fills', () => {
    const tracker = armed({ holdSec: 2, decayRatio: 0.45 });
    run(tracker, 31, () => CENTRE, STEP); // to t = 1.0 s: progress ~0.5
    const filled = tracker.state.progress;
    expect(filled).toBeGreaterThan(0.4);

    // A second with no landmark at all, picking up exactly where the fill left off.
    const gone = 29 * STEP;
    const { last } = run(tracker, 30, () => null, 1 + STEP);
    expect(last.progress).toBeGreaterThan(0);
    expect(last.progress).toBeCloseTo(filled - (gone * 0.45) / 2, 3);
    // The whole point of decayRatio: a second away costs less than a second of holding earns.
    expect(filled - last.progress).toBeLessThan(gone / 2);
    expect(last.tracked).toBe(false);
    expect(last.pointer).toBeNull();
  });

  it('a patient whose landmark arrives two frames in three still gets there', () => {
    const tracker = armed();
    const { states } = run(tracker, 140, (i) => (i % 3 === 2 ? null : CENTRE), STEP);
    expect(states.some((s) => s.confirmed)).toBe(true);
  });

  it('holds the "tracked" claim through a short dropout, and drops it when the limb is really gone', () => {
    const tracker = armed({ graceSec: 0.4 });
    run(tracker, 10, () => CENTRE, STEP);
    // Three dropped frames (100 ms) — the patient has not gone anywhere.
    const brief = run(tracker, 3, () => null, 11 * STEP);
    expect(brief.last.tracked).toBe(true);
    // Half a second of nothing is a lost limb and the screen has to say so.
    const gone = run(tracker, 15, () => null, 11 * STEP + 3 * STEP);
    expect(gone.last.tracked).toBe(false);
  });

  it('progress bottoms out at zero rather than going negative', () => {
    const tracker = armed();
    run(tracker, 10, () => CENTRE, STEP);
    const { last } = run(tracker, 300, () => null, 1);
    expect(last.progress).toBe(0);
  });
});

describe('a camera that is slow rather than gone', () => {
  /**
   * A 4 fps stream is a working camera. The watchdog that feeds the trackers `null` when frames stop
   * used to fire on a flat 0.2 s — a 5 fps floor nothing else in the app enforces (the camera check's
   * readiness gate admits an easy prescription down to 5.6 fps) — so on a slower device it fed a null
   * between EVERY pair of real frames: the ring decayed almost as fast as it filled and a 1.8 s hold
   * took the better part of a minute, while the screen announced that no frames were arriving.
   *
   * This is that watchdog, simulated: 80 ms ticks, real frames at 4 fps, and `staleSec` as the caller
   * computes it (see `dwellCadence` in DwellTarget.tsx).
   */
  const INTERVAL = 0.25;
  const TICK = 0.08;

  function slowCamera(staleSec: number, graceSec: number, maxStepSec: number) {
    const tracker = new DwellTracker(TARGET, { holdSec: 1.8 });
    tracker.setCadence(graceSec, maxStepSec);
    tracker.update(AWAY, 0);
    let lastFrame = 0;
    let confirmedAt: number | null = null;
    let everOffline = false;
    let everLost = false;
    for (let tick = 1; tick <= 250; tick++) {
      const t = tick * TICK;
      let state: DwellState | null = null;
      if (t - lastFrame >= INTERVAL - 1e-9) {
        lastFrame = t;
        state = tracker.update(CENTRE, t);
      } else if (t - lastFrame > staleSec) {
        state = tracker.update(null, t);
      }
      // What the legend beside the preview would be claiming this tick.
      if (t - lastFrame > staleSec) everOffline = true;
      if (state && !state.tracked) everLost = true;
      if (state?.confirmed && confirmedAt === null) confirmedAt = t;
    }
    return { confirmedAt, everOffline, everLost };
  }

  it('fills in about the time it promises, and never claims the camera is gone', () => {
    const { confirmedAt, everOffline, everLost } = slowCamera(INTERVAL * 2.5, INTERVAL * 4, INTERVAL * 2);
    expect(confirmedAt).not.toBeNull();
    // 1.8 s of holding plus the smoothing window, which at 4 fps is one whole frame.
    expect(confirmedAt as number).toBeLessThanOrEqual(1.8 + 2 * INTERVAL);
    expect(everOffline).toBe(false);
    expect(everLost).toBe(false);
  });

  it('and on the old flat 0.2 s floor it neither fills nor tells the truth', () => {
    const { confirmedAt, everOffline } = slowCamera(0.2, 0.4, 0.25);
    // 20 s of holding still, and the ring is nowhere near full…
    expect(confirmedAt).toBeNull();
    // …while the screen would have been saying "no camera frames are arriving" over a working preview.
    expect(everOffline).toBe(true);
  });
});

describe('one hold answers one question', () => {
  it('a limb left parked in the target cannot confirm twice', () => {
    const tracker = armed({ holdSec: 1, refractorySec: 1.5 });
    const { states } = run(tracker, 600, () => CENTRE, STEP); // 20 s of never moving
    expect(states.filter((s) => s.confirmed).length).toBe(1);
  });

  it('refractory clears the half-filled ring so nothing is left over from the answered question', () => {
    const tracker = armed({ holdSec: 1, refractorySec: 1.5 });
    const { states } = run(tracker, 90, () => CENTRE, STEP);
    const after = states.slice(states.findIndex((s) => s.confirmed) + 1);
    expect(after.length).toBeGreaterThan(10);
    expect(after.every((s) => s.progress === 0)).toBe(true);
    expect(after.some((s) => s.blocked === 'refractory')).toBe(true);
  });

  it('confirms again only after the limb has left and come back', () => {
    const tracker = armed({ holdSec: 1, refractorySec: 1.5 });
    const first = run(tracker, 40, () => CENTRE, STEP);
    expect(first.states.filter((s) => s.confirmed).length).toBe(1);
    // Out (past the refractory), then in again: a second, deliberate answer.
    run(tracker, 60, () => AWAY, 2);
    const second = run(tracker, 60, () => CENTRE, 4);
    expect(second.states.filter((s) => s.confirmed).length).toBe(1);
  });
});

describe('a limb already resting where the target is drawn', () => {
  it('does not fill until it has been seen outside — the patient has to actually move in', () => {
    // A seated patient's knee can be exactly where the target lands the moment the screen opens.
    const tracker = new DwellTracker(TARGET, { holdSec: 1 });
    const parked = run(tracker, 120, () => CENTRE, STEP);
    expect(parked.states.some((s) => s.confirmed)).toBe(false);
    expect(parked.last.blocked).toBe('entry');
    expect(parked.last.progress).toBe(0);
    // Move it out, move it back: now it is a choice, and it counts.
    run(tracker, 20, () => AWAY, 5);
    const chosen = run(tracker, 60, () => CENTRE, 6);
    expect(chosen.states.some((s) => s.confirmed)).toBe(true);
  });

  it('a landmark that merely stops being detected does not open the entry gate', () => {
    // Losing the hand is not the same as moving it away, and treating it as such would let a dropout
    // arm a confirm the patient never intended.
    const tracker = new DwellTracker(TARGET, { holdSec: 1 });
    run(tracker, 10, () => CENTRE, STEP);
    run(tracker, 60, () => null, 1);
    const back = run(tracker, 60, () => CENTRE, 4);
    expect(back.states.some((s) => s.confirmed)).toBe(false);
    expect(back.last.blocked).toBe('entry');
  });

  it('requireEntry can be turned off for a target that is only ever shown after a deliberate move', () => {
    const tracker = new DwellTracker(TARGET, { holdSec: 1, requireEntry: false });
    const { states } = run(tracker, 60, () => CENTRE, STEP);
    expect(states.some((s) => s.confirmed)).toBe(true);
  });
});

describe('reset and retarget', () => {
  it('reset clears the hold and re-arms the entry gate', () => {
    const tracker = armed({ holdSec: 1 });
    run(tracker, 20, () => CENTRE, STEP);
    expect(tracker.state.progress).toBeGreaterThan(0);
    tracker.reset();
    expect(tracker.state.progress).toBe(0);
    expect(tracker.state.blocked).toBe('entry');
  });

  it('moving the target abandons the hold that was accumulating against the old one', () => {
    const tracker = armed({ holdSec: 1 });
    run(tracker, 20, () => CENTRE, STEP);
    tracker.setTarget({ x: 0.2, y: 0.7, radius: 0.15 });
    expect(tracker.state.progress).toBe(0);
    // Setting the same circle again is not a change and must not throw away a hold in progress.
    run(tracker, 10, () => ({ x: 0.2, y: 0.7 }), 2);
    const held = tracker.state.progress;
    tracker.setTarget({ x: 0.2, y: 0.7, radius: 0.15 });
    expect(tracker.state.progress).toBe(held);
  });

  it('a camera that turns out not to be 4:3 re-aims the target rather than measuring the wrong one', () => {
    const tracker = new DwellTracker({ x: 0.72, y: 0.4, radius: 0.12 }, { xScale: 4 / 3 });
    run(tracker, 10, () => ({ x: 0.72, y: 0.4 }), 0);
    const wide = retargetForAspect({ x: 0.72, y: 0.4, radius: 0.12 }, 16 / 9);
    tracker.setTarget(wide, 16 / 9);
    expect(tracker.state.progress).toBe(0);
    expect(tracker.state.target).toEqual(wide);
    expect(tracker.state.xScale).toBe(16 / 9);
  });
});

describe('two targets on one screen', () => {
  it('the layouts the screens use are disjoint, hysteresis bands included', () => {
    // Two trackers fed the same pointer is only sound while no point can be inside both.
    const aspect = 4 / 3;
    const left: DwellCircle = { x: 0.28, y: 0.3, radius: 0.12 };
    const right: DwellCircle = { x: 0.72, y: 0.3, radius: 0.095 };
    expect(dwellTargetsOverlap(left, right, DWELL_DEFAULTS.exitRatio, aspect)).toBe(false);
    // …and a pair placed carelessly close is caught.
    expect(dwellTargetsOverlap(left, { ...right, x: 0.45 }, DWELL_DEFAULTS.exitRatio, aspect)).toBe(true);
  });

  it('distance is measured in units of frame height, so the circle tested is the circle drawn', () => {
    const p = { x: 0.5 + 0.15, y: 0.3 };
    expect(dwellDistance(p, TARGET, 1)).toBeCloseTo(0.15, 6);
    expect(dwellDistance(p, TARGET, 4 / 3)).toBeCloseTo(0.2, 6);
  });
});

describe('retargetForAspect', () => {
  it('keeps the offset from the centre the same PHYSICAL distance on a wider sensor', () => {
    const authored: DwellCircle = { x: 0.72, y: 0.4, radius: 0.12 };
    const wide = retargetForAspect(authored, 16 / 9);
    // 0.22 of a 4:3 frame's width is 0.2933 frame heights; the same 0.2933 on 16:9 is 0.165 of width.
    expect((authored.x - 0.5) * (4 / 3)).toBeCloseTo(0.29333, 5);
    expect((wide.x - 0.5) * (16 / 9)).toBeCloseTo(0.29333, 5);
    expect(wide.y).toBe(authored.y);
    expect(wide.radius).toBe(authored.radius);
  });

  it('leaves a 4:3 frame alone and refuses to act on a nonsense aspect', () => {
    const c: DwellCircle = { x: 0.72, y: 0.4, radius: 0.12 };
    expect(retargetForAspect(c, 4 / 3)).toBe(c);
    expect(retargetForAspect(c, 0)).toBe(c);
    expect(retargetForAspect(c, Number.NaN)).toBe(c);
  });
});

/* ---------------- which limb is pointing ---------------- */

function hand(x: number, y: number, label: string, score: number): HandDetection {
  const landmarks: Landmark[] = Array.from({ length: 21 }, () => ({ x, y, z: 0 }));
  // Offset the palm points slightly so the mean is a real centroid, not a repeated point.
  landmarks[HAND.WRIST] = { x, y: y + 0.02, z: 0 };
  landmarks[HAND.INDEX_MCP] = { x: x + 0.01, y: y - 0.01, z: 0 };
  landmarks[HAND.MIDDLE_MCP] = { x, y: y - 0.01, z: 0 };
  landmarks[HAND.RING_MCP] = { x: x - 0.01, y: y - 0.01, z: 0 };
  landmarks[HAND.PINKY_MCP] = { x: x - 0.02, y, z: 0 };
  return { landmarks, label, score };
}

function poseWithKnees(left: DwellPoint, right: DwellPoint, visibility = 0.9): Landmark[] {
  const pose: Landmark[] = Array.from({ length: POSE_LANDMARK_COUNT }, () => ({ x: 0.5, y: 0.5, z: 0, visibility }));
  pose[POSE.LEFT_KNEE] = { x: left.x, y: left.y, z: 0, visibility };
  pose[POSE.RIGHT_KNEE] = { x: right.x, y: right.y, z: 0, visibility };
  return pose;
}

/** A seated figure with its hands somewhere specific: leg mode follows those too. */
function poseWithHands(left: DwellPoint, right: DwellPoint, knees = true): Landmark[] {
  const pose = poseWithKnees({ x: 0.6, y: 0.6 }, { x: 0.4, y: 0.6 });
  if (!knees) {
    pose[POSE.LEFT_KNEE] = { x: 0.6, y: 0.6, z: 0, visibility: 0.1 };
    pose[POSE.RIGHT_KNEE] = { x: 0.4, y: 0.6, z: 0, visibility: 0.1 };
  }
  pose[POSE.LEFT_WRIST] = { x: left.x, y: left.y, z: 0, visibility: 0.9 };
  pose[POSE.RIGHT_WRIST] = { x: right.x, y: right.y, z: 0, visibility: 0.9 };
  return pose;
}

const NO_HANDS: DetectionResult = { tMs: 0, pose: null, hands: [] };

describe('dwellLimbs', () => {
  it('hand mode: one palm centre per detected hand, either side accepted', () => {
    const result: DetectionResult = { ...NO_HANDS, hands: [hand(0.3, 0.4, 'Left', 0.95), hand(0.7, 0.4, 'Right', 0.95)] };
    const limbs = dwellLimbs(result, 'hand', false);
    expect(limbs).toHaveLength(2);
    // Raw (un-mirrored) stream: the MediaPipe label is inverted, so "Left" is the patient's right.
    expect(limbs[0].side).toBe('right');
    expect(limbs[0].label).toBe('your right hand');
    expect(limbs[0].key).toBe('hand:right');
    expect(limbs[1].side).toBe('left');
    expect(limbs[0].point.x).toBeCloseTo(0.3 - 0.004, 3);
  });

  it('hand mode: an unconfident handedness label is reported as unknown, never guessed', () => {
    const result: DetectionResult = { ...NO_HANDS, hands: [hand(0.3, 0.4, 'Left', 0.51)] };
    const [limb] = dwellLimbs(result, 'hand', false);
    expect(limb.side).toBeNull();
    expect(limb.label).toBe('a hand');
    // …and it still gets a key, so two unlabelled hands are never averaged into one pointer.
    expect(limb.key).toBe('hand:#1');
  });

  it('hand mode: the palm LENGTH comes with the pointer, in frame heights', () => {
    // Every clearance hand mode claims is quoted in the patient's own hand (DWELL_LATERAL_FLOOR_PALMS),
    // so the pointer has to carry it. The synthetic hand here is 0.03 from wrist to middle MCP.
    const result: DetectionResult = { ...NO_HANDS, hands: [hand(0.3, 0.4, 'Left', 0.95)] };
    const [limb] = dwellLimbs(result, 'hand', false, 4 / 3);
    expect(limb.scale).toBeCloseTo(0.03, 6);
    // …and it is in frame HEIGHTS: the same hand lying ACROSS the frame is worth more on a wide sensor,
    // which is the whole reason the clearance is quoted in palms and the palm is measured this way.
    const sideways = hand(0.3, 0.4, 'Left', 0.95);
    sideways.landmarks[HAND.WRIST] = { x: 0.3, y: 0.4, z: 0 };
    sideways.landmarks[HAND.MIDDLE_MCP] = { x: 0.34, y: 0.4, z: 0 };
    const narrow = dwellLimbs({ ...NO_HANDS, hands: [sideways] }, 'hand', false, 1)[0];
    const wide = dwellLimbs({ ...NO_HANDS, hands: [sideways] }, 'hand', false, 16 / 9)[0];
    expect(narrow.scale).toBeCloseTo(0.04, 6);
    expect(wide.scale as number).toBeCloseTo(0.04 * (16 / 9), 6);
  });

  it('LEG MODE HAS NO KNEE POINTERS AT ALL — the defect that made this change', () => {
    /**
     * A seated patient puts a knee somewhere only by performing a prescribed leg movement, so every
     * target a knee can hold is a target the exercise fills (see "a knee cannot be given a target it
     * can reach that a rep does not" below). A march with hip circumduction confirmed at the camera
     * check, during a ROM measurement and on the pause dialog, where it ended the session.
     */
    const pose = poseWithHands({ x: 0.7, y: 0.35 }, { x: 0.3, y: 0.7 });
    const limbs = dwellLimbs({ tMs: 0, pose, hands: [] }, 'leg', false);
    expect(limbs.map((l) => l.key)).toEqual(['hand:left', 'hand:right']);
    expect(limbs.every((l) => !l.key.startsWith('knee'))).toBe(true);
    // Even a knee sitting exactly on a target is not offered — there is nothing to offer it to.
    const onTarget = poseWithKnees({ x: TARGET.x, y: TARGET.y }, { x: 0.4, y: 0.6 });
    onTarget[POSE.LEFT_WRIST] = { x: 0.2, y: 0.8, z: 0, visibility: 0.9 };
    onTarget[POSE.RIGHT_WRIST] = { x: 0.8, y: 0.8, z: 0, visibility: 0.9 };
    expect(dwellLimbs({ tMs: 0, pose: onTarget, hands: [] }, 'leg', false).map((l) => l.key)).toEqual([
      'hand:left',
      'hand:right',
    ]);
  });

  it('leg mode: hands, named by the PATIENT side under the mirror convention in force', () => {
    const pose = poseWithHands({ x: 0.7, y: 0.35 }, { x: 0.3, y: 0.7 });
    const limbs = dwellLimbs({ tMs: 0, pose, hands: [] }, 'leg', false);
    expect(limbs.map((l) => l.label)).toEqual(['your left hand', 'your right hand']);
    expect(limbs[0].point).toEqual({ x: 0.7, y: 0.35 });
    // Mirrored: the patient's left hand arrives in the RIGHT_* slot, like every other landmark.
    const mirrored = dwellLimbs({ tMs: 0, pose, hands: [] }, 'leg', true);
    expect(mirrored.find((l) => l.key === 'hand:left')?.point).toEqual({ x: 0.3, y: 0.7 });
  });

  it('leg mode: a knees-up framing with no hands in the picture has NO hands-free pointer', () => {
    // Pose extrapolates landmarks off the edge of the image and still calls them visible; a limb the
    // patient cannot see in the preview must not be able to drive a target they can. With the knees
    // out of the running that leaves nothing — which is a real cost of the fix, and is why
    // `DwellLegend` says "No hand in view" and points at the buttons instead of a dead ring.
    const pose = poseWithHands({ x: 0.7, y: -0.2 }, { x: 1.3, y: 0.5 });
    expect(dwellLimbs({ tMs: 0, pose, hands: [] }, 'leg', false)).toEqual([]);
  });

  it('leg mode: a hand below the visibility floor is not offered as a pointer', () => {
    const pose = poseWithHands({ x: 0.35, y: 0.65 }, { x: 0.65, y: 0.62 });
    pose[POSE.LEFT_WRIST] = { ...pose[POSE.LEFT_WRIST], visibility: 0.2 };
    pose[POSE.RIGHT_WRIST] = { ...pose[POSE.RIGHT_WRIST], visibility: 0.2 };
    expect(dwellLimbs({ tMs: 0, pose, hands: [] }, 'leg', false)).toEqual([]);
  });

  it('hand mode: a palm outside the frame is not a pointer', () => {
    const result: DetectionResult = { ...NO_HANDS, hands: [hand(1.2, 0.4, 'Left', 0.95)] };
    expect(dwellLimbs(result, 'hand', false)).toEqual([]);
  });

  it('no detection at all is no limbs, not a fabricated one', () => {
    expect(dwellLimbs(null, 'hand', false)).toEqual([]);
    expect(dwellLimbs({ tMs: 0, pose: null, hands: [] }, 'leg', false)).toEqual([]);
  });
});

describe('pickDwellLimb', () => {
  const aspect = 4 / 3;
  const targets = [TARGET];
  const limb = (x: number, y: number, side: 'left' | 'right', what = 'hand'): DwellLimb => ({
    point: { x, y },
    side,
    label: `your ${side} ${what}`,
    key: `${what}:${side}`,
    scale: null,
  });

  it('a limb inside the target beats a nearer-looking limb outside it', () => {
    const inside = { point: CENTRE, side: 'left' as const, label: 'your left hand', key: 'hand:left', scale: null };
    const outside = limb(0.5, 0.5, 'right', 'hand');
    expect(pickDwellLimb([outside, inside], targets, { xScale: aspect })?.side).toBe('left');
  });

  it('with nothing inside, it follows whichever limb is nearest — including the unaffected side', () => {
    expect(pickDwellLimb([limb(0.1, 0.9, 'left'), limb(0.5, 0.45, 'right')], targets, { xScale: aspect })?.side).toBe('right');
  });

  it('sticks to the limb it was already following instead of swapping between two equal candidates', () => {
    const left = limb(0.4, 0.5, 'left');
    const right = limb(0.6, 0.5, 'right');
    const first = pickDwellLimb([left, right], targets, { xScale: aspect });
    const again = pickDwellLimb([right, left], targets, { xScale: aspect, previous: first?.point, previousKey: first?.key });
    expect(again?.side).toBe(first?.side);
  });

  it('keeps following the SAME limb across a move the continuity radius alone would lose', () => {
    // Two knees are 0.267 frame-heights apart — further than any continuity radius that also tolerates
    // a limb moving, which is why identity decides it and proximity only breaks ties.
    const left = limb(0.6, 0.6, 'left');
    const right = limb(0.4, 0.6, 'right');
    const moved = limb(0.55, 0.35, 'left');
    const pick = pickDwellLimb([moved, right], targets, { xScale: aspect, previous: left.point, previousKey: 'hand:left' });
    expect(pick?.key).toBe('hand:left');
  });

  it('lets go of a limb that is no longer a candidate at all', () => {
    const atTarget = { point: CENTRE, side: 'right' as const, label: 'your right hand', key: 'hand:right', scale: null };
    const pick = pickDwellLimb([atTarget], targets, { xScale: aspect, previous: { x: 0.4, y: 0.5 }, previousKey: 'hand:left' });
    expect(pick?.side).toBe('right');
  });

  it('no limbs is null — never a pointer at the origin', () => {
    expect(pickDwellLimb([], targets, {})).toBeNull();
  });
});

/* ---------------- why a knee is not a pointer ---------------- */

describe('a knee cannot be given a target it can reach that a rep does not', () => {
  /**
   * THE REASON LEG MODE FOLLOWS HANDS. This is the claim the whole fix rests on, so it is measured
   * rather than asserted: take every circle a dwell target could be placed at, ask whether a seated
   * knee can be inside it at all, and — when it can — how long a single unpaced repetition DWELLS
   * inside it. If that time reaches the hold, the exercise fills the ring, and there is no placement
   * left to try.
   *
   * The rig is this repo's own seated figure, swept over the two things a leg prescription moves a
   * knee with: lift (seated_march) and lateral travel (hip_abduction, in both directions, which covers
   * the circumduction compensation the critic drove).
   */
  const LIFTS = Array.from({ length: 41 }, (_, i) => i / 40);
  const ABDUCTIONS = Array.from({ length: 21 }, (_, i) => -1 + i / 10);
  const ASPECT = 4 / 3;

  /** knee[side][abductionIndex][liftIndex] */
  const KNEES = (['left', 'right'] as const).map((side) =>
    ABDUCTIONS.map((abduction) =>
      LIFTS.map((kneeLift) => {
        const pose = seatedPose({ kneeLift, abduction, side });
        const k = pose[side === 'left' ? POSE.LEFT_KNEE : POSE.RIGHT_KNEE];
        return { x: k.x, y: k.y };
      }),
    ),
  );

  /** Seconds one REP_PROFILE repetition spends with its amount inside [lo, hi]. */
  function dwellSec(lo: number, hi: number): number {
    const span = REP_PROFILE.riseSec + REP_PROFILE.holdSec + REP_PROFILE.fallSec;
    let sec = 0;
    for (let t = 0; t <= span; t += STEP) {
      const a = repAmount(t, REP_PROFILE);
      if (a >= lo - 1e-9 && a <= hi + 1e-9) sec += STEP;
    }
    return sec;
  }

  it('every circle a knee can be inside is one a repetition fills, or one the patient can just SIT in', () => {
    let reachable = 0;
    let filled = 0;
    let postural = 0;
    const escapes: string[] = [];
    for (const radius of [0.115, 0.09]) {
      for (let cx = 0.1; cx <= 0.9001; cx += 0.05) {
        for (let cy = 0.1; cy <= 0.9001; cy += 0.05) {
          const circle: DwellCircle = { x: cx, y: cy, radius };
          let best = 0;
          let can = false;
          // A posture rather than a repetition: the knee is in the circle with the leg barely lifted,
          // so the patient reaches it by sitting rather than by moving. Just as disqualifying — a ring
          // that fills because of how somebody is sitting is a confirm nobody made.
          let sitting = false;
          for (let s = 0; s < 2; s++) {
            for (let a = 0; a < ABDUCTIONS.length; a++) {
              let lo = Infinity;
              let hi = -Infinity;
              for (let l = 0; l < LIFTS.length; l++) {
                if (dwellDistance(KNEES[s][a][l], circle, ASPECT) <= radius) {
                  can = true;
                  if (LIFTS[l] <= 0.2) sitting = true;
                  lo = Math.min(lo, LIFTS[l]);
                  hi = Math.max(hi, LIFTS[l]);
                }
              }
              if (lo <= hi) best = Math.max(best, dwellSec(lo, hi));
            }
          }
          if (!can) continue;
          reachable += 1;
          if (best >= DWELL_DEFAULTS.holdSec) filled += 1;
          else if (sitting) postural += 1;
          else escapes.push(`r${radius} @(${cx.toFixed(2)}, ${cy.toFixed(2)}) — longest rep dwell ${best.toFixed(2)} s`);
        }
      }
    }
    // There are plenty of such circles — this is not vacuously true of an empty set.
    expect(reachable).toBeGreaterThan(100);
    expect(filled).toBeGreaterThan(100);
    expect(postural).toBeGreaterThan(0);
    // NOTHING is left: there is no circle a knee can hold that the prescription does not also hold.
    // Which is why leg mode follows hands, and why a longer hold or a cleverer placement is not a fix.
    expect(escapes.join('\n')).toBe('');
  });

  it('and the pair the app actually places is inside that set — measured, not argued', () => {
    // The circles the screens place in leg mode, against a knee at full lift with the circumduction
    // the critic drove. 0.04 of a frame height from the centre: a quarter of the way in.
    for (const [side, circle] of [
      ['left', { x: 0.72, y: 0.32, radius: 0.115 }],
      ['right', { x: 0.28, y: 0.32, radius: 0.09 }],
    ] as const) {
      const pose = seatedPose({ kneeLift: 1, abduction: 1, side });
      const knee = pose[side === 'left' ? POSE.LEFT_KNEE : POSE.RIGHT_KNEE];
      expect(dwellDistance(knee, circle, ASPECT), side).toBeLessThan(circle.radius);
    }
  });
});

/* ---------------- where a limb lives, measured ---------------- */

describe('DwellHabitat', () => {
  /** Feed `n` seconds of a limb at `at(t)`, 30 fps, starting at `t0`. */
  function feed(h: DwellHabitat, key: string, from: number, to: number, at: (t: number) => DwellPoint, scale: number | null = null) {
    for (let t = from; t <= to + 1e-9; t += STEP) h.noteOne(key, at(t), t, scale);
    return to;
  }

  it('records time spent rather than frames delivered, so a 60 fps camera cannot outvote a 5 fps one', () => {
    // Without the thinning a fast camera would put twelve times as many samples into the record as a
    // slow one, and every percentile in here would be a statement about the webcam. It cannot invent
    // samples a slow camera never sent, so the two are not equal — but they are the same order, and
    // the record is a measure of the ten seconds rather than of the 600 frames.
    const fast = new DwellHabitat();
    const slow = new DwellHabitat();
    for (let t = 0; t <= 10; t += 1 / 60) fast.noteOne('hand:left', { x: 0.3, y: 0.7 }, t);
    for (let t = 0; t <= 10; t += 1 / 5) slow.noteOne('hand:left', { x: 0.3, y: 0.7 }, t);
    const a = (fast.get('hand:left') as DwellHabitatSummary).samples;
    const b = (slow.get('hand:left') as DwellHabitatSummary).samples;
    expect(a).toBeLessThanOrEqual(Math.ceil(10 / DWELL_HABITAT_INTERVAL_SEC) + 1);
    expect(a / b).toBeLessThan(2.5);
  });

  it('a limb sitting still lives exactly where it sits, and wanders nowhere', () => {
    const h = new DwellHabitat();
    feed(h, 'hand:left', 0, 8, () => ({ x: 0.3, y: 0.7 }));
    const s = h.get('hand:left', 4 / 3) as DwellHabitatSummary;
    expect(s.home.x).toBeCloseTo(0.3, 6);
    expect(s.home.y).toBeCloseTo(0.7, 6);
    expect(s.spread).toBeCloseTo(0, 6);
    expect(s.settled).toBe(true);
  });

  it('A TWO-SECOND REACH DOES NOT MOVE IT — the circularity that makes the naive version unusable', () => {
    // The whole reason this is read with order statistics. If reaching toward the target taught the
    // record that the limb lives there, the requirement would grow by exactly the reach the gesture
    // consists of and no patient could ever finish a hold.
    const h = new DwellHabitat();
    let t = feed(h, 'hand:left', 0, 18, () => ({ x: 0.3, y: 0.7 }));
    const before = h.get('hand:left', 4 / 3) as DwellHabitatSummary;
    t = feed(h, 'hand:left', t + STEP, t + 2, () => ({ x: 0.72, y: 0.32 }));
    const after = h.get('hand:left', 4 / 3) as DwellHabitatSummary;
    expect(after.home.x).toBeCloseTo(before.home.x, 3);
    expect(after.home.y).toBeCloseTo(before.home.y, 3);
    expect(after.spread).toBeLessThan(0.02);
  });

  it('…but a movement the patient REPEATS is where they live, and the record says so at once', () => {
    // The other half: an exercise is not an excursion, it is what the limb is doing. Eight seconds of
    // repetitions out of twenty is a quarter of the record and the wander is measured, not assumed.
    const h = new DwellHabitat();
    let t = feed(h, 'hand:left', 0, 10, () => ({ x: 0.5, y: 0.7 }));
    for (let rep = 0; rep < 4; rep++) {
      t = feed(h, 'hand:left', t + STEP, t + 2, (u) => ({ x: 0.5, y: 0.7 - 0.25 * repAmount(u - (t + STEP), { riseSec: 0.8, holdSec: 0.4, fallSec: 0.8 }) }));
    }
    const s = h.get('hand:left', 4 / 3) as DwellHabitatSummary;
    expect(s.spread).toBeGreaterThan(0.05);
  });

  it('before it has seen enough, a limb lives exactly where it is — the conservative reading', () => {
    const h = new DwellHabitat();
    h.noteOne('hand:left', { x: 0.72, y: 0.32 }, 0);
    const s = h.get('hand:left', 4 / 3) as DwellHabitatSummary;
    expect(s.settled).toBe(false);
    expect(s.home).toEqual({ x: 0.72, y: 0.32 });
    // A target on top of it is refused rather than given a benefit of the doubt nobody has measured.
    expect(dwellTargetClear({ x: 0.72, y: 0.32, radius: 0.115 }, [s], { xScale: 4 / 3 }).clear).toBe(false);
  });

  it('a limb that has left the picture stops constraining anything', () => {
    const h = new DwellHabitat();
    feed(h, 'hand:left', 0, 6, () => ({ x: 0.72, y: 0.32 }));
    expect(h.all(6, 4 / 3)).toHaveLength(1);
    expect(h.all(6 + DWELL_HABITAT_FORGET_SEC + 0.1, 4 / 3)).toHaveLength(0);
  });

  it('keeps limbs apart: two hands are two records, never one average', () => {
    const h = new DwellHabitat();
    for (let t = 0; t <= 8; t += STEP) {
      h.noteOne('hand:left', { x: 0.3, y: 0.7 }, t);
      h.noteOne('hand:right', { x: 0.7, y: 0.7 }, t);
    }
    const all = h.all(8, 4 / 3);
    expect(all.map((s) => s.key).sort()).toEqual(['hand:left', 'hand:right']);
    expect(all.every((s) => Math.abs(s.home.x - 0.5) > 0.15)).toBe(true);
  });
});

describe('dwellClearance', () => {
  const rest: DwellHabitatSummary = {
    key: 'hand:left',
    home: { x: 0.5, y: 0.63 },
    spread: 0.02,
    lateralSpread: 0.01,
    scale: 0.15,
    samples: 200,
    lastSeen: 0,
    settled: true,
  };

  it('leg mode counts the whole distance, band and measured wander included', () => {
    const near: DwellCircle = { x: 0.72, y: 0.45, radius: 0.115 };
    const c = dwellClearance(near, { ...rest, scale: null }, { xScale: 4 / 3, axis: 'radial' });
    // exit radius 0.1438 + margin 0.03 + the wander this limb was measured making.
    expect(c.required).toBeCloseTo(0.115 * DWELL_DEFAULTS.exitRatio + DWELL_CLEAR_MARGIN + 0.02, 6);
    expect(c.actual).toBeCloseTo(dwellDistance(rest.home, near, 4 / 3), 6);
    expect(c.clear).toBe(c.actual >= c.required);
  });

  it('hand mode counts only what the prescription cannot eat: the distance ACROSS the frame', () => {
    // A target directly above the palm is not separated at all, however far up it is: wrist extension
    // and a forearm lift travel straight through it (1.94 palm lengths, measured in DwellTarget.test).
    const above: DwellCircle = { x: 0.5, y: 0.2, radius: 0.115 };
    expect(dwellClearance(above, rest, { xScale: 4 / 3, axis: 'lateral' }).clear).toBe(false);
    // …and one to the side is, whatever it does vertically.
    const beside: DwellCircle = { x: 0.79, y: 0.37, radius: 0.115 };
    const c = dwellClearance(beside, rest, { xScale: 4 / 3, axis: 'lateral' });
    expect(c.actual).toBeCloseTo(0.29 * (4 / 3), 6);
    expect(c.clear).toBe(true);
  });

  it('the lateral floor is quoted in the PATIENT’s hand, so a closer camera demands more room', () => {
    const big = { ...rest, scale: 0.24 };
    const beside: DwellCircle = { x: 0.72, y: 0.37, radius: 0.115 };
    const small = dwellClearance(beside, rest, { xScale: 4 / 3, axis: 'lateral' });
    const large = dwellClearance(beside, big, { xScale: 4 / 3, axis: 'lateral' });
    expect(large.required).toBeGreaterThan(small.required);
    expect(large.required - small.required).toBeCloseTo((0.24 - 0.15) * DWELL_LATERAL_FLOOR_PALMS, 6);
  });

  it('with nothing in view there is nothing to clear, and a target is not blocked by a ghost', () => {
    expect(dwellTargetClear({ x: 0.72, y: 0.32, radius: 0.115 }, [], { xScale: 4 / 3 }).clear).toBe(true);
  });

  it('the WORST limb decides, not the average of them', () => {
    const other: DwellHabitatSummary = { ...rest, key: 'hand:right', home: { x: 0.72, y: 0.33 } };
    const circle: DwellCircle = { x: 0.72, y: 0.32, radius: 0.115 };
    const c = dwellTargetClear(circle, [rest, other], { xScale: 4 / 3, axis: 'radial' });
    expect(c.key).toBe('hand:right');
    expect(c.clear).toBe(false);
  });
});

describe('placeDwellCircle', () => {
  const hand = (x: number, y: number, key = 'hand:left', scale: number | null = null): DwellHabitatSummary => ({
    key,
    home: { x, y },
    spread: 0.02,
    lateralSpread: 0.01,
    scale,
    samples: 200,
    lastSeen: 0,
    settled: true,
  });
  const opts = { xScale: 4 / 3, axis: 'radial' as const, extra: DWELL_CLEAR_EXTRA };

  it('leaves a target alone when the patient is nowhere near it', () => {
    const authored: DwellCircle = { x: 0.72, y: 0.32, radius: 0.115 };
    const placement = placeDwellCircle(authored, [hand(0.6, 0.75)], opts);
    expect(placement.circle).toEqual(authored);
    expect(placement.moved).toBe(0);
    expect(placement.placeable).toBe(true);
  });

  it('moves off a hand that rests high — the escape a fixture sweep could not see', () => {
    // (0.70, 0.45): 0.1327 from the primary centre against an exit radius of 0.1438. Inside the band.
    const authored: DwellCircle = { x: 0.72, y: 0.32, radius: 0.115 };
    const resting = hand(0.7, 0.45);
    expect(dwellTargetClear(authored, [resting], opts).clear).toBe(false);
    const placement = placeDwellCircle(authored, [resting], opts);
    expect(placement.placeable).toBe(true);
    expect(placement.moved).toBeGreaterThan(0);
    // It clears by the margin a reach is worth, not by a hair…
    const room = dwellTargetClear(placement.circle, [resting], opts);
    expect(room.actual - room.required).toBeGreaterThanOrEqual(DWELL_CLEAR_EXTRA - 1e-9);
    // …and it is the SMALLEST move that does: a patient who has learned where the circle is should
    // find it near where it was, not on the other side of the preview.
    expect(placement.moved).toBeLessThan(0.2);
  });

  it('goes UP when up is the only way out — the direction leg mode asks the gesture to be made in', () => {
    const authored: DwellCircle = { x: 0.72, y: 0.32, radius: 0.115 };
    const resting = hand(0.72, 0.45);
    // Pin x: the only freedom left is the axis the confirm gesture is made in.
    const placement = placeDwellCircle(authored, [resting], { ...opts, fits: (c) => Math.abs(c.x - authored.x) < 1e-9 });
    expect(placement.placeable).toBe(true);
    expect(placement.circle.y).toBeLessThan(authored.y);
  });

  it('moves a hand-mode target SIDEWAYS, because that is the way the table lets an arm travel', () => {
    const authored: DwellCircle = { x: 0.72, y: 0.37, radius: 0.115 };
    const palm = hand(0.72, 0.44, 'hand:right', 0.15);
    const handOpts = { xScale: 4 / 3, axis: 'lateral' as const, extra: DWELL_CLEAR_EXTRA };
    expect(dwellTargetClear(authored, [palm], handOpts).clear).toBe(false);
    const placement = placeDwellCircle(authored, [palm], handOpts);
    expect(placement.placeable).toBe(true);
    expect(placement.circle.y).toBe(authored.y);
    expect(Math.abs(placement.circle.x - authored.x)).toBeGreaterThan(0.1);
    expect(dwellTargetClear(placement.circle, [palm], handOpts).clear).toBe(true);
  });

  it('will not put a target where it cannot be drawn, or on top of the other one', () => {
    const authored: DwellCircle = { x: 0.72, y: 0.32, radius: 0.115 };
    const resting = hand(0.7, 0.45);
    // Only the band 0.30..0.34 is allowed to exist: nothing there clears, so it says so.
    const boxed = placeDwellCircle(authored, [resting], {
      ...opts,
      fits: (c) => c.y >= 0.3 && c.y <= 0.34 && Math.abs(c.x - authored.x) < 0.02,
    });
    expect(boxed.placeable).toBe(false);
    // And a candidate that would land on the other ring is refused, band included.
    const taken: DwellCircle = { x: 0.72, y: 0.15, radius: 0.115 };
    const placement = placeDwellCircle(authored, [resting], { ...opts, taken: [taken] });
    expect(dwellTargetsOverlap(placement.circle, taken, DWELL_DEFAULTS.exitRatio, 4 / 3)).toBe(false);
  });

  it('clears EVERY limb in view, not just the nearest one', () => {
    const authored: DwellCircle = { x: 0.72, y: 0.32, radius: 0.115 };
    const summaries = [hand(0.7, 0.45), hand(0.72, 0.12, 'hand:right')];
    const placement = placeDwellCircle(authored, summaries, opts);
    for (const s of summaries) expect(dwellClearance(placement.circle, s, opts).clear).toBe(true);
  });
});

describe('a target standing on a limb cannot be held', () => {
  it('accumulates nothing, says why, and gives back what it had', () => {
    const tracker = armed({ holdSec: 1 });
    run(tracker, 15, () => CENTRE, STEP);
    const earned = tracker.state.progress;
    expect(earned).toBeGreaterThan(0.3);
    tracker.setOccupied(true);
    const blocked = run(tracker, 200, () => CENTRE, 1);
    expect(blocked.states.some((s) => s.confirmed)).toBe(false);
    expect(blocked.last.blocked).toBe('occupied');
    expect(blocked.last.holding).toBe(false);
    expect(blocked.last.progress).toBe(0);
    // …and when the ring has moved somewhere clear, the same limb can answer with it.
    tracker.setOccupied(false);
    run(tracker, 10, () => AWAY, 10);
    expect(run(tracker, 60, () => CENTRE, 11).states.some((s) => s.confirmed)).toBe(true);
  });

  it('outranks the entry gate, and is outranked by the refractory period', () => {
    const tracker = new DwellTracker(TARGET, { holdSec: 1 });
    tracker.setOccupied(true);
    expect(tracker.update(CENTRE, STEP).blocked).toBe('occupied');
    const done = armed({ holdSec: 1 });
    run(done, 60, () => CENTRE, STEP);
    done.setOccupied(true);
    expect(done.update(CENTRE, 2.1).blocked).toBe('refractory');
  });
});
