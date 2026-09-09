import { describe, expect, it } from 'vitest';
import { clickSchedule, computeLatencyResult, matchInputsToClicks, median, robustStats } from './latencyProbe';

describe('robustStats', () => {
  it('median handles odd, even and empty inputs', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(Number.isNaN(median([]))).toBe(true);
  });
  it('computes median / MAD / sigma and ignores an outlier', () => {
    const s = robustStats([120, 118, 125, 122, 400, 119, 121]);
    expect(s.n).toBe(7);
    expect(s.medianMs).toBe(121);
    expect(s.madMs).toBe(2); // deviations: 1,3,4,1,279,2,0 → sorted 0,1,1,2,3,4,279 → median 2
    expect(s.sigmaMs).toBeCloseTo(2.9652, 3);
    expect(s.minMs).toBe(118);
    expect(s.maxMs).toBe(400);
    expect(s.meanMs).toBeCloseTo(160.71, 1);
  });
  it('returns NaN stats for no samples', () => {
    const s = robustStats([]);
    expect(s.n).toBe(0);
    expect(Number.isNaN(s.medianMs)).toBe(true);
  });
});

describe('clickSchedule', () => {
  it('spaces clicks by 60/bpm from the start time', () => {
    const c = clickSchedule(10, 100, 4);
    expect(c).toHaveLength(4);
    expect(c[0]).toBe(10);
    expect(c[1]).toBeCloseTo(10.6, 9);
    expect(c[3]).toBeCloseTo(11.8, 9);
  });
});

describe('matchInputsToClicks', () => {
  const clicks = clickSchedule(0, 100, 8); // every 0.6 s

  it('pairs each click with its closest input and reports latency as input − click', () => {
    const inputs = clicks.map((t) => t + 0.15);
    const m = matchInputsToClicks(clicks, inputs, 0.27);
    expect(m.matched).toBe(8);
    expect(m.unmatchedClicks).toBe(0);
    expect(m.spurious).toBe(0);
    for (const o of m.offsetsSec) expect(o).toBeCloseTo(0.15, 9);
  });

  it('leaves clicks unmatched when the patient skips a beat and flags extra inputs', () => {
    const inputs = [0.1, 0.7, /* beat 2 skipped */ 1.9, 2.5, 2.55, 3.1, 3.7, 4.3];
    const m = matchInputsToClicks(clicks, inputs, 0.27);
    expect(m.matched).toBe(7);
    expect(m.unmatchedClicks).toBe(1);
    expect(m.spurious).toBe(1);
    expect(m.offsetsSec[0]).toBeCloseTo(0.1, 9);
    expect(m.offsetsSec[3]).toBeCloseTo(0.1, 9); // 2.5 wins over 2.55 for the click at 2.4
  });

  it('uses each input once (closest pairs first)', () => {
    const m = matchInputsToClicks([0, 0.6], [0.5], 0.5);
    expect(m.matched).toBe(1);
    expect(m.offsetsSec).toEqual([-0.09999999999999998]);
  });
});

describe('computeLatencyResult', () => {
  const clicks = clickSchedule(5, 100, 16);
  const opts = { matchWindowSec: 0.27, minMatched: 8, maxMadMs: 60 };

  it('accepts a consistent patient and returns the median offset in seconds', () => {
    const jitter = [0.01, -0.005, 0.012, 0, -0.008, 0.004, 0.009, -0.011, 0.002, 0.006, -0.003, 0.007, -0.002, 0.005, 0.001, -0.006];
    const inputs = clicks.map((t, i) => t + 0.14 + jitter[i]);
    const r = computeLatencyResult(clicks, inputs, opts);
    expect(r.accepted).toBe(true);
    expect(r.matched).toBe(16);
    expect(r.totalClicks).toBe(16);
    expect(r.offsetSec).toBeCloseTo(0.14, 2);
    expect(Math.abs(r.medianMs - 140)).toBeLessThan(3);
    expect(r.madMs).toBeLessThan(10);
    expect(r.samplesMs).toHaveLength(16);
  });

  it('rejects when too few beats were matched or the jitter is too large', () => {
    const few = computeLatencyResult(clicks, clicks.slice(0, 3).map((t) => t + 0.1), opts);
    expect(few.accepted).toBe(false);
    expect(few.matched).toBe(3);
    const noisy = computeLatencyResult(clicks, clicks.map((t, i) => t + (i % 2 === 0 ? 0.02 : 0.25)), opts);
    expect(noisy.accepted).toBe(false);
    expect(noisy.madMs).toBeGreaterThan(60);
  });

  it('handles no inputs without throwing', () => {
    const r = computeLatencyResult(clicks, [], opts);
    expect(r.accepted).toBe(false);
    expect(r.matched).toBe(0);
    expect(r.offsetSec).toBe(0);
    expect(r.unmatchedClicks).toBe(16);
  });
});
