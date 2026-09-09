/**
 * LaneTrigger: rising-edge detector over a normalized (0..1) value stream with hysteresis, a minimum
 * re-trigger interval, and sub-frame crossing time interpolation.
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
  /** Value at the frame that crossed (>= threshold). Fraction of ROM reached. */
  strength: number;
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
        if (crossTime - this.lastEventTime >= this.minIntervalSec) {
          this.lastEventTime = crossTime;
          event = { ctxTime: crossTime, strength: value };
        }
      }
    } else {
      if (value > this._peak) this._peak = value;
      if (value < this.rearmLevel) {
        this._armed = true;
        this._peak = 0;
      }
    }
    this.prevValue = value;
    this.prevTime = tSec;
    return event;
  }
}
