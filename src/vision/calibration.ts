/**
 * ROM calibration state machine.
 *   'rest'  : patient holds still >= restDurationSec  -> min = median(rest samples)
 *   'move'  : patient performs `reps` comfortable reps -> max = 90th percentile of detected peaks
 *   'done'  : RomCalibration available (or error 'insufficient_range' with guidance)
 * Peaks are found with a simple prominence rule: a rise of >= prominence above the last trough starts a
 * candidate; the candidate's running maximum becomes a peak once the value drops >= prominence below it.
 */
import type { Movement } from '../engine/types.ts';
import { MOVEMENT_INFO } from './features.ts';
import { clamp01 } from './landmarks.ts';

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
}

export type CalibrationPhase = 'rest' | 'move' | 'done';
export type CalibrationError = 'insufficient_range' | 'no_reps';

export interface CalibrationStatus {
  phase: CalibrationPhase;
  /** 0..1 progress of the rest hold. */
  restProgress: number;
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

export function median(values: readonly number[]): number {
  if (values.length === 0) return NaN;
  const s = values.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** Linear-interpolated percentile, p in 0..1. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return NaN;
  const s = values.slice().sort((a, b) => a - b);
  const pos = clamp01(p) * (s.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

/** clamp((feature - min)/(max - min), 0, 1). Returns 0 for a degenerate range. */
export function normalizeFeature(cal: Pick<RomCalibration, 'min' | 'max'>, feature: number): number {
  const range = cal.max - cal.min;
  if (!(range > 1e-9)) return 0;
  return clamp01((feature - cal.min) / range);
}

export function isCalibrationValid(cal: Pick<RomCalibration, 'min' | 'max'> | null | undefined, movement?: Movement): boolean {
  if (!cal || !Number.isFinite(cal.min) || !Number.isFinite(cal.max)) return false;
  const minRom = movement ? MOVEMENT_INFO[movement].minRom : 1e-6;
  return cal.max - cal.min >= minRom;
}

export class RomCalibrator {
  readonly movement: Movement;
  readonly restDurationSec: number;
  readonly repsRequired: number;
  readonly minRom: number;
  readonly prominence: number;
  readonly peakPercentile: number;
  readonly autoAdvance: boolean;
  readonly moveTimeoutSec: number;

  private phase: CalibrationPhase = 'rest';
  private error: CalibrationError | null = null;
  private restSamples: number[] = [];
  private restStart = NaN;
  private restEnd = NaN;
  private moveStart = NaN;
  private moveSamples = 0;
  private min: number | null = null;
  private max: number | null = null;
  private peaks: number[] = [];
  // peak detection
  private trough = Infinity;
  private candidate = -Infinity;
  private rising = false;

  constructor(movement: Movement, opts: CalibratorOptions = {}) {
    this.movement = movement;
    this.restDurationSec = opts.restDurationSec ?? 2;
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

  restProgress(): number {
    if (this.phase !== 'rest') return 1;
    if (Number.isNaN(this.restStart)) return 0;
    return clamp01((this.restEnd - this.restStart) / this.restDurationSec);
  }

  /** Feed one raw (or smoothed) feature sample at time tSec. null samples (tracking lost) are ignored. */
  push(feature: number | null, tSec: number): CalibrationPhase {
    if (feature === null || !Number.isFinite(feature)) return this.phase;
    if (this.phase === 'rest') {
      if (Number.isNaN(this.restStart)) this.restStart = tSec;
      this.restEnd = tSec;
      this.restSamples.push(feature);
      this.min = median(this.restSamples);
      if (this.autoAdvance && this.restEnd - this.restStart >= this.restDurationSec) this.beginMove();
    } else if (this.phase === 'move') {
      if (Number.isNaN(this.moveStart)) this.moveStart = tSec;
      this.moveSamples++;
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

  /** Manually end the rest phase (e.g. therapist pressed "Next"). Requires at least one rest sample. */
  beginMove(): boolean {
    if (this.phase !== 'rest' || this.restSamples.length === 0) return false;
    this.min = median(this.restSamples);
    this.phase = 'move';
    this.moveStart = NaN;
    this.moveSamples = 0;
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

  /** Restart the move phase (after insufficient_range), keeping the rest baseline. */
  retryMove(): void {
    this.phase = 'rest';
    this.max = null;
    this.beginMove();
  }

  reset(): void {
    this.phase = 'rest';
    this.error = null;
    this.restSamples = [];
    this.restStart = NaN;
    this.restEnd = NaN;
    this.moveStart = NaN;
    this.moveSamples = 0;
    this.min = null;
    this.max = null;
    this.peaks = [];
    this.trough = Infinity;
    this.candidate = -Infinity;
    this.rising = false;
  }

  /* ---------- therapist adjustment ---------- */

  /** Shift min and/or max by feature-unit deltas (clamped so max stays above min). */
  nudge(minDelta: number, maxDelta: number): void {
    if (this.min !== null) this.min += minDelta;
    if (this.max !== null) this.max += maxDelta;
    this.reconcile();
  }

  /** Set min/max directly (either may be null to keep the current value). */
  setRange(min: number | null, max: number | null): void {
    if (min !== null) this.min = min;
    if (max !== null) this.max = max;
    this.reconcile();
  }

  private reconcile(): void {
    if (this.min !== null && this.max !== null && this.max < this.min + 1e-6) this.max = this.min + 1e-6;
    if (this.phase === 'done' && this.min !== null && this.max !== null) {
      this.error = this.max - this.min < this.minRom ? 'insufficient_range' : this.error === 'insufficient_range' ? null : this.error;
    }
  }

  /** Final calibration, or null while not done / errored. */
  getResult(): RomCalibration | null {
    if (this.phase !== 'done' || this.error || this.min === null || this.max === null) return null;
    return { min: this.min, max: this.max, samples: this.restSamples.length + this.moveSamples, peaks: this.peaks.slice(), movement: this.movement };
  }

  /** Best-effort calibration even when errored (for therapist override). */
  getProvisional(): RomCalibration | null {
    if (this.min === null || this.max === null) return null;
    return { min: this.min, max: this.max, samples: this.restSamples.length + this.moveSamples, peaks: this.peaks.slice(), movement: this.movement };
  }

  /** Normalize a feature with the current (possibly provisional) range. 0 when no range yet. */
  normalize(feature: number): number {
    if (this.min === null || this.max === null) return 0;
    return normalizeFeature({ min: this.min, max: this.max }, feature);
  }

  getStatus(): CalibrationStatus {
    const info = MOVEMENT_INFO[this.movement];
    let message: string;
    if (this.phase === 'rest') message = info.restInstruction;
    else if (this.phase === 'move') message = `${info.calibrationInstruction} (${this.peaks.length}/${this.repsRequired})`;
    else if (this.error === 'insufficient_range') {
      message = `Not enough movement was detected (${this.formatRom()}). Try a bigger movement, move closer to the camera, or let the therapist adjust the range manually.`;
    } else if (this.error === 'no_reps') {
      message = 'No repetitions were detected. Make sure the whole limb is visible and try again.';
    } else message = 'Calibration complete.';
    return {
      phase: this.phase,
      restProgress: this.restProgress(),
      repsDetected: this.peaks.length,
      repsRequired: this.repsRequired,
      min: this.min,
      max: this.max,
      error: this.error,
      message,
      samples: this.phase === 'rest' ? this.restSamples.length : this.moveSamples,
    };
  }

  private formatRom(): string {
    const info = MOVEMENT_INFO[this.movement];
    const rom = this.min !== null && this.max !== null ? this.max - this.min : 0;
    return info.unit === 'deg' ? `${rom.toFixed(0)}° of ${this.minRom}° needed` : `${(rom * 100).toFixed(0)}% of ${(this.minRom * 100).toFixed(0)}% needed`;
  }
}
