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
import type { SongManifest } from '../audio/manifest.ts';
import { attributionText } from '../audio/manifest.ts';
import { laneLabel } from '../render/palette.ts';
import { compensationKind } from '../vision/features.ts';
import type { RomCalibration } from '../vision/calibration.ts';
import type { LaneRepStats, RunSummary } from './GameRunner.ts';
import type { InputMode, LaneResultSummary, SessionConfig, SessionResult } from './types.ts';

export interface BuildResultOptions {
  summary: RunSummary;
  config: SessionConfig;
  manifest?: SongManifest | null;
  inputMode: InputMode;
  latencyOffsetSec: number;
  calibrations?: (RomCalibration | null)[];
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
      label: laneLabel(spec),
      hits: stats?.hits ?? 0,
      perfects: stats?.perfects ?? 0,
      goods: stats?.goods ?? 0,
      misses: stats?.misses ?? 0,
      judged: stats?.judged ?? 0,
      accuracy: stats?.accuracy ?? 0,
      // The rep count the input source actually observed is the better number when it has one
      // (a movement that never reached the hit threshold is still a rep the patient performed).
      reps: Math.max(stats?.reps ?? 0, reps?.reps ?? 0),
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
    health: results.health,
    timingBiasMs: results.timingBiasMs,
    timingBiasMadMs: results.timingBiasMadMs,
    latencyOffsetMs: Math.round(opts.latencyOffsetSec * 1000),
    suggestedLatencyMs: summary.suggestedLatencySec === null ? null : Math.round(summary.suggestedLatencySec * 1000),
    completed: summary.completed,
    lanes,
  };
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
