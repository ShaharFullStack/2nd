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

  it('recycles round-robin when full instead of dropping the new one (O(1) per emit)', () => {
    const p = new ParticlePool(3);
    for (let i = 0; i < 3; i++) p.emit({ x: 0, y: 0, life: 1, size: 1, color: 10 + i });
    p.update(0.5);
    // Saturated: each further emit lands in the next slot and never drops the newcomer.
    for (let i = 0; i < 5; i++) {
      const slot = p.emit({ x: 0, y: 0, life: 1, size: 1, color: 90 + i });
      expect(slot).toBe(i % 3);
      expect(p.count).toBe(3);
      expect(p.color[slot]).toBe(90 + i);
      expect(p.age[slot]).toBe(0);
    }
  });

  it('setCapacity resizes the pool at runtime, keeping live particles and clamping the count', () => {
    const p = new ParticlePool(8);
    for (let i = 0; i < 8; i++) p.emit({ x: i, y: 0, life: 1, size: 1, color: i });
    expect(p.count).toBe(8);
    p.setCapacity(3);
    expect(p.capacity).toBe(3);
    expect(p.count).toBe(3);
    expect(p.x.length).toBe(3);
    expect(Array.from(p.x)).toEqual([0, 1, 2]);
    // Still usable (and still saturating at the new capacity).
    for (let i = 0; i < 6; i++) p.emit({ x: 99, y: 0, life: 1, size: 1, color: 5 });
    expect(p.count).toBe(3);
    // Growing keeps what is live and accepts more.
    p.setCapacity(10);
    expect(p.capacity).toBe(10);
    expect(p.count).toBe(3);
    p.emit({ x: 7, y: 0, life: 1, size: 1, color: 1 });
    expect(p.count).toBe(4);
    // A no-op patch does not reallocate.
    const xs = p.x;
    p.setCapacity(10);
    expect(p.x).toBe(xs);
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

  it('update ignores a NaN dt rather than poisoning every live particle', () => {
    const p = new ParticlePool(4);
    p.emit({ x: 5, y: 5, vx: 10, life: 1, size: 1, color: 0 });
    p.update(Number.NaN);
    expect(p.x[0]).toBe(5);
    expect(p.age[0]).toBe(0);
    expect(p.count).toBe(1);
    // ...and it keeps working afterwards.
    p.update(0.5);
    expect(p.age[0]).toBeCloseTo(0.5);
  });

  it('retires a particle whose age went non-finite instead of making it immortal', () => {
    // A NaN age used to fail `age >= life`, so the slot was never swap-removed: it held a pool slot
    // for the rest of the song and the round-robin recycler started eating live bursts.
    const p = new ParticlePool(64);
    p.emit({ x: 0, y: 0, life: 10, size: 1, color: 0 });
    p.emit({ x: 1, y: 1, life: 10, size: 1, color: 1 });
    p.age[0] = Number.NaN;
    p.update(0.016);
    expect(p.count).toBe(1);
    expect(p.color[0]).toBe(1);
    // The freed slot is reusable and no dead particle lingers: the pool drains back to the survivor.
    for (let i = 0; i < 50; i++) p.emit({ x: 0, y: 0, life: 0.01, size: 1, color: 2 });
    expect(p.count).toBe(51);
    p.update(0.05);
    expect(p.count).toBe(1);
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
      // Sparks are seeded on the gem's rim so they do not stack into one white disc over the
      // receptor; the ring and the streaks still start at the hit point itself.
      expect(Math.hypot(p.x[i] - 100, (p.y[i] - 200) / 0.72)).toBeLessThanOrEqual(20 * 0.72 + 1e-4);
      if (p.kind[i] === PARTICLE_RING) {
        rings++;
        expect(p.x[i]).toBe(100);
        expect(p.y[i]).toBe(200);
      }
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
