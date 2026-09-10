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

  it('(C) an occlusion gap disarms: recovering above threshold is not a rising edge', () => {
    const trig = new LaneTrigger({ thresholdFraction: 0.5 });
    trig.push(0.1, 0.5); // armed
    expect(trig.armed).toBe(true);
    trig.push(null, 0.6); // tracking lost mid-rep
    expect(trig.state).toBe('unconfirmed');
    expect(trig.push(0.9, 0.7)).toBeNull(); // recovered high: the rise was never observed
    trig.push(0.05, 0.8);
    expect(trig.push(0.9, 0.9)).not.toBeNull();
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
