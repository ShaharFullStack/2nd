import { describe, expect, it } from 'vitest';
import type { Movement, Side } from '../engine/types.ts';
import { RomCalibrator, normalizeFeature, percentile, isCalibrationValid } from './calibration.ts';
import { captureCompensationBaseline, extractFeature } from './features.ts';
import { handPose, repSequence, seatedPose, seatedRest } from './fixtures.ts';
import type { Landmark } from './landmarks.ts';
import { LanePipeline } from './pipeline.ts';
import { LaneTrigger } from './trigger.ts';

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

describe('RomCalibrator guards (sample count, stillness, compensation baseline)', () => {
  it('does not leave rest on wall time alone: needs minRestSamples', () => {
    const cal = new RomCalibrator('seated_march', { minRestSamples: 30 });
    // 5 tracked frames spread over 3 s (tracking mostly lost): still resting.
    for (let i = 0; i < 5; i++) cal.push(0.1, i * 0.75);
    expect(cal.getPhase()).toBe('rest');
    expect(cal.restProgress()).toBeLessThan(0.2);
    // 30 frames within the next second: window full (time + count), still => advance.
    for (let i = 0; i < 30; i++) cal.push(0.1 + (i % 2) * 0.001, 4 + i / 30);
    expect(cal.getPhase()).toBe('move');
    expect(cal.getStatus().min).toBeCloseTo(0.1, 2);
  });

  it('waits for the patient to be still (window slides), then gives up after restTimeoutSec', () => {
    const fidgety = new RomCalibrator('knee_extension', { restTimeoutSec: 6 });
    let t = 0;
    // Large swings (40° >> minRom*0.75) for 4 s: never still.
    for (; t < 4; t += 1 / 30) fidgety.push(90 + 40 * Math.sin(t * 6), t);
    expect(fidgety.getPhase()).toBe('rest');
    expect(fidgety.isRestStill()).toBe(false);
    expect(fidgety.restProgress()).toBe(1);
    expect(fidgety.getStatus().message).toMatch(/hold still/i);
    // Settles: the trailing 2 s window becomes still => advance with min from the still window only.
    for (; t < 6.5; t += 1 / 30) fidgety.push(92 + (t % 0.1), t);
    expect(fidgety.getPhase()).toBe('move');
    expect(fidgety.getStatus().min).toBeCloseTo(92.05, 0);

    const never = new RomCalibrator('knee_extension', { restTimeoutSec: 5 });
    for (let s = 0; s < 5.5; s += 1 / 30) never.push(90 + 40 * Math.sin(s * 6), s);
    expect(never.getPhase()).toBe('move'); // timed out, best effort
  });

  it('accumulates the rest-phase compensation baseline as a median', () => {
    const cal = new RomCalibrator('ankle_dorsiflexion');
    for (let i = 0; i < 75; i++) {
      const heel = i === 40 ? 0.3 : 0.9 + (i % 3) * 0.001; // one wild frame
      cal.pushSample({ smoothed: 88, t: i / 30, compensationSample: { kind: 'heel_lift', value: heel, scale: 0.25 } });
    }
    expect(cal.getPhase()).toBe('move');
    const base = cal.getCompensationBaseline()!;
    expect(base.kind).toBe('heel_lift');
    expect(base.value).toBeCloseTo(0.901, 3);
    expect(base.scale).toBeCloseTo(0.25, 9);
    expect(base.samples).toBeGreaterThanOrEqual(30);
    for (let i = 0; i < 200; i++) cal.push(88 + 30 * Math.max(0, Math.sin(i / 10)), 3 + i / 30);
    expect(cal.getPhase()).toBe('done');
    expect(cal.getResult()!.compensationBaseline).toEqual(base);
  });
});

describe('calibration -> play consistency through the shared LanePipeline', () => {
  const HARD_THRESHOLD = 0.8;

  function calibrateThrough(pipeline: LanePipeline, gen: (a: number) => Landmark[], repDurationSec: number) {
    const cal = new RomCalibrator(pipeline.movement);
    for (const { t, amount } of repSequence({ restSec: 2.5, reps: 3, repDurationSec, amplitude: 1 })) {
      cal.pushSample(pipeline.push(gen(amount), t));
    }
    expect(cal.getPhase()).toBe('done');
    expect(cal.getError()).toBeNull();
    return cal.getResult()!;
  }

  const cases: Array<[Movement, Side, (a: number) => Landmark[]]> = [
    ['seated_march', 'left', (a) => seatedPose({ kneeLift: a })],
    ['knee_extension', 'left', (a) => seatedPose({ kneeExtension: a })],
    ['ankle_dorsiflexion', 'right', (a) => seatedPose({ toeLift: a, side: 'right' })],
    ['hip_abduction', 'left', (a) => seatedPose({ abduction: a })],
    ['hand_open_close', 'left', (a) => handPose({ openness: a })],
    ['wrist_extension', 'left', (a) => handPose({ wristExtension: a })],
    ['finger_opposition', 'right', (a) => handPose({ pinch: a })],
    ['finger_spread', 'left', (a) => handPose({ spread: a })],
  ];

  for (const [movement, side, gen] of cases) {
    it(`${movement}: hard threshold (0.8 of ROM) is reachable at tempo (0.5 s reps) after a slow-rep calibration`, () => {
      const pipeline = new LanePipeline({ movement, side });
      const cal = calibrateThrough(pipeline, gen, 1.5);
      pipeline.setCalibration(cal);
      let peak = 0;
      const trig = new LaneTrigger({ thresholdFraction: HARD_THRESHOLD });
      let hits = 0;
      for (const { t, amount } of repSequence({ restSec: 1, reps: 8, repDurationSec: 0.5, amplitude: 1 })) {
        const s = pipeline.push(gen(amount), 100 + t);
        peak = Math.max(peak, s.value);
        if (trig.push(s.value, 100 + t)) hits++;
      }
      expect(peak).toBeGreaterThan(0.9);
      expect(hits).toBe(8);
    });
  }

  it('filter delay is the same for every lane whatever the feature unit (degrees vs ratio)', () => {
    const lags: Record<string, number> = {};
    for (const [movement, side, gen] of cases) {
      const filtered = new LanePipeline({ movement, side });
      const raw = new LanePipeline({ movement, side, smoothing: { kind: 'none' } });
      const cal = calibrateThrough(filtered, gen, 1.5);
      filtered.setCalibration(cal);
      raw.setCalibration(cal);
      const tf = new LaneTrigger({ thresholdFraction: 0.65 });
      const tr = new LaneTrigger({ thresholdFraction: 0.65 });
      const lagSamples: number[] = [];
      let pendingRaw: number | null = null;
      for (const { t, amount } of repSequence({ restSec: 1, reps: 4, repDurationSec: 0.75, amplitude: 1 })) {
        const er = tr.push(raw.push(gen(amount), 50 + t).value, 50 + t);
        const ef = tf.push(filtered.push(gen(amount), 50 + t).value, 50 + t);
        if (er) pendingRaw = er.ctxTime;
        if (ef && pendingRaw !== null) {
          lagSamples.push(ef.ctxTime - pendingRaw);
          pendingRaw = null;
        }
      }
      expect(lagSamples).toHaveLength(4);
      lags[movement] = lagSamples.reduce((a, b) => a + b, 0) / lagSamples.length;
      expect(filtered.filterDelaySec(30)).toBeCloseTo(1 / 30, 9);
    }
    const values = Object.values(lags);
    const spreadMs = (Math.max(...values) - Math.min(...values)) * 1000;
    // Every lane lags the unfiltered signal by ~1 frame; spread across lanes far below the hard perfect window (50 ms).
    for (const v of values) {
      expect(v * 1000).toBeGreaterThan(0);
      expect(v * 1000).toBeLessThan(50);
    }
    expect(spreadMs).toBeLessThan(15);
  });

  it('a unit-dependent filter (OneEuro with beta) is not a LaneFilterSpec, and pipelines drop tracking cleanly', () => {
    const p = new LanePipeline({ movement: 'seated_march', side: 'left', calibration: { min: 0, max: 1, samples: 1 } });
    p.push(seatedPose({ kneeLift: 1 }), 0);
    p.push(seatedPose({ kneeLift: 1 }), 1 / 30);
    expect(p.last.value).toBeGreaterThan(0.5);
    const lost = p.push(null, 2 / 30);
    expect(lost.tracking).toBe(false);
    expect(lost.value).toBe(0);
    expect(lost.raw).toBeNull();
    p.reset();
    expect(Number.isNaN(p.last.t)).toBe(true);
    // Compensation flows through the pipeline once a baseline exists.
    const ankle = new LanePipeline({ movement: 'ankle_dorsiflexion', side: 'left', calibration: { min: 88, max: 128, samples: 1 } });
    expect(ankle.push(seatedPose({ toeLift: 1, heelLift: 1 }), 0).compensation).toBeNull();
    ankle.setCompensationBaseline(captureCompensationBaseline('ankle_dorsiflexion', seatedRest(), 'left'));
    expect(ankle.push(seatedPose({ toeLift: 1, heelLift: 1 }), 1 / 30).compensation?.flagged).toBe(true);
  });
});
