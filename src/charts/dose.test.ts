import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LANE_REST_SEC,
  MAX_LANE_REST_SEC,
  MIN_LANE_REST_SEC,
  chartDose,
  clampLaneRestSec,
  generateChartDetailed,
  repsPerMinuteAt,
} from './generate.ts';
import type { SongGrid } from './generate.ts';

/** The demo song's grid: the one the Setup screen's dose figures are quoted from. */
const SONG: SongGrid = { id: 'demo', bpm: 120, offset: 0, durationSec: 97 };

describe('the therapeutic dose is measurable before the session starts', () => {
  it('counts the reps each lane is asked for and the rate they are asked at', () => {
    const { chart } = generateChartDetailed(SONG, 2, 'medium', 1);
    const dose = chartDose(chart);
    expect(dose.notes).toBe(chart.notes.length);
    expect(dose.perLane).toHaveLength(2);
    expect(dose.perLane[0] + dose.perLane[1]).toBe(dose.notes);
    expect(dose.repsPerLane).toBeCloseTo(dose.notes / 2, 9);
    // the rate is the thing a therapist prescribes, and it is a real per-minute figure
    expect(dose.repsPerMinPerLane).toBeGreaterThan(0);
    expect(dose.totalRepsPerMin).toBeGreaterThan(dose.repsPerMinPerLane);
    expect(dose.spanSec).toBeGreaterThan(60);
    expect(dose.minLaneGapSec).toBeGreaterThan(0);
  });

  it('is empty-safe and lane-range-safe (a dose panel must never throw at a therapist)', () => {
    const empty = chartDose({ notes: [], lanes: 2 });
    expect(empty).toMatchObject({ notes: 0, repsPerLane: 0, repsPerMinPerLane: 0, totalRepsPerMin: 0, spanSec: 0 });
    expect(empty.minLaneGapSec).toBe(Infinity);
    const stray = chartDose({ notes: [{ id: 1, lane: 7, time: 1 }, { id: 2, lane: 0, time: 2 }], lanes: 2 });
    expect(stray.notes).toBe(2);
    expect(stray.perLane).toEqual([1, 0]); // the out-of-range note is counted overall, not misfiled
  });
});

describe('the pacing floor is a therapist control, not a difficulty side effect', () => {
  it('clamps to a safe range and converts to the reps-per-minute a therapist prescribes in', () => {
    expect(clampLaneRestSec(Number.NaN)).toBe(DEFAULT_LANE_REST_SEC);
    expect(clampLaneRestSec(0)).toBe(MIN_LANE_REST_SEC);
    expect(clampLaneRestSec(999)).toBe(MAX_LANE_REST_SEC);
    expect(repsPerMinuteAt(1.2)).toBeCloseTo(50, 9);
    expect(repsPerMinuteAt(2)).toBeCloseTo(30, 9);
  });

  it('actually moves the dose: a longer rest means fewer, slower reps at the SAME difficulty', () => {
    const fast = chartDose(generateChartDetailed(SONG, 2, 'medium', 1, { minLaneSpacingSec: 0.6 }).chart);
    const safe = chartDose(generateChartDetailed(SONG, 2, 'medium', 1, { minLaneSpacingSec: DEFAULT_LANE_REST_SEC }).chart);
    const slow = chartDose(generateChartDetailed(SONG, 2, 'medium', 1, { minLaneSpacingSec: 2.5 }).chart);
    expect(safe.notes).toBeLessThan(fast.notes);
    expect(slow.notes).toBeLessThan(safe.notes);
    expect(slow.repsPerMinPerLane).toBeLessThan(safe.repsPerMinPerLane);
    // and the floor is honoured: no lane is ever asked for two reps closer than the prescription
    expect(safe.minLaneGapSec).toBeGreaterThanOrEqual(DEFAULT_LANE_REST_SEC - 1e-9);
    expect(slow.minLaneGapSec).toBeGreaterThanOrEqual(2.5 - 1e-9);
  });

  it('the default is the physiological one (50 reps/min per limb), not the medium preset', () => {
    expect(DEFAULT_LANE_REST_SEC).toBe(1.2);
    const dose = chartDose(generateChartDetailed(SONG, 2, 'medium', 1, { minLaneSpacingSec: DEFAULT_LANE_REST_SEC }).chart);
    expect(dose.repsPerMinPerLane).toBeLessThanOrEqual(repsPerMinuteAt(DEFAULT_LANE_REST_SEC) + 1e-6);
  });
});
