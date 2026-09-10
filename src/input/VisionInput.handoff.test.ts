/**
 * The CALIBRATION -> PLAY HANDOFF, and the provenance a therapist reads off the results screen.
 *
 * Everything here is a silent-death test: a configuration in which the lane keeps a green status, a
 * moving meter or a plausible metric while measuring the wrong limb, the wrong quantity, or nothing at
 * all. None of these produce an unearned hit — they produce an unearned SILENCE, which the module's own
 * comments call the catastrophic failure ("the affected lane reads flat 0 all session").
 */
import { describe, expect, it } from 'vitest';
import type { LaneSpec } from '../engine/types.ts';
import { VisionInput } from './VisionInput.ts';
import type { CompensationEvent, LaneInputEvent, LaneRepEvent } from './types.ts';
import type { DetectionResult, LandmarkDetector } from '../vision/mediapipe.ts';
import { captureCompensationBaseline, extractFeature } from '../vision/features.ts';
import { handPose, mirrorPoseLandmarks, repSequence, seatedPose, seatedRest } from '../vision/fixtures.ts';
import type { Landmark } from '../vision/landmarks.ts';
import { RomCalibrator, calibrationProblem, isCalibrationValid } from '../vision/calibration.ts';
import type { RomCalibration } from '../vision/calibration.ts';
import { LanePipeline } from '../vision/pipeline.ts';

class FakeClock { currentTime = 0; }

function fakeDetector(mode: 'leg' | 'hand'): LandmarkDetector {
  return { mode, delegate: 'CPU', detect: (_f, ts): DetectionResult => ({ tMs: ts, pose: null, hands: [] }), close() {} };
}

function calFor(movement: LaneSpec['movement'], side: LaneSpec['side'], gen: (a: number) => Landmark[], opts?: { mirrored?: boolean }): RomCalibration {
  return {
    min: extractFeature(movement, gen(0), side, opts)!,
    max: extractFeature(movement, gen(1), side, opts)!,
    samples: 1,
    movement,
  };
}

/* ------------------------------------------------------------------ *
 * 1. The mirror convention travels WITH the pipeline
 * ------------------------------------------------------------------ */

describe('reusing a calibration pipeline cannot silently change which limb is measured', () => {
  const affected: LaneSpec[] = [{ index: 0, movement: 'seated_march', side: 'left' }];
  const mirroredCal = () => calFor('seated_march', 'left', (a) => mirrorPoseLandmarks(seatedPose({ kneeLift: a, side: 'left' })), { mirrored: true });

  it('REFUSES a reused pipeline whose mirror convention differs from the session (it would read the other leg)', () => {
    // The exact configuration that used to pass silently: the session flips its frames, the handed-over
    // pipeline does not, so every leg feature comes out of the UNAFFECTED limb's landmark slots.
    const stale = new LanePipeline({ movement: 'seated_march', side: 'left' }); // mirrored defaults to false
    expect(() => new VisionInput({
      mode: 'leg', lanes: affected, calibrations: [mirroredCal()], thresholdFraction: 0.65,
      audioContext: new FakeClock(), detector: fakeDetector('leg'), driveLoop: false, mirrored: true,
      pipelines: [stale],
    })).toThrow(/mirrored/);
  });

  it('measures the affected limb through a reused pipeline built with the session convention', async () => {
    const shared = new LanePipeline({ movement: 'seated_march', side: 'left', smoothing: { kind: 'none' }, featureOptions: { mirrored: true } });
    const input = new VisionInput({
      mode: 'leg', lanes: affected, calibrations: [mirroredCal()], thresholdFraction: 0.65,
      audioContext: new FakeClock(), detector: fakeDetector('leg'), driveLoop: false, mirrored: true,
      pipelines: [shared],
    });
    const events: LaneInputEvent[] = [];
    input.onEvent((e) => events.push(e));
    await input.start();
    let peak = 0;
    for (const { t, amount } of repSequence({ restSec: 1, reps: 2, repDurationSec: 1, amplitude: 0.95 })) {
      input.processDetection({ tMs: t * 1000, pose: mirrorPoseLandmarks(seatedPose({ kneeLift: amount, side: 'left' })), hands: [] }, t);
      peak = Math.max(peak, input.getLaneDebug()[0].value);
    }
    expect(peak).toBeGreaterThan(0.85); // flat 0 before the fix
    expect(events).toHaveLength(2);
    expect(input.getStatus().reason).toBe('ok');
    input.stop();
  });

  it('a per-lane featureOptions.mirrored that contradicts the session is refused, not silently overridden', () => {
    expect(() => new VisionInput({
      mode: 'leg', lanes: affected, calibrations: [mirroredCal()], thresholdFraction: 0.65,
      audioContext: new FakeClock(), detector: fakeDetector('leg'), driveLoop: false, mirrored: true,
      featureOptions: [{ mirrored: false }],
    })).toThrow(/mirror/i);
  });

  it('aligns a reused pipeline\'s filter-break window with the session stall watchdog, and says when smoothing is ignored', () => {
    const shared = new LanePipeline({ movement: 'seated_march', side: 'left', smoothing: { kind: 'none' } });
    expect(shared.getMaxGapSec()).toBeCloseTo(0.5, 9);
    const warn = console.warn;
    const said: string[] = [];
    console.warn = (...a: unknown[]) => { said.push(a.map(String).join(' ')); };
    try {
      new VisionInput({
        mode: 'leg', lanes: affected, calibrations: [calFor('seated_march', 'left', (a) => seatedPose({ kneeLift: a }))],
        thresholdFraction: 0.65, audioContext: new FakeClock(), detector: fakeDetector('leg'), driveLoop: false,
        pipelines: [shared], staleFrameSec: 0.25, smoothing: { kind: 'ema', alpha: 0.2 },
      });
    } finally {
      console.warn = warn;
    }
    expect(shared.getMaxGapSec()).toBeCloseTo(0.25, 9);
    expect(shared.smoothing.kind).toBe('none'); // the shared signal path wins ...
    expect(said.join(' ')).toMatch(/smoothing is ignored/); // ... and the config is told it was ignored
  });

  it('pushes the session visibility gate onto a reused pipeline', () => {
    const shared = new LanePipeline({ movement: 'seated_march', side: 'left' });
    expect(shared.getMinVisibility()).toBeUndefined();
    const input = new VisionInput({
      mode: 'leg', lanes: affected, calibrations: [calFor('seated_march', 'left', (a) => seatedPose({ kneeLift: a }))],
      thresholdFraction: 0.65, audioContext: new FakeClock(), detector: fakeDetector('leg'), driveLoop: false,
      pipelines: [shared], minVisibility: 0.8,
    });
    expect(input.getPipeline(0)!.getMinVisibility()).toBe(0.8);
    // A pose whose knee is below the session's (raised) gate must now read as untracked on this lane.
    input.processDetection({ tMs: 0, pose: seatedPose({ kneeLift: 0.5, visibility: 0.7 }), hands: [] }, 0);
    expect(input.getLaneDebug()[0].tracking).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * 2. finger_opposition: WHICH fingertip is part of the measurement
 * ------------------------------------------------------------------ */

describe('finger_opposition records and checks the fingertip it was calibrated on', () => {
  const lane: LaneSpec[] = [{ index: 0, movement: 'finger_opposition', side: 'left' }];
  const indexCal = (): RomCalibration => ({
    min: extractFeature('finger_opposition', handPose({ pinch: 0 }), 'left')!,
    max: extractFeature('finger_opposition', handPose({ pinch: 1 }), 'left')!,
    samples: 1, movement: 'finger_opposition', fingertip: 'index',
  });
  const handFrame = (pinch: number): DetectionResult => ({ tMs: 0, pose: null, hands: [{ landmarks: handPose({ pinch, centerX: 0.7 }), label: 'Right', score: 0.95 }] });

  it('the calibrator stamps the fingertip it measured', () => {
    const cal = new RomCalibrator('finger_opposition', { fingertip: 'pinky', restDurationSec: 0.2, minRestSamples: 5, reps: 1, prominence: 0.2 });
    for (let i = 0; i < 12; i++) cal.push(0, i / 30);
    cal.beginMove();
    for (const v of [0, 0.5, 1, 0.5, 0]) cal.push(v, 1 + v);
    cal.finish();
    expect(cal.getResult()?.fingertip).toBe('pinky');
    // ... and one measured on the index does not validate a pinky lane.
    expect(isCalibrationValid(indexCal(), 'finger_opposition', { fingertip: 'pinky' })).toBe(false);
    expect(isCalibrationValid(indexCal(), 'finger_opposition', { fingertip: 'index' })).toBe(true);
    expect(isCalibrationValid(indexCal(), 'finger_opposition')).toBe(true); // default = index
    expect(calibrationProblem(indexCal(), 'finger_opposition', { fingertip: 'pinky' })).toMatch(/index/);
  });

  it('REFUSES an index-calibrated range on a lane that opposes another fingertip', async () => {
    const input = new VisionInput({
      mode: 'hand', lanes: lane, calibrations: [indexCal()], thresholdFraction: 0.65,
      audioContext: new FakeClock(), detector: fakeDetector('hand'), driveLoop: false,
      featureOptions: [{ fingertip: 'pinky' }], smoothing: { kind: 'none' },
    });
    const events: LaneInputEvent[] = [];
    input.onEvent((e) => events.push(e));
    await input.start();
    for (const pinch of [0, 0.5, 1, 0.5, 0, 1]) input.processDetection(handFrame(pinch), pinch);
    const st = input.getStatus();
    expect(st.reason).toBe('uncalibrated');
    expect(st.invalidCalibrationLanes).toEqual([0]);
    expect(input.getInvalidCalibrations()[0].reason).toMatch(/index/);
    expect(events).toHaveLength(0);          // refused, not normalized against the wrong quantity
    expect(input.getLaneStates()[0].value).toBe(0);
    input.stop();
  });

  it('REFUSES a reused pipeline that opposes a different fingertip', () => {
    const shared = new LanePipeline({ movement: 'finger_opposition', side: 'left', featureOptions: { fingertip: 'pinky' } });
    expect(() => new VisionInput({
      mode: 'hand', lanes: lane, calibrations: [indexCal()], thresholdFraction: 0.65,
      audioContext: new FakeClock(), detector: fakeDetector('hand'), driveLoop: false, pipelines: [shared],
    })).toThrow(/finger/);
  });

  it('plays normally when the calibration and the lane agree on the fingertip', async () => {
    const input = new VisionInput({
      mode: 'hand', lanes: lane, calibrations: [indexCal()], thresholdFraction: 0.65,
      audioContext: new FakeClock(), detector: fakeDetector('hand'), driveLoop: false, smoothing: { kind: 'none' },
    });
    const events: LaneInputEvent[] = [];
    input.onEvent((e) => events.push(e));
    await input.start();
    for (const [i, pinch] of [0, 0.5, 1, 0.5, 0].entries()) input.processDetection(handFrame(pinch), i / 30);
    expect(input.getStatus().reason).toBe('ok');
    expect(events).toHaveLength(1);
    input.stop();
  });
});

/* ------------------------------------------------------------------ *
 * 2b. setCalibration() — the RUNTIME hand-over a calibration screen uses
 * ------------------------------------------------------------------ */

describe('setCalibration vets with the LANE\'s fingertip, exactly like the constructor', () => {
  // Every other fingertip test above goes through the constructor. This is the API a calibration screen
  // actually calls (`vi.setCalibration(lane, calibrator.getResult())` after each lane finishes), and it
  // used to vet WITHOUT the lane's CalibrationContext — so a therapist-chosen fingertip made it do both
  // of the things this module calls its worst failures: refuse the range that was measured correctly
  // (lane dead for the whole session) and accept one measured on a DIFFERENT quantity (meter and
  // reported ROM% normalized by another finger's range).
  const lane: LaneSpec[] = [{ index: 0, movement: 'finger_opposition', side: 'right' }];
  const calOn = (fingertip: 'index' | 'pinky'): RomCalibration => ({
    min: extractFeature('finger_opposition', handPose({ pinch: 0 }), 'right', { fingertip })!,
    max: extractFeature('finger_opposition', handPose({ pinch: 1, pinchTarget: fingertip }), 'right', { fingertip })!,
    samples: 1, movement: 'finger_opposition', fingertip,
  });
  const make = () => new VisionInput({
    mode: 'hand', lanes: lane, calibrations: [null], thresholdFraction: 0.65,
    audioContext: new FakeClock(), detector: fakeDetector('hand'), driveLoop: false,
    featureOptions: [{ fingertip: 'pinky' }], smoothing: { kind: 'none' },
  });

  it('ACCEPTS the range measured on the lane\'s own fingertip', () => {
    const input = make();
    expect(input.setCalibration(0, calOn('pinky'))).toBe(true);
    const st = input.getStatus();
    expect(st.invalidCalibrationLanes ?? []).toEqual([]);
    expect(input.getLaneDebug()[0].calibration?.fingertip).toBe('pinky');
  });

  it('REFUSES a range measured on a different fingertip instead of normalizing one quantity by another', () => {
    const input = make();
    expect(input.setCalibration(0, calOn('index'))).toBe(false);
    expect(input.getStatus().invalidCalibrationLanes).toEqual([0]);
    expect(input.getInvalidCalibrations()[0].reason).toMatch(/index/);
    // Refused means UNCALIBRATED, not "used anyway": the lane reads 0 and cannot score.
    expect(input.getLaneDebug()[0].calibration).toBeNull();
  });

  it('a default-fingertip lane still accepts a default-fingertip range through the same path', () => {
    const input = new VisionInput({
      mode: 'hand', lanes: lane, calibrations: [null], thresholdFraction: 0.65,
      audioContext: new FakeClock(), detector: fakeDetector('hand'), driveLoop: false, smoothing: { kind: 'none' },
    });
    expect(input.setCalibration(0, calOn('index'))).toBe(true);
    expect(input.setCalibration(0, calOn('pinky'))).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * 3. thresholdFraction is a lane-killer and is validated
 * ------------------------------------------------------------------ */

describe('VisionInput validates the hit threshold', () => {
  const lanes: LaneSpec[] = [{ index: 0, movement: 'seated_march', side: 'left' }];
  const make = (thresholdFraction: number, extra: Record<string, unknown> = {}) => new VisionInput({
    mode: 'leg', lanes, calibrations: [calFor('seated_march', 'left', (a) => seatedPose({ kneeLift: a }))],
    thresholdFraction, audioContext: new FakeClock(), detector: fakeDetector('leg'), driveLoop: false, ...extra,
  });

  it('refuses 0 / NaN / >1 (every lane would be dead, and no watchdog would say so)', () => {
    expect(() => make(0)).toThrow(/thresholdFraction/);
    expect(() => make(Number.NaN)).toThrow(/thresholdFraction/);
    expect(() => make(1.5)).toThrow(/thresholdFraction/);
    expect(() => make(-0.2)).toThrow(/thresholdFraction/);
    expect(() => make(1)).not.toThrow();
    expect(() => make(0.05)).not.toThrow();
  });

  it('refuses a re-arm fraction that makes re-arming impossible', () => {
    expect(() => make(0.6, { rearmFraction: 1 })).toThrow(/rearmFraction/);
    expect(() => make(0.6, { rearmFraction: 0 })).toThrow(/rearmFraction/);
    expect(() => make(0.6, { minIntervalSec: -1 })).toThrow(/minIntervalSec/);
    expect(() => make(0.6, { rearmFraction: 0.6 })).not.toThrow();
  });
});

/* ------------------------------------------------------------------ *
 * 4. A compensation nobody is measuring must not read as "none observed"
 * ------------------------------------------------------------------ */

describe('compensation that is not being monitored is reported as not measured', () => {
  const lanes: LaneSpec[] = [{ index: 0, movement: 'ankle_dorsiflexion', side: 'left' }];
  const cal = () => calFor('ankle_dorsiflexion', 'left', (a) => seatedPose({ toeLift: a }));
  const make = (baseline?: ReturnType<typeof captureCompensationBaseline>) => new VisionInput({
    mode: 'leg', lanes, calibrations: [cal()], thresholdFraction: 0.7, audioContext: new FakeClock(),
    detector: fakeDetector('leg'), driveLoop: false, smoothing: { kind: 'none' },
    ...(baseline ? { compensationBaselines: [baseline] } : {}),
  });

  it('says so in the status and on every rep when no rest baseline exists', async () => {
    const input = make();
    const comps: CompensationEvent[] = [];
    const reps: LaneRepEvent[] = [];
    input.onCompensation((c) => comps.push(c));
    input.onRep((r) => reps.push(r));
    await input.start();
    // A full toe-lift rep performed with the heel completely off the floor: the textbook compensation.
    for (const { t, amount } of repSequence({ restSec: 0.5, reps: 1, repDurationSec: 1 })) {
      input.processDetection({ tMs: 0, pose: seatedPose({ toeLift: amount, heelLift: 1 }), hands: [] }, t);
    }
    expect(reps).toHaveLength(1);
    expect(reps[0].peak).toBeGreaterThan(0.9);
    expect(comps).toHaveLength(0);                      // nothing was measured ...
    expect(reps[0].compensation).toBeUndefined();
    expect(reps[0].compensationMonitored).toBe(false);  // ... and the rep SAYS it was not measured
    const st = input.getStatus();
    expect(st.unmonitoredCompensationLanes).toEqual([0]);
    expect(st.warnings!.join(' ')).toMatch(/not being monitored/i);
    expect(input.getUnmonitoredCompensationLanes()).toEqual([{ lane: 0, movement: 'ankle_dorsiflexion', side: 'left', kind: 'heel_lift' }]);
    expect(input.getLaneDebug()[0].compensationMonitored).toBe(false);
    input.stop();
  });

  it('reports nothing of the kind — and flags the rep — once a baseline exists', async () => {
    const input = make(captureCompensationBaseline('ankle_dorsiflexion', seatedRest(), 'left'));
    const reps: LaneRepEvent[] = [];
    input.onRep((r) => reps.push(r));
    await input.start();
    for (const { t, amount } of repSequence({ restSec: 0.5, reps: 1, repDurationSec: 1 })) {
      input.processDetection({ tMs: 0, pose: seatedPose({ toeLift: amount, heelLift: amount }), hands: [] }, t);
    }
    expect(reps[0].compensationMonitored).toBe(true);
    expect(reps[0].compensation?.kind).toBe('heel_lift');
    const st = input.getStatus();
    expect(st.unmonitoredCompensationLanes).toEqual([]);
    expect(st.warnings!.join(' ')).not.toMatch(/not being monitored/i);
    input.stop();
  });

  it('a movement that monitors nothing is never reported as unmonitored', async () => {
    const input = new VisionInput({
      mode: 'leg', lanes: [{ index: 0, movement: 'knee_extension', side: 'left' }],
      calibrations: [calFor('knee_extension', 'left', (a) => seatedPose({ kneeExtension: a }))],
      thresholdFraction: 0.7, audioContext: new FakeClock(), detector: fakeDetector('leg'), driveLoop: false,
    });
    await input.start();
    input.processDetection({ tMs: 0, pose: seatedPose({ kneeExtension: 0 }), hands: [] }, 0);
    expect(input.getStatus().unmonitoredCompensationLanes).toEqual([]);
    expect(input.getLaneDebug()[0].compensationMonitored).toBeNull();
    input.stop();
  });
});

/* ------------------------------------------------------------------ *
 * 5. The unreachable watchdog needs RECENT evidence of attempts
 * ------------------------------------------------------------------ */

describe('unreachable-lane watchdog only accuses a lane that is still being worked', () => {
  const lanes: LaneSpec[] = [{ index: 0, movement: 'seated_march', side: 'left' }];
  const make = () => new VisionInput({
    mode: 'leg', lanes, calibrations: [calFor('seated_march', 'left', (a) => seatedPose({ kneeLift: a }))],
    thresholdFraction: 0.8, audioContext: new FakeClock(), detector: fakeDetector('leg'), driveLoop: false,
    smoothing: { kind: 'none' }, unreachableLaneSec: 5, nowMs: () => 0,
  });
  const frame = (input: VisionInput, lift: number, t: number) =>
    input.processDetection({ tMs: t * 1000, pose: seatedPose({ kneeLift: lift }), hands: [] }, t);

  it('does NOT accuse a patient who made one sub-threshold attempt and then rested', async () => {
    const input = make();
    await input.start();
    // One honest attempt at ~0.7 of ROM (threshold 0.8) ...
    for (let i = 0; i < 10; i++) frame(input, 0.7, i / 30);
    expect(input.getLaneActivity()[0].peakSinceThreshold).toBeGreaterThan(0.4);
    // ... then a legitimate rest for longer than the whole watchdog window.
    for (let i = 0; i < 300; i++) frame(input, 0, 1 + i / 30);
    expect(input.getUnreachableLanes()).toEqual([]);
    expect(input.getStatus().reason).toBe('ok');
    expect(input.getLaneActivity()[0].sinceAttemptSec).toBeGreaterThan(5);
    input.stop();
  });

  it('DOES accuse a lane the patient keeps working without ever reaching the threshold', async () => {
    const input = make();
    await input.start();
    for (let i = 0; i < 300; i++) frame(input, i % 2 === 0 ? 0.7 : 0.1, i / 30);
    expect(input.getUnreachableLanes()).toEqual([0]);
    expect(input.getStatus().reason).toBe('lane_unreachable');
    input.stop();
  });
});

/* ------------------------------------------------------------------ *
 * 6. stop() clears the watchdog clocks (a resumed AudioContext need not advance)
 * ------------------------------------------------------------------ */

describe('stop() leaves no lane state behind for the next session', () => {
  it('a restarted session cannot be accused with the previous session\'s evidence', async () => {
    const lanes: LaneSpec[] = [{ index: 0, movement: 'seated_march', side: 'left' }];
    const input = new VisionInput({
      mode: 'leg', lanes, calibrations: [calFor('seated_march', 'left', (a) => seatedPose({ kneeLift: a }))],
      thresholdFraction: 0.8, audioContext: new FakeClock(), detector: fakeDetector('leg'), driveLoop: false,
      smoothing: { kind: 'none' }, unreachableLaneSec: 5, nowMs: () => 0,
    });
    await input.start();
    for (let i = 0; i < 300; i++) input.processDetection({ tMs: 0, pose: seatedPose({ kneeLift: 0.7 }), hands: [] }, i / 30);
    expect(input.getUnreachableLanes()).toEqual([0]);
    input.stop();

    // The AudioContext was suspended over the pause and resumes where it left off: ctx time does NOT
    // jump, so the "gap in tracking" self-heal inside processDetection never fires.
    await input.start();
    input.processDetection({ tMs: 0, pose: seatedPose({ kneeLift: 0.7 }), hands: [] }, 10);
    expect(input.getUnreachableLanes()).toEqual([]);
    const a = input.getLaneActivity()[0];
    expect(a.sinceThresholdSec).toBe(0); // the watchdog clock restarted with the session
    expect(a.unreachable).toBe(false);
    input.stop();
  });
});

/* ------------------------------------------------------------------ *
 * 7. A frozen AudioContext clock is detected and named
 * ------------------------------------------------------------------ */

describe('a suspended AudioContext (frozen ctx clock) is reported', () => {
  it('flags clockStalled when frames keep arriving with the same ctxTime', async () => {
    let wallMs = 0;
    const lanes: LaneSpec[] = [{ index: 0, movement: 'seated_march', side: 'left' }];
    const input = new VisionInput({
      mode: 'leg', lanes, calibrations: [calFor('seated_march', 'left', (a) => seatedPose({ kneeLift: a }))],
      thresholdFraction: 0.65, audioContext: new FakeClock(), detector: fakeDetector('leg'), driveLoop: false,
      nowMs: () => wallMs,
    });
    await input.start();
    // Frames arrive at 30 fps of WALL time; the audio clock is stuck at 0 (context suspended).
    for (let i = 0; i < 30; i++) {
      wallMs = i * 33;
      input.processDetection({ tMs: 0, pose: seatedPose({ kneeLift: 0 }), hands: [] }, 0);
    }
    expect(input.isClockStalled()).toBe(true);
    const st = input.getStatus();
    expect(st.clockStalled).toBe(true);
    expect(st.frameAgeSec).toBeLessThan(0.5);            // frames are NOT stale: this is a different fault
    expect(st.reason).toBe('ok');                        // ... and it is reported without lying about tracking
    expect(st.warnings!.join(' ')).toMatch(/audio clock/i);

    // The patient taps the screen, the context resumes: the flag clears on the next advancing frame.
    wallMs += 33;
    input.processDetection({ tMs: 0, pose: seatedPose({ kneeLift: 0 }), hands: [] }, 0.033);
    expect(input.isClockStalled()).toBe(false);
    expect(input.getStatus().clockStalled).toBe(false);
    input.stop();
  });

  it('a normally advancing clock is never flagged', async () => {
    let wallMs = 0;
    const lanes: LaneSpec[] = [{ index: 0, movement: 'seated_march', side: 'left' }];
    const input = new VisionInput({
      mode: 'leg', lanes, calibrations: [calFor('seated_march', 'left', (a) => seatedPose({ kneeLift: a }))],
      thresholdFraction: 0.65, audioContext: new FakeClock(), detector: fakeDetector('leg'), driveLoop: false,
      nowMs: () => wallMs,
    });
    await input.start();
    for (let i = 0; i < 60; i++) {
      wallMs = i * 33;
      input.processDetection({ tMs: 0, pose: seatedPose({ kneeLift: 0 }), hands: [] }, i / 30);
    }
    expect(input.isClockStalled()).toBe(false);
    expect(input.getStatus().warnings!.join(' ')).not.toMatch(/audio clock/i);
    input.stop();
  });
});
