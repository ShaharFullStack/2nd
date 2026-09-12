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
 * hand selection by side happens in src/vision/mediapipe.ts / VisionInput. The features themselves use
 * x/y only (Hand z is a low-fidelity relative depth) and are position- and scale-invariant; z is used
 * ONLY by the coarse `handPlausible` shape gate, where a rotation-invariant scale is needed.
 */
import type { LaneSpec, Mode, Movement, Side } from '../engine/types.ts';
import {
  HAND, POSE, FINGERTIP_INDEX, allVisible, angleAtJoint, angleBetween2d, distance, distance2d, midpoint, sub, palmSize, palmSize2d, palmWidth2d,
} from './landmarks.ts';
import type { Fingertip, Landmark } from './landmarks.ts';
import type { LaneFilterSpec } from './filters.ts';
import { median } from './stats.ts';

/**
 * The fingertip finger_opposition opposes the thumb with, unless the therapist chooses another
 * (docs/ARCHITECTURE.md:77). Exported because the CHOICE IS PART OF THE MEASUREMENT: a range calibrated
 * on the index normalizes a different quantity than a pinch played on the pinky, so the calibration
 * records it (RomCalibration.fingertip) and the lane pipeline carries it (LanePipeline.getFingertip).
 */
export const DEFAULT_FINGERTIP: Fingertip = 'index';

export interface FeatureOptions {
  /** finger_opposition: which fingertip opposes the thumb (default DEFAULT_FINGERTIP = 'index'). */
  fingertip?: Fingertip;
  /** Minimum pose visibility (default MIN_VISIBILITY). */
  minVisibility?: number;
  /** Pose world landmarks (metres, hip-centred) for the same frame; used by the 3D angle features. */
  worldLandmarks?: readonly Landmark[] | null;
  /**
   * True when the frames fed to the detector were horizontally flipped before detection (default false;
   * see the mirror convention in src/vision/mediapipe.ts).
   *
   * IT SELECTS THE LIMB, not just a sign. A mirrored human is indistinguishable from a real one, so the
   * Pose model labels by APPARENT geometry: on flipped frames the patient's RIGHT leg is reported in the
   * LEFT_* landmark indices and vice versa. Every LEG extractor therefore resolves its indices through
   * `poseSideIndices(side, mirrored)`, which swaps them. Getting this wrong does not degrade the signal,
   * it measures THE OTHER LEG — for a hemiparetic patient that means the affected lane reads flat 0 all
   * session, or (if calibration ran in the same configuration) the whole game is driven by the
   * unaffected limb with no error anywhere.
   *
   * ON TOP OF the index swap, the SIGNED lateral feature (hip_abduction) still needs the coordinate
   * flip: mirroring reverses image x, so the outward direction for a given limb reverses with it. The
   * two corrections are independent and BOTH are required (see abductionSign).
   * Hand features are mirror-invariant (distances, unsigned angles, and a y-only wrist rise); which hand
   * belongs to which side is decided by `pickHand` in mediapipe.ts, not here.
   */
  mirrored?: boolean;
  /**
   * Frame aspect ratio (width / height) of the frames the landmarks came from; default 1 (square).
   * MediaPipe normalizes x by the frame WIDTH and y by the HEIGHT, so without this every mixed-axis
   * feature is multiplied by the webcam's aspect ratio and the fixed guards below (minRom,
   * HEEL_LIFT_TOLERANCE, the trunk-lean degrees) mean a different PHYSICAL amount on every laptop.
   * With it, all features are in units of frame height and are identical on 4:3, 16:9 and 1:1.
   * VisionInput sets it from CameraSession.width/height. See the note at the top of landmarks.ts.
   */
  xScale?: number;
}

export type FeatureExtractor = (landmarks: readonly Landmark[] | null | undefined, side: Side, opts?: FeatureOptions) => number | null;

export interface PoseSideIndices {
  shoulder: number; hip: number; knee: number; ankle: number; heel: number; foot: number;
}

const LEFT_SIDE_IDX: Readonly<PoseSideIndices> = Object.freeze({
  shoulder: POSE.LEFT_SHOULDER, hip: POSE.LEFT_HIP, knee: POSE.LEFT_KNEE, ankle: POSE.LEFT_ANKLE, heel: POSE.LEFT_HEEL, foot: POSE.LEFT_FOOT_INDEX,
});
const RIGHT_SIDE_IDX: Readonly<PoseSideIndices> = Object.freeze({
  shoulder: POSE.RIGHT_SHOULDER, hip: POSE.RIGHT_HIP, knee: POSE.RIGHT_KNEE, ankle: POSE.RIGHT_ANKLE, heel: POSE.RIGHT_HEEL, foot: POSE.RIGHT_FOOT_INDEX,
});

/**
 * The Pose landmark indices that hold the PATIENT's `side` leg, for the mirror convention in use.
 *
 * MediaPipe Pose labels anatomically from the image it is given, and a horizontally flipped image of a
 * person is a perfectly valid image of a person whose left and right are swapped — the model has no way
 * to know and no reason to care. So on `mirrored` frames the patient's left leg arrives in the RIGHT_*
 * indices. Every leg extractor and the leg compensation checks go through this function; nothing in this
 * module may pick POSE.LEFT_ / POSE.RIGHT_ landmark slots from `side` directly.
 */
export function poseSideIndices(side: Side, mirrored = false): Readonly<PoseSideIndices> {
  const patientLeft = side === 'left';
  // mirrored: the patient's left limb is reported under the RIGHT_* labels.
  return patientLeft !== mirrored ? LEFT_SIDE_IDX : RIGHT_SIDE_IDX;
}

function poseIdx(side: Side, opts?: FeatureOptions): Readonly<PoseSideIndices> {
  return poseSideIndices(side, opts?.mirrored ?? false);
}

const TORSO_IDX = [POSE.LEFT_SHOULDER, POSE.RIGHT_SHOULDER, POSE.LEFT_HIP, POSE.RIGHT_HIP];

/** The frame aspect correction in effect (see FeatureOptions.xScale / landmarks.ts). */
function xs(opts: FeatureOptions | undefined): number {
  const s = opts?.xScale;
  return s !== undefined && Number.isFinite(s) && s > 0 ? s : 1;
}

/** Torso length in frame-height units: mid-shoulder to mid-hip (image plane). null if not visible or degenerate. */
export function torsoLength(pose: readonly Landmark[] | null | undefined, minVisibility?: number, xScale = 1): number | null {
  if (!allVisible(pose, TORSO_IDX, minVisibility)) return null;
  const p = pose as readonly Landmark[];
  const len = distance2d(midpoint(p[POSE.LEFT_SHOULDER], p[POSE.RIGHT_SHOULDER]), midpoint(p[POSE.LEFT_HIP], p[POSE.RIGHT_HIP]), xScale);
  return len > 1e-4 ? len : null;
}

/**
 * The landmark set used for 3D angles: world landmarks when supplied (and complete), else image
 * landmarks. World landmarks are metric and isotropic, so they carry xScale 1; image landmarks carry
 * the frame's aspect correction.
 */
function angleSource(pose: readonly Landmark[], opts: FeatureOptions | undefined, indices: readonly number[]): { lms: readonly Landmark[]; xScale: number } {
  const w = opts?.worldLandmarks;
  if (w && allVisible(w, indices, -Infinity)) return { lms: w, xScale: 1 };
  return { lms: pose, xScale: xs(opts) };
}

/** seated_march: knee height above hip normalized by torso length. (hip.y - knee.y)/torsoLen */
export const seatedMarch: FeatureExtractor = (pose, side, opts) => {
  const i = poseIdx(side, opts);
  if (!allVisible(pose, [i.hip, i.knee], opts?.minVisibility)) return null;
  const torso = torsoLength(pose, opts?.minVisibility, xs(opts));
  if (torso === null) return null;
  const p = pose as readonly Landmark[];
  return (p[i.hip].y - p[i.knee].y) / torso;
};

/** knee_extension: interior angle hip-knee-ankle in degrees (90 = bent, 180 = straight). 3D (world landmarks preferred). */
export const kneeExtension: FeatureExtractor = (pose, side, opts) => {
  const i = poseIdx(side, opts);
  const idx = [i.hip, i.knee, i.ankle];
  if (!allVisible(pose, idx, opts?.minVisibility)) return null;
  const { lms: p, xScale } = angleSource(pose as readonly Landmark[], opts, idx);
  return angleAtJoint(p[i.hip], p[i.knee], p[i.ankle], xScale);
};

/**
 * ankle_dorsiflexion: 180 - (interior angle at the ankle between ankle->knee and ankle->foot_index).
 * Toes lifted => the ankle angle shrinks => the feature grows. 3D (world landmarks preferred).
 *
 * There is NO universal rest value: it is set by the patient's own shin/foot geometry and by how far the
 * foot is placed forward of the knee (the module's seated fixture rests at ~76, not the 90 a foot flat
 * under a vertical shin would give). That is exactly why the number is never used raw — RomCalibrator's
 * rest hold measures this patient's own zero.
 *
 * It also RESPONDS TO KNEE ANGLE: extending the knee swings the shin, which changes the ankle-knee
 * vector even with the foot held still (a knee_extension sweep drives this feature from ~76 down to ~9
 * and back up to ~14, i.e. not even monotone in knee angle). Pairing the two movements on one leg is
 * therefore reported as a 'coupled' conflict by `laneConflicts` rather than being silently scored.
 */
export const ankleDorsiflexion: FeatureExtractor = (pose, side, opts) => {
  const i = poseIdx(side, opts);
  const idx = [i.knee, i.ankle, i.foot];
  if (!allVisible(pose, idx, opts?.minVisibility)) return null;
  const { lms: p, xScale } = angleSource(pose as readonly Landmark[], opts, idx);
  return 180 - angleAtJoint(p[i.knee], p[i.ankle], p[i.foot], xScale);
};

/**
 * Image-x direction that is OUTWARD (abduction) for this side. In a raw, un-mirrored front-camera frame
 * the patient's LEFT side appears at the LARGER x (you face them, their left hand is on your right), so
 * outward for the left leg is +x and for the right leg -x; a mirrored stream reverses image x, so both
 * flip.
 *
 * THIS IS NOT REDUNDANT WITH THE INDEX SWAP in `poseSideIndices`, and the two must not be collapsed:
 * the swap picks WHICH LIMB's landmarks are read, this picks WHICH DIRECTION is outward for that limb in
 * the coordinate system they arrived in. Worked example, patient's left knee abducted, torso 1 unit:
 *   raw      hip.x 0.60, knee.x 0.75 under LEFT_*  -> poseSideIndices('left', false) = LEFT_*,
 *            sign +1 -> +0.15
 *   mirrored hip.x 0.40, knee.x 0.25 under RIGHT_* -> poseSideIndices('left', true)  = RIGHT_*,
 *            sign -1 -> -1 * (0.25 - 0.40) = +0.15   (same physical abduction, same number)
 * Dropping either correction gives the wrong limb, the wrong sign, or both.
 */
export function abductionSign(side: Side, mirrored = false): number {
  const s = side === 'left' ? 1 : -1;
  return mirrored ? -s : s;
}

/**
 * hip_abduction: SIGNED lateral knee displacement from the hip, (knee.x - hip.x)*outward / torsoLen.
 *
 * DELIBERATE DEVIATION from docs/ARCHITECTURE.md, which specifies |knee.x - hip.x|: with the absolute
 * value ADduction (pulling the knee inward across the midline) scores exactly like ABduction, so the
 * compensatory pattern this exercise is prescribed to correct earns full credit. The signed feature is
 * negative for adduction, and ROM normalization clamps anything below the calibrated rest `min` to 0 —
 * i.e. adduction reads as "rest" and never scores. Direction-specificity is not optional in rehab.
 */
export const hipAbduction: FeatureExtractor = (pose, side, opts) => {
  const i = poseIdx(side, opts);
  if (!allVisible(pose, [i.hip, i.knee], opts?.minVisibility)) return null;
  const xScale = xs(opts);
  const torso = torsoLength(pose, opts?.minVisibility, xScale);
  if (torso === null) return null;
  const p = pose as readonly Landmark[];
  // The lateral offset is pure image-x: without the aspect correction this ratio (a mostly-horizontal
  // numerator over a mostly-vertical denominator) is the feature most distorted by the webcam's shape.
  return (abductionSign(side, opts?.mirrored ?? false) * (p[i.knee].x - p[i.hip].x) * xScale) / torso;
};

const FINGER_TIPS = [HAND.INDEX_TIP, HAND.MIDDLE_TIP, HAND.RING_TIP, HAND.PINKY_TIP];
const HAND_ALL = Array.from({ length: 21 }, (_, k) => k);
const ALL_TIPS = [HAND.THUMB_TIP, HAND.INDEX_TIP, HAND.MIDDLE_TIP, HAND.RING_TIP, HAND.PINKY_TIP];

/**
 * Plausibility bands (multiples of the 3D palm size wrist->middle_mcp, which is rotation invariant, so
 * these hold for every hand orientation including the fingers-at-the-camera rest pose of wrist_extension).
 * Generous by design: this rejects collapsed / geometrically impossible hands, not unusual ones.
 */
export const HAND_PLAUSIBILITY = Object.freeze({ minWidthRatio: 0.25, maxWidthRatio: 2.5, minTipRatio: 0.3, maxTipRatio: 3.6 });

/**
 * Coarse shape check on a detected hand.
 *
 * WHY: MediaPipe's HandLandmarker ALWAYS returns all 21 landmarks — it infers occluded ones rather than
 * omitting them — and exposes no per-landmark presence score, so "some landmarks are missing" is not a
 * signal that ever arrives from the real detector. A half-occluded hand instead yields confident garbage.
 * This gate rejects the geometrically impossible results (fingers collapsed into the wrist, a palm folded
 * to nothing) so they surface as 'low_visibility' instead of flowing into the features. It is a floor,
 * not a confidence measure; VisionInput additionally gates on the handedness score (`minHandScore`).
 */
export function handPlausible(hand: readonly Landmark[], xScale = 1): boolean {
  const ps = palmSize(hand, xScale); // 3D: invariant under wrist pitch, unlike the image-plane palm length.
  if (!(ps > 1e-4)) return false;
  const width = distance(hand[HAND.INDEX_MCP], hand[HAND.PINKY_MCP], xScale) / ps;
  if (width < HAND_PLAUSIBILITY.minWidthRatio || width > HAND_PLAUSIBILITY.maxWidthRatio) return false;
  for (const t of ALL_TIPS) {
    const r = distance(hand[t], hand[HAND.WRIST], xScale) / ps;
    if (r < HAND_PLAUSIBILITY.minTipRatio || r > HAND_PLAUSIBILITY.maxTipRatio) return false;
  }
  return true;
}

function handOk(hand: readonly Landmark[] | null | undefined, xScale = 1): hand is readonly Landmark[] {
  // Hand landmarks carry no meaningful visibility: presence/finiteness plus a shape plausibility gate.
  if (!allVisible(hand, HAND_ALL, -Infinity)) return false;
  const h = hand as readonly Landmark[];
  return palmSize(h, xScale) > 1e-4 && palmSize2d(h, xScale) > 1e-4 && handPlausible(h, xScale);
}

/** hand_open_close: mean (index..pinky fingertip -> wrist image distance) / palm size (2D). Open => larger. */
export const handOpenClose: FeatureExtractor = (hand, _side, opts) => {
  const xScale = xs(opts);
  if (!handOk(hand, xScale)) return null;
  const ps = palmSize2d(hand, xScale);
  let sum = 0;
  for (const t of FINGER_TIPS) sum += distance2d(hand[t], hand[HAND.WRIST], xScale);
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
 *
 * DELIBERATE DEVIATION from docs/ARCHITECTURE.md:76, which specifies "vertical rise of the wrist landmark
 * relative to a calibrated rest baseline, normalized by palm size". That formulation measures the WRIST's
 * absolute image position, so it scores the one thing wrist extension must not reward — lifting the whole
 * forearm off the table (the classic compensation) — and it drifts with any change of seat height or
 * camera distance, none of which a rest baseline can separate from real movement. This version measures
 * the hand's angle ABOUT the wrist (wrist -> middle MCP rise over palm width), which is translation- and
 * scale-invariant: a forearm lift moves both landmarks together and reads exactly 0.
 * Consequence, and the reason `posture` exists below: the movement is only observable with the hand over
 * the table edge and the fingers toward the camera, which is a DIFFERENT posture from the palm-to-camera
 * setup the other three hand movements need (see MovementPosture / laneConflicts).
 */
export const wristExtension: FeatureExtractor = (hand, _side, opts) => {
  const xScale = xs(opts);
  if (!handOk(hand, xScale)) return null;
  const width = palmWidth2d(hand, xScale);
  if (width < 1e-4) return null;
  return (hand[HAND.WRIST].y - hand[HAND.MIDDLE_MCP].y) / width;
};

/** finger_opposition: 1 - (thumb_tip -> chosen fingertip image distance / palm size 2D). Pinch => larger. */
export const fingerOpposition: FeatureExtractor = (hand, _side, opts) => {
  const xScale = xs(opts);
  if (!handOk(hand, xScale)) return null;
  const tip = FINGERTIP_INDEX[opts?.fingertip ?? DEFAULT_FINGERTIP];
  return 1 - distance2d(hand[HAND.THUMB_TIP], hand[tip], xScale) / palmSize2d(hand, xScale);
};

/** finger_spread: 2D angle (degrees) between index MCP->tip and pinky MCP->tip vectors. Spread => larger. */
export const fingerSpread: FeatureExtractor = (hand, _side, opts) => {
  const xScale = xs(opts);
  if (!handOk(hand, xScale)) return null;
  return angleBetween2d(sub(hand[HAND.INDEX_TIP], hand[HAND.INDEX_MCP]), sub(hand[HAND.PINKY_TIP], hand[HAND.PINKY_MCP]), xScale);
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
 *   heel_lift : value = (heel.y - ankle.y)/shinLength — the heel's height BELOW the ankle in shin
 *               lengths, a RELATIVE quantity; scale = shin length knee->ankle (kept for display)
 *   trunk_lean: value = trunk tilt from vertical in degrees, scale = 1
 * The calibrator accumulates these over the rest phase and takes medians (see baselineFromSamples).
 *
 * WHY heel_lift IS RELATIVE TO THE ANKLE, not an absolute image y: the baseline is captured once, at
 * rest, and then compared against for the whole song. An absolute heel.y also moves when the PATIENT or
 * the CAMERA moves — a chair scoot, a camera bump, the patient settling into the seat. A 0.02 whole-body
 * shift over a 0.25 shin is a phantom "rise" of 0.08, two thirds of HEEL_LIFT_TOLERANCE, which lands in
 * therapist-facing rep metrics and in the live coaching as a compensation the patient never made.
 * heel.y - ankle.y moves with the foot only: a whole-body translation cancels exactly.
 */
export interface CompensationSample { kind: CompensationKind; value: number; scale: number; }

/** Rest baseline so compensation can be measured relative to the patient's own posture. */
export interface CompensationBaseline {
  kind: CompensationKind;
  /** heel_lift: rest (heel.y - ankle.y)/shin; trunk_lean: rest trunk tilt in degrees from vertical. */
  value: number;
  /** heel_lift: shin length at rest (knee->ankle), for display only — `value` is already scale-free. */
  scale: number;
  /** Number of rest frames the baseline was taken from (1 = single frame). */
  samples?: number;
}

export interface CompensationResult {
  kind: CompensationKind;
  /**
   * Magnitude compared against `tolerance`: heel_lift = rise / shinLen; trunk_lean = the SIZE of the
   * change in trunk tilt from rest, in degrees (direction-free — see `signed`). VisionInput keeps the
   * LARGEST value seen during a rep as that rep's compensation, so this must grow with severity in
   * whichever direction the patient compensated.
   */
  value: number;
  /**
   * The same quantity WITH its direction. heel_lift: identical to `value` (positive = heel rising).
   * trunk_lean: signed change in trunk tilt from the rest posture, positive = the trunk moved toward
   * the RIGHT of the image. Therapist-facing output keeps the direction because "leaned 20 degrees
   * further into the existing list" and "swung 20 degrees across to the other side" are different
   * clinical events with the same magnitude.
   */
  signed: number;
  /** Tolerance the value is compared against. */
  tolerance: number;
  flagged: boolean;
}

/**
 * Heel rise > this fraction of the shin length flags ankle_dorsiflexion reps. Because the underlying
 * quantity is (heel.y - ankle.y)/shin measured with the frame's aspect correction, this is a fixed
 * PHYSICAL amount on any webcam and survives the patient/camera moving between rest and the rep.
 */
export const HEEL_LIFT_TOLERANCE = 0.12;
/**
 * Change in lateral trunk tilt from the REST posture (degrees, either direction) that flags
 * seated_march reps.
 *
 * Either direction, because the quantity that matters is how far the trunk MOVED from where the patient
 * started, not how far it is from vertical. A post-stroke patient very often rests with a lateral list
 * of 10-20 degrees; hiking the hip to lift the knee then swings the trunk AWAY from that list, which is
 * a smaller angle from vertical and would never be flagged by an unsigned tilt-minus-rest rule (it
 * reports a NEGATIVE extra). Same reasoning as heel_lift being measured relative to the ankle: the
 * baseline is the patient's own resting posture, not the world.
 */
export const TRUNK_LEAN_TOLERANCE_DEG = 12;

/** Which compensation (if any) is monitored for a movement. */
export function compensationKind(movement: Movement): CompensationKind | null {
  if (movement === 'ankle_dorsiflexion') return 'heel_lift';
  if (movement === 'seated_march') return 'trunk_lean';
  return null;
}

/**
 * SIGNED lateral trunk tilt from vertical (degrees) of the hip-mid -> shoulder-mid vector, image plane.
 *
 * Positive = the shoulders are to the RIGHT of the hips in the IMAGE (which limb that is depends on the
 * mirror convention, so this is deliberately an image-space quantity: the compensation rule only ever
 * uses DIFFERENCES of it, which are mirror-symmetric in magnitude). 0 = upright.
 *
 * Signed rather than a bare angle-from-vertical because trunk lean is judged against the patient's own
 * resting posture: with an unsigned angle, a trunk that swings from a 16-degree list THROUGH vertical to
 * 16 degrees the other way — a 32-degree excursion — reports a change of exactly zero.
 *
 * `xScale` maps x into y units so the angle is the same on a 4:3 and a 16:9 frame.
 */
export function trunkTiltDeg(pose: readonly Landmark[] | null | undefined, minVisibility?: number, xScale = 1): number | null {
  if (!allVisible(pose, TORSO_IDX, minVisibility)) return null;
  const p = pose as readonly Landmark[];
  const up = sub(midpoint(p[POSE.LEFT_SHOULDER], p[POSE.RIGHT_SHOULDER]), midpoint(p[POSE.LEFT_HIP], p[POSE.RIGHT_HIP]));
  // atan2 against the image-up direction (-y): |result| is the angle from vertical, the sign is the
  // side the trunk is leaning to. Equivalent to the cross product of the trunk vector with vertical.
  return (Math.atan2(up.x * xScale, -up.y) * 180) / Math.PI;
}

/** Measure this frame's raw compensation quantities for the movement (null: not applicable / not visible). */
export function measureCompensation(movement: Movement, pose: readonly Landmark[] | null | undefined, side: Side, opts?: FeatureOptions): CompensationSample | null {
  const kind = compensationKind(movement);
  if (!kind || !pose) return null;
  const xScale = xs(opts);
  if (kind === 'heel_lift') {
    const i = poseIdx(side, opts);
    if (!allVisible(pose, [i.knee, i.ankle, i.heel], opts?.minVisibility)) return null;
    const shin = distance(pose[i.knee], pose[i.ankle], xScale);
    if (shin < 1e-4) return null;
    // Relative to the ankle (see CompensationSample): a whole-body / camera shift cancels.
    return { kind, value: (pose[i.heel].y - pose[i.ankle].y) / shin, scale: shin };
  }
  const tilt = trunkTiltDeg(pose, opts?.minVisibility, xScale);
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
    // Both are (heel.y - ankle.y)/shin, already scale-free. y grows downward: rise = baseline - now.
    const rise = baseline.value - sample.value;
    return { kind: 'heel_lift', value: rise, signed: rise, tolerance: HEEL_LIFT_TOLERANCE, flagged: rise > HEEL_LIFT_TOLERANCE };
  }
  // Both are SIGNED tilts from vertical, so this is the trunk's angular EXCURSION from its resting
  // posture — in either direction. Magnitude is what the tolerance judges (a hip-hike that swings the
  // trunk away from a resting list is the same compensation as one that deepens it); the direction is
  // carried alongside for the therapist.
  const change = sample.value - baseline.value;
  const mag = Math.abs(change);
  return { kind: 'trunk_lean', value: mag, signed: change, tolerance: TRUNK_LEAN_TOLERANCE_DEG, flagged: mag > TRUNK_LEAN_TOLERANCE_DEG };
}

/** Evaluate the compensation for the current frame against a rest baseline. */
export function checkCompensation(movement: Movement, pose: readonly Landmark[] | null | undefined, side: Side, baseline: CompensationBaseline, opts?: FeatureOptions): CompensationResult | null {
  const sample = measureCompensation(movement, pose, side, opts);
  return sample ? evaluateCompensation(sample, baseline) : null;
}

/* ---------------- movement info ---------------- */

/** Lane smoothing spec (unit-free linear filters only; see filters.ts LaneFilterSpec). */
export type SmoothingSpec = LaneFilterSpec;

/**
 * Coarse lanes (hip/knee/ankle, and the whole-hand movements) use a single EMA at alpha 0.5 — 1 frame of
 * group delay at 30 fps. The FINE-MOTOR lanes (finger_opposition, finger_spread, which ride on fingertip
 * landmarks several times noisier than hip/knee landmarks) use a two-stage EMA at the delay-matched
 * alpha 2/3: the SAME 1-frame group delay, but twice the high-frequency rejection (Nyquist gain 0.25 vs
 * 0.33). Every lane therefore still has an identical, analytically known delay — the property the engine
 * folds into its single session latency offset — while the noisy lanes get a steeper rolloff.
 */
export const COARSE_SMOOTHING: SmoothingSpec = Object.freeze({ kind: 'ema', alpha: 0.5 }) as SmoothingSpec;
export const FINE_SMOOTHING: SmoothingSpec = Object.freeze({ kind: 'ema2', alpha: 2 / 3 }) as SmoothingSpec;

/**
 * The physical SETUP a movement is measured in. Two movements with different postures cannot both be
 * performed by the same limb in one session: the patient can only hold one of them, and whichever they
 * hold makes the other movement unobservable (or, worse, makes the other lane's feature respond to it).
 *   'seated_leg'      : seated, facing the camera, hips/knees (and feet) in view — AND A HAND.
 *   'palm_to_camera'  : forearm on the table, palm to the camera, fingers up.
 *   'hand_over_edge'  : forearm on the table, hand over the edge, fingers pointing at the camera.
 * The two hand postures are 90 degrees apart about the wrist, which is exactly the wrist_extension axis.
 *
 * WHY THE LEG SETUP ASKS FOR A HAND IT DOES NOT MEASURE. Nothing about a knee range needs a wrist in
 * frame. But a patient working alone answers every screen by holding a limb inside a circle, and in leg
 * mode that limb can only be a HAND: a seated patient puts a knee somewhere only by performing a
 * prescribed leg movement, so a knee that could fill a circle would fill it on every repetition
 * (vision/dwell.ts). The framing this text asks for therefore has to be a framing the hands-free path
 * survives — "hips, knees and feet" alone invited a patient to sit down with no way to answer anything,
 * which is the stranding the whole gesture exists to prevent. The camera check states the same fact
 * about the framing it can actually SEE (`cameraReadiness`, `PointerObservation`), because an
 * instruction is not evidence that it was followed.
 *
 * AND WHY IT NAMES THE SUPPORT, AND RULES OUT THE THIGH. This text used to offer "on your thigh or the
 * arm of the chair" as though the two were interchangeable. They are not, and the difference is the
 * whole of this feature's third failure: hip flexion rotates the thigh about the hip, so a hand resting
 * at fraction f along the hip->knee segment rises by f x the knee's travel and is swung sideways by
 * circumduction at the same time. Driven through the shipping classes, a seated march with
 * circumduction and a hand on the thigh filled the PRIMARY circle in 3.23 s on the first repetition —
 * at every frame rate, in both frame aspects, on either side. A chair arm, an armrest or a table is
 * furniture: the leg cannot move it, and that independence is the only thing that makes a hold a
 * different event from a repetition. The instruction is still only half of it — the pointer's
 * independence is also MEASURED from the landmarks and a carried hand is refused (`DwellCoupling`),
 * because three rounds of this feature were lost to trusting a premise about the body.
 */
export type MovementPosture = 'seated_leg' | 'palm_to_camera' | 'hand_over_edge';

export const POSTURE_INFO: Readonly<Record<MovementPosture, { label: string; setup: string }>> = Object.freeze({
  seated_leg: {
    label: 'Seated, facing the camera',
    setup:
      'Sit facing the camera so your hips, knees and feet are in view, and rest a hand where the camera can see it — on the arm of the chair, an armrest or a table, and NOT on your thigh. That hand is what holds the circles on screen, so you never have to touch the tablet: it has to be resting on something your leg does not move, because a hand carried by your thigh cannot be told apart from a repetition. Your knees cannot do it at all, for the same reason — they are doing the exercise.',
  },
  palm_to_camera: { label: 'Palm to the camera', setup: 'Rest your forearm on the table with your palm facing the camera.' },
  hand_over_edge: { label: 'Hand over the table edge', setup: 'Rest your forearm on the table with your hand over the edge, fingers pointing at the camera.' },
});

export interface MovementInfo {
  movement: Movement;
  label: string;
  mode: Mode;
  /** Setup the movement is measured in; movements with different postures cannot share a limb. */
  posture: MovementPosture;
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
  /**
   * Minimum acceptable (max - min) in feature units; below this calibration reports insufficient_range.
   * Ratio units are frame-height units (FeatureOptions.xScale applied), so this guard means the same
   * PHYSICAL amount on a 4:3 and a 16:9 webcam — without that correction the same patient passes on one
   * laptop and is told "not enough movement" on another.
   */
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
    movement: 'seated_march', label: 'Seated march', mode: 'leg', posture: 'seated_leg',
    instructions: 'Lift your knee up toward the ceiling, then lower it.',
    calibrationInstruction: 'Lift your knee as high as is comfortable, lower it, and repeat 3 times.',
    restInstruction: 'Sit upright with both feet flat on the floor and hold still.',
    higherIsMore: true, smoothing: COARSE_SMOOTHING,
    minRom: 0.12, unit: 'ratio', compensation: 'trunk_lean', requiredVisible: 'knees_up',
  },
  knee_extension: {
    movement: 'knee_extension', label: 'Knee extension', mode: 'leg', posture: 'seated_leg',
    instructions: 'Straighten your knee, kicking your foot forward, then lower it.',
    calibrationInstruction: 'Straighten your knee as far as is comfortable, relax, and repeat 3 times.',
    restInstruction: 'Sit upright with your foot flat on the floor and hold still.',
    higherIsMore: true, smoothing: COARSE_SMOOTHING,
    minRom: 20, unit: 'deg', compensation: null, requiredVisible: 'feet',
  },
  ankle_dorsiflexion: {
    movement: 'ankle_dorsiflexion', label: 'Ankle dorsiflexion', mode: 'leg', posture: 'seated_leg',
    instructions: 'Lift your toes toward your shin, keeping your heel on the floor.',
    calibrationInstruction: 'Lift your toes as high as is comfortable (heel down), relax, and repeat 3 times.',
    restInstruction: 'Keep your foot flat on the floor and hold still.',
    higherIsMore: true, smoothing: COARSE_SMOOTHING,
    minRom: 10, unit: 'deg', compensation: 'heel_lift', requiredVisible: 'feet',
  },
  hip_abduction: {
    movement: 'hip_abduction', label: 'Hip abduction', mode: 'leg', posture: 'seated_leg',
    instructions: 'Move your knee out to the side, then bring it back.',
    calibrationInstruction: 'Move your knee out to the side as far as is comfortable, return, and repeat 3 times.',
    restInstruction: 'Sit with your knees together over your feet and hold still.',
    higherIsMore: true, smoothing: COARSE_SMOOTHING,
    minRom: 0.1, unit: 'ratio', compensation: null, requiredVisible: 'knees_up',
  },
  hand_open_close: {
    movement: 'hand_open_close', label: 'Hand open / close', mode: 'hand', posture: 'palm_to_camera',
    instructions: 'Open your hand wide, then make a fist.',
    calibrationInstruction: 'Open your hand as wide as is comfortable, close it, and repeat 3 times.',
    restInstruction: 'Rest your forearm on the table, palm to the camera, hand relaxed (loosely closed).',
    higherIsMore: true, smoothing: COARSE_SMOOTHING,
    minRom: 0.35, unit: 'ratio', compensation: null, requiredVisible: 'full_hand',
  },
  wrist_extension: {
    movement: 'wrist_extension', label: 'Wrist extension', mode: 'hand', posture: 'hand_over_edge',
    instructions: 'Bend your hand up at the wrist so your knuckles rise, keeping your forearm on the table.',
    calibrationInstruction: 'Bend your hand up at the wrist as far as is comfortable, let it drop back, and repeat 3 times.',
    restInstruction: 'Rest your forearm on the table with your hand over the edge, fingers pointing at the camera, and hold still.',
    higherIsMore: true, smoothing: COARSE_SMOOTHING,
    minRom: 0.35, unit: 'ratio', compensation: null, requiredVisible: 'full_hand',
  },
  finger_opposition: {
    movement: 'finger_opposition', label: 'Finger opposition', mode: 'hand', posture: 'palm_to_camera',
    instructions: 'Touch your thumb to your fingertip, then open again.',
    calibrationInstruction: 'Touch your thumb to the fingertip, open your hand, and repeat 3 times.',
    restInstruction: 'Rest your hand open, palm to the camera, and hold still.',
    higherIsMore: true, smoothing: FINE_SMOOTHING,
    minRom: 0.25, unit: 'ratio', compensation: null, requiredVisible: 'full_hand',
  },
  finger_spread: {
    movement: 'finger_spread', label: 'Finger spread', mode: 'hand', posture: 'palm_to_camera',
    instructions: 'Spread your fingers wide apart, then bring them together.',
    calibrationInstruction: 'Spread your fingers as wide as is comfortable, relax, and repeat 3 times.',
    restInstruction: 'Rest your hand open with fingers together, palm to the camera.',
    higherIsMore: true, smoothing: FINE_SMOOTHING,
    minRom: 12, unit: 'deg', compensation: null, requiredVisible: 'full_hand',
  },
});

export function movementMode(movement: Movement): Mode {
  return MOVEMENT_INFO[movement].mode;
}

/** How a therapist names each fingertip to a patient. "Little finger", never "pinky", out loud. */
export const FINGERTIP_NAME: Record<Fingertip, string> = {
  index: 'index finger',
  middle: 'middle finger',
  ring: 'ring finger',
  pinky: 'little finger',
};

/**
 * The patient-facing instruction for a lane, naming the DIGIT that was actually prescribed.
 *
 * `MOVEMENT_INFO.instructions` cannot do this on its own: finger_opposition's generic "touch your
 * thumb to your fingertip" is the one string a patient is read aloud, and it is wrong for three of
 * the four tips a therapist can now choose. Every other movement passes straight through.
 */
export function movementInstructions(movement: Movement, fingertip?: Fingertip): string {
  if (movement !== 'finger_opposition') return MOVEMENT_INFO[movement].instructions;
  return `Touch your thumb to your ${FINGERTIP_NAME[fingertip ?? DEFAULT_FINGERTIP]}, then open again.`;
}

/** Same, for the ROM calibration screen's "do three reps" wording. */
export function movementCalibrationInstruction(movement: Movement, fingertip?: Fingertip): string {
  if (movement !== 'finger_opposition') return MOVEMENT_INFO[movement].calibrationInstruction;
  return `Touch your thumb to your ${FINGERTIP_NAME[fingertip ?? DEFAULT_FINGERTIP]}, open your hand, and repeat 3 times.`;
}

/* ---------------- lane conflicts (therapist setup guard) ---------------- */

export interface LaneConflict {
  /** Lane indices of the two conflicting lanes. */
  lanes: [number, number];
  movements: [Movement, Movement];
  /** Side the two lanes share, or null for a cross-side conflict (the two limbs need different setups). */
  side: Side | null;
  /**
   * 'error'  : the session CANNOT work as prescribed — the same movement twice on one limb, or two
   *            movements needing incompatible postures of the same limb. Change it before playing.
   * 'warning': it can work, but the two lanes interfere (coupled motions, or two hands held in
   *            different setups, which is awkward and degrades handedness).
   */
  severity: 'error' | 'warning';
  /** Why: 'duplicate' | 'posture' (incompatible setup) | 'coupled' (same voluntary motion). */
  kind: 'duplicate' | 'posture' | 'coupled';
  /** Therapist-facing explanation for the Setup screen. */
  message: string;
}

/**
 * Movement pairs that cross-trigger when prescribed on the SAME limb. Deliberately an explicit table
 * rather than a shared-landmark rule: sharing landmarks does not imply cross-talk (a 3D knee angle is
 * unaffected by hip flexion, so seated_march + knee_extension is a legitimate pairing), while these
 * pairs are driven by the same voluntary motion and will trigger each other on a real patient.
 * No synthetic fixture can expose this — each fixture parameter moves only its own landmarks.
 */
const COUPLED_PAIRS: Array<{ a: Movement; b: Movement; why: string }> = [
  { a: 'seated_march', b: 'hip_abduction', why: 'both read the knee position relative to the hip; a knee lift almost always carries lateral drift' },
  { a: 'knee_extension', b: 'ankle_dorsiflexion', why: 'both read the shin/foot chain; kicking the leg out swings the foot' },
  { a: 'hand_open_close', b: 'finger_spread', why: 'opening the hand spreads the fingers' },
  { a: 'hand_open_close', b: 'finger_opposition', why: 'closing the hand curls the index finger toward the thumb' },
  { a: 'finger_opposition', b: 'finger_spread', why: 'pinching curls the index finger, which rotates the spread axis' },
];

function coupling(a: Movement, b: Movement): string | null {
  for (const p of COUPLED_PAIRS) {
    if ((p.a === a && p.b === b) || (p.a === b && p.b === a)) return p.why;
  }
  return null;
}

/**
 * WHY A POSTURE MISMATCH IS AN ERROR, NOT A WARNING (measured, not theoretical).
 *
 * wrist_extension is measured with the hand over the table edge and the fingers pointing AT the camera;
 * hand_open_close / finger_opposition / finger_spread are measured with the palm TO the camera. The two
 * setups are the same 90° rotation about the wrist that wrist_extension performs, so prescribing one of
 * each on the same hand is broken in both directions at once:
 *   - held over the edge, a pure wrist-extension rep rigidly rotates every finger landmark, and the
 *     other lanes' features (2D fingertip-to-wrist ratio, 2D projected spread angle) sweep across their
 *     whole calibrated range at CONSTANT openness/spread — the patient scores hits on a lane whose
 *     movement they never performed;
 *   - held palm to camera, wrist_extension reads pinned at its maximum for every hand shape, so that
 *     lane can never fall below its re-arm level and never scores for the whole song.
 * No fixture quirk: it is what a 2D projection of a rigid rotation does. The prescription must change.
 */
const POSTURE_CROSS_TALK =
  'rotating the hand at the wrist also sweeps the open/close and spread features across their whole range, so one lane would score the other lane\'s hits while the other stays pinned';

function postureMessage(aIdx: number, bIdx: number, aInfo: MovementInfo, bInfo: MovementInfo, side: Side | null): string {
  const pa = POSTURE_INFO[aInfo.posture];
  const pb = POSTURE_INFO[bInfo.posture];
  const wrist = aInfo.movement === 'wrist_extension' || bInfo.movement === 'wrist_extension';
  const where = side ? `the same ${side} ${aInfo.mode === 'hand' ? 'hand' : 'leg'}` : 'the two hands at once';
  return `Lanes ${aIdx + 1} (${aInfo.label}) and ${bIdx + 1} (${bInfo.label}) need different setups for ${where}: ${pa.label.toLowerCase()} vs ${pb.label.toLowerCase()}.${
    side ? ` Only one of them can be held, so the other cannot be performed${wrist ? `, and ${POSTURE_CROSS_TALK}` : ''}. Put them on different limbs or in different sessions.`
      : ' Holding one hand in each setup is awkward and makes MediaPipe\'s left/right labelling unreliable; prefer one setup per session.'
  }`;
}

/**
 * Physically conflicting lanes in a prescription:
 *   - the identical movement (and fingertip) twice on one limb      -> error   (kind 'duplicate')
 *   - finger opposition on one hand with two different fingertips   -> warning (kind 'coupled')
 *   - two movements needing incompatible postures of the same limb -> error   (kind 'posture')
 *   - the same postures on two different limbs of a hand session   -> warning (kind 'posture')
 *   - two movements driven by the same voluntary motion            -> warning (kind 'coupled')
 * At most one conflict is reported per lane pair (the most severe one). Advisory as far as the runtime
 * goes — VisionInput never refuses to run — but the Setup screen MUST show them and should refuse to
 * start on an 'error': nothing downstream can separate the lanes, and an unearned hit is worse than a
 * miss. `hasBlockingLaneConflict` is the one-line check for that.
 */
/**
 * The fingertip a lane really uses: the therapist's choice, the default for finger_opposition when it
 * carries none, and undefined for every movement that has no fingertip dimension. Mirrors
 * `calibrationKey` in the store — the conflict rules must partition lanes exactly the way the
 * calibration store, the runtime and the trend view do, or the app blocks a prescription it can
 * otherwise represent end to end.
 */
function laneTip(l: LaneSpec): Fingertip | undefined {
  return l.movement === 'finger_opposition' ? (l.fingertip ?? DEFAULT_FINGERTIP) : undefined;
}

export function laneConflicts(lanes: readonly LaneSpec[]): LaneConflict[] {
  const out: LaneConflict[] = [];
  for (let i = 0; i < lanes.length; i++) {
    for (let j = i + 1; j < lanes.length; j++) {
      const a = lanes[i];
      const b = lanes[j];
      const ia = MOVEMENT_INFO[a.movement];
      const ib = MOVEMENT_INFO[b.movement];
      const sameSide = a.side === b.side;
      if (!sameSide) {
        // Different limbs are mechanically independent — except that a hand session cannot sensibly hold
        // the two hands in different setups (and the handedness labels suffer when it tries).
        if (ia.mode === 'hand' && ib.mode === 'hand' && ia.posture !== ib.posture) {
          out.push({
            lanes: [a.index, b.index], movements: [a.movement, b.movement], side: null, severity: 'warning', kind: 'posture',
            message: postureMessage(a.index, b.index, ia, ib, null),
          });
        }
        continue;
      }
      if (a.movement === b.movement) {
        // THE FINGERTIP IS PART OF THE MOVEMENT'S IDENTITY. Thumb-to-index and thumb-to-little on one
        // hand are two different quantities everywhere else in the app — different feature, different
        // calibration key, different stored range, different trend line — and prescribing exactly that
        // pair is the whole reason a therapist is offered the choice. Only the SAME tip twice is the
        // un-runnable duplicate; different tips are a coupling warning, because opposing one tip does
        // tend to draw its neighbours in.
        const ta = laneTip(a);
        const tb = laneTip(b);
        if (ta !== undefined && tb !== undefined && ta !== tb) {
          out.push({
            lanes: [a.index, b.index], movements: [a.movement, b.movement], side: a.side, severity: 'warning', kind: 'coupled',
            message: `Lanes ${a.index + 1} and ${b.index + 1} oppose the thumb to different fingers of the ${a.side} hand (${FINGERTIP_NAME[ta]} and ${FINGERTIP_NAME[tb]}). They are calibrated and scored separately, but a patient who cannot isolate the digits may trigger both — check each lane's meter alone on the camera screen.`,
          });
          continue;
        }
        out.push({
          lanes: [a.index, b.index], movements: [a.movement, b.movement], side: a.side, severity: 'error', kind: 'duplicate',
          message: `Lanes ${a.index + 1} and ${b.index + 1} are both ${ia.label}${ta ? ` (${FINGERTIP_NAME[ta]})` : ''} on the ${a.side} side: one movement would hit both lanes.`,
        });
        continue;
      }
      if (ia.posture !== ib.posture) {
        out.push({
          lanes: [a.index, b.index], movements: [a.movement, b.movement], side: a.side, severity: 'error', kind: 'posture',
          message: postureMessage(a.index, b.index, ia, ib, a.side),
        });
        continue;
      }
      const why = coupling(a.movement, b.movement);
      if (why) {
        out.push({
          lanes: [a.index, b.index], movements: [a.movement, b.movement], side: a.side, severity: 'warning', kind: 'coupled',
          message: `Lanes ${a.index + 1} (${ia.label}) and ${b.index + 1} (${ib.label}) use the same ${a.side} limb and ${why}, so they may trigger each other.`,
        });
      }
    }
  }
  return out;
}

/** True when the prescription contains an 'error' conflict: the Setup screen must not start the session. */
export function hasBlockingLaneConflict(lanes: readonly LaneSpec[]): boolean {
  return laneConflicts(lanes).some((c) => c.severity === 'error');
}

/**
 * The postures a prescription requires (deduplicated, in lane order). One entry = one coherent setup the
 * patient can actually hold; more than one is what `laneConflicts` reports on.
 */
export function requiredPostures(lanes: readonly LaneSpec[]): MovementPosture[] {
  const seen: MovementPosture[] = [];
  for (const l of lanes) {
    const p = MOVEMENT_INFO[l.movement].posture;
    if (!seen.includes(p)) seen.push(p);
  }
  return seen;
}
