/** Emitted when a lane's normalized movement value crosses the hit threshold (rising edge). */
export interface LaneInputEvent {
  lane: number;
  /** AudioContext.currentTime (seconds) at which the crossing was observed. */
  ctxTime: number;
  /**
   * Fraction of calibrated ROM reached, clamped to 0..1 (use `rawStrength` for the unclamped value).
   * Measured AT THE CROSSING, so it is just above the hit threshold and is NOT the rep's peak ROM — the
   * event is emitted the instant the threshold is crossed, before the rep has finished. The rehab
   * metric "ROM achieved" is LaneRepEvent.peak / rawPeak, which arrive when the rep completes.
   */
  strength: number;
  /**
   * Same fraction WITHOUT the 0..1 clamp: >1 when the patient exceeded their calibrated ROM. Scoring
   * uses `strength`; the rehab metrics keep this so cross-session ROM gain stays visible.
   */
  rawStrength?: number;
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
  /**
   * Live meters, one entry per configured lane.
   *
   * ALIASING CONTRACT: the returned array and its LaneState objects are OWNED BY THE SOURCE and may be
   * the same objects on every call (VisionInput memoizes them per processed frame so a 60 Hz HUD polling
   * a 30 fps camera does not re-render on unchanged data). Treat the result as READ-ONLY: copy before
   * sorting or mutating (`[...src.getLaneStates()]`), or every other consumer sees your edit.
   * VisionInput freezes the objects, so a stray write throws instead of silently corrupting the meters.
   */
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

export type VisionTrackingReason =
  | 'stopped' | 'starting' | 'ok' | 'no_person' | 'low_visibility' | 'no_hand' | 'hand_missing' | 'error'
  /** No frame has been processed for staleFrameSec: camera wedged, tab backgrounded, device taken. */
  | 'stalled'
  /** A video track of the camera stream fired 'ended' (unplugged / permission revoked / stolen). */
  | 'camera_ended'
  /**
   * The detector is swapping backends (GPU inference failed; the CPU task is being built) and returns
   * empty results meanwhile. Distinct from 'no_person' on purpose: telling the patient to move when the
   * cause is a backend swap is a lie, and moving cannot fix it.
   */
  | 'recovering'
  /**
   * At least one lane's calibration is unusable (its range is below the movement's minimum ROM), so that
   * lane is refused rather than allowed to score noise. See VisionStatus.invalidCalibrationLanes.
   */
  | 'uncalibrated'
  /**
   * At least one lane has sat above its re-arm level for so long that it can no longer produce a rising
   * edge — a drifted baseline / stuck limb / bad calibration. Every note in that lane would miss in
   * silence otherwise. See VisionStatus.pinnedLanes.
   */
  | 'lane_pinned';
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
  /** Seconds since the last processed frame (Infinity before the first). Drives the stall watchdog. */
  frameAgeSec?: number;
  /**
   * Lanes refused because their calibration spans less than the movement's minimum ROM. They read 0 and
   * can never trigger — a 1%-of-ROM range would otherwise turn hand tremor into scored hits.
   */
  invalidCalibrationLanes?: number[];
  /**
   * Lanes stuck above their re-arm level for longer than the pinned-lane watchdog allows: the meter sits
   * pinned, no rising edge can occur, and every note in that lane misses until the lane is re-calibrated.
   */
  pinnedLanes?: number[];
  /** True when the detection rate is too low for the engine's timing windows (see MIN_USABLE_DETECT_FPS). */
  lowFps?: boolean;
  /** Non-fatal quality warnings (low fps, throttled inference, refused calibrations, pinned lanes). */
  warnings?: string[];
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
  /** Peak normalized value (fraction of calibrated ROM) reached during the rep, clamped to 0..1. */
  peak: number;
  /**
   * Peak WITHOUT the 0..1 clamp: >1 when the rep exceeded the calibrated ROM. The Results screen's
   * "ROM achieved" and cross-session ROM gain must read this, not `peak`, or improvement past the
   * calibration is invisible.
   */
  rawPeak?: number;
  /**
   * False when no LaneInputEvent was emitted for this rep because the crossing fell inside the minimum
   * re-trigger interval (see MIN_SAME_LANE_NOTE_SPACING_SEC). The rep still happened and still counts
   * toward the rehab metrics — it simply could not score.
   */
  emitted?: boolean;
  /** Worst compensation observed during the whole rep, if any. */
  compensation?: LaneCompensation;
}
