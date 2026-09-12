/**
 * The dwell maths, frame by frame.
 *
 * Every case here is a patient this feature exists for: a hand that shakes, a landmark that drops out
 * on a 12 fps clinic webcam, a knee already resting where the target is drawn, a limb parked on the
 * boundary of the circle. The failure mode each test pins down is the same one — a hands-free path
 * that works for a steady hand and strands everybody else.
 */
import { describe, expect, it } from 'vitest';
import {
  DWELL_DEFAULTS,
  DwellTracker,
  dwellDistance,
  dwellLimbs,
  dwellTargetsOverlap,
  pickDwellLimb,
} from './dwell.ts';
import type { DwellCircle, DwellPoint, DwellState } from './dwell.ts';
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
): { last: DwellState; states: DwellState[] } {
  const states: DwellState[] = [];
  for (let i = 0; i < frames; i++) {
    const t = start + i * STEP;
    states.push(tracker.update(at(i, t), t));
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
    const inBand = { x: TARGET.x + TARGET.radius * 1.3, y: TARGET.y };
    const beyondExit = { x: TARGET.x + TARGET.radius * 1.6, y: TARGET.y };

    expect(tracker.update(justOutside, STEP).inside).toBe(false);
    expect(tracker.update(CENTRE, 2 * STEP).inside).toBe(true);
    // Inside the hysteresis band: a wobble past the drawn edge does NOT end the hold.
    expect(tracker.update(inBand, 3 * STEP).inside).toBe(true);
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
});

describe('two targets on one screen', () => {
  it('the layouts the screens use are disjoint, hysteresis bands included', () => {
    // Two trackers fed the same pointer is only sound while no point can be inside both.
    const aspect = 4 / 3;
    const left: DwellCircle = { x: 0.27, y: 0.3, radius: 0.15 };
    const right: DwellCircle = { x: 0.73, y: 0.3, radius: 0.15 };
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

const NO_HANDS: DetectionResult = { tMs: 0, pose: null, hands: [] };

describe('dwellLimbs', () => {
  it('hand mode: one palm centre per detected hand, either side accepted', () => {
    const result: DetectionResult = { ...NO_HANDS, hands: [hand(0.3, 0.4, 'Left', 0.95), hand(0.7, 0.4, 'Right', 0.95)] };
    const limbs = dwellLimbs(result, 'hand', false);
    expect(limbs).toHaveLength(2);
    // Raw (un-mirrored) stream: the MediaPipe label is inverted, so "Left" is the patient's right.
    expect(limbs[0].side).toBe('right');
    expect(limbs[0].label).toBe('your right hand');
    expect(limbs[1].side).toBe('left');
    expect(limbs[0].point.x).toBeCloseTo(0.3 - 0.004, 3);
  });

  it('hand mode: an unconfident handedness label is reported as unknown, never guessed', () => {
    const result: DetectionResult = { ...NO_HANDS, hands: [hand(0.3, 0.4, 'Left', 0.51)] };
    const [limb] = dwellLimbs(result, 'hand', false);
    expect(limb.side).toBeNull();
    expect(limb.label).toBe('a hand');
  });

  it('leg mode: knees, named by the PATIENT side under the mirror convention in force', () => {
    const pose = poseWithKnees({ x: 0.35, y: 0.65 }, { x: 0.65, y: 0.62 });
    const raw = dwellLimbs({ tMs: 0, pose, hands: [] }, 'leg', false);
    expect(raw.map((l) => l.label)).toEqual(['your left knee', 'your right knee']);
    expect(raw[0].point).toEqual({ x: 0.35, y: 0.65 });

    // Mirrored capture: the model puts the patient's left leg in the RIGHT_* slots.
    const mirrored = dwellLimbs({ tMs: 0, pose, hands: [] }, 'leg', true);
    expect(mirrored[0].label).toBe('your left knee');
    expect(mirrored[0].point).toEqual({ x: 0.65, y: 0.62 });
  });

  it('leg mode: a knee below the visibility floor is not offered as a pointer', () => {
    const pose = poseWithKnees({ x: 0.35, y: 0.65 }, { x: 0.65, y: 0.62 }, 0.2);
    expect(dwellLimbs({ tMs: 0, pose, hands: [] }, 'leg', false)).toEqual([]);
  });

  it('no detection at all is no limbs, not a fabricated one', () => {
    expect(dwellLimbs(null, 'hand', false)).toEqual([]);
    expect(dwellLimbs({ tMs: 0, pose: null, hands: [] }, 'leg', false)).toEqual([]);
  });
});

describe('pickDwellLimb', () => {
  const aspect = 4 / 3;
  const targets = [TARGET];

  it('a limb inside the target beats a nearer-looking limb outside it', () => {
    const inside = { point: CENTRE, side: 'left' as const, label: 'your left hand' };
    const outside = { point: { x: 0.5, y: 0.5 }, side: 'right' as const, label: 'your right hand' };
    expect(pickDwellLimb([outside, inside], targets, { xScale: aspect })?.side).toBe('left');
  });

  it('with nothing inside, it follows whichever limb is nearest — including the unaffected side', () => {
    const far = { point: { x: 0.1, y: 0.9 }, side: 'left' as const, label: 'your left knee' };
    const near = { point: { x: 0.5, y: 0.45 }, side: 'right' as const, label: 'your right knee' };
    expect(pickDwellLimb([far, near], targets, { xScale: aspect })?.side).toBe('right');
  });

  it('sticks to the limb it was already following instead of swapping between two equal candidates', () => {
    const left = { point: { x: 0.4, y: 0.5 }, side: 'left' as const, label: 'your left knee' };
    const right = { point: { x: 0.6, y: 0.5 }, side: 'right' as const, label: 'your right knee' };
    const first = pickDwellLimb([left, right], targets, { xScale: aspect });
    const again = pickDwellLimb([right, left], targets, { xScale: aspect, previous: first?.point });
    expect(again?.side).toBe(first?.side);
  });

  it('lets go of a limb that has moved right across the frame rather than following a swap', () => {
    const moved = { point: { x: 0.9, y: 0.9 }, side: 'left' as const, label: 'your left hand' };
    const atTarget = { point: CENTRE, side: 'right' as const, label: 'your right hand' };
    expect(pickDwellLimb([moved, atTarget], targets, { xScale: aspect, previous: { x: 0.4, y: 0.5 } })?.side).toBe('right');
  });

  it('no limbs is null — never a pointer at the origin', () => {
    expect(pickDwellLimb([], targets, {})).toBeNull();
  });
});
