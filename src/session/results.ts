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
import { formatFeature } from '../vision/calibration.ts';
import type { RomCalibration } from '../vision/calibration.ts';
import type { LaneRepStats, RunSummary } from './GameRunner.ts';
import type { InputMode, LaneResultSummary, Patient, SessionConfig, SessionEndReason, SessionResult, TrackingQuality } from './types.ts';
import { TRACKING_NOT_RECORDED, trackingSentence } from './tracking.ts';

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
 */
export function endReasonLabel(reason: SessionEndReason | null | undefined): string {
  if (reason === 'quit') return 'stopped by therapist';
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

function laneLine(l: LaneResultSummary): string {
  const parts = [`${l.movementName}: ${l.reps} reps`, `${formatPercent(l.accuracy)} accuracy`];
  if (l.romSamples > 0) {
    parts.push(`ROM mean ${formatPercent(l.romMean)} / best ${formatPercent(l.romBest)} of the calibrated range`);
    if (l.calibratedMin !== null && l.calibratedMax !== null) {
      parts.push(`range calibrated ${l.calibratedMin.toFixed(2)}–${l.calibratedMax.toFixed(2)}${l.calibrationManual ? ' (set by hand)' : ''}`);
    }
  } else {
    parts.push('range not measured');
  }
  if (l.compensationKind === null) parts.push('no compensation monitored for this movement');
  else if (!l.compensationMonitored) parts.push(`${l.compensationKind.replace('_', ' ')} not measured`);
  else parts.push(`${l.compensationFlags} rep(s) flagged for ${l.compensationKind.replace('_', ' ')}`);
  return `    - ${parts.join(' · ')}`;
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
  lines.push('');

  for (const s of sessions) {
    lines.push(`${formatDate(s.startedAt)} — ${s.songTitle} · ${s.mode === 'leg' ? 'Leg' : 'Hand'} · ${s.difficulty}${s.completed ? '' : ` · ${endReasonLabel(s.endReason)}`}`);
    if (s.inputMode !== 'camera') {
      lines.push(`    NOT THE PATIENT'S PERFORMANCE — this run was driven by ${s.inputMode}.`);
    }
    // THE WORK FIRST, THE GRADE AFTER — the same ordering the Results screen was corrected to. This
    // is the copy that goes into the notes and off the device, and it used to open every session
    // line with "4,200 pts · 1 stars", i.e. a grade on an impairment in the durable artefact.
    lines.push(
      `    ${s.reps} movements performed · ${s.hits} of ${s.hits + s.misses} notes answered in time · ` +
        `${formatDuration(s.durationSec)}` +
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
