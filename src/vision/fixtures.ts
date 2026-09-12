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
  /**
   * WHERE THE HANDS ARE — and they are somewhere, which is the point.
   *
   * A seated patient exercising their legs has two arms in the picture, and in leg mode those hands are
   * the ONLY thing that can answer a dwell target (`dwellLimbs` stopped returning knees). This rig used
   * to leave every arm landmark on its unplaced (0.5, 0.2) placeholder, so a harness driving it could
   * only aim a knee — i.e. could not perform the one gesture the app supports, while a real patient
   * framed as the app asks them to be framed can.
   *
   * The four rest positions are the ones the dwell envelope is swept over in DwellTarget.test.tsx
   * ('the bodies the pipeline is driven with'), so a fixture hand rests where that proof says hands
   * rest. 'out_of_view' is the other real state: hands out of the picture, which is what the old
   * framing instruction invited and what the camera check now has to say out loud.
   *
   * AND A RESTING HAND IS NOT WORLD-FIXED — see `SEATED_HAND_SUPPORTS`. What holds the hand up decides
   * whether the leg prescription moves it, and the rig that said "the hands stay where they were"
   * whatever the leg did is the rig that hid this feature's third failure.
   */
  hands?: SeatedHandRest | 'out_of_view';
  /**
   * WHERE ALONG THE THIGH a thigh-supported hand sits: 0 = at the hip (the one point on the thigh that
   * does not move), 1 = at the knee. Defaults to the rest position's own fraction
   * (`SEATED_HAND_SUPPORTS`). Only meaningful for a rest whose support is 'thigh'.
   *
   * It exists so the sweeps can vary it, because THIS IS THE VARIABLE THE PROOF WAS MISSING: a hand at
   * fraction f rises by f x the knee's travel and is carried laterally by f x the knee's circumduction,
   * and a rig that pinned the wrist at the hip pinned exactly the quantity under test.
   */
  handThighFraction?: number;
  /**
   * ONE HAND RAISED TO A POINT (image coordinates) — the confirm gesture, and nothing else: the other
   * hand stays where it rests, the legs are untouched, and the scene is not translated. Aiming a hand
   * by translating the whole body (which is what a harness with no arms has to do) moves the knees,
   * the hips and the other hand with it, and can carry them out of frame.
   */
  handAt?: { side: Side; x: number; y: number };
  /**
   * ONE hand out of the picture, the other resting where `hands` says.
   *
   * The state that matters for the hands-free path: a patient with only one hand the camera can see.
   * If that hand is the one resting on the thigh, the app has no other limb to fall back on, so the
   * rings have to stand down and SAY so rather than let the exercise answer for them. `hands:
   * 'out_of_view'` hides both and cannot express it.
   */
  hideHand?: Side;
  /** Visibility assigned to all landmarks (default 0.95). */
  visibility?: number;
}

/** Where a seated patient's hands rest while their LEGS are working, in image coordinates. */
export type SeatedHandRest = 'thighs' | 'lap' | 'chair_arms' | 'folded';

export const SEATED_HAND_RESTS: Readonly<Record<SeatedHandRest, Readonly<Record<Side, { x: number; y: number }>>>> = Object.freeze({
  thighs: { left: { x: 0.64, y: 0.62 }, right: { x: 0.36, y: 0.62 } },
  lap: { left: { x: 0.58, y: 0.72 }, right: { x: 0.42, y: 0.72 } },
  chair_arms: { left: { x: 0.7, y: 0.45 }, right: { x: 0.3, y: 0.45 } },
  folded: { left: { x: 0.54, y: 0.55 }, right: { x: 0.46, y: 0.55 } },
});

/** What is holding a resting hand up — which is what decides whether the exercise moves it. */
export type SeatedHandSupport =
  /** The patient's own thigh: hip flexion and circumduction CARRY THE HAND. */
  | 'thigh'
  /** A chair arm, an armrest, a table: furniture, so the hand stays where it is in the world. */
  | 'fixed'
  /** Nothing but the arms, in front of the body: carried by a trunk lean, not by the leg. */
  | 'trunk';

/**
 * WHAT HOLDS EACH RESTING HAND UP, AND HOW MUCH OF THE LEG'S MOTION IT THEREFORE INHERITS.
 *
 * This table is the fixture fix for the third round of the same defect. A hand resting ON THE THIGH is
 * part of the thigh's kinematic chain: hip flexion rotates the thigh about the hip, so a hand at
 * fraction f along the hip->knee segment rises by f x the knee's vertical travel, and hip circumduction
 * (the compensation this app promises never to penalise) carries it sideways by f x the knee's lateral
 * travel at the same time. The rig used to hold every wrist at a world-fixed point and say "nothing
 * else in the figure moves", which made the hands-free proof a proof about a body that does not exist:
 * the 324-case sweep varied movement, side, pace, compensation, aspect and rest position and hard-coded
 * the one quantity the claim depends on.
 *
 * `fraction` is where along the thigh the hand sits — a hand rests mid-to-distal thigh (0.7), a hand in
 * the LAP sits on the proximal thighs (0.35) and moves less, and a hand on a CHAIR ARM or a table moves
 * not at all. Those are the numbers the sweeps start from; `SeatedPoseParams.handThighFraction`
 * overrides them so f itself can be swept.
 */
export const SEATED_HAND_SUPPORTS: Readonly<Record<SeatedHandRest, Readonly<{ support: SeatedHandSupport; fraction: number }>>> =
  Object.freeze({
    thighs: { support: 'thigh', fraction: 0.7 },
    lap: { support: 'thigh', fraction: 0.35 },
    chair_arms: { support: 'fixed', fraction: 0 },
    folded: { support: 'trunk', fraction: 0 },
  });

/** Visibility given to an arm that is out of the picture — below MIN_VISIBILITY, so nothing reads it. */
const HIDDEN_VISIBILITY = 0.05;

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

  /**
   * THE ARMS, which a seated leg patient has and this rig used to leave on the placeholder.
   *
   * A resting hand is placed BY ITS SUPPORT (`SEATED_HAND_SUPPORTS`), and that is the whole point of
   * this block:
   *   - 'thigh'  — the hand is carried by the thigh. Its offset from the hip at rest is preserved, and
   *                then it moves with f x (knee - hip): UP with hip flexion, SIDEWAYS with hip
   *                circumduction or abduction. A hand on the thigh is not a witness that is independent
   *                of the leg prescription; it is part of the leg.
   *   - 'fixed'  — a chair arm, an armrest, a table. The hand stays put whatever the leg and the trunk
   *                do, which is why this is the support the app now asks for.
   *   - 'trunk'  — folded in front of the body, so it swings with the same `lean` the shoulders do.
   * `handAt` raises ONE hand to a point and takes its elbow with it; the knees, the hips and the other
   * hand stay where they were, so a hand can be put on a dwell target without dragging the body.
   */
  const hands = params.hands ?? 'thighs';
  const hidden = hands === 'out_of_view';
  const support = hidden ? SEATED_HAND_SUPPORTS.lap : SEATED_HAND_SUPPORTS[hands];
  const thighF = params.handThighFraction ?? support.fraction;
  for (const side of ['left', 'right'] as Side[]) {
    const raised = params.handAt && params.handAt.side === side ? params.handAt : null;
    // A hand RAISED to a point is in the picture whatever the framing says: that is the gesture, and a
    // patient who brings one hand back into frame has one pointer and not none.
    const gone = !raised && (hidden || params.hideHand === side);
    const sign = side === 'left' ? 1 : -1;
    const shoulder = side === 'left' ? p[POSE.LEFT_SHOULDER] : p[POSE.RIGHT_SHOULDER];
    const hip = side === 'left' ? p[POSE.LEFT_HIP] : p[POSE.RIGHT_HIP];
    const knee = side === 'left' ? p[POSE.LEFT_KNEE] : p[POSE.RIGHT_KNEE];
    // How much of this leg's own travel the hand inherits, and how much of the trunk's.
    const carry = support.support === 'thigh' ? thighF : 0;
    const sway = support.support === 'trunk' ? lean : 0;
    const restAt = hidden ? SEATED_HAND_RESTS.lap[side] : SEATED_HAND_RESTS[hands][side];
    // Out of the picture: below the bottom edge (a frame cropped to hips, knees and feet), and
    // reported at a visibility nothing in the app will read (MIN_VISIBILITY is 0.5).
    const at = raised
      ? { x: raised.x, y: raised.y }
      : gone
        ? { x: restAt.x + sway, y: 1.18 }
        : { x: restAt.x + sway + carry * (knee.x - hip.x), y: restAt.y + carry * (knee.y - hip.y) };
    const armVis = gone ? HIDDEN_VISIBILITY : vis;
    // Hands on the thighs / on a raised target are forward of the hips, toward the camera.
    const wristZ = raised ? -0.05 : -0.12;
    const idx = side === 'left'
      ? { elbow: POSE.LEFT_ELBOW, wrist: POSE.LEFT_WRIST }
      : { elbow: POSE.RIGHT_ELBOW, wrist: POSE.RIGHT_WRIST };
    p[idx.wrist] = lm(at.x, at.y, wristZ, armVis);
    p[idx.elbow] = lm(shoulder.x + (at.x - shoulder.x) * 0.55 + sign * 0.025, shoulder.y + (at.y - shoulder.y) * 0.55, wristZ / 2, armVis);
  }
  return p;
}

/** A seated figure with one hand raised to a point — the whole of the leg-mode confirm gesture. */
export const seatedHandAt = (x: number, y: number, side: Side = 'left', params: SeatedPoseParams = {}) =>
  seatedPose({ ...params, handAt: { side, x, y } });
/** A seated figure framed on hips, knees and feet: legs in view, hands out of the picture. */
export const seatedHandsOutOfView = (params: SeatedPoseParams = {}) => seatedPose({ ...params, hands: 'out_of_view' });

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
