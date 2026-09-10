import { describe, expect, it } from 'vitest';
import type { ScoreResults } from '../engine/scoring.ts';
import type { LaneRepStats, RunSummary } from './GameRunner.ts';
import { buildSessionResult, formatDuration, formatMs, formatPercent } from './results.ts';
import type { SessionConfig } from './types.ts';

const CONFIG: SessionConfig = {
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
    expect(r.lanes[0].label).toContain('L');
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
 * THE LABEL IS THE LANE'S NAME EVERYWHERE DOWNSTREAM — the Results per-movement table, the History
 * table and the trend card title all read it back. It has to name the digit that was prescribed.
 */
describe('the stored per-lane label', () => {
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
    expect(r.lanes.map((l) => l.label)).toEqual(['L index pinch', 'L little pinch']);
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
    expect(r.lanes[0].label).toBe('R index pinch');
    expect(r.lanes[0].fingertip).toBe('index');
    // A movement with no fingertip dimension is untouched.
    expect(r.lanes[1].label).toBe('R open hand');
    expect(r.lanes[1].fingertip).toBeUndefined();
  });
});
