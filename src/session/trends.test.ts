import { describe, expect, it } from 'vitest';
import { DEFAULT_TREND_WINDOW, movementTrends } from './trends.ts';
import type { LaneResultSummary, SessionResult } from './types.ts';

function lane(patch: Partial<LaneResultSummary> = {}): LaneResultSummary {
  return {
    lane: 0,
    movement: 'knee_extension',
    side: 'left',
    label: 'L knee extension',
    hits: 8, perfects: 4, goods: 4, misses: 2, judged: 10, accuracy: 0.8, reps: 12,
    timingBiasMs: null, timingBiasMadMs: null,
    romMean: 0.6, romBest: 0.75, romSamples: 12, romUncertain: 0,
    calibratedMin: 20, calibratedMax: 80, calibrationManual: false,
    compensationKind: null, compensationMonitored: false, compensationFlags: 0, compensationWorst: null,
    ...patch,
  };
}

/** Sessions are supplied NEWEST FIRST, exactly as the store keeps them. */
function session(id: string, at: number, lanes: LaneResultSummary[]): SessionResult {
  return {
    id, startedAt: at, endedAt: at + 1000, durationSec: 120,
    mode: 'leg', difficulty: 'medium', windowScale: 1, inputMode: 'camera',
    songId: 's', songTitle: 'S', artist: 'A', attribution: '',
    score: 100, stars: 3, accuracy: 0.8, starAccuracy: 0.8, maxCombo: 5, totalNotes: 10,
    hits: 8, perfects: 4, goods: 4, misses: 2, reps: 12, health: 1,
    timingBiasMs: null, timingBiasMadMs: null, latencyOffsetMs: 120, suggestedLatencyMs: null,
    completed: true, lanes,
  };
}

describe('movementTrends', () => {
  it('groups by movement+side and orders points oldest first', () => {
    const history = [
      session('c', 3000, [lane({ romMean: 0.7, accuracy: 0.9 })]),
      session('b', 2000, [lane({ romMean: 0.6, accuracy: 0.8 })]),
      session('a', 1000, [lane({ romMean: 0.5, accuracy: 0.7 })]),
    ];
    const [trend] = movementTrends(history);
    expect(trend.key).toBe('knee_extension:left');
    expect(trend.points.map((p) => p.sessionId)).toEqual(['a', 'b', 'c']);
    expect(trend.firstRom).toBeCloseTo(0.5);
    expect(trend.latestRom).toBeCloseTo(0.7);
    expect(trend.romChange).toBeCloseTo(0.2);
    expect(trend.accuracyChange).toBeCloseTo(0.2);
    expect(trend.totalReps).toBe(36);
  });

  it('keeps the two sides of one movement apart', () => {
    const history = [session('a', 1, [lane({ side: 'left' }), lane({ side: 'right', label: 'R knee extension' })])];
    expect(movementTrends(history).map((t) => t.key)).toEqual(['knee_extension:left', 'knee_extension:right']);
  });

  it('keeps two fingertips of finger_opposition apart — they are different quantities', () => {
    const history = [
      session('b', 2, [lane({ movement: 'finger_opposition', fingertip: 'pinky', romMean: 0.4, label: 'L pinch' })]),
      session('a', 1, [lane({ movement: 'finger_opposition', fingertip: 'index', romMean: 0.9, label: 'L pinch' })]),
    ];
    const trends = movementTrends(history);
    expect(trends.map((t) => t.key)).toEqual(['finger_opposition:left:pinky', 'finger_opposition:left:index']);
    // Pooled, this would read as a 50-point collapse in range that never happened.
    for (const t of trends) expect(t.romChange).toBeNull();
  });

  it('never plots an unmeasured session as zero ROM', () => {
    const history = [
      session('c', 3, [lane({ romMean: 0.7 })]),
      session('b', 2, [lane({ romMean: null, romBest: null, romSamples: 0 })]), // a keyboard session
      session('a', 1, [lane({ romMean: 0.5 })]),
    ];
    const [trend] = movementTrends(history);
    expect(trend.points.map((p) => p.rom)).toEqual([0.5, null, 0.7]);
    expect(trend.romPoints).toHaveLength(2);
    expect(trend.romChange).toBeCloseTo(0.2); // measured points only
    expect(trend.points.map((p) => p.accuracy)).toHaveLength(3); // accuracy is always known
  });

  it('flags a change of calibrated span rather than averaging it away', () => {
    const history = [
      session('b', 2, [lane({ calibratedMin: 20, calibratedMax: 110, romMean: 0.55 })]), // span 90
      session('a', 1, [lane({ calibratedMin: 20, calibratedMax: 80, romMean: 0.6 })]),   // span 60
    ];
    const [trend] = movementTrends(history);
    expect(trend.points[0].recalibrated).toBe(false); // nothing to compare the first against
    expect(trend.points[1].recalibrated).toBe(true);
    expect(trend.anyRecalibration).toBe(true);
    // The percentage fell while the patient's actual range grew — the flag is the whole point.
    expect(trend.romChange!).toBeLessThan(0);
  });

  it('a span within 5% is not called a re-calibration', () => {
    const history = [
      session('b', 2, [lane({ calibratedMin: 20, calibratedMax: 82 })]), // span 62
      session('a', 1, [lane({ calibratedMin: 20, calibratedMax: 80 })]), // span 60
    ];
    expect(movementTrends(history)[0].anyRecalibration).toBe(false);
  });

  it('windows each movement to its own most recent N sessions', () => {
    const history = Array.from({ length: 20 }, (_, i) =>
      session(`s${19 - i}`, 20 - i, [lane({ romMean: (19 - i) / 100 })]),
    );
    const [wide] = movementTrends(history, 20);
    expect(wide.points).toHaveLength(20);
    const [narrow] = movementTrends(history, 3);
    expect(narrow.points.map((p) => p.sessionId)).toEqual(['s17', 's18', 's19']);
    expect(movementTrends(history)[0].points).toHaveLength(DEFAULT_TREND_WINDOW);
  });

  it('orders movements by most recently worked', () => {
    const history = [
      session('b', 2, [lane({ movement: 'hip_abduction', label: 'L hip' })]),
      session('a', 1, [lane({ movement: 'knee_extension' })]),
    ];
    expect(movementTrends(history).map((t) => t.movement)).toEqual(['hip_abduction', 'knee_extension']);
  });

  it('reports no change from a single session rather than a fake trend', () => {
    const [trend] = movementTrends([session('a', 1, [lane()])]);
    expect(trend.points).toHaveLength(1);
    expect(trend.romChange).toBeNull();
    expect(trend.accuracyChange).toBeNull();
    expect(trend.latestRom).toBeCloseTo(0.6);
  });

  it('counts compensation flags only where they were monitored', () => {
    const history = [
      session('b', 2, [lane({ compensationMonitored: true, compensationFlags: 3 })]),
      session('a', 1, [lane({ compensationMonitored: false, compensationFlags: 3 })]),
    ];
    expect(movementTrends(history)[0].points.map((p) => p.compensationFlags)).toEqual([0, 3]);
  });

  it('is empty for an empty history', () => {
    expect(movementTrends([])).toEqual([]);
  });
});
