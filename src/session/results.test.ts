import { describe, expect, it } from 'vitest';
import type { ScoreResults } from '../engine/scoring.ts';
import type { LaneRepStats, RunSummary } from './GameRunner.ts';
import {
  buildPatientExport,
  buildSessionResult,
  clinicalLaneName,
  formatDuration,
  formatMs,
  formatPercent,
  laneRangeSummaries,
  laneTrendKey,
  mostImprovedRange,
  rangeChange,
} from './results.ts';
import type { LaneResultSummary, SessionConfig, SessionResult } from './types.ts';

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

  /**
   * THE HEADLINE IS THE SUM OF THE COLUMN UNDER IT.
   *
   * Each lane's `reps` is `max(the engine's count, the reps the camera actually observed)` — a
   * crossing swallowed by the camera's refractory window reports a rep and emits no input event, so
   * the observed count is sometimes the larger and it is the right one. The session headline was
   * the engine's total regardless, so the report could print "Movements performed 126" over a
   * per-movement column that added up to more than 126.
   */
  it('never prints a headline rep count smaller than its own per-movement column', () => {
    const s = summary();
    // The camera saw four movements in lane 1 that the engine was never handed (refractory window).
    s.laneReps[1] = repStats(1, { reps: 6 });
    const r = buildSessionResult({ summary: s, config: CONFIG, inputMode: 'camera', latencyOffsetSec: 0 });
    expect(r.lanes[1].reps).toBe(6);
    expect(r.reps).toBe(r.lanes.reduce((n, l) => n + l.reps, 0));
    expect(r.reps).toBe(30);
    // And the movements that answered no note are counted off the same total, not the smaller one.
    expect(r.surplusMovements).toBe(30);
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
    expect(line).toContain('pacing 1.2 s between two reps of the same movement');
    expect(line).not.toContain('pts');
    // the grade is still there for the clinician, one line down and labelled as such
    expect(out.text).toContain('Scoring (clinical): 1,200 pts');
    expect(out.text.indexOf('movements performed')).toBeLessThan(out.text.indexOf('Scoring (clinical)'));
  });

  it('bumps the format version whenever the meaning of the file changes', () => {
    // v2: `health` changed meaning under a stable key and was replaced by `answerRate`.
    // v3: sessions carry the camera conditions they were measured in (`tracking`), so a reader can
    //     tell a range measured on a clean 30 fps stream from one measured on a 12 fps stream.
    const parsed = JSON.parse(exported().json) as { version: number; fields: Record<string, string>; sessions: unknown[] };
    expect(parsed.version).toBe(3);
    expect(parsed.fields.answerRate).toMatch(/notes answered/);
    expect(parsed.fields.health).toMatch(/REMOVED in v2/);
    expect(parsed.fields.tracking).toMatch(/frames per second/);
  });

  it('says when a session’s pacing was never recorded rather than inventing one', () => {
    const out = exported({ laneRestSec: undefined });
    expect(out.text).toContain('pacing not recorded');
  });

  /**
   * THE SAME QUANTITY, THE SAME UNITS, IN THE DURABLE ARTEFACT.
   *
   * `laneRestSec` is the rest between two reps of ONE LANE. This file used to print it as "1.2 s
   * between reps of one limb (50 reps/min per limb at most)" while the setup screen the therapist
   * prescribed from said the opposite in the same session — and for a prescription with two lanes on
   * one limb the exported ceiling was wrong by a factor of two, off-device, where nobody can check it
   * against the app. Two surfaces quoting one quantity in opposite units is a med-error pattern.
   */
  it('quotes the pacing per LANE and works the limb ceiling out from the lanes on the limb', () => {
    const oneEach = exported();
    expect(oneEach.text).toContain('at most 50 reps/min per lane, one lane per limb so that is the limb ceiling too');
    expect(oneEach.text).not.toContain('reps of one limb');
    expect(oneEach.text).not.toContain('reps/min per limb');

    // Both lanes on the LEFT leg: the limb is asked for both, so its ceiling is twice the lane's.
    const asStored = (JSON.parse(oneEach.json) as { sessions: SessionResult[] }).sessions[0];
    const bilateral = exported({ lanes: asStored.lanes.map((l) => ({ ...l, side: 'left' as const })) });
    expect(bilateral.text).toContain('at most 50 reps/min per lane; 2 lanes on the left leg, so at most 100 reps/min for that limb');

    // …and the glossary the reader checks the field against says the same thing.
    const parsed = JSON.parse(oneEach.json) as { fields: Record<string, string> };
    expect(parsed.fields.laneRestSec).toMatch(/SAME LANE/);
    expect(parsed.fields.laneRestSec).toMatch(/NOT per limb/);
  });
});

/**
 * RANGE IS PER LIMB. `max(romBest)` across a mixed prescription is the unaffected side essentially
 * every time, and this app has no field that says which side is affected — so the presentation layer
 * is not allowed to pick one, and these helpers make that structural rather than a UI convention.
 */
describe('laneRangeSummaries', () => {
  const weak: LaneResultSummary = {
    lane: 0, movement: 'seated_march', side: 'left', movementName: 'Left Seated march',
    hits: 2, perfects: 0, goods: 2, misses: 18, judged: 20, accuracy: 0.1, reps: 20,
    timingBiasMs: null, timingBiasMadMs: null, romMean: 0.3, romBest: 0.4, romSamples: 20, romUncertain: 0,
    calibratedMin: 0.1, calibratedMax: 0.5, calibrationManual: false,
    compensationKind: null, compensationMonitored: false, compensationFlags: 0, compensationWorst: null,
  };
  const strong: LaneResultSummary = {
    ...weak,
    lane: 1, movement: 'knee_extension', side: 'right', movementName: 'Right Knee extension',
    romMean: 0.8, romBest: 0.95, calibratedMin: 100, calibratedMax: 160,
  };

  it('keeps prescription order and expresses every lane in its own units', () => {
    const out = laneRangeSummaries([weak, strong]);
    expect(out.map((s) => s.movementName)).toEqual(['Left Seated march', 'Right Knee extension']);
    expect(out[0].best).toBeCloseTo(0.26, 5); // 0.1 + 0.4 x 0.4
    expect(out[0].unit).toBe('ratio');
    expect(out[1].best).toBeCloseTo(157, 5); // 100 + 0.95 x 60
    expect(out[1].unit).toBe('deg');
  });

  it('marks a lane that measured nothing rather than reporting a zero range', () => {
    const [only] = laneRangeSummaries([{ ...weak, romSamples: 0, romMean: null, romBest: null }]);
    expect(only.measured).toBe(false);
    expect(only.best).toBeNull();
    expect(only.bestFraction).toBeNull();
  });

  it('compares each lane only with ITSELF last time', () => {
    const previous = new Map([
      [laneTrendKey(weak), { ...weak, romBest: 0.2 }],
      [laneTrendKey(strong), { ...strong, romBest: 0.9 }],
    ]);
    const out = laneRangeSummaries([weak, strong], previous);
    expect(out[0].gainPct).toBeCloseTo(0.2, 5);
    expect(out[1].gainPct).toBeCloseTo(0.05, 5);
    expect(out[0].gain).toBeCloseTo(0.08, 5); // 0.4 of its own range is 0.08 in ratio units
    expect(out[1].gain).toBeCloseTo(3, 5);
  });

  it('ranks improvement against each lane"s own range, so a big joint cannot win by being big', () => {
    const previous = new Map([
      [laneTrendKey(weak), { ...weak, romBest: 0.2 }],
      [laneTrendKey(strong), { ...strong, romBest: 0.9 }],
    ]);
    const out = laneRangeSummaries([weak, strong], previous);
    // The knee moved 3 degrees and the march moved 0.08 ratio units; the march gained a fifth of
    // its own range and the knee a twentieth of its.
    expect(mostImprovedRange(out)?.movementName).toBe('Left Seated march');
  });

  it('names nobody when nothing improved', () => {
    const previous = new Map([[laneTrendKey(weak), { ...weak, romBest: 0.6 }]]);
    expect(mostImprovedRange(laneRangeSummaries([weak], previous))).toBeNull();
    expect(mostImprovedRange(laneRangeSummaries([weak]))).toBeNull();
  });

  /**
   * "SAME AS LAST TIME" AND "BIGGEST GAIN TODAY" MAY NOT BE SAID ABOUT ONE NUMBER.
   *
   * The ranking accepted any `gainPct > 0` with no resolution floor while the tile beside it printed
   * "same as last time" for anything under both the movement's unit resolution and half a point of
   * range. A knee that moved 0.15° therefore rendered both verdicts, one under the other, and the
   * card header announced that limb as the day's achievement — on a mixed prescription, the
   * unaffected one, which is the exact failure the per-limb headline exists to end.
   */
  it('will not rank a change it has just called unmeasurable', () => {
    // +0.15° on a 60° knee range: under 1° (so not printable in degrees) and under half a point of
    // its own range (0.0025). The march is flat and the ankle went backwards.
    const previous = new Map([
      [laneTrendKey(weak), { ...weak, romBest: 0.4 }],
      [laneTrendKey(strong), { ...strong, romBest: 0.95 - 0.15 / 60 }],
    ]);
    const out = laneRangeSummaries([weak, strong], previous);
    expect(rangeChange(out[1]).kind).toBe('same');
    expect(mostImprovedRange(out)).toBeNull();
  });

  it('still ranks a change that is real but only visible as a share of the range', () => {
    // +0.4° on a 60° range is 0.67 points: it rounds to 0° in the movement’s own units, but it is
    // over the half-point floor, so it is a real change said in the unit that can show it.
    const previous = new Map([[laneTrendKey(strong), { ...strong, romBest: 0.95 - 0.4 / 60 }]]);
    const out = laneRangeSummaries([strong], previous);
    const change = rangeChange(out[0]);
    expect(change.kind).toBe('up');
    expect(change.inUnits).toBe(false);
    expect(mostImprovedRange(out)?.movementName).toBe('Right Knee extension');
  });

  it('calls a drop a drop, so nothing green is drawn over a loss', () => {
    const previous = new Map([[laneTrendKey(weak), { ...weak, romBest: 0.8 }]]);
    expect(rangeChange(laneRangeSummaries([weak], previous)[0]).kind).toBe('down');
    expect(rangeChange({ gain: null, gainPct: null, unit: 'deg' }).kind).toBe('none');
  });
});
