/** Emitted when a lane's normalized movement value crosses the hit threshold (rising edge). */
export interface LaneInputEvent {
  lane: number;
  /** AudioContext.currentTime (seconds) at which the crossing was observed. */
  ctxTime: number;
  /** Fraction of calibrated ROM reached (0..1+). */
  strength: number;
  /**
   * Compensation observed on this rep up to the crossing (vision only, e.g. heel lift during ankle
   * dorsiflexion). Absent when none was detected / not monitored.
   */
  compensation?: LaneCompensation;
}
export interface LaneState { lane: number; value: number; armed: boolean; tracking?: boolean; }
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

export type CompensationKindName = 'heel_lift' | 'trunk_lean';
/** Compensation summary attached to a LaneInputEvent / LaneRepEvent: `value` is the worst magnitude seen. */
export interface LaneCompensation { kind: CompensationKindName; value: number; }

/** Compensation detected on a lane (e.g. heel lift during ankle dorsiflexion). */
export interface CompensationEvent { lane: number; ctxTime: number; kind: CompensationKindName; value: number; }

/**
 * Rep-level rehab metrics, emitted by VisionInput.onRep() once a rep is complete (the lane re-armed).
 * `ctxTime` equals the ctxTime of the LaneInputEvent that opened the rep, so the engine can join them.
 */
export interface LaneRepEvent {
  lane: number;
  /** ctxTime of the threshold crossing that started the rep (same as the LaneInputEvent). */
  ctxTime: number;
  /** ctxTime at which the lane re-armed (end of the rep). */
  endCtxTime: number;
  /** Peak normalized value (fraction of calibrated ROM) reached during the rep, 0..1. */
  peak: number;
  /** Worst compensation observed during the whole rep, if any. */
  compensation?: LaneCompensation;
}
