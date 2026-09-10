import { describe, expect, it } from 'vitest';
import { LaneTrigger, MIN_SAME_LANE_NOTE_SPACING_SEC, DEFAULT_MIN_INTERVAL_SEC, minSameLaneNoteSpacingSec } from './trigger.ts';
import { repSequence } from './fixtures.ts';

describe('LaneTrigger', () => {
  it('emits exactly one event per rep with hysteresis', () => {
    const trig = new LaneTrigger({ thresholdFraction: 0.6 });
    const seq = repSequence({ restSec: 1, reps: 5, repDurationSec: 1, amplitude: 1, noise: 0.05, seed: 3 });
    const events = [];
    for (const { t, amount } of seq) {
      const e = trig.push(amount, t);
      if (e) events.push(e);
    }
    expect(events).toHaveLength(5);
    // Each event lies on the rising half of its rep (rep k starts at 1 + k).
    events.forEach((e, k) => {
      expect(e.ctxTime).toBeGreaterThan(1 + k);
      expect(e.ctxTime).toBeLessThan(1 + k + 0.5);
      expect(e.strength).toBeGreaterThanOrEqual(0.6);
    });
  });

  it('does not re-trigger while hovering around the threshold (must fall below 0.6x)', () => {
    const trig = new LaneTrigger({ thresholdFraction: 0.5 });
    let t = 0;
    const step = (v: number) => trig.push(v, (t += 0.1));
    expect(step(0)).toBeNull();
    expect(step(0.7)).not.toBeNull();
    expect(trig.armed).toBe(false);
    for (const v of [0.4, 0.55, 0.35, 0.6, 0.31]) expect(step(v)).toBeNull();
    expect(trig.armed).toBe(false);
    expect(step(0.29)).toBeNull(); // below 0.3 => re-armed
    expect(trig.armed).toBe(true);
    expect(step(0.8)).not.toBeNull();
  });

  it('interpolates the crossing time between frames', () => {
    const trig = new LaneTrigger({ thresholdFraction: 0.5 });
    trig.push(0.2, 1.0);
    const e = trig.push(0.8, 1.1);
    expect(e).not.toBeNull();
    // 0.2 -> 0.8 over 100 ms; threshold 0.5 is halfway => 1.05
    expect(e!.ctxTime).toBeCloseTo(1.05, 9);
    expect(e!.strength).toBe(0.8);
  });

  it('tracks the peak and supports threshold changes / reset', () => {
    const trig = new LaneTrigger({ thresholdFraction: 0.5 });
    trig.push(0, 0);
    trig.push(0.6, 0.1);
    trig.push(0.95, 0.2);
    expect(trig.peakSinceTrigger).toBe(0.95);
    trig.setThreshold(0.9);
    expect(trig.rearmLevel).toBeCloseTo(0.54);
    trig.reset();
    // reset() leaves the lane DISARMED: it must be observed below the re-arm level before it can fire.
    expect(trig.armed).toBe(false);
    expect(trig.state).toBe('unconfirmed');
    expect(trig.peakSinceTrigger).toBe(0);
  });
});

describe('LaneTrigger is a rising-edge detector, never a level detector', () => {
  it('(A) a fresh trigger fed a limb already held above threshold emits nothing', () => {
    const trig = new LaneTrigger({ thresholdFraction: 0.6 });
    expect(trig.state).toBe('unconfirmed');
    for (let i = 0; i < 10; i++) expect(trig.push(0.95, i / 30)).toBeNull();
    expect(trig.state).toBe('unconfirmed');
    // Lower the limb, raise it again: NOW there is an observed rising edge.
    expect(trig.push(0.1, 10 / 30)).toBeNull();
    expect(trig.armed).toBe(true);
    expect(trig.push(0.95, 11 / 30)).not.toBeNull();
  });

  it('(B) reset() mid-rep (therapist re-calibration) cannot re-score the still-ongoing rep', () => {
    const trig = new LaneTrigger({ thresholdFraction: 0.6 });
    trig.push(0, 0);
    expect(trig.push(0.9, 0.1)).not.toBeNull();
    trig.reset(); // e.g. VisionInput.setCalibration while the knee is still up
    for (let i = 0; i < 10; i++) expect(trig.push(0.9, 0.2 + i / 30)).toBeNull();
    // Only after the limb comes down and goes up again does a second hit exist.
    trig.push(0.05, 1);
    expect(trig.push(0.9, 1.1)).not.toBeNull();
  });

  it('(C) a LONG occlusion disarms: recovering above threshold is not a rising edge', () => {
    const trig = new LaneTrigger({ thresholdFraction: 0.5, maxGapSec: 0.2 });
    trig.push(0.1, 0.5); // armed
    expect(trig.armed).toBe(true);
    for (let t = 0.6; t <= 1.2; t += 0.1) trig.push(null, t); // tracking lost for 0.7 s
    expect(trig.state).toBe('unconfirmed');
    expect(trig.push(0.9, 1.3)).toBeNull(); // recovered high: a whole rep could have happened unseen
    trig.push(0.05, 1.4);
    expect(trig.push(0.9, 1.5)).not.toBeNull();
  });

  it('(C-short) a dropped frame during the RISE keeps the rep: the arming survives the dropout', () => {
    // THE ROUND-3 BUG: one null sample used to demote 'armed' -> 'unconfirmed', so a single
    // low-visibility frame at 35% of ROM cost the hit AND the rep, invisibly (status still 'ok').
    const trig = new LaneTrigger({ thresholdFraction: 0.5, maxGapSec: 0.5 });
    expect(trig.push(0.05, 0)).toBeNull();
    expect(trig.armed).toBe(true);
    trig.push(0.35, 1 / 30);
    trig.push(null, 2 / 30); // ONE dropped frame, mid-rise
    expect(trig.state).toBe('armed'); // the below-re-arm observation still stands
    const e = trig.push(0.65, 3 / 30)!;
    expect(e).not.toBeNull();
    expect(e.afterGap).toBe(true); // flagged: the crossing time is less precise, not hidden
    // Interpolated ACROSS the dropout (0.35 -> 0.65 spans the threshold at 50%), so the estimate is
    // unbiased rather than pinned a whole gap late to the recovery frame.
    expect(e.interpolated).toBe(true);
    expect(e.gapSec).toBeCloseTo(2 / 30, 9);
    expect(e.ctxTime).toBeCloseTo(1 / 30 + (2 / 30) * 0.5, 9);
    expect(e.ctxTime).toBeLessThan(3 / 30);
    trig.push(0.05, 4 / 30);
    expect(trig.takeCompletedRep()).toMatchObject({ emitted: true, gapped: true });
  });

  it('(C-short) still needs a below-re-arm observation: a dropout cannot manufacture a rising edge', () => {
    const trig = new LaneTrigger({ thresholdFraction: 0.5, maxGapSec: 0.5 });
    // Never seen below the re-arm level: a dropout followed by a high sample is NOT a rep.
    for (let i = 0; i < 5; i++) trig.push(0.9, i / 30);
    trig.push(null, 5 / 30);
    expect(trig.state).toBe('unconfirmed');
    expect(trig.push(0.95, 6 / 30)).toBeNull();
  });

  it('a lane dropping 2% of frames loses no reps and no hits', () => {
    // Probe from the round-3 review: 2%/frame lane dropout over 40 reps used to cost ~2.5 reps per
    // percent of dropout, silently. Now every rep is scored and reported.
    const trig = new LaneTrigger({ thresholdFraction: 0.5, minIntervalSec: 0.3, maxGapSec: 0.5 });
    let seed = 12345;
    const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    let hits = 0;
    let reps = 0;
    const fps = 30;
    const repSec = 1.2;
    const total = 40 * repSec;
    for (let i = 0; i * (1 / fps) < total; i++) {
      const t = i / fps;
      const v = 0.5 * (1 - Math.cos((2 * Math.PI * t) / repSec));
      if (trig.push(rand() < 0.02 ? null : v, t)) hits++;
      if (trig.takeCompletedRep()) reps++;
    }
    expect(hits).toBe(40);
    expect(reps).toBeGreaterThanOrEqual(39); // the last rep may still be in flight
  });

  it('(C2) a long gap with no samples at all (stalled camera) disarms just like a null sample', () => {
    const trig = new LaneTrigger({ thresholdFraction: 0.5, maxGapSec: 0.5 });
    trig.push(0.1, 1);
    expect(trig.armed).toBe(true);
    expect(trig.push(0.9, 31)).toBeNull(); // 30 s later: whatever happened in between was not observed
    trig.push(0.1, 31.05);
    expect(trig.push(0.9, 31.1)).not.toBeNull();
  });

  it('a gap DURING a rep does not invalidate the rep: re-arming still needs a below-re-arm sample', () => {
    const trig = new LaneTrigger({ thresholdFraction: 0.5 });
    trig.push(0.1, 0);
    const e = trig.push(0.9, 0.1)!;
    expect(e).not.toBeNull();
    trig.push(null, 0.2);
    expect(trig.state).toBe('triggered');
    trig.push(0.8, 0.3); // still up
    expect(trig.takeCompletedRep()).toBeNull();
    trig.push(0.1, 0.4);
    expect(trig.takeCompletedRep()).toMatchObject({ emitted: true, peak: 0.9 });
    expect(trig.armed).toBe(true);
  });
});

describe('LaneTrigger timing and rep bookkeeping', () => {
  it('enforces the minimum re-trigger interval', () => {
    const trig = new LaneTrigger({ thresholdFraction: 0.5, minIntervalSec: 0.3 });
    expect(trig.push(0, 0)).toBeNull();
    expect(trig.push(1, 0.05)).not.toBeNull();
    trig.push(0, 0.1);
    expect(trig.armed).toBe(true);
    expect(trig.push(1, 0.15)).toBeNull(); // too soon, swallowed
    trig.push(0, 0.2);
    expect(trig.push(1, 0.5)).not.toBeNull();
  });

  it('exports the re-trigger interval as the minimum same-lane note spacing for chart generation', () => {
    expect(MIN_SAME_LANE_NOTE_SPACING_SEC).toBe(DEFAULT_MIN_INTERVAL_SEC);
    expect(minSameLaneNoteSpacingSec()).toBe(0.3);
    expect(minSameLaneNoteSpacingSec(0.2)).toBe(0.2);
    // At 160 BPM eighth notes are 187 ms apart: closer than the guard, so a same-lane pair is unhittable.
    expect(60 / 160 / 2).toBeLessThan(MIN_SAME_LANE_NOTE_SPACING_SEC);
    expect(60 / 160).toBeGreaterThan(MIN_SAME_LANE_NOTE_SPACING_SEC); // quarter notes are fine
  });

  it('swallowed crossings still surface as reps (emitted:false), so rep counts stay honest', () => {
    const trig = new LaneTrigger({ thresholdFraction: 0.5, minIntervalSec: 0.3 });
    let crossings = 0;
    let emitted = 0;
    const reps = [];
    // 4 Hz reps: many more crossings than the 300 ms guard allows to score.
    for (let i = 0; i * (1 / 60) <= 3.34; i++) {
      const t = i / 60;
      const v = 0.5 * (1 - Math.cos(2 * Math.PI * 4 * t));
      const wasArmed = trig.armed;
      const e = trig.push(v, t);
      if (wasArmed && v >= 0.5) crossings++;
      if (e) emitted++;
      const rep = trig.takeCompletedRep();
      if (rep) reps.push(rep);
    }
    expect(crossings).toBeGreaterThan(emitted);
    expect(reps.length).toBeGreaterThanOrEqual(crossings - 1);
    expect(reps.some((r) => r.emitted === false)).toBe(true);
    expect(reps.filter((r) => r.emitted).length).toBe(emitted);
  });

  it('reports each completed rep with its peak once the lane re-arms (joined by ctxTime)', () => {
    const trig = new LaneTrigger({ thresholdFraction: 0.5, minIntervalSec: 0.5 });
    expect(trig.takeCompletedRep()).toBeNull();
    trig.push(0, 0);
    const e = trig.push(0.6, 0.1)!;
    expect(e).not.toBeNull();
    trig.push(0.9, 0.2);
    trig.push(0.7, 0.3);
    expect(trig.takeCompletedRep()).toBeNull(); // still above the re-arm level
    trig.push(0.1, 0.4);
    const rep = trig.takeCompletedRep()!;
    expect(rep).toEqual({ ctxTime: e.ctxTime, endCtxTime: 0.4, peak: 0.9, rawPeak: 0.9, emitted: true });
    expect(trig.takeCompletedRep()).toBeNull(); // consumed
    // A crossing swallowed by the min re-trigger interval still completes, flagged emitted:false.
    expect(trig.push(0.8, 0.45)).toBeNull();
    trig.push(0.0, 0.5);
    expect(trig.takeCompletedRep()).toMatchObject({ emitted: false, peak: 0.8 });
  });

  it('setThreshold cannot hand out a free hit: lowering it re-checks the arming', () => {
    // Round-3 probe: armed at threshold 0.8 with the value held STEADY at 0.40 (re-arm 0.48), then
    // setThreshold(0.3) -> the next push of the SAME 0.40 used to emit a hit for zero movement.
    const trig = new LaneTrigger({ thresholdFraction: 0.8 });
    let t = 0;
    for (let i = 0; i < 10; i++) expect(trig.push(0.4, (t += 1 / 30))).toBeNull();
    expect(trig.armed).toBe(true);
    trig.setThreshold(0.3);
    expect(trig.state).toBe('unconfirmed'); // 0.40 is above the NEW re-arm level of 0.18
    expect(trig.push(0.4, (t += 1 / 30))).toBeNull();
    expect(trig.push(0.9, (t += 1 / 30))).toBeNull();
    // A real return to rest re-arms it, and then a real rise scores.
    trig.push(0.1, (t += 1 / 30));
    expect(trig.armed).toBe(true);
    expect(trig.push(0.9, (t += 1 / 30))).not.toBeNull();
  });

  it('setThreshold keeps the arming when the lane really is below the new re-arm level', () => {
    const trig = new LaneTrigger({ thresholdFraction: 0.8 });
    trig.push(0.05, 0);
    expect(trig.armed).toBe(true);
    trig.setThreshold(0.3); // new re-arm level 0.18; 0.05 is genuinely below it
    expect(trig.armed).toBe(true);
    expect(trig.push(0.35, 0.1)).not.toBeNull();
  });

  it('raising the threshold mid-rep neither scores nor loses the rep in flight', () => {
    const trig = new LaneTrigger({ thresholdFraction: 0.4 });
    trig.push(0.05, 0);
    expect(trig.push(0.5, 0.1)).not.toBeNull();
    trig.setThreshold(0.9);
    expect(trig.state).toBe('triggered');
    expect(trig.push(0.5, 0.2)).toBeNull();
    trig.push(0.1, 0.3); // below the new re-arm level 0.54 => rep completes
    expect(trig.takeCompletedRep()).toMatchObject({ emitted: true, peak: 0.5 });
  });

  it('carries the UNCLAMPED value so exceeding the calibrated ROM stays measurable', () => {
    const trig = new LaneTrigger({ thresholdFraction: 0.6 });
    trig.push(0, 0, 0);
    const e = trig.push(1, 0.1, 1.4)!; // 140% of the calibrated range
    expect(e.strength).toBe(1);
    expect(e.rawStrength).toBeCloseTo(1.4, 9);
    trig.push(1, 0.2, 1.55);
    expect(trig.peakSinceTrigger).toBe(1);
    expect(trig.rawPeakSinceTrigger).toBeCloseTo(1.55, 9);
    trig.push(0, 0.3, 0);
    const rep = trig.takeCompletedRep()!;
    expect(rep.peak).toBe(1);
    expect(rep.rawPeak).toBeCloseTo(1.55, 9);
  });
});

describe('LaneTrigger closes a rep that the stream break left open', () => {
  it('a blackout longer than maxGapSec ends the rep at the last OBSERVED sample, flagged truncated', () => {
    const trig = new LaneTrigger({ thresholdFraction: 0.5, maxGapSec: 0.5 });
    trig.push(0.05, 0);
    expect(trig.push(0.9, 0.1)).not.toBeNull(); // earned crossing: the rep is real and scored
    trig.push(0.95, 0.2);
    // Camera wedges. The patient rests, does a whole second rep and comes back up, unobserved.
    expect(trig.push(0.95, 12)).toBeNull();
    const rep = trig.takeCompletedRep()!;
    expect(rep).toMatchObject({ endCtxTime: 0.2, peak: 0.95, emitted: true, truncated: true });
    expect(rep.endCtxTime - rep.ctxTime).toBeLessThan(0.5); // NOT a 12-second "rep"
    // And the lane is disarmed: the post-blackout level is not a rising edge.
    expect(trig.state).toBe('unconfirmed');
    expect(trig.push(0.95, 12.03)).toBeNull();
    trig.push(0.05, 12.06);
    expect(trig.push(0.9, 12.1)).not.toBeNull();
  });

  it('detects the blackout from the null samples themselves, without waiting for recovery', () => {
    const trig = new LaneTrigger({ thresholdFraction: 0.5, maxGapSec: 0.5 });
    trig.push(0, 0);
    trig.push(1, 0.1);
    for (let t = 0.2; t < 0.6; t += 0.1) {
      trig.push(null, t);
      expect(trig.takeCompletedRep()).toBeNull(); // still inside the tolerated gap
    }
    trig.push(null, 0.75);
    expect(trig.takeCompletedRep()).toMatchObject({ endCtxTime: 0.1, truncated: true });
  });

  it('a SHORT dropout still leaves the rep intact and unflagged (the common dropped frame)', () => {
    const trig = new LaneTrigger({ thresholdFraction: 0.5, maxGapSec: 0.5 });
    trig.push(0.1, 0);
    trig.push(0.9, 0.1);
    trig.push(null, 0.13);
    trig.push(0.8, 0.17);
    expect(trig.takeCompletedRep()).toBeNull();
    trig.push(0.1, 0.25);
    const rep = trig.takeCompletedRep()!;
    expect(rep.truncated).toBeUndefined();
    expect(rep).toMatchObject({ endCtxTime: 0.25, peak: 0.9, emitted: true });
  });
});

/**
 * The dropout the old rule could not see: no null sample, no break past maxGapSec — the frames simply
 * stop arriving for a while and then resume (GC pause, tab hiccup, the detect loop's adaptive throttle).
 */
describe('LaneTrigger measured (unannounced) dropouts', () => {
  it('flags a crossing interpolated across a silent 400 ms hole', () => {
    const trig = new LaneTrigger({ thresholdFraction: 0.65, maxGapSec: 0.5 });
    trig.push(0.05, 0);
    trig.push(0.1, 0.033);
    // …nothing at all for 400 ms, then the value is suddenly at 0.95.
    const ev = trig.push(0.95, 0.433)!;
    expect(ev).not.toBeNull();
    expect(ev.interpolated).toBe(true);
    expect(ev.gapSec).toBeCloseTo(0.4, 9);
    expect(ev.afterGap).toBe(true); // the whole point: uncertain by ±200 ms, and it says so
    trig.push(0.1, 0.5);
    expect(trig.takeCompletedRep()).toMatchObject({ emitted: true, gapped: true });
  });

  it('does NOT flag the steady cadence of a healthy 30 fps stream', () => {
    const trig = new LaneTrigger({ thresholdFraction: 0.65 });
    let t = 0;
    let ev = null as ReturnType<LaneTrigger['push']>;
    for (let i = 0; i < 10; i++, t += 1 / 30) trig.push(0.05, t);
    for (const v of [0.3, 0.6, 0.9]) {
      const e = trig.push(v, t);
      t += 1 / 30;
      if (e) ev = e;
    }
    expect(ev).not.toBeNull();
    expect(ev!.afterGap).toBeUndefined();
    expect(ev!.gapSec).toBeCloseTo(1 / 30, 6);
  });

  it('adapts to a sustained rate change instead of flagging every frame of it', () => {
    // The loop throttles from 30 fps to 12 fps and stays there: that is the cadence now, not a dropout.
    const trig = new LaneTrigger({ thresholdFraction: 0.65 });
    let t = 0;
    for (let i = 0; i < 6; i++, t += 1 / 30) trig.push(0.05, t);
    for (let i = 0; i < 10; i++, t += 1 / 12) trig.push(0.05, t);
    expect(trig.nominalIntervalSec).toBeCloseTo(1 / 12, 6);
    trig.push(0.3, t);
    t += 1 / 12;
    const ev = trig.push(0.9, t)!;
    expect(ev.afterGap).toBeUndefined();
  });

  it('a pinned nominalIntervalSec overrides the measurement', () => {
    const trig = new LaneTrigger({ thresholdFraction: 0.65, nominalIntervalSec: 1 / 30 });
    expect(trig.nominalIntervalSec).toBeCloseTo(1 / 30, 9);
    expect(trig.isTimingGap(1 / 30)).toBe(false);
    expect(trig.isTimingGap(0.06)).toBe(true);
    // Fed a slow but perfectly steady 12 fps stream it keeps complaining, because it was told to.
    let t = 0;
    for (let i = 0; i < 8; i++, t += 1 / 12) trig.push(0.05, t);
    const ev = trig.push(0.9, t)!;
    expect(ev.afterGap).toBe(true);
  });

  it('never calls the first interval of a stream a gap (nothing to compare it with)', () => {
    const trig = new LaneTrigger({ thresholdFraction: 0.5 });
    expect(trig.nominalIntervalSec).toBeNull();
    expect(trig.isTimingGap(10)).toBe(false);
    trig.push(0.1, 0);
    const ev = trig.push(0.9, 0.4)!;
    expect(ev.afterGap).toBeUndefined();
  });

  it('flags a rep whose PEAK fell inside a silent hole, even with a clean crossing', () => {
    const trig = new LaneTrigger({ thresholdFraction: 0.5, maxGapSec: 0.5 });
    let t = 0;
    for (let i = 0; i < 8; i++, t += 1 / 30) trig.push(0.1, t);
    trig.push(0.4, t);
    t += 1 / 30;
    expect(trig.push(0.6, t)!.afterGap).toBeUndefined(); // the crossing itself was clean
    t += 0.3; // …and then 300 ms of nothing while the patient was at their peak
    trig.push(0.55, t);
    t += 1 / 30;
    trig.push(0.1, t);
    const rep = trig.takeCompletedRep()!;
    expect(rep.truncated).toBeUndefined();
    expect(rep.gapped).toBe(true); // peak 0.6 is a LOWER BOUND, and says so
  });
});

describe('LaneTrigger hot-path hygiene and configuration guards', () => {
  it('tracks the median of the LAST 8 intervals with no per-read sort', () => {
    const trig = new LaneTrigger({ thresholdFraction: 0.5 });
    let t = 0;
    // 8 intervals of 1/30, then 8 of 1/60: the window must have fully rolled over.
    for (let i = 0; i < 9; i++, t += 1 / 30) trig.push(0.1, t);
    expect(trig.nominalIntervalSec).toBeCloseTo(1 / 30, 9);
    for (let i = 0; i < 8; i++, t += 1 / 60) trig.push(0.1, t);
    expect(trig.nominalIntervalSec).toBeCloseTo(1 / 60, 9);
    // A single 400 ms hole must NOT raise the bar it is itself measured against (median, not mean).
    t += 0.4;
    trig.push(0.1, t);
    expect(trig.nominalIntervalSec).toBeCloseTo(1 / 60, 9);
    expect(trig.isTimingGap(0.4)).toBe(true);
    // The estimate agrees with a plain sort of the same window at every step of a jittery stream.
    const ref = new LaneTrigger({ thresholdFraction: 0.5 });
    const seen: number[] = [];
    let u = 0;
    ref.push(0.1, u); // the first sample brackets no interval
    for (const gap of [0.03, 0.05, 0.02, 0.09, 0.031, 0.04, 0.033, 0.02, 0.07, 0.01, 0.06, 0.035]) {
      u += gap;
      ref.push(0.1, u);
      seen.push(gap);
      const window = seen.slice(-8).sort((a, b) => a - b);
      const n = window.length;
      const median = n % 2 === 1 ? window[(n - 1) / 2] : (window[n / 2 - 1] + window[n / 2]) / 2;
      expect(ref.nominalIntervalSec).toBeCloseTo(median, 12);
    }
    ref.reset();
    expect(ref.nominalIntervalSec).toBeNull();
  });

  it('refuses a threshold that would leave the lane permanently dead', () => {
    // At 0 the re-arm level is 0 too, so `value < rearmLevel` is never true: the lane can never leave
    // 'unconfirmed' and never fires, while looking healthy. NaN is the same failure with no watchdog.
    expect(() => new LaneTrigger({ thresholdFraction: 0 })).toThrow(/thresholdFraction/);
    expect(() => new LaneTrigger({ thresholdFraction: Number.NaN })).toThrow(/thresholdFraction/);
    expect(() => new LaneTrigger({ thresholdFraction: 1.2 })).toThrow(/thresholdFraction/);
    const trig = new LaneTrigger({ thresholdFraction: 0.5 });
    expect(() => trig.setThreshold(0)).toThrow(/thresholdFraction/);
    expect(trig.thresholdFraction).toBe(0.5); // unchanged by the refused edit
    trig.setThreshold(1);
    expect(trig.thresholdFraction).toBe(1);
  });
});
