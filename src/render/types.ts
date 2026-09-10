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
   * MARKS: the dead grey miss ring shrunk 12 %, a grey liquid column capped short of the target
   * height (it can never reach the height that means "at the trigger point", however hard the
   * patient pushes), and — uniquely to this state — a violet drain cap riding the top of that
   * column, a dashed re-arm line at the level to come back down to, a "lower to reset" chevron that
   * settles onto that line, and an arc outside the ring that grows as the value drains and
   * completes exactly when the lane re-arms. Just as important is what is *removed*: no level line,
   * no target line or ticks, no hot fill, no halo, no additive rim or corona. A lane with
   * `armed === false` must never wear any part of the "will fire" costume: the input layer will
   * emit nothing for it however hard the patient pushes.
   */
  armed: boolean;
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
  /** Live movement meters, one per lane — matched by `RenderLaneState.lane` when present. */
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
   * ticks on the ring's outline at the same height, where the liquid can never cover it), at 76 %
   * of the well's height with overshoot headroom above it. So the meter answers "how much further"
   * during the rise, and a lane that would really fire is the only one that paints liquid at or
   * above the target-line height: a locked-out lane's column is capped ~10 % of the target height
   * short of that line, so the band around it stays empty in every state that cannot score.
   *
   * A level at or above the target line is necessary but NOT sufficient for the "this will fire"
   * look: that one (hot fill, split white-hot cap, inner rim, corona, halo) is drawn only when the
   * lane would really trigger — at/over threshold *and* `armed` *and* `tracking` (see
   * `RenderLaneState`). That conjunction is the renderer's core biofeedback claim. A locked-out
   * lane loses the target line and ticks altogether: its target is the re-arm line below, not the
   * threshold above.
   *
   * KNOWN LIMIT, stated because the rest of this doc is a promise: the renderer can only be as
   * truthful as `LaneState` is. `src/vision/trigger.ts` also swallows a crossing that lands within
   * `minIntervalSec` (0.3 s) of the previous one, and that refractory window is not exposed in
   * `LaneState`, so a rise that re-arms and re-crosses inside 300 ms can wear the "will fire" look
   * for the frame before it is dropped. Closing it needs the input layer to fold the min-interval
   * into `armed` (or to publish it per lane); the renderer must not guess at it.
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
