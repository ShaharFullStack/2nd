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
 *   - `setThreshold()` re-checks the arming against the NEW re-arm level, so making the game easier
 *     mid-song cannot hand out a free hit for a limb that is simply sitting where it already was;
 *   - a break in the sample stream LONGER than `maxGapSec` (a stalled camera / backgrounded tab)
 *     disarms an armed lane, because a rise could have happened and finished inside a window nobody
 *     watched.
 *
 * WHAT A SHORT BREAK DOES *NOT* DO (fixed after round 3): a dropped frame or a one-frame visibility dip
 * does NOT disarm an armed lane. The arming is a record of an observation that was actually made — "this
 * lane was seen below the re-arm level" — and a later frame going missing does not unmake it. If the last
 * observed value was below the re-arm level and the next observed value, no more than `maxGapSec` later,
 * is at or above the threshold, the rising edge demonstrably happened; refusing it lost BOTH the hit and
 * the rep (the patient sees an unexplained miss, the therapist's rep count under-reports), at a rate of
 * roughly 2.5 reps per 1% of dropped frames, with the status still reading a green "ok". The only thing a
 * short break costs is TIMING PRECISION, and that is measured rather than hidden: the crossing is
 * interpolated between the two samples that actually bracket it (the last observed one and the current
 * one), so the estimate stays unbiased with an uncertainty of about half the gap instead of being pinned,
 * a whole gap late, to the recovery frame. Such events carry `afterGap: true` and their real `gapSec`,
 * and the rep carries `gapped: true` — flagged exactly the way `truncated` reps are.
 *
 * A DROPOUT IS A MEASUREMENT, NOT AN ANNOUNCEMENT (fixed after round 4). "Frames were dropped" is not
 * only the case where a null sample arrived or the gap blew past `maxGapSec` — the ordinary shape of a
 * GC pause, a tab hiccup, or the detect loop's own adaptive throttle is that samples simply stop for
 * 100-400 ms and then resume, with nothing pushed in between and `maxGapSec` never exceeded. The trigger
 * therefore measures the stream's own nominal interval (the median of the last few) and treats anything
 * beyond `gapFactor` x that as a dropout for TIMING purposes: `afterGap` on the event, `gapped` on the
 * rep, with the interpolation unchanged. Without this, a crossing whose true time was uncertain by
 * ±200 ms — wider than every difficulty's "good" window — was handed to the latency calibration and the
 * timing critics labelled clean, in exactly the situation the flag exists for.
 *
 * A SHORT break during a rep (state 'triggered') likewise does not invalidate the rep: the lane still
 * needs a below-re-arm sample to re-arm, which is exactly the arming condition. A break LONGER than
 * `maxGapSec` does end it: the rep is closed at the last sample actually observed and reported
 * `truncated: true`, because its peak and its end would otherwise describe a window nobody watched — a
 * blackout, the patient resting and starting a second rep, and the recovery would all be merged into one
 * rep with a ten-second span. The crossing that opened it was observed, so the rep still counts; its peak
 * is honestly a lower bound.
 */

export interface TriggerOptions {
  /** Normalized value that counts as a hit. Must be in (0, 1]: 0/NaN/>1 is refused (see validThreshold). */
  thresholdFraction: number;
  /** Re-arm when the value falls below thresholdFraction * rearmFraction (default 0.6). */
  rearmFraction?: number;
  /** Minimum time between two emitted events in seconds (default 0.3). */
  minIntervalSec?: number;
  /**
   * A sample arriving more than this long after the previous one (default 0.5 s) counts as a break in
   * the stream: an armed lane falls back to 'unconfirmed' and a rep in flight is closed as `truncated`.
   * Breaks SHORTER than this keep both the arming and the rep (see the class comment); the crossing is
   * then interpolated across the break and flagged `afterGap`.
   */
  maxGapSec?: number;
  /**
   * Expected spacing between consecutive samples (seconds). Default: MEASURED from the stream (the
   * median of the last few intervals), which is what a detect loop with an adaptive frame rate needs.
   * Set it to pin the expectation instead.
   */
  nominalIntervalSec?: number;
  /**
   * A sample arriving later than `gapFactor` x the nominal interval counts as a DROPOUT for timing
   * purposes (default 1.5, i.e. one whole missing frame): the crossing is still interpolated and still
   * scored, but it is flagged `afterGap` and its rep `gapped`. See `isTimingGap`.
   */
  gapFactor?: number;
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
  /**
   * True when `ctxTime` was interpolated between the two samples that bracket the crossing. False only
   * when there was no usable sample below the threshold to interpolate from (the very first sample of a
   * stream), in which case `ctxTime` is the crossing frame's own time and is late by up to one interval.
   */
  interpolated: boolean;
  /**
   * Interval between the two samples the crossing was measured across (seconds). The timing uncertainty
   * is about half of this — normally one frame (~33 ms at 30 fps), more when frames were dropped.
   */
  gapSec: number;
  /**
   * Present (true) when one or more frames were missing immediately before the crossing, so `gapSec` is
   * wider than a frame interval and the crossing time is correspondingly less precise. The event is
   * still honest — the rise was observed from below the re-arm level to above the threshold.
   *
   * SET BY MEASUREMENT, NOT BY EVENT. It does not require anyone to have NOTICED the break: the flag is
   * raised whenever `gapSec` exceeds `gapFactor` x the stream's own nominal interval, which is the only
   * form the common cases take. A GC pause, a backgrounded tab, and the detect loop's own adaptive
   * throttle (mediapipe.ts DetectLoop.chargeBudget, which can stretch the period to 1/12 s) all deliver
   * NO null samples and no over-long break — frames simply stop arriving for a while and then resume.
   * Flagging only on an observed break let a crossing whose true time was uncertain by ±200 ms — wider
   * than every difficulty's "good" window — enter the latency estimate labelled clean.
   */
  afterGap?: boolean;
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
  /**
   * True when the rep was closed by a break in the sample stream (occlusion / stalled camera) rather
   * than by an observed return to rest: `endCtxTime` is the last sample actually seen and `peak` is a
   * LOWER BOUND on the ROM reached. Rehab metrics should keep such reps but must not treat their peak
   * as a measurement.
   */
  truncated?: boolean;
  /**
   * True when frames were dropped DURING the rep (or immediately before its crossing) but the stream
   * recovered inside `maxGapSec`, so the rep was kept. It is a real rep with a real crossing; its peak
   * is a lower bound (the maximum may have fallen in the dropout) and its start time is less precise.
   */
  gapped?: boolean;
}

/** 'unconfirmed' = never seen below the re-arm level since the last break/reset, so it cannot fire. */
export type TriggerState = 'unconfirmed' | 'armed' | 'triggered';

export const DEFAULT_REARM_FRACTION = 0.6;
export const DEFAULT_MIN_INTERVAL_SEC = 0.3;
export const DEFAULT_MAX_GAP_SEC = 0.5;
/** A sample later than this multiple of the nominal interval is a timing dropout (see `isTimingGap`). */
export const DEFAULT_GAP_FACTOR = 1.5;
/**
 * Absolute floor under which no interval is ever called a dropout (seconds). At 60 fps 1.5 frames is
 * 25 ms, so this only ever guards against a freakishly short first interval setting an absurd
 * expectation before the median has anything to work with.
 */
export const MIN_TIMING_GAP_SEC = 0.02;
/** How many recent intervals the nominal-interval estimate is the median of. */
const INTERVAL_WINDOW = 8;

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

/**
 * The hit threshold, vetted.
 *
 * A NON-POSITIVE OR NON-FINITE THRESHOLD IS A DEAD LANE, SILENTLY. At 0 the re-arm level is 0 too, so
 * `value < rearmLevel` is never true, the lane never leaves 'unconfirmed' and no rising edge can ever be
 * observed — every note in it misses, and the only symptom is a puzzling 'lane_pinned' 8 s later (the
 * lane is trivially "at or above" 0 from its first frame). NaN is worse: every comparison against it is
 * false, so the lane is equally dead AND no watchdog fires at all. Above 1 the lane is unreachable by
 * construction. None of that is a degraded configuration a patient can play through, so it is refused
 * here rather than diagnosed later. (Chart JSON validation accepts thresholdFraction 0 — see
 * src/charts/generate.ts — so this IS reachable from stored data.)
 */
function validThreshold(thresholdFraction: number): number {
  if (!Number.isFinite(thresholdFraction) || thresholdFraction <= 0 || thresholdFraction > 1) {
    throw new Error(`LaneTrigger: thresholdFraction ${thresholdFraction} must be a number in (0, 1] — a lane with a 0/NaN threshold can never re-arm and would miss every note in silence`);
  }
  return thresholdFraction;
}

/** Insert into an ascending array (window of 8: a linear scan beats an allocation + sort). */
function insertSorted(sorted: number[], v: number): void {
  let i = sorted.length;
  while (i > 0 && sorted[i - 1] > v) i--;
  sorted.splice(i, 0, v);
}

/** Remove one occurrence of `v` from an ascending array. */
function removeSorted(sorted: number[], v: number): void {
  const i = sorted.indexOf(v);
  if (i >= 0) sorted.splice(i, 1);
}

export class LaneTrigger {
  private threshold: number;
  private rearmFraction: number;
  private minIntervalSec: number;
  private maxGapSec: number;
  private _state: TriggerState = 'unconfirmed';
  private prevValue = NaN;
  private prevTime = NaN;
  /** Time of the last sample actually observed (survives breakContinuity, unlike prevTime). */
  private lastObservedTime = NaN;
  /** Value of the last sample actually observed (survives breakContinuity, unlike prevValue). */
  private lastObservedValue = NaN;
  private lastEventTime = -Infinity;
  private _peak = 0;
  private _rawPeak = 0;
  private repStart = NaN;
  private repEmitted = false;
  private repGapped = false;
  private completed: CompletedRep | null = null;
  private readonly pinnedInterval: number | null;
  private readonly gapFactor: number;
  /** Recent sample intervals (seconds), newest last; the median is the nominal interval. */
  private intervals: number[] = [];
  /**
   * The same intervals kept in ASCENDING order, so the median is an index lookup.
   *
   * `isTimingGap` is read on every push — every lane, every frame, ~120 reads/s at 4 lanes and 30 fps —
   * and used to allocate a copy of the window and sort it each time. The window is 8 elements, so an
   * insertion into a sorted array is a handful of comparisons and no allocation at all, and the 60 fps
   * highway keeps the slice this used to spend on garbage.
   */
  private sortedIntervals: number[] = [];

  constructor(opts: TriggerOptions) {
    this.threshold = validThreshold(opts.thresholdFraction);
    this.rearmFraction = opts.rearmFraction ?? DEFAULT_REARM_FRACTION;
    this.minIntervalSec = opts.minIntervalSec ?? DEFAULT_MIN_INTERVAL_SEC;
    this.maxGapSec = opts.maxGapSec ?? DEFAULT_MAX_GAP_SEC;
    const nominal = opts.nominalIntervalSec;
    this.pinnedInterval = nominal !== undefined && Number.isFinite(nominal) && nominal > 0 ? nominal : null;
    const f = opts.gapFactor;
    this.gapFactor = f !== undefined && Number.isFinite(f) && f > 1 ? f : DEFAULT_GAP_FACTOR;
  }

  /**
   * The stream's nominal sample interval: the pinned `nominalIntervalSec`, else the median of the last
   * few observed intervals, else null before any has been seen. A MEDIAN, not a mean: the whole point is
   * to describe the normal frame spacing while dropouts are present, and one 400 ms hole must not raise
   * the bar it is supposed to be measured against.
   */
  get nominalIntervalSec(): number | null {
    if (this.pinnedInterval !== null) return this.pinnedInterval;
    const n = this.sortedIntervals.length;
    if (n === 0) return null;
    const sorted = this.sortedIntervals;
    return n % 2 === 1 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  }

  /**
   * True when an interval of `gapSec` is long enough to count as dropped frames rather than the normal
   * cadence — i.e. the crossing it brackets must be labelled `afterGap` even though nothing announced a
   * break. Unknown cadence (the very first interval of a stream) is never a gap: with nothing to compare
   * against, calling it one would flag every session's first rep.
   */
  isTimingGap(gapSec: number): boolean {
    const nominal = this.nominalIntervalSec;
    if (nominal === null || !Number.isFinite(gapSec)) return false;
    return gapSec > Math.max(nominal * this.gapFactor, MIN_TIMING_GAP_SEC);
  }

  private recordInterval(gapSec: number): void {
    if (!Number.isFinite(gapSec) || gapSec <= 0) return;
    this.intervals.push(gapSec);
    insertSorted(this.sortedIntervals, gapSec);
    if (this.intervals.length > INTERVAL_WINDOW) {
      const evicted = this.intervals.shift() as number;
      removeSorted(this.sortedIntervals, evicted);
    }
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

  /** Last value actually observed (NaN before the first sample). Survives dropouts. */
  get lastValue(): number {
    return this.lastObservedValue;
  }

  /**
   * Change the hit threshold mid-session (a therapist making the game easier or harder).
   *
   * THE ARMING IS RE-CHECKED, and that is not a detail: 'armed' means "seen below the re-arm level", a
   * statement about the OLD level. Lowering the threshold lowers the re-arm level with it, so a lane
   * resting at 0.40 — armed under threshold 0.8 (re-arm 0.48) — is, under threshold 0.3 (re-arm 0.18),
   * both un-armable AND already above the threshold: the very next sample of the same, motionless 0.40
   * used to emit a hit for zero movement, one free hit per lane per adjustment. A lane whose last
   * observed value is not below the NEW re-arm level therefore goes back to 'unconfirmed' and must be
   * seen returning to rest before it can score again, exactly like a fresh lane.
   */
  setThreshold(thresholdFraction: number): void {
    const t = validThreshold(thresholdFraction);
    if (t === this.threshold) return;
    this.threshold = t;
    if (this._state === 'armed' && !(this.lastObservedValue < this.rearmLevel)) this._state = 'unconfirmed';
  }

  /** Full reset. The lane comes back DISARMED: it must be seen below the re-arm level before it can fire. */
  reset(): void {
    this._state = 'unconfirmed';
    this.prevValue = NaN;
    this.prevTime = NaN;
    this.lastObservedTime = NaN;
    this.lastObservedValue = NaN;
    this.lastEventTime = -Infinity;
    this._peak = 0;
    this._rawPeak = 0;
    this.repStart = NaN;
    this.repEmitted = false;
    this.repGapped = false;
    this.completed = null;
    this.intervals = [];
    this.sortedIntervals = [];
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
      this.breakContinuity(tSec);
      return null;
    }
    const raw = rawValue === undefined || !Number.isFinite(rawValue) ? value : rawValue;
    const gap = Number.isNaN(this.prevTime) ? Infinity : tSec - this.prevTime;
    // A gap that is long but still inside maxGapSec: nothing is forgotten (the previous sample is still
    // the interpolation reference), but the timing is degraded and must be labelled as such. This is the
    // ordinary shape of a GC pause / tab hiccup / adaptive throttle — no null sample, no long break, the
    // frames simply stop for a few hundred ms and resume.
    const timingGap = gap > 0 && Number.isFinite(gap) && this.isTimingGap(gap);
    if (!(gap >= 0) || gap > this.maxGapSec) this.breakContinuity(tSec);
    else this.recordInterval(gap);

    let event: TriggerEvent | null = null;
    if (timingGap && this._state === 'triggered') this.repGapped = true;
    if (this._state === 'triggered') {
      if (value > this._peak) this._peak = value;
      if (raw > this._rawPeak) this._rawPeak = raw;
      if (value < this.rearmLevel) {
        this._state = 'armed';
        this.completed = { ctxTime: this.repStart, endCtxTime: tSec, peak: this._peak, rawPeak: this._rawPeak, emitted: this.repEmitted };
        if (this.repGapped) this.completed.gapped = true;
        this.clearRep();
      }
    } else if (value >= this.threshold) {
      // Only an ARMED lane may fire: 'unconfirmed' means no below-re-arm observation was made since the
      // last reset/break, so this level was never *risen through* as far as this trigger knows.
      if (this._state === 'armed') {
        // The sample to measure the crossing FROM. Normally the previous frame; after a dropout the last
        // frame actually observed, which is still a real observation below the threshold (and, since the
        // lane is still armed, no more than maxGapSec old). Interpolating across it beats pinning the
        // crossing to this frame, which would be a whole gap late instead of half a gap uncertain.
        const broke = Number.isNaN(this.prevValue);
        // Either kind of dropout degrades the crossing time: an OBSERVED break (a null sample or a gap
        // past maxGapSec, which cleared prevValue) or a MEASURED one (frames that merely stopped
        // arriving for longer than the stream's own cadence allows).
        const afterGap = broke || timingGap;
        const refValue = broke ? this.lastObservedValue : this.prevValue;
        const refTime = broke ? this.lastObservedTime : this.prevTime;
        let crossTime = tSec;
        let interpolated = false;
        let gapSec = NaN;
        if (!Number.isNaN(refValue) && refValue < this.threshold && tSec > refTime) {
          const f = (this.threshold - refValue) / (value - refValue);
          crossTime = refTime + f * (tSec - refTime);
          interpolated = true;
          gapSec = tSec - refTime;
        }
        this._state = 'triggered';
        this._peak = value;
        this._rawPeak = raw;
        this.repStart = crossTime;
        this.repGapped = afterGap;
        this.repEmitted = crossTime - this.lastEventTime >= this.minIntervalSec;
        if (this.repEmitted) {
          this.lastEventTime = crossTime;
          event = { ctxTime: crossTime, strength: value, rawStrength: raw, interpolated, gapSec };
          if (afterGap) event.afterGap = true;
        }
      }
    } else if (value < this.rearmLevel) {
      // The confirmed below-re-arm observation the rising edge is measured from.
      this._state = 'armed';
    }
    this.prevValue = value;
    this.prevTime = tSec;
    this.lastObservedTime = tSec;
    this.lastObservedValue = value;
    return event;
  }

  private clearRep(): void {
    this._peak = 0;
    this._rawPeak = 0;
    this.repStart = NaN;
    this.repEmitted = false;
    this.repGapped = false;
  }

  /**
   * A null sample or an over-long gap. Interpolation from the PREVIOUS FRAME is impossible either way
   * (prevValue/prevTime are cleared), but what happens to the state depends on how long the break is:
   *
   *  - SHORT (<= maxGapSec): nothing is forgotten. An armed lane STAYS armed — the below-re-arm sample it
   *    was armed by was really observed, and a missing frame afterwards does not unmake that observation,
   *    so a rise that resumes within the window is still a rise this trigger watched from below. A rep in
   *    flight likewise survives. Both are marked `gapped` so the widened timing/peak uncertainty travels
   *    with the data. (Before this rule, ONE dropped frame during the rise silently cost the hit AND the
   *    rep, with no status anyone could act on.)
   *  - LONG (> maxGapSec): an armed lane is disarmed, because a whole rep could have started and finished
   *    unobserved, and a rep in flight is CLOSED at the last sample actually observed and reported
   *    `truncated: true` — everything after the blackout belongs to a movement this trigger never watched
   *    and must not be folded into the peak or the duration of the rep that was open when the stream died.
   *
   * @param tSec time of the sample that revealed the break (a null sample, or the one after the gap).
   */
  private breakContinuity(tSec: number): void {
    this.prevValue = NaN;
    this.prevTime = NaN;
    const observedGap = Number.isNaN(this.lastObservedTime) || !Number.isFinite(tSec) ? Infinity : tSec - this.lastObservedTime;
    const shortBreak = observedGap >= 0 && observedGap <= this.maxGapSec;
    if (this._state === 'armed') {
      if (!shortBreak) this._state = 'unconfirmed';
      return;
    }
    if (this._state !== 'triggered') return;
    if (shortBreak) {
      this.repGapped = true; // a dropped frame or two: the rep survives it, flagged
      return;
    }
    this._state = 'unconfirmed';
    this.completed = {
      ctxTime: this.repStart,
      endCtxTime: this.lastObservedTime,
      peak: this._peak,
      rawPeak: this._rawPeak,
      emitted: this.repEmitted,
      truncated: true,
    };
    if (this.repGapped) this.completed.gapped = true;
    this.clearRep();
  }
}
