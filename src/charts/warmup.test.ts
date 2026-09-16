/**
 * THE OPENING BARS ARE SPARSE WHEN THE APP DOES NOT YET KNOW THE PATIENT'S RANGE.
 *
 * On the in-song calibration path (session/inSongCalibration.ts) the first seconds of the song are
 * where the range of motion is learned, from the movements the patient makes. The patient therefore
 * has to be MOVING — hiding the notes would learn nothing — but they must be asked for far less,
 * far further apart, so that an opening they have not found the movement for yet does not teach them
 * in ten seconds that they cannot do this.
 *
 * And the dose the setup screen prints is measured from the chart this produces, so the thinning is
 * stated rather than discovered.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_LANE_REST_SEC, chartDose, generateChartDetailed } from './generate.ts';
import type { SongGrid } from './generate.ts';
import { WARMUP_LANE_REST_MULTIPLIER, WARMUP_SEC } from '../session/inSongCalibration.ts';

const SONG: SongGrid = { id: 'warm', bpm: 120, offset: 0, durationSec: 180 };
const WARMUP_LANE_REST = DEFAULT_LANE_REST_SEC * WARMUP_LANE_REST_MULTIPLIER;

const opts = { minLaneSpacingSec: DEFAULT_LANE_REST_SEC, warmupSec: WARMUP_SEC, warmupLaneRestSec: WARMUP_LANE_REST };

/** Smallest gap between two notes of ONE lane inside `[0, until)`. */
function tightestLaneGap(notes: readonly { lane: number; time: number }[], until: number): number {
  const last = new Map<number, number>();
  let worst = Infinity;
  for (const n of notes) {
    if (n.time >= until) continue;
    const prev = last.get(n.lane);
    if (prev !== undefined) worst = Math.min(worst, n.time - prev);
    last.set(n.lane, n.time);
  }
  return worst;
}

describe('the warm-up opening of a chart', () => {
  it('asks each lane for a repetition no more often than the warm-up pacing', () => {
    const r = generateChartDetailed(SONG, 4, 'medium', 7, opts);
    expect(tightestLaneGap(r.chart.notes, WARMUP_SEC)).toBeGreaterThanOrEqual(WARMUP_LANE_REST - 1e-6);
  });

  it('is markedly sparser than the same chart without a warm-up, and only in the opening', () => {
    const warm = generateChartDetailed(SONG, 4, 'medium', 7, opts);
    const plain = generateChartDetailed(SONG, 4, 'medium', 7, { minLaneSpacingSec: DEFAULT_LANE_REST_SEC });
    const inOpening = (notes: readonly { time: number }[]) => notes.filter((n) => n.time < WARMUP_SEC).length;
    expect(inOpening(warm.chart.notes)).toBeLessThan(inOpening(plain.chart.notes));
    // Not empty: the patient has to be moving for anything to be learned from them.
    expect(inOpening(warm.chart.notes)).toBeGreaterThan(0);
    // And the rest of the song is untouched — the prescription is the prescription.
    const after = (notes: readonly { time: number }[]) => notes.filter((n) => n.time >= WARMUP_SEC).map((n) => n.time);
    expect(after(warm.chart.notes)).toEqual(after(plain.chart.notes));
  });

  it('says so in the warnings rather than quietly under-delivering reps', () => {
    const r = generateChartDetailed(SONG, 4, 'medium', 7, opts);
    expect(r.warnings.join(' ')).toMatch(/warm-up: \d+ note\(s\) removed from the first 12s/);
  });

  it('measures the dose from the chart it actually produced, thinning included', () => {
    const warm = generateChartDetailed(SONG, 4, 'medium', 7, opts);
    const dose = chartDose(warm.chart);
    const total = dose.perLane.reduce((n, reps) => n + reps, 0);
    expect(total).toBe(warm.chart.notes.length);
  });

  it('keeps every note id contiguous after the thinning — ids are the judge’s index', () => {
    const r = generateChartDetailed(SONG, 4, 'medium', 7, opts);
    expect(r.chart.notes.map((n) => n.id)).toEqual(r.chart.notes.map((_, i) => i));
  });

  it('changes nothing at all when no warm-up is asked for (the measured path)', () => {
    const a = generateChartDetailed(SONG, 4, 'medium', 7, { minLaneSpacingSec: DEFAULT_LANE_REST_SEC });
    const b = generateChartDetailed(SONG, 4, 'medium', 7, { minLaneSpacingSec: DEFAULT_LANE_REST_SEC, warmupSec: 0 });
    expect(b.chart.notes).toEqual(a.chart.notes);
    expect(b.warnings.join(' ')).not.toMatch(/warm-up/);
  });
});
