/**
 * Landmark overlay for the camera check: draws what the tracker actually sees, so a therapist can
 * tell "the patient is out of frame" from "the model is not running" without reading a status line.
 */
import type { DetectionResult } from '../vision/mediapipe.ts';
import { HAND, POSE } from '../vision/landmarks.ts';
import type { Landmark } from '../vision/landmarks.ts';
import { runtime } from '../session/runtime.ts';
import { PREVIEW_ASPECT, previewPlacement } from './DwellTarget.tsx';

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

/**
 * WHERE A LANDMARK LANDS ON THE GLASS — the same crop the <video> under it gets.
 *
 * The canvas is the size of the 4:3 `.camera-frame` box and the video inside it is
 * `object-fit: cover` (src/index.css), so a frame that is not 4:3 is CROPPED to fill the box: a
 * 16:9 sensor loses 12.5 % off each side. Painting `p.x * w` therefore draws the skeleton where the
 * landmark would be if the sensor were 4:3, which on the commonest sensor there is means every dot
 * is pulled toward the middle — measured at 28 px on a 518 px preview, 0.62 of a dwell ring radius.
 * That matters beyond looking wrong: the dots are the patient's only positional feedback, so they
 * aim at them, and the secondary (smaller) dwell target then never fills.
 *
 * `previewPlacement` is the one place that maths lives (it is what puts the dwell rings on the
 * glass), so this asks IT rather than keeping a second copy. The transform is affine, so two probe
 * points are enough to build the whole mapping once per frame.
 */
function placer(w: number, h: number, xScale: number): (p: Landmark) => { x: number; y: number } {
  const origin = previewPlacement({ x: 0, y: 0, radius: 0 }, xScale);
  const unit = previewPlacement({ x: 1, y: 1, radius: 0 }, xScale);
  const sx = (unit.x - origin.x) * w;
  const sy = (unit.y - origin.y) * h;
  const x0 = origin.x * w;
  const y0 = origin.y * h;
  return (p) => ({ x: x0 + p.x * sx, y: y0 + p.y * sy });
}

function drawSkeleton(
  ctx: Ctx2D,
  points: readonly Landmark[],
  bones: ReadonlyArray<readonly [number, number]>,
  at: (p: Landmark) => { x: number; y: number },
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
    const from = at(pa);
    const to = at(pb);
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
  }
  ctx.stroke();

  ctx.fillStyle = '#ffffff';
  for (const p of points) {
    if (!visible(p)) continue;
    const q = at(p);
    ctx.beginPath();
    ctx.arc(q.x, q.y, dotRadius, 0, Math.PI * 2);
    ctx.fill();
  }
}

/**
 * The aspect (width / height) of the frames the landmarks came from, asked of the camera session
 * that produced them — never assumed. Same source, and same defensiveness, as the dwell targets'
 * own placement (`DwellTarget.tsx`): a replay or stubbed source need not implement it, and with no
 * camera at all the authored 4:3 is also the shape of the box, so the mapping is the identity.
 */
export function liveFrameAspect(): number {
  const vision = runtime.peekVision();
  const s = typeof vision?.getXScale === 'function' ? vision.getXScale() : undefined;
  return typeof s === 'number' && Number.isFinite(s) && s > 0 ? s : PREVIEW_ASPECT;
}

/**
 * Paint one detection onto the overlay canvas (which sits on top of the <video>, same box).
 *
 * Coordinates are normalized 0..1 in the DETECTOR's frame; the preview may be CSS-mirrored, which
 * flips the canvas with it, so nothing is flipped here. `xScale` is the aspect (width / height) of
 * the frames those coordinates came from — `VisionInput.getXScale()`, the same number the dwell
 * targets are placed by. Omitting it asks the live camera (`liveFrameAspect`); what is never done
 * is assuming the camera delivered the 4:3 it was asked for.
 */
export function drawDetection(
  ctx: Ctx2D,
  result: DetectionResult | null,
  w: number,
  h: number,
  xScale: number = liveFrameAspect(),
): void {
  ctx.clearRect(0, 0, w, h);
  if (!result) return;
  const at = placer(w, h, xScale);
  const dot = Math.max(3, Math.round(Math.min(w, h) / 150));
  if (result.pose && result.pose.length > 0) {
    drawSkeleton(ctx, result.pose, POSE_BONES, at, w, h, 'rgba(53, 214, 255, 0.95)', dot);
  }
  for (const hand of result.hands) {
    drawSkeleton(ctx, hand.landmarks, HAND_BONES, at, w, h, 'rgba(255, 61, 127, 0.95)', dot * 0.8);
  }
}
