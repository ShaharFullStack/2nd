/**
 * The frame-aspect (anisotropy) guarantee: MediaPipe normalizes x by the frame WIDTH and y by the
 * HEIGHT, so every mixed-axis feature is scaled by the webcam's aspect ratio unless it is corrected.
 * These tests pin the corrected behaviour: the SAME physical pose, re-normalized for a different frame
 * shape, must produce the SAME feature — otherwise the fixed guards (MOVEMENT_INFO.minRom,
 * HEEL_LIFT_TOLERANCE, the trunk-lean degrees) mean a different physical amount on every laptop.
 */
import { describe, expect, it } from 'vitest';
import type { Movement, Side } from '../engine/types.ts';
import { HEEL_LIFT_TOLERANCE, MOVEMENT_INFO, checkCompensation, captureCompensationBaseline, extractFeature, measureCompensation, trunkTiltDeg } from './features.ts';
import { handPose, reNormalizeAspect, seatedPose, seatedRest, translateLandmarks } from './fixtures.ts';
import { aspectScale } from './landmarks.ts';
import type { Landmark } from './landmarks.ts';

const FOUR_THREE = 4 / 3;
const SIXTEEN_NINE = 16 / 9;

/** The same physical pose as a square-frame rig would see it, re-normalized for `aspect`. */
function asSeenBy(square: Landmark[], aspect: number): Landmark[] {
  return reNormalizeAspect(square, 1, aspect);
}

describe('aspectScale', () => {
  it('is width/height, and 1 for a missing or degenerate size', () => {
    expect(aspectScale(640, 480)).toBeCloseTo(FOUR_THREE, 10);
    expect(aspectScale(1280, 720)).toBeCloseTo(SIXTEEN_NINE, 10);
    expect(aspectScale(0, 480)).toBe(1);
    expect(aspectScale(undefined, undefined)).toBe(1);
    expect(aspectScale(NaN, 480)).toBe(1);
  });
});

describe('features are identical on any frame aspect once xScale is applied', () => {
  const cases: Array<{ movement: Movement; side: Side; pose: (a: number) => Landmark[] }> = [
    { movement: 'seated_march', side: 'left', pose: (a) => seatedPose({ kneeLift: a }) },
    { movement: 'knee_extension', side: 'left', pose: (a) => seatedPose({ kneeExtension: a }) },
    { movement: 'ankle_dorsiflexion', side: 'left', pose: (a) => seatedPose({ toeLift: a }) },
    { movement: 'hip_abduction', side: 'left', pose: (a) => seatedPose({ abduction: a }) },
    { movement: 'hand_open_close', side: 'right', pose: (a) => handPose({ openness: a }) },
    { movement: 'wrist_extension', side: 'right', pose: (a) => handPose({ wristExtension: a }) },
    { movement: 'finger_opposition', side: 'right', pose: (a) => handPose({ pinch: a }) },
    { movement: 'finger_spread', side: 'right', pose: (a) => handPose({ spread: a }) },
  ];

  for (const { movement, side, pose } of cases) {
    it(`${movement}: 4:3 and 16:9 report the same number`, () => {
      for (const amount of [0, 0.5, 1]) {
        const square = pose(amount);
        const ref = extractFeature(movement, square, side, { xScale: 1 })!;
        const fourThree = extractFeature(movement, asSeenBy(square, FOUR_THREE), side, { xScale: FOUR_THREE })!;
        const wide = extractFeature(movement, asSeenBy(square, SIXTEEN_NINE), side, { xScale: SIXTEEN_NINE })!;
        expect(fourThree, `${movement}@${amount} 4:3`).toBeCloseTo(ref, 8);
        expect(wide, `${movement}@${amount} 16:9`).toBeCloseTo(ref, 8);
      }
    });
  }

  it('WITHOUT the correction the same pose measures differently per webcam (the bug this guards)', () => {
    const square = seatedPose({ abduction: 1 });
    const ref = extractFeature('hip_abduction', square, 'left')!;
    const wideUncorrected = extractFeature('hip_abduction', asSeenBy(square, SIXTEEN_NINE), 'left')!;
    expect(wideUncorrected).toBeLessThan(ref * 0.7); // ~1/1.78 of the true value
    // ... and the difference is big enough to swallow the movement's whole minimum ROM.
    expect(ref - wideUncorrected).toBeGreaterThan(MOVEMENT_INFO.hip_abduction.minRom);
  });

  it('the ROM a patient must reach is the same on both cameras (the therapeutic consequence)', () => {
    for (const [movement, gen, side] of [
      ['hip_abduction', (a: number) => seatedPose({ abduction: a }), 'left'],
      ['finger_spread', (a: number) => handPose({ spread: a }), 'right'],
    ] as const) {
      const rom = (aspect: number) => {
        const lo = extractFeature(movement, asSeenBy(gen(0), aspect), side, { xScale: aspect })!;
        const hi = extractFeature(movement, asSeenBy(gen(1), aspect), side, { xScale: aspect })!;
        return hi - lo;
      };
      expect(rom(SIXTEEN_NINE), movement).toBeCloseTo(rom(FOUR_THREE), 8);
    }
  });

  it('world landmarks stay metric: xScale is not applied to them', () => {
    const pose = seatedPose({ kneeExtension: 0.6 });
    const world = seatedPose({ kneeExtension: 0.6 }); // stand-in metric set (already isotropic)
    const a = extractFeature('knee_extension', pose, 'left', { worldLandmarks: world, xScale: 1 })!;
    const b = extractFeature('knee_extension', asSeenBy(pose, SIXTEEN_NINE), 'left', { worldLandmarks: world, xScale: SIXTEEN_NINE })!;
    expect(b).toBeCloseTo(a, 10);
  });

  it('trunk tilt and the heel-lift tolerance are also aspect-invariant', () => {
    const leaning = seatedPose({ kneeLift: 1, trunkLean: 1 });
    expect(trunkTiltDeg(asSeenBy(leaning, SIXTEEN_NINE), undefined, SIXTEEN_NINE)!).toBeCloseTo(trunkTiltDeg(leaning)!, 6);
    const base = captureCompensationBaseline('ankle_dorsiflexion', asSeenBy(seatedRest(), SIXTEEN_NINE), 'left', { xScale: SIXTEEN_NINE })!;
    const cheat = checkCompensation('ankle_dorsiflexion', asSeenBy(seatedPose({ toeLift: 1, heelLift: 1 }), SIXTEEN_NINE), 'left', base, { xScale: SIXTEEN_NINE })!;
    const squareCheat = checkCompensation('ankle_dorsiflexion', seatedPose({ toeLift: 1, heelLift: 1 }), 'left', captureCompensationBaseline('ankle_dorsiflexion', seatedRest(), 'left')!)!;
    expect(cheat.value).toBeCloseTo(squareCheat.value, 6);
    expect(cheat.tolerance).toBe(HEEL_LIFT_TOLERANCE);
  });
});

describe('heel-lift compensation is translation invariant', () => {
  const baseline = captureCompensationBaseline('ankle_dorsiflexion', seatedRest(), 'left')!;

  it('a chair scoot / camera bump between rest and the rep does NOT flag a compensation', () => {
    // 0.02 of the frame over a 0.25 shin used to read as a 0.08 "rise" — two thirds of the tolerance.
    for (const dy of [-0.05, -0.02, 0.02, 0.05]) {
      const shifted = translateLandmarks(seatedPose({ toeLift: 1 }), 0.01, dy);
      const res = checkCompensation('ankle_dorsiflexion', shifted, 'left', baseline)!;
      expect(res.flagged, `dy=${dy}`).toBe(false);
      expect(Math.abs(res.value), `dy=${dy}`).toBeLessThan(0.02);
    }
  });

  it('a real heel lift is still flagged, and the same amount at any position', () => {
    const cheat = seatedPose({ toeLift: 1, heelLift: 1 });
    const here = checkCompensation('ankle_dorsiflexion', cheat, 'left', baseline)!;
    const overThere = checkCompensation('ankle_dorsiflexion', translateLandmarks(cheat, -0.08, 0.06), 'left', baseline)!;
    expect(here.flagged).toBe(true);
    expect(overThere.flagged).toBe(true);
    expect(overThere.value).toBeCloseTo(here.value, 9);
  });

  it('the raw quantity is a shin-relative ratio, not an image y', () => {
    const s = measureCompensation('ankle_dorsiflexion', seatedRest(), 'left')!;
    const moved = measureCompensation('ankle_dorsiflexion', translateLandmarks(seatedRest(), 0.1, 0.1), 'left')!;
    expect(s.value).toBeCloseTo(moved.value, 9);
    expect(s.value).toBeLessThan(1); // a ratio of the shin length, not an absolute coordinate
    expect(s.scale).toBeGreaterThan(0.2); // the shin length is still reported for display
  });
});
