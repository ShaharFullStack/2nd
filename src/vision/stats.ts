/** Small order-statistics helpers shared by calibration and compensation baselines. */
import { clamp01 } from './landmarks.ts';

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
