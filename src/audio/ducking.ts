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
 * Cancel pending automation, anchor `from` at `now`, then ramp exponentially to `target` over
 * `rampSec`. Returns the ramp actually scheduled (values clamped to MIN_GAIN, min 1 ms).
 */
export function scheduleRamp(param: GainParamLike, from: number, now: number, target: number, rampSec: number): RampState {
  const r: RampState = {
    from: Math.max(from, MIN_GAIN),
    to: Math.max(target, MIN_GAIN),
    t0: now,
    t1: now + Math.max(rampSec, 1e-3),
  };
  param.cancelScheduledValues(now);
  param.setValueAtTime(r.from, now);
  param.exponentialRampToValueAtTime(r.to, r.t1);
  return r;
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

  /** Point the controller at another stem's gain (e.g. setPlayerStem). Restores the old one instantly. */
  rebind(param: GainParamLike, now: number): void {
    if (param === this.param) return;
    this.param.cancelScheduledValues(now);
    this.param.setValueAtTime(this.opts.hitGain, now);
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

  /** Instantly restore the nominal level (song start / stop / seek). */
  reset(now: number): void {
    this.isDucked = false;
    const v = Math.max(this.opts.hitGain, MIN_GAIN);
    this.ramp = { from: v, to: v, t0: now, t1: now };
    this.param.cancelScheduledValues(now);
    this.param.setValueAtTime(this.opts.hitGain, now);
  }
}
