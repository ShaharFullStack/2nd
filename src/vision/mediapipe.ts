/**
 * MediaPipe tasks-vision wrapper: lazy loader (local wasm + models), camera helper, detect loop.
 *
 * Everything the rest of the app touches is the small `LandmarkDetector` interface, so tests and critics
 * can inject a fake detector instead of the real MediaPipe runtime (see src/input/VisionInput.ts).
 *
 * HANDEDNESS / MIRROR CONVENTION
 * ------------------------------
 * getUserMedia delivers the raw (un-mirrored) sensor image: the patient's RIGHT hand appears on the
 * image LEFT (small x). The UI usually mirrors the preview with CSS `scaleX(-1)`; that does not affect
 * the landmarks. MediaPipe's handedness label assumes the input image IS mirrored (selfie-flipped), so
 * on a raw stream the label is inverted: label "Left" == patient's right hand.
 *   mirrored = false (default, raw stream fed to the detector): patient side = opposite of the label.
 *   mirrored = true  (frames were horizontally flipped BEFORE detection): patient side = label.
 * `pickHand` also falls back to position (raw: patient's right hand is the one with the smaller x)
 * when labels are missing/ambiguous.
 */
import type { Mode, Side } from '../engine/types.ts';
import type { Landmark } from './landmarks.ts';

export interface HandDetection {
  landmarks: Landmark[];
  /** MediaPipe label as reported ("Left" | "Right"), before any mirror correction. */
  label: string;
  /** Handedness confidence 0..1. */
  score: number;
}

export interface DetectionResult {
  /** Timestamp passed to the detector (ms, monotonic). */
  tMs: number;
  /** 33 pose landmarks (leg mode) or null when no person was found. */
  pose: Landmark[] | null;
  /**
   * Pose world landmarks (metres, hip-centred) for the same frame when the detector provides them.
   * Used by the 3D angle features (knee_extension, ankle_dorsiflexion); image-space z is a fallback.
   */
  poseWorld?: Landmark[] | null;
  /** Detected hands (hand mode); empty when none. */
  hands: HandDetection[];
}

/** Anything MediaPipe accepts as an image source; kept loose so fakes can pass anything. */
export type FrameSource = HTMLVideoElement | HTMLImageElement | HTMLCanvasElement | ImageBitmap | ImageData | OffscreenCanvas | VideoFrame;

export interface LandmarkDetector {
  readonly mode: Mode;
  /** Backend actually in use. */
  readonly delegate: 'GPU' | 'CPU';
  /** Run inference for one video frame. `timestampMs` must increase monotonically. */
  detect(frame: FrameSource, timestampMs: number): DetectionResult;
  close(): void;
}

export interface DetectorOptions {
  mode: Mode;
  /** Directory holding the tasks-vision wasm files (default '/wasm'). */
  wasmPath?: string;
  poseModelPath?: string;
  handModelPath?: string;
  /** 'auto' (default) tries GPU then falls back to CPU. */
  delegate?: 'GPU' | 'CPU' | 'auto';
  numHands?: number;
  minDetectionConfidence?: number;
  minTrackingConfidence?: number;
}

export const DEFAULT_WASM_PATH = '/wasm';
export const DEFAULT_POSE_MODEL = '/models/pose_landmarker_lite.task';
export const DEFAULT_HAND_MODEL = '/models/hand_landmarker.task';

type TasksVision = typeof import('@mediapipe/tasks-vision');
let visionModule: Promise<TasksVision> | null = null;
type WasmFileset = Awaited<ReturnType<TasksVision['FilesetResolver']['forVisionTasks']>>;
let filesets = new Map<string, Promise<WasmFileset>>();

/** Lazy-load the tasks-vision bundle (only once). */
export function loadTasksVision(): Promise<TasksVision> {
  if (!visionModule) visionModule = import('@mediapipe/tasks-vision');
  return visionModule;
}

export async function loadFileset(wasmPath: string = DEFAULT_WASM_PATH) {
  let p = filesets.get(wasmPath);
  if (!p) {
    p = loadTasksVision().then((mp) => mp.FilesetResolver.forVisionTasks(wasmPath));
    filesets.set(wasmPath, p);
  }
  return p;
}

/** Testing hook: forget cached module/fileset promises. */
export function resetMediaPipeCache(): void {
  visionModule = null;
  filesets = new Map();
}

async function withDelegateFallback<T>(
  preferred: 'GPU' | 'CPU' | 'auto',
  create: (delegate: 'GPU' | 'CPU') => Promise<T>,
): Promise<{ instance: T; delegate: 'GPU' | 'CPU' }> {
  if (preferred === 'CPU') return { instance: await create('CPU'), delegate: 'CPU' };
  try {
    return { instance: await create('GPU'), delegate: 'GPU' };
  } catch (err) {
    if (preferred === 'GPU') throw err;
    console.warn('[vision] GPU delegate failed, falling back to CPU', err);
    return { instance: await create('CPU'), delegate: 'CPU' };
  }
}

/** Create a real MediaPipe-backed detector for the given mode using LOCAL assets. */
export async function createDetector(opts: DetectorOptions): Promise<LandmarkDetector> {
  const mp = await loadTasksVision();
  const fileset = await loadFileset(opts.wasmPath ?? DEFAULT_WASM_PATH);
  const preferred = opts.delegate ?? 'auto';
  let lastTs = -1;
  const nextTs = (t: number) => {
    // MediaPipe requires strictly increasing timestamps.
    const ts = t <= lastTs ? lastTs + 1 : t;
    lastTs = ts;
    return ts;
  };

  if (opts.mode === 'leg') {
    const { instance, delegate } = await withDelegateFallback(preferred, (d) =>
      mp.PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: opts.poseModelPath ?? DEFAULT_POSE_MODEL, delegate: d },
        runningMode: 'VIDEO',
        numPoses: 1,
        minPoseDetectionConfidence: opts.minDetectionConfidence ?? 0.5,
        minTrackingConfidence: opts.minTrackingConfidence ?? 0.5,
      }),
    );
    return {
      mode: 'leg',
      delegate,
      detect(frame, timestampMs) {
        const ts = nextTs(timestampMs);
        const res = instance.detectForVideo(frame as Parameters<typeof instance.detectForVideo>[0], ts);
        const pose = res.landmarks.length > 0 ? res.landmarks[0].map(toLandmark) : null;
        const poseWorld = pose && res.worldLandmarks.length > 0 ? res.worldLandmarks[0].map(toLandmark) : null;
        return { tMs: ts, pose, poseWorld, hands: [] };
      },
      close: () => instance.close(),
    };
  }

  const { instance, delegate } = await withDelegateFallback(preferred, (d) =>
    mp.HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: opts.handModelPath ?? DEFAULT_HAND_MODEL, delegate: d },
      runningMode: 'VIDEO',
      numHands: opts.numHands ?? 2,
      minHandDetectionConfidence: opts.minDetectionConfidence ?? 0.5,
      minTrackingConfidence: opts.minTrackingConfidence ?? 0.5,
    }),
  );
  return {
    mode: 'hand',
    delegate,
    detect(frame, timestampMs) {
      const ts = nextTs(timestampMs);
      const res = instance.detectForVideo(frame as Parameters<typeof instance.detectForVideo>[0], ts);
      const hands: HandDetection[] = res.landmarks.map((lms, i) => {
        const cat = res.handedness[i]?.[0];
        return { landmarks: lms.map(toLandmark), label: cat?.categoryName ?? '', score: cat?.score ?? 0 };
      });
      return { tMs: ts, pose: null, hands };
    },
    close: () => instance.close(),
  };
}

function toLandmark(l: { x: number; y: number; z: number; visibility?: number }): Landmark {
  return { x: l.x, y: l.y, z: l.z, visibility: l.visibility };
}

/* ---------------- hand selection ---------------- */

/** Map a MediaPipe handedness label to the patient's side under the mirror convention above. */
export function labelToPatientSide(label: string, mirrored: boolean): Side | null {
  const l = label.toLowerCase();
  if (l !== 'left' && l !== 'right') return null;
  const asLabel: Side = l === 'left' ? 'left' : 'right';
  if (mirrored) return asLabel;
  return asLabel === 'left' ? 'right' : 'left';
}

/**
 * Pick the detected hand belonging to the patient's `side`.
 *  1. Exactly one hand carries a confident, mirror-corrected label of `side`: that hand.
 *  2. Otherwise (no confident label of `side`, or BOTH hands labelled the same side — a common
 *     MediaPipe failure): assign by image position among the candidates, where candidates = the hands
 *     labelled `side` when there are several, else every hand NOT confidently labelled the other side,
 *     else (two hands both labelled the other side) all hands. In a raw stream the patient's right hand
 *     has the smaller wrist x (the larger x when `mirrored`).
 * With two hands the left and right lanes therefore always resolve to DIFFERENT hands, even when the
 * labels are identical or missing.
 */
export function pickHand(hands: readonly HandDetection[], side: Side, mirrored = false, minLabelScore = 0.6): HandDetection | null {
  if (hands.length === 0) return null;
  const other: Side = side === 'left' ? 'right' : 'left';
  const labelOf = (h: HandDetection) => (h.score >= minLabelScore ? labelToPatientSide(h.label, mirrored) : null);
  const mine = hands.filter((h) => labelOf(h) === side);
  if (mine.length === 1) return mine[0];
  let candidates = mine.length > 1 ? mine : hands.filter((h) => labelOf(h) !== other);
  // Every hand labelled the other side: with two hands the labels are unreliable (MediaPipe often
  // gives both the same label) => assign by position; a single hand of the other side is not ours.
  if (candidates.length === 0 && hands.length >= 2) candidates = hands.slice();
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  // Positional assignment.
  const byX = candidates.slice().sort((a, b) => a.landmarks[0].x - b.landmarks[0].x);
  const rightIsSmallX = !mirrored;
  const wantSmallX = side === 'right' ? rightIsSmallX : !rightIsSmallX;
  return wantSmallX ? byX[0] : byX[byX.length - 1];
}

/* ---------------- camera ---------------- */

export interface CameraOptions {
  width?: number;
  height?: number;
  facingMode?: 'user' | 'environment';
  /** Reuse an existing <video>; otherwise one is created (not attached to the DOM). */
  video?: HTMLVideoElement;
  deviceId?: string;
  /** Give up (stopping the acquired tracks) if the video never becomes ready within this time (default 8000 ms). */
  timeoutMs?: number;
}

export interface CameraSession {
  video: HTMLVideoElement;
  stream: MediaStream;
  width: number;
  height: number;
  stop(): void;
}

/** Open the front camera at 640x480 (ideal) and start playing it in a muted, inline <video>. */
export async function openCamera(opts: CameraOptions = {}): Promise<CameraSession> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    throw new Error('Camera not available: getUserMedia unsupported');
  }
  const constraints: MediaStreamConstraints = {
    audio: false,
    video: {
      width: { ideal: opts.width ?? 640 },
      height: { ideal: opts.height ?? 480 },
      facingMode: opts.deviceId ? undefined : (opts.facingMode ?? 'user'),
      deviceId: opts.deviceId ? { exact: opts.deviceId } : undefined,
      frameRate: { ideal: 30 },
    },
  };
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  const video = opts.video ?? document.createElement('video');
  const release = () => {
    for (const t of stream.getTracks()) t.stop();
    video.srcObject = null;
  };
  try {
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    video.srcObject = stream;
    await waitForVideoReady(video, opts.timeoutMs ?? 8000);
    try {
      await video.play();
    } catch {
      /* autoplay may be blocked until a gesture; the loop still runs once playing */
    }
  } catch (err) {
    // Never leave the camera LED on after a failure: stop the acquired tracks before rethrowing.
    release();
    throw err;
  }
  return {
    video,
    stream,
    width: video.videoWidth || (opts.width ?? 640),
    height: video.videoHeight || (opts.height ?? 480),
    stop: release,
  };
}

/** Resolve once the video has metadata (readyState >= 2), reject on error or after `timeoutMs`. */
export function waitForVideoReady(video: HTMLVideoElement, timeoutMs: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (video.readyState >= 2) return resolve();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const cleanup = () => {
      if (timer !== null) clearTimeout(timer);
      video.onloadedmetadata = null;
      video.onerror = null;
    };
    video.onloadedmetadata = () => {
      cleanup();
      resolve();
    };
    video.onerror = () => {
      cleanup();
      reject(new Error('Camera video failed to load'));
    };
    if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
      timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Camera video not ready after ${timeoutMs} ms`));
      }, timeoutMs);
    }
  });
}

/* ---------------- detect loop ---------------- */

export interface LoopStats {
  /** Detection frames per second (EMA). */
  fps: number;
  /** Inference wall time per frame in ms (EMA). */
  inferenceMs: number;
  frames: number;
  /** performance.now() of the last processed frame; 0 if none. */
  lastFrameAt: number;
  running: boolean;
}

export type DetectionCallback = (result: DetectionResult, frameTimeMs: number) => void;

/**
 * Runs detector.detect on every new video frame, using requestVideoFrameCallback when available
 * (frame-accurate, gives capture timestamps) and requestAnimationFrame otherwise (a frame is processed
 * only when video.currentTime advanced). Errors thrown by the detector OR by `onResult` are reported
 * through `onError` and the loop keeps running.
 * `onResult(result, frameTimeMs)`: frameTimeMs is the performance.now()-based capture/presentation time
 * of the frame (best effort), which callers convert to AudioContext time.
 */
export class DetectLoop {
  private readonly video: HTMLVideoElement;
  private readonly detector: LandmarkDetector;
  private readonly onResult: DetectionCallback;
  private handle = 0;
  private usingRvfc = false;
  private running = false;
  private lastMediaTime = -1;
  private stats: LoopStats = { fps: 0, inferenceMs: 0, frames: 0, lastFrameAt: 0, running: false };
  private lastTick = 0;
  onError: ((err: unknown) => void) | null = null;

  constructor(video: HTMLVideoElement, detector: LandmarkDetector, onResult: DetectionCallback) {
    this.video = video;
    this.detector = detector;
    this.onResult = onResult;
  }

  getStats(): LoopStats {
    return { ...this.stats, running: this.running };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.usingRvfc = typeof this.video.requestVideoFrameCallback === 'function';
    this.schedule();
  }

  stop(): void {
    this.running = false;
    if (this.usingRvfc) this.video.cancelVideoFrameCallback(this.handle);
    else if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.handle);
    this.handle = 0;
  }

  private schedule(): void {
    if (!this.running) return;
    if (this.usingRvfc) {
      this.handle = this.video.requestVideoFrameCallback((now, meta) => {
        const frameTime = meta.captureTime ?? meta.presentationTime ?? now;
        try {
          this.step(frameTime, now);
        } finally {
          this.schedule();
        }
      });
    } else {
      const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 16) as unknown as number;
      this.handle = raf((now) => {
        try {
          const mt = this.video.currentTime;
          // Only run inference when the video advanced to a new frame (rAF can outpace the camera).
          if (mt !== this.lastMediaTime && this.video.readyState >= 2) {
            this.lastMediaTime = mt;
            this.step(now, now);
          }
        } finally {
          this.schedule();
        }
      });
    }
  }

  private step(frameTimeMs: number, nowMs: number): void {
    const t0 = performance.now();
    let result: DetectionResult;
    try {
      result = this.detector.detect(this.video, Math.max(0, Math.round(nowMs)));
    } catch (err) {
      this.onError?.(err);
      return;
    }
    const t1 = performance.now();
    const inf = t1 - t0;
    const s = this.stats;
    s.frames++;
    s.inferenceMs = s.frames === 1 ? inf : s.inferenceMs * 0.9 + inf * 0.1;
    if (this.lastTick > 0) {
      const dt = (t1 - this.lastTick) / 1000;
      if (dt > 0) {
        const fps = 1 / dt;
        s.fps = s.fps === 0 ? fps : s.fps * 0.9 + fps * 0.1;
      }
    }
    this.lastTick = t1;
    s.lastFrameAt = t1;
    try {
      this.onResult(result, frameTimeMs);
    } catch (err) {
      // A throwing listener must not kill the loop (the frame callback re-schedules in `finally`).
      this.onError?.(err);
    }
  }
}
