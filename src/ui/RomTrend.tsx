/**
 * Cross-session progress, per movement: is this patient's range of motion improving?
 *
 * The session table underneath answers "what happened on Tuesday". This answers the question the
 * patient and the therapist actually came for, and it is the only place in the app where more than
 * one session is on screen at once.
 *
 * Legibility decisions, all for a tablet at arm's length:
 *  - One card per movement, never one chart with four lines. Movements have different ranges and
 *    different meanings; overlaying them makes a pretty chart nobody can read.
 *  - Two sparklines per card, labelled and figure-first: the NUMBER is the headline, the line is the
 *    shape. A therapist reading from 2 m gets "62 %, up" without resolving individual points.
 *  - Sessions where ROM was never measured (keyboard runs, camera runs whose reps were all cut short)
 *    break the ROM line instead of drawing a zero. Accuracy is always known and always continuous.
 *  - A re-calibration is called out: `romMean` is a percentage OF THE RANGE CALIBRATED THAT DAY, so a
 *    patient given a wider range can improve while the percentage falls.
 */
import { useMemo, useState } from 'react';
import { formatDate, formatPercent } from '../session/results.ts';
import { DEFAULT_TREND_WINDOW, movementTrends } from '../session/trends.ts';
import type { MovementTrend } from '../session/trends.ts';
import type { SessionResult } from '../session/types.ts';
import { DeltaBadge, Sparkline } from './common.tsx';

const WINDOWS = [4, 8, 16];

function TrendCard({ trend }: { trend: MovementTrend }) {
  const romValues = trend.points.map((p) => p.rom);
  const accuracyValues = trend.points.map((p) => p.accuracy);
  const sessions = trend.points.length;
  const measured = trend.romPoints.length;
  const first = trend.points[0];
  const last = trend.points[sessions - 1];

  return (
    <div className="trend-card" data-testid={`trend-${trend.key}`}>
      <div className="trend-row">
        <h4>{trend.label}</h4>
        <span className="badge">
          {sessions} session{sessions === 1 ? '' : 's'}
        </span>
      </div>

      <div className="trend-row">
        <div className="trend-figure">
          <span className="k">ROM achieved</span>
          <span className="v">{measured > 0 ? formatPercent(trend.latestRom) : '—'}</span>
          <DeltaBadge value={trend.romChange} />
        </div>
        {measured > 0 ? (
          <Sparkline
            values={romValues}
            label={`${trend.label}: range of motion over the last ${sessions} sessions`}
            color="#ff3d7f"
            band={1}
          />
        ) : (
          <span className="dim" style={{ maxWidth: 200 }}>
            Range was not measured in these sessions — only camera sessions record it.
          </span>
        )}
      </div>

      <div className="trend-row">
        <div className="trend-figure">
          <span className="k">Accuracy</span>
          <span className="v">{formatPercent(trend.latestAccuracy)}</span>
          <DeltaBadge value={trend.accuracyChange} />
        </div>
        <Sparkline
          values={accuracyValues}
          label={`${trend.label}: accuracy over the last ${sessions} sessions`}
          color="#35d6ff"
        />
      </div>

      <div className="dim">
        {trend.totalReps} movements performed
        {first && last && sessions > 1 ? ` · ${formatDate(first.at)} → ${formatDate(last.at)}` : first ? ` · ${formatDate(first.at)}` : ''}
      </div>

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

  if (trends.length === 0) return null;

  return (
    <div className="stack" data-testid="rom-trend">
      <div className="row">
        <h3 style={{ margin: 0 }}>Progress by movement</h3>
        <span className="dim">Range of motion and accuracy across sessions — most recently worked first.</span>
        <div className="grow" />
        <div className="seg seg-sm" role="group" aria-label="Sessions shown per movement">
          {WINDOWS.map((n) => (
            <button key={n} aria-pressed={window === n} onClick={() => setWindow(n)} data-testid={`trend-window-${n}`}>
              Last {n}
            </button>
          ))}
        </div>
      </div>

      <div className="trend-grid">
        {trends.map((t) => (
          <TrendCard key={t.key} trend={t} />
        ))}
      </div>

      <span className="dim">
        ROM is the mean peak of each rep as a fraction of that session's calibrated range; the dotted gold
        line marks 100 % of it, which a patient who has improved past their calibration will cross.
      </span>
    </div>
  );
}
