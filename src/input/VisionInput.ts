/**
 * VisionInput: camera -> MediaPipe -> per-lane feature -> filter -> ROM normalize -> LaneTrigger -> events.
 * The detector and camera are injectable (fake detector in tests / critics). Without a driven loop
 * (`driveLoop: false`) callers feed frames via `processDetection(result, ctxTime)`.
 */
import type { LaneSpec, Mode, Side } from '../engine/types.ts';
import type { CompensationEvent, CtxClock, InputSource, LaneInputEvent, LaneState, VisionStatus, VisionTrackingReason } from './types.ts';
import type { RomCalibration } from '../vision/calibration.ts';
import { normalizeFeature } from '../vision/calibration.ts';
import { MOVEMENT_INFO, extractFeature, checkCompensation, compensationKind } from '../vision/features.ts';
import type { CompensationBaseline, FeatureOptions } from '../vision/features.ts';
import { createFilter } from '../vision/filters.ts';
import type { FilterSpec, ScalarFilter } from '../vision/filters.ts';
import { LaneTrigger } from '../vision/trigger.ts';
import { DetectLoop, createDetector, openCamera, pickHand } from '../vision/mediapipe.ts';
import type { CameraSession, DetectionResult, LandmarkDetector, LoopStats } from '../vision/mediapipe.ts';
import type { Landmark } from '../vision/landmarks.ts';

export interface VisionInputConfig {
  mode: Mode;
  lanes: LaneSpec[];
  /** One per entry of `lanes` (same order). */
  calibrations: RomCalibration[];
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
  /** Override smoothing for all lanes (default: MOVEMENT_INFO[movement].smoothing). */
  smoothing?: FilterSpec;
  /** Per-lane feature options (e.g. fingertip for finger_opposition), same order as lanes. */
  featureOptions?: (FeatureOptions | undefined)[];
  /** Per-lane rest baselines for compensation checks, same order as lanes. */
  compensationBaselines?: (CompensationBaseline | null | undefined)[];
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
  calibration: RomCalibration;
  compensation: { kind: 'heel_lift' | 'trunk_lean'; value: number; flagged: boolean } | null;
}

interface LaneRuntime {
  spec: LaneSpec;
  cal: RomCalibration;
  filter: ScalarFilter;
  trigger: LaneTrigger;
  raw: number | null;
  filtered: number | null;
  value: number;
  tracking: boolean;
  compensation: LaneDebug['compensation'];
  /** Compensation seen since the last trigger (attached to the next event). */
  compFlagPending: boolean;
  compFlagLastEmit: number;
}

const STATUS_MESSAGES: Record<VisionTrackingReason, string> = {
  stopped: 'Camera is off.',
  starting: 'Starting camera…',
  ok: '',
  no_person: 'No person detected. Sit facing the camera so your body is in view.',
  low_visibility: 'Some joints are hidden. Move back so your hips, knees and feet are in view.',
  no_hand: 'No hand detected. Rest your forearm on the table with your palm facing the camera.',
  hand_missing: 'One hand is not in view. Keep both hands visible.',
  error: 'Camera or detector error.',
};

export class VisionInput implements InputSource {
  readonly config: VisionInputConfig;
  private lanes: LaneRuntime[];
  private listeners = new Set<(e: LaneInputEvent) => void>();
  private compListeners = new Set<(e: CompensationEvent) => void>();
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
    this.lanes = config.lanes.map((spec, i) => this.makeLane(spec, config.calibrations[i]));
  }

  private makeLane(spec: LaneSpec, cal: RomCalibration): LaneRuntime {
    const c = this.config;
    return {
      spec,
      cal,
      filter: createFilter(c.smoothing ?? MOVEMENT_INFO[spec.movement].smoothing),
      trigger: new LaneTrigger({ thresholdFraction: c.thresholdFraction, rearmFraction: c.rearmFraction, minIntervalSec: c.minIntervalSec }),
      raw: null,
      filtered: null,
      value: 0,
      tracking: false,
      compensation: null,
      compFlagPending: false,
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
    for (const l of this.lanes) {
      l.filter.reset();
      l.trigger.reset();
      l.value = 0;
      l.tracking = false;
      l.raw = null;
      l.filtered = null;
    }
  }

  onEvent(cb: (e: LaneInputEvent) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  getLaneStates(): LaneState[] {
    return this.lanes.map((l) => ({ lane: l.spec.index, value: l.value, armed: l.trigger.armed, tracking: l.tracking }));
  }

  /* ---------- extras for UI / calibration ---------- */

  onCompensation(cb: (e: CompensationEvent) => void): () => void {
    this.compListeners.add(cb);
    return () => {
      this.compListeners.delete(cb);
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
      message: STATUS_MESSAGES[this.reason],
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
    const l = this.lanes.find((x) => x.spec.index === laneIndex);
    if (!l || !this.latest) return null;
    return this.selectLandmarks(l.spec, this.latest);
  }

  getVideoElement(): HTMLVideoElement | null {
    return this.camera?.video ?? null;
  }

  getLaneDebug(): LaneDebug[] {
    return this.lanes.map((l) => ({
      lane: l.spec.index,
      movement: l.spec.movement,
      side: l.spec.side,
      raw: l.raw,
      filtered: l.filtered,
      value: l.value,
      armed: l.trigger.armed,
      tracking: l.tracking,
      calibration: l.cal,
      compensation: l.compensation,
    }));
  }

  setThresholdFraction(f: number): void {
    for (const l of this.lanes) l.trigger.setThreshold(f);
  }

  /** Replace a lane's calibration (therapist re-calibration / nudge during play). */
  setCalibration(laneIndex: number, cal: RomCalibration): void {
    const l = this.lanes.find((x) => x.spec.index === laneIndex);
    if (l) l.cal = cal;
  }

  /** Convert a performance.now()-based frame time to AudioContext time (best effort). */
  frameTimeToCtx(frameTimeMs: number): number {
    const nowPerf = typeof performance !== 'undefined' ? performance.now() : frameTimeMs;
    const age = Math.max(0, (nowPerf - frameTimeMs) / 1000);
    return this.config.audioContext.currentTime - age;
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
    const untracked: number[] = [];
    const anyLandmarks = this.config.mode === 'leg' ? res.pose !== null : res.hands.length > 0;
    let lowVis = false;

    for (let i = 0; i < this.lanes.length; i++) {
      const l = this.lanes[i];
      const landmarks = this.selectLandmarks(l.spec, res);
      const fo: FeatureOptions = { ...(this.config.featureOptions?.[i] ?? {}), minVisibility: this.config.minVisibility };
      const raw = landmarks ? extractFeature(l.spec.movement, landmarks, l.spec.side, fo) : null;
      l.raw = raw;
      if (raw === null) {
        if (landmarks) lowVis = true;
        l.tracking = false;
        l.filtered = null;
        l.trigger.push(null, ctxTime);
        untracked.push(l.spec.index);
        continue;
      }
      l.tracking = true;
      const filtered = l.filter.filter(raw, ctxTime);
      l.filtered = filtered;
      l.value = normalizeFeature(l.cal, filtered);

      // compensation
      const baseline = this.config.compensationBaselines?.[i];
      const kind = compensationKind(l.spec.movement);
      if (baseline && kind && landmarks) {
        const c = checkCompensation(l.spec.movement, landmarks, l.spec.side, baseline, fo);
        l.compensation = c ? { kind: c.kind, value: c.value, flagged: c.flagged } : null;
        if (c?.flagged && l.value >= l.trigger.rearmLevel) {
          l.compFlagPending = true;
          if (ctxTime - l.compFlagLastEmit > 0.5) {
            l.compFlagLastEmit = ctxTime;
            const ev: CompensationEvent = { lane: l.spec.index, ctxTime, kind: c.kind, value: c.value };
            for (const cb of this.compListeners) cb(ev);
          }
        }
      }

      const trig = l.trigger.push(l.value, ctxTime);
      if (trig) {
        const ev: LaneInputEvent = { lane: l.spec.index, ctxTime: trig.ctxTime, strength: trig.strength };
        events.push(ev);
        l.compFlagPending = false;
      }
    }

    this.untracked = untracked;
    if (!this.running && this.reason === 'stopped') this.reason = 'ok';
    if (!anyLandmarks) this.reason = this.config.mode === 'leg' ? 'no_person' : 'no_hand';
    else if (untracked.length === this.lanes.length && this.lanes.length > 0) this.reason = this.config.mode === 'leg' ? 'low_visibility' : 'hand_missing';
    else if (untracked.length > 0) this.reason = this.config.mode === 'leg' || lowVis ? 'low_visibility' : 'hand_missing';
    else this.reason = 'ok';

    for (const ev of events) for (const cb of this.listeners) cb(ev);
    return events;
  }
}
