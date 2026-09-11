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
 *   the threshold crossing              →  (b) the rep just reached the target ROM — the frame the
 *                                          input engine emitted its `LaneInputEvent` on. See
 *                                          "THE CROSSING IS ONE FRAME" below: this is a LATCHED
 *                                          state, not a level test.
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
 * THE CROSSING IS ONE FRAME, AND IT IS ALREADY DISARMED. This is the whole reason `ReceptorHistory`
 * exists. `LaneTrigger.push()` moves the lane to 'triggered' on the very sample that crosses
 * (src/vision/trigger.ts), and `VisionInput` pushes the trigger BEFORE `getLaneStates()` reads
 * `trigger.armed` (src/input/VisionInput.ts) — so the crossing frame is published as
 * `{ value: >= threshold, armed: false }` and NO frame from ANY input source in this repo ever
 * satisfies `armed && value >= threshold`. (The scripted sources are the same by construction:
 * src/input/laneStates.ts publishes a held lane as `{ value: 1, armed: false }`.) A `willFire`
 * look conditioned on that conjunction is therefore dead code, and a renderer built on it gives the
 * patient NO gauge-level acknowledgement of the one thing the session is for — reaching the target
 * range. Worse, without a latch the gauge *steps down* at the instant of success: the last armed
 * frame paints a nearly full column, the next frame is capped by the lockout ceiling.
 *
 * So state (b) is detected as an EDGE and held for `GOAL_HOLD_SEC` (+ `GOAL_FADE_SEC` of ramp):
 * a lane that was armed on the previous tracked frame and is now locked at or past the threshold
 * has just crossed it — that is the frame the trigger fired on. `ReceptorHistory.update` sets
 * `ReceptorLook.goal` from that latch, and `goal > 0` is what the renderer draws state (b) from.
 * `willFire` is kept as the single-frame form of the same claim (and still refreshes the latch), so
 * that if the input layer ever publishes the crossing as armed — or a caller hands the model a
 * synthetic state — nothing has to change.
 *
 * AN ARMED → NOT-ARMED EDGE IS NOT ALWAYS A CROSSING, AND THAT IS THE DANGEROUS PART. `LaneTrigger`
 * disarms a lane for three different reasons, and only one of them is a rep:
 *   1. it crossed the threshold ('triggered') — the rep the latch exists for;
 *   2. `breakContinuity` — the sample stream was silent for longer than `maxGapSec`, so the lane
 *      goes to 'unconfirmed' AT WHATEVER VALUE IT HAS. VisionInput pushes a null sample for every
 *      untracked frame, so half a second of a lost knee landmark (hemiparesis, tremor, a therapist
 *      stepping past the tablet, a limb leaving frame) does exactly this — and the recovery frame is
 *      then published as `{ value: 0.95, armed: false }`, byte for byte the shape of a crossing,
 *      with NO `LaneInputEvent` and no `CompletedRep` behind it. Celebrating it is the precise lie
 *      this file was written to remove;
 *   3. `setThreshold` — a therapist making the song easier mid-song re-checks every lane's arming
 *      against the new re-arm level and disarms the ones that are not already below it.
 * The renderer therefore refuses the edge unless its evidence is still good, applying the trigger's
 * own rule to itself ("an unobserved window is not evidence"): the arming is forgotten when the last
 * DISTINCT tracked sample is more than `maxGapSec` old (case 2 — `RenderFrame.maxGapSec`, defaulting
 * to `DEFAULT_MAX_GAP_SEC`, the same 0.5 s VisionInput passes its triggers), and whenever the
 * threshold or re-arm fraction changes between frames (case 3). Better still, a source that
 * publishes `LaneStateLike.triggerState` is believed instead of guessed at: then only
 * 'armed' → 'triggered' is a crossing, and an 'unconfirmed' lane is never one.
 *
 * RESIDUAL, stated because the rest of this is a promise. Two windows remain in which the latch can
 * fire for a crossing the score did not get, and neither is closable from inside the renderer:
 *   - REFRACTORY. `LaneTrigger` swallows a crossing that lands within `minIntervalSec` (0.3 s) of
 *     the previous one, and that window is not exposed in `LaneState`. Such a crossing still enters
 *     'triggered', so the latch still fires: true of the patient's MOVEMENT (VisionInput reports the
 *     rep either way, `LaneRepEvent.emitted: false`) but not of the score.
 *   - AN UNREPORTED STALL. The gap rule measures the silence the renderer can SEE. If the camera
 *     simply stops delivering frames, `VisionInput` keeps republishing the last sample with
 *     `tracking: true` until its own stall watchdog (`staleFrameSec`, the same 0.5 s) fires, so up
 *     to `maxGapSec` of the trigger's silence can be invisible here. Only a lane whose re-arm-level
 *     crossing happened to fall inside that window is affected, and the honest fix is upstream:
 *     publish `triggerState` (or the observation time) in `LaneState`, which removes the guess
 *     entirely. The renderer must not invent either number.
 * The guard errs the other way too, deliberately: a RENDER hitch longer than `maxGapSec` (a long GC
 * pause, a backgrounded tab) also expires the arming, so a crossing that happens across it loses its
 * acknowledgement even though it scored. That is the correct direction to be wrong in — a missing
 * cue costs one moment of knowledge-of-results on a frame the patient could not see anyway, while a
 * false one teaches the wrong movement and costs the display its credibility.
 *
 * NOISE, AND WHY (d) IS DEBOUNCED. `tracking` comes straight off a per-frame hard visibility gate
 * (src/vision/landmarks.ts, MIN_VISIBILITY) via src/vision/pipeline.ts, and nothing in the chain
 * debounces it. A landmark chattering across that gate — marginal framing, motion blur at peak rep
 * velocity, exactly the conditions of a real clinic — would strobe the whole receptor row between a
 * full gauge and "?" at frame rate. During Play the receptor is the patient's only out-of-frame
 * signal, so it has to be stable: `ReceptorHistory` holds the last tracked look for `LOST_HOLD_SEC`
 * before it will show (d), and reports that it is doing so as `ReceptorLook.stale`. A lane that has
 * NEVER been tracked (including one with no `LaneState` at all) skips the hold and reads (d)
 * immediately — for an absent measurement the honest default is "I cannot see you", not a live,
 * at-rest gauge.
 *
 * `receptorLookInto` collapses one `RenderLaneState` into what the receptor should read;
 * `ReceptorHistory.update` adds the two things a single frame cannot know (the crossing latch and
 * the tracking hold). The renderer positions every mark on ONE LINEAR ROM AXIS (`Highway.meterPos`:
 * full ROM at the top of the well, the target line at `thresholdFraction` of it, the re-arm line at
 * `thresholdFraction * rearmFraction`), so a given movement is the same distance on screen wherever
 * in the range it is made — during the rise and during the return alike. What differs between the
 * states is not the scale but the SET OF MARKS (see `Highway.drawReceptors`):
 * (a) one continuous level line + the target line and two ticks, (b) those
 * plus liquid above the target line, a level cap SPLIT into two white-hot segments, two additive
 * rings, and the ticks replaced by two solid arrowheads, (c) a desaturated ring whose column stands
 * at the patient's true height and travels down through the target height as they lower, with a
 * violet drain cap on it, a dashed re-arm line, a "lower to reset" chevron and a return-to-rest arc
 * — all four of which move for the WHOLE descent, from the patient's real peak down to the re-arm
 * line — and no level line, target line or halo at all, and
 * (d) the only ring on the board with gaps in it, plus a "?", and nothing else. (The chevron and the
 * violet drain cap are keyed to `needsLower`, not to `locked`: a locked lane that is ALREADY below
 * the re-arm line keeps the rest of (c) but stops ordering the patient down.)
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
 * Default break-in-the-stream window, mirroring `DEFAULT_MAX_GAP_SEC` in src/vision/trigger.ts (and
 * `VisionInput.staleFrameSec`, which is what VisionInput actually passes its triggers). A sample
 * arriving more than this long after the previous OBSERVED one is a break: `LaneTrigger` throws its
 * arming away, because a whole rep could have started and finished inside a window nobody watched.
 *
 * The receptor has to apply the same rule to its own evidence — see `ReceptorHistory.update`. It is
 * a renderer-side mirror of a number the input layer owns, so `RenderFrame.maxGapSec` overrides it
 * for a session that tunes `staleFrameSec`; `receptor.test.ts` asserts the two defaults agree.
 */
export const DEFAULT_MAX_GAP_SEC = 0.5;

/**
 * MINIMUM span for the overshoot READOUT (`ReceptorLook.over`), as a fraction of the threshold —
 * the floor that keeps `over` from dividing by a vanishing range when the threshold is set at or
 * near full ROM. See `meterOverSpan`.
 */
export const METER_OVER_RANGE = 0.5;

/**
 * The ROM distance `ReceptorLook.over` is measured over: from the threshold to full ROM
 * (`1 - thresholdFraction`), floored at `thresholdFraction * METER_OVER_RANGE` so a near-full-ROM
 * threshold cannot collapse it to zero.
 *
 * THIS IS A READOUT, NOT THE RENDERER'S SCALE. `Highway.drawReceptors` positions every mark in the
 * well with `meterPos`, one linear map from ROM to height (full ROM at the ceiling, the target line
 * at `thresholdFraction` of it), so nothing on screen depends on this span. It used to: the well was
 * two bands either side of a target line pinned at a fixed height, and the band above it had to be
 * wide enough not to saturate before full ROM — which stopped the column pinning but still drew the
 * whole of the ROM above the threshold at up to 4.5x the compression of the ROM below it, on the
 * default 'easy' difficulty. `over` survives as what it always described: how far past their target
 * the patient got, as a fraction of the range they had left.
 */
export function meterOverSpan(thresholdFraction: number): number {
  const threshold = clamp(thresholdFraction, 0.05, 1);
  return Math.max(1 - threshold, threshold * METER_OVER_RANGE);
}

/**
 * How long the goal-attainment look (b) is held at full strength after the threshold crossing.
 * Knowledge of results is the therapeutic ingredient here, and the crossing itself lasts one 33 ms
 * camera frame — far below the ~100 ms a patient mid-rep can be expected to catch, and far below
 * the hit burst it has to stand alongside. 0.45 s sits between the judgment popup (0.5 s) and the
 * re-arm pop (0.28 s), so the three cues read as one sequence rather than as a flicker.
 */
export const GOAL_HOLD_SEC = 0.45;
/**
 * Ramp at the end of the hold. The marks of (b) stay until `goal` reaches 0; the ramp is what the
 * renderer glides the ring scale, the ring alpha and the liquid column down with, so the gauge
 * settles into the lockout look (c) instead of stepping down 12 % at the moment of success.
 */
export const GOAL_FADE_SEC = 0.15;

/**
 * How long the last tracked look is held before the receptor admits it cannot see the patient.
 * Long enough to swallow the visibility-gate chatter described above (a few frames at 30 fps),
 * short enough that a patient who has actually left frame is told so within a fifth of a second.
 */
export const LOST_HOLD_SEC = 0.2;

/** What the receptor should read for one lane this frame. */
export interface ReceptorLook {
  /** Meter fill 0..1 against the trigger threshold (1 = at or past `thresholdFraction`). */
  fill: number;
  /**
   * Overshoot 0..1: how far *past* the threshold the value is, over `meterOverSpan(threshold)` of
   * ROM (the threshold → full ROM). 0 whenever `fill < 1`, and it does not saturate anywhere inside
   * the reachable range, so `fill + over` together are a strictly monotone read-out of the
   * patient's position over the whole of `[0, 1]` ROM.
   *
   * A READOUT FOR CONSUMERS, NOT A DRAWING INPUT — say, "cleared the target by this much", the
   * ROM-achieved number a therapist is after. The receptor draws every height from `rom` through
   * `Highway.meterPos`, one linear ROM axis with the target line at `thresholdFraction` of it, so a
   * given movement covers the same distance on screen wherever in the range it is made; `fill` and
   * `over` are the same position expressed against the threshold instead.
   */
  over: number;
  /**
   * True exactly when the lane would score on THIS frame's numbers: re-armed, tracked, and at or
   * past threshold. See the file header — no input source in this repo publishes such a frame, so
   * in the running product this is always false and state (b) is driven by `goal`. It is kept as
   * the single-frame form of the same claim (it refreshes the latch when it is true), so a future
   * input layer that publishes the crossing as armed needs no renderer change.
   */
  willFire: boolean;
  /**
   * Goal-attainment strength 0..1 — the LATCHED form of "this rep reached the target". 1 on and
   * just after the threshold crossing, ramping to 0 at the end of `GOAL_HOLD_SEC + GOAL_FADE_SEC`.
   * Set by `ReceptorHistory.update`, which is the only thing that can see the crossing edge;
   * `receptorLookInto` on its own can only report the single-frame form (`willFire ? 1 : 0`).
   * `goal > 0` is state (b) and is the only thing that earns the "this counts" marks.
   *
   * Optional only so that a hand-built look literal written against the older shape still
   * type-checks; every function here writes it, so read it as `look.goal ?? 0`.
   */
  goal?: number;
  /**
   * True when the lane is locked out by hysteresis: it has fired (or has never been confirmed below
   * the re-arm level), so nothing the patient does can score until the value falls below
   * `thresholdFraction * rearmFraction`. Independent of `fill` — an unconfirmed lane below the
   * threshold is just as unable to fire. False while `tracking` is false: (d) outranks (c).
   *
   * `locked` and `goal > 0` overlap for the length of the latch, and that is not a contradiction:
   * the lane really has fired and really cannot fire again. The renderer resolves it by drawing (b)
   * for the latch and (c) after it — first "you got there", then "now come back down".
   */
  locked: boolean;
  /**
   * How much of the RETURN JOURNEY the patient has actually given back, 0..1, while locked
   * (1 = at or below the re-arm level, i.e. the next rep is about to start counting). 0 when
   * unlocked.
   *
   * MEASURED FROM WHERE THEY REALLY STARTED, which is `peakRom`: the journey is
   * `peakRom → thresholdFraction * rearmFraction` of ROM, and this is the fraction of it travelled.
   * It used to be measured in *clamped fill* units — `(1 - fill) / (1 - resetLevel)` — which
   * reported 0 for EVERY value at or above the threshold, so a patient who had genuinely lowered
   * from full ROM to the threshold (71 % of the descent on the default 'easy' difficulty) was told
   * they had given back nothing, and every mark driven by this number sat motionless for the first
   * and largest part of the descent. A gauge that flatlines while the patient performs the movement
   * it is asking for is worse than no gauge.
   *
   * A single frame cannot know `peakRom`, so `receptorLookInto` falls back to
   * `max(value, thresholdFraction)` — which reproduces the old reading exactly below the threshold
   * and reads 0 above it. `ReceptorHistory.update` supplies the real observed peak; it is what the
   * renderer draws from.
   */
  resetProgress: number;
  /**
   * The lane's value as a fraction of calibrated ROM — `LaneState.value`, clamped to the range the
   * calibration can produce (`[0, 1]`, with headroom to 1.5 for a synthetic/out-of-contract state).
   * `fill` and `over` are this same number expressed against the threshold; this is the raw units
   * the return journey and `peakRom` are measured in. Meaningless when `tracking` is false.
   *
   * Optional for the same reason as `goal`; always written by the functions here.
   */
  rom?: number;
  /**
   * The highest `rom` observed since this lockout began — the top of the return journey, and the
   * denominator of `resetProgress`. Equal to `rom` whenever the lane is not locked (there is no
   * journey in progress), and never below `thresholdFraction` while locked, because a lane locks
   * out by crossing the threshold and a lane that has never been confirmed is treated as having
   * come from there rather than from wherever it happens to be sitting.
   *
   * ONLY EVER RAISED, never decayed. A spurious landmark spike sets a peak the patient never
   * reached, which makes the gauge UNDER-report their progress for that descent; decaying the peak
   * back toward the current value would instead make the arc creep forward while the patient holds
   * perfectly still, which is a lie in the one state whose whole message is "you have not given
   * anything back yet". Under-reporting is the correct direction to be wrong in, and the arc still
   * completes exactly on the re-arm line either way.
   *
   * Optional for the same reason as `goal`; always written by the functions here.
   */
  peakRom?: number;
  /**
   * True while the lane is locked AND not yet below the re-arm level — i.e. the patient really does
   * have somewhere to lower to. (At the line exactly it is still true: `LaneTrigger` re-arms on
   * `value < rearmLevel`, strictly, so "on the line" is one notch short.) The "lower to reset" instruction (the drain cap read as a thing to
   * bring down, and the chevron) is drawn from THIS, not from `locked`.
   *
   * A locked lane can sit BELOW the re-arm line: 'unconfirmed' is a statement about what has been
   * observed, not about the current value, so `setThreshold`, a reset, or a stream break can leave a
   * lane at 0.1 of ROM unable to fire. Telling that patient to lower further is an instruction they
   * cannot carry out — they are already past the line they are being pointed at. The lane still
   * cannot score, so it is still (c) and still says so; it just stops giving an order that is
   * already obeyed, and its return-to-rest arc is complete.
   *
   * Optional for the same reason as `goal`; always written by the functions here.
   */
  needsLower?: boolean;
  /** Height of the re-arm line inside the ring, as a fraction of the meter (0..1). */
  resetLevel: number;
  /** Halo / glow target 0..1. Zero whenever the lane cannot fire, except during the goal latch. */
  glowTarget: number;
  /**
   * False when the tracker has lost the limb / hand *and* the `LOST_HOLD_SEC` hold has expired (or
   * this lane was never tracked at all). Every other field is then meaningless and the renderer
   * draws nothing derived from a value: a broken, slowly breathing ring and a "?", and no fill,
   * level line, target line, halo, lock cue or beat pulse. See `Highway.drawLostReceptor`.
   */
  tracking: boolean;
  /**
   * True while the look is the LAST TRACKED one, replayed during the `LOST_HOLD_SEC` anti-strobe
   * hold: `tracking` is still true and the gauge still draws, but the numbers are up to
   * `LOST_HOLD_SEC` old. Nothing in the renderer needs to treat it specially — it exists so a
   * consumer that logs or scores off a look can tell a measurement from a held one.
   *
   * Optional for the same reason as `goal`; always written by the functions here.
   */
  stale?: boolean;
}

/**
 * Which of the four MARK SETS a look wears. The four states differ by the number and shape of the
 * marks drawn, not by brightness or hue (see `Highway.drawReceptors`), so this is the one place that
 * decides which set a look is in — and it is exported because it is the answer EVERY live meter on
 * screen has to give at the same instant.
 *
 * ONE VOICE. The receptor row is not the only movement meter in the patient's field of view: the
 * play screen's picture-in-picture lane meters sit next to the camera preview for the whole session
 * (src/ui/Play.tsx). They used to be drawn from their own single-frame reading, which meant they had
 * no crossing latch and could only test `willFire` — the conjunction no input source in this repo
 * ever publishes (see the file header) — so on the frame the patient reached their target the
 * receptor threw the full goal look and the meter 300 px away went straight to the grey "lower to
 * reset" costume. Two meters disagreeing at the one moment that matters is worse than either being
 * wrong on its own. Both now go through `ReceptorHistory.update` and classify with this function.
 *
 * The order is the precedence order and it is not arbitrary: no measurement outranks everything
 * (nothing derived from a value may be drawn), the crossing outranks the lockout it causes (the
 * patient is told "you got there" before "now come back down"), and a locked lane outranks its own
 * level (a lane that cannot fire may wear no part of the "this counts" costume at any value).
 */
export type ReceptorMarkSet = 'lost' | 'goal' | 'locked' | 'rising';

/** Classify a look into its mark set — see `ReceptorMarkSet`. */
export function receptorMarkSet(look: ReceptorLook): ReceptorMarkSet {
  if (!look.tracking) return 'lost';
  if ((look.goal ?? 0) > 0) return 'goal';
  if (look.locked) return 'locked';
  return 'rising';
}

/** Shape of the per-lane state this reads (structurally `RenderLaneState`). */
export interface LaneStateLike {
  value: number;
  armed: boolean;
  tracking?: boolean;
  /**
   * The input layer's OWN trigger state, when it publishes one. `armed` collapses 'unconfirmed' and
   * 'triggered' into one flag, and the difference between them is exactly the difference between
   * "this rep fired" and "this lane has never been confirmed", which is what the crossing latch has
   * to guess at otherwise (see `ReceptorHistory.update`). When it is present the receptor reads it
   * instead of guessing, and `armed` is derived from it so the two can never disagree.
   *
   * `VisionInput` does not publish it in `LaneState` yet (it does expose it on `LaneDebug` /
   * `LaneActivity`); until it does, the latch falls back to the edge rule and the gap rule below.
   */
  triggerState?: 'unconfirmed' | 'armed' | 'triggered';
}

/** A zeroed look, for callers that need one to pass to `receptorLookInto` / `ReceptorHistory`. */
export function emptyReceptorLook(rearmFraction: number = DEFAULT_REARM_FRACTION): ReceptorLook {
  return {
    fill: 0, over: 0, willFire: false, goal: 0, locked: false, needsLower: false,
    resetProgress: 0, rom: 0, peakRom: 0, resetLevel: rearmFraction, glowTarget: 0, tracking: true, stale: false,
  };
}

function copyLook(out: ReceptorLook, src: ReceptorLook): ReceptorLook {
  out.fill = src.fill;
  out.over = src.over;
  out.willFire = src.willFire;
  out.goal = src.goal ?? 0;
  out.locked = src.locked;
  out.needsLower = src.needsLower ?? false;
  out.resetProgress = src.resetProgress;
  out.rom = src.rom ?? 0;
  out.peakRom = src.peakRom ?? src.rom ?? 0;
  out.resetLevel = src.resetLevel;
  out.glowTarget = src.glowTarget;
  out.tracking = src.tracking;
  out.stale = src.stale ?? false;
  return out;
}

/**
 * Fill an existing `ReceptorLook` (allocation-free; the renderer calls this once per lane per
 * frame). SINGLE-FRAME ONLY: `goal` is just `willFire`, which no real input source produces, and
 * tracking is not debounced — go through `ReceptorHistory.update` for the state the receptor is
 * actually drawn from.
 *
 * `state` may be undefined, and that is NOT an idle lane: a lane with no meter has no measurement,
 * so it reads as (d) tracking lost. (`GameRunner`'s first frame ships `laneStates: []`; drawing
 * four live, at-rest gauges for it would be the same lie as a meter pinned under a dead camera.)
 *
 * `peakRom` is the one number a single frame cannot supply: the top of the return journey
 * `resetProgress` is measured from (see `ReceptorLook.peakRom`). Omit it and the journey is
 * measured from `max(value, thresholdFraction)`, i.e. from wherever the patient is right now, which
 * reads 0 for the whole of the descent above the threshold. `ReceptorHistory.update` passes the
 * observed peak, and that is the form the renderer uses.
 */
export function receptorLookInto(
  out: ReceptorLook,
  state: LaneStateLike | undefined,
  thresholdFraction: number,
  rearmFraction: number,
  peakRom?: number,
): ReceptorLook {
  const threshold = clamp(thresholdFraction, 0.05, 1);
  const rearm = clamp(rearmFraction, 0.05, 0.99);
  const value = state ? clamp(state.value, 0, 1.5) : 0;
  // The input layer's own trigger state wins when it publishes one: `armed` is a two-way collapse of
  // a three-way fact, and everything hard about the crossing latch comes from that collapse.
  const trig = state ? state.triggerState : undefined;
  const armed = trig ? trig === 'armed' : state ? state.armed !== false : true;
  const tracking = state ? state.tracking !== false : false;
  const ratio = value / threshold;
  const fill = clamp(ratio, 0, 1);
  // The re-arm point, expressed in the meter's own units (fraction of threshold) — that is exactly
  // where the re-arm line is drawn inside the ring.
  const resetLevel = rearm;
  const locked = !armed && tracking;
  // The top of the return journey, in ROM. Floored at the threshold because that is where a lockout
  // begins: a lane goes to 'triggered' by crossing the threshold, and one that is 'unconfirmed' at
  // some lower value has to be given SOME journey to travel or the arc would be complete before the
  // patient had moved. Raised to the observed peak by `ReceptorHistory`, which is what turns the
  // whole descent from full ROM into drawn-to-scale motion instead of a frozen `fill: 1`.
  const peak = Math.max(Number.isFinite(peakRom as number) ? (peakRom as number) : value, value, threshold);
  // Where the lane re-arms, in the same ROM units (`LaneTrigger.rearmLevel`).
  const rearmRom = threshold * rearm;
  out.fill = fill;
  // Measured over the threshold → full ROM span (see `meterOverSpan`), so it never saturates before
  // full ROM: `fill + over` is a strictly monotone position read-out over the whole range.
  out.over = clamp((value - threshold) / meterOverSpan(threshold), 0, 1);
  out.rom = value;
  out.peakRom = locked ? peak : value;
  out.tracking = tracking;
  out.stale = false;
  out.locked = locked;
  out.willFire = armed && tracking && fill >= 1;
  out.goal = out.willFire ? 1 : 0;
  // 0 at the top of the journey, 1 once the value has dropped to the re-arm line — measured over
  // the REAL distance `peak - rearmRom`, so every millimetre of the descent moves it. A lane locked
  // below the line already ('unconfirmed' after a reset, a stream break or a threshold change) has
  // no journey left: its return is complete by definition.
  out.resetProgress = locked ? (peak > rearmRom ? clamp((peak - value) / (peak - rearmRom), 0, 1) : 1) : 0;
  out.resetLevel = resetLevel;
  // ...but only ORDER the patient down while there is somewhere to go. A locked lane below the
  // re-arm line (see `needsLower`) is still locked and still says so; it just stops pointing at a
  // line the patient is already under.
  out.needsLower = locked && fill >= resetLevel;
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
  return receptorLookInto(emptyReceptorLook(rearmFraction), state, thresholdFraction, rearmFraction);
}

/**
 * Strength of the goal-attainment look `age` seconds after the threshold crossing: 1 for
 * `GOAL_HOLD_SEC`, then a linear ramp to 0 over `GOAL_FADE_SEC`.
 */
export function goalStrength(age: number): number {
  if (!(age >= 0)) return 0;
  if (age < GOAL_HOLD_SEC) return 1;
  const v = 1 - (age - GOAL_HOLD_SEC) / GOAL_FADE_SEC;
  // Snapped to 0 at the end: `goal > 0` is what switches the whole (b) mark set on, so a float
  // residue of 2e-16 would hold the "you reached it" costume for one extra frame.
  return v <= 1e-6 ? 0 : v;
}

interface LaneHistory {
  /** A tracked frame has been folded in, so `prevArmed` means something. */
  seen: boolean;
  /** Was the previous TRACKED frame able to fire? The left half of the crossing edge. */
  prevArmed: boolean;
  /** The previous TRACKED frame's published trigger state, when the source publishes one. */
  prevTrigger: 'unconfirmed' | 'armed' | 'triggered' | undefined;
  /** Time of the most recent threshold crossing (-Infinity = never). */
  goalT0: number;
  everTracked: boolean;
  lastTrackedAt: number;
  /**
   * Time of the last DISTINCT tracked sample — the renderer's estimate of the input layer's
   * `lastObservedTime`. See `ReceptorHistory.update`: `now - observedAt` is the gap `LaneTrigger`
   * measures its own continuity break against, so it is what the arming evidence expires on.
   */
  observedAt: number;
  /** The last state fed in, by reference and by value, so a repeated sample can be told from a new one. */
  srcRef: LaneStateLike | undefined;
  srcValue: number;
  srcArmed: boolean;
  srcTracking: boolean;
  srcTrigger: 'unconfirmed' | 'armed' | 'triggered' | undefined;
  /** The threshold / re-arm fraction the arming evidence was gathered under. */
  threshold: number;
  rearm: number;
  /**
   * Highest value observed since this lockout began — the top of the return journey (see
   * `ReceptorLook.peakRom`). NaN = no journey being watched, so the next locked frame starts one
   * from wherever the patient is. Reset when the lane re-arms, when the stream breaks (an
   * unobserved window is not evidence about how high they got), and when the threshold is retuned.
   */
  peak: number;
  /** Last tracked look, replayed during the anti-strobe hold. */
  last: ReceptorLook;
  /** Last update time, to notice a clock that went backwards (song restart / seek). */
  t: number;
}

function newLaneHistory(): LaneHistory {
  return {
    seen: false, prevArmed: false, prevTrigger: undefined, goalT0: -Infinity, everTracked: false,
    lastTrackedAt: -Infinity, observedAt: -Infinity,
    srcRef: undefined, srcValue: NaN, srcArmed: false, srcTracking: false, srcTrigger: undefined,
    threshold: NaN, rearm: NaN, peak: NaN,
    last: emptyReceptorLook(), t: -Infinity,
  };
}

/** Drop the crossing evidence: whatever happens next, it is not a rising edge this renderer watched. */
function forgetArming(h: LaneHistory): void {
  h.seen = false;
  h.prevArmed = false;
  h.prevTrigger = undefined;
}

/**
 * The two things one frame of `LaneState` cannot tell you: that the threshold was just crossed
 * (state (b) — see the file header) and whether a `tracking: false` is a real dropout or one noisy
 * frame. Keeps a few numbers per lane, allocates nothing per frame, and is the model both the
 * receptor row and any other live meter should be drawn from, so the patient never has two meters
 * in front of them saying different things.
 */
export class ReceptorHistory {
  private lanes: LaneHistory[] = [];

  /** Drop all history (song restart, lane count change, input source swap). */
  reset(): void {
    for (const h of this.lanes) Object.assign(h, newLaneHistory());
  }

  /**
   * Fill `out` with the look lane `lane` should be drawn from at time `now` (seconds; the same
   * clock every frame — `RenderFrame.songTime` in the renderer).
   */
  update(
    out: ReceptorLook,
    lane: number,
    state: LaneStateLike | undefined,
    thresholdFraction: number,
    rearmFraction: number,
    now: number,
    maxGapSec: number = DEFAULT_MAX_GAP_SEC,
  ): ReceptorLook {
    let h = this.lanes[lane];
    if (!h) {
      h = newLaneHistory();
      this.lanes[lane] = h;
    }
    // A clock that jumped backwards is a new song / a seek, not a rep: nothing before it is
    // evidence about what the patient is doing now.
    if (Number.isFinite(now) && now < h.t) Object.assign(h, newLaneHistory());
    h.t = now;

    // ---- what counts as a NEW observation ------------------------------------------------------
    // The renderer runs faster than the camera, so most frames re-present the sample the previous
    // one already showed (`VisionInput.getLaneStates` deliberately returns the SAME frozen objects
    // until it processes a new detection). A repeat is not an observation, and the whole gap rule
    // below is about how long it has been since the input layer last observed anything.
    //
    // TWO DIFFERENT QUANTITIES, AND THE DIFFERENCE IS BOUNDED. `LaneTrigger` measures its own
    // continuity on `push()` calls — one per processed camera frame, whatever the sample says —
    // while the renderer can only measure what it can SEE in `LaneState`, which is object identity
    // and four field values. The two agree for `VisionInput`, and by construction rather than by
    // luck: it rebuilds a fresh frozen `LaneState` per processed frame (memoized on `frameSeq`), so
    // `state !== h.srcRef` is true on exactly the frames it pushed and false on the extra polls of a
    // 60 Hz renderer. `receptor.test.ts` pins that path ("a repeated value in a NEW object is still
    // an observation") so a future memoization that reuses the object across frames cannot silently
    // turn a still patient into a stream break.
    //
    // Where they can diverge is a source that returns the SAME object for many processed frames.
    // The scripted sources do exactly that (`src/input/laneStates.ts` caches on a held/not-held
    // bitmask), and there a patient held at one value for longer than `maxGapSec` looks silent from
    // here. The consequence is bounded and one-directional: the arming evidence and the peak are
    // dropped, so the renderer may WITHHOLD a goal latch (a rising rep re-seeds `seen` several
    // frames before it crosses, so a real crossing survives) and may restart the return journey from
    // the patient's current height, which under-reports their progress. It can never invent a
    // crossing. That is the safe direction, and the honest fix is the same one the RESIDUAL
    // paragraph names: publish `triggerState` (or the sample's observation time) in `LaneState`.
    const fresh =
      state !== h.srcRef ||
      !(state === undefined || (state.value === h.srcValue && state.armed === h.srcArmed && (state.tracking !== false) === h.srcTracking && state.triggerState === h.srcTrigger));
    h.srcRef = state;
    h.srcValue = state ? state.value : NaN;
    h.srcArmed = state ? state.armed : false;
    h.srcTracking = state ? state.tracking !== false : false;
    h.srcTrigger = state ? state.triggerState : undefined;

    // ---- AN UNOBSERVED WINDOW IS NOT EVIDENCE --------------------------------------------------
    // `LaneTrigger.breakContinuity` throws an armed lane's arming away as soon as the stream has
    // been silent for longer than `maxGapSec` — a whole rep could have started and finished in
    // there. When it does, the lane goes to 'unconfirmed' AT ITS CURRENT VALUE, which is published
    // as exactly the same `{ value >= threshold, armed: false }` frame a real crossing is. Without
    // this rule the receptor read a lane recovering from a half-second occlusion as a rep that had
    // just scored and threw the full "you reached it" celebration for a rep that fired NOTHING (no
    // LaneInputEvent and, because breakContinuity closes the rep, no CompletedRep either).
    //
    // So the renderer applies the trigger's own rule to its own evidence, measured off the same
    // quantity: the time since the last DISTINCT tracked sample. Past that, the previous arming is
    // not something this renderer watched any more, and no edge may be latched from it.
    const gap = Number.isFinite(maxGapSec) && maxGapSec > 0 ? maxGapSec : DEFAULT_MAX_GAP_SEC;
    if (h.everTracked && now - h.observedAt > gap) forgetArming(h);
    // `LaneTrigger.setThreshold` also re-checks the arming (a therapist making the song easier
    // mid-song disarms every lane that is not already below the NEW re-arm level) — likewise not a
    // crossing. The renderer cannot see the re-check, but it can see the number change.
    const tuned =
      (Number.isFinite(h.threshold) && Number.isFinite(thresholdFraction) && thresholdFraction !== h.threshold) ||
      (Number.isFinite(h.rearm) && Number.isFinite(rearmFraction) && rearmFraction !== h.rearm);
    if (h.seen && tuned) forgetArming(h);
    // The peak the return journey is measured from is evidence too, and it expires on exactly the
    // same two rules. A lane recovering from half a second of lost landmarks is 'unconfirmed' at
    // whatever value it has, and the renderer did not watch how high it got; a retuned threshold
    // moves the finish line the journey is measured to. Either way the honest thing is to start the
    // journey again from where the patient is now, which under-reports their progress rather than
    // inventing a descent they may not have made.
    if (h.everTracked && now - h.observedAt > gap) h.peak = NaN;
    if (tuned) h.peak = NaN;
    h.threshold = thresholdFraction;
    h.rearm = rearmFraction;

    receptorLookInto(out, state, thresholdFraction, rearmFraction, h.peak);

    if (out.tracking) {
      // THE CROSSING. The trigger flips to 'triggered' on the sample that crosses, so the crossing
      // frame arrives as "locked, at or past threshold" one frame after an armed one. That edge —
      // not `armed && fill >= 1`, which no source emits — is the moment the lane fired.
      //
      // When the source publishes its trigger state the edge is a FACT rather than an inference:
      // only 'armed' → 'triggered' is a crossing, and an 'unconfirmed' lane never is one however
      // full its meter. That is the same distinction the gap rule above reconstructs by hand.
      const cross = h.srcTrigger !== undefined && h.prevTrigger !== undefined
        ? h.prevTrigger === 'armed' && h.srcTrigger === 'triggered'
        : h.seen && h.prevArmed && out.locked && out.fill >= 1;
      if (out.willFire || cross) h.goalT0 = now;
      h.seen = true;
      h.prevArmed = !out.locked;
      h.prevTrigger = h.srcTrigger;
      h.everTracked = true;
      h.lastTrackedAt = now;
      // THE TOP OF THE RETURN JOURNEY. While the lane is locked this only ever rises (see
      // `ReceptorLook.peakRom`); the moment it re-arms the journey is over and the next one starts
      // from wherever the patient is when they next lock out.
      h.peak = out.locked ? (out.peakRom as number) : NaN;
      if (fresh) h.observedAt = now;
      copyLook(h.last, out);
    } else if (h.everTracked && now - h.lastTrackedAt < LOST_HOLD_SEC) {
      // Anti-strobe hold: replay the last real measurement rather than flipping the whole row to
      // "?" on one frame that failed the visibility gate.
      copyLook(out, h.last);
      out.stale = true;
    }

    const goal = out.tracking ? goalStrength(now - h.goalT0) : 0;
    out.goal = goal;
    if (goal > 0) out.glowTarget = Math.max(out.glowTarget, goal);
    return out;
  }
}
