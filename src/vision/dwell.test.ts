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
 */
import { describe, expect, it } from 'vitest';
import {
  DWELL_DEFAULTS,
  DwellTracker,
  dwellDistance,
  dwellLimbs,
  dwellTargetsOverlap,
  pickDwellLimb,
  retargetForAspect,
} from './dwell.ts';
import type { DwellCircle, DwellLimb, DwellPoint, DwellState } from './dwell.ts';
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

  it('a limb swinging through the target on the way past cannot confirm', () => {
    // A rep: 200 ms crossing the target, then gone. Nothing in this app asks for a rep slower than
    // that, which is exactly why dwelling on the target is not dwelling on the exercise.
    const tracker = armed();
    let confirms = 0;
    for (let rep = 0; rep < 8; rep++) {
      const { states } = run(
        tracker,
        30,
        (i) => (i < 6 ? CENTRE : AWAY),
        rep * 1.2,
      );
      confirms += states.filter((s) => s.confirmed).length;
    }
    expect(confirms).toBe(0);
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

  it('leg mode: knees, named by the PATIENT side under the mirror convention in force', () => {
    const pose = poseWithKnees({ x: 0.35, y: 0.65 }, { x: 0.65, y: 0.62 });
    const raw = dwellLimbs({ tMs: 0, pose, hands: [] }, 'leg', false).filter((l) => l.key.startsWith('knee'));
    expect(raw.map((l) => l.label)).toEqual(['your left knee', 'your right knee']);
    expect(raw[0].point).toEqual({ x: 0.35, y: 0.65 });

    // Mirrored capture: the model puts the patient's left leg in the RIGHT_* slots.
    const mirrored = dwellLimbs({ tMs: 0, pose, hands: [] }, 'leg', true).filter((l) => l.key.startsWith('knee'));
    expect(mirrored[0].label).toBe('your left knee');
    expect(mirrored[0].point).toEqual({ x: 0.65, y: 0.62 });
  });

  it('leg mode: a hand is a pointer too — the patient is exercising their legs, not their arms', () => {
    const pose = poseWithHands({ x: 0.7, y: 0.35 }, { x: 0.3, y: 0.7 });
    const limbs = dwellLimbs({ tMs: 0, pose, hands: [] }, 'leg', false);
    expect(limbs.map((l) => l.key)).toEqual(['knee:left', 'knee:right', 'hand:left', 'hand:right']);
    expect(limbs[2].label).toBe('your left hand');
    expect(limbs[2].point).toEqual({ x: 0.7, y: 0.35 });
    // Mirrored: the patient's left hand arrives in the RIGHT_* slot, like every other landmark.
    const mirrored = dwellLimbs({ tMs: 0, pose, hands: [] }, 'leg', true);
    expect(mirrored.find((l) => l.key === 'hand:left')?.point).toEqual({ x: 0.3, y: 0.7 });
  });

  it('leg mode: a knees-up framing with no hands in the picture still has its knees', () => {
    const pose = poseWithHands({ x: 0.7, y: -0.2 }, { x: 1.3, y: 0.5 });
    const limbs = dwellLimbs({ tMs: 0, pose, hands: [] }, 'leg', false);
    // Pose extrapolates landmarks off the edge of the image and still calls them visible; a limb the
    // patient cannot see in the preview must not be able to drive a target they can.
    expect(limbs.map((l) => l.key)).toEqual(['knee:left', 'knee:right']);
  });

  it('leg mode: a knee below the visibility floor is not offered as a pointer', () => {
    const pose = poseWithKnees({ x: 0.35, y: 0.65 }, { x: 0.65, y: 0.62 }, 0.2);
    expect(dwellLimbs({ tMs: 0, pose, hands: [] }, 'leg', false).filter((l) => l.key.startsWith('knee'))).toEqual([]);
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
  const limb = (x: number, y: number, side: 'left' | 'right', what = 'knee'): DwellLimb => ({
    point: { x, y },
    side,
    label: `your ${side} ${what}`,
    key: `${what}:${side}`,
  });

  it('a limb inside the target beats a nearer-looking limb outside it', () => {
    const inside = { point: CENTRE, side: 'left' as const, label: 'your left hand', key: 'hand:left' };
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
    const pick = pickDwellLimb([moved, right], targets, { xScale: aspect, previous: left.point, previousKey: 'knee:left' });
    expect(pick?.key).toBe('knee:left');
  });

  it('lets go of a limb that is no longer a candidate at all', () => {
    const atTarget = { point: CENTRE, side: 'right' as const, label: 'your right hand', key: 'hand:right' };
    const pick = pickDwellLimb([atTarget], targets, { xScale: aspect, previous: { x: 0.4, y: 0.5 }, previousKey: 'hand:left' });
    expect(pick?.side).toBe('right');
  });

  it('no limbs is null — never a pointer at the origin', () => {
    expect(pickDwellLimb([], targets, {})).toBeNull();
  });
});
