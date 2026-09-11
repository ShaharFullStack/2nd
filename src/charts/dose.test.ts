import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LANE_REST_SEC,
  MAX_LANE_REST_SEC,
  MIN_LANE_REST_SEC,
  chartDose,
  clampLaneRestSec,
  generateChartDetailed,
  limbRepsPerMinuteAt,
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

/**
 * A LIMB IS NOT A LANE, and the dose is prescribed per limb.
 *
 * `chartDose` reported the busiest LANE and the Setup screen printed it as "reps per minute, each
 * limb". Prescribe two movements on one leg — knee extension AND ankle dorsiflexion on the left,
 * which is an ordinary session — and that leg is asked for the sum of both lanes, so the figure the
 * therapist doses from was wrong by the number of lanes on the limb.
 */
describe('the dose is measured per LIMB, which may carry more than one lane', () => {
  it('adds the lanes on one limb together, and does not add another limb\'s in', () => {
    const chart = {
      lanes: 3,
      notes: [
        // left limb, lane 0: 3 reps; left limb, lane 1: 2 reps; right limb, lane 2: 4 reps
        { id: 1, lane: 0, time: 0 }, { id: 2, lane: 0, time: 20 }, { id: 3, lane: 0, time: 40 },
        { id: 4, lane: 1, time: 10 }, { id: 5, lane: 1, time: 50 },
        { id: 6, lane: 2, time: 5 }, { id: 7, lane: 2, time: 25 }, { id: 8, lane: 2, time: 45 },
        { id: 9, lane: 2, time: 55 },
      ],
    };
    const dose = chartDose(chart, ['left', 'left', 'right']);
    expect(dose.perLane).toEqual([3, 2, 4]);
    const left = dose.perLimb.find((l) => l.key === 'left');
    const right = dose.perLimb.find((l) => l.key === 'right');
    expect(left?.reps).toBe(5); // 3 + 2, the SUM of the lanes on that limb
    expect(left?.laneIndices).toEqual([0, 1]);
    expect(right?.reps).toBe(4);
    // 55 s of span, so the left limb's rate is 5 reps in 55 s and the right's 4 — and the reported
    // per-limb figure is the busiest LIMB's, which the per-lane figure (4, the busiest lane) is not.
    expect(dose.spanSec).toBeCloseTo(55, 9);
    expect(dose.repsPerBusiestLimb).toBe(5);
    expect(dose.lanesOnBusiestLimb).toBe(2);
    expect(dose.repsPerMinPerLimb).toBeCloseTo(5 / (55 / 60), 9);
    expect(dose.repsPerMinPerLane).toBeCloseTo(4 / (55 / 60), 9);
    expect(dose.repsPerMinPerLimb).toBeGreaterThan(dose.repsPerMinPerLane);
    // and the whole body is still the whole body
    expect(dose.totalRepsPerMin).toBeCloseTo(9 / (55 / 60), 9);
  });

  it('one lane per limb is the case where limb and lane agree', () => {
    const { chart } = generateChartDetailed(SONG, 2, 'medium', 1);
    const dose = chartDose(chart, ['left', 'right']);
    expect(dose.perLimb).toHaveLength(2);
    expect(dose.repsPerMinPerLimb).toBeCloseTo(dose.repsPerMinPerLane, 9);
    // and with no grouping at all every lane is its own limb, which is the same answer
    expect(chartDose(chart).repsPerMinPerLimb).toBeCloseTo(dose.repsPerMinPerLane, 9);
  });

  it('the pacing CEILING is per lane too, so a two-lane limb may be asked for twice it', () => {
    expect(limbRepsPerMinuteAt(1.2, 1)).toBeCloseTo(50, 9);
    expect(limbRepsPerMinuteAt(1.2, 2)).toBeCloseTo(100, 9);
    // a real two-lanes-on-one-limb chart never exceeds that ceiling, and does exceed the lane one
    const { chart } = generateChartDetailed(SONG, 3, 'hard', 2, { minLaneSpacingSec: 1.2 });
    const dose = chartDose(chart, ['left', 'left', 'right']);
    expect(dose.repsPerMinPerLimb).toBeLessThanOrEqual(limbRepsPerMinuteAt(1.2, 2) + 1e-6);
    expect(dose.repsPerMinPerLimb).toBeGreaterThan(repsPerMinuteAt(1.2));
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
