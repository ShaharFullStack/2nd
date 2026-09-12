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
import type { CalibrationMeasurement } from '../vision/calibration.ts';
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
 * One health report, kept so a verdict can be taken over a WINDOW of them rather than over
 * everything since the screen opened. `anyTracked` is null when the caller did not say how many
 * lanes are prescribed, because "at least one limb is in frame" cannot be derived without it.
 */
interface TrackingSample {
  fps: number;
  inferenceMs: number;
  tracked: boolean;
  anyTracked: boolean | null;
  lowFps: boolean;
  delegate: 'GPU' | 'CPU' | null;
  reason: string;
  ok: boolean;
}

/**
 * How many of the MOST RECENT health reports a forward-looking verdict (the camera check) is taken
 * over: 20 samples, six seconds at `TRACKING_SAMPLE_MS`.
 *
 * WHY A WINDOW AT ALL. A cumulative median cannot come back. A clinic tablet that spent its first
 * minute on the camera-check screen downloading the model, or behind another app's compositing, is
 * a device whose median frame rate is pinned below the gate's floor FOR THE REST OF THE VISIT even
 * after it frees up — the patient holds still, the stream recovers, and the screen goes on saying
 * the device cannot be used because of a minute that is over. The session's own tracking block is
 * the opposite case and keeps the cumulative figure (`summary`): a record of a three-minute song
 * describes the whole song, not its last six seconds.
 */
export const READINESS_WINDOW_SAMPLES = 20;

function summarize(entries: readonly TrackingSample[]): TrackingQuality | null {
  if (entries.length === 0) return null;
  const fps: number[] = [];
  const inference: number[] = [];
  let tracked = 0;
  let lowFps = 0;
  let delegate: 'GPU' | 'CPU' | null = null;
  const reasons = new Map<string, number>();
  for (const e of entries) {
    if (e.fps > 0) fps.push(e.fps);
    if (e.inferenceMs > 0) inference.push(e.inferenceMs);
    if (e.tracked) tracked++;
    if (e.lowFps) lowFps++;
    if (e.delegate) delegate = e.delegate;
    if (!e.ok) reasons.set(e.reason, (reasons.get(e.reason) ?? 0) + 1);
  }
  let worst: string | null = null;
  let worstN = 0;
  for (const [reason, n] of reasons) {
    if (n > worstN) {
      worst = reason;
      worstN = n;
    }
  }
  return {
    samples: entries.length,
    fpsMedian: round1(median(fps)),
    fpsLow: round1(percentile(fps, 0.1)),
    inferenceMsMedian: round1(median(inference)),
    trackedFraction: tracked / entries.length,
    lowFpsFraction: lowFps / entries.length,
    delegate,
    worstReason: worst,
  };
}

/**
 * Accumulates the input layer's health report over a run. Deliberately a plain class with no timer
 * of its own: the play screen already polls `getStatus()` for the live warnings, and one poll is
 * cheaper and always consistent with what the therapist was shown while it happened.
 *
 * TWO VIEWS OF THE SAME STREAM, because two questions are being asked of it. `summary()` is the
 * RECORD — everything sampled, which is what a session's tracking block has to describe. `recent()`
 * is the VERDICT — the last `READINESS_WINDOW_SAMPLES` reports, which is what a screen deciding
 * whether this device can be used right now has to be allowed to change its mind on.
 */
export class TrackingRecorder {
  private fps: number[] = [];
  private inference: number[] = [];
  private tracked = 0;
  private lowFps = 0;
  private total = 0;
  private delegate: 'GPU' | 'CPU' | null = null;
  private reasons = new Map<string, number>();
  /** The trailing window, bounded. Nothing else in here is allowed to grow without limit either. */
  private window: TrackingSample[] = [];

  /**
   * Record one observation. `status.fps` of 0 with `tracking` false is a dead stream — counted as a
   * sample that was NOT tracked (which is the truth) but kept out of the frame-rate statistics,
   * where a run of zeros would report a median frame rate no camera ever produced.
   *
   * `laneCount` is how many lanes the prescription has. With it, a sample can say whether SOME limb
   * was in frame as opposed to all of them (`VisionStatus.tracking` is "every lane", so one hand of
   * a bilateral prescription drifting out makes it false); without it that distinction is not
   * derivable and is reported as unknown rather than guessed.
   */
  sample(status: VisionStatus, laneCount?: number): void {
    this.total++;
    if (status.fps > 0) this.fps.push(status.fps);
    if (status.inferenceMs > 0) this.inference.push(status.inferenceMs);
    if (status.tracking) this.tracked++;
    const low = status.fps > 0 && status.fps < MIN_USABLE_DETECT_FPS;
    if (low) this.lowFps++;
    if (status.delegate) this.delegate = status.delegate;
    const ok = status.tracking && status.reason === 'ok';
    if (!ok) {
      this.reasons.set(status.reason, (this.reasons.get(status.reason) ?? 0) + 1);
    }
    const anyTracked =
      status.tracking === true
        ? true
        : laneCount !== undefined && laneCount > 0
          ? (status.untrackedLanes?.length ?? laneCount) < laneCount
          : null;
    this.window.push({
      fps: status.fps,
      inferenceMs: status.inferenceMs,
      tracked: status.tracking === true,
      anyTracked,
      lowFps: low,
      delegate: status.delegate,
      reason: status.reason,
      ok,
    });
    if (this.window.length > READINESS_WINDOW_SAMPLES) this.window.shift();
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

  /**
   * The same block over the TRAILING WINDOW only — what a screen deciding about this device NOW is
   * entitled to judge it on. Null before the first sample.
   */
  recent(): TrackingQuality | null {
    return summarize(this.window);
  }

  /**
   * Share of the windowed samples in which at least one prescribed lane had usable landmarks, or
   * null when no sample could say (no lane count was supplied). It is the difference between
   * "nothing is being tracked" and "one of two hands has drifted out of frame", and those two have
   * different remedies and different truths.
   */
  anyLandmarksFraction(): number | null {
    const known = this.window.filter((e) => e.anyTracked !== null);
    if (known.length === 0) return null;
    return known.filter((e) => e.anyTracked === true).length / known.length;
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

/* ------------------------------------------------------------------------------------------------
 * THE CALIBRATION THE WHOLE SCALE IS BUILT ON.
 *
 * Everything above judges how well a SESSION was tracked. This judges how well the CALIBRATION was
 * measured — the range every one of those session figures is a percentage of. It lives here, beside
 * `trackingGrade`, because the two answer the same question about the same camera and must not drift
 * apart: one set of thresholds decides what "good" means about a camera measurement anywhere in this
 * app, and a therapist who has learnt what the word means on one screen can read it on the other.
 * ---------------------------------------------------------------------------------------------- */

/**
 * How much the reps behind a range may disagree before the top of that range is an estimate rather
 * than a measurement, as a fraction of the range itself.
 *
 * `max` is the 90th percentile of the detected peaks. With three reps that is very nearly the largest
 * of them, so the spread between them IS the uncertainty on the top: reps of 0.30, 0.31 and 0.32
 * against a 0.24 range agree to within 8 % of it, while 0.20, 0.28 and 0.32 disagree by half of it and
 * a different 90th percentile would have produced a materially different denominator.
 */
export const FAIR_REP_SPREAD_FRACTION = 0.25;
export const POOR_REP_SPREAD_FRACTION = 0.5;

/** The number of reps a range is meant to be built from (RomCalibrator's default). */
export const EXPECTED_CALIBRATION_REPS = 3;

/**
 * How much of this range can be read as a measurement.
 *  - `poor` — the peaks were sampled below the app's own usable frame rate, a fifth of the frames had
 *             no usable landmarks, the reps disagreed by half the range, or there was only one rep (a
 *             range with no repeat has no evidence of repeatability at all);
 *  - `fair` — usable but coarse: the top of the range is a soft number, so read the percentages it is
 *             the denominator of as approximate;
 *  - `good` — the range was measured under the conditions the figures downstream assume.
 */
export function calibrationGrade(m: CalibrationMeasurement): TrackingGrade {
  if (
    m.fpsMedian < MIN_USABLE_DETECT_FPS ||
    m.trackedFraction < POOR_TRACKED_FRACTION ||
    m.repSpreadFraction > POOR_REP_SPREAD_FRACTION ||
    m.reps < 2
  ) {
    return 'poor';
  }
  if (
    m.fpsMedian < GOOD_DETECT_FPS ||
    m.trackedFraction < GOOD_TRACKED_FRACTION ||
    m.repSpreadFraction > FAIR_REP_SPREAD_FRACTION ||
    m.reps < EXPECTED_CALIBRATION_REPS
  ) {
    return 'fair';
  }
  return 'good';
}

/** The grade of a stored range, or null when it carries no measurement block — never "good". */
export function calibrationMeasurementGrade(
  cal: { measurement?: CalibrationMeasurement | null } | null | undefined,
): TrackingGrade | null {
  return cal?.measurement ? calibrationGrade(cal.measurement) : null;
}

/**
 * "23 fps, landmarks usable for 96 % of it, 3 reps within 9 % of the range" — the conditions the
 * denominator was measured in, in one clause, for a badge tooltip or a table cell.
 */
export function calibrationConditions(m: CalibrationMeasurement): string {
  const fps = `${m.fpsMedian.toFixed(0)} fps`;
  const low = m.fpsLow > 0 && m.fpsLow < m.fpsMedian - 2 ? ` (dipping to ${m.fpsLow.toFixed(0)})` : '';
  const seen = `landmarks usable for ${Math.round(m.trackedFraction * 100)} % of the frames`;
  const reps =
    m.reps === 0
      ? 'no repetitions detected'
      : m.reps === 1
        ? '1 repetition (no repeat to compare it with)'
        : `${m.reps} reps within ${Math.round(m.repSpreadFraction * 100)} % of the range`;
  return `${fps}${low}, ${seen}, ${reps}`;
}

/**
 * THE SENTENCE THAT GOES BESIDE THE RANGE — conditions first, then what they cost the reader.
 *
 * It says what follows from the sampling and nothing more. A low frame rate biases the top of a range
 * DOWNWARD (a peak between two frames is never seen), which makes every later rep read as a larger
 * percentage of it than it was, and that direction is stated: a therapist deciding whether to re-run
 * a calibration needs to know which way the error points.
 */
export function calibrationSentence(m: CalibrationMeasurement): string {
  const grade = calibrationGrade(m);
  const head = `This range was measured at ${calibrationConditions(m)}.`;
  if (grade === 'good') return head;
  const why: string[] = [];
  if (m.fpsMedian < GOOD_DETECT_FPS) {
    why.push(
      `at ${m.fpsMedian.toFixed(0)} fps a peak between two frames is never seen, so the top of the range is if anything too low — every later rep then reads as a larger percentage of it than it was`,
    );
  }
  if (m.trackedFraction < GOOD_TRACKED_FRACTION) {
    why.push(`${Math.round((1 - m.trackedFraction) * 100)} % of the frames had no usable landmarks, so part of the hold and the reps was not measured at all`);
  }
  if (m.reps < EXPECTED_CALIBRATION_REPS) {
    why.push(
      m.reps <= 1
        ? 'it rests on a single repetition, so there is no evidence it repeats'
        : `it rests on ${m.reps} repetitions rather than ${EXPECTED_CALIBRATION_REPS}`,
    );
  }
  if (m.repSpreadFraction > FAIR_REP_SPREAD_FRACTION) {
    why.push(`the reps it was built from disagreed by ${Math.round(m.repSpreadFraction * 100)} % of the range, so the top of it is an estimate`);
  }
  const tail = why.length > 0 ? ` ${cap(why.join('; '))}.` : '';
  return `${head}${tail} Every percentage measured against this range carries that — re-run the calibration if the conditions can be improved.`;
}

/** What a screen or an export says when a range carries no measurement block at all. */
export const CALIBRATION_NOT_RECORDED =
  'How well this range was measured was not recorded — it was set by hand, or captured before this device recorded it.';

/* ------------------------------------------------------------------------------------------------
 * BEFORE THE PATIENT IS IN THE CHAIR.
 *
 * Everything above is retrospective: it describes a measurement that has already been taken. This is
 * the forward-looking half, and it exists because the camera check was the only screen in the flow
 * with neither a gate nor a statement about what came next. Driven with a real webcam at 1–2 fps and
 * "No person detected", it let the therapist walk straight on to a ROM calibration that cannot be
 * measured and a song that cannot be played — spending an appointment to find out.
 *
 * It is built on the SAME recorder and the SAME thresholds as the session block above, deliberately:
 * what the camera check calls a degraded stream has to be what the record calls a degraded stream, or
 * the screen that promises and the record that reports disagree about the same camera.
 * ---------------------------------------------------------------------------------------------- */

/** Health reports needed before this screen may claim anything about the device (~2.4 s at 300 ms). */
export const READINESS_SAMPLES = 8;

/** The timing windows in force for the prescription, narrowest lane first — what has to be reachable. */
export interface ReadinessWindows {
  /** Narrowest perfect window across the prescribed lanes (± ms). */
  perfectMs: number;
  /** Narrowest good window across the prescribed lanes (± ms). */
  goodMs: number;
  /** How the difficulty is named on screen, for the sentence. */
  difficulty: string;
}

export type ReadinessKind = 'measuring' | 'ready' | 'degraded' | 'blocked';

export interface DeviceReadiness {
  kind: ReadinessKind;
  /**
   * True when going forward cannot produce a measurement on this device as it stands. It is a gate on
   * a POSITIVE finding only — never on absence of evidence — and every one of them clears by itself
   * when the thing it names is fixed (the patient sits down, the stream speeds up).
   */
  gate: boolean;
  /** One line, the verdict. */
  headline: string;
  /** What this device WILL support, in the prescription's own numbers. */
  will: string[];
  /** What it will NOT. Empty when everything prescribed is reachable. */
  wont: string[];
  /** What to do about it, when there is something to do. */
  action: string | null;
}

/** The frame interval this stream is delivering, in ms (null when no frame rate was observed). */
function frameIntervalMs(q: TrackingQuality): number | null {
  return q.fpsMedian > 0 ? Math.round(1000 / q.fpsMedian) : null;
}

/**
 * WHAT THIS DEVICE WILL AND WILL NOT SUPPORT, said before the appointment is spent on finding out.
 *
 * `q` is the camera check's own rolling observation (the same TrackingRecorder the session uses), or
 * null before any health report has arrived.
 */
export interface ReadinessObservation {
  /**
   * Share of the same samples in which AT LEAST ONE prescribed lane had usable landmarks, or null
   * when it could not be derived (see `TrackingRecorder.anyLandmarksFraction`).
   *
   * `TrackingQuality.trackedFraction` is EVERY lane at once (`VisionStatus.tracking`), so on a
   * bilateral prescription it goes to zero the moment one of the two hands drifts out of frame — and
   * "Nothing is being tracked on this camera yet" was then printed over a preview visibly drawing a
   * skeleton. This is what tells those two states apart.
   */
  anyLandmarksFraction?: number | null;
}

export function cameraReadiness(
  q: TrackingQuality | null,
  w: ReadinessWindows,
  obs: ReadinessObservation = {},
): DeviceReadiness {
  if (!q || q.samples === 0) {
    return {
      kind: 'measuring',
      gate: false,
      headline: 'Checking what this device can do…',
      will: [],
      wont: [],
      action: null,
    };
  }
  const interval = frameIntervalMs(q);
  const seenPct = Math.round(q.trackedFraction * 100);
  const cpu = q.delegate === 'CPU';

  // NOTHING FOR ANY LANE. Not "the patient is not moving" — no lane has landmarks, so there is no
  // range to calibrate and no lane that can ever trigger. It clears the moment they are in frame,
  // which is exactly what this screen is for.
  //
  // SOME lanes, though, is a DIFFERENT SENTENCE, and printing this one over a preview drawing a
  // tracked hand was the screen calling its own picture a liar: `trackedFraction` is every lane at
  // once, so one hand of a bilateral prescription leaving the frame zeroes it. `anyLandmarks` is
  // what separates them; when nothing can say (no lane count was supplied) the wording falls back to
  // the part that is true either way — this prescription is not fully in frame.
  const anyLandmarks = obs.anyLandmarksFraction ?? null;
  if (q.trackedFraction === 0 && q.samples >= READINESS_SAMPLES) {
    const partial = anyLandmarks !== null && anyLandmarks > 0;
    return {
      kind: 'blocked',
      gate: true,
      headline: partial
        ? 'Part of this prescription is out of frame.'
        : anyLandmarks === null
          ? 'Not every prescribed limb is being tracked yet.'
          : 'Nothing is being tracked on this camera yet.',
      will: [],
      wont: [
        partial
          ? `Some landmarks are arriving (${Math.round(anyLandmarks * 100)} % of these readings had at least one limb in frame), but never all of the prescribed lanes at once — and a lane with no landmarks has no rest position and no repetitions to measure.`
          : 'Range of motion cannot be calibrated: the next screen measures a rest position and three repetitions, and neither exists without landmarks.',
        'A lane with no landmarks cannot trigger, so it would score nothing whatever the patient does.',
      ],
      action: partial
        ? 'Step back, or move the camera, until every prescribed limb is inside the preview at once. This clears by itself as soon as they all are.'
        : 'Get the whole limb into frame, lit from the front, and check the preview shows the skeleton before going on. This clears by itself as soon as the model sees the patient.',
    };
  }

  if (q.samples < READINESS_SAMPLES) {
    return {
      kind: 'measuring',
      gate: true,
      headline: `Checking what this device can do… (${q.samples} of ${READINESS_SAMPLES} readings)`,
      will: [],
      wont: [],
      action: null,
    };
  }

  /**
   * NO FRAME RATE AT ALL. A stream that is being sampled but is processing zero frames a second is
   * not a device "with limits", it is a device with no measurement on it.
   *
   * This used to fall through: `frameIntervalMs` returns null when the median is 0, the timing
   * branch was therefore skipped, and the screen printed "This device will run the session, with
   * limits: 0 fps, landmarks usable for 84 % of the session" — a dead frame rate reported as a
   * condition the session would run with. Nothing downstream can be measured from frames that are
   * not arriving, so it is blocked, and (like every gate here) it clears by itself the moment one
   * frame is processed.
   */
  if (interval === null) {
    return {
      kind: 'blocked',
      gate: true,
      headline: 'No frames are being processed on this camera.',
      will: [],
      wont: [
        'Nothing can be measured: a repetition is only ever seen in a frame, and no frame has been processed in these readings.',
        `Neither hit window in this prescription can be reached (perfect ±${w.perfectMs} ms, good ±${w.goodMs} ms on ${w.difficulty}), because nothing is being timed.`,
      ],
      action:
        'Restart the camera. If it comes back at the same rate, close other applications and browser tabs, or run this session on another device. This clears by itself as soon as frames start arriving.',
    };
  }

  // TOO SLOW FOR ANY WINDOW IN FORCE. A movement is only ever seen in the frame it was sampled in, so
  // once one frame interval is longer than the WIDEST window the prescription grants, a correctly
  // performed rep cannot be placed inside a hit window at all — the song would judge the camera.
  if (interval !== null && interval > w.goodMs) {
    return {
      kind: 'blocked',
      gate: true,
      headline: `This device is processing ${q.fpsMedian.toFixed(0)} frames per second — one frame every ${interval} ms.`,
      will: [],
      wont: [
        `The widest hit window in this prescription is ±${w.goodMs} ms (${w.difficulty}), shorter than the gap between two frames: a correctly performed repetition cannot be placed inside it, so the session would score the camera and not the patient.`,
        `Range of motion would be measured from ${q.fpsMedian.toFixed(0)} peaks a second, so every range would come out lower than the patient's real one.`,
      ],
      action: cpu
        ? `Inference is running on the CPU at ${q.inferenceMsMedian.toFixed(0)} ms a frame. Close other applications and browser tabs, or run this session on a device with graphics acceleration. Restarting the camera re-measures this device. Going on anyway still plays the song and still records the movements, with the timing and the ranges qualified by these conditions; the keyboard session measures no range of motion at all but plays the song.`
        : `Close other applications and browser tabs, or run this session on a faster device. Restarting the camera re-measures this device. Going on anyway still plays the song and still records the movements, with the timing and the ranges qualified by these conditions; the keyboard session measures no range of motion at all but plays the song.`,
    };
  }

  const will: string[] = [];
  const wont: string[] = [];
  if (interval !== null) {
    will.push(`Timing is resolved no finer than ${interval} ms — one camera frame at ${q.fpsMedian.toFixed(0)} fps.`);
    if (interval <= w.perfectMs) {
      will.push(`Both hit windows in this prescription are reachable (perfect ±${w.perfectMs} ms, good ±${w.goodMs} ms on ${w.difficulty}).`);
    } else {
      wont.push(
        `The ±${w.perfectMs} ms perfect window on ${w.difficulty} is shorter than one frame here, so expect "good" rather than "perfect" even on well-timed repetitions. The ±${w.goodMs} ms good window is reachable.`,
      );
    }
    // The SAME fact, on whichever list it belongs to: at a healthy frame rate "a range is a lower
    // bound" is a statement of scope; below GOOD_DETECT_FPS it is a limit of this device, and a
    // "with limits" headline over an empty list of limits is the kind of empty warning that gets
    // trained away.
    if (q.fpsMedian >= GOOD_DETECT_FPS) {
      will.push(`Range of motion is the peak of the frames that arrive, so every range is a lower bound on the patient's real one.`);
    } else {
      wont.push(
        `Range of motion is the peak of the frames that arrive, and at ${q.fpsMedian.toFixed(0)} fps a fast repetition can peak between two frames and go unrecorded — every range measured here is a lower bound, and the calibrated range it is measured against is too.`,
      );
    }
  }
  if (q.fpsLow > 0 && q.fpsLow < q.fpsMedian - 2) {
    wont.push(`The frame rate dips to ${q.fpsLow.toFixed(0)} fps in the worst stretches, so some repetitions will be measured more coarsely than others.`);
  }
  if (q.trackedFraction >= GOOD_TRACKED_FRACTION) {
    will.push(`Landmarks were usable for ${seenPct} % of this check.`);
  } else {
    wont.push(
      `Landmarks were usable for only ${seenPct} % of this check: the rest was not "no movement", it was not measured. Re-frame the patient before calibrating, or that share of the reps goes unrecorded.`,
    );
  }
  if (cpu) {
    will.push(`Inference is on the CPU at ${q.inferenceMsMedian.toFixed(0)} ms a frame (no graphics acceleration on this device).`);
  }

  const grade = trackingGrade(q);
  if (grade === 'good' && wont.length === 0) {
    return {
      kind: 'ready',
      gate: false,
      headline: `This device will support the whole prescription: ${trackingConditions(q)}.`,
      will,
      wont,
      action: null,
    };
  }
  return {
    kind: 'degraded',
    gate: false,
    headline: `This device will run the session, with limits: ${trackingConditions(q)}.`,
    will,
    wont,
    action:
      q.fpsMedian < GOOD_DETECT_FPS
        ? 'Closing other applications and browser tabs is the one thing that reliably raises the frame rate. The session is recorded with these conditions on it either way.'
        : 'The session is recorded with these conditions on it, and every figure it produces is qualified by them.',
  };
}
