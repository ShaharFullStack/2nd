import { describe, expect, it } from 'vitest';
import type { Movement, Side } from '../engine/types.ts';
import { EXTRACTORS, MOVEMENT_INFO, POSTURE_INFO, abductionSign, baselineFromSamples, captureCompensationBaseline, checkCompensation, evaluateCompensation, extractFeature, handPlausible, hasBlockingLaneConflict, laneConflicts, measureCompensation, requiredPostures, trunkTiltDeg } from './features.ts';
import { handCollapsed, handPose, seatedPose, seatedPoseWorld, seatedRest, handOpen, handFist, seatedKneeAbducted, seatedKneeAdducted, seatedKneeLifted, handWristExtended, handWristRaised } from './fixtures.ts';
import { normalizeFeature } from './calibration.ts';
import type { LaneSpec } from '../engine/types.ts';
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

  it('angle features use metric world landmarks when supplied (monotonic, and preferred over image z)', () => {
    for (const movement of ['knee_extension', 'ankle_dorsiflexion'] as Movement[]) {
      const key = movement === 'knee_extension' ? 'kneeExtension' : 'toeLift';
      const vals = STEPS.map((a) => extractFeature(movement, seatedPose({ [key]: a }), 'left', { worldLandmarks: seatedPoseWorld({ [key]: a }) }));
      expectStrictlyIncreasing(vals as number[], `${movement}/world`);
      // Same geometry => same angle whichever source is used.
      expect(vals[4]).toBeCloseTo(extractFeature(movement, seatedPose({ [key]: 0.5 }), 'left') as number, 6);
    }
    // Image landmarks at rest but world landmarks extended: the world angle wins.
    const rest = seatedRest();
    const world = seatedPoseWorld({ kneeExtension: 1 });
    expect(extractFeature('knee_extension', rest, 'left', { worldLandmarks: world })).toBeGreaterThan(165);
    // Incomplete world landmarks fall back to the image landmarks (no crash, rest angle).
    expect(extractFeature('knee_extension', rest, 'left', { worldLandmarks: world.slice(0, 10) })).toBeCloseTo(90, -1);
    // Visibility is still gated on the image landmarks.
    rest[POSE.LEFT_ANKLE] = { ...rest[POSE.LEFT_ANKLE], visibility: 0.1 };
    expect(extractFeature('knee_extension', rest, 'left', { worldLandmarks: world })).toBeNull();
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

  it('hip_abduction is DIRECTION-SPECIFIC: adduction must not score like abduction', () => {
    for (const side of SIDES) {
      const rest = extractFeature('hip_abduction', seatedPose({ side }), side) as number;
      const abducted = extractFeature('hip_abduction', seatedKneeAbducted(1, side), side) as number;
      const adducted = extractFeature('hip_abduction', seatedKneeAdducted(1, side), side) as number;
      expect(abducted).toBeGreaterThan(rest);
      // Pulling the knee INWARD across the midline (the compensatory pattern this exercise corrects)
      // reads BELOW rest, so ROM normalization pins it at 0 instead of awarding full credit.
      expect(adducted).toBeLessThan(rest);
      expect(adducted).not.toBeCloseTo(abducted, 6);
      const cal = { min: rest, max: abducted };
      expect(normalizeFeature(cal, abducted)).toBe(1);
      expect(normalizeFeature(cal, adducted)).toBe(0);
      // Half-way adduction also scores nothing.
      expect(normalizeFeature(cal, extractFeature('hip_abduction', seatedKneeAdducted(0.5, side), side) as number)).toBe(0);
    }
  });

  it('hip_abduction respects the mirror convention', () => {
    expect(abductionSign('left', false)).toBe(1);
    expect(abductionSign('right', false)).toBe(-1);
    expect(abductionSign('left', true)).toBe(-1);
    // Mirroring the frames flips which image-x direction is outward, so the sign of the feature flips.
    const pose = seatedKneeAbducted(1, 'left');
    const raw = extractFeature('hip_abduction', pose, 'left') as number;
    const mirrored = extractFeature('hip_abduction', pose, 'left', { mirrored: true }) as number;
    expect(mirrored).toBeCloseTo(-raw, 9);
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
    ['wrist_extension', (a) => handWristExtended(a)],
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

  it('hand features are scale and position invariant (distance to camera, hand location)', () => {
    for (const movement of ['hand_open_close', 'wrist_extension', 'finger_opposition', 'finger_spread'] as Movement[]) {
      const base = { openness: 0.5, pinch: 0.5, spread: 0.5, wristExtension: 0.5 };
      const a = extractFeature(movement, handPose({ ...base, scale: 1 }), 'left');
      const b = extractFeature(movement, handPose({ ...base, scale: 0.5 }), 'left');
      const c = extractFeature(movement, handPose({ ...base, scale: 0.7, centerX: 0.2, wristRaise: 0.8 }), 'left');
      expect(a).toBeCloseTo(b as number, 6);
      expect(a).toBeCloseTo(c as number, 6);
    }
  });

  it('wrist_extension measures rotation about the wrist, not lifting the forearm (compensation)', () => {
    const rest = extractFeature('wrist_extension', handWristExtended(0), 'left') as number;
    for (const a of STEPS) {
      // Translating the whole hand upward (forearm/elbow lift) must not score.
      const hand = handPose({ wristExtension: 0, wristRaise: a });
      expect(Math.abs((extractFeature('wrist_extension', hand, 'left') as number) - rest)).toBeLessThan(1e-9);
    }
    expect(extractFeature('wrist_extension', handWristRaised(1), 'left')).toBeCloseTo(extractFeature('wrist_extension', handWristRaised(0), 'left') as number, 9);
    // Rest hangs slightly below level (negative elevation), full extension is well above.
    expect(rest).toBeLessThan(0);
    expect(extractFeature('wrist_extension', handWristExtended(1), 'left')).toBeGreaterThan(rest + MOVEMENT_INFO.wrist_extension.minRom);
  });

  it('finger_opposition can target another fingertip', () => {
    const hand = handPose({ pinch: 1 });
    const idx = extractFeature('finger_opposition', hand, 'left', { fingertip: 'index' }) as number;
    const pinky = extractFeature('finger_opposition', hand, 'left', { fingertip: 'pinky' }) as number;
    expect(idx).toBeGreaterThan(pinky);
  });

  it('rejects an implausible (collapsed) hand even though all 21 landmarks are present', () => {
    // The real HandLandmarker ALWAYS returns 21 landmarks — it infers occluded ones — so "missing
    // landmarks" never arrives from the detector; confident garbage does.
    const collapsed = handCollapsed();
    expect(collapsed).toHaveLength(HAND_LANDMARK_COUNT);
    expect(collapsed.every((l) => Number.isFinite(l.x) && Number.isFinite(l.y))).toBe(true);
    expect(handPlausible(collapsed)).toBe(false);
    for (const m of ['hand_open_close', 'wrist_extension', 'finger_opposition', 'finger_spread'] as Movement[]) {
      expect(extractFeature(m, collapsed, 'left'), m).toBeNull();
    }
    // Every legitimate hand pose (including the fingers-at-the-camera wrist_extension rest) is plausible.
    for (const p of [handOpen(), handFist(), handWristExtended(0), handWristExtended(1), handPose({ pinch: 1 }), handPose({ spread: 1 }), handPose({ scale: 0.4 })]) {
      expect(handPlausible(p)).toBe(true);
    }
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

  it('rest-phase median baseline is robust to a single jittery frame', () => {
    const samples = [0, 0.2, 0.4, 0.6, 0.8, 1].map((h) => measureCompensation('ankle_dorsiflexion', seatedPose({ heelLift: h * 0.05 }), 'left')!);
    const good = samples.slice(0, 5);
    const outlier = seatedPose({ heelLift: 1 });
    const jittery = [...good, measureCompensation('ankle_dorsiflexion', outlier, 'left')!];
    const base = baselineFromSamples(jittery)!;
    expect(base.kind).toBe('heel_lift');
    expect(base.samples).toBe(6);
    // Median of 6 = mean of the 3rd and 4th values, unaffected by the outlier frame.
    const ys = jittery.map((s) => s.value).sort((a, b) => a - b);
    expect(base.value).toBeCloseTo((ys[2] + ys[3]) / 2, 9);
    const single = captureCompensationBaseline('ankle_dorsiflexion', outlier, 'left')!;
    expect(single.samples).toBe(1);
    // Against the single-frame (lifted) baseline a flat foot would read as a negative rise; the median baseline is sane.
    expect(evaluateCompensation(good[0], single)!.value).toBeLessThan(0);
    expect(Math.abs(evaluateCompensation(good[0], base)!.value)).toBeLessThan(0.05);
    expect(baselineFromSamples([])).toBeNull();
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
      // Lane smoothing must be unit-free so every lane has the same filter delay.
      expect(['ema', 'ema2', 'lowpass', 'none']).toContain(info.smoothing.kind);
      // Every movement declares the setup it is measured in, and the patient-facing rest instruction
      // must describe THAT setup (the instructions are what the therapist reads out loud).
      expect(POSTURE_INFO[info.posture], m).toBeDefined();
      expect(info.posture === 'seated_leg', m).toBe(info.mode === 'leg');
      if (info.posture === 'palm_to_camera') expect(info.restInstruction, m).toMatch(/palm to the camera/);
      if (info.posture === 'hand_over_edge') expect(info.restInstruction, m).toMatch(/over the edge/);
    }
  });

  it('laneConflicts warns about physically coupled lanes on the same limb', () => {
    const lanes = (...specs: Array<[number, Movement, Side]>): LaneSpec[] => specs.map(([index, movement, side]) => ({ index, movement, side }));
    // Same limb, coupled movements: a knee lift almost always carries lateral drift.
    const coupled = laneConflicts(lanes([0, 'seated_march', 'left'], [1, 'hip_abduction', 'left']));
    expect(coupled).toHaveLength(1);
    expect(coupled[0].severity).toBe('warning');
    expect(coupled[0].lanes).toEqual([0, 1]);
    expect(coupled[0].message).toMatch(/left/);
    // Opposite limbs are independent.
    expect(laneConflicts(lanes([0, 'seated_march', 'left'], [1, 'hip_abduction', 'right']))).toHaveLength(0);
    // A 3D knee angle is unaffected by hip flexion, so this common pairing is NOT flagged.
    expect(laneConflicts(lanes([0, 'seated_march', 'left'], [1, 'knee_extension', 'left']))).toHaveLength(0);
    expect(laneConflicts(lanes([0, 'knee_extension', 'right'], [1, 'ankle_dorsiflexion', 'right']))).toHaveLength(1);
    // The same movement twice on the same limb is an error, not a warning.
    const dup = laneConflicts(lanes([0, 'hand_open_close', 'left'], [1, 'hand_open_close', 'left']));
    expect(dup[0].severity).toBe('error');
    expect(laneConflicts(lanes([0, 'hand_open_close', 'left'], [1, 'finger_spread', 'left']))).toHaveLength(1);
    expect(laneConflicts([])).toEqual([]);
  });

  it('a same-hand posture mismatch is an ERROR (wrist_extension vs the palm-to-camera movements)', () => {
    const lanes = (...specs: Array<[number, Movement, Side]>): LaneSpec[] => specs.map(([index, movement, side]) => ({ index, movement, side }));
    for (const other of ['hand_open_close', 'finger_opposition', 'finger_spread'] as Movement[]) {
      const c = laneConflicts(lanes([0, 'wrist_extension', 'left'], [1, other, 'left']));
      expect(c, other).toHaveLength(1);
      expect(c[0].severity, other).toBe('error');
      expect(c[0].kind, other).toBe('posture');
      expect(c[0].side).toBe('left');
      expect(c[0].message).toMatch(/different setups/);
      expect(hasBlockingLaneConflict(lanes([0, 'wrist_extension', 'left'], [1, other, 'left'])), other).toBe(true);
      // Opposite hands are physically possible but need two different setups at once: a warning.
      const bilateral = laneConflicts(lanes([0, 'wrist_extension', 'left'], [1, other, 'right']));
      expect(bilateral, other).toHaveLength(1);
      expect(bilateral[0].severity, other).toBe('warning');
      expect(bilateral[0].side).toBeNull();
      expect(hasBlockingLaneConflict(lanes([0, 'wrist_extension', 'left'], [1, other, 'right']))).toBe(false);
    }
    // Movements sharing a posture are unaffected (still only the coupling warning), and leg lanes never
    // collide on posture.
    const coupled = laneConflicts(lanes([0, 'hand_open_close', 'left'], [1, 'finger_spread', 'left']));
    expect(coupled[0].kind).toBe('coupled');
    expect(coupled[0].severity).toBe('warning');
    expect(laneConflicts(lanes([0, 'knee_extension', 'left'], [1, 'hip_abduction', 'left']))).toHaveLength(0);
    expect(hasBlockingLaneConflict(lanes([0, 'seated_march', 'left'], [1, 'knee_extension', 'right']))).toBe(false);
    expect(requiredPostures(lanes([0, 'wrist_extension', 'left'], [1, 'hand_open_close', 'left'], [2, 'finger_spread', 'right'])))
      .toEqual(['hand_over_edge', 'palm_to_camera']);
    expect(requiredPostures(lanes([0, 'hand_open_close', 'left'], [1, 'finger_spread', 'right']))).toEqual(['palm_to_camera']);
  });

  it('MEASURED: the posture mismatch is real geometry — a rigid wrist rotation sweeps the other features', () => {
    // Openness and spread are held CONSTANT while only the wrist angle changes. Both palm-to-camera
    // features move by more than their whole minimum ROM, i.e. across a calibrated range — which is why
    // laneConflicts must refuse the pairing rather than warn about it.
    const oc = STEPS.map((a) => extractFeature('hand_open_close', handPose({ openness: 0.6, spread: 0.5, wristExtension: a }), 'left') as number);
    const fs = STEPS.map((a) => extractFeature('finger_spread', handPose({ openness: 0.6, spread: 0.5, wristExtension: a }), 'left') as number);
    expect(Math.max(...oc) - Math.min(...oc)).toBeGreaterThan(MOVEMENT_INFO.hand_open_close.minRom);
    expect(Math.max(...fs) - Math.min(...fs)).toBeGreaterThan(MOVEMENT_INFO.finger_spread.minRom);
    // Converse: in the palm-to-camera posture wrist_extension is pinned near its maximum whatever the
    // hand does, so that lane could never re-arm.
    const wrist = [0, 0.5, 1].map((o) => extractFeature('wrist_extension', handPose({ openness: o }), 'left') as number);
    const full = extractFeature('wrist_extension', handWristExtended(1), 'left') as number;
    for (const w of wrist) expect(w).toBeGreaterThanOrEqual(full - 1e-9);
  });

  it('fine-motor lanes get a steeper filter with the SAME group delay as the coarse lanes', () => {
    expect(MOVEMENT_INFO.finger_opposition.smoothing).toEqual({ kind: 'ema2', alpha: 2 / 3 });
    expect(MOVEMENT_INFO.finger_spread.smoothing).toEqual({ kind: 'ema2', alpha: 2 / 3 });
    expect(MOVEMENT_INFO.seated_march.smoothing).toEqual({ kind: 'ema', alpha: 0.5 });
  });

  it('fixtures have the right landmark counts', () => {
    expect(seatedRest()).toHaveLength(POSE_LANDMARK_COUNT);
    expect(handOpen()).toHaveLength(HAND_LANDMARK_COUNT);
  });
});
