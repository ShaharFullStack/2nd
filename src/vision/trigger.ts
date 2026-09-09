/**
 * LaneTrigger: rising-edge detector over a normalized (0..1) value stream with hysteresis, a minimum
 * re-trigger interval, and sub-frame crossing time interpolation. It also tracks the rep's peak and
 * reports a `CompletedRep` when the lane re-arms (see `takeCompletedRep`).
 */

export interface TriggerOptions {
  /** Normalized value that counts as a hit (0..1). */
  thresholdFraction: number;
  /** Re-arm when the value falls below thresholdFraction * rearmFraction (default 0.6). */
  rearmFraction?: number;
  /** Minimum time between two emitted events in seconds (default 0.3). */
  minIntervalSec?: number;
}

export interface TriggerEvent {
  /** Interpolated time (same time base as the samples, i.e. AudioContext seconds) of the threshold crossing. */
  ctxTime: number;
  /** Value at the frame that crossed (>= threshold). Fraction of ROM reached so far; the rep's peak comes with CompletedRep. */
  strength: number;
}

/** A finished rep: reported once the value fell back below the re-arm level. */
export interface CompletedRep {
  /** ctxTime of the crossing that opened the rep (same value as its TriggerEvent, when one was emitted). */
  ctxTime: number;
  /** Time of the sample at which the lane re-armed. */
  endCtxTime: number;
  /** Highest value seen between the crossing and re-arm (0..1). */
  peak: number;
  /** False when the crossing was swallowed by the min re-trigger interval (no TriggerEvent was emitted). */
  emitted: boolean;
}

export const DEFAULT_REARM_FRACTION = 0.6;
export const DEFAULT_MIN_INTERVAL_SEC = 0.3;

export class LaneTrigger {
  private threshold: number;
  private rearmFraction: number;
  private minIntervalSec: number;
  private _armed = true;
  private prevValue = NaN;
  private prevTime = NaN;
  private lastEventTime = -Infinity;
  private _peak = 0;
  private repStart = NaN;
  private repEmitted = false;
  private completed: CompletedRep | null = null;

  constructor(opts: TriggerOptions) {
    this.threshold = opts.thresholdFraction;
    this.rearmFraction = opts.rearmFraction ?? DEFAULT_REARM_FRACTION;
    this.minIntervalSec = opts.minIntervalSec ?? DEFAULT_MIN_INTERVAL_SEC;
  }

  get armed(): boolean {
    return this._armed;
  }

  get thresholdFraction(): number {
    return this.threshold;
  }

  get rearmLevel(): number {
    return this.threshold * this.rearmFraction;
  }

  /** Highest value seen since the last rising edge (0 when armed). */
  get peakSinceTrigger(): number {
    return this._peak;
  }

  setThreshold(thresholdFraction: number): void {
    this.threshold = thresholdFraction;
  }

  reset(): void {
    this._armed = true;
    this.prevValue = NaN;
    this.prevTime = NaN;
    this.lastEventTime = -Infinity;
    this._peak = 0;
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
   * Feed one sample. Returns a TriggerEvent on the rising edge through the threshold (armed only),
   * otherwise null. Samples with a null value (tracking lost) keep the state but break interpolation.
   */
  push(value: number | null, tSec: number): TriggerEvent | null {
    if (value === null || !Number.isFinite(value)) {
      this.prevValue = NaN;
      this.prevTime = NaN;
      return null;
    }
    let event: TriggerEvent | null = null;
    if (this._armed) {
      if (value >= this.threshold) {
        let crossTime = tSec;
        if (!Number.isNaN(this.prevValue) && this.prevValue < this.threshold && tSec > this.prevTime) {
          const f = (this.threshold - this.prevValue) / (value - this.prevValue);
          crossTime = this.prevTime + f * (tSec - this.prevTime);
        }
        this._armed = false;
        this._peak = value;
        this.repStart = crossTime;
        this.repEmitted = crossTime - this.lastEventTime >= this.minIntervalSec;
        if (this.repEmitted) {
          this.lastEventTime = crossTime;
          event = { ctxTime: crossTime, strength: value };
        }
      }
    } else {
      if (value > this._peak) this._peak = value;
      if (value < this.rearmLevel) {
        this._armed = true;
        this.completed = { ctxTime: this.repStart, endCtxTime: tSec, peak: this._peak, emitted: this.repEmitted };
        this._peak = 0;
        this.repStart = NaN;
        this.repEmitted = false;
      }
    }
    this.prevValue = value;
    this.prevTime = tSec;
    return event;
  }
}
