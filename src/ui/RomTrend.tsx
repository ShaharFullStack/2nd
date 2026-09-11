/**
 * Cross-session progress, per movement: is this patient's range of motion improving?
 *
 * The session table underneath answers "what happened on Tuesday". This answers the question the
 * patient and the therapist actually came for, and it is the only place in the app where more than
 * one session is on screen at once. That makes it an OUTCOME RECORD, and it is held to the rule an
 * outcome record is held to:
 *
 *  - EVERY NUMBER HERE WAS MEASURED ON THIS PATIENT. Two separate rules, and both had to be added:
 *    the series are built for ONE `patientId` (a shared tablet's history holds several people's
 *    sessions, and a chart that pooled them answered "is this patient improving?" with somebody
 *    else's reps); and keyboard/autoplay runs are the system, not the patient, producing the input,
 *    so they are excluded from every line, every count and every delta (see session/trends.ts) and
 *    the exclusion is stated on the card rather than being silent.
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
import { endReasonLabel, formatPercent } from '../session/results.ts';
import { DEFAULT_TREND_WINDOW, movementTrends, trendCoverage } from '../session/trends.ts';
import type { MovementTrend, TrendPoint } from '../session/trends.ts';
import type { SessionResult } from '../session/types.ts';
import { trackingMix } from '../session/tracking.ts';
import { DeltaBadge, SessionBars, Sparkline, shortDate } from './common.tsx';
import { ScopeNote } from './ScopeNote.tsx';

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

/**
 * THE SESSIONS THIS CARD IS ABOUT — one set, used by every figure, every plot and every caption on it.
 *
 * The card used to disagree with itself. `trends.ts` takes its change figures across the COMPLETE
 * sessions whenever two of those exist (a nine-rep walk-out is not the other end of a like-for-like
 * comparison), and `latestRom` is the last of those; the card then plotted `trend.points` — every
 * session including the incomplete ones — and captioned the plot "the gap between the dashed line
 * and the last point IS the change". On a window holding one aborted run, the headline figure was
 * one session, the last point on the line was a different session, and the caption described a third
 * relationship. Three statements, three different sets.
 *
 * So the basis is chosen ONCE here, by the same rule trends.ts uses, and everything on the card is
 * derived from it: headline, delta badge, both line plots, the accuracy columns, the rep total and
 * the date range. The runs that fall outside it are not hidden — they are counted on the card, their
 * reps are stated, and every one of them is listed in "Session by session" underneath.
 */
function cardBasis(points: readonly TrendPoint[]): { shown: TrendPoint[]; excluded: TrendPoint[] } {
  const complete = points.filter((p) => p.completed);
  if (complete.length >= 2 && complete.length < points.length) {
    return { shown: complete, excluded: points.filter((p) => !p.completed) };
  }
  return { shown: points.slice(), excluded: [] };
}

/** First and last non-null value of a series, and how many there were. */
function ends(values: readonly (number | null)[]): { first: number | null; last: number | null; n: number } {
  let first: number | null = null;
  let last: number | null = null;
  let n = 0;
  for (const v of values) {
    if (v === null || !Number.isFinite(v)) continue;
    if (first === null) first = v;
    last = v;
    n++;
  }
  return { first, last, n };
}

/** latest − first, but only when there really are two points to span. */
function spanChange(e: { first: number | null; last: number | null; n: number }): number | null {
  if (e.first === null || e.last === null || e.n < 2) return null;
  return e.last - e.first;
}

function TrendCard({ trend }: { trend: MovementTrend }) {
  const { shown, excluded } = cardBasis(trend.points);
  const romValues = shown.map((p) => p.rom);
  const accuracyValues = shown.map((p) => p.accuracy);
  const absoluteValues = shown.map((p) => p.absoluteMean);
  const at = shown.map((p) => p.at);
  const sessions = shown.length;
  const measured = romValues.filter((v) => v !== null).length;
  const absMeasured = absoluteValues.filter((v) => v !== null).length;
  const first = shown[0];
  const last = shown[sessions - 1];
  const unit = trend.unit;

  const romEnds = ends(romValues);
  const absEnds = ends(absoluteValues);
  const accuracyEnds = ends(accuracyValues);
  const romChange = spanChange(romEnds);
  const absoluteChange = spanChange(absEnds);
  const accuracyChange = spanChange(accuracyEnds);
  /** Reps in the sessions this card's figures are about, and in the ones it set aside. */
  const shownReps = shown.reduce((n, p) => n + p.reps, 0);
  const excludedReps = excluded.reduce((n, p) => n + p.reps, 0);
  /** True when there was no complete pair to compare, so the figures above span a cut-short run. */
  const changeIncludesIncomplete = excluded.length === 0 && shown.length >= 2 && shown.some((p) => !p.completed);

  // The denominator that was in force most recently IN THIS SET — not in the window as a whole.
  const withRange = shown.filter((p) => p.calibratedMin !== null && p.calibratedSpan !== null);
  const latestRange = withRange[withRange.length - 1] ?? null;
  const latestCalibratedMin = latestRange?.calibratedMin ?? null;
  const rangeSpan = latestRange?.calibratedSpan ?? null;
  const latestCalibratedMax =
    latestCalibratedMin !== null && rangeSpan !== null ? latestCalibratedMin + rangeSpan : null;
  const rangeKnown = latestCalibratedMin !== null && latestCalibratedMax !== null;
  const anyRecalibration = shown.some((p) => p.recalibrated);

  return (
    <div className="trend-card" data-testid={`trend-${trend.key}`}>
      <div className="trend-row">
        <h4>{trend.label}</h4>
        <span className="badge">
          {plural(sessions, 'camera session')}
          {/* SAID ON THE CARD, NOT ONLY IN THE TABLE UNDERNEATH IT. Sessions are now recorded from
              every exit, so a 12-second abort sits in this window next to a full 97-second run. The
              count is the one figure that stops a therapist reading three sessions' worth of
              progress off two sessions and a walk-out — and it now says whether those aborts are
              part of what is drawn beside it. */}
          {excluded.length > 0 && (
            <span data-testid={`trend-incomplete-${trend.key}`}> · {excluded.length} set aside</span>
          )}
          {excluded.length === 0 && trend.incompleteSessions > 0 && (
            <span data-testid={`trend-incomplete-${trend.key}`}> · {trend.incompleteSessions} ended early</span>
          )}
        </span>
      </div>

      <div className="trend-block">
        <div className="trend-row">
          <div className="trend-figure">
            <span className="k">ROM achieved</span>
            <span className="v">{measured > 0 ? formatPercent(romEnds.last) : '—'}</span>
          </div>
          <DeltaBadge value={romChange} />
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
            ? `Out of the range calibrated on the day — most recently ${formatUnit(latestCalibratedMin, unit)} to ${formatUnit(latestCalibratedMax, unit)} (${formatUnit(rangeSpan, unit)} of travel).`
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
              <span className="v">{formatUnit(absEnds.last, unit)}</span>
            </div>
            <DeltaBadge
              value={absoluteChange}
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
            <span className="v">{formatPercent(accuracyEnds.last)}</span>
          </div>
          <DeltaBadge value={accuracyChange} />
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
        {plural(shownReps, 'movement')} performed
        {/* A session-date RANGE, not a pair of timestamps: "Jul 30, 2026, 10:20 PM → Sep 8, 2026,
            10:20 PM" spends half a line on a time of day nobody reads. */}
        {first && last && sessions > 1 ? ` · ${shortDate(first.at)} → ${shortDate(last.at)}` : first ? ` · ${shortDate(first.at)}` : ''}
      </div>

      {/* The per-point readout. There is no hover on a clinic tablet, so a dip in a line has to be
          traceable to a DATE somewhere on the card, not only in the session table on another screen
          (which is not per-movement and cannot answer "which session was that dip?"). */}
      <details className="trend-points">
        <summary className="dim" data-testid={`trend-points-${trend.key}`}>
          Session by session ({trend.points.length}
          {excluded.length > 0 ? `, including the ${excluded.length} set aside above` : ''})
        </summary>
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
                      {!p.completed && <span className="badge badge-warn">{endReasonLabel(p.endReason)}</span>}
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

      {/* WHAT WAS SET ASIDE, AND WHERE IT WENT. A run the patient left after nine reps is real work
          and is listed above under its own date — it is simply not a comparable MEASUREMENT of a
          session, so it anchors none of the figures, none of the plots and none of the deltas on
          this card. Saying which sessions the card is about is the whole point of the change: the
          headline, the line, the columns and the caption now name one set. */}
      {excluded.length > 0 && (
        <div className="dim" data-testid={`trend-set-aside-${trend.key}`}>
          {plural(excluded.length, 'session')} that ended early {excluded.length === 1 ? 'is' : 'are'} not in the
          figures, the plots or the change badges above — there {shown.length === 1 ? 'is' : 'are'}{' '}
          {plural(shown.length, 'complete session')} to compare instead. The{' '}
          {plural(excludedReps, 'movement')} performed in {excluded.length === 1 ? 'it' : 'them'} still happened and{' '}
          {excluded.length === 1 ? 'is' : 'are'} listed session by session above.
        </div>
      )}
      {trend.excludedSessions > 0 && (
        <div className="dim" data-testid={`trend-excluded-${trend.key}`}>
          {plural(trend.excludedSessions, `${modeList(trend.excludedModes)} session`)} with this movement{' '}
          {trend.excludedSessions === 1 ? 'is' : 'are'} not counted above: the input came from the system, not
          from the patient.
        </div>
      )}
      {changeIncludesIncomplete && (
        <div className="dim" data-testid={`trend-incomplete-change-${trend.key}`}>
          There are not two full sessions to compare, so everything above — the figures, the plots and
          the change badges — includes a run that ended early. Fewer reps, not a different patient:
          read it as a direction, not a result.
        </div>
      )}
      {anyRecalibration && (
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

export default function RomTrend({ history, patientId }: { history: readonly SessionResult[]; patientId: string }) {
  // NOT `window`: a state variable of that name shadows the global for the whole component body, so
  // the next `window.matchMedia('(prefers-reduced-motion)')` added in here would silently read 8.
  const [windowSize, setWindowSize] = useState(DEFAULT_TREND_WINDOW);
  // `history` is the whole device's; `patientId` is what makes these series this patient's.
  const trends = useMemo(() => movementTrends(history, patientId, windowSize), [history, patientId, windowSize]);
  const coverage = useMemo(() => trendCoverage(history, patientId), [history, patientId]);
  const mix = useMemo(() => trackingMix(history, patientId), [history, patientId]);

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
          Range of motion and accuracy across <b>this patient's camera</b> sessions — most recently worked first.
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

      {/*
        THE SCOPE, AND THE CONDITIONS, UNDER THE LINES THEY QUALIFY. This is the view that is read as
        outcome data — a range in degrees against a date — so it is the one that most needs to say
        what produced the numbers and how evenly they were measured.
      */}
      <div className="stack scope-note" style={{ gap: 4 }} data-testid="trend-scope">
        <ScopeNote full plain testId="trend-scope-note" />
        <span className="dim" data-testid="trend-tracking-mix">
          {mix.degraded === 0 && mix.unrecorded === 0
            ? `All ${mix.total} camera session${mix.total === 1 ? '' : 's'} behind these lines were measured on a camera stream that held up.`
            : `Of this patient's ${mix.total} camera session${mix.total === 1 ? '' : 's'}, ` +
              [
                mix.degraded > 0 ? `${mix.degraded} ${mix.degraded === 1 ? 'was' : 'were'} measured on a degraded camera stream` : null,
                mix.unrecorded > 0 ? `${mix.unrecorded} ${mix.unrecorded === 1 ? 'has' : 'have'} no tracking quality recorded` : null,
              ]
                .filter(Boolean)
                .join(' and ') +
              '. A difference between two sessions measured differently is partly the equipment; the session table states each one.'}
        </span>
      </div>

      <span className="dim">
        Each card describes ONE set of sessions: where the window holds at least two complete camera sessions, those
        are what the figure, the plots, the change badge and the rep total are all taken from, and the runs that ended
        early are named on the card and listed under it rather than drawn into the line. ROM is the mean peak of each
        rep as a fraction of that session's calibrated range; the peak figure under it is the same reps in the
        movement's own units (degrees, or a body-scaled ratio), which is the figure a re-calibration cannot move. The
        grey dashed line is the first point of that same set — the gap between it and the last point IS the change
        badge beside the figure. Each vertical axis is scaled to its data and labelled at both ends, the two percentage
        plots in a card carry the same reps, and every chart in a card shares one horizontal axis of real dates — a
        column and the points above it are the same session, and a slow gain does not draw the same slope as a fast
        one. A gold dashed line appears at 100 % of the calibrated range when the patient gets near it.
      </span>
    </div>
  );
}
