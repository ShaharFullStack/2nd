import { describe, expect, it } from 'vitest';
import { DEFAULT_LANE_FILTER, EmaFilter, LowPassFilter, OneEuroFilter, createFilter, filterGroupDelaySec } from './filters.ts';

describe('filters', () => {
  it('EMA converges toward a constant input and starts at the first sample', () => {
    const f = new EmaFilter(0.5);
    expect(f.filter(10, 0)).toBe(10);
    f.filter(0, 1 / 30);
    expect(f.value).toBe(5);
    for (let i = 0; i < 40; i++) f.filter(0, i / 30);
    expect(Math.abs(f.value)).toBeLessThan(1e-6);
  });

  it('OneEuro smooths jitter at rest but follows fast movement', () => {
    const slow = new OneEuroFilter({ minCutoff: 1, beta: 0 });
    const adaptive = new OneEuroFilter({ minCutoff: 1, beta: 0.5 });
    let noisyVar = 0;
    let filtVar = 0;
    for (let i = 0; i < 300; i++) {
      const t = i / 30;
      const noise = (i % 2 ? 1 : -1) * 0.05;
      noisyVar += noise * noise;
      const y = slow.filter(0.5 + noise, t) - 0.5;
      if (i > 60) filtVar += y * y;
    }
    expect(filtVar).toBeLessThan(noisyVar * 0.2);
    // Step response: adaptive (beta>0) reaches the new level faster.
    for (let i = 0; i < 10; i++) {
      slow.filter(0, i / 30);
      adaptive.filter(0, i / 30);
    }
    let vs = 0;
    let va = 0;
    for (let i = 10; i < 14; i++) {
      vs = slow.filter(1, i / 30);
      va = adaptive.filter(1, i / 30);
    }
    expect(va).toBeGreaterThan(vs);
    expect(va).toBeGreaterThan(0.5);
  });

  it('OneEuro tolerates duplicate timestamps and reset', () => {
    const f = new OneEuroFilter();
    f.filter(1, 0);
    expect(Number.isFinite(f.filter(2, 0))).toBe(true);
    f.reset();
    expect(f.filter(7, 5)).toBe(7);
  });

  it('createFilter builds each kind', () => {
    expect(createFilter({ kind: 'ema', alpha: 0.3 })).toBeInstanceOf(EmaFilter);
    expect(createFilter({ kind: 'oneEuro', minCutoff: 1, beta: 0 })).toBeInstanceOf(OneEuroFilter);
    expect(createFilter({ kind: 'none' }).filter(3, 0)).toBe(3);
  });
});

describe('lane filters (unit-free)', () => {
  it('EMA / low-pass commute with an affine normalization (unit-free): degrees and ratios get the same delay', () => {
    const deg = createFilter({ kind: 'ema', alpha: 0.5 });
    const ratio = createFilter({ kind: 'ema', alpha: 0.5 });
    for (let i = 0; i < 60; i++) {
      const t = i / 30;
      const v = 0.5 * (1 - Math.cos(t * 4)); // 0..1 bump
      const a = deg.filter(90 + 60 * v, t); // degrees
      const b = ratio.filter(0.1 + 0.3 * v, t); // ratio
      expect((a - 90) / 60).toBeCloseTo((b - 0.1) / 0.3, 9);
    }
  });

  it('filterGroupDelaySec: EMA 0.5 = 1 frame; low-pass = 1/(2*pi*fc); none = 0', () => {
    expect(filterGroupDelaySec({ kind: 'ema', alpha: 0.5 }, 30)).toBeCloseTo(1 / 30, 9);
    expect(filterGroupDelaySec({ kind: 'ema', alpha: 0.25 }, 30)).toBeCloseTo(3 / 30, 9);
    expect(filterGroupDelaySec({ kind: 'lowpass', cutoffHz: 4.8 }, 30)).toBeCloseTo(1 / (2 * Math.PI * 4.8), 9);
    expect(filterGroupDelaySec({ kind: 'none' }, 30)).toBe(0);
    expect(DEFAULT_LANE_FILTER).toEqual({ kind: 'ema', alpha: 0.5 });
  });

  it('LowPassFilter is frame-rate independent and tolerates duplicate timestamps', () => {
    const f30 = new LowPassFilter(3);
    const f60 = new LowPassFilter(3);
    for (let i = 0; i <= 60; i++) f30.filter(1, i / 30);
    for (let i = 0; i <= 120; i++) f60.filter(1, i / 60);
    // Both start at 1 (first sample) and stay there.
    expect(f30.value).toBeCloseTo(1, 6);
    expect(f60.value).toBeCloseTo(1, 6);
    const s30 = new LowPassFilter(3);
    const s60 = new LowPassFilter(3);
    s30.filter(0, 0);
    s60.filter(0, 0);
    for (let i = 1; i <= 15; i++) s30.filter(1, i / 30);
    for (let i = 1; i <= 30; i++) s60.filter(1, i / 60);
    expect(Math.abs(s30.value - s60.value)).toBeLessThan(0.05); // same 0.5 s step response
    expect(Number.isFinite(s30.filter(1, 0.5))).toBe(true); // non-monotonic timestamp
    s30.reset();
    expect(s30.filter(4, 9)).toBe(4);
    expect(createFilter({ kind: 'lowpass', cutoffHz: 2 })).toBeInstanceOf(LowPassFilter);
  });
});
