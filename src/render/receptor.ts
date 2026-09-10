/**
 * The receptor's honest state model — pure, no DOM, unit-testable.
 *
 * This is the renderer's core biofeedback claim, so it lives apart from the drawing code and is
 * tested on its own: **the receptor must mean exactly what the input engine means.**
 *
 * The engine (docs/ARCHITECTURE.md, "Input contract") fires a lane when its normalized value
 * crosses `Difficulty.thresholdFraction` on a *rising edge*, with hysteresis: after firing, the
 * lane cannot fire again until the value falls back below `thresholdFraction * REARM_FRACTION`.
 * `LaneState.armed` is that re-arm flag.
 *
 * So there are two genuinely different situations at a full meter, and they must not look alike:
 *
 *   armed  + value ≥ threshold  →  the lane *will* fire on this rep. Meter full, hot, haloed.
 *   !armed + value ≥ threshold  →  the lane *cannot* fire, no matter how hard the patient pushes,
 *                                  until they lower past the re-arm line. This is the single most
 *                                  common thing a rehab patient does (holding at end range), and
 *                                  showing them a lit, "ready" receptor for the whole hold is a
 *                                  lie that teaches the wrong movement.
 *
 * `receptorLook` collapses a `RenderLaneState` into what the receptor should read, and
 * `Highway.drawReceptors` renders `locked` as a categorically different thing (drained grey meter,
 * no hot fill, no halo, grey ring, a re-arm line and a "lower to reset" chevron) rather than as a
 * dimmed version of the live one.
 */
import { clamp } from './geometry';

/**
 * Default hysteresis re-arm fraction: the lane re-arms once its value falls below
 * `thresholdFraction * REARM_FRACTION`. Matches the vision trigger detector in the architecture
 * contract; override per frame with `RenderFrame.rearmFraction` if a session tunes it.
 */
export const DEFAULT_REARM_FRACTION = 0.6;

/** What the receptor should read for one lane this frame. */
export interface ReceptorLook {
  /** Meter fill 0..1 against the trigger threshold (1 = at or past `thresholdFraction`). */
  fill: number;
  /**
   * True exactly when the lane would score right now: re-armed, tracked, and at or past threshold.
   * Only this state gets the hot fill, the white meniscus and the halo.
   */
  willFire: boolean;
  /**
   * True when the lane is locked out by hysteresis — the patient is above the re-arm line but the
   * lane has already fired, so nothing they do can score until they lower.
   */
  locked: boolean;
  /** 0..1 progress back toward the re-arm point while locked (1 = about to re-arm). 0 when unlocked. */
  resetProgress: number;
  /** Height of the re-arm line inside the ring, as a fraction of the meter (0..1). */
  resetLevel: number;
  /** Halo / glow target 0..1. Zero whenever the lane cannot fire (locked or tracking lost). */
  glowTarget: number;
  /** False when the tracker has lost the limb / hand: the whole receptor dims and shows "?". */
  tracking: boolean;
}

/** Shape of the per-lane state this reads (structurally `RenderLaneState`). */
export interface LaneStateLike {
  value: number;
  armed: boolean;
  tracking?: boolean;
}

/**
 * Fill an existing `ReceptorLook` (allocation-free; the renderer calls this once per lane per
 * frame). `state` may be undefined — a lane with no meter reads as idle, tracked and armed.
 */
export function receptorLookInto(
  out: ReceptorLook,
  state: LaneStateLike | undefined,
  thresholdFraction: number,
  rearmFraction: number,
): ReceptorLook {
  const threshold = clamp(thresholdFraction, 0.05, 1);
  const rearm = clamp(rearmFraction, 0.05, 0.99);
  const value = state ? clamp(state.value, 0, 1.5) : 0;
  const armed = state ? state.armed !== false : true;
  const tracking = state ? state.tracking !== false : true;
  const fill = clamp(value / threshold, 0, 1);
  // The re-arm point, expressed in the meter's own units (fraction of threshold) — that is exactly
  // where the re-arm line is drawn inside the ring.
  const resetLevel = rearm;
  const locked = !armed && tracking;
  out.fill = fill;
  out.tracking = tracking;
  out.locked = locked;
  out.willFire = armed && tracking && fill >= 1;
  // While locked: 0 at threshold, 1 once the value has dropped to the re-arm line.
  out.resetProgress = locked ? clamp((1 - fill) / Math.max(1 - resetLevel, 1e-6), 0, 1) : 0;
  out.resetLevel = resetLevel;
  // A lane that cannot fire gets no halo at all — the light going out *is* the "you must lower" cue.
  out.glowTarget = armed && tracking ? fill * fill : 0;
  return out;
}

/** Allocating convenience form of `receptorLookInto` (tests, one-off inspection). */
export function receptorLook(
  state: LaneStateLike | undefined,
  thresholdFraction: number,
  rearmFraction: number = DEFAULT_REARM_FRACTION,
): ReceptorLook {
  return receptorLookInto(
    { fill: 0, willFire: false, locked: false, resetProgress: 0, resetLevel: rearmFraction, glowTarget: 0, tracking: true },
    state,
    thresholdFraction,
    rearmFraction,
  );
}
