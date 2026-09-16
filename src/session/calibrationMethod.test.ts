/**
 * A RANGE LEARNED INSIDE THE MUSIC IS MARKED AS ONE, EVERYWHERE IT SURFACES.
 *
 * `romMean` and `romBest` are percentages OF a range, and a range gathered while the patient was
 * chasing notes is not the same measurement as one taken from a rest hold and three maximum-effort
 * repetitions. This file is the proof that the distinction survives the whole journey the number
 * takes — the grade, the sentence beside it, the point on the trend, and above all the place where
 * one session is subtracted from another.
 *
 * It follows the discipline `compareTracking` established for the camera one level up, and uses the
 * same vocabulary; see session/tracking.ts.
 */
import { describe, expect, it } from 'vitest';
import type { CalibrationMeasurement } from '../vision/calibration.ts';
import { movementTrends } from './trends.ts';
import {
  calibrationGrade,
  calibrationMethodLabel,
  calibrationProvenance,
  calibrationSentence,
  compareCalibration,
  compareTracking,
  sessionCalibrationMeasurement,
  worstComparison,
} from './tracking.ts';
import type { LaneResultSummary, SessionResult, TrackingQuality } from './types.ts';

/** A measurement block that would grade 'good' on every camera test there is. */
const CLEAN = {
  frames: 900, tracked: 895, trackedFraction: 0.994, fpsMedian: 30, fpsLow: 28,
  durationSec: 30, reps: 4, repSpread: 2, repSpreadFraction: 0.05,
} satisfies Omit<CalibrationMeasurement, 'method'>;

const MEASURED: CalibrationMeasurement = { ...CLEAN, method: 'rom_screen' };
const IN_SONG: CalibrationMeasurement = { ...CLEAN, method: 'in_song' };
const LEGACY: CalibrationMeasurement = { ...CLEAN };

const GOOD_TRACKING: TrackingQuality = {
  samples: 200, fpsMedian: 30, fpsLow: 28, inferenceMsMedian: 12,
  trackedFraction: 0.99, lowFpsFraction: 0, delegate: 'GPU', worstReason: null,
};

function lane(patch: Partial<LaneResultSummary> = {}): LaneResultSummary {
  return {
    lane: 0, movement: 'knee_extension', side: 'left', movementName: 'Left Knee extension',
    hits: 8, perfects: 4, goods: 4, misses: 2, judged: 10, accuracy: 0.8, reps: 12,
    timingBiasMs: null, timingBiasMadMs: null,
    romMean: 0.6, romBest: 0.7, romSamples: 12, romUncertain: 0,
    calibratedMin: 20, calibratedMax: 70, calibrationManual: false,
    compensationKind: null, compensationMonitored: false, compensationFlags: 0, compensationWorst: null,
    ...patch,
  };
}

function session(id: string, at: number, m: CalibrationMeasurement | null): SessionResult {
  return {
    id, patientId: 'p1', patientName: 'P', startedAt: at, endedAt: at + 1000,
    durationSec: 100, mode: 'leg', difficulty: 'medium', windowScale: 1, inputMode: 'camera',
    songId: 's', songTitle: 'Song', artist: '', attribution: '',
    score: 1, stars: 3, accuracy: 0.8, starAccuracy: 0.8, maxCombo: 1, totalNotes: 10,
    hits: 8, perfects: 4, goods: 4, misses: 2, reps: 12, answerRate: 1,
    timingBiasMs: null, timingBiasMadMs: null, latencyOffsetMs: 120, suggestedLatencyMs: null,
    completed: true, tracking: GOOD_TRACKING,
    lanes: [lane({ calibrationMeasurement: m })],
  };
}

describe('the grade knows the difference', () => {
  it('never calls an in-song range good, however clean the stream and however many reps', () => {
    expect(calibrationGrade(MEASURED)).toBe('good');
    expect(calibrationGrade(IN_SONG)).toBe('fair');
  });

  it('still calls a genuinely bad in-song range poor — the cap is a ceiling, not a floor', () => {
    expect(calibrationGrade({ ...IN_SONG, reps: 1 })).toBe('poor');
  });

  it('names the method in the sentence and in the file line, and never guesses at an absent one', () => {
    expect(calibrationMethodLabel('in_song')).toBe('learned during the song');
    expect(calibrationMethodLabel('rom_screen')).toBe('measured on the calibration screen');
    expect(calibrationMethodLabel(null)).toBe('not recorded');
    expect(calibrationProvenance(IN_SONG)).toMatch(/^learned during the song, at /);
    expect(calibrationSentence(IN_SONG)).toMatch(/while the song was playing/);
    // …and says nothing of the sort about a range that was measured properly.
    expect(calibrationSentence(MEASURED)).not.toMatch(/while the song was playing/);
  });
});

describe('a trend cannot silently mix an in-song range with a deliberately measured one', () => {
  const labels = { from: 'the earlier session', to: 'the later one' };

  it('qualifies a comparison whose two ends were arrived at differently', () => {
    const v = compareCalibration(MEASURED, IN_SONG, labels);
    expect(v.kind).toBe('uneven');
    expect(v.tag).toBe('ranges measured differently');
    expect(v.note).toMatch(/may be the method rather than the patient/);
  });

  it('qualifies it in the other direction too', () => {
    expect(compareCalibration(IN_SONG, MEASURED, labels).kind).toBe('uneven');
  });

  it('qualifies two in-song ends as well — both denominators depend on the day', () => {
    const v = compareCalibration(IN_SONG, IN_SONG, labels);
    expect(v.kind).toBe('uneven');
    expect(v.tag).toBe('ranges learned in song');
  });

  it('says nothing about two deliberately measured ends', () => {
    expect(compareCalibration(MEASURED, MEASURED, labels)).toMatchObject({ kind: 'like-for-like', tag: null });
  });

  /**
   * A measurement block written before the method existed came from the ONE way this app then had of
   * producing a range: the calibration screen. So it is not an unknown method, and saying so would
   * put a qualifier on every historical comparison for no new reason. What it is NOT allowed to do is
   * let an in-song range through beside it — and it does not.
   */
  it('reads a block with no method as the calibration screen, because that is what it was', () => {
    expect(compareCalibration(LEGACY, MEASURED, labels).kind).toBe('like-for-like');
    expect(compareCalibration(LEGACY, IN_SONG, labels).kind).toBe('uneven');
  });

  it('takes the WORSE of the camera verdict and the range verdict, never the flattering one', () => {
    const cam = compareTracking(GOOD_TRACKING, GOOD_TRACKING, labels);
    expect(cam.kind).toBe('like-for-like');
    expect(worstComparison(cam, compareCalibration(MEASURED, IN_SONG, labels)).kind).toBe('uneven');
    expect(worstComparison(cam, compareCalibration(MEASURED, MEASURED, labels)).kind).toBe('like-for-like');
    // Nothing checked at all is not a pass.
    expect(worstComparison().kind).toBe('unrecorded');
  });

  it('lets one in-song lane speak for a whole session rather than picking the flattering lane', () => {
    const mixed = session('s', 1, MEASURED);
    mixed.lanes = [lane({ calibrationMeasurement: MEASURED }), lane({ lane: 1, calibrationMeasurement: IN_SONG })];
    expect(sessionCalibrationMeasurement(mixed)?.method).toBe('in_song');
    // And a session with one lane that records nothing records nothing as a whole.
    const partial = session('s', 1, MEASURED);
    partial.lanes = [lane({ calibrationMeasurement: MEASURED }), lane({ lane: 1, calibrationMeasurement: null })];
    expect(sessionCalibrationMeasurement(partial)).toBeNull();
  });
});

describe('the trend carries the method on the point, not only in a footnote', () => {
  it('puts the method and the range grade on every plotted point', () => {
    const history = [session('s2', 2_000_000, IN_SONG), session('s1', 1_000_000, MEASURED)];
    const [trend] = movementTrends(history, 'p1');
    expect(trend.points.map((p) => p.calibrationMethod)).toEqual(['rom_screen', 'in_song']);
    expect(trend.points.map((p) => p.calibrationGrade)).toEqual(['good', 'fair']);
  });

  it('reports a range with no measurement block as not recorded, never as measured', () => {
    const [trend] = movementTrends([session('s1', 1_000_000, null)], 'p1');
    expect(trend.points[0].calibrationMethod).toBeNull();
    expect(trend.points[0].calibrationGrade).toBeNull();
    expect(trend.points[0].calibrationMeasurement).toBeNull();
  });
});
