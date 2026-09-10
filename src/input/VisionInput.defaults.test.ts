/**
 * The DEFAULT detector and camera must be reachable-with-options, not all-or-nothing.
 *
 * A clinic laptop with two webcams, an app served from a sub-path, or a dark treatment room all need to
 * change ONE value (deviceId, wasmPath, minDetectionConfidence). Before this, the only way in was to
 * replace the whole detector/camera factory — which means re-implementing the GPU-to-CPU delegate
 * fallback, the model paths and the camera readiness timeout in application code, where they will drift.
 */
import { describe, expect, it, vi } from 'vitest';
import type { LaneSpec } from '../engine/types.ts';
import type { CameraOptions, CameraSession, DetectionResult, DetectorOptions, LandmarkDetector } from '../vision/mediapipe.ts';
import { extractFeature } from '../vision/features.ts';
import { seatedPose } from '../vision/fixtures.ts';
import type { RomCalibration } from '../vision/calibration.ts';

const detectorCalls: DetectorOptions[] = [];
const cameraCalls: CameraOptions[] = [];

vi.mock('../vision/mediapipe.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../vision/mediapipe.ts')>();
  return {
    ...actual,
    createDetector: async (opts: DetectorOptions): Promise<LandmarkDetector> => {
      detectorCalls.push(opts);
      return { mode: opts.mode, delegate: 'CPU', detect: (_f, ts): DetectionResult => ({ tMs: ts, pose: null, hands: [] }), close() {} };
    },
    openCamera: async (opts: CameraOptions = {}): Promise<CameraSession> => {
      cameraCalls.push(opts);
      const video = {
        requestVideoFrameCallback: () => 1,
        cancelVideoFrameCallback: () => {},
        videoWidth: 0,
        videoHeight: 0,
      } as unknown as HTMLVideoElement;
      return { video, stream: {} as MediaStream, width: 640, height: 480, ended: false, onEnded: null, stop() {} };
    },
  };
});

const { VisionInput } = await import('./VisionInput.ts');

class FakeClock { currentTime = 0; }
const lanes: LaneSpec[] = [{ index: 0, movement: 'seated_march', side: 'left' }];
const cal: RomCalibration = {
  min: extractFeature('seated_march', seatedPose({ kneeLift: 0 }), 'left')!,
  max: extractFeature('seated_march', seatedPose({ kneeLift: 1 }), 'left')!,
  samples: 1,
  movement: 'seated_march',
};

describe('default detector / camera options reach the defaults', () => {
  it('passes detectorOptions and cameraOptions through, and keeps mode authoritative', async () => {
    detectorCalls.length = 0;
    cameraCalls.length = 0;
    const input = new VisionInput({
      mode: 'leg', lanes, calibrations: [cal], thresholdFraction: 0.65, audioContext: new FakeClock(),
      detectorOptions: { wasmPath: '/rehab/wasm', poseModelPath: '/rehab/models/pose.task', minDetectionConfidence: 0.3, minTrackingConfidence: 0.3 },
      cameraOptions: { deviceId: 'clinic-cam-2', width: 1280, height: 720 },
    });
    await input.start();
    expect(detectorCalls).toHaveLength(1);
    expect(detectorCalls[0]).toMatchObject({
      mode: 'leg', wasmPath: '/rehab/wasm', poseModelPath: '/rehab/models/pose.task',
      minDetectionConfidence: 0.3, minTrackingConfidence: 0.3, numHands: 2,
    });
    expect(cameraCalls[0]).toEqual({ width: 1280, height: 720, facingMode: 'user', deviceId: 'clinic-cam-2' });
    input.stop();
  });

  it('keeps the documented defaults when nothing is passed', async () => {
    detectorCalls.length = 0;
    cameraCalls.length = 0;
    const input = new VisionInput({
      mode: 'hand', lanes: [{ index: 0, movement: 'hand_open_close', side: 'right' }],
      calibrations: [null], thresholdFraction: 0.65, audioContext: new FakeClock(),
    });
    await input.start();
    expect(detectorCalls[0]).toEqual({ mode: 'hand', numHands: 2 });
    expect(cameraCalls[0]).toEqual({ width: 640, height: 480, facingMode: 'user' });
    input.stop();
  });

  it('an INJECTED detector/camera still wins over the options (they describe the default only)', async () => {
    detectorCalls.length = 0;
    cameraCalls.length = 0;
    const input = new VisionInput({
      mode: 'leg', lanes, calibrations: [cal], thresholdFraction: 0.65, audioContext: new FakeClock(),
      detector: { mode: 'leg', delegate: 'GPU', detect: (_f, ts) => ({ tMs: ts, pose: null, hands: [] }), close() {} },
      driveLoop: false,
      detectorOptions: { wasmPath: '/ignored' },
    });
    await input.start();
    expect(detectorCalls).toHaveLength(0);
    expect(cameraCalls).toHaveLength(0);
    input.stop();
  });
});
