/**
 * THE SKELETON HAS TO LAND ON THE LIMB IT CAME FROM.
 *
 * The overlay canvas is the size of the 4:3 `.camera-frame` box; the <video> under it is
 * `object-fit: cover`, so a 16:9 frame is cropped 12.5 % off each side before the patient sees it.
 * Painting `p.x * width` therefore draws every landmark where it WOULD be if the sensor were 4:3 —
 * measured in the running app at 1280x720 on a 1024x768 tablet: a landmark the video showed at box
 * px 373 was painted at 344, 28 px in on a 518 px preview, 0.62 of a dwell ring radius.
 *
 * That is not a cosmetic error. The dots are the only positional feedback the patient has, so they
 * aim at them, and the secondary (smaller) dwell circle then sits more than a radius away from where
 * they are putting their limb: the ring never fills and nothing on screen says why.
 */
import { describe, expect, it } from 'vitest';
import { drawDetection } from './overlay.ts';
import type { DetectionResult } from '../vision/mediapipe.ts';
import { POSE } from '../vision/landmarks.ts';

const W = 518;
const H = (W * 3) / 4;

/** A 2D context that remembers where the dots were drawn. */
function recordingCtx(): { ctx: CanvasRenderingContext2D; dots: { x: number; y: number }[] } {
  const dots: { x: number; y: number }[] = [];
  const ctx = {
    lineWidth: 0,
    strokeStyle: '',
    fillStyle: '',
    clearRect: () => {},
    beginPath: () => {},
    moveTo: () => {},
    lineTo: () => {},
    stroke: () => {},
    fill: () => {},
    arc: (x: number, y: number) => {
      dots.push({ x, y });
    },
  } as unknown as CanvasRenderingContext2D;
  return { ctx, dots };
}

/** One pose landmark at (x, y), everything else parked out of the way but visible. */
function poseAt(x: number, y: number): DetectionResult {
  const pose = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 0 }));
  pose[POSE.LEFT_WRIST] = { x, y, z: 0, visibility: 1 };
  return { tMs: 0, pose, hands: [] };
}

/** Where the <video> puts a normalized x, per the `object-fit: cover` rule the CSS asks for. */
function coverX(nx: number, xScale: number): number {
  const visX = Math.min(1, 4 / 3 / xScale);
  return ((nx - (1 - visX) / 2) / visX) * W;
}

describe('the landmark overlay is painted through the same crop as the video', () => {
  it('a 4:3 frame in a 4:3 box is the identity — nothing changes for a camera that matched', () => {
    const { ctx, dots } = recordingCtx();
    drawDetection(ctx, poseAt(0.8, 0.4), W, H, 4 / 3);
    const drawn = dots.find((d) => Math.abs(d.y - 0.4 * H) < 0.001);
    expect(drawn, 'the visible landmark was painted').toBeTruthy();
    expect(drawn!.x).toBeCloseTo(0.8 * W, 6);
  });

  it('a 16:9 frame is cropped exactly as the preview crops it, not drawn as if it were 4:3', () => {
    const { ctx, dots } = recordingCtx();
    const nx = 0.8;
    drawDetection(ctx, poseAt(nx, 0.5), W, H, 16 / 9);
    const drawn = dots.find((d) => Math.abs(d.y - 0.5 * H) < 0.001);
    expect(drawn).toBeTruthy();
    // Where the patient sees their own wrist:
    expect(drawn!.x).toBeCloseTo(coverX(nx, 16 / 9), 6);
    // ...which is a long way from where it used to be painted. 0.62 of a primary ring radius
    // (0.115 frame heights) on this preview, and 0.79 of the secondary's.
    const naive = nx * W;
    const off = Math.abs(drawn!.x - naive);
    expect(off).toBeGreaterThan(0.5 * 0.115 * H);
  });

  it('the centre of the frame is the centre of the box on any sensor — the error grows with offset', () => {
    for (const xScale of [1, 4 / 3, 16 / 9, 2]) {
      const { ctx, dots } = recordingCtx();
      drawDetection(ctx, poseAt(0.5, 0.5), W, H, xScale);
      const drawn = dots.find((d) => Math.abs(d.y - 0.5 * H) < 1e-6);
      expect(drawn, `xScale ${xScale}`).toBeTruthy();
      expect(drawn!.x, `xScale ${xScale}`).toBeCloseTo(0.5 * W, 6);
    }
  });

  it('a taller-than-4:3 frame loses the top and bottom instead, and y is what moves', () => {
    const { ctx, dots } = recordingCtx();
    const ny = 0.8;
    drawDetection(ctx, poseAt(0.5, ny), W, H, 1);
    const visY = 1 / (4 / 3);
    const expected = ((ny - (1 - visY) / 2) / visY) * H;
    const drawn = dots.find((d) => Math.abs(d.x - 0.5 * W) < 1e-6);
    expect(drawn).toBeTruthy();
    expect(drawn!.y).toBeCloseTo(expected, 6);
    expect(Math.abs(drawn!.y - ny * H)).toBeGreaterThan(1);
  });

  it('draws nothing at all for no detection (and clears what was there)', () => {
    const { ctx, dots } = recordingCtx();
    drawDetection(ctx, null, W, H, 16 / 9);
    expect(dots).toHaveLength(0);
  });
});
