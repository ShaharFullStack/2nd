/**
 * LaneTrigger: RISING-EDGE detector over a normalized (0..1) value stream with hysteresis, a minimum
 * re-trigger interval, and sub-frame crossing time interpolation. It also tracks the rep's peak and
 * reports a `CompletedRep` when the lane re-arms (see `takeCompletedRep`).
 *
 * RISING EDGE, NOT LEVEL (this is the whole point in a rehab game — an unearned hit is worse than a
 * missed one). The trigger starts DISARMED ('unconfirmed'): it fires only after it has actually observed
 * the lane BELOW the re-arm level and then seen it rise through the threshold. Consequently:
 *   - a fresh trigger fed a limb already held at 0.95 of ROM emits nothing (no movement was observed);
 *   - `reset()` (e.g. a therapist re-calibrating mid-play) leaves it disarmed, so a still-raised limb
 *     cannot score the same, ongoing rep twice;
 *   - any break in the sample stream — a null sample (tracking lost) or a gap longer than `maxGapSec`
 *     (a stalled camera / backgrounded tab) — disarms an armed lane again, because the rise that may
 *     have happened during the gap was never observed.
 * A break during a rep (state 'triggered') does NOT invalidate the rep: the lane still needs a
 * below-re-arm sample to re-arm, which is exactly the arming condition.
 */

export interface TriggerOptions {
  /** Normalized value that counts as a hit (0..1). */
  thresholdFraction: number;
  /** Re-arm when the value falls below thresholdFraction * rearmFraction (default 0.6). */
  rearmFraction?: number;
  /** Minimum time between two emitted events in seconds (default 0.3). */
  minIntervalSec?: number;
  /**
   * A sample arriving more than this long after the previous one (default 0.5 s) counts as a break in
   * the stream: no interpolation across it, and an armed lane falls back to 'unconfirmed'.
   */
  maxGapSec?: number;
}

export interface TriggerEvent {
  /** Interpolated time (same time base as the samples, i.e. AudioContext seconds) of the threshold crossing. */
  ctxTime: number;
  /**
   * Value at the frame that CROSSED the threshold, clamped to 1 — i.e. a fraction of ROM just above
   * `thresholdFraction`, NOT the rep's peak ROM (which is not known yet: the event has to be emitted at
   * the crossing, or the hit would be judged late by half a rep). Anything reporting "ROM achieved" must
   * read CompletedRep.peak / rawPeak (LaneRepEvent), which arrive when the rep ends; reading `strength`
   * as ROM systematically under-reports it to roughly the threshold.
   */
  strength: number;
  /** Same value WITHOUT the 0..1 clamp (>1 when the patient exceeded their calibrated ROM). */
  rawStrength: number;
}

/** A finished rep: reported once the value fell back below the re-arm level. */
export interface CompletedRep {
  /** ctxTime of the crossing that opened the rep (same value as its TriggerEvent, when one was emitted). */
  ctxTime: number;
  /** Time of the sample at which the lane re-armed. */
  endCtxTime: number;
  /** Highest value seen between the crossing and re-arm (0..1). */
  peak: number;
  /** Highest UNCLAMPED value of the rep (>1 when the patient exceeded their calibrated ROM). */
  rawPeak: number;
  /** False when the crossing was swallowed by the min re-trigger interval (no TriggerEvent was emitted). */
  emitted: boolean;
}

/** 'unconfirmed' = never seen below the re-arm level since the last break/reset, so it cannot fire. */
export type TriggerState = 'unconfirmed' | 'armed' | 'triggered';

export const DEFAULT_REARM_FRACTION = 0.6;
export const DEFAULT_MIN_INTERVAL_SEC = 0.3;
export const DEFAULT_MAX_GAP_SEC = 0.5;

/**
 * The shortest interval at which the same lane can score twice: crossings closer together than this are
 * swallowed by the hysteresis/re-trigger guard (they still surface as reps with `emitted:false`).
 * AUTHORITATIVE for chart generation: two notes in the SAME lane must never be closer than this, or the
 * second is unhittable by construction (at 160 BPM that rules out same-lane eighth notes, 187 ms apart).
 */
export const MIN_SAME_LANE_NOTE_SPACING_SEC = DEFAULT_MIN_INTERVAL_SEC;

/** Minimum spacing between two notes in the same lane for a given trigger config (seconds). */
export function minSameLaneNoteSpacingSec(minIntervalSec: number = DEFAULT_MIN_INTERVAL_SEC): number {
  return minIntervalSec;
}

export class LaneTrigger {
  private threshold: number;
  private rearmFraction: number;
  private minIntervalSec: number;
  private maxGapSec: number;
  private _state: TriggerState = 'unconfirmed';
  private prevValue = NaN;
  private prevTime = NaN;
  private lastEventTime = -Infinity;
  private _peak = 0;
  private _rawPeak = 0;
  private repStart = NaN;
  private repEmitted = false;
  private completed: CompletedRep | null = null;

  constructor(opts: TriggerOptions) {
    this.threshold = opts.thresholdFraction;
    this.rearmFraction = opts.rearmFraction ?? DEFAULT_REARM_FRACTION;
    this.minIntervalSec = opts.minIntervalSec ?? DEFAULT_MIN_INTERVAL_SEC;
    this.maxGapSec = opts.maxGapSec ?? DEFAULT_MAX_GAP_SEC;
  }

  /** True only when a confirmed below-re-arm observation makes the lane able to fire on a rising edge. */
  get armed(): boolean {
    return this._state === 'armed';
  }

  get state(): TriggerState {
    return this._state;
  }

  get thresholdFraction(): number {
    return this.threshold;
  }

  get rearmLevel(): number {
    return this.threshold * this.rearmFraction;
  }

  /** Highest value seen since the last rising edge (0 when not inside a rep). */
  get peakSinceTrigger(): number {
    return this._peak;
  }

  /** Highest UNCLAMPED value since the last rising edge (0 when not inside a rep). */
  get rawPeakSinceTrigger(): number {
    return this._rawPeak;
  }

  setThreshold(thresholdFraction: number): void {
    this.threshold = thresholdFraction;
  }

  /** Full reset. The lane comes back DISARMED: it must be seen below the re-arm level before it can fire. */
  reset(): void {
    this._state = 'unconfirmed';
    this.prevValue = NaN;
    this.prevTime = NaN;
    this.lastEventTime = -Infinity;
    this._peak = 0;
    this._rawPeak = 0;
    this.repStart = NaN;
    this.repEmitted = false;
    this.completed = null;
  }

  /**
   * Returns (and clears) the rep that completed on the most recent push, if any. Call after every push
   * to surface per-rep peak ROM.
   */
  takeCompletedRep(): CompletedRep | null {
    const c = this.completed;
    this.completed = null;
    return c;
  }

  /**
   * Feed one sample. Returns a TriggerEvent ONLY on an observed rising edge through the threshold from a
   * confirmed armed state; otherwise null.
   * @param value     normalized value clamped to 0..1 (drives threshold/hysteresis).
   * @param tSec      sample time (AudioContext seconds).
   * @param rawValue  same value without the 0..1 clamp (optional; defaults to `value`).
   */
  push(value: number | null, tSec: number, rawValue?: number): TriggerEvent | null {
    if (value === null || !Number.isFinite(value)) {
      this.breakContinuity();
      return null;
    }
    const raw = rawValue === undefined || !Number.isFinite(rawValue) ? value : rawValue;
    const gap = Number.isNaN(this.prevTime) ? Infinity : tSec - this.prevTime;
    if (!(gap >= 0) || gap > this.maxGapSec) this.breakContinuity();

    let event: TriggerEvent | null = null;
    if (this._state === 'triggered') {
      if (value > this._peak) this._peak = value;
      if (raw > this._rawPeak) this._rawPeak = raw;
      if (value < this.rearmLevel) {
        this._state = 'armed';
        this.completed = { ctxTime: this.repStart, endCtxTime: tSec, peak: this._peak, rawPeak: this._rawPeak, emitted: this.repEmitted };
        this._peak = 0;
        this._rawPeak = 0;
        this.repStart = NaN;
        this.repEmitted = false;
      }
    } else if (value >= this.threshold) {
      // Only an ARMED lane may fire: 'unconfirmed' means no below-re-arm observation was made since the
      // last reset/break, so this level was never *risen through* as far as this trigger knows.
      if (this._state === 'armed') {
        let crossTime = tSec;
        if (!Number.isNaN(this.prevValue) && this.prevValue < this.threshold && tSec > this.prevTime) {
          const f = (this.threshold - this.prevValue) / (value - this.prevValue);
          crossTime = this.prevTime + f * (tSec - this.prevTime);
        }
        this._state = 'triggered';
        this._peak = value;
        this._rawPeak = raw;
        this.repStart = crossTime;
        this.repEmitted = crossTime - this.lastEventTime >= this.minIntervalSec;
        if (this.repEmitted) {
          this.lastEventTime = crossTime;
          event = { ctxTime: crossTime, strength: value, rawStrength: raw };
        }
      }
    } else if (value < this.rearmLevel) {
      // The confirmed below-re-arm observation the rising edge is measured from.
      this._state = 'armed';
    }
    this.prevValue = value;
    this.prevTime = tSec;
    return event;
  }

  /** A null sample or an over-long gap: interpolation is impossible and an armed lane loses its arming. */
  private breakContinuity(): void {
    this.prevValue = NaN;
    this.prevTime = NaN;
    if (this._state === 'armed') this._state = 'unconfirmed';
  }
}
