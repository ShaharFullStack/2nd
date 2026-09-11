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
import { answerRateOf } from '../engine/scoring.ts';
import type { SongManifest } from '../audio/manifest.ts';
import { attributionText } from '../audio/manifest.ts';
import type { Fingertip, Movement, Side } from '../engine/types.ts';
import { compensationKind, FINGERTIP_NAME, MOVEMENT_INFO } from '../vision/features.ts';
import type { RomCalibration } from '../vision/calibration.ts';
import type { LaneRepStats, RunSummary } from './GameRunner.ts';
import type { InputMode, LaneResultSummary, Patient, SessionConfig, SessionEndReason, SessionResult } from './types.ts';

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

export interface BuildResultOptions {
  summary: RunSummary;
  config: SessionConfig;
  manifest?: SongManifest | null;
  inputMode: InputMode;
  latencyOffsetSec: number;
  calibrations?: (RomCalibration | null)[];
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
    reps: results.reps,
    // The gauge's quantity under its own name, plus the movements it does NOT contain (see
    // session/types.ts: `health` meant three different things over this record's life).
    //
    // WITHOUT THE WARM-UP (warmup = 0). The live gauge holds its needle up over the opening notes so
    // a single missed first note does not empty it seconds after the count-in; a stored clinical
    // record must be the measurement itself, or a session abandoned after three notes would be
    // filed as near-perfect.
    answerRate: answerRateOf(results.attempted, results.hits + results.misses, 0),
    surplusMovements: results.surplus,
    // THE DOSE THAT WAS GIVEN. Without it a rep count from last week is not comparable with today's.
    ...(config.laneRestSec !== undefined ? { laneRestSec: config.laneRestSec } : {}),
    timingBiasMs: results.timingBiasMs,
    timingBiasMadMs: results.timingBiasMadMs,
    latencyOffsetMs: Math.round(opts.latencyOffsetSec * 1000),
    suggestedLatencyMs: summary.suggestedLatencySec === null ? null : Math.round(summary.suggestedLatencySec * 1000),
    completed: summary.completed,
    endReason: summary.endReason,
    lanes,
  };
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
        `${s.laneRestSec === undefined ? ' · pacing not recorded' : ` · pacing ${s.laneRestSec.toFixed(1)} s between reps of one limb (${Math.round(60 / s.laneRestSec)} reps/min per limb at most)`}`,
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
    for (const l of s.lanes) lines.push(laneLine(l));
    lines.push('');
  }
  if (sessions.length === 0) lines.push('No sessions recorded for this patient.');

  const json = JSON.stringify(
    {
      app: 'beat-rehab',
      format: 'patient-record',
      /**
       * VERSION 2. v1 records carry `health`, a field whose MEANING changed underneath a stable key
       * (rock meter → movements-per-note-offered). v2 drops it and states the quantity by name:
       * `answerRate` (notes answered with a movement, bounded by notes offered) with
       * `surplusMovements` beside it, and `laneRestSec` — the pacing the session was prescribed at,
       * without which no two sessions' rep counts are comparable.
       */
      version: 2,
      fields: {
        answerRate: 'notes answered with a movement / notes offered (0..1); absent on sessions recorded before v2',
        surplusMovements: 'movements that answered no note (reps - notes answered)',
        laneRestSec: 'prescribed minimum seconds between two reps of one limb; absent = not recorded',
        health: 'REMOVED in v2 — v1 records may carry it, and it is NOT the same quantity as answerRate',
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
