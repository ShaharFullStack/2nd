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
 */
import { useMemo, useState } from 'react';
import { formatDate, formatPercent } from '../session/results.ts';
import { DEFAULT_TREND_WINDOW, movementTrends, trendCoverage } from '../session/trends.ts';
import type { MovementTrend } from '../session/trends.ts';
import type { SessionResult } from '../session/types.ts';
import { DeltaBadge, Sparkline } from './common.tsx';

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

function TrendCard({ trend }: { trend: MovementTrend }) {
  const romValues = trend.points.map((p) => p.rom);
  const accuracyValues = trend.points.map((p) => p.accuracy);
  const at = trend.points.map((p) => p.at);
  const sessions = trend.points.length;
  const measured = trend.romPoints.length;
  const first = trend.points[0];
  const last = trend.points[sessions - 1];

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
            label={`${trend.label}: range of motion over the last ${sessions} camera sessions`}
            color="#ff3d7f"
            band={1}
          />
        ) : (
          <span className="dim">Range was not measured in these sessions — only completed camera reps record it.</span>
        )}
      </div>

      <div className="trend-block">
        <div className="trend-row">
          <div className="trend-figure">
            <span className="k">Accuracy</span>
            <span className="v">{formatPercent(trend.latestAccuracy)}</span>
          </div>
          <DeltaBadge value={trend.accuracyChange} />
        </div>
        <Sparkline
          values={accuracyValues}
          at={at}
          label={`${trend.label}: accuracy over the last ${sessions} camera sessions`}
          color="#35d6ff"
        />
      </div>

      <div className="dim">
        {plural(trend.totalReps, 'movement')} performed
        {first && last && sessions > 1 ? ` · ${formatDate(first.at)} → ${formatDate(last.at)}` : first ? ` · ${formatDate(first.at)}` : ''}
      </div>

      {trend.excludedSessions > 0 && (
        <div className="dim" data-testid={`trend-excluded-${trend.key}`}>
          {plural(trend.excludedSessions, `${modeList(trend.excludedModes)} session`)} with this movement{' '}
          {trend.excludedSessions === 1 ? 'is' : 'are'} not counted above: the input came from the system, not
          from the patient.
        </div>
      )}
      {trend.anyRecalibration && (
        <div className="dim">
          The calibrated range changed during this window — percentages are of the range in force on the
          day, so compare the shape, not only the number.
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
  const [window, setWindow] = useState(DEFAULT_TREND_WINDOW);
  const trends = useMemo(() => movementTrends(history, window), [history, window]);
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
            <button key={n} aria-pressed={window === n} onClick={() => setWindow(n)} data-testid={`trend-window-${n}`}>
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
        ROM is the mean peak of each rep as a fraction of that session's calibrated range. The grey dashed line is
        where this window started — the gap between it and the last point IS the change. The vertical axis is scaled to
        the data and labelled at both ends, and each point sits at its real date, so a slow gain does not draw the same
        slope as a fast one. A gold dashed line appears at 100 % of the calibrated range when the patient gets near it.
      </span>
    </div>
  );
}
