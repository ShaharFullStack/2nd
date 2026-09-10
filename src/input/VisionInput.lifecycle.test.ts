/**
 * VisionInput lifecycle: start()/stop() must be race-safe, and the camera must be OFF whenever the
 * screen is gone.
 *
 * Acquiring a detector and a camera takes two awaits, the second of which contains the browser's
 * permission prompt. Real UI drives that concurrently — React StrictMode's mount/unmount/mount is
 * literally start(); stop(); start(), and a patient can back out of the camera check while the prompt
 * is up. Both races used to leave a recording camera and a running inference loop behind.
 */
import { describe, expect, it, vi } from 'vitest';
import type { LaneSpec } from '../engine/types.ts';
import { VisionInput } from './VisionInput.ts';
import type { CameraSession, DetectionResult, LandmarkDetector } from '../vision/mediapipe.ts';
import { extractFeature } from '../vision/features.ts';
import { reNormalizeAspect, seatedPose } from '../vision/fixtures.ts';
import type { RomCalibration } from '../vision/calibration.ts';

class FakeClock { currentTime = 0; }

const lanes: LaneSpec[] = [{ index: 0, movement: 'seated_march', side: 'left' }];
const cal: RomCalibration = {
  min: extractFeature('seated_march', seatedPose({ kneeLift: 0 }), 'left')!,
  max: extractFeature('seated_march', seatedPose({ kneeLift: 1 }), 'left')!,
  samples: 1,
  movement: 'seated_march',
};

interface FakeDetector extends LandmarkDetector { closed: boolean; }
function makeDetector(): FakeDetector {
  return {
    mode: 'leg',
    delegate: 'CPU',
    closed: false,
    detect: (_f, ts): DetectionResult => ({ tMs: ts, pose: null, hands: [] }),
    close() { this.closed = true; },
  };
}

interface FakeCamera extends CameraSession { stopped: number; }
function makeCamera(): FakeCamera {
  const video = {
    requestVideoFrameCallback: () => 1,
    cancelVideoFrameCallback: () => {},
    videoWidth: 0,
    videoHeight: 0,
  } as unknown as HTMLVideoElement;
  return {
    video,
    stream: {} as MediaStream,
    width: 640,
    height: 480,
    ended: false,
    onEnded: null,
    stopped: 0,
    stop() { this.stopped++; },
  };
}

/** A factory whose promise the test resolves by hand, plus a count of how many it created. */
function deferredFactory<T>(make: () => T) {
  const pending: Array<(v: T) => void> = [];
  const made: T[] = [];
  const factory = () => new Promise<T>((resolve) => {
    pending.push((v) => {
      made.push(v);
      resolve(v);
    });
  });
  return {
    factory,
    made,
    calls: () => pending.length,
    /** Resolve the i-th pending acquisition with a fresh instance. */
    settle(i = 0) {
      const v = make();
      pending[i](v);
      return v;
    },
    settleAll() {
      for (let i = 0; i < pending.length; i++) this.settle(i);
    },
  };
}

function makeInput(over: Partial<ConstructorParameters<typeof VisionInput>[0]> = {}) {
  return new VisionInput({
    mode: 'leg', lanes, calibrations: [cal], thresholdFraction: 0.65,
    audioContext: new FakeClock(), smoothing: { kind: 'none' },
    ...over,
  } as ConstructorParameters<typeof VisionInput>[0]);
}

describe('VisionInput start/stop is race-safe (React StrictMode, mid-open cancel)', () => {
  it('stop() during a pending start leaves nothing running and RELEASES what the start created', async () => {
    const det = deferredFactory(makeDetector);
    const cam = deferredFactory(makeCamera);
    const input = makeInput({ detector: det.factory, camera: cam.factory });

    const started = input.start();
    expect(input.isStarting()).toBe(true);
    // The patient backs out while the permission prompt is up.
    input.stop();
    expect(input.isRunning()).toBe(false);
    // ... and only now does the detector arrive.
    const detector = det.settle();
    await started;

    expect(input.isRunning()).toBe(false);
    expect(input.getStatus().reason).toBe('stopped');
    expect(detector.closed).toBe(true); // the superseded start closed its own detector
    expect(cam.calls()).toBe(0); // and never went on to open the camera
    expect(input.getVideoElement()).toBeNull();
    expect(input.getStats().running).toBe(false);
  });

  it('stop() while the CAMERA is opening still turns the camera off', async () => {
    const cam = deferredFactory(makeCamera);
    const detector = makeDetector();
    const input = makeInput({ detector: () => Promise.resolve(detector), camera: cam.factory });

    const started = input.start();
    await Promise.resolve(); // let the detector await settle so we are inside the camera open
    expect(cam.calls()).toBe(1);
    input.stop();
    const camera = cam.settle();
    await started;

    expect(input.isRunning()).toBe(false);
    expect(camera.stopped).toBe(1); // the camera the abandoned start opened was released
    expect(camera.onEnded).toBeNull();
    expect(input.getVideoElement()).toBeNull();
    // An injected-instance detector is not owned, but a factory-created one is: closed by the abandon.
    expect(detector.closed).toBe(true);
  });

  it('two concurrent start()s create exactly ONE detector and ONE camera', async () => {
    const det = deferredFactory(makeDetector);
    const cam = deferredFactory(makeCamera);
    const input = makeInput({ detector: det.factory, camera: cam.factory });

    const a = input.start();
    const b = input.start();
    expect(det.calls()).toBe(1); // the second call joined the in-flight start instead of racing it
    det.settle();
    await Promise.resolve();
    await Promise.resolve();
    expect(cam.calls()).toBe(1);
    cam.settle();
    await Promise.all([a, b]);

    expect(det.made).toHaveLength(1);
    expect(cam.made).toHaveLength(1);
    expect(input.isRunning()).toBe(true);
    expect(det.made[0].closed).toBe(false);
    expect(cam.made[0].stopped).toBe(0);
    input.stop();
    expect(det.made[0].closed).toBe(true);
    expect(cam.made[0].stopped).toBe(1);
  });

  it('StrictMode mount -> unmount -> mount ends with one live camera and the first pair released', async () => {
    const det = deferredFactory(makeDetector);
    const cam = deferredFactory(makeCamera);
    const input = makeInput({ detector: det.factory, camera: cam.factory });

    const first = input.start(); // mount
    input.stop(); // unmount
    const second = input.start(); // mount again
    expect(det.calls()).toBe(2); // a genuinely new acquisition, not the invalidated one

    det.settle(0); // the abandoned generation's detector arrives late
    det.settle(1);
    await Promise.resolve();
    await Promise.resolve();
    await first;
    // Only the second generation reaches the camera step.
    expect(cam.calls()).toBe(1);
    cam.settle(0);
    await second;

    expect(input.isRunning()).toBe(true);
    expect(det.made[0].closed).toBe(true); // first generation released...
    expect(det.made[1].closed).toBe(false); // ... second generation live
    expect(cam.made[0].stopped).toBe(0);
    expect(input.getVideoElement()).toBe(cam.made[0].video);

    input.stop();
    expect(det.made[1].closed).toBe(true);
    expect(cam.made[0].stopped).toBe(1);
  });

  it('a rejected camera (permission denied) closes the detector and leaves nothing open', async () => {
    const detector = makeDetector();
    const denied = new Error('NotAllowedError: Permission denied');
    const input = makeInput({ detector: () => Promise.resolve(detector), camera: () => Promise.reject(denied) });

    await expect(input.start()).rejects.toThrow(/Permission denied/);
    expect(input.isRunning()).toBe(false);
    expect(input.isStarting()).toBe(false);
    expect(detector.closed).toBe(true);
    expect(input.getStatus().reason).toBe('error');
    expect(input.getLastError()).toBe(denied);
    // ... and a retry after the patient grants permission works normally.
    const detector2 = makeDetector();
    const camera = makeCamera();
    const retry = makeInput({ detector: () => Promise.resolve(detector2), camera: () => Promise.resolve(camera) });
    await retry.start();
    expect(retry.isRunning()).toBe(true);
    retry.stop();
    expect(camera.stopped).toBe(1);
  });

  it('start() on an already-running input is a no-op (no second camera)', async () => {
    const cam = deferredFactory(makeCamera);
    const input = makeInput({ detector: () => Promise.resolve(makeDetector()), camera: cam.factory });
    const p = input.start();
    await Promise.resolve();
    cam.settle();
    await p;
    await input.start();
    expect(cam.calls()).toBe(1);
    input.stop();
  });

  it('an abandoned start never processes a frame into the stopped instance', async () => {
    const det = deferredFactory(makeDetector);
    const input = makeInput({ detector: det.factory, driveLoop: false });
    const started = input.start();
    input.stop();
    det.settle();
    await started;
    expect(input.isRunning()).toBe(false);
    expect(input.getStatus().reason).toBe('stopped');
    expect(input.getLaneStates()[0]).toMatchObject({ value: 0 });
  });
});

describe('VisionInput refuses a calibration that would manufacture hits', () => {
  const tiny: RomCalibration = { min: 0.2, max: 0.201, samples: 10, movement: 'seated_march' };

  it('a range far below the movement minimum scores NOTHING and says so', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const clock = new FakeClock();
      const input = new VisionInput({
        mode: 'leg', lanes, calibrations: [tiny], thresholdFraction: 0.65, audioContext: clock,
        detector: () => Promise.resolve(makeDetector()), driveLoop: false, smoothing: { kind: 'none' },
      });
      const events: unknown[] = [];
      input.onEvent((e) => events.push(e));
      await input.start();
      // A 1%-of-ROM tremor: with the tiny range this crossed the threshold several times a second.
      for (let i = 0; i < 60; i++) {
        input.processDetection({ tMs: 0, pose: seatedPose({ kneeLift: (i % 2) * 0.01 }), hands: [] }, i / 30);
      }
      expect(events).toHaveLength(0);
      expect(input.getLaneStates()[0].value).toBe(0);
      const st = input.getStatus();
      expect(st.reason).toBe('uncalibrated');
      expect(st.tracking).toBe(false);
      expect(st.invalidCalibrationLanes).toEqual([0]);
      expect(st.message).toMatch(/calibration/i);
      expect(st.warnings?.join(' ')).toMatch(/12%/);
      expect(input.getInvalidCalibrations()[0].reason).toMatch(/below the 12% minimum/);
      expect(err).toHaveBeenCalled();
      input.stop();
    } finally {
      err.mockRestore();
    }
  });

  it('setCalibration refuses a bad range (returns false) and accepts a good one', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const input = makeInput({ detector: () => Promise.resolve(makeDetector()), driveLoop: false });
      await input.start();
      expect(input.getStatus().invalidCalibrationLanes).toEqual([]);
      expect(input.setCalibration(0, tiny)).toBe(false);
      expect(input.getStatus().invalidCalibrationLanes).toEqual([0]);
      expect(input.getLaneDebug()[0].calibration).toBeNull();
      expect(input.setCalibration(0, cal)).toBe(true);
      expect(input.getStatus().invalidCalibrationLanes).toEqual([]);
      input.stop();
    } finally {
      err.mockRestore();
    }
  });
});

describe('VisionInput pinned-lane watchdog (the other silent death)', () => {
  it('a lane stuck above the re-arm level is reported instead of missing every note in silence', async () => {
    const input = makeInput({ detector: () => Promise.resolve(makeDetector()), driveLoop: false, pinnedLaneSec: 3 });
    await input.start();
    // The patient's baseline drifted: the knee never comes back below the re-arm level.
    for (let i = 0; i <= 30 * 5; i++) {
      input.processDetection({ tMs: 0, pose: seatedPose({ kneeLift: 0.9 }), hands: [] }, i / 30);
    }
    const st = input.getStatus();
    expect(st.reason).toBe('lane_pinned');
    expect(st.pinnedLanes).toEqual([0]);
    expect(st.tracking).toBe(false);
    expect(st.message).toMatch(/stuck above/i);
    expect(input.getLaneActivity()[0].aboveRearmSec).toBeGreaterThan(4);
    // Coming back to rest clears it.
    input.processDetection({ tMs: 0, pose: seatedPose({ kneeLift: 0 }), hands: [] }, 6);
    expect(input.getStatus().reason).toBe('ok');
    expect(input.getPinnedLanes()).toEqual([]);
    input.stop();
  });

  it('normal reps never trip it, and a stream break restarts the clock rather than accusing the lane', async () => {
    const input = makeInput({ detector: () => Promise.resolve(makeDetector()), driveLoop: false, pinnedLaneSec: 3 });
    await input.start();
    let t = 0;
    for (let rep = 0; rep < 4; rep++) {
      for (const a of [0, 0.5, 1, 1, 0.5, 0]) {
        input.processDetection({ tMs: 0, pose: seatedPose({ kneeLift: a }), hands: [] }, t);
        t += 1 / 5; // a slow 1.2 s rep
      }
    }
    expect(input.getPinnedLanes()).toEqual([]);
    // A wedged camera for 30 s with the limb up on both sides of the gap is not 30 s of "pinned".
    input.processDetection({ tMs: 0, pose: seatedPose({ kneeLift: 0.9 }), hands: [] }, t);
    input.processDetection({ tMs: 0, pose: seatedPose({ kneeLift: 0.9 }), hands: [] }, t + 30);
    expect(input.getPinnedLanes()).toEqual([]);
    input.stop();
  });
});

describe('VisionInput takes the frame aspect from the live camera', () => {
  it('a 16:9 webcam measures the same movement as a 4:3 one', async () => {
    const make = async (w: number, h: number) => {
      const camera = makeCamera();
      camera.width = w;
      camera.height = h;
      const input = makeInput({ detector: () => Promise.resolve(makeDetector()), camera: () => Promise.resolve(camera) });
      await input.start();
      return input;
    };
    const wide = await make(1280, 720);
    const classic = await make(640, 480);
    expect(wide.getXScale()).toBeCloseTo(16 / 9, 10);
    expect(classic.getXScale()).toBeCloseTo(4 / 3, 10);

    // The SAME physical pose, as each camera would normalize it.
    const seen = (aspect: number, amount: number) => reNormalizeAspect(seatedPose({ kneeLift: amount }), 1, aspect);
    for (const amount of [0.2, 0.6, 1]) {
      wide.processDetection({ tMs: 0, pose: seen(16 / 9, amount), hands: [] }, amount);
      classic.processDetection({ tMs: 0, pose: seen(4 / 3, amount), hands: [] }, amount);
      expect(wide.getLaneDebug()[0].raw!, `amount ${amount}`).toBeCloseTo(classic.getLaneDebug()[0].raw!, 8);
    }
    wide.stop();
    classic.stop();
  });

  it('an explicit config xScale wins over the camera (fixtures / pre-normalized streams)', async () => {
    const camera = makeCamera();
    const input = makeInput({ detector: () => Promise.resolve(makeDetector()), camera: () => Promise.resolve(camera), xScale: 1 });
    await input.start();
    expect(input.getXScale()).toBe(1);
    input.stop();
  });
});

describe('VisionInput distinguishes a backend swap from a missing patient', () => {
  it('reports "recovering", not "no person detected", while the detector rebuilds on CPU', async () => {
    let recovering = true;
    const detector: LandmarkDetector = {
      mode: 'leg',
      delegate: 'GPU',
      get recovering() { return recovering; },
      detect: (_f, ts): DetectionResult => ({ tMs: ts, pose: null, hands: [] }),
      close: () => {},
    };
    const input = makeInput({ detector: () => Promise.resolve(detector), driveLoop: false });
    await input.start();
    input.processDetection({ tMs: 0, pose: null, hands: [] }, 0);
    const st = input.getStatus();
    expect(st.reason).toBe('recovering');
    expect(st.message).toMatch(/engine/i);
    expect(st.message).not.toMatch(/no person/i);
    recovering = false;
    expect(input.getStatus().reason).toBe('no_person');
    input.stop();
  });
});

describe('VisionInput getLaneStates aliasing', () => {
  it('returns frozen, memoized objects so a consumer cannot silently corrupt the meters', async () => {
    const input = makeInput({ detector: () => Promise.resolve(makeDetector()), driveLoop: false });
    await input.start();
    input.processDetection({ tMs: 0, pose: seatedPose({ kneeLift: 0.5 }), hands: [] }, 0);
    const a = input.getLaneStates();
    expect(input.getLaneStates()).toBe(a); // memoized per processed frame
    expect(Object.isFrozen(a[0])).toBe(true);
    expect(() => {
      (a[0] as { value: number }).value = 99;
    }).toThrow();
    expect(input.getLaneStates()[0].value).toBeCloseTo(0.5, 1);
    input.stop();
  });
});
