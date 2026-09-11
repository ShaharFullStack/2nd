/**
 * Player-stem ducking logic, kept independent of Web Audio so it can be unit-tested
 * against a fake AudioParam.
 *
 * PROPORTIONATE, PER-LANE DUCKING (diverges from docs/ARCHITECTURE.md's flat `missGain` 0.05 — see
 * `duckGainForMisses`). A miss lowers the stem by ONE STEP (`missStepDb`, −3 dB), a second
 * consecutive miss by another, and the run bottoms out at `missGain` (0.35, −9 dB) — audibly quieter,
 * never silent. The old contract ducked to 5 % on the first miss and held it until the next hit, so
 * in a hemiparesis session the weak side — which IS the therapy — muted the instrument for the whole
 * body: a patient hitting every note with the strong leg heard nothing because the weak leg missed.
 * The miss run is per DuckController, and `assignLaneStems` gives each lane its own stem (and so its
 * own controller) whenever the song has enough of them, so the weak lane dims its own instrument only.
 * When the song has too few stems for the lane count every lane shares one controller, and that
 * controller's floor is raised to a single step (`duckOptionsFor`): a shared instrument belongs to
 * the working limb as much as to the weak one, so a run of misses cannot take it 9 dB down.
 * Hit → restore to 1.0 in 60 ms. Streak bonus: at `streakThreshold` (8) combo or more the restored
 * level is raised by `streakBoostDb` (+2 dB).
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
  /**
   * FLOOR of the duck — the quietest the stem ever gets, however long the miss run (default 0.35,
   * −9 dB). It is not the level of a single miss any more: see `missStepDb` and `duckGainForMisses`.
   */
  missGain: number;
  /** dB removed per consecutive miss on this controller's stem (default −3, i.e. half power). */
  missStepDb: number;
  missRampMs: number;
  hitGain: number;
  hitRampMs: number;
  streakThreshold: number;
  streakBoostDb: number;
}

export const DEFAULT_DUCK_OPTIONS: DuckOptions = {
  missGain: 0.35,
  missStepDb: -3,
  missRampMs: 40,
  hitGain: 1.0,
  hitRampMs: 60,
  streakThreshold: 8,
  streakBoostDb: 2,
};

/**
 * Level for a run of `misses` consecutive misses: one step of `missStepDb` each, bottoming out at
 * `missGain`. 0 misses = the nominal level.
 *
 * Proportionate by construction: the first miss is a dip a patient hears as "that one did not land"
 * (−3 dB), not a mute. Only a sustained run — three misses in a row in that lane — reaches the floor,
 * and even the floor keeps the instrument in the mix.
 */
export function duckGainForMisses(misses: number, opts: DuckOptions = DEFAULT_DUCK_OPTIONS): number {
  const n = Number.isFinite(misses) ? Math.max(0, Math.floor(misses)) : 0;
  if (n === 0) return opts.hitGain;
  const floor = Math.min(Math.max(opts.missGain, MIN_GAIN), opts.hitGain);
  return Math.max(floor, opts.hitGain * dbToGain(opts.missStepDb * n));
}

/**
 * The duck settings a given assignment mode should run with.
 *
 * 'per-lane': the full contract — one step per consecutive miss IN THAT LANE, down to `missGain`.
 * The lane owns its instrument, so the depth is allowed to grow with the lane's own miss run.
 *
 * 'shared': the floor is raised to ONE STEP. When the song has too few stems every lane ducks the
 * same instrument, so that instrument is also the reward for the limb that IS working, and a run of
 * misses — which can be a chart with three notes for the weak hand in a row — must not take it down
 * 9 dB. One step is the whole consequence, however long the run, and any hit anywhere restores it.
 */
export function duckOptionsFor(mode: LaneStemAssignment['mode'], opts: DuckOptions = DEFAULT_DUCK_OPTIONS): DuckOptions {
  if (mode === 'per-lane') return opts;
  return { ...opts, missGain: Math.min(opts.hitGain, Math.max(opts.missGain, dbToGain(opts.missStepDb))) };
}

/** Attenuation (positive dB) of one miss and of the deepest possible run, for a given mode. */
export function duckDepthDb(mode: LaneStemAssignment['mode'], opts: DuckOptions = DEFAULT_DUCK_OPTIONS): { stepDb: number; floorDb: number } {
  const o = duckOptionsFor(mode, opts);
  return { stepDb: -gainToDb(duckGainForMisses(1, o)), floorDb: -gainToDb(duckGainForMisses(99, o)) };
}

/** Which stem each lane ducks, and which stems never duck at all. See `assignLaneStems`. */
export interface LaneStemAssignment {
  /** 'per-lane': every lane has its own stem. 'shared': every lane ducks the player stem. */
  mode: 'per-lane' | 'shared';
  /** Stem id per lane index (length = lane count). */
  perLane: string[];
  /** Stems no lane ducks — the bed, which always plays at full level. Never empty. */
  bed: string[];
  /** How many stems the song has. */
  stemCount: number;
  /**
   * The most lanes this song can give an instrument of its own (`stemCount − 1`, since one stem
   * always stays out of the assignment to carry the song). Above it the mode is 'shared' — the
   * Setup screen needs the number to say what would have to change.
   */
  capacity: number;
  /** One sentence a therapist can read: the rule AND which lane has which instrument. */
  summary: string;
  /**
   * The rule alone, with no lane→instrument mapping in it — for a screen that lists the mapping
   * beside it and would otherwise print the same pairs twice.
   */
  rule: string;
}

/**
 * Give each lane its own stem to duck, if the song has enough stems to keep a bed playing.
 *
 * Rehab rule: a miss must never take away the reward for the parts of the body that are working.
 * With enough stems, the weak side dims its own instrument and the strong side's keeps playing; with
 * too few, every lane shares the player stem — and then the duck is capped at ONE STEP however long
 * the run (`duckOptionsFor('shared')`), because that instrument is also the reward for the limb that
 * is working. At least one stem is always left out of the assignment, so the song itself never stops.
 */
export function assignLaneStems(
  stemIds: readonly string[],
  playerStem: string,
  lanes: number,
  /**
   * What each lane IS, in the therapist's words ("Left · Seated march"). Without it the summary can
   * only name the instruments as a set — "each lane has its own instrument (drums, bass)" — which
   * leaves the one question a hemiparesis session needs answered unanswerable: is the weak left leg
   * the drums or the bass? A therapist listening for whether the weak side is being rewarded has to
   * know which instrument to listen for.
   */
  laneLabels?: readonly string[],
): LaneStemAssignment {
  const n = Math.max(0, Math.floor(lanes));
  const named = (perLane: readonly string[]): string =>
    perLane.map((stem, i) => `${laneLabels?.[i] ?? `lane ${i + 1}`} → ${stem}`).join('; ');
  // "lead play throughout" was printed for every 3-lane session on a 4-stem song: the bed is a list,
  // and a list of one takes a singular verb.
  const bedPlays = (bed: readonly string[]): string =>
    bed.length === 0 ? 'nothing else is playing' : `${bed.join(', ')} ${bed.length === 1 ? 'plays' : 'play'} throughout`;
  const ordered = stemIds.includes(playerStem) ? [playerStem, ...stemIds.filter((id) => id !== playerStem)] : [...stemIds];
  if (ordered.length === 0 || n === 0) {
    const none = 'No stems are loaded, so nothing is ducked.';
    return {
      mode: 'shared', perLane: new Array<string>(n).fill(playerStem), bed: [],
      stemCount: ordered.length, capacity: 0, summary: none, rule: none,
    };
  }
  const capacity = ordered.length - 1; // one stem always stays out of the assignment
  if (n <= capacity) {
    const perLane = ordered.slice(0, n);
    const bed = ordered.slice(n);
    return {
      mode: 'per-lane',
      perLane,
      bed,
      stemCount: ordered.length,
      capacity,
      summary: `Each lane has its own instrument — ${named(perLane)}. ${bedPlays(bed)}. A miss dips only that lane's instrument, so a weak limb's misses never take the reward away from the limb that is working.`,
      rule: `Each lane has its own instrument; ${bedPlays(bed)}. A miss dips only that lane's instrument, so a weak limb's misses never take the reward away from the limb that is working.`,
    };
  }
  const perLane = new Array<string>(n).fill(ordered[0]);
  const bed = ordered.slice(1);
  // ONE STEP, AND NO DEEPER. A shared instrument belongs to every lane at once, so the depth of the
  // duck is capped at a single step here (`duckOptionsFor`) — see the floor it installs. The
  // sentence and the behaviour are written together on purpose: this is the text a therapist reads.
  const why = `This song has ${ordered.length} stem${ordered.length === 1 ? '' : 's'} — enough for ${capacity} lane${capacity === 1 ? '' : 's'}, not ${n} — so every lane shares "${ordered[0]}", and ${bedPlays(bed)}`;
  const consequence = `A miss in ANY lane dips it one step and no further, however long the run, because that instrument is also the reward for the limb that is working; the next hit in any lane brings it straight back.`;
  return {
    mode: 'shared',
    perLane,
    bed,
    stemCount: ordered.length,
    capacity,
    summary: `${why} (${named(perLane)}). ${consequence}`,
    // The screen that prints this puts the depth in dB beside it, so the rule states the MAPPING and
    // leaves the consequence to the sentence that can quantify it.
    rule: `${why}. A miss in ANY lane dips that one shared instrument.`,
  };
}

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
  private opts: DuckOptions;
  private isDucked = false;
  /** Consecutive misses on this stem — the depth of the duck, reset by any hit. */
  private missRunCount = 0;
  private ramp: RampState;

  constructor(param: GainParamLike, opts: Partial<DuckOptions> = {}) {
    this.param = param;
    this.opts = { ...DEFAULT_DUCK_OPTIONS, ...opts };
    const v = Math.max(this.opts.hitGain, MIN_GAIN);
    this.ramp = { from: v, to: v, t0: -Infinity, t1: -Infinity };
  }

  get ducked(): boolean { return this.isDucked; }
  /** Consecutive misses currently ducking this stem (0 = at the nominal level). */
  get missRun(): number { return this.missRunCount; }
  /** Last level this controller scheduled (the ramp destination). */
  get target(): number { return this.ramp.to; }
  get options(): DuckOptions { return this.opts; }
  /**
   * Change the duck settings in place (StemMixer does this when the lane→stem assignment switches
   * between 'per-lane' and 'shared': the same controller keeps the same gain param, but a shared
   * stem ducks by at most one step). Re-ramps to the level the current miss run implies under the
   * new settings, so a stem already ducked deeper than the new floor comes back up instead of
   * sitting at a level the settings say is impossible.
   */
  setOptions(opts: Partial<DuckOptions>, now: number): void {
    const next = { ...this.opts, ...opts };
    const changed = (Object.keys(next) as (keyof DuckOptions)[]).some((k) => next[k] !== this.opts[k]);
    this.opts = next;
    if (!changed) return;
    const target = this.missRunCount > 0 ? duckGainForMisses(this.missRunCount, next) : this.ramp.to;
    if (target !== this.ramp.to) this.ramp = scheduleRamp(this.param, this.valueAt(now), now, target, next.hitRampMs / 1000);
  }
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

  /**
   * One miss on this controller's stem: step DOWN by `missStepDb`, bottoming out at `missGain`.
   * Pass `misses` to set the run length explicitly (a replay/critic); by default the controller
   * counts its own consecutive misses, which any hit resets.
   */
  miss(now: number, misses?: number): number {
    this.missRunCount = misses === undefined ? this.missRunCount + 1 : Math.max(0, Math.floor(misses));
    this.isDucked = this.missRunCount > 0;
    const target = duckGainForMisses(this.missRunCount, this.opts);
    this.ramp = scheduleRamp(this.param, this.valueAt(now), now, target, this.opts.missRampMs / 1000);
    return this.ramp.to;
  }

  hit(now: number, combo: number = 0): number {
    this.isDucked = false;
    this.missRunCount = 0;
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
    this.missRunCount = 0;
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
