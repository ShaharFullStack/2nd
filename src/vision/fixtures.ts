/**
 * Synthetic landmark generators for tests (no camera needed).
 * Coordinates follow MediaPipe: normalized image x/y (y down), z = depth (negative = toward camera).
 * The seated figure faces the camera; parameters are 0 (rest) .. 1 (full movement).
 */
import type { Side } from '../engine/types.ts';
import { FINGERTIP_INDEX, HAND, HAND_LANDMARK_COUNT, POSE, POSE_LANDMARK_COUNT, POSE_MIRROR_INDEX } from './landmarks.ts';
import type { Fingertip, Landmark } from './landmarks.ts';

/**
 * Re-normalize landmarks captured in a frame of aspect `fromAspect` (width/height) into a frame of
 * aspect `toAspect` showing the SAME physical scene at the same vertical scale.
 *
 * The rigs below are built for a SQUARE frame (fromAspect 1), which is exactly why they cannot, on their
 * own, catch the anisotropy bug: MediaPipe normalizes x by the frame width and y by the height, so a
 * real 16:9 webcam reports the same physical pose with x compressed by 16/9 relative to a square frame.
 * Feeding `reNormalizeAspect(pose, 1, 16/9)` to an extractor with `xScale: 16/9` must produce the same
 * number as the original pose with `xScale: 1` — that equality IS the guarantee "a fixed guard means the
 * same physical amount on any webcam".
 * y is unchanged (same fraction of frame height); x is re-expressed about the centre, and z with it
 * (MediaPipe documents z as "roughly the same scale as x").
 */
export function reNormalizeAspect(landmarks: readonly Landmark[], fromAspect: number, toAspect: number): Landmark[] {
  const k = fromAspect / toAspect;
  return landmarks.map((l) => ({ x: 0.5 + (l.x - 0.5) * k, y: l.y, z: l.z * k, visibility: l.visibility }));
}

/**
 * What a detection of the SAME pose looks like when the frames were horizontally flipped BEFORE being
 * given to the detector (`mirrored: true`).
 *
 * TWO things happen, and a test that does only the first cannot catch the bug that matters:
 *  1. the coordinates flip: x -> 1 - x (and z, which MediaPipe scales like x, keeps its sign — depth is
 *     unaffected by a horizontal flip);
 *  2. THE LABELS SWAP: a mirrored human is a perfectly ordinary human to the model, so it labels the
 *     apparent anatomy and the patient's LEFT leg comes back in the RIGHT_* slots (POSE_MIRROR_INDEX).
 * Applying (1) without (2) produces a frame no camera can ever deliver, and asserting on it only proves
 * the sign convention while the limb-selection bug passes untouched.
 */
export function mirrorPoseLandmarks(pose: readonly Landmark[]): Landmark[] {
  const out: Landmark[] = new Array(pose.length);
  for (let i = 0; i < pose.length; i++) {
    const src = pose[POSE_MIRROR_INDEX[i] ?? i] ?? pose[i];
    out[i] = { x: 1 - src.x, y: src.y, z: src.z, visibility: src.visibility };
  }
  return out;
}

/**
 * The same for metric WORLD landmarks: they share the Pose labelling, so the labels swap identically;
 * the coordinates are hip-centred metres, so x negates about 0 instead of about the frame centre.
 */
export function mirrorPoseWorldLandmarks(pose: readonly Landmark[]): Landmark[] {
  const out: Landmark[] = new Array(pose.length);
  for (let i = 0; i < pose.length; i++) {
    const src = pose[POSE_MIRROR_INDEX[i] ?? i] ?? pose[i];
    out[i] = { x: -src.x, y: src.y, z: src.z, visibility: src.visibility };
  }
  return out;
}

/** Translate every landmark (a chair scoot / camera bump: the whole scene shifts, the patient does not move). */
export function translateLandmarks(landmarks: readonly Landmark[], dx: number, dy: number): Landmark[] {
  return landmarks.map((l) => ({ x: l.x + dx, y: l.y + dy, z: l.z, visibility: l.visibility }));
}

export interface SeatedPoseParams {
  /** Knee lift (seated march) 0..1. */
  kneeLift?: number;
  /** Knee extension 0..1 (0 = 90° bent, 1 = straight). */
  kneeExtension?: number;
  /** Toe lift (dorsiflexion) 0..1. */
  toeLift?: number;
  /**
   * Knee moved laterally 0..1 = ABduction (outward). NEGATIVE values are ADduction (the knee pulled
   * inward across the midline) — the compensatory pattern hip_abduction is prescribed to correct, which
   * must NOT score.
   */
  abduction?: number;
  /** Heel lifted off the floor 0..1 (compensation). */
  heelLift?: number;
  /**
   * Lateral trunk lean, ~0..30 degrees at 0..1. NEGATIVE values lean the OTHER way, which is what a
   * patient with a resting lateral list does when they hike the opposite hip: the trunk swings through
   * vertical rather than deeper into the list.
   */
  trunkLean?: number;
  /** Which leg the parameters apply to (default 'left'); the other leg stays at rest. */
  side?: Side;
  /** Visibility assigned to all landmarks (default 0.95). */
  visibility?: number;
}

function lm(x: number, y: number, z: number, visibility = 0.95): Landmark {
  return { x, y, z, visibility };
}

const THIGH = 0.25;
const SHIN = 0.25;

/**
 * Seated patient facing the camera, knees-up in view. Hips at y=0.6, shoulders at y=0.3.
 * Left hip is at image x=0.6 (patient's left appears on the image right in a raw stream is NOT assumed
 * here — fixtures only need internal consistency).
 */
export function seatedPose(params: SeatedPoseParams = {}): Landmark[] {
  const vis = params.visibility ?? 0.95;
  const p: Landmark[] = Array.from({ length: POSE_LANDMARK_COUNT }, () => lm(0.5, 0.2, 0, vis));
  const lean = (params.trunkLean ?? 0) * 0.17; // ~30° at 1 for torso length 0.3
  p[POSE.NOSE] = lm(0.5 + lean, 0.15, -0.05, vis);
  p[POSE.LEFT_SHOULDER] = lm(0.64 + lean, 0.3, 0, vis);
  p[POSE.RIGHT_SHOULDER] = lm(0.36 + lean, 0.3, 0, vis);
  p[POSE.LEFT_HIP] = lm(0.6, 0.6, 0, vis);
  p[POSE.RIGHT_HIP] = lm(0.4, 0.6, 0, vis);

  const build = (side: Side, active: boolean) => {
    const sign = side === 'left' ? 1 : -1;
    const hip = side === 'left' ? p[POSE.LEFT_HIP] : p[POSE.RIGHT_HIP];
    const k = active ? (params.kneeLift ?? 0) : 0;
    const e = active ? (params.kneeExtension ?? 0) : 0;
    const d = active ? (params.toeLift ?? 0) : 0;
    const a = active ? (params.abduction ?? 0) : 0;
    const h = active ? (params.heelLift ?? 0) : 0;
    // Thigh points straight toward the camera (knee level with the hip); lifting the knee raises it (y decreases).
    const knee = { x: hip.x + sign * 0.15 * a, y: hip.y - 0.28 * k, z: -THIGH };
    // Shin hangs down at rest; extension swings the ankle forward (toward the camera).
    const th = (e * Math.PI) / 2;
    const ankle = { x: knee.x, y: knee.y + SHIN * Math.cos(th), z: knee.z - SHIN * Math.sin(th) };
    // Foot: forward and slightly down at rest; dorsiflexion rotates the toes up by up to ~40°.
    const footLen = 0.12;
    const restAngle = Math.atan2(0.03, 0.12); // slight downward pitch of the foot at rest
    const pitch = restAngle - d * (40 * Math.PI) / 180;
    const foot = { x: ankle.x, y: ankle.y + footLen * Math.sin(pitch), z: ankle.z - footLen * Math.cos(pitch) };
    const heel = { x: ankle.x, y: ankle.y + 0.03 - 0.06 * h, z: ankle.z + 0.03 };
    const idx = side === 'left'
      ? { knee: POSE.LEFT_KNEE, ankle: POSE.LEFT_ANKLE, heel: POSE.LEFT_HEEL, foot: POSE.LEFT_FOOT_INDEX }
      : { knee: POSE.RIGHT_KNEE, ankle: POSE.RIGHT_ANKLE, heel: POSE.RIGHT_HEEL, foot: POSE.RIGHT_FOOT_INDEX };
    p[idx.knee] = lm(knee.x, knee.y, knee.z, vis);
    p[idx.ankle] = lm(ankle.x, ankle.y, ankle.z, vis);
    p[idx.heel] = lm(heel.x, heel.y, heel.z, vis);
    p[idx.foot] = lm(foot.x, foot.y, foot.z, vis);
  };
  const active = params.side ?? 'left';
  build('left', active === 'left');
  build('right', active === 'right');
  return p;
}

/**
 * Metric "world" landmarks for the same seated figure (MediaPipe worldLandmarks: metres, hip-centred).
 * Same geometry as seatedPose scaled to a ~1.0 m torso-to-floor span, so tests can pass them as
 * FeatureOptions.worldLandmarks.
 */
export function seatedPoseWorld(params: SeatedPoseParams = {}, metresPerUnit = 1.6): Landmark[] {
  const p = seatedPose(params);
  const hipMid = { x: (p[POSE.LEFT_HIP].x + p[POSE.RIGHT_HIP].x) / 2, y: (p[POSE.LEFT_HIP].y + p[POSE.RIGHT_HIP].y) / 2, z: 0 };
  return p.map((l) => ({ x: (l.x - hipMid.x) * metresPerUnit, y: (l.y - hipMid.y) * metresPerUnit, z: l.z * metresPerUnit, visibility: l.visibility }));
}

export const seatedRest = (side: Side = 'left') => seatedPose({ side });
export const seatedKneeLifted = (amount = 1, side: Side = 'left') => seatedPose({ kneeLift: amount, side });
export const seatedLegExtended = (amount = 1, side: Side = 'left') => seatedPose({ kneeExtension: amount, side });
export const seatedToesLifted = (amount = 1, side: Side = 'left') => seatedPose({ toeLift: amount, side });
export const seatedKneeAbducted = (amount = 1, side: Side = 'left') => seatedPose({ abduction: amount, side });
/** Knee pulled INWARD across the midline (adduction): the wrong direction for hip_abduction. */
export const seatedKneeAdducted = (amount = 1, side: Side = 'left') => seatedPose({ abduction: -amount, side });

export interface HandParams {
  /** 0 = fist, 1 = fully open (default 1). */
  openness?: number;
  /**
   * Wrist extension 0..1: rotates the hand about the wrist's lateral axis from hanging slightly down with
   * the fingers toward the camera (0, elevation -10°) up to fingers pointing up / palm to camera (1, +80°).
   * Default: fingers up (elevation 90°), the palm-to-camera pose used by the other hand movements.
   */
  wristExtension?: number;
  /** Translate the whole hand up (forearm lift, a compensation — NOT wrist extension) 0..1. */
  wristRaise?: number;
  /** Thumb-to-fingertip pinch 0..1 (1 = touching `pinchTarget`). */
  pinch?: number;
  /**
   * Which fingertip the thumb pinches toward (default 'index'). The therapist can prescribe any of them
   * (RomCalibration.fingertip / FeatureOptions.fingertip), and a range measured on one is not a range
   * for another — so the fixture has to be able to produce the movement that was actually prescribed.
   */
  pinchTarget?: Fingertip;
  /** Finger spread 0..1 (0 = fingers together, 1 = wide). */
  spread?: number;
  /** Uniform scale (distance to the camera); default 1. */
  scale?: number;
  /** Image-x offset of the hand centre (default 0.5). */
  centerX?: number;
}

function h(x: number, y: number, z = 0): Landmark {
  return { x, y, z };
}

/**
 * Hand rig. Built in a palm-local frame (u across the palm toward the pinky, v along the fingers,
 * n out of the palm toward the camera), then pitched about the wrist's lateral axis by the elevation
 * angle: 90° = fingers up / palm to camera (default), 0° = fingers pointing at the camera.
 * Wrist at (centerX, 0.75). Palm size (wrist -> middle MCP) is 0.15 * scale; palm width 0.1 * scale.
 */
export function handPose(params: HandParams = {}): Landmark[] {
  const o = params.openness ?? 1;
  const w = params.wristRaise ?? 0;
  const pinch = params.pinch ?? 0;
  const spread = params.spread ?? 0;
  const s = params.scale ?? 1;
  const cx = params.centerX ?? 0.5;
  const elevDeg = params.wristExtension === undefined ? 90 : -10 + 90 * params.wristExtension;
  const phi = (elevDeg * Math.PI) / 180;
  const wristY = 0.75 - 0.15 * w * s;
  // Local (u, v, n) -> world: x = cx + u; y = wristY - v*sin(phi) + n*cos(phi); z = -v*cos(phi) - n*sin(phi).
  const world = (u: number, v: number, n: number): Landmark => h(cx + u, wristY - v * Math.sin(phi) + n * Math.cos(phi), -v * Math.cos(phi) - n * Math.sin(phi));
  const out: Landmark[] = Array.from({ length: HAND_LANDMARK_COUNT }, () => world(0, 0, 0));
  out[HAND.WRIST] = world(0, 0, 0);
  const fingerLen = 0.16 * s;
  // MCP row 0.15*s along the fingers from the wrist, slightly fanned.
  const mcpU = { index: -0.05, middle: -0.0167, ring: 0.0167, pinky: 0.05 };
  const mcpV = 0.15 * s;
  const fingers: Array<[keyof typeof mcpU, number, number, number, number, number]> = [
    ['index', HAND.INDEX_MCP, HAND.INDEX_PIP, HAND.INDEX_DIP, HAND.INDEX_TIP, -1],
    ['middle', HAND.MIDDLE_MCP, HAND.MIDDLE_PIP, HAND.MIDDLE_DIP, HAND.MIDDLE_TIP, -0.33],
    ['ring', HAND.RING_MCP, HAND.RING_PIP, HAND.RING_DIP, HAND.RING_TIP, 0.33],
    ['pinky', HAND.PINKY_MCP, HAND.PINKY_PIP, HAND.PINKY_DIP, HAND.PINKY_TIP, 1],
  ];
  const local: Array<{ u: number; v: number; n: number }> = Array.from({ length: HAND_LANDMARK_COUNT }, () => ({ u: 0, v: 0, n: 0 }));
  for (const [name, mcp, pip, dip, tip, fan] of fingers) {
    const mu = mcpU[name] * s;
    local[mcp] = { u: mu, v: mcpV, n: 0 };
    // Direction: along the fingers, fanned outward by spread (up to ~25° for the outer fingers).
    const ang = fan * spread * (25 * Math.PI) / 180;
    const du = Math.sin(ang);
    const dv = Math.cos(ang);
    // Openness: extended length along the direction; curled fingers fold back toward the palm (toward the camera).
    const ext = fingerLen * (0.25 + 0.75 * o);
    const curl = fingerLen * 0.5 * (1 - o);
    local[pip] = { u: mu + du * ext * 0.4, v: mcpV + dv * ext * 0.4, n: curl * 0.3 };
    local[dip] = { u: mu + du * ext * 0.75, v: mcpV + dv * ext * 0.75, n: curl * 0.7 };
    local[tip] = { u: mu + du * ext, v: mcpV + dv * ext, n: curl };
  }
  // Thumb: from the wrist out to the index side; pinch moves the tip onto the target fingertip.
  const thumbOpen = { u: -0.14 * s, v: 0.12 * s, n: 0 };
  const idxTip = local[FINGERTIP_INDEX[params.pinchTarget ?? 'index']];
  const tipU = thumbOpen.u + (idxTip.u - thumbOpen.u) * pinch;
  const tipV = thumbOpen.v + (idxTip.v - thumbOpen.v) * pinch;
  const tipN = thumbOpen.n + (idxTip.n - thumbOpen.n) * pinch;
  local[HAND.THUMB_CMC] = { u: -0.04 * s, v: 0.03 * s, n: 0 };
  local[HAND.THUMB_MCP] = { u: -0.08 * s, v: 0.06 * s, n: 0 };
  local[HAND.THUMB_IP] = { u: (local[HAND.THUMB_MCP].u + tipU) / 2, v: (local[HAND.THUMB_MCP].v + tipV) / 2, n: tipN / 2 };
  local[HAND.THUMB_TIP] = { u: tipU, v: tipV, n: tipN };
  for (let k = 1; k < HAND_LANDMARK_COUNT; k++) out[k] = world(local[k].u, local[k].v, local[k].n);
  return out;
}

export const handOpen = () => handPose({ openness: 1 });
export const handFist = () => handPose({ openness: 0 });
/** Wrist extension rep: the hand rotates up about the wrist (forearm stays put). */
export const handWristExtended = (amount = 1) => handPose({ wristExtension: amount });
/** Whole-hand translation only (forearm lift compensation) — wrist_extension must NOT respond to this. */
export const handWristRaised = (amount = 1) => handPose({ wristRaise: amount });
export const handPinch = (amount = 1) => handPose({ pinch: amount });
export const handSpread = (amount = 1) => handPose({ spread: amount });

/**
 * A geometrically impossible hand that the real HandLandmarker can still emit for a half-occluded hand:
 * all 21 landmarks present and finite, but every fingertip collapsed onto the wrist. Used to test the
 * plausibility gate (the real detector never returns FEWER than 21 landmarks, so slicing an array is not
 * a realistic failure mode).
 */
export function handCollapsed(): Landmark[] {
  const hand = handPose();
  const wrist = hand[HAND.WRIST];
  for (const t of [HAND.THUMB_TIP, HAND.INDEX_TIP, HAND.MIDDLE_TIP, HAND.RING_TIP, HAND.PINKY_TIP]) {
    hand[t] = { x: wrist.x, y: wrist.y, z: wrist.z };
  }
  return hand;
}

/**
 * A synthetic rep sequence: `reps` smooth bumps from 0 to `amplitude` over `repDurationSec` each after
 * `restSec` of rest, sampled at `fps`. Returns [{t, amount}] with amount in 0..1 to feed a generator.
 */
export function repSequence(opts: { restSec?: number; reps?: number; repDurationSec?: number; fps?: number; amplitude?: number; noise?: number; seed?: number } = {}): Array<{ t: number; amount: number }> {
  const rest = opts.restSec ?? 2.5;
  const reps = opts.reps ?? 3;
  const dur = opts.repDurationSec ?? 1.5;
  const fps = opts.fps ?? 30;
  const amp = opts.amplitude ?? 1;
  const noise = opts.noise ?? 0;
  let seed = (opts.seed ?? 1) >>> 0;
  const rnd = () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const total = rest + reps * dur + 0.5;
  const out: Array<{ t: number; amount: number }> = [];
  for (let i = 0; i * (1 / fps) <= total; i++) {
    const t = i / fps;
    let amount = 0;
    if (t >= rest && t < rest + reps * dur) {
      const phase = ((t - rest) % dur) / dur;
      amount = amp * 0.5 * (1 - Math.cos(2 * Math.PI * phase));
    }
    amount += noise * (rnd() - 0.5);
    out.push({ t, amount: Math.min(1, Math.max(0, amount)) });
  }
  return out;
}
