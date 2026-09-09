import { describe, expect, it } from 'vitest';
import { PARTICLE_RING, PARTICLE_SPARK, ParticlePool, emitHitBurst, makeRng } from './particles';

describe('ParticlePool', () => {
  it('starts empty with the requested capacity', () => {
    const p = new ParticlePool(16);
    expect(p.capacity).toBe(16);
    expect(p.count).toBe(0);
  });

  it('emit fills slots and update integrates motion', () => {
    const p = new ParticlePool(8);
    const i = p.emit({ x: 10, y: 20, vx: 100, vy: -50, life: 1, size: 4, color: 1 });
    expect(i).toBe(0);
    expect(p.count).toBe(1);
    p.update(0.1);
    expect(p.x[0]).toBeCloseTo(20);
    expect(p.y[0]).toBeCloseTo(15);
    expect(p.age[0]).toBeCloseTo(0.1);
  });

  it('gravity and drag affect velocity', () => {
    const p = new ParticlePool(8);
    p.emit({ x: 0, y: 0, vx: 100, vy: 0, life: 2, size: 1, color: 0, gravity: 100, drag: 0.5 });
    p.update(0.1);
    expect(p.vy[0]).toBeGreaterThan(0);
    expect(p.vx[0]).toBeLessThan(100);
  });

  it('removes dead particles and compacts (order not preserved)', () => {
    const p = new ParticlePool(8);
    p.emit({ x: 1, y: 0, life: 0.1, size: 1, color: 1 });
    p.emit({ x: 2, y: 0, life: 1.0, size: 1, color: 2 });
    p.emit({ x: 3, y: 0, life: 0.1, size: 1, color: 3 });
    p.update(0.2);
    expect(p.count).toBe(1);
    expect(p.color[0]).toBe(2);
    expect(p.x[0]).toBe(2);
  });

  it('recycles the oldest particle when full instead of dropping the new one', () => {
    const p = new ParticlePool(3);
    p.emit({ x: 0, y: 0, life: 1, size: 1, color: 10 });
    p.emit({ x: 0, y: 0, life: 1, size: 1, color: 11 });
    p.emit({ x: 0, y: 0, life: 1, size: 1, color: 12 });
    p.update(0.5); // all at 50%
    p.age[1] = 0.9; // make slot 1 the oldest
    const slot = p.emit({ x: 0, y: 0, life: 1, size: 1, color: 99 });
    expect(slot).toBe(1);
    expect(p.count).toBe(3);
    expect(p.color[1]).toBe(99);
    expect(p.age[1]).toBe(0);
  });

  it('does not allocate arrays after construction (typed arrays are stable)', () => {
    const p = new ParticlePool(4);
    const xs = p.x;
    for (let i = 0; i < 20; i++) p.emit({ x: i, y: 0, life: 0.05, size: 1, color: 0 });
    p.update(0.1);
    expect(p.x).toBe(xs);
    expect(p.count).toBe(0);
  });

  it('interpolates size and alpha over life', () => {
    const p = new ParticlePool(2);
    p.emit({ x: 0, y: 0, life: 1, size: 10, endSize: 0, color: 0, alpha: 1 });
    expect(p.sizeAt(0)).toBe(10);
    expect(p.alphaAt(0)).toBe(1);
    p.update(0.5);
    expect(p.sizeAt(0)).toBeCloseTo(5);
    expect(p.alphaAt(0)).toBeLessThan(1);
    expect(p.alphaAt(0)).toBeGreaterThan(0);
    p.update(0.49);
    expect(p.alphaAt(0)).toBeLessThan(0.05);
  });

  it('clear() empties the pool', () => {
    const p = new ParticlePool(4);
    p.emit({ x: 0, y: 0, life: 1, size: 1, color: 0 });
    p.clear();
    expect(p.count).toBe(0);
  });

  it('update ignores non-positive dt', () => {
    const p = new ParticlePool(4);
    p.emit({ x: 5, y: 5, vx: 10, life: 1, size: 1, color: 0 });
    p.update(0);
    p.update(-1);
    expect(p.x[0]).toBe(5);
  });
});

describe('emitHitBurst', () => {
  it('spawns sparks, streaks and exactly one ring with the lane colour', () => {
    const p = new ParticlePool(256);
    emitHitBurst(p, makeRng(1), 100, 200, 20, 3, 1);
    expect(p.count).toBeGreaterThan(15);
    let rings = 0;
    let sparks = 0;
    for (let i = 0; i < p.count; i++) {
      expect(p.color[i]).toBe(3);
      expect(p.x[i]).toBe(100);
      expect(p.y[i]).toBe(200);
      if (p.kind[i] === PARTICLE_RING) rings++;
      if (p.kind[i] === PARTICLE_SPARK) sparks++;
    }
    expect(rings).toBe(1);
    expect(sparks).toBeGreaterThan(5);
  });

  it('is deterministic for a given rng seed', () => {
    const a = new ParticlePool(256);
    const b = new ParticlePool(256);
    emitHitBurst(a, makeRng(7), 0, 0, 10, 0);
    emitHitBurst(b, makeRng(7), 0, 0, 10, 0);
    expect(Array.from(a.vx.slice(0, a.count))).toEqual(Array.from(b.vx.slice(0, b.count)));
  });
});

describe('makeRng', () => {
  it('yields values in [0,1) and is reproducible', () => {
    const r1 = makeRng(123);
    const r2 = makeRng(123);
    for (let i = 0; i < 100; i++) {
      const v = r1();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      expect(v).toBe(r2());
    }
  });
});
