import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_GAP_SEC,
  DEFAULT_REARM_FRACTION,
  GOAL_FADE_SEC,
  GOAL_HOLD_SEC,
  GOAL_MIN_SEC,
  LOST_HOLD_SEC,
  REFRACTORY_GUARD_MIN_SEC,
  ReceptorHistory,
  emptyReceptorLook,
  goalStrength,
  receptorGoalHolding,
  receptorLook,
  receptorMarkSet,
  receptorLookInto,
  refractoryGuard,
  type LaneStateLike,
  type ReceptorLook,
} from './receptor';
import { DEFAULT_MAX_GAP_SEC as TRIGGER_MAX_GAP_SEC, LaneTrigger } from '../vision/trigger';
import { AutoplayInput } from '../input/AutoplayInput';
import { KeyboardInput } from '../input/KeyboardInput';
import type { InputSource } from '../input/types';
import type { LaneSpec } from '../engine/types';
import type { RomCalibration } from '../vision/calibration';
import { extractFeature } from '../vision/features';
import { seatedPose } from '../vision/fixtures';

const T = 0.6; // a plausible calibrated thresholdFraction

describe('receptorLook — the meter means what the engine means', () => {
  it('fills against thresholdFraction, not against 1.0', () => {
    expect(receptorLook({ value: 0, armed: true }, T).fill).toBe(0);
    expect(receptorLook({ value: 0.3, armed: true }, T).fill).toBeCloseTo(0.5, 6);
    expect(receptorLook({ value: 0.6, armed: true }, T).fill).toBe(1);
    // Past threshold the meter stays full (it cannot read "more than triggering").
    expect(receptorLook({ value: 0.95, armed: true }, T).fill).toBe(1);
  });

  it('offers NO single-frame form of state (b): a look built without a history never celebrates', () => {
    // The crossing frame is published already disarmed, so a single-frame "this counts" test is
    // unreachable in the running product — and a model that offers one anyway is a trap a consumer
    // falls into (the picture-in-picture meters did, and shipped with a goal cue that could never
    // fire). `goal` is therefore 0 here in every state, including the ones that look like success.
    expect(receptorLook({ value: 0.6, armed: true }, T).goal).toBe(0);
    expect(receptorLook({ value: 0.95, armed: false }, T).goal).toBe(0);
    expect(receptorLook({ value: 0.95, armed: true, tracking: false }, T).goal).toBe(0);
    expect(receptorLook({ value: 1, armed: true, triggerState: 'triggered' }, T).goal).toBe(0);
  });

  it('reads the published trigger state in preference to `armed`, so the two cannot disagree', () => {
    // `armed` collapses 'unconfirmed' and 'triggered'; when the source ships the three-way fact the
    // look is derived from it (src/input/types.ts LaneState.triggerState).
    expect(receptorLook({ value: 0.2, armed: false, triggerState: 'armed' }, T).locked).toBe(false);
    expect(receptorLook({ value: 0.2, armed: true, triggerState: 'unconfirmed' }, T).locked).toBe(true);
    expect(receptorLook({ value: 1, armed: true, triggerState: 'triggered' }, T).locked).toBe(true);
  });

  it('locks out an unarmed lane and never gives it a halo', () => {
    const held = receptorLook({ value: 0.9, armed: false }, T);
    expect(held.locked).toBe(true);
    expect(held.glowTarget).toBe(0);
    const live = receptorLook({ value: 0.9, armed: true }, T);
    expect(live.locked).toBe(false);
    expect(live.glowTarget).toBeGreaterThan(0.9);
  });

  it('stops ordering a locked lane down once it is already below the re-arm line', () => {
    // 'unconfirmed' is a statement about what has been OBSERVED, not about the current value: a
    // reset, a retune or a stream break can leave a lane locked at 0.1 of ROM. It still cannot
    // score and still reads as (c) — but the "lower to reset" order is one the patient has already
    // carried out, and the renderer keys the chevron and the violet drain cap to this flag.
    expect(receptorLook({ value: 0.5, armed: false }, T).needsLower).toBe(true);
    // On the line exactly is still one notch short: LaneTrigger re-arms on `value < rearmLevel`.
    expect(receptorLook({ value: 0.36, armed: false }, T).needsLower).toBe(true);
    const below = receptorLook({ value: 0.1, armed: false }, T);
    expect(below.locked).toBe(true);
    expect(below.needsLower).toBe(false);
    expect(below.resetProgress).toBe(1);
    // A lane that CAN fire is never asked to lower, wherever it is.
    expect(receptorLook({ value: 0.1, armed: true }, T).needsLower).toBe(false);
    expect(receptorLook({ value: 0.95, armed: false, tracking: false }, T).needsLower).toBe(false);
  });

  it('tracks progress back toward the re-arm line while locked', () => {
    // Re-arm happens below threshold * 0.6 = 0.36 of ROM.
    const at = (value: number): number => receptorLook({ value, armed: false }, T).resetProgress;
    expect(at(0.6)).toBe(0); // still at the top, nothing given back yet
    expect(at(0.48)).toBeCloseTo(0.5, 6); // half way down to the re-arm line
    expect(at(0.36)).toBe(1); // at the line — about to re-arm
    expect(at(0.1)).toBe(1);
    expect(at(0.8)).toBe(0); // above threshold: still 0, never negative
    // An armed lane is not "resetting" at all.
    expect(receptorLook({ value: 0.5, armed: true }, T).resetProgress).toBe(0);
  });

  it('puts the re-arm line where the engine re-arms', () => {
    expect(receptorLook({ value: 0.9, armed: false }, T).resetLevel).toBeCloseTo(DEFAULT_REARM_FRACTION, 6);
    expect(receptorLook({ value: 0.9, armed: false }, T, 0.4).resetLevel).toBeCloseTo(0.4, 6);
    // resetProgress follows the tuned re-arm fraction too (line at 0.6 * 0.4 = 0.24 of ROM).
    expect(receptorLook({ value: 0.24, armed: false }, T, 0.4).resetProgress).toBe(1);
    expect(receptorLook({ value: 0.42, armed: false }, T, 0.4).resetProgress).toBeCloseTo(0.5, 6);
  });

  it('lost tracking dims but does not claim a lockout', () => {
    const lost = receptorLook({ value: 0.9, armed: true, tracking: false }, T);
    expect(lost.tracking).toBe(false);
    expect(lost.locked).toBe(false); // it is not "lower to reset", it is "I cannot see you"
    expect(lost.glowTarget).toBe(0);
  });

  it('degenerate inputs clamp instead of propagating', () => {
    expect(receptorLook({ value: Number.NaN, armed: true }, T).fill).toBe(0);
    expect(receptorLook({ value: 5, armed: true }, T).fill).toBe(1);
    expect(receptorLook({ value: -3, armed: true }, T).fill).toBe(0);
    expect(receptorLook({ value: 0.5, armed: true }, Number.NaN).fill).toBeGreaterThan(0);
    expect(Number.isFinite(receptorLook({ value: 0.5, armed: false }, 0, Number.NaN).resetProgress)).toBe(true);
    // No lane state at all is an ABSENT MEASUREMENT, so it reads as (d) "I cannot see you" — not
    // as a live, at-rest, armed gauge. GameRunner's first frame ships `laneStates: []`.
    const none = receptorLook(undefined, T);
    expect(none.fill).toBe(0);
    expect(none.locked).toBe(false);
    expect(none.tracking).toBe(false);
  });

  it('receptorLookInto reuses the caller object (hot path allocates nothing)', () => {
    const out: ReceptorLook = { fill: 0, over: 0, locked: false, resetProgress: 0, resetLevel: 0.6, glowTarget: 0, tracking: true };
    const a = receptorLookInto(out, { value: 0.9, armed: true }, T, DEFAULT_REARM_FRACTION);
    expect(a).toBe(out);
    expect(out.locked).toBe(false);
    receptorLookInto(out, { value: 0.9, armed: false }, T, DEFAULT_REARM_FRACTION);
    expect(out.locked).toBe(true);
    expect(out).toEqual(receptorLook({ value: 0.9, armed: false }, T));
  });
});

// -------------------------------------------------------------------------------------------------
// The two things one frame of LaneState cannot tell you, and the reason ReceptorHistory exists:
// the threshold crossing is published as an `armed: false` frame, and `tracking` is an undebounced
// per-frame visibility gate.
// -------------------------------------------------------------------------------------------------

describe('ReceptorHistory — the crossing is an edge, and tracking is noisy', () => {
  const REARM = DEFAULT_REARM_FRACTION;
  /** Feed one frame and return the goal strength the receptor would be drawn with. */
  const feed = (h: ReceptorHistory, look: ReceptorLook, s: LaneStateLike | undefined, t: number): ReceptorLook =>
    h.update(look, 0, s, T, REARM, t);

  it('a real LaneTrigger never publishes `armed && value >= threshold` — the reason (b) is a latch', () => {
    // This is the failure the latch exists for, asserted against the real trigger rather than
    // against a hand-built LaneState: drive a full rep exactly the way VisionInput does (push the
    // sample, THEN read `armed`, which is the order src/input/VisionInput.ts uses) and count the
    // frames that satisfy a single-frame "will fire" test. There are none, ever.
    const trig = new LaneTrigger({ thresholdFraction: T, rearmFraction: REARM, minIntervalSec: 0.3 });
    let wouldFire = 0;
    let crossed = 0;
    for (let i = 0; i <= 30; i++) {
      const value = 0.9 * Math.sin((Math.PI * i) / 30); // 0 → 0.9 → 0, one rep
      const t = i / 30;
      if (trig.push(value, t)) crossed++;
      if (trig.armed && value >= T) wouldFire++;
    }
    expect(crossed).toBe(1);       // the rep really did fire
    expect(wouldFire).toBe(0);     // ...and no frame of it ever looked like it would
  });

  it('latches the crossing from the armed → not-armed edge and holds it', () => {
    const trig = new LaneTrigger({ thresholdFraction: T, rearmFraction: REARM, minIntervalSec: 0.3 });
    const h = new ReceptorHistory();
    const look = emptyReceptorLook();
    let fireAt = -1;
    let goalAtFire = 0;
    for (let i = 0; i <= 30; i++) {
      const value = 0.9 * Math.sin((Math.PI * i) / 30);
      const t = i / 30;
      const fired = trig.push(value, t) !== null;
      feed(h, look, { value, armed: trig.armed }, t);
      if (fired) {
        fireAt = t;
        goalAtFire = look.goal ?? 0;
        break; // the rest of the rep is driven by hand below, at times after this one
      }
      // Before the crossing the lane is rising and armed; there is no goal look to be had.
      expect(look.goal ?? 0).toBe(0);
    }
    expect(fireAt).toBeGreaterThan(0);
    expect(goalAtFire).toBe(1); // the gauge acknowledges the rep on the very frame it scores
    // ...and the acknowledgement outlives the one frame the crossing lasts, then gets out of the way.
    feed(h, look, { value: 0.8, armed: false }, fireAt + GOAL_HOLD_SEC * 0.5);
    expect(look.goal).toBe(1);
    expect(look.locked).toBe(true); // both true at once: "you got there" AND "you cannot fire again"
    feed(h, look, { value: 0.8, armed: false }, fireAt + GOAL_HOLD_SEC + GOAL_FADE_SEC * 0.5);
    expect(look.goal).toBeGreaterThan(0);
    expect(look.goal).toBeLessThan(1);
    feed(h, look, { value: 0.8, armed: false }, fireAt + GOAL_HOLD_SEC + GOAL_FADE_SEC + 0.01);
    expect(look.goal).toBe(0); // ...and then it is purely "lower to reset"
  });

  it('does not invent a crossing for a lane that was locked on its very first frame', () => {
    // A patient who starts the song already at end range arrives 'unconfirmed' with a full meter and
    // no armed frame behind it. Nothing was crossed — nothing must be celebrated. (This is only the
    // EASY half of the problem: the hard half, a lane that WAS armed and lost its arming to a
    // dropout, is the test below — it has an armed frame behind it and looks identical here.)
    const h = new ReceptorHistory();
    const look = emptyReceptorLook();
    for (let i = 0; i < 10; i++) {
      feed(h, look, { value: 0.9, armed: false }, i * 0.033);
      expect(look.goal ?? 0).toBe(0);
      expect(look.locked).toBe(true);
    }
  });

  it('refuses the crossing a real LaneTrigger threw away during a dropout', () => {
    // THE FALSE POSITIVE THIS GUARD EXISTS FOR, driven against the real trigger rather than against
    // hand-built states. A lane is disarmed by a break in the sample stream as well as by a
    // crossing (src/vision/trigger.ts breakContinuity), and VisionInput pushes a null sample for
    // every untracked frame — so a knee landmark lost for a second mid-rep sends the lane to
    // 'unconfirmed' and the recovery frame is published as { value: 0.95, armed: false }: byte for
    // byte the shape of a crossing, with NO event and no rep behind it. Celebrating it congratulates
    // a patient with hemiparesis or tremor for a rep that scored nothing, and never tells them to
    // lower and reset.
    const trig = new LaneTrigger({ thresholdFraction: T, rearmFraction: REARM, minIntervalSec: 0.3 });
    const h = new ReceptorHistory();
    const look = emptyReceptorLook();
    let events = 0;
    let t = 0;
    const push = (v: number | null): void => {
      if (trig.push(v, t)) events++;
      feed(h, look, v === null ? { value: 0, armed: trig.armed, tracking: false } : { value: v, armed: trig.armed, tracking: true }, t);
      t += 1 / 30;
    };
    for (let i = 0; i < 15; i++) push(0); // at rest: the lane is observed below the re-arm level
    for (let i = 0; i < 5; i++) push(0.4); // rising, still short of the 0.6 threshold
    expect(trig.state).toBe('armed');
    for (let i = 0; i < 30; i++) push(null); // 1 s out of frame — past the trigger's maxGapSec
    expect(trig.state).toBe('unconfirmed');
    expect(look.tracking).toBe(false); // and the receptor says so
    push(0.95); // ...and the patient reappears at end range
    expect(events).toBe(0); // the input layer credited NOTHING
    expect(look.goal ?? 0).toBe(0); // ...so neither does the gauge
    // ...and the gauge is live again on that very frame: the recovered frame carries a measurement,
    // so "I cannot see you" has stopped being true (see `LOST_HOLD_SEC`). What the dropout killed is
    // the crossing evidence, not the stream.
    expect(look.tracking).toBe(true);
    for (let i = 0; i < 10; i++) {
      push(0.95);
      expect(look.goal ?? 0).toBe(0);
    }
    expect(look.tracking).toBe(true);
    expect(look.locked).toBe(true);
    expect(look.needsLower).toBe(true); // it tells them the true thing instead: lower to reset
    // ...and it stays refused for the whole span the celebration would have lasted.
    for (let i = 0; i < 20; i++) {
      push(0.95);
      expect(look.goal ?? 0).toBe(0);
    }
    expect(events).toBe(0);
  });

  it('refuses the same dropout when the trigger state is PUBLISHED, too', () => {
    // The published path must be at least as strict as the inferred one it replaces, or the fix for
    // the missing cue would have bought it at the cost of a false one. `breakContinuity` leaves the
    // lane 'unconfirmed', never 'triggered' — so the recovery frame, identical in `armed` and in
    // `value` to a real crossing, is not a crossing here either.
    const trig = new LaneTrigger({ thresholdFraction: T, rearmFraction: REARM, minIntervalSec: 0.3 });
    const h = new ReceptorHistory();
    const look = emptyReceptorLook();
    let events = 0;
    let t = 0;
    const push = (v: number | null): void => {
      if (trig.push(v, t)) events++;
      // Exactly what VisionInput.getLaneStates() now publishes, including the trigger's own state.
      feed(h, look, { value: v ?? 0, armed: trig.armed, triggerState: trig.state, tracking: v !== null }, t);
      t += 1 / 30;
    };
    for (let i = 0; i < 15; i++) push(0);
    for (let i = 0; i < 5; i++) push(0.4);
    expect(trig.state).toBe('armed');
    for (let i = 0; i < 30; i++) push(null); // 1 s of lost landmarks
    expect(trig.state).toBe('unconfirmed');
    for (let i = 0; i < 20; i++) {
      push(0.95); // back at end range, with a full meter and no rep behind it
      expect(look.goal ?? 0).toBe(0);
    }
    expect(events).toBe(0);
    expect(look.locked).toBe(true);
    // ...and the same lane, having lowered and risen again, IS celebrated: the guard is not a mute.
    for (let i = 0; i < 5; i++) push(0.1);
    expect(trig.state).toBe('armed');
    push(0.95);
    expect(events).toBe(1);
    expect(look.goal).toBe(1);
  });

  it('still latches a crossing that resumes INSIDE the gap window', () => {
    // The mirror of the test above, and the reason the guard is a gap rule and not "any dropout
    // cancels the rep": a short visibility dip does not unmake the below-re-arm observation, so the
    // trigger keeps its arming and really does fire on the recovery frame (interpolating across the
    // gap). That rep scored, and a gauge that stayed silent about it would be the opposite lie.
    const trig = new LaneTrigger({ thresholdFraction: T, rearmFraction: REARM, minIntervalSec: 0.3 });
    const h = new ReceptorHistory();
    const look = emptyReceptorLook();
    let events = 0;
    let t = 0;
    const push = (v: number | null): void => {
      if (trig.push(v, t)) events++;
      feed(h, look, v === null ? { value: 0, armed: trig.armed, tracking: false } : { value: v, armed: trig.armed, tracking: true }, t);
      t += 1 / 30;
    };
    for (let i = 0; i < 15; i++) push(0);
    for (let i = 0; i < 4; i++) push(null); // 0.13 s: inside maxGapSec, inside LOST_HOLD_SEC
    expect(trig.state).toBe('armed');
    push(0.95);
    expect(events).toBe(1);
    expect(look.goal).toBe(1);
  });

  it('drops the crossing when the threshold is retuned mid-song', () => {
    // LaneTrigger.setThreshold re-checks the arming against the NEW re-arm level, so making the song
    // easier can disarm a lane that has not moved at all — and the next sample of that same,
    // motionless value is then at/above the new threshold and disarmed. No movement, no event.
    const trig = new LaneTrigger({ thresholdFraction: 0.8, rearmFraction: REARM, minIntervalSec: 0.3 });
    const h = new ReceptorHistory();
    const look = emptyReceptorLook();
    let events = 0;
    if (trig.push(0.4, 0)) events++; // below re-arm (0.48): the lane arms
    h.update(look, 0, { value: 0.4, armed: trig.armed }, 0.8, REARM, 0);
    expect(trig.armed).toBe(true);
    trig.setThreshold(0.3); // therapist makes it easier: re-arm level is now 0.18, the lane is above it
    if (trig.push(0.4, 0.033)) events++;
    h.update(look, 0, { value: 0.4, armed: trig.armed }, 0.3, REARM, 0.033);
    expect(trig.state).toBe('unconfirmed');
    expect(events).toBe(0);
    expect(look.fill).toBe(1); // the meter is full against the new, lower threshold...
    expect(look.goal ?? 0).toBe(0); // ...and says nothing about having reached it
    expect(look.locked).toBe(true);
  });

  it('does not count a re-published sample as a new observation', () => {
    // VisionInput returns the SAME frozen LaneState objects until it processes a new detection, so a
    // 60 Hz renderer sees each 30 fps sample twice — and a stalled camera means it sees one sample
    // forever. A repeat is not evidence that the stream is alive, so the arming expires on it just
    // as it would on an untracked window.
    const h = new ReceptorHistory();
    const look = emptyReceptorLook();
    const held: LaneStateLike = { value: 0.4, armed: true, tracking: true };
    for (let i = 0; i < 40; i++) feed(h, look, held, i * 0.016); // 0.64 s of one frozen sample
    feed(h, look, { value: 0.95, armed: false, tracking: true }, 0.64);
    expect(look.goal ?? 0).toBe(0);
  });

  it('believes a published triggerState instead of inferring the edge', () => {
    // The way to stop guessing: entering 'triggered' is a crossing and nothing else is, however
    // full the meter and however stale the stream. Every source in this repo publishes it now
    // (VisionInput from LaneTrigger.state, the scripted sources from their held bit), so the two
    // guards above are belt and braces rather than the only defence.
    const real = new ReceptorHistory();
    const fake = new ReceptorHistory();
    const a = emptyReceptorLook();
    const b = emptyReceptorLook();
    real.update(a, 0, { value: 0.4, armed: true, triggerState: 'armed' }, T, REARM, 0);
    real.update(a, 0, { value: 0.95, armed: false, triggerState: 'triggered' }, T, REARM, 0.033);
    expect(a.goal).toBe(1);
    // Same two frames as far as `armed` is concerned — and not a rep.
    fake.update(b, 0, { value: 0.4, armed: true, triggerState: 'armed' }, T, REARM, 0);
    fake.update(b, 0, { value: 0.95, armed: false, triggerState: 'unconfirmed' }, T, REARM, 0.033);
    expect(b.goal ?? 0).toBe(0);
    expect(b.locked).toBe(true);
  });

  it('latches a published crossing after ANY amount of apparent silence', () => {
    // THE REGRESSION, at the model level. The gap rule expires an INFERENCE the renderer made from
    // timing; it must not expire the input layer's own state machine. A source that memoizes its
    // LaneStates (every scripted source does — src/input/laneStates.ts) looks silent for the whole
    // of a patient's rest, and tying the two together meant no rep following more than `maxGapSec`
    // of rest could ever be acknowledged.
    for (const rest of [0.1, 0.45, 0.55, 1, 5, 60]) {
      const h = new ReceptorHistory();
      const look = emptyReceptorLook();
      const idle: LaneStateLike = { value: 0, armed: true, triggerState: 'armed', tracking: true };
      for (let t = 0; t < rest; t += 1 / 60) feed(h, look, idle, t); // the SAME object, as memoized
      expect(look.goal ?? 0, `rest ${rest}s, at rest`).toBe(0);
      feed(h, look, { value: 1, armed: false, triggerState: 'triggered', tracking: true }, rest);
      expect(look.goal, `rest ${rest}s, crossing`).toBe(1);
    }
  });

  it('mirrors the input layer\'s own break-in-the-stream window', () => {
    // The guard is only as good as the number it uses; if the trigger's default ever moves, the
    // renderer's must move with it (or the session must pass RenderFrame.maxGapSec).
    expect(DEFAULT_MAX_GAP_SEC).toBe(TRIGGER_MAX_GAP_SEC);
  });

  it('takes that window from the input source that owns it, not from a second copy of the default', async () => {
    // THE DEFAULTS AGREEING IS NOT THE SAME AS THE TWO BEING COUPLED. `RenderFrame.maxGapSec` was
    // never set by anything, so the receptor always fell back to `DEFAULT_MAX_GAP_SEC` and the two
    // clocks agreed only because nothing had ever passed `VisionInput.staleFrameSec`. The first
    // session to tune it would have desynchronised the receptor's peak expiry and its inferred-edge
    // guard from the trigger's continuity break in silence — a lane recovering from an occlusion is
    // published as byte-for-byte the frame a real crossing is, and the gap rule is what tells them
    // apart. The window is now readable off the source and `GameRunner` forwards it onto the frame
    // (`GameRunnerOptions.maxGapSec`, src/ui/Play.tsx).
    const { VisionInput } = await import('../input/VisionInput');
    const lanes: LaneSpec[] = [{ index: 0, movement: 'seated_march', side: 'left' }];
    const cal: RomCalibration = {
      min: extractFeature('seated_march', seatedPose({ kneeLift: 0 }), 'left')!,
      max: extractFeature('seated_march', seatedPose({ kneeLift: 1 }), 'left')!,
      samples: 1,
      movement: 'seated_march',
    };
    const base = { mode: 'leg' as const, lanes, calibrations: [cal], thresholdFraction: 0.6, audioContext: { currentTime: 0 } };
    expect(new VisionInput(base).staleFrameSec).toBe(DEFAULT_MAX_GAP_SEC);
    expect(new VisionInput({ ...base, staleFrameSec: 0.25 }).staleFrameSec).toBe(0.25);
  });

  it('does not celebrate a lockout that arrives below the threshold', () => {
    // setThreshold / reset / a long dropout can disarm a lane at any value. That is not a rep.
    const h = new ReceptorHistory();
    const look = emptyReceptorLook();
    feed(h, look, { value: 0.2, armed: true }, 0);
    feed(h, look, { value: 0.25, armed: false }, 0.033);
    expect(look.goal ?? 0).toBe(0);
  });


  it('measures the return journey from the observed PEAK, so every millimetre of the descent counts', () => {
    // THE FROZEN GAUGE, at the model level. `resetProgress` used to be measured in clamped-`fill`
    // units, so every value at or above the threshold reported 0: a patient who had genuinely
    // lowered from full ROM to the threshold — 71 % of the return journey on the default 'easy'
    // difficulty — was told they had given back nothing, and every mark the renderer hangs off this
    // number sat still while they did exactly what the gauge had asked.
    //
    // Driven against the real trigger, at the DEFAULT difficulty (thresholdFraction 0.5, re-arm 0.6
    // → the lane re-arms below 0.30 of ROM).
    const TH = 0.5;
    const trig = new LaneTrigger({ thresholdFraction: TH, rearmFraction: REARM, minIntervalSec: 0.3 });
    const h = new ReceptorHistory();
    const look = emptyReceptorLook();
    let t = 0;
    const feedAt = (value: number): ReceptorLook => {
      t += 0.033;
      trig.push(value, t);
      return h.update(look, 0, { value, armed: trig.armed }, TH, REARM, t);
    };
    for (const v of [0.05, 0.2, 0.4]) feedAt(v);
    feedAt(1); // the crossing: the trigger fires and publishes the frame already disarmed
    expect(look.locked).toBe(true);
    expect(look.peakRom).toBeCloseTo(1, 6);
    expect(look.resetProgress).toBe(0); // at the top: nothing given back yet
    let prev = 0;
    const REARM_ROM = TH * REARM; // 0.30 of ROM — the level `LaneTrigger` re-arms below
    for (const v of [0.95, 0.9, 0.85, 0.8, 0.75, 0.7, 0.65, 0.6, 0.55, 0.5, 0.45, 0.4, 0.35, REARM_ROM]) {
      const l = feedAt(v);
      // The journey is peakRom → threshold * rearmFraction, and this is the fraction of it
      // travelled — a real number for every value, not 0 until the threshold is reached.
      expect(l.resetProgress, `resetProgress at ${v.toFixed(2)}`).toBeCloseTo((1 - v) / (1 - REARM_ROM), 6);
      expect(l.resetProgress, `moves at ${v.toFixed(2)}`).toBeGreaterThan(prev);
      prev = l.resetProgress;
      expect(l.locked, `still locked at ${v.toFixed(2)}`).toBe(true);
    }
    // It completes exactly at the re-arm level, which is where the trigger re-arms.
    expect(prev).toBeCloseTo(1, 6);
    expect(look.needsLower).toBe(true); // on the line is one notch short: `armed` is `value < line`
    // ...and more than half of that motion happened above the threshold — the span that used to
    // report 0. (1.00 → 0.50 of ROM is 0.5 of a 0.7-of-ROM journey.)
    const half = (1 - TH) / (1 - TH * REARM);
    expect(half).toBeGreaterThan(0.7);
  });

  it('only ever raises the peak, so a landmark spike under-reports instead of inventing a descent', () => {
    // A spurious spike sets a peak the patient never reached, which makes the arc report LESS
    // progress than they have made. Decaying the peak back toward the current value would instead
    // make the arc creep forward while they hold perfectly still — a lie in the one state whose
    // whole message is "you have not given anything back yet".
    const h = new ReceptorHistory();
    const look = emptyReceptorLook();
    let t = 0;
    const feedAt = (value: number, armed: boolean): ReceptorLook => {
      t += 0.033;
      return h.update(look, 0, { value, armed }, T, REARM, t);
    };
    feedAt(0.5, true);
    feedAt(1, false); // a crossing at full ROM
    feedAt(0.8, false);
    const from1 = look.resetProgress;
    feedAt(0.95, false); // the patient goes back UP: the peak holds, progress falls back
    expect(look.peakRom).toBeCloseTo(1, 6);
    expect(look.resetProgress).toBeLessThan(from1);
    feedAt(1.0, false);
    expect(look.resetProgress).toBe(0);
    // A higher peak is taken immediately — the journey is measured from wherever they really got to.
    feedAt(0.7, false);
    expect(look.peakRom).toBeCloseTo(1, 6);
    expect(look.resetProgress).toBeCloseTo((1 - 0.7) / (1 - T * REARM), 6);
  });

  it('starts the return journey again when the evidence for the peak expires', () => {
    // The peak is evidence like the arming is, and it expires on the same two rules: a break in the
    // stream longer than `maxGapSec` (the renderer did not watch how high they got) and a threshold
    // retune (the finish line moved). Either way the honest thing is to measure from where the
    // patient is now, which under-reports their progress rather than inventing a descent.
    const h = new ReceptorHistory();
    const look = emptyReceptorLook();
    h.update(look, 0, { value: 0.5, armed: true }, T, REARM, 0);
    h.update(look, 0, { value: 1, armed: false }, T, REARM, 0.033);
    h.update(look, 0, { value: 0.8, armed: false }, T, REARM, 0.066);
    expect(look.peakRom).toBeCloseTo(1, 6);
    // ...a gap longer than the trigger's own continuity window, then a lane at 0.8 again.
    h.update(look, 0, { value: 0.8, armed: false }, T, REARM, 0.066 + DEFAULT_MAX_GAP_SEC + 0.1);
    expect(look.peakRom).toBeCloseTo(0.8, 6);
    expect(look.resetProgress).toBe(0);
    // A retune does the same (`LaneTrigger.setThreshold` re-checks every lane's arming).
    const h2 = new ReceptorHistory();
    const look2 = emptyReceptorLook();
    h2.update(look2, 0, { value: 0.5, armed: true }, T, REARM, 0);
    h2.update(look2, 0, { value: 1, armed: false }, T, REARM, 0.033);
    h2.update(look2, 0, { value: 0.9, armed: false }, T, REARM, 0.066);
    expect(look2.resetProgress).toBeGreaterThan(0);
    h2.update(look2, 0, { value: 0.9, armed: false }, 0.8, REARM, 0.099);
    expect(look2.peakRom).toBeCloseTo(0.9, 6);
    expect(look2.resetProgress).toBe(0);
  });

  it('names the ONE cause that really produces a locked lane below the re-arm line', () => {
    // `needsLower` is what keeps (c) from ordering a patient DOWN when they are already under the
    // line they are being pointed at. Its doc used to name three causes — `setThreshold`, a reset,
    // and a stream break — and driven against the real `LaneTrigger` two of the three are
    // impossible. Pinned here so the costume is documented by what the input layer does, not by what
    // the renderer imagines it might.
    const REARM_F = DEFAULT_REARM_FRACTION;
    const look = emptyReceptorLook();

    // (1) A RETUNE CANNOT. `LaneTrigger.setThreshold` disarms only the lanes that are NOT already
    // below the NEW re-arm level (src/vision/trigger.ts), so the value it leaves 'unconfirmed' at is
    // by construction at or above that level — `needsLower` is TRUE, and the instruction is real.
    const retune = new LaneTrigger({ thresholdFraction: 0.8, rearmFraction: REARM_F, minIntervalSec: 0.3 });
    for (let i = 0; i < 5; i++) retune.push(0.4, i / 30); // at rest under threshold 0.8: armed
    expect(retune.state).toBe('armed');
    retune.setThreshold(0.3); // the therapist makes the song easier mid-song
    expect(retune.state).toBe('unconfirmed');
    receptorLookInto(look, { value: 0.4, armed: retune.armed, triggerState: retune.state }, 0.3, REARM_F);
    expect(look.locked).toBe(true);
    expect(look.needsLower).toBe(true);

    // (2) A STREAM BREAK CANNOT EITHER. `breakContinuity` does leave the lane 'unconfirmed' at
    // whatever value it had — but the very push that reveals the break's end re-arms the lane if the
    // recovered value is below the re-arm level, and that happens BEFORE VisionInput reads
    // `trigger.state` for the frame. So a patient who comes back at rest is published 'armed'.
    const gap = new LaneTrigger({ thresholdFraction: T, rearmFraction: REARM_F, minIntervalSec: 0.3 });
    for (let i = 0; i < 5; i++) gap.push(0.1, i / 30);
    for (let i = 0; i < 30; i++) gap.push(null, (5 + i) / 30); // 1 s of lost landmarks
    expect(gap.state).toBe('unconfirmed');
    gap.push(0.1, 35 / 30); // ...and they are back, at rest
    expect(gap.state).toBe('armed');
    receptorLookInto(look, { value: 0.1, armed: gap.armed, triggerState: gap.state }, T, REARM_F);
    expect(look.locked).toBe(false);

    // (3) A RESET CAN, AND IT IS THE ONLY ONE. `VisionInput.setCalibration` resets the trigger
    // (src/input/VisionInput.ts), which leaves it 'unconfirmed' with no observation at all — at
    // whatever value the lane is published at, including one below the re-arm line — until the next
    // camera frame re-arms it. One or two render frames, and the costume is right for them: the lane
    // genuinely cannot score, and telling a patient at rest to lower further is an order they cannot
    // obey.
    const recal = new LaneTrigger({ thresholdFraction: T, rearmFraction: REARM_F, minIntervalSec: 0.3 });
    for (let i = 0; i < 5; i++) recal.push(0.1, i / 30);
    recal.reset();
    receptorLookInto(look, { value: 0.1, armed: recal.armed, triggerState: recal.state }, T, REARM_F);
    expect(look.locked).toBe(true);
    expect(look.needsLower).toBe(false);
    expect(look.resetProgress).toBe(1); // the return journey is complete by definition
  });

  it('holds the last tracked look through a single-frame visibility dropout', () => {
    const h = new ReceptorHistory();
    const look = emptyReceptorLook();
    feed(h, look, { value: 0.3, armed: true, tracking: true }, 0);
    // One noisy frame across the visibility gate: the gauge does not flip to "?" and back.
    feed(h, look, { value: 0, armed: true, tracking: false }, 0.033);
    expect(look.tracking).toBe(true);
    expect(look.stale).toBe(true);
    expect(look.fill).toBeCloseTo(0.5, 6); // the last real measurement, not the dead 0
    // A dropout that lasts, though, is a dropout.
    feed(h, look, { value: 0, armed: true, tracking: false }, 0.033 + LOST_HOLD_SEC);
    expect(look.tracking).toBe(false);
    expect(look.stale).toBe(false);
  });

  it('shows (d) immediately for a lane that was never tracked, including one with no state at all', () => {
    const h = new ReceptorHistory();
    const look = emptyReceptorLook();
    feed(h, look, undefined, 0); // GameRunner's first frame: laneStates: []
    expect(look.tracking).toBe(false);
    expect(look.stale).toBe(false);
    feed(h, look, { value: 0.4, armed: true, tracking: false }, 0.016);
    expect(look.tracking).toBe(false);
  });

  it('forgets everything when the clock jumps backwards (song restart / seek)', () => {
    const h = new ReceptorHistory();
    const look = emptyReceptorLook();
    feed(h, look, { value: 0.3, armed: true }, 10);
    feed(h, look, { value: 0.9, armed: false }, 10.033);
    expect(look.goal).toBe(1);
    feed(h, look, { value: 0.9, armed: false }, 0.5); // restart
    expect(look.goal ?? 0).toBe(0);
  });

  it('goalStrength holds then ramps', () => {
    expect(goalStrength(-1)).toBe(0);
    expect(goalStrength(Number.NaN)).toBe(0);
    expect(goalStrength(0)).toBe(1);
    expect(goalStrength(GOAL_HOLD_SEC * 0.99)).toBe(1);
    expect(goalStrength(GOAL_HOLD_SEC + GOAL_FADE_SEC * 0.5)).toBeCloseTo(0.5, 6);
    expect(goalStrength(GOAL_HOLD_SEC + GOAL_FADE_SEC)).toBe(0);
    expect(goalStrength(Infinity)).toBe(0);
  });
});


// -------------------------------------------------------------------------------------------------
// STATE (b) OVER THE SOURCES A PATIENT IS ACTUALLY PUT ON.
//
// The model above is driven with hand-built LaneStates, and that is exactly how the bug this suite
// now pins got through: every hand-built sequence changes its object on every frame, and the real
// scripted sources do not — `LaneStateCache` hands back the SAME frozen array for as long as the
// held/not-held bitmask is unchanged (src/input/laneStates.ts), which for a patient at rest is the
// whole gap between two reps. Driven over the real thing, the goal cue used to be reachable only
// for a rep that followed less than `DEFAULT_MAX_GAP_SEC` of rest: 36 goal frames after 0.10/0.30/
// 0.45 s of rest, ZERO after 0.55/1.0/5.0 s, on the keyboard path `CameraFallback` hands a patient
// when the camera fails, and on the replay/autoplay path every dev screenshot has ever been taken
// on. Nothing here may build a LaneState by hand.
// -------------------------------------------------------------------------------------------------

describe('the goal cue fires on every rep of every source a patient can be placed on', () => {
  const TH = 0.5; // the default difficulty's thresholdFraction
  const FPS = 60;
  const FRAME = 1 / FPS;

  /** Poll a real source for `sec` at 60 Hz through a real history; return the per-frame goal values. */
  const poll = (
    src: InputSource,
    h: ReceptorHistory,
    look: ReceptorLook,
    t0: number,
    sec: number,
    advance?: (t: number) => void,
  ): number[] => {
    const out: number[] = [];
    for (let i = 0; i * FRAME < sec; i++) {
      const t = t0 + i * FRAME;
      advance?.(t);
      const states = src.getLaneStates();
      h.update(look, 0, states[0], TH, DEFAULT_REARM_FRACTION, t);
      out.push(look.goal ?? 0);
    }
    return out;
  };

  it('KeyboardInput: a rep after ANY length of rest is acknowledged, for >= 150 ms, from the firing frame', () => {
    // `?input=keyboard` is not a dev-only path: CameraFallback offers it to a PATIENT when the
    // camera fails, and Play.tsx renders the same live meters for it.
    for (const rest of [0.1, 0.3, 0.45, 0.55, 1, 5]) {
      const clock = { currentTime: 0 };
      const target = new EventTarget();
      const kb = new KeyboardInput({ lanes: 4, audioContext: clock, target, blurTargets: [] });
      void kb.start();
      const h = new ReceptorHistory();
      const look = emptyReceptorLook();
      let events = 0;
      kb.onEvent(() => events++);

      const atRest = poll(kb, h, look, 0, rest);
      expect(atRest.every((g) => g === 0), `rest ${rest}s: no cue while at rest`).toBe(true);

      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'd' })); // the rep
      expect(events, `rest ${rest}s: the input layer fired`).toBe(1);
      const after = poll(kb, h, look, rest, GOAL_HOLD_SEC + GOAL_FADE_SEC + 0.2);

      // ON THE FIRING FRAME: the very first poll after the event is already the full cue.
      expect(after[0], `rest ${rest}s: cue on the firing frame`).toBe(1);
      // LATCHED: knowledge of results a patient mid-rep can actually catch.
      const lit = after.filter((g) => g > 0).length;
      expect(lit * FRAME, `rest ${rest}s: cue duration`).toBeGreaterThanOrEqual(0.15);
      expect(lit * FRAME).toBeCloseTo(GOAL_HOLD_SEC + GOAL_FADE_SEC, 1);
      // ...and it gets out of the way afterwards, leaving the lockout to say "lower to reset".
      expect(after[after.length - 1], `rest ${rest}s: cue ends`).toBe(0);
      kb.stop();
    }
  });

  it('KeyboardInput: the cue does NOT re-fire while the key stays down, and never fires on release or stop', () => {
    const clock = { currentTime: 0 };
    const target = new EventTarget();
    const kb = new KeyboardInput({ lanes: 4, audioContext: clock, target, blurTargets: [] });
    void kb.start();
    const h = new ReceptorHistory();
    const look = emptyReceptorLook();
    poll(kb, h, look, 0, 1);
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'd' }));
    // Held for four seconds — a hemiparetic patient holding at end range, which is the default
    // behaviour, not the exception. One cue, then the lockout for as long as they hold.
    const held = poll(kb, h, look, 1, 4);
    expect(held.filter((g) => g === 1).length * FRAME).toBeCloseTo(GOAL_HOLD_SEC, 1);
    expect(held[held.length - 1]).toBe(0);
    expect(look.locked).toBe(true);
    expect(look.needsLower).toBe(true);
    // A mid-song stop releases every key. A release is not a rep.
    kb.stop();
    const stopped = poll(kb, h, look, 5, 1);
    expect(stopped.every((g) => g === 0)).toBe(true);
  });

  it('AutoplayInput / ReplayInput: every scripted note gets its cue, whatever the gap before it', () => {
    // The path every dev screenshot and every critic frame has ever been taken on — which is why
    // nobody saw the hole. Note gaps here are 0.2 s, 0.8 s and 4 s: one inside the old evidence
    // window and two outside it.
    const clock = { currentTime: 0 };
    const songClock = { songTime: (n = clock.currentTime) => n, ctxTimeForSongTime: (t: number) => t };
    const times = [0.5, 0.7, 1.5, 5.5];
    const bot = new AutoplayInput({
      chart: { notes: times.map((time, id) => ({ id, lane: 0, time })), lanes: 4 },
      audioContext: clock,
      songClock,
      autoTick: false,
    });
    void bot.start();
    const h = new ReceptorHistory();
    const look = emptyReceptorLook();
    /** The frame index each LaneInputEvent was delivered on — "the frame the engine actually fired". */
    const firedOn: number[] = [];
    let frame = 0;
    bot.onEvent(() => firedOn.push(frame));
    // One pass over the whole song, ticking the bot exactly as GameRunner does before each draw.
    const goals = poll(bot, h, look, 0, 6.5, (t) => {
      frame = Math.round(t * FPS);
      clock.currentTime = t;
      bot.tick(t);
    });
    expect(firedOn).toHaveLength(times.length);
    // Every one of them acknowledged, on its own firing frame — including the 4 s gap, which is
    // eight times the window the old evidence rule threw the crossing away after.
    for (let i = 0; i < firedOn.length; i++) {
      expect(goals[firedOn[i]], `note ${i} at ${times[i]}s`).toBe(1);
    }
    // ...and no cue at any other time than the hold after a note (nothing celebrates the release).
    const unexplained = goals.filter((g, i) => g > 0 && !firedOn.some((f) => i >= f && (i - f) * FRAME < GOAL_HOLD_SEC + GOAL_FADE_SEC));
    expect(unexplained).toHaveLength(0);
  });
});

/**
 * THE LATCH HAS TWO ENDS. Everything above pins the moment (b) STARTS. These pin the moment it
 * stops, which is the other half of the same honesty claim and is the half nothing used to cover:
 * every latch test above holds the lane at `{ armed: false, value: 0.8 }` for the whole window, so
 * the case a real patient is in for most of every rep — RE-ARMED while the latch is still running —
 * was never exercised at all.
 *
 * It is not an edge case, it is the pacing the game is designed at. `MIN_LANE_SPACING_SEC`
 * (src/charts/generate.ts) puts same-lane notes 0.45 s apart on hard and 0.60 s apart on medium,
 * both at or under the old fixed `GOAL_HOLD_SEC + GOAL_FADE_SEC` latch — so a patient keeping up
 * never left state (b), and (a) "how much further" and (c) "lower to reset" were never drawn for
 * that lane.
 */
describe('the goal cue stops when it stops being true', () => {
  const TH = 0.5; // the default difficulty's thresholdFraction
  const REARM = DEFAULT_REARM_FRACTION;
  const FPS = 30; // MediaPipe's frame budget: one crossing lasts one of these

  /** One lane, driven through a REAL LaneTrigger; returns a row per camera frame. */
  const drive = (
    values: (t: number) => number,
    frames: number,
  ): Array<{ t: number; v: number; marks: ReturnType<typeof receptorMarkSet>; goal: number; locked: boolean; holding: boolean; glow: number; rom: number }> => {
    const trig = new LaneTrigger({ thresholdFraction: TH, rearmFraction: REARM, minIntervalSec: 0.3 });
    const h = new ReceptorHistory();
    const look = emptyReceptorLook();
    const rows = [];
    for (let i = 0; i < frames; i++) {
      const t = i / FPS;
      const v = values(t);
      trig.push(v, t);
      // Exactly what VisionInput publishes: push first, then read the trigger (src/input/VisionInput.ts).
      h.update(look, 0, { value: v, armed: trig.armed, triggerState: trig.state, tracking: true }, TH, REARM, t);
      rows.push({
        t,
        v,
        marks: receptorMarkSet(look),
        goal: look.goal ?? 0,
        locked: look.locked,
        holding: receptorGoalHolding(look),
        glow: look.glowTarget,
        rom: look.rom ?? 0,
      });
    }
    return rows;
  };

  /** A raised-cosine rep of `period` seconds peaking at `peak` of ROM — a real concentric/eccentric cycle. */
  const reps = (period: number, peak = 0.75) => (t: number): number =>
    peak * (0.5 - 0.5 * Math.cos((2 * Math.PI * (t % period)) / period));

  it('a lane that is armed and back at rest is never wearing the goal costume', () => {
    // The defect, stated as the invariant it violates. THE test: at the chart generator's own hard
    // pacing, is there any frame where the input layer would accept the next rep (armed) and the
    // patient is back down near rest, while the gauge is still shouting "you reached your target"?
    const rows = drive(reps(0.45), 90);
    const liars = rows.filter((r) => r.marks === 'goal' && !r.locked && r.rom < TH * REARM);
    expect(liars.map((r) => `${r.t.toFixed(3)}s rom=${r.rom.toFixed(2)}`)).toEqual([]);
  });

  it('ends the latch ON the re-arm frame, not on a fixed 0.6 s timer', () => {
    const rows = drive(reps(0.45), 90);
    const firstCross = rows.findIndex((r) => r.marks === 'goal');
    expect(firstCross).toBeGreaterThan(0);
    const rearm = rows.findIndex((r, i) => i > firstCross && !r.locked);
    expect(rearm).toBeGreaterThan(firstCross);
    // The lockout lasted well under the old fixed latch — that is the whole point.
    expect((rearm - firstCross) / FPS).toBeLessThan(GOAL_HOLD_SEC + GOAL_FADE_SEC);
    // ...and the cue ends with the lockout — within GOAL_MIN_SEC of the re-arm, not at the ~0.3 s
    // the fixed latch had left to run. (Measured on THIS run of the cue: the next rep starts its
    // own.)
    let lastLit = firstCross;
    while (rows[lastLit + 1]?.goal > 0) lastLit++;
    expect((lastLit - rearm) / FPS).toBeLessThanOrEqual(GOAL_MIN_SEC + 1 / FPS);
  });

  it('a fluid rep reads (a) → (b) → (a), at every difficulty the chart generator paces', () => {
    // On hard the old latch (0.60 s) covered the whole 0.45 s inter-rep interval, so a lane that was
    // keeping up showed nothing but (b): the graded "how much further" readout of (a) was dead code
    // at the game's own designed pacing, for the very patient the game is working.
    //
    // (c) is deliberately NOT in this sequence, and that is a design claim, not an oversight: it is
    // the STALL state (see the test below). A patient descending at pace is already obeying "lower
    // to reset", and cycling the receptor through three costumes inside 0.45 s would cost more
    // legibility at 2 m than the instruction could buy back. The lockout is still honest throughout
    // — the column is the same position gauge on the same scale in (b) as in (c).
    for (const [name, period] of [['hard', 0.45], ['medium', 0.6], ['easy', 0.9]] as const) {
      const rows = drive(reps(period), Math.round(period * FPS * 6));
      const seen = new Set(rows.map((r) => r.marks));
      expect(seen.has('rising'), `${name}: (a) is drawn`).toBe(true);
      expect(seen.has('goal'), `${name}: (b) is drawn`).toBe(true);
      // ...and (a) comes BACK after the first cue, for a real span of every rep — not just for the
      // frames before the patient's very first crossing. This is the one the fixed latch failed:
      // past the first rep the lane never left (b) again.
      const firstGoal = rows.findIndex((r) => r.marks === 'goal');
      const risingAfter = rows.slice(firstGoal).filter((r) => r.marks === 'rising').length;
      const repsDriven = rows.length / FPS / period;
      expect(risingAfter / FPS / repsDriven, `${name}: (a) seconds per rep`).toBeGreaterThan(0.15);
      // The costume never changes more than twice per rep.
      const changes = rows.filter((r, i) => i > 0 && r.marks !== rows[i - 1].marks).length;
      expect(changes / (rows.length / FPS / period), `${name}: costume changes per rep`).toBeLessThanOrEqual(2.5);
    }
  });

  it('(c) is the STALL state, and a patient who lingers at end range gets it', () => {
    // The other half of the claim above. Reach target and stay there — the single most common thing
    // a rehab patient does — and the latch runs out while the lane is still locked, so the receptor
    // hands over to the return-to-rest marks and tells them where to lower to.
    const rows = drive((t) => (t < 0.1 ? 0 : t < 1.0 ? 0.9 : Math.max(0, 0.9 - (t - 1.0) * 3)), 60);
    const seen = new Set(rows.map((r) => r.marks));
    expect(seen.has('rising')).toBe(true);
    expect(seen.has('goal')).toBe(true);
    expect(seen.has('locked')).toBe(true);
    // ...and (c) owns the whole rest of the lockout, with no goal cue left anywhere in it.
    const lockedRows = rows.filter((r) => r.marks === 'locked');
    expect(lockedRows.length / FPS).toBeGreaterThan(0.3);
    expect(lockedRows.every((r) => r.goal === 0 && r.locked)).toBe(true);
  });

  it('still holds KR for at least GOAL_MIN_SEC when the lane re-arms on the very next frame', () => {
    // The binary sources (keyboard, replay, autoplay) and a hard tremor spike all do this: cross and
    // be back under the re-arm line one frame later. Cutting the cue at the re-arm alone would show
    // knowledge of results for 33 ms, which is below what a patient mid-rep can catch — the reason
    // the latch exists in the first place.
    const rows = drive((t) => (Math.abs(t - 0.1) < 1e-9 ? 1 : 0), 20);
    const lit = rows.filter((r) => r.goal > 0);
    expect(lit.length / FPS).toBeGreaterThanOrEqual(GOAL_MIN_SEC);
    // ...and not one frame more than the floor buys.
    expect(lit.length / FPS).toBeLessThanOrEqual(GOAL_MIN_SEC + 1 / FPS);
    expect(lit[0].t).toBeCloseTo(0.1, 6); // on the firing frame
  });

  it('tells the truth about POSITION through the whole overrun, while still reporting the rep', () => {
    // The `GOAL_MIN_SEC` overrun is the one window where `goal > 0` and the lane is armed. The rep
    // claim is still true; the position claim is not, and `receptorGoalHolding` is what separates
    // them. A forced halo and a white-hot cap at the floor of the well are position claims.
    const rows = drive((t) => (Math.abs(t - 0.1) < 1e-9 ? 1 : 0), 20);
    const overrun = rows.filter((r) => r.goal > 0 && !r.locked);
    expect(overrun.length).toBeGreaterThan(0);
    for (const r of overrun) {
      expect(r.holding, `overrun at ${r.t.toFixed(3)}s must not claim the patient is still at target`).toBe(false);
      expect(r.rom, 'the patient really is back at rest').toBe(0);
      expect(r.glow, 'no forced halo on a gauge at 0 % of ROM').toBe(0);
    }
    // ...and on the firing frame itself, both claims hold.
    const cross = rows.find((r) => r.locked && r.goal > 0);
    expect(cross?.holding).toBe(true);
    expect(cross?.glow).toBe(1);
  });

  it('a patient HOLDING at end range still gets the full hold, then (c)', () => {
    // The re-arm bound must not shorten the cue for the case it was tuned for: a hemiparetic patient
    // who reaches target and stays there. Nothing re-arms, so nothing cuts the latch.
    const rows = drive((t) => (t < 0.1 ? 0 : 0.9), 60);
    const lit = rows.filter((r) => r.goal > 0);
    expect(lit.length / FPS).toBeCloseTo(GOAL_HOLD_SEC + GOAL_FADE_SEC, 1);
    expect(lit.every((r) => r.holding)).toBe(true); // never re-armed: the rep is in hand throughout
    expect(rows[rows.length - 1].marks).toBe('locked');
  });

  it('receptorGoalHolding is false for every state that is not a held crossing', () => {
    const look = emptyReceptorLook();
    expect(receptorGoalHolding(receptorLookInto(look, { value: 0.3, armed: true }, TH, REARM))).toBe(false); // (a)
    expect(receptorGoalHolding(receptorLookInto(look, { value: 0.9, armed: false }, TH, REARM))).toBe(false); // (c)
    expect(receptorGoalHolding(receptorLookInto(look, { value: 0.9, armed: true, tracking: false }, TH, REARM))).toBe(false); // (d)
    // ...and true only for the combination the renderer may draw a position claim from.
    expect(receptorGoalHolding({ ...emptyReceptorLook(), goal: 1, locked: true, fill: 1 })).toBe(true);
    expect(receptorGoalHolding({ ...emptyReceptorLook(), goal: 1, locked: false, fill: 1 })).toBe(false);
    // ...and "still up there" means still AT THE TARGET, not merely still locked out. The lockout
    // runs all the way down to the re-arm line, which is well below the target line drawn on the
    // same gauge.
    expect(receptorGoalHolding({ ...emptyReceptorLook(), goal: 1, locked: true, fill: 0.74 })).toBe(false);
  });

  it('a crossing restarts the latch even if the previous one was cut short by a re-arm', () => {
    // Three reps at hard pacing: three cues, each starting on its own crossing frame, none of them
    // inheriting the previous rep's release.
    const rows = drive(reps(0.45), Math.round(0.45 * FPS * 3));
    const runs: number[][] = [];
    rows.forEach((r, i) => {
      if (r.goal > 0 && (i === 0 || rows[i - 1].goal === 0)) runs.push([]);
      if (r.goal > 0) runs[runs.length - 1].push(i);
    });
    expect(runs.length).toBe(3);
    for (const run of runs) {
      expect(rows[run[0]].goal).toBe(1); // full strength on the firing frame
      expect(run.length / FPS).toBeGreaterThanOrEqual(GOAL_MIN_SEC);
    }
  });
});

// -------------------------------------------------------------------------------------------------
// (d) MAY NOT CONTRADICT THE ENGINE — THE ROUND-5 FINDING, AND THE REASON THESE ARE DRIVEN END TO END.
//
// The receptor used to decide (d) from a DUTY CYCLE: a darkness budget spent by untracked time and
// forgiven by tracked time at a rate set by a 50 % floor, latched with a Schmitt trigger. The
// justification written into the file was that "the reps performed inside the dark windows scored
// nothing" — and that was never checked against the input layer. It is false. `LaneTrigger` keeps a
// lane's arming across any break up to `maxGapSec` and interpolates the crossing across it, so a rep
// performed half in the dark still fires, still emits its `LaneInputEvent` and still scores. Driven
// end to end at 1.2 s reps, 30 fps camera, 60 Hz render, the old rule produced 17 engine events and
// ONE goal cue at 42 % tracking duty, with 97 % of frames reading "I cannot see you" over a score
// odometer, hit bursts and judgment popups all firing normally.
//
// So these tests drive a REAL `LaneTrigger` with a real rep waveform and assert the only thing that
// matters: THE RECEPTOR AND THE ENGINE AGREE, cue for event. The old block asserted the duty rule
// against itself — it drove a trigger, but with a constant value that never crossed anything, so no
// test in this file ever compared a cue count to an event count on a chattering stream.
// -------------------------------------------------------------------------------------------------

describe('the receptor may not call a lane lost while the engine is scoring it', () => {
  const REARM = DEFAULT_REARM_FRACTION;

  /**
   * One lane, end to end: a real `LaneTrigger` pushed one sample per CAMERA frame (null when the
   * visibility gate fails, exactly as VisionInput does), a `ReceptorHistory` polled at the RENDER
   * rate off the state the trigger publishes — the same order src/input/VisionInput.ts uses (push,
   * then read `trigger.armed` / `trigger.state`).
   *
   * Returns the engine's event count beside the receptor's cue count and mark-set census, which is
   * the comparison the round-5 finding turned on.
   */
  const drive = (opts: {
    tracked: (cameraFrame: number) => boolean;
    camFps?: number;
    renderFps?: number;
    durSec?: number;
    repSec?: number;
    peak?: number;
  }) => {
    const camFps = opts.camFps ?? 30;
    const renderFps = opts.renderFps ?? 60;
    const durSec = opts.durSec ?? 20;
    const repSec = opts.repSec ?? 1.2;
    const peak = opts.peak ?? 0.9;
    const trig = new LaneTrigger({ thresholdFraction: T, rearmFraction: REARM, minIntervalSec: 0.3, maxGapSec: TRIGGER_MAX_GAP_SEC });
    const h = new ReceptorHistory();
    const look = emptyReceptorLook();
    // A triangular rep: rest → peak → rest, once per `repSec`.
    const rom = (t: number): number => {
      const p = (t % repSec) / repSec;
      return p < 0.5 ? peak * (p / 0.5) : peak * (1 - (p - 0.5) / 0.5);
    };
    let events = 0;
    let cues = 0;
    let inCue = false;
    let lostFrames = 0;
    let frames = 0;
    let published: LaneStateLike | undefined;
    let cam = 0;
    for (let r = 0; r < Math.round(durSec * renderFps); r++) {
      const t = r / renderFps;
      while (cam / camFps <= t + 1e-9) {
        const ct = cam / camFps;
        const ok = opts.tracked(cam);
        if (trig.push(ok ? rom(ct) : null, ct)) events++;
        // What VisionInput publishes: a fresh frozen state per processed camera frame, carrying the
        // trigger's own state. An untracked frame publishes `tracking: false` and holds the value.
        published = { value: ok ? rom(ct) : (published?.value ?? 0), armed: trig.armed, triggerState: trig.state, tracking: ok };
        cam++;
      }
      h.update(look, 0, published, T, REARM, t, TRIGGER_MAX_GAP_SEC, 0.3);
      frames++;
      const mark = receptorMarkSet(look);
      if (mark === 'lost') lostFrames++;
      if (mark === 'goal') {
        if (!inCue) cues++;
        inCue = true;
      } else inCue = false;
    }
    return { events, cues, lostFraction: lostFrames / frames };
  };

  it('gives one goal cue per engine event at every tracking duty, not just above 50 %', () => {
    // THE FINDING. Each of these streams is fully scorable — every gap is inside the trigger's
    // continuity window, so it fires for every rep — and the duty rule drew 0-5 cues for 15-17
    // events on the ones below the floor, with up to 97 % of frames reading (d).
    const duties: Array<[string, (i: number) => boolean]> = [
      ['perfect', () => true],
      ['52 %', (i) => i % 25 < 13],
      ['48 %', (i) => i % 25 < 12], // the 4 % either side of the old cliff
      ['42 %', (i) => i % 12 < 5],
      ['33 %', (i) => i % 3 === 0],
    ];
    for (const [name, tracked] of duties) {
      const r = drive({ tracked });
      expect(r.events, name).toBeGreaterThan(10);
      expect(r.cues, name).toBe(r.events);
    }
  });

  it('agrees with the engine at 60 fps too, where even a 6.7 %-duty lane scores every rep', () => {
    // The exact configuration the old rule's rationale cited ("driven at 60 Hz with one tracked
    // frame in fifteen … reps performed inside the dark windows scored nothing"). The gaps are
    // 0.233 s, well inside `maxGapSec`, so the engine fires for every rep — and the receptor now
    // acknowledges every one of them.
    const r = drive({ tracked: (i) => i % 15 === 0, camFps: 60 });
    expect(r.events).toBe(17);
    expect(r.cues).toBe(r.events);
    // ...while still reporting the dark windows honestly: the gap is longer than the hold, so (d) is
    // shown during each one. An honest half-dark gauge, not a session-long "?" over a climbing score.
    expect(r.lostFraction).toBeGreaterThan(0.05);
    expect(r.lostFraction).toBeLessThan(0.5);
  });

  it('reports a half-dark stream as half dark — and still acknowledges every rep it scores', () => {
    // 1-in-15 at 30 fps: gaps of 0.467 s, just inside the trigger's window. Four of the seventeen
    // reps are performed entirely inside a dark window and score nothing; the engine says so, and
    // the receptor neither invents cues for them nor withholds cues for the thirteen that did score.
    const r = drive({ tracked: (i) => i % 15 === 0 });
    expect(r.events).toBeLessThan(17);
    expect(r.cues).toBe(r.events);
    expect(r.lostFraction).toBeGreaterThan(0.4);
  });

  it('does NOT strobe on the visibility-gate chatter the hold exists for', () => {
    // The reason (d) is debounced at all: a landmark chattering across MIN_VISIBILITY at frame rate
    // (marginal framing, motion blur at peak rep velocity) must not flip the whole receptor row
    // between a full gauge and "?" 30 times a second. Every gap here is far shorter than the hold,
    // so the dark run never reaches it and (d) is never entered.
    expect(drive({ tracked: (i) => i % 2 === 0 }).lostFraction).toBe(0);
    expect(drive({ tracked: (i) => i % 4 !== 3 }).lostFraction).toBe(0);
    expect(drive({ tracked: (i) => i % 3 === 0 }).lostFraction).toBe(0);
  });

  it('still enters (d) after exactly LOST_HOLD_SEC of an uninterrupted dropout', () => {
    // The number the stop / occlusion behaviour is specified at, unchanged: a real dropout is still
    // reported within a fifth of a second.
    const FPS = 60;
    const h = new ReceptorHistory();
    const look = emptyReceptorLook();
    h.update(look, 0, { value: 0.3, armed: true, tracking: true }, T, REARM, 0);
    let lostAt = NaN;
    for (let i = 1; i < FPS * 2 && !(lostAt === lostAt); i++) {
      h.update(look, 0, { value: 0, armed: true, tracking: false }, T, REARM, i / FPS);
      if (!look.tracking) lostAt = i / FPS;
    }
    expect(lostAt).toBeGreaterThanOrEqual(LOST_HOLD_SEC);
    expect(lostAt).toBeLessThan(LOST_HOLD_SEC + 2 / FPS);
  });

  it('leaves (d) on the first tracked frame, because that frame is a sample the engine can fire on', () => {
    // THE ASYMMETRY, AND WHY IT IS NOT A REGRESSION OF THE ROUND-4 FIX. Entering (d) costs
    // `LOST_HOLD_SEC` of uninterrupted darkness; leaving costs one tracked frame. A tracked frame is
    // a sample `LaneTrigger` is pushed and can fire on — for a rep that crossed inside the gap it is
    // exactly the frame the crossing is interpolated back across and the event emitted on — so a
    // recovery that costs contiguous stream is a recovery that withholds knowledge of results from
    // reps the engine scored. An hour with the camera unplugged costs the same one frame as a
    // one-second dropout.
    const FPS = 60;
    const h = new ReceptorHistory();
    const look = emptyReceptorLook();
    h.update(look, 0, { value: 0.3, armed: true, tracking: true }, T, REARM, 0);
    let t = 0;
    for (let i = 0; i < FPS * 60; i++) {
      t += 1 / FPS;
      h.update(look, 0, { value: 0, armed: true, tracking: false }, T, REARM, t);
    }
    expect(look.tracking).toBe(false);
    t += 1 / FPS;
    h.update(look, 0, { value: 0.3, armed: true, tracking: true }, T, REARM, t);
    expect(look.tracking).toBe(true);
    expect(look.stale).toBe(false);
  });

  it('celebrates the rep the engine fires on the frame it recovers from a gap', () => {
    // The two halves together, on the case that killed the duty rule: the patient's limb is lost for
    // longer than the anti-strobe hold but less than the trigger's continuity window, and rises
    // through the threshold while it is out of sight. The trigger keeps its arming, fires on the
    // recovery sample and emits the event; the receptor is in (d) on the frame before and must be
    // showing the cue on the frame the event lands.
    const FPS = 60;
    const CAM = 30;
    const trig = new LaneTrigger({ thresholdFraction: T, rearmFraction: REARM, minIntervalSec: 0.3, maxGapSec: TRIGGER_MAX_GAP_SEC });
    const h = new ReceptorHistory();
    const look = emptyReceptorLook();
    let published: LaneStateLike | undefined;
    let events = 0;
    let cue = false;
    let sawLost = false;
    const camFrame = (v: number | null, t: number): void => {
      if (trig.push(v, t)) events++;
      published = { value: v ?? (published?.value ?? 0), armed: trig.armed, triggerState: trig.state, tracking: v !== null };
    };
    let t = 0;
    const render = (): void => {
      h.update(look, 0, published, T, REARM, t, TRIGGER_MAX_GAP_SEC, 0.3);
      if (receptorMarkSet(look) === 'lost') sawLost = true;
      if (receptorMarkSet(look) === 'goal') cue = true;
      t += 1 / FPS;
    };
    // At rest, observed below the re-arm level: the lane is armed.
    for (let i = 0; i < 10; i++) {
      camFrame(0.05, t);
      render();
      render();
    }
    expect(trig.armed).toBe(true);
    // 0.4 s of lost landmarks — twice the anti-strobe hold, inside the trigger's 0.5 s window.
    for (let i = 0; i < Math.round(0.4 * CAM); i++) {
      camFrame(null, t);
      render();
      render();
    }
    expect(sawLost).toBe(true);
    expect(cue).toBe(false);
    // They come back at end range. The trigger interpolates the crossing across the gap and FIRES.
    camFrame(0.95, t);
    expect(events).toBe(1);
    render();
    // ...and the receptor says so on that very frame. Under the duty rule it said "I cannot see you"
    // for another fifth of a second and never acknowledged the rep at all.
    expect(cue).toBe(true);
    expect(look.goal).toBe(1);
  });

  it('a lane with no measurement at all reads (d) from its first frame', () => {
    // No hold for a lane that has never been tracked (including one with no `LaneState`): for an
    // absent measurement the honest default is "I cannot see you", not a live, at-rest gauge.
    const h = new ReceptorHistory();
    const look = emptyReceptorLook();
    h.update(look, 0, undefined, T, REARM, 0);
    expect(receptorMarkSet(look)).toBe('lost');
    h.update(look, 1, { value: 0.4, armed: true, tracking: false }, T, REARM, 0);
    expect(receptorMarkSet(look)).toBe('lost');
  });

  it('a goal latch does not come back after a dropout that outlasted the hold', () => {
    // (d) outranks everything, and it has to outrank it AFTERWARDS too: a latch still running when
    // the receptor admitted it could not see the patient describes a window nobody watched, and
    // resuming it on the recovery frame would surface knowledge of results a fifth of a second late,
    // no longer contingent on the movement that earned it. So entering (d) ends the latch outright.
    //
    // (A crossing ON a tracked frame is always acknowledged now — a tracked frame leaves (d) before
    // the crossing is read, which is exactly the round-5 fix. The only way a latch and (d) can meet
    // is a dropout that starts after the crossing, which is this.)
    const FPS = 60;
    const h = new ReceptorHistory();
    const look = emptyReceptorLook();
    let t = 0;
    const step = (state: LaneStateLike): string => {
      h.update(look, 0, { ...state }, T, REARM, t, TRIGGER_MAX_GAP_SEC, 0.3);
      t += 1 / FPS;
      return receptorMarkSet(look);
    };
    step({ value: 0.1, armed: true, triggerState: 'armed', tracking: true });
    expect(step({ value: 0.9, armed: false, triggerState: 'triggered', tracking: true })).toBe('goal');
    // The limb is lost while they are still holding at end range, for longer than the hold.
    let marks: string[] = [];
    for (let i = 0; i < Math.round(0.4 * FPS); i++) marks.push(step({ value: 0.9, armed: false, tracking: false }));
    expect(marks[marks.length - 1]).toBe('lost');
    // The KR cue survived the first `GOAL_MIN_SEC` of the dropout (it is the patient's knowledge of
    // results, and the frames are still being drawn) and is gone by the time (d) is entered.
    expect(marks.filter((k) => k === 'goal').length / FPS).toBeGreaterThanOrEqual(GOAL_MIN_SEC);
    // They reappear, still at end range, still 'triggered'. That is not a new crossing and the old
    // one is over: the honest message is the lockout, not a second celebration.
    marks = [];
    for (let i = 0; i < 30; i++) marks.push(step({ value: 0.9, armed: false, triggerState: 'triggered', tracking: true }));
    expect(marks).not.toContain('goal');
    expect(marks.every((k) => k === 'locked')).toBe(true);
  });
});

// -------------------------------------------------------------------------------------------------
// THE REFRACTORY WINDOW. `LaneTrigger` swallows a crossing that lands within `minIntervalSec` of the
// last EMITTED one: the lane still enters 'triggered' and VisionInput still reports the rep, but no
// LaneInputEvent is sent and nothing scores. The receptor used to throw the full KR costume for it,
// so a patient with clonus, a tremor or a bounce at end range saw two acknowledgements against one
// step of the score — a contradiction on screen a therapist has to explain away.
// -------------------------------------------------------------------------------------------------

describe('a crossing the input layer swallowed gets no acknowledgement', () => {
  const REARM = DEFAULT_REARM_FRACTION;
  const FPS = 60;
  const MIN_INTERVAL = 0.3;

  /** Drive a real trigger over `values`, one frame per entry, and report events and goal runs. */
  const bounce = (values: number[]): { events: number; runs: number } => {
    const trig = new LaneTrigger({ thresholdFraction: T, rearmFraction: REARM, minIntervalSec: MIN_INTERVAL });
    const h = new ReceptorHistory();
    const look = emptyReceptorLook();
    let events = 0;
    let runs = 0;
    let lit = false;
    for (let i = 0; i < values.length; i++) {
      const t = i / FPS;
      if (trig.push(values[i], t)) events++;
      h.update(
        look,
        0,
        { value: values[i], armed: trig.armed, triggerState: trig.state, tracking: true },
        T,
        REARM,
        t,
        DEFAULT_MAX_GAP_SEC,
        MIN_INTERVAL,
      );
      const now = (look.goal ?? 0) > 0;
      if (now && !lit) runs++;
      lit = now;
    }
    return { events, runs };
  };

  /** A lane at rest with a peak at each of `at` (frame indices) — a crossing per peak. */
  const peaks = (at: number[], frames: number): number[] =>
    Array.from({ length: frames }, (_, i) => (at.includes(i) ? 0.9 : 0.1));

  it('acknowledges once for two crossings 0.2 s apart — the clonus / bounce case', () => {
    // Driven live before the fix: events=1, reps=2 (`emitted:[true,false]`), and TWO goal cues of
    // 0.15 s each against one step of the score.
    const { events, runs } = bounce(peaks([3, 15], FPS));
    expect(events).toBe(1);
    expect(runs).toBe(1);
  });

  it('...and twice when the engine really did credit both', () => {
    // The control, and the direction that must never break: 0.4 s apart is past the window, both
    // crossings score, and withholding knowledge of results from a rep that scored would cost the
    // patient the therapeutic ingredient.
    const { events, runs } = bounce(peaks([3, 27], FPS));
    expect(events).toBe(2);
    expect(runs).toBe(2);
  });

  it('narrows the guard band to one render step, on a real camera cadence', () => {
    // THE ROUND-5 FINDING. The renderer used to time a crossing by the render FRAME it noticed the
    // lockout on, while `LaneTrigger` times it by interpolating between the two samples that bracket
    // the threshold — so the reconstruction was out by up to a camera frame plus a render frame at
    // each end, and the flat 0.05 s guard that covered it left a measured 0.27-0.30 s band throwing
    // a full KR cue for a crossing the engine swallowed: 3.3-3.7 Hz, exactly an end-range bounce.
    // `crossingTime` now runs the trigger's own interpolation on the renderer's own timestamps.
    //
    // Driven at a real cadence (30 fps camera under a 60 Hz render loop), two crossings `sep` apart.
    const CAM = 30;
    const RENDER = 60;
    const twoCrossings = (sep: number): { events: number; runs: number } => {
      const trig = new LaneTrigger({ thresholdFraction: T, rearmFraction: REARM, minIntervalSec: MIN_INTERVAL });
      const h = new ReceptorHistory();
      const look = emptyReceptorLook();
      const at = [0.4, 0.4 + sep];
      // A sharp peak at each time: 0.1 at rest, rising to 0.95 and back over 0.12 s.
      const rom = (t: number): number => {
        let v = 0.1;
        for (const p of at) {
          const d = Math.abs(t - p);
          if (d < 0.06) v = Math.max(v, 0.1 + 0.85 * (1 - d / 0.06));
        }
        return v;
      };
      let events = 0;
      let runs = 0;
      let lit = false;
      let published: LaneStateLike | undefined;
      let cam = 0;
      for (let r = 0; r < Math.round(2 * RENDER); r++) {
        const t = r / RENDER;
        while (cam / CAM <= t + 1e-9) {
          const ct = cam / CAM;
          if (trig.push(rom(ct), ct)) events++;
          published = { value: rom(ct), armed: trig.armed, triggerState: trig.state, tracking: true };
          cam++;
        }
        h.update(look, 0, published, T, REARM, t, DEFAULT_MAX_GAP_SEC, MIN_INTERVAL);
        const now = (look.goal ?? 0) > 0;
        if (now && !lit) runs++;
        lit = now;
      }
      return { events, runs };
    };
    // Well inside the window: one event, one cue. 0.28 s used to read as TWO cues.
    for (const sep of [0.15, 0.2, 0.24, 0.26, 0.28]) {
      const r = twoCrossings(sep);
      expect(r.events, `sep=${sep}`).toBe(1);
      expect(r.runs, `sep=${sep}`).toBe(1);
    }
    // ...and past it, both are credited. This is the direction that must never break: a cue withheld
    // from a rep that scored costs the patient their knowledge of results.
    for (const sep of [0.32, 0.36, 0.45]) {
      const r = twoCrossings(sep);
      expect(r.events, `sep=${sep}`).toBe(2);
      expect(r.runs, `sep=${sep}`).toBe(2);
    }
  });

  it('widens the guard with the render step rather than capping it', () => {
    // The margin is the renderer's own clock, so a slow render loop gets a proportionally wider one:
    // at 10 Hz the reconstruction is out by up to 0.1 s, and a FIXED 0.05 s margin suppressed a
    // crossing the trigger had really emitted (two crossings 0.34 s apart). `refractoryGuard` is the
    // rule; these are the numbers it must produce.
    expect(refractoryGuard(1 / 60)).toBeCloseTo(1 / 60, 6);
    expect(refractoryGuard(0.1)).toBeCloseTo(0.1, 6);
    // ...floored, so a renderer reporting a zero step does not demand the interval be exact.
    expect(refractoryGuard(0)).toBe(REFRACTORY_GUARD_MIN_SEC);
    expect(refractoryGuard(NaN)).toBe(REFRACTORY_GUARD_MIN_SEC);
  });

  it('leaves the scripted sources alone: no frame means no refractory window', () => {
    // KeyboardInput / ReplayInput / AutoplayInput emit every crossing, however close together. A
    // renderer that assumed a window on those paths would refuse the cue for a rep that really did
    // score, which is why `RenderFrame.minIntervalSec` is undefined there rather than defaulted.
    const h = new ReceptorHistory();
    const look = emptyReceptorLook();
    let runs = 0;
    let lit = false;
    const values = peaks([3, 15], FPS);
    for (let i = 0; i < values.length; i++) {
      const held = values[i] >= T;
      h.update(
        look,
        0,
        { value: values[i], armed: !held, triggerState: held ? 'triggered' : 'armed', tracking: true },
        T,
        REARM,
        i / FPS,
      );
      const now = (look.goal ?? 0) > 0;
      if (now && !lit) runs++;
      lit = now;
    }
    expect(runs).toBe(2);
  });
});

// -------------------------------------------------------------------------------------------------
// "…AND YOU ARE STILL UP THERE" IS A CLAIM ABOUT THE LEVEL. The lockout runs from the crossing all
// the way down to the RE-ARM line, which is well below the target line drawn on the same gauge, so
// keying the position marks to `locked` painted the hot column and the split white-hot cap onto a
// patient who had visibly come down off their target.
// -------------------------------------------------------------------------------------------------

describe('the position half of (b) ends at the target line, not at the re-arm line', () => {
  const REARM = DEFAULT_REARM_FRACTION;
  const FPS = 60;

  it('drops the position claim as soon as the patient is below the target, keeping the KR claim', () => {
    const trig = new LaneTrigger({ thresholdFraction: T, rearmFraction: REARM, minIntervalSec: 0.3 });
    const h = new ReceptorHistory();
    const look = emptyReceptorLook();
    // A rep, then a slow eccentric phase that stays above the re-arm level (0.36 of ROM) throughout:
    // locked for every frame of it, and below the target line for most of it.
    const values = [0.1, 0.1, 0.1, 0.9, 0.8, 0.7, 0.62, 0.55, 0.48, 0.42, 0.38];
    const rows = values.map((v, i) => {
      const t = i / FPS;
      trig.push(v, t);
      h.update(look, 0, { value: v, armed: trig.armed, triggerState: trig.state, tracking: true }, T, REARM, t);
      return { v, marks: receptorMarkSet(look), holding: receptorGoalHolding(look), glow: look.glowTarget, locked: look.locked };
    });
    const above = rows.filter((r) => r.v >= T);
    const below = rows.filter((r) => r.v < T && r.marks === 'goal');
    expect(above.length).toBeGreaterThan(0);
    expect(below.length).toBeGreaterThan(0);
    // At or above the target: both claims of (b) are true.
    expect(above.every((r) => r.marks === 'goal' && r.holding)).toBe(true);
    // Below it and still locked: the rep still reached the target (KR marks stay) but the patient is
    // not up there any more — no hot column, no split cap, and no forced halo either.
    expect(below.every((r) => !r.holding)).toBe(true);
    expect(below.every((r) => r.glow === 0)).toBe(true);
    // ...and the lane really is still locked out for all of it, which is what made this invisible.
    expect(below.every((r) => r.locked)).toBe(true);
  });
});

/**
 * THE ROUND-7 BLOCKER: a therapist pause is the most-used control on the play screen and it is the
 * brief's own "mid-song stop". The camera does not stop for it, `GameRunner.draw` keeps handing the
 * renderer live `getLaneStates()`, and `RhythmEngine` drops every event stamped inside the pause —
 * not judged, not scored, not recorded. Measured on the real app before this: holding a lane key
 * with the song clock frozen gave eleven consecutive frames of `goal === 1` and the PiP meter's KR
 * ring lit, with score/reps/hits flat at 0/0/0.
 */
describe('a stopped session is not a rep', () => {
  const REARM = DEFAULT_REARM_FRACTION;
  const FPS = 60;
  const MIN_INTERVAL = 0.3;

  /** One frame, with the session either accepting input or stopped. */
  const feed = (
    h: ReceptorHistory,
    look: ReceptorLook,
    s: LaneStateLike | undefined,
    t: number,
    suspended: boolean,
  ): ReceptorLook => h.update(look, 0, s, T, REARM, t, DEFAULT_MAX_GAP_SEC, MIN_INTERVAL, suspended);

  it('gives NO cue for a whole rep performed while the session is stopped', () => {
    // Driven against the real trigger, which is exactly what happens in the clinic: the lane really
    // does cross, `VisionInput` really does emit, `LaneTrigger` really does lock out — and the
    // engine throws the event away because it is stamped inside the pause.
    const trig = new LaneTrigger({ thresholdFraction: T, rearmFraction: REARM, minIntervalSec: MIN_INTERVAL });
    const h = new ReceptorHistory();
    const look = emptyReceptorLook();
    let crossed = 0;
    let cues = 0;
    let rising = 0;
    for (let i = 0; i <= 40; i++) {
      const value = 0.9 * Math.sin((Math.PI * i) / 40); // 0 → 0.9 → 0, one full rep
      const t = i / FPS;
      if (trig.push(value, t)) crossed++;
      feed(h, look, { value, armed: trig.armed, triggerState: trig.state, tracking: true }, t, true);
      if ((look.goal ?? 0) > 0) cues++;
      if (receptorMarkSet(look) === 'rising') rising++;
      // ...and the other half of the same lie: no graded "how much further" readout either, because
      // the honest answer to "what will the input layer do with this" is "nothing".
      expect(receptorMarkSet(look)).toBe('lost');
      expect(look.suspended).toBe(true);
    }
    expect(crossed).toBe(1); // the input layer really did fire — this is not a rep that failed
    expect(cues).toBe(0);    // ...and the display said nothing about it
    expect(rising).toBe(0);
  });

  it('reads as (d) exactly — the same blanked look a dead tracker gets, plus the glyph flag', () => {
    // Not a fifth state: the mark set is the patient's remedy, and a stopped session has none. Every
    // field a consumer could paint a gauge, a lockout or a halo out of is blanked the same way.
    const h = new ReceptorHistory();
    const look = emptyReceptorLook();
    feed(h, look, { value: 0.5, armed: true, triggerState: 'armed', tracking: true }, 0, false);
    expect(receptorMarkSet(look)).toBe('rising');
    feed(h, look, { value: 0.5, armed: true, triggerState: 'armed', tracking: true }, 1 / FPS, true);
    expect(receptorMarkSet(look)).toBe('lost');
    expect(look.tracking).toBe(false);
    expect(look.suspended).toBe(true);
    expect(look.locked).toBe(false);
    expect(look.needsLower).toBe(false);
    expect(look.goal).toBe(0);
    expect(look.glowTarget).toBe(0);
    expect(look.resetProgress).toBe(0);
    expect(look.stale).toBe(false);
    expect(receptorGoalHolding(look)).toBe(false);
    // A lane that is locked out when the stop arrives is blanked too: "lower to reset" is an
    // instruction about the next rep, and there is no next rep until the therapist resumes.
    feed(h, look, { value: 0.9, armed: false, triggerState: 'triggered', tracking: true }, 2 / FPS, true);
    expect(receptorMarkSet(look)).toBe('lost');
    expect(look.locked).toBe(false);
    // And a dead tracker inside a stop still reads (d) — it just is not the SESSION's doing, so the
    // glyph is the pause bars either way and the therapist's remedy is the one on screen.
    feed(h, look, { value: 0, armed: true, triggerState: 'armed', tracking: false }, 3 / FPS, true);
    expect(receptorMarkSet(look)).toBe('lost');
    // ...and the instant it is resumed the gauge is live again, from the patient's real value.
    feed(h, look, { value: 0.3, armed: true, triggerState: 'armed', tracking: true }, 4 / FPS, false);
    expect(receptorMarkSet(look)).toBe('rising');
    expect(look.suspended).toBe(false);
    expect(look.fill).toBeCloseTo(0.5, 6);
  });

  it('cuts a latch that was lit just before the stop, and never brings it back', () => {
    // KR that is held across a pause and finishes after the resume is feedback delivered into the
    // next repetition's concentric phase — non-contingent, which is the failure this file exists to
    // remove. It also must not flicker back on for a stop shorter than the latch.
    const h = new ReceptorHistory();
    const look = emptyReceptorLook();
    feed(h, look, { value: 0.2, armed: true, triggerState: 'armed', tracking: true }, 0, false);
    feed(h, look, { value: 0.9, armed: false, triggerState: 'triggered', tracking: true }, 1 / FPS, false);
    expect(look.goal).toBe(1); // a real rep, acknowledged on the frame it fired
    feed(h, look, { value: 0.9, armed: false, triggerState: 'triggered', tracking: true }, 2 / FPS, true);
    expect(look.goal).toBe(0);
    // Resumed well inside `GOAL_HOLD_SEC`: the cue is gone for good, not merely hidden.
    feed(h, look, { value: 0.9, armed: false, triggerState: 'triggered', tracking: true }, 3 / FPS, false);
    expect(look.goal).toBe(0);
    expect(receptorMarkSet(look)).toBe('locked');
  });

  it('does not read a rep made DURING the stop as a crossing on the frame it resumes', () => {
    // The reason the per-lane record keeps being fed through the suspension. A patient repositioned
    // mid-pause crosses and is still holding at end range when the therapist resumes; freezing the
    // record instead would present that as a fresh 'armed' → 'triggered' edge on the first live
    // frame and celebrate a rep that fired into a paused engine — the same bug, moved.
    const h = new ReceptorHistory();
    const look = emptyReceptorLook();
    feed(h, look, { value: 0.2, armed: true, triggerState: 'armed', tracking: true }, 0, false);
    feed(h, look, { value: 0.9, armed: false, triggerState: 'triggered', tracking: true }, 1 / FPS, true);
    for (let i = 2; i < 30; i++) {
      feed(h, look, { value: 0.9, armed: false, triggerState: 'triggered', tracking: true }, i / FPS, true);
    }
    // Resumed, still held: nothing crossed since the resume, so nothing is acknowledged.
    for (let i = 30; i < 40; i++) {
      feed(h, look, { value: 0.9, armed: false, triggerState: 'triggered', tracking: true }, i / FPS, false);
      expect(look.goal ?? 0).toBe(0);
      expect(receptorMarkSet(look)).toBe('locked');
    }
    // ...and the next REAL rep is acknowledged normally, so nothing is left poisoned behind.
    feed(h, look, { value: 0.2, armed: true, triggerState: 'armed', tracking: true }, 40 / FPS, false);
    feed(h, look, { value: 0.9, armed: false, triggerState: 'triggered', tracking: true }, 41 / FPS, false);
    expect(look.goal).toBe(1);
  });

  it('does not spend the refractory ledger on a crossing the stop discarded', () => {
    // THE EXPENSIVE DIRECTION, and the round-7 finding that goes with the blocker. The renderer
    // reconstructs `LaneTrigger`'s refractory window on its own clock (`REFRACTORY_GUARD_MIN_SEC`),
    // and that clock is `Highway.receptorT`, which stands still for up to `SONG_CLOCK_STALL_SEC` at
    // the start of every stall and then runs on wall time — so a crossing stamped into the ledger
    // during a pause is stamped at a time the input layer never agreed to, and it suppresses the
    // acknowledgement of the first real rep within `minIntervalSec` of it after the resume.
    // Withholding KR from a rep that scored is the one error direction this file refuses.
    const h = new ReceptorHistory();
    const look = emptyReceptorLook();
    feed(h, look, { value: 0.2, armed: true, triggerState: 'armed', tracking: true }, 0.0, false);
    // A crossing inside the stop: fires the trigger, scores nothing, and must leave no trace.
    feed(h, look, { value: 0.9, armed: false, triggerState: 'triggered', tracking: true }, 0.10, true);
    feed(h, look, { value: 0.1, armed: true, triggerState: 'armed', tracking: true }, 0.15, true);
    // Resumed, and a rep the engine really does credit — only 0.15 s after the phantom one.
    feed(h, look, { value: 0.2, armed: true, triggerState: 'armed', tracking: true }, 0.20, false);
    feed(h, look, { value: 0.9, armed: false, triggerState: 'triggered', tracking: true }, 0.25, false);
    expect(look.goal).toBe(1);
    // The ledger is still doing its job for the crossings that really were swallowed: an end-range
    // bounce back inside `minIntervalSec` of the credited rep gets no second acknowledgement. (Fed
    // after the first latch has already been cut by the re-arm at 0.30, so this reads the bounce and
    // not the tail of the rep before it.)
    feed(h, look, { value: 0.1, armed: true, triggerState: 'armed', tracking: true }, 0.30, false);
    feed(h, look, { value: 0.1, armed: true, triggerState: 'armed', tracking: true }, 0.40, false);
    expect(look.goal).toBe(0);
    feed(h, look, { value: 0.9, armed: false, triggerState: 'triggered', tracking: true }, 0.45, false);
    expect(look.goal).toBe(0);
  });

  it('leaves every other path exactly as it was when nothing is suspended', () => {
    // The default is false and the parameter is last, so a caller that knows nothing about stops —
    // the demo, the critic harnesses, every existing test — is unchanged.
    const a = new ReceptorHistory();
    const b = new ReceptorHistory();
    const la = emptyReceptorLook();
    const lb = emptyReceptorLook();
    for (let i = 0; i <= 30; i++) {
      const value = 0.9 * Math.sin((Math.PI * i) / 30);
      const t = i / FPS;
      const s: LaneStateLike = { value, armed: value < T, triggerState: value < T ? 'armed' : 'triggered', tracking: true };
      a.update(la, 0, s, T, REARM, t, DEFAULT_MAX_GAP_SEC, MIN_INTERVAL);
      b.update(lb, 0, s, T, REARM, t, DEFAULT_MAX_GAP_SEC, MIN_INTERVAL, false);
      expect({ ...lb }).toEqual({ ...la });
    }
  });
});
