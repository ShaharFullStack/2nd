/**
 * Turn a finished run into the therapist's record: score, per-lane accuracy, reps, ROM achieved
 * against what was calibrated, timing bias and compensation flags.
 *
 * Two rules from the rehab side are enforced here rather than in the UI:
 *  - `reps` is what the patient PERFORMED (hits + movements that matched no note), never `hits`.
 *    A session with 0 hits and 90 reps is a calibration failure, and the difference must be visible.
 *  - "no compensation flags" and "compensation was never measured" are different states
 *    (`compensationMonitored`), so a session with no rest baseline never reads as a clean one.
 */
import { limbRepsPerMinuteAt, repsPerMinuteAt } from '../charts/generate.ts';
import { answerRateOf } from '../engine/scoring.ts';
import type { SongManifest } from '../audio/manifest.ts';
import { attributionText } from '../audio/manifest.ts';
import type { Fingertip, Mode, Movement, Side } from '../engine/types.ts';
import { compensationKind, FINGERTIP_NAME, MOVEMENT_INFO } from '../vision/features.ts';
import { FEATURE_UNIT_SHORT, formatFeature } from '../vision/calibration.ts';
import type { RomCalibration } from '../vision/calibration.ts';
import type { LaneRepStats, RunSummary } from './GameRunner.ts';
import type { InputMode, LaneResultSummary, Patient, SessionConfig, SessionEndReason, SessionResult, TrackingQuality } from './types.ts';
import { TRACKING_NOT_RECORDED, calibrationConditions, calibrationGrade, trackingSentence } from './tracking.ts';

/**
 * The FULL clinical name of a lane: side, the movement's real name, and the prescribed digit.
 *
 * The record keeps THIS, never `render/palette.ts`'s `laneLabel` ("L knee ext", "L little pinch").
 * That one is cut to fit under a ~46 px lane on the canvas and is the only place it belongs; a stored
 * clinical record is read months later, exported, and possibly printed, where an abbreviation nobody
 * outside this app defines is not a movement name. Same string as the UI's `laneName`.
 */
export function clinicalLaneName(spec: { movement: Movement; side: Side; fingertip?: Fingertip }): string {
  const side = spec.side === 'left' ? 'Left' : 'Right';
  const tip = spec.movement === 'finger_opposition' ? ` (${FINGERTIP_NAME[spec.fingertip ?? 'index']})` : '';
  return `${side} ${MOVEMENT_INFO[spec.movement].label}${tip}`;
}

/**
 * WHAT THIS APP IS, IN ONE SENTENCE, WHEREVER A MEASUREMENT IS READ.
 *
 * This used to live only in the README. Meanwhile the app presented degrees, ranges, timing bias in
 * milliseconds, per-limb trends across weeks and an exported "patient record" — everything a
 * clinical instrument presents, with nothing anywhere on screen or in the file saying it is not one.
 * A therapist reading a six-week ROM trend off a tablet, or a colleague reading the exported file
 * with the app nowhere in sight, had no way to know what produced the numbers.
 *
 * ONE SENTENCE, EVERY SCREEN THAT SHOWS A MEASUREMENT, EVERY EXPORT — and nothing to dismiss. A
 * modal that has to be clicked away each session is a sentence nobody reads by the third day; a
 * quiet line under the figures it qualifies is read whenever the figures are.
 */
export const SCOPE_STATEMENT =
  'Beat Rehab is a movement game, not a clinical measurement instrument. These figures are webcam ' +
  'estimates recorded during play, for a clinician to interpret alongside their own assessment — ' +
  'not a diagnosis, and not a substitute for measuring the joint.';

/** The same statement short enough to sit under a card without becoming furniture. */
export const SCOPE_SHORT = 'A movement game, not a measuring instrument: webcam estimates for a clinician to interpret.';

export interface BuildResultOptions {
  summary: RunSummary;
  config: SessionConfig;
  manifest?: SongManifest | null;
  inputMode: InputMode;
  latencyOffsetSec: number;
  calibrations?: (RomCalibration | null)[];
  /**
   * How the camera was tracking while this run was measured (session/tracking.ts). Omitted for a
   * run with no camera — the record then says tracking was not recorded, which is the truth.
   */
  tracking?: TrackingQuality | null;
  /**
   * The patient's display name at the time of the run, copied onto the record so an export is legible
   * away from this device. The ID comes from `config.patientId` — the prescription, not the store,
   * decides whose session this is.
   */
  patientName?: string;
  /** Injectable for tests. */
  now?: () => number;
  id?: string;
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

export function newSessionId(now: number = Date.now()): string {
  const rand = Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
  return `s${now.toString(36)}-${rand}`;
}

export function buildSessionResult(opts: BuildResultOptions): SessionResult {
  const { summary, config, manifest } = opts;
  const results = summary.results;
  const now = opts.now ?? Date.now;

  const lanes: LaneResultSummary[] = config.lanes.map((spec, i) => {
    const stats = results.lanes[i];
    const reps: LaneRepStats | undefined = summary.laneReps[i];
    const peaks = reps?.peaks ?? [];
    const cal = opts.calibrations?.[i] ?? null;
    return {
      lane: i,
      movement: spec.movement,
      side: spec.side,
      ...(spec.movement === 'finger_opposition' ? { fingertip: spec.fingertip ?? 'index' } : {}),
      movementName: clinicalLaneName(spec),
      hits: stats?.hits ?? 0,
      perfects: stats?.perfects ?? 0,
      goods: stats?.goods ?? 0,
      misses: stats?.misses ?? 0,
      judged: stats?.judged ?? 0,
      accuracy: stats?.accuracy ?? 0,
      // The rep count the input source actually observed is the better number when it has one
      // (a movement that never reached the hit threshold is still a rep the patient performed).
      reps: Math.max(stats?.reps ?? 0, reps?.reps ?? 0),
      attempted: stats?.attempted ?? 0,
      surplus: stats?.surplus ?? 0,
      timingBiasMs: stats?.timingBiasMs ?? null,
      timingBiasMadMs: stats?.timingBiasMadMs ?? null,
      romMean: mean(peaks),
      romBest: peaks.length > 0 ? Math.max(...peaks) : null,
      romSamples: peaks.length,
      romUncertain: reps?.uncertain ?? 0,
      calibratedMin: cal ? cal.min : null,
      calibratedMax: cal ? cal.max : null,
      calibrationManual: cal?.manual === true,
      // The uncertainty on the DENOMINATOR travels with the percentages taken against it.
      calibrationMeasurement: cal?.measurement ?? null,
      // The movement decides WHETHER a compensation is monitored; the run decides whether it was
      // actually measured. Reading the kind off the observed events would report "n/a" for a lane
      // that monitors heel lift but produced no rep data, which reads as "nothing to check".
      compensationKind: reps?.compensationKind ?? compensationKind(spec.movement),
      compensationMonitored: reps?.compensationMonitored ?? false,
      compensationFlags: reps?.compensationFlags ?? 0,
      compensationWorst: reps?.compensationWorst ?? null,
    };
  });

  /**
   * THE HEADLINE COUNT IS THE SUM OF THE COLUMN UNDER IT. NOT A SECOND OPINION ABOUT IT.
   *
   * `results.reps` is the ENGINE's count — one per input event it was handed. Each lane's `reps`
   * above is `max(that, the reps the input source actually observed)`, which is the right number
   * (a crossing swallowed by the camera's refractory window reports a rep and emits no input event;
   * a movement that never reached the hit threshold is still a rep). Summing the engine's total
   * while printing the per-lane maxima under it let the report print "Movements performed 126" over
   * a per-movement column that added up to more than 126 — the headline contradicted by its own
   * table, in the one figure this screen exists to lead with.
   *
   * So the headline is the column's own total, and `surplusMovements` — the movements that answered
   * no note — is re-derived from it rather than from the engine's smaller total, or the two figures
   * on the same card would disagree by the same difference.
   */
  const repsTotal = lanes.reduce((n, l) => n + l.reps, 0);
  const attemptedTotal = lanes.reduce((n, l) => n + (l.attempted ?? 0), 0);

  return {
    id: opts.id ?? newSessionId(now()),
    patientId: config.patientId,
    patientName: opts.patientName ?? '',
    startedAt: summary.startedAt || now(),
    endedAt: summary.endedAt || now(),
    durationSec: Math.max(0, summary.songTime),
    mode: config.mode,
    difficulty: config.difficulty,
    windowScale: config.windowScale,
    inputMode: opts.inputMode,
    songId: config.songId,
    songTitle: manifest?.title ?? 'Silent session',
    artist: manifest?.artist ?? '',
    attribution: manifest ? attributionText(manifest) : '',
    score: results.score,
    stars: results.stars,
    accuracy: results.accuracy,
    starAccuracy: results.starAccuracy,
    maxCombo: results.maxCombo,
    totalNotes: results.totalNotes,
    hits: results.hits,
    perfects: results.perfects,
    goods: results.goods,
    misses: results.misses,
    reps: repsTotal,
    // The gauge's quantity under its own name, plus the movements it does NOT contain (see
    // session/types.ts: `health` meant three different things over this record's life).
    //
    // WITHOUT THE WARM-UP (warmup = 0). The live gauge holds its needle up over the opening notes so
    // a single missed first note does not empty it seconds after the count-in; a stored clinical
    // record must be the measurement itself, or a session abandoned after three notes would be
    // filed as near-perfect.
    answerRate: answerRateOf(results.attempted, results.hits + results.misses, 0),
    surplusMovements: Math.max(0, repsTotal - attemptedTotal),
    // THE DOSE THAT WAS GIVEN. Without it a rep count from last week is not comparable with today's.
    ...(config.laneRestSec !== undefined ? { laneRestSec: config.laneRestSec } : {}),
    timingBiasMs: results.timingBiasMs,
    timingBiasMadMs: results.timingBiasMadMs,
    latencyOffsetMs: Math.round(opts.latencyOffsetSec * 1000),
    suggestedLatencyMs: summary.suggestedLatencySec === null ? null : Math.round(summary.suggestedLatencySec * 1000),
    completed: summary.completed,
    endReason: summary.endReason,
    // THE CONDITIONS THE FIGURES ABOVE WERE MEASURED IN. Only written when something was actually
    // observed: a keyboard or autoplay run has no camera, and an all-zero block would read as a
    // camera session with a dead stream.
    ...(opts.tracking ? { tracking: opts.tracking } : {}),
    lanes,
  };
}

/**
 * ONE LANE'S RANGE, IN ITS OWN UNITS — the presentation of `LaneResultSummary` the screens share.
 *
 * WHY THIS IS PER LANE AND NEVER A MAXIMUM ACROSS THEM. The results screen used to headline
 * `max(romBest)` over every lane and call it "RANGE ACHIEVED". A hemiparetic prescription is
 * deliberately mixed — the affected limb and an unaffected one, so the patient has a lane they can
 * actually score in — and a maximum over a mixed set picks the STRONG side essentially every time.
 * The headline then celebrated the limb the patient did not come about, and the limb they did come
 * about was a row in a table below the fold.
 *
 * The obvious alternative — headline "the affected side" — is not available and must not be faked:
 * `Patient` stores a display name and an id and nothing else, on purpose (see session/types.ts), so
 * this app does not know which side is affected and cannot be made to guess it from the data. Any
 * inference (the lower score? the smaller range?) would be a clinical claim invented by a UI.
 *
 * So the headline is PER LIMB: every prescribed movement, in prescription order, each against its
 * OWN calibrated range, with no single winner. Where an earlier camera session exists, the movement
 * that GAINED the most is named (`gain`/`gainPct`) — that is the one honest way to single one out,
 * because it is about change in the patient, not about which limb is stronger.
 */
export interface LaneRangeSummary {
  lane: number;
  movementName: string;
  movement: Movement;
  side: Side;
  unit: 'deg' | 'ratio';
  /** True when this lane recorded at least one rep peak. */
  measured: boolean;
  /** Best rep as a fraction of the range calibrated today (0..1), or null. */
  bestFraction: number | null;
  /** Mean rep, same units. */
  meanFraction: number | null;
  /** Best rep in the movement's own units (degrees / body-scaled ratio), or null when no range. */
  best: number | null;
  /** Mean rep, same units. */
  mean: number | null;
  /** Change in the absolute best rep against the previous camera session, or null. */
  gain: number | null;
  /** Change in the best rep as a fraction of the calibrated range, or null. */
  gainPct: number | null;
  reps: number;
}

/** `calibratedMin + fraction x span` — the rep in the movement's own units, or null. */
function absoluteOf(l: LaneResultSummary, fraction: number | null): number | null {
  if (l.romSamples <= 0 || fraction === null || l.calibratedMin === null || l.calibratedMax === null) return null;
  const v = l.calibratedMin + fraction * (l.calibratedMax - l.calibratedMin);
  return Number.isFinite(v) ? v : null;
}

/** The key a movement's history is tracked under (movement + side + fingertip), as in trends.ts. */
export function laneTrendKey(l: Pick<LaneResultSummary, 'movement' | 'side' | 'fingertip'>): string {
  return l.fingertip ? `${l.movement}:${l.side}:${l.fingertip}` : `${l.movement}:${l.side}`;
}

/**
 * Every prescribed lane's range, in prescription order, each compared only with ITSELF last time.
 * `previous` is the same patient's previous CAMERA session's lanes (keyed by `laneTrendKey`), or
 * empty when there is none.
 */
export function laneRangeSummaries(
  lanes: readonly LaneResultSummary[],
  previous?: ReadonlyMap<string, LaneResultSummary>,
): LaneRangeSummary[] {
  return lanes.map((l) => {
    const was = previous?.get(laneTrendKey(l)) ?? null;
    const bestFraction = l.romSamples > 0 ? l.romBest : null;
    const meanFraction = l.romSamples > 0 ? l.romMean : null;
    const best = absoluteOf(l, bestFraction);
    const wasBest = was ? absoluteOf(was, was.romSamples > 0 ? was.romBest : null) : null;
    const wasBestFraction = was && was.romSamples > 0 ? was.romBest : null;
    return {
      lane: l.lane,
      movementName: l.movementName,
      movement: l.movement,
      side: l.side,
      unit: MOVEMENT_INFO[l.movement]?.unit ?? 'ratio',
      measured: l.romSamples > 0,
      bestFraction,
      meanFraction,
      best,
      mean: absoluteOf(l, meanFraction),
      gain: best !== null && wasBest !== null ? best - wasBest : null,
      gainPct: bestFraction !== null && wasBestFraction !== null ? bestFraction - wasBestFraction : null,
      reps: l.reps,
    };
  });
}

/**
 * The smallest change in a movement's OWN calibrated range that this app will call a change: half a
 * point. Below it the difference is inside what one camera frame's peak can move, and the screens
 * say "same as last time" — see `rangeChange`.
 */
export const MIN_GAIN_PCT = 0.005;

/** How a lane's change since last time may be spoken about. One rule, shared by every surface. */
export type RangeChangeKind = 'up' | 'down' | 'same' | 'none';

export interface RangeChange {
  kind: RangeChangeKind;
  /** True when the change is large enough to be printed in the movement's OWN units. */
  inUnits: boolean;
}

/**
 * IS THERE A CHANGE HERE AT ALL, AND MAY IT BE NAMED?
 *
 * The one rule, in one place, because two surfaces were applying two. `mostImprovedRange` accepted
 * any `gainPct > 0` while the tile beside it printed "same as last time" for anything under both the
 * movement's unit resolution and half a point of range — so a knee that moved 0.15° rendered "same
 * as last time" and "biggest gain today" one under the other, and the card header named that limb
 * as the day's achievement on a change it had just declared unmeasurable. On a mixed prescription
 * that limb is the unaffected one, which is the exact failure the per-limb headline was built to
 * end, reintroduced one element to the right of the fix.
 *
 * A change is real when it is resolvable in the movement's own units, OR when it is at least
 * `MIN_GAIN_PCT` of that movement's own calibrated range. Anything else is 'same'.
 */
export function rangeChange(s: Pick<LaneRangeSummary, 'gain' | 'gainPct' | 'unit'>): RangeChange {
  if (s.gain === null && s.gainPct === null) return { kind: 'none', inUnits: false };
  if (s.gain !== null && formatFeature(Math.abs(s.gain), s.unit) !== formatFeature(0, s.unit)) {
    return { kind: s.gain > 0 ? 'up' : 'down', inUnits: true };
  }
  if (s.gainPct !== null && Math.abs(s.gainPct) >= MIN_GAIN_PCT) {
    return { kind: s.gainPct > 0 ? 'up' : 'down', inUnits: false };
  }
  return { kind: 'same', inUnits: false };
}

/**
 * THE STEP `formatFeature` PRINTS IN, and the bound a change too small for it actually satisfies.
 *
 * `formatFeature` rounds a joint angle to whole degrees (`Math.round`) and a body-scaled ratio to two
 * places (`toFixed`), so the finest step it can show is 1° / 0.01 — and a change that prints as no
 * change at all is strictly under HALF of that.
 *
 * BOTH NUMBERS HAVE TO EXIST, because the caption that states them used to state neither: it printed
 * `formatFeature(1, unit)`, which is "1°" (twice the true bound) for degrees and "1.00" for a
 * ratio — a hundred times the step, and a whole unit of a quantity whose entire calibrated range is
 * routinely less than 1.0. A therapist reading "the change is under 1.00" on a seated march was being
 * told the measurement was useless when it was resolved to 0.005.
 */
export const FEATURE_STEP: Readonly<Record<'deg' | 'ratio', number>> = Object.freeze({ deg: 1, ratio: 0.01 });

/** The finest difference this app prints in that unit, as it is written ("1°", "0.01"). */
export function featureStepLabel(unit: 'deg' | 'ratio'): string {
  return unit === 'deg' ? '1°' : '0.01';
}

/**
 * The true bound on a change that `formatFeature` rounds away to nothing, as it is written
 * ("0.5°", "0.005"). This is what `belowResolution` on the Results screen actually tests.
 */
export function subResolutionBound(unit: 'deg' | 'ratio'): string {
  return unit === 'deg' ? '0.5°' : '0.005';
}

/**
 * The whole sentence the Results tile prints under a change it had to state in points of range.
 *
 * One place, because the number in it is a property of `formatFeature` and nothing else, and because
 * the screen that shows it must not be able to invent a different bound from the one the formatter
 * really applies.
 */
export function subResolutionNote(unit: 'deg' | 'ratio'): string {
  return (
    `in points of this movement’s own calibrated range: the change is under ${subResolutionBound(unit)}, ` +
    `finer than the ${featureStepLabel(unit)} this screen prints ` +
    `${unit === 'deg' ? 'degrees' : 'a body-scaled ratio'} to`
  );
}

/**
 * The movement that gained the most against its own previous session, or null when nothing gained.
 *
 * THE ONLY SINGLING-OUT THIS SCREEN DOES. It ranks a patient against themselves per limb, so it can
 * never hand the headline to the strong side for being strong: a knee that went 61° → 62° does not
 * out-rank a seated march that went 0.21 → 0.29, because the two are never compared — each lane's
 * gain is expressed as a fraction of its OWN calibrated range before they are ordered.
 *
 * AND THE GAIN HAS TO BE ONE. A ranking with no resolution floor named a limb "biggest gain today"
 * on 0.15° — a difference the same screen prints as "same as last time", and one smaller than the
 * peak of a single dropped camera frame. `rangeChange` is the floor, and it is the same one the
 * badge beside the figure uses, so the two can no longer describe one number differently.
 */
export function mostImprovedRange(summaries: readonly LaneRangeSummary[]): LaneRangeSummary | null {
  let best: LaneRangeSummary | null = null;
  for (const s of summaries) {
    if (s.gainPct === null || s.gainPct <= 0) continue;
    if (rangeChange(s).kind !== 'up') continue;
    if (best === null || (s.gainPct as number) > (best.gainPct as number)) best = s;
  }
  return best;
}

/**
 * WHAT ENDED A SESSION, in the words a therapist needs.
 *
 * "Ended early" covers a clinical decision and a flat battery equally, and they are not the same
 * fact: one is "the patient had had enough at 40 s", the other is "the equipment dropped the
 * session" — and the runner has always known which. A record stored before the reason was persisted
 * says exactly the old thing rather than picking one of the two.
 *
 * `quit` used to read "stopped on purpose", which was true while ending a run meant pressing a
 * button. It does not any more: a patient alone can end their own session by holding a limb on the
 * "Stop here" target in the pause dialog, and the record cannot tell the two apart. Naming the
 * therapist would put a person who was not in the room into the clinical record, so it names the
 * only thing the runner actually knows — that somebody chose to stop.
 */
export function endReasonLabel(reason: SessionEndReason | null | undefined): string {
  if (reason === 'quit') return 'stopped on purpose';
  if (reason === 'abandoned') return 'interrupted';
  return 'ended early';
}

/** "1 260 pts · 78 % · 3 stars" style one-liner for the History table. */
export function formatPercent(v: number | null | undefined, digits = 0): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return `${(v * 100).toFixed(digits)}%`;
}

export function formatMs(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const sign = v > 0 ? '+' : '';
  return `${sign}${Math.round(v)} ms`;
}

export function formatDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * The LIMB a lane is prescribed on — which is what a DOSE is prescribed for, and what two lanes can
 * share. One session is one mode, so the side names the limb. Lives here, beside the export and the
 * results note, because the setup card imports it too: the three surfaces that quote this quantity
 * must not be able to name it differently.
 */
export function limbLabel(side: string, mode: Mode): string {
  const which = side === 'left' ? 'Left' : 'Right';
  return `${which} ${mode === 'leg' ? 'leg' : 'hand'}`;
}

/** The busiest limb in a prescription: its side, and how many lanes are on it. */
export function busiestLimbOf(lanes: readonly { side: Side }[]): { side: Side; lanes: number } | null {
  const count = new Map<Side, number>();
  for (const l of lanes) count.set(l.side, (count.get(l.side) ?? 0) + 1);
  let best: { side: Side; lanes: number } | null = null;
  for (const [side, n] of count) if (!best || n > best.lanes) best = { side, lanes: n };
  return best;
}

/**
 * THE PACING, SAID THE WAY THE SETUP SCREEN SAYS IT.
 *
 * `laneRestSec` is the minimum rest between two reps of ONE LANE — one movement on one side. It is
 * NOT the rest between two reps of one limb, and the two differ by exactly the number of lanes on
 * that limb: a prescription with left knee extension AND left ankle dorsiflexion can ask the left leg
 * for a rep in each of them inside that rest. The Setup card was corrected to say so; this sentence
 * is what the RESULTS note and the EXPORTED record say, and they used to say the opposite ("1.2 s
 * between reps of one limb (50 reps/min per limb at most)"), understating the limb ceiling by the
 * number of lanes on it in the one artefact that leaves the device.
 */
export function pacingSentence(laneRestSec: number, lanes: readonly { side: Side }[], mode: Mode): string {
  const perLane = Math.round(repsPerMinuteAt(laneRestSec));
  const limb = busiestLimbOf(lanes);
  const head = `${laneRestSec.toFixed(1)} s between two reps of the same movement (at most ${perLane} reps/min per lane`;
  if (!limb || limb.lanes <= 1) return `${head}, one lane per limb so that is the limb ceiling too)`;
  return (
    `${head}; ${limb.lanes} lanes on the ${limbLabel(limb.side, mode).toLowerCase()}, so at most ` +
    `${Math.round(limbRepsPerMinuteAt(laneRestSec, limb.lanes))} reps/min for that limb)`
  );
}

/** Clock time alone ("14:02") — a visit happens inside one day, so the date is stated once. */
export function formatTime(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString(undefined, { timeStyle: 'short' });
  } catch {
    return new Date(ts).toISOString().slice(11, 16);
  }
}

// ------------------------------------------------------------------ several songs, or several visits

/**
 * THE LONGEST QUIET STRETCH THAT IS STILL ONE APPOINTMENT.
 *
 * A song is 97 seconds and the Results screen ends with a "Play again" button, so a 40-minute
 * physiotherapy slot produces three, five, eight rows in the history table — and read down that
 * table they are indistinguishable from three, five, eight visits. "Eight sessions this fortnight"
 * is then a claim about attendance that the record does not support.
 *
 * 45 minutes is chosen to swallow everything that really happens inside one appointment — camera
 * setup, ROM calibration per lane, the latency check, a rest, a transfer back to the chair, a
 * conversation — while staying under the gap between two slots on one therapist's list.
 */
export const VISIT_GAP_MS = 45 * 60 * 1000;

/**
 * SAID WHEREVER THE GROUPING IS SHOWN. This app is never told when an appointment was: it has
 * timestamps, and the grouping is an inference from them. A visit header that did not say so would be
 * presenting a clinical fact (attendance) that nothing in the record actually contains.
 */
export const VISIT_LEGEND =
  'VISITS: runs recorded within 45 minutes of each other are grouped as one visit. This is inferred ' +
  'from the clock — the app is never told when an appointment starts or ends — so a long break inside ' +
  'one session will read as two visits, and two slots back to back may read as one.';

/** One appointment's worth of runs, as `groupVisits` infers it. */
export interface Visit {
  /** Stable key: the id of the EARLIEST run in the visit. */
  id: string;
  /** When the first run of the visit started and the last one ended (epoch ms). */
  startedAt: number;
  endedAt: number;
  /** The visit's runs, newest first — the order the history table lists them in. */
  sessions: SessionResult[];
  /** Movements performed across the whole visit, and the song time those runs covered. */
  reps: number;
  songSec: number;
  /** How many of the runs were camera runs (the only ones that measure the patient). */
  cameraSessions: number;
}

/** When a run finished, from the record — falling back to its own stated length. */
function endOfSession(s: SessionResult): number {
  if (Number.isFinite(s.endedAt) && s.endedAt > s.startedAt) return s.endedAt;
  return s.startedAt + Math.max(0, Number.isFinite(s.durationSec) ? s.durationSec : 0) * 1000;
}

/**
 * Group runs into visits. Order-independent in, NEWEST VISIT FIRST out, each visit's own runs newest
 * first, so it drops straight into the history table without re-sorting anything.
 */
export function groupVisits(sessions: readonly SessionResult[], gapMs: number = VISIT_GAP_MS): Visit[] {
  const asc = [...sessions].sort((a, b) => a.startedAt - b.startedAt);
  const out: Visit[] = [];
  let current: SessionResult[] = [];
  let currentEnd = -Infinity;
  const flush = (): void => {
    if (current.length === 0) return;
    const runs = [...current].reverse();
    out.unshift({
      id: current[0].id,
      startedAt: current[0].startedAt,
      endedAt: current.reduce((t, s) => Math.max(t, endOfSession(s)), current[0].startedAt),
      sessions: runs,
      reps: runs.reduce((n, s) => n + (Number.isFinite(s.reps) ? s.reps : 0), 0),
      songSec: runs.reduce((n, s) => n + (Number.isFinite(s.durationSec) ? Math.max(0, s.durationSec) : 0), 0),
      cameraSessions: runs.filter((s) => s.inputMode === 'camera').length,
    });
    current = [];
  };
  for (const s of asc) {
    if (current.length > 0 && s.startedAt - currentEnd > gapMs) flush();
    current.push(s);
    currentEnd = Math.max(currentEnd, endOfSession(s));
  }
  flush();
  return out;
}

/** "3 songs · 14:02–14:41 · 212 movements · 4:51 of song" — one visit in one line. */
export function visitSummary(v: Visit): string {
  const runs = `${v.sessions.length} song${v.sessions.length === 1 ? '' : 's'}`;
  const span = v.endedAt > v.startedAt + 60_000 ? `${formatTime(v.startedAt)}–${formatTime(v.endedAt)}` : formatTime(v.startedAt);
  return `${runs} · ${span} · ${v.reps} movement${v.reps === 1 ? '' : 's'} · ${formatDuration(v.songSec)} of song`;
}

export function formatDate(ts: number): string {
  try {
    return new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return new Date(ts).toISOString();
  }
}

/**
 * ONE PATIENT'S WHOLE RECORD, as text that can leave the device.
 *
 * WHY THIS EXISTS. Everything this app measures lives in one browser's localStorage: it is deleted by
 * a cleared cache, a re-imaged tablet, a retention trim, or a therapist tapping "Clear". A clinical
 * record that can only be read on the device that made it, and that expires without telling anyone, is
 * not a record. This is the way out — a file to keep, and the same content on the clipboard for a note
 * or an email.
 *
 * TWO FORMS, BOTH COMPLETE, NEITHER A SCREENSHOT:
 *  - `json` is the archive: every stored field of every session, so a record can be re-read (or
 *    re-imported) later without this app's screens in front of it.
 *  - `text` is what a human reads — movements under their FULL clinical names, the figures the trend
 *    view is built from, and the same caveats the screens carry (non-camera sessions are marked as not
 *    the patient's performance; a re-calibrated range is stated, never averaged away).
 */
export interface PatientExportInput {
  patient: Patient;
  /** The patient's sessions, newest first (the order the store keeps history in). */
  sessions: readonly SessionResult[];
  /** Sessions this device has already deleted under its retention limit, when known. */
  droppedSessions?: number;
  /** The retention limit in force, so the reader knows what the file is protecting them from. */
  retentionLimit?: number;
  now?: () => number;
}

export interface PatientExport {
  filename: string;
  json: string;
  text: string;
}

/** Filesystem-safe stem for the export file: the patient's name, or their id when it is unusable. */
function exportSlug(name: string, id: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || id;
}

function isoDay(ts: number): string {
  try {
    return new Date(ts).toISOString().slice(0, 10);
  } catch {
    return 'unknown-date';
  }
}

/**
 * WHAT UNIT EVERY FIGURE BELOW IS IN, said once at the top of the file.
 *
 * The export is pasted into notes and read by people who have never opened this app. A bare
 * "0.10–0.50" means nothing to them, and neither does "62 %" without the thing it is 62 % OF.
 */
const UNITS_LEGEND =
  'UNITS: a range is given in the movement’s own units — degrees at the joint for a joint angle, or a ' +
  'body-scaled ratio (the movement measured against this patient’s own torso or palm size, which is ' +
  'what makes it comparable across sessions and cameras) for the rest. The percentage beside it is ' +
  'that rep as a share of the range CALIBRATED FOR THAT MOVEMENT IN THAT SESSION, so percentages from ' +
  'two different movements — or from two sessions calibrated apart — are not the same quantity. A rep ' +
  'is one movement performed, times are minutes:seconds, and every millisecond figure is a timing offset.';

/** `calibratedMin + fraction x span`, printed in the movement's own units. Null when unavailable. */
function laneAbsolute(l: LaneResultSummary, unit: 'deg' | 'ratio', fraction: number | null): string | null {
  if (fraction === null || l.calibratedMin === null || l.calibratedMax === null) return null;
  const v = l.calibratedMin + fraction * (l.calibratedMax - l.calibratedMin);
  return Number.isFinite(v) ? formatFeature(v, unit) : null;
}

/**
 * ONE MOVEMENT'S LINE — AND EVERY NUMBER ON IT CARRIES WHAT IT IS MEASURED IN.
 *
 * This line used to read "ROM mean 62% / best 75% of the calibrated range · range calibrated
 * 0.10–0.50". Two faults, both in the artefact that leaves the device: the range the patient actually
 * WORKED was never stated in the movement's own units at all (only as a share of a calibration the
 * reader cannot see), and the calibration bounds — the one place the units do appear — were printed
 * to two decimal places with no unit whatsoever, so a knee extension read "90.00–140.00" and a seated
 * march read "0.10–0.50" in the same column of the same file.
 */
function laneLine(l: LaneResultSummary): string {
  const unit: 'deg' | 'ratio' = MOVEMENT_INFO[l.movement]?.unit ?? 'ratio';
  const parts = [`${l.movementName}: ${l.reps} reps`, `${formatPercent(l.accuracy)} of its notes hit in time`];
  if (l.romSamples > 0) {
    const meanAbs = laneAbsolute(l, unit, l.romMean);
    const bestAbs = laneAbsolute(l, unit, l.romBest);
    parts.push(
      meanAbs !== null && bestAbs !== null
        ? `range worked: mean rep ${meanAbs}, best rep ${bestAbs} (${FEATURE_UNIT_SHORT[unit]}) = ` +
            `${formatPercent(l.romMean)} and ${formatPercent(l.romBest)} of the range calibrated for this movement`
        : `range worked: ${formatPercent(l.romMean)} mean / ${formatPercent(l.romBest)} of the range calibrated for ` +
            `this movement (the calibrated bounds were not stored, so it cannot be given in ${FEATURE_UNIT_SHORT[unit]})`,
    );
    if (l.calibratedMin !== null && l.calibratedMax !== null) {
      parts.push(
        `calibrated for this session: 0% = ${formatFeature(l.calibratedMin, unit)} at rest, ` +
          `100% = ${formatFeature(l.calibratedMax, unit)} at comfortable maximum (${FEATURE_UNIT_SHORT[unit]})` +
          `${l.calibrationManual ? ', set by hand rather than measured' : ''}`,
      );
      // AND HOW WELL THAT RANGE WAS MEASURED. Every percentage on this line is taken against it, so
      // the file that is read with no app around it has to be able to say whether the denominator
      // came off a clean stream and three agreeing reps or off a slow one and three that did not.
      parts.push(
        l.calibrationMeasurement
          ? `that range was measured at ${calibrationConditions(l.calibrationMeasurement)} (${calibrationGrade(l.calibrationMeasurement)})`
          : 'how well that range was measured was not recorded',
      );
    }
  } else {
    parts.push('range not measured');
  }
  if (l.compensationKind === null) parts.push('no compensation monitored for this movement');
  else if (!l.compensationMonitored) parts.push(`${l.compensationKind.replace('_', ' ')} not measured`);
  else parts.push(`${l.compensationFlags} rep(s) flagged for ${l.compensationKind.replace('_', ' ')}`);
  return `    - ${parts.join(' · ')}`;
}

/** One run, exactly as it appears inside a visit. Shared by the patient export and the single-session one. */
function sessionLines(s: SessionResult): string[] {
  const lines: string[] = [];
  lines.push(`  ${formatDate(s.startedAt)} — ${s.songTitle} · ${s.mode === 'leg' ? 'Leg' : 'Hand'} · ${s.difficulty}${s.completed ? '' : ` · ${endReasonLabel(s.endReason)}`}`);
  if (s.inputMode !== 'camera') {
    lines.push(`    NOT THE PATIENT'S PERFORMANCE — this run was driven by ${s.inputMode}.`);
  }
  // THE WORK FIRST, THE GRADE AFTER — the same ordering the Results screen was corrected to. This
  // is the copy that goes into the notes and off the device, and it used to open every session
  // line with "4,200 pts · 1 stars", i.e. a grade on an impairment in the durable artefact.
  lines.push(
    `    ${s.reps} movements performed · ${s.hits} of ${s.hits + s.misses} notes answered in time · ` +
      `${formatDuration(s.durationSec)} of song` +
      `${s.laneRestSec === undefined ? ' · pacing not recorded' : ` · pacing ${pacingSentence(s.laneRestSec, s.lanes, s.mode)}`}`,
  );
  if (typeof s.answerRate === 'number') {
    lines.push(
      `    Notes answered with a movement: ${formatPercent(s.answerRate)}` +
        `${typeof s.surplusMovements === 'number' ? ` · ${s.surplusMovements} movement(s) answered no note` : ''}`,
    );
  }
  lines.push(
    `    Scoring (clinical): ${s.score.toLocaleString()} pts · ${s.stars} stars · ${formatPercent(s.accuracy)} accuracy · ` +
      `timing ${formatMs(s.timingBiasMs)} · input latency ${s.latencyOffsetMs} ms`,
  );
  // WHAT THE CAMERA WAS DOING WHILE THOSE FIGURES WERE MEASURED — per session, because it differs
  // per session, which is exactly why a trend built without it can be a trend in the equipment.
  if (s.inputMode === 'camera') {
    lines.push(`    Tracking: ${s.tracking ? trackingSentence(s.tracking) : TRACKING_NOT_RECORDED}`);
  }
  for (const l of s.lanes) lines.push(laneLine(l));
  lines.push('');
  return lines;
}

export function buildPatientExport(input: PatientExportInput): PatientExport {
  const now = (input.now ?? Date.now)();
  const { patient, sessions } = input;
  const camera = sessions.filter((s) => s.inputMode === 'camera');
  const lines: string[] = [];
  lines.push('Beat Rehab — patient record');
  lines.push(`Patient: ${patient.name}${patient.unassigned ? ' (unassigned — these sessions were recorded before this device tracked patients)' : ''}`);
  // The local record id, printed because the display name is the ONLY identifier this app stores and
  // two patients on one tablet can share it. A printed record that says only "J. Smith" cannot be
  // filed against the right person; this is what the picker's disambiguator refers to.
  lines.push(`Local record id: ${patient.id}${patient.createdAt ? ` · added ${formatDate(patient.createdAt)}` : ''}`);
  lines.push(`Exported: ${formatDate(now)}`);
  lines.push(`Sessions in this file: ${sessions.length} (${camera.length} camera-measured)`);
  if (input.droppedSessions) {
    lines.push(`Note: ${input.droppedSessions} older session(s) were already deleted by this device's retention limit and are NOT in this file.`);
  }
  if (input.retentionLimit) {
    lines.push(`This device keeps at most ${input.retentionLimit} sessions per patient; older ones are deleted automatically.`);
  }
  lines.push('Only camera sessions measure the patient. Keyboard and autoplay runs are the system driving the lanes and are marked as such.');
  // THE SCOPE TRAVELS WITH THE DATA. This file is read off the device, pasted into notes and
  // printed, with nothing else around it to say what produced the numbers.
  lines.push('');
  lines.push(`SCOPE: ${SCOPE_STATEMENT}`);
  // AND THE RULE FOR SUBTRACTING ONE SESSION FROM ANOTHER, in the artefact where somebody will do
  // exactly that with a ruler and no app in front of them. Each session below states the camera
  // conditions it was measured in; two sessions measured differently are not a like-for-like pair,
  // and the difference between them is partly the equipment.
  lines.push(
    'COMPARING SESSIONS: each session below states how well the camera was tracking while it was ' +
      'measured. A change between two sessions tracked differently — or between one that recorded ' +
      'tracking quality and one that did not — is partly the equipment, not the patient.',
  );
  lines.push(UNITS_LEGEND);
  // WHICH RUNS WERE ONE APPOINTMENT. The sessions below are listed newest first and several of them
  // can be one visit; the grouping is inferred from the clock, so the file says so rather than
  // implying the app was told when the appointments were.
  lines.push(VISIT_LEGEND);
  lines.push('');

  for (const visit of groupVisits(sessions)) {
    // THE APPOINTMENT, THEN THE RUNS INSIDE IT. Read as a flat list, five "Play again" runs from one
    // 40-minute slot are five visits — a claim about attendance the record cannot support.
    lines.push(`VISIT — ${formatDate(visit.startedAt)} · ${visitSummary(visit)}`);
    for (const s of visit.sessions) for (const line of sessionLines(s)) lines.push(line);
  }
  if (sessions.length === 0) lines.push('No sessions recorded for this patient.');

  const json = JSON.stringify(
    {
      app: 'beat-rehab',
      format: 'patient-record',
      // FIRST FIELD IN THE FILE, so a reader who opens the JSON and reads nothing else has read it.
      scope: SCOPE_STATEMENT,
      /**
       * VERSION 2. v1 records carry `health`, a field whose MEANING changed underneath a stable key
       * (rock meter → movements-per-note-offered). v2 drops it and states the quantity by name:
       * `answerRate` (notes answered with a movement, bounded by notes offered) with
       * `surplusMovements` beside it, and `laneRestSec` — the pacing the session was prescribed at,
       * without which no two sessions' rep counts are comparable.
       */
      version: 3,
      fields: {
        answerRate: 'notes answered with a movement / notes offered (0..1); absent on sessions recorded before v2',
        surplusMovements: 'movements that answered no note (reps - notes answered)',
        laneRestSec:
          'prescribed minimum seconds between two reps of the SAME LANE (one movement on one side); ' +
          'NOT per limb — a limb carrying n lanes can be asked for n reps inside that rest, so its ' +
          'ceiling is n x 60/laneRestSec reps per minute. Absent = not recorded',
        health: 'REMOVED in v2 — v1 records may carry it, and it is NOT the same quantity as answerRate',
        tracking:
          'v3: the camera conditions the session was measured in — fpsMedian/fpsLow (processed frames per ' +
          'second), inferenceMsMedian, trackedFraction (share of the session with usable landmarks), ' +
          'lowFpsFraction, delegate, worstReason. Absent = not recorded (every session before v3, and every ' +
          'session with no camera). Timing is resolved no finer than one frame interval (1000/fpsMedian ms) ' +
          'and a range is the peak OF THE FRAMES THAT ARRIVED, so it is a lower bound. A DIFFERENCE ' +
          'BETWEEN TWO SESSIONS IS ONLY LIKE-FOR-LIKE WHEN BOTH CARRY THIS BLOCK AND BOTH WERE ' +
          'TRACKED WELL (fpsMedian >= 24 and trackedFraction >= 0.95); otherwise part of the change ' +
          'is the camera.',
        'lanes[].calibrationMeasurement':
          'HOW WELL THE DENOMINATOR ITSELF WAS MEASURED — romMean and romBest are percentages OF the ' +
          'calibrated range, so this is the uncertainty they inherit. frames (every frame offered to the ' +
          'calibrator, including ones with no usable landmarks), tracked and trackedFraction; fpsMedian ' +
          'and fpsLow (the rate those frames arrived at); durationSec; reps (the peaks the top of the ' +
          'range was taken from) and repSpread / repSpreadFraction (how far apart they were, in feature ' +
          'units and as a fraction of the range). The top of the range is the 90th percentile of the ' +
          'peaks, so A LOW FRAME RATE BIASES IT DOWNWARD (a peak between two frames is never seen) and ' +
          'every percentage against it then reads high. Null = not recorded: the range was set by hand, ' +
          'or captured before this existed. It is NOT the same thing as a clean measurement.',
      },
      exportedAt: now,
      patient,
      retention: { limit: input.retentionLimit ?? null, alreadyDeleted: input.droppedSessions ?? 0 },
      sessionCount: sessions.length,
      cameraSessionCount: camera.length,
      sessions,
    },
    null,
    2,
  );

  return {
    filename: `beat-rehab-${exportSlug(patient.name, patient.id)}-${isoDay(now)}.json`,
    json,
    text: lines.join('\n'),
  };
}


/**
 * ONE SESSION, ON ITS OWN, FOR THE MOMENT THE DEVICE REFUSED TO KEEP IT.
 *
 * `buildPatientExport` reads the stored history — which is exactly what does not exist when the
 * write failed. A quota-full tablet (the per-patient cap is 100 sessions, and a clinic tablet is
 * shared) leaves the only copy of a session on the Results screen, and the therapist has one thing
 * they can do about it before they navigate away: take it off the device by hand. So the Results
 * screen builds the file straight from the record in memory.
 *
 * Same two forms, same scope and unit legends, so a file rescued this way reads like any other.
 */
export interface SessionExportInput {
  result: SessionResult;
  /** Why this file was produced, when it was not a plain "export" (printed at the top). */
  reason?: string;
  now?: () => number;
}

export function buildSessionExport(input: SessionExportInput): PatientExport {
  const now = (input.now ?? Date.now)();
  const s = input.result;
  const lines: string[] = [];
  lines.push('Beat Rehab — one session');
  lines.push(`Patient: ${s.patientName || 'not recorded'}`);
  lines.push(`Local record id: ${s.patientId || 'none'} · session ${s.id}`);
  lines.push(`Exported: ${formatDate(now)}`);
  if (input.reason) lines.push(input.reason);
  lines.push('');
  lines.push(`SCOPE: ${SCOPE_STATEMENT}`);
  lines.push(UNITS_LEGEND);
  lines.push('');
  lines.push(`VISIT — ${formatDate(s.startedAt)} · 1 song · ${formatTime(s.startedAt)} · ${s.reps} movement${s.reps === 1 ? '' : 's'} · ${formatDuration(s.durationSec)} of song`);
  for (const line of sessionLines(s)) lines.push(line);

  const json = JSON.stringify(
    {
      app: 'beat-rehab',
      format: 'session-record',
      scope: SCOPE_STATEMENT,
      version: 3,
      exportedAt: now,
      ...(input.reason ? { reason: input.reason } : {}),
      sessionCount: 1,
      cameraSessionCount: s.inputMode === 'camera' ? 1 : 0,
      sessions: [s],
    },
    null,
    2,
  );

  return {
    filename: `beat-rehab-session-${exportSlug(s.patientName, s.patientId || s.id)}-${isoDay(s.startedAt)}.json`,
    json,
    text: lines.join('\n'),
  };
}
