import { FINE_MOTOR } from './types.ts';
import type { Difficulty, DifficultyName, LaneSpec, Movement, TimingWindows } from './types.ts';

/** Base window multiplier applied to fine-motor movements (finger_opposition, finger_spread). */
export const FINE_MOTOR_WINDOW_MULTIPLIER = 1.6;

function deepFreeze<T extends object>(o: T): Readonly<T> {
  for (const v of Object.values(o)) if (v && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v);
  return Object.freeze(o);
}

/** Canonical difficulty presets (see docs/ARCHITECTURE.md). Deep-frozen: presets cannot be mutated. */
export const DIFFICULTIES: Readonly<Record<DifficultyName, Readonly<Difficulty>>> = deepFreeze({
  easy: { name: 'easy', thresholdFraction: 0.5, noteDensity: 0.5, windows: { perfectMs: 90, goodMs: 180 } },
  medium: { name: 'medium', thresholdFraction: 0.65, noteDensity: 1, windows: { perfectMs: 70, goodMs: 140 } },
  hard: { name: 'hard', thresholdFraction: 0.8, noteDensity: 1.5, windows: { perfectMs: 50, goodMs: 110 } },
});

export const DIFFICULTY_NAMES: readonly DifficultyName[] = Object.freeze(['easy', 'medium', 'hard']);

/** Resolve a difficulty by name or pass a Difficulty object through unchanged. */
export function resolveDifficulty(d: Difficulty | DifficultyName): Difficulty {
  return typeof d === 'string' ? DIFFICULTIES[d] : d;
}

export function isFineMotor(movement: Movement): boolean {
  return FINE_MOTOR.includes(movement);
}

/* ---------- therapist-tunable window scale (explicit value, no module state) ---------- */

export const MIN_WINDOW_SCALE = 0.25;
export const MAX_WINDOW_SCALE = 4;

/**
 * Clamp a therapist window scale to [0.25, 4]; non-finite values become 1.
 * Keep the value in session settings (e.g. the zustand store) and pass it to `windowsFor`.
 */
export function clampWindowScale(scale: number): number {
  if (!Number.isFinite(scale)) return 1;
  return Math.min(MAX_WINDOW_SCALE, Math.max(MIN_WINDOW_SCALE, scale));
}

export function scaleWindows(w: TimingWindows, k: number): TimingWindows {
  return { perfectMs: w.perfectMs * k, goodMs: w.goodMs * k };
}

/**
 * Timing windows for a movement at a difficulty.
 * Fine-motor movements get ×FINE_MOTOR_WINDOW_MULTIPLIER (unless `multiplierOverride` is given);
 * the result is additionally multiplied by `scale` (therapist tuning, clamped to [0.25, 4]; default 1).
 * Pure: no hidden global state.
 */
export function windowsFor(
  movement: Movement,
  difficulty: Difficulty | DifficultyName,
  multiplierOverride?: number,
  scale = 1,
): TimingWindows {
  const base = resolveDifficulty(difficulty).windows;
  const mult = multiplierOverride ?? (isFineMotor(movement) ? FINE_MOTOR_WINDOW_MULTIPLIER : 1);
  return scaleWindows(base, mult * clampWindowScale(scale));
}

/** Per-lane windows for a set of lane specs (array indexed by `LaneSpec.index`). */
export function windowsForLanes(lanes: readonly LaneSpec[], difficulty: Difficulty | DifficultyName, scale = 1): TimingWindows[] {
  const out: TimingWindows[] = [];
  for (const l of lanes) out[l.index] = windowsFor(l.movement, difficulty, undefined, scale);
  for (let i = 0; i < out.length; i++) if (!out[i]) out[i] = windowsFor('seated_march', difficulty, 1, scale);
  return out;
}
