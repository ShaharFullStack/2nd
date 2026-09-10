/**
 * The receptor's honest state model — pure, no DOM, unit-testable.
 *
 * This is the renderer's core biofeedback claim, so it lives apart from the drawing code and is
 * tested on its own: **the receptor must mean exactly what the input engine means.**
 *
 * The engine (docs/ARCHITECTURE.md, "Input contract"; src/vision/trigger.ts) fires a lane when its
 * normalized value crosses `Difficulty.thresholdFraction` on a *rising edge*, with hysteresis:
 * after firing, the lane cannot fire again until the value falls back below
 * `thresholdFraction * REARM_FRACTION` (`LaneTrigger.rearmLevel`). `LaneState.armed` is that flag.
 *
 * `armed === false` covers BOTH of the trigger's non-firing states, and the receptor deliberately
 * draws them the same way because the patient's remedy is the same for both:
 *   - 'triggered'   — the rep fired and has not been given back yet;
 *   - 'unconfirmed' — the lane has never been observed below the re-arm level since the last reset
 *                     or dropout (a patient who starts the song already at end range, a lane
 *                     recovering from an occlusion, a calibration replaced mid-rep).
 * In both, and *at any value*, nothing the patient does scores until they get below the re-arm
 * level. So `locked` is not conditioned on a full meter: an unconfirmed lane at 40 % of threshold
 * is just as unable to fire, and says "lower to reset" just as loudly.
 *
 * So there are four states, and they must not look like brightness steps of one look:
 *
 *   tracking + armed + below threshold  →  (a) rising. The effortful, coachable phase: the meter
 *                                          has to answer "how much further", not "not yet".
 *   tracking + armed + at/over          →  (b) the lane *will* fire on this rep.
 *   tracking + !armed                   →  (c) the lane *cannot* fire, no matter how hard the
 *                                          patient pushes, until they lower past the re-arm line.
 *                                          This is the single most common thing a rehab patient
 *                                          does (holding at end range), and showing them a lit,
 *                                          "ready" receptor for the whole hold is a lie that
 *                                          teaches the wrong movement.
 *   !tracking                           →  (d) there is no measurement. Outranks (c): "lower to
 *                                          reset" is advice a patient who is out of frame cannot
 *                                          act on, so `locked` is false while untracked and every
 *                                          value-derived output (`fill`, `over`, `resetProgress`,
 *                                          `glowTarget`) is meaningless — `Highway.drawReceptors`
 *                                          draws none of them.
 *
 * `receptorLook` collapses a `RenderLaneState` into what the receptor should read;
 * `Highway.drawReceptors` renders each state as a different SET OF MARKS (see its doc comment):
 * (a) one continuous level line + a fixed target line and ticks, (b) those plus liquid above the
 * target line, a level cap SPLIT into two white-hot segments and two additive rings, (c) a dead grey
 * ring whose column is capped short of the target height, with a violet drain cap on it, a dashed
 * re-arm line, a "lower to reset" chevron and a return-to-rest arc — and no level line, target line
 * or halo at all, and (d) the only ring on the board with gaps in it, plus a "?", and nothing else.
 */
import { clamp } from './geometry';

/**
 * Default hysteresis re-arm fraction: the lane re-arms once its value falls below
 * `thresholdFraction * REARM_FRACTION`. Matches the vision trigger detector in the architecture
 * contract (`src/vision/trigger.ts` exports the same default); override per frame with
 * `RenderFrame.rearmFraction` if a session tunes it.
 */
export const DEFAULT_REARM_FRACTION = 0.6;

/**
 * How far past the threshold saturates `ReceptorLook.over`: at `threshold * (1 + METER_OVER_RANGE)`
 * the meter's overshoot headroom is full. The headroom exists so the target line is a mark the
 * level can sit *above*, which is how a ROM gauge shows that a rep cleared the target rather than
 * merely reached the top of the widget.
 */
export const METER_OVER_RANGE = 0.5;

/** What the receptor should read for one lane this frame. */
export interface ReceptorLook {
  /** Meter fill 0..1 against the trigger threshold (1 = at or past `thresholdFraction`). */
  fill: number;
  /**
   * Overshoot 0..1: how far *past* the threshold the value is, saturating at
   * `threshold * (1 + METER_OVER_RANGE)`. 0 whenever `fill < 1`. The renderer maps it onto the
   * headroom above the target line, and ignores it entirely while `locked` (a locked column is
   * additionally capped short of the target height), so only a lane that would really fire ever
   * paints liquid at or above that line.
   */
  over: number;
  /**
   * True exactly when the lane would score right now: re-armed, tracked, and at or past threshold.
   * Only this state gets the hot fill, the split white-hot cap, the additive rim + corona and a
   * full halo.
   */
  willFire: boolean;
  /**
   * True when the lane is locked out by hysteresis: it has fired (or has never been confirmed below
   * the re-arm level), so nothing the patient does can score until the value falls below
   * `thresholdFraction * rearmFraction`. Independent of `fill` — an unconfirmed lane below the
   * threshold is just as unable to fire. False while `tracking` is false: (d) outranks (c).
   */
  locked: boolean;
  /** 0..1 progress back toward the re-arm point while locked (1 = about to re-arm). 0 when unlocked. */
  resetProgress: number;
  /** Height of the re-arm line inside the ring, as a fraction of the meter (0..1). */
  resetLevel: number;
  /** Halo / glow target 0..1. Zero whenever the lane cannot fire (locked or tracking lost). */
  glowTarget: number;
  /**
   * False when the tracker has lost the limb / hand. Every other field is then meaningless and the
   * renderer draws nothing derived from a value: a broken, slowly breathing ring and a "?", and no
   * fill, level line, target line, halo, lock cue or beat pulse. See `Highway.drawLostReceptor`.
   */
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
  const ratio = value / threshold;
  const fill = clamp(ratio, 0, 1);
  // The re-arm point, expressed in the meter's own units (fraction of threshold) — that is exactly
  // where the re-arm line is drawn inside the ring.
  const resetLevel = rearm;
  const locked = !armed && tracking;
  out.fill = fill;
  out.over = clamp((ratio - 1) / METER_OVER_RANGE, 0, 1);
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
    { fill: 0, over: 0, willFire: false, locked: false, resetProgress: 0, resetLevel: rearmFraction, glowTarget: 0, tracking: true },
    state,
    thresholdFraction,
    rearmFraction,
  );
}
