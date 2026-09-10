/**
 * Robustness guards added after the round-4 review: the detect loop's main-thread budget and post-stop
 * safety, the calibration rest-window guards, the opt-in unit-aware one-euro lane filter, and the
 * same-lane note spacing constant the chart generator must agree with.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_MAX_DETECT_HZ, DetectLoop, MIN_USABLE_DETECT_FPS } from './mediapipe.ts';
import type { DetectionResult, LandmarkDetector } from './mediapipe.ts';
import { RomCalibrator, isCalibrationValid, calibrationProblem } from './calibration.ts';
import { createFilter, filterGroupDelaySec, resolveLaneFilter, OneEuroFilter } from './filters.ts';
import type { LaneFilterSpec } from './filters.ts';
import { LanePipeline } from './pipeline.ts';
import { MIN_SAME_LANE_NOTE_SPACING_SEC } from './trigger.ts';
import { MIN_LANE_SPACING_SEC } from '../charts/generate.ts';

/* ---------------- DetectLoop main-thread budget ---------------- */

interface RvfcVideo extends HTMLVideoElement { __cbs: Array<(now: number, meta: { captureTime?: number }) => void>; }

function rvfcVideo(): RvfcVideo {
  const cbs: Array<(now: number, meta: { captureTime?: number }) => void> = [];
  const v = {
    __cbs: cbs,
    requestVideoFrameCallback: (cb: (now: number, meta: { captureTime?: number }) => void) => cbs.push(cb),
    cancelVideoFrameCallback: () => {},
    currentTime: 0,
    readyState: 4,
  } as unknown as RvfcVideo;
  return v;
}

function counting(detector: Partial<LandmarkDetector> = {}): LandmarkDetector & { calls: number } {
  return {
    mode: 'leg',
    delegate: 'CPU',
    calls: 0,
    detect(_f, ts): DetectionResult {
      (this as { calls: number }).calls++;
      return { tMs: ts, pose: null, hands: [] };
    },
    close: () => {},
    ...detector,
  } as LandmarkDetector & { calls: number };
}

/** Feed n frames spaced `stepMs` apart on the frames' own capture clock. */
function drive(video: RvfcVideo, times: number[]): void {
  for (const t of times) {
    const cb = video.__cbs[video.__cbs.length - 1];
    cb(t, { captureTime: t });
  }
}

describe('DetectLoop keeps a main-thread budget for the note highway', () => {
  it('caps the inference rate: a 60 fps webcam does not double the inference cost', () => {
    const video = rvfcVideo();
    const detector = counting();
    const loop = new DetectLoop(video, detector, () => {}, { maxDetectHz: 10 });
    loop.start();
    drive(video, [0, 50, 100, 150, 200, 250]); // 20 fps of video frames
    expect(detector.calls).toBe(3); // 0, 100, 200 — capped at 10 Hz
    expect(loop.getStats().skipped).toBe(3);
    expect(loop.getStats().frames).toBe(3);
    loop.stop();
  });

  it('the default cap sits just above the 30 fps the camera is asked for (no clipping of jitter)', () => {
    expect(DEFAULT_MAX_DETECT_HZ).toBeGreaterThan(30);
    const video = rvfcVideo();
    const detector = counting();
    const loop = new DetectLoop(video, detector, () => {});
    loop.start();
    drive(video, [0, 33, 66, 100, 133]); // ordinary 30 fps with jitter
    expect(detector.calls).toBe(5);
    expect(loop.getStats().skipped).toBe(0);
    loop.stop();
  });

  it('adaptively skips when an inference blows the budget (the CPU-delegate clinic laptop)', () => {
    const video = rvfcVideo();
    const slow = counting({
      detect(_f: unknown, ts: number): DetectionResult {
        const until = performance.now() + 20; // a 20 ms CPU-delegate pose inference
        while (performance.now() < until) { /* burn the main thread, as MediaPipe does */ }
        return { tMs: ts, pose: null, hands: [] };
      },
    });
    const loop = new DetectLoop(video, slow, () => {}, { maxDetectHz: 30, budgetMs: 1, adaptiveSkip: true });
    loop.start();
    drive(video, [0, 40, 80, 120]);
    expect(loop.getStats().skipped).toBeGreaterThan(0);
    expect(loop.isThrottled()).toBe(true);
    expect(loop.getStats().frames).toBeLessThan(4); // the renderer got its slice back
    expect(loop.getStats().frames).toBeGreaterThan(0); // ... and input never stops entirely
    loop.stop();
  });

  it('never throttles below the floor rate', () => {
    const video = rvfcVideo();
    const glacial = counting({
      detect(_f: unknown, ts: number): DetectionResult {
        const until = performance.now() + 25;
        while (performance.now() < until) { /* burn */ }
        return { tMs: ts, pose: null, hands: [] };
      },
    });
    const loop = new DetectLoop(video, glacial, () => {}, { maxDetectHz: 30, minDetectHz: 20, budgetMs: 0.01 });
    loop.start();
    // The floor is 20 Hz = one inference per 50 ms, so frames 50 ms apart are all processed.
    drive(video, [0, 60, 120, 180]);
    expect(loop.getStats().frames).toBe(4);
    loop.stop();
  });

  it('a frame callback dispatched before stop() does NOT call into the closed detector', () => {
    for (const useRvfc of [true, false]) {
      const cbs: Array<(now: number, meta?: unknown) => void> = [];
      const video = useRvfc
        ? ({ requestVideoFrameCallback: (cb: (n: number, m: unknown) => void) => cbs.push(cb), cancelVideoFrameCallback: () => {}, currentTime: 0, readyState: 4 } as unknown as HTMLVideoElement)
        : ({ currentTime: 0, readyState: 4 } as unknown as HTMLVideoElement);
      const origRaf = globalThis.requestAnimationFrame;
      const origCaf = globalThis.cancelAnimationFrame;
      if (!useRvfc) {
        globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => cbs.push(cb as (n: number) => void);
        globalThis.cancelAnimationFrame = () => {};
      }
      try {
        const detector = counting();
        const loop = new DetectLoop(video, detector, () => {}, { maxDetectHz: 1000 });
        loop.start();
        const pending = cbs[cbs.length - 1];
        loop.stop();
        // The browser had already queued this callback when stop() ran. Calling into a MediaPipe task
        // that VisionInput.stop() has close()d can abort the wasm runtime, not merely throw.
        expect(() => pending(10, { captureTime: 10 })).not.toThrow();
        expect(detector.calls, useRvfc ? 'rvfc' : 'raf').toBe(0);
      } finally {
        if (!useRvfc) {
          globalThis.requestAnimationFrame = origRaf;
          globalThis.cancelAnimationFrame = origCaf;
        }
      }
    }
  });

  it('publishes a usable-fps floor for the engine timing windows', () => {
    expect(MIN_USABLE_DETECT_FPS).toBeGreaterThan(0);
    // A hard difficulty's ±50 ms perfect window needs frames closer together than the window itself.
    expect(1000 / MIN_USABLE_DETECT_FPS).toBeGreaterThan(50);
  });
});

/* ---------------- calibration guards ---------------- */

describe('RomCalibrator rest window is a REST window', () => {
  it('a slowly drifting rest position is not "still" (spread alone would miss it)', () => {
    const drifting = new RomCalibrator('seated_march', { restTimeoutSec: 1e6 });
    // 0.05 of drift over the 2 s window = 42% of seated_march's 0.12 minRom, but with a tiny
    // instantaneous spread: the old spread-only guard accepted it and biased `min` by a third of minRom.
    for (let i = 0; i < 120; i++) drifting.push(0.1 + i * (0.05 / 60), i / 30);
    expect(drifting.getPhase()).toBe('rest');
    expect(drifting.isRestStill()).toBe(false);
    expect(Math.abs(drifting.restDrift())).toBeGreaterThan(0.01);

    const still = new RomCalibrator('seated_march');
    for (let i = 0; i < 120; i++) still.push(0.1 + ((i % 2) * 0.002), i / 30);
    expect(still.getPhase()).toBe('move');
    expect(Math.abs(still.restDrift())).toBeLessThan(0.005);
  });

  it('the default stillness fraction is tight enough to protect `min`', () => {
    const cal = new RomCalibrator('seated_march');
    expect(cal.stillnessFraction).toBeLessThanOrEqual(0.4);
    expect(cal.restDriftFraction).toBeLessThanOrEqual(0.25);
  });
});

describe('RomCalibrator.retryMove reports what it did', () => {
  it('returns true and re-enters move when a rest baseline exists', () => {
    const cal = new RomCalibrator('seated_march', { minRestSamples: 5, restDurationSec: 0.1 });
    for (let i = 0; i < 10; i++) cal.push(0.1, i / 30);
    expect(cal.getPhase()).toBe('move');
    for (let i = 0; i < 10; i++) cal.push(0.1 + 0.13 * (i % 2), 1 + i / 30);
    cal.finish();
    expect(cal.getPhase()).toBe('done');
    expect(cal.retryMove()).toBe(true);
    expect(cal.getPhase()).toBe('move');
    expect(cal.getError()).toBeNull();
  });

  it('falls back to a full reset (returning false) instead of silently doing nothing', () => {
    // A therapist set the range by hand straight from the rest phase, so there is no rest window to
    // reuse. The old implementation left the phase at 'rest' with the error intact: a dead button.
    const cal = new RomCalibrator('seated_march');
    cal.setManualRange(0.1, 0.105); // deliberately below minRom
    expect(cal.getError()).toBe('insufficient_range');
    expect(cal.retryMove()).toBe(false);
    expect(cal.getPhase()).toBe('rest');
    expect(cal.getError()).toBeNull();
    expect(cal.getStatus().restProgress).toBe(0);
  });
});

describe('calibration validity is checkable at every boundary', () => {
  it('names why a range is refused, in the movement’s own unit', () => {
    expect(calibrationProblem({ min: 0.2, max: 0.201 }, 'seated_march')).toMatch(/only 0.1%, below the 12% minimum/);
    expect(calibrationProblem({ min: 90, max: 95 }, 'knee_extension')).toMatch(/only 5°, below the 20° minimum/);
    expect(calibrationProblem({ min: 0, max: 1 }, 'seated_march')).toBeNull();
    expect(calibrationProblem(null, 'seated_march')).toBeNull();
    expect(calibrationProblem({ min: NaN, max: 1 }, 'seated_march')).toMatch(/not a number/);
  });

  it('the ranges the therapist APIs can produce are all reachable by the check', () => {
    const cal = new RomCalibrator('seated_march');
    cal.setManualRange(0.5, 0.5 + 1e-9); // reconcile only guarantees max > min + 1e-6
    const provisional = cal.getProvisional()!;
    expect(provisional).not.toBeNull();
    expect(isCalibrationValid(provisional, 'seated_march')).toBe(false);
    cal.setManualRange(0.2, 0.6);
    expect(isCalibrationValid(cal.getResult(), 'seated_march')).toBe(true);
  });
});

/* ---------------- one-euro as an opt-in lane filter ---------------- */

describe('OneEuro is reachable from the lane pipeline and is unit-aware', () => {
  it('createFilter scales beta by the lane feature scale so one spec fits every unit', () => {
    const spec: LaneFilterSpec = { kind: 'oneEuro', minCutoff: 1, beta: 0.5, featureScale: 20 };
    const f = createFilter(spec) as OneEuroFilter;
    expect(f).toBeInstanceOf(OneEuroFilter);
    expect(f.beta).toBeCloseTo(0.5 / 20, 12);
    expect((createFilter({ kind: 'oneEuro', minCutoff: 1, beta: 0.5 }) as OneEuroFilter).beta).toBe(0.5);
  });

  it('a lane pipeline fills in the movement’s own scale, so degrees and ratio lanes behave alike', () => {
    const spec: LaneFilterSpec = { kind: 'oneEuro', minCutoff: 1, beta: 1 };
    const deg = new LanePipeline({ movement: 'knee_extension', side: 'left', smoothing: spec });
    const ratio = new LanePipeline({ movement: 'seated_march', side: 'left', smoothing: spec });
    expect(resolveLaneFilter(spec, 20)).toMatchObject({ featureScale: 20 });
    // Drive both with the SAME movement expressed in their own units (0..1 of the movement's minRom):
    // a unit-aware beta makes the smoothed trajectories match after rescaling.
    const track = (p: LanePipeline, scale: number) => {
      const out: number[] = [];
      for (let i = 0; i < 30; i++) out.push((p.pushFeature((i / 29) * scale, i / 30).smoothed as number) / scale);
      return out;
    };
    const a = track(deg, 20);
    const b = track(ratio, 0.12);
    for (let i = 0; i < a.length; i++) expect(b[i]).toBeCloseTo(a[i], 9);
  });

  it('reports the worst-case group delay so a latency offset is never late', () => {
    expect(filterGroupDelaySec({ kind: 'oneEuro', minCutoff: 4.8, beta: 0.01 }, 30)).toBeCloseTo(1 / (2 * Math.PI * 4.8), 12);
    const p = new LanePipeline({ movement: 'seated_march', side: 'left', smoothing: { kind: 'oneEuro', minCutoff: 2, beta: 0.1 } });
    expect(p.filterDelaySec(30)).toBeCloseTo(1 / (2 * Math.PI * 2), 12);
  });

  it('still smooths and still follows (the reason the spec names it)', () => {
    const p = new LanePipeline({ movement: 'seated_march', side: 'left', smoothing: { kind: 'oneEuro', minCutoff: 1, beta: 2 } });
    const noise = [0.02, -0.02, 0.02, -0.02, 0.02, -0.02, 0.02, -0.02];
    let t = 0;
    let last = 0;
    for (const n of noise) {
      last = p.pushFeature(0.3 + n, t).smoothed as number;
      t += 1 / 30;
    }
    expect(Math.abs(last - 0.3)).toBeLessThan(0.015); // jitter at rest is suppressed
    for (let i = 0; i < 10; i++) {
      last = p.pushFeature(0.3 + i * 0.1, t).smoothed as number;
      t += 1 / 30;
    }
    expect(last).toBeGreaterThan(0.9); // a fast movement is still tracked
  });
});

/* ---------------- cross-module constant ---------------- */

describe('same-lane note spacing agrees with the chart generator', () => {
  it('no difficulty places two same-lane notes closer than the trigger can fire', () => {
    // MIN_SAME_LANE_NOTE_SPACING_SEC is declared authoritative for chart generation but the generator
    // carries its own table; without this assertion the two can drift apart with nothing failing, and
    // the result is notes that are unhittable by construction.
    for (const [name, spacing] of Object.entries(MIN_LANE_SPACING_SEC)) {
      expect(spacing, name).toBeGreaterThanOrEqual(MIN_SAME_LANE_NOTE_SPACING_SEC);
    }
  });
});
