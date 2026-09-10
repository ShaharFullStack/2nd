/**
 * What a finished run says the input latency SHOULD have been, and whether that disagreement is big
 * enough for the therapist to act on before the next session.
 *
 * The engine already reports `suggestedLatencyMs` (the run's own median timing bias folded back into
 * the offset). This module answers the two questions the Results screen has to answer with it:
 *
 *  1. Is the disagreement REAL? A steady bias smaller than a good window costs nothing — every note
 *     still lands inside the window it was going to land in. A bias LARGER than one good window is a
 *     different thing entirely: the patient's honest movement is being judged outside the window, so
 *     the session under-reports what they did. That is the threshold used here, and it is per-session
 *     rather than a constant because the good window depends on the difficulty, the therapist's
 *     window scale AND the movement (fine-motor lanes get ×1.6).
 *  2. What exactly changes if the therapist applies it? Before, after, and by how much — a therapist
 *     who cannot see the old value cannot decide whether the new one is plausible.
 *
 * The NARROWEST good window across the session's lanes is the one that matters: it is the first lane
 * that starts losing honest movements to the bias.
 */
import { windowsFor } from '../engine/difficulty.ts';
import type { InputMode, SessionResult } from './types.ts';

/**
 * The range the stored camera offset may take (ms). This is the SAME clamp the store applies on the
 * way in, exported so the screen that offers a value can offer the value that will actually be
 * written — a button reading "Use −2 ms" that silently stores 0 ms is a lie about a clinical
 * parameter, and the therapist has no way to notice it.
 */
export const LATENCY_MIN_MS = 0;
export const LATENCY_MAX_MS = 1000;

/** What the store will really keep, given a suggestion in ms. */
export function clampLatencyMs(ms: number): number {
  if (!Number.isFinite(ms)) return LATENCY_MIN_MS;
  return Math.max(LATENCY_MIN_MS, Math.min(LATENCY_MAX_MS, Math.round(ms)));
}

export interface LatencyAdvice {
  /** What drove the lanes in the run this advice came from. */
  inputMode: InputMode;
  /**
   * True only for a camera run. `latencyOffsetSec` is the CAMERA pipeline's offset; a keyboard run
   * measures a human's reaction bias and the autoplay bot measures its own scheduling jitter, and
   * writing either into the camera offset silently corrupts the next real session.
   */
  appliesToCamera: boolean;
  /** The offset the run was judged with (ms). */
  currentMs: number;
  /** The offset the run says it should have been (ms). */
  suggestedMs: number;
  /** What applying it would actually store, after the store's 0..1000 ms clamp. */
  applicableMs: number;
  /** True when the clamp moved the suggestion — the screen must show the clamped value, not the raw one. */
  clamped: boolean;
  /** suggested - current (ms). Positive = the pipeline is slower than the session assumed. */
  deltaMs: number;
  /** The narrowest good window in force this session (ms), i.e. the threshold `significant` uses. */
  goodWindowMs: number;
  /** True when |delta| exceeds one good window — worth showing prominently and acting on. */
  significant: boolean;
}

/**
 * The advice for a finished session, or null when the run produced no confident suggestion (too few
 * judged hits, an abandoned session). A run that was not camera-driven still returns advice — the
 * number is real, it is just about the wrong pipeline — with `appliesToCamera: false` and never
 * `significant`, so the screen can explain it instead of offering to apply it.
 */
export function latencyAdvice(
  result: Pick<SessionResult, 'suggestedLatencyMs' | 'latencyOffsetMs' | 'difficulty' | 'windowScale' | 'lanes' | 'inputMode'>,
): LatencyAdvice | null {
  const suggestedMs = result.suggestedLatencyMs;
  if (suggestedMs === null || !Number.isFinite(suggestedMs)) return null;
  const currentMs = result.latencyOffsetMs;
  if (!Number.isFinite(currentMs)) return null;
  const goodWindowMs = narrowestGoodWindowMs(result);
  const deltaMs = suggestedMs - currentMs;
  const applicableMs = clampLatencyMs(suggestedMs);
  const appliesToCamera = result.inputMode === 'camera';
  return {
    inputMode: result.inputMode,
    appliesToCamera,
    currentMs,
    suggestedMs,
    applicableMs,
    clamped: applicableMs !== Math.round(suggestedMs),
    deltaMs,
    goodWindowMs,
    // A non-camera run's bias is never a reason to change the camera offset, however large it is.
    significant: appliesToCamera && Math.abs(deltaMs) > goodWindowMs,
  };
}

/**
 * The narrowest good window (ms) across the session's lanes — the lane that suffers first. Falls back
 * to the difficulty's own gross-motor window when the record carries no lanes (a session that ended
 * before a single lane was summarised).
 */
export function narrowestGoodWindowMs(result: Pick<SessionResult, 'difficulty' | 'windowScale' | 'lanes'>): number {
  const scale = Number.isFinite(result.windowScale) ? result.windowScale : 1;
  const windows = result.lanes.map((l) => windowsFor(l.movement, result.difficulty, undefined, scale).goodMs);
  if (windows.length === 0) return windowsFor('seated_march', result.difficulty, undefined, scale).goodMs;
  return Math.min(...windows);
}
