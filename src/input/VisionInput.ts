/**
 * VisionInput: camera -> MediaPipe -> per-lane LanePipeline (feature -> unit-free filter -> ROM
 * normalize) -> LaneTrigger -> LaneInputEvent (+ LaneRepEvent with the rep's peak / compensation).
 *
 * The detector and camera are injectable (fake detector in tests / critics). Without a driven loop
 * (`driveLoop: false`) callers feed frames via `processDetection(result, ctxTime)`.
 *
 * SIGNAL PATH: every lane owns a `LanePipeline` (src/vision/pipeline.ts), the very object a calibration
 * screen can feed to `RomCalibrator.pushSample` via `onFrame()`, so calibration and play see the same
 * filtered signal (pass `calibrations[i] = null` while calibrating a lane; it produces no triggers).
 * The filter is linear and unit-free (EMA alpha 0.5, or the delay-matched two-stage EMA on the fine-motor
 * lanes => ~1 frame of lag at 30 fps either way) so every lane has the same delay; `filterDelaySec()`
 * reports it for the engine's latency offset.
 *
 * HONESTY RULES this class enforces (a rehab game must never award a rep that was not performed):
 *  - hits are RISING EDGES only (see LaneTrigger): a lane found already above threshold, a lane whose
 *    calibration was replaced mid-rep, and a lane recovering from an occlusion all score nothing until
 *    the movement is observed rising from below the re-arm level;
 *  - a stalled frame stream (wedged camera, backgrounded tab, revoked permission, ended track) surfaces
 *    as 'stalled' / 'camera_ended' with meters at 0 — never a frozen meter under a green "tracking OK";
 *  - a lane whose calibration spans less than the movement's minimum ROM is REFUSED, not played: it
 *    reads 0, can never trigger, and says so in the status ('uncalibrated');
 *  - a lane pinned above its re-arm level for `pinnedLaneSec` surfaces as 'lane_pinned' instead of
 *    quietly missing every remaining note under a green OK, and a lane that is being ATTEMPTED but can
 *    no longer reach its threshold (fatigue, a ROM calibrated fresh, a difficulty set too high) surfaces
 *    as 'lane_unreachable' — the same failure from the other side, and the more common one clinically;
 *  - every completed rep is reported through onRep(), including reps whose crossing was swallowed by the
 *    minimum re-trigger interval (`emitted:false`), and with an UNCLAMPED `rawPeak` so ROM beyond the
 *    calibrated range stays measurable;
 *  - a lane must MEASURE WHAT IT SAYS IT MEASURES: a reused pipeline (the calibration screen's) whose
 *    mirror convention or opposed fingertip differs from this session's is REFUSED at construction, and
 *    a stored calibration measured for another movement, on another fingertip or under the
 *    other mirror convention is refused per lane — a lane silently reading the other limb, or
 *    normalizing one quantity by another's range, keeps a green status and a flat meter and is the
 *    worst failure this class can have. EVERY path that admits a calibration (the constructor and the
 *    RUNTIME hand-over `setCalibration`, what a calibration screen calls per lane) vets it against ONE
 *    context derived from the lane's own featureOptions (`laneCalibrationContext`), because the two
 *    paths building their own context literals is precisely how they came to disagree;
 *  - a lane driven by a hand the detector could not identify (the unilateral lone-hand escape hatch) is
 *    named in `unlabelledHandLanes`: the movement is measured, but WHOSE hand made it is unconfirmed,
 *    and the unaffected hand inflating the affected limb's rep count is a therapist-facing lie;
 *  - the pose model tracks ONE body and never says whose, so a discontinuity in the tracked body's own
 *    geometry (a therapist crossing the frame) is reported as `subjectChanged` — the only silent death
 *    in which every other watchdog stays green;
 *  - the app duty-cycling its own inference to protect the main thread is reported as `throttled`,
 *    separately from `lowFps`: the same symptom, a different cause and a different remedy;
 *  - a compensation nobody is measuring is never reported as "none observed": a lane whose movement
 *    monitors one but has no rest baseline is named in the status and every one of its reps carries
 *    `compensationMonitored: false`;
 *  - a hit threshold that would kill every lane (0 / NaN / >1) is refused at construction rather than
 *    diagnosed as a mystery 'lane_pinned' 8 s into the song, and a frozen AudioContext clock (a
 *    suspended context: every time in this class runs on it) is reported as `clockStalled`.
 */
import type { LaneSpec, Mode, Side } from '../engine/types.ts';
import type { CompensationEvent, CtxClock, InputSource, LaneCompensation, LaneInputEvent, LaneRepEvent, LaneState, VisionStatus, VisionTrackingReason } from './types.ts';
import type { LaneConflict, MovementPosture } from '../vision/features.ts';
import { POSTURE_INFO, laneConflicts, requiredPostures } from '../vision/features.ts';
import type { RomCalibration } from '../vision/calibration.ts';
import { RomCalibrator, calibrationContext, calibrationProblem, calibrationWarnings, isCalibrationValid } from '../vision/calibration.ts';
import type { CalibrationContext, CalibratorOptions } from '../vision/calibration.ts';
import { DEFAULT_FINGERTIP, MOVEMENT_INFO, compensationKind } from '../vision/features.ts';
import type { CompensationBaseline, CompensationKind, FeatureOptions } from '../vision/features.ts';
import type { Fingertip } from '../vision/landmarks.ts';
import type { LaneFilterSpec } from '../vision/filters.ts';
import { resolveLaneFilter } from '../vision/filters.ts';
import { LanePipeline } from '../vision/pipeline.ts';
import type { LaneSample } from '../vision/pipeline.ts';
import { DEFAULT_MIN_INTERVAL_SEC, LaneTrigger } from '../vision/trigger.ts';
import { DetectLoop, MIN_USABLE_DETECT_FPS, createDetector, openCamera, pickHandResult } from '../vision/mediapipe.ts';
import type { CameraOptions, CameraSession, DetectLoopOptions, DetectorOptions, DetectionResult, LandmarkDetector, LoopStats } from '../vision/mediapipe.ts';
import { POSE, allVisible, aspectScale, distance2d, midpoint } from '../vision/landmarks.ts';
import type { Landmark } from '../vision/landmarks.ts';

/**
 * Tuning for the same-person guard. The pose model tracks ONE person (`numPoses: 1`) and does not tell
 * us WHICH: when a therapist steps into or crosses the frame, the model can latch onto their body and
 * every lane silently starts measuring a different person — with a perfectly green 'ok' status, because
 * the pose is visible, the values are plausible and the lanes are being attempted. None of the other
 * watchdogs (untracked / pinned / unreachable) can see it. So we watch the tracked body's own geometry
 * for a discontinuity no seated patient can produce in one frame.
 */
export interface SubjectGuardOptions {
  /**
   * Fractional change in TORSO LENGTH between consecutive frames that counts as a different body
   * (default 0.25). Torso length is near-constant for a seated patient — it changes only with trunk
   * flexion, and never by a quarter in 33 ms — while a person at a different distance from the camera
   * has a visibly different one.
   */
  torsoFraction?: number;
  /**
   * Hip-midpoint jump between consecutive frames, as a fraction of torso length, that counts as a
   * different body (default 0.5). Half a torso length in one frame is a teleport for a seated patient.
   */
  moveFraction?: number;
  /** How long the warning stays up after the last discontinuity (default 5 s of frames). */
  warnSec?: number;
}

export interface VisionInputConfig {
  mode: Mode;
  lanes: LaneSpec[];
  /** One per entry of `lanes` (same order). `null` = not calibrated yet (lane reads 0, never triggers). */
  calibrations: (RomCalibration | null)[];
  /** Normalized value (0..1 of ROM) that counts as a hit. */
  thresholdFraction: number;
  audioContext: CtxClock;
  /**
   * Inject a detector instance or factory. Default: real MediaPipe via createDetector().
   * Ownership: a factory-created (or default) detector is closed on stop(); an injected instance is NOT.
   */
  detector?: LandmarkDetector | (() => Promise<LandmarkDetector>);
  /**
   * Options for the DEFAULT detector (ignored when `detector` is given, since that one is already
   * built). `mode` always comes from this config and cannot be overridden here. This is how a deployment
   * reaches the settings that vary per site — `wasmPath` and the model paths when the app is not served
   * from the domain root, and `minDetectionConfidence`/`minTrackingConfidence` for a dark clinic room —
   * WITHOUT having to re-implement the whole default detector (delegate fallback and all) just to change
   * one number.
   */
  detectorOptions?: Omit<DetectorOptions, 'mode'>;
  /** Inject a camera session or factory. Default: openCamera() 640x480 front camera. Same ownership rule as `detector`. */
  camera?: CameraSession | (() => Promise<CameraSession>);
  /**
   * Options for the DEFAULT camera (ignored when `camera` is given). Merged over
   * `{ width: 640, height: 480, facingMode: 'user' }`, so `deviceId` alone is enough to pick the second
   * webcam on a clinic laptop — the common case, and previously only reachable by replacing the whole
   * camera factory.
   */
  cameraOptions?: CameraOptions;
  /** Run the detect loop on start (default true). false = caller feeds processDetection(). */
  driveLoop?: boolean;
  /**
   * Start even when `laneConflicts` reports an 'error'-severity conflict (default false: start() throws).
   * A blocking conflict means the lanes cannot be told apart — one movement scores another lane's notes
   * while that lane sits pinned — so the default is to refuse. Set true only for a deliberate dev or
   * critic scenario that wants to observe the broken configuration.
   */
  allowConflictingLanes?: boolean;
  /**
   * The frames fed to the detector are already horizontally flipped (default false). NOT the same thing
   * as a CSS-mirrored preview, which does not affect landmarks at all. It selects which hand is assigned
   * to which side (pickHand) AND which Pose landmark slots hold which leg (poseSideIndices) — see the
   * mirror convention block at the top of src/vision/mediapipe.ts. Calibrate and play with the SAME
   * value: a calibration captured under one convention does not normalize the other.
   */
  mirrored?: boolean;
  /**
   * Override smoothing for all lanes (default: MOVEMENT_INFO[movement].smoothing, EMA 0.5).
   * The unit-free linear filters (ema / ema2 / lowpass / none) keep every lane's delay identical and
   * analytically known; 'oneEuro' is available as an opt-in and is made unit-aware per lane by the
   * pipeline — see filters.ts LaneFilterSpec, and note that its delay is then a worst case, not a
   * constant, which is what filterDelaySec() reports.
   */
  smoothing?: LaneFilterSpec;
  /** Per-lane feature options (e.g. fingertip for finger_opposition), same order as lanes. */
  featureOptions?: (Omit<FeatureOptions, 'worldLandmarks'> | undefined)[];
  /** Per-lane rest baselines for compensation checks (override calibration.compensationBaseline), same order as lanes. */
  compensationBaselines?: (CompensationBaseline | null | undefined)[];
  /**
   * Reuse existing pipelines (e.g. the ones the calibration screen fed to RomCalibrator), same order as
   * lanes. Their calibration is replaced by `calibrations[i]` when that is non-null.
   */
  pipelines?: (LanePipeline | undefined)[];
  rearmFraction?: number;
  minIntervalSec?: number;
  /** Pose visibility gate (default MIN_VISIBILITY). */
  minVisibility?: number;
  /**
   * Hand mode: minimum MediaPipe handedness score for a picked hand to be used at all (default 0, off).
   * Raise it to reject hands the detector is unsure about (they surface as 'hand_missing').
   */
  minHandScore?: number;
  /**
   * Hand mode: minimum handedness score at which a LABEL is trusted when assigning hands to sides
   * (default 0.6, see pickHand). Lower it only if the lighting/posture of a session makes MediaPipe
   * chronically unsure; it does not gate whether the hand is used (that is `minHandScore`).
   */
  handLabelScore?: number;
  /**
   * UNILATERAL escape hatch: accept the only hand in frame even when its handedness label is not
   * confident. Default: true exactly when every lane is on the SAME side — there is then no other lane
   * for a mis-assigned hand to steal, so the safety rule that protects bilateral sessions (a lone
   * unlabelled hand goes to neither side) would only lock the patient out of their own session.
   * Handedness confidence is precisely what degrades in the fingers-at-the-camera wrist_extension
   * posture, so a unilateral wrist session needs this. Set false to force labels even then.
   */
  acceptLoneHand?: boolean;
  /**
   * Stall watchdog: with no processed frame for this long (default 0.5 s) the status becomes 'stalled'
   * and the meters read 0 instead of freezing at the last value under a green "tracking OK".
   */
  staleFrameSec?: number;
  /**
   * Pinned-lane watchdog (default 8 s): a lane continuously at or above its re-arm level for this long
   * can no longer produce a rising edge, so every note in it misses in silence. Surfaced as
   * 'lane_pinned'. Longer than any plausible rep (1-2 s) and any plausible hold, short enough to catch
   * the failure inside one song section.
   */
  pinnedLaneSec?: number;
  /**
   * Unreachable-lane watchdog (default 15 s): a lane that is being ATTEMPTED — its meter has risen past
   * `unreachableAttemptFraction` of the threshold — but has not actually reached the threshold for this
   * long is reported as 'lane_unreachable'. The symmetric counterpart of `pinnedLaneSec`: that one
   * catches a lane stuck too HIGH to re-arm, this one a lane that can no longer get high ENOUGH.
   * Generous on purpose (a rep is 1-2 s, and a lane's notes can legitimately be seconds apart).
   */
  unreachableLaneSec?: number;
  /**
   * How much of the hit threshold a lane must reach to count as being attempted (default 0.5) before
   * the unreachable-lane watchdog will report it. Without this floor, a lane whose notes simply have not
   * come round yet — a patient correctly resting — would be reported as broken.
   */
  unreachableAttemptFraction?: number;
  /**
   * Frame aspect ratio (width / height) used to make the features isotropic — see FeatureOptions.xScale.
   * Default: taken from the live CameraSession (its width/height, refreshed from the video element), or
   * 1 when frames are fed in directly (fixtures / tests are square by construction).
   */
  xScale?: number;
  /** Detect-loop rate cap / main-thread budget (see DetectLoopOptions). */
  loopOptions?: DetectLoopOptions;
  /**
   * SAME-PERSON GUARD (leg mode). Pass `false` to disable, or an object to tune it. See
   * `getSubjectChangedSec()` for what it is for and why the alternative is a whole session of
   * confidently-measured numbers belonging to the wrong body.
   */
  subjectGuard?: SubjectGuardOptions | false;
  /** Clock for the watchdog (default performance.now). Injectable so the watchdog is testable. */
  nowMs?: () => number;
}

export interface LaneDebug {
  lane: number;
  movement: LaneSpec['movement'];
  side: Side;
  raw: number | null;
  filtered: number | null;
  value: number;
  /** Unclamped normalized value (>1 past the calibrated ROM). */
  rawValue: number;
  armed: boolean;
  /** The mirror convention the lane's features are extracted under (which LIMB is being read). */
  mirrored: boolean;
  /** 'unconfirmed' lanes cannot fire until they have been seen below the re-arm level. */
  triggerState: 'unconfirmed' | 'armed' | 'triggered';
  tracking: boolean;
  calibration: RomCalibration | null;
  compensation: { kind: 'heel_lift' | 'trunk_lean'; value: number; flagged: boolean } | null;
  /**
   * null when the movement monitors no compensation; false when it monitors one but no baseline is in
   * effect (nothing is being measured); true when it is actually being measured.
   */
  compensationMonitored: boolean | null;
}

/**
 * Per-frame callback: the lanes' pipeline samples (same order as config.lanes) for this detection.
 * The array is freshly allocated per frame and the samples are immutable, so a listener may retain them
 * (a calibration screen collecting a rest window does exactly that).
 */
export type FrameCallback = (samples: readonly LaneSample[], ctxTime: number, result: DetectionResult) => void;

interface LaneRuntime {
  spec: LaneSpec;
  pipeline: LanePipeline;
  trigger: LaneTrigger;
  sample: LaneSample;
  /** Worst flagged compensation observed during the current rep (reset when the lane re-arms). */
  worstComp: LaneCompensation | null;
  compFlagLastEmit: number;
  /** ctxTime the lane last rose to (or above) its re-arm level without coming back down; NaN when below. */
  aboveSince: number;
  /** ctxTime of the last frame that actually OBSERVED the lane above its re-arm level. */
  aboveLastSeen: number;
  /**
   * ctxTime the lane last REACHED its hit threshold — or, before it ever has, the first frame it was
   * tracked on. The unreachable-lane watchdog measures from here.
   */
  reachedAt: number;
  /** Highest normalized value seen since `reachedAt` (evidence that the lane is being attempted). */
  peakSinceReached: number;
  /**
   * ctxTime of the last frame that was actually EVIDENCE OF AN ATTEMPT — the value at or above
   * `unreachableAttemptFraction` of the hit threshold. NaN when there has been none since `reachedAt`.
   * The unreachable watchdog needs recent evidence, not ever-evidence: see laneUnreachable.
   */
  attemptAt: number;
  /** ctxTime of the last frame the lane was actually tracked on (the watchdog's continuity check). */
  lastTrackedAt: number;
  /** Why the lane's calibration was refused (null when it is usable / absent). */
  calibrationProblem: string | null;
  /** Non-fatal concerns about an accepted calibration (unsteady zero, hand-set range, stale capture). */
  calibrationWarnings: string[];
}

/** A lane whose calibration was refused: it reads 0 and can never score. */
export interface InvalidCalibration {
  lane: number;
  movement: LaneSpec['movement'];
  side: Side;
  /** Therapist-facing reason, e.g. "the calibrated range is only 1%, below the 12% minimum for …". */
  reason: string;
}

/**
 * A lane whose movement monitors a compensation that is NOT being measured this session (no rest
 * baseline). Its reps carry `compensationMonitored: false`: absence of a flag means "not measured".
 */
export interface UnmonitoredCompensation {
  lane: number;
  movement: LaneSpec['movement'];
  side: Side;
  /** The compensation that would have been monitored (heel lift / trunk lean). */
  kind: CompensationKind;
}

/** Landmarks the same-person guard measures the tracked body's geometry from (hips + shoulders). */
const SUBJECT_IDX = [POSE.LEFT_HIP, POSE.RIGHT_HIP, POSE.LEFT_SHOULDER, POSE.RIGHT_SHOULDER] as const;

/** Live per-lane liveness for the pinned-lane watchdog / a therapist HUD. */
export interface LaneActivity {
  lane: number;
  /** Seconds the lane has been continuously at or above its re-arm level (0 when below it). */
  aboveRearmSec: number;
  /** True once that exceeds `pinnedLaneSec`: the lane can no longer produce a rising edge. */
  pinned: boolean;
  /** Seconds since the lane last REACHED its hit threshold (or since it was first tracked). */
  sinceThresholdSec: number;
  /** Highest normalized value seen in that window: how close the attempts are coming. */
  peakSinceThreshold: number;
  /** Seconds since the lane last showed EVIDENCE OF AN ATTEMPT (Infinity when it has shown none). */
  sinceAttemptSec: number;
  /** True when the lane is being attempted but has not reached the threshold for `unreachableLaneSec`. */
  unreachable: boolean;
  /** ctxTime of the last completed rep (NaN when there has been none). */
  lastRepAt: number;
  triggerState: 'unconfirmed' | 'armed' | 'triggered';
}

/**
 * The setup hint shown with every hand-mode tracking problem. It is derived from the lanes' POSTURE, not
 * hardcoded: telling a wrist_extension patient to turn their palm to the camera would instruct them out
 * of the only posture in which their movement can be measured (see MovementPosture in features.ts).
 * A prescription mixing postures is a lane conflict; the hint then falls back to the majority posture.
 */
function handSetupHint(lanes: readonly LaneSpec[]): string {
  const postures = requiredPostures(lanes).filter((p) => p !== 'seated_leg');
  if (postures.length === 1) return POSTURE_INFO[postures[0]].setup;
  return POSTURE_INFO.palm_to_camera.setup;
}

/** Human-readable status message derived from the reason AND the configured lanes. */
export function visionStatusMessage(reason: VisionTrackingReason, mode: Mode, lanes: readonly LaneSpec[]): string {
  const HAND_MOVEMENT_HINT = handSetupHint(lanes);
  switch (reason) {
    case 'stopped':
      return 'Camera is off.';
    case 'starting':
      return 'Starting camera…';
    case 'ok':
      return '';
    case 'error':
      return 'Camera or detector error.';
    case 'stalled':
      return 'The camera stopped sending frames. Check that no other app is using it and that this tab is in the foreground.';
    case 'camera_ended':
      return 'The camera was disconnected or switched off. Reconnect it and restart the camera.';
    case 'recovering':
      // NOT "no person detected": the landmarks are empty because the detector is rebuilding itself on
      // the CPU, and telling the patient to move would be a lie they cannot act on.
      return 'Switching to the compatible camera engine — one moment. Stay where you are.';
    case 'uncalibrated':
      return 'A lane has no usable calibration and cannot score. Re-run the range calibration for it.';
    case 'lane_pinned':
      return 'A lane is stuck above the hit threshold and cannot score until the movement returns to rest. Return to the resting position, or re-calibrate.';
    case 'lane_unreachable':
      return 'A lane is being moved but no longer reaches the hit threshold, so it cannot score. Take a rest, lower the difficulty, or re-calibrate the range.';
    case 'no_person':
      return 'No person detected. Sit facing the camera so your body is in view.';
    case 'no_hand':
      return `No hand detected. ${HAND_MOVEMENT_HINT}`;
    case 'low_visibility': {
      if (mode === 'hand') return `Part of your hand is hidden. ${HAND_MOVEMENT_HINT}`;
      const needsFeet = lanes.some((l) => MOVEMENT_INFO[l.movement].requiredVisible === 'feet');
      return needsFeet
        ? 'Some joints are hidden. Move back so your hips, knees and feet are in view.'
        : 'Some joints are hidden. Move back so your hips and knees are in view.';
    }
    case 'hand_missing': {
      const sides = new Set(lanes.map((l) => l.side));
      if (sides.size === 1) {
        const side = lanes[0]?.side ?? 'left';
        return `Your ${side} hand is not in view. ${HAND_MOVEMENT_HINT}`;
      }
      return `One hand is not in view. Keep both hands visible. ${HAND_MOVEMENT_HINT}`;
    }
  }
}

export class VisionInput implements InputSource {
  readonly config: VisionInputConfig;
  private lanes: LaneRuntime[];
  private listeners = new Set<(e: LaneInputEvent) => void>();
  private repListeners = new Set<(e: LaneRepEvent) => void>();
  private compListeners = new Set<(e: CompensationEvent) => void>();
  private frameListeners = new Set<FrameCallback>();
  private detector: LandmarkDetector | null = null;
  private camera: CameraSession | null = null;
  private loop: DetectLoop | null = null;
  private running = false;
  private ownsDetector = false;
  private ownsCamera = false;
  /**
   * Monotonic generation of the lifecycle. Bumped on every start() AND every stop(), and captured by
   * start() at entry: any in-flight start whose generation no longer matches has been superseded and
   * must release whatever it created instead of installing it. See start() for why this is not optional.
   */
  private startSeq = 0;
  /** The in-flight start of the CURRENT generation, so concurrent start()s share one detector/camera. */
  private startPromise: Promise<void> | null = null;
  private latest: DetectionResult | null = null;
  private latestCtxTime = 0;
  private reason: VisionTrackingReason = 'stopped';
  private untracked: number[] = [];
  private lastError: unknown = null;
  private lastFrameMs = Number.NEGATIVE_INFINITY;
  private cameraEnded = false;
  /**
   * CTX-CLOCK WATCHDOG. Every event time, every watchdog clock and every interpolated crossing in this
   * class runs on AudioContext.currentTime, while the stall watchdog runs on wall time. A SUSPENDED
   * AudioContext (the autoplay policy before the patient's first gesture, or a hidden tab) freezes ctx
   * time while frames keep arriving: successive frames then carry the SAME ctxTime, so LaneTrigger sees
   * a zero-length interval (dropped, so no cadence is ever learned), no crossing can be interpolated
   * (`tSec > refTime` is false), and the pinned/unreachable clocks stop counting. Nothing is scored
   * wrongly — no music is playing either — but a frozen clock under a green "tracking OK" is exactly
   * the kind of silent degradation this class exists to name, so it is measured and reported.
   */
  private lastSeenCtxTime = NaN;
  /** Wall-clock ms at which ctxTime last actually advanced. */
  private lastCtxAdvanceMs = Number.NEGATIVE_INFINITY;
  private ctxClockStalled = false;
  /**
   * The break-in-the-stream window this input runs its `LaneTrigger`s on. PUBLIC because the
   * renderer has to expire its own crossing evidence on exactly this clock — the disarm an
   * occlusion causes is published as byte-for-byte the same `LaneState` a real threshold crossing
   * is (see `RenderFrame.maxGapSec`), so a session that tunes `staleFrameSec` and leaves the
   * receptor on its default would desynchronise the two silently.
   */
  readonly staleFrameSec: number;

  /**
   * The refractory window every lane trigger was built with: the minimum interval between two
   * EMITTED `LaneInputEvent`s (`LaneTrigger.minIntervalSec`). Public for the same reason
   * `staleFrameSec` is — a crossing swallowed by it enters 'triggered' and is published as
   * `{ armed: false }` exactly like one that fired, so a live meter that does not know the number
   * acknowledges a rep the score never got. See `RenderFrame.minIntervalSec`.
   */
  readonly minIntervalSec: number;
  private readonly pinnedLaneSec: number;
  private readonly unreachableLaneSec: number;
  private readonly unreachableAttemptFraction: number;
  private lastRepAt: number[] = [];
  /** Monotonic counter of processed frames; invalidates the getLaneStates() memo. */
  private frameSeq = 0;
  private laneStates: LaneState[] | null = null;
  private laneStatesFrame = -1;
  private laneStatesDead = false;
  /** Lanes whose landmarks came from a hand nobody could identify this frame (see pickHandResult). */
  private unlabelledHand: number[] = [];
  /** Last frame's tracked-body geometry, for the same-person guard. */
  private subjectSig: { cx: number; cy: number; torso: number } | null = null;
  /** ctxTime of the last tracked-body discontinuity (NaN: none seen). */
  private subjectJumpAt = NaN;
  /** Bumped by anything that changes the status other than a frame (calibration / threshold edits). */
  private statusSeq = 0;
  private status: VisionStatus | null = null;
  private statusKey = '';

  constructor(config: VisionInputConfig) {
    this.config = config;
    this.staleFrameSec = config.staleFrameSec ?? 0.5;
    this.minIntervalSec = config.minIntervalSec ?? DEFAULT_MIN_INTERVAL_SEC;
    this.pinnedLaneSec = config.pinnedLaneSec ?? 8;
    this.unreachableLaneSec = config.unreachableLaneSec ?? 15;
    this.unreachableAttemptFraction = config.unreachableAttemptFraction ?? 0.5;
    if (config.calibrations.length < config.lanes.length) {
      throw new Error(`VisionInput: ${config.lanes.length} lanes but ${config.calibrations.length} calibrations`);
    }
    // THE HIT THRESHOLD IS THE ONE NUMBER THAT CAN KILL EVERY LANE AT ONCE, and it arrives from stored
    // data: chart JSON validation accepts thresholdFraction 0 (src/charts/generate.ts) and a
    // hand-edited localStorage difficulty can hold anything at all. At 0 the re-arm level is 0, so no
    // lane ever falls below it, no lane ever leaves 'unconfirmed', and the entire session scores
    // nothing while the status reports a cheerful 'lane_pinned' 8 s in (every lane is trivially "above"
    // 0 from its first frame). NaN is worse — every comparison is false, so the lanes are just as dead
    // and NO watchdog fires. Refuse the configuration here, where the message can name the field.
    const t = config.thresholdFraction;
    if (!Number.isFinite(t) || t <= 0 || t > 1) {
      throw new Error(`VisionInput: thresholdFraction ${t} must be a number in (0, 1] — at 0 or NaN no lane can ever re-arm or score, and above 1 no lane can ever reach the threshold`);
    }
    // The re-arm level is thresholdFraction * rearmFraction: at 1 the lane must fall below the threshold
    // it just crossed to re-arm (chattering on one held movement), at 0 it must return to an exact zero
    // that landmark noise never reaches (one rep per session).
    const rf = config.rearmFraction;
    if (rf !== undefined && (!Number.isFinite(rf) || rf <= 0 || rf >= 1)) {
      throw new Error(`VisionInput: rearmFraction ${rf} must be a number in (0, 1) — the lane re-arms below thresholdFraction * rearmFraction`);
    }
    const mi = config.minIntervalSec;
    if (mi !== undefined && (!Number.isFinite(mi) || mi < 0)) {
      throw new Error(`VisionInput: minIntervalSec ${mi} must be a non-negative number`);
    }
    // LaneSpec.index is an IDENTITY, not a position: it is the number that travels on every
    // LaneInputEvent, LaneRepEvent, LaneState and LaneActivity, the number the chart's notes carry, and
    // the key a HUD renders meters under. Two lanes sharing one, or a negative / fractional one, is not
    // a degraded configuration — it is an ambiguous one. `findLane` would silently return whichever came
    // first (so setCalibration / getPipeline / getLaneLandmarks address one lane and ignore the other),
    // getLaneStates would emit two entries under the same `lane`, and the engine's own duplicate-lane
    // guard (src/engine/rhythm.ts) can only protect the scoring path, not the display. `laneConflicts`
    // does not cover it either: it only reports a duplicate when the movement AND side also match.
    const seenIndex = new Set<number>();
    for (const l of config.lanes) {
      if (MOVEMENT_INFO[l.movement].mode !== config.mode) {
        throw new Error(`VisionInput: movement ${l.movement} is not a ${config.mode} movement`);
      }
      if (!Number.isInteger(l.index) || l.index < 0) {
        throw new Error(`VisionInput: lane index ${l.index} (${l.movement}/${l.side}) must be a non-negative integer`);
      }
      if (seenIndex.has(l.index)) {
        throw new Error(`VisionInput: duplicate lane index ${l.index} — every lane needs its own index (events, meters and chart notes are keyed by it)`);
      }
      seenIndex.add(l.index);
    }
    this.lanes = config.lanes.map((spec, i) => this.makeLane(spec, i));
    this.lastRepAt = this.lanes.map(() => NaN);
  }

  /**
   * Vet a calibration before it can ever produce a score.
   *
   * A range narrower than the movement's minimum ROM is not a degraded calibration, it is a hit
   * generator: with a range of 0.001 on seated_march (minRom 0.12) a 1%-of-ROM tremor crosses the
   * threshold several times a second, and the patient is credited with reps they never performed.
   * Such ranges are reachable in practice, not hypothetically — `setManualRange` accepts anything,
   * `reconcile` only keeps max above min by 1e-6, `getProvisional` returns the range of an ERRORED
   * calibration, and a stale calibration can arrive from localStorage a month later. This class refuses
   * them: the lane is treated as UNCALIBRATED (reads 0, never triggers) and says so out loud in the
   * console and in getStatus(). Refusing is safe in a way that scoring is not — an unearned hit is worse
   * than a miss, and a lane that is visibly dead sends the therapist to re-calibrate.
   */
  private vetCalibration(spec: LaneSpec, cal: RomCalibration | null, ctx?: CalibrationContext): { cal: RomCalibration | null; problem: string | null; warnings: string[] } {
    if (!cal) return { cal: null, problem: null, warnings: [] };
    if (isCalibrationValid(cal, spec.movement, ctx)) {
      // ACCEPTED, but not necessarily above suspicion: an unsteady zero, a range typed in by hand, or a
      // months-old capture from localStorage are all usable and all worth saying out loud.
      const warnings = calibrationWarnings(cal, spec.movement, Date.now(), ctx).map((w) => `Lane ${spec.index + 1} (${MOVEMENT_INFO[spec.movement].label}): ${w}`);
      return { cal, problem: null, warnings };
    }
    const problem = calibrationProblem(cal, spec.movement, ctx) ?? 'the calibrated range is unusable';
    console.error(`[vision] lane ${spec.index + 1} (${MOVEMENT_INFO[spec.movement].label}, ${spec.side}) refused: ${problem}. The lane will not score until it is re-calibrated.`);
    return { cal: null, problem, warnings: [] };
  }

  /** The mirror convention this session measures EVERY lane under (see VisionInputConfig.mirrored). */
  isMirrored(): boolean {
    return this.config.mirrored ?? false;
  }

  /**
   * The feature options lane `i` is measured with: the lane's own `featureOptions` entry, with the
   * SESSION-WIDE settings layered on top. `mirrored` is session-wide by nature (it describes the frames,
   * not the lane) and a per-lane entry that contradicts it is refused rather than silently overridden —
   * disagreeing about the mirror convention means disagreeing about WHICH LIMB is measured.
   */
  private laneFeatureOptions(i: number): Omit<FeatureOptions, 'worldLandmarks'> {
    const c = this.config;
    const per = c.featureOptions?.[i];
    const mirrored = this.isMirrored();
    if (per?.mirrored !== undefined && per.mirrored !== mirrored) {
      throw new Error(`VisionInput: featureOptions[${i}].mirrored (${per.mirrored}) contradicts the session's mirrored (${mirrored}) — the mirror convention describes the frames and must be the same for every lane`);
    }
    const opts: Omit<FeatureOptions, 'worldLandmarks'> = { ...(per ?? {}), mirrored };
    const minVisibility = c.minVisibility ?? per?.minVisibility;
    if (minVisibility !== undefined) opts.minVisibility = minVisibility;
    else delete opts.minVisibility;
    const xScale = c.xScale ?? per?.xScale;
    if (xScale !== undefined) opts.xScale = xScale;
    else delete opts.xScale;
    if (c.lanes[i].movement === 'finger_opposition') opts.fingertip = per?.fingertip ?? DEFAULT_FINGERTIP;
    return opts;
  }

  /** The fingertip lane `i` opposes (finger_opposition only; DEFAULT_FINGERTIP elsewhere). */
  private laneFingertip(i: number): Fingertip {
    return this.config.featureOptions?.[i]?.fingertip ?? DEFAULT_FINGERTIP;
  }

  /**
   * What lane `i` measures, for vetting any calibration handed to it: derived from the SAME merged
   * feature options the lane's extractor runs with (`laneFeatureOptions`), never assembled by hand.
   *
   * THE WHOLE POINT IS THAT THERE IS ONE OF THESE. The constructor used to pass `{ fingertip }` and
   * `setCalibration` passed nothing, so for a finger_opposition lane on a therapist-chosen fingertip
   * the two paths disagreed about the same calibration: the range measured on THIS lane's finger was
   * refused at the hand-over (lane dead all session) while a range measured on the default finger was
   * accepted (one quantity normalized by another's range). Any future option that changes WHICH
   * QUANTITY a lane measures joins CalibrationContext and both paths get it at once.
   */
  private laneCalibrationContext(i: number): CalibrationContext {
    return calibrationContext(this.config.lanes[i].movement, this.laneFeatureOptions(i));
  }

  /**
   * The context lane `laneIndex` measures in — what a stored calibration has to match to be usable here.
   * Public so a calibration screen can (a) show it and (b) spread it into the calibrator that measures
   * the range (`new RomCalibrator(movement, { ...ctx })`), which stamps it onto the result. Without that
   * stamp the range is a legacy one: it can only ever be warned about, never checked. See createCalibrator.
   */
  getCalibrationContext(laneIndex: number): CalibrationContext | null {
    const i = this.laneConfigIndex(laneIndex);
    return i < 0 ? null : this.laneCalibrationContext(i);
  }

  /**
   * A RomCalibrator for lane `laneIndex`, pre-stamped with that lane's context (fingertip, mirror
   * convention) so the range it produces records WHAT IT MEASURED and a later session can check it
   * instead of guessing. This is the intended way for a calibration screen to build one; constructing a
   * bare `new RomCalibrator(movement)` produces a range that no boundary check can validate.
   */
  createCalibrator(laneIndex: number, opts: CalibratorOptions = {}): RomCalibrator | null {
    const i = this.laneConfigIndex(laneIndex);
    if (i < 0) return null;
    return new RomCalibrator(this.config.lanes[i].movement, { ...this.laneCalibrationContext(i), ...opts });
  }

  /** Position of lane `laneIndex` in config.lanes (-1 when unknown). `lanes` is a 1:1 map of it. */
  private laneConfigIndex(laneIndex: number): number {
    return this.lanes.findIndex((x) => x.spec.index === laneIndex);
  }

  /**
   * Build one lane's runtime — and, when a pipeline is REUSED (the calibration screen hands its own
   * pipelines over so calibration and play share one signal path), check that it measures THE SAME
   * THING this session is configured for.
   *
   * WHY THIS CHECK EXISTS. A LanePipeline carries the feature options it extracts with. Until round 6
   * this method validated only `movement`/`side` and then called setCalibration()/setXScale(): the
   * session's `mirrored` was applied ONLY when constructing a FRESH pipeline. So a session configured
   * `mirrored: true` that reused a pipeline built without it measured THE OTHER LEG — for a hemiparetic
   * patient, the affected lane reads a flat 0 for the whole song. Nothing caught it: the pose is
   * visible so the lane is not 'untracked'; the value never rises so it is not pinned; and the
   * unreachable watchdog needs evidence of attempts, which a flat 0 never provides. Three silent-death
   * watchdogs and a green 'ok' over a lane measuring the wrong limb.
   *
   * The rule now: options that decide WHICH LIMB or WHICH QUANTITY is measured (`mirrored`, and
   * finger_opposition's `fingertip`) must already MATCH — a mismatch throws exactly like movement/side,
   * because a calibration collected through that pipeline measured the wrong thing too and there is
   * nothing to salvage. Options that are gates or scale corrections (`minVisibility`, `xScale`) are
   * pushed onto the pipeline: the session is the authority for those and re-pointing them is harmless.
   */
  private makeLane(spec: LaneSpec, i: number): LaneRuntime {
    const c = this.config;
    const opts = this.laneFeatureOptions(i);
    const fingertip = this.laneFingertip(i);
    const vetted = this.vetCalibration(spec, c.calibrations[i] ?? null, this.laneCalibrationContext(i));
    const cal = vetted.cal;
    let pipeline = c.pipelines?.[i];
    if (pipeline) {
      if (pipeline.movement !== spec.movement || pipeline.side !== spec.side) {
        throw new Error(`VisionInput: pipeline ${i} is ${pipeline.movement}/${pipeline.side}, lane is ${spec.movement}/${spec.side}`);
      }
      if (pipeline.getMirrored() !== opts.mirrored) {
        throw new Error(
          `VisionInput: pipeline ${i} (${spec.movement}/${spec.side}) extracts with mirrored=${pipeline.getMirrored()}, the session is mirrored=${opts.mirrored} — ` +
            'on flipped frames the patient\'s left limb arrives under the RIGHT_* landmarks, so the two conventions measure OPPOSITE LIMBS. ' +
            'Build the pipeline with featureOptions.mirrored set to the session\'s value (and re-calibrate: a range measured under the other convention describes the other limb).',
        );
      }
      if (spec.movement === 'finger_opposition' && pipeline.getFingertip() !== fingertip) {
        throw new Error(
          `VisionInput: pipeline ${i} opposes the ${pipeline.getFingertip()} finger, the session opposes the ${fingertip} finger — ` +
            'those are different quantities, so one cannot normalize the other. Rebuild the pipeline (and the calibration) for the fingertip in play.',
        );
      }
      // Gates and scale corrections: the session config is the authority and the pipeline follows it.
      pipeline.setMinVisibility(opts.minVisibility);
      pipeline.setMaxGapSec(this.staleFrameSec);
      // The one session-level setting that CANNOT be applied to a live pipeline is its filter (the
      // filter object holds the lane's smoothed state). Sharing the pipeline is precisely how
      // calibration and play come to see one identical signal, so the pipeline's own filter wins — but
      // a config that asked for something else is told, because the lane's delay is not what it ordered.
      if (c.smoothing && JSON.stringify(resolveLaneFilter(c.smoothing, MOVEMENT_INFO[spec.movement].minRom)) !== JSON.stringify(pipeline.smoothing)) {
        console.warn(`[vision] lane ${spec.index + 1}: config.smoothing is ignored for the reused pipeline, which keeps its own ${pipeline.smoothing.kind} filter (calibration and play must share one signal path).`);
      }
      // A refused calibration must also clear whatever the reused pipeline was already carrying,
      // otherwise the invalid range survives inside the shared object and keeps scoring.
      if (cal || vetted.problem) pipeline.setCalibration(cal);
    } else {
      pipeline = new LanePipeline({
        movement: spec.movement,
        side: spec.side,
        smoothing: c.smoothing,
        calibration: cal,
        maxGapSec: this.staleFrameSec,
        featureOptions: opts,
      });
    }
    if (c.xScale !== undefined) pipeline.setXScale(c.xScale);
    const baselineOverride = c.compensationBaselines?.[i];
    if (baselineOverride !== undefined) pipeline.setCompensationBaseline(baselineOverride);
    return {
      spec,
      pipeline,
      trigger: new LaneTrigger({
        thresholdFraction: c.thresholdFraction,
        rearmFraction: c.rearmFraction,
        minIntervalSec: c.minIntervalSec,
        maxGapSec: this.staleFrameSec,
      }),
      sample: pipeline.last,
      worstComp: null,
      compFlagLastEmit: -Infinity,
      aboveSince: NaN,
      aboveLastSeen: NaN,
      reachedAt: NaN,
      peakSinceReached: 0,
      attemptAt: NaN,
      lastTrackedAt: NaN,
      calibrationProblem: vetted.problem,
      calibrationWarnings: vetted.warnings,
    };
  }

  /* ---------- InputSource ---------- */

  /**
   * Open the detector and (unless driveLoop is false) the camera, then run the detect loop.
   *
   * RACE SAFETY — the reason this is not a plain `async start()`. Acquiring a detector and a camera
   * takes two awaits (the second one includes the browser's permission prompt, which a patient can sit
   * in front of for as long as they like). Real UI drives this concurrently:
   *   - React StrictMode's mount -> unmount -> mount IS literally start(); stop(); start(), on the very
   *     first dev render of the camera screen;
   *   - a patient who backs out of the camera check while the permission prompt is up calls stop()
   *     mid-start.
   * A naive implementation loses both races: stop() runs before the fields are assigned, so it releases
   * NOTHING, the pending start then installs a live camera and inference loop into a "stopped" object,
   * and the camera keeps recording a patient who left the screen. Two concurrent start()s likewise
   * create two detectors and two cameras, the first pair overwritten and leaked with its MediaPipe GPU
   * context.
   *
   * The fix is a generation counter, `startSeq`, captured at entry and re-checked after EVERY await:
   * on a mismatch the resources this call created are closed/stopped immediately and it returns without
   * touching any field. stop() bumps the generation, so it invalidates an in-flight start even though
   * there is nothing yet to release. Concurrent start()s of the same generation share one promise, so
   * exactly one detector and one camera are ever created. Post-condition, always: when start() settles,
   * either isRunning() is true and the camera is live, or nothing is running and no device is open.
   */
  start(): Promise<void> {
    if (this.running) return Promise.resolve();
    // A second start() while one is in flight must not open a second camera: share the same promise.
    if (this.startPromise) return this.startPromise;
    const seq = ++this.startSeq;
    const p = this.startInternal(seq).finally(() => {
      if (this.startSeq === seq) this.startPromise = null;
    });
    this.startPromise = p;
    return p;
  }

  private async startInternal(seq: number): Promise<void> {
    // A prescription that CANNOT work (the same movement twice on one limb, or two incompatible postures
    // of one limb) is REFUSED here, not merely logged.
    //
    // Round 4 left this as a console.error and started the session anyway, which made the entire "no
    // unearned hits" guarantee depend on a Setup screen that did not exist yet: with wrist_extension and
    // hand_open_close on the same hand, one lane scores the other lane's movement while the other sits
    // pinned, and nothing downstream can separate them. An input source that cannot honestly attribute a
    // hit must not run. `allowConflictingLanes` exists for a deliberate dev/critic override, and it is
    // opt-in precisely so nobody reaches it by accident.
    const blocking = this.getLaneConflicts().filter((c) => c.severity === 'error');
    if (blocking.length > 0) {
      for (const c of blocking) console.error(`[vision] unusable lane prescription: ${c.message}`);
      if (this.config.allowConflictingLanes !== true) {
        this.reason = 'error';
        this.lastError = new Error(blocking[0].message);
        throw new Error(`VisionInput: refusing to start on an unusable lane prescription — ${blocking[0].message}`);
      }
    }
    this.reason = 'starting';
    this.lastError = null;
    this.cameraEnded = false;
    this.lastFrameMs = this.now();
    // Everything this call creates stays LOCAL until the final commit, so an abandoned start owns —
    // and can therefore release — exactly what it made, and a concurrent stop() cannot half-release it.
    let detector: LandmarkDetector | null = null;
    let ownsDetector = false;
    let camera: CameraSession | null = null;
    let ownsCamera = false;
    let committed = false;
    const abandon = () => {
      if (camera) camera.onEnded = null;
      if (ownsCamera) {
        try {
          camera?.stop();
        } catch {
          /* releasing a half-open camera may throw; the LED going off is what matters */
        }
      }
      if (ownsDetector) {
        try {
          detector?.close();
        } catch {
          /* same for a half-built MediaPipe task */
        }
      }
    };
    /** True when this start has been superseded by a stop() or a newer start(). */
    const superseded = () => this.startSeq !== seq;
    try {
      // THE CAMERA IS OPENED FIRST, AND THE ORDER IS THE POINT. The most common clinic failure by far is
      // a refused (or silently blocked) permission, and it is knowable in well under a second. Building
      // the detector first buried that behind a 6-8 MB model download and compile: measured against the
      // dev server, a permission refusal took 45 s to reach the therapist, who spent all of it looking at
      // a spinner that could not name the problem. getUserMedia first means permission denied / no device
      // / device busy surface immediately, and only a session that HAS a camera pays for the model.
      if (this.config.driveLoop !== false) {
        const cam = this.config.camera;
        if (!cam) {
          camera = await openCamera({ width: 640, height: 480, facingMode: 'user', ...this.config.cameraOptions });
          ownsCamera = true;
        } else if (typeof cam === 'function') {
          camera = await cam();
          ownsCamera = true;
        } else camera = cam;
        if (superseded()) return abandon();
        // A track that ends (unplugged / permission revoked / another app took the device) silently
        // stops the frame callbacks: surface it instead of leaving the last verdict standing.
        camera.onEnded = () => {
          this.cameraEnded = true;
        };
        if (camera.ended) this.cameraEnded = true;
        this.applyXScale(aspectScale(camera.width, camera.height));
      }

      const d = this.config.detector;
      if (!d) {
        // WITHOUT A DRIVEN LOOP THERE IS NOTHING TO DETECT WITH. A default detector here would download
        // and compile a 6-8 MB model and hold a GPU inference context that nothing can ever call: the
        // loop that would drive it is not created, and the caller feeds frames through
        // processDetection() with results it obtained itself (that is the whole point of
        // driveLoop:false, used by the calibration and preview screens). An INJECTED detector is still
        // honoured — a caller who passes one may well want to call it via getDetector().
        if (this.config.driveLoop !== false) {
          detector = await createDetector({ numHands: 2, ...this.config.detectorOptions, mode: this.config.mode });
          ownsDetector = true;
        }
      } else if (typeof d === 'function') {
        detector = await d();
        ownsDetector = true;
      } else detector = d;
      if (superseded()) return abandon();

      if (this.config.driveLoop !== false) {
        // Unreachable: the branches above always produce both when the loop is driven. Narrowing guards,
        // and real ones — a loop with neither would silently process nothing.
        if (!detector) throw new Error('VisionInput: no detector to drive the camera loop with');
        if (!camera) throw new Error('VisionInput: no camera to drive the detect loop with');
        this.loop = new DetectLoop(
          camera.video,
          detector,
          (res, frameTimeMs) => {
            const ctxTime = this.frameTimeToCtx(frameTimeMs);
            this.processDetection(res, ctxTime);
          },
          this.config.loopOptions,
        );
        this.loop.onError = (err) => {
          this.lastError = err;
          this.reason = 'error';
        };
      }
      // Commit: from here the instance owns the resources and stop() releases them.
      this.detector = detector;
      this.ownsDetector = ownsDetector;
      this.camera = camera;
      this.ownsCamera = ownsCamera;
      committed = true;
      this.running = true;
      this.reason = this.config.mode === 'leg' ? 'no_person' : 'no_hand';
      this.loop?.start();
    } catch (err) {
      if (committed) this.stop();
      else {
        abandon();
        this.loop = null;
      }
      if (!superseded()) {
        this.lastError = err;
        this.reason = 'error';
      }
      throw err;
    }
  }

  stop(): void {
    // Invalidate any start still awaiting a detector/camera: it will release what it created instead of
    // installing it (see start()). Without this bump, a stop() during the permission prompt releases
    // nothing — the fields it clears are still empty — and the camera stays on after the screen is gone.
    this.startSeq++;
    this.startPromise = null;
    this.loop?.stop();
    this.loop = null;
    if (this.camera) this.camera.onEnded = null;
    if (this.ownsCamera) this.camera?.stop();
    if (this.ownsDetector) this.detector?.close();
    this.camera = null;
    this.detector = null;
    this.ownsCamera = false;
    this.ownsDetector = false;
    this.running = false;
    this.reason = 'stopped';
    this.laneStates = null;
    this.statusSeq++;
    this.cameraEnded = false;
    this.lastFrameMs = Number.NEGATIVE_INFINITY;
    this.untracked = [];
    this.unlabelledHand = [];
    this.subjectSig = null;
    this.subjectJumpAt = NaN;
    this.lastRepAt = this.lanes.map(() => NaN);
    for (const l of this.lanes) {
      l.pipeline.reset();
      l.trigger.reset();
      l.sample = l.pipeline.last;
      l.worstComp = null;
      l.compFlagLastEmit = -Infinity;
      l.aboveSince = NaN;
      l.aboveLastSeen = NaN;
      // The unreachable watchdog's clocks are ctxTime-based, and an AudioContext that was suspended and
      // resumed across the stop does NOT guarantee that the clock advanced past staleFrameSec — the
      // self-heal in processDetection would then not fire and the new session would start carrying the
      // previous one's `reachedAt`/`peakSinceReached`, i.e. it could accuse a fresh lane of being
      // unreachable using evidence from a session that has ended.
      l.reachedAt = NaN;
      l.peakSinceReached = 0;
      l.attemptAt = NaN;
      l.lastTrackedAt = NaN;
    }
    this.ctxClockStalled = false;
    this.lastCtxAdvanceMs = Number.NEGATIVE_INFINITY;
    this.lastSeenCtxTime = NaN;
  }

  /** True while start() is awaiting a detector/camera (permission prompt included). */
  isStarting(): boolean {
    return this.startPromise !== null;
  }

  onEvent(cb: (e: LaneInputEvent) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /**
   * Live meters. When the frame stream has stalled (or the camera track ended) the lanes report value 0
   * and tracking:false rather than freezing at the last observed value — a meter pinned at 90% under a
   * dead camera is worse than no meter.
   */
  getLaneStates(): LaneState[] {
    const dead = this.running && (this.cameraEnded || this.isStale());
    // MEMOIZED per processed frame (and per liveness flip): a HUD polling at 60 fps on a 30 fps camera
    // asks twice per frame, and returning a fresh array of fresh objects would re-render every time.
    // Identical contents => identical reference => React sees no change, which is the truth.
    // The returned array and its objects are shared and must be treated as read-only (copy to mutate).
    if (this.laneStates && this.laneStatesFrame === this.frameSeq && this.laneStatesDead === dead) return this.laneStates;
    // FROZEN: the objects are shared between every consumer and reused across polls, so a UI that
    // "just tweaks" one would silently corrupt everyone else's meters. A throw names the bug instead.
    this.laneStates = this.lanes.map((l) => Object.freeze({
      lane: l.spec.index,
      value: dead ? 0 : l.sample.value,
      armed: l.trigger.armed,
      // The three-way fact `armed` collapses (see LaneState.triggerState). A live meter has to tell a
      // rep from an occlusion recovery, and both publish `{ value >= threshold, armed: false }`: only
      // `LaneTrigger.push` moving a lane to 'triggered' is a crossing, and it is the same moment this
      // source emits the lane's LaneInputEvent. Published unmodified when the stream is dead too — the
      // trigger's state is still the truth about whether the lane may fire, and `tracking: false`
      // already tells every consumer not to read a value.
      triggerState: l.trigger.state,
      tracking: dead ? false : l.sample.tracking,
    }));
    this.laneStatesFrame = this.frameSeq;
    this.laneStatesDead = dead;
    return this.laneStates;
  }

  /* ---------- extras for UI / calibration / results ---------- */

  /** Rep-level metrics (peak ROM, worst compensation) once a rep completes (lane re-armed). */
  onRep(cb: (e: LaneRepEvent) => void): () => void {
    this.repListeners.add(cb);
    return () => {
      this.repListeners.delete(cb);
    };
  }

  /** Live compensation warnings (rate limited to one per 0.5 s per lane) for on-screen coaching. */
  onCompensation(cb: (e: CompensationEvent) => void): () => void {
    this.compListeners.add(cb);
    return () => {
      this.compListeners.delete(cb);
    };
  }

  /** Every processed frame: the lanes' pipeline samples (feed them to RomCalibrator.pushSample). */
  onFrame(cb: FrameCallback): () => void {
    this.frameListeners.add(cb);
    return () => {
      this.frameListeners.delete(cb);
    };
  }

  isRunning(): boolean {
    return this.running;
  }

  /** Wall clock the stall watchdog runs on (injectable via config.nowMs). */
  private now(): number {
    if (this.config.nowMs) return this.config.nowMs();
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }

  /** Seconds since the last processed frame (Infinity before the first one). */
  frameAgeSec(): number {
    if (!this.running || !Number.isFinite(this.lastFrameMs)) return Infinity;
    return Math.max(0, (this.now() - this.lastFrameMs) / 1000);
  }

  /**
   * True when no frame has been processed for `staleFrameSec`. `reason` is only ever written by
   * processDetection, so without this check a wedged camera, a backgrounded tab (rVFC stops firing), a
   * revoked permission or a device stolen by another app would keep reporting the last frame's verdict
   * forever while the song plays on and every note misses.
   */
  isStale(): boolean {
    return this.running && this.frameAgeSec() > this.staleFrameSec;
  }

  /**
   * Live tracking status. MEMOIZED, like getLaneStates(): a therapist HUD polling at 60 Hz on a 30 fps
   * camera used to allocate two lane arrays, a pinned-lane array, a warnings array and several
   * interpolated strings PER POLL, none of which can change between frames.
   *
   * The cache key is everything that can move the verdict: the processed-frame counter, the
   * calibration/threshold generation, the liveness verdict (so a stall still flips to 'stalled' the
   * instant the watchdog fires, between frames), and `frameAgeSec` rounded to 100 ms — so "no frames for
   * 3.2 s" keeps counting up on a dead camera instead of freezing at the last frame's value, which is
   * the one number a therapist actually reads off a wedged session.
   *
   * ALIASING CONTRACT, same as getLaneStates(): the object and its arrays are shared and frozen. Copy
   * before mutating.
   */
  getStatus(): VisionStatus {
    const age = this.frameAgeSec();
    const key = `${this.frameSeq}|${this.statusSeq}|${this.running ? 1 : 0}|${this.reason}|${this.cameraEnded ? 1 : 0}|${this.detector?.recovering ? 1 : 0}|${this.ctxClockStalled ? 1 : 0}|${Math.round(Math.min(age, 1e6) * 10)}`;
    if (this.status && this.statusKey === key) return this.status;
    this.status = this.buildStatus(age);
    this.statusKey = key;
    return this.status;
  }

  private buildStatus(age: number): VisionStatus {
    const stats = this.getStats();
    const badCal = this.getInvalidCalibrationLanes();
    const pinned = this.getPinnedLanes();
    const unreachable = this.getUnreachableLanes();
    let reason = this.reason;
    if (this.running && reason !== 'error') {
      if (this.cameraEnded) reason = 'camera_ended';
      else if (age > this.staleFrameSec) reason = 'stalled';
      else if (this.detector?.recovering) reason = 'recovering';
      // These two are only reported once the frame stream itself is healthy: a patient who is out of
      // frame needs to hear that first, and a lane cannot be judged pinned on a dead stream.
      else if (reason === 'ok' && badCal.length > 0) reason = 'uncalibrated';
      else if (reason === 'ok' && pinned.length > 0) reason = 'lane_pinned';
      // Reported last of the lane faults: a pinned lane is the more urgent one, and a lane can be both.
      else if (reason === 'ok' && unreachable.length > 0) reason = 'lane_unreachable';
    }
    // A dead stream reports 0 fps AND 0 ms: the last EMA of the inference time describes frames that are
    // no longer arriving, and "0 fps / 18 ms" on a HUD reads as "still working, just slow".
    const dead = reason === 'stalled' || reason === 'camera_ended';
    const fps = dead ? 0 : stats.fps;
    // fps is REPORTED everywhere and JUDGED nowhere unless we do it here: below this rate the engine's
    // timing windows are not achievable and the patient is losing points to their laptop, not their arm.
    const lowFps = this.running && !dead && stats.frames > 15 && fps > 0 && fps < MIN_USABLE_DETECT_FPS;
    const warnings: string[] = [];
    for (const l of this.lanes) {
      if (l.calibrationProblem) warnings.push(`Lane ${l.spec.index + 1} (${MOVEMENT_INFO[l.spec.movement].label}) is not calibrated: ${l.calibrationProblem}.`);
      else for (const w of l.calibrationWarnings) warnings.push(w);
    }
    for (const lane of pinned) {
      warnings.push(`Lane ${lane + 1} has been held above its hit threshold for over ${this.pinnedLaneSec}s and cannot score again until it returns to rest — re-calibrate it.`);
    }
    const activity = unreachable.length > 0 ? this.getLaneActivity() : [];
    for (const lane of unreachable) {
      const a = activity.find((x) => x.lane === lane);
      const best = a ? Math.round(a.peakSinceThreshold * 100) : 0;
      warnings.push(
        `Lane ${lane + 1} has not reached its hit threshold for over ${this.unreachableLaneSec}s (best attempt ${best}% of the ${Math.round(this.config.thresholdFraction * 100)}% needed) — the movement is being made but cannot score. Lower the difficulty or re-calibrate.`,
      );
    }
    // A monitored compensation with no baseline produces no flags at all, which reads on the results
    // screen exactly like a clean session. Say it out loud, per lane, for as long as it is true.
    const unmonitored = this.getUnmonitoredCompensationLanes();
    for (const u of unmonitored) {
      const what = u.kind === 'heel_lift' ? 'Heel lift' : 'Trunk lean';
      warnings.push(
        `Lane ${u.lane + 1} (${MOVEMENT_INFO[u.movement].label}): ${what.toLowerCase()} is NOT being monitored — the calibration carries no resting baseline for it (the ${u.kind === 'heel_lift' ? 'heel' : 'trunk'} was not measured during the rest hold). This session's reps will be reported as "compensation not measured", not as clean. Re-run the rest hold to enable it.`,
      );
    }
    if (this.running && this.ctxClockStalled) {
      warnings.push('The audio clock is not advancing (the AudioContext is suspended — it needs a user gesture, or the tab is hidden), so hit times cannot be measured. Tap the screen or bring the tab to the foreground.');
    }
    if (lowFps) warnings.push(`The camera is only managing ${fps.toFixed(0)} frames per second (${MIN_USABLE_DETECT_FPS} needed for accurate timing). Close other apps or try an easier difficulty.`);
    // THROTTLING IS NOT LOW FPS. lowFps says the frames are not arriving; this says they arrive and the
    // app is deliberately skipping inference on some of them because each one costs more main-thread
    // time than the frame budget allows. Same symptom for the patient (movements sampled less often),
    // completely different remedy — which is why it gets its own sentence instead of hiding inside the
    // fps one. The adaptive budget can duty-cycle down to minDetectHz on the CPU delegate.
    const throttled = this.running && !dead && this.isThrottled();
    if (throttled) {
      warnings.push(
        `This computer needs ${stats.inferenceMs.toFixed(0)} ms to analyse each camera frame${this.detector?.delegate === 'CPU' ? ' (running on the CPU — no graphics acceleration available)' : ''}, so the app is analysing fewer frames than the camera sends in order to keep the note highway smooth. Movements are being sampled less often than they are happening. Lower the difficulty or use a machine with graphics acceleration.`,
      );
    }
    const unlabelled = this.unlabelledHand;
    if (unlabelled.length > 0) {
      // Name the SIDE from the lanes actually affected, not from lanes[0]: a session may be explicitly
      // configured with acceptLoneHand while prescribing both sides, and telling the therapist to check
      // the wrong limb is exactly the kind of confident-but-wrong sentence this list exists to avoid.
      const sides = [...new Set(unlabelled.map((i) => this.config.lanes.find((l) => l.index === i)?.side).filter(Boolean))].join('/');
      warnings.push(
        `Lane${unlabelled.length > 1 ? 's' : ''} ${unlabelled.map((i) => i + 1).join(', ')}: only one hand is in frame and the camera cannot tell which hand it is, so it is being scored as the ${sides} hand. Check that it is the hand being treated, or bring both hands into view.`,
      );
    }
    const subjectChanged = this.running && !dead && this.getSubjectChangedSec() <= (this.config.subjectGuard === false ? -1 : this.config.subjectGuard?.warnSec ?? 5);
    if (subjectChanged) {
      warnings.push(
        'The person being tracked changed position abruptly — the camera may have switched to a different person in the frame (this model follows only one body and cannot tell them apart). Check that only the patient is in view: everything measured while someone else is tracked belongs to them, not the patient.',
      );
    }
    return Object.freeze({
      tracking: this.running && reason === 'ok',
      reason,
      message: this.statusMessage(reason, badCal, pinned, unreachable),
      fps,
      inferenceMs: dead ? 0 : stats.inferenceMs,
      delegate: this.detector?.delegate ?? null,
      untrackedLanes: Object.freeze(this.untracked.slice()) as number[],
      frameAgeSec: age,
      invalidCalibrationLanes: Object.freeze(badCal) as number[],
      pinnedLanes: Object.freeze(pinned) as number[],
      unreachableLanes: Object.freeze(unreachable) as number[],
      unmonitoredCompensationLanes: Object.freeze(unmonitored.map((u) => u.lane)) as number[],
      clockStalled: this.running && this.ctxClockStalled,
      lowFps,
      throttled,
      unlabelledHandLanes: Object.freeze(unlabelled.slice()) as number[],
      subjectChanged,
      warnings: Object.freeze(warnings) as string[],
    }) as VisionStatus;
  }

  private statusMessage(reason: VisionTrackingReason, badCal: number[], pinned: number[], unreachable: number[]): string {
    if (reason === 'uncalibrated') {
      const names = badCal.map((i) => `${i + 1}`).join(', ');
      return `Lane${badCal.length > 1 ? 's' : ''} ${names} ${badCal.length > 1 ? 'have' : 'has'} no usable calibration and cannot score. Re-run the range calibration for ${badCal.length > 1 ? 'those lanes' : 'that lane'}.`;
    }
    if (reason === 'lane_pinned') {
      const names = pinned.map((i) => `${i + 1}`).join(', ');
      return `Lane${pinned.length > 1 ? 's' : ''} ${names} ${pinned.length > 1 ? 'are' : 'is'} stuck above the hit threshold — the movement never returns to rest, so nothing can score. Return to the resting position, or re-calibrate.`;
    }
    if (reason === 'lane_unreachable') {
      const names = unreachable.map((i) => `${i + 1}`).join(', ');
      const plural = unreachable.length > 1;
      return `Lane${plural ? 's' : ''} ${names} ${plural ? 'are' : 'is'} being moved but no longer ${plural ? 'reach' : 'reaches'} the hit threshold, so ${plural ? 'those lanes' : 'that lane'} cannot score. Take a rest, lower the difficulty, or re-calibrate the range.`;
    }
    return visionStatusMessage(reason, this.config.mode, this.config.lanes);
  }

  /**
   * True while frames arrive with a FROZEN AudioContext clock (a suspended context). See the
   * `ctxClockStalled` field: everything this class times runs on that clock.
   */
  isClockStalled(): boolean {
    return this.running && this.ctxClockStalled;
  }

  /**
   * Lanes whose movement monitors a compensation but which have NO baseline to measure it against.
   *
   * THE THIRD KIND OF SILENT DEATH, and the one a therapist reads off the results screen rather than
   * the game. `LanePipeline` only evaluates compensation when a baseline exists, so an
   * ankle_dorsiflexion lane whose calibration carries `compensationBaseline: null` emits ZERO
   * CompensationEvents and reports every rep with no `compensation` field — indistinguishable, on the
   * results screen, from a patient who kept their heel perfectly flat through every rep.
   *
   * A null baseline is not hypothetical: `RomCalibrator.beginMove` takes it from the rest-phase samples,
   * and the heel is by some distance the least reliably visible pose landmark, so a rest hold in which
   * the heel never cleared the visibility gate produces exactly this. So does `setManualRange` called
   * from a phase with no rest samples, and so does any calibration built by hand.
   *
   * Every other provenance hole in this module is reported (unsteady zero, hand-set range, stale
   * capture, refused range); this one is reported here, in `getStatus().warnings`, and per rep as
   * `LaneRepEvent.compensationMonitored: false`.
   */
  getUnmonitoredCompensationLanes(): UnmonitoredCompensation[] {
    const out: UnmonitoredCompensation[] = [];
    for (const l of this.lanes) {
      const kind = compensationKind(l.spec.movement);
      if (kind && !l.pipeline.isCompensationMonitored()) {
        out.push({ lane: l.spec.index, movement: l.spec.movement, side: l.spec.side, kind });
      }
    }
    return out;
  }

  /** Lanes whose calibration was refused (range below the movement's minimum ROM). */
  getInvalidCalibrationLanes(): number[] {
    const out: number[] = [];
    for (const l of this.lanes) if (l.calibrationProblem) out.push(l.spec.index);
    return out;
  }

  /** The refused calibrations with their reasons, for a therapist screen. */
  getInvalidCalibrations(): InvalidCalibration[] {
    const out: InvalidCalibration[] = [];
    for (const l of this.lanes) {
      if (l.calibrationProblem) out.push({ lane: l.spec.index, movement: l.spec.movement, side: l.spec.side, reason: l.calibrationProblem });
    }
    return out;
  }

  /**
   * Lanes pinned above their re-arm level for longer than `pinnedLaneSec`.
   *
   * THE OTHER SILENT DEATH. The stall watchdog catches frames STOPPING; this catches the frame stream
   * staying perfectly healthy while one lane's baseline has drifted (the patient re-seated, the camera
   * moved, the calibration was taken in a different posture) so the value never falls back below the
   * re-arm level. The trigger then sits in 'triggered' forever, no rising edge can occur, and every note
   * in that lane misses for the rest of the song under a green "tracking OK" — precisely the failure
   * this class claims to prevent. It is NOT auto-corrected: silently re-arming a lane would award a hit
   * nobody performed. It is reported, loudly, so the lane gets re-calibrated.
   */
  getPinnedLanes(): number[] {
    if (!this.running || this.isStale() || this.cameraEnded) return [];
    const out: number[] = [];
    for (const l of this.lanes) {
      if (!Number.isNaN(l.aboveSince) && this.latestCtxTime - l.aboveSince >= this.pinnedLaneSec) out.push(l.spec.index);
    }
    return out;
  }

  /**
   * THE OTHER OTHER SILENT DEATH — the symmetric counterpart of `getPinnedLanes`, and the one that
   * actually happens in a clinic.
   *
   * `getPinnedLanes` catches a lane stuck too HIGH to re-arm. This catches a lane that can no longer get
   * high ENOUGH: the patient fatigues over a three-minute song, or their ROM was calibrated when they
   * were fresh and `hard` puts the hit threshold at 0.8 of it. The frame stream is healthy, the meter
   * moves, the status says 'ok' — and every remaining note in that lane misses with nothing on screen to
   * explain it or to act on. A lane is only reported once there is EVIDENCE OF ATTEMPTS
   * (`peakSinceReached` past `unreachableAttemptFraction` of the threshold), so a patient correctly
   * resting between that lane's notes is never accused of anything. Like the pinned watchdog it is
   * reported, never auto-corrected: quietly lowering the threshold would award hits nobody earned.
   */
  getUnreachableLanes(): number[] {
    if (!this.running || this.isStale() || this.cameraEnded) return [];
    const out: number[] = [];
    for (const l of this.lanes) if (this.laneUnreachable(l)) out.push(l.spec.index);
    return out;
  }

  private laneUnreachable(l: LaneRuntime): boolean {
    if (l.calibrationProblem || !l.sample.tracking) return false;
    if (Number.isNaN(l.reachedAt)) return false;
    if (this.latestCtxTime - l.reachedAt < this.unreachableLaneSec) return false;
    if (l.peakSinceReached < l.trigger.thresholdFraction * this.unreachableAttemptFraction) return false;
    // The attempt has to be RECENT: a lane whose last real attempt is older than the whole watchdog
    // window is a lane the patient has stopped working, not a lane that cannot reach its threshold.
    return !Number.isNaN(l.attemptAt) && this.latestCtxTime - l.attemptAt < this.unreachableLaneSec;
  }

  /** Per-lane liveness (how long above the re-arm level, last rep, trigger state). */
  getLaneActivity(): LaneActivity[] {
    return this.lanes.map((l, i) => ({
      lane: l.spec.index,
      aboveRearmSec: Number.isNaN(l.aboveSince) ? 0 : Math.max(0, this.latestCtxTime - l.aboveSince),
      pinned: !Number.isNaN(l.aboveSince) && this.latestCtxTime - l.aboveSince >= this.pinnedLaneSec,
      sinceThresholdSec: Number.isNaN(l.reachedAt) ? 0 : Math.max(0, this.latestCtxTime - l.reachedAt),
      peakSinceThreshold: l.peakSinceReached,
      sinceAttemptSec: Number.isNaN(l.attemptAt) ? Infinity : Math.max(0, this.latestCtxTime - l.attemptAt),
      unreachable: this.laneUnreachable(l),
      lastRepAt: this.lastRepAt[i] ?? NaN,
      triggerState: l.trigger.state,
    }));
  }

  /** Frame aspect correction applied to the features (1 = square / unknown). */
  getXScale(): number {
    return this.lanes[0]?.pipeline.getXScale() ?? 1;
  }

  /** Push an aspect correction to every lane, unless the config pinned one explicitly. */
  private applyXScale(xScale: number): void {
    if (this.config.xScale !== undefined) return;
    for (const l of this.lanes) l.pipeline.setXScale(xScale);
  }

  /**
   * Re-read the camera's true frame size: videoWidth/videoHeight are 0 until metadata arrives and some
   * devices renegotiate mid-stream, and the constraint is only an `ideal` — most laptop sensors are
   * natively 16:9 whatever we ask for. The features must follow the frame that actually arrived.
   */
  private syncCameraAspect(): void {
    const cam = this.camera;
    if (!cam || this.config.xScale !== undefined) return;
    const w = cam.video?.videoWidth;
    const h = cam.video?.videoHeight;
    if (!w || !h || !Number.isFinite(w) || !Number.isFinite(h)) return;
    if (w === cam.width && h === cam.height) return;
    cam.width = w;
    cam.height = h;
    this.applyXScale(aspectScale(w, h));
  }

  /** Physically conflicting lanes in this prescription (advisory; for the Setup screen). */
  getLaneConflicts(): LaneConflict[] {
    return laneConflicts(this.config.lanes);
  }

  /**
   * True when the prescription contains an 'error' conflict: the Setup screen must not let the session
   * start (the lanes cannot be separated, so the patient would score hits they never earned).
   */
  hasBlockingConflict(): boolean {
    return this.getLaneConflicts().some((c) => c.severity === 'error');
  }

  /** The setups (postures) this prescription asks the patient to hold; more than one is a conflict. */
  getRequiredPostures(): { posture: MovementPosture; label: string; setup: string }[] {
    return requiredPostures(this.config.lanes).map((p) => ({ posture: p, ...POSTURE_INFO[p] }));
  }

  getStats(): LoopStats {
    return this.loop?.getStats() ?? { fps: 0, inferenceMs: 0, frames: 0, lastFrameAt: 0, running: false };
  }

  getLastError(): unknown {
    return this.lastError;
  }

  /** Latest raw detection (pose + hands) for an overlay preview. */
  getLatestDetection(): DetectionResult | null {
    return this.latest;
  }

  /** ctx time assigned to the latest detection. */
  getLatestCtxTime(): number {
    return this.latestCtxTime;
  }

  /** Landmarks used for a lane in the latest frame (for a per-lane overlay). */
  getLaneLandmarks(laneIndex: number): Landmark[] | null {
    const l = this.findLane(laneIndex);
    if (!l || !this.latest) return null;
    return this.selectLandmarks(l.spec, this.latest);
  }

  /**
   * The detector in use, or null (not started, or started with driveLoop:false and none injected — see
   * start(): no default detector is built in that configuration because nothing could drive it).
   */
  getDetector(): LandmarkDetector | null {
    return this.detector;
  }

  getVideoElement(): HTMLVideoElement | null {
    return this.camera?.video ?? null;
  }

  /** The lane's signal pipeline (shared with calibration). */
  getPipeline(laneIndex: number): LanePipeline | null {
    return this.findLane(laneIndex)?.pipeline ?? null;
  }

  /** All lane pipelines, same order as config.lanes. */
  getPipelines(): LanePipeline[] {
    return this.lanes.map((l) => l.pipeline);
  }

  /**
   * Filter group delay of the lanes at the current (or given) detection frame rate: with the default
   * (unit-free, linear) filters it is constant and identical for every lane, so the engine can fold it
   * into the single session latency offset. An opt-in 'oneEuro' lane reports its WORST case (the delay
   * at rest), which only ever over-estimates — the maximum over the lanes is returned either way.
   */
  filterDelaySec(fps: number = this.getStats().fps || 30): number {
    let max = 0;
    for (const l of this.lanes) max = Math.max(max, l.pipeline.filterDelaySec(fps));
    return max;
  }

  getLaneDebug(): LaneDebug[] {
    return this.lanes.map((l) => ({
      lane: l.spec.index,
      movement: l.spec.movement,
      side: l.spec.side,
      raw: l.sample.raw,
      filtered: l.sample.smoothed,
      value: l.sample.value,
      rawValue: l.sample.rawValue,
      armed: l.trigger.armed,
      mirrored: l.pipeline.getMirrored(),
      triggerState: l.trigger.state,
      tracking: l.sample.tracking,
      calibration: l.pipeline.getCalibration(),
      compensation: l.sample.compensation ? { kind: l.sample.compensation.kind, value: l.sample.compensation.value, flagged: l.sample.compensation.flagged } : null,
      compensationMonitored: compensationKind(l.spec.movement) ? l.pipeline.isCompensationMonitored() : null,
    }));
  }

  /**
   * Change the hit threshold mid-session (a therapist making the song easier or harder).
   *
   * This does NOT reset the triggers — that would discard reps in flight — but LaneTrigger.setThreshold
   * re-checks each lane's arming against the new re-arm level, so a lane merely sitting where it already
   * was cannot score off the adjustment itself. See LaneTrigger.setThreshold.
   */
  setThresholdFraction(f: number): void {
    for (const l of this.lanes) {
      l.trigger.setThreshold(f);
      // The unreachable watchdog measures against the threshold, so its window restarts with it: a lane
      // must be given the new threshold's worth of time before it can be accused of not reaching it.
      l.reachedAt = NaN;
      l.peakSinceReached = 0;
      l.attemptAt = NaN;
    }
    this.laneStates = null;
    this.statusSeq++;
  }

  /**
   * Replace a lane's calibration (therapist re-calibration / nudge during play). null = uncalibrated.
   * Returns false when the calibration was REFUSED for being narrower than the movement's minimum ROM:
   * the lane is left uncalibrated (reads 0, never triggers) rather than made into a hit generator.
   */
  setCalibration(laneIndex: number, cal: RomCalibration | null): boolean {
    const i = this.laneConfigIndex(laneIndex);
    if (i < 0) return false;
    const l = this.lanes[i];
    // The lane's CalibrationContext must come along, and it is derived exactly where the constructor
    // derives it (laneCalibrationContext) — not rebuilt from the fields this method happens to remember.
    // For a finger_opposition lane the therapist may have chosen a fingertip other than the default, and
    // `1 - min(tip..thumb)/palm` measured against the PINKY is a different quantity from the same
    // expression measured against the INDEX; under the other mirror convention the same lane spec
    // measures the OTHER limb. Vetting without that context did the two things this module calls its
    // worst failures: it REFUSED the calibration that was actually measured on this lane (dead lane for
    // the whole session) and ACCEPTED one measured on something else (one quantity normalized by
    // another's range — meter, thresholds and reported ROM% all wrong, with a green status over them).
    // This runtime hand-over is what a calibration screen calls after every lane finishes, so it must
    // vet identically to the constructor.
    const vetted = this.vetCalibration(l.spec, cal, this.laneCalibrationContext(i));
    l.calibrationProblem = vetted.problem;
    l.calibrationWarnings = vetted.warnings;
    l.pipeline.setCalibration(vetted.cal);
    l.trigger.reset();
    l.worstComp = null;
    l.aboveSince = NaN;
    l.reachedAt = NaN;
    l.peakSinceReached = 0;
    l.attemptAt = NaN;
    this.laneStates = null;
    this.statusSeq++;
    return vetted.problem === null;
  }

  /** Convert a performance.now()-based frame time to AudioContext time (best effort). */
  frameTimeToCtx(frameTimeMs: number): number {
    const nowPerf = typeof performance !== 'undefined' ? performance.now() : frameTimeMs;
    const age = Math.max(0, (nowPerf - frameTimeMs) / 1000);
    return this.config.audioContext.currentTime - age;
  }

  private findLane(laneIndex: number): LaneRuntime | undefined {
    for (const l of this.lanes) if (l.spec.index === laneIndex) return l;
    return undefined;
  }

  /** True when every lane is on the same side (the standard unilateral stroke prescription). */
  isUnilateral(): boolean {
    const sides = new Set(this.config.lanes.map((l) => l.side));
    return sides.size <= 1;
  }

  /**
   * End the compensation window when the lane is not inside a rep and has fallen back to (or below) the
   * re-arm level, or lost tracking outside a rep.
   *
   * WHY: a compensation flag must be TRUE OF THE REP IT IS ATTACHED TO — it is therapist-facing rehab
   * output, not decoration. `worstComp` accumulates from the moment the value rises above the re-arm
   * level (so a heel lift during the rise into the threshold is caught), and a completed rep consumes
   * it. Without this, an attempt that rises above the re-arm level with a compensation but never reaches
   * the threshold leaves the flag latched forever, and the next clean rep is reported as compensated.
   * A rep IN PROGRESS ('triggered') keeps its window across a tracking dropout: that compensation was
   * genuinely observed during this rep. So does an ATTEMPT still on its way up across a SHORT dropout —
   * the same rule the trigger applies to the arming itself (LaneTrigger.breakContinuity). The trigger's
   * state is the authority: it is still 'armed' when the break was short enough that the rise it is
   * watching survived, and 'unconfirmed' once the break was long enough to hide a whole movement, at
   * which point whatever was seen belongs to no rep anyone can name. Without this, one dropped frame
   * during the rise erased a heel lift that really happened and the rep was reported clean — the same
   * class of silent data loss as dropping the rep itself.
   */
  private expireCompensation(l: LaneRuntime, value: number | null): void {
    if (l.worstComp === null) return;
    if (l.trigger.state === 'triggered') return;
    if (value === null) {
      if (l.trigger.state !== 'armed') l.worstComp = null;
      return;
    }
    if (value < l.trigger.rearmLevel) l.worstComp = null;
  }

  private selectLandmarks(spec: LaneSpec, res: DetectionResult, record = false): Landmark[] | null {
    if (this.config.mode === 'leg') return res.pose;
    const pick = pickHandResult(res.hands, spec.side, this.config.mirrored ?? false, {
      minLabelScore: this.config.handLabelScore,
      acceptLoneHand: this.config.acceptLoneHand ?? this.isUnilateral(),
    });
    const h = pick.hand;
    if (!h) return null;
    // Optional confidence gate: a hand the detector is unsure about must not drive the affected lane.
    if (h.score < (this.config.minHandScore ?? 0)) return null;
    // The lone-hand escape hatch was used and the handedness label was a coin flip: this lane is being
    // driven by a hand nobody could identify. It is still the best available answer (refusing it locks a
    // unilateral patient out of their own session), but "the affected limb's rep count" is a
    // therapist-facing metric and it must not be reported as if the limb were confirmed. Say it.
    if (record && pick.source === 'lone_unlabelled') this.unlabelledHand.push(spec.index);
    return h.landmarks;
  }

  /**
   * SAME-PERSON GUARD. See SubjectGuardOptions: `numPoses: 1` tracks one body and never says whose, so a
   * therapist stepping into frame can hand every lane a different person under a green 'ok'. Compare the
   * tracked body's torso length and hip midpoint with the previous frame's; a discontinuity larger than
   * a seated patient can produce in one frame means the model changed its mind about who it is looking
   * at (or the patient's own tracking broke badly enough that the same doubt applies).
   *
   * Only ever a WARNING: the frame is still processed. A false positive that silently dropped frames
   * would be a worse failure than the one it guards against, and the therapist is the right person to
   * decide whether the frame contains the patient.
   */
  private checkSubjectContinuity(pose: Landmark[] | null, ctxTime: number, gapSec: number): void {
    if (this.config.mode !== 'leg' || this.config.subjectGuard === false) return;
    const g = this.config.subjectGuard ?? {};
    if (!pose || !allVisible(pose, SUBJECT_IDX, this.config.minVisibility)) {
      // Nothing to compare against next frame: a body that reappears after an absence is legitimately
      // somewhere else, so the guard restarts rather than firing on the re-acquisition.
      this.subjectSig = null;
      return;
    }
    const xScale = this.getXScale();
    const hip = midpoint(pose[POSE.LEFT_HIP], pose[POSE.RIGHT_HIP]);
    const sho = midpoint(pose[POSE.LEFT_SHOULDER], pose[POSE.RIGHT_SHOULDER]);
    const torso = distance2d(hip, sho, xScale);
    const prev = this.subjectSig;
    const sig = { cx: hip.x, cy: hip.y, torso };
    this.subjectSig = torso > 1e-4 ? sig : null;
    if (!prev || torso <= 1e-4 || prev.torso <= 1e-4) return;
    // Frames far apart (a dropout, a re-start, a backgrounded tab) tell us nothing about continuity.
    if (!Number.isFinite(gapSec) || gapSec <= 0 || gapSec > this.staleFrameSec) return;
    const grew = Math.abs(torso - prev.torso) / prev.torso;
    const moved = Math.hypot((sig.cx - prev.cx) * xScale, sig.cy - prev.cy) / prev.torso;
    if (grew > (g.torsoFraction ?? 0.25) || moved > (g.moveFraction ?? 0.5)) {
      this.subjectJumpAt = ctxTime;
      this.statusSeq++;
    }
  }

  /**
   * Seconds since the tracked BODY last jumped in a way no seated patient can (Infinity: never).
   *
   * The fourth silent death, and the only one the module could not otherwise name: the pose is visible,
   * the values are plausible, the lanes are being attempted — everything the other watchdogs look at is
   * healthy — and yet the numbers belong to whoever the model is now tracking. Reported as a warning for
   * `subjectGuard.warnSec` after the last discontinuity.
   */
  getSubjectChangedSec(): number {
    if (Number.isNaN(this.subjectJumpAt)) return Infinity;
    return Math.max(0, this.latestCtxTime - this.subjectJumpAt);
  }

  /**
   * True when the detect loop is duty-cycling inference down to protect the main thread (see
   * DetectLoopOptions.adaptiveSkip). Distinct from `lowFps`, and with a different remedy: the CAMERA is
   * delivering frames, the app is choosing not to run inference on all of them because each one costs
   * more main-thread time than the frame budget allows.
   */
  isThrottled(): boolean {
    return this.loop?.isThrottled() ?? false;
  }

  /**
   * Core pipeline for one detection frame. Public so tests / a calibration screen can feed frames.
   * `ctxTime` = AudioContext time the frame corresponds to.
   */
  processDetection(res: DetectionResult, ctxTime: number): LaneInputEvent[] {
    this.latest = res;
    const prevCtxTime = this.latestCtxTime;
    this.latestCtxTime = ctxTime;
    const nowMs = this.now();
    // Has the AUDIO clock moved since the last frame? (See the ctxClockStalled field.) Frames arriving
    // with an unchanged ctxTime mean the AudioContext is suspended: the whole timing chain is frozen.
    if (Number.isNaN(this.lastSeenCtxTime) || ctxTime !== this.lastSeenCtxTime) {
      this.lastSeenCtxTime = ctxTime;
      this.lastCtxAdvanceMs = nowMs;
      this.ctxClockStalled = false;
    } else if (Number.isFinite(this.lastCtxAdvanceMs) && (nowMs - this.lastCtxAdvanceMs) / 1000 > this.staleFrameSec) {
      this.ctxClockStalled = true;
    }
    this.lastFrameMs = nowMs;
    this.frameSeq++;
    this.syncCameraAspect();
    const events: LaneInputEvent[] = [];
    const reps: LaneRepEvent[] = [];
    const untracked: number[] = [];
    // A FRESH array every frame: onFrame listeners (the calibration screen) may retain it.
    const samples: LaneSample[] = new Array(this.lanes.length);
    const anyLandmarks = this.config.mode === 'leg' ? res.pose !== null : res.hands.length > 0;
    let lowVis = false;
    const world = this.config.mode === 'leg' ? res.poseWorld ?? null : null;
    this.checkSubjectContinuity(res.pose, ctxTime, ctxTime - prevCtxTime);
    this.unlabelledHand = [];

    for (let i = 0; i < this.lanes.length; i++) {
      const l = this.lanes[i];
      const landmarks = this.selectLandmarks(l.spec, res, true);
      const sample = l.pipeline.push(landmarks, ctxTime, world);
      l.sample = sample;
      samples[i] = sample;
      if (!sample.tracking) {
        if (landmarks) lowVis = true;
        // A dropout observes nothing: the pinned clock is neither advanced nor cleared here — a SHORT
        // dropout inside a genuinely stuck lane keeps accumulating, a long one restarts it (above).
        l.trigger.push(null, ctxTime);
        // Tracking loss OUTSIDE a rep ends the compensation window: whatever was seen before the lane
        // went dark belongs to no rep and must not be attached to the next one.
        this.expireCompensation(l, null);
        untracked.push(l.spec.index);
        continue;
      }

      // Pinned-lane watchdog: how long the lane has been continuously at/above its re-arm level. A rep
      // is 1-2 s; anything an order of magnitude longer means the lane can no longer fall back far
      // enough to re-arm, so it will never score again (see getPinnedLanes). Continuity is the same
      // rule LaneTrigger applies: a break in the observed stream longer than the stall window is NOT
      // evidence that the lane stayed up, so the clock restarts rather than accusing a lane of being
      // pinned for the duration of a wedged camera.
      if (sample.value >= l.trigger.rearmLevel) {
        if (Number.isNaN(l.aboveSince) || ctxTime - l.aboveLastSeen > this.staleFrameSec) l.aboveSince = ctxTime;
        l.aboveLastSeen = ctxTime;
      } else l.aboveSince = NaN;

      // Unreachable-lane watchdog (the mirror of the pinned one): the clock runs from the last time the
      // lane actually REACHED its threshold, or from the first frame it was tracked on. `peakSinceReached`
      // is the evidence that the patient is attempting the movement at all — without it a lane whose
      // notes have not come round yet would be accused of being broken. Tracking gaps restart the clock
      // for the same reason they restart the pinned clock: an unobserved window is not evidence.
      if (Number.isNaN(l.reachedAt) || ctxTime - l.lastTrackedAt > this.staleFrameSec) {
        l.reachedAt = ctxTime;
        l.peakSinceReached = 0;
        l.attemptAt = NaN;
      }
      l.lastTrackedAt = ctxTime;
      if (sample.value >= l.trigger.thresholdFraction) {
        l.reachedAt = ctxTime;
        l.peakSinceReached = 0;
        l.attemptAt = NaN;
      } else {
        if (sample.value > l.peakSinceReached) l.peakSinceReached = sample.value;
        // WHEN the attempt happened matters as much as how high it got. `peakSinceReached` is a running
        // maximum that never decays, so one sub-threshold attempt (0.7 of a 0.8 threshold) followed by
        // a patient legitimately RESTING for the rest of the watchdog window used to be reported as
        // 'lane_unreachable' — accusing them of making a movement that cannot score while they sat
        // still. The evidence has to be recent to mean anything, so its time is kept too.
        if (sample.value >= l.trigger.thresholdFraction * this.unreachableAttemptFraction) l.attemptAt = ctxTime;
      }

      // Compensation during the movement (value at/above the re-arm level): remember the worst for the
      // CURRENT attempt only. An attempt ends when the lane drops back below the re-arm level without
      // completing a rep (see expireCompensation) — otherwise a sustained sub-threshold movement with a
      // lifted heel would latch its flag onto a clean rep minutes later.
      const c = sample.compensation;
      if (c?.flagged && sample.value >= l.trigger.rearmLevel) {
        if (!l.worstComp || c.value > l.worstComp.value) l.worstComp = { kind: c.kind, value: c.value };
        if (ctxTime - l.compFlagLastEmit > 0.5) {
          l.compFlagLastEmit = ctxTime;
          const ev: CompensationEvent = { lane: l.spec.index, ctxTime, kind: c.kind, value: c.value };
          for (const cb of this.compListeners) cb(ev);
        }
      }

      const trig = l.trigger.push(sample.value, ctxTime, sample.rawValue);
      if (trig) {
        const ev: LaneInputEvent = { lane: l.spec.index, ctxTime: trig.ctxTime, strength: trig.strength, rawStrength: trig.rawStrength };
        if (Number.isFinite(trig.gapSec)) ev.gapSec = trig.gapSec;
        // The crossing was measured across a dropout: still a real, observed rising edge (it is scored
        // like any other — losing it would cost the patient a rep they performed), but its time is only
        // good to about half the gap, so a latency measurement must leave it out.
        if (trig.afterGap) ev.timingDegraded = true;
        if (l.worstComp) ev.compensation = { ...l.worstComp };
        events.push(ev);
      }
      const done = l.trigger.takeCompletedRep();
      if (done) {
        // EVERY completed rep is reported, including one whose crossing was swallowed by the minimum
        // re-trigger interval (emitted:false): the patient performed it, so it belongs in the rehab
        // metrics even though it could not score.
        const rep: LaneRepEvent = {
          lane: l.spec.index, ctxTime: done.ctxTime, endCtxTime: done.endCtxTime,
          peak: done.peak, rawPeak: done.rawPeak, emitted: done.emitted,
        };
        // Closed by a break in the stream, not by an observed return to rest: the peak is a lower bound.
        if (done.truncated) rep.truncated = true;
        // Frames were dropped inside the rep but the stream came back: the rep is kept and counted, and
        // its peak is flagged as the lower bound it is.
        if (done.gapped) rep.gapped = true;
        // Say whether the compensation was measured AT ALL. Without this, a rep with no `compensation`
        // is ambiguous: it could be a clean rep, or a rep nobody was watching for a heel lift.
        if (compensationKind(l.spec.movement)) rep.compensationMonitored = l.pipeline.isCompensationMonitored();
        if (l.worstComp) rep.compensation = { ...l.worstComp };
        reps.push(rep);
        this.lastRepAt[i] = done.endCtxTime;
        l.worstComp = null;
      } else {
        this.expireCompensation(l, sample.value);
      }
    }

    this.untracked = untracked;
    if (!anyLandmarks) this.reason = this.config.mode === 'leg' ? 'no_person' : 'no_hand';
    else if (untracked.length > 0) this.reason = this.config.mode === 'leg' || lowVis ? 'low_visibility' : 'hand_missing';
    else this.reason = 'ok';

    for (const cb of this.frameListeners) cb(samples, ctxTime, res);
    for (const ev of events) for (const cb of this.listeners) cb(ev);
    for (const rep of reps) for (const cb of this.repListeners) cb(rep);
    return events;
  }
}
