/**
 * WHOSE BODY WAS THIS RANGE MEASURED ON?
 *
 * `calibrationMismatch` already refused a range measured for another movement, on another fingertip or
 * under the other mirror convention — every dimension of WHAT was measured. It never asked WHOSE, so
 * "Reuse last session's range" could hand patient B patient A's knee: the numbers are plausible, the
 * lane plays, and every ROM percentage in B's record is a fraction of A's range.
 */
import { describe, expect, it } from 'vitest';
import {
  RomCalibrator,
  calibrationMismatch,
  calibrationWarnings,
  isCalibrationValid,
  patientMismatch,
  withPatient,
} from './calibration.ts';
import type { RomCalibration } from './calibration.ts';

const RANGE: RomCalibration = { min: 20, max: 80, samples: 90, movement: 'knee_extension', patient: 'patient-a' };

describe('a range measured on another patient', () => {
  it('is refused, with an action, not merely warned about', () => {
    const mismatch = calibrationMismatch(RANGE, 'knee_extension', { patient: 'patient-b' });
    expect(mismatch?.field).toBe('patient');
    expect(mismatch?.reason).toMatch(/measured on a different patient/i);
    expect(mismatch?.reason).toMatch(/re-calibrate this lane/i);
  });

  it('fails the validity check every scoring consumer runs', () => {
    expect(isCalibrationValid(RANGE, 'knee_extension', { patient: 'patient-b' })).toBe(false);
    expect(isCalibrationValid(RANGE, 'knee_extension', { patient: 'patient-a' })).toBe(true);
  });

  it('is reported BEFORE any other mismatch — whose body it was is the first question', () => {
    const wrongEverything: RomCalibration = { ...RANGE, movement: 'seated_march' };
    expect(calibrationMismatch(wrongEverything, 'knee_extension', { patient: 'patient-b' })?.field).toBe('patient');
  });
});

describe('a range measured on the same patient', () => {
  it('passes, and says nothing', () => {
    expect(calibrationMismatch(RANGE, 'knee_extension', { patient: 'patient-a' })).toBeNull();
    expect(patientMismatch(RANGE, { patient: 'patient-a' })).toBeNull();
  });
});

describe('a range with no patient recorded', () => {
  const legacy: RomCalibration = { min: 20, max: 80, samples: 90, movement: 'knee_extension' };

  it('cannot be refused — there is nothing to compare — but is never silently trusted', () => {
    expect(calibrationMismatch(legacy, 'knee_extension', { patient: 'patient-b' })).toBeNull();
    expect(calibrationWarnings(legacy, 'knee_extension', Date.now(), { patient: 'patient-b' }).join(' ')).toMatch(
      /does not record which patient/i,
    );
  });

  it('says nothing at all when the caller did not name a patient either', () => {
    expect(calibrationWarnings(legacy, 'knee_extension', Date.now()).join(' ')).not.toMatch(/patient/i);
  });
});

describe('the context a lane is measured in', () => {
  it('gains the patient through one function, never a hand-built literal', () => {
    expect(withPatient({ fingertip: 'pinky', mirrored: true }, 'p1')).toEqual({
      fingertip: 'pinky',
      mirrored: true,
      patient: 'p1',
    });
    // No patient selected: the field is ABSENT, which is what "the caller did not say" has to look
    // like — an empty string would compare unequal to every stored id and refuse every range.
    expect(withPatient({ mirrored: false }, null)).toEqual({ mirrored: false });
  });
});

describe('the calibrator stamps who it measured', () => {
  it('carries the patient onto the range it produces, so a later session can check it', () => {
    const cal = new RomCalibrator('seated_march', {
      patient: 'patient-a',
      restDurationSec: 0.2,
      minRestSamples: 5,
      reps: 1,
      prominence: 0.06,
    });
    for (let i = 0; i < 12; i++) cal.push(0, i / 30);
    cal.beginMove();
    for (const [i, v] of [0, 0.2, 0.4, 0.2, 0].entries()) cal.push(v, 1 + i / 30);
    cal.finish();
    const result = cal.getResult();
    expect(result?.patient).toBe('patient-a');
    expect(calibrationMismatch(result, 'seated_march', { patient: 'patient-b' })?.field).toBe('patient');
  });
});
