/**
 * What the patient did today — and only then, for the therapist, how it scored.
 *
 * THIS SCREEN USED TO BE A REPORT CARD ON AN IMPAIRMENT. It led with a score, five stars (zero of
 * them below 25 % weighted accuracy) and a bare "10 % weighted accuracy", followed by a nine-column
 * clinical table; it never read the history, so a patient four weeks post-stroke saw a grade with no
 * memory and no direction. A rehab session is not graded: it is counted. So the headline is now the
 * work — movements performed, range achieved, today against last time — the clinical detail is kept
 * in full but folded away for the therapist, and the score has stopped being the first thing anybody
 * reads.
 *
 * The comparison is PATIENT-SCOPED and CAMERA-ONLY, through `patientSessions`/`isPatientDriven`
 * (session/trends.ts): a clinic tablet's history is device-wide, and a keyboard or autoplay run is
 * the system producing the input, not the patient producing a movement.
 */
import { useMemo } from 'react';
import { endReasonLabel, formatDuration, formatMs, formatPercent } from '../session/results.ts';
import { isPatientDriven, patientSessions } from '../session/trends.ts';
import type { LaneResultSummary, SessionResult } from '../session/types.ts';
import { useStore } from '../state/store.ts';
import { FEATURE_UNIT_SHORT, formatFeature } from '../vision/calibration.ts';
import { MOVEMENT_INFO } from '../vision/features.ts';
import { Meter, Screen, Stars, Toast, TopBar } from './common.tsx';
import LatencyHandover from './LatencyHandover.tsx';

/** The key a movement's history is tracked under (movement + side + fingertip), as in trends.ts. */
function laneKey(l: Pick<LaneResultSummary, 'movement' | 'side' | 'fingertip'>): string {
  return l.fingertip ? `${l.movement}:${l.side}:${l.fingertip}` : `${l.movement}:${l.side}`;
}

/** The lane's mean peak in the movement's OWN units (degrees / ratio), or null when not measured. */
function absoluteMean(l: LaneResultSummary): number | null {
  if (l.romSamples <= 0 || l.romMean === null || l.calibratedMin === null || l.calibratedMax === null) return null;
  const v = l.calibratedMin + l.romMean * (l.calibratedMax - l.calibratedMin);
  return Number.isFinite(v) ? v : null;
}

function absoluteBest(l: LaneResultSummary): number | null {
  if (l.romSamples <= 0 || l.romBest === null || l.calibratedMin === null || l.calibratedMax === null) return null;
  const v = l.calibratedMin + l.romBest * (l.calibratedMax - l.calibratedMin);
  return Number.isFinite(v) ? v : null;
}

/** "+12" / "−3" / "—". Deltas are stated as counts, never as a pass mark. */
function delta(now: number, then: number | null): string | null {
  if (then === null || !Number.isFinite(then)) return null;
  const d = now - then;
  if (d === 0) return 'same as last time';
  return `${d > 0 ? '+' : '−'}${Math.abs(Math.round(d))} vs last time`;
}

export default function ResultsScreen() {
  const goto = useStore((s) => s.goto);
  const result = useStore((s) => s.lastResult);
  const setSeed = useStore((s) => s.setSeed);
  const seed = useStore((s) => s.seed);
  const history = useStore((s) => s.history);

  /**
   * The previous session THIS patient drove, if any. The record for the run just finished is already
   * in the history, so it is excluded by id rather than by position.
   */
  const previous: SessionResult | null = useMemo(() => {
    if (!result || !isPatientDriven(result)) return null;
    const mine = patientSessions(history, result.patientId).filter((s) => s.id !== result.id && isPatientDriven(s));
    return mine[0] ?? null; // history is newest-first
  }, [history, result]);

  const previousLanes = useMemo(() => {
    const map = new Map<string, LaneResultSummary>();
    for (const l of previous?.lanes ?? []) map.set(laneKey(l), l);
    return map;
  }, [previous]);

  if (!result) {
    return (
      <Screen>
        <TopBar title="No session to show" onBack={() => goto('home')} />
        <button className="btn btn-primary btn-lg" onClick={() => goto('home')}>
          Back to start
        </button>
      </Screen>
    );
  }

  const measuredLanes = result.lanes.filter((l) => l.romSamples > 0);
  const bestLane = measuredLanes.reduce<LaneResultSummary | null>(
    (best, l) => (best === null || (l.romBest ?? 0) > (best.romBest ?? 0) ? l : best),
    null,
  );
  const sessionsSoFar = patientSessions(history, result.patientId).filter(isPatientDriven).length;

  const judged = result.hits + result.misses;
  /** Notes answered with a movement, bounded by the notes offered — null on a pre-`answerRate` record. */
  const answerRate = typeof result.answerRate === 'number' && Number.isFinite(result.answerRate) ? result.answerRate : null;
  /**
   * Counted from the lanes where the record carries them; the rate is the fallback for older ones.
   *
   * AND NEVER MORE THAN THE NOTES OFFERED. The screen must not be able to print "a movement was made
   * for 120 of the 189 notes" from a record whose per-lane and session totals disagree (a hand-built
   * or half-migrated record): the impossible sentence is exactly the defect this card was rebuilt to
   * remove, so the sum is used only when it is consistent with the session total.
   */
  const laneAttempted = result.lanes.every((l) => typeof l.attempted === 'number')
    ? result.lanes.reduce((n, l) => n + (l.attempted ?? 0), 0)
    : null;
  const answered =
    laneAttempted !== null && laneAttempted <= judged ? laneAttempted : Math.round((answerRate ?? 0) * judged);
  const surplus =
    typeof result.surplusMovements === 'number' && Number.isFinite(result.surplusMovements)
      ? result.surplusMovements
      : null;
  /**
   * MOVING AND NOT SCORING. Fires on the ratio, so the common partial fault (280 movements, 12 hits)
   * is called out as loudly as the total one. Ten movements is the floor for saying anything at all:
   * below that there is no evidence either way.
   */
  const fault = isPatientDriven(result) && result.reps >= 10 && result.hits <= 0.25 * result.reps;

  /** How the two sessions' PRESCRIBED dose differed, or null when they asked for the same thing. */
  const pacingNote: string | null = (() => {
    if (!previous) return null;
    const now = result.laneRestSec;
    const then = previous.laneRestSec;
    if (now === undefined || then === undefined) {
      return 'The pacing of one of these sessions was not recorded, so the number of reps ASKED FOR may have differed — read the change in reps with that in mind.';
    }
    if (Math.abs(now - then) < 0.05) return null;
    return `The pacing differed: last session allowed ${then.toFixed(1)} s between reps of one limb and this one ${now.toFixed(1)} s, so the two sessions asked for different numbers of reps. The change in reps performed is partly the prescription, not the patient.`;
  })();

  return (
    <Screen testId="results-screen">
      <TopBar
        eyebrow={`${result.patientName || 'No patient recorded'} · ${result.completed ? 'Session complete' : `Session ${endReasonLabel(result.endReason ?? null)}`}`}
        title={result.songTitle}
        right={
          <>
            <button
              className="btn btn-lg"
              onClick={() => {
                setSeed(seed + 1);
                goto('play');
              }}
              data-testid="play-again"
            >
              Play again
            </button>
            <button className="btn btn-primary btn-lg" onClick={() => goto('mode')}>
              New session
            </button>
          </>
        }
      />

      {/*
        A SESSION THE PATIENT DID NOT DRIVE IS NOT A CLINICAL RESULT, and it says so before any figure
        on the screen is read. Every number below (score, "movements performed", accuracy, timing) is a
        property of the keyboard or of the autoplay bot; none of it was measured on the patient, and
        none of it reaches the progress trend on the History screen.
      */}
      {result.inputMode !== 'camera' && (
        <div className="quarantine" data-testid="results-not-measured">
          <span className="glyph" aria-hidden="true">
            {result.inputMode === 'autoplay' ? '🤖' : '⌨️'}
          </span>
          <div className="stack" style={{ gap: 6 }}>
            <h3 style={{ margin: 0 }}>
              {result.inputMode === 'autoplay' ? 'Autoplay demo — not a patient session' : 'Keyboard session — no movement was measured'}
            </h3>
            <p className="muted" style={{ margin: 0 }}>
              The lanes were driven by {result.inputMode === 'autoplay' ? 'the autoplay bot' : 'keys 1–4'}, not by the
              patient's movement. The figures below describe{' '}
              {result.inputMode === 'autoplay' ? 'the bot' : 'whoever pressed the keys'}: no range of motion was
              recorded, the reps are keypresses, and this session is excluded from the progress trend on the history
              screen.
            </p>
          </div>
        </div>
      )}

      {/* THE HEADLINE IS THE WORK: reps performed, range reached, and the direction of travel. */}
      <div className="card-grid">
        <div className="card stack" data-testid="results-reps">
          <div className="eyebrow">Movements performed</div>
          <div className="big-number mono">{result.reps}</div>
          <div className="dim">
            across {result.lanes.length} movement{result.lanes.length === 1 ? '' : 's'} in {formatDuration(result.durationSec)}
          </div>
          <div className="dim" data-testid="results-reps-delta">
            {!isPatientDriven(result)
              ? 'Not compared: the patient did not drive this session'
              : previous
                ? (delta(result.reps, previous.reps) ?? '')
                : 'First recorded session for this patient'}
          </div>
          {/*
            A REP COUNT IS ONLY COMPARABLE AGAINST THE DOSE THAT WAS ASKED FOR. Pacing is the control
            that sets that dose directly — the same patient, song and difficulty gives 24 reps a lane
            at 3.0 s and 96 at 0.4 s — so "+26 vs last time" is meaningless unless both sessions were
            asked for the same number. When the pacing moved, or either session predates the control
            and did not record it, the delta above is qualified here rather than left to be read as
            progress.
          */}
          {previous && isPatientDriven(result) && pacingNote && (
            <div className="dim" data-testid="results-pacing-note">
              {pacingNote}
            </div>
          )}
          {/* Only when the song did not run to the end: otherwise judged == the whole chart and the
              line says nothing. A short session is a fact about the dose, so it is stated. */}
          {result.totalNotes > judged && judged > 0 && (
            <div className="dim" data-testid="results-short-session">
              {judged} of the {result.totalNotes} notes prescribed were reached before the session ended
            </div>
          )}
        </div>

        <div className="card stack" data-testid="results-range">
          <div className="eyebrow">Range achieved</div>
          {bestLane ? (
            <>
              <div className="big-number mono">
                {absoluteBest(bestLane) === null
                  ? formatPercent(bestLane.romBest)
                  : formatFeature(absoluteBest(bestLane) as number, MOVEMENT_INFO[bestLane.movement].unit)}
              </div>
              <div className="dim">
                best rep · {bestLane.movementName} · {formatPercent(bestLane.romBest)} of the range calibrated today
              </div>
              {/* WHAT THE NUMBER IS. A ratio movement prints a bare "0.34" — the unit has no symbol,
                  so it has to be said in words or the headline figure means nothing. */}
              <div className="dim" data-testid="results-range-unit">
                measured in {FEATURE_UNIT_SHORT[MOVEMENT_INFO[bestLane.movement].unit]}
                {MOVEMENT_INFO[bestLane.movement].unit === 'ratio'
                  ? ' — the movement against this patient’s own torso (or palm) size'
                  : ' at the joint'}
              </div>
            </>
          ) : (
            <>
              <div className="big-number mono">—</div>
              <div className="dim">no range was measured in this session</div>
            </>
          )}
        </div>

        {/*
          NOTES ANSWERED — the highway gauge's own quantity, bounded by the notes that were offered.
          It used to be movements ÷ notes CLAMPED to 1, which produced a full green card and the
          sentence "movements made for 280 of the 189 notes offered" for a tremor session that landed
          6 % of its notes. The clamp hid the one case it mattered for; the surplus is now its own
          figure below, because more movements than notes is a finding, not a success.
        */}
        <div className="card stack" data-testid="results-consistency">
          <div className="eyebrow">Notes answered</div>
          <div className="big-number mono">{answerRate === null ? '—' : formatPercent(answerRate)}</div>
          <div className="dim">
            {answerRate === null
              ? 'not recorded for this session'
              : `a movement was made for ${answered} of the ${judged} notes offered — the gauge on the highway`}
          </div>
          {answerRate !== null && <Meter value={answerRate} label="notes answered with a movement" />}
          <div className="dim" data-testid="results-surplus">
            {surplus === null
              ? ''
              : surplus > 0
                ? `${surplus} further movement${surplus === 1 ? '' : 's'} answered no note (${result.reps} performed in total)`
                : 'every movement performed answered a note'}
          </div>
        </div>

        <div className="card stack" data-testid="results-sessions">
          <div className="eyebrow">Camera sessions recorded</div>
          <div className="big-number mono">{sessionsSoFar}</div>
          <div className="dim">
            {previous ? `last session ${formatDuration(previous.durationSec)}, ${previous.reps} movements` : 'this is the first'}
          </div>
          <button className="btn" onClick={() => goto('history')} data-testid="open-history-from-results">
            Progress over time
          </button>
        </div>
      </div>

      {/*
        THE FAULT TOAST FIRES ON A RATIO, NOT ON ZERO. Gated on `hits === 0` it never fired for the
        far more common partial fault: 280 movements, 12 hits, and the screen said nothing at all
        while a 100 % card sat above it. A patient who is moving and not scoring is a measurement
        problem until proven otherwise, and the threshold is the same one a therapist would use by
        eye — most of the work produced no score.
      */}
      {fault && (
        <Toast kind="bad">
          <strong data-testid="results-fault">This looks like a calibration or latency fault, not a performance.</strong>{' '}
          The patient performed {result.reps} movements and {result.hits === 0 ? 'none of them' : `only ${result.hits}`}{' '}
          scored{judged > 0 ? ` against ${judged} notes` : ''}
          {result.timingBiasMs !== null ? `, with the timing running ${formatMs(result.timingBiasMs)}` : ''}. Check the
          ROM ranges and re-run the latency check before reading anything below as the patient's performance.
        </Toast>
      )}

      {/* TODAY AGAINST LAST TIME, per movement — the question a rehab session is actually asking. */}
      <div className="card stack" data-testid="results-today">
        <div className="row">
          <h3>Today, movement by movement</h3>
          <div className="grow" />
          <span className="dim">
            {previous
              ? 'compared with this patient’s last camera session'
              : result.inputMode === 'camera'
                ? 'no earlier camera session to compare with yet'
                : 'comparison is only drawn between camera sessions'}
          </span>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Movement</th>
                <th>Reps</th>
                <th>Range (mean rep)</th>
                <th>Best rep</th>
              </tr>
            </thead>
            <tbody>
              {result.lanes.map((l) => {
                const was = previousLanes.get(laneKey(l)) ?? null;
                const mean = absoluteMean(l);
                const wasMean = was ? absoluteMean(was) : null;
                const unit = MOVEMENT_INFO[l.movement].unit;
                return (
                  <tr key={l.lane} data-testid={`results-today-lane-${l.lane}`}>
                    <td>
                      <b>{l.movementName}</b>
                    </td>
                    <td>
                      <b className="mono">{l.reps}</b>
                      {was && <div className="dim">{delta(l.reps, was.reps)}</div>}
                    </td>
                    <td>
                      {l.romSamples > 0 ? (
                        <>
                          <span className="mono">{mean === null ? formatPercent(l.romMean) : formatFeature(mean, unit)}</span>
                          <div className="dim">
                            {formatPercent(l.romMean)} of the calibrated range
                            {wasMean !== null && mean !== null ? ` · was ${formatFeature(wasMean, unit)}` : ''}
                          </div>
                        </>
                      ) : (
                        <span className="dim">not measured</span>
                      )}
                    </td>
                    <td>
                      {l.romBest === null ? (
                        <span className="dim">—</span>
                      ) : (
                        <span className="mono">
                          {absoluteBest(l) === null ? formatPercent(l.romBest) : formatFeature(absoluteBest(l) as number, unit)}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {previous && previous.difficulty !== result.difficulty && (
          <span className="dim">
            Last session was prescribed at {previous.difficulty} and this one at {result.difficulty}: the accuracy is
            not comparable. Whether the REPS are comparable depends on the pacing, stated above.
          </span>
        )}
        {previous && pacingNote && <span className="dim">{pacingNote}</span>}
      </div>

      <LatencyHandover result={result} />

      {/* THE CLINICAL DETAIL, kept in full — and kept out of the patient's first glance. */}
      <details className="card stack" data-testid="results-clinical">
        <summary className="dim">Clinical detail — scoring, timing and compensation</summary>

        <div className="card-grid" style={{ marginTop: 12 }}>
          <div className="stack" style={{ gap: 4 }}>
            <div className="eyebrow">Score</div>
            <div className="big-number mono">{result.score.toLocaleString()}</div>
            <Stars value={result.stars} />
            <div className="dim">
              {formatPercent(result.starAccuracy)} of notes hit with the timing weighted (goods count 0.75) · best combo{' '}
              {result.maxCombo}
            </div>
          </div>
          <div className="stack" style={{ gap: 4 }}>
            <div className="eyebrow">Notes hit</div>
            <div className="big-number mono">{result.hits}</div>
            <div className="dim">
              {result.misses} missed of {result.totalNotes} notes · {result.difficulty} · windows ×
              {result.windowScale.toFixed(2)}
            </div>
            <Meter value={result.totalNotes > 0 ? result.hits / result.totalNotes : 0} label="notes hit" />
          </div>
          <div className="stack" style={{ gap: 4 }}>
            <div className="eyebrow">Timing bias</div>
            <div className="big-number mono">{formatMs(result.timingBiasMs)}</div>
            <div className="dim">
              spread ±{result.timingBiasMadMs === null ? '—' : Math.round(result.timingBiasMadMs)} ms · latency offset in
              force {result.latencyOffsetMs} ms
            </div>
          </div>
        </div>

        <div className="table-wrap" style={{ marginTop: 12 }}>
          <table className="table">
            <thead>
              <tr>
                <th>Movement</th>
                <th>Accuracy</th>
                <th>Hits</th>
                <th>Missed</th>
                <th>Reps</th>
                <th>ROM achieved</th>
                <th>Best rep</th>
                <th>Timing</th>
                <th>Compensation</th>
              </tr>
            </thead>
            <tbody>
              {result.lanes.map((l) => (
                <tr key={l.lane}>
                  <td>
                    <b>{l.movementName}</b>
                    <div className="dim">{l.perfects} perfect · {l.goods} good</div>
                  </td>
                  <td>{formatPercent(l.accuracy)}</td>
                  <td>{l.hits}</td>
                  <td>{l.misses}</td>
                  <td>{l.reps}</td>
                  <td>
                    {l.romSamples > 0 ? (
                      <>
                        {formatPercent(l.romMean)}
                        <div className="dim">
                          of calibrated range, {l.romSamples} reps
                          {l.calibratedMin !== null && l.calibratedMax !== null
                            ? ` (${l.calibratedMin.toFixed(2)}→${l.calibratedMax.toFixed(2)}${l.calibrationManual ? ', set by hand' : ''})`
                            : ''}
                        </div>
                      </>
                    ) : (
                      <span className="dim">not measured</span>
                    )}
                  </td>
                  <td>{l.romBest === null ? <span className="dim">—</span> : formatPercent(l.romBest)}</td>
                  <td>
                    {formatMs(l.timingBiasMs)}
                    {l.timingBiasMadMs !== null && <div className="dim">±{Math.round(l.timingBiasMadMs)} ms</div>}
                  </td>
                  <td>
                    {l.compensationKind === null ? (
                      <span className="dim">n/a</span>
                    ) : !l.compensationMonitored ? (
                      <span className="badge badge-warn">not measured</span>
                    ) : l.compensationFlags === 0 ? (
                      <span className="badge badge-ok">clean</span>
                    ) : (
                      <span className="badge badge-bad">
                        {l.compensationFlags} × {l.compensationKind.replace('_', ' ')}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {result.lanes.some((l) => l.romUncertain > 0) && (
          <span className="dim">
            Some reps were measured across dropped camera frames; their range is a lower bound and is marked uncertain in
            the stored record.
          </span>
        )}
      </details>

      <div className="card row">
        <div className="stack" style={{ gap: 4 }}>
          <span className="badge badge-ok">Saved to history</span>
          <span className="attribution">{result.attribution}</span>
        </div>
        <div className="grow" />
        <button className="btn" onClick={() => goto('history')}>
          Session history
        </button>
      </div>
    </Screen>
  );
}
