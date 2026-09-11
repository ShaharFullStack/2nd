import { describe, expect, it } from 'vitest';
import { endReasonLabel } from './results.ts';
import { DEFAULT_TREND_WINDOW, movementTrends, patientSessions, trendCoverage } from './trends.ts';
import type { LaneResultSummary, SessionResult } from './types.ts';

function lane(patch: Partial<LaneResultSummary> = {}): LaneResultSummary {
  return {
    lane: 0,
    movement: 'knee_extension',
    side: 'left',
    movementName: 'Left Knee extension',
    hits: 8, perfects: 4, goods: 4, misses: 2, judged: 10, accuracy: 0.8, reps: 12,
    timingBiasMs: null, timingBiasMadMs: null,
    romMean: 0.6, romBest: 0.75, romSamples: 12, romUncertain: 0,
    calibratedMin: 20, calibratedMax: 80, calibrationManual: false,
    compensationKind: null, compensationMonitored: false, compensationFlags: 0, compensationWorst: null,
    ...patch,
  };
}

/** Every fixture session belongs to this patient; the API takes the id explicitly. */
const PATIENT = 'p-test';

/** Sessions are supplied NEWEST FIRST, exactly as the store keeps them. */
function session(id: string, at: number, lanes: LaneResultSummary[]): SessionResult {
  return {
    id, patientId: PATIENT, patientName: 'Test Patient',
    startedAt: at, endedAt: at + 1000, durationSec: 120,
    mode: 'leg', difficulty: 'medium', windowScale: 1, inputMode: 'camera',
    songId: 's', songTitle: 'S', artist: 'A', attribution: '',
    score: 100, stars: 3, accuracy: 0.8, starAccuracy: 0.8, maxCombo: 5, totalNotes: 10,
    hits: 8, perfects: 4, goods: 4, misses: 2, reps: 12, answerRate: 1,
    timingBiasMs: null, timingBiasMadMs: null, latencyOffsetMs: 120, suggestedLatencyMs: null,
    completed: true, lanes,
  };
}

/**
 * THE RULE THIS FILE EXISTS FOR, first: a trend is an outcome record. Only sessions the patient drove
 * through the camera may contribute to it — a keyboard run is whoever held the keyboard, and an
 * autoplay run is a bot hitting every note at 100 %. Both used to be averaged into the accuracy line,
 * the delta badge, the session count and the rep total.
 */
describe('movementTrends excludes sessions the patient did not drive', () => {
  const bot = (id: string, at: number, patch: Partial<SessionResult> = {}) => ({
    ...session(id, at, [lane({ accuracy: 1, reps: 7, romMean: null, romBest: null, romSamples: 0 })]),
    inputMode: 'autoplay' as const,
    ...patch,
  });

  it('plots no point, no rep and no delta for an autoplay or keyboard session', () => {
    const history = [
      bot('bot2', 4000),
      bot('kb', 3000, { inputMode: 'keyboard' }),
      session('cam2', 2000, [lane({ romMean: 0.62, accuracy: 0.62, reps: 11 })]),
      session('cam1', 1000, [lane({ romMean: 0.5, accuracy: 0.5, reps: 9 })]),
    ];
    const [trend] = movementTrends(history, PATIENT);
    expect(trend.points.map((p) => p.sessionId)).toEqual(['cam1', 'cam2']);
    expect(trend.points.every((p) => p.inputMode === 'camera')).toBe(true);
    expect(trend.totalReps).toBe(20); // 9 + 11 — not 34
    expect(trend.latestAccuracy).toBeCloseTo(0.62, 6); // not the bot's 100 %
    expect(trend.accuracyChange).toBeCloseTo(0.12, 6);
    expect(trend.excludedSessions).toBe(2);
    expect(trend.excludedModes).toEqual(['autoplay', 'keyboard']);
  });

  it('produces no card at all for a movement only ever run on the keyboard', () => {
    expect(movementTrends([bot('kb', 1, { inputMode: 'keyboard' })], PATIENT)).toEqual([]);
  });

  it('never lets a bot session fill a window slot a real session should have had', () => {
    const history = [
      bot('bot', 100),
      ...Array.from({ length: 4 }, (_, i) => session(`c${i}`, 90 - i, [lane({ romMean: 0.5 })])),
    ];
    expect(movementTrends(history, PATIENT, 4).map((t) => t.points.length)).toEqual([4]);
  });

  it('counts the split for the screen header', () => {
    const history = [bot('b', 3), bot('k', 2, { inputMode: 'keyboard' }), session('c', 1, [lane()])];
    expect(trendCoverage(history, PATIENT)).toEqual({ cameraSessions: 1, excludedSessions: 2, excludedModes: ['autoplay', 'keyboard'], incompleteSessions: 0 });
    expect(trendCoverage([], PATIENT)).toEqual({ cameraSessions: 0, excludedSessions: 0, excludedModes: [], incompleteSessions: 0 });
  });

  it('treats a record with no recorded input mode as unproven, not as the patient', () => {
    const legacy = { ...session('old', 1, [lane()]), inputMode: undefined as unknown as SessionResult['inputMode'] };
    expect(movementTrends([legacy], PATIENT)).toEqual([]);
    expect(trendCoverage([legacy], PATIENT).excludedModes).toEqual(['unknown']);
  });
});

describe('movementTrends', () => {
  it('groups by movement+side and orders points oldest first', () => {
    const history = [
      session('c', 3000, [lane({ romMean: 0.7, accuracy: 0.9 })]),
      session('b', 2000, [lane({ romMean: 0.6, accuracy: 0.8 })]),
      session('a', 1000, [lane({ romMean: 0.5, accuracy: 0.7 })]),
    ];
    const [trend] = movementTrends(history, PATIENT);
    expect(trend.key).toBe('knee_extension:left');
    expect(trend.points.map((p) => p.sessionId)).toEqual(['a', 'b', 'c']);
    expect(trend.firstRom).toBeCloseTo(0.5);
    expect(trend.latestRom).toBeCloseTo(0.7);
    expect(trend.romChange).toBeCloseTo(0.2);
    expect(trend.accuracyChange).toBeCloseTo(0.2);
    expect(trend.totalReps).toBe(36);
  });

  it('keeps the two sides of one movement apart', () => {
    const history = [session('a', 1, [lane({ side: 'left' }), lane({ side: 'right', movementName: 'Right Knee extension' })])];
    expect(movementTrends(history, PATIENT).map((t) => t.key)).toEqual(['knee_extension:left', 'knee_extension:right']);
  });

  it('keeps two fingertips of finger_opposition apart — they are different quantities', () => {
    const history = [
      session('b', 2, [lane({ movement: 'finger_opposition', fingertip: 'pinky', romMean: 0.4, movementName: 'Left Finger opposition (index finger)' })]),
      session('a', 1, [lane({ movement: 'finger_opposition', fingertip: 'index', romMean: 0.9, movementName: 'Left Finger opposition (index finger)' })]),
    ];
    const trends = movementTrends(history, PATIENT);
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
    const [trend] = movementTrends(history, PATIENT);
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
    const [trend] = movementTrends(history, PATIENT);
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
    expect(movementTrends(history, PATIENT)[0].anyRecalibration).toBe(false);
  });

  it('windows each movement to its own most recent N sessions', () => {
    const history = Array.from({ length: 20 }, (_, i) =>
      session(`s${19 - i}`, 20 - i, [lane({ romMean: (19 - i) / 100 })]),
    );
    const [wide] = movementTrends(history, PATIENT, 20);
    expect(wide.points).toHaveLength(20);
    const [narrow] = movementTrends(history, PATIENT, 3);
    expect(narrow.points.map((p) => p.sessionId)).toEqual(['s17', 's18', 's19']);
    expect(movementTrends(history, PATIENT)[0].points).toHaveLength(DEFAULT_TREND_WINDOW);
  });

  it('orders movements by most recently worked', () => {
    const history = [
      session('b', 2, [lane({ movement: 'hip_abduction', movementName: 'Left Hip abduction' })]),
      session('a', 1, [lane({ movement: 'knee_extension' })]),
    ];
    expect(movementTrends(history, PATIENT).map((t) => t.movement)).toEqual(['hip_abduction', 'knee_extension']);
  });

  it('reports no change from a single session rather than a fake trend', () => {
    const [trend] = movementTrends([session('a', 1, [lane()])], PATIENT);
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
    expect(movementTrends(history, PATIENT)[0].points.map((p) => p.compensationFlags)).toEqual([0, 3]);
  });

  it('is empty for an empty history', () => {
    expect(movementTrends([], PATIENT)).toEqual([]);
  });
});

/**
 * TWO CARDS FOR TWO DIGITS MUST NOT BE CALLED THE SAME THING.
 *
 * The key already separated an index lane from a little-finger lane; the TITLE did not, because it
 * was read back from `LaneResultSummary.label`, which said "L pinch" for every tip. A therapist
 * looking at two side-by-side cards reading "L pinch", one ▲ +15 and one ▼ −9, cannot tell which
 * finger regressed — and neither can they for the same lane worked in March and April.
 */
describe('the label a human reads carries the fingertip', () => {
  const pinch = (fingertip: 'index' | 'middle' | 'ring' | 'pinky', patch: Partial<LaneResultSummary> = {}) =>
    lane({ movement: 'finger_opposition', side: 'left', fingertip, movementName: 'Left Finger opposition (index finger)', ...patch });

  it('gives two fingertips on one hand two different titles', () => {
    const trends = movementTrends([
      session('a', 1000, [pinch('index', { lane: 0, romMean: 0.8 }), pinch('pinky', { lane: 1, romMean: 0.4 })]),
    ], PATIENT);
    expect(trends).toHaveLength(2);
    const labels = trends.map((t) => t.label);
    expect(new Set(labels).size).toBe(2);
    expect(labels).toContain('Left Finger opposition (index finger)');
    expect(labels).toContain('Left Finger opposition (little finger)');
    expect(trends.map((t) => t.fingertip).sort()).toEqual(['index', 'pinky']);
  });

  it('ignores a stored label that predates the fingertip, rather than repeating its collision', () => {
    // Every one of these records claims to be "L pinch". The title is rebuilt from the same fields
    // the key is built from, so it can never disagree with the key.
    const trends = movementTrends([
      session('apr', 2000, [pinch('pinky')]),
      session('mar', 1000, [pinch('index')]),
    ], PATIENT);
    expect(trends.map((t) => t.label).sort()).toEqual(['Left Finger opposition (index finger)', 'Left Finger opposition (little finger)']);
  });

  it('leaves a movement with no fingertip dimension exactly as it was', () => {
    expect(movementTrends([session('a', 1, [lane()])], PATIENT)[0].label).toBe('Left Knee extension');
  });
});

/**
 * THE DENOMINATOR AND THE FIGURE THAT DOES NOT DEPEND ON IT.
 *
 * `romMean` is a percentage of the range calibrated THAT DAY. Widen the range and the same knee angle
 * reads lower, so the percentage alone cannot answer "did this patient's range improve?". The
 * absolute peak is `calibratedMin + rom x span` — already implied by what is persisted.
 */
describe('absolute peak, in the movement units', () => {
  it('reconstructs the peak in the movement own units', () => {
    const t = movementTrends([session('a', 1, [lane({ romMean: 0.5, romBest: 0.75, calibratedMin: 20, calibratedMax: 80 })])], PATIENT)[0];
    expect(t.unit).toBe('deg');
    expect(t.points[0].absoluteMean).toBeCloseTo(50, 6); // 20 + 0.5 x 60
    expect(t.points[0].absoluteBest).toBeCloseTo(65, 6);
    expect(t.latestAbsolute).toBeCloseTo(50, 6);
  });

  it('rises across a re-calibration that makes the PERCENTAGE fall', () => {
    // Session 1: 20..80 deg, 90 % => 74 deg. Session 2: recalibrated to 20..120, 70 % => 90 deg.
    // The percentage says the patient got worse by 20 points; the joint angle says they gained 16 deg.
    const t = movementTrends([
      session('b', 2000, [lane({ romMean: 0.7, calibratedMin: 20, calibratedMax: 120 })]),
      session('a', 1000, [lane({ romMean: 0.9, calibratedMin: 20, calibratedMax: 80 })]),
    ], PATIENT)[0];
    expect(t.romChange).toBeCloseTo(-0.2, 6);
    expect(t.absoluteChange).toBeCloseTo(16, 6);
    expect(t.anyRecalibration).toBe(true);
    expect(t.latestCalibratedMin).toBe(20);
    expect(t.latestCalibratedMax).toBe(120);
  });

  it('never invents an absolute peak from an unmeasured session', () => {
    const t = movementTrends([session('a', 1, [lane({ romMean: null, romBest: null, romSamples: 0 })])], PATIENT)[0];
    expect(t.points[0].absoluteMean).toBeNull();
    expect(t.absolutePoints).toHaveLength(0);
    expect(t.latestAbsolute).toBeNull();
  });

  it('never invents one from a session with no recorded range', () => {
    const t = movementTrends([session('a', 1, [lane({ calibratedMin: null, calibratedMax: null })])], PATIENT)[0];
    expect(t.points[0].absoluteMean).toBeNull();
    expect(t.latestCalibratedMin).toBeNull();
  });
});

/**
 * THE POOLING BUG, PINNED.
 *
 * A clinic tablet's history holds several people's sessions. Keyed on movement alone, one patient's
 * "is my range improving?" chart was built out of everybody who had ever used the device — and the
 * shape of the line looked entirely normal, which is why it survived four reviews before this.
 */
describe('a trend is one patient\'s, never the tablet\'s', () => {
  const other = (id: string, at: number, romMean: number): SessionResult => ({
    ...session(id, at, [lane({ romMean })]),
    patientId: 'someone-else',
    patientName: 'Someone Else',
  });

  it('ignores every session belonging to another patient', () => {
    const history = [
      other('x', 3000, 0.1),
      session('b', 2000, [lane({ romMean: 0.7 })]),
      other('y', 1500, 0.1),
      session('a', 1000, [lane({ romMean: 0.5 })]),
    ];
    const [trend] = movementTrends(history, PATIENT);
    expect(trend.points.map((p) => p.sessionId)).toEqual(['a', 'b']);
    expect(trend.latestRom).toBeCloseTo(0.7, 6);
    expect(trend.romChange).toBeCloseTo(0.2, 6);
  });

  it('counts only this patient in the coverage line under the charts', () => {
    const history = [other('x', 2, 0.1), session('a', 1, [lane()])];
    expect(trendCoverage(history, PATIENT)).toEqual({ cameraSessions: 1, excludedSessions: 0, excludedModes: [], incompleteSessions: 0 });
  });

  it('shows a patient with no sessions nothing at all, rather than somebody else\'s line', () => {
    const history = [other('x', 2, 0.1)];
    expect(movementTrends(history, PATIENT)).toEqual([]);
    expect(patientSessions(history, PATIENT)).toEqual([]);
  });
});

/**
 * A RUN THE PATIENT WALKED OUT OF IS STILL IN THE RECORD — AND MUST NOT READ LIKE A SESSION.
 *
 * Sessions are now persisted from every exit, so a 12-second abort sits in the history next to a
 * 97-second full run. The reps are real and are plotted. What must not happen is a nine-rep walk-out
 * silently becoming one end of "72 %, no change" — the sentence a therapist changes a prescription
 * on.
 */
describe('runs that were cut short', () => {
  const cut = (id: string, at: number, patch: Partial<LaneResultSummary>, reason: SessionResult['endReason']) => ({
    ...session(id, at, [lane(patch)]),
    completed: false,
    endReason: reason,
  });

  it('plots the point, carries WHY it stopped, and counts it on the card', () => {
    const history = [
      cut('short', 3000, { romMean: 0.4, accuracy: 0.4, reps: 9 }, 'abandoned'),
      session('full2', 2000, [lane({ romMean: 0.7, accuracy: 0.7, reps: 40 })]),
      session('full1', 1000, [lane({ romMean: 0.6, accuracy: 0.6, reps: 40 })]),
    ];
    const [trend] = movementTrends(history, PATIENT);
    expect(trend.points.map((p) => p.sessionId)).toEqual(['full1', 'full2', 'short']);
    expect(trend.points.map((p) => p.completed)).toEqual([true, true, false]);
    expect(trend.points.at(-1)!.endReason).toBe('abandoned');
    expect(trend.incompleteSessions).toBe(1);
    expect(trendCoverage(history, PATIENT).incompleteSessions).toBe(1);
  });

  it('takes the delta between the two FULL sessions, not off the walk-out', () => {
    const history = [
      cut('short', 3000, { romMean: 0.2, accuracy: 0.2, reps: 9 }, 'quit'),
      session('full2', 2000, [lane({ romMean: 0.7, accuracy: 0.7, reps: 40 })]),
      session('full1', 1000, [lane({ romMean: 0.6, accuracy: 0.6, reps: 40 })]),
    ];
    const [trend] = movementTrends(history, PATIENT);
    expect(trend.firstRom).toBeCloseTo(0.6);
    expect(trend.latestRom).toBeCloseTo(0.7);
    expect(trend.romChange).toBeCloseTo(0.1); // improving — not the -0.4 the abort would have shown
    expect(trend.changeIncludesIncomplete).toBe(false);
  });

  it('says so when there are not two full sessions to compare', () => {
    const history = [
      cut('short', 2000, { romMean: 0.2, accuracy: 0.2, reps: 9 }, 'abandoned'),
      session('full1', 1000, [lane({ romMean: 0.6, accuracy: 0.6, reps: 40 })]),
    ];
    const [trend] = movementTrends(history, PATIENT);
    expect(trend.changeIncludesIncomplete).toBe(true);
    expect(trend.romChange).toBeCloseTo(-0.4); // still shown — but flagged, never presented as like-for-like
  });

  it('a record with no stored reason says "ended early" rather than inventing one', () => {
    const legacy = { ...session('old', 1000, [lane()]), completed: false };
    const [trend] = movementTrends([legacy], PATIENT);
    expect(trend.points[0].endReason).toBeNull();
    expect(endReasonLabel(trend.points[0].endReason)).toBe('ended early');
    expect(endReasonLabel('quit')).toBe('stopped by therapist');
    expect(endReasonLabel('abandoned')).toBe('interrupted');
  });
});
