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
import { SEATED_HAND_RESTS, SEATED_HAND_SUPPORTS, seatedHandAt, seatedHandsOutOfView, seatedPose } from './fixtures.ts';
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

  /**
   * WHAT IS HOLDING THE HAND UP IS WHAT MOVES IT — the fixture defect that hid this feature's third
   * failure. The rig used to hold every wrist at a world-fixed point (carried only by the trunk lean),
   * so a hand "on the thigh" was the one thing a seated leg exercise could not move. A hand on the
   * thigh is part of the thigh: hip flexion rotates the thigh about the hip and takes the hand with it.
   */
  describe('a resting hand is carried by whatever is holding it up', () => {
    const wrist = (pose: ReturnType<typeof seatedPose>, side: 'left' | 'right') =>
      pose[side === 'left' ? POSE.LEFT_WRIST : POSE.RIGHT_WRIST];

    it('ON THE THIGH: rises by f x the knee’s travel, and is carried sideways by circumduction', () => {
      for (const f of [0.35, 0.7, 0.85, 1]) {
        for (const side of ['left', 'right'] as const) {
          const rest = seatedPose({ side, hands: 'thighs', handThighFraction: f });
          const lifted = seatedPose({ side, hands: 'thighs', handThighFraction: f, kneeLift: 1 });
          const knee = side === 'left' ? POSE.LEFT_KNEE : POSE.RIGHT_KNEE;
          const kneeRise = rest[knee].y - lifted[knee].y;
          expect(kneeRise, `${side} knee`).toBeCloseTo(0.28, 10);
          // The hand rises by exactly its fraction of the knee's rise. THIS is the quantity the old
          // rig pinned at zero, and at f=1 it is 0.28 of a frame height — more than two dwell radii.
          expect(wrist(rest, side).y - wrist(lifted, side).y, `${side} f=${f}`).toBeCloseTo(f * kneeRise, 10);
          // …and circumduction carries it laterally at the same time, by the same fraction.
          const circ = seatedPose({ side, hands: 'thighs', handThighFraction: f, kneeLift: 1, abduction: 1 });
          const kneeOut = circ[knee].x - lifted[knee].x;
          expect(Math.abs(kneeOut), `${side} knee out`).toBeCloseTo(0.15, 10);
          expect(wrist(circ, side).x - wrist(lifted, side).x, `${side} f=${f} lateral`).toBeCloseTo(f * kneeOut, 10);
          // The OTHER hand, on the other (resting) thigh, does not move: only the exercising leg carries.
          const other = side === 'left' ? 'right' : 'left';
          expect(wrist(circ, other)).toEqual(wrist(rest, other));
        }
      }
      // A hand IN THE LAP sits on the proximal thigh, so it is carried too — less, but not by nothing.
      const lap = seatedPose({ hands: 'lap' });
      const lapLifted = seatedPose({ hands: 'lap', kneeLift: 1 });
      const carried = wrist(lap, 'left').y - wrist(lapLifted, 'left').y;
      expect(carried).toBeGreaterThan(0.05);
      expect(carried).toBeLessThan(0.28 * 0.7);
    });

    it('ON A CHAIR ARM: world-fixed — not moved by the leg, and not by the trunk either', () => {
      const base = seatedPose({ hands: 'chair_arms' });
      for (const variant of [
        seatedPose({ hands: 'chair_arms', kneeLift: 1 }),
        seatedPose({ hands: 'chair_arms', kneeLift: 1, abduction: 1 }),
        seatedPose({ hands: 'chair_arms', abduction: -1 }),
        seatedPose({ hands: 'chair_arms', kneeExtension: 1, toeLift: 1, heelLift: 1 }),
        seatedPose({ hands: 'chair_arms', trunkLean: 1 }),
        seatedPose({ hands: 'chair_arms', side: 'right', kneeLift: 1, abduction: 1 }),
      ]) {
        expect(wrist(variant, 'left')).toEqual(wrist(base, 'left'));
        expect(wrist(variant, 'right')).toEqual(wrist(base, 'right'));
      }
      // That independence is the whole reason the app asks for this support (POSTURE_INFO.seated_leg).
      expect(SEATED_HAND_SUPPORTS.chair_arms.support).toBe('fixed');
    });

    it('FOLDED in front of the body: carried by the trunk lean, since nothing else holds it', () => {
      const lean = seatedPose({ hands: 'folded', trunkLean: 1 });
      const straight = seatedPose({ hands: 'folded' });
      const dx = lean[POSE.LEFT_SHOULDER].x - straight[POSE.LEFT_SHOULDER].x;
      expect(dx).toBeGreaterThan(0.1);
      expect(wrist(lean, 'left').x - wrist(straight, 'left').x).toBeCloseTo(dx, 10);
      expect(wrist(lean, 'right').x - wrist(straight, 'right').x).toBeCloseTo(dx, 10);
      // A trunk lean does NOT move a hand the thigh is holding: the thigh is where it was.
      const thighLean = seatedPose({ hands: 'thighs', trunkLean: 1 });
      expect(wrist(thighLean, 'left')).toEqual(wrist(seatedPose({ hands: 'thighs' }), 'left'));
    });

    it('a RAISED hand is where it was put, whatever the leg is doing', () => {
      for (const lift of [0, 0.5, 1]) {
        const pose = seatedPose({ kneeLift: lift, abduction: lift, handAt: { side: 'left', x: 0.72, y: 0.32 } });
        expect(wrist(pose, 'left').x).toBeCloseTo(0.72, 12);
        expect(wrist(pose, 'left').y).toBeCloseTo(0.32, 12);
      }
    });
  });
});
