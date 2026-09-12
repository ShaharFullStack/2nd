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
  frames: 140, tracked: 87, trackedFraction: 0.62, fpsMedian: 11, fpsLow: 8,
  durationSec: 9, reps: 3, repSpread: 22, repSpreadFraction: 0.44,
};

describe('the exported record states how the calibrated range was measured', () => {
  it('names the conditions and the grade beside the range the percentages are out of', () => {
    const out = buildPatientExport({
      patient: PATIENT,
      sessions: [session([lane({ calibrationMeasurement: RAGGED })])],
      now: () => 3_000_000,
    });
    expect(out.text).toContain('that range was measured at 11 fps');
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
    expect(out.text).not.toMatch(/that range was measured at/);
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
