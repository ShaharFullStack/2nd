import { FINE_MOTOR } from './types.ts';
import type { Difficulty, DifficultyName, Movement, TimingWindows } from './types.ts';

/** Base window multiplier applied to fine-motor movements (finger_opposition, finger_spread). */
export const FINE_MOTOR_WINDOW_MULTIPLIER = 1.6;

/** Canonical difficulty presets (see docs/ARCHITECTURE.md). */
export const DIFFICULTIES: Readonly<Record<DifficultyName, Difficulty>> = Object.freeze({
  easy: { name: 'easy', thresholdFraction: 0.5, noteDensity: 0.5, windows: { perfectMs: 90, goodMs: 180 } },
  medium: { name: 'medium', thresholdFraction: 0.65, noteDensity: 1, windows: { perfectMs: 70, goodMs: 140 } },
  hard: { name: 'hard', thresholdFraction: 0.8, noteDensity: 1.5, windows: { perfectMs: 50, goodMs: 110 } },
});

export const DIFFICULTY_NAMES: readonly DifficultyName[] = ['easy', 'medium', 'hard'];

/** Resolve a difficulty by name or pass a Difficulty object through unchanged. */
export function resolveDifficulty(d: Difficulty | DifficultyName): Difficulty {
  return typeof d === 'string' ? DIFFICULTIES[d] : d;
}

export function isFineMotor(movement: Movement): boolean {
  return FINE_MOTOR.includes(movement);
}

/* ---------- therapist-tunable global window scale ---------- */

const MIN_SCALE = 0.25;
const MAX_SCALE = 4;
let globalWindowScale = 1;

/** Set a global multiplier applied to every timing window (therapist tuning). Clamped to [0.25, 4]. */
export function setGlobalWindowScale(scale: number): number {
  if (!Number.isFinite(scale)) return globalWindowScale;
  globalWindowScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
  return globalWindowScale;
}

export function getGlobalWindowScale(): number {
  return globalWindowScale;
}

export function resetGlobalWindowScale(): void {
  globalWindowScale = 1;
}

export function scaleWindows(w: TimingWindows, k: number): TimingWindows {
  return { perfectMs: w.perfectMs * k, goodMs: w.goodMs * k };
}

/**
 * Timing windows for a movement at a difficulty.
 * Fine-motor movements get ×FINE_MOTOR_WINDOW_MULTIPLIER (unless `multiplierOverride` is given);
 * the result is additionally scaled by the global window scale (or `scale` when supplied).
 */
export function windowsFor(
  movement: Movement,
  difficulty: Difficulty | DifficultyName,
  multiplierOverride?: number,
  scale: number = globalWindowScale,
): TimingWindows {
  const base = resolveDifficulty(difficulty).windows;
  const mult = multiplierOverride ?? (isFineMotor(movement) ? FINE_MOTOR_WINDOW_MULTIPLIER : 1);
  return scaleWindows(base, mult * scale);
}
