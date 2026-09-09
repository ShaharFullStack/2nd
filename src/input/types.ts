/** Emitted when a lane's normalized movement value crosses the hit threshold (rising edge). */
export interface LaneInputEvent {
  lane: number;
  /** AudioContext.currentTime (seconds) at which the crossing was observed. */
  ctxTime: number;
  /** Fraction of calibrated ROM reached (0..1+). */
  strength: number;
}
export interface LaneState { lane: number; value: number; armed: boolean; tracking: boolean; }
export interface InputSource {
  start(): Promise<void>;
  stop(): void;
  onEvent(cb: (e: LaneInputEvent) => void): () => void;
  getLaneStates(): LaneState[];
}

/* ---------- additions (vision module) ---------- */

/** Minimal clock every InputSource needs; AudioContext satisfies it. */
export interface CtxClock { readonly currentTime: number; }

/** Song-clock view needed by scripted inputs (engine SongClock satisfies it). */
export interface SongTimeSource {
  songTime(nowCtx?: number): number;
  ctxTimeForSongTime(songTime: number): number;
}

export type VisionTrackingReason = 'stopped' | 'starting' | 'ok' | 'no_person' | 'low_visibility' | 'no_hand' | 'hand_missing' | 'error';
export interface VisionStatus {
  /** True when every lane has usable landmarks this frame. */
  tracking: boolean;
  reason: VisionTrackingReason;
  /** Human-readable hint for the patient/therapist. */
  message: string;
  fps: number;
  inferenceMs: number;
  /** Backend in use once started. */
  delegate: 'GPU' | 'CPU' | null;
  /** Lanes whose landmarks were missing this frame. */
  untrackedLanes: number[];
}

/** Compensation detected on a lane (e.g. heel lift during ankle dorsiflexion). */
export interface CompensationEvent { lane: number; ctxTime: number; kind: 'heel_lift' | 'trunk_lean'; value: number; }
