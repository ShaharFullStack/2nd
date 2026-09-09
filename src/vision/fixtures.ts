/**
 * Synthetic landmark generators for tests (no camera needed).
 * Coordinates follow MediaPipe: normalized image x/y (y down), z = depth (negative = toward camera).
 * The seated figure faces the camera; parameters are 0 (rest) .. 1 (full movement).
 */
import type { Side } from '../engine/types.ts';
import { HAND, HAND_LANDMARK_COUNT, POSE, POSE_LANDMARK_COUNT } from './landmarks.ts';
import type { Landmark } from './landmarks.ts';

export interface SeatedPoseParams {
  /** Knee lift (seated march) 0..1. */
  kneeLift?: number;
  /** Knee extension 0..1 (0 = 90° bent, 1 = straight). */
  kneeExtension?: number;
  /** Toe lift (dorsiflexion) 0..1. */
  toeLift?: number;
  /** Knee moved laterally (abduction) 0..1. */
  abduction?: number;
  /** Heel lifted off the floor 0..1 (compensation). */
  heelLift?: number;
  /** Lateral trunk lean 0..1 (compensation, ~0..30°). */
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

export const seatedRest = (side: Side = 'left') => seatedPose({ side });
export const seatedKneeLifted = (amount = 1, side: Side = 'left') => seatedPose({ kneeLift: amount, side });
export const seatedLegExtended = (amount = 1, side: Side = 'left') => seatedPose({ kneeExtension: amount, side });
export const seatedToesLifted = (amount = 1, side: Side = 'left') => seatedPose({ toeLift: amount, side });
export const seatedKneeAbducted = (amount = 1, side: Side = 'left') => seatedPose({ abduction: amount, side });

export interface HandParams {
  /** 0 = fist, 1 = fully open (default 1). */
  openness?: number;
  /** Raise the whole hand (wrist extension) 0..1. */
  wristRaise?: number;
  /** Thumb-index pinch 0..1 (1 = touching). */
  pinch?: number;
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
 * Hand with the palm facing the camera, fingers pointing up (y decreasing). Wrist at (centerX, 0.75).
 * Palm size (wrist -> middle MCP) is 0.15 * scale.
 */
export function handPose(params: HandParams = {}): Landmark[] {
  const o = params.openness ?? 1;
  const w = params.wristRaise ?? 0;
  const pinch = params.pinch ?? 0;
  const spread = params.spread ?? 0;
  const s = params.scale ?? 1;
  const cx = params.centerX ?? 0.5;
  const wristY = 0.75 - 0.15 * w * s;
  const out: Landmark[] = Array.from({ length: HAND_LANDMARK_COUNT }, () => h(cx, wristY));
  const wrist = h(cx, wristY, 0);
  out[HAND.WRIST] = wrist;
  const fingerLen = 0.16 * s;
  // MCP row 0.15*s above the wrist, slightly fanned.
  const mcpX = { index: -0.05, middle: -0.0167, ring: 0.0167, pinky: 0.05 };
  const mcpY = wristY - 0.15 * s;
  const fingers: Array<[keyof typeof mcpX, number, number, number, number, number]> = [
    ['index', HAND.INDEX_MCP, HAND.INDEX_PIP, HAND.INDEX_DIP, HAND.INDEX_TIP, -1],
    ['middle', HAND.MIDDLE_MCP, HAND.MIDDLE_PIP, HAND.MIDDLE_DIP, HAND.MIDDLE_TIP, -0.33],
    ['ring', HAND.RING_MCP, HAND.RING_PIP, HAND.RING_DIP, HAND.RING_TIP, 0.33],
    ['pinky', HAND.PINKY_MCP, HAND.PINKY_PIP, HAND.PINKY_DIP, HAND.PINKY_TIP, 1],
  ];
  for (const [name, mcp, pip, dip, tip, fan] of fingers) {
    const mx = cx + mcpX[name] * s;
    out[mcp] = h(mx, mcpY, 0);
    // Direction: up, fanned outward by spread (up to ~25° for the outer fingers).
    const ang = fan * spread * (25 * Math.PI) / 180;
    const dx = Math.sin(ang);
    const dy = -Math.cos(ang);
    // Openness: extended length along the direction; curled fingers fold back toward the palm (z toward camera).
    const ext = fingerLen * (0.25 + 0.75 * o);
    const curlZ = -fingerLen * 0.5 * (1 - o);
    out[pip] = h(mx + dx * ext * 0.4, mcpY + dy * ext * 0.4, curlZ * 0.3);
    out[dip] = h(mx + dx * ext * 0.75, mcpY + dy * ext * 0.75, curlZ * 0.7);
    out[tip] = h(mx + dx * ext, mcpY + dy * ext, curlZ);
  }
  // Thumb: from the wrist out to the index side; pinch moves the tip to the index tip.
  const thumbOpen = { x: cx - 0.14 * s, y: wristY - 0.12 * s, z: 0 };
  const idxTip = out[HAND.INDEX_TIP];
  const tipX = thumbOpen.x + (idxTip.x - thumbOpen.x) * pinch;
  const tipY = thumbOpen.y + (idxTip.y - thumbOpen.y) * pinch;
  const tipZ = thumbOpen.z + (idxTip.z - thumbOpen.z) * pinch;
  out[HAND.THUMB_CMC] = h(cx - 0.04 * s, wristY - 0.03 * s, 0);
  out[HAND.THUMB_MCP] = h(cx - 0.08 * s, wristY - 0.06 * s, 0);
  out[HAND.THUMB_IP] = h((out[HAND.THUMB_MCP].x + tipX) / 2, (out[HAND.THUMB_MCP].y + tipY) / 2, tipZ / 2);
  out[HAND.THUMB_TIP] = h(tipX, tipY, tipZ);
  return out;
}

export const handOpen = () => handPose({ openness: 1 });
export const handFist = () => handPose({ openness: 0 });
export const handWristRaised = (amount = 1) => handPose({ wristRaise: amount });
export const handPinch = (amount = 1) => handPose({ pinch: amount });
export const handSpread = (amount = 1) => handPose({ spread: amount });

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
