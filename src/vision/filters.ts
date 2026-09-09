/** Signal smoothing for noisy per-frame features. */

export interface ScalarFilter {
  /** Feed a sample at time `tSec` (seconds, monotonic). Returns the smoothed value. */
  filter(value: number, tSec: number): number;
  /** Last smoothed value (NaN before the first sample). */
  readonly value: number;
  reset(): void;
}

function smoothingFactor(cutoffHz: number, dtSec: number): number {
  const r = 2 * Math.PI * cutoffHz * dtSec;
  return r / (r + 1);
}

/**
 * One Euro filter (Casiez et al. 2012). Low `minCutoff` = smoother at rest; `beta` scales the cutoff with
 * speed so fast movements track with little lag.
 */
export class OneEuroFilter implements ScalarFilter {
  minCutoff: number;
  beta: number;
  dCutoff: number;
  private x = NaN;
  private dx = 0;
  private t = NaN;

  constructor(opts: { minCutoff?: number; beta?: number; dCutoff?: number } = {}) {
    this.minCutoff = opts.minCutoff ?? 1;
    this.beta = opts.beta ?? 0;
    this.dCutoff = opts.dCutoff ?? 1;
  }

  get value(): number {
    return this.x;
  }

  reset(): void {
    this.x = NaN;
    this.dx = 0;
    this.t = NaN;
  }

  filter(value: number, tSec: number): number {
    if (Number.isNaN(this.x) || !(tSec > this.t)) {
      if (Number.isNaN(this.x)) {
        this.x = value;
        this.dx = 0;
        this.t = tSec;
        return value;
      }
      // Non-monotonic / duplicate timestamp: treat as one nominal frame (1/30 s).
      tSec = this.t + 1 / 30;
    }
    const dt = tSec - this.t;
    this.t = tSec;
    const dxRaw = (value - this.x) / dt;
    const aD = smoothingFactor(this.dCutoff, dt);
    this.dx = aD * dxRaw + (1 - aD) * this.dx;
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    const a = smoothingFactor(cutoff, dt);
    this.x = a * value + (1 - a) * this.x;
    return this.x;
  }
}

/** Exponential moving average: x = alpha*value + (1-alpha)*x. alpha ~0.5 at 30 fps is a good default. */
export class EmaFilter implements ScalarFilter {
  alpha: number;
  private x = NaN;

  constructor(alpha = 0.5) {
    this.alpha = Math.min(1, Math.max(0, alpha));
  }

  get value(): number {
    return this.x;
  }

  reset(): void {
    this.x = NaN;
  }

  filter(value: number, _tSec: number): number {
    this.x = Number.isNaN(this.x) ? value : this.alpha * value + (1 - this.alpha) * this.x;
    return this.x;
  }
}

/**
 * First-order low-pass with a fixed cutoff in Hz (frame-rate independent; equals a OneEuro with beta 0).
 * Group delay at low frequencies ~= 1 / (2*pi*cutoffHz).
 */
export class LowPassFilter implements ScalarFilter {
  cutoffHz: number;
  private x = NaN;
  private t = NaN;

  constructor(cutoffHz = 4.8) {
    this.cutoffHz = cutoffHz;
  }

  get value(): number {
    return this.x;
  }

  reset(): void {
    this.x = NaN;
    this.t = NaN;
  }

  filter(value: number, tSec: number): number {
    if (Number.isNaN(this.x)) {
      this.x = value;
      this.t = tSec;
      return value;
    }
    // Non-monotonic / duplicate timestamp: treat as one nominal frame (1/30 s).
    const dt = tSec > this.t ? tSec - this.t : 1 / 30;
    this.t += dt;
    const a = smoothingFactor(this.cutoffHz, dt);
    this.x = a * value + (1 - a) * this.x;
    return this.x;
  }
}

/** Pass-through (no smoothing). */
export class IdentityFilter implements ScalarFilter {
  private x = NaN;
  get value(): number {
    return this.x;
  }
  reset(): void {
    this.x = NaN;
  }
  filter(value: number): number {
    this.x = value;
    return value;
  }
}

/**
 * UNIT-FREE, LINEAR filters allowed in the lane pipeline. Because they are linear and time-invariant
 * they commute with the affine ROM normalization: filter(normalize(x)) == normalize(filter(x)) (before
 * clamping), so filtering the raw feature is identical to filtering the 0..1 value, and the delay of
 * every lane is the same regardless of the feature's unit (degrees vs ratio). OneEuro's `beta` term is
 * unit-dependent (cutoff grows with |dx| in feature units) and is therefore NOT a LaneFilterSpec.
 */
export type LaneFilterSpec =
  | { kind: 'ema'; alpha: number }
  | { kind: 'lowpass'; cutoffHz: number }
  | { kind: 'none' };

export type FilterSpec =
  | LaneFilterSpec
  | { kind: 'oneEuro'; minCutoff: number; beta: number; dCutoff?: number };

/** ARCHITECTURE default: EMA alpha 0.5 (~1 frame of lag at 30 fps). */
export const DEFAULT_LANE_FILTER: LaneFilterSpec = Object.freeze({ kind: 'ema', alpha: 0.5 }) as LaneFilterSpec;

export function createFilter(spec: FilterSpec): ScalarFilter {
  switch (spec.kind) {
    case 'oneEuro':
      return new OneEuroFilter(spec);
    case 'ema':
      return new EmaFilter(spec.alpha);
    case 'lowpass':
      return new LowPassFilter(spec.cutoffHz);
    case 'none':
      return new IdentityFilter();
  }
}

/**
 * Low-frequency group delay (seconds) of a lane filter: the constant time a slow ramp/rep is delayed by.
 * ema: (1-alpha)/alpha frames; lowpass: 1/(2*pi*fc); none: 0. `fps` is the sample rate the filter runs at.
 * Exposed so the engine can fold the (identical for every lane) filter delay into its latency offset.
 */
export function filterGroupDelaySec(spec: LaneFilterSpec, fps: number): number {
  switch (spec.kind) {
    case 'ema': {
      const a = Math.min(1, Math.max(1e-6, spec.alpha));
      return fps > 0 ? (1 - a) / a / fps : 0;
    }
    case 'lowpass':
      return spec.cutoffHz > 0 ? 1 / (2 * Math.PI * spec.cutoffHz) : 0;
    case 'none':
      return 0;
  }
}
