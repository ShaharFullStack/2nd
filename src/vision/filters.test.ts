import { describe, expect, it } from 'vitest';
import { EmaFilter, OneEuroFilter, createFilter } from './filters.ts';

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
