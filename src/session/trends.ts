/**
 * Cross-session rehab trend: "is this patient's range of motion getting better?".
 *
 * Everything needed is already in the persisted `SessionResult.lanes` (romMean/romBest against the
 * calibratedMin/Max in force at the time, accuracy, reps). This module turns the flat session list
 * into one series PER MOVEMENT, which is the unit a therapist actually reasons about — "left knee
 * extension", not "Tuesday's session".
 *
 * Four rules the History screen must not have to remember:
 *
 *  - ONLY CAMERA SESSIONS COUNT. A keyboard or autoplay run is the SYSTEM producing the input, not the
 *    patient producing a movement: its accuracy is a property of the bot or of whoever held the
 *    keyboard. Averaging that into a progress display would put a green "improving" badge on work the
 *    patient never did, which is the one thing an outcome record may never do. Non-camera sessions are
 *    excluded from every series, every count and every delta here, and counted in `excluded*` so the
 *    screen can say out loud that they were left out.
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
import type { Fingertip, Movement, Side } from '../engine/types.ts';
import { laneLabel } from '../render/palette.ts';
import { MOVEMENT_INFO } from '../vision/features.ts';
import type { InputMode, LaneResultSummary, SessionResult } from './types.ts';

/** One session's contribution to one movement's trend. */
export interface TrendPoint {
  sessionId: string;
  /** Always 'camera' — a point only exists for a session the patient actually drove. */
  inputMode: InputMode;
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
  /** The bottom of that day's calibrated range (feature units) — the zero the percentage is from. */
  calibratedMin: number | null;
  /**
   * The mean peak in the movement's OWN units (degrees, or a torso/palm-normalized ratio), i.e.
   * `calibratedMin + rom x span`.
   *
   * This is the only figure on the card that survives a re-calibration. `rom` is a percentage of a
   * denominator the therapist can move: widen the range on Tuesday and the same knee angle reads
   * lower, which is exactly the case where "did this patient's range improve?" must still be
   * answerable. Null when ROM was not measured or no range was recorded — never 0.
   */
  absoluteMean: number | null;
  /** Best single rep in the same units. */
  absoluteBest: number | null;
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
  /** finger_opposition only — the digit this series was measured on. Part of `label`. */
  fingertip?: Fingertip;
  /** Units of `absolute*`: 'deg' for a joint angle, 'ratio' for a normalized distance. */
  unit: 'deg' | 'ratio';
  /** Oldest first, so a chart reads left-to-right in time. */
  points: TrendPoint[];
  /** Points whose ROM was actually measured (the ones a ROM chart can draw). */
  romPoints: TrendPoint[];
  /** Points that also carry a calibrated range, so an absolute peak can be plotted. */
  absolutePoints: TrendPoint[];
  /** First and latest MEASURED ROM, and the change between them (null when fewer than two). */
  firstRom: number | null;
  latestRom: number | null;
  romChange: number | null;
  /** Same for accuracy, over all points. */
  firstAccuracy: number | null;
  latestAccuracy: number | null;
  accuracyChange: number | null;
  /** First/latest absolute peak (feature units) and the change between them. */
  firstAbsolute: number | null;
  latestAbsolute: number | null;
  absoluteChange: number | null;
  /** The calibrated range in force on the most recent session that recorded one — the denominator. */
  latestCalibratedMin: number | null;
  latestCalibratedMax: number | null;
  /** Movements performed in this lane across the whole window. */
  totalReps: number;
  /** True when any point in the window sits on a different calibrated span than its predecessor. */
  anyRecalibration: boolean;
  /** Stored sessions containing this movement that were left out because they were not camera-driven. */
  excludedSessions: number;
  /** Which kinds ('keyboard' | 'autoplay' | 'unknown'), in first-seen order. */
  excludedModes: string[];
}

/** How much of the stored history a trend can honestly draw on. */
export interface TrendCoverage {
  /** Sessions the patient drove through the camera — the only ones any series is built from. */
  cameraSessions: number;
  /** Sessions excluded because the input was a keyboard, the autoplay bot, or unrecorded. */
  excludedSessions: number;
  excludedModes: string[];
}

/** A session counts as the patient's performance only when the camera measured it. */
export function isPatientDriven(s: Pick<SessionResult, 'inputMode'>): boolean {
  return s.inputMode === 'camera';
}

function excludedMode(s: Pick<SessionResult, 'inputMode'>): string {
  return s.inputMode === 'keyboard' || s.inputMode === 'autoplay' ? s.inputMode : 'unknown';
}

/** Camera vs non-camera split of the whole stored history, for the header of the trend view. */
export function trendCoverage(history: readonly SessionResult[]): TrendCoverage {
  let cameraSessions = 0;
  let excludedSessions = 0;
  const excludedModes: string[] = [];
  for (const s of history) {
    if (isPatientDriven(s)) {
      cameraSessions++;
      continue;
    }
    excludedSessions++;
    const kind = excludedMode(s);
    if (!excludedModes.includes(kind)) excludedModes.push(kind);
  }
  return { cameraSessions, excludedSessions, excludedModes };
}

/** Default number of sessions a trend looks back over — enough to see a direction on a tablet. */
export const DEFAULT_TREND_WINDOW = 8;

/** Fractional change in the calibrated span that counts as "this was re-calibrated". */
const RECALIBRATION_TOLERANCE = 0.05;

function laneKey(l: Pick<LaneResultSummary, 'movement' | 'side' | 'fingertip'>): string {
  return l.fingertip ? `${l.movement}:${l.side}:${l.fingertip}` : `${l.movement}:${l.side}`;
}

/**
 * The card's title, DERIVED rather than read back from `lane.label`.
 *
 * Records written before the fingertip reached the label carry a stored `label` of "L pinch" for
 * every digit, so two cards for two different fingers would arrive identically titled — which is the
 * one thing a per-movement outcome record may not do. The key already distinguishes them; the title
 * is rebuilt from the same three fields so it always agrees with the key.
 */
function trendLabel(l: Pick<LaneResultSummary, 'movement' | 'side' | 'fingertip'>): string {
  return laneLabel({ movement: l.movement, side: l.side, fingertip: l.fingertip });
}

/** Mean peak expressed in the movement's own units, or null when either half is unknown. */
function absolute(rom: number | null, min: number | null, spanValue: number | null): number | null {
  if (rom === null || min === null || spanValue === null || !Number.isFinite(rom)) return null;
  const v = min + rom * spanValue;
  return Number.isFinite(v) ? v : null;
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
  const excludedByKey = new Map<string, string[]>();

  // history is newest-first: walking it forward keeps `order` in most-recently-worked order and gives
  // each key its newest entries first, which is what the per-movement window has to be taken from.
  for (const session of history) {
    // A session the patient did not drive contributes NOTHING to any series — not a ROM point, not an
    // accuracy point, not a rep. It is only tallied, so the card can name what it left out.
    if (!isPatientDriven(session)) {
      const kind = excludedMode(session);
      for (const lane of session.lanes) {
        const key = laneKey(lane);
        const seen = excludedByKey.get(key);
        if (seen) seen.push(kind);
        else excludedByKey.set(key, [kind]);
      }
      continue;
    }
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
    const excluded = excludedByKey.get(key) ?? [];
    const points: TrendPoint[] = [];
    let previousSpan: number | null = null;
    for (const { lane, session } of rows) {
      const s = span(lane);
      const recalibrated =
        s !== null && previousSpan !== null && previousSpan > 0
          ? Math.abs(s - previousSpan) / previousSpan > RECALIBRATION_TOLERANCE
          : false;
      const rom = lane.romSamples > 0 ? lane.romMean : null;
      const romBest = lane.romSamples > 0 ? lane.romBest : null;
      points.push({
        sessionId: session.id,
        inputMode: session.inputMode,
        at: session.startedAt,
        rom,
        romBest,
        accuracy: Number.isFinite(lane.accuracy) ? lane.accuracy : 0,
        reps: lane.reps,
        calibratedSpan: s,
        calibratedMin: lane.calibratedMin,
        absoluteMean: absolute(rom, lane.calibratedMin, s),
        absoluteBest: absolute(romBest, lane.calibratedMin, s),
        recalibrated,
        compensationFlags: lane.compensationMonitored ? lane.compensationFlags : 0,
      });
      if (s !== null) previousSpan = s;
    }

    const romPoints = points.filter((p) => p.rom !== null);
    const absolutePoints = points.filter((p) => p.absoluteMean !== null);
    const first = rows[0]?.lane;
    const latest = rows[rows.length - 1]?.lane;
    const spec = latest ?? first;
    const firstRom = romPoints[0]?.rom ?? null;
    const latestRom = romPoints[romPoints.length - 1]?.rom ?? null;
    const firstAccuracy = points[0]?.accuracy ?? null;
    const latestAccuracy = points[points.length - 1]?.accuracy ?? null;
    const firstAbsolute = absolutePoints[0]?.absoluteMean ?? null;
    const latestAbsolute = absolutePoints[absolutePoints.length - 1]?.absoluteMean ?? null;
    // The denominator that was in force most recently — disclosed on the card, because every
    // percentage above is a fraction of it.
    const withRange = rows.filter((r) => r.lane.calibratedMin !== null && r.lane.calibratedMax !== null);
    const latestRange = withRange[withRange.length - 1]?.lane ?? null;
    return {
      key,
      label: trendLabel(spec),
      movement: spec.movement,
      side: spec.side,
      ...(spec.fingertip ? { fingertip: spec.fingertip } : {}),
      unit: MOVEMENT_INFO[spec.movement]?.unit ?? 'ratio',
      points,
      romPoints,
      absolutePoints,
      firstRom,
      latestRom,
      romChange: change(firstRom, latestRom, romPoints.length),
      firstAccuracy,
      latestAccuracy,
      accuracyChange: change(firstAccuracy, latestAccuracy, points.length),
      firstAbsolute,
      latestAbsolute,
      absoluteChange: change(firstAbsolute, latestAbsolute, absolutePoints.length),
      latestCalibratedMin: latestRange?.calibratedMin ?? null,
      latestCalibratedMax: latestRange?.calibratedMax ?? null,
      totalReps: points.reduce((n, p) => n + p.reps, 0),
      anyRecalibration: points.some((p) => p.recalibrated),
      excludedSessions: excluded.length,
      excludedModes: excluded.filter((m, i) => excluded.indexOf(m) === i),
    };
  });
}
