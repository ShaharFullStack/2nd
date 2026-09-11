/**
 * WHO THIS SESSION IS BEING RECORDED AGAINST, on every screen that leads to a recording.
 *
 * The picker answers the question once; this keeps the answer in front of the therapist afterwards.
 * It is on Home, the prescription screen, the ROM calibration screen, Results and History, because the
 * moment to catch "this is the wrong patient" is before the song starts, not in the export three weeks
 * later — and because a name that only appears on a screen you visited once is not an answer you can
 * rely on having read.
 *
 * Three states, all load-bearing:
 *  - a patient: name plus a one-tap switch;
 *  - NOBODY: a refusal, in the bad style, with the only button that resolves it. Screens that record
 *    something use `blocking` so this is not merely informative;
 *  - a record that is not a person (the migrated "unassigned" bucket, the keyboard/autoplay device
 *    test): named as such, so nobody mistakes it for a patient's clinical record.
 */
import { useMemo } from 'react';
import { labelIndex, patientUsage } from '../state/patients.ts';
import { useStore } from '../state/store.ts';

export function PatientBanner({ blocking = false }: { blocking?: boolean }) {
  const goto = useStore((s) => s.goto);
  const patients = useStore((s) => s.patients);
  const activePatientId = useStore((s) => s.activePatientId);
  const history = useStore((s) => s.history);
  const inputMode = useStore((s) => s.inputMode);
  const active = patients.find((p) => p.id === activePatientId) ?? null;
  // The same label the picker rendered, from the same function: a banner that says "J. Smith" when
  // two J. Smiths exist is not the at-a-glance guarantee this component is for.
  const labels = useMemo(() => labelIndex(patients, patientUsage(history)), [patients, history]);
  const label = active ? labels[active.id] : null;

  if (!active) {
    return (
      <div className="toast toast-bad" data-testid="patient-banner-none">
        <div className="row">
          <span>
            <b>No patient selected.</b>{' '}
            {blocking
              ? 'A session has to be recorded against somebody — nothing is stored, and no saved range of motion is offered, until one is chosen.'
              : 'Choose one before starting a session.'}
          </span>
          <div className="grow" />
          <button className="btn btn-primary" onClick={() => goto('patients')} data-testid="patient-choose">
            Choose patient
          </button>
        </div>
      </div>
    );
  }

  // A dev-input run is the SYSTEM driving the lanes, and the store files it under the device-test
  // record no matter who is selected (store.addResult). The banner has to say so BEFORE the run, or
  // it is promising a recording against this patient that will not happen.
  const devInput = inputMode !== 'camera';
  const notAPerson = active.deviceTest || active.unassigned || devInput;
  return (
    <div className={notAPerson ? 'toast' : 'card'} data-testid="patient-banner">
      <div className="row">
        <div className="stack" style={{ gap: 2 }}>
          <span className="eyebrow">{devInput ? 'Selected patient — runs are NOT recorded against them' : 'Recording against'}</span>
          <div className="row" style={{ gap: 10 }}>
            <b style={{ fontSize: '1.3rem' }} data-testid="patient-banner-name">
              {active.name}
            </b>
            {label?.ambiguous && (
              <span className="badge badge-warn" data-testid="patient-banner-tag">
                {label.tag}
              </span>
            )}
            {active.unassigned && <span className="badge badge-warn">unassigned records</span>}
            {active.deviceTest && <span className="badge badge-warn">not a patient</span>}
          </div>
          <span className="dim" data-testid="patient-banner-detail">
            {devInput
              ? `${inputMode} input — the lanes are driven by the system, so these runs are filed under "Device test (not a patient)".`
              : label?.detail}
          </span>
        </div>
        <div className="grow" />
        <button className="btn" onClick={() => goto('patients')} data-testid="patient-switch">
          Switch patient
        </button>
      </div>
    </div>
  );
}

export default PatientBanner;
