import { describe, expect, it, vi } from 'vitest';
import { DetectLoop, labelToPatientSide, openCamera, pickHand, waitForVideoReady } from './mediapipe.ts';
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

  it('pickHand assigns two hands carrying the SAME label to different lanes by position', () => {
    for (const label of ['Left', 'Right']) {
      const hands = [hand(label, 0.9, 0.7), hand(label, 0.9, 0.3)];
      const right = pickHand(hands, 'right', false);
      const left = pickHand(hands, 'left', false);
      expect(right).toBe(hands[1]); // raw stream: patient's right = small x
      expect(left).toBe(hands[0]);
      expect(right).not.toBe(left);
      expect(pickHand(hands, 'right', true)).toBe(hands[0]);
    }
  });

  it('pickHand never gives one hand to both lanes when only one label is confident', () => {
    const hands = [hand('Left', 0.9, 0.3), hand('', 0, 0.7)]; // "Left" = patient's right (raw)
    expect(pickHand(hands, 'right', false)).toBe(hands[0]);
    expect(pickHand(hands, 'left', false)).toBe(hands[1]);
    const swapped = [hand('', 0, 0.3), hand('Left', 0.9, 0.7)];
    expect(pickHand(swapped, 'right', false)).toBe(swapped[1]);
    expect(pickHand(swapped, 'left', false)).toBe(swapped[0]);
    // Two hands both confidently labelled the OTHER side: labels are unreliable => position again.
    const bothOther = [hand('Right', 0.9, 0.3), hand('Right', 0.9, 0.7)]; // "Right" = patient's left (raw)
    expect(pickHand(bothOther, 'right', false)).toBe(bothOther[0]);
    expect(pickHand(bothOther, 'left', false)).toBe(bothOther[1]);
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

  it('falls back to requestAnimationFrame and only runs inference on new video frames', () => {
    const rafCbs: FrameRequestCallback[] = [];
    const origRaf = globalThis.requestAnimationFrame;
    const origCaf = globalThis.cancelAnimationFrame;
    const cancelled: number[] = [];
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => rafCbs.push(cb);
    globalThis.cancelAnimationFrame = (h: number) => { cancelled.push(h); };
    try {
      const video = { currentTime: 0, readyState: 4 } as unknown as HTMLVideoElement; // no requestVideoFrameCallback
      const detect = vi.fn((_f: unknown, ts: number): DetectionResult => ({ tMs: ts, pose: null, hands: [] }));
      const detector: LandmarkDetector = { mode: 'leg', delegate: 'CPU', detect, close: () => {} };
      const results: number[] = [];
      const loop = new DetectLoop(video, detector, (_r, ft) => results.push(ft));
      loop.start();
      expect(rafCbs).toHaveLength(1);
      rafCbs[0](100); // currentTime 0 is a new media time => inference
      expect(rafCbs).toHaveLength(2);
      rafCbs[1](116); // same media time => skipped, but re-scheduled
      expect(rafCbs).toHaveLength(3);
      (video as { currentTime: number }).currentTime = 0.033;
      rafCbs[2](133);
      expect(results).toEqual([100, 133]);
      expect(detect).toHaveBeenCalledTimes(2);
      expect(detect.mock.calls[1][1]).toBe(133);
      expect(loop.getStats().frames).toBe(2);
      loop.stop();
      expect(cancelled).toHaveLength(1);
      expect(loop.getStats().running).toBe(false);
      rafCbs[3]?.(150); // a late callback after stop does nothing
      expect(detect).toHaveBeenCalledTimes(2);
    } finally {
      globalThis.requestAnimationFrame = origRaf;
      globalThis.cancelAnimationFrame = origCaf;
    }
  });

  it('keeps running when a result listener throws (error reported, next frame still scheduled)', () => {
    const cbs: Array<(now: number, meta: object) => void> = [];
    const video = { requestVideoFrameCallback: (cb: (now: number, meta: object) => void) => cbs.push(cb), cancelVideoFrameCallback: () => {} } as unknown as HTMLVideoElement;
    const detector: LandmarkDetector = { mode: 'leg', delegate: 'CPU', detect: (_f, ts) => ({ tMs: ts, pose: null, hands: [] }), close: () => {} };
    let calls = 0;
    const loop = new DetectLoop(video, detector, () => {
      calls++;
      if (calls === 1) throw new Error('listener bug');
    });
    const errs: unknown[] = [];
    loop.onError = (e) => errs.push(e);
    loop.start();
    expect(() => cbs[0](10, {})).not.toThrow();
    expect(errs).toHaveLength(1);
    expect(cbs).toHaveLength(2); // re-scheduled despite the throw
    cbs[1](43, {});
    expect(calls).toBe(2);
    expect(loop.getStats().frames).toBe(2);
    loop.stop();
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

describe('openCamera', () => {
  interface FakeVideo { readyState: number; onloadedmetadata: (() => void) | null; onerror: (() => void) | null; srcObject: unknown; videoWidth: number; videoHeight: number; play: () => Promise<void>; muted?: boolean; playsInline?: boolean; autoplay?: boolean; }
  const fakeVideo = (): FakeVideo => ({ readyState: 0, onloadedmetadata: null, onerror: null, srcObject: null, videoWidth: 0, videoHeight: 0, play: () => Promise.resolve() });

  function withMediaDevices(getUserMedia: (c: MediaStreamConstraints) => Promise<MediaStream>, run: () => Promise<void>) {
    const original = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true });
    return run().finally(() => {
      if (original) Object.defineProperty(navigator, 'mediaDevices', original);
      else delete (navigator as unknown as { mediaDevices?: unknown }).mediaDevices;
    });
  }

  it('times out on a wedged camera and stops the acquired tracks (no LED left on)', async () => {
    const track = { stop: vi.fn() };
    const stream = { getTracks: () => [track] } as unknown as MediaStream;
    const video = fakeVideo();
    await withMediaDevices(() => Promise.resolve(stream), async () => {
      await expect(openCamera({ video: video as unknown as HTMLVideoElement, timeoutMs: 30 })).rejects.toThrow(/not ready after 30 ms/);
    });
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(video.srcObject).toBeNull();
    expect(video.onloadedmetadata).toBeNull();
  });

  it('resolves once metadata is loaded, requests a 640x480 front camera, and stop() releases the tracks', async () => {
    const track = { stop: vi.fn() };
    const stream = { getTracks: () => [track] } as unknown as MediaStream;
    const video = fakeVideo();
    let constraints: MediaStreamConstraints | null = null;
    await withMediaDevices((c) => {
      constraints = c;
      setTimeout(() => {
        video.videoWidth = 640;
        video.videoHeight = 480;
        video.onloadedmetadata?.();
      }, 5);
      return Promise.resolve(stream);
    }, async () => {
      const session = await openCamera({ video: video as unknown as HTMLVideoElement, timeoutMs: 1000 });
      expect(session.width).toBe(640);
      expect(session.height).toBe(480);
      expect(video.srcObject).toBe(stream);
      expect(video.muted).toBe(true);
      expect(video.playsInline).toBe(true);
      session.stop();
    });
    const v = constraints!.video as MediaTrackConstraints;
    expect(v.width).toEqual({ ideal: 640 });
    expect(v.height).toEqual({ ideal: 480 });
    expect(v.facingMode).toBe('user');
    expect(track.stop).toHaveBeenCalledTimes(1);
  });

  it('waitForVideoReady resolves immediately when the video already has metadata, rejects on error', async () => {
    const ready = fakeVideo();
    ready.readyState = 2;
    await expect(waitForVideoReady(ready as unknown as HTMLVideoElement, 10)).resolves.toBeUndefined();
    const failing = fakeVideo();
    const p = waitForVideoReady(failing as unknown as HTMLVideoElement, 1000);
    failing.onerror?.();
    await expect(p).rejects.toThrow(/failed to load/);
  });
});
