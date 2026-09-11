import { describe, expect, it } from 'vitest';
import type { ScoreResults } from '../engine/scoring.ts';
import type { LaneRepStats, RunSummary } from './GameRunner.ts';
import { buildPatientExport, buildSessionResult, clinicalLaneName, formatDuration, formatMs, formatPercent } from './results.ts';
import type { SessionConfig, SessionResult } from './types.ts';

const CONFIG: SessionConfig = {
  patientId: 'p-test',
  mode: 'leg',
  lanes: [
    { index: 0, movement: 'seated_march', side: 'left' },
    { index: 1, movement: 'ankle_dorsiflexion', side: 'right' },
  ],
  difficulty: 'medium',
  windowScale: 1,
  songId: 'demo-groove',
  seed: 1,
};

function laneStats(lane: number, over: Partial<ScoreResults['lanes'][number]> = {}): ScoreResults['lanes'][number] {
  return {
    lane,
    hits: 0,
    perfects: 0,
    goods: 0,
    misses: 0,
    judged: 0,
    accuracy: 0,
    weightedAccuracy: 0,
    meanDeltaMs: 0,
    stdDeltaMs: 0,
    unmatched: 0,
    attempted: 0,
    surplus: 0,
    reps: 0,
    timingBiasMs: null,
    timingBiasMadMs: null,
    timingBiasSamples: 0,
    ...over,
  };
}

function repStats(lane: number, over: Partial<LaneRepStats> = {}): LaneRepStats {
  return {
    lane,
    reps: 0,
    peaks: [],
    uncertain: 0,
    compensationKind: null,
    compensationMonitored: false,
    compensationFlags: 0,
    compensationWorst: null,
    ...over,
  };
}

function summary(over: Partial<RunSummary> = {}): RunSummary {
  const results = {
    score: 1200,
    combo: 3,
    maxCombo: 9,
    multiplier: 2,
    health: 0.62,
    totalNotes: 40,
    hits: 20,
    perfects: 12,
    goods: 8,
    misses: 20,
    judged: 40,
    accuracy: 0.5,
    weightedAccuracy: 0.4,
    starAccuracy: 0.45,
    stars: 2,
    meanDeltaMs: 12,
    stdDeltaMs: 30,
    unmatched: 6,
    outOfRange: 0,
    reps: 26,
    timingBiasMs: 18,
    timingBiasMadMs: 9,
    timingBiasSamples: 26,
    lanes: [
      laneStats(0, { hits: 20, perfects: 12, goods: 8, misses: 5, judged: 25, accuracy: 0.8, reps: 24, timingBiasMs: 18, timingBiasMadMs: 9 }),
      laneStats(1, { misses: 15, judged: 15, reps: 2 }),
    ],
  } as unknown as ScoreResults;
  return {
    results,
    laneReps: [
      repStats(0, { reps: 24, peaks: [0.9, 1.1, 1.0], uncertain: 1 }),
      repStats(1, { reps: 2, compensationKind: 'heel_lift', compensationMonitored: true, compensationFlags: 2, compensationWorst: 0.3 }),
    ],
    completed: true,
    endReason: 'chart',
    songTime: 92.5,
    startedAt: 1000,
    endedAt: 94000,
    suggestedLatencySec: 0.3,
    ...over,
  };
}

describe('buildSessionResult', () => {
  it('reports the movements performed, not only the ones that scored', () => {
    const r = buildSessionResult({ summary: summary(), config: CONFIG, inputMode: 'camera', latencyOffsetSec: 0.12 });
    expect(r.reps).toBe(26);
    expect(r.hits).toBe(20);
    expect(r.lanes[0].reps).toBe(24);
    // Lane 1 performed two movements that never scored — they must still appear.
    expect(r.lanes[1].reps).toBe(2);
    expect(r.lanes[1].hits).toBe(0);
  });

  it('carries ROM achieved as a fraction of the calibrated range, with the uncertain count', () => {
    const r = buildSessionResult({ summary: summary(), config: CONFIG, inputMode: 'camera', latencyOffsetSec: 0.12 });
    expect(r.lanes[0].romMean).toBeCloseTo(1.0, 6);
    expect(r.lanes[0].romBest).toBeCloseTo(1.1, 6);
    expect(r.lanes[0].romSamples).toBe(3);
    expect(r.lanes[0].romUncertain).toBe(1);
    // No rep events for a keyboard-style source means "not measured", not "0% of range".
    expect(r.lanes[1].romMean).toBeNull();
  });

  it('separates "no compensation" from "compensation never measured"', () => {
    const s = summary();
    s.laneReps[0] = repStats(0, { reps: 24, peaks: [1], compensationKind: null, compensationMonitored: false });
    const r = buildSessionResult({ summary: s, config: CONFIG, inputMode: 'camera', latencyOffsetSec: 0 });
    expect(r.lanes[0].compensationMonitored).toBe(false);
    expect(r.lanes[0].compensationFlags).toBe(0);
    expect(r.lanes[1].compensationMonitored).toBe(true);
    expect(r.lanes[1].compensationFlags).toBe(2);
    expect(r.lanes[1].compensationKind).toBe('heel_lift');
  });

  it('stores the calibrated range the ROM percentages are measured against', () => {
    const r = buildSessionResult({
      summary: summary(),
      config: CONFIG,
      inputMode: 'camera',
      latencyOffsetSec: 0,
      calibrations: [{ min: 0.1, max: 0.42, samples: 90, movement: 'seated_march', manual: true }, null],
    });
    expect(r.lanes[0].calibratedMin).toBeCloseTo(0.1);
    expect(r.lanes[0].calibratedMax).toBeCloseTo(0.42);
    expect(r.lanes[0].calibrationManual).toBe(true);
    expect(r.lanes[1].calibratedMin).toBeNull();
    expect(r.lanes[1].calibrationManual).toBe(false);
  });

  it('records the latency in force and what the run suggests it should have been', () => {
    const r = buildSessionResult({ summary: summary(), config: CONFIG, inputMode: 'camera', latencyOffsetSec: 0.12 });
    expect(r.latencyOffsetMs).toBe(120);
    expect(r.suggestedLatencyMs).toBe(300);
  });

  it('labels lanes with the movement and side the therapist prescribed', () => {
    const r = buildSessionResult({ summary: summary(), config: CONFIG, inputMode: 'keyboard', latencyOffsetSec: 0 });
    expect(r.lanes[0].movementName).toBe('Left Seated march');
    expect(r.lanes[0].movement).toBe('seated_march');
    expect(r.lanes[1].side).toBe('right');
    expect(r.inputMode).toBe('keyboard');
  });

  it('falls back to a silent-session title when no manifest was loaded', () => {
    const r = buildSessionResult({ summary: summary(), config: CONFIG, inputMode: 'camera', latencyOffsetSec: 0 });
    expect(r.songTitle).toBe('Silent session');
    expect(r.attribution).toBe('');
  });

  it('marks an abandoned run incomplete but keeps its numbers', () => {
    const r = buildSessionResult({ summary: summary({ completed: false }), config: CONFIG, inputMode: 'camera', latencyOffsetSec: 0 });
    expect(r.completed).toBe(false);
    expect(r.score).toBe(1200);
  });

  /**
   * WHY it stopped, not only THAT it stopped. "Ended early" reads the same for a therapist who
   * decided the patient had had enough at 40 s and for a tablet that went to sleep mid-song — and
   * those are a clinical judgment and an equipment failure. The runner has always known which; this
   * is that fact reaching the record a therapist reads months later.
   */
  it('stores WHICH exit ended the run, not just that it was early', () => {
    const quit = buildSessionResult({
      summary: summary({ completed: false, endReason: 'quit' }),
      config: CONFIG, inputMode: 'camera', latencyOffsetSec: 0,
    });
    const gone = buildSessionResult({
      summary: summary({ completed: false, endReason: 'abandoned' }),
      config: CONFIG, inputMode: 'camera', latencyOffsetSec: 0,
    });
    expect(quit.endReason).toBe('quit');
    expect(gone.endReason).toBe('abandoned');
    expect(buildSessionResult({ summary: summary(), config: CONFIG, inputMode: 'camera', latencyOffsetSec: 0 }).endReason).toBe('chart');
  });
});

describe('formatters', () => {
  it('formats percentages, signed milliseconds and durations', () => {
    expect(formatPercent(0.834)).toBe('83%');
    expect(formatPercent(null)).toBe('—');
    expect(formatMs(12.4)).toBe('+12 ms');
    expect(formatMs(-30)).toBe('-30 ms');
    expect(formatMs(null)).toBe('—');
    expect(formatDuration(92.5)).toBe('1:32');
    expect(formatDuration(-1)).toBe('0:00');
  });
});

/**
 * THE STORED NAME IS THE LANE'S NAME EVERYWHERE DOWNSTREAM — the Results per-movement table, the
 * History table, the export and the trend card title all read it back. It has to be the FULL clinical
 * name (never the canvas abbreviation) and it has to name the digit that was prescribed.
 */
describe('the stored per-lane movement name', () => {
  const pinchConfig = (lanes: SessionConfig['lanes']): SessionConfig => ({ ...CONFIG, mode: 'hand', lanes });

  it('names the fingertip, so two pinch lanes on one hand are not both "L pinch"', () => {
    const r = buildSessionResult({
      summary: summary(),
      config: pinchConfig([
        { index: 0, movement: 'finger_opposition', side: 'left', fingertip: 'index' },
        { index: 1, movement: 'finger_opposition', side: 'left', fingertip: 'pinky' },
      ]),
      inputMode: 'camera',
      latencyOffsetSec: 0.12,
    });
    expect(r.lanes.map((l) => l.movementName)).toEqual(['Left Finger opposition (index finger)', 'Left Finger opposition (little finger)']);
    expect(r.lanes.map((l) => l.fingertip)).toEqual(['index', 'pinky']);
  });

  it('names the DEFAULT tip when the therapist never touched the control — the lane is still measured on it', () => {
    const r = buildSessionResult({
      summary: summary(),
      config: pinchConfig([
        { index: 0, movement: 'finger_opposition', side: 'right' },
        { index: 1, movement: 'hand_open_close', side: 'right' },
      ]),
      inputMode: 'camera',
      latencyOffsetSec: 0.12,
    });
    expect(r.lanes[0].movementName).toBe('Right Finger opposition (index finger)');
    expect(r.lanes[0].fingertip).toBe('index');
    // A movement with no fingertip dimension is untouched.
    expect(r.lanes[1].movementName).toBe('Right Hand open / close');
    expect(r.lanes[1].fingertip).toBeUndefined();
  });
});

/**
 * GETTING THE RECORD OFF THE DEVICE.
 *
 * Everything this app measures lives in one browser's localStorage, capped and trimmed on write. Until
 * the export existed there was no way to keep a record past a cleared cache — so the export is held to
 * the same standard as the screens: full clinical movement names, the caveats carried, and the parts
 * the device has ALREADY deleted named rather than quietly missing.
 */
describe('a patient record that can leave the device', () => {
  const patient = { id: 'p1', name: 'Jane Okafor', createdAt: 1, lastUsedAt: 2 };

  const record = (patch: Partial<SessionResult> = {}): SessionResult => ({
    ...buildSessionResult({
      summary: summary(),
      config: CONFIG,
      inputMode: 'camera',
      latencyOffsetSec: 0.12,
      patientName: patient.name,
      now: () => 1_700_000_000_000,
      id: 's1',
    }),
    ...patch,
  });

  it('names the patient and every movement in full, never the canvas abbreviation', () => {
    const out = buildPatientExport({ patient, sessions: [record()], now: () => 1_700_000_500_000 });
    expect(out.text).toContain('Jane Okafor');
    expect(out.text).toContain('Left Seated march');
    expect(out.text).not.toContain('L knee lift');
    expect(out.filename).toMatch(/^beat-rehab-jane-okafor-\d{4}-\d{2}-\d{2}\.json$/);
    // A printed record must be filable even when two patients on the tablet share a display name —
    // the name is the only identifier this app stores, so the local record id goes in the header.
    expect(out.text).toContain('Local record id: p1');
  });

  it('is complete JSON, so the record survives without this app', () => {
    const out = buildPatientExport({ patient, sessions: [record()], now: () => 1 });
    const parsed = JSON.parse(out.json) as { patient: typeof patient; sessions: SessionResult[] };
    expect(parsed.patient.id).toBe('p1');
    expect(parsed.sessions[0].lanes[0].movementName).toBe('Left Seated march');
  });

  it('says what the device has ALREADY deleted, so a trimmed record cannot read as a whole one', () => {
    const out = buildPatientExport({ patient, sessions: [record()], droppedSessions: 7, retentionLimit: 100, now: () => 1 });
    expect(out.text).toMatch(/7 older session\(s\) were already deleted/);
    expect(out.text).toMatch(/at most 100 sessions per patient/);
  });

  it('keeps the "not the patient" quarantine on a keyboard or autoplay run', () => {
    const out = buildPatientExport({ patient, sessions: [record({ inputMode: 'keyboard' })], now: () => 1 });
    expect(out.text).toMatch(/NOT THE PATIENT'S PERFORMANCE/);
  });

  it('is honest about an empty record rather than producing a blank file', () => {
    const out = buildPatientExport({ patient, sessions: [], now: () => 1 });
    expect(out.text).toContain('No sessions recorded for this patient.');
  });
});

describe('the clinical name of a lane', () => {
  it('is the movement\'s real name, with the digit where there is one', () => {
    expect(clinicalLaneName({ movement: 'ankle_dorsiflexion', side: 'left' })).toBe('Left Ankle dorsiflexion');
    expect(clinicalLaneName({ movement: 'finger_opposition', side: 'right', fingertip: 'pinky' })).toBe(
      'Right Finger opposition (little finger)',
    );
  });
});


/**
 * THE DOSE HAS TO BE IN THE RECORD. Pacing is the control that sets the rep count directly — the
 * same patient, song and difficulty gives 24 reps a lane at 3.0 s and 96 at 0.4 s — so a stored
 * session that cannot say what pacing was prescribed cannot support "+26 movements vs last time".
 */
describe('the prescription is recorded, not just obeyed', () => {
  it('stores the pacing the session was prescribed at', () => {
    const r = buildSessionResult({
      summary: summary(),
      config: { ...CONFIG, laneRestSec: 2.4 },
      inputMode: 'camera',
      latencyOffsetSec: 0.12,
    });
    expect(r.laneRestSec).toBe(2.4);
  });

  it('leaves it undefined — never a guess — when the session predates the control', () => {
    const r = buildSessionResult({ summary: summary(), config: CONFIG, inputMode: 'camera', latencyOffsetSec: 0.12 });
    expect(r.laneRestSec).toBeUndefined();
  });

  it('records notes ANSWERED and the movements that answered nothing under their own names', () => {
    const r = buildSessionResult({ summary: summary(), config: CONFIG, inputMode: 'camera', latencyOffsetSec: 0.12 });
    // The RAW measurement, not the gauge's warm-up-padded reading: 0 answered of 40 judged here,
    // because the fixture's lane stats carry no `attempted`.
    expect(r.answerRate).toBe(0);
    expect('health' in r).toBe(false); // the key whose meaning changed three times is gone
  });

  it('files a session abandoned after two notes as what it measured, not as a warm-up reading', () => {
    const short = summary({
      results: {
        ...summary().results,
        hits: 0, misses: 2, judged: 2, attempted: 0, reps: 2, surplus: 2,
      } as unknown as ScoreResults,
    });
    const r = buildSessionResult({ summary: short, config: CONFIG, inputMode: 'camera', latencyOffsetSec: 0.12 });
    expect(r.answerRate).toBe(0);
  });
});

describe('the exported record leads with the work, like the screen does', () => {
  const patient = { id: 'p1', name: 'Jane Okafor', createdAt: 1, lastUsedAt: 2 };
  const exported = (patch: Partial<SessionResult> = {}) =>
    buildPatientExport({
      patient,
      sessions: [
        {
          ...buildSessionResult({
            summary: summary(),
            config: { ...CONFIG, laneRestSec: 1.2 },
            inputMode: 'camera',
            latencyOffsetSec: 0.12,
            patientName: patient.name,
            now: () => 1_700_000_000_000,
            id: 's1',
          }),
          ...patch,
        },
      ],
      now: () => 1_700_000_500_000,
    });

  it('opens each session line with movements performed, not with points and stars', () => {
    const out = exported();
    const line = out.text.split('\n').find((l) => l.includes('movements performed')) ?? '';
    expect(line).toContain('26 movements performed');
    expect(line).toContain('pacing 1.2 s between reps of one limb');
    expect(line).not.toContain('pts');
    // the grade is still there for the clinician, one line down and labelled as such
    expect(out.text).toContain('Scoring (clinical): 1,200 pts');
    expect(out.text.indexOf('movements performed')).toBeLessThan(out.text.indexOf('Scoring (clinical)'));
  });

  it('bumps the format version, because `health` changed meaning under a stable key', () => {
    const parsed = JSON.parse(exported().json) as { version: number; fields: Record<string, string>; sessions: unknown[] };
    expect(parsed.version).toBe(2);
    expect(parsed.fields.answerRate).toMatch(/notes answered/);
    expect(parsed.fields.health).toMatch(/REMOVED in v2/);
  });

  it('says when a session’s pacing was never recorded rather than inventing one', () => {
    const out = exported({ laneRestSec: undefined });
    expect(out.text).toContain('pacing not recorded');
  });
});
