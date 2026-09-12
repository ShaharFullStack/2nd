/**
 * GRADING THE DENOMINATOR — the same rule, in the same module, as grading a session.
 *
 * A therapist who has learnt what "good" means on a session record must be able to read it on a
 * calibration; these tests pin that the two verdicts share their thresholds, that "absent" never
 * reads as "good", and that the sentence beside a degraded range states WHICH WAY the error points
 * (a low frame rate misses peaks, so the range comes out too small and every later rep reads as a
 * larger percentage of it than it was).
 */
import { describe, expect, it } from 'vitest';
import {
  CALIBRATION_NOT_RECORDED,
  EXPECTED_CALIBRATION_REPS,
  GOOD_DETECT_FPS,
  calibrationConditions,
  calibrationGrade,
  calibrationMeasurementGrade,
  calibrationSentence,
} from './tracking.ts';
import type { CalibrationMeasurement } from '../vision/calibration.ts';

function m(patch: Partial<CalibrationMeasurement> = {}): CalibrationMeasurement {
  return {
    frames: 150, tracked: 149, trackedFraction: 0.99, fpsMedian: 30, fpsLow: 27,
    durationSec: 5, reps: 3, repSpread: 2, repSpreadFraction: 0.05,
    ...patch,
  };
}

describe('calibrationGrade', () => {
  it('a clean stream with three tight reps is good', () => {
    expect(calibrationGrade(m())).toBe('good');
  });

  it('below the app’s own usable frame rate it is poor, whatever the reps did', () => {
    expect(calibrationGrade(m({ fpsMedian: 11.8 }))).toBe('poor');
  });

  it('a coarse but usable frame rate is fair', () => {
    expect(calibrationGrade(m({ fpsMedian: GOOD_DETECT_FPS - 4 }))).toBe('fair');
  });

  it('landmarks missing for a fifth of the frames is poor; for a twentieth, fair', () => {
    expect(calibrationGrade(m({ trackedFraction: 0.75 }))).toBe('poor');
    expect(calibrationGrade(m({ trackedFraction: 0.9 }))).toBe('fair');
  });

  it('reps that disagree by half the range are poor — the top of it is a guess', () => {
    expect(calibrationGrade(m({ repSpreadFraction: 0.6 }))).toBe('poor');
    expect(calibrationGrade(m({ repSpreadFraction: 0.3 }))).toBe('fair');
  });

  it('a single rep is poor: a range with no repeat has no evidence it repeats', () => {
    expect(calibrationGrade(m({ reps: 1, repSpread: 0, repSpreadFraction: 0 }))).toBe('poor');
    expect(calibrationGrade(m({ reps: EXPECTED_CALIBRATION_REPS - 1 }))).toBe('fair');
  });

  it('a range with no measurement block grades null, NOT good', () => {
    expect(calibrationMeasurementGrade({ measurement: null })).toBeNull();
    expect(calibrationMeasurementGrade({})).toBeNull();
    expect(calibrationMeasurementGrade(null)).toBeNull();
    expect(calibrationMeasurementGrade({ measurement: m() })).toBe('good');
    expect(CALIBRATION_NOT_RECORDED).toMatch(/not recorded/i);
  });
});

describe('what the screens say about it', () => {
  it('states the conditions in one clause: rate, availability, reps', () => {
    const s = calibrationConditions(m({ fpsMedian: 29, fpsLow: 21, trackedFraction: 0.96, reps: 3, repSpreadFraction: 0.08 }));
    expect(s).toContain('29 fps');
    expect(s).toContain('dipping to 21');
    expect(s).toContain('96 %');
    expect(s).toContain('3 reps within 8 % of the range');
  });

  it('names a single rep as having nothing to compare against', () => {
    expect(calibrationConditions(m({ reps: 1 }))).toContain('no repeat to compare it with');
  });

  it('a good range gets conditions and no caveat', () => {
    const s = calibrationSentence(m());
    expect(s).toContain('30 fps');
    expect(s).not.toMatch(/re-run the calibration/);
  });

  it('a slow stream says WHICH WAY the error points', () => {
    const s = calibrationSentence(m({ fpsMedian: 11, fpsLow: 8 }));
    // The bias is downward on the range, which inflates every percentage measured against it.
    expect(s).toMatch(/too low/);
    expect(s).toMatch(/larger percentage/);
    expect(s).toMatch(/re-run the calibration/);
  });

  it('lost landmarks are reported as unmeasured, not as stillness', () => {
    const s = calibrationSentence(m({ trackedFraction: 0.6 }));
    expect(s).toContain('40 % of the frames had no usable landmarks');
    expect(s).toMatch(/not measured at all/);
  });

  it('ragged reps are reported as an estimate of the top', () => {
    const s = calibrationSentence(m({ repSpreadFraction: 0.45 }));
    expect(s).toContain('45 % of the range');
    expect(s).toMatch(/estimate/);
  });
});
