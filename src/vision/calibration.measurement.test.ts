/**
 * THE DENOMINATOR CARRIES HOW WELL IT WAS MEASURED.
 *
 * `min`/`max` is the scale every ROM percentage, export and trend line for this movement is taken
 * against. Two calibrations that produce the same two numbers — one from a clean 30 fps stream with
 * three tight reps, one from an 11 fps stream that lost the limb for a third of the hold and whose
 * reps disagreed by half the range — used to be indistinguishable in the record. These tests pin the
 * block that tells them apart, including the two ways it could quietly start lying: frames with no
 * landmarks going uncounted, and a therapist nudge moving the range out from under the rep spread.
 */
import { describe, expect, it } from 'vitest';
import { RomCalibrator, applyRomNudge, measurementForRange } from './calibration.ts';
import type { CalibrationMeasurement } from './calibration.ts';

/**
 * Drive a calibrator through a rest hold and `peaks.length` reps at a chosen frame rate, optionally
 * dropping every `dropEvery`-th frame's landmarks (feature = null), the way a real stream does.
 */
function runCalibration(opts: {
  fps: number;
  peaks: number[];
  rest?: number;
  restSec?: number;
  dropEvery?: number;
  minRom?: number;
}): RomCalibrator {
  const { fps, peaks, rest = 20, restSec = 2.5, dropEvery = 0 } = opts;
  const cal = new RomCalibrator('knee_extension', { minRom: opts.minRom ?? 10, now: () => 1000 });
  const dt = 1 / fps;
  let t = 0;
  let n = 0;
  const push = (v: number) => {
    n++;
    cal.push(dropEvery > 0 && n % dropEvery === 0 ? null : v, t);
    t += dt;
  };
  // Rest: dead still, so the window is accepted rather than timing out.
  for (let i = 0; i < Math.ceil(restSec * fps); i++) push(rest);
  // Reps: rest → peak → rest, sampled at the same rate.
  for (const peak of peaks) {
    for (let i = 1; i <= 6; i++) push(rest + ((peak - rest) * i) / 6);
    for (let i = 5; i >= 0; i--) push(rest + ((peak - rest) * i) / 6);
  }
  cal.finish();
  return cal;
}

function measurementOf(cal: RomCalibrator): CalibrationMeasurement {
  const result = cal.getResult() ?? cal.getProvisional();
  expect(result).not.toBeNull();
  const m = result!.measurement;
  expect(m, 'the calibration carries no measurement block').toBeTruthy();
  return m!;
}

describe('CalibrationMeasurement', () => {
  it('records the frame rate the peaks were actually sampled at', () => {
    const fast = measurementOf(runCalibration({ fps: 30, peaks: [60, 61, 62] }));
    const slow = measurementOf(runCalibration({ fps: 11, peaks: [60, 61, 62] }));
    expect(fast.fpsMedian).toBeGreaterThan(28);
    expect(fast.fpsMedian).toBeLessThan(32);
    expect(slow.fpsMedian).toBeGreaterThan(10);
    expect(slow.fpsMedian).toBeLessThan(12);
    // The two ranges are the same numbers; only the block tells them apart.
    expect(slow.fpsMedian).toBeLessThan(fast.fpsMedian);
  });

  it('counts frames whose landmarks were unusable — they are "not measured", not "no movement"', () => {
    const clean = measurementOf(runCalibration({ fps: 30, peaks: [60, 61, 62] }));
    expect(clean.trackedFraction).toBe(1);
    expect(clean.tracked).toBe(clean.frames);

    // Every third frame arrives with no usable landmarks.
    const lossy = measurementOf(runCalibration({ fps: 30, peaks: [60, 61, 62], dropEvery: 3 }));
    expect(lossy.frames).toBeGreaterThan(lossy.tracked);
    expect(lossy.trackedFraction).toBeGreaterThan(0.6);
    expect(lossy.trackedFraction).toBeLessThan(0.72);
  });

  it('records how far apart the reps the top was taken from were, in units and as a fraction of the range', () => {
    const tight = measurementOf(runCalibration({ fps: 30, peaks: [60, 61, 62] }));
    expect(tight.reps).toBe(3);
    expect(tight.repSpread).toBeCloseTo(2, 5);
    expect(tight.repSpreadFraction).toBeLessThan(0.1);

    const ragged = measurementOf(runCalibration({ fps: 30, peaks: [40, 52, 64] }));
    expect(ragged.reps).toBe(3);
    expect(ragged.repSpread).toBeCloseTo(24, 5);
    // 24 units of disagreement over a ~44-unit range: the top of it is an estimate.
    expect(ragged.repSpreadFraction).toBeGreaterThan(0.4);
  });

  it('a range typed in by hand carries NO measurement block — absent is not "good"', () => {
    const cal = new RomCalibrator('knee_extension', { minRom: 10, now: () => 1000 });
    cal.setManualRange(20, 70);
    const result = cal.getResult();
    expect(result).not.toBeNull();
    expect(result!.measurement).toBeNull();
  });

  it('a nudge re-expresses the rep spread against the range it just moved', () => {
    const cal = runCalibration({ fps: 30, peaks: [40, 52, 64] });
    const built = cal.getResult() ?? cal.getProvisional();
    expect(built).not.toBeNull();
    const before = built!.measurement!;
    const { calibration, preview } = applyRomNudge(built!, 'knee_extension', -0.2);
    expect(preview.disabled).toBe(false);
    const after = calibration.measurement!;
    // The FACTS about the measurement do not move…
    expect(after.frames).toBe(before.frames);
    expect(after.fpsMedian).toBe(before.fpsMedian);
    expect(after.repSpread).toBe(before.repSpread);
    // …but the fraction OF THE RANGE does, because the range is its denominator.
    expect(calibration.max).toBeLessThan(built!.max);
    expect(after.repSpreadFraction).toBeGreaterThan(before.repSpreadFraction);
    expect(after.repSpreadFraction).toBeCloseTo(after.repSpread / (calibration.max - calibration.min), 6);
  });

  it('measurementForRange changes only the fraction', () => {
    const m: CalibrationMeasurement = {
      frames: 100, tracked: 95, trackedFraction: 0.95, fpsMedian: 28, fpsLow: 22,
      durationSec: 4, reps: 3, repSpread: 5, repSpreadFraction: 0.1,
    };
    expect(measurementForRange(m, 0, 25)).toEqual({ ...m, repSpreadFraction: 0.2 });
    // A degenerate range reports 0 rather than dividing by nothing.
    expect(measurementForRange(m, 10, 10).repSpreadFraction).toBe(0);
  });

  it('a live calibrator reports the conditions before the range exists, so they can still be fixed', () => {
    const cal = new RomCalibrator('knee_extension', { minRom: 10, now: () => 1000 });
    expect(cal.getMeasurement()).toBeNull();
    for (let i = 0; i < 30; i++) cal.push(i % 4 === 0 ? null : 20, i / 15);
    const live = cal.getMeasurement();
    expect(live).not.toBeNull();
    expect(live!.frames).toBe(30);
    expect(live!.trackedFraction).toBeLessThan(1);
    expect(live!.fpsMedian).toBeCloseTo(15, 0);
  });

  it('frames that arrive after the range is settled do not change how it was measured', () => {
    const cal = runCalibration({ fps: 30, peaks: [60, 61, 62] });
    const before = measurementOf(cal);
    for (let i = 0; i < 200; i++) cal.push(null, 100 + i);
    expect(measurementOf(cal)).toEqual(before);
  });

  it('reset() clears the block with everything else', () => {
    const cal = runCalibration({ fps: 30, peaks: [60, 61, 62] });
    cal.reset();
    expect(cal.getMeasurement()).toBeNull();
  });
});
