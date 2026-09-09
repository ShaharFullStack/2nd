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

export type FilterSpec =
  | { kind: 'oneEuro'; minCutoff: number; beta: number; dCutoff?: number }
  | { kind: 'ema'; alpha: number }
  | { kind: 'none' };

export function createFilter(spec: FilterSpec): ScalarFilter {
  switch (spec.kind) {
    case 'oneEuro':
      return new OneEuroFilter(spec);
    case 'ema':
      return new EmaFilter(spec.alpha);
    case 'none':
      return new IdentityFilter();
  }
}
