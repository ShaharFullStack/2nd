/**
 * Per-movement feature extractors (docs/ARCHITECTURE.md "Movement feature extraction").
 * Every extractor: feature(landmarks, side, opts?) -> number | null (null when landmarks missing / low
 * visibility). All features are oriented so that MORE movement => LARGER value (higherIsMore = true).
 *
 * LEG extractors take the 33 Pose landmarks. Ratio features (seated_march, hip_abduction) are image-plane
 * only. Angle features (knee_extension, ankle_dorsiflexion) need depth because a seated, camera-facing
 * patient's thigh is foreshortened in the image plane: pass MediaPipe's metric `worldLandmarks` via
 * `opts.worldLandmarks` (preferred; image-space z is the noisiest coordinate) — they fall back to the
 * image landmarks' z when absent. Visibility is always gated on the image landmarks.
 * HAND extractors take the 21 landmarks of the ALREADY-SELECTED hand (side is used only for symmetry);
 * hand selection by side happens in src/vision/mediapipe.ts / VisionInput. They use x/y only (Hand z
 * is a low-fidelity relative depth) and are position- and scale-invariant.
 */
import type { Mode, Movement, Side } from '../engine/types.ts';
import {
  HAND, POSE, FINGERTIP_INDEX, allVisible, angleAtJoint, angleBetween2d, distance, distance2d, midpoint, sub, palmSize, palmSize2d, palmWidth2d,
} from './landmarks.ts';
import type { Fingertip, Landmark } from './landmarks.ts';
import type { LaneFilterSpec } from './filters.ts';
import { median } from './stats.ts';

export interface FeatureOptions {
  /** finger_opposition: which fingertip opposes the thumb (default 'index'). */
  fingertip?: Fingertip;
  /** Minimum pose visibility (default MIN_VISIBILITY). */
  minVisibility?: number;
  /** Pose world landmarks (metres, hip-centred) for the same frame; used by the 3D angle features. */
  worldLandmarks?: readonly Landmark[] | null;
}

export type FeatureExtractor = (landmarks: readonly Landmark[] | null | undefined, side: Side, opts?: FeatureOptions) => number | null;

function poseIdx(side: Side) {
  return side === 'left'
    ? { shoulder: POSE.LEFT_SHOULDER, hip: POSE.LEFT_HIP, knee: POSE.LEFT_KNEE, ankle: POSE.LEFT_ANKLE, heel: POSE.LEFT_HEEL, foot: POSE.LEFT_FOOT_INDEX }
    : { shoulder: POSE.RIGHT_SHOULDER, hip: POSE.RIGHT_HIP, knee: POSE.RIGHT_KNEE, ankle: POSE.RIGHT_ANKLE, heel: POSE.RIGHT_HEEL, foot: POSE.RIGHT_FOOT_INDEX };
}

const TORSO_IDX = [POSE.LEFT_SHOULDER, POSE.RIGHT_SHOULDER, POSE.LEFT_HIP, POSE.RIGHT_HIP];

/** Torso length in image units: mid-shoulder to mid-hip (image plane). null if not visible or degenerate. */
export function torsoLength(pose: readonly Landmark[] | null | undefined, minVisibility?: number): number | null {
  if (!allVisible(pose, TORSO_IDX, minVisibility)) return null;
  const p = pose as readonly Landmark[];
  const len = distance2d(midpoint(p[POSE.LEFT_SHOULDER], p[POSE.RIGHT_SHOULDER]), midpoint(p[POSE.LEFT_HIP], p[POSE.RIGHT_HIP]));
  return len > 1e-4 ? len : null;
}

/** The landmark set used for 3D angles: world landmarks when supplied (and complete), else image landmarks. */
function angleSource(pose: readonly Landmark[], opts: FeatureOptions | undefined, indices: readonly number[]): readonly Landmark[] {
  const w = opts?.worldLandmarks;
  if (w && allVisible(w, indices, -Infinity)) return w;
  return pose;
}

/** seated_march: knee height above hip normalized by torso length. (hip.y - knee.y)/torsoLen */
export const seatedMarch: FeatureExtractor = (pose, side, opts) => {
  const i = poseIdx(side);
  if (!allVisible(pose, [i.hip, i.knee], opts?.minVisibility)) return null;
  const torso = torsoLength(pose, opts?.minVisibility);
  if (torso === null) return null;
  const p = pose as readonly Landmark[];
  return (p[i.hip].y - p[i.knee].y) / torso;
};

/** knee_extension: interior angle hip-knee-ankle in degrees (90 = bent, 180 = straight). 3D (world landmarks preferred). */
export const kneeExtension: FeatureExtractor = (pose, side, opts) => {
  const i = poseIdx(side);
  const idx = [i.hip, i.knee, i.ankle];
  if (!allVisible(pose, idx, opts?.minVisibility)) return null;
  const p = angleSource(pose as readonly Landmark[], opts, idx);
  return angleAtJoint(p[i.hip], p[i.knee], p[i.ankle]);
};

/**
 * ankle_dorsiflexion: 180 - (interior angle at the ankle between ankle->knee and ankle->foot_index).
 * Rest ~ 90 (foot flat, shin vertical); toes lifted => angle shrinks => feature grows. 3D (world landmarks preferred).
 */
export const ankleDorsiflexion: FeatureExtractor = (pose, side, opts) => {
  const i = poseIdx(side);
  const idx = [i.knee, i.ankle, i.foot];
  if (!allVisible(pose, idx, opts?.minVisibility)) return null;
  const p = angleSource(pose as readonly Landmark[], opts, idx);
  return 180 - angleAtJoint(p[i.knee], p[i.ankle], p[i.foot]);
};

/** hip_abduction: lateral knee displacement from the hip, |knee.x - hip.x| / torsoLen. */
export const hipAbduction: FeatureExtractor = (pose, side, opts) => {
  const i = poseIdx(side);
  if (!allVisible(pose, [i.hip, i.knee], opts?.minVisibility)) return null;
  const torso = torsoLength(pose, opts?.minVisibility);
  if (torso === null) return null;
  const p = pose as readonly Landmark[];
  return Math.abs(p[i.knee].x - p[i.hip].x) / torso;
};

const FINGER_TIPS = [HAND.INDEX_TIP, HAND.MIDDLE_TIP, HAND.RING_TIP, HAND.PINKY_TIP];
const HAND_ALL = Array.from({ length: 21 }, (_, k) => k);

function handOk(hand: readonly Landmark[] | null | undefined): hand is readonly Landmark[] {
  // Hand landmarks carry no meaningful visibility: only presence/finiteness is checked.
  return allVisible(hand, HAND_ALL, -Infinity) && palmSize(hand as readonly Landmark[]) > 1e-4 && palmSize2d(hand as readonly Landmark[]) > 1e-4;
}

/** hand_open_close: mean (index..pinky fingertip -> wrist image distance) / palm size (2D). Open => larger. */
export const handOpenClose: FeatureExtractor = (hand) => {
  if (!handOk(hand)) return null;
  const ps = palmSize2d(hand);
  let sum = 0;
  for (const t of FINGER_TIPS) sum += distance2d(hand[t], hand[HAND.WRIST]);
  return sum / FINGER_TIPS.length / ps;
};

/**
 * wrist_extension: elevation of the hand about the wrist. Setup: forearm resting on the table, hand over
 * the edge, fingers toward the camera (rest = hand hanging level/slightly down); extension rotates the
 * hand up about the wrist so the knuckles rise ABOVE the wrist.
 *   feature = (wrist.y - middle_mcp.y) / palmWidth   (image y grows downward => knuckles up => positive)
 * palmWidth (index MCP -> pinky MCP, 2D) lies on the extension axis so it does not foreshorten during the
 * movement; the feature is invariant to whole-arm translation and camera distance, so lifting the
 * forearm/elbow (the compensation) does not score.
 */
export const wristExtension: FeatureExtractor = (hand) => {
  if (!handOk(hand)) return null;
  const width = palmWidth2d(hand);
  if (width < 1e-4) return null;
  return (hand[HAND.WRIST].y - hand[HAND.MIDDLE_MCP].y) / width;
};

/** finger_opposition: 1 - (thumb_tip -> chosen fingertip image distance / palm size 2D). Pinch => larger. */
export const fingerOpposition: FeatureExtractor = (hand, _side, opts) => {
  if (!handOk(hand)) return null;
  const tip = FINGERTIP_INDEX[opts?.fingertip ?? 'index'];
  return 1 - distance2d(hand[HAND.THUMB_TIP], hand[tip]) / palmSize2d(hand);
};

/** finger_spread: 2D angle (degrees) between index MCP->tip and pinky MCP->tip vectors. Spread => larger. */
export const fingerSpread: FeatureExtractor = (hand) => {
  if (!handOk(hand)) return null;
  return angleBetween2d(sub(hand[HAND.INDEX_TIP], hand[HAND.INDEX_MCP]), sub(hand[HAND.PINKY_TIP], hand[HAND.PINKY_MCP]));
};

export const EXTRACTORS: Readonly<Record<Movement, FeatureExtractor>> = Object.freeze({
  seated_march: seatedMarch,
  knee_extension: kneeExtension,
  ankle_dorsiflexion: ankleDorsiflexion,
  hip_abduction: hipAbduction,
  hand_open_close: handOpenClose,
  wrist_extension: wristExtension,
  finger_opposition: fingerOpposition,
  finger_spread: fingerSpread,
});

/** Convenience: extract the feature for `movement`. */
export function extractFeature(movement: Movement, landmarks: readonly Landmark[] | null | undefined, side: Side, opts?: FeatureOptions): number | null {
  return EXTRACTORS[movement](landmarks, side, opts);
}

/* ---------------- compensation checks ---------------- */

export type CompensationKind = 'heel_lift' | 'trunk_lean';

/**
 * One frame's raw compensation quantities (before comparing with a baseline):
 *   heel_lift : value = heel.y (image), scale = shin length knee->ankle (image)
 *   trunk_lean: value = trunk tilt from vertical in degrees, scale = 1
 * The calibrator accumulates these over the rest phase and takes medians (see baselineFromSamples).
 */
export interface CompensationSample { kind: CompensationKind; value: number; scale: number; }

/** Rest baseline so compensation can be measured relative to the patient's own posture. */
export interface CompensationBaseline {
  kind: CompensationKind;
  /** heel_lift: rest heel.y; trunk_lean: rest trunk tilt in degrees from vertical. */
  value: number;
  /** heel_lift: shin length at rest (knee->ankle) used as the scale. */
  scale: number;
  /** Number of rest frames the baseline was taken from (1 = single frame). */
  samples?: number;
}

export interface CompensationResult {
  kind: CompensationKind;
  /** Normalized magnitude: heel_lift = rise / shinLen; trunk_lean = extra tilt in degrees. */
  value: number;
  /** Tolerance the value is compared against. */
  tolerance: number;
  flagged: boolean;
}

/** Heel rise > this fraction of the shin length flags ankle_dorsiflexion reps. */
export const HEEL_LIFT_TOLERANCE = 0.12;
/** Extra lateral trunk tilt (degrees beyond the rest tilt) that flags seated_march reps. */
export const TRUNK_LEAN_TOLERANCE_DEG = 12;

/** Which compensation (if any) is monitored for a movement. */
export function compensationKind(movement: Movement): CompensationKind | null {
  if (movement === 'ankle_dorsiflexion') return 'heel_lift';
  if (movement === 'seated_march') return 'trunk_lean';
  return null;
}

/** Trunk tilt from vertical (degrees) of the hip-mid -> shoulder-mid vector, image plane. */
export function trunkTiltDeg(pose: readonly Landmark[] | null | undefined, minVisibility?: number): number | null {
  if (!allVisible(pose, TORSO_IDX, minVisibility)) return null;
  const p = pose as readonly Landmark[];
  const up = sub(midpoint(p[POSE.LEFT_SHOULDER], p[POSE.RIGHT_SHOULDER]), midpoint(p[POSE.LEFT_HIP], p[POSE.RIGHT_HIP]));
  return angleBetween2d(up, { x: 0, y: -1, z: 0 });
}

/** Measure this frame's raw compensation quantities for the movement (null: not applicable / not visible). */
export function measureCompensation(movement: Movement, pose: readonly Landmark[] | null | undefined, side: Side, opts?: FeatureOptions): CompensationSample | null {
  const kind = compensationKind(movement);
  if (!kind || !pose) return null;
  if (kind === 'heel_lift') {
    const i = poseIdx(side);
    if (!allVisible(pose, [i.knee, i.ankle, i.heel], opts?.minVisibility)) return null;
    const shin = distance(pose[i.knee], pose[i.ankle]);
    if (shin < 1e-4) return null;
    return { kind, value: pose[i.heel].y, scale: shin };
  }
  const tilt = trunkTiltDeg(pose, opts?.minVisibility);
  return tilt === null ? null : { kind, value: tilt, scale: 1 };
}

/** Median-combine rest-phase samples into a baseline (null for an empty list). */
export function baselineFromSamples(samples: readonly CompensationSample[]): CompensationBaseline | null {
  if (samples.length === 0) return null;
  return {
    kind: samples[0].kind,
    value: median(samples.map((s) => s.value)),
    scale: median(samples.map((s) => s.scale)),
    samples: samples.length,
  };
}

/**
 * Capture a baseline from a SINGLE rest frame (null: not applicable / not visible). Prefer the
 * calibrator's rest-phase median (RomCalibration.compensationBaseline), which is robust to jitter.
 */
export function captureCompensationBaseline(movement: Movement, pose: readonly Landmark[] | null | undefined, side: Side, opts?: FeatureOptions): CompensationBaseline | null {
  const s = measureCompensation(movement, pose, side, opts);
  return s ? { kind: s.kind, value: s.value, scale: s.scale, samples: 1 } : null;
}

/** Evaluate a measured sample against a rest baseline. */
export function evaluateCompensation(sample: CompensationSample, baseline: CompensationBaseline): CompensationResult | null {
  if (sample.kind !== baseline.kind) return null;
  if (sample.kind === 'heel_lift') {
    const scale = baseline.scale > 1e-4 ? baseline.scale : sample.scale;
    const rise = (baseline.value - sample.value) / scale; // y grows downward: rise = baseline - now
    return { kind: 'heel_lift', value: rise, tolerance: HEEL_LIFT_TOLERANCE, flagged: rise > HEEL_LIFT_TOLERANCE };
  }
  const extra = sample.value - baseline.value;
  return { kind: 'trunk_lean', value: extra, tolerance: TRUNK_LEAN_TOLERANCE_DEG, flagged: extra > TRUNK_LEAN_TOLERANCE_DEG };
}

/** Evaluate the compensation for the current frame against a rest baseline. */
export function checkCompensation(movement: Movement, pose: readonly Landmark[] | null | undefined, side: Side, baseline: CompensationBaseline, opts?: FeatureOptions): CompensationResult | null {
  const sample = measureCompensation(movement, pose, side, opts);
  return sample ? evaluateCompensation(sample, baseline) : null;
}

/* ---------------- movement info ---------------- */

/** Lane smoothing spec (unit-free linear filters only; see filters.ts LaneFilterSpec). */
export type SmoothingSpec = LaneFilterSpec;

export interface MovementInfo {
  movement: Movement;
  label: string;
  mode: Mode;
  /** Short patient-facing instruction shown during play. */
  instructions: string;
  /** Instruction for the ROM calibration screen (rest + 3 reps). */
  calibrationInstruction: string;
  /** Rest-phase instruction. */
  restInstruction: string;
  /** True when a larger feature value means more movement (all built-in extractors). */
  higherIsMore: boolean;
  /**
   * Smoothing applied by the lane pipeline (identical path for calibration and play). Unit-free and
   * linear, so every lane has the same delay whatever its feature unit; default EMA alpha 0.5 (~1 frame).
   */
  smoothing: SmoothingSpec;
  /** Minimum acceptable (max - min) in feature units; below this calibration reports insufficient_range. */
  minRom: number;
  /** Feature unit for therapist display. */
  unit: 'deg' | 'ratio';
  /** Compensation monitored, if any. */
  compensation: CompensationKind | null;
  /** Landmarks that must be visible (Pose indices for leg; hand movements need the whole hand). */
  requiredVisible: 'full_hand' | 'knees_up' | 'feet';
}

export const MOVEMENT_INFO: Readonly<Record<Movement, MovementInfo>> = Object.freeze({
  seated_march: {
    movement: 'seated_march', label: 'Seated march', mode: 'leg',
    instructions: 'Lift your knee up toward the ceiling, then lower it.',
    calibrationInstruction: 'Lift your knee as high as is comfortable, lower it, and repeat 3 times.',
    restInstruction: 'Sit upright with both feet flat on the floor and hold still.',
    higherIsMore: true, smoothing: { kind: 'ema', alpha: 0.5 },
    minRom: 0.12, unit: 'ratio', compensation: 'trunk_lean', requiredVisible: 'knees_up',
  },
  knee_extension: {
    movement: 'knee_extension', label: 'Knee extension', mode: 'leg',
    instructions: 'Straighten your knee, kicking your foot forward, then lower it.',
    calibrationInstruction: 'Straighten your knee as far as is comfortable, relax, and repeat 3 times.',
    restInstruction: 'Sit upright with your foot flat on the floor and hold still.',
    higherIsMore: true, smoothing: { kind: 'ema', alpha: 0.5 },
    minRom: 20, unit: 'deg', compensation: null, requiredVisible: 'feet',
  },
  ankle_dorsiflexion: {
    movement: 'ankle_dorsiflexion', label: 'Ankle dorsiflexion', mode: 'leg',
    instructions: 'Lift your toes toward your shin, keeping your heel on the floor.',
    calibrationInstruction: 'Lift your toes as high as is comfortable (heel down), relax, and repeat 3 times.',
    restInstruction: 'Keep your foot flat on the floor and hold still.',
    higherIsMore: true, smoothing: { kind: 'ema', alpha: 0.5 },
    minRom: 10, unit: 'deg', compensation: 'heel_lift', requiredVisible: 'feet',
  },
  hip_abduction: {
    movement: 'hip_abduction', label: 'Hip abduction', mode: 'leg',
    instructions: 'Move your knee out to the side, then bring it back.',
    calibrationInstruction: 'Move your knee out to the side as far as is comfortable, return, and repeat 3 times.',
    restInstruction: 'Sit with your knees together over your feet and hold still.',
    higherIsMore: true, smoothing: { kind: 'ema', alpha: 0.5 },
    minRom: 0.1, unit: 'ratio', compensation: null, requiredVisible: 'knees_up',
  },
  hand_open_close: {
    movement: 'hand_open_close', label: 'Hand open / close', mode: 'hand',
    instructions: 'Open your hand wide, then make a fist.',
    calibrationInstruction: 'Open your hand as wide as is comfortable, close it, and repeat 3 times.',
    restInstruction: 'Rest your forearm on the table, palm to the camera, hand relaxed (loosely closed).',
    higherIsMore: true, smoothing: { kind: 'ema', alpha: 0.5 },
    minRom: 0.35, unit: 'ratio', compensation: null, requiredVisible: 'full_hand',
  },
  wrist_extension: {
    movement: 'wrist_extension', label: 'Wrist extension', mode: 'hand',
    instructions: 'Bend your hand up at the wrist so your knuckles rise, keeping your forearm on the table.',
    calibrationInstruction: 'Bend your hand up at the wrist as far as is comfortable, let it drop back, and repeat 3 times.',
    restInstruction: 'Rest your forearm on the table with your hand over the edge, fingers pointing at the camera, and hold still.',
    higherIsMore: true, smoothing: { kind: 'ema', alpha: 0.5 },
    minRom: 0.35, unit: 'ratio', compensation: null, requiredVisible: 'full_hand',
  },
  finger_opposition: {
    movement: 'finger_opposition', label: 'Finger opposition', mode: 'hand',
    instructions: 'Touch your thumb to your fingertip, then open again.',
    calibrationInstruction: 'Touch your thumb to the fingertip, open your hand, and repeat 3 times.',
    restInstruction: 'Rest your hand open, palm to the camera, and hold still.',
    higherIsMore: true, smoothing: { kind: 'ema', alpha: 0.5 },
    minRom: 0.25, unit: 'ratio', compensation: null, requiredVisible: 'full_hand',
  },
  finger_spread: {
    movement: 'finger_spread', label: 'Finger spread', mode: 'hand',
    instructions: 'Spread your fingers wide apart, then bring them together.',
    calibrationInstruction: 'Spread your fingers as wide as is comfortable, relax, and repeat 3 times.',
    restInstruction: 'Rest your hand open with fingers together, palm to the camera.',
    higherIsMore: true, smoothing: { kind: 'ema', alpha: 0.5 },
    minRom: 12, unit: 'deg', compensation: null, requiredVisible: 'full_hand',
  },
});

export function movementMode(movement: Movement): Mode {
  return MOVEMENT_INFO[movement].mode;
}
