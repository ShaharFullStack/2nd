/**
 * WHO IS THIS SESSION FOR — the first question the app asks and the last one it lets you skip.
 *
 * A clinic tablet is shared. Before this screen existed every session, every stored range and the
 * whole cross-session ROM trend lived in one device-wide bucket: "reuse last session's range" could
 * hand patient B patient A's knee, and an outcome chart pooled everyone who had ever used the tablet.
 * Identity is the fix, and identity is only worth anything if it is unmissable and takes seconds.
 *
 * DESIGN RULES HERE:
 *  - THE ACTIVE PATIENT IS THE LOUDEST THING IN THE APP, on this screen and in the banner every other
 *    screen carries (`PatientBanner`). Getting it wrong has to require ignoring a name in 2 rem type.
 *  - NOTHING IS AUTO-SELECTED. A device with no patient chosen stops here. The alternative — defaulting
 *    to the most recent patient — is precisely how patient B's session lands in patient A's record.
 *  - THE MINIMUM IDENTITY. One name field. No date of birth, no record number: see `Patient` in
 *    session/types.ts. Everything here is unencrypted localStorage on a shared device.
 *  - NO TWO ROWS MAY READ ALIKE. The privacy-minimal name is the whole identity, so two patients WILL
 *    be called "J. Smith". Every control that names a patient — row, select button, move target, the
 *    banner on every other screen — renders `PatientLabel.display`, which state/patients.ts guarantees
 *    is distinct within a same-named group (last session date, else added date, else the id tail).
 *    A second "J. Smith" is WARNED about at creation and never silently accepted.
 *  - THERE IS A WAY BACK. Sessions can be moved between any two patients, in bulk here and one at a
 *    time from the history screen. A mis-filed session must not need deleting to be corrected.
 *  - THE UNASSIGNED RECORD IS VISIBLE UNTIL IT IS DEALT WITH. Sessions recorded before this device
 *    tracked patients are filed under it, badged, and can be renamed (they were one person's) or moved
 *    wholesale onto a real patient — never silently absorbed into whoever is on screen.
 */
import { useMemo, useState } from 'react';
import { buildPatientExport } from '../session/results.ts';
import type { Patient } from '../session/types.ts';
import { findNameMatches, labelIndex, patientUsage, sortPatients } from '../state/patients.ts';
import { MAX_HISTORY, useStore } from '../state/store.ts';
import { Screen, TopBar } from './common.tsx';
import { copyToClipboard, saveTextFile } from './download.ts';

export default function PatientPicker() {
  const goto = useStore((s) => s.goto);
  const patients = useStore((s) => s.patients);
  const activePatientId = useStore((s) => s.activePatientId);
  const history = useStore((s) => s.history);
  const historyDropped = useStore((s) => s.historyDropped);
  const addPatient = useStore((s) => s.addPatient);
  const selectPatient = useStore((s) => s.selectPatient);
  const renamePatient = useStore((s) => s.renamePatient);
  const deletePatient = useStore((s) => s.deletePatient);
  const reassignSessions = useStore((s) => s.reassignSessions);
  const previousScreen = useStore((s) => s.previousScreen);

  const [newName, setNewName] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [moveFrom, setMoveFrom] = useState<string | null>(null);
  /** A typed name that already belongs to somebody: held until the therapist says which they meant. */
  const [duplicate, setDuplicate] = useState<{ name: string; matches: Patient[] } | null>(null);

  const usage = useMemo(() => patientUsage(history), [history]);
  const labels = useMemo(() => labelIndex(patients, usage), [patients, usage]);
  const counts = useMemo(() => {
    const m: Record<string, number> = {};
    for (const r of history) m[r.patientId] = (m[r.patientId] ?? 0) + 1;
    return m;
  }, [history]);

  const ordered = useMemo(() => sortPatients(patients), [patients]);
  const active = patients.find((p) => p.id === activePatientId) ?? null;
  const activeLabel = active ? labels[active.id] : null;

  const commitCreate = (name: string) => {
    addPatient(name);
    setNewName('');
    setDuplicate(null);
    setNote(`${name} is now the patient this session will be recorded against.`);
  };

  /**
   * WARN, DO NOT BLOCK. Two real people can share a name and the app must not tell a therapist their
   * patient does not exist. It must also never let the second one be created by accident, because
   * from that moment two records are one keystroke apart forever.
   */
  const create = () => {
    const name = newName.trim();
    if (!name) return;
    const matches = findNameMatches(patients, name);
    if (matches.length > 0) {
      setDuplicate({ name, matches });
      setNote(null);
      return;
    }
    commitCreate(name);
  };

  const startRename = (p: Patient) => {
    setEditing(p.id);
    setEditName(p.name);
  };

  const commitRename = () => {
    if (editing && editName.trim()) {
      const clash = findNameMatches(patients, editName, editing);
      renamePatient(editing, editName);
      setNote(
        clash.length > 0
          ? `Renamed. ${editName.trim()} is now the name of ${clash.length + 1} records on this tablet — they are told apart below by when each was last seen.`
          : null,
      );
    }
    setEditing(null);
  };

  const remove = (p: Patient) => {
    const n = counts[p.id] ?? 0;
    if (n > 0) {
      setNote(`${labels[p.id]?.display ?? p.name} still has ${n} stored session${n === 1 ? '' : 's'}. Export them, then move them to the right patient or delete them from the history screen — a patient is never deleted with a record still on the device.`);
      return;
    }
    if (!confirm(`Delete ${labels[p.id]?.display ?? p.name}? They have no stored sessions.`)) return;
    deletePatient(p.id);
    setNote(`${p.name} was deleted.`);
  };

  const exportPatient = async (p: Patient) => {
    const sessions = history.filter((r) => r.patientId === p.id);
    const record = buildPatientExport({
      patient: p,
      sessions,
      droppedSessions: historyDropped[p.id] ?? 0,
      retentionLimit: MAX_HISTORY,
    });
    saveTextFile(record.filename, record.json, 'application/json');
    const copied = await copyToClipboard(record.text);
    setNote(
      copied
        ? `${record.filename} saved, and a readable summary of ${sessions.length} session${sessions.length === 1 ? '' : 's'} is on the clipboard.`
        : `${record.filename} saved. The clipboard was refused by the browser — open the file to read the record.`,
    );
  };

  return (
    <Screen testId="patient-screen">
      <TopBar
        eyebrow="Whose session is this?"
        title="Patients on this tablet"
        onBack={previousScreen && previousScreen !== 'patients' ? () => goto(previousScreen) : () => goto('home')}
        right={
          active ? (
            <button className="btn btn-primary btn-lg" onClick={() => goto('mode')} data-testid="patient-continue">
              Start a session for {activeLabel?.display ?? active.name} →
            </button>
          ) : undefined
        }
      />

      {/* The answer to "who is this session for", in the largest type on the screen. */}
      <div className="card stack" data-testid="patient-active">
        <span className="eyebrow">This session will be recorded against</span>
        {active ? (
          <>
            <div className="big-number" style={{ fontSize: 'clamp(2rem, 5vw, 3rem)' }}>{active.name}</div>
            {/* The disambiguator sits UNDER the name in its own right, not folded into it: on the one
                screen that answers "which J. Smith", the answer has to survive being read quickly. */}
            {activeLabel?.ambiguous && (
              <div className="row">
                <span className="badge badge-warn" data-testid="patient-active-tag">{activeLabel.tag}</span>
                <span className="dim">Another patient on this tablet has the same name.</span>
              </div>
            )}
            <div className="row">
              {active.unassigned && <span className="badge badge-warn">unassigned records</span>}
              {active.deviceTest && <span className="badge badge-warn">not a patient</span>}
              <span className="dim">{activeLabel?.detail}</span>
            </div>
          </>
        ) : (
          <>
            <div className="big-number" style={{ fontSize: 'clamp(2rem, 5vw, 3rem)' }}>Nobody yet</div>
            <p className="muted" style={{ margin: 0 }}>
              Choose a patient below, or add one. Nothing is recorded, and no stored range of motion is
              offered back, until this says a name.
            </p>
          </>
        )}
      </div>

      {/* A confirmation, not a warning: the Toast styles are yellow/red and would read as "something
          went wrong" for "the patient was created". */}
      {note && (
        <div className="card" data-testid="patient-note">
          <span className="muted">{note}</span>
        </div>
      )}

      <div className="card stack">
        <h3 style={{ margin: 0 }}>Add a patient</h3>
        <div className="row">
          <div className="field grow" style={{ minWidth: 260 }}>
            <label htmlFor="new-patient">Name or initials — whatever your clinic's rules allow</label>
            <input
              id="new-patient"
              className="control"
              value={newName}
              maxLength={60}
              placeholder="e.g. J. Okafor — Tue group"
              onChange={(e) => {
                setNewName(e.target.value);
                setDuplicate(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') create();
              }}
              data-testid="patient-name-input"
            />
          </div>
          <button className="btn btn-primary btn-lg" onClick={create} disabled={!newName.trim()} data-testid="patient-add">
            Add &amp; select
          </button>
        </div>

        {/* THE SAME-NAME STOP. Not a refusal — two people really can be "J. Smith" — but the second
            one is never created by a therapist who did not mean to, and the likelier intention (this
            IS the patient already on the tablet) is one large tap away. */}
        {duplicate && (
          <div className="toast" data-testid="patient-duplicate-warning">
            <div className="stack" style={{ gap: 10 }}>
              <span>
                <b>
                  {duplicate.matches.length === 1
                    ? `A patient called ${duplicate.matches[0].name} is already on this tablet.`
                    : `${duplicate.matches.length} patients called ${duplicate.matches[0].name} are already on this tablet.`}
                </b>{' '}
                If this is the same person, select them — a second record would split their history and
                their calibrated ranges in two. If it is a different person with the same name, add
                them: both will be labelled by when they were last seen.
              </span>
              {duplicate.matches.map((m) => (
                <button
                  key={m.id}
                  className="btn btn-primary btn-lg"
                  onClick={() => {
                    selectPatient(m.id);
                    setNewName('');
                    setDuplicate(null);
                    setNote(`${labels[m.id]?.display ?? m.name} is now the patient this session will be recorded against — no new record was created.`);
                  }}
                  data-testid={`patient-duplicate-existing-${m.id}`}
                >
                  Use the existing {labels[m.id]?.display ?? m.name}
                </button>
              ))}
              <div className="row">
                <button
                  className="btn btn-danger"
                  onClick={() => commitCreate(duplicate.name)}
                  data-testid="patient-duplicate-add-anyway"
                >
                  Add a different person also called {duplicate.name}
                </button>
                <button className="btn btn-ghost" onClick={() => setDuplicate(null)} data-testid="patient-duplicate-cancel">
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        <span className="dim">
          Stored in this browser only, unencrypted, on a device other people use. Keep it to what you need
          to tell two patients apart — no date of birth, no record number.
        </span>
      </div>

      <h3 style={{ marginBottom: 0 }}>Everyone on this tablet ({patients.length})</h3>
      {patients.length === 0 && (
        <div className="card">
          <p className="muted" style={{ margin: 0 }}>No patients yet. Add the first one above.</p>
        </div>
      )}

      <div className="stack">
        {ordered.map((p) => {
          const n = counts[p.id] ?? 0;
          const label = labels[p.id];
          const isActive = p.id === activePatientId;
          const moveTargets = patients.filter((t) => t.id !== p.id && !t.deviceTest);
          return (
            <div className="card stack" key={p.id} data-testid={`patient-row-${p.id}`}>
              <div className="row">
                {editing === p.id ? (
                  <>
                    <input
                      className="control grow"
                      value={editName}
                      maxLength={60}
                      autoFocus
                      onChange={(e) => setEditName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitRename();
                        if (e.key === 'Escape') setEditing(null);
                      }}
                      data-testid={`patient-rename-input-${p.id}`}
                    />
                    <button className="btn btn-primary" onClick={commitRename} data-testid={`patient-rename-save-${p.id}`}>
                      Save name
                    </button>
                    <button className="btn btn-ghost" onClick={() => setEditing(null)}>
                      Cancel
                    </button>
                  </>
                ) : (
                  <div className="stack grow" style={{ gap: 8 }}>
                    <div className="row" style={{ gap: 10 }}>
                      <b style={{ fontSize: '1.25rem' }}>{p.name}</b>
                      {/* The one thing that makes this row not the row above it. */}
                      {label?.ambiguous && (
                        <span className="badge badge-warn" data-testid={`patient-tag-${p.id}`}>
                          {label.tag}
                        </span>
                      )}
                      {isActive && <span className="badge badge-ok" data-testid={`patient-active-${p.id}`}>selected</span>}
                      {p.unassigned && <span className="badge badge-warn">unassigned</span>}
                      {p.deviceTest && <span className="badge badge-warn">not a patient</span>}
                    </div>
                    <span className="dim" data-testid={`patient-detail-${p.id}`}>{label?.detail}</span>
                    {/* Actions on their own line. The select button carries the disambiguator and is
                        therefore long; sharing a line with the name made every row wrap differently,
                        which is the opposite of what a row of near-identical patients needs. */}
                    <div className="row">
                      {!isActive && (
                        <button className="btn btn-primary" onClick={() => selectPatient(p.id)} data-testid={`patient-select-${p.id}`}>
                          Record against {label?.display ?? p.name}
                        </button>
                      )}
                      <div className="grow" />
                      <button className="btn" onClick={() => startRename(p)} data-testid={`patient-rename-${p.id}`}>
                        Rename
                      </button>
                      <button className="btn" onClick={() => void exportPatient(p)} data-testid={`patient-export-${p.id}`}>
                        Export record
                      </button>
                      <button className="btn btn-danger" onClick={() => remove(p)} data-testid={`patient-delete-${p.id}`}>
                        Delete
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* THE WAY BACK, for any record with sessions in it — not only the unassigned one.
                  The likeliest real error in this app is a session filed against the wrong person, and
                  on a tablet with two same-named patients it is a likely one. Deleting the record to
                  fix a label is not a correction; moving it is. (History moves them one at a time.) */}
              {n > 0 && !p.deviceTest && (
                <div className="stack" style={{ gap: 8 }}>
                  <span className="dim">
                    {p.unassigned
                      ? `${n} session${n === 1 ? '' : 's'} recorded before this device tracked patients. Rename this record if they are all one patient's, or move them onto an existing patient.`
                      : `${n} session${n === 1 ? '' : 's'} filed here. If they belong to somebody else — the other ${p.name}, say — move them rather than deleting them.`}
                  </span>
                  {moveFrom === p.id ? (
                    <div className="row">
                      <span className="dim">Move all {n} onto:</span>
                      {moveTargets.map((t) => (
                        <button
                          key={t.id}
                          className="btn btn-lg"
                          onClick={() => {
                            const moved = reassignSessions(p.id, t.id);
                            setMoveFrom(null);
                            setNote(`${moved} session${moved === 1 ? '' : 's'} and their stored ranges now belong to ${labels[t.id]?.display ?? t.name}.`);
                          }}
                          data-testid={`patient-move-to-${t.id}`}
                        >
                          {labels[t.id]?.display ?? t.name}
                        </button>
                      ))}
                      {moveTargets.length === 0 && <span className="dim">Add a patient first.</span>}
                      <button className="btn btn-ghost" onClick={() => setMoveFrom(null)}>
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <div className="row">
                      <button className="btn" onClick={() => setMoveFrom(p.id)} data-testid={`patient-move-${p.id}`}>
                        Move these sessions to another patient…
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <span className="dim">
        Sessions, stored ranges of motion and the progress charts are all kept per patient: switching here
        switches all three. This device keeps at most {MAX_HISTORY} sessions per patient — export a record
        to keep it beyond that, or beyond a cleared browser.
      </span>
    </Screen>
  );
}
