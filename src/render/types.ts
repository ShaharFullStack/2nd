import type { HitEvent, Judgment, LaneSpec } from '../engine/types';

/** Visual state of a note as far as the renderer is concerned. */
export type NoteVisualState = 'pending' | 'hit' | 'miss';

/** A note that is (or was recently) on screen. Plain data — one per visible note per frame. */
export interface RenderNote {
  id: number;
  lane: number;
  /** Song time (seconds) the note should be struck. */
  time: number;
  state: NoteVisualState;
  /**
   * Set once the note is judged (hit or miss). Read by the renderer's no-event fallback: if a note
   * is flipped to `hit`/`miss` and no matching `HitEvent` has been seen (yet, or ever), the renderer
   * fires that judgment's feedback itself — `perfect` gets the brighter burst + gold popup, anything
   * else `good`. When the `HitEvent` does arrive it is de-duped, so feedback plays exactly once.
   */
  judgment?: Judgment;
}

/**
 * Per-lane live movement meter. Structurally compatible with `LaneState` from src/input/types.ts,
 * so `inputSource.getLaneStates()` can be passed straight through.
 */
export interface RenderLaneState {
  /**
   * Which lane this meter belongs to. **Read when present** (that is what `LaneState.lane` is for):
   * the renderer indexes meters by this value, so `getLaneStates()` may arrive in any order. Only
   * when it is absent everywhere does the renderer fall back to array position — and a `lane` that
   * is out of range or duplicated warns once on the console rather than silently attaching a
   * patient's knee meter to another lane's receptor.
   */
  lane?: number;
  /** Normalized movement value 0..1 of calibrated ROM. */
  value: number;
  /**
   * Hysteresis re-arm flag, straight from the input engine (`LaneTrigger.armed`): false means the
   * lane **cannot fire** — at any value — until it falls below `thresholdFraction * rearmFraction`
   * (`LaneTrigger.rearmLevel`). It covers both of the trigger's non-firing states, 'triggered' (the
   * rep fired and has not been given back) and 'unconfirmed' (never yet observed below the re-arm
   * level: a patient who started the song at end range, a lane recovering from an occlusion, a
   * calibration replaced mid-rep). The remedy is the same for both, which is why the receptor draws
   * them the same way.
   *
   * This is NOT a brightness modifier. The receptor renders it as a categorically different set of
   * MARKS: the ring shrunk 12 % and pulled most of the way toward the dead miss grey — desaturated,
   * but still carrying the lane's own hue, so the lane keeps its identity at the instant its note is
   * struck — a dulled liquid column, and — uniquely to this state — a violet drain cap riding the
   * top of that column, a dashed re-arm line at the level to come back down to, a "lower to reset"
   * chevron in the gap between the two, and an arc outside the ring that grows with the fraction of
   * the return journey travelled and completes exactly when the lane re-arms. Just as important is
   * what is *removed*: no level line, no target line or ticks, no hot fill, no halo, no additive rim
   * or corona. A lane with `armed === false` must never wear any part of the "this counts" costume:
   * the input layer will emit nothing for it however hard the patient pushes.
   *
   * THE COLUMN IS NOT ONE OF THOSE MARKS. It is a position gauge on the same scale in every state,
   * so a locked lane's column stands at the patient's true height — above the target height if that
   * is where they are — and travels down through it as they lower. It was once clamped short of the
   * target height to keep it from "looking ready", and the cost was the opposite of biofeedback:
   * combined with a fill that saturates at the threshold, the column and every mark hanging off it
   * (drain cap, chevron, arc) sat frozen for the whole span from the patient's real peak down to
   * the threshold — 71 % of the return journey on the default 'easy' difficulty. All four of the
   * return-to-rest marks now move from the first millimetre of the descent; the eccentric phase is
   * a therapeutic target in its own right, not dead time.
   *
   * ONE EXCEPTION, AND IT IS THE POINT: the ~0.45 s immediately after the THRESHOLD CROSSING. The
   * trigger disarms on the sample that crosses (src/vision/trigger.ts) and `VisionInput` pushes it
   * before it publishes `armed` (src/input/VisionInput.ts), so the crossing frame arrives here as
   * `{ value >= threshold, armed: false }` — the frame the lane really did fire on is an
   * `armed: false` frame, and no frame from any input source in this repo is ever
   * `armed && value >= threshold`. The renderer therefore latches that EDGE (a lane that was armed
   * on the previous tracked frame and is now not armed at or past threshold) and shows the
   * goal-attainment look for it; see `ReceptorHistory` in src/render/receptor.ts. Without the latch
   * the patient gets no gauge-level acknowledgement of reaching their target range at all, and the
   * column visibly steps DOWN at the moment they reach it.
   *
   * AND THE EDGE IS NOT ENOUGH ON ITS OWN. A lane is disarmed by three different things, only one
   * of which is a rep: the crossing; `LaneTrigger.breakContinuity`, i.e. the sample stream going
   * silent for longer than `maxGapSec` (VisionInput pushes a null sample for every untracked frame,
   * so half a second of a lost landmark does it) which sends the lane to 'unconfirmed' AT ITS
   * CURRENT VALUE; and `LaneTrigger.setThreshold`, which re-checks the arming when a therapist
   * retunes the difficulty mid-song. Cases 2 and 3 publish exactly the same
   * `{ value >= threshold, armed: false }` frame as a crossing while emitting no `LaneInputEvent`
   * and — case 2 — no `LaneRepEvent` either. So `ReceptorHistory` also expires its evidence the way
   * the trigger expires its own: an arming older than `RenderFrame.maxGapSec` of unobserved stream,
   * or gathered under a different `thresholdFraction` / `rearmFraction`, cannot produce a crossing.
   * See `RenderLaneState.triggerState` for the way to stop guessing altogether, and the RESIDUAL
   * paragraph in src/render/receptor.ts for what is left.
   */
  armed: boolean;
  /**
   * OPTIONAL, AND PREFERRED: the input layer's own three-way trigger state
   * (`LaneTrigger.state`, already exposed on `VisionInput.getLaneDebug()` /
   * `getLaneActivity()`). `armed` collapses 'unconfirmed' and 'triggered' into one flag, and the
   * difference between them is the difference between "this rep just fired" and "this lane has
   * never been confirmed" — the exact thing the crossing latch has to reconstruct from timing
   * otherwise. When this is present the receptor reads it instead: only 'armed' → 'triggered' is a
   * crossing, an 'unconfirmed' lane never is one however full its meter, and `armed` is derived
   * from it so the two cannot disagree.
   *
   * `VisionInput.getLaneStates()` does not publish it yet. Wiring it there (one field, already on
   * the lane's trigger) removes the last inference in the receptor's "this counts" cue.
   */
  triggerState?: 'unconfirmed' | 'armed' | 'triggered';
  /**
   * False when the tracker lost the limb / hand (`VisionInput.getLaneStates()` sets it, and reports
   * `value: 0` with it when the whole stream is dead — a lane-level dropout instead leaves the last
   * sample behind, which is why the renderer must not read `value` here either). Defaults to true
   * when absent.
   *
   * There is no measurement in this state, so the receptor draws nothing that encodes `value` — no
   * well, no fill, no level line, no target line, no halo, no lock cues, not even the beat pulse (a
   * dead signal must not dance with the music). It shows a broken, slowly breathing light-grey ring
   * with a large "?" instead: the only ring on the board with gaps in it, distinct from the solid
   * grey "lower to reset" ring, because the remedy is different (get back in frame, not move
   * differently). It outranks `armed === false`: a patient who is out of frame cannot act on
   * "lower to reset".
   *
   * DEBOUNCED BY THE RENDERER. This flag is a per-frame hard visibility gate
   * (src/vision/landmarks.ts `MIN_VISIBILITY`, via src/vision/pipeline.ts) passed straight through
   * by `VisionInput`, and nothing upstream smooths it: a landmark chattering across that gate —
   * marginal framing, or motion blur at peak rep velocity — would strobe the whole receptor row
   * between a full gauge and "?" at frame rate, and during Play the receptor is the patient's only
   * out-of-frame signal. So the renderer holds the last tracked look for `LOST_HOLD_SEC` (0.2 s)
   * before it will show this state; a lane that has never been tracked shows it immediately.
   *
   * A lane with NO `RenderLaneState` at all is treated as this state, not as an idle armed lane:
   * an absent measurement is "I cannot see you", and `GameRunner`'s first frame really does ship
   * `laneStates: []`.
   */
  tracking?: boolean;
}

/**
 * Everything the highway needs to paint one frame. The game loop builds a fresh
 * (or reused) object every animation frame and hands it to `Highway.draw()`.
 * Nothing here is mutated by the renderer.
 */
export interface RenderFrame {
  /** Current song time in seconds (audio clock). Drives scrolling and all animations. */
  songTime: number;
  /** Notes to consider drawing. Off-screen ones are culled by the renderer; pass a window of ±approachSec. */
  notes: RenderNote[];
  /**
   * Lane definitions (2..4). `LaneSpec.index` is read when the specs carry a full 0..n-1 set, so a
   * therapist config in any order still labels the right lane; otherwise array position is used
   * (and an out-of-range / duplicated `index` warns once).
   */
  lanes: LaneSpec[];
  /**
   * Live movement meters, one per lane — matched by `RenderLaneState.lane` when present. A lane
   * with no entry has no measurement and is drawn as tracking-lost (see `RenderLaneState.tracking`),
   * never as an idle at-rest gauge.
   */
  laneStates: RenderLaneState[];
  combo: number;
  /** Score multiplier tier (1..4+). */
  multiplier: number;
  score: number;
  /** Rock meter 0..1. */
  health: number;
  /** Hit / miss events from roughly the last second; used to spawn bursts, popups and lane tints. */
  recentHits: HitEvent[];
  bpm: number;
  /** Fraction 0..1 of the way through the current beat. */
  beatPhase: number;
  /** Index of the current beat since the chart's first beat (for bar lines every 4 beats). Defaults to floor(songTime*bpm/60). */
  beatIndex?: number;
  songTitle?: string;
  attribution?: string;
  /** Optional audio-reactive energy 0..1 (e.g. RMS of the mix); boosts glow intensity. */
  energy?: number;
  /**
   * Fraction of ROM that counts as a hit — pass `Difficulty.thresholdFraction` for the session,
   * every frame. It is drawn as a fixed TARGET LINE across the receptor's meter well (and as two
   * marks on the ring's outline at the same height, where the liquid can never cover them), at 76 %
   * of the well's height; the band above it spans the rest of the patient's calibrated ROM, so the
   * meter answers "how much further" during the rise and can never saturate before full ROM. The
   * column is a POSITION on one scale in all four states — including the locked one, whose whole
   * job is to be lowered and which therefore has to be able to show itself coming down from above
   * the line. Only during the ~0.45 s after a real threshold crossing is a height above that line
   * ALSO a claim: "this rep cleared the target by this much", the ROM-achieved reading a therapist
   * is looking for. In every other state the height says where the patient is and nothing more.
   *
   * A level at or above the target line is necessary but NOT sufficient for the "you reached it"
   * look. That one (hot fill into the headroom, split white-hot cap, two solid arrowheads in place
   * of the ticks, inner rim, corona, full halo) is drawn only for the CROSSING — latched by the
   * renderer from the armed → not-armed edge at or past threshold, because the crossing frame is
   * published with `armed: false` and the level test `armed && value >= threshold` matches no frame
   * any input source in this repo emits (see `RenderLaneState.armed`). A lane that is merely held
   * at end range gets none of it; a lane that has just fired gets all of it, once, for as long as a
   * patient mid-rep can actually catch it. After the latch the receptor becomes the locked-out look
   * and loses the target line and ticks altogether: its target is now the re-arm line below, not
   * the threshold above.
   *
   * The latch is guarded, because an armed → not-armed edge is not always a crossing: see
   * `RenderLaneState.armed`. An arming that predates more than `maxGapSec` of unobserved stream, or
   * that was gathered under a different threshold, is thrown away rather than celebrated — the same
   * rule `LaneTrigger` applies to its own arming.
   *
   * KNOWN LIMITS, stated because the rest of this doc is a promise: the renderer can only be as
   * truthful as `LaneState` is, and two paths to the cue survive the guards.
   *   - REFRACTORY. `src/vision/trigger.ts` swallows a crossing that lands within `minIntervalSec`
   *     (0.3 s) of the previous one, and that window is not exposed in `LaneState`. Such a crossing
   *     still enters 'triggered', so the latch still fires and the gauge still says "you reached
   *     your target" — true of the patient's movement (the rep IS reported, with
   *     `LaneRepEvent.emitted: false`) but not of the score.
   *   - AN UNREPORTED STALL. The gap guard can only measure silence the renderer is TOLD about.
   *     `VisionInput` republishes its last sample with `tracking: true` until its own stall
   *     watchdog fires, so up to `maxGapSec` of the trigger's silence can be invisible here, and a
   *     lane whose stream died in that window and recovers at end range can still be latched.
   * Both close the same way, upstream and cheaply: publish `RenderLaneState.triggerState` (or the
   * sample's observation time) from `VisionInput.getLaneStates()`. The renderer must not guess at
   * either number.
   *
   * The threshold is optional only so the type stays compatible with partial frames: when it is
   * absent the renderer falls back to 0.5 *and warns once on the console*, because a meter filled
   * against the wrong threshold is a lie (a full ring with no note firing, or a note firing at a
   * half-full ring).
   */
  thresholdFraction?: number;
  /**
   * Hysteresis re-arm fraction: after a lane fires it cannot fire again until its value falls below
   * `thresholdFraction * rearmFraction` (`LaneTrigger.rearmLevel`). Defaults to
   * `DEFAULT_REARM_FRACTION` (0.6), the value in the architecture contract. A locked-out receptor
   * draws its dashed re-arm line at exactly this height and closes its return-to-rest arc exactly
   * when the value reaches it, so pass the session's real value if it is ever tuned — a re-arm line
   * drawn at the wrong height tells the patient to stop lowering while the lane is still dead.
   */
  rearmFraction?: number;
  /**
   * The input layer's break-in-the-stream window: a sample arriving more than this long after the
   * previous OBSERVED one makes `LaneTrigger` throw the lane's arming away ('unconfirmed'), because
   * a whole rep could have started and finished unwatched. Defaults to `DEFAULT_MAX_GAP_SEC`
   * (0.5 s) — `LaneTrigger`'s default and the value `VisionInput` actually passes its triggers
   * (`VisionInput.staleFrameSec`).
   *
   * The receptor needs it because the disarming it causes is published as *exactly* the frame a
   * threshold crossing is (`{ value >= threshold, armed: false }`), with no `LaneInputEvent` and no
   * `LaneRepEvent` behind it. `ReceptorHistory` therefore expires its own crossing evidence on the
   * same clock: a patient whose limb left frame for half a second mid-rep is told to lower and
   * reset, not congratulated for a rep that scored nothing. Pass the session's real value if
   * `staleFrameSec` is ever tuned — too large re-opens the false "you reached it", too small only
   * costs a real crossing its acknowledgement.
   */
  maxGapSec?: number;
}

/** Tunables for the highway renderer. All optional; see DEFAULT_HIGHWAY_OPTIONS. */
export interface HighwayOptions {
  /** Seconds a note takes to travel from the horizon (far road edge) to the strike line. */
  approachSec: number;
  /** Far road edge as a fraction of canvas height. */
  horizonY: number;
  /** Strike line as a fraction of canvas height. */
  strikeY: number;
  /** Road width at the horizon relative to its width at the strike line (0..1). Smaller = stronger perspective. */
  farScale: number;
  /** Road width at the strike line as a fraction of canvas width (for 4 lanes; fewer lanes shrink a bit). */
  roadWidth: number;
  /**
   * Screen-space scroll speed below the strike line relative to the speed at the line (0.2..1).
   * Lower keeps gems visible longer past the line so the engine's late miss verdict
   * (note time + goodMs + grace, up to ~280 ms) still lands on a gem that is *entirely* on screen.
   * The default 0.34, with the default `strikeY` 0.78, keeps the whole gem inside the canvas for
   * ≥ 300 ms past the line at 720p / 1080p / portrait / ultrawide (`gemVisibleTailSec`, asserted in
   * geometry.test.ts). The speed eases into the tail over ~0.13 s so a gem crossing the receptor
   * never visibly brakes.
   */
  pastLineSpeed: number;
  /** Use the rehab-friendly high-contrast palette instead of Guitar Hero colors. */
  highContrast: boolean;
  /** Draw movement labels under each lane. */
  showLabels: boolean;
  /**
   * Show a (neutral grey) "MISS" popup on missed notes. Off by default for the rehab audience — a
   * miss is still signalled by the gem greying out + fizzling and a soft red lane tint.
   * Therapist-toggleable at runtime via setOptions().
   */
  showMissPopup: boolean;
  /** Overlay draw-time stats (for the demo / profiling). */
  showStats: boolean;
  /**
   * Particle pool capacity. Applied immediately by `setOptions()` (the pool is reallocated), so a
   * therapist-facing "calmer effects" control can lower it mid-song.
   */
  maxParticles: number;
  /**
   * Decorative effect intensity 0..1 (default 1). Scales the things that are *not* judgment
   * feedback — particle burst size, stage-light beams, parallax stars, rail/edge glow — and softens
   * (never removes) the hit flash and miss tint. At 0 a hit still gets a shockwave ring, a lane
   * flash and a popup, and a miss still gets a grey fizzle and a red tint: feedback is never
   * silent, it just stops being a fireworks display. Runtime-adjustable via `setOptions()`.
   */
  effectIntensity: number;
  /**
   * Reduced motion (vestibular / clinical safety, default false). Freezes the parallax star layers
   * and the sweeping stage lights, stops the combo bounce/shake and the beat-driven size pulsing,
   * and keeps judgment popups from flying up the screen. Notes still scroll (that is the game) and
   * all judgment feedback still fires. Runtime-adjustable via `setOptions()`.
   */
  reducedMotion: boolean;
  /**
   * Factory for offscreen scratch canvases (sprites, cached text). Defaults to OffscreenCanvas
   * when available, else document.createElement('canvas'). Tests inject a stub.
   */
  createCanvas?: (width: number, height: number) => CanvasLike;
}

/** Minimal canvas surface the renderer relies on (HTMLCanvasElement | OffscreenCanvas | test stub). */
export interface CanvasLike {
  width: number;
  height: number;
  getContext(kind: '2d', opts?: unknown): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
}

/**
 * Draw-time statistics, updated after every `draw()`.
 *
 * `drawMs` is JS-side command-issue time only; on a GPU-accelerated canvas the raster/composite
 * cost lands at frame flush and never shows up there. `frameMs` / `longFrames` / `fps` are derived
 * from the wall-clock interval between consecutive `draw()` calls, which does include that cost
 * when draw() is called once per requestAnimationFrame — use those to judge the 60 fps target.
 */
export interface RenderStats {
  /** Draw time (command issue) of the last frame in ms. */
  drawMs: number;
  /** Exponential moving average of draw time in ms. */
  avgDrawMs: number;
  /** Worst draw time seen (ms) since last `resetStats()`. */
  maxDrawMs: number;
  /** Wall-clock interval between the last two draw() calls (ms); 0 for the first frame. */
  frameMs: number;
  /** EMA of `frameMs` (ms). */
  avgFrameMs: number;
  /** Frames per second implied by `avgFrameMs`. */
  fps: number;
  /** Number of frame intervals longer than 25 ms (a dropped frame at 60 Hz) since last `resetStats()`. */
  longFrames: number;
  /** Frames drawn since construction. */
  frames: number;
  /** Notes actually painted last frame (after culling). */
  notesDrawn: number;
  /** Live particles last frame. */
  particles: number;
  /** Sprite cache entries (gems + glows). */
  sprites: number;
}
