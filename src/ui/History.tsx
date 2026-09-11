/**
 * ONE PATIENT'S RECORD. Never the device's.
 *
 * This screen used to list every session stored on the tablet, which on a shared device meant one
 * patient's table and one patient's ROM trend were built out of several people's sessions. Everything
 * here is scoped to the patient named in the banner at the top, and there is no view that is not.
 *
 * Two further honesty rules, both of which cost a line of UI and buy a record you can trust:
 *  - RETENTION IS STATED, NOT SILENT. The device keeps `MAX_HISTORY` sessions per patient and deletes
 *    the rest. A table that just stops at 100 looks exactly like a complete record; the count of what
 *    has already gone is kept (`historyDropped`) and printed.
 *  - THE RECORD CAN LEAVE. A file to save and a readable copy on the clipboard, per patient — because
 *    a clinical record that only exists in one browser's localStorage is one cleared cache from gone.
 */
import { useMemo, useState } from 'react';
import { buildPatientExport, endReasonLabel, formatDate, formatDuration, formatMs, formatPercent } from '../session/results.ts';
import { labelIndex, patientUsage } from '../state/patients.ts';
import { MAX_HISTORY, useStore } from '../state/store.ts';
import { Screen, Stars, TopBar } from './common.tsx';
import { ScopeNote } from './ScopeNote.tsx';
import { TRACKING_NOT_RECORDED, trackingConditions, trackingGrade } from '../session/tracking.ts';
import { ScrollTable } from './Results.tsx';
import PatientBanner from './PatientBanner.tsx';
import RomTrend from './RomTrend.tsx';
import { copyToClipboard, saveTextFile } from './download.ts';

export default function HistoryScreen() {
  const goto = useStore((s) => s.goto);
  const allHistory = useStore((s) => s.history);
  const clearHistory = useStore((s) => s.clearHistory);
  const deleteResult = useStore((s) => s.deleteResult);
  const moveResult = useStore((s) => s.moveResult);
  const patients = useStore((s) => s.patients);
  const activePatientId = useStore((s) => s.activePatientId);
  const historyDropped = useStore((s) => s.historyDropped);
  const [note, setNote] = useState<string | null>(null);
  /** The session whose "this is the wrong person" correction is open. */
  const [moving, setMoving] = useState<string | null>(null);
  /**
   * THE GRADE IS OPT-IN HERE, EXACTLY AS IT IS ON RESULTS.
   *
   * This table read WHEN | SESSION | SCORE | STARS | ACCURACY | REPS | …, so the entertainment grade
   * on an impairment came before the count of work the patient did — the same ordering Results was
   * corrected out of, contradicting it one screen later. The work now leads, and the five scoring
   * columns (score, stars, accuracy, best combo, timing) are one tap away rather than in front of
   * the patient's face. Folding them also takes ~380 px off the table, which is most of what used to
   * push the per-movement column off a 1024-wide tablet.
   */
  const [showScoring, setShowScoring] = useState(false);

  const patient = patients.find((p) => p.id === activePatientId) ?? null;
  const labels = useMemo(() => labelIndex(patients, patientUsage(allHistory)), [patients, allHistory]);
  const label = patient ? labels[patient.id] : null;
  // Every other patient this session could really belong to. The device-test record is included: a
  // camera run that was actually a demo belongs there, not in somebody's outcome data.
  const moveTargets = useMemo(() => patients.filter((p) => p.id !== activePatientId), [patients, activePatientId]);
  // The scoping happens ONCE, here, and everything below reads `history`. The trend view is handed the
  // patient id as well and filters again — the one number a shared tablet may not get wrong is worth
  // checking twice.
  const history = useMemo(
    () => (activePatientId ? allHistory.filter((r) => r.patientId === activePatientId) : []),
    [allHistory, activePatientId],
  );
  const dropped = activePatientId ? (historyDropped[activePatientId] ?? 0) : 0;
  const otherPatients = allHistory.length - history.length;

  const exportRecord = async () => {
    if (!patient) return;
    const record = buildPatientExport({ patient, sessions: history, droppedSessions: dropped, retentionLimit: MAX_HISTORY });
    saveTextFile(record.filename, record.json, 'application/json');
    const copied = await copyToClipboard(record.text);
    setNote(
      copied
        ? `Saved ${record.filename}, and a readable summary is on the clipboard — paste it into your notes.`
        : `Saved ${record.filename}. This browser refused the clipboard, so open the file to read the record.`,
    );
  };

  return (
    <Screen testId="history-screen">
      <TopBar
        eyebrow={patient ? `${history.length} session${history.length === 1 ? '' : 's'} for this patient` : 'No patient selected'}
        title={patient ? `${label?.display ?? patient.name} — session history` : 'Session history'}
        onBack={() => goto('home')}
        right={
          history.length > 0 ? (
            <>
              <button className="btn btn-primary btn-lg" onClick={() => void exportRecord()} data-testid="history-export">
                Export record
              </button>
              <button
                className="btn btn-danger"
                onClick={() => {
                  if (confirm(`Delete all ${history.length} stored sessions for ${patient?.name}? Export first if you need them.`)) {
                    clearHistory();
                    setNote(null);
                  }
                }}
              >
                Delete this patient's sessions
              </button>
            </>
          ) : undefined
        }
      />

      <PatientBanner />
      {/*
        THE SCOPE STATEMENT, ON THE SCREEN THAT TURNS SESSIONS INTO A TREND AND A FILE. This is where
        a range in degrees is plotted across six weeks and where the exported record is produced; it
        is exactly the screen a reader is most likely to mistake for a clinical instrument, and it
        used to say nothing about what it is at all.
      */}
      <ScopeNote full testId="history-scope" />
      {note && (
        <div className="card" data-testid="history-note">
          <span className="muted">{note}</span>
        </div>
      )}

      {!patient ? (
        <div className="card stack">
          <h3>Choose a patient to see their record</h3>
          <p className="muted">
            Sessions are kept per patient. {allHistory.length > 0
              ? `There ${allHistory.length === 1 ? 'is 1 session' : `are ${allHistory.length} sessions`} stored on this device across all patients.`
              : 'Nothing has been recorded on this device yet.'}
          </p>
          <button className="btn btn-primary btn-lg" onClick={() => goto('patients')}>
            Choose patient
          </button>
        </div>
      ) : history.length === 0 ? (
        <div className="card stack">
          <h3>Nothing recorded for {patient.name} yet</h3>
          <p className="muted">Sessions are stored in this browser only — nothing leaves the device unless you export it.</p>
          <button className="btn btn-primary btn-lg" onClick={() => goto('mode')}>
            Start a session
          </button>
        </div>
      ) : (
        <>
          <RomTrend history={allHistory} patientId={patient.id} />

          <div className="row">
            <h3 style={{ marginBottom: 0 }}>Every session</h3>
            <div className="grow" />
            <button
              className="btn btn-sm"
              aria-pressed={showScoring}
              onClick={() => setShowScoring((v) => !v)}
              data-testid="history-toggle-scoring"
            >
              {showScoring ? 'Hide scoring columns' : 'Show scoring columns'}
            </button>
          </div>
          <div className="card">
            <ScrollTable
              offscreen={
                showScoring
                  ? 'the scoring columns — accuracy, score, stars, best combo and timing'
                  : 'the length and the per-movement detail'
              }
              testId="history-table"
            >
            <table className="table">
            <thead>
              {/* WORK FIRST: what the patient did, then how long it took, then — only if asked for —
                  how it scored. */}
              <tr>
                <th>When</th>
                <th>Session</th>
                <th>Movements performed</th>
                <th>Range worked</th>
                <th>Length</th>
                {showScoring && (
                  <>
                    <th>Accuracy</th>
                    <th>Score</th>
                    <th>Stars</th>
                    <th>Combo</th>
                    <th>Timing</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody>
              {history.map((r) => (
                <tr key={r.id}>
                  {/* The per-session delete lives in the FIRST column, not a trailing one: this table
                      scrolls horizontally on a tablet, and an action in the last column is an action
                      the therapist never finds. */}
                  <td>
                    {formatDate(r.startedAt)}
                    {!r.completed && <div className="dim">{endReasonLabel(r.endReason ?? null)}</div>}
                    {/* THE CORRECTION THAT IS NOT A DELETION. A session filed against the wrong
                        person is the likeliest real error here — likelier still with two same-named
                        patients on the tablet — and destroying the record of work the patient did is
                        not an acceptable way to fix a label. */}
                    <div>
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => setMoving(moving === r.id ? null : r.id)}
                        data-testid={`history-move-${r.id}`}
                      >
                        {moving === r.id ? 'Cancel move' : 'Wrong patient?'}
                      </button>
                    </div>
                    {/* Stretched, full-size taps: this list is used by therapists with a patient
                        mid-transfer beside them, and a mis-tap here merges two people's records. */}
                    {moving === r.id && (
                      <div className="stack" style={{ gap: 6, marginTop: 6, alignItems: 'stretch' }} data-testid={`history-move-targets-${r.id}`}>
                        <span className="dim">
                          {r.inputMode === 'camera'
                            ? 'Move this session to:'
                            : 'This run was driven by the system, so it can only be filed as a device test:'}
                        </span>
                        {moveTargets.filter((t) => r.inputMode === 'camera' || t.deviceTest).map((t) => (
                          <button
                            key={t.id}
                            className="btn"
                            onClick={() => {
                              if (!moveResult(r.id, t.id)) return;
                              setMoving(null);
                              setNote(
                                `The session from ${formatDate(r.startedAt)} now belongs to ${labels[t.id]?.display ?? t.name}. ` +
                                  'It has left this patient\u2019s table, trend and export.',
                              );
                            }}
                            data-testid={`history-move-to-${r.id}-${t.id}`}
                          >
                            {labels[t.id]?.display ?? t.name}
                          </button>
                        ))}
                        {moveTargets.filter((t) => r.inputMode === 'camera' || t.deviceTest).length === 0 && (
                          <span className="dim">There is nobody else on this tablet to move it to.</span>
                        )}
                      </div>
                    )}
                    <div>
                      <button
                        className="btn btn-ghost btn-sm"
                        onClick={() => {
                          if (confirm(`Delete the session from ${formatDate(r.startedAt)}? This cannot be undone.`)) deleteResult(r.id);
                        }}
                        data-testid={`history-delete-${r.id}`}
                      >
                        Delete session
                      </button>
                    </div>
                  </td>
                  <td>
                    <b>{r.songTitle}</b>
                    <div className="dim">
                      {r.mode === 'leg' ? 'Leg' : 'Hand'} · {r.difficulty}
                    </div>
                    {/* Quarantined in the record itself, not only in the trend above: these rows are
                        the system's input, and their score/accuracy/reps are not the patient's. */}
                    {r.inputMode !== 'camera' && (
                      <span className="badge badge-warn" data-testid={`history-not-measured-${r.id}`}>
                        {r.inputMode} · not measured
                      </span>
                    )}
                  </td>
                  <td className="mono">
                    <b>{r.reps}</b>
                    {/* THE DOSE THE REPS WERE ASKED FOR. Pacing sets the rep count directly (0.4 s
                        gives ~4× the reps of 3.0 s on the same song), so a rep count compared down
                        this column without it is not a comparison. */}
                    <div className="dim">
                      {r.laneRestSec === undefined ? 'pacing not recorded' : `at ${r.laneRestSec.toFixed(1)} s pacing`}
                    </div>
                  </td>
                  <td>
                    {r.lanes.map((l) => (
                      <div key={l.lane} className="dim">
                        {l.movementName}: {l.reps} reps
                        {l.romMean !== null ? ` · ${formatPercent(l.romMean)} ROM` : ''}
                        {l.compensationMonitored && l.compensationFlags > 0 ? ` · ${l.compensationFlags} flagged` : ''}
                      </div>
                    ))}
                    {/* HOW WELL THE CAMERA WAS TRACKING WHEN THOSE RANGES WERE MEASURED. Two rows of
                        this column can differ by a factor of three in frame rate; without this the
                        column reads as one comparable series of measurements, which is how a change
                        in the equipment becomes a change in the patient. */}
                    {r.inputMode === 'camera' && (
                      <div className="dim" data-testid={`history-tracking-${r.id}`}>
                        {r.tracking ? (
                          <>
                            <span
                              className={
                                trackingGrade(r.tracking) === 'good'
                                  ? 'badge badge-ok'
                                  : trackingGrade(r.tracking) === 'fair'
                                    ? 'badge badge-warn'
                                    : 'badge badge-bad'
                              }
                            >
                              tracking {trackingGrade(r.tracking)}
                            </span>{' '}
                            {trackingConditions(r.tracking)}
                          </>
                        ) : (
                          TRACKING_NOT_RECORDED
                        )}
                      </div>
                    )}
                  </td>
                  <td className="mono">{formatDuration(r.durationSec)}</td>
                  {showScoring && (
                    <>
                      <td className="mono">{formatPercent(r.accuracy)}</td>
                      <td className="mono">{r.score.toLocaleString()}</td>
                      <td>
                        <Stars value={r.stars} />
                      </td>
                      <td className="mono">{r.maxCombo}</td>
                      <td className="mono">{formatMs(r.timingBiasMs)}</td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
            </table>
            </ScrollTable>
          </div>

          {/* WHAT THIS RECORD IS MISSING. A truncated record that does not say it is truncated is the
              same failure as a pooled one: the therapist reads a complete history that is not. */}
          <div className="dim" data-testid="history-retention">
            This device keeps the most recent {MAX_HISTORY} sessions per patient; older ones are deleted
            automatically to stay inside the browser's storage.{' '}
            {dropped > 0 ? (
              <b>
                {dropped} older session{dropped === 1 ? ' has' : 's have'} already been deleted for {label?.display ?? patient.name} and{' '}
                {dropped === 1 ? 'is' : 'are'} not in this table or in any export.
              </b>
            ) : (
              `${history.length} of ${MAX_HISTORY} used — nothing has been deleted for ${label?.display ?? patient.name} yet.`
            )}{' '}
            Exported records are the only copy that survives a cleared browser.
            {otherPatients > 0 && ` ${otherPatients} session${otherPatients === 1 ? '' : 's'} belonging to other patients on this tablet are not shown here.`}
          </div>
        </>
      )}
    </Screen>
  );
}
