/**
 * The screen that answers "whose session is this", and the banner that keeps answering it.
 *
 * These tests are about the two ways this can go wrong in a clinic: the therapist cannot tell who is
 * selected (so the wrong record fills up), or the app picks somebody for them (so the wrong record
 * fills up silently). Both are checked here rather than left to the store, because both are failures
 * of what is ON SCREEN.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { SessionResult } from '../session/types.ts';
import { DEFAULT_SETTINGS, defaultLanes, useStore } from '../state/store.ts';
import HistoryScreen from './History.tsx';
import PatientBanner from './PatientBanner.tsx';
import PatientPicker from './PatientPicker.tsx';

function result(id: string, patientId: string): SessionResult {
  return {
    id, patientId, patientName: 'x', startedAt: 1_700_000_000_000, endedAt: 1_700_000_100_000, durationSec: 60,
    mode: 'leg', difficulty: 'medium', windowScale: 1, inputMode: 'camera',
    songId: 'demo-groove', songTitle: `Song ${id}`, artist: 'A', attribution: '',
    score: 100, stars: 3, accuracy: 0.8, starAccuracy: 0.8, maxCombo: 4, totalNotes: 10,
    hits: 8, perfects: 4, goods: 4, misses: 2, reps: 12, answerRate: 1,
    timingBiasMs: null, timingBiasMadMs: null, latencyOffsetMs: 120, suggestedLatencyMs: null,
    completed: true,
    lanes: [
      {
        lane: 0, movement: 'knee_extension', side: 'left', movementName: 'Left Knee extension',
        hits: 8, perfects: 4, goods: 4, misses: 2, judged: 10, accuracy: 0.8, reps: 12,
        timingBiasMs: null, timingBiasMadMs: null, romMean: 0.6, romBest: 0.8, romSamples: 12, romUncertain: 0,
        calibratedMin: 20, calibratedMax: 80, calibrationManual: false,
        compensationKind: null, compensationMonitored: false, compensationFlags: 0, compensationWorst: null,
      },
    ],
  };
}

beforeEach(() => {
  localStorage.clear();
  useStore.setState({
    screen: 'patients',
    patients: [],
    activePatientId: null,
    historyDropped: {},
    history: [],
    lastResult: null,
    lanes: defaultLanes('leg'),
    calibrations: [null, null],
    savedCalibrations: {},
    calibrationsByPatient: {},
    settings: { ...DEFAULT_SETTINGS },
    inputMode: 'camera',
  });
});
afterEach(cleanup);

describe('the patient picker', () => {
  it('says plainly that nobody is selected instead of showing a plausible name', () => {
    render(<PatientPicker />);
    expect(screen.getByTestId('patient-active').textContent).toContain('Nobody yet');
    expect(screen.queryByTestId('patient-continue')).toBeNull();
  });

  it('creates a patient and makes them the one the session is recorded against', () => {
    render(<PatientPicker />);
    fireEvent.change(screen.getByTestId('patient-name-input'), { target: { value: '  Jane   Okafor ' } });
    fireEvent.click(screen.getByTestId('patient-add'));
    expect(screen.getByTestId('patient-active').textContent).toContain('Jane Okafor');
    expect(screen.getByTestId('patient-continue').textContent).toContain('Jane Okafor');
  });

  it('switches patients in one tap, and shows which one is live', () => {
    const a = useStore.getState().addPatient('Ann');
    const b = useStore.getState().addPatient('Ben');
    render(<PatientPicker />);
    expect(screen.getByTestId(`patient-active-${b}`)).toBeTruthy();
    fireEvent.click(screen.getByTestId(`patient-select-${a}`));
    expect(useStore.getState().activePatientId).toBe(a);
    expect(screen.getByTestId(`patient-active-${a}`)).toBeTruthy();
  });

  it('refuses to delete a patient who still has a record on the device', () => {
    const a = useStore.getState().addPatient('Ann');
    useStore.getState().addResult(result('a1', a));
    render(<PatientPicker />);
    fireEvent.click(screen.getByTestId(`patient-delete-${a}`));
    expect(useStore.getState().patients).toHaveLength(1);
    expect(document.body.textContent).toContain('still has 1 stored session');
  });

  it('renames a patient in place', () => {
    const a = useStore.getState().addPatient('Ann');
    render(<PatientPicker />);
    fireEvent.click(screen.getByTestId(`patient-rename-${a}`));
    fireEvent.change(screen.getByTestId(`patient-rename-input-${a}`), { target: { value: 'Ann Smith' } });
    fireEvent.click(screen.getByTestId(`patient-rename-save-${a}`));
    expect(useStore.getState().patients[0].name).toBe('Ann Smith');
  });
});

describe('the banner every screen carries', () => {
  it('refuses, in the loud style, when there is nobody to record against', () => {
    render(<PatientBanner blocking />);
    expect(screen.getByTestId('patient-banner-none').textContent).toContain('No patient selected');
    expect(screen.getByTestId('patient-choose')).toBeTruthy();
  });

  it('names the patient, and says when the record is not a person', () => {
    useStore.getState().selectDeviceTestPatient();
    render(<PatientBanner />);
    expect(screen.getByTestId('patient-banner-name').textContent).toContain('Device test');
    expect(screen.getByTestId('patient-banner').textContent).toContain('not a patient');
  });
});

describe('the history screen', () => {
  it('shows one patient\'s sessions and no other\'s', () => {
    const a = useStore.getState().addPatient('Ann');
    const b = useStore.getState().addPatient('Ben');
    useStore.getState().addResult(result('a1', a));
    useStore.getState().addResult(result('b1', b));
    useStore.getState().selectPatient(a);

    render(<HistoryScreen />);
    expect(screen.getByTestId('history-delete-a1')).toBeTruthy();
    expect(screen.queryByTestId('history-delete-b1')).toBeNull();
    expect(document.body.textContent).toContain('Ann — session history');
    // And it says out loud that the other patient's session exists but is not shown here.
    expect(screen.getByTestId('history-retention').textContent).toContain('belonging to other patients');
  });

  it('states the retention limit, and what has already been deleted', () => {
    const a = useStore.getState().addPatient('Ann');
    useStore.getState().addResult(result('a1', a));
    useStore.setState({ historyDropped: { [a]: 3 } });
    render(<HistoryScreen />);
    const text = screen.getByTestId('history-retention').textContent ?? '';
    expect(text).toContain('most recent 100 sessions per patient');
    expect(text).toContain('3 older sessions have already been deleted');
  });

  it('asks who the record is for when nobody is selected, instead of listing the device', () => {
    const a = useStore.getState().addPatient('Ann');
    useStore.getState().addResult(result('a1', a));
    useStore.setState({ activePatientId: null });
    render(<HistoryScreen />);
    expect(document.body.textContent).toContain('Choose a patient to see their record');
    expect(screen.queryByTestId('history-delete-a1')).toBeNull();
  });
});

/**
 * THE SAME-NAME FAILURE, on screen.
 *
 * With no DOB and no record number, "J. Smith" twice is not a hypothetical — the app's own privacy
 * minimum makes it likely. Three pixel-identical rows, an identical "Record against J. Smith" button
 * and an identical banner turn the one screen built to make mis-attribution hard into a coin flip.
 */
describe('two patients with the same name', () => {
  it('warns before creating a second one, and offers the existing record instead', () => {
    const first = useStore.getState().addPatient('J. Smith');
    render(<PatientPicker />);
    fireEvent.change(screen.getByTestId('patient-name-input'), { target: { value: 'j. smith' } });
    fireEvent.click(screen.getByTestId('patient-add'));

    // Nothing has been created yet — the therapist has to say which they meant.
    expect(useStore.getState().patients).toHaveLength(1);
    expect(screen.getByTestId('patient-duplicate-warning').textContent).toContain('already on this tablet');
    fireEvent.click(screen.getByTestId(`patient-duplicate-existing-${first}`));
    expect(useStore.getState().patients).toHaveLength(1);
    expect(useStore.getState().activePatientId).toBe(first);
  });

  it('still allows a genuinely different person with the same name — a warning, not a block', () => {
    useStore.getState().addPatient('J. Smith');
    render(<PatientPicker />);
    fireEvent.change(screen.getByTestId('patient-name-input'), { target: { value: 'J. Smith' } });
    fireEvent.click(screen.getByTestId('patient-add'));
    fireEvent.click(screen.getByTestId('patient-duplicate-add-anyway'));
    expect(useStore.getState().patients).toHaveLength(2);
  });

  it('renders no two identical rows, select buttons or move targets', () => {
    const a = useStore.getState().addPatient('J. Smith');
    const b = useStore.getState().addPatient('J. Smith');
    useStore.getState().addResult({ ...result('a1', a), startedAt: 1_600_000_000_000 });
    useStore.getState().addResult(result('b1', b));
    useStore.getState().selectPatient(a);
    render(<PatientPicker />);

    const rowA = screen.getByTestId(`patient-detail-${a}`).textContent ?? '';
    const rowB = screen.getByTestId(`patient-detail-${b}`).textContent ?? '';
    expect(rowA).not.toBe(rowB);
    expect(screen.getByTestId(`patient-tag-${a}`).textContent).not.toBe(screen.getByTestId(`patient-tag-${b}`).textContent);
    // The select button carries the disambiguator too — it is the control that commits the choice.
    expect(screen.getByTestId(`patient-select-${b}`).textContent).toContain('last session');

    // ...and so does the move-target button, where a wrong tap merges two people's records.
    fireEvent.click(screen.getByTestId(`patient-move-${a}`));
    expect(screen.getByTestId(`patient-move-to-${b}`).textContent).toContain('last session');
  });

  it('disambiguates in the banner every other screen carries', () => {
    const a = useStore.getState().addPatient('J. Smith');
    useStore.getState().addPatient('J. Smith');
    useStore.getState().addResult({ ...result('a1', a), startedAt: 1_600_000_000_000 });
    useStore.getState().selectPatient(a);
    render(<PatientBanner />);
    expect(screen.getByTestId('patient-banner-tag').textContent).toContain('last session');
  });
});

describe('moving a session that was filed against the wrong person', () => {
  it('is offered on every row and does not require deleting the record', () => {
    const a = useStore.getState().addPatient('Ann');
    const b = useStore.getState().addPatient('Ben');
    useStore.getState().addResult(result('a1', a));
    useStore.getState().selectPatient(a);
    render(<HistoryScreen />);

    fireEvent.click(screen.getByTestId('history-move-a1'));
    fireEvent.click(screen.getByTestId(`history-move-to-a1-${b}`));
    expect(useStore.getState().history.find((r) => r.id === 'a1')!.patientId).toBe(b);
    expect(useStore.getState().history).toHaveLength(1);
    expect(screen.getByTestId('history-note').textContent).toContain('now belongs to Ben');
  });
});

describe('a run the system drove', () => {
  it('is announced before it starts as not being recorded against the selected patient', () => {
    const a = useStore.getState().addPatient('Ann');
    useStore.getState().selectPatient(a);
    useStore.setState({ inputMode: 'autoplay' });
    render(<PatientBanner />);
    expect(screen.getByTestId('patient-banner').textContent).toContain('NOT recorded against');
    expect(screen.getByTestId('patient-banner-detail').textContent).toContain('Device test');
  });
});
