import { describe, expect, it } from 'vitest';
import type { Movement, Side } from '../engine/types.ts';
import {
  CALIBRATION_STALE_MS, MIN_ROM_SNR, RomCalibrator, applyRomNudge, calibrationProblem, calibrationWarnings,
  isCalibrationValid, normalizeFeature, percentile, previewRomNudge, requiredRom,
} from './calibration.ts';
import type { RomCalibration } from './calibration.ts';
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
    // prominence lowered so the peak detector sees the tiny reps at all; the RANGE is what is judged.
    const cal = new RomCalibrator('knee_extension', { prominence: 2 });
    for (const { t, amount } of repSequence({ reps: 3, amplitude: 0.05 })) {
      cal.push(extractFeature('knee_extension', seatedPose({ kneeExtension: amount }), 'left'), t);
    }
    expect(cal.getPhase()).toBe('done');
    expect(cal.getError()).toBe('insufficient_range');
    expect(cal.getResult()).toBeNull();
    const st = cal.getStatus();
    expect(st.message).toMatch(/bigger movement|adjust/i);
    expect(st.repsDetected).toBeGreaterThanOrEqual(1);
    // A clean, still rest window relaxes the absolute floor to half the nominal minRom - and no further.
    expect(cal.requiredRange()).toBeCloseTo(10, 6);
    // therapist nudges max up until the range is acceptable
    const prov = cal.getProvisional()!;
    cal.setRange(null, prov.min + 40);
    expect(cal.getError()).toBeNull();
    expect(cal.getResult()!.max).toBeCloseTo(prov.min + 40);
    cal.nudge(0, -33);
    expect(cal.getError()).toBe('insufficient_range');
    cal.nudge(-1, 0);
    expect(cal.getError()).toBe('insufficient_range');
    cal.nudge(-4, 0);
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

  it('a therapist override rescues a no_reps lane (not only insufficient_range)', () => {
    // The peak detector can miss a slow, smooth patient entirely. Before, only 'insufficient_range' was
    // clearable, so a lane the therapist measured by hand stayed unplayable forever.
    const cal = new RomCalibrator('finger_spread', { moveTimeoutSec: 5 });
    for (let t = 0; t < 8; t += 1 / 30) cal.push(30, t);
    expect(cal.getError()).toBe('no_reps');
    expect(cal.getResult()).toBeNull();
    const min = cal.getStatus().min!;
    expect(cal.getProvisional()).toBeNull(); // nothing moved at all: no range to offer yet
    cal.setRange(null, min + 25); // 25 deg > minRom 12
    expect(cal.getError()).toBeNull();
    const res = cal.getResult()!;
    expect(res.max - res.min).toBeCloseTo(25, 6);
    expect(res.manual).toBe(true);
    expect(cal.isManual()).toBe(true);
    expect(cal.getStatus().message).toMatch(/manually/i);
    // Still guarded: an override below the movement's minimum ROM is an error again.
    cal.nudge(0, -20);
    expect(cal.getError()).toBe('insufficient_range');
    expect(cal.getResult()).toBeNull();

    // When the patient DID move but no clean peak was found, the provisional range is the largest
    // feature seen, so the therapist screen starts from something real instead of nothing.
    const slow = new RomCalibrator('finger_spread', { moveTimeoutSec: 3, autoAdvance: false });
    for (let i = 0; i < 40; i++) slow.push(30, i / 30);
    slow.beginMove();
    for (let i = 0; i < 150; i++) slow.push(30 + i * 0.05, 2 + i / 30); // a slow ramp, never coming back
    expect(slow.getError()).toBe('no_reps');
    const prov = slow.getProvisional()!;
    expect(prov.manual).toBe(false);
    expect(prov.max).toBeGreaterThan(prov.min);
  });

  it('setManualRange finishes a calibration from any phase (full therapist override)', () => {
    const cal = new RomCalibrator('knee_extension');
    for (let i = 0; i < 20; i++) cal.push(90, i / 30); // still resting, nowhere near done
    expect(cal.getPhase()).toBe('rest');
    expect(cal.getResult()).toBeNull();
    cal.setManualRange(92, 150);
    expect(cal.getPhase()).toBe('done');
    expect(cal.getError()).toBeNull();
    expect(cal.getResult()).toMatchObject({ min: 92, max: 150, manual: true });
    expect(cal.normalize(121)).toBeCloseTo(0.5, 2);
    // A degenerate manual range is still refused.
    cal.setManualRange(92, 95);
    expect(cal.getError()).toBe('insufficient_range');
    expect(cal.getResult()).toBeNull();
    cal.reset();
    expect(cal.isManual()).toBe(false);
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

  it('takes the compensation baseline from the SAME rest window as min, even when comp is sparse', () => {
    // Patient fidgets for 5 s with the heel UP (comp 0.6), then holds still 5 s with the heel DOWN
    // (comp 0.9). The heel is the least reliably visible pose landmark, so measureCompensation returns a
    // sample on only 1 frame in 3 — the case that used to make the baseline span the fidgety period.
    const run = (compEveryNthFrame: number) => {
      const cal = new RomCalibrator('ankle_dorsiflexion');
      for (let i = 0; i < 300; i++) {
        const t = i / 30;
        const still = t >= 5;
        const smoothed = still ? 88 : 88 + 20 * Math.sin(t * 7);
        const sample: Parameters<typeof cal.pushSample>[0] = { smoothed, t };
        if (i % compEveryNthFrame === 0) sample.compensationSample = { kind: 'heel_lift', value: still ? 0.9 : 0.6, scale: 0.25 };
        cal.pushSample(sample);
        if (cal.getPhase() !== 'rest') break;
      }
      return cal;
    };
    for (const nth of [1, 3, 7]) {
      const cal = run(nth);
      expect(cal.getPhase(), `every ${nth} frames`).toBe('move');
      expect(cal.getStatus().min, `every ${nth} frames`).toBeCloseTo(88, 6);
      // The baseline describes the still (heel-down) window, not the fidgety one.
      expect(cal.getCompensationBaseline()!.value, `every ${nth} frames`).toBeCloseTo(0.9, 6);
      const w = cal.getRestWindow();
      expect(w.startSec).toBeGreaterThan(4.5);
      expect(w.compensationSamples).toBeGreaterThan(0);
      expect(w.compensationSamples).toBeLessThanOrEqual(w.samples);
    }
  });

  it('keeps the most recent compensation sample when every one predates the rest window', () => {
    const cal = new RomCalibrator('seated_march', { autoAdvance: false });
    for (let i = 0; i < 150; i++) {
      const t = i / 30;
      const sample: Parameters<typeof cal.pushSample>[0] = { smoothed: 0.1, t };
      if (i < 3) sample.compensationSample = { kind: 'trunk_lean', value: 4 + i, scale: 1 };
      cal.pushSample(sample);
    }
    expect(cal.getRestWindow().startSec).toBeGreaterThan(2); // the comp samples are long out of window
    expect(cal.beginMove()).toBe(true);
    // Only stale samples exist: the newest is kept as the best available estimate rather than dropped.
    expect(cal.getCompensationBaseline()!.value).toBe(6);
    expect(cal.getCompensationBaseline()!.samples).toBe(1);
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

describe('LanePipeline smoothing does not carry state across a blackout', () => {
  const cal = { min: 0, max: 0.28, samples: 1 };
  it('the first frame after a long gap reports where the patient IS, not a blend with the old limb position', () => {
    const p = new LanePipeline({ movement: 'seated_march', side: 'left', calibration: cal, maxGapSec: 0.5 });
    for (let i = 0; i < 10; i++) p.push(seatedPose({ kneeLift: 1 }), i / 30);
    const raised = p.last.value;
    expect(raised).toBeGreaterThan(0.9);
    // Camera wedges for 10 s; the patient lowers the leg meanwhile.
    const after = p.push(seatedPose({ kneeLift: 0 }), 10);
    expect(after.value).toBeLessThan(0.02);
    // Exactly the value an untouched pipeline reports for the same pose (i.e. no memory of the gap).
    const fresh = new LanePipeline({ movement: 'seated_march', side: 'left', calibration: cal });
    expect(after.value).toBeCloseTo(fresh.push(seatedPose({ kneeLift: 0 }), 0).value, 9);
  });

  it('still smooths across a normal frame interval and across a SHORT dropout', () => {
    const p = new LanePipeline({ movement: 'seated_march', side: 'left', calibration: cal, maxGapSec: 0.5 });
    for (let i = 0; i < 10; i++) p.push(seatedPose({ kneeLift: 1 }), i / 30);
    p.push(null, 10 / 30); // one dropped frame: the filter keeps its memory
    const next = p.push(seatedPose({ kneeLift: 0 }), 11 / 30);
    const unsmoothed = (lift: number) =>
      new LanePipeline({ movement: 'seated_march', side: 'left', calibration: cal }).push(seatedPose({ kneeLift: lift }), 0).smoothed!;
    // Still averaging with the raised leg (EMA alpha 0.5): between the two raw levels, not at either.
    expect(next.smoothed!).toBeGreaterThan(unsmoothed(0) + 0.05);
    expect(next.smoothed!).toBeLessThan(unsmoothed(1));
  });
});


describe('the rest window is MEASURED, not assumed (the zero every value is normalized from)', () => {
  /** Feed `sec` seconds of a rest baseline, then 3 clean reps of the given amplitude. */
  const run = (opts: { jitter?: (t: number) => number; restSec: number; peak: number; cal?: RomCalibrator }) => {
    const cal = opts.cal ?? new RomCalibrator('seated_march');
    const base = 0.5;
    const jitter = opts.jitter ?? (() => 0);
    let t = 0;
    for (; t < opts.restSec; t += 1 / 30) cal.push(base + jitter(t), t);
    for (let r = 0; r < 3 && cal.getPhase() === 'move'; r++) {
      for (let i = 0; i <= 30; i++, t += 1 / 30) cal.push(base + opts.peak * 0.5 * (1 - Math.cos((2 * Math.PI * i) / 30)), t);
    }
    return cal;
  };

  it('records restStill:false for a window that never settled, instead of claiming it was still', () => {
    // 11 s of rest oscillating +/-0.06 - half of seated_march's entire minimum ROM. The rest phase
    // auto-advances on restTimeoutSec; it used to report restStill:true afterwards and hand back a
    // calibration indistinguishable from a clean one.
    const cal = run({ jitter: (t) => 0.06 * Math.sin(t * 5), restSec: 11, peak: 0.9 });
    expect(cal.getPhase()).toBe('done');
    const st = cal.getStatus();
    expect(st.restStill).toBe(false);
    expect(st.rest!.still).toBe(false);
    expect(st.rest!.spread).toBeGreaterThan(0.05);
    expect(st.warnings!.join(' ')).toMatch(/never settled|resting position/i);
  });

  it('rejects a range that cannot be told apart from its own noisy zero, and says why', () => {
    const cal = run({ jitter: (t) => 0.06 * Math.sin(t * 5), restSec: 11, peak: 0.25 });
    const spread = cal.getRestQuality()!.spread;
    // The range (0.25, twice the nominal minRom) is wide in absolute terms but under MIN_ROM_SNR x
    // the rest noise its own zero is buried in.
    expect(cal.requiredRange()).toBeCloseTo(spread * MIN_ROM_SNR, 6);
    expect(cal.requiredRange()).toBeGreaterThan(0.12);
    expect(cal.getError()).toBe('insufficient_range');
    expect(cal.getResult()).toBeNull();
    // The guidance names the real cause: "move more" is the wrong instruction here.
    expect(cal.getStatus().message).toMatch(/resting position/i);
  });

  it('admits a clean SMALL range that the fixed absolute floor used to refuse', () => {
    // Hemiparetic patient: seated_march ROM 0.11 against the nominal 0.12 floor, rest rock steady.
    const cal = run({ restSec: 2.5, peak: 0.11, cal: new RomCalibrator('seated_march', { prominence: 0.02 }) });
    expect(cal.getPhase()).toBe('done');
    expect(cal.getRestQuality()!.still).toBe(true);
    expect(cal.requiredRange()).toBeCloseTo(0.06, 6); // half the nominal minRom, no lower
    const res = cal.getResult()!;
    expect(res.max - res.min).toBeGreaterThan(0.1);
    expect(res.max - res.min).toBeLessThan(0.12);
    expect(isCalibrationValid(res, 'seated_march')).toBe(true);
    expect(calibrationProblem(res, 'seated_march')).toBeNull();
  });

  it('carries the rest window, capture time and posture with the calibration', () => {
    const cal = run({ restSec: 2.5, peak: 0.9, cal: new RomCalibrator('seated_march', { now: () => 1_000_000, sessionId: 's-42' }) });
    const res = cal.getResult()!;
    expect(res.capturedAt).toBe(1_000_000);
    expect(res.posture).toBe('seated_leg');
    expect(res.sessionId).toBe('s-42');
    expect(res.rest).toMatchObject({ still: true, samples: expect.any(Number) });
    expect(res.movement).toBe('seated_march');
  });
});

describe('calibration provenance is checkable', () => {
  const base: RomCalibration = { min: 0, max: 0.5, samples: 100, movement: 'seated_march', posture: 'seated_leg' };

  it('refuses a range measured for a DIFFERENT movement (different unit entirely)', () => {
    const kneeDegrees: RomCalibration = { min: 100, max: 160, samples: 100, movement: 'knee_extension' };
    expect(isCalibrationValid(kneeDegrees, 'knee_extension')).toBe(true);
    expect(isCalibrationValid(kneeDegrees, 'seated_march')).toBe(false);
    expect(calibrationProblem(kneeDegrees, 'seated_march')).toMatch(/knee extension/i);
  });

  it('warns about a stale calibration instead of silently normalizing with it', () => {
    const now = 10 * CALIBRATION_STALE_MS;
    expect(calibrationWarnings({ ...base, capturedAt: now - 60_000 }, 'seated_march', now)).toEqual([]);
    const stale = calibrationWarnings({ ...base, capturedAt: now - 3 * CALIBRATION_STALE_MS }, 'seated_march', now);
    expect(stale.join(' ')).toMatch(/measured .* ago/i);
    // Still VALID (a therapist may reuse it deliberately) - the point is that it is visible.
    expect(isCalibrationValid({ ...base, capturedAt: now - 3 * CALIBRATION_STALE_MS }, 'seated_march')).toBe(true);
  });

  it('warns about an unsteady zero and a hand-set range', () => {
    const noisy = calibrationWarnings({ ...base, max: 1.5, rest: { still: false, spread: 0.09, drift: 0.01, durationSec: 10, samples: 300 } }, 'seated_march');
    expect(noisy.join(' ')).toMatch(/never steady|0% may sit inside/i);
    expect(calibrationWarnings({ ...base, manual: true }, 'seated_march').join(' ')).toMatch(/set by hand/i);
  });

  it('requiredRom is the absolute floor without a rest measurement (legacy calibrations unchanged)', () => {
    expect(requiredRom('seated_march')).toBe(0.12);
    expect(requiredRom('seated_march', { still: true, spread: 0, drift: 0, durationSec: 2, samples: 60 })).toBe(0.06);
    expect(requiredRom('seated_march', { still: false, spread: 0, drift: 0, durationSec: 2, samples: 60 })).toBe(0.12);
    expect(requiredRom('seated_march', { still: true, spread: 0.1, drift: 0, durationSec: 2, samples: 60 })).toBeCloseTo(0.3, 9);
  });
});

/**
 * A 'no_reps' failure has two completely different causes and only one used to be reported. The
 * therapist reads this message and acts on it, so it has to name the one that happened.
 */
describe('RomCalibrator no_reps guidance', () => {
  it('names the RANGE when the movement is real but smaller than a rep has to be', () => {
    // knee_extension: minRom 20 deg => prominence 10 deg. This patient has 8 deg of active range.
    const cal = new RomCalibrator('knee_extension', { moveTimeoutSec: 3, autoAdvance: false });
    for (let i = 0; i < 60; i++) cal.push(90, i / 30);
    cal.beginMove();
    let t = 2;
    for (let rep = 0; rep < 4; rep++) {
      for (let i = 0; i < 30; i++, t += 1 / 30) cal.push(90 + 8 * Math.sin((i / 30) * Math.PI), t);
    }
    for (let i = 0; i < 40; i++, t += 1 / 30) cal.push(90, t);
    expect(cal.getError()).toBe('no_reps');
    const msg = cal.getStatus().message;
    expect(msg).toMatch(/largest movement seen was/i);
    expect(msg).toMatch(/8\.0°/); // what they actually managed
    expect(msg).toMatch(/10\.0°/); // what a rep has to span
    expect(msg).not.toMatch(/whole limb is visible/i); // NOT a camera problem
    // …and the therapist has a real range to start from.
    expect(cal.getProvisional()!.max).toBeGreaterThan(cal.getProvisional()!.min);
  });

  it('names the RETURN when the limb rises far enough but never comes back down', () => {
    const cal = new RomCalibrator('knee_extension', { moveTimeoutSec: 3, autoAdvance: false });
    for (let i = 0; i < 60; i++) cal.push(90, i / 30);
    cal.beginMove();
    let t = 2;
    for (let i = 0; i < 150; i++, t += 1 / 30) cal.push(90 + i * 0.4, t); // a slow ramp, never returning
    expect(cal.getError()).toBe('no_reps');
    const msg = cal.getStatus().message;
    expect(msg).toMatch(/never returned toward the resting position/i);
    expect(msg).toMatch(/come back down by 10\.0°/);
  });

  it('still blames visibility when literally nothing moved', () => {
    const cal = new RomCalibrator('finger_spread', { moveTimeoutSec: 5 });
    for (let t = 0; t < 8; t += 1 / 30) cal.push(30, t);
    expect(cal.getError()).toBe('no_reps');
    expect(cal.getStatus().message).toMatch(/No movement was detected at all/i);
  });
});

describe('LanePipeline carries the measurement identity it was built with', () => {
  it('reports its mirror convention, fingertip and visibility gate', () => {
    const p = new LanePipeline({ movement: 'finger_opposition', side: 'left', featureOptions: { mirrored: true, fingertip: 'pinky', minVisibility: 0.8 } });
    expect(p.getMirrored()).toBe(true);
    expect(p.getFingertip()).toBe('pinky');
    expect(p.getMinVisibility()).toBe(0.8);
    expect(p.getFeatureOptions()).toMatchObject({ mirrored: true, fingertip: 'pinky', minVisibility: 0.8 });
    const q = new LanePipeline({ movement: 'seated_march', side: 'left' });
    expect(q.getMirrored()).toBe(false); // the default IS a convention, not "unset"
    expect(q.getFingertip()).toBe('index');
  });

  it('re-pointing at the other limb drops the filter state and the last sample', () => {
    const p = new LanePipeline({ movement: 'seated_march', side: 'left', calibration: { min: 0, max: 1, samples: 1 } });
    p.push(seatedPose({ kneeLift: 1, side: 'left' }), 0);
    expect(p.last.tracking).toBe(true);
    p.setMirrored(true); // now reading the RIGHT_* landmark slots: the old smoothed value described the other leg
    expect(p.getMirrored()).toBe(true);
    expect(p.last.tracking).toBe(false);
    expect(p.last.value).toBe(0);
  });

  it('knows whether its compensation is actually being measured', () => {
    const none = new LanePipeline({ movement: 'knee_extension', side: 'left' });
    expect(none.getCompensationKind()).toBeNull();
    expect(none.isCompensationMonitored()).toBe(false);
    const ankle = new LanePipeline({ movement: 'ankle_dorsiflexion', side: 'left' });
    expect(ankle.getCompensationKind()).toBe('heel_lift');
    expect(ankle.isCompensationMonitored()).toBe(false); // monitors one, has no baseline: NOT measured
    ankle.setCompensationBaseline(captureCompensationBaseline('ankle_dorsiflexion', seatedRest(), 'left'));
    expect(ankle.isCompensationMonitored()).toBe(true);
    // A calibration whose rest hold never saw the heel leaves the baseline null: still not measured.
    ankle.setCompensationBaseline(undefined);
    ankle.setCalibration({ min: 88, max: 128, samples: 1, movement: 'ankle_dorsiflexion', compensationBaseline: null });
    expect(ankle.isCompensationMonitored()).toBe(false);
  });
});

describe('finger_opposition calibrations carry the fingertip they were measured on', () => {
  it('warns when a lane opposes a non-default fingertip against a range that records none', () => {
    const legacy: RomCalibration = { min: 0, max: 1, samples: 1, movement: 'finger_opposition' };
    expect(calibrationWarnings(legacy, 'finger_opposition')).toEqual([]);
    expect(calibrationWarnings(legacy, 'finger_opposition', Date.now(), { fingertip: 'index' })).toEqual([]);
    const w = calibrationWarnings(legacy, 'finger_opposition', Date.now(), { fingertip: 'ring' });
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/ring/);
    // Recorded and matching: nothing to say.
    expect(calibrationWarnings({ ...legacy, fingertip: 'ring' }, 'finger_opposition', Date.now(), { fingertip: 'ring' })).toEqual([]);
  });
});

describe('the Easier / Harder nudge is proportional, bounded and self-describing', () => {
  /** A finished calibration: rest at `rest`, three reps peaking at `peak`. */
  const measured = (movement: Movement, rest: number, peak: number): RomCalibrator => {
    const cal = new RomCalibrator(movement, { autoAdvance: false });
    for (let i = 0; i < 90; i++) cal.push(rest + (i % 2) * 1e-3, i / 30);
    cal.beginMove();
    let t = 3;
    for (let rep = 0; rep < 3; rep++) {
      for (let i = 0; i <= 20; i++) cal.push(rest + (peak - rest) * Math.sin((i / 20) * Math.PI), t += 1 / 30);
    }
    cal.finish();
    return cal;
  };

  it('steps by a fraction of the MEASURED RANGE, so it means the same on degrees and on ratios', () => {
    // knee_extension is degrees: a 40 degree range steps by 2 degrees, not by the old 0.05 (invisible)
    const knee = measured('knee_extension', 90, 130);
    const kneeMax = knee.getResult()!.max;
    const easier = knee.previewNudgeTop(-0.05);
    expect(easier.delta).toBeCloseTo(-0.05 * (kneeMax - knee.getResult()!.min), 6);
    expect(Math.abs(easier.delta)).toBeGreaterThan(1); // degrees, and visible
    expect(easier.label).toMatch(/Easier — target \d+° → \d+° \(−5% of the measured range\)/);

    // finger_opposition is a ratio around 0.6: the old absolute 0.05 was an eighth of the range
    const pinch = measured('finger_opposition', 0.1, 0.7);
    const p = pinch.previewNudgeTop(-0.05);
    expect(Math.abs(p.delta)).toBeLessThan(0.05);
    expect(p.label).toMatch(/Easier — target 0\.\d\d → 0\.\d\d/);
  });

  it('never raises the target above what the patient actually reached', () => {
    const cal = measured('knee_extension', 90, 130);
    const best = cal.patientBest()!;
    for (let i = 0; i < 20; i++) cal.nudgeTop(0.05);
    expect(cal.getResult()!.max).toBeLessThanOrEqual(best + 1e-9);
    const at = cal.previewNudgeTop(0.05);
    expect(at.disabled).toBe(true);
    expect(at.limit).toBe('patient_best');
    expect(at.label).toMatch(/already at this patient's best/);
    expect(at.note).toMatch(/never been produced/);
    // and the raw nudge() the old buttons called is bounded upward too
    cal.nudge(0, 500);
    expect(cal.getResult()!.max).toBeLessThanOrEqual(best + 1e-9);
  });

  it('never lowers the target into a range that cannot be told from rest noise', () => {
    const cal = measured('knee_extension', 90, 130);
    const min = cal.getResult()!.min;
    for (let i = 0; i < 60; i++) cal.nudgeTop(-0.05);
    const res = cal.getResult();
    expect(res).not.toBeNull(); // still a usable calibration, not an error state
    expect(res!.max - min).toBeGreaterThanOrEqual(cal.requiredRange() - 1e-9);
    const at = cal.previewNudgeTop(-0.05);
    expect(at.disabled).toBe(true);
    expect(at.limit).toBe('minimum_range');
    expect(at.label).toMatch(/already at the smallest usable range/);
  });

  it('applies exactly what it previewed, and marks the range as therapist-adjusted', () => {
    const cal = measured('seated_march', 0.05, 0.6);
    const before = cal.getResult()!.max;
    const preview = cal.previewNudgeTop(-0.05);
    expect(cal.getResult()!.max).toBe(before); // a preview changes nothing
    const applied = cal.nudgeTop(-0.05);
    expect(applied.nextMax).toBe(preview.nextMax);
    expect(cal.getResult()!.max).toBeCloseTo(preview.nextMax, 12);
    expect(cal.isManual()).toBe(true);
  });

  /**
   * THE FORM THE SCREEN ACTUALLY CALLS. The buttons a therapist presses sit on the lane's ACCEPTED
   * range, which may have been reused from a previous session and have no live calibrator behind it
   * at all. Both forms must answer identically or the label and the press disagree.
   */
  it('answers the same on a stored range as on the calibrator that measured it', () => {
    const cal = measured('seated_march', 0.05, 0.6);
    const stored = cal.getResult()!;
    for (const f of [-0.05, 0.05]) {
      const fromClass = cal.previewNudgeTop(f);
      const fromStored = previewRomNudge(stored, 'seated_march', f);
      expect(fromStored.nextMax).toBeCloseTo(fromClass.nextMax, 12);
      expect(fromStored.label).toBe(fromClass.label);
      expect(fromStored.disabled).toBe(fromClass.disabled);
    }
    const { calibration, preview } = applyRomNudge(stored, 'seated_march', -0.05);
    expect(calibration.max).toBeCloseTo(preview.nextMax, 12);
    expect(calibration.manual).toBe(true);
    expect(stored.max).toBe(cal.getResult()!.max); // the input is never mutated
  });

  it('will not raise a target above a range with no reps on record behind it', () => {
    // A hand-built / legacy stored range: nothing says this patient ever reached anything above it.
    const handBuilt: RomCalibration = { min: 20, max: 60, samples: 0, movement: 'knee_extension', peaks: [] };
    const up = previewRomNudge(handBuilt, 'knee_extension', 0.05);
    expect(up.disabled).toBe(true);
    expect(up.label).toMatch(/no rep on record above 60°/);
    expect(up.note).toMatch(/Re-measure the lane to raise the target/);
    // Lowering is always available: it only ever asks for less than the patient has already done.
    const down = previewRomNudge(handBuilt, 'knee_extension', -0.05);
    expect(down.disabled).toBe(false);
    expect(down.nextMax).toBeCloseTo(58, 6);
  });

  it('steps by the same PROPORTION on a degree lane and a ratio lane, in each one’s own units', () => {
    // The defect this control had: one absolute 0.05 step meant 0.25 % of a knee-extension range and
    // ~16 % of a hemiparetic seated-march range, under one label that said "5 %".
    const knee: RomCalibration = { min: 20, max: 60, samples: 0, movement: 'knee_extension', peaks: [80] };
    const march: RomCalibration = { min: 0.08, max: 0.4, samples: 0, movement: 'seated_march', peaks: [0.5] };
    const k = previewRomNudge(knee, 'knee_extension', 0.05);
    const m = previewRomNudge(march, 'seated_march', 0.05);
    expect(k.delta).toBeCloseTo(0.05 * 40, 9); // 2°, not 0.05°
    expect(m.delta).toBeCloseTo(0.05 * 0.32, 9); // 0.016, not 0.05
    expect(k.delta / (knee.max - knee.min)).toBeCloseTo(m.delta / (march.max - march.min), 9);
    expect(k.label).toContain('°');
    expect(m.label).toContain('0.4');
  });

  /**
   * A BUTTON MUST NEVER SAY IT WILL TURN 0.33 INTO 0.33. formatFeature prints a ratio at two places
   * and a degree at none, so a small-but-real step ("+5 % of the measured range" on a range of 0.03,
   * or 0.4° on a knee) printed the same number twice and told the therapist nothing about the press
   * they had just made.
   */
  it('prints the target at a precision that shows the move, in both unit families', () => {
    const march: RomCalibration = { min: 0.30, max: 0.32, samples: 0, movement: 'seated_march', peaks: [0.5] };
    const m = previewRomNudge(march, 'seated_march', 0.05);
    expect(m.disabled).toBe(false);
    expect(m.nextMax).toBeCloseTo(0.321, 9);
    expect(m.label).toContain('0.320 → 0.321');
    const knee: RomCalibration = { min: 52, max: 60, samples: 0, movement: 'knee_extension', peaks: [90] };
    const k = previewRomNudge(knee, 'knee_extension', 0.05);
    expect(k.nextMax).toBeCloseTo(60.4, 9);
    expect(k.label).toContain('60.0° → 60.4°');
    // The ordinary case keeps the ordinary precision.
    const wide: RomCalibration = { min: 20, max: 60, samples: 0, movement: 'knee_extension', peaks: [90] };
    expect(previewRomNudge(wide, 'knee_extension', 0.05).label).toContain('60° → 62°');
  });

  it('refuses the press when the step is smaller than the measurement can express', () => {
    const tiny: RomCalibration = { min: 0.4000, max: 0.40002, samples: 0, movement: 'seated_march', peaks: [0.9] };
    const p = previewRomNudge(tiny, 'seated_march', 0.05);
    expect(p.disabled).toBe(true);
    expect(p.limit).toBe('below_precision');
    expect(p.label).toMatch(/smaller than this measurement can show/);
    expect(p.note).toMatch(/nothing to press/);
    // and nothing is applied through it
    expect(applyRomNudge(tiny, 'seated_march', 0.05).calibration.max).toBe(tiny.max);
  });

  /**
   * "EASIER" MUST NEVER MAKE IT HARDER. The minimum-usable-range floor stopped a range being shrunk
   * past noise — but on a lane whose range is ALREADY below that floor (the impaired lane this button
   * exists for) it moved the top UP: on a seated march measured 0.30–0.32 the button read
   * "Easier — target 0.32 → 0.42", a third more range than the patient has ever produced.
   */
  it('refuses to raise the target under the word Easier', () => {
    const tooSmall: RomCalibration = { min: 0.30, max: 0.32, samples: 0, movement: 'seated_march', peaks: [0.31, 0.32] };
    const down = previewRomNudge(tooSmall, 'seated_march', -0.05);
    expect(down.nextMax).toBeLessThanOrEqual(tooSmall.max);
    expect(down.delta).toBe(0);
    expect(down.disabled).toBe(true);
    expect(down.label).toMatch(/already smaller than a usable one/);
    expect(down.note).toMatch(/cannot be made smaller/);
    expect(applyRomNudge(tooSmall, 'seated_march', -0.05).calibration.max).toBe(tooSmall.max);
    // A range with room to give still gives it, and still stops at the floor.
    const roomy: RomCalibration = { min: 0.1, max: 0.9, samples: 0, movement: 'seated_march', peaks: [0.9] };
    const ok = previewRomNudge(roomy, 'seated_march', -0.05);
    expect(ok.disabled).toBe(false);
    expect(ok.nextMax).toBeCloseTo(0.9 - 0.05 * 0.8, 9);
  });

  it('says so instead of throwing when there is no range to nudge', () => {
    const fresh = new RomCalibrator('knee_extension');
    const p = fresh.previewNudgeTop(0.05);
    expect(p.disabled).toBe(true);
    expect(p.limit).toBe('no_range');
    expect(p.note).toMatch(/No range/);
    expect(fresh.nudgeTop(0.05).disabled).toBe(true);
    expect(fresh.previewNudgeTop(0).disabled).toBe(true);
  });
});
