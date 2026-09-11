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
 * The grade of a stored session, or null when the record carries no tracking block — which is NOT
 * the same as a clean stream and is never allowed to render as one.
 */
export function sessionTrackingGrade(s: Pick<SessionResult, 'tracking'>): TrackingGrade | null {
  return s.tracking ? trackingGrade(s.tracking) : null;
}

/**
 * HOW MANY OF THE SESSIONS BEHIND A SET OF LINES WERE MEASURED WELL.
 *
 * Takes the GRADES OF THE SESSIONS THAT ARE ON SCREEN, not a patient's whole stored history: the
 * sentence this feeds sits under a plot of a chosen window ("Last 4"), and a count of twelve
 * sessions under four drawn points is a number that does not match its own view. `null` in the list
 * is a session with no tracking block.
 */
export function trackingMixOfGrades(grades: readonly (TrackingGrade | null)[]): {
  total: number;
  degraded: number;
  unrecorded: number;
} {
  let degraded = 0;
  let unrecorded = 0;
  for (const g of grades) {
    if (g === null) unrecorded++;
    else if (g !== 'good') degraded++;
  }
  return { total: grades.length, degraded, unrecorded };
}

/**
 * WHETHER TWO SESSIONS MAY BE SUBTRACTED FROM EACH OTHER.
 *
 * This is the point of recording tracking quality at all. A per-session block and a footnote tell a
 * therapist how today was measured; they do not stop the screen printing a green "▲ +40 pts" chip
 * across a 30 fps session and an 11.8 fps one — and COMPARISON is exactly where equipment noise
 * masquerades as patient change. Every delta, gain badge and "biggest gain today" on any screen runs
 * through this, so a change taken across two differently-measured sessions cannot render as a plain
 * win anywhere.
 *
 * Three verdicts, and only the first is allowed to look like a clean result:
 *  - `like-for-like` — both sessions recorded tracking and both were graded good;
 *  - `uneven`        — the two grades differ, or both are degraded: part of the difference may be
 *                      the camera;
 *  - `unrecorded`    — at least one end has no tracking block, so the app CANNOT SAY the two were
 *                      measured alike. Absent reads as absent, never as good.
 */
export type ComparabilityKind = 'like-for-like' | 'uneven' | 'unrecorded';

export interface TrackingComparison {
  kind: ComparabilityKind;
  from: TrackingGrade | null;
  to: TrackingGrade | null;
  /** Short enough to sit INSIDE the delta chip. Null when nothing needs saying. */
  tag: string | null;
  /** The sentence that goes with it. Null when like-for-like. */
  note: string | null;
}

export interface ComparisonLabels {
  /** How the earlier session is named in the sentence. */
  from: string;
  /** How the later one is named. */
  to: string;
}

const DEFAULT_LABELS: ComparisonLabels = { from: 'the earlier session', to: 'the later one' };

export function compareTracking(
  from: TrackingQuality | null | undefined,
  to: TrackingQuality | null | undefined,
  labels: ComparisonLabels = DEFAULT_LABELS,
): TrackingComparison {
  const a = from ? trackingGrade(from) : null;
  const b = to ? trackingGrade(to) : null;
  if (a === null || b === null) {
    const which =
      a === null && b === null
        ? `Neither ${labels.from} nor ${labels.to} recorded how well the camera was tracking`
        : a === null
          ? `${cap(labels.from)} has no tracking quality recorded`
          : `${cap(labels.to)} has no tracking quality recorded`;
    return {
      kind: 'unrecorded',
      from: a,
      to: b,
      tag: 'tracking unknown',
      note: `${which}, so there is no evidence these two sessions were measured under the same conditions. Read the change as a direction, not as a measured gain.`,
    };
  }
  if (a === 'good' && b === 'good') return { kind: 'like-for-like', from: a, to: b, tag: null, note: null };
  if (a !== b) {
    return {
      kind: 'uneven',
      from: a,
      to: b,
      tag: 'measured unevenly',
      note: `${cap(labels.from)} was tracked ${a} and ${labels.to} ${b}, so part of this difference may be the camera rather than the patient.`,
    };
  }
  return {
    kind: 'uneven',
    from: a,
    to: b,
    tag: `both tracked ${a}`,
    note: `Both sessions were tracked ${a}: ranges are lower bounds on a degraded stream, so a difference of this size may be the camera rather than the patient.`,
  };
}

function cap(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

/** What a screen or an export says when a record carries no tracking block at all. */
export const TRACKING_NOT_RECORDED = 'Tracking quality was not recorded for this session.';
