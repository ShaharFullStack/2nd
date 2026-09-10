/**
 * ROM calibration state machine.
 *   'rest'  : patient holds still: the last `restDurationSec` of samples (>= minRestSamples, and still)
 *             -> min = median(rest window). Compensation quantities measured over the same window
 *             -> compensationBaseline (medians).
 *   'move'  : patient performs `reps` comfortable reps -> max = 90th percentile of detected peaks
 *   'done'  : RomCalibration available (or error 'insufficient_range' with guidance)
 * Peaks are found with a simple prominence rule: a rise of >= prominence above the last trough starts a
 * candidate; the candidate's running maximum becomes a peak once the value drops >= prominence below it.
 *
 * SIGNAL PATH: feed the calibrator the SAME smoothed feature the play pipeline uses (LanePipeline /
 * `pushSample`), never the raw extractor output, so the calibrated range and the played value see an
 * identical filter and thresholdFraction of ROM is reachable at tempo.
 */
import type { Movement } from '../engine/types.ts';
import { MOVEMENT_INFO, baselineFromSamples } from './features.ts';
import type { CompensationBaseline, CompensationSample } from './features.ts';
import { clamp01 } from './landmarks.ts';
import { median, percentile } from './stats.ts';

export { median, percentile };

export interface RomCalibration {
  /** Feature value at rest. */
  min: number;
  /** Feature value at comfortable maximum. */
  max: number;
  /** Number of feature samples that contributed. */
  samples: number;
  /** Detected rep peaks (feature units), for therapist review. */
  peaks?: number[];
  movement?: Movement;
  /** Rest-phase compensation baseline (median over the rest window), when the movement monitors one. */
  compensationBaseline?: CompensationBaseline | null;
  /** True when a therapist adjusted the range by hand (nudge/setRange) rather than it being measured. */
  manual?: boolean;
}

export type CalibrationPhase = 'rest' | 'move' | 'done';
export type CalibrationError = 'insufficient_range' | 'no_reps';

export interface CalibrationStatus {
  phase: CalibrationPhase;
  /** 0..1 progress of the rest hold. */
  restProgress: number;
  /** False while the rest window is not still enough to be used (message says "hold still"). */
  restStill: boolean;
  /** Reps detected so far in the move phase. */
  repsDetected: number;
  repsRequired: number;
  /** Provisional / final min and max. */
  min: number | null;
  max: number | null;
  error: CalibrationError | null;
  /** Human guidance for the current state. */
  message: string;
  /** Samples fed to the current phase. */
  samples: number;
}

export interface CalibratorOptions {
  /** Seconds of rest samples to collect (default 2). */
  restDurationSec?: number;
  /** Minimum number of rest samples before the rest phase may end (default 30, i.e. >= 1 s at 30 fps). */
  minRestSamples?: number;
  /**
   * Stillness guard: the rest window's 10th..90th percentile spread must be below this fraction of
   * minRom before auto-advancing (default 0.35). The window keeps sliding until the patient is still.
   *
   * WHY 0.35 AND NOT MORE: `min` is the MEDIAN of this window and every normalized value in the session
   * is measured from it. At 0.75 a rest window drifting 42% of seated_march's minimum ROM counted as
   * "still", so `min` was a median over a moving target and the whole normalization could be biased by
   * a third of the guard value — the patient then plays a game whose zero is somewhere inside their
   * movement. Spread alone is also not enough: a slow, steady drift has a small spread at every instant,
   * so `restDriftFraction` additionally bounds the trend across the window.
   */
  stillnessFraction?: number;
  /**
   * Trend guard: |median(first half of the rest window) - median(second half)| must be below this
   * fraction of minRom (default 0.2). Catches a steadily drifting rest position, which a percentile
   * spread over the same window barely registers.
   */
  restDriftFraction?: number;
  /** Give up waiting for stillness and advance after this many seconds of rest (default 10). */
  restTimeoutSec?: number;
  /** Reps to collect (default 3). */
  reps?: number;
  /** Override the per-movement minimum ROM (feature units). */
  minRom?: number;
  /** Peak prominence in feature units (default 0.5 * minRom). */
  prominence?: number;
  /** Percentile (0..1) of peaks used as max (default 0.9). */
  peakPercentile?: number;
  /** Automatically advance rest -> move once the rest window is full (default true). */
  autoAdvance?: boolean;
  /** Maximum seconds in the move phase before giving up with 'no_reps' (default 30). */
  moveTimeoutSec?: number;
}

/** What the calibrator consumes per frame (LanePipeline's LaneSample satisfies this). */
export interface CalibrationSample {
  /** Smoothed feature (null when tracking was lost this frame). */
  smoothed: number | null;
  /** Sample time (seconds). */
  t: number;
  /** Raw compensation quantities for the frame, if the movement monitors any. */
  compensationSample?: CompensationSample | null;
}

/** clamp((feature - min)/(max - min), 0, 1). Returns 0 for a degenerate range. */
export function normalizeFeature(cal: Pick<RomCalibration, 'min' | 'max'>, feature: number): number {
  return clamp01(normalizeFeatureRaw(cal, feature));
}

/**
 * (feature - min)/(max - min) WITHOUT the 0..1 clamp. Returns 0 for a degenerate range.
 * Cross-session ROM gain is the therapeutic outcome, so a patient who outgrows their calibration must
 * stay measurable: the clamped value drives thresholds/meters, this one drives the recorded metrics
 * (LaneRepEvent.rawPeak / LaneInputEvent.rawStrength).
 */
export function normalizeFeatureRaw(cal: Pick<RomCalibration, 'min' | 'max'>, feature: number): number {
  const range = cal.max - cal.min;
  if (!(range > 1e-9)) return 0;
  return (feature - cal.min) / range;
}

/**
 * True when a calibration spans at least the movement's minimum ROM (its `minRom`), i.e. when
 * normalizing against it is meaningful.
 *
 * THIS IS A BOUNDARY CHECK, NOT A FORMALITY. `setManualRange` accepts anything, `reconcile` only keeps
 * max above min by 1e-6, `getProvisional` hands back the range of an ERRORED calibration, and a stale
 * calibration can arrive from localStorage months later. Any of those can produce a range of, say,
 * 0.001 on seated_march (minRom 0.12) — and then 1% of the patient's real ROM is a full-scale hit, so
 * hand tremor scores. Every consumer that turns a feature into a SCORE must run this first; VisionInput
 * does, and refuses to play a lane that fails (see VisionInput.getInvalidCalibrationLanes).
 */
export function isCalibrationValid(cal: Pick<RomCalibration, 'min' | 'max'> | null | undefined, movement?: Movement): boolean {
  if (!cal || !Number.isFinite(cal.min) || !Number.isFinite(cal.max)) return false;
  const minRom = movement ? MOVEMENT_INFO[movement].minRom : 1e-6;
  return cal.max - cal.min >= minRom;
}

/** Why a calibration was rejected (null = usable). Suitable for a therapist-facing message. */
export function calibrationProblem(cal: Pick<RomCalibration, 'min' | 'max'> | null | undefined, movement: Movement): string | null {
  if (!cal) return null;
  if (!Number.isFinite(cal.min) || !Number.isFinite(cal.max)) return 'the range is not a number';
  const info = MOVEMENT_INFO[movement];
  const rom = cal.max - cal.min;
  if (rom >= info.minRom) return null;
  // Keep a tiny range legible: "0%" reads as a formatting bug, "0.1%" reads as the actual problem.
  const fmt = (v: number) => {
    if (info.unit === 'deg') return `${v < 1 ? v.toFixed(1) : v.toFixed(0)}°`;
    const pct = v * 100;
    return `${pct > 0 && pct < 1 ? pct.toFixed(1) : pct.toFixed(0)}%`;
  };
  return `the calibrated range is only ${fmt(rom)}, below the ${fmt(info.minRom)} minimum for ${info.label.toLowerCase()}`;
}

export class RomCalibrator {
  readonly movement: Movement;
  readonly restDurationSec: number;
  readonly minRestSamples: number;
  readonly stillnessFraction: number;
  readonly restDriftFraction: number;
  readonly restTimeoutSec: number;
  readonly repsRequired: number;
  readonly minRom: number;
  readonly prominence: number;
  readonly peakPercentile: number;
  readonly autoAdvance: boolean;
  readonly moveTimeoutSec: number;

  private phase: CalibrationPhase = 'rest';
  private error: CalibrationError | null = null;
  /** Rest samples with times; only the trailing restDurationSec window is used. */
  private restSamples: number[] = [];
  private restTimes: number[] = [];
  /** Compensation samples with THEIR OWN times: they are sparser than the feature samples. */
  private restComp: CompensationSample[] = [];
  private restCompTimes: number[] = [];
  private restStart = NaN;
  private restEnd = NaN;
  private restTotal = 0;
  private restStill = false;
  private moveStart = NaN;
  private moveSamples = 0;
  private min: number | null = null;
  private max: number | null = null;
  private baseline: CompensationBaseline | null = null;
  private peaks: number[] = [];
  private manualAdjusted = false;
  /** Highest feature seen in the move phase, so a 'no_reps' lane still offers a starting range. */
  private moveMax = -Infinity;
  // peak detection
  private trough = Infinity;
  private candidate = -Infinity;
  private rising = false;

  constructor(movement: Movement, opts: CalibratorOptions = {}) {
    this.movement = movement;
    this.restDurationSec = opts.restDurationSec ?? 2;
    this.minRestSamples = opts.minRestSamples ?? 30;
    this.stillnessFraction = opts.stillnessFraction ?? 0.35;
    this.restDriftFraction = opts.restDriftFraction ?? 0.2;
    this.restTimeoutSec = opts.restTimeoutSec ?? 10;
    this.repsRequired = opts.reps ?? 3;
    this.minRom = opts.minRom ?? MOVEMENT_INFO[movement].minRom;
    this.prominence = opts.prominence ?? this.minRom * 0.5;
    this.peakPercentile = opts.peakPercentile ?? 0.9;
    this.autoAdvance = opts.autoAdvance ?? true;
    this.moveTimeoutSec = opts.moveTimeoutSec ?? 30;
  }

  getPhase(): CalibrationPhase {
    return this.phase;
  }

  getError(): CalibrationError | null {
    return this.error;
  }

  isDone(): boolean {
    return this.phase === 'done';
  }

  /** 0..1: fraction of the rest window filled (time AND sample count). */
  restProgress(): number {
    if (this.phase !== 'rest') return 1;
    if (Number.isNaN(this.restStart)) return 0;
    const byTime = clamp01((this.restEnd - this.restStart) / this.restDurationSec);
    const byCount = clamp01(this.restSamples.length / this.minRestSamples);
    return Math.min(byTime, byCount);
  }

  /** True when the trailing rest window is quiet enough to define the rest position. */
  isRestStill(): boolean {
    return this.restStill;
  }

  /** Feed a pipeline sample (smoothed feature + optional compensation quantities). */
  pushSample(sample: CalibrationSample): CalibrationPhase {
    return this.push(sample.smoothed, sample.t, sample.compensationSample);
  }

  /**
   * Feed one feature sample at time tSec. Use the SMOOTHED feature from the lane pipeline. null samples
   * (tracking lost) are ignored. `comp` = this frame's raw compensation quantities (rest phase only).
   */
  push(feature: number | null, tSec: number, comp?: CompensationSample | null): CalibrationPhase {
    if (feature === null || !Number.isFinite(feature)) return this.phase;
    if (this.phase === 'rest') {
      if (Number.isNaN(this.restStart)) this.restStart = tSec;
      this.restEnd = tSec;
      this.restTotal++;
      this.restSamples.push(feature);
      this.restTimes.push(tSec);
      if (comp) {
        this.restComp.push(comp);
        this.restCompTimes.push(tSec);
      }
      // Slide the window: keep only the trailing restDurationSec (but never fewer than minRestSamples).
      while (this.restSamples.length > this.minRestSamples && this.restTimes[0] < tSec - this.restDurationSec) {
        this.restSamples.shift();
        this.restTimes.shift();
      }
      // The compensation baseline MUST describe the same rest window as `min`, so it is windowed on its
      // OWN timestamps against the feature window's start. Compensation is measured far less often than
      // the feature (the heel is the least reliably visible pose landmark), so a length-match would let
      // the baseline span several times the rest window and describe a completely different posture.
      // Only when every comp sample predates the window is the most recent one kept (best available).
      const windowStart = this.restTimes[0];
      while (this.restCompTimes.length > 1 && this.restCompTimes[0] < windowStart) {
        this.restComp.shift();
        this.restCompTimes.shift();
      }
      const windowFull = tSec - this.restStart >= this.restDurationSec && this.restSamples.length >= this.minRestSamples;
      this.restStill = windowFull && this.computeStillness();
      const timedOut = tSec - this.restStart >= this.restTimeoutSec && this.restSamples.length >= this.minRestSamples;
      if (this.autoAdvance && (this.restStill || timedOut)) this.beginMove();
    } else if (this.phase === 'move') {
      if (Number.isNaN(this.moveStart)) this.moveStart = tSec;
      this.moveSamples++;
      if (feature > this.moveMax) this.moveMax = feature;
      this.detectPeak(feature);
      if (this.peaks.length >= this.repsRequired) this.finish();
      else if (tSec - this.moveStart > this.moveTimeoutSec) {
        if (this.peaks.length > 0) this.finish();
        else {
          this.error = 'no_reps';
          this.phase = 'done';
        }
      }
    }
    return this.phase;
  }

  private computeStillness(): boolean {
    if (this.restSamples.length < 2) return false;
    const spread = percentile(this.restSamples, 0.9) - percentile(this.restSamples, 0.1);
    if (spread > this.minRom * this.stillnessFraction) return false;
    // Trend guard: a slow steady drift keeps the instantaneous spread small but moves the median the
    // whole session is normalized from. Compare the two halves of the window.
    const half = this.restSamples.length >> 1;
    if (half < 2) return true;
    const drift = Math.abs(median(this.restSamples.slice(this.restSamples.length - half)) - median(this.restSamples.slice(0, half)));
    return drift <= this.minRom * this.restDriftFraction;
  }

  /** Drift of the rest window (second-half median minus first-half median), for a calibration screen. */
  restDrift(): number {
    const half = this.restSamples.length >> 1;
    if (half < 2) return 0;
    return median(this.restSamples.slice(this.restSamples.length - half)) - median(this.restSamples.slice(0, half));
  }

  /** Manually end the rest phase (e.g. therapist pressed "Next"). Requires at least one rest sample. */
  beginMove(): boolean {
    if (this.phase !== 'rest' || this.restSamples.length === 0) return false;
    this.min = median(this.restSamples);
    this.baseline = baselineFromSamples(this.restComp);
    this.phase = 'move';
    this.moveStart = NaN;
    this.moveSamples = 0;
    this.moveMax = -Infinity;
    this.peaks = [];
    this.trough = this.min;
    this.candidate = -Infinity;
    this.rising = false;
    this.error = null;
    return true;
  }

  private detectPeak(v: number): void {
    if (!this.rising) {
      if (v < this.trough) this.trough = v;
      if (v - this.trough >= this.prominence) {
        this.rising = true;
        this.candidate = v;
      }
    } else {
      if (v > this.candidate) this.candidate = v;
      if (this.candidate - v >= this.prominence) {
        this.peaks.push(this.candidate);
        this.rising = false;
        this.trough = v;
        this.candidate = -Infinity;
      }
    }
  }

  /** Finish the move phase now with whatever peaks were detected (used by a therapist "Done" button). */
  finish(): CalibrationPhase {
    if (this.phase !== 'move') return this.phase;
    // A rep still in progress (rose but never fell back) counts as a peak.
    if (this.rising && this.candidate > -Infinity) this.peaks.push(this.candidate);
    if (this.peaks.length === 0) {
      this.error = 'no_reps';
      this.phase = 'done';
      return this.phase;
    }
    this.max = percentile(this.peaks, this.peakPercentile);
    this.error = this.max - (this.min as number) < this.minRom ? 'insufficient_range' : null;
    this.phase = 'done';
    return this.phase;
  }

  /**
   * Restart the move phase (after insufficient_range / no_reps), keeping the rest baseline.
   * Returns true when the rest baseline could be reused and the calibrator is back in 'move'.
   *
   * When there are no rest samples to reuse — the therapist called setManualRange() straight from the
   * rest phase, or reset() ran — it falls back to a FULL RESET and returns false, so a "try again"
   * button restarts the rest hold instead of silently doing nothing (it used to leave the phase at
   * 'rest' with the old error intact, which reads to the therapist as a dead button).
   */
  retryMove(): boolean {
    if (this.restSamples.length === 0) {
      this.reset();
      return false;
    }
    this.phase = 'rest';
    this.max = null;
    this.error = null;
    return this.beginMove();
  }

  reset(): void {
    this.phase = 'rest';
    this.error = null;
    this.restSamples = [];
    this.restTimes = [];
    this.restComp = [];
    this.restCompTimes = [];
    this.restStart = NaN;
    this.restEnd = NaN;
    this.restTotal = 0;
    this.restStill = false;
    this.moveStart = NaN;
    this.moveSamples = 0;
    this.moveMax = -Infinity;
    this.min = null;
    this.max = null;
    this.baseline = null;
    this.peaks = [];
    this.manualAdjusted = false;
    this.trough = Infinity;
    this.candidate = -Infinity;
    this.rising = false;
  }

  /* ---------- therapist adjustment ---------- */

  /** Shift min and/or max by feature-unit deltas (clamped so max stays above min). */
  nudge(minDelta: number, maxDelta: number): void {
    if (this.min !== null) this.min += minDelta;
    if (this.max !== null) this.max += maxDelta;
    this.manualAdjusted = true;
    this.reconcile();
  }

  /** Set min/max directly (either may be null to keep the current value). */
  setRange(min: number | null, max: number | null): void {
    if (min !== null) this.min = min;
    if (max !== null) this.max = max;
    this.manualAdjusted = true;
    this.reconcile();
  }

  /**
   * After a therapist override the range is whatever they set, so BOTH failure modes are rescuable:
   * 'insufficient_range' (the reps were too small) and 'no_reps' (the peak detector never saw a rep —
   * a slow, smooth patient, or a lane that lost tracking mid-attempt). Clearing only the former left
   * getResult() null forever, so a lane the therapist had explicitly measured by hand could not be
   * played at all. A manual range that is still below the movement's minimum ROM stays an error.
   */
  private reconcile(): void {
    if (this.min !== null && this.max !== null && this.max < this.min + 1e-6) this.max = this.min + 1e-6;
    if (this.phase === 'done' && this.min !== null && this.max !== null) {
      this.error = this.max - this.min < this.minRom ? 'insufficient_range' : null;
    }
  }

  private build(min: number, max: number): RomCalibration {
    return {
      min,
      max,
      samples: this.restTotal + this.moveSamples,
      peaks: this.peaks.slice(),
      movement: this.movement,
      compensationBaseline: this.baseline,
      manual: this.manualAdjusted,
    };
  }

  /** Final calibration, or null while not done / errored. */
  getResult(): RomCalibration | null {
    if (this.phase !== 'done' || this.error || this.min === null || this.max === null) return null;
    return this.build(this.min, this.max);
  }

  /**
   * Full therapist override from ANY phase: set both ends of the range and finish the calibration.
   * The escape hatch for a lane the automatic path cannot measure (a patient too slow/smooth for the
   * peak detector, a joint the therapist goniometers by hand): without it, a 'no_reps' lane could only
   * be retried, never overridden, and the session would have to drop the lane.
   * The rest-phase compensation baseline collected so far is kept.
   */
  setManualRange(min: number, max: number): void {
    if (this.phase === 'rest' && this.restSamples.length > 0 && this.baseline === null) {
      this.baseline = baselineFromSamples(this.restComp);
    }
    this.min = min;
    this.max = max;
    this.manualAdjusted = true;
    this.phase = 'done';
    this.reconcile();
  }

  /** True when the current range came from (or was adjusted by) a therapist override. */
  isManual(): boolean {
    return this.manualAdjusted;
  }

  /**
   * Best-effort calibration even when errored (for therapist override). When no rep was detected at all
   * ('no_reps' leaves `max` unset) the largest feature seen during the move phase stands in, so the
   * therapist screen has a real starting range to nudge instead of nothing at all.
   */
  getProvisional(): RomCalibration | null {
    if (this.min === null) return null;
    const max = this.max ?? (this.moveMax > this.min ? this.moveMax : null);
    if (max === null) return null;
    return this.build(this.min, max);
  }

  /** Rest-phase compensation baseline (median), available from the move phase on. */
  getCompensationBaseline(): CompensationBaseline | null {
    return this.baseline;
  }

  /** Normalize a feature with the current (possibly provisional) range. 0 when no range yet. */
  normalize(feature: number): number {
    if (this.min === null || this.max === null) return 0;
    return normalizeFeature({ min: this.min, max: this.max }, feature);
  }

  /** Same as normalize() but unclamped, so exceeding the calibrated ROM stays measurable (>1). */
  normalizeRaw(feature: number): number {
    if (this.min === null || this.max === null) return 0;
    return normalizeFeatureRaw({ min: this.min, max: this.max }, feature);
  }

  /**
   * The rest window `min` and the compensation baseline are BOTH taken from (seconds, sample counts).
   * Exposed so a calibration screen (and the tests) can prove the two describe the same window.
   */
  getRestWindow(): { startSec: number; endSec: number; samples: number; compensationSamples: number } {
    return {
      startSec: this.restTimes.length > 0 ? this.restTimes[0] : NaN,
      endSec: this.restTimes.length > 0 ? this.restTimes[this.restTimes.length - 1] : NaN,
      samples: this.restSamples.length,
      compensationSamples: this.restComp.length,
    };
  }

  getStatus(): CalibrationStatus {
    const info = MOVEMENT_INFO[this.movement];
    let message: string;
    if (this.phase === 'rest') {
      const full = this.restProgress() >= 1;
      message = full && !this.restStill ? `${info.restInstruction} Hold still…` : info.restInstruction;
    } else if (this.phase === 'move') message = `${info.calibrationInstruction} (${this.peaks.length}/${this.repsRequired})`;
    else if (this.error === 'insufficient_range') {
      message = `Not enough movement was detected (${this.formatRom()}). Try a bigger movement, move closer to the camera, or let the therapist adjust the range manually.`;
    } else if (this.error === 'no_reps') {
      message = 'No repetitions were detected. Make sure the whole limb is visible and try again.';
    } else message = this.manualAdjusted ? 'Range set manually by the therapist.' : 'Calibration complete.';
    const min = this.phase === 'rest' ? (this.restSamples.length > 0 ? median(this.restSamples) : null) : this.min;
    return {
      phase: this.phase,
      restProgress: this.restProgress(),
      restStill: this.phase !== 'rest' || this.restStill,
      repsDetected: this.peaks.length,
      repsRequired: this.repsRequired,
      min,
      max: this.max,
      error: this.error,
      message,
      samples: this.phase === 'rest' ? this.restTotal : this.moveSamples,
    };
  }

  private formatRom(): string {
    const info = MOVEMENT_INFO[this.movement];
    const rom = this.min !== null && this.max !== null ? this.max - this.min : 0;
    return info.unit === 'deg' ? `${rom.toFixed(0)}° of ${this.minRom}° needed` : `${(rom * 100).toFixed(0)}% of ${(this.minRom * 100).toFixed(0)}% needed`;
  }
}
