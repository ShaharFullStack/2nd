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
import type { SessionResult } from './types.ts';

export interface LatencyAdvice {
  /** The offset the run was judged with (ms). */
  currentMs: number;
  /** The offset the run says it should have been (ms). */
  suggestedMs: number;
  /** suggested - current (ms). Positive = the pipeline is slower than the session assumed. */
  deltaMs: number;
  /** The narrowest good window in force this session (ms), i.e. the threshold `significant` uses. */
  goodWindowMs: number;
  /** True when |delta| exceeds one good window — worth showing prominently and acting on. */
  significant: boolean;
}

/**
 * The advice for a finished session, or null when the run produced no confident suggestion (too few
 * judged hits, a keyboard/autoplay run, an abandoned session).
 */
export function latencyAdvice(result: Pick<SessionResult, 'suggestedLatencyMs' | 'latencyOffsetMs' | 'difficulty' | 'windowScale' | 'lanes'>): LatencyAdvice | null {
  const suggestedMs = result.suggestedLatencyMs;
  if (suggestedMs === null || !Number.isFinite(suggestedMs)) return null;
  const currentMs = result.latencyOffsetMs;
  if (!Number.isFinite(currentMs)) return null;
  const goodWindowMs = narrowestGoodWindowMs(result);
  const deltaMs = suggestedMs - currentMs;
  return {
    currentMs,
    suggestedMs,
    deltaMs,
    goodWindowMs,
    significant: Math.abs(deltaMs) > goodWindowMs,
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
