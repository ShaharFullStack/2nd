/**
 * Cross-session progress, per movement: is this patient's range of motion improving?
 *
 * The session table underneath answers "what happened on Tuesday". This answers the question the
 * patient and the therapist actually came for, and it is the only place in the app where more than
 * one session is on screen at once. That makes it an OUTCOME RECORD, and it is held to the rule an
 * outcome record is held to:
 *
 *  - EVERY NUMBER HERE WAS MEASURED ON THE PATIENT. Keyboard and autoplay runs are the system, not
 *    the patient, producing the input; they are excluded from every line, every count and every
 *    delta (see session/trends.ts) and the exclusion is stated on the card rather than being silent.
 *
 * Legibility decisions, all for a tablet at arm's length:
 *  - One card per movement, never one chart with four lines. Movements have different ranges and
 *    different meanings; overlaying them makes a pretty chart nobody can read.
 *  - Figure first, then a FULL-WIDTH plot directly under its own label — the eye never crosses dead
 *    space to associate a number with its line.
 *  - The plot autoscales to the data with both bounds labelled, and draws the starting level as a
 *    dashed line: a clinically meaningful gain (tens of points) has to look different from noise.
 *  - Sessions where ROM was never measured (a camera run whose reps were all cut short) break the
 *    ROM line instead of drawing a zero. Accuracy is known for every included session.
 *  - A re-calibration is called out: `romMean` is a percentage OF THE RANGE CALIBRATED THAT DAY, so a
 *    patient given a wider range can improve while the percentage falls.
 *  - THE DENOMINATOR IS DISCLOSED AND THE ABSOLUTE FIGURE IS PLOTTED BESIDE IT. A percentage of a
 *    range the therapist can move cannot, on its own, answer "did this patient's range improve?".
 *    The movement's own units (degrees for a joint angle; a body-scaled ratio otherwise) are
 *    reconstructed from what is already persisted — `calibratedMin + rom x span` — and given their
 *    own block with their own title, because they are a DIFFERENT QUANTITY from the percentage and
 *    the two may never share a line or a heading.
 *  - ONLY THE TWO PLOTS WHOSE SHAPES MAY BE COMPARED ARE DRAWN THE SAME WAY. The ROM percentage and
 *    the absolute peak are the SAME reps expressed twice, so a divergence between their shapes is
 *    itself the finding (the calibrated range moved under them) and stacking two autoscaled lines is
 *    exactly right. Accuracy is a different quantity; it is drawn as columns on a fixed 0–100 % axis,
 *    so nothing invites a slope comparison the axes do not license.
 *  - EVERY POINT IS READABLE AS A DATE. The end sessions are dated on the axis and the full
 *    session-by-session list sits under the card — a clinic tablet has no hover.
 *  - EVERY CHART IN A CARD SHARES ONE HORIZONTAL AXIS. The line plots and the accuracy columns are
 *    positioned by the same function of the same real dates (`sessionAxis` in common.tsx), so the
 *    column under a point is that point's session. Two marks stacked in one card, sharing gutters and
 *    printing the same end dates, invite that cross-read whatever the caption says; the fix is to
 *    make it true.
 */
import { useMemo, useState } from 'react';
import { formatPercent } from '../session/results.ts';
import { DEFAULT_TREND_WINDOW, movementTrends, trendCoverage } from '../session/trends.ts';
import type { MovementTrend, TrendPoint } from '../session/trends.ts';
import type { SessionResult } from '../session/types.ts';
import { DeltaBadge, SessionBars, Sparkline, shortDate } from './common.tsx';

const WINDOWS = [4, 8, 16];

/** "keyboard" / "keyboard and autoplay" — named, so the therapist knows what was left out. */
function modeList(modes: string[]): string {
  if (modes.length === 0) return 'non-camera';
  if (modes.length === 1) return modes[0];
  return `${modes.slice(0, -1).join(', ')} and ${modes[modes.length - 1]}`;
}

/** What actually drove those lanes, for the sentence that explains the exclusion. */
function drivenBy(modes: string[]): string {
  const kb = modes.includes('keyboard');
  const bot = modes.includes('autoplay');
  if (kb && bot) return 'by keys and by the autoplay bot';
  if (bot) return 'by the autoplay bot';
  if (kb) return 'by keys';
  return 'by something other than the camera';
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The movement's own units, for the absolute (calibration-independent) figures. */
function formatUnit(v: number | null, unit: 'deg' | 'ratio'): string {
  if (v === null || !Number.isFinite(v)) return '—';
  return unit === 'deg' ? `${Math.round(v)}\u00b0` : v.toFixed(2);
}

/**
 * What the absolute block is CALLED. Never "ROM" and never a percentage: it is the peak the patient
 * reached in the units the extractor measures, which is the figure a re-calibration cannot move.
 */
function absoluteTitle(unit: 'deg' | 'ratio'): string {
  return unit === 'deg' ? 'Peak angle reached' : 'Peak reach (body-scaled)';
}

/** Same quantity, column-width. The full name is on the block above and in the column's tooltip. */
function absoluteColumn(unit: 'deg' | 'ratio'): string {
  return unit === 'deg' ? 'Peak °' : 'Peak';
}

function TrendCard({ trend }: { trend: MovementTrend }) {
  const romValues = trend.points.map((p) => p.rom);
  const accuracyValues = trend.points.map((p) => p.accuracy);
  const absoluteValues = trend.points.map((p) => p.absoluteMean);
  const at = trend.points.map((p) => p.at);
  const sessions = trend.points.length;
  const measured = trend.romPoints.length;
  const absMeasured = trend.absolutePoints.length;
  const first = trend.points[0];
  const last = trend.points[sessions - 1];
  const unit = trend.unit;

  const rangeKnown = trend.latestCalibratedMin !== null && trend.latestCalibratedMax !== null;
  const rangeSpan = rangeKnown ? (trend.latestCalibratedMax as number) - (trend.latestCalibratedMin as number) : null;

  return (
    <div className="trend-card" data-testid={`trend-${trend.key}`}>
      <div className="trend-row">
        <h4>{trend.label}</h4>
        <span className="badge">
          {plural(sessions, 'camera session')}
        </span>
      </div>

      <div className="trend-block">
        <div className="trend-row">
          <div className="trend-figure">
            <span className="k">ROM achieved</span>
            <span className="v">{measured > 0 ? formatPercent(trend.latestRom) : '—'}</span>
          </div>
          <DeltaBadge value={trend.romChange} />
        </div>
        {measured > 0 ? (
          <Sparkline
            values={romValues}
            at={at}
            label={`${trend.label}: range of motion, as a percentage of that day's calibrated range, over the last ${sessions} camera sessions`}
            color="#ff3d7f"
            band={1}
          />
        ) : (
          <span className="dim">Range was not measured in these sessions — only completed camera reps record it.</span>
        )}
        <span className="dim" data-testid={`trend-denominator-${trend.key}`}>
          {rangeKnown
            ? `Out of the range calibrated on the day — most recently ${formatUnit(trend.latestCalibratedMin, unit)} to ${formatUnit(trend.latestCalibratedMax, unit)} (${formatUnit(rangeSpan, unit)} of travel).`
            : 'The calibrated range these percentages are out of was not recorded for these sessions.'}
        </span>
      </div>

      {/* A DIFFERENT QUANTITY, so a separate block with its own title and its own units: the peak the
          patient actually reached. This is the one figure a re-calibration cannot move. */}
      {absMeasured > 0 && (
        <div className="trend-block" data-testid={`trend-absolute-${trend.key}`}>
          <div className="trend-row">
            <div className="trend-figure">
              <span className="k">{absoluteTitle(unit)}</span>
              <span className="v">{formatUnit(trend.latestAbsolute, unit)}</span>
            </div>
            <DeltaBadge
              value={trend.absoluteChange}
              scale={1}
              digits={unit === 'deg' ? 0 : 2}
              unit={unit === 'deg' ? '\u00b0' : 'units'}
            />
          </div>
          <Sparkline
            values={absoluteValues}
            at={at}
            min={Number.NEGATIVE_INFINITY}
            max={Number.POSITIVE_INFINITY}
            minSpan={unit === 'deg' ? 8 : 0.08}
            label={`${trend.label}: ${absoluteTitle(unit).toLowerCase()}, in the movement's own units, over the last ${sessions} camera sessions`}
            color="#ffc945"
            format={(v) => formatUnit(v, unit)}
          />
          <span className="dim">
            {unit === 'deg'
              ? 'Same reps as the plot above, in degrees at the joint, reconstructed from that day\u2019s calibrated range — independent of where the range was set, so it answers "is the range itself bigger?".'
              : 'Same reps as the plot above, in the extractor\u2019s own body-scaled ratio (normalised by torso or palm size), independent of where the range was set, so it answers "is the movement itself bigger?".'}
          </span>
        </div>
      )}

      <div className="trend-block">
        <div className="trend-row">
          <div className="trend-figure">
            <span className="k">Accuracy</span>
            <span className="v">{formatPercent(trend.latestAccuracy)}</span>
          </div>
          <DeltaBadge value={trend.accuracyChange} />
        </div>
        {/* COLUMNS ON A FIXED 0–100 % AXIS, not a third autoscaled line. Accuracy is a different
            quantity from the two plots above, and an autoscaled line under an autoscaled line reads
            as a comparable slope when it is not one. Accuracy has a true zero and a real ceiling, so
            it is the series that can carry an absolute scale — which also makes "not measured" a
            missing column rather than a point on a moving axis. */}
        <SessionBars
          values={accuracyValues}
          at={at}
          label={`${trend.label}: accuracy of the notes judged in this lane, out of 100 %, over the last ${sessions} camera sessions`}
          color="#35d6ff"
        />
        <span className="dim">
          Columns are out of 100 % of the notes judged in this lane — an absolute scale, unlike the plots above.
        </span>
      </div>

      <div className="dim">
        {plural(trend.totalReps, 'movement')} performed
        {/* A session-date RANGE, not a pair of timestamps: "Jul 30, 2026, 10:20 PM → Sep 8, 2026,
            10:20 PM" spends half a line on a time of day nobody reads. */}
        {first && last && sessions > 1 ? ` · ${shortDate(first.at)} → ${shortDate(last.at)}` : first ? ` · ${shortDate(first.at)}` : ''}
      </div>

      {/* The per-point readout. There is no hover on a clinic tablet, so a dip in a line has to be
          traceable to a DATE somewhere on the card, not only in the session table on another screen
          (which is not per-movement and cannot answer "which session was that dip?"). */}
      <details className="trend-points">
        <summary className="dim" data-testid={`trend-points-${trend.key}`}>Session by session ({sessions})</summary>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Session</th>
                <th>ROM</th>
                {absMeasured > 0 && <th title={absoluteTitle(unit)}>{absoluteColumn(unit)}</th>}
                <th>Accuracy</th>
                <th>Reps</th>
              </tr>
            </thead>
            <tbody>
              {trend.points
                .slice()
                .reverse()
                .map((p: TrendPoint) => (
                  <tr key={p.sessionId}>
                    <td>
                      {shortDate(p.at)}
                      {p.recalibrated && <span className="badge badge-warn">re-calibrated</span>}
                    </td>
                    {/* "not measured", never 0 %. */}
                    <td className="mono">{p.rom === null ? <span className="dim">not measured</span> : formatPercent(p.rom)}</td>
                    {absMeasured > 0 && (
                      <td className="mono">
                        {p.absoluteMean === null ? <span className="dim">not measured</span> : formatUnit(p.absoluteMean, unit)}
                      </td>
                    )}
                    <td className="mono">{formatPercent(p.accuracy)}</td>
                    <td className="mono">{p.reps}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </details>

      {trend.excludedSessions > 0 && (
        <div className="dim" data-testid={`trend-excluded-${trend.key}`}>
          {plural(trend.excludedSessions, `${modeList(trend.excludedModes)} session`)} with this movement{' '}
          {trend.excludedSessions === 1 ? 'is' : 'are'} not counted above: the input came from the system, not
          from the patient.
        </div>
      )}
      {trend.anyRecalibration && (
        <div className="dim">
          The calibrated range changed during this window, so the percentages above are against different
          denominators from session to session. {absMeasured > 0 ? `The ${absoluteTitle(unit).toLowerCase()} plot is not affected — read the range question there.` : 'Compare the shape, not only the number.'}
        </div>
      )}
      {measured > 0 && measured < sessions && (
        <div className="dim">
          {sessions - measured} of these sessions did not measure range (gaps in the pink line).
        </div>
      )}
    </div>
  );
}

export default function RomTrend({ history }: { history: readonly SessionResult[] }) {
  // NOT `window`: a state variable of that name shadows the global for the whole component body, so
  // the next `window.matchMedia('(prefers-reduced-motion)')` added in here would silently read 8.
  const [windowSize, setWindowSize] = useState(DEFAULT_TREND_WINDOW);
  const trends = useMemo(() => movementTrends(history, windowSize), [history, windowSize]);
  const coverage = useMemo(() => trendCoverage(history), [history]);

  // Nothing the patient drove: say so plainly rather than plotting the bot's keypresses as progress.
  if (trends.length === 0) {
    if (coverage.excludedSessions === 0) return null;
    return (
      <div className="card stack" data-testid="rom-trend-empty">
        <h3 style={{ margin: 0 }}>No measured progress yet</h3>
        <p className="muted" style={{ margin: 0 }}>
          The {plural(coverage.excludedSessions, `stored ${modeList(coverage.excludedModes)} session`)} on this device
          {coverage.excludedSessions === 1 ? ' was' : ' were'} driven {drivenBy(coverage.excludedModes)}, not by the
          patient's movement, so
          {coverage.excludedSessions === 1 ? ' it measures' : ' they measure'} no range of motion and cannot be shown
          as progress. Run a camera session to start the trend.
        </p>
      </div>
    );
  }

  return (
    <div className="stack" data-testid="rom-trend">
      <div className="row">
        <h3 style={{ margin: 0 }}>Progress by movement</h3>
        <span className="dim">
          Range of motion and accuracy across <b>camera</b> sessions — most recently worked first.
        </span>
        <div className="grow" />
        <div className="seg seg-sm" role="group" aria-label="Sessions shown per movement">
          {WINDOWS.map((n) => (
            <button key={n} aria-pressed={windowSize === n} onClick={() => setWindowSize(n)} data-testid={`trend-window-${n}`}>
              Last {n}
            </button>
          ))}
        </div>
      </div>

      {coverage.excludedSessions > 0 && (
        <span className="dim" data-testid="trend-coverage">
          {plural(coverage.excludedSessions, `${modeList(coverage.excludedModes)} session`)} excluded from every figure
          below — a session the patient did not drive is not a record of what the patient did. They are still listed in
          the session table.
        </span>
      )}

      <div className="trend-grid">
        {trends.map((t) => (
          <TrendCard key={t.key} trend={t} />
        ))}
      </div>

      <span className="dim">
        ROM is the mean peak of each rep as a fraction of that session's calibrated range; the peak figure under it is
        the same reps in the movement's own units (degrees, or a body-scaled ratio), which is the figure a
        re-calibration cannot move. The grey dashed line is where this window started — the gap between it and the last
        point IS the change. Each vertical axis is scaled to its data and labelled at both ends, the two percentage
        plots in a card carry the same reps, and every chart in a card shares one horizontal axis of real dates — a
        column and the points above it are the same session, and a slow gain does not draw the same slope as a fast
        one. A gold dashed line appears at 100 % of the calibrated range when the patient gets near it.
      </span>
    </div>
  );
}
