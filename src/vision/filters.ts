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

/**
 * Two cascaded EMAs (a critically-damped 2-pole lowpass). Compared with a single EMA of the SAME
 * low-frequency group delay it rolls off twice as fast: at Nyquist a single EMA(alpha=0.5) passes 1/3 of
 * the input while this filter at the delay-matched alpha=2/3 passes only 1/4, and the total white-noise
 * variance gain drops from 0.333 to 0.313. Used by the fine-motor lanes (fingertip landmarks are far
 * noisier than hip/knee landmarks) WITHOUT breaking the equal-delay property every lane relies on —
 * use `matchedEma2Alpha()` to pick the alpha that matches an EMA's delay.
 */
export class Ema2Filter implements ScalarFilter {
  alpha: number;
  private s1 = NaN;
  private s2 = NaN;

  constructor(alpha = 2 / 3) {
    this.alpha = Math.min(1, Math.max(0, alpha));
  }

  get value(): number {
    return this.s2;
  }

  reset(): void {
    this.s1 = NaN;
    this.s2 = NaN;
  }

  filter(value: number, _tSec: number): number {
    this.s1 = Number.isNaN(this.s1) ? value : this.alpha * value + (1 - this.alpha) * this.s1;
    this.s2 = Number.isNaN(this.s2) ? this.s1 : this.alpha * this.s1 + (1 - this.alpha) * this.s2;
    return this.s2;
  }
}

/**
 * Alpha for a two-stage EMA whose group delay equals a single EMA with `emaAlpha`:
 * 2*(1-a')/a' = (1-a)/a  =>  a' = 2a/(1+a). (0.5 -> 2/3, i.e. 1 frame of delay at 30 fps.)
 */
export function matchedEma2Alpha(emaAlpha: number): number {
  const a = Math.min(1, Math.max(1e-6, emaAlpha));
  return (2 * a) / (1 + a);
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
 * Filters allowed in the lane pipeline (docs/ARCHITECTURE.md:80 names "one-euro filter or EMA").
 *
 * The first four are LINEAR and UNIT-FREE. Being linear and time-invariant they commute with the affine
 * ROM normalization — filter(normalize(x)) == normalize(filter(x)) before clamping — so filtering the
 * raw feature is identical to filtering the 0..1 value, and the group delay of every lane is the same
 * whatever the feature's unit (degrees vs ratio). That equal, analytically known delay is what the
 * engine folds into its single session latency offset, which is why they are the defaults.
 *
 * 'oneEuro' is the OPT-IN exception, and it is UNIT-AWARE for exactly that reason: its adaptive term
 * raises the cutoff by `beta * |dx/dt|`, and |dx/dt| is in feature units per second, so the same `beta`
 * would mean something wildly different on a degrees lane (knee_extension, ROM ~60) and a ratio lane
 * (seated_march, ROM ~0.5). `featureScale` is the size of "one unit of movement" for the lane in its own
 * feature units — LanePipeline fills it in from MOVEMENT_INFO[movement].minRom when it is omitted — and
 * the effective beta is `beta / featureScale`, so a spec written once means the same responsiveness on
 * every lane. Its delay is signal-dependent (lower at speed, that being the point);
 * `filterGroupDelaySec` reports the worst case 1/(2*pi*minCutoff), which is what a latency offset must
 * budget for. Prefer the EMAs unless a lane is visibly laggy at tempo.
 */
export type LaneFilterSpec =
  | { kind: 'ema'; alpha: number }
  | { kind: 'ema2'; alpha: number }
  | { kind: 'lowpass'; cutoffHz: number }
  | { kind: 'oneEuro'; minCutoff: number; beta: number; dCutoff?: number; featureScale?: number }
  | { kind: 'none' };

/** Alias kept for callers that filter something other than a lane feature. */
export type FilterSpec = LaneFilterSpec;

/** ARCHITECTURE default: EMA alpha 0.5 (~1 frame of lag at 30 fps). */
export const DEFAULT_LANE_FILTER: LaneFilterSpec = Object.freeze({ kind: 'ema', alpha: 0.5 }) as LaneFilterSpec;

export function createFilter(spec: FilterSpec): ScalarFilter {
  switch (spec.kind) {
    case 'oneEuro': {
      const scale = spec.featureScale !== undefined && Number.isFinite(spec.featureScale) && spec.featureScale > 0 ? spec.featureScale : 1;
      return new OneEuroFilter({ minCutoff: spec.minCutoff, beta: spec.beta / scale, dCutoff: spec.dCutoff });
    }
    case 'ema':
      return new EmaFilter(spec.alpha);
    case 'ema2':
      return new Ema2Filter(spec.alpha);
    case 'lowpass':
      return new LowPassFilter(spec.cutoffHz);
    case 'none':
      return new IdentityFilter();
  }
}

/**
 * Fill in a lane filter's unit-dependent fields for a lane whose feature unit has the given scale
 * ("one unit of movement" in feature units, i.e. MOVEMENT_INFO[movement].minRom). A no-op for the
 * unit-free filters and for a spec that already carries an explicit featureScale.
 */
export function resolveLaneFilter(spec: LaneFilterSpec, featureScale: number): LaneFilterSpec {
  if (spec.kind !== 'oneEuro' || spec.featureScale !== undefined) return spec;
  return { ...spec, featureScale: Number.isFinite(featureScale) && featureScale > 0 ? featureScale : 1 };
}

/**
 * Low-frequency group delay (seconds) of a lane filter: the constant time a slow ramp/rep is delayed by.
 * ema: (1-alpha)/alpha frames; ema2: 2*(1-alpha)/alpha frames; lowpass: 1/(2*pi*fc); none: 0.
 * oneEuro: the WORST CASE 1/(2*pi*minCutoff) — at rest the adaptive cutoff is exactly minCutoff, and it
 * only ever rises (less delay) with speed, so a latency offset budgeted on this is never late.
 * `fps` is the sample rate the filter runs at.
 * Exposed so the engine can fold the (identical for every lane) filter delay into its latency offset.
 */
export function filterGroupDelaySec(spec: LaneFilterSpec, fps: number): number {
  switch (spec.kind) {
    case 'oneEuro':
      return spec.minCutoff > 0 ? 1 / (2 * Math.PI * spec.minCutoff) : 0;
    case 'ema': {
      const a = Math.min(1, Math.max(1e-6, spec.alpha));
      return fps > 0 ? (1 - a) / a / fps : 0;
    }
    case 'ema2': {
      const a = Math.min(1, Math.max(1e-6, spec.alpha));
      return fps > 0 ? (2 * (1 - a)) / a / fps : 0;
    }
    case 'lowpass':
      return spec.cutoffHz > 0 ? 1 / (2 * Math.PI * spec.cutoffHz) : 0;
    case 'none':
      return 0;
  }
}
