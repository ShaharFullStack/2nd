import { describe, expect, it } from 'vitest';
import { RomCalibrator, normalizeFeature, percentile, isCalibrationValid } from './calibration.ts';
import { extractFeature } from './features.ts';
import { handPose, repSequence, seatedPose } from './fixtures.ts';

describe('percentile / normalize', () => {
  it('percentile interpolates', () => {
    expect(percentile([1, 2, 3], 0.5)).toBe(2);
    expect(percentile([1, 2, 3], 0.9)).toBeCloseTo(2.8);
    expect(percentile([5], 0.9)).toBe(5);
  });
  it('normalizeFeature clamps to 0..1', () => {
    const cal = { min: 10, max: 20 };
    expect(normalizeFeature(cal, 5)).toBe(0);
    expect(normalizeFeature(cal, 15)).toBe(0.5);
    expect(normalizeFeature(cal, 25)).toBe(1);
    expect(normalizeFeature({ min: 1, max: 1 }, 1)).toBe(0);
  });
});

describe('RomCalibrator', () => {
  it('finds min (rest median) and max (90th pct of peaks) from a synthetic knee-lift sequence', () => {
    const cal = new RomCalibrator('seated_march');
    const seq = repSequence({ restSec: 2.5, reps: 3, repDurationSec: 1.5, amplitude: 0.8, noise: 0.03, seed: 7 });
    const restFeature = extractFeature('seated_march', seatedPose({ kneeLift: 0 }), 'left') as number;
    const peakFeature = extractFeature('seated_march', seatedPose({ kneeLift: 0.8 }), 'left') as number;
    let sawMove = false;
    for (const { t, amount } of seq) {
      const f = extractFeature('seated_march', seatedPose({ kneeLift: amount }), 'left');
      const phase = cal.push(f, t);
      if (phase === 'move') sawMove = true;
      if (t < 2) expect(cal.getPhase()).toBe('rest');
    }
    expect(sawMove).toBe(true);
    expect(cal.getPhase()).toBe('done');
    expect(cal.getError()).toBeNull();
    const res = cal.getResult()!;
    expect(res).not.toBeNull();
    expect(res.min).toBeCloseTo(restFeature, 1);
    expect(Math.abs(res.max - peakFeature)).toBeLessThan(0.08);
    expect(res.peaks).toHaveLength(3);
    expect(res.samples).toBeGreaterThan(100);
    expect(res.movement).toBe('seated_march');
    expect(cal.normalize(res.min)).toBe(0);
    expect(cal.normalize(res.max)).toBe(1);
    expect(cal.normalize((res.min + res.max) / 2)).toBeCloseTo(0.5);
    expect(isCalibrationValid(res, 'seated_march')).toBe(true);
    expect(cal.getStatus().message).toMatch(/complete/i);
  });

  it('works for a hand movement (finger_opposition pinch reps)', () => {
    const cal = new RomCalibrator('finger_opposition');
    for (const { t, amount } of repSequence({ reps: 3, amplitude: 1 })) {
      cal.push(extractFeature('finger_opposition', handPose({ pinch: amount }), 'right'), t);
    }
    expect(cal.getPhase()).toBe('done');
    const res = cal.getResult()!;
    expect(res.max - res.min).toBeGreaterThan(0.5);
  });

  it('reports insufficient_range when reps are tiny, and allows manual override', () => {
    const cal = new RomCalibrator('knee_extension');
    for (const { t, amount } of repSequence({ reps: 3, amplitude: 0.12 })) {
      cal.push(extractFeature('knee_extension', seatedPose({ kneeExtension: amount }), 'left'), t);
    }
    expect(cal.getPhase()).toBe('done');
    expect(cal.getError()).toBe('insufficient_range');
    expect(cal.getResult()).toBeNull();
    const st = cal.getStatus();
    expect(st.message).toMatch(/bigger movement|adjust/i);
    expect(st.repsDetected).toBeGreaterThanOrEqual(1);
    // therapist nudges max up until the range is acceptable
    const prov = cal.getProvisional()!;
    cal.setRange(null, prov.min + 40);
    expect(cal.getError()).toBeNull();
    expect(cal.getResult()!.max).toBeCloseTo(prov.min + 40);
    cal.nudge(0, -35);
    expect(cal.getError()).toBe('insufficient_range');
    cal.nudge(-5, 0);
    expect(cal.getError()).toBe('insufficient_range');
    cal.nudge(-10, 0);
    expect(cal.getError()).toBeNull();
  });

  it('ignores null samples, reports rest progress and supports manual beginMove/finish', () => {
    const cal = new RomCalibrator('hand_open_close', { autoAdvance: false });
    expect(cal.restProgress()).toBe(0);
    for (let i = 0; i < 90; i++) cal.push(i % 3 === 0 ? null : 1.0 + (i % 2) * 0.01, i / 30);
    expect(cal.restProgress()).toBe(1);
    expect(cal.getPhase()).toBe('rest');
    expect(cal.beginMove()).toBe(true);
    expect(cal.getPhase()).toBe('move');
    expect(cal.getStatus().min).toBeCloseTo(1.005, 2);
    // One rep that never comes back down, then therapist presses done.
    for (let i = 0; i < 30; i++) cal.push(1.0 + (i / 30) * 0.6, 3 + i / 30);
    cal.finish();
    expect(cal.getPhase()).toBe('done');
    expect(cal.getResult()!.max).toBeCloseTo(1.58, 2);
  });

  it('errors with no_reps when nothing happens in the move phase, and can retry', () => {
    const cal = new RomCalibrator('finger_spread', { moveTimeoutSec: 5 });
    for (let t = 0; t < 8; t += 1 / 30) cal.push(30, t);
    expect(cal.getPhase()).toBe('done');
    expect(cal.getError()).toBe('no_reps');
    cal.retryMove();
    expect(cal.getPhase()).toBe('move');
    expect(cal.getError()).toBeNull();
    cal.reset();
    expect(cal.getPhase()).toBe('rest');
    expect(cal.restProgress()).toBe(0);
  });
});
