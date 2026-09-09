import { describe, expect, it, vi } from 'vitest';
import { DetectLoop, labelToPatientSide, pickHand } from './mediapipe.ts';
import type { DetectionResult, HandDetection, LandmarkDetector } from './mediapipe.ts';
import { handPose } from './fixtures.ts';

const hand = (label: string, score: number, x: number): HandDetection => ({ landmarks: handPose({ centerX: x }), label, score });

describe('handedness convention', () => {
  it('raw (unmirrored) stream inverts MediaPipe labels; mirrored keeps them', () => {
    expect(labelToPatientSide('Left', false)).toBe('right');
    expect(labelToPatientSide('Right', false)).toBe('left');
    expect(labelToPatientSide('Left', true)).toBe('left');
    expect(labelToPatientSide('nope', false)).toBeNull();
  });

  it('pickHand uses labels when confident', () => {
    const hands = [hand('Left', 0.95, 0.3), hand('Right', 0.95, 0.7)];
    expect(pickHand(hands, 'right', false)).toBe(hands[0]);
    expect(pickHand(hands, 'left', false)).toBe(hands[1]);
    expect(pickHand(hands, 'left', true)).toBe(hands[0]);
  });

  it('pickHand falls back to position when labels are unreliable', () => {
    const hands = [hand('Left', 0.5, 0.7), hand('Left', 0.5, 0.3)];
    expect(pickHand(hands, 'right', false)).toBe(hands[1]); // small x = patient's right in raw stream
    expect(pickHand(hands, 'left', false)).toBe(hands[0]);
    expect(pickHand(hands, 'right', true)).toBe(hands[0]);
  });

  it('pickHand with a single hand', () => {
    const only = [hand('Left', 0.9, 0.5)];
    expect(pickHand(only, 'right', false)).toBe(only[0]);
    expect(pickHand(only, 'left', false)).toBeNull();
    expect(pickHand([hand('', 0, 0.5)], 'left', false)).not.toBeNull();
    expect(pickHand([], 'left')).toBeNull();
  });
});

describe('DetectLoop', () => {
  it('drives the detector with requestVideoFrameCallback and reports stats', () => {
    const callbacks: Array<(now: number, meta: { captureTime?: number }) => void> = [];
    const video = {
      requestVideoFrameCallback: vi.fn((cb: (now: number, meta: { captureTime?: number }) => void) => {
        callbacks.push(cb);
        return callbacks.length;
      }),
      cancelVideoFrameCallback: vi.fn(),
      currentTime: 0,
      readyState: 4,
    } as unknown as HTMLVideoElement;
    const detector: LandmarkDetector = {
      mode: 'leg',
      delegate: 'CPU',
      detect: vi.fn((_f, ts): DetectionResult => ({ tMs: ts, pose: null, hands: [] })),
      close: vi.fn(),
    };
    const results: Array<[DetectionResult, number]> = [];
    const loop = new DetectLoop(video, detector, (r, ft) => results.push([r, ft]));
    loop.start();
    expect(callbacks).toHaveLength(1);
    callbacks[0](100, { captureTime: 90 });
    callbacks[1](133, {});
    expect(results).toHaveLength(2);
    expect(results[0][1]).toBe(90);
    expect(results[1][1]).toBe(133);
    expect(results[1][0].tMs).toBe(133);
    const stats = loop.getStats();
    expect(stats.frames).toBe(2);
    expect(stats.running).toBe(true);
    expect(stats.inferenceMs).toBeGreaterThanOrEqual(0);
    loop.stop();
    expect(video.cancelVideoFrameCallback).toHaveBeenCalled();
    expect(loop.getStats().running).toBe(false);
  });

  it('reports detector errors without throwing', () => {
    const cbs: Array<(now: number, meta: object) => void> = [];
    const video = { requestVideoFrameCallback: (cb: (now: number, meta: object) => void) => cbs.push(cb), cancelVideoFrameCallback: () => {} } as unknown as HTMLVideoElement;
    const detector: LandmarkDetector = { mode: 'hand', delegate: 'GPU', detect: () => { throw new Error('boom'); }, close: () => {} };
    const loop = new DetectLoop(video, detector, () => {});
    const errs: unknown[] = [];
    loop.onError = (e) => errs.push(e);
    loop.start();
    cbs[0](10, {});
    expect(errs).toHaveLength(1);
    loop.stop();
  });
});
