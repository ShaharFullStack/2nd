/**
 * The record has to be able to tell a good measurement from a bad one.
 *
 * These tests pin the two claims the rest of the app makes on top of this module: that a session
 * measured on a degraded camera stream is STORED as such (rather than looking identical to a clean
 * one), and that the uncertainty stated beside a figure is derived from what was observed rather
 * than invented.
 */
import { describe, expect, it } from 'vitest';
import type { VisionStatus } from '../input/types.ts';
import {
  compareTracking,
  trackingMixOfGrades,
  GOOD_DETECT_FPS,
  TRACKING_SAMPLE_MS,
  TrackingRecorder,
  timingResolutionMs,
  trackingConditions,
  trackingGrade,
  trackingSentence,
} from './tracking.ts';

function status(patch: Partial<VisionStatus> = {}): VisionStatus {
  return {
    tracking: true,
    reason: 'ok',
    message: '',
    fps: 30,
    inferenceMs: 12,
    delegate: 'GPU',
    untrackedLanes: [],
    ...patch,
  } as VisionStatus;
}

describe('TrackingRecorder', () => {
  it('records nothing for a session with no camera, so the record says "not recorded"', () => {
    // A keyboard or autoplay run never samples: an all-zero block would read as a camera session
    // whose stream was dead, which is a different (and alarming) claim.
    expect(new TrackingRecorder().summary()).toBeNull();
  });

  it('summarises the stream it saw: median and low frame rate, inference time, tracked share', () => {
    const r = new TrackingRecorder();
    for (const fps of [30, 29, 31, 30, 28, 30, 30, 12, 30, 30]) r.sample(status({ fps }));
    const q = r.summary()!;
    expect(q.samples).toBe(10);
    expect(q.fpsMedian).toBe(30);
    expect(q.fpsLow).toBeLessThan(q.fpsMedian); // the dip is kept, not averaged away
    expect(q.inferenceMsMedian).toBe(12);
    expect(q.trackedFraction).toBe(1);
    expect(q.delegate).toBe('GPU');
    expect(q.worstReason).toBeNull();
  });

  it('counts the stretches with no usable landmarks, and names the commonest reason', () => {
    const r = new TrackingRecorder();
    for (let i = 0; i < 6; i++) r.sample(status());
    for (let i = 0; i < 4; i++) r.sample(status({ tracking: false, reason: 'low_visibility' }));
    const q = r.summary()!;
    expect(q.trackedFraction).toBeCloseTo(0.6, 6);
    expect(q.worstReason).toBe('low_visibility');
  });

  it('keeps a dead stream out of the frame-rate statistics but inside the tracked share', () => {
    // A stalled camera reports 0 fps AND 0 ms (VisionInput.getStatus). Averaging those zeros in
    // would publish a median frame rate no camera ever produced.
    const r = new TrackingRecorder();
    for (let i = 0; i < 5; i++) r.sample(status({ fps: 26 }));
    for (let i = 0; i < 5; i++) r.sample(status({ fps: 0, inferenceMs: 0, tracking: false, reason: 'stalled' }));
    const q = r.summary()!;
    expect(q.fpsMedian).toBe(26);
    expect(q.trackedFraction).toBeCloseTo(0.5, 6);
    expect(q.worstReason).toBe('stalled');
  });

  it('samples at the rate the play screen polls at', () => {
    expect(TRACKING_SAMPLE_MS).toBeGreaterThan(0);
    expect(1000 / TRACKING_SAMPLE_MS).toBeLessThanOrEqual(4); // cheap enough to run for a whole song
  });
});

describe('what the grade and the sentence claim', () => {
  const q = (patch: Partial<ReturnType<TrackingRecorder['summary']> & object>) => ({
    samples: 100,
    fpsMedian: 30,
    fpsLow: 28,
    inferenceMsMedian: 12,
    trackedFraction: 1,
    lowFpsFraction: 0,
    delegate: 'GPU' as const,
    worstReason: null,
    ...patch,
  });

  it('grades a clean stream good and a slow one poor', () => {
    expect(trackingGrade(q({}))).toBe('good');
    expect(trackingGrade(q({ fpsMedian: GOOD_DETECT_FPS - 1 }))).toBe('fair');
    // below the engine's own usable floor the timing windows are not achievable at all
    expect(trackingGrade(q({ fpsMedian: 12 }))).toBe('poor');
  });

  it('grades on tracking loss as well as on frame rate', () => {
    expect(trackingGrade(q({ trackedFraction: 0.9 }))).toBe('fair');
    expect(trackingGrade(q({ trackedFraction: 0.5 }))).toBe('poor');
  });

  it('states timing resolution as one camera frame, not as a made-up error bar', () => {
    expect(timingResolutionMs(q({ fpsMedian: 30 }))).toBe(33);
    expect(timingResolutionMs(q({ fpsMedian: 12 }))).toBe(83);
    expect(timingResolutionMs(q({ fpsMedian: 0 }))).toBeNull();
  });

  it('says the conditions on a good stream and adds the caveat only on a bad one', () => {
    const good = trackingSentence(q({}));
    expect(good).toContain('30 fps');
    expect(good).toContain('100 %');
    expect(good).toContain('33 ms');
    expect(good).not.toMatch(/approximate|lower bounds/);

    const bad = trackingSentence(q({ fpsMedian: 11, fpsLow: 8, trackedFraction: 0.7 }));
    expect(bad).toContain('11 fps');
    expect(bad).toContain('70 %');
    expect(bad).toContain('lower bounds');
    expect(bad).toContain('may be the camera rather than the patient');
  });

  it('mentions the dip only when the stream actually dipped', () => {
    expect(trackingConditions(q({ fpsMedian: 30, fpsLow: 29 }))).not.toContain('dipping');
    expect(trackingConditions(q({ fpsMedian: 30, fpsLow: 9 }))).toContain('dipping to 9');
  });
});

/**
 * THE REASON TRACKING QUALITY IS RECORDED AT ALL.
 *
 * A per-session block on a record nobody subtracts anything from changes no decision. The screens
 * subtract sessions from each other constantly — a gain chip, a trend delta, "biggest gain today" —
 * and this is the gate every one of those runs through.
 */
describe('whether two sessions may be compared', () => {
  const good = { samples: 100, fpsMedian: 30, fpsLow: 28, inferenceMsMedian: 12, trackedFraction: 1, lowFpsFraction: 0, delegate: 'GPU' as const, worstReason: null };
  const fair = { ...good, fpsMedian: 20 };
  const poor = { ...good, fpsMedian: 11.8, trackedFraction: 0.62 };

  it('calls two clean streams like-for-like and says nothing further', () => {
    const c = compareTracking(good, good);
    expect(c.kind).toBe('like-for-like');
    expect(c.tag).toBeNull();
    expect(c.note).toBeNull();
  });

  it('will not call a poor session against a good one a plain gain', () => {
    const c = compareTracking(good, poor);
    expect(c.kind).toBe('uneven');
    expect(c.tag).toBe('measured unevenly');
    expect(c.note).toContain('tracked good');
    expect(c.note).toContain('poor');
    expect(c.note).toContain('may be the camera rather than the patient');
  });

  it('qualifies two degraded sessions even though they match each other', () => {
    const c = compareTracking(fair, fair);
    expect(c.kind).toBe('uneven');
    expect(c.tag).toBe('both tracked fair');
  });

  it('treats a missing tracking block as absent, never as a clean stream', () => {
    expect(compareTracking(null, good).kind).toBe('unrecorded');
    expect(compareTracking(good, undefined).kind).toBe('unrecorded');
    const c = compareTracking(null, null);
    expect(c.tag).toBe('tracking unknown');
    expect(c.note).toContain('no evidence');
  });

  it('names the two ends the way the calling screen names them', () => {
    const c = compareTracking(good, poor, { from: 'the Feb 3 session', to: "today's session" });
    expect(c.note).toContain('The Feb 3 session was tracked good');
    expect(c.note).toContain("today's session poor");
  });
});

describe('the mix stated under a set of plotted sessions', () => {
  it('counts exactly the grades it was handed, with absent counted as absent', () => {
    expect(trackingMixOfGrades(['good', 'good'])).toEqual({ total: 2, degraded: 0, unrecorded: 0 });
    expect(trackingMixOfGrades(['good', 'fair', 'poor', null])).toEqual({ total: 4, degraded: 2, unrecorded: 1 });
    expect(trackingMixOfGrades([])).toEqual({ total: 0, degraded: 0, unrecorded: 0 });
  });
});
