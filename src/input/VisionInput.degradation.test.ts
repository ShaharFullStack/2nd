/**
 * The degradations that used to be SILENT: the app throttling its own inference, a lane driven by a hand
 * nobody could identify, and the pose model changing its mind about whose body it is tracking.
 *
 * Each one leaves every existing watchdog green — frames arrive, landmarks are present, values are
 * plausible, lanes are being attempted — while a therapist-facing number quietly stops meaning what it
 * says. This module's rule is that no failure mode is allowed to be silent, so each is named in
 * getStatus(): as a flag for the UI and as a sentence a patient or therapist can act on.
 */
import { describe, expect, it } from 'vitest';
import type { LaneSpec } from '../engine/types.ts';
import { VisionInput } from './VisionInput.ts';
import type { CameraSession, DetectionResult, LandmarkDetector } from '../vision/mediapipe.ts';
import { extractFeature } from '../vision/features.ts';
import { handPose, seatedPose, translateLandmarks } from '../vision/fixtures.ts';
import { POSE } from '../vision/landmarks.ts';
import type { Landmark } from '../vision/landmarks.ts';
import type { RomCalibration } from '../vision/calibration.ts';

class FakeClock { currentTime = 0; }

function fakeDetector(mode: 'leg' | 'hand'): LandmarkDetector {
  return { mode, delegate: 'CPU', detect: (_f, ts): DetectionResult => ({ tMs: ts, pose: null, hands: [] }), close() {} };
}

const legCal: RomCalibration = {
  min: extractFeature('seated_march', seatedPose({ kneeLift: 0 }), 'left')!,
  max: extractFeature('seated_march', seatedPose({ kneeLift: 1 }), 'left')!,
  samples: 1,
  movement: 'seated_march',
};
const handCal: RomCalibration = {
  min: extractFeature('hand_open_close', handPose({ openness: 0 }), 'right')!,
  max: extractFeature('hand_open_close', handPose({ openness: 1 }), 'right')!,
  samples: 1,
  movement: 'hand_open_close',
};

/* ------------------------------------------------------------------ *
 * 1. A lane driven by a hand nobody could identify
 * ------------------------------------------------------------------ */

describe('an unidentified lone hand is used but NAMED', () => {
  const lanes: LaneSpec[] = [{ index: 0, movement: 'hand_open_close', side: 'right' }];
  const make = () => new VisionInput({
    mode: 'hand', lanes, calibrations: [handCal], thresholdFraction: 0.65,
    audioContext: new FakeClock(), detector: fakeDetector('hand'), driveLoop: false, smoothing: { kind: 'none' },
  });
  const frame = (score: number, label: string): DetectionResult => ({ tMs: 0, pose: null, hands: [{ landmarks: handPose({ openness: 0.2 }), label, score }] });

  it('reports the lane when the handedness label was a coin flip (unilateral escape hatch)', async () => {
    const input = make(); // unilateral => acceptLoneHand defaults on
    await input.start();
    input.processDetection(frame(0.52, 'Left'), 0);
    const st = input.getStatus();
    expect(st.unlabelledHandLanes).toEqual([0]);
    expect(st.warnings?.some((w) => /cannot tell which hand/i.test(w))).toBe(true);
    expect(st.reason).toBe('ok'); // still measured: refusing would lock the patient out of their session
    input.stop();
  });

  it('says nothing when the hand IS identified', async () => {
    const input = make();
    await input.start();
    input.processDetection(frame(0.95, 'Left'), 0); // "Left" on a raw stream = the patient's RIGHT hand
    const st = input.getStatus();
    expect(st.unlabelledHandLanes).toEqual([]);
    expect(st.warnings?.some((w) => /cannot tell which hand/i.test(w))).toBe(false);
    input.stop();
  });

  it('clears once the label recovers (it is a live condition, not a latch)', async () => {
    const input = make();
    await input.start();
    input.processDetection(frame(0.52, 'Left'), 0);
    expect(input.getStatus().unlabelledHandLanes).toEqual([0]);
    input.processDetection(frame(0.95, 'Left'), 1 / 30);
    expect(input.getStatus().unlabelledHandLanes).toEqual([]);
    input.stop();
  });

  it('a hand weakly labelled the OTHER side is not scored as the prescribed one at all', async () => {
    const input = make();
    await input.start();
    // 0.59: below the trust bar, but not a coin flip — believed enough to refuse the wrong side.
    input.processDetection(frame(0.59, 'Right'), 0); // "Right" raw = the patient's LEFT hand
    const st = input.getStatus();
    expect(st.reason).toBe('hand_missing'); // the lane has no landmarks at all, rather than the wrong hand's
    expect(st.unlabelledHandLanes).toEqual([]);
    input.stop();
  });
});

/* ------------------------------------------------------------------ *
 * 2. The pose model changing bodies mid-session
 * ------------------------------------------------------------------ */

describe('same-person guard: a therapist crossing the frame is not silently measured', () => {
  const lanes: LaneSpec[] = [{ index: 0, movement: 'seated_march', side: 'left' }];
  const make = (extra: Record<string, unknown> = {}) => new VisionInput({
    mode: 'leg', lanes, calibrations: [legCal], thresholdFraction: 0.65,
    audioContext: new FakeClock(), detector: fakeDetector('leg'), driveLoop: false, smoothing: { kind: 'none' }, ...extra,
  });
  const feed = (input: VisionInput, poses: Landmark[][], startT = 0) => {
    let t = startT;
    for (const pose of poses) {
      input.processDetection({ tMs: t * 1000, pose, hands: [] }, t);
      t += 1 / 30;
    }
    return t;
  };
  /** Same seated figure, further from the camera: a different body, plausibly posed. */
  const shorterTorso = (): Landmark[] => {
    const p = seatedPose();
    for (const i of [POSE.LEFT_SHOULDER, POSE.RIGHT_SHOULDER]) p[i] = { ...p[i], y: 0.48 };
    return p;
  };

  it('flags a hip-midpoint teleport between consecutive frames', async () => {
    const input = make();
    await input.start();
    feed(input, [seatedPose(), seatedPose(), translateLandmarks(seatedPose(), 0.3, 0)]);
    const st = input.getStatus();
    expect(st.subjectChanged).toBe(true);
    expect(st.warnings?.some((w) => /different person/i.test(w))).toBe(true);
    input.stop();
  });

  it('flags a torso that changes length by more than a quarter in one frame', async () => {
    const input = make();
    await input.start();
    feed(input, [seatedPose(), seatedPose(), shorterTorso()]);
    expect(input.getStatus().subjectChanged).toBe(true);
    input.stop();
  });

  it('does NOT flag the movements the patient is actually asked to perform', async () => {
    const input = make();
    await input.start();
    const poses: Landmark[][] = [];
    for (let i = 0; i <= 30; i++) poses.push(seatedPose({ kneeLift: Math.sin((i / 30) * Math.PI) }));
    poses.push(seatedPose({ trunkLean: 1 })); // even a whole trunk lean inside one frame
    feed(input, poses);
    const st = input.getStatus();
    expect(st.subjectChanged).toBe(false);
    expect(st.reason).toBe('ok');
    input.stop();
  });

  it('does NOT flag a body re-acquired after an absence (it is legitimately somewhere else)', async () => {
    const input = make();
    await input.start();
    let t = feed(input, [seatedPose(), seatedPose()]);
    input.processDetection({ tMs: t * 1000, pose: null, hands: [] }, t); // out of frame
    t += 1 / 30;
    input.processDetection({ tMs: t * 1000, pose: translateLandmarks(seatedPose(), 0.3, 0), hands: [] }, t);
    expect(input.getStatus().subjectChanged).toBe(false);
    input.stop();
  });

  it('the warning ages out instead of latching for the rest of the song', async () => {
    const input = make({ subjectGuard: { warnSec: 0.2 } });
    await input.start();
    let t = feed(input, [seatedPose(), seatedPose(), translateLandmarks(seatedPose(), 0.3, 0)]);
    expect(input.getStatus().subjectChanged).toBe(true);
    for (let i = 0; i < 12; i++) {
      input.processDetection({ tMs: t * 1000, pose: translateLandmarks(seatedPose(), 0.3, 0), hands: [] }, t);
      t += 1 / 30;
    }
    expect(input.getStatus().subjectChanged).toBe(false);
    input.stop();
  });

  it('can be switched off, and is leg-mode only', async () => {
    const input = make({ subjectGuard: false });
    await input.start();
    feed(input, [seatedPose(), seatedPose(), translateLandmarks(seatedPose(), 0.3, 0)]);
    expect(input.getStatus().subjectChanged).toBe(false);
    expect(input.getSubjectChangedSec()).toBe(Infinity);
    input.stop();
  });
});

/* ------------------------------------------------------------------ *
 * 3. The app throttling its own inference
 * ------------------------------------------------------------------ */

interface RvfcVideo extends HTMLVideoElement { __cbs: Array<(now: number, meta: { captureTime: number }) => void>; }

function rvfcVideo(): RvfcVideo {
  const cbs: Array<(now: number, meta: { captureTime: number }) => void> = [];
  return {
    __cbs: cbs,
    requestVideoFrameCallback: (cb: (n: number, m: { captureTime: number }) => void) => cbs.push(cb),
    cancelVideoFrameCallback: () => {},
    currentTime: 0,
    readyState: 4,
    videoWidth: 640,
    videoHeight: 480,
  } as unknown as RvfcVideo;
}

function fakeCamera(video: HTMLVideoElement): CameraSession {
  return { video, stream: {} as MediaStream, width: 640, height: 480, ended: false, onEnded: null, stop() {} };
}

describe('throttled inference is reported separately from a slow camera', () => {
  const lanes: LaneSpec[] = [{ index: 0, movement: 'seated_march', side: 'left' }];

  it('names the app duty-cycling inference, with the remedy that actually applies', async () => {
    const video = rvfcVideo();
    // A CPU-delegate pose inference that blows the frame budget, exactly like the clinic laptop.
    const slow: LandmarkDetector = {
      mode: 'leg',
      delegate: 'CPU',
      detect: (_f, ts): DetectionResult => {
        const until = performance.now() + 20;
        while (performance.now() < until) { /* burn the main thread, as MediaPipe does */ }
        return { tMs: ts, pose: seatedPose(), hands: [] };
      },
      close() {},
    };
    const input = new VisionInput({
      mode: 'leg', lanes, calibrations: [legCal], thresholdFraction: 0.65,
      audioContext: new FakeClock(), detector: slow, camera: fakeCamera(video),
      loopOptions: { maxDetectHz: 30, budgetMs: 1, adaptiveSkip: true },
    });
    await input.start();
    for (const t of [0, 40, 80, 120, 160, 200]) video.__cbs[video.__cbs.length - 1](t, { captureTime: t });
    expect(input.isThrottled()).toBe(true);
    expect(input.getStats().skipped).toBeGreaterThan(0);
    const st = input.getStatus();
    expect(st.throttled).toBe(true);
    const warning = st.warnings?.find((w) => /analysing fewer frames/i.test(w));
    expect(warning).toBeTruthy();
    // The remedy is NOT the lowFps remedy ("close other apps"): the frames are arriving fine.
    expect(warning).toMatch(/graphics acceleration/i);
    input.stop();
  });

  it('says nothing when inference fits the budget', async () => {
    const video = rvfcVideo();
    const fast: LandmarkDetector = { mode: 'leg', delegate: 'GPU', detect: (_f, ts) => ({ tMs: ts, pose: seatedPose(), hands: [] }), close() {} };
    const input = new VisionInput({
      mode: 'leg', lanes, calibrations: [legCal], thresholdFraction: 0.65,
      audioContext: new FakeClock(), detector: fast, camera: fakeCamera(video),
      loopOptions: { maxDetectHz: 30, budgetMs: 10, adaptiveSkip: true },
    });
    await input.start();
    for (const t of [0, 40, 80, 120]) video.__cbs[video.__cbs.length - 1](t, { captureTime: t });
    expect(input.isThrottled()).toBe(false);
    expect(input.getStatus().throttled).toBe(false);
    input.stop();
  });
});
