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
 * The filter is linear and unit-free (default EMA alpha 0.5 => ~1 frame of lag at 30 fps) so every lane
 * has the same delay; `filterDelaySec()` reports it for the engine's latency offset.
 */
import type { LaneSpec, Mode, Side } from '../engine/types.ts';
import type { CompensationEvent, CtxClock, InputSource, LaneCompensation, LaneInputEvent, LaneRepEvent, LaneState, VisionStatus, VisionTrackingReason } from './types.ts';
import type { RomCalibration } from '../vision/calibration.ts';
import { MOVEMENT_INFO } from '../vision/features.ts';
import type { CompensationBaseline, FeatureOptions } from '../vision/features.ts';
import type { LaneFilterSpec } from '../vision/filters.ts';
import { LanePipeline } from '../vision/pipeline.ts';
import type { LaneSample } from '../vision/pipeline.ts';
import { LaneTrigger } from '../vision/trigger.ts';
import { DetectLoop, createDetector, openCamera, pickHand } from '../vision/mediapipe.ts';
import type { CameraSession, DetectionResult, LandmarkDetector, LoopStats } from '../vision/mediapipe.ts';
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
  /** Override smoothing for all lanes (default: MOVEMENT_INFO[movement].smoothing, EMA 0.5). Unit-free filters only. */
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
}

export interface LaneDebug {
  lane: number;
  movement: LaneSpec['movement'];
  side: Side;
  raw: number | null;
  filtered: number | null;
  value: number;
  armed: boolean;
  tracking: boolean;
  calibration: RomCalibration | null;
  compensation: { kind: 'heel_lift' | 'trunk_lean'; value: number; flagged: boolean } | null;
}

/** Per-frame callback: the lanes' pipeline samples (same order as config.lanes) for this detection. */
export type FrameCallback = (samples: readonly LaneSample[], ctxTime: number, result: DetectionResult) => void;

interface LaneRuntime {
  spec: LaneSpec;
  pipeline: LanePipeline;
  trigger: LaneTrigger;
  sample: LaneSample;
  /** Worst flagged compensation observed during the current rep (reset when the lane re-arms). */
  worstComp: LaneCompensation | null;
  compFlagLastEmit: number;
}

const HAND_MOVEMENT_HINT = 'Rest your forearm on the table with your palm facing the camera.';

/** Human-readable status message derived from the reason AND the configured lanes. */
export function visionStatusMessage(reason: VisionTrackingReason, mode: Mode, lanes: readonly LaneSpec[]): string {
  switch (reason) {
    case 'stopped':
      return 'Camera is off.';
    case 'starting':
      return 'Starting camera…';
    case 'ok':
      return '';
    case 'error':
      return 'Camera or detector error.';
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
  private latest: DetectionResult | null = null;
  private latestCtxTime = 0;
  private reason: VisionTrackingReason = 'stopped';
  private untracked: number[] = [];
  private lastError: unknown = null;
  private readonly samplesView: LaneSample[] = [];

  constructor(config: VisionInputConfig) {
    this.config = config;
    if (config.calibrations.length < config.lanes.length) {
      throw new Error(`VisionInput: ${config.lanes.length} lanes but ${config.calibrations.length} calibrations`);
    }
    for (const l of config.lanes) {
      if (MOVEMENT_INFO[l.movement].mode !== config.mode) {
        throw new Error(`VisionInput: movement ${l.movement} is not a ${config.mode} movement`);
      }
    }
    this.lanes = config.lanes.map((spec, i) => this.makeLane(spec, i));
  }

  private makeLane(spec: LaneSpec, i: number): LaneRuntime {
    const c = this.config;
    const cal = c.calibrations[i] ?? null;
    let pipeline = c.pipelines?.[i];
    if (pipeline) {
      if (pipeline.movement !== spec.movement || pipeline.side !== spec.side) {
        throw new Error(`VisionInput: pipeline ${i} is ${pipeline.movement}/${pipeline.side}, lane is ${spec.movement}/${spec.side}`);
      }
      if (cal) pipeline.setCalibration(cal);
    } else {
      pipeline = new LanePipeline({
        movement: spec.movement,
        side: spec.side,
        smoothing: c.smoothing,
        calibration: cal,
        featureOptions: { ...(c.featureOptions?.[i] ?? {}), minVisibility: c.minVisibility },
      });
    }
    const baselineOverride = c.compensationBaselines?.[i];
    if (baselineOverride !== undefined) pipeline.setCompensationBaseline(baselineOverride);
    return {
      spec,
      pipeline,
      trigger: new LaneTrigger({ thresholdFraction: c.thresholdFraction, rearmFraction: c.rearmFraction, minIntervalSec: c.minIntervalSec }),
      sample: pipeline.last,
      worstComp: null,
      compFlagLastEmit: -Infinity,
    };
  }

  /* ---------- InputSource ---------- */

  async start(): Promise<void> {
    if (this.running) return;
    this.reason = 'starting';
    this.lastError = null;
    try {
      const d = this.config.detector;
      if (!d) {
        this.detector = await createDetector({ mode: this.config.mode, numHands: 2 });
        this.ownsDetector = true;
      } else if (typeof d === 'function') {
        this.detector = await d();
        this.ownsDetector = true;
      } else this.detector = d;

      if (this.config.driveLoop !== false) {
        const cam = this.config.camera;
        if (!cam) {
          this.camera = await openCamera({ width: 640, height: 480, facingMode: 'user' });
          this.ownsCamera = true;
        } else if (typeof cam === 'function') {
          this.camera = await cam();
          this.ownsCamera = true;
        } else this.camera = cam;
        this.loop = new DetectLoop(this.camera.video, this.detector, (res, frameTimeMs) => {
          const ctxTime = this.frameTimeToCtx(frameTimeMs);
          this.processDetection(res, ctxTime);
        });
        this.loop.onError = (err) => {
          this.lastError = err;
          this.reason = 'error';
        };
        this.loop.start();
      }
      this.running = true;
      this.reason = this.config.mode === 'leg' ? 'no_person' : 'no_hand';
    } catch (err) {
      this.lastError = err;
      this.reason = 'error';
      this.stop();
      throw err;
    }
  }

  stop(): void {
    this.loop?.stop();
    this.loop = null;
    if (this.ownsCamera) this.camera?.stop();
    if (this.ownsDetector) this.detector?.close();
    this.camera = null;
    this.detector = null;
    this.ownsCamera = false;
    this.ownsDetector = false;
    this.running = false;
    this.reason = 'stopped';
    this.untracked = [];
    for (const l of this.lanes) {
      l.pipeline.reset();
      l.trigger.reset();
      l.sample = l.pipeline.last;
      l.worstComp = null;
      l.compFlagLastEmit = -Infinity;
    }
  }

  onEvent(cb: (e: LaneInputEvent) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  getLaneStates(): LaneState[] {
    return this.lanes.map((l) => ({ lane: l.spec.index, value: l.sample.value, armed: l.trigger.armed, tracking: l.sample.tracking }));
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

  getStatus(): VisionStatus {
    const stats = this.getStats();
    return {
      tracking: this.running && this.reason === 'ok',
      reason: this.reason,
      message: visionStatusMessage(this.reason, this.config.mode, this.config.lanes),
      fps: stats.fps,
      inferenceMs: stats.inferenceMs,
      delegate: this.detector?.delegate ?? null,
      untrackedLanes: this.untracked.slice(),
    };
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
   * Filter group delay of the lanes at the current (or given) detection frame rate: constant and
   * identical for every lane, so the engine can fold it into the single session latency offset.
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
      armed: l.trigger.armed,
      tracking: l.sample.tracking,
      calibration: l.pipeline.getCalibration(),
      compensation: l.sample.compensation ? { kind: l.sample.compensation.kind, value: l.sample.compensation.value, flagged: l.sample.compensation.flagged } : null,
    }));
  }

  setThresholdFraction(f: number): void {
    for (const l of this.lanes) l.trigger.setThreshold(f);
  }

  /** Replace a lane's calibration (therapist re-calibration / nudge during play). null = uncalibrated. */
  setCalibration(laneIndex: number, cal: RomCalibration | null): void {
    const l = this.findLane(laneIndex);
    if (!l) return;
    l.pipeline.setCalibration(cal);
    l.trigger.reset();
    l.worstComp = null;
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

  private selectLandmarks(spec: LaneSpec, res: DetectionResult): Landmark[] | null {
    if (this.config.mode === 'leg') return res.pose;
    return pickHand(res.hands, spec.side, this.config.mirrored ?? false)?.landmarks ?? null;
  }

  /**
   * Core pipeline for one detection frame. Public so tests / a calibration screen can feed frames.
   * `ctxTime` = AudioContext time the frame corresponds to.
   */
  processDetection(res: DetectionResult, ctxTime: number): LaneInputEvent[] {
    this.latest = res;
    this.latestCtxTime = ctxTime;
    const events: LaneInputEvent[] = [];
    const reps: LaneRepEvent[] = [];
    const untracked: number[] = [];
    const anyLandmarks = this.config.mode === 'leg' ? res.pose !== null : res.hands.length > 0;
    let lowVis = false;
    const world = this.config.mode === 'leg' ? res.poseWorld ?? null : null;

    for (let i = 0; i < this.lanes.length; i++) {
      const l = this.lanes[i];
      const landmarks = this.selectLandmarks(l.spec, res);
      const sample = l.pipeline.push(landmarks, ctxTime, world);
      l.sample = sample;
      this.samplesView[i] = sample;
      if (!sample.tracking) {
        if (landmarks) lowVis = true;
        l.trigger.push(null, ctxTime);
        untracked.push(l.spec.index);
        continue;
      }

      // Compensation during the movement (value at/above the re-arm level): remember the worst for the rep.
      const c = sample.compensation;
      if (c?.flagged && sample.value >= l.trigger.rearmLevel) {
        if (!l.worstComp || c.value > l.worstComp.value) l.worstComp = { kind: c.kind, value: c.value };
        if (ctxTime - l.compFlagLastEmit > 0.5) {
          l.compFlagLastEmit = ctxTime;
          const ev: CompensationEvent = { lane: l.spec.index, ctxTime, kind: c.kind, value: c.value };
          for (const cb of this.compListeners) cb(ev);
        }
      }

      const trig = l.trigger.push(sample.value, ctxTime);
      if (trig) {
        const ev: LaneInputEvent = { lane: l.spec.index, ctxTime: trig.ctxTime, strength: trig.strength };
        if (l.worstComp) ev.compensation = { ...l.worstComp };
        events.push(ev);
      }
      const done = l.trigger.takeCompletedRep();
      if (done) {
        if (done.emitted) {
          const rep: LaneRepEvent = { lane: l.spec.index, ctxTime: done.ctxTime, endCtxTime: done.endCtxTime, peak: done.peak };
          if (l.worstComp) rep.compensation = { ...l.worstComp };
          reps.push(rep);
        }
        l.worstComp = null;
      }
    }
    this.samplesView.length = this.lanes.length;

    this.untracked = untracked;
    if (!this.running && this.reason === 'stopped') this.reason = 'ok';
    if (!anyLandmarks) this.reason = this.config.mode === 'leg' ? 'no_person' : 'no_hand';
    else if (untracked.length > 0) this.reason = this.config.mode === 'leg' || lowVis ? 'low_visibility' : 'hand_missing';
    else this.reason = 'ok';

    for (const cb of this.frameListeners) cb(this.samplesView, ctxTime, res);
    for (const ev of events) for (const cb of this.listeners) cb(ev);
    for (const rep of reps) for (const cb of this.repListeners) cb(rep);
    return events;
  }
}
