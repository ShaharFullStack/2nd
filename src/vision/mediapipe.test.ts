import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DetectLoop, createDetector, labelToPatientSide, openCamera, pickHand, pickHandResult, resetMediaPipeCache, waitForVideoReady } from './mediapipe.ts';
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

  it('acceptLoneHand rescues a UNILATERAL session whose lone hand has a weak label', () => {
    // Handedness confidence is exactly what degrades in the fingers-at-the-camera wrist_extension
    // posture; in a one-sided prescription there is no other lane to protect, so the lone hand is used.
    const weak = [hand('Right', 0.4, 0.5)];
    expect(pickHand(weak, 'left', false)).toBeNull(); // default (bilateral-safe) behaviour is unchanged
    expect(pickHand(weak, 'left', false, { acceptLoneHand: true })).toBe(weak[0]);
    expect(pickHand(weak, 'right', false, { acceptLoneHand: true })).toBe(weak[0]);
    expect(pickHand([hand('', 0, 0.5)], 'right', false, { acceptLoneHand: true })).not.toBeNull();
    // A CONFIDENT label for the other side is still believed: that is the unaffected hand.
    const confident = [hand('Right', 0.95, 0.5)]; // "Right" = patient's LEFT in a raw stream
    expect(pickHand(confident, 'left', false, { acceptLoneHand: true })).toBe(confident[0]);
    expect(pickHand(confident, 'right', false, { acceptLoneHand: true })).toBeNull();
    // With two hands in frame the escape hatch does nothing: position is meaningful again.
    const pair = [hand('', 0, 0.3), hand('', 0, 0.7)];
    expect(pickHand(pair, 'right', false, { acceptLoneHand: true })).toBe(pair[0]);
    expect(pickHand(pair, 'left', false, { acceptLoneHand: true })).toBe(pair[1]);
    // minLabelScore is configurable: the same 0.4 label counts once the bar is lowered ("Right" on a raw
    // stream is the patient's LEFT hand), and stops counting when it is raised.
    expect(pickHand(weak, 'left', false, { minLabelScore: 0.3 })).toBe(weak[0]);
    expect(pickHand(weak, 'right', false, { minLabelScore: 0.3 })).toBeNull();
    expect(pickHand([hand('Right', 0.95, 0.5)], 'left', false, { minLabelScore: 0.99 })).toBeNull();
  });

  it('the lone-hand escape hatch still refuses a hand that weakly points at the OTHER side', () => {
    // The danger in a unilateral session is not lane-to-lane theft (there is no second lane) — it is the
    // UNAFFECTED hand drifting into frame and driving the affected limb's lane, inflating exactly the
    // rep count and ROM trend the therapist is treating from. A 0.59 label is below minLabelScore but is
    // not noise, so it is believed enough to REFUSE the wrong side.
    const leaning = [hand('Right', 0.59, 0.5)]; // "Right" on a raw stream = the patient's LEFT hand
    expect(pickHand(leaning, 'right', false, { acceptLoneHand: true })).toBeNull();
    expect(pickHand(leaning, 'left', false, { acceptLoneHand: true })).toBe(leaning[0]);
    // A genuine coin flip carries no information and is still accepted (that is what the hatch is for),
    // but the caller is told the hand is unidentified so it can warn the therapist.
    const coinFlip = [hand('Right', 0.52, 0.5)];
    expect(pickHandResult(coinFlip, 'right', false, { acceptLoneHand: true })).toEqual({ hand: coinFlip[0], source: 'lone_unlabelled' });
    expect(pickHandResult(coinFlip, 'left', false, { acceptLoneHand: true }).source).toBe('lone_unlabelled');
    // A confidently labelled lone hand is reported as identified, not as a fallback.
    expect(pickHandResult([hand('Right', 0.95, 0.5)], 'left', false, { acceptLoneHand: true }).source).toBe('label');
    expect(pickHandResult([hand('Right', 0.95, 0.5)], 'right', false, { acceptLoneHand: true })).toEqual({ hand: null, source: 'none' });
    // The coin-flip bar is tunable for a session whose lighting makes the classifier chronically unsure.
    expect(pickHand(leaning, 'right', false, { acceptLoneHand: true, ambiguousLabelScore: 0.7 })).toBe(leaning[0]);
  });

  it('pickHandResult names how two-handed frames were resolved', () => {
    const pair = [hand('', 0, 0.3), hand('', 0, 0.7)];
    expect(pickHandResult(pair, 'right', false).source).toBe('position');
    expect(pickHandResult([hand('Left', 0.95, 0.3), hand('Right', 0.95, 0.7)], 'right', false).source).toBe('label');
    expect(pickHandResult([], 'right', false).source).toBe('none');
  });

  it('pickHand with a single hand', () => {
    const only = [hand('Left', 0.9, 0.5)];
    expect(pickHand(only, 'right', false)).toBe(only[0]);
    expect(pickHand(only, 'left', false)).toBeNull();
    expect(pickHand([], 'left')).toBeNull();
  });

  it('a single hand with no usable label goes to NEITHER lane (never lets the good hand score)', () => {
    // One hand, handedness score below minLabelScore: position cannot disambiguate a lone hand, and in a
    // bilateral session giving it to both lanes would let the unaffected hand score the affected lane.
    const unlabelled = [hand('Right', 0.4, 0.5)];
    expect(pickHand(unlabelled, 'left', false)).toBeNull();
    expect(pickHand(unlabelled, 'right', false)).toBeNull();
    expect(pickHand([hand('', 0, 0.5)], 'left', false)).toBeNull();
    expect(pickHand([hand('', 0, 0.5)], 'right', false)).toBeNull();
    // A confident label on a lone hand still resolves that one side only.
    expect(pickHand([hand('Right', 0.9, 0.5)], 'left', false)).not.toBeNull();
    expect(pickHand([hand('Right', 0.9, 0.5)], 'right', false)).toBeNull();
    // With TWO hands position is meaningful again, so an unlabelled hand is still assignable.
    const pair = [hand('Left', 0.9, 0.3), hand('', 0, 0.7)];
    expect(pickHand(pair, 'left', false)).toBe(pair[1]);
  });
});

describe('DetectLoop', () => {
  it('stop() cancels the setTimeout fallback when there is no requestAnimationFrame', () => {
    // The environment that TAKES the fallback is exactly the one where cancelAnimationFrame does not
    // exist either, so the old stop() cancelled nothing and one timer kept firing per stopped loop.
    const g = globalThis as unknown as { requestAnimationFrame?: unknown; cancelAnimationFrame?: unknown };
    const raf = g.requestAnimationFrame;
    const caf = g.cancelAnimationFrame;
    delete g.requestAnimationFrame;
    delete g.cancelAnimationFrame;
    vi.useFakeTimers();
    try {
      const video = { currentTime: 0, readyState: 4 } as unknown as HTMLVideoElement;
      const detect = vi.fn((_f: unknown, ts: number): DetectionResult => ({ tMs: ts, pose: null, hands: [] }));
      const detector: LandmarkDetector = { mode: 'leg', delegate: 'CPU', detect, close: vi.fn() };
      const loop = new DetectLoop(video, detector, () => {});
      loop.start();
      expect(vi.getTimerCount()).toBe(1);
      loop.stop();
      expect(vi.getTimerCount()).toBe(0); // the timer is GONE, not merely inert
      vi.advanceTimersByTime(5000);
      expect(detect).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      if (raf) g.requestAnimationFrame = raf;
      if (caf) g.cancelAnimationFrame = caf;
    }
  });

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
    // The MediaPipe timestamp is the frame's CAPTURE time (90), not the callback's wall time (100).
    expect(results[0][0].tMs).toBe(90);
    expect(detector.detect).toHaveBeenCalledWith(video, 90);
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

/* ---------------- createDetector (mocked @mediapipe/tasks-vision) ---------------- */

/**
 * The runtime wrapper is the one part of the module that cannot be exercised without the real MediaPipe
 * bundle, so the bundle is mocked and the CONTRACT is pinned here: local asset paths (no CDN), VIDEO
 * running mode, numHands 2, strictly increasing timestamps, and both delegate fallbacks — at creation
 * (documented) and at the FIRST INFERENCE (the common clinic-laptop failure: a GPU landmarker that is
 * created successfully and then throws on the first detectForVideo).
 */
const mp = vi.hoisted(() => {
  interface FakeTask {
    kind: 'pose' | 'hand';
    delegate: 'GPU' | 'CPU';
    opts: Record<string, unknown>;
    closed: boolean;
    timestamps: number[];
    detectForVideo(frame: unknown, ts: number): unknown;
    close(): void;
  }
  const state = {
    wasmPaths: [] as string[],
    created: [] as Array<{ kind: 'pose' | 'hand'; delegate: 'GPU' | 'CPU'; opts: Record<string, unknown> }>,
    tasks: [] as FakeTask[],
    failGpuCreate: false,
    failGpuInference: false,
    failCpuCreate: false,
  };
  const make = (kind: 'pose' | 'hand', opts: Record<string, unknown>): FakeTask => {
    const base = opts.baseOptions as { delegate: 'GPU' | 'CPU' };
    const task: FakeTask = {
      kind,
      delegate: base.delegate,
      opts,
      closed: false,
      timestamps: [],
      detectForVideo(_frame: unknown, ts: number) {
        task.timestamps.push(ts);
        if (task.delegate === 'GPU' && state.failGpuInference) throw new Error('WebGL context lost');
        return kind === 'pose'
          ? { landmarks: [[{ x: 0.5, y: 0.5, z: 0, visibility: 0.9 }]], worldLandmarks: [[{ x: 0.1, y: 0.2, z: 0.3 }]] }
          : { landmarks: [[{ x: 0.4, y: 0.6, z: 0 }]], handedness: [[{ categoryName: 'Left', score: 0.87 }]] };
      },
      close() {
        task.closed = true;
      },
    };
    state.tasks.push(task);
    return task;
  };
  const creator = (kind: 'pose' | 'hand') => async (_fileset: unknown, opts: Record<string, unknown>) => {
    const delegate = (opts.baseOptions as { delegate: 'GPU' | 'CPU' }).delegate;
    state.created.push({ kind, delegate, opts });
    if (delegate === 'GPU' && state.failGpuCreate) throw new Error('GPU delegate unavailable');
    if (delegate === 'CPU' && state.failCpuCreate) throw new Error('CPU create failed');
    return make(kind, opts);
  };
  const reset = () => {
    state.wasmPaths = [];
    state.created = [];
    state.tasks = [];
    state.failGpuCreate = false;
    state.failGpuInference = false;
    state.failCpuCreate = false;
  };
  return { state, creator, reset };
});

vi.mock('@mediapipe/tasks-vision', () => ({
  FilesetResolver: {
    forVisionTasks: async (path: string) => {
      mp.state.wasmPaths.push(path);
      return { wasm: path };
    },
  },
  PoseLandmarker: { createFromOptions: mp.creator('pose') },
  HandLandmarker: { createFromOptions: mp.creator('hand') },
}));

describe('createDetector', () => {
  const frame = {} as unknown as HTMLVideoElement;
  beforeEach(() => {
    mp.reset();
    resetMediaPipeCache();
  });

  const flush = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };

  it('uses LOCAL assets, VIDEO mode and one pose, and forces strictly increasing timestamps', async () => {
    const det = await createDetector({ mode: 'leg' });
    expect(mp.state.wasmPaths).toEqual(['/wasm']); // local wasm directory, never a CDN
    const opts = mp.state.created[0].opts;
    expect((opts.baseOptions as { modelAssetPath: string }).modelAssetPath).toBe('/models/pose_landmarker_lite.task');
    expect(opts.runningMode).toBe('VIDEO');
    expect(opts.numPoses).toBe(1);
    expect(det.mode).toBe('leg');
    expect(det.delegate).toBe('GPU');

    const a = det.detect(frame, 100);
    expect(a.tMs).toBe(100);
    expect(a.pose).toHaveLength(1);
    expect(a.poseWorld).toHaveLength(1);
    // A frame whose capture time did not advance (or went backwards) must still get a larger timestamp:
    // MediaPipe rejects non-monotonic ones and would throw for the rest of the session.
    expect(det.detect(frame, 100).tMs).toBe(101);
    expect(det.detect(frame, 50).tMs).toBe(102);
    expect(mp.state.tasks[0].timestamps).toEqual([100, 101, 102]);
    det.close();
    expect(mp.state.tasks[0].closed).toBe(true);
  });

  it('hand mode requests 2 hands from the local model and maps handedness', async () => {
    const det = await createDetector({ mode: 'hand' });
    const opts = mp.state.created[0].opts;
    expect((opts.baseOptions as { modelAssetPath: string }).modelAssetPath).toBe('/models/hand_landmarker.task');
    expect(opts.runningMode).toBe('VIDEO');
    expect(opts.numHands).toBe(2);
    const res = det.detect(frame, 10);
    expect(res.pose).toBeNull();
    expect(res.hands).toHaveLength(1);
    expect(res.hands[0].label).toBe('Left');
    expect(res.hands[0].score).toBeCloseTo(0.87, 6);
    det.close();
  });

  it('caches the fileset per wasm path until resetMediaPipeCache()', async () => {
    (await createDetector({ mode: 'leg' })).close();
    (await createDetector({ mode: 'hand' })).close();
    expect(mp.state.wasmPaths).toEqual(['/wasm']);
    resetMediaPipeCache();
    (await createDetector({ mode: 'leg' })).close();
    expect(mp.state.wasmPaths).toEqual(['/wasm', '/wasm']);
  });

  it('falls back to CPU when the GPU delegate cannot be CREATED', async () => {
    mp.state.failGpuCreate = true;
    const det = await createDetector({ mode: 'leg' });
    expect(mp.state.created.map((c) => c.delegate)).toEqual(['GPU', 'CPU']);
    expect(det.delegate).toBe('CPU');
    expect(det.detect(frame, 1).pose).toHaveLength(1);
    det.close();
    // Pinned to GPU: no silent CPU fallback, the error surfaces.
    mp.state.created = [];
    await expect(createDetector({ mode: 'leg', delegate: 'GPU' })).rejects.toThrow(/GPU delegate unavailable/);
    expect(mp.state.created.map((c) => c.delegate)).toEqual(['GPU']);
  });

  it('re-creates the detector on CPU when the FIRST INFERENCE fails on GPU', async () => {
    mp.state.failGpuInference = true;
    const det = await createDetector({ mode: 'hand' });
    expect(det.delegate).toBe('GPU');
    // The failing frame yields "nothing detected" (lanes read not-tracking) instead of throwing at the
    // DetectLoop, which would otherwise pin the session at reason 'error' forever.
    const during = det.detect(frame, 5);
    expect(during.hands).toEqual([]);
    expect(during.tMs).toBe(5);
    // ... and it says WHY it is empty, so the patient is told "switching engines" rather than the lie
    // "no hand detected — put your hand in view", which they cannot act on.
    expect(det.recovering).toBe(true);
    await flush();
    expect(det.recovering).toBe(false);
    expect(det.delegate).toBe('CPU');
    expect(mp.state.created.map((c) => c.delegate)).toEqual(['GPU', 'CPU']);
    expect(mp.state.tasks[0].closed).toBe(true); // the broken GPU task is released
    const after = det.detect(frame, 6);
    expect(after.hands).toHaveLength(1);
    // Only ONE fallback attempt: a CPU task that also throws is a real error, not another re-create.
    expect(mp.state.created).toHaveLength(2);
    det.close();
  });

  it('surfaces the error loudly when the CPU re-creation also fails', async () => {
    mp.state.failGpuInference = true;
    mp.state.failCpuCreate = true;
    const det = await createDetector({ mode: 'leg' });
    expect(det.detect(frame, 1).pose).toBeNull();
    await flush();
    expect(() => det.detect(frame, 2)).toThrow(/CPU create failed/);
    expect(det.delegate).toBe('GPU');
    det.close();
  });
});
