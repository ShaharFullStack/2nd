/**
 * THE DENOMINATOR'S PROVENANCE LEAVES THE DEVICE WITH THE NUMBERS.
 *
 * The exported record is read with no app around it — pasted into notes, printed, filed. Every "range
 * worked: 62 %" in it is a percentage of the range calibrated that day, so the file has to be able to
 * say whether that range came off a clean stream and three agreeing reps or off an 11 fps one and
 * three that did not. And a range with no such block has to read as NOT RECORDED, never as clean.
 */
import { describe, expect, it } from 'vitest';
import { buildPatientExport } from './results.ts';
import type { LaneResultSummary, Patient, SessionResult } from './types.ts';
import type { CalibrationMeasurement } from '../vision/calibration.ts';

const PATIENT: Patient = { id: 'p1', name: 'Export Patient', createdAt: 1_000, lastUsedAt: 1_000 };

function lane(patch: Partial<LaneResultSummary> = {}): LaneResultSummary {
  return {
    lane: 0, movement: 'knee_extension', side: 'left', movementName: 'Left Knee extension',
    hits: 8, perfects: 4, goods: 4, misses: 2, judged: 10, accuracy: 0.8, reps: 12,
    timingBiasMs: null, timingBiasMadMs: null,
    romMean: 0.62, romBest: 0.75, romSamples: 12, romUncertain: 0,
    calibratedMin: 20, calibratedMax: 70, calibrationManual: false,
    compensationKind: null, compensationMonitored: false, compensationFlags: 0, compensationWorst: null,
    ...patch,
  };
}

function session(lanes: LaneResultSummary[]): SessionResult {
  return {
    id: 's1', patientId: PATIENT.id, patientName: PATIENT.name, startedAt: 2_000_000, endedAt: 2_100_000,
    durationSec: 100, mode: 'leg', difficulty: 'medium', windowScale: 1, inputMode: 'camera',
    songId: 's', songTitle: 'Song', artist: 'A', attribution: '',
    score: 1, stars: 3, accuracy: 0.8, starAccuracy: 0.8, maxCombo: 1, totalNotes: 10,
    hits: 8, perfects: 4, goods: 4, misses: 2, reps: 12, answerRate: 1,
    timingBiasMs: null, timingBiasMadMs: null, latencyOffsetMs: 120, suggestedLatencyMs: null,
    completed: true, lanes,
  };
}

const RAGGED: CalibrationMeasurement = {
  method: 'rom_screen',
  frames: 140, tracked: 87, trackedFraction: 0.62, fpsMedian: 11, fpsLow: 8,
  durationSec: 9, reps: 3, repSpread: 22, repSpreadFraction: 0.44,
};

/** The same range, learned while the patient was chasing notes on a perfectly healthy stream. */
const IN_SONG: CalibrationMeasurement = {
  method: 'in_song',
  frames: 900, tracked: 890, trackedFraction: 0.989, fpsMedian: 30, fpsLow: 28,
  durationSec: 30, reps: 5, repSpread: 3, repSpreadFraction: 0.06,
};

describe('the exported record states how the calibrated range was measured', () => {
  it('names the conditions and the grade beside the range the percentages are out of', () => {
    const out = buildPatientExport({
      patient: PATIENT,
      sessions: [session([lane({ calibrationMeasurement: RAGGED })])],
      now: () => 3_000_000,
    });
    expect(out.text).toContain('that range was measured on the calibration screen, at 11 fps');
    expect(out.text).toContain('62 %');
    expect(out.text).toContain('3 reps within 44 % of the range');
    expect(out.text).toContain('(poor)');
  });

  it('says "not recorded" for a hand-set range rather than leaving the reader to assume', () => {
    const out = buildPatientExport({
      patient: PATIENT,
      sessions: [session([lane({ calibrationManual: true, calibrationMeasurement: null })])],
      now: () => 3_000_000,
    });
    expect(out.text).toContain('how well that range was measured was not recorded');
    expect(out.text).not.toMatch(/that range was measured on/);
  });

  /**
   * A RANGE LEARNED INSIDE THE MUSIC MAY NOT READ LIKE ONE MEASURED ON THE CALIBRATION SCREEN.
   *
   * This is the failure the in-song path could most easily cause: a clean 30 fps stream and five
   * agreeing reps would grade 'good' on every camera test there is, and the file would then present
   * a range gathered while the patient was chasing notes as a deliberate measurement. The method is
   * the thing that has to be in the file, and the grade has to be capped by it.
   */
  it('names an in-song range as one, and never grades it better than fair however clean the stream was', () => {
    const out = buildPatientExport({
      patient: PATIENT,
      sessions: [session([lane({ calibrationMeasurement: IN_SONG })])],
      now: () => 3_000_000,
    });
    expect(out.text).toContain('that range was learned during the song, at 30 fps');
    expect(out.text).toContain('(fair)');
    expect(out.text).not.toContain('(good)');
    expect(out.text).not.toContain('measured on the calibration screen');
  });

  it('states on the session line where the whole visit got its ranges from', () => {
    const inSong = { ...session([lane({ calibrationMeasurement: IN_SONG })]), calibrationMode: 'in_song' as const };
    const measured = { ...session([lane({ calibrationMeasurement: RAGGED })]), id: 's2', calibrationMode: 'measured' as const };
    const legacy = session([lane({ calibrationMeasurement: RAGGED })]);
    const out = buildPatientExport({ patient: PATIENT, sessions: [inSong, measured, legacy], now: () => 3_000_000 });
    expect(out.text).toContain('Range of motion: learned inside the song');
    expect(out.text).toContain('Range of motion: measured before the song on the range-of-motion screens');
    // A record written before the choice existed says so, rather than being given the new default.
    expect(out.text).toContain('not recorded on this session');
    const parsed = JSON.parse(out.json) as { fields: Record<string, string> };
    expect(parsed.fields['lanes[].calibrationMeasurement.method']).toMatch(/NOT LIKE-FOR-LIKE/);
    expect(parsed.fields.calibrationMode).toMatch(/learned from the patient/);
  });

  it('carries the block into the JSON archive, with a legend that explains which way it biases', () => {
    const out = buildPatientExport({
      patient: PATIENT,
      sessions: [session([lane({ calibrationMeasurement: RAGGED })])],
      now: () => 3_000_000,
    });
    const parsed = JSON.parse(out.json) as {
      fields: Record<string, string>;
      sessions: { lanes: { calibrationMeasurement: CalibrationMeasurement | null }[] }[];
    };
    expect(parsed.sessions[0].lanes[0].calibrationMeasurement).toEqual(RAGGED);
    const legend = parsed.fields['lanes[].calibrationMeasurement'];
    expect(legend).toMatch(/BIASES IT DOWNWARD/);
    expect(legend).toMatch(/Null = not recorded/);
  });
});
