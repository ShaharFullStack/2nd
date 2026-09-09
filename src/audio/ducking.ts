/**
 * Player-stem ducking logic, kept independent of Web Audio so it can be unit-tested
 * against a fake AudioParam.
 *
 * Contract (docs/ARCHITECTURE.md): miss → ramp to `missGain` (0.05) in 40 ms; hit → restore
 * to 1.0 in 60 ms; ducking persists until the next hit. Streak bonus: at `streakThreshold`
 * (8) combo or more the restored level is raised by `streakBoostDb` (+2 dB).
 */

/** The subset of AudioParam we schedule on. `value` must report the current (automated) value. */
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

/**
 * Cancel pending automation, anchor the current value at `now`, then ramp exponentially to
 * `target` over `rampSec`. Returns the clamped target actually scheduled.
 */
export function rampGain(param: GainParamLike, now: number, target: number, rampSec: number): number {
  const from = Math.max(param.value, MIN_GAIN);
  const to = Math.max(target, MIN_GAIN);
  param.cancelScheduledValues(now);
  param.setValueAtTime(from, now);
  param.exponentialRampToValueAtTime(to, now + Math.max(rampSec, 1e-3));
  return to;
}

export class DuckController {
  private param: GainParamLike;
  private readonly opts: DuckOptions;
  private isDucked = false;
  private lastTarget: number;

  constructor(param: GainParamLike, opts: Partial<DuckOptions> = {}) {
    this.param = param;
    this.opts = { ...DEFAULT_DUCK_OPTIONS, ...opts };
    this.lastTarget = this.opts.hitGain;
  }

  get ducked(): boolean { return this.isDucked; }
  /** Last level this controller scheduled (the ramp destination). */
  get target(): number { return this.lastTarget; }
  get options(): DuckOptions { return this.opts; }

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
    this.lastTarget = rampGain(this.param, now, this.opts.missGain, this.opts.missRampMs / 1000);
    return this.lastTarget;
  }

  hit(now: number, combo: number = 0): number {
    this.isDucked = false;
    this.lastTarget = rampGain(this.param, now, targetGainForCombo(combo, this.opts), this.opts.hitRampMs / 1000);
    return this.lastTarget;
  }

  /** Instantly restore the nominal level (song start / stop / seek). */
  reset(now: number): void {
    this.isDucked = false;
    this.lastTarget = this.opts.hitGain;
    this.param.cancelScheduledValues(now);
    this.param.setValueAtTime(this.opts.hitGain, now);
  }
}
