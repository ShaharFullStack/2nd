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
 *    quietly missing every remaining note under a green OK;
 *  - every completed rep is reported through onRep(), including reps whose crossing was swallowed by the
 *    minimum re-trigger interval (`emitted:false`), and with an UNCLAMPED `rawPeak` so ROM beyond the
 *    calibrated range stays measurable.
 */
import type { LaneSpec, Mode, Side } from '../engine/types.ts';
import type { CompensationEvent, CtxClock, InputSource, LaneCompensation, LaneInputEvent, LaneRepEvent, LaneState, VisionStatus, VisionTrackingReason } from './types.ts';
import type { LaneConflict, MovementPosture } from '../vision/features.ts';
import { POSTURE_INFO, laneConflicts, requiredPostures } from '../vision/features.ts';
import type { RomCalibration } from '../vision/calibration.ts';
import { calibrationProblem, isCalibrationValid } from '../vision/calibration.ts';
import { MOVEMENT_INFO } from '../vision/features.ts';
import type { CompensationBaseline, FeatureOptions } from '../vision/features.ts';
import type { LaneFilterSpec } from '../vision/filters.ts';
import { LanePipeline } from '../vision/pipeline.ts';
import type { LaneSample } from '../vision/pipeline.ts';
import { LaneTrigger } from '../vision/trigger.ts';
import { DetectLoop, MIN_USABLE_DETECT_FPS, createDetector, openCamera, pickHand } from '../vision/mediapipe.ts';
import type { CameraSession, DetectLoopOptions, DetectionResult, LandmarkDetector, LoopStats } from '../vision/mediapipe.ts';
import { aspectScale } from '../vision/landmarks.ts';
import type { Landmark } from '../vision/landmarks.ts';

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
  /** Inject a camera session or factory. Default: openCamera() 640x480 front camera. Same ownership rule as `detector`. */
  camera?: CameraSession | (() => Promise<CameraSession>);
  /** Run the detect loop on start (default true). false = caller feeds processDetection(). */
  driveLoop?: boolean;
  /** Frames fed to the detector are already horizontally flipped (default false, see mediapipe.ts). */
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
   * Frame aspect ratio (width / height) used to make the features isotropic — see FeatureOptions.xScale.
   * Default: taken from the live CameraSession (its width/height, refreshed from the video element), or
   * 1 when frames are fed in directly (fixtures / tests are square by construction).
   */
  xScale?: number;
  /** Detect-loop rate cap / main-thread budget (see DetectLoopOptions). */
  loopOptions?: DetectLoopOptions;
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
  /** 'unconfirmed' lanes cannot fire until they have been seen below the re-arm level. */
  triggerState: 'unconfirmed' | 'armed' | 'triggered';
  tracking: boolean;
  calibration: RomCalibration | null;
  compensation: { kind: 'heel_lift' | 'trunk_lean'; value: number; flagged: boolean } | null;
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
  /** Why the lane's calibration was refused (null when it is usable / absent). */
  calibrationProblem: string | null;
}

/** A lane whose calibration was refused: it reads 0 and can never score. */
export interface InvalidCalibration {
  lane: number;
  movement: LaneSpec['movement'];
  side: Side;
  /** Therapist-facing reason, e.g. "the calibrated range is only 1%, below the 12% minimum for …". */
  reason: string;
}

/** Live per-lane liveness for the pinned-lane watchdog / a therapist HUD. */
export interface LaneActivity {
  lane: number;
  /** Seconds the lane has been continuously at or above its re-arm level (0 when below it). */
  aboveRearmSec: number;
  /** True once that exceeds `pinnedLaneSec`: the lane can no longer produce a rising edge. */
  pinned: boolean;
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
  private readonly staleFrameSec: number;
  private readonly pinnedLaneSec: number;
  private lastRepAt: number[] = [];
  /** Monotonic counter of processed frames; invalidates the getLaneStates() memo. */
  private frameSeq = 0;
  private laneStates: LaneState[] | null = null;
  private laneStatesFrame = -1;
  private laneStatesDead = false;

  constructor(config: VisionInputConfig) {
    this.config = config;
    this.staleFrameSec = config.staleFrameSec ?? 0.5;
    this.pinnedLaneSec = config.pinnedLaneSec ?? 8;
    if (config.calibrations.length < config.lanes.length) {
      throw new Error(`VisionInput: ${config.lanes.length} lanes but ${config.calibrations.length} calibrations`);
    }
    for (const l of config.lanes) {
      if (MOVEMENT_INFO[l.movement].mode !== config.mode) {
        throw new Error(`VisionInput: movement ${l.movement} is not a ${config.mode} movement`);
      }
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
  private vetCalibration(spec: LaneSpec, cal: RomCalibration | null): { cal: RomCalibration | null; problem: string | null } {
    if (!cal) return { cal: null, problem: null };
    if (isCalibrationValid(cal, spec.movement)) return { cal, problem: null };
    const problem = calibrationProblem(cal, spec.movement) ?? 'the calibrated range is unusable';
    console.error(`[vision] lane ${spec.index + 1} (${MOVEMENT_INFO[spec.movement].label}, ${spec.side}) refused: ${problem}. The lane will not score until it is re-calibrated.`);
    return { cal: null, problem };
  }

  private makeLane(spec: LaneSpec, i: number): LaneRuntime {
    const c = this.config;
    const vetted = this.vetCalibration(spec, c.calibrations[i] ?? null);
    const cal = vetted.cal;
    let pipeline = c.pipelines?.[i];
    if (pipeline) {
      if (pipeline.movement !== spec.movement || pipeline.side !== spec.side) {
        throw new Error(`VisionInput: pipeline ${i} is ${pipeline.movement}/${pipeline.side}, lane is ${spec.movement}/${spec.side}`);
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
        featureOptions: { ...(c.featureOptions?.[i] ?? {}), minVisibility: c.minVisibility, mirrored: c.mirrored ?? false, xScale: c.xScale },
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
      calibrationProblem: vetted.problem,
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
    // A prescription that CANNOT work (same movement twice on a limb, or two incompatible postures of one
    // limb) must never fail silently at 3 unearned hits per rep: the Setup screen should block on
    // getLaneConflicts(), and if it did not, at least say so out loud.
    for (const c of this.getLaneConflicts()) {
      if (c.severity === 'error') console.error(`[vision] unusable lane prescription: ${c.message}`);
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
      const d = this.config.detector;
      if (!d) {
        detector = await createDetector({ mode: this.config.mode, numHands: 2 });
        ownsDetector = true;
      } else if (typeof d === 'function') {
        detector = await d();
        ownsDetector = true;
      } else detector = d;
      if (superseded()) return abandon();

      if (this.config.driveLoop !== false) {
        const cam = this.config.camera;
        if (!cam) {
          camera = await openCamera({ width: 640, height: 480, facingMode: 'user' });
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
    this.cameraEnded = false;
    this.lastFrameMs = Number.NEGATIVE_INFINITY;
    this.untracked = [];
    this.lastRepAt = this.lanes.map(() => NaN);
    for (const l of this.lanes) {
      l.pipeline.reset();
      l.trigger.reset();
      l.sample = l.pipeline.last;
      l.worstComp = null;
      l.compFlagLastEmit = -Infinity;
      l.aboveSince = NaN;
      l.aboveLastSeen = NaN;
    }
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

  getStatus(): VisionStatus {
    const stats = this.getStats();
    const age = this.frameAgeSec();
    const badCal = this.getInvalidCalibrationLanes();
    const pinned = this.getPinnedLanes();
    let reason = this.reason;
    if (this.running && reason !== 'error') {
      if (this.cameraEnded) reason = 'camera_ended';
      else if (age > this.staleFrameSec) reason = 'stalled';
      else if (this.detector?.recovering) reason = 'recovering';
      // These two are only reported once the frame stream itself is healthy: a patient who is out of
      // frame needs to hear that first, and a lane cannot be judged pinned on a dead stream.
      else if (reason === 'ok' && badCal.length > 0) reason = 'uncalibrated';
      else if (reason === 'ok' && pinned.length > 0) reason = 'lane_pinned';
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
    }
    for (const lane of pinned) {
      warnings.push(`Lane ${lane + 1} has been held above its hit threshold for over ${this.pinnedLaneSec}s and cannot score again until it returns to rest — re-calibrate it.`);
    }
    if (lowFps) warnings.push(`The camera is only managing ${fps.toFixed(0)} frames per second (${MIN_USABLE_DETECT_FPS} needed for accurate timing). Close other apps or try an easier difficulty.`);
    return {
      tracking: this.running && reason === 'ok',
      reason,
      message: this.statusMessage(reason, badCal, pinned),
      fps,
      inferenceMs: dead ? 0 : stats.inferenceMs,
      delegate: this.detector?.delegate ?? null,
      untrackedLanes: this.untracked.slice(),
      frameAgeSec: age,
      invalidCalibrationLanes: badCal,
      pinnedLanes: pinned,
      lowFps,
      warnings,
    };
  }

  private statusMessage(reason: VisionTrackingReason, badCal: number[], pinned: number[]): string {
    if (reason === 'uncalibrated') {
      const names = badCal.map((i) => `${i + 1}`).join(', ');
      return `Lane${badCal.length > 1 ? 's' : ''} ${names} ${badCal.length > 1 ? 'have' : 'has'} no usable calibration and cannot score. Re-run the range calibration for ${badCal.length > 1 ? 'those lanes' : 'that lane'}.`;
    }
    if (reason === 'lane_pinned') {
      const names = pinned.map((i) => `${i + 1}`).join(', ');
      return `Lane${pinned.length > 1 ? 's' : ''} ${names} ${pinned.length > 1 ? 'are' : 'is'} stuck above the hit threshold — the movement never returns to rest, so nothing can score. Return to the resting position, or re-calibrate.`;
    }
    return visionStatusMessage(reason, this.config.mode, this.config.lanes);
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

  /** Per-lane liveness (how long above the re-arm level, last rep, trigger state). */
  getLaneActivity(): LaneActivity[] {
    return this.lanes.map((l, i) => ({
      lane: l.spec.index,
      aboveRearmSec: Number.isNaN(l.aboveSince) ? 0 : Math.max(0, this.latestCtxTime - l.aboveSince),
      pinned: !Number.isNaN(l.aboveSince) && this.latestCtxTime - l.aboveSince >= this.pinnedLaneSec,
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
      triggerState: l.trigger.state,
      tracking: l.sample.tracking,
      calibration: l.pipeline.getCalibration(),
      compensation: l.sample.compensation ? { kind: l.sample.compensation.kind, value: l.sample.compensation.value, flagged: l.sample.compensation.flagged } : null,
    }));
  }

  setThresholdFraction(f: number): void {
    for (const l of this.lanes) l.trigger.setThreshold(f);
    this.laneStates = null;
  }

  /**
   * Replace a lane's calibration (therapist re-calibration / nudge during play). null = uncalibrated.
   * Returns false when the calibration was REFUSED for being narrower than the movement's minimum ROM:
   * the lane is left uncalibrated (reads 0, never triggers) rather than made into a hit generator.
   */
  setCalibration(laneIndex: number, cal: RomCalibration | null): boolean {
    const l = this.findLane(laneIndex);
    if (!l) return false;
    const vetted = this.vetCalibration(l.spec, cal);
    l.calibrationProblem = vetted.problem;
    l.pipeline.setCalibration(vetted.cal);
    l.trigger.reset();
    l.worstComp = null;
    l.aboveSince = NaN;
    this.laneStates = null;
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
   * genuinely observed during this rep.
   */
  private expireCompensation(l: LaneRuntime, value: number | null): void {
    if (l.worstComp === null) return;
    if (l.trigger.state === 'triggered') return;
    if (value === null || value < l.trigger.rearmLevel) l.worstComp = null;
  }

  private selectLandmarks(spec: LaneSpec, res: DetectionResult): Landmark[] | null {
    if (this.config.mode === 'leg') return res.pose;
    const h = pickHand(res.hands, spec.side, this.config.mirrored ?? false, {
      minLabelScore: this.config.handLabelScore,
      acceptLoneHand: this.config.acceptLoneHand ?? this.isUnilateral(),
    });
    if (!h) return null;
    // Optional confidence gate: a hand the detector is unsure about must not drive the affected lane.
    if (h.score < (this.config.minHandScore ?? 0)) return null;
    return h.landmarks;
  }

  /**
   * Core pipeline for one detection frame. Public so tests / a calibration screen can feed frames.
   * `ctxTime` = AudioContext time the frame corresponds to.
   */
  processDetection(res: DetectionResult, ctxTime: number): LaneInputEvent[] {
    this.latest = res;
    this.latestCtxTime = ctxTime;
    this.lastFrameMs = this.now();
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

    for (let i = 0; i < this.lanes.length; i++) {
      const l = this.lanes[i];
      const landmarks = this.selectLandmarks(l.spec, res);
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
