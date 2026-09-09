/** One calibration observation: the beat the patient was asked to hit and when the input arrived. */
export interface LatencySample {
  /** Song/ctx time (seconds) of the expected beat. */
  expected: number;
  /** Same time base (seconds) at which the input was observed. */
  observed: number;
}

export interface LatencyEstimate {
  /** Median (observed - expected), seconds. Positive = input arrives after the beat. */
  offsetSec: number;
  offsetMs: number;
  /** Median absolute deviation of accepted samples, seconds. */
  madSec: number;
  /** Number of accepted samples. */
  samples: number;
  /** Samples rejected as outliers (|observed - expected| > maxAbsSec). */
  rejected: number;
  confident: boolean;
}

export interface LatencyOptions {
  /** Reject samples with |delta| above this (default 0.25 s). */
  maxAbsSec?: number;
  /** Minimum accepted samples for confidence (default 5). */
  minSamples?: number;
  /** Maximum MAD for confidence (default 0.03 s). */
  maxMadSec?: number;
  /** Maximum rejected fraction for confidence (default 0.5). */
  maxRejectedFraction?: number;
}

export const LATENCY_OUTLIER_SEC = 0.25;
export const LATENCY_MIN_SAMPLES = 5;
export const LATENCY_MAX_MAD_SEC = 0.03;

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

/**
 * Estimate input latency from (expectedBeatTime, observedInputTime) pairs.
 * Robust: median offset, MAD spread, outliers beyond `maxAbsSec` rejected.
 */
export function estimateLatency(pairs: readonly LatencySample[], opts: LatencyOptions = {}): LatencyEstimate {
  const maxAbs = opts.maxAbsSec ?? LATENCY_OUTLIER_SEC;
  const minSamples = opts.minSamples ?? LATENCY_MIN_SAMPLES;
  const maxMad = opts.maxMadSec ?? LATENCY_MAX_MAD_SEC;
  const maxRejected = opts.maxRejectedFraction ?? 0.5;

  const deltas: number[] = [];
  let rejected = 0;
  for (const p of pairs) {
    const d = p.observed - p.expected;
    if (!Number.isFinite(d) || Math.abs(d) > maxAbs) {
      rejected++;
      continue;
    }
    deltas.push(d);
  }
  const offsetSec = median(deltas);
  const madSec = mad(deltas, offsetSec);
  const total = deltas.length + rejected;
  const confident =
    deltas.length >= minSamples && madSec <= maxMad && (total === 0 ? false : rejected / total <= maxRejected);
  return { offsetSec, offsetMs: offsetSec * 1000, madSec, samples: deltas.length, rejected, confident };
}

/**
 * Pair raw input times with the nearest expected beat (within `maxAbsSec`), one input per beat.
 * Handy for turning a calibration recording into `LatencySample`s.
 */
export function pairInputsToBeats(
  beatTimes: readonly number[],
  inputTimes: readonly number[],
  maxAbsSec: number = LATENCY_OUTLIER_SEC,
): LatencySample[] {
  const beats = beatTimes.slice().sort((a, b) => a - b);
  const inputs = inputTimes.slice().sort((a, b) => a - b);
  const out: LatencySample[] = [];
  let j = 0;
  for (const b of beats) {
    // advance to inputs that could match this beat
    while (j < inputs.length && inputs[j] < b - maxAbsSec) j++;
    let best = -1;
    let bestAbs = Infinity;
    for (let k = j; k < inputs.length && inputs[k] <= b + maxAbsSec; k++) {
      const abs = Math.abs(inputs[k] - b);
      if (abs < bestAbs) {
        bestAbs = abs;
        best = k;
      }
    }
    if (best >= 0) {
      out.push({ expected: b, observed: inputs[best] });
      j = best + 1; // each input used at most once
    }
  }
  return out;
}
