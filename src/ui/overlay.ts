/**
 * Landmark overlay for the camera check: draws what the tracker actually sees, so a therapist can
 * tell "the patient is out of frame" from "the model is not running" without reading a status line.
 */
import type { DetectionResult } from '../vision/mediapipe.ts';
import { HAND, POSE } from '../vision/landmarks.ts';
import type { Landmark } from '../vision/landmarks.ts';

type Ctx2D = CanvasRenderingContext2D;

const POSE_BONES: ReadonlyArray<readonly [number, number]> = [
  [POSE.LEFT_SHOULDER, POSE.RIGHT_SHOULDER],
  [POSE.LEFT_SHOULDER, POSE.LEFT_HIP],
  [POSE.RIGHT_SHOULDER, POSE.RIGHT_HIP],
  [POSE.LEFT_HIP, POSE.RIGHT_HIP],
  [POSE.LEFT_HIP, POSE.LEFT_KNEE],
  [POSE.LEFT_KNEE, POSE.LEFT_ANKLE],
  [POSE.LEFT_ANKLE, POSE.LEFT_HEEL],
  [POSE.LEFT_ANKLE, POSE.LEFT_FOOT_INDEX],
  [POSE.LEFT_HEEL, POSE.LEFT_FOOT_INDEX],
  [POSE.RIGHT_HIP, POSE.RIGHT_KNEE],
  [POSE.RIGHT_KNEE, POSE.RIGHT_ANKLE],
  [POSE.RIGHT_ANKLE, POSE.RIGHT_HEEL],
  [POSE.RIGHT_ANKLE, POSE.RIGHT_FOOT_INDEX],
  [POSE.RIGHT_HEEL, POSE.RIGHT_FOOT_INDEX],
  [POSE.LEFT_SHOULDER, POSE.LEFT_ELBOW],
  [POSE.LEFT_ELBOW, POSE.LEFT_WRIST],
  [POSE.RIGHT_SHOULDER, POSE.RIGHT_ELBOW],
  [POSE.RIGHT_ELBOW, POSE.RIGHT_WRIST],
];

const HAND_BONES: ReadonlyArray<readonly [number, number]> = [
  [HAND.WRIST, HAND.THUMB_CMC], [HAND.THUMB_CMC, HAND.THUMB_MCP], [HAND.THUMB_MCP, HAND.THUMB_IP], [HAND.THUMB_IP, HAND.THUMB_TIP],
  [HAND.WRIST, HAND.INDEX_MCP], [HAND.INDEX_MCP, HAND.INDEX_PIP], [HAND.INDEX_PIP, HAND.INDEX_DIP], [HAND.INDEX_DIP, HAND.INDEX_TIP],
  [HAND.INDEX_MCP, HAND.MIDDLE_MCP], [HAND.MIDDLE_MCP, HAND.MIDDLE_PIP], [HAND.MIDDLE_PIP, HAND.MIDDLE_DIP], [HAND.MIDDLE_DIP, HAND.MIDDLE_TIP],
  [HAND.MIDDLE_MCP, HAND.RING_MCP], [HAND.RING_MCP, HAND.RING_PIP], [HAND.RING_PIP, HAND.RING_DIP], [HAND.RING_DIP, HAND.RING_TIP],
  [HAND.RING_MCP, HAND.PINKY_MCP], [HAND.PINKY_MCP, HAND.PINKY_PIP], [HAND.PINKY_PIP, HAND.PINKY_DIP], [HAND.PINKY_DIP, HAND.PINKY_TIP],
  [HAND.WRIST, HAND.PINKY_MCP],
];

const MIN_DRAW_VISIBILITY = 0.35;

function visible(l: Landmark | undefined): boolean {
  return !!l && (l.visibility === undefined || l.visibility >= MIN_DRAW_VISIBILITY);
}

function drawSkeleton(
  ctx: Ctx2D,
  points: readonly Landmark[],
  bones: ReadonlyArray<readonly [number, number]>,
  w: number,
  h: number,
  color: string,
  dotRadius: number,
): void {
  ctx.lineWidth = Math.max(2, Math.round(Math.min(w, h) / 220));
  ctx.strokeStyle = color;
  ctx.beginPath();
  for (const [a, b] of bones) {
    const pa = points[a];
    const pb = points[b];
    if (!visible(pa) || !visible(pb)) continue;
    ctx.moveTo(pa.x * w, pa.y * h);
    ctx.lineTo(pb.x * w, pb.y * h);
  }
  ctx.stroke();

  ctx.fillStyle = '#ffffff';
  for (const p of points) {
    if (!visible(p)) continue;
    ctx.beginPath();
    ctx.arc(p.x * w, p.y * h, dotRadius, 0, Math.PI * 2);
    ctx.fill();
  }
}

/**
 * Paint one detection onto the overlay canvas (which sits on top of the <video>, same box).
 * Coordinates are normalized 0..1 in the DETECTOR's frame; the preview may be CSS-mirrored, which
 * flips the canvas with it, so nothing is flipped here.
 */
export function drawDetection(ctx: Ctx2D, result: DetectionResult | null, w: number, h: number): void {
  ctx.clearRect(0, 0, w, h);
  if (!result) return;
  const dot = Math.max(3, Math.round(Math.min(w, h) / 150));
  if (result.pose && result.pose.length > 0) {
    drawSkeleton(ctx, result.pose, POSE_BONES, w, h, 'rgba(53, 214, 255, 0.95)', dot);
  }
  for (const hand of result.hands) {
    drawSkeleton(ctx, hand.landmarks, HAND_BONES, w, h, 'rgba(255, 61, 127, 0.95)', dot * 0.8);
  }
}
