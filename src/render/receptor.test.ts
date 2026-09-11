import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_GAP_SEC,
  DEFAULT_REARM_FRACTION,
  GOAL_FADE_SEC,
  GOAL_HOLD_SEC,
  LOST_HOLD_SEC,
  ReceptorHistory,
  emptyReceptorLook,
  goalStrength,
  receptorLook,
  receptorLookInto,
  type LaneStateLike,
  type ReceptorLook,
} from './receptor';
import { DEFAULT_MAX_GAP_SEC as TRIGGER_MAX_GAP_SEC, LaneTrigger } from '../vision/trigger';

const T = 0.6; // a plausible calibrated thresholdFraction

describe('receptorLook — the meter means what the engine means', () => {
  it('fills against thresholdFraction, not against 1.0', () => {
    expect(receptorLook({ value: 0, armed: true }, T).fill).toBe(0);
    expect(receptorLook({ value: 0.3, armed: true }, T).fill).toBeCloseTo(0.5, 6);
    expect(receptorLook({ value: 0.6, armed: true }, T).fill).toBe(1);
    // Past threshold the meter stays full (it cannot read "more than triggering").
    expect(receptorLook({ value: 0.95, armed: true }, T).fill).toBe(1);
  });

  it('reads "will fire" exactly when the lane would fire', () => {
    // Armed and at threshold: the lane fires. This is the only state that gets the hot fill + halo.
    expect(receptorLook({ value: 0.6, armed: true }, T).willFire).toBe(true);
    // One notch below threshold: no.
    expect(receptorLook({ value: 0.599, armed: true }, T).willFire).toBe(false);
    // Full value but NOT re-armed (patient holding at end range after a rep): the lane cannot fire,
    // so the receptor must not claim it will. This is the case the whole state model exists for.
    expect(receptorLook({ value: 0.95, armed: false }, T).willFire).toBe(false);
    // Tracking lost: nothing can fire.
    expect(receptorLook({ value: 0.95, armed: true, tracking: false }, T).willFire).toBe(false);
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
    const out: ReceptorLook = { fill: 0, over: 0, willFire: false, locked: false, resetProgress: 0, resetLevel: 0.6, glowTarget: 0, tracking: true };
    const a = receptorLookInto(out, { value: 0.9, armed: true }, T, DEFAULT_REARM_FRACTION);
    expect(a).toBe(out);
    expect(out.willFire).toBe(true);
    receptorLookInto(out, { value: 0.9, armed: false }, T, DEFAULT_REARM_FRACTION);
    expect(out.willFire).toBe(false);
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

  it('a real LaneTrigger never publishes `armed && value >= threshold` — so willFire alone is dead', () => {
    // This is the failure the latch exists for, asserted against the real trigger rather than
    // against a hand-built LaneState: drive a full rep exactly the way VisionInput does (push the
    // sample, THEN read `armed`, which is the order src/input/VisionInput.ts uses) and count the
    // frames that satisfy the single-frame "will fire" test. There are none, ever.
    const trig = new LaneTrigger({ thresholdFraction: T, rearmFraction: REARM, minIntervalSec: 0.3 });
    let willFire = 0;
    let crossed = 0;
    for (let i = 0; i <= 30; i++) {
      const value = 0.9 * Math.sin((Math.PI * i) / 30); // 0 → 0.9 → 0, one rep
      const t = i / 30;
      if (trig.push(value, t)) crossed++;
      const look = receptorLook({ value, armed: trig.armed }, T);
      if (look.willFire) willFire++;
    }
    expect(crossed).toBe(1);       // the rep really did fire
    expect(willFire).toBe(0);      // ...and no frame of it ever looked like it would
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
    expect(look.locked).toBe(true);
    expect(look.needsLower).toBe(true); // it tells them the true thing instead: lower to reset
    // ...and it stays refused for the whole span the celebration would have lasted.
    for (let i = 0; i < 20; i++) {
      push(0.95);
      expect(look.goal ?? 0).toBe(0);
    }
    expect(events).toBe(0);
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
    // The way to stop guessing: 'armed' → 'triggered' is a crossing and nothing else is, however
    // full the meter and however fresh the stream. VisionInput does not publish this in LaneState
    // yet (it is on LaneDebug/LaneActivity); when it does, the two guards above become belt and
    // braces rather than the only defence.
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

  it('mirrors the input layer\'s own break-in-the-stream window', () => {
    // The guard is only as good as the number it uses; if the trigger's default ever moves, the
    // renderer's must move with it (or the session must pass RenderFrame.maxGapSec).
    expect(DEFAULT_MAX_GAP_SEC).toBe(TRIGGER_MAX_GAP_SEC);
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
