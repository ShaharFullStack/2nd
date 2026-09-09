import { describe, expect, it } from 'vitest';
import type { Movement, Side } from '../engine/types.ts';
import { EXTRACTORS, MOVEMENT_INFO, captureCompensationBaseline, checkCompensation, extractFeature, trunkTiltDeg } from './features.ts';
import { handPose, seatedPose, seatedRest, handOpen, handFist, seatedKneeLifted } from './fixtures.ts';
import { POSE, HAND_LANDMARK_COUNT, POSE_LANDMARK_COUNT } from './landmarks.ts';
import type { Landmark } from './landmarks.ts';

const STEPS = [0, 0.1, 0.25, 0.4, 0.5, 0.6, 0.75, 0.9, 1];
const SIDES: Side[] = ['left', 'right'];

function expectStrictlyIncreasing(values: number[], label: string) {
  for (let i = 1; i < values.length; i++) {
    expect(values[i], `${label}: step ${i} (${values[i - 1]} -> ${values[i]})`).toBeGreaterThan(values[i - 1]);
  }
}

describe('leg extractors (Pose fixtures)', () => {
  const legCases: Array<[Movement, (amount: number, side: Side) => Landmark[]]> = [
    ['seated_march', (a, side) => seatedPose({ kneeLift: a, side })],
    ['knee_extension', (a, side) => seatedPose({ kneeExtension: a, side })],
    ['ankle_dorsiflexion', (a, side) => seatedPose({ toeLift: a, side })],
    ['hip_abduction', (a, side) => seatedPose({ abduction: a, side })],
  ];
  for (const [movement, gen] of legCases) {
    for (const side of SIDES) {
      it(`${movement} (${side}) is monotonic increasing with movement`, () => {
        const vals = STEPS.map((a) => extractFeature(movement, gen(a, side), side));
        expect(vals.every((v) => v !== null)).toBe(true);
        expectStrictlyIncreasing(vals as number[], `${movement}/${side}`);
        // Range exceeds the per-movement minimum ROM at full movement.
        expect((vals[vals.length - 1] as number) - (vals[0] as number)).toBeGreaterThan(MOVEMENT_INFO[movement].minRom);
      });
      it(`${movement} (${side}) does not respond to the other leg`, () => {
        const other: Side = side === 'left' ? 'right' : 'left';
        const rest = extractFeature(movement, gen(0, side), side) as number;
        const moved = extractFeature(movement, gen(1, other), side) as number;
        expect(Math.abs(moved - rest)).toBeLessThan(1e-9);
      });
    }
  }

  it('knee_extension is ~90° bent at rest and near 180° straight', () => {
    expect(extractFeature('knee_extension', seatedRest(), 'left')).toBeCloseTo(90, -1);
    expect(extractFeature('knee_extension', seatedPose({ kneeExtension: 1 }), 'left')).toBeGreaterThan(165);
  });

  it('returns null when required landmarks have low visibility', () => {
    const pose = seatedRest();
    pose[POSE.LEFT_KNEE] = { ...pose[POSE.LEFT_KNEE], visibility: 0.1 };
    expect(extractFeature('seated_march', pose, 'left')).toBeNull();
    expect(extractFeature('knee_extension', pose, 'left')).toBeNull();
    expect(extractFeature('seated_march', pose, 'right')).not.toBeNull();
    expect(extractFeature('seated_march', null, 'left')).toBeNull();
    expect(extractFeature('seated_march', [], 'left')).toBeNull();
    expect(extractFeature('seated_march', seatedRest().slice(0, 20), 'left')).toBeNull();
  });

  it('accepts a custom minVisibility', () => {
    const pose = seatedPose({ visibility: 0.4 });
    expect(extractFeature('hip_abduction', pose, 'left')).toBeNull();
    expect(extractFeature('hip_abduction', pose, 'left', { minVisibility: 0.3 })).not.toBeNull();
  });
});

describe('hand extractors (Hand fixtures)', () => {
  const handCases: Array<[Movement, (amount: number) => Landmark[]]> = [
    ['hand_open_close', (a) => handPose({ openness: a })],
    ['wrist_extension', (a) => handPose({ wristRaise: a })],
    ['finger_opposition', (a) => handPose({ pinch: a })],
    ['finger_spread', (a) => handPose({ spread: a })],
  ];
  for (const [movement, gen] of handCases) {
    it(`${movement} is monotonic increasing with movement`, () => {
      const vals = STEPS.map((a) => extractFeature(movement, gen(a), 'left'));
      expect(vals.every((v) => v !== null)).toBe(true);
      expectStrictlyIncreasing(vals as number[], movement);
      expect((vals[vals.length - 1] as number) - (vals[0] as number)).toBeGreaterThan(MOVEMENT_INFO[movement].minRom);
    });
  }

  it('hand features are scale invariant (distance to camera)', () => {
    for (const movement of ['hand_open_close', 'finger_opposition', 'finger_spread'] as Movement[]) {
      const a = extractFeature(movement, handPose({ openness: 0.5, pinch: 0.5, spread: 0.5, scale: 1 }), 'left');
      const b = extractFeature(movement, handPose({ openness: 0.5, pinch: 0.5, spread: 0.5, scale: 0.5 }), 'left');
      expect(a).toBeCloseTo(b as number, 6);
    }
  });

  it('finger_opposition can target another fingertip', () => {
    const hand = handPose({ pinch: 1 });
    const idx = extractFeature('finger_opposition', hand, 'left', { fingertip: 'index' }) as number;
    const pinky = extractFeature('finger_opposition', hand, 'left', { fingertip: 'pinky' }) as number;
    expect(idx).toBeGreaterThan(pinky);
  });

  it('returns null for incomplete hands', () => {
    expect(extractFeature('hand_open_close', handOpen().slice(0, 10), 'left')).toBeNull();
    expect(extractFeature('finger_spread', null, 'right')).toBeNull();
    const nan = handFist();
    nan[0] = { x: NaN, y: NaN, z: 0 };
    expect(extractFeature('hand_open_close', nan, 'left')).toBeNull();
  });
});

describe('compensation checks', () => {
  it('flags heel lift during ankle dorsiflexion but not a clean rep', () => {
    const rest = seatedRest();
    const base = captureCompensationBaseline('ankle_dorsiflexion', rest, 'left');
    expect(base?.kind).toBe('heel_lift');
    const clean = checkCompensation('ankle_dorsiflexion', seatedPose({ toeLift: 1 }), 'left', base!);
    expect(clean?.flagged).toBe(false);
    const cheat = checkCompensation('ankle_dorsiflexion', seatedPose({ toeLift: 1, heelLift: 1 }), 'left', base!);
    expect(cheat?.flagged).toBe(true);
    expect(cheat!.value).toBeGreaterThan(clean!.value);
  });

  it('flags trunk lean during seated march', () => {
    const rest = seatedRest();
    const base = captureCompensationBaseline('seated_march', rest, 'left');
    expect(base?.kind).toBe('trunk_lean');
    expect(trunkTiltDeg(rest)).toBeCloseTo(0, 5);
    const clean = checkCompensation('seated_march', seatedKneeLifted(1), 'left', base!);
    expect(clean?.flagged).toBe(false);
    const lean = checkCompensation('seated_march', seatedPose({ kneeLift: 1, trunkLean: 1 }), 'left', base!);
    expect(lean?.flagged).toBe(true);
    expect(lean!.value).toBeGreaterThan(12);
  });

  it('is not applicable for other movements', () => {
    expect(captureCompensationBaseline('knee_extension', seatedRest(), 'left')).toBeNull();
    expect(captureCompensationBaseline('hand_open_close', handOpen(), 'left')).toBeNull();
  });
});

describe('MOVEMENT_INFO', () => {
  it('covers all 8 movements with an extractor and consistent mode', () => {
    const movements = Object.keys(MOVEMENT_INFO) as Movement[];
    expect(movements).toHaveLength(8);
    for (const m of movements) {
      expect(EXTRACTORS[m]).toBeTypeOf('function');
      const info = MOVEMENT_INFO[m];
      expect(info.movement).toBe(m);
      expect(info.higherIsMore).toBe(true);
      expect(info.minRom).toBeGreaterThan(0);
      expect(info.instructions.length).toBeGreaterThan(10);
      expect(info.calibrationInstruction.length).toBeGreaterThan(10);
      expect(info.mode).toBe(m.startsWith('hand') || m.startsWith('wrist') || m.startsWith('finger') ? 'hand' : 'leg');
    }
  });

  it('fixtures have the right landmark counts', () => {
    expect(seatedRest()).toHaveLength(POSE_LANDMARK_COUNT);
    expect(handOpen()).toHaveLength(HAND_LANDMARK_COUNT);
  });
});
