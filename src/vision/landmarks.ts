/**
 * Minimal landmark types + MediaPipe index constants + geometry helpers.
 *
 * Coordinate convention (MediaPipe normalized landmarks):
 *   x: 0 = image left, 1 = image right;  y: 0 = image top, 1 = image bottom (y grows DOWNWARD);
 *   z: depth, roughly the same scale as x, negative = closer to the camera (Pose: relative to hips).
 * Raw getUserMedia frames are NOT mirrored (see src/vision/mediapipe.ts for the handedness convention).
 */

export interface Landmark {
  x: number;
  y: number;
  z: number;
  /** Pose only (0..1). Hand landmarks usually have none / 0 — treat undefined as visible. */
  visibility?: number;
}

/** Pose landmarks below this visibility are treated as missing. */
export const MIN_VISIBILITY = 0.5;

/* ---------------- MediaPipe Pose (33 landmarks) ---------------- */
export const POSE = {
  NOSE: 0,
  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13,
  RIGHT_ELBOW: 14,
  LEFT_WRIST: 15,
  RIGHT_WRIST: 16,
  LEFT_HIP: 23,
  RIGHT_HIP: 24,
  LEFT_KNEE: 25,
  RIGHT_KNEE: 26,
  LEFT_ANKLE: 27,
  RIGHT_ANKLE: 28,
  LEFT_HEEL: 29,
  RIGHT_HEEL: 30,
  LEFT_FOOT_INDEX: 31,
  RIGHT_FOOT_INDEX: 32,
} as const;
export const POSE_LANDMARK_COUNT = 33;

/* ---------------- MediaPipe Hands (21 landmarks) ---------------- */
export const HAND = {
  WRIST: 0,
  THUMB_CMC: 1,
  THUMB_MCP: 2,
  THUMB_IP: 3,
  THUMB_TIP: 4,
  INDEX_MCP: 5,
  INDEX_PIP: 6,
  INDEX_DIP: 7,
  INDEX_TIP: 8,
  MIDDLE_MCP: 9,
  MIDDLE_PIP: 10,
  MIDDLE_DIP: 11,
  MIDDLE_TIP: 12,
  RING_MCP: 13,
  RING_PIP: 14,
  RING_DIP: 15,
  RING_TIP: 16,
  PINKY_MCP: 17,
  PINKY_PIP: 18,
  PINKY_DIP: 19,
  PINKY_TIP: 20,
} as const;
export const HAND_LANDMARK_COUNT = 21;

export type Fingertip = 'index' | 'middle' | 'ring' | 'pinky';
export const FINGERTIP_INDEX: Record<Fingertip, number> = {
  index: HAND.INDEX_TIP,
  middle: HAND.MIDDLE_TIP,
  ring: HAND.RING_TIP,
  pinky: HAND.PINKY_TIP,
};

/* ---------------- geometry ---------------- */

export interface Vec3 { x: number; y: number; z: number; }

export function sub(a: Landmark | Vec3, b: Landmark | Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function length(v: Vec3): number {
  return Math.hypot(v.x, v.y, v.z);
}

/** 3D euclidean distance. */
export function distance(a: Landmark | Vec3, b: Landmark | Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** 2D (image-plane) euclidean distance. */
export function distance2d(a: Landmark | Vec3, b: Landmark | Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function midpoint(a: Landmark | Vec3, b: Landmark | Vec3): Vec3 {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
}

/** Angle in degrees between two vectors (0..180). Returns 0 for a zero-length vector. */
export function angleBetween(u: Vec3, v: Vec3): number {
  const lu = length(u);
  const lv = length(v);
  if (lu === 0 || lv === 0) return 0;
  const c = (u.x * v.x + u.y * v.y + u.z * v.z) / (lu * lv);
  return (Math.acos(Math.min(1, Math.max(-1, c))) * 180) / Math.PI;
}

/** Angle in degrees between two vectors using only x/y. */
export function angleBetween2d(u: Vec3, v: Vec3): number {
  return angleBetween({ x: u.x, y: u.y, z: 0 }, { x: v.x, y: v.y, z: 0 });
}

/** Interior angle (degrees) at joint `b` formed by a-b-c (e.g. hip-knee-ankle). 180 = straight. */
export function angleAtJoint(a: Landmark | Vec3, b: Landmark | Vec3, c: Landmark | Vec3): number {
  return angleBetween(sub(a, b), sub(c, b));
}

/** Palm size: wrist -> middle finger MCP distance (2D+z). Scale-normalizer for hand features. */
export function palmSize(hand: readonly Landmark[]): number {
  return distance(hand[HAND.WRIST], hand[HAND.MIDDLE_MCP]);
}

/** Palm size in the image plane only (wrist -> middle MCP, x/y). Used by the 2D hand features. */
export function palmSize2d(hand: readonly Landmark[]): number {
  return distance2d(hand[HAND.WRIST], hand[HAND.MIDDLE_MCP]);
}

/**
 * Palm width in the image plane: index MCP -> pinky MCP. The MCP row is parallel to the wrist
 * flexion/extension axis, so this length is invariant under wrist extension (unlike palm length,
 * which foreshortens) — it is the scale normalizer for wrist_extension.
 */
export function palmWidth2d(hand: readonly Landmark[]): number {
  return distance2d(hand[HAND.INDEX_MCP], hand[HAND.PINKY_MCP]);
}

/** True when the landmark exists and (for pose) its visibility is at least `minVisibility`. */
export function isVisible(lm: Landmark | undefined, minVisibility: number = MIN_VISIBILITY): lm is Landmark {
  if (!lm) return false;
  if (!Number.isFinite(lm.x) || !Number.isFinite(lm.y)) return false;
  return lm.visibility === undefined || lm.visibility >= minVisibility;
}

/** True when every listed index is present and visible. */
export function allVisible(lms: readonly Landmark[] | null | undefined, indices: readonly number[], minVisibility: number = MIN_VISIBILITY): boolean {
  if (!lms) return false;
  for (const i of indices) if (!isVisible(lms[i], minVisibility)) return false;
  return true;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
