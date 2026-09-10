/**
 * Player-stem ducking logic, kept independent of Web Audio so it can be unit-tested
 * against a fake AudioParam.
 *
 * Contract (docs/ARCHITECTURE.md): miss → ramp to `missGain` (0.05) in 40 ms; hit → restore
 * to 1.0 in 60 ms; ducking persists until the next hit. Streak bonus: at `streakThreshold`
 * (8) combo or more the restored level is raised by `streakBoostDb` (+2 dB).
 *
 * Anchoring: a new ramp must start from the value the previous ramp has *reached* at `now`,
 * otherwise a hit 20 ms into a 40 ms miss-ramp jumps (click). `AudioParam.value` only reflects
 * automation at render-quantum granularity and lags in some browsers, so the controller tracks
 * the analytic position of its own exponential ramp (`RampState` + `rampValueAt`) and anchors
 * on that instead of reading `param.value` back.
 */

/** The subset of AudioParam we schedule on. */
export interface GainParamLike {
  value: number;
  cancelScheduledValues(startTime: number): unknown;
  setValueAtTime(value: number, startTime: number): unknown;
  exponentialRampToValueAtTime(value: number, endTime: number): unknown;
  /**
   * Optional (Chrome 57+, Safari 14.1+, Firefox 137+): cancels pending automation AND holds the
   * exact automation value at `cancelTime`, so a new ramp starts from the audio thread's own value
   * instead of a main-thread estimate. Feature-detected by `scheduleRamp`.
   */
  cancelAndHoldAtTime?(cancelTime: number): unknown;
}

/** AudioParam subset for linear (slider-style) ramps. */
export interface LinearParamLike {
  value: number;
  cancelScheduledValues(startTime: number): unknown;
  setValueAtTime(value: number, startTime: number): unknown;
  linearRampToValueAtTime(value: number, endTime: number): unknown;
  cancelAndHoldAtTime?(cancelTime: number): unknown;
}

/** True when the param implements cancelAndHoldAtTime (exact anchoring on the audio thread). */
export function supportsCancelAndHold(param: { cancelAndHoldAtTime?: unknown }): boolean {
  return typeof param.cancelAndHoldAtTime === 'function';
}

export interface DuckOptions {
  missGain: number;
  missRampMs: number;
  hitGain: number;
  hitRampMs: number;
  streakThreshold: number;
  streakBoostDb: number;
}

export const DEFAULT_DUCK_OPTIONS: DuckOptions = {
  missGain: 0.05,
  missRampMs: 40,
  hitGain: 1.0,
  hitRampMs: 60,
  streakThreshold: 8,
  streakBoostDb: 2,
};

/** Exponential ramps cannot reach 0, so gains are clamped to this floor. */
export const MIN_GAIN = 1e-4;

export const dbToGain = (db: number): number => Math.pow(10, db / 20);
export const gainToDb = (g: number): number => 20 * Math.log10(Math.max(g, MIN_GAIN));

/** Restored level for a given combo count (combo = consecutive hits including this one). */
export function targetGainForCombo(combo: number, opts: DuckOptions = DEFAULT_DUCK_OPTIONS): number {
  const boost = combo >= opts.streakThreshold ? dbToGain(opts.streakBoostDb) : 1;
  return opts.hitGain * boost;
}

/** An exponential ramp `from` (at t0) → `to` (at t1), as scheduled on the param. */
export interface RampState {
  from: number;
  to: number;
  t0: number;
  t1: number;
}

/** Analytic value of an exponential ramp at time `t` (Web Audio: v0 · (v1/v0)^((t−t0)/(t1−t0))). */
export function rampValueAt(r: RampState, t: number): number {
  if (t <= r.t0) return r.from;
  if (t >= r.t1) return r.to;
  return r.from * Math.pow(r.to / r.from, (t - r.t0) / (r.t1 - r.t0));
}

/**
 * Cancel pending automation, anchor at `now`, then ramp exponentially to `target` over
 * `rampSec`. Returns the ramp actually scheduled (values clamped to MIN_GAIN, min 1 ms).
 *
 * Anchoring: with `cancelAndHoldAtTime` available the audio thread itself holds the exact
 * in-flight value at `now` (no discontinuity even when the main thread's `now` is a few render
 * quanta stale); otherwise the analytic `from` is pinned with setValueAtTime. `from` is always
 * recorded in the returned RampState so callers can keep tracking the ramp analytically.
 */
export function scheduleRamp(param: GainParamLike, from: number, now: number, target: number, rampSec: number): RampState {
  const r: RampState = {
    from: Math.max(from, MIN_GAIN),
    to: Math.max(target, MIN_GAIN),
    t0: now,
    t1: now + Math.max(rampSec, 1e-3),
  };
  if (supportsCancelAndHold(param)) {
    param.cancelAndHoldAtTime!(now);
  } else {
    param.cancelScheduledValues(now);
    param.setValueAtTime(r.from, now);
  }
  param.exponentialRampToValueAtTime(r.to, r.t1);
  return r;
}

/** Analytic value of a linear ramp at time `t`. */
export function linearRampValueAt(r: RampState, t: number): number {
  if (t <= r.t0) return r.from;
  if (t >= r.t1) return r.to;
  return r.from + (r.to - r.from) * ((t - r.t0) / (r.t1 - r.t0));
}

/**
 * Anchored linear ramps for slider-style controls (stem/master volume, SFX volume): tracks the
 * ramp it scheduled so a burst of `set()` calls (a slider being dragged) starts each new ramp
 * from where the previous one actually is instead of from a stale `param.value`.
 */
export class SmoothGain {
  private readonly param: LinearParamLike;
  private ramp: RampState;

  constructor(param: LinearParamLike, initial: number = param.value) {
    this.param = param;
    const v = Math.max(0, initial);
    this.ramp = { from: v, to: v, t0: -Infinity, t1: -Infinity };
    this.param.value = v;
  }

  /** Destination of the last ramp (the "set" value a UI should display). */
  get target(): number { return this.ramp.to; }
  get currentRamp(): RampState { return { ...this.ramp }; }
  valueAt(now: number): number { return linearRampValueAt(this.ramp, now); }

  /** Ramp linearly from the analytic current value to `target` over `rampSec` (min 1 ms). */
  set(target: number, now: number, rampSec: number): RampState {
    const from = this.valueAt(now);
    const r: RampState = { from, to: Math.max(0, target), t0: now, t1: now + Math.max(rampSec, 1e-3) };
    if (supportsCancelAndHold(this.param)) {
      this.param.cancelAndHoldAtTime!(now);
    } else {
      this.param.cancelScheduledValues(now);
      this.param.setValueAtTime(from, now);
    }
    this.param.linearRampToValueAtTime(r.to, r.t1);
    this.ramp = r;
    return r;
  }
}

/**
 * Convenience: ramp from the param's reported current value (`param.value`) to `target`.
 * Returns the clamped target actually scheduled. Prefer `DuckController`, which anchors on the
 * analytic ramp position instead of `param.value`.
 */
export function rampGain(param: GainParamLike, now: number, target: number, rampSec: number): number {
  return scheduleRamp(param, param.value, now, target, rampSec).to;
}

export class DuckController {
  private param: GainParamLike;
  private readonly opts: DuckOptions;
  private isDucked = false;
  private ramp: RampState;

  constructor(param: GainParamLike, opts: Partial<DuckOptions> = {}) {
    this.param = param;
    this.opts = { ...DEFAULT_DUCK_OPTIONS, ...opts };
    const v = Math.max(this.opts.hitGain, MIN_GAIN);
    this.ramp = { from: v, to: v, t0: -Infinity, t1: -Infinity };
  }

  get ducked(): boolean { return this.isDucked; }
  /** Last level this controller scheduled (the ramp destination). */
  get target(): number { return this.ramp.to; }
  get options(): DuckOptions { return this.opts; }
  /** The ramp currently scheduled on the param. */
  get currentRamp(): RampState { return { ...this.ramp }; }

  /** Analytic gain of the player stem at ctx time `now` (for UI meters / anchoring). */
  valueAt(now: number): number { return rampValueAt(this.ramp, now); }

  /**
   * Point the controller at another stem's gain (e.g. setPlayerStem mid-song). The outgoing stem
   * is RAMPED back to the nominal level over the hit ramp, anchored on the value its current ramp
   * has actually reached: hard-writing it would jump 0.05 → 1.0 in one sample (an audible click)
   * whenever the player stem is swapped while ducked.
   */
  rebind(param: GainParamLike, now: number): void {
    if (param === this.param) return;
    scheduleRamp(this.param, this.valueAt(now), now, this.opts.hitGain, this.opts.hitRampMs / 1000);
    this.param = param;
    this.reset(now);
  }

  miss(now: number): number {
    this.isDucked = true;
    this.ramp = scheduleRamp(this.param, this.valueAt(now), now, this.opts.missGain, this.opts.missRampMs / 1000);
    return this.ramp.to;
  }

  hit(now: number, combo: number = 0): number {
    this.isDucked = false;
    this.ramp = scheduleRamp(this.param, this.valueAt(now), now, targetGainForCombo(combo, this.opts), this.opts.hitRampMs / 1000);
    return this.ramp.to;
  }

  /**
   * Restore the nominal level (song start / stop / seek / stem swap).
   *
   * `rampSec` > 0 ramps there from the value the current ramp has actually reached, exactly like
   * `hit()`; pass the transport's fade length whenever the stem may still be audible (a seek or
   * stop while ducked otherwise steps 0.05 → 1.0 in one sample — a 26× discontinuity inside the
   * ~8 ms fade-out, i.e. an audible click). The default 0 is the hard write, correct only when
   * nothing is sounding (a fresh load, or after the fade has completed).
   */
  reset(now: number, rampSec: number = 0): void {
    this.isDucked = false;
    const v = Math.max(this.opts.hitGain, MIN_GAIN);
    const from = this.valueAt(now);
    if (rampSec > 0 && Math.abs(from - v) > 1e-9) {
      this.ramp = scheduleRamp(this.param, from, now, v, rampSec);
      return;
    }
    this.ramp = { from: v, to: v, t0: now, t1: now };
    this.param.cancelScheduledValues(now);
    this.param.setValueAtTime(v, now);
  }
}
