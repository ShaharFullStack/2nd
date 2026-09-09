/**
 * Latency calibration math (pure).
 *
 * The documented input pipeline is a 30 fps camera (33 ms frame quantisation) feeding EMA-smoothed
 * threshold crossings performed by motor-impaired patients, with 80–200 ms of pipeline latency on
 * top of the patient's own reaction/movement time. Defaults here are chosen for that pipeline:
 * - outliers are rejected relative to a robust centre (median), not about zero, so a genuine
 *   200–300 ms offset is not trimmed asymmetrically;
 * - pairing inputs to beats uses an asymmetric window derived from the beat interval (latency is
 *   physically positive), so a crossing that consistently lands 300 ms after the beat still pairs;
 * - unpaired beats count as rejected samples, so "no data" is diagnosed, not reported as 0 ms;
 * - the spread threshold (MAD) is ~1.5 camera frames and confidence is graded (0..1) so the
 *   calibration screen can show a meter instead of a bare boolean.
 */

/** One calibration observation: the beat the patient was asked to hit and when the input arrived. */
export interface LatencySample {
  /** Song/ctx time (seconds) of the expected beat. */
  expected: number;
  /** Same time base (seconds) at which the input was observed. */
  observed: number;
}

export type LatencyQuality = 'good' | 'fair' | 'poor' | 'none';

export interface LatencyEstimate {
  /** Median (observed - expected) over accepted samples, seconds. Positive = input arrives after the beat. */
  offsetSec: number;
  offsetMs: number;
  /** Median absolute deviation of accepted samples about the median, seconds. */
  madSec: number;
  /** Number of accepted samples. */
  samples: number;
  /** Samples rejected: non-finite, beyond `maxAbsSec`, beyond `maxDevSec` from the median, plus unpaired beats. */
  rejected: number;
  /** Beats that never received an input (subset of `rejected`). */
  unpaired: number;
  /** Graded confidence 0..1 (min of sample-count, spread and rejection scores; 0.5 = every threshold just met). */
  confidence: number;
  /** Convenience label for the UI: good (>= 0.75), fair (>= 0.5), poor (> 0), none (no accepted samples). */
  quality: LatencyQuality;
  /** True when every threshold is met (equivalent to confidence >= 0.5). */
  confident: boolean;
}

export interface LatencyOptions {
  /** Absolute plausibility bound: reject samples with |observed - expected| above this (default 1 s). */
  maxAbsSec?: number;
  /** Reject samples deviating more than this from the robust centre (median) (default 0.25 s). */
  maxDevSec?: number;
  /** Minimum accepted samples for confidence (default 6). */
  minSamples?: number;
  /** Maximum MAD for confidence (default 0.05 s ≈ 1.5 frames at 30 fps). */
  maxMadSec?: number;
  /** Maximum rejected fraction (including unpaired beats) for confidence (default 1/3). */
  maxRejectedFraction?: number;
  /** Beats that received no input; counted as rejected (default 0; `calibrateLatency` fills it in). */
  unpaired?: number;
}

/** Camera frame period the defaults are tuned for (30 fps). */
export const LATENCY_FRAME_SEC = 1 / 30;
/** Absolute plausibility bound for a single sample (seconds). */
export const LATENCY_MAX_ABS_SEC = 1.0;
/** Maximum deviation from the median before a sample is treated as an outlier (seconds). */
export const LATENCY_OUTLIER_SEC = 0.25;
export const LATENCY_MIN_SAMPLES = 6;
/** ~1.5 camera frames: healthy tappers (SD ~25 ms) and impaired patients (SD ~45 ms) both pass. */
export const LATENCY_MAX_MAD_SEC = 0.05;
/**
 * More than a third of the beats rejected (outliers or never answered) means the run is not a
 * trustworthy calibration even if the surviving samples are tight: a 16-beat run tolerates 5
 * rejected beats, not 6.
 */
export const LATENCY_MAX_REJECTED_FRACTION = 1 / 3;
/** Recommended metronome tempo for the calibration screen (beat interval 1 s ≫ pipeline latency). */
export const CALIBRATION_BPM_RECOMMENDED = 60;
export const CALIBRATION_BEATS_RECOMMENDED = 16;

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const s = values.slice().sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Median absolute deviation about `center` (default: the median of `values`). */
export function mad(values: readonly number[], center: number = median(values)): number {
  if (values.length === 0) return 0;
  const dev = values.map((v) => Math.abs(v - center));
  return median(dev);
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export function qualityForConfidence(confidence: number, samples: number): LatencyQuality {
  if (samples === 0 || confidence <= 0) return 'none';
  if (confidence >= 0.75) return 'good';
  if (confidence >= 0.5) return 'fair';
  return 'poor';
}

/**
 * Estimate input latency from (expectedBeatTime, observedInputTime) pairs.
 * Robust: outliers are rejected about the median (two-pass), offset = median, spread = MAD.
 */
export function estimateLatency(pairs: readonly LatencySample[], opts: LatencyOptions = {}): LatencyEstimate {
  const maxAbs = opts.maxAbsSec ?? LATENCY_MAX_ABS_SEC;
  const maxDev = opts.maxDevSec ?? LATENCY_OUTLIER_SEC;
  const minSamples = opts.minSamples ?? LATENCY_MIN_SAMPLES;
  const maxMad = opts.maxMadSec ?? LATENCY_MAX_MAD_SEC;
  const maxRejected = opts.maxRejectedFraction ?? LATENCY_MAX_REJECTED_FRACTION;
  const unpaired = Math.max(0, Math.floor(opts.unpaired ?? 0));

  // pass 1: plausibility
  const plausible: number[] = [];
  let rejected = unpaired;
  for (const p of pairs) {
    const d = p.observed - p.expected;
    if (!Number.isFinite(d) || Math.abs(d) > maxAbs) rejected++;
    else plausible.push(d);
  }
  // pass 2: outliers relative to the robust centre
  const centre = median(plausible);
  const deltas: number[] = [];
  for (const d of plausible) {
    if (Math.abs(d - centre) > maxDev) rejected++;
    else deltas.push(d);
  }

  const offsetSec = median(deltas);
  const madSec = mad(deltas, offsetSec);
  const samples = deltas.length;
  const total = samples + rejected;
  const rejectedFraction = total === 0 ? 1 : rejected / total;

  // graded scores: each is exactly 0.5 when its threshold is just met, 1 when comfortably inside
  const sampleScore = samples === 0 ? 0 : clamp01(samples / (2 * minSamples));
  const spreadScore = samples === 0 ? 0 : clamp01(1 - madSec / (2 * maxMad));
  const rejectScore = samples === 0 ? 0 : clamp01(1 - rejectedFraction / (2 * maxRejected));
  const confidence = Math.min(sampleScore, spreadScore, rejectScore);
  const confident = samples >= minSamples && madSec <= maxMad && rejectedFraction <= maxRejected;

  return {
    offsetSec,
    offsetMs: offsetSec * 1000,
    madSec,
    samples,
    rejected,
    unpaired,
    confidence,
    quality: qualityForConfidence(confidence, samples),
    confident,
  };
}

export interface PairingWindow {
  /** How early (seconds before the beat) an input may be and still pair with it. */
  earlySec: number;
  /** How late (seconds after the beat) an input may be and still pair with it. */
  lateSec: number;
}

/** Smallest positive gap between consecutive (sorted) beats, or `fallback` when fewer than two beats. */
export function beatIntervalOf(beatTimes: readonly number[], fallback = 1): number {
  const s = beatTimes.slice().sort((a, b) => a - b);
  let min = Infinity;
  for (let i = 1; i < s.length; i++) {
    const g = s[i] - s[i - 1];
    if (g > 0 && g < min) min = g;
  }
  return Number.isFinite(min) ? min : fallback;
}

/**
 * Default pairing window for a beat interval: asymmetric because latency is positive
 * (an input that lands 0.6 s after a 60 bpm beat is a late hit of that beat, not an early hit of the next).
 * early = 25% of the interval, late = 75%.
 */
export function defaultPairingWindow(beatIntervalSec: number): PairingWindow {
  const iv = beatIntervalSec > 0 && Number.isFinite(beatIntervalSec) ? beatIntervalSec : 1;
  return { earlySec: 0.25 * iv, lateSec: 0.75 * iv };
}

function resolveWindow(window: number | PairingWindow | undefined, beats: readonly number[]): PairingWindow {
  if (typeof window === 'number') return { earlySec: window, lateSec: window };
  if (window) return window;
  return defaultPairingWindow(beatIntervalOf(beats));
}

export interface PairingResult {
  pairs: LatencySample[];
  /** Beats with no input inside their window. */
  unpairedBeats: number;
  /** Inputs that paired with no beat (extra movements). */
  spuriousInputs: number;
  window: PairingWindow;
}

/**
 * Pair raw input times with beats: for each beat (in order) the nearest unused input inside
 * [beat - earlySec, beat + lateSec]; each input is used at most once. `window` may be a symmetric
 * radius (number) or an explicit {earlySec, lateSec}; default: `defaultPairingWindow(beatInterval)`.
 */
export function pairInputsToBeatsDetailed(
  beatTimes: readonly number[],
  inputTimes: readonly number[],
  window?: number | PairingWindow,
): PairingResult {
  const beats = beatTimes.slice().sort((a, b) => a - b);
  const inputs = inputTimes.slice().sort((a, b) => a - b);
  const w = resolveWindow(window, beats);
  const pairs: LatencySample[] = [];
  let unpairedBeats = 0;
  let j = 0;
  for (const b of beats) {
    while (j < inputs.length && inputs[j] < b - w.earlySec) j++;
    let best = -1;
    let bestAbs = Infinity;
    for (let k = j; k < inputs.length && inputs[k] <= b + w.lateSec; k++) {
      const abs = Math.abs(inputs[k] - b);
      if (abs < bestAbs) {
        bestAbs = abs;
        best = k;
      }
    }
    if (best >= 0) {
      pairs.push({ expected: b, observed: inputs[best] });
      j = best + 1;
    } else {
      unpairedBeats++;
    }
  }
  return { pairs, unpairedBeats, spuriousInputs: inputs.length - pairs.length, window: w };
}

/** Pairs only (see `pairInputsToBeatsDetailed`). */
export function pairInputsToBeats(
  beatTimes: readonly number[],
  inputTimes: readonly number[],
  window?: number | PairingWindow,
): LatencySample[] {
  return pairInputsToBeatsDetailed(beatTimes, inputTimes, window).pairs;
}

export interface CalibrationOptions extends LatencyOptions {
  /** Pairing window override (default derived from the beat interval). */
  window?: number | PairingWindow;
}

export interface CalibrationResult extends LatencyEstimate {
  pairing: PairingResult;
}

/**
 * One-call calibration: pair a recording of metronome beats and observed inputs, count unpaired
 * beats as rejected samples, and estimate the offset. This is what the calibration screen should
 * use; the returned `offsetSec` is the single `inputLatencySec` to feed the engine.
 */
export function calibrateLatency(
  beatTimes: readonly number[],
  inputTimes: readonly number[],
  opts: CalibrationOptions = {},
): CalibrationResult {
  const pairing = pairInputsToBeatsDetailed(beatTimes, inputTimes, opts.window);
  const est = estimateLatency(pairing.pairs, { ...opts, unpaired: (opts.unpaired ?? 0) + pairing.unpairedBeats });
  return { ...est, pairing };
}
