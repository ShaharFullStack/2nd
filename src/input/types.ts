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
  /**
   * Present (true) when frames were dropped immediately before the crossing, so `ctxTime` was measured
   * across the dropout: the rise WAS observed (from below the re-arm level to above the threshold) but
   * its time is uncertain by roughly half of `gapSec` rather than half a frame. Scoring treats such an
   * event exactly like any other — dropping it would lose a rep the patient really performed — but a
   * timing analysis (latency calibration, a critic measuring crossing jitter) should exclude them.
   */
  timingDegraded?: boolean;
  /** Interval the crossing time was measured across (seconds); ~1 frame normally, wider after a dropout. */
  gapSec?: number;
}
export interface LaneState {
  lane: number;
  value: number;
  /**
   * False when the lane cannot fire: it has already triggered and not been given back, OR it has never
   * been confirmed below the re-arm level. A two-way collapse of the three-way fact below.
   */
  armed: boolean;
  /**
   * THE LANE'S OWN TRIGGER STATE, published by every source in this repo.
   *
   * `armed` cannot tell "this rep just fired" ('triggered') from "this lane has never been confirmed"
   * ('unconfirmed'), and that is exactly the difference between a rep and an occlusion recovery: both
   * publish `{ value >= threshold, armed: false }`, only one of them emitted a `LaneInputEvent`. A live
   * meter therefore had to RECONSTRUCT the crossing from timing (see src/render/receptor.ts), and the
   * reconstruction is defeated by the aliasing contract above — a source that returns the same frozen
   * objects for a whole second of rest looks, from the outside, exactly like a stream that went silent.
   * That cost the knowledge-of-results cue on every keyboard/replay/autoplay rep following more than
   * `DEFAULT_MAX_GAP_SEC` of rest, i.e. essentially every rep of a real chart, on a path a patient is
   * put on by `CameraFallback` when the camera fails.
   *
   * So it is published: entering 'triggered' is the crossing and nothing else can produce it
   * (`LaneTrigger.push` only moves to 'triggered' from 'armed', on a rising edge past the threshold),
   * `breakContinuity` and `setThreshold` move a lane to 'unconfirmed' instead, and a meter reading this
   * never has to guess. Optional only so that a hand-built `LaneState` in a test still type-checks.
   */
  triggerState?: TriggerLaneState;
  tracking?: boolean;
}
/** `LaneTrigger.state` (src/vision/trigger.ts), re-exported through the input contract. */
export type TriggerLaneState = 'unconfirmed' | 'armed' | 'triggered';
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
  | 'lane_pinned'
  /**
   * The mirror image of 'lane_pinned', and the more common one clinically: at least one lane is being
   * ATTEMPTED and can no longer REACH its hit threshold — the patient fatigued over a three-minute song,
   * or the ROM was calibrated when they were fresh and the difficulty puts the threshold at 0.8 of it.
   * The lane tracks perfectly, reports a healthy meter, and misses every remaining note. Lower the
   * difficulty or re-calibrate. See VisionStatus.unreachableLanes.
   */
  | 'lane_unreachable';
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
  /**
   * Lanes the patient is visibly still working — the meter moves — but which have not reached the hit
   * threshold for longer than the watchdog allows, so every note in them is missing under a green OK.
   * A lane that is simply idle (no movement at all) is NOT listed: this reports failure to reach, not
   * failure to try.
   */
  unreachableLanes?: number[];
  /**
   * Lanes whose movement MONITORS a compensation (heel lift on ankle_dorsiflexion, trunk lean on
   * seated_march) but which have NO rest baseline to measure it against, so no compensation can be
   * detected for the whole session. Without this the results screen shows "no compensation flags" for a
   * session in which compensation was never measured at all — the difference between "the patient kept
   * their heel down" and "nobody looked".
   */
  unmonitoredCompensationLanes?: number[];
  /**
   * True when frames are arriving but AudioContext.currentTime is not advancing (a suspended context:
   * the autoplay policy before the first user gesture, or a hidden tab). Every event time and every
   * lane watchdog in the vision module runs on that clock, so while this is true crossings cannot be
   * interpolated and the pinned/unreachable watchdogs are frozen.
   */
  clockStalled?: boolean;
  /** True when the detection rate is too low for the engine's timing windows (see MIN_USABLE_DETECT_FPS). */
  lowFps?: boolean;
  /**
   * True when the app itself is duty-cycling inference to protect the main thread (DetectLoop's adaptive
   * budget): frames ARE arriving, they are just not all being looked at. Distinct from `lowFps` and with
   * a different remedy — the machine cannot afford this model at this rate, so the fix is a lighter
   * render load or the GPU delegate, not "close other apps".
   */
  throttled?: boolean;
  /**
   * HAND MODE. Lanes currently driven by the lone hand in frame accepted WITHOUT a usable handedness
   * label (the unilateral escape hatch, see PickHandOptions.acceptLoneHand). The movement is being
   * measured, but which hand performed it is unconfirmed — so the affected limb's rep count and ROM
   * trend may belong to the unaffected hand that drifted into frame.
   */
  unlabelledHandLanes?: number[];
  /**
   * LEG MODE. True when the tracked BODY jumped recently in a way a seated patient cannot (the pose
   * model, which tracks one person and never says which, appears to have latched onto someone else —
   * classically a therapist crossing the frame). Every other signal stays healthy while this happens,
   * which is what makes it worth reporting.
   */
  subjectChanged?: boolean;
  /**
   * Non-fatal quality warnings in plain language (low fps, throttled inference, refused/suspect
   * calibrations, pinned or unreachable lanes, unmonitored compensation, a suspended audio clock, an
   * unidentified hand, a changed subject). Everything this module knows is degraded and nothing else.
   */
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
  /**
   * True when the rep was closed by a break in the camera stream (occlusion, stalled camera, tab
   * backgrounded) instead of by an observed return to rest: `endCtxTime` is the last frame actually
   * seen and `peak`/`rawPeak` are LOWER BOUNDS. Count such reps, but never average their ROM into a
   * cross-session trend as if it were measured.
   */
  truncated?: boolean;
  /**
   * True when frames were dropped during the rep (or just before its crossing) but the stream recovered
   * quickly enough that the rep was kept. The rep is real and counts; `peak`/`rawPeak` are lower bounds
   * (the maximum may have fallen inside the dropout) and `ctxTime` is less precise. Distinct from
   * `truncated`, which means the rep was CUT SHORT by a break long enough to hide a whole movement.
   */
  gapped?: boolean;
  /** Worst compensation observed during the whole rep, if any. */
  compensation?: LaneCompensation;
  /**
   * Present only for movements that monitor a compensation (heel lift / trunk lean). True when it was
   * actually being measured during this rep (a rest baseline was in effect), FALSE when it was not — in
   * which case the absence of `compensation` means "not measured", not "none observed". A rehab metric
   * must never be silently unmeasured: see VisionStatus.unmonitoredCompensationLanes.
   */
  compensationMonitored?: boolean;
}
