/**
 * MediaPipe tasks-vision wrapper: lazy loader (local wasm + models), camera helper, detect loop.
 *
 * Everything the rest of the app touches is the small `LandmarkDetector` interface, so tests and critics
 * can inject a fake detector instead of the real MediaPipe runtime (see src/input/VisionInput.ts).
 *
 * HANDEDNESS / MIRROR CONVENTION
 * ------------------------------
 * `mirrored` means ONE thing: the frames handed to the detector were horizontally flipped before
 * detection. It is NOT about the preview — the UI usually mirrors that with CSS `scaleX(-1)`, which does
 * not touch the landmarks and does not make `mirrored` true. It has TWO consequences, in two different
 * places, and both matter:
 *
 * 1. HANDS (here). getUserMedia delivers the raw (un-mirrored) sensor image: the patient's RIGHT hand
 *    appears on the image LEFT (small x). MediaPipe's handedness label assumes the input image IS
 *    mirrored (selfie-flipped), so on a RAW stream the label is inverted: label "Left" == patient's
 *    right hand.
 *      mirrored = false (default, raw stream fed to the detector): patient side = opposite of the label.
 *      mirrored = true  (frames flipped BEFORE detection): patient side = label.
 *    `pickHand` also falls back to position (raw: patient's right hand is the one with the smaller x)
 *    when labels are missing/ambiguous.
 *
 * 2. POSE (src/vision/features.ts). The Pose model has no such assumption — it labels the anatomy it
 *    sees. A mirrored human is an ordinary human to it, so on flipped frames the patient's LEFT leg is
 *    reported in the RIGHT_* landmark indices. `poseSideIndices(side, mirrored)` swaps them, and every
 *    leg extractor goes through it; the SIGNED lateral feature (hip_abduction) additionally flips its
 *    outward direction, because image x itself reversed. Note the two models therefore behave
 *    OPPOSITELY on a raw stream (hand labels inverted, pose labels correct) — that asymmetry is real,
 *    documented MediaPipe behaviour, not a bug in either place.
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
  /** Detected hands (hand mode); empty when none. Never more than `MAX_SUBJECT_HANDS`. */
  hands: HandDetection[];
  /**
   * HOW MANY HANDS WERE IN THE PICTURE THAT ONE PERSON CANNOT ACCOUNT FOR — 0 almost always, and the
   * only evidence in this app that somebody other than the patient is in front of the camera.
   *
   * See `MAX_SUBJECT_HANDS`. Absent (rather than 0) when nothing looked: the scripted sources, a
   * replay, a fixture built by hand. Absent must never be read as "nobody else is there".
   */
  extraHands?: number;
}

/**
 * HOW MANY HANDS ONE PERSON HAS, and why this file has to have an opinion about it.
 *
 * The patient is meant to be alone with the tablet, and in a clinic they are routinely not: a carer
 * steadies a shoulder, a therapist reaches across to adjust the chair. `dwellLimbs` (vision/dwell.ts)
 * offers EVERY detected hand as a pointer — deliberately, because either of the patient's own hands
 * may answer a circle — so a hand that is not the patient's can park on a target and complete a hold.
 * The app cannot tell whose hand a hand is from hand landmarks. What it CAN tell, and previously could
 * not, is that there are more hands in the picture than one person has; that is the only honest
 * statement available, and it is the precondition for refusing anything.
 *
 * So the detector asks the model for one hand MORE than the session can use, keeps the ones the
 * session can use, and reports the surplus as a COUNT rather than feeding it to the lanes or the
 * pointer (`extraHandsInFrame`). Everything downstream sees exactly the list it saw before.
 */
export const MAX_SUBJECT_HANDS = 2;

/**
 * Hands in the picture that one person cannot account for. 0 when the frame is unremarkable, and 0
 * for a result that carries no count (a fixture, a replay) — `hasExtraHandCount` is how a caller
 * tells "nobody else is there" from "nothing looked", because the two must not read the same.
 */
export function extraHandsInFrame(result: DetectionResult | null | undefined): number {
  const n = result?.extraHands;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/** True when this result was produced by something that counted the hands in frame at all. */
export function hasExtraHandCount(result: DetectionResult | null | undefined): boolean {
  return typeof result?.extraHands === 'number' && Number.isFinite(result.extraHands);
}

/**
 * TWO HANDS MAY NOT WEAR ONE NAME.
 *
 * MediaPipe commonly labels both detected hands with the same handedness — it is a per-hand
 * classifier with no constraint tying the two together — and every consumer of that label keys off it:
 * `pickHandResult` falls back to image position (which is correct and already documented), but
 * `dwellLimbs` builds its identity key from it (`hand:right`), and two hands sharing one key are
 * SMOOTHED INTO ONE POINTER by `DwellTracker`. A carer's hand and the patient's hand then average into
 * a phantom limb halfway between them, which can sit on a target neither of them is on.
 *
 * A label the model has given to two hands at once does not identify either of them, so the SCORE —
 * which is exactly the "how far do you trust this label" channel, and which every reader of the label
 * already gates on — is dropped to zero for both. Nothing is invented and nothing is asserted: the
 * hands keep their landmarks and their raw labels, they get distinct pointer keys, and they are
 * captioned "a hand" instead of being told to the patient as a side. Lane assignment is unchanged,
 * because two hands labelled the same side already resolved by position.
 *
 * Returns the same array (not a copy) when there is nothing to resolve.
 */
export function resolveHandLabels(hands: readonly HandDetection[]): readonly HandDetection[] {
  if (hands.length < 2) return hands;
  const seen = new Map<string, number>();
  for (const h of hands) {
    const key = h.label.toLowerCase();
    if (key === '') continue;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  let contested = false;
  for (const n of seen.values()) if (n > 1) contested = true;
  if (!contested) return hands;
  return hands.map((h) => ((seen.get(h.label.toLowerCase()) ?? 0) > 1 ? { ...h, score: 0 } : h));
}

/** Anything MediaPipe accepts as an image source; kept loose so fakes can pass anything. */
export type FrameSource = HTMLVideoElement | HTMLImageElement | HTMLCanvasElement | ImageBitmap | ImageData | OffscreenCanvas | VideoFrame;

export interface LandmarkDetector {
  readonly mode: Mode;
  /** Backend actually in use. */
  readonly delegate: 'GPU' | 'CPU';
  /**
   * True while the detector is swapping backends (GPU inference failed, the CPU task is being built).
   * detect() returns EMPTY results for these frames, which downstream would otherwise report to the
   * patient as "no person detected — sit facing the camera": honest about the landmarks, a lie about
   * the cause, and it asks them to move when moving cannot help. Consumers surface this as 'recovering'.
   */
  readonly recovering?: boolean;
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
  /**
   * How many hands the SESSION can use — never more than `MAX_SUBJECT_HANDS`, and the model is asked
   * for one more than this so a third hand in the picture can be seen and reported rather than
   * silently displacing one of the patient's (see `MAX_SUBJECT_HANDS`). The surplus never reaches the
   * result's `hands`.
   */
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

/** The minimum a MediaPipe task instance has to look like for `buildDetector`. */
interface VideoTask<R> {
  detectForVideo(frame: never, timestampMs: number): R;
  close(): void;
}

/**
 * Wrap a created task instance as a LandmarkDetector, with a ONE-SHOT GPU -> CPU recovery.
 *
 * WHY THE SECOND FALLBACK: `withDelegateFallback` only covers creation. MediaPipe on a clinic laptop with
 * a broken/blocklisted WebGL stack routinely CREATES a GPU landmarker successfully and then throws on the
 * first `detectForVideo`. Without this, that path surfaces as a permanent 'error' status (DetectLoop
 * reports every frame's throw) and the session is dead. Here the first GPU inference failure re-creates
 * the task on CPU in the background; frames during the swap return "nothing detected" (the lanes read
 * 'not tracking' — honest, and no unearned hits), and `delegate` flips to 'CPU' once it is live. If the
 * CPU re-creation ALSO fails, the failure is rethrown from every subsequent detect: loudly dead, never a
 * frozen meter under a green OK.
 */
function buildDetector<R>(cfg: {
  mode: Mode;
  instance: VideoTask<R>;
  delegate: 'GPU' | 'CPU';
  /** null when no CPU retry is allowed (delegate was pinned to 'GPU'). */
  createCpu: (() => Promise<VideoTask<R>>) | null;
  map: (res: R, ts: number) => DetectionResult;
  empty: (ts: number) => DetectionResult;
}): LandmarkDetector {
  let instance = cfg.instance;
  let delegate = cfg.delegate;
  let closed = false;
  let recovering = false;
  let fallbackUsed = delegate === 'CPU' || cfg.createCpu === null;
  let fatal: unknown = null;
  let lastTs = -1;
  const nextTs = (t: number) => {
    // MediaPipe requires strictly increasing timestamps.
    const ts = t <= lastTs ? lastTs + 1 : t;
    lastTs = ts;
    return ts;
  };
  return {
    mode: cfg.mode,
    get delegate() {
      return delegate;
    },
    get recovering() {
      return recovering;
    },
    detect(frame, timestampMs) {
      if (fatal) throw fatal;
      const ts = nextTs(timestampMs);
      if (recovering) return cfg.empty(ts);
      try {
        return cfg.map(instance.detectForVideo(frame as never, ts), ts);
      } catch (err) {
        if (fallbackUsed || closed || !cfg.createCpu) throw err;
        fallbackUsed = true;
        recovering = true;
        console.warn('[vision] GPU inference failed, re-creating the detector on CPU', err);
        const dying = instance;
        void cfg.createCpu().then(
          (inst) => {
            try {
              dying.close();
            } catch {
              /* the GPU task is already broken; its close() may throw too */
            }
            if (closed) {
              inst.close();
              return;
            }
            instance = inst;
            delegate = 'CPU';
            recovering = false;
          },
          (e) => {
            fatal = e;
            recovering = false;
          },
        );
        return cfg.empty(ts);
      }
    },
    close() {
      closed = true;
      instance.close();
    },
  };
}

/** Create a real MediaPipe-backed detector for the given mode using LOCAL assets. */
export async function createDetector(opts: DetectorOptions): Promise<LandmarkDetector> {
  const mp = await loadTasksVision();
  const fileset = await loadFileset(opts.wasmPath ?? DEFAULT_WASM_PATH);
  const preferred = opts.delegate ?? 'auto';

  if (opts.mode === 'leg') {
    const createPose = (d: 'GPU' | 'CPU') =>
      mp.PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: opts.poseModelPath ?? DEFAULT_POSE_MODEL, delegate: d },
        runningMode: 'VIDEO',
        numPoses: 1,
        minPoseDetectionConfidence: opts.minDetectionConfidence ?? 0.5,
        minTrackingConfidence: opts.minTrackingConfidence ?? 0.5,
      });
    const { instance, delegate } = await withDelegateFallback(preferred, createPose);
    type PoseResult = ReturnType<typeof instance.detectForVideo>;
    return buildDetector<PoseResult>({
      mode: 'leg',
      instance: instance as unknown as VideoTask<PoseResult>,
      delegate,
      createCpu: preferred === 'GPU' ? null : () => createPose('CPU') as unknown as Promise<VideoTask<PoseResult>>,
      map: (res, ts) => {
        const pose = res.landmarks.length > 0 ? res.landmarks[0].map(toLandmark) : null;
        const poseWorld = pose && res.worldLandmarks.length > 0 ? res.worldLandmarks[0].map(toLandmark) : null;
        // `numPoses: 1` — one subject, so a carer in frame cannot add a limb here; they can only
        // BECOME the subject, which is what VisionInput's subject-continuity guard is for.
        return { tMs: ts, pose, poseWorld, hands: [], extraHands: 0 };
      },
      empty: (ts) => ({ tMs: ts, pose: null, poseWorld: null, hands: [], extraHands: 0 }),
    });
  }

  const createHand = (d: 'GPU' | 'CPU') =>
    mp.HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: opts.handModelPath ?? DEFAULT_HAND_MODEL, delegate: d },
      runningMode: 'VIDEO',
      // ONE MORE THAN THE SESSION CAN USE. See `MAX_SUBJECT_HANDS`: the extra slot is not for the
      // patient, it is so a hand that is nobody's business being there is VISIBLE to the app instead
      // of taking a patient's hand's place in a list of two. It costs a landmark pass only on the
      // frames a third hand is actually in, and the surplus is dropped before anything downstream
      // (features, lanes, the dwell pointer) can read it.
      numHands: Math.min(MAX_SUBJECT_HANDS, Math.max(1, Math.round(opts.numHands ?? MAX_SUBJECT_HANDS))) + 1,
      minHandDetectionConfidence: opts.minDetectionConfidence ?? 0.5,
      minTrackingConfidence: opts.minTrackingConfidence ?? 0.5,
    });
  const { instance, delegate } = await withDelegateFallback(preferred, createHand);
  type HandResult = ReturnType<typeof instance.detectForVideo>;
  return buildDetector<HandResult>({
    mode: 'hand',
    instance: instance as unknown as VideoTask<HandResult>,
    delegate,
    createCpu: preferred === 'GPU' ? null : () => createHand('CPU') as unknown as Promise<VideoTask<HandResult>>,
    map: (res, ts) => {
      const all: HandDetection[] = res.landmarks.map((lms, i) => {
        const cat = res.handedness[i]?.[0];
        return { landmarks: lms.map(toLandmark), label: cat?.categoryName ?? '', score: cat?.score ?? 0 };
      });
      // THE SURPLUS IS COUNTED, NOT PASSED ON. Which of three hands belongs to the patient is not
      // something hand landmarks can answer, so nothing here guesses: the list handed downstream is
      // the model's own first `MAX_SUBJECT_HANDS`, i.e. exactly what a two-hand request would have
      // returned, and the fact that there was a third is reported so the screens can say so and can
      // refuse the one confirm that cannot be taken back.
      const hands = [...resolveHandLabels(all.slice(0, MAX_SUBJECT_HANDS))];
      return { tMs: ts, pose: null, hands, extraHands: Math.max(0, all.length - MAX_SUBJECT_HANDS) };
    },
    empty: (ts) => ({ tMs: ts, pose: null, hands: [], extraHands: 0 }),
  });
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

export interface PickHandOptions {
  /** Handedness score at which a MediaPipe label is trusted (default 0.6). */
  minLabelScore?: number;
  /**
   * Accept the ONLY hand in frame even without a confident label. Default false.
   *
   * The lone-hand safety rule below exists for BILATERAL sessions. In a UNILATERAL session (every lane
   * on one side — the standard stroke prescription) there is no second lane to steal from and no
   * ambiguity to protect against, so refusing the lone hand only locks the patient out of their own
   * session. Handedness confidence is exactly what degrades in the fingers-at-the-camera posture that
   * wrist_extension requires, which makes that lockout likely rather than hypothetical. VisionInput
   * turns this on automatically when all its lanes share one side.
   * It never applies with two hands in frame: there the position rule is meaningful and is used instead.
   *
   * It is NOT a blank cheque: the lone hand must still be WEAKLY CONSISTENT with `side` (see
   * `ambiguousLabelScore`). The danger a unilateral session still has is not lane-to-lane theft, it is
   * the UNAFFECTED hand wandering into frame and driving the affected limb's lane — which inflates
   * exactly the rep count and ROM trend the therapist is treating from.
   */
  acceptLoneHand?: boolean;
  /**
   * Score at or below which a handedness label carries NO information (default 0.55). MediaPipe reports
   * the winning class probability, so a score near 0.5 is a coin flip and the label may as well be
   * absent — that is the case `acceptLoneHand` exists for. Above it the label is weak but not noise, and
   * a lone hand labelled the OTHER side is refused rather than scored as the prescribed limb.
   */
  ambiguousLabelScore?: number;
}

/** How `pickHandResult` arrived at its answer — VisionInput reports the weak cases to the therapist. */
export type HandPickSource =
  /** A confident, mirror-corrected handedness label of the requested side. */
  | 'label'
  /** Two hands in frame: assigned by image position (labels absent, unusable, or both the same). */
  | 'position'
  /** The lone hand in a unilateral session, accepted on a label too weak to identify it. See below. */
  | 'lone_unlabelled'
  /** No hand could be assigned to this side. */
  | 'none';

export interface HandPick {
  hand: HandDetection | null;
  source: HandPickSource;
}

/** Default `PickHandOptions.ambiguousLabelScore`: at or below this a handedness label is a coin flip. */
export const DEFAULT_AMBIGUOUS_LABEL_SCORE = 0.55;

const NO_HAND: HandPick = Object.freeze({ hand: null, source: 'none' }) as HandPick;

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
 *
 * A SINGLE hand with no usable label (score below `minLabelScore`) is returned for NEITHER side: image
 * position cannot tell which hand it is when there is nothing to compare it against, and in a bilateral
 * session (affected + unaffected side, a very common prescription) handing it to both lanes would let
 * the good hand score the affected hand's lane. Returning null surfaces as 'hand_missing' instead.
 * `opts.acceptLoneHand` is the documented escape hatch for a unilateral session.
 */
export function pickHand(hands: readonly HandDetection[], side: Side, mirrored = false, opts: PickHandOptions = {}): HandDetection | null {
  return pickHandResult(hands, side, mirrored, opts).hand;
}

/**
 * `pickHand` plus HOW the hand was chosen, so a caller can tell the therapist when a lane is being
 * driven by a hand nobody could identify (`source: 'lone_unlabelled'`).
 */
export function pickHandResult(hands: readonly HandDetection[], side: Side, mirrored = false, opts: PickHandOptions = {}): HandPick {
  if (hands.length === 0) return NO_HAND;
  const minLabelScore = opts.minLabelScore ?? 0.6;
  const ambiguousScore = opts.ambiguousLabelScore ?? DEFAULT_AMBIGUOUS_LABEL_SCORE;
  const other: Side = side === 'left' ? 'right' : 'left';
  const labelOf = (h: HandDetection) => (h.score >= minLabelScore ? labelToPatientSide(h.label, mirrored) : null);
  // Unilateral escape hatch: one hand in frame, no lane on the other side to protect.
  if (hands.length === 1 && opts.acceptLoneHand) {
    const h = hands[0];
    const confident = labelOf(h);
    if (confident === side) return { hand: h, source: 'label' };
    if (confident === other) return NO_HAND;
    // No CONFIDENT label. Fall back to the raw one anyway: the escape hatch exists because the score
    // sags in the postures this app asks for, not because the label becomes wrong. It is refused only
    // when it still points weakly at the OTHER hand — a lone hand that the classifier calls "Left" at
    // 0.59 is far more likely to be the patient's unaffected hand drifting into frame than the affected
    // one it is being asked to score. Only a genuine coin flip (<= ambiguousLabelScore) is accepted, and
    // then the caller is told the hand is unidentified.
    if (h.score > ambiguousScore && labelToPatientSide(h.label, mirrored) === other) return NO_HAND;
    return { hand: h, source: 'lone_unlabelled' };
  }
  const mine = hands.filter((h) => labelOf(h) === side);
  if (mine.length === 1) return { hand: mine[0], source: 'label' };
  let candidates = mine.length > 1 ? mine : hands.filter((h) => labelOf(h) !== other);
  // Every hand labelled the other side: with two hands the labels are unreliable (MediaPipe often
  // gives both the same label) => assign by position; a single hand of the other side is not ours.
  if (candidates.length === 0 && hands.length >= 2) candidates = hands.slice();
  if (candidates.length === 0) return NO_HAND;
  // Only one hand in the frame and no confident label: unassignable (see above).
  if (hands.length === 1) return labelOf(hands[0]) === side ? { hand: hands[0], source: 'label' } : NO_HAND;
  if (candidates.length === 1) return { hand: candidates[0], source: 'position' };
  // Positional assignment.
  const byX = candidates.slice().sort((a, b) => a.landmarks[0].x - b.landmarks[0].x);
  const rightIsSmallX = !mirrored;
  const wantSmallX = side === 'right' ? rightIsSmallX : !rightIsSmallX;
  return { hand: wantSmallX ? byX[0] : byX[byX.length - 1], source: 'position' };
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
  /**
   * True once a video track of the stream fired 'ended' (device unplugged, permission revoked, another
   * app grabbed the camera, OS sleep). Frames stop arriving without any error being thrown, so the
   * runtime must watch this instead of assuming the last frame's verdict still holds.
   */
  ended?: boolean;
  /** Set by the consumer: called when a video track ends (see `ended`). */
  onEnded?: (() => void) | null;
  stop(): void;
}

/** Open the front camera at 640x480 (ideal) and start playing it in a muted, inline <video>. */
export async function openCamera(opts: CameraOptions = {}): Promise<CameraSession> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    throw new Error('Camera not available: getUserMedia unsupported');
  }
  const wantW = opts.width ?? 640;
  const wantH = opts.height ?? 480;
  const constraints: MediaStreamConstraints = {
    audio: false,
    video: {
      width: { ideal: wantW },
      height: { ideal: wantH },
      // Only an IDEAL: most laptop sensors are natively 16:9 and would be letterboxed or refused by an
      // exact 4:3. Whatever the browser actually hands back, the session reports the true videoWidth /
      // videoHeight below and the features correct for it (FeatureOptions.xScale) — the aspect ratio
      // must never silently rescale the movement measurements.
      aspectRatio: { ideal: wantW / wantH },
      facingMode: opts.deviceId ? undefined : (opts.facingMode ?? 'user'),
      deviceId: opts.deviceId ? { exact: opts.deviceId } : undefined,
      // Cap as well as prefer: a 60 fps sensor doubles the main-thread inference cost for no extra
      // timing resolution (DetectLoop also enforces its own cap, since `max` is only a request).
      frameRate: { ideal: 30, max: 60 },
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
  const session: CameraSession = {
    video,
    stream,
    width: video.videoWidth || (opts.width ?? 640),
    height: video.videoHeight || (opts.height ?? 480),
    ended: false,
    onEnded: null,
    stop: release,
  };
  // A track that ends (unplug / revoked permission / stolen device) simply stops delivering frames.
  // Surface it so the runtime can show "not tracking" instead of a frozen meter under a green OK.
  const tracks = typeof stream.getVideoTracks === 'function' ? stream.getVideoTracks() : stream.getTracks();
  for (const t of tracks) {
    t.addEventListener?.('ended', () => {
      session.ended = true;
      session.onEnded?.();
    });
  }
  return session;
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
  /** Video frames deliberately skipped by the rate cap / adaptive budget (see DetectLoopOptions). */
  skipped?: number;
}

export type DetectionCallback = (result: DetectionResult, frameTimeMs: number) => void;

/**
 * Detection rate below which the engine's ±50 ms "perfect" window stops being reachable: at N fps a
 * crossing is localized to a frame interval of 1/N s, and even with the trigger's sub-frame
 * interpolation the residual error is a good fraction of that. At 15 fps (67 ms between frames) the
 * hardest difficulty's perfect window is already gone. Reported, not enforced — a patient must be told
 * their laptop cannot keep up, rather than silently missing every note.
 */
export const MIN_USABLE_DETECT_FPS = 15;

/** Default inference rate cap: just above the 30 fps the camera is asked for (see DetectLoopOptions). */
export const DEFAULT_MAX_DETECT_HZ = 32;

export interface DetectLoopOptions {
  /**
   * Hard cap on inferences per second (default 32 — just above the 30 fps the camera is asked for, so
   * ordinary frame jitter is not clipped). Video frames arriving faster are dropped without running
   * inference: the camera is only asked for `ideal: 30`, and a 60 fps webcam that ignores that would
   * otherwise double the main-thread cost of the whole session for no extra timing resolution.
   * The cap is measured on the frames' own capture/presentation clock, not on wall time.
   */
  maxDetectHz?: number;
  /**
   * Adaptive skip (default true). MediaPipe's detectForVideo runs SYNCHRONOUSLY on the main thread —
   * the same thread that draws the note highway — so a 30-60 ms pose inference on the CPU delegate (the
   * documented clinic-laptop path) stalls the highway for that long every single frame. When an
   * inference overruns `budgetMs`, the loop waits out the overrun before the next one, so inference
   * duty-cycles down to roughly the budget and the renderer keeps its slice. Bounded by `minDetectHz`
   * so the input never degrades below a usable rate.
   */
  adaptiveSkip?: boolean;
  /** Main-thread time per frame inference may take before the adaptive skip kicks in (default: half the cap's period). */
  budgetMs?: number;
  /** Floor for the adaptive skip (default 12 Hz): inference is never throttled below this. */
  minDetectHz?: number;
}

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
  /**
   * How the pending callback was scheduled, so stop() can actually cancel IT.
   *
   * The rAF branch falls back to setTimeout when requestAnimationFrame does not exist — and the old
   * stop() only ever called cancelAnimationFrame, guarded by `typeof cancelAnimationFrame === 'function'`,
   * which is false in exactly the environment that took the fallback. The `if (!this.running) return`
   * guard kept the stray callback harmless, but one timer kept firing per stopped loop for the life of
   * the page.
   */
  private pending: 'none' | 'rvfc' | 'raf' | 'timeout' = 'none';
  private usingRvfc = false;
  private running = false;
  private lastMediaTime = -1;
  private stats: LoopStats = { fps: 0, inferenceMs: 0, frames: 0, lastFrameAt: 0, running: false, skipped: 0 };
  private lastTick = 0;
  /** Rate cap / adaptive budget: no inference before this frame time. */
  private nextDetectAtMs = -Infinity;
  private readonly minPeriodMs: number;
  private readonly maxPeriodMs: number;
  private readonly budgetMs: number;
  private readonly adaptive: boolean;
  onError: ((err: unknown) => void) | null = null;

  constructor(video: HTMLVideoElement, detector: LandmarkDetector, onResult: DetectionCallback, opts: DetectLoopOptions = {}) {
    this.video = video;
    this.detector = detector;
    this.onResult = onResult;
    const maxHz = opts.maxDetectHz && opts.maxDetectHz > 0 ? opts.maxDetectHz : DEFAULT_MAX_DETECT_HZ;
    const minHz = opts.minDetectHz && opts.minDetectHz > 0 ? Math.min(opts.minDetectHz, maxHz) : Math.min(12, maxHz);
    this.minPeriodMs = 1000 / maxHz;
    this.maxPeriodMs = 1000 / minHz;
    this.budgetMs = opts.budgetMs !== undefined && opts.budgetMs > 0 ? opts.budgetMs : this.minPeriodMs / 2;
    this.adaptive = opts.adaptiveSkip !== false;
  }

  getStats(): LoopStats {
    return { ...this.stats, running: this.running };
  }

  /** True when the last inference blew the main-thread budget and the loop is duty-cycling it down. */
  isThrottled(): boolean {
    return this.adaptive && this.stats.inferenceMs > this.budgetMs;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.nextDetectAtMs = -Infinity;
    this.usingRvfc = typeof this.video.requestVideoFrameCallback === 'function';
    this.schedule();
  }

  stop(): void {
    this.running = false;
    // Cancel with the SAME mechanism that scheduled the pending callback.
    if (this.pending === 'rvfc') this.video.cancelVideoFrameCallback?.(this.handle);
    else if (this.pending === 'raf' && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(this.handle);
    else if (this.pending === 'timeout') clearTimeout(this.handle);
    this.pending = 'none';
    this.handle = 0;
  }

  private schedule(): void {
    if (!this.running) return;
    if (this.usingRvfc) {
      this.pending = 'rvfc';
      this.handle = this.video.requestVideoFrameCallback((now, meta) => {
        // A callback dispatched BEFORE stop() still fires after it. Without this guard it would call
        // detector.detect() on a MediaPipe task VisionInput.stop() has already close()d, and calling
        // into a deleted wasm task can abort the runtime outright rather than throw — taking the whole
        // page's vision stack with it.
        if (!this.running) return;
        const frameTime = meta.captureTime ?? meta.presentationTime ?? now;
        try {
          this.maybeStep(frameTime);
        } finally {
          this.schedule();
        }
      });
    } else {
      const hasRaf = typeof requestAnimationFrame === 'function';
      const raf = hasRaf ? requestAnimationFrame : (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 16) as unknown as number;
      this.pending = hasRaf ? 'raf' : 'timeout';
      this.handle = raf((now) => {
        if (!this.running) return; // same post-stop() guard as above
        try {
          const mt = this.video.currentTime;
          // Only run inference when the video advanced to a new frame (rAF can outpace the camera).
          if (mt !== this.lastMediaTime && this.video.readyState >= 2) {
            this.lastMediaTime = mt;
            this.maybeStep(now);
          }
        } finally {
          this.schedule();
        }
      });
    }
  }

  /** Rate cap + adaptive main-thread budget (see DetectLoopOptions); skipped frames are counted. */
  private maybeStep(frameTimeMs: number): void {
    if (frameTimeMs < this.nextDetectAtMs) {
      this.stats.skipped = (this.stats.skipped ?? 0) + 1;
      return;
    }
    this.step(frameTimeMs);
  }

  private step(frameTimeMs: number): void {
    const t0 = performance.now();
    let result: DetectionResult;
    try {
      // The MediaPipe timestamp is the frame's CAPTURE time, the same clock the engine is judged
      // against — not the callback's wall time, which leads capture by a variable 10-30 ms under load
      // and would desync the tracker's internal temporal filtering from our timing. (createDetector
      // still enforces strict monotonicity.)
      result = this.detector.detect(this.video, Math.max(0, Math.round(frameTimeMs)));
    } catch (err) {
      // Still charge the rate cap: a detector that throws in 40 ms would otherwise be retried on every
      // single video frame, which is the same main-thread stall with none of the benefit.
      this.chargeBudget(frameTimeMs, performance.now() - t0);
      this.onError?.(err);
      return;
    }
    const t1 = performance.now();
    const inf = t1 - t0;
    this.chargeBudget(frameTimeMs, inf);
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

  /**
   * Set the earliest frame time of the next inference: at least the rate cap's period, plus (when
   * adaptive) the amount by which this inference overran the main-thread budget, so a slow CPU-delegate
   * inference yields the thread back to the renderer instead of monopolising every frame. Capped at
   * `maxPeriodMs` so the detection rate never collapses.
   */
  private chargeBudget(frameTimeMs: number, inferenceMs: number): void {
    let period = this.minPeriodMs;
    if (this.adaptive && inferenceMs > this.budgetMs) period = Math.min(this.maxPeriodMs, period + (inferenceMs - this.budgetMs));
    this.nextDetectAtMs = frameTimeMs + period;
  }
}
