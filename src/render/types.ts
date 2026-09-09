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

/** Per-lane live movement meter, mirrors `LaneState` from src/input/types.ts minus the lane index. */
export interface RenderLaneState {
  /** Normalized movement value 0..1 of calibrated ROM. */
  value: number;
  /** True when the lane can fire again (hysteresis re-armed). */
  armed: boolean;
  /** False when the tracker lost the limb / hand. */
  tracking: boolean;
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
  /** Use the rehab-friendly high-contrast palette instead of Guitar Hero colors. */
  highContrast: boolean;
  /** Draw movement labels under each lane. */
  showLabels: boolean;
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

/** Draw-time statistics, updated after every `draw()`. */
export interface RenderStats {
  /** Draw time of the last frame in ms. */
  drawMs: number;
  /** Exponential moving average of draw time in ms. */
  avgDrawMs: number;
  /** Worst draw time seen (ms) since last `resetStats()`. */
  maxDrawMs: number;
  /** Frames drawn since construction. */
  frames: number;
  /** Notes actually painted last frame (after culling). */
  notesDrawn: number;
  /** Live particles last frame. */
  particles: number;
  /** Sprite cache entries (gems + glows). */
  sprites: number;
}
