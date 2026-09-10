/**
 * A CALIBRATION IS ONLY A RANGE OF SOMETHING — and every module boundary it crosses has to agree on
 * WHAT.
 *
 * The lane's CalibrationContext (which fingertip it opposes, which mirror convention its frames are in)
 * decides which quantity, and which LIMB, a stored range describes. These tests pin the boundaries a
 * range actually crosses in this app:
 *
 *   RomCalibrator -> store -> localStorage -> (a later session) -> VisionInput.setCalibration
 *
 * and the property that makes them safe: the constructor and the runtime hand-over vet with ONE context,
 * derived from the lane's own featureOptions. They used to build their own literals and drift apart —
 * the hand-over passed no context at all, so a therapist-chosen fingertip made it refuse the range that
 * was measured correctly and accept one measured on a different finger, both silently.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import type { LaneSpec } from '../engine/types.ts';
import { VisionInput } from './VisionInput.ts';
import type { LaneInputEvent } from './types.ts';
import type { DetectionResult, LandmarkDetector } from '../vision/mediapipe.ts';
import { extractFeature } from '../vision/features.ts';
import { handPose, seatedPose } from '../vision/fixtures.ts';
import { RomCalibrator, calibrationContext, calibrationMismatch, calibrationWarnings, isCalibrationValid } from '../vision/calibration.ts';
import type { RomCalibration } from '../vision/calibration.ts';
import { calibrationKey, useStore } from '../state/store.ts';
import { STORAGE_PREFIX } from '../state/persist.ts';

class FakeClock { currentTime = 0; }

function fakeDetector(mode: 'leg' | 'hand'): LandmarkDetector {
  return { mode, delegate: 'CPU', detect: (_f, ts): DetectionResult => ({ tMs: ts, pose: null, hands: [] }), close() {} };
}

type Tip = 'index' | 'pinky';

/** A finger_opposition range on `fingertip`, stamped with the context it was measured in. */
function pinchCal(fingertip: Tip, mirrored?: boolean): RomCalibration {
  const cal: RomCalibration = {
    min: extractFeature('finger_opposition', handPose({ pinch: 0 }), 'right', { fingertip })!,
    max: extractFeature('finger_opposition', handPose({ pinch: 1, pinchTarget: fingertip }), 'right', { fingertip })!,
    samples: 90,
    movement: 'finger_opposition',
    fingertip,
  };
  if (mirrored !== undefined) cal.mirrored = mirrored;
  return cal;
}

/** A seated_march range, stamped with the mirror convention it was measured under. */
function marchCal(mirrored?: boolean): RomCalibration {
  const cal: RomCalibration = {
    min: extractFeature('seated_march', seatedPose({ kneeLift: 0, side: 'left' }), 'left')!,
    max: extractFeature('seated_march', seatedPose({ kneeLift: 1, side: 'left' }), 'left')!,
    samples: 90,
    movement: 'seated_march',
  };
  if (mirrored !== undefined) cal.mirrored = mirrored;
  return cal;
}

const HAND_LANE: LaneSpec[] = [{ index: 0, movement: 'finger_opposition', side: 'right' }];
const LEG_LANE: LaneSpec[] = [{ index: 0, movement: 'seated_march', side: 'left' }];

interface VisionOpts {
  lanes?: LaneSpec[];
  mode?: 'leg' | 'hand';
  calibrations?: (RomCalibration | null)[];
  featureOptions?: { fingertip?: Tip }[];
  mirrored?: boolean;
}

function makeVision(o: VisionOpts = {}): VisionInput {
  const mode = o.mode ?? 'hand';
  return new VisionInput({
    mode,
    lanes: o.lanes ?? (mode === 'hand' ? HAND_LANE : LEG_LANE),
    calibrations: o.calibrations ?? [null],
    thresholdFraction: 0.65,
    audioContext: new FakeClock(),
    detector: fakeDetector(mode),
    driveLoop: false,
    smoothing: { kind: 'none' },
    ...(o.featureOptions ? { featureOptions: o.featureOptions } : {}),
    ...(o.mirrored !== undefined ? { mirrored: o.mirrored } : {}),
  });
}

/* ------------------------------------------------------------------ *
 * 1. The context is DERIVED, in one place, from the lane's options
 * ------------------------------------------------------------------ */

describe('calibrationContext() is the single derivation both VisionInput paths use', () => {
  it('carries fingertip only for the movement it means anything for, and the mirror convention always', () => {
    expect(calibrationContext('seated_march', { mirrored: true })).toEqual({ mirrored: true });
    expect(calibrationContext('seated_march')).toEqual({ mirrored: false });
    expect(calibrationContext('finger_opposition')).toEqual({ mirrored: false, fingertip: 'index' });
    expect(calibrationContext('finger_opposition', { fingertip: 'pinky', mirrored: true })).toEqual({ mirrored: true, fingertip: 'pinky' });
  });

  it('a gate or an aspect correction is NOT context: it does not make a stored range wrong', () => {
    // minVisibility decides whether a frame is measured at all; xScale makes the feature identical on
    // every camera. Neither changes WHAT the number is, so neither may refuse a range.
    expect(calibrationContext('finger_opposition', { fingertip: 'index', minVisibility: 0.9, xScale: 1.78 } as never))
      .toEqual({ mirrored: false, fingertip: 'index' });
  });

  it('exposes the context per lane, so a calibration screen can measure IN it', () => {
    const input = makeVision({ featureOptions: [{ fingertip: 'pinky' }], mirrored: true });
    expect(input.getCalibrationContext(0)).toEqual({ fingertip: 'pinky', mirrored: true });
    expect(input.getCalibrationContext(7)).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * 2. The runtime hand-over vets EXACTLY like the constructor
 * ------------------------------------------------------------------ */

describe('setCalibration() and the constructor agree about every lane context', () => {
  const cases: { name: string; lane: Tip; cal: Tip; mirrorLane: boolean; mirrorCal: boolean | undefined }[] = [
    { name: 'default fingertip, default mirror', lane: 'index', cal: 'index', mirrorLane: false, mirrorCal: false },
    { name: 'non-default fingertip, matching', lane: 'pinky', cal: 'pinky', mirrorLane: false, mirrorCal: false },
    { name: 'non-default fingertip, mismatched', lane: 'pinky', cal: 'index', mirrorLane: false, mirrorCal: false },
    { name: 'default lane, non-default range', lane: 'index', cal: 'pinky', mirrorLane: false, mirrorCal: false },
    { name: 'mirrored session, mirrored range', lane: 'pinky', cal: 'pinky', mirrorLane: true, mirrorCal: true },
    { name: 'mirrored session, un-mirrored range', lane: 'pinky', cal: 'pinky', mirrorLane: true, mirrorCal: false },
    { name: 'legacy range with no mirror recorded', lane: 'index', cal: 'index', mirrorLane: true, mirrorCal: undefined },
  ];

  for (const c of cases) {
    it(`${c.name}: same verdict through both paths`, () => {
      const cal = pinchCal(c.cal, c.mirrorCal);
      const opts: VisionOpts = { featureOptions: [{ fingertip: c.lane }], mirrored: c.mirrorLane };
      const viaConstructor = makeVision({ ...opts, calibrations: [cal] });
      const viaHandover = makeVision(opts);
      const accepted = viaHandover.setCalibration(0, cal);
      expect(accepted).toBe(viaConstructor.getInvalidCalibrations().length === 0);
      expect(viaHandover.getInvalidCalibrations().map((x) => x.reason)).toEqual(viaConstructor.getInvalidCalibrations().map((x) => x.reason));
      // And the pipeline ends up in the same state: carrying the range, or carrying nothing at all.
      expect(viaHandover.getLaneDebug()[0].calibration).toEqual(viaConstructor.getLaneDebug()[0].calibration);
    });
  }
});

describe('setCalibration() with a therapist-chosen fingertip', () => {
  const handFrame = (pinch: number): DetectionResult => ({
    tMs: 0,
    pose: null,
    hands: [{ landmarks: handPose({ pinch, pinchTarget: 'pinky', centerX: 0.7 }), label: 'Left', score: 0.95 }],
  });

  it('ACCEPTS a range measured in the lane\'s own (non-default) context and plays it', async () => {
    const input = makeVision({ featureOptions: [{ fingertip: 'pinky' }] });
    expect(input.setCalibration(0, pinchCal('pinky', false))).toBe(true);
    expect(input.getInvalidCalibrations()).toEqual([]);
    expect(input.getStatus().warnings ?? []).toEqual([]);

    const events: LaneInputEvent[] = [];
    input.onEvent((e) => events.push(e));
    await input.start();
    for (const [i, pinch] of [0, 0.5, 1, 0.5, 0].entries()) input.processDetection(handFrame(pinch), i / 30);
    expect(input.getStatus().reason).toBe('ok');
    expect(events).toHaveLength(1); // accepted AND usable: the lane scores the rep it was calibrated for
    input.stop();
  });

  it('REFUSES a range measured on another finger, and says what to do about it', () => {
    const input = makeVision({ featureOptions: [{ fingertip: 'pinky' }] });
    expect(input.setCalibration(0, pinchCal('index', false))).toBe(false);
    const [refusal] = input.getInvalidCalibrations();
    expect(refusal.lane).toBe(0);
    expect(refusal.reason).toMatch(/measured opposing the index finger/i);
    expect(refusal.reason).toMatch(/re-calibrate this lane on the pinky finger/i);
    // Refused means UNCALIBRATED, not "used anyway".
    expect(input.getLaneDebug()[0].calibration).toBeNull();
    expect(input.getStatus().invalidCalibrationLanes).toEqual([0]);
    expect(input.getStatus().warnings!.join(' ')).toMatch(/re-calibrate this lane on the pinky finger/i);
  });
});

/* ------------------------------------------------------------------ *
 * 3. The mirror convention is context too — it selects the LIMB
 * ------------------------------------------------------------------ */

describe('a range measured under the other mirror convention is a range of the other limb', () => {
  it('REFUSES it on the leg lane, through both paths, with an actionable reason', () => {
    const cal = marchCal(true); // measured on flipped frames: patient's left leg, RIGHT_* landmark slots
    const viaConstructor = makeVision({ mode: 'leg', calibrations: [cal], mirrored: false });
    const [refusal] = viaConstructor.getInvalidCalibrations();
    expect(refusal.reason).toMatch(/mirrored/i);
    expect(refusal.reason).toMatch(/OTHER limb/i);
    expect(refusal.reason).toMatch(/re-calibrate this lane/i);
    expect(makeVision({ mode: 'leg', mirrored: false }).setCalibration(0, cal)).toBe(false);
  });

  it('ACCEPTS it when the session runs the convention it was measured in', () => {
    expect(makeVision({ mode: 'leg', mirrored: true }).setCalibration(0, marchCal(true))).toBe(true);
    expect(makeVision({ mode: 'leg', mirrored: false }).setCalibration(0, marchCal(false))).toBe(true);
  });

  it('applies to HAND lanes too: the mirror decides which hand the label means', () => {
    // The numbers are mirror-invariant (a distance ratio), which is exactly why this is silent: the
    // range looks perfectly plausible while belonging to the unaffected hand.
    const cal = pinchCal('index', true);
    expect(makeVision({ mirrored: false }).setCalibration(0, cal)).toBe(false);
    expect(makeVision({ mirrored: true }).setCalibration(0, cal)).toBe(true);
  });

  it('a legacy range that records no convention is WARNED about, not refused', () => {
    const input = makeVision({ mode: 'leg', mirrored: true });
    expect(input.setCalibration(0, marchCal(undefined))).toBe(true);
    expect(input.getStatus().warnings!.join(' ')).toMatch(/does not record whether the camera image was mirrored/i);
    // ...and nothing is said when the lane is on the default convention the field's absence implies.
    const plain = makeVision({ mode: 'leg', mirrored: false });
    expect(plain.setCalibration(0, marchCal(undefined))).toBe(true);
    expect((plain.getStatus().warnings ?? []).join(' ')).not.toMatch(/mirror/i);
  });
});

/* ------------------------------------------------------------------ *
 * 4. RomCalibrator -> VisionInput: the loop closes only if the range is STAMPED
 * ------------------------------------------------------------------ */

describe('createCalibrator() measures in the lane\'s context, so its result validates on that lane', () => {
  function runCalibrator(cal: RomCalibrator): RomCalibration {
    for (let i = 0; i < 12; i++) cal.push(0, i / 30);
    cal.beginMove();
    for (const [i, v] of [0, 0.4, 0.9, 0.4, 0].entries()) cal.push(v, 1 + i / 30);
    cal.finish();
    return cal.getResult() as RomCalibration;
  }

  it('stamps the fingertip and the mirror convention the lane plays in', () => {
    const input = makeVision({ featureOptions: [{ fingertip: 'pinky' }], mirrored: true });
    const calibrator = input.createCalibrator(0, { restDurationSec: 0.2, minRestSamples: 5, reps: 1, prominence: 0.2 })!;
    const result = runCalibrator(calibrator);
    expect(result.fingertip).toBe('pinky');
    expect(result.mirrored).toBe(true);
    expect(input.setCalibration(0, result)).toBe(true);
    // The same measured range is (correctly) refused by a lane that measures something else.
    expect(makeVision({ featureOptions: [{ fingertip: 'index' }], mirrored: true }).setCalibration(0, result)).toBe(false);
    expect(makeVision({ featureOptions: [{ fingertip: 'pinky' }], mirrored: false }).setCalibration(0, result)).toBe(false);
  });

  it('a bare calibrator produces an UNSTAMPED range that no boundary can check', () => {
    // Kept as a test because it is the failure mode of the un-adopted path: nothing is wrong with the
    // numbers, they simply do not say what they measured, so a later session can only warn.
    const result = runCalibrator(new RomCalibrator('seated_march', { restDurationSec: 0.2, minRestSamples: 5, reps: 1, prominence: 0.06 }));
    expect(result.mirrored).toBeUndefined();
    expect(calibrationMismatch(result, 'seated_march', { mirrored: true })).toBeNull();
    expect(calibrationWarnings(result, 'seated_march', Date.now(), { mirrored: true }).join(' ')).toMatch(/mirrored/i);
  });
});

/* ------------------------------------------------------------------ *
 * 5. The full round trip: store -> localStorage -> a later session
 * ------------------------------------------------------------------ */

describe('a calibration saved by the store survives localStorage and is re-vetted on reload', () => {
  const laneSpec: LaneSpec = { index: 0, movement: 'finger_opposition', side: 'right' };

  beforeEach(() => {
    localStorage.clear();
    useStore.getState().setLanes([laneSpec, { index: 1, movement: 'hand_open_close', side: 'right' }]);
  });

  /** What a NEXT session reads back: the raw JSON, parsed exactly as the store parses it on boot. */
  function reloadSaved(): Record<string, RomCalibration> {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}calibrations`);
    expect(raw).not.toBeNull();
    return JSON.parse(raw as string) as Record<string, RomCalibration>;
  }

  it('keeps the context through JSON and accepts the range on an identically configured lane', () => {
    const measured = pinchCal('pinky', true);
    useStore.getState().setCalibration(0, measured);
    expect(useStore.getState().savedCalibrations[calibrationKey(laneSpec)]).toBe(measured);

    const reloaded = reloadSaved()[calibrationKey(laneSpec)];
    expect(reloaded.fingertip).toBe('pinky');
    expect(reloaded.mirrored).toBe(true);
    expect(isCalibrationValid(reloaded, 'finger_opposition', { fingertip: 'pinky', mirrored: true })).toBe(true);

    const input = makeVision({ featureOptions: [{ fingertip: 'pinky' }], mirrored: true });
    expect(input.setCalibration(0, reloaded)).toBe(true);
    expect(input.getInvalidCalibrations()).toEqual([]);
  });

  it('REFUSES it, actionably, when the later session configured the lane differently', () => {
    // The saved-calibration key is `movement:side`, so it does NOT distinguish the fingertip or the
    // mirror setting: the same key is offered back to a lane that measures something else. That offer is
    // caught HERE, at the boundary, instead of silently normalizing one quantity by another's range.
    useStore.getState().setCalibration(0, pinchCal('pinky', true));
    const reloaded = reloadSaved()[calibrationKey(laneSpec)];

    const otherFinger = makeVision({ featureOptions: [{ fingertip: 'index' }], mirrored: true });
    expect(otherFinger.setCalibration(0, reloaded)).toBe(false);
    expect(otherFinger.getInvalidCalibrations()[0].reason).toMatch(/re-calibrate this lane on the index finger/i);

    const otherMirror = makeVision({ featureOptions: [{ fingertip: 'pinky' }], mirrored: false });
    expect(otherMirror.setCalibration(0, reloaded)).toBe(false);
    expect(otherMirror.getInvalidCalibrations()[0].reason).toMatch(/re-calibrate this lane/i);
    expect(otherMirror.getLaneDebug()[0].calibration).toBeNull();
  });

  it('the same range still loads cleanly into the session that measured it, via the constructor', () => {
    useStore.getState().setCalibration(0, pinchCal('pinky', true));
    const reloaded = reloadSaved()[calibrationKey(laneSpec)];
    const input = makeVision({ calibrations: [reloaded], featureOptions: [{ fingertip: 'pinky' }], mirrored: true });
    expect(input.getInvalidCalibrations()).toEqual([]);
    expect(input.getLaneDebug()[0].calibration?.max).toBeCloseTo(reloaded.max, 10);
  });
});
