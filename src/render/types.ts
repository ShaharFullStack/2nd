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
  /** Set once the note is judged (hit or miss). */
  judgment?: Judgment;
}

/**
 * Per-lane live movement meter. Structurally compatible with `LaneState` from src/input/types.ts,
 * so `inputSource.getLaneStates()` can be passed straight through (the extra `lane` field is ignored).
 */
export interface RenderLaneState {
  /** Normalized movement value 0..1 of calibrated ROM. */
  value: number;
  /** True when the lane can fire again (hysteresis re-armed). */
  armed: boolean;
  /** False when the tracker lost the limb / hand. Defaults to true when absent. */
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
  /** Lane definitions (2..4). Index in this array == lane index. */
  lanes: LaneSpec[];
  /** Live movement meters, one per lane (same order as `lanes`). */
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
  /** Fraction of ROM that counts as a hit (Difficulty.thresholdFraction). Default 0.5. Receptors glow as value approaches it. */
  thresholdFraction?: number;
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
   * (note time + goodMs + grace, up to ~280 ms) still lands on a visible gem. Default 0.45 ≈ ≥500 ms at 720p/1080p, ≥480 ms portrait.
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
  /** Particle pool capacity. */
  maxParticles: number;
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
