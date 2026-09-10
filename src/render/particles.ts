/**
 * Fixed-capacity particle pool (structure of arrays). Zero allocation after construction:
 * emit() writes into free slots, update() compacts by swapping dead particles to the tail.
 */

export type ParticleKind = 0 | 1 | 2;
export const PARTICLE_SPARK: ParticleKind = 0; // small glowing dot, gravity, fades
export const PARTICLE_RING: ParticleKind = 1; // expanding ring shockwave
export const PARTICLE_STREAK: ParticleKind = 2; // elongated spark along its velocity

export interface EmitOptions {
  x: number;
  y: number;
  /** Velocity (px/s). */
  vx?: number;
  vy?: number;
  /** Lifetime in seconds. */
  life: number;
  /** Start size (px, radius). */
  size: number;
  /** Size at end of life (px). Defaults to `size`. */
  endSize?: number;
  /** Colour index into the caller's colour table (kept as a number so the pool stays allocation-free). */
  color: number;
  kind?: ParticleKind;
  /** Gravity (px/s^2) applied to vy. */
  gravity?: number;
  /** Velocity damping per second (0 = none, 1 = strong). */
  drag?: number;
  /** Start alpha. */
  alpha?: number;
}

export class ParticlePool {
  capacity: number;
  private n = 0;
  /** Round-robin recycle cursor used when the pool is saturated (O(1) per emit). */
  private cursor = 0;
  x: Float32Array;
  y: Float32Array;
  vx: Float32Array;
  vy: Float32Array;
  age: Float32Array;
  life: Float32Array;
  size: Float32Array;
  endSize: Float32Array;
  gravity: Float32Array;
  drag: Float32Array;
  alpha: Float32Array;
  color: Uint16Array;
  kind: Uint8Array;

  constructor(capacity: number) {
    this.capacity = Math.max(1, Math.floor(capacity));
    const c = this.capacity;
    this.x = new Float32Array(c);
    this.y = new Float32Array(c);
    this.vx = new Float32Array(c);
    this.vy = new Float32Array(c);
    this.age = new Float32Array(c);
    this.life = new Float32Array(c);
    this.size = new Float32Array(c);
    this.endSize = new Float32Array(c);
    this.gravity = new Float32Array(c);
    this.drag = new Float32Array(c);
    this.alpha = new Float32Array(c);
    this.color = new Uint16Array(c);
    this.kind = new Uint8Array(c);
  }

  /** Number of live particles. */
  get count(): number {
    return this.n;
  }

  /**
   * Change the pool capacity at runtime (therapist "calmer effects" control). Reallocates the
   * backing arrays once and keeps the first `min(count, capacity)` live particles; a no-op when the
   * capacity is unchanged, so it is safe to call from a `setOptions()` patch that doesn't touch it.
   */
  setCapacity(capacity: number): void {
    const c = Math.max(1, Math.floor(capacity));
    if (c === this.capacity) return;
    const keep = Math.min(this.n, c);
    const grow = <T extends Float32Array | Uint16Array | Uint8Array>(src: T, make: (n: number) => T): T => {
      const dst = make(c);
      for (let i = 0; i < keep; i++) dst[i] = src[i];
      return dst;
    };
    const f32 = (n: number): Float32Array => new Float32Array(n);
    this.x = grow(this.x, f32);
    this.y = grow(this.y, f32);
    this.vx = grow(this.vx, f32);
    this.vy = grow(this.vy, f32);
    this.age = grow(this.age, f32);
    this.life = grow(this.life, f32);
    this.size = grow(this.size, f32);
    this.endSize = grow(this.endSize, f32);
    this.gravity = grow(this.gravity, f32);
    this.drag = grow(this.drag, f32);
    this.alpha = grow(this.alpha, f32);
    this.color = grow(this.color, (n) => new Uint16Array(n));
    this.kind = grow(this.kind, (n) => new Uint8Array(n));
    this.capacity = c;
    this.n = keep;
    this.cursor = 0;
  }

  /**
   * Spawn a particle. When the pool is saturated the slot under a round-robin cursor is recycled,
   * so a burst never silently vanishes and an emit is always O(1) (a scan for the particle closest
   * to death costs O(capacity) *per emit*, i.e. ~60k iterations for four simultaneous bursts into a
   * full 600-slot pool). Returns the slot index.
   */
  emit(o: EmitOptions): number {
    let i: number;
    if (this.n < this.capacity) {
      i = this.n++;
    } else {
      i = this.cursor;
      this.cursor = (this.cursor + 1) % this.capacity;
    }
    this.x[i] = o.x;
    this.y[i] = o.y;
    this.vx[i] = o.vx ?? 0;
    this.vy[i] = o.vy ?? 0;
    this.age[i] = 0;
    this.life[i] = Math.max(0.001, o.life);
    this.size[i] = o.size;
    this.endSize[i] = o.endSize ?? o.size;
    this.gravity[i] = o.gravity ?? 0;
    this.drag[i] = o.drag ?? 0;
    this.alpha[i] = o.alpha ?? 1;
    this.color[i] = o.color;
    this.kind[i] = o.kind ?? PARTICLE_SPARK;
    return i;
  }

  /**
   * Advance all particles by dt seconds, removing dead ones (order not preserved). A non-finite
   * `dt` is ignored entirely, and any particle whose age has become non-finite is retired rather
   * than kept: the comparisons are written so that NaN takes the *remove* branch. (A NaN age used
   * to make a particle immortal — never swap-removed, permanently holding a pool slot until the
   * round-robin recycler started cannibalising live bursts.)
   */
  update(dt: number): void {
    if (!(dt > 0)) return;
    let i = 0;
    while (i < this.n) {
      const a = this.age[i] + dt;
      if (!(a < this.life[i])) {
        this.swapRemove(i);
        continue;
      }
      this.age[i] = a;
      const damp = this.drag[i] > 0 ? Math.max(0, 1 - this.drag[i] * dt) : 1;
      this.vy[i] += this.gravity[i] * dt;
      this.vx[i] *= damp;
      this.vy[i] *= damp;
      this.x[i] += this.vx[i] * dt;
      this.y[i] += this.vy[i] * dt;
      i++;
    }
  }

  /** Life progress 0..1 for slot i. */
  progress(i: number): number {
    return this.age[i] / this.life[i];
  }

  /** Current size for slot i (linear interpolation size → endSize). */
  sizeAt(i: number): number {
    const t = this.progress(i);
    return this.size[i] + (this.endSize[i] - this.size[i]) * t;
  }

  /** Current alpha for slot i (fades out over the last 60% of life). */
  alphaAt(i: number): number {
    const t = this.progress(i);
    const fade = t < 0.4 ? 1 : 1 - (t - 0.4) / 0.6;
    return this.alpha[i] * Math.max(0, fade);
  }

  clear(): void {
    this.n = 0;
    this.cursor = 0;
  }

  private swapRemove(i: number): void {
    const last = this.n - 1;
    if (i !== last) {
      this.x[i] = this.x[last];
      this.y[i] = this.y[last];
      this.vx[i] = this.vx[last];
      this.vy[i] = this.vy[last];
      this.age[i] = this.age[last];
      this.life[i] = this.life[last];
      this.size[i] = this.size[last];
      this.endSize[i] = this.endSize[last];
      this.gravity[i] = this.gravity[last];
      this.drag[i] = this.drag[last];
      this.alpha[i] = this.alpha[last];
      this.color[i] = this.color[last];
      this.kind[i] = this.kind[last];
    }
    this.n = last;
  }
}

/** Tiny deterministic PRNG (mulberry32) for particle scatter and the demo. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Emit a Guitar-Hero style hit burst: radial sparks + a few streaks + a shockwave ring.
 * `intensity` scales both the count and the speed of the debris (0 → ring only), which is what the
 * renderer's `effectIntensity` option dials for a calmer clinical presentation.
 */
export function emitHitBurst(
  pool: ParticlePool,
  rng: () => number,
  x: number,
  y: number,
  radius: number,
  color: number,
  intensity = 1,
): void {
  const sparks = Math.max(0, Math.round(20 * intensity));
  for (let i = 0; i < sparks; i++) {
    const ang = rng() * Math.PI * 2;
    const speed = radius * (6 + rng() * 10) * intensity;
    pool.emit({
      x,
      y,
      vx: Math.cos(ang) * speed,
      vy: Math.sin(ang) * speed * 0.6 - radius * 4,
      life: 0.35 + rng() * 0.35,
      size: radius * (0.12 + rng() * 0.16),
      endSize: 0,
      color,
      gravity: radius * 18,
      drag: 1.5,
      kind: PARTICLE_SPARK,
    });
  }
  const streaks = Math.max(0, Math.round(7 * intensity));
  for (let i = 0; i < streaks; i++) {
    const ang = -Math.PI / 2 + (rng() - 0.5) * 1.6;
    const speed = radius * (14 + rng() * 10) * intensity;
    pool.emit({
      x,
      y,
      vx: Math.cos(ang) * speed,
      vy: Math.sin(ang) * speed,
      life: 0.22 + rng() * 0.2,
      size: radius * 0.1,
      endSize: 0,
      color,
      drag: 2.5,
      kind: PARTICLE_STREAK,
    });
  }
  pool.emit({
    x,
    y,
    life: 0.32,
    size: radius * 0.8,
    endSize: radius * (2.6 + intensity),
    color,
    alpha: 0.9,
    kind: PARTICLE_RING,
  });
}
