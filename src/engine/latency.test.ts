import { describe, expect, it } from 'vitest';
import { estimateLatency, mad, median, pairInputsToBeats } from './latency.ts';

describe('median / mad', () => {
  it('handles odd, even and empty', () => {
    expect(median([])).toBe(0);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(mad([1, 2, 3, 4, 100])).toBe(1);
  });
});

describe('estimateLatency', () => {
  it('computes the median offset and rejects outliers > 250 ms', () => {
    const pairs = [0.1, 0.12, 0.11, 0.13, 0.09, 0.1, 0.4, -0.3].map((d, i) => ({ expected: i, observed: i + d }));
    const est = estimateLatency(pairs);
    expect(est.offsetSec).toBeCloseTo(0.105, 9);
    expect(est.offsetMs).toBeCloseTo(105, 6);
    expect(est.samples).toBe(6);
    expect(est.rejected).toBe(2);
    expect(est.madSec).toBeCloseTo(0.01, 9);
    expect(est.confident).toBe(true);
  });
  it('is not confident with too few samples, high spread, or mostly outliers', () => {
    expect(estimateLatency([{ expected: 0, observed: 0.1 }]).confident).toBe(false);
    const noisy = [0.0, 0.2, 0.05, 0.18, 0.02, 0.15, 0.01].map((d, i) => ({ expected: i, observed: i + d }));
    expect(estimateLatency(noisy).confident).toBe(false);
    const mostlyBad = [0.1, 0.1, 0.1, 0.1, 0.1, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9].map((d, i) => ({ expected: i, observed: i + d }));
    const e = estimateLatency(mostlyBad);
    expect(e.samples).toBe(5);
    expect(e.confident).toBe(false);
    expect(estimateLatency([]).confident).toBe(false);
    expect(estimateLatency([]).offsetSec).toBe(0);
    expect(estimateLatency([{ expected: 0, observed: Number.NaN }]).rejected).toBe(1);
  });
  it('respects options', () => {
    const pairs = [0.3, 0.31, 0.29].map((d, i) => ({ expected: i, observed: i + d }));
    expect(estimateLatency(pairs).samples).toBe(0);
    const e = estimateLatency(pairs, { maxAbsSec: 0.5, minSamples: 3 });
    expect(e.samples).toBe(3);
    expect(e.confident).toBe(true);
    expect(e.offsetSec).toBeCloseTo(0.3);
  });
});

describe('pairInputsToBeats', () => {
  it('matches each beat with its nearest input, each input at most once', () => {
    const beats = [1, 2, 3, 4];
    const inputs = [1.1, 2.12, 2.5, 3.9, 6.0];
    const pairs = pairInputsToBeats(beats, inputs);
    expect(pairs).toEqual([
      { expected: 1, observed: 1.1 },
      { expected: 2, observed: 2.12 },
      { expected: 4, observed: 3.9 },
    ]);
  });
});
