/**
 * A BUG IN OUR OWN FRAME HANDLER MUST NOT BE REPORTED AS A BROKEN CAMERA.
 *
 * Every consumer of the frame stream is app code: the calibration screen's sampler, the in-song
 * range learner, a harness probe. They all run inside `processDetection`, and until this was fixed a
 * single throw from any of them escaped into DetectLoop's catch, which reports through `onError`,
 * which sets `reason = 'error'`. The patient was then shown "Camera or detector error." a few
 * seconds into the song — a working camera blamed for our bug — and because `buildStatus`
 * short-circuits on 'error', every other diagnostic went quiet at the same time.
 *
 * So: the throw is contained, the camera keeps its honest state, and the fault is NAMED, because a
 * listener that has stopped running has stopped doing its job and nobody can see that from the video.
 */
import { describe, expect, it, vi } from 'vitest';
import type { LaneSpec } from '../engine/types.ts';
import { VisionInput } from './VisionInput.ts';
import type { DetectionResult, LandmarkDetector } from '../vision/mediapipe.ts';
import { extractFeature } from '../vision/features.ts';
import { seatedPose } from '../vision/fixtures.ts';
import type { RomCalibration } from '../vision/calibration.ts';

class FakeClock { currentTime = 0; }

const lanes: LaneSpec[] = [{ index: 0, movement: 'seated_march', side: 'left' }];
const cal: RomCalibration = {
  min: extractFeature('seated_march', seatedPose({ kneeLift: 0 }), 'left')!,
  max: extractFeature('seated_march', seatedPose({ kneeLift: 1 }), 'left')!,
  samples: 1,
  movement: 'seated_march',
};
const detector: LandmarkDetector = {
  mode: 'leg', delegate: 'CPU',
  detect: (_f, ts): DetectionResult => ({ tMs: ts, pose: null, hands: [] }),
  close() {},
};
const make = () => new VisionInput({
  mode: 'leg', lanes, calibrations: [cal], thresholdFraction: 0.65,
  audioContext: new FakeClock(), detector, driveLoop: false, smoothing: { kind: 'none' },
});
const frame = (lift: number): DetectionResult => ({ tMs: 0, pose: seatedPose({ kneeLift: lift }), hands: [] });

describe('a throwing frame listener is isolated, not blamed on the camera', () => {
  it('does not let the throw escape processDetection', async () => {
    const input = make();
    await input.start();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    input.onFrame(() => { throw new Error('the in-song learner blew up'); });
    expect(() => input.processDetection(frame(0.2), 0)).not.toThrow();
    spy.mockRestore();
    input.stop();
  });

  it('keeps the camera’s own state honest instead of reporting "Camera or detector error."', async () => {
    const input = make();
    await input.start();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    input.onFrame(() => { throw new Error('boom'); });
    input.processDetection(frame(0.2), 0);
    const st = input.getStatus();
    spy.mockRestore();
    expect(st.reason).not.toBe('error');
    expect(st.message).not.toMatch(/camera or detector error/i);
    input.stop();
  });

  it('NAMES the fault rather than going quiet about a handler that stopped running', async () => {
    const input = make();
    await input.start();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    input.onFrame(() => { throw new Error('cannot read peaks of null'); });
    input.processDetection(frame(0.2), 0);
    const st = input.getStatus();
    spy.mockRestore();
    expect(st.warnings?.some((w) => /cannot read peaks of null/.test(w))).toBe(true);
    expect(st.warnings?.some((w) => /camera itself is fine/i.test(w))).toBe(true);
    expect(input.getListenerFaults()).toEqual([
      { where: 'frame', message: 'cannot read peaks of null', count: 1 },
    ]);
    input.stop();
  });

  it('says it ONCE however many frames it throws on, and keeps counting', async () => {
    const input = make();
    await input.start();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    input.onFrame(() => { throw new Error('every frame'); });
    for (let i = 0; i < 30; i++) input.processDetection(frame(0.2 + i * 0.01), i / 30);
    // One log line, not thirty: these fire from the frame loop and the first has the useful stack.
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    expect(input.getListenerFaults()[0].count).toBe(30);
    input.stop();
  });

  it('a healthy listener beside a throwing one still gets every frame', async () => {
    const input = make();
    await input.start();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const seen: number[] = [];
    input.onFrame(() => { throw new Error('first listener is broken'); });
    input.onFrame((samples) => { seen.push(samples.length); });
    for (let i = 0; i < 5; i++) input.processDetection(frame(0.2), i / 30);
    spy.mockRestore();
    expect(seen).toHaveLength(5);
    input.stop();
  });
});
