/**
 * HOW WELL THE CAMERA WAS ACTUALLY TRACKING WHILE THE MEASUREMENT WAS TAKEN.
 *
 * Every clinical figure this app produces — a range in degrees, a timing bias in milliseconds, a
 * rep count, a trend across six weeks — is derived from landmarks sampled off a webcam by a model
 * running on whatever hardware the clinic has. A knee range measured from a 12 fps stream with the
 * leg drifting out of frame is NOT the same measurement as one from a steady 30 fps stream, and
 * until this module existed the record could not tell them apart: `SessionResult` carried no frame
 * rate, no inference time and no measure of tracking loss, so every session looked equally solid
 * and a trend built out of a good day and a bad one read as a change in the patient.
 *
 * So the play screen samples `VisionInput.getStatus()` while the song runs and this file turns that
 * into (a) a stored block on the record and (b) the two sentences a therapist needs beside a
 * number: how the stream behaved, and what that does to the resolution of the figure.
 *
 * WHAT IS AND IS NOT CLAIMED. Nothing here estimates the model's landmark error — that would be a
 * number invented by a UI, and this app has no ground truth to calibrate it against. What it states
 * is the uncertainty it can actually derive from what it observed:
 *  - TIMING is resolved to at best one frame interval (1000/fps ms): a movement is only ever seen
 *    in the frame it was sampled in, so at 12 fps a timing bias is a ±83 ms quantity;
 *  - a RANGE is a peak OF THE FRAMES THAT ARRIVED. A peak between two frames is invisible, so every
 *    range is a lower bound, and the fewer the frames the looser the bound;
 *  - a stretch with no usable landmarks is not "no movement", it is "not measured", and the share of
 *    the session that was actually tracked is the honest qualifier on the rep count.
 */
import { MIN_USABLE_DETECT_FPS } from '../vision/mediapipe.ts';
import type { VisionStatus } from '../input/types.ts';
import type { SessionResult, TrackingQuality } from './types.ts';

/** How often the play screen samples the input's health report (ms). */
export const TRACKING_SAMPLE_MS = 500;

/**
 * Below this the stream is good enough to report without a caveat: the camera is asked for 30 fps
 * and anything from 24 up is a stream doing its job. Between here and MIN_USABLE_DETECT_FPS the
 * measurement is usable but coarse; below MIN_USABLE_DETECT_FPS the app itself says the timing
 * windows are not achievable (vision/mediapipe.ts).
 */
export const GOOD_DETECT_FPS = 24;
/** Below this share of the session tracked, the figures are a partial observation, not a record. */
export const GOOD_TRACKED_FRACTION = 0.95;
export const POOR_TRACKED_FRACTION = 0.8;

export type TrackingGrade = 'good' | 'fair' | 'poor';

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** The value `p` of the way up the sorted samples (p = 0.1 → the tenth percentile). */
function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.round(p * (s.length - 1))));
  return s[i];
}

/**
 * Accumulates the input layer's health report over a run. Deliberately a plain class with no timer
 * of its own: the play screen already polls `getStatus()` for the live warnings, and one poll is
 * cheaper and always consistent with what the therapist was shown while it happened.
 */
export class TrackingRecorder {
  private fps: number[] = [];
  private inference: number[] = [];
  private tracked = 0;
  private lowFps = 0;
  private total = 0;
  private delegate: 'GPU' | 'CPU' | null = null;
  private reasons = new Map<string, number>();

  /**
   * Record one observation. `status.fps` of 0 with `tracking` false is a dead stream — counted as a
   * sample that was NOT tracked (which is the truth) but kept out of the frame-rate statistics,
   * where a run of zeros would report a median frame rate no camera ever produced.
   */
  sample(status: VisionStatus): void {
    this.total++;
    if (status.fps > 0) this.fps.push(status.fps);
    if (status.inferenceMs > 0) this.inference.push(status.inferenceMs);
    if (status.tracking) this.tracked++;
    if (status.fps > 0 && status.fps < MIN_USABLE_DETECT_FPS) this.lowFps++;
    if (status.delegate) this.delegate = status.delegate;
    if (!status.tracking || status.reason !== 'ok') {
      this.reasons.set(status.reason, (this.reasons.get(status.reason) ?? 0) + 1);
    }
  }

  get samples(): number {
    return this.total;
  }

  /**
   * The stored block, or null when nothing was ever sampled — a keyboard or autoplay run has no
   * camera to describe, and an empty block would read as "tracking was measured and was zero".
   */
  summary(): TrackingQuality | null {
    if (this.total === 0) return null;
    let worst: string | null = null;
    let worstN = 0;
    for (const [reason, n] of this.reasons) {
      if (n > worstN) {
        worst = reason;
        worstN = n;
      }
    }
    return {
      samples: this.total,
      fpsMedian: round1(median(this.fps)),
      fpsLow: round1(percentile(this.fps, 0.1)),
      inferenceMsMedian: round1(median(this.inference)),
      trackedFraction: this.total > 0 ? this.tracked / this.total : 0,
      lowFpsFraction: this.total > 0 ? this.lowFps / this.total : 0,
      delegate: this.delegate,
      worstReason: worst,
    };
  }
}

function round1(v: number): number {
  return Number.isFinite(v) ? Math.round(v * 10) / 10 : 0;
}

/**
 * How much of this record can be read as a measurement.
 *  - `poor`  — the app's own floor was not met (the timing windows are not achievable at this frame
 *              rate) or a fifth of the session produced no usable landmarks at all;
 *  - `fair`  — a usable but coarse stream: read ranges as approximate and small timing changes as noise;
 *  - `good`  — the stream did what the measurement assumes.
 */
export function trackingGrade(q: TrackingQuality): TrackingGrade {
  if (q.fpsMedian < MIN_USABLE_DETECT_FPS || q.trackedFraction < POOR_TRACKED_FRACTION) return 'poor';
  if (q.fpsMedian < GOOD_DETECT_FPS || q.trackedFraction < GOOD_TRACKED_FRACTION) return 'fair';
  return 'good';
}

/**
 * The interval between two camera samples, in ms — the finest difference in TIME this session can
 * resolve. A crossing is interpolated between the frames either side of it, so this is the bound on
 * the error rather than the error itself; it is quoted as "no finer than", never as "±exactly".
 */
export function timingResolutionMs(q: TrackingQuality): number | null {
  if (!(q.fpsMedian > 0)) return null;
  return Math.round(1000 / q.fpsMedian);
}

/** "28 fps, in frame 99 % of the session" — the measurement's conditions in one clause. */
export function trackingConditions(q: TrackingQuality): string {
  const seen = `${Math.round(q.trackedFraction * 100)} %`;
  const fps = `${q.fpsMedian.toFixed(0)} fps`;
  const low = q.fpsLow > 0 && q.fpsLow < q.fpsMedian - 2 ? ` (dipping to ${q.fpsLow.toFixed(0)})` : '';
  return `${fps}${low}, landmarks usable for ${seen} of the session`;
}

/**
 * The sentence that goes beside the figures — conditions first, then what they cost the reader.
 *
 * Deliberately one line and never an alarm: on a good stream it is a statement of conditions, which
 * is what a therapist needs in order to trust the number, and only a genuinely degraded stream says
 * "read these as approximate".
 */
export function trackingSentence(q: TrackingQuality): string {
  const grade = trackingGrade(q);
  const res = timingResolutionMs(q);
  const timing = res === null ? '' : ` Timing is resolved no finer than ${res} ms (one camera frame).`;
  const head = `Measured from the camera at ${trackingConditions(q)}.`;
  if (grade === 'good') return `${head}${timing}`;
  if (grade === 'fair') {
    return `${head}${timing} Ranges are peaks of the frames that arrived, so read them as approximate on this session.`;
  }
  return (
    `${head}${timing} This is below what the timing windows assume: ranges are lower bounds, timing is coarse, ` +
    `and a change against another session may be the camera rather than the patient.`
  );
}

/**
 * HOW MANY OF THE SESSIONS BEHIND THESE LINES WERE MEASURED WELL.
 *
 * A trend is the one view where a change in the EQUIPMENT is indistinguishable from a change in the
 * patient: two points measured at 30 fps with the limb in frame and at 12 fps with it drifting out
 * are drawn as the same kind of dot. So the sessions that could be plotted are counted by how well
 * they were tracked, and the count is stated under the cards.
 */
export function trackingMix(history: readonly SessionResult[], patientId: string): {
  total: number;
  degraded: number;
  unrecorded: number;
} {
  const mine = history.filter((r) => r.patientId === patientId && r.inputMode === 'camera');
  let degraded = 0;
  let unrecorded = 0;
  for (const r of mine) {
    if (!r.tracking) unrecorded++;
    else if (trackingGrade(r.tracking) !== 'good') degraded++;
  }
  return { total: mine.length, degraded, unrecorded };
}

/** What a screen or an export says when a record carries no tracking block at all. */
export const TRACKING_NOT_RECORDED = 'Tracking quality was not recorded for this session.';
