/**
 * Cross-session rehab trend: "is this patient's range of motion getting better?".
 *
 * Everything needed is already in the persisted `SessionResult.lanes` (romMean/romBest against the
 * calibratedMin/Max in force at the time, accuracy, reps). This module turns the flat session list
 * into one series PER MOVEMENT, which is the unit a therapist actually reasons about — "left knee
 * extension", not "Tuesday's session".
 *
 * Three rules the History screen must not have to remember:
 *
 *  - A movement's series is keyed by movement + side (+ fingertip for finger_opposition), the same key
 *    the calibrations are stored under. Two different fingertips are two different quantities and must
 *    never share a line.
 *  - ROM is only plotted where it was MEASURED (`romSamples > 0`). A keyboard/autoplay session, or a
 *    camera session whose reps were all truncated, carries `romMean: null` — plotting that as 0 %
 *    would draw a collapse in range that never happened. Accuracy is always known, so it is separate.
 *  - `romMean` is a fraction of the range calibrated THAT DAY. A patient re-calibrated to a wider
 *    range can improve while their percentage falls, so the calibrated span is carried on every point
 *    and a change of span is flagged (`recalibrated`) rather than silently averaged away.
 */
import type { Movement, Side } from '../engine/types.ts';
import type { LaneResultSummary, SessionResult } from './types.ts';

/** One session's contribution to one movement's trend. */
export interface TrendPoint {
  sessionId: string;
  /** Date.now() of the session start. */
  at: number;
  /** Mean peak ROM as a fraction of the calibrated range, or null when it was not measured. */
  rom: number | null;
  /** Best single rep, same units. */
  romBest: number | null;
  /** hits / judged in this lane (0..1). Always known. */
  accuracy: number;
  reps: number;
  /** The calibrated span this session's percentages are against (feature units), when recorded. */
  calibratedSpan: number | null;
  /** True when the calibrated span differs from the previous session's by more than 5 %. */
  recalibrated: boolean;
  /** Compensation flags in this lane (0 when clean or unmonitored). */
  compensationFlags: number;
}

export interface MovementTrend {
  /** movement:side(:fingertip) — the same key the calibration store uses. */
  key: string;
  label: string;
  movement: Movement;
  side: Side;
  /** Oldest first, so a chart reads left-to-right in time. */
  points: TrendPoint[];
  /** Points whose ROM was actually measured (the ones a ROM chart can draw). */
  romPoints: TrendPoint[];
  /** First and latest MEASURED ROM, and the change between them (null when fewer than two). */
  firstRom: number | null;
  latestRom: number | null;
  romChange: number | null;
  /** Same for accuracy, over all points. */
  firstAccuracy: number | null;
  latestAccuracy: number | null;
  accuracyChange: number | null;
  /** Movements performed in this lane across the whole window. */
  totalReps: number;
  /** True when any point in the window sits on a different calibrated span than its predecessor. */
  anyRecalibration: boolean;
}

/** Default number of sessions a trend looks back over — enough to see a direction on a tablet. */
export const DEFAULT_TREND_WINDOW = 8;

/** Fractional change in the calibrated span that counts as "this was re-calibrated". */
const RECALIBRATION_TOLERANCE = 0.05;

function laneKey(l: Pick<LaneResultSummary, 'movement' | 'side' | 'fingertip'>): string {
  return l.fingertip ? `${l.movement}:${l.side}:${l.fingertip}` : `${l.movement}:${l.side}`;
}

function span(l: LaneResultSummary): number | null {
  if (l.calibratedMin === null || l.calibratedMax === null) return null;
  const d = l.calibratedMax - l.calibratedMin;
  return Number.isFinite(d) ? d : null;
}

function change(first: number | null, latest: number | null, count: number): number | null {
  if (first === null || latest === null || count < 2) return null;
  return latest - first;
}

/**
 * Per-movement trends over the most recent `window` sessions that contain each movement, newest
 * session first in `history` (the order the store keeps it in). Movements are returned in the order
 * they were most recently worked, so today's prescription is at the top.
 */
export function movementTrends(history: readonly SessionResult[], window: number = DEFAULT_TREND_WINDOW): MovementTrend[] {
  const limit = Math.max(1, Math.floor(window));
  const order: string[] = [];
  const byKey = new Map<string, { lane: LaneResultSummary; session: SessionResult }[]>();

  // history is newest-first: walking it forward keeps `order` in most-recently-worked order and gives
  // each key its newest entries first, which is what the per-movement window has to be taken from.
  for (const session of history) {
    for (const lane of session.lanes) {
      const key = laneKey(lane);
      let rows = byKey.get(key);
      if (!rows) {
        rows = [];
        byKey.set(key, rows);
        order.push(key);
      }
      if (rows.length < limit) rows.push({ lane, session });
    }
  }

  return order.map((key) => {
    const rows = (byKey.get(key) ?? []).slice().reverse(); // oldest first
    const points: TrendPoint[] = [];
    let previousSpan: number | null = null;
    for (const { lane, session } of rows) {
      const s = span(lane);
      const recalibrated =
        s !== null && previousSpan !== null && previousSpan > 0
          ? Math.abs(s - previousSpan) / previousSpan > RECALIBRATION_TOLERANCE
          : false;
      points.push({
        sessionId: session.id,
        at: session.startedAt,
        rom: lane.romSamples > 0 ? lane.romMean : null,
        romBest: lane.romSamples > 0 ? lane.romBest : null,
        accuracy: Number.isFinite(lane.accuracy) ? lane.accuracy : 0,
        reps: lane.reps,
        calibratedSpan: s,
        recalibrated,
        compensationFlags: lane.compensationMonitored ? lane.compensationFlags : 0,
      });
      if (s !== null) previousSpan = s;
    }

    const romPoints = points.filter((p) => p.rom !== null);
    const first = rows[0]?.lane;
    const latest = rows[rows.length - 1]?.lane;
    const firstRom = romPoints[0]?.rom ?? null;
    const latestRom = romPoints[romPoints.length - 1]?.rom ?? null;
    const firstAccuracy = points[0]?.accuracy ?? null;
    const latestAccuracy = points[points.length - 1]?.accuracy ?? null;
    return {
      key,
      label: latest?.label ?? first?.label ?? key,
      movement: (latest ?? first).movement,
      side: (latest ?? first).side,
      points,
      romPoints,
      firstRom,
      latestRom,
      romChange: change(firstRom, latestRom, romPoints.length),
      firstAccuracy,
      latestAccuracy,
      accuracyChange: change(firstAccuracy, latestAccuracy, points.length),
      totalReps: points.reduce((n, p) => n + p.reps, 0),
      anyRecalibration: points.some((p) => p.recalibrated),
    };
  });
}
