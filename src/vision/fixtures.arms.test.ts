/**
 * THE SEATED RIG HAS ARMS — and in leg mode they are the only thing that can answer a dwell target.
 *
 * `dwellLimbs` returns the HANDS in leg mode and nothing else (a seated patient puts a knee somewhere
 * only by performing a prescribed leg movement — see the header of dwell.ts). But this rig left every
 * arm landmark on its unplaced (0.5, 0.2) placeholder, so anything driven off it — the two critic
 * harnesses included — had to aim a knee and could not perform the supported gesture at all. Worse, the
 * placeholder is a *visible landmark*: it reported a hand that was not modelled, at a point no hand
 * could be, which is the kind of fake evidence a harness must never be able to produce.
 *
 * What is pinned here: where the hands are, that moving one of them moves NOTHING else, that hands out
 * of the picture leave leg mode with no pointer at all, and that none of it touches a measurement.
 * (That the raised hand actually fills a ring is proved end-to-end against the shipping pipeline in
 * DwellTarget.test.tsx, "the FIXTURE RIG can perform it".)
 */
import { describe, expect, it } from 'vitest';
import { dwellDistance, dwellLimbs } from './dwell.ts';
import { extractFeature } from './features.ts';
import { SEATED_HAND_RESTS, seatedHandAt, seatedHandsOutOfView, seatedPose } from './fixtures.ts';
import { MIN_VISIBILITY, POSE } from './landmarks.ts';
import type { DetectionResult } from './mediapipe.ts';

/** The frame the rig is authored in, and the leg-mode primary target drawn in it (DwellTarget.tsx). */
const ASPECT = 4 / 3;
const TARGET = { x: 0.72, y: 0.32, radius: 0.115 };

const frame = (pose: ReturnType<typeof seatedPose>): DetectionResult => ({ tMs: 0, pose, hands: [] });

describe('the seated rig has hands', () => {
  it('rests both of them where the dwell envelope says a seated patient rests them', () => {
    const limbs = dwellLimbs(frame(seatedPose()), 'leg', false, ASPECT);
    expect(limbs.map((l) => l.key)).toEqual(['hand:left', 'hand:right']);
    // Two DISTINCT points. The placeholder put both wrists on the same pixel, which is a body no
    // camera can see and a pointer `pickDwellLimb` has to choose between by coin toss.
    expect(limbs[0].point).not.toEqual(limbs[1].point);
    expect(limbs[0].point).toEqual(SEATED_HAND_RESTS.thighs.left);
    expect(limbs[1].point).toEqual(SEATED_HAND_RESTS.thighs.right);
    // Neither is inside the ring at rest — the gesture has to be a move the patient makes.
    for (const l of limbs) expect(dwellDistance(l.point, TARGET, ASPECT)).toBeGreaterThan(TARGET.radius);
    // Every rest position the envelope is swept over is available, and none of them is in the ring.
    for (const where of Object.keys(SEATED_HAND_RESTS) as Array<keyof typeof SEATED_HAND_RESTS>) {
      const pose = seatedPose({ hands: where });
      const hand = dwellLimbs(frame(pose), 'leg', false, ASPECT)[0].point;
      expect(hand, where).toEqual(SEATED_HAND_RESTS[where].left);
      expect(dwellDistance(hand, TARGET, ASPECT), where).toBeGreaterThan(TARGET.radius);
    }
  });

  it('puts one hand on a target without moving the rest of the patient', () => {
    // The whole reason for `handAt`. A rig with no arms can only be aimed by translating the scene,
    // which drags the knees, the hips and the other hand with it — and, in the harnesses, dragged the
    // one landmark that could act as a pointer clean out of the frame.
    const params = { kneeLift: 0.4, side: 'left' } as const;
    const rest = seatedPose(params);
    const raised = seatedHandAt(TARGET.x, TARGET.y, 'left', params);
    const hand = dwellLimbs(frame(raised), 'leg', false, ASPECT).find((l) => l.key === 'hand:left');
    expect(hand).toBeDefined();
    expect(dwellDistance(hand!.point, TARGET, ASPECT)).toBeLessThan(1e-12);
    for (const i of [
      POSE.LEFT_HIP, POSE.RIGHT_HIP, POSE.LEFT_KNEE, POSE.RIGHT_KNEE, POSE.LEFT_ANKLE, POSE.RIGHT_ANKLE,
      POSE.LEFT_SHOULDER, POSE.RIGHT_SHOULDER, POSE.NOSE, POSE.RIGHT_WRIST,
    ]) {
      expect(raised[i], String(i)).toEqual(rest[i]);
    }
    // The elbow follows the hand it belongs to; an arm that does not bend is a body nobody has.
    expect(raised[POSE.LEFT_ELBOW]).not.toEqual(rest[POSE.LEFT_ELBOW]);
  });

  it('can also put the hands OUT of the picture — the framing the app used to ask for', () => {
    const hidden = seatedHandsOutOfView();
    expect(dwellLimbs(frame(hidden), 'leg', false, ASPECT)).toEqual([]);
    for (const i of [POSE.LEFT_WRIST, POSE.RIGHT_WRIST]) {
      // Not merely off the bottom edge: reported at a confidence nothing in the app will read, which
      // is what a real detector does with a limb it cannot see.
      expect(hidden[i].visibility ?? 1, String(i)).toBeLessThan(MIN_VISIBILITY);
      expect(hidden[i].y, String(i)).toBeGreaterThan(1);
    }
    // A hand brought back INTO the picture is a pointer again, and the other one stays out.
    const one = seatedPose({ hands: 'out_of_view', handAt: { side: 'right', x: 0.3, y: 0.4 } });
    const limbs = dwellLimbs(frame(one), 'leg', false, ASPECT);
    expect(limbs.map((l) => l.key)).toEqual(['hand:right']);
    expect(limbs[0].point).toEqual({ x: 0.3, y: 0.4 });
  });

  it('measures the legs identically however the arms are placed', () => {
    // Which is the other half of why the camera check WARNS about a missing hand instead of gating:
    // every prescribed lane is just as measurable with both hands out of the picture.
    for (const movement of ['seated_march', 'knee_extension', 'ankle_dorsiflexion', 'hip_abduction'] as const) {
      const params = { kneeLift: 0.7, kneeExtension: 0.7, toeLift: 0.7, abduction: 0.7, side: 'left' } as const;
      const base = extractFeature(movement, seatedPose(params), 'left', { xScale: ASPECT }) as number;
      for (const variant of [
        seatedHandsOutOfView(params),
        seatedPose({ ...params, hands: 'chair_arms' }),
        seatedHandAt(TARGET.x, TARGET.y, 'left', params),
      ]) {
        expect(extractFeature(movement, variant, 'left', { xScale: ASPECT }) as number, movement).toBeCloseTo(base, 12);
      }
    }
  });

  it('carries the hands with the trunk when the trunk leans, because arms hang from shoulders', () => {
    const lean = seatedPose({ trunkLean: 1 });
    const straight = seatedPose();
    const dx = lean[POSE.LEFT_SHOULDER].x - straight[POSE.LEFT_SHOULDER].x;
    expect(dx).toBeGreaterThan(0.1);
    expect(lean[POSE.LEFT_WRIST].x - straight[POSE.LEFT_WRIST].x).toBeCloseTo(dx, 10);
    expect(lean[POSE.RIGHT_WRIST].x - straight[POSE.RIGHT_WRIST].x).toBeCloseTo(dx, 10);
  });
});
