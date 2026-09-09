import { describe, expect, it } from 'vitest';
import type { LaneSpec } from '../engine/types.ts';
import { VisionInput, visionStatusMessage } from './VisionInput.ts';
import type { LaneInputEvent, LaneRepEvent, CompensationEvent } from './types.ts';
import type { DetectionResult, LandmarkDetector } from '../vision/mediapipe.ts';
import { extractFeature, captureCompensationBaseline } from '../vision/features.ts';
import { handPose, repSequence, seatedPose, seatedPoseWorld, seatedRest } from '../vision/fixtures.ts';
import type { Landmark } from '../vision/landmarks.ts';
import { RomCalibrator } from '../vision/calibration.ts';
import type { RomCalibration } from '../vision/calibration.ts';
import { LanePipeline } from '../vision/pipeline.ts';

class FakeClock { currentTime = 0; }

/** Fake detector fed by a queue of frames (pose or hands). */
function fakeDetector(mode: 'leg' | 'hand', frames: DetectionResult[]): LandmarkDetector & { closed: boolean } {
  let i = 0;
  return {
    mode,
    delegate: 'CPU',
    closed: false,
    detect: (_f, ts) => ({ ...(frames[Math.min(i++, frames.length - 1)]), tMs: ts }),
    close() { this.closed = true; },
  };
}

function calFor(movement: LaneSpec['movement'], side: LaneSpec['side'], gen: (a: number) => Landmark[]): RomCalibration {
  return { min: extractFeature(movement, gen(0), side)!, max: extractFeature(movement, gen(1), side)!, samples: 1, movement };
}

describe('VisionInput end-to-end (leg mode, fake detector)', () => {
  const lanes: LaneSpec[] = [
    { index: 0, movement: 'seated_march', side: 'left' },
    { index: 1, movement: 'knee_extension', side: 'right' },
  ];
  const cals = [
    calFor('seated_march', 'left', (a) => seatedPose({ kneeLift: a, side: 'left' })),
    calFor('knee_extension', 'right', (a) => seatedPose({ kneeExtension: a, side: 'right' })),
  ];

  it('emits one event per rep on the right lane with interpolated ctx times and updates meters', async () => {
    const clock = new FakeClock();
    const detector = fakeDetector('leg', []);
    const input = new VisionInput({ mode: 'leg', lanes, calibrations: cals, thresholdFraction: 0.65, audioContext: clock, detector: () => Promise.resolve(detector), driveLoop: false, smoothing: { kind: 'none' } });
    const events: LaneInputEvent[] = [];
    const reps: LaneRepEvent[] = [];
    const off = input.onEvent((e) => events.push(e));
    input.onRep((r) => reps.push(r));
    await input.start();
    expect(input.getStatus().reason).toBe('no_person');

    // 3 left knee-lift reps (amplitude 0.9 so the rep peak is distinguishable from 1), right leg still.
    const seq = repSequence({ restSec: 1, reps: 3, repDurationSec: 1, amplitude: 0.9 });
    let maxValue = 0;
    for (const { t, amount } of seq) {
      const pose = seatedPose({ kneeLift: amount, side: 'left' });
      input.processDetection({ tMs: t * 1000, pose, hands: [] }, 10 + t);
      const st = input.getLaneStates();
      maxValue = Math.max(maxValue, st[0].value);
      expect(st[1].value).toBeLessThan(0.05);
      expect(st[0].tracking).toBe(true);
      expect(input.getStatus().tracking).toBe(true);
    }
    expect(maxValue).toBeGreaterThan(0.85);
    expect(maxValue).toBeLessThan(0.95);
    expect(events).toHaveLength(3);
    for (const [k, e] of events.entries()) {
      expect(e.lane).toBe(0);
      expect(e.strength).toBeGreaterThanOrEqual(0.65);
      expect(e.compensation).toBeUndefined();
      // rising half of rep k: song t in (1+k, 1.5+k) => ctx 11+k .. 11.5+k
      expect(e.ctxTime).toBeGreaterThan(11 + k);
      expect(e.ctxTime).toBeLessThan(11.5 + k);
    }
    // One rep-complete event per rep, joined to its LaneInputEvent by ctxTime, carrying the peak ROM.
    expect(reps).toHaveLength(3);
    for (const [k, r] of reps.entries()) {
      expect(r.lane).toBe(0);
      expect(r.ctxTime).toBe(events[k].ctxTime);
      expect(r.endCtxTime).toBeGreaterThan(r.ctxTime);
      expect(r.peak).toBeCloseTo(maxValue, 2);
      expect(r.peak).toBeGreaterThan(events[k].strength);
      expect(r.compensation).toBeUndefined();
    }
    // ctxTime is interpolated (not a multiple of the 1/30 frame period).
    const frac = ((events[0].ctxTime - 10) * 30) % 1;
    expect(frac).toBeGreaterThan(0.01);
    expect(frac).toBeLessThan(0.99);

    // Now the right leg extends: lane 1 fires, lane 0 does not.
    for (const { t, amount } of repSequence({ restSec: 0.5, reps: 1, repDurationSec: 1 })) {
      input.processDetection({ tMs: 0, pose: seatedPose({ kneeExtension: amount, side: 'right' }), hands: [] }, 20 + t);
    }
    expect(events).toHaveLength(4);
    expect(events[3].lane).toBe(1);

    expect(input.getLatestDetection()).not.toBeNull();
    expect(input.getLaneLandmarks(0)).toHaveLength(33);
    expect(input.getLaneDebug()[0].calibration).toBe(cals[0]);
    off();
    input.processDetection({ tMs: 0, pose: seatedPose({ kneeLift: 1 }), hands: [] }, 30);
    expect(events).toHaveLength(4);
    input.stop();
    expect(detector.closed).toBe(true);
    expect(input.getStatus().reason).toBe('stopped');
  });

  it('reports no_person / low_visibility and marks lanes untracked', async () => {
    const clock = new FakeClock();
    const input = new VisionInput({ mode: 'leg', lanes, calibrations: cals, thresholdFraction: 0.5, audioContext: clock, detector: fakeDetector('leg', []), driveLoop: false });
    await input.start();
    input.processDetection({ tMs: 0, pose: null, hands: [] }, 1);
    expect(input.getStatus().reason).toBe('no_person');
    expect(input.getLaneStates().every((s) => !s.tracking)).toBe(true);
    const pose = seatedRest();
    pose[25] = { ...pose[25], visibility: 0.1 }; // left knee hidden
    input.processDetection({ tMs: 0, pose, hands: [] }, 2);
    const st = input.getStatus();
    expect(st.reason).toBe('low_visibility');
    expect(st.untrackedLanes).toEqual([0]);
    expect(input.getLaneStates()[1].tracking).toBe(true);
    input.processDetection({ tMs: 0, pose: seatedRest(), hands: [] }, 3);
    expect(input.getStatus().reason).toBe('ok');
    // Meters do not freeze mid-ROM when tracking is lost: value resets to 0.
    input.processDetection({ tMs: 0, pose: seatedPose({ kneeLift: 1 }), hands: [] }, 4);
    input.processDetection({ tMs: 0, pose: seatedPose({ kneeLift: 1 }), hands: [] }, 4.05);
    expect(input.getLaneStates()[0].value).toBeGreaterThan(0.7);
    input.processDetection({ tMs: 0, pose: null, hands: [] }, 4.1);
    expect(input.getLaneStates()[0]).toMatchObject({ value: 0, tracking: false });
    expect(input.getLaneDebug()[0].raw).toBeNull();
    input.stop();
  });

  it('uses pose world landmarks for the angle features when the detector provides them', async () => {
    const clock = new FakeClock();
    const laneSpec: LaneSpec[] = [{ index: 0, movement: 'knee_extension', side: 'left' }];
    const cal = calFor('knee_extension', 'left', (a) => seatedPose({ kneeExtension: a }));
    const input = new VisionInput({ mode: 'leg', lanes: laneSpec, calibrations: [cal], thresholdFraction: 0.5, audioContext: clock, detector: fakeDetector('leg', []), driveLoop: false, smoothing: { kind: 'none' } });
    await input.start();
    // Image landmarks say "rest", world landmarks say "extended": the metric angle wins.
    input.processDetection({ tMs: 0, pose: seatedRest(), poseWorld: seatedPoseWorld({ kneeExtension: 1 }), hands: [] }, 1);
    expect(input.getLaneStates()[0].value).toBeGreaterThan(0.9);
    input.processDetection({ tMs: 0, pose: seatedRest(), poseWorld: null, hands: [] }, 2);
    expect(input.getLaneStates()[0].value).toBeLessThan(0.05);
    input.stop();
  });

  it('frameTimeToCtx maps a performance.now() frame time to ctx time by its age', async () => {
    const clock = new FakeClock();
    clock.currentTime = 100;
    const lanes1: LaneSpec[] = [{ index: 0, movement: 'seated_march', side: 'left' }];
    const input = new VisionInput({ mode: 'leg', lanes: lanes1, calibrations: [null], thresholdFraction: 0.5, audioContext: clock, detector: fakeDetector('leg', []), driveLoop: false });
    const now = performance.now();
    expect(input.frameTimeToCtx(now - 50)).toBeCloseTo(99.95, 2);
    expect(input.frameTimeToCtx(now)).toBeCloseTo(100, 2);
    // A frame time in the future (clock skew) never yields a ctx time after "now".
    expect(input.frameTimeToCtx(now + 1000)).toBeLessThanOrEqual(100);
  });

  it('calibrates through the SAME pipeline it plays with (onFrame -> RomCalibrator), so hard reps are reachable at tempo', async () => {
    const clock = new FakeClock();
    const laneSpec: LaneSpec[] = [{ index: 0, movement: 'seated_march', side: 'left' }, { index: 1, movement: 'ankle_dorsiflexion', side: 'right' }];
    // Left knee lifts while the right toes lift (different legs: lifting the knee would lift that heel too).
    const twoLegs = (amount: number) => {
      const pose = seatedPose({ kneeLift: amount, side: 'left' });
      const right = seatedPose({ toeLift: amount, side: 'right' });
      for (const i of [26, 28, 30, 32]) pose[i] = right[i];
      return pose;
    };
    const input = new VisionInput({ mode: 'leg', lanes: laneSpec, calibrations: [null, null], thresholdFraction: 0.8, audioContext: clock, detector: fakeDetector('leg', []), driveLoop: false });
    const events: LaneInputEvent[] = [];
    input.onEvent((e) => events.push(e));
    await input.start();
    const calibrators = laneSpec.map((l) => new RomCalibrator(l.movement));
    const offFrame = input.onFrame((samples) => samples.forEach((s, i) => calibrators[i].pushSample(s)));
    // Uncalibrated lanes read 0 and never trigger while the patient calibrates with slow (1.5 s) reps.
    for (const { t, amount } of repSequence({ restSec: 2.5, reps: 3, repDurationSec: 1.5 })) {
      input.processDetection({ tMs: 0, pose: twoLegs(amount), hands: [] }, t);
      expect(input.getLaneStates().every((s) => s.value === 0)).toBe(true);
    }
    expect(events).toHaveLength(0);
    offFrame();
    for (const [i, c] of calibrators.entries()) {
      expect(c.getPhase()).toBe('done');
      expect(c.getError()).toBeNull();
      input.setCalibration(i, c.getResult());
    }
    expect(input.getLaneDebug()[1].calibration?.compensationBaseline?.kind).toBe('heel_lift');
    // Play at tempo (0.5 s reps): every rep crosses the hard threshold on both lanes.
    let peak = 0;
    for (const { t, amount } of repSequence({ restSec: 1, reps: 6, repDurationSec: 0.5 })) {
      input.processDetection({ tMs: 0, pose: twoLegs(amount), hands: [] }, 20 + t);
      peak = Math.max(peak, ...input.getLaneStates().map((s) => s.value));
    }
    expect(peak).toBeGreaterThan(0.9);
    expect(events.filter((e) => e.lane === 0)).toHaveLength(6);
    expect(events.filter((e) => e.lane === 1)).toHaveLength(6);
    expect(events.every((e) => e.compensation === undefined)).toBe(true);
    expect(input.filterDelaySec(30)).toBeCloseTo(1 / 30, 9);
    // Pipelines can be handed over to a new VisionInput (same filter objects) with the calibrations.
    const again = new VisionInput({ mode: 'leg', lanes: laneSpec, calibrations: calibrators.map((c) => c.getResult()), thresholdFraction: 0.8, audioContext: clock, detector: fakeDetector('leg', []), driveLoop: false, pipelines: input.getPipelines() });
    expect(again.getPipeline(0)).toBe(input.getPipeline(0));
    expect(again.getPipeline(0)).toBeInstanceOf(LanePipeline);
    expect(() => new VisionInput({ mode: 'leg', lanes: [laneSpec[1]], calibrations: [null], thresholdFraction: 0.8, audioContext: clock, driveLoop: false, pipelines: [input.getPipeline(0)!] })).toThrow(/pipeline 0/);
    input.stop();
  });

  it('emits compensation events for heel lift when baselines are given', async () => {
    const clock = new FakeClock();
    const laneSpec: LaneSpec[] = [{ index: 0, movement: 'ankle_dorsiflexion', side: 'left' }];
    const cal = calFor('ankle_dorsiflexion', 'left', (a) => seatedPose({ toeLift: a }));
    const baseline = captureCompensationBaseline('ankle_dorsiflexion', seatedRest(), 'left');
    const input = new VisionInput({ mode: 'leg', lanes: laneSpec, calibrations: [cal], thresholdFraction: 0.7, audioContext: clock, detector: fakeDetector('leg', []), driveLoop: false, compensationBaselines: [baseline], smoothing: { kind: 'none' } });
    const comps: CompensationEvent[] = [];
    input.onCompensation((c) => comps.push(c));
    const events: LaneInputEvent[] = [];
    input.onEvent((e) => events.push(e));
    const reps: LaneRepEvent[] = [];
    input.onRep((r) => reps.push(r));
    await input.start();
    for (const { t, amount } of repSequence({ restSec: 0.5, reps: 1, repDurationSec: 1 })) {
      input.processDetection({ tMs: 0, pose: seatedPose({ toeLift: amount }), hands: [] }, t);
    }
    expect(events).toHaveLength(1);
    expect(events[0].compensation).toBeUndefined();
    expect(reps).toHaveLength(1);
    expect(reps[0].compensation).toBeUndefined();
    expect(comps).toHaveLength(0);
    for (const { t, amount } of repSequence({ restSec: 0.5, reps: 1, repDurationSec: 1 })) {
      input.processDetection({ tMs: 0, pose: seatedPose({ toeLift: amount, heelLift: amount }), hands: [] }, 5 + t);
    }
    expect(events).toHaveLength(2);
    expect(comps.length).toBeGreaterThanOrEqual(1);
    expect(comps[0].kind).toBe('heel_lift');
    expect(comps[0].lane).toBe(0);
    expect(input.getLaneDebug()[0].compensation?.kind).toBe('heel_lift');
    // The flag reaches the engine on the hit event itself (heel already up at the crossing) ...
    expect(events[1].compensation?.kind).toBe('heel_lift');
    expect(events[1].compensation!.value).toBeGreaterThan(0.12);
    // ... and the rep summary carries the worst value over the whole rep (>= what the event saw).
    expect(reps).toHaveLength(2);
    expect(reps[1].ctxTime).toBe(events[1].ctxTime);
    expect(reps[1].compensation?.kind).toBe('heel_lift');
    expect(reps[1].compensation!.value).toBeGreaterThanOrEqual(events[1].compensation!.value);
    // A compensation flag never leaks into the next (clean) rep.
    for (const { t, amount } of repSequence({ restSec: 0.5, reps: 1, repDurationSec: 1 })) {
      input.processDetection({ tMs: 0, pose: seatedPose({ toeLift: amount }), hands: [] }, 10 + t);
    }
    expect(events[2].compensation).toBeUndefined();
    expect(reps[2].compensation).toBeUndefined();
  });

  it('validates config', () => {
    const clock = new FakeClock();
    expect(() => new VisionInput({ mode: 'hand', lanes, calibrations: cals, thresholdFraction: 0.5, audioContext: clock })).toThrow(/not a hand movement/);
    expect(() => new VisionInput({ mode: 'leg', lanes, calibrations: [cals[0]], thresholdFraction: 0.5, audioContext: clock })).toThrow(/calibrations/);
  });
});

describe('VisionInput end-to-end (hand mode, two hands, raw stream)', () => {
  it('routes each hand to its lane using mirror-corrected handedness', async () => {
    const clock = new FakeClock();
    const lanes: LaneSpec[] = [
      { index: 0, movement: 'hand_open_close', side: 'left' },
      { index: 1, movement: 'finger_opposition', side: 'right' },
    ];
    const cals = [
      calFor('hand_open_close', 'left', (a) => handPose({ openness: a })),
      calFor('finger_opposition', 'right', (a) => handPose({ pinch: a })),
    ];
    const input = new VisionInput({ mode: 'hand', lanes, calibrations: cals, thresholdFraction: 0.6, audioContext: clock, detector: fakeDetector('hand', []), driveLoop: false, mirrored: false, smoothing: { kind: 'ema', alpha: 0.6 } });
    const events: LaneInputEvent[] = [];
    input.onEvent((e) => events.push(e));
    await input.start();
    expect(input.getStatus().reason).toBe('no_hand');
    // Raw stream: MediaPipe label "Right" == patient's LEFT hand; label "Left" == patient's RIGHT hand.
    const seq = repSequence({ restSec: 0.5, reps: 2, repDurationSec: 1 });
    for (const { t, amount } of seq) {
      const patientLeft = handPose({ openness: amount, centerX: 0.7 });
      const patientRight = handPose({ pinch: 0, centerX: 0.3 });
      input.processDetection({ tMs: 0, pose: null, hands: [
        { landmarks: patientLeft, label: 'Right', score: 0.95 },
        { landmarks: patientRight, label: 'Left', score: 0.95 },
      ] }, t);
    }
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.lane === 0)).toBe(true);
    for (const { t, amount } of seq) {
      input.processDetection({ tMs: 0, pose: null, hands: [
        { landmarks: handPose({ openness: 0, centerX: 0.7 }), label: 'Right', score: 0.95 },
        { landmarks: handPose({ pinch: amount, centerX: 0.3 }), label: 'Left', score: 0.95 },
      ] }, 10 + t);
    }
    expect(events).toHaveLength(4);
    expect(events[2].lane).toBe(1);
    expect(events[3].lane).toBe(1);
    // One hand leaves the frame => hand_missing, that lane untracked.
    input.processDetection({ tMs: 0, pose: null, hands: [{ landmarks: handPose({ centerX: 0.7 }), label: 'Right', score: 0.95 }] }, 20);
    expect(input.getStatus().reason).toBe('hand_missing');
    expect(input.getStatus().untrackedLanes).toEqual([1]);
    input.stop();
  });
});

describe('VisionInput hand mode: two lanes on the same hand, status messages', () => {
  it('drives both lanes from the one (left) hand and words the status for that hand', async () => {
    const clock = new FakeClock();
    const lanes: LaneSpec[] = [
      { index: 0, movement: 'hand_open_close', side: 'left' },
      { index: 1, movement: 'finger_spread', side: 'left' },
    ];
    const cals = [
      calFor('hand_open_close', 'left', (a) => handPose({ openness: a })),
      calFor('finger_spread', 'left', (a) => handPose({ spread: a })),
    ];
    const input = new VisionInput({ mode: 'hand', lanes, calibrations: cals, thresholdFraction: 0.6, audioContext: clock, detector: fakeDetector('hand', []), driveLoop: false, smoothing: { kind: 'none' } });
    const events: LaneInputEvent[] = [];
    input.onEvent((e) => events.push(e));
    await input.start();
    // Only the patient's left hand (label "Right" on a raw stream) is in view: both lanes track it.
    for (const { t, amount } of repSequence({ restSec: 0.5, reps: 2, repDurationSec: 1 })) {
      input.processDetection({ tMs: 0, pose: null, hands: [{ landmarks: handPose({ openness: amount, spread: amount, centerX: 0.7 }), label: 'Right', score: 0.95 }] }, t);
      expect(input.getLaneStates().every((s) => s.tracking)).toBe(true);
    }
    expect(input.getStatus().reason).toBe('ok');
    expect(events.filter((e) => e.lane === 0)).toHaveLength(2);
    expect(events.filter((e) => e.lane === 1)).toHaveLength(2);
    expect(input.getLaneLandmarks(0)).toBe(input.getLaneLandmarks(1));
    // The wrong (right) hand alone: both lanes untracked; message names the LEFT hand, not "both hands".
    input.processDetection({ tMs: 0, pose: null, hands: [{ landmarks: handPose({ centerX: 0.3 }), label: 'Left', score: 0.95 }] }, 10);
    const st = input.getStatus();
    expect(st.reason).toBe('hand_missing');
    expect(st.untrackedLanes).toEqual([0, 1]);
    expect(st.message).toMatch(/your left hand/i);
    expect(st.message).not.toMatch(/both hands/i);
    // A hand that is present but incomplete is 'low_visibility' with a hand-specific message.
    input.processDetection({ tMs: 0, pose: null, hands: [{ landmarks: handPose({ centerX: 0.7 }).slice(0, 12), label: 'Right', score: 0.95 }] }, 11);
    expect(input.getStatus().reason).toBe('low_visibility');
    expect(input.getStatus().message).toMatch(/hand/i);
    expect(input.getStatus().message).not.toMatch(/knees/i);
    input.stop();
  });

  it('visionStatusMessage adapts to the configured lanes', () => {
    const both: LaneSpec[] = [{ index: 0, movement: 'hand_open_close', side: 'left' }, { index: 1, movement: 'hand_open_close', side: 'right' }];
    expect(visionStatusMessage('hand_missing', 'hand', both)).toMatch(/both hands/i);
    expect(visionStatusMessage('hand_missing', 'hand', [both[1]])).toMatch(/right hand/i);
    expect(visionStatusMessage('low_visibility', 'leg', [{ index: 0, movement: 'seated_march', side: 'left' }])).not.toMatch(/feet/);
    expect(visionStatusMessage('low_visibility', 'leg', [{ index: 0, movement: 'ankle_dorsiflexion', side: 'left' }])).toMatch(/feet/);
    expect(visionStatusMessage('ok', 'leg', [])).toBe('');
  });
});

describe('VisionInput with a driven loop (fake camera + rVFC)', () => {
  it('runs frames through the loop and converts frame times to ctx time', async () => {
    const clock = new FakeClock();
    clock.currentTime = 100;
    const cbs: Array<(now: number, meta: { captureTime?: number }) => void> = [];
    const video = {
      requestVideoFrameCallback: (cb: (now: number, meta: { captureTime?: number }) => void) => cbs.push(cb),
      cancelVideoFrameCallback: () => {},
    } as unknown as HTMLVideoElement;
    let stopped = false;
    const camera = { video, stream: {} as MediaStream, width: 640, height: 480, stop: () => { stopped = true; } };
    const frames: DetectionResult[] = [];
    for (const { amount } of repSequence({ restSec: 0.2, reps: 1, repDurationSec: 0.6, fps: 30 })) {
      frames.push({ tMs: 0, pose: seatedPose({ abduction: amount }), hands: [] });
    }
    const detector = fakeDetector('leg', frames);
    const lanes: LaneSpec[] = [{ index: 0, movement: 'hip_abduction', side: 'left' }];
    const cal = calFor('hip_abduction', 'left', (a) => seatedPose({ abduction: a }));
    const input = new VisionInput({ mode: 'leg', lanes, calibrations: [cal], thresholdFraction: 0.5, audioContext: clock, detector: () => Promise.resolve(detector), camera: () => Promise.resolve(camera), smoothing: { kind: 'none' } });
    const events: LaneInputEvent[] = [];
    input.onEvent((e) => events.push(e));
    await input.start();
    expect(input.getVideoElement()).toBe(video);
    expect(input.getStatus().delegate).toBe('CPU');
    const now = performance.now();
    for (let i = 0; i < frames.length; i++) {
      clock.currentTime = 100 + i / 30;
      cbs[i](now + (i * 1000) / 30, { captureTime: now + (i * 1000) / 30 });
    }
    expect(events).toHaveLength(1);
    expect(events[0].ctxTime).toBeGreaterThan(100);
    expect(events[0].ctxTime).toBeLessThan(100 + frames.length / 30);
    expect(input.getStats().frames).toBe(frames.length);
    input.stop();
    expect(stopped).toBe(true);
  });
});
