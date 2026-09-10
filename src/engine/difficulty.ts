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

export type WindowScaleIssue = 'ok' | 'non_finite' | 'below_min' | 'above_max';

/** What `checkWindowScale` found: the value that will actually be used, and whether it was changed. */
export interface WindowScaleCheck {
  /** The scale that `windowsFor` will apply. */
  value: number;
  /** True when `value` differs from what was asked for. */
  clamped: boolean;
  reason: WindowScaleIssue;
  /** Ready-to-show explanation when `clamped`, else null. */
  message: string | null;
}

/**
 * Validate a therapist window scale WITHOUT silently deciding for them.
 *
 * `clampWindowScale` (and therefore `windowsFor`) has to clamp — non-positive or absurd windows
 * blow up inside `Judge` at Play time, far from the control that caused it — but a clinical control
 * must not apply a different number than the one the therapist typed and say nothing: typing 0.1
 * yields 0.25, i.e. 2.5x what was asked for. Call this from the Setup screen and show `message`
 * next to the field; call `clampWindowScale` when you only need the number.
 */
export function checkWindowScale(scale: number): WindowScaleCheck {
  if (!Number.isFinite(scale)) {
    return { value: 1, clamped: true, reason: 'non_finite', message: `window scale ${String(scale)} is not a number; using 1x` };
  }
  if (scale < MIN_WINDOW_SCALE) {
    return { value: MIN_WINDOW_SCALE, clamped: true, reason: 'below_min', message: `window scale ${scale} is below the minimum ${MIN_WINDOW_SCALE}x; using ${MIN_WINDOW_SCALE}x (windows this tight are unhittable)` };
  }
  if (scale > MAX_WINDOW_SCALE) {
    return { value: MAX_WINDOW_SCALE, clamped: true, reason: 'above_max', message: `window scale ${scale} is above the maximum ${MAX_WINDOW_SCALE}x; using ${MAX_WINDOW_SCALE}x (wider windows stop measuring timing)` };
  }
  return { value: scale, clamped: false, reason: 'ok', message: null };
}

/**
 * Clamp a therapist window scale (or an explicit fine-motor multiplier) to [0.25, 4]; non-finite
 * values become 1. Keep the value in session settings (e.g. the zustand store) and pass it to
 * `windowsFor`, which clamps both of its multipliers with this.
 *
 * This clamp is SILENT by design (it is on the hot path of window construction). Any UI that lets a
 * therapist type the number must run `checkWindowScale` too and show `message` when `clamped` —
 * otherwise a clinical control applies a value nobody chose.
 */
export function clampWindowScale(scale: number): number {
  return checkWindowScale(scale).value;
}

export function scaleWindows(w: TimingWindows, k: number): TimingWindows {
  return { perfectMs: w.perfectMs * k, goodMs: w.goodMs * k };
}

/**
 * Timing windows for a movement at a difficulty.
 * Fine-motor movements get ×FINE_MOTOR_WINDOW_MULTIPLIER (unless `multiplierOverride` is given);
 * the result is additionally multiplied by `scale` (therapist tuning; default 1).
 *
 * Both `multiplierOverride` and `scale` are clamped to [MIN_WINDOW_SCALE, MAX_WINDOW_SCALE] and
 * non-finite values become 1 — a therapist control that produces 0 or a negative number must not
 * hand back `{perfectMs: 0, goodMs: 0}` / negative windows that only blow up later inside `Judge`
 * at Play time, far from the control that caused it. The clamp is silent here: run
 * `checkWindowScale(scale)` in the Setup screen and show its `message` so the therapist learns that
 * the value in force is not the one they typed.
 * Pure: no hidden global state.
 */
export function windowsFor(
  movement: Movement,
  difficulty: Difficulty | DifficultyName,
  multiplierOverride?: number,
  scale = 1,
): TimingWindows {
  const base = resolveDifficulty(difficulty).windows;
  const mult = multiplierOverride === undefined ? (isFineMotor(movement) ? FINE_MOTOR_WINDOW_MULTIPLIER : 1) : clampWindowScale(multiplierOverride);
  return scaleWindows(base, mult * clampWindowScale(scale));
}

/**
 * Per-lane windows for a set of lane specs (array indexed by `LaneSpec.index`).
 * The specs must cover exactly the indices 0..n-1 once each: a missing, duplicate or out-of-range
 * index throws (a mis-indexed fine-motor lane must never silently get gross-motor windows).
 */
export function windowsForLanes(lanes: readonly LaneSpec[], difficulty: Difficulty | DifficultyName, scale = 1): TimingWindows[] {
  if (lanes.length === 0) throw new RangeError('windowsForLanes: no lanes');
  const out: (TimingWindows | undefined)[] = new Array<TimingWindows | undefined>(lanes.length).fill(undefined);
  for (const l of lanes) {
    if (!Number.isInteger(l.index) || l.index < 0 || l.index >= lanes.length) {
      throw new RangeError(`windowsForLanes: lane index ${l.index} out of range [0, ${lanes.length}) for ${lanes.length} lane(s)`);
    }
    if (out[l.index]) throw new RangeError(`windowsForLanes: duplicate lane index ${l.index}`);
    out[l.index] = windowsFor(l.movement, difficulty, undefined, scale);
  }
  return out as TimingWindows[];
}
