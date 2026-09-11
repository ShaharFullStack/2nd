/**
 * WHAT A SHARED TABLET MUST NEVER DO, as executable rules.
 *
 * All four final reviewers named the same blocker: there was no patient identity, so one device-wide
 * bucket held everyone's sessions, everyone's saved ranges and one pooled ROM trend. These tests pin
 * the three places that has to be impossible now — the record, the range, and the retention of both.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { SessionResult } from '../session/types.ts';
import type { RomCalibration } from '../vision/calibration.ts';
import { DEFAULT_SETTINGS, MAX_HISTORY, calibrationKey, defaultLanes, useStore } from './store.ts';

function result(id: string, patientId: string, patch: Partial<SessionResult> = {}): SessionResult {
  return {
    id,
    patientId,
    patientName: 'x',
    startedAt: 1,
    endedAt: 2,
    durationSec: 10,
    mode: 'leg',
    difficulty: 'medium',
    windowScale: 1,
    inputMode: 'camera',
    songId: 'demo-groove',
    songTitle: 'x',
    artist: '',
    attribution: '',
    score: 10,
    stars: 2,
    accuracy: 0.5,
    starAccuracy: 0.5,
    maxCombo: 2,
    totalNotes: 4,
    hits: 2,
    perfects: 1,
    goods: 1,
    misses: 2,
    reps: 4,
    answerRate: 1,
    timingBiasMs: null,
    timingBiasMadMs: null,
    latencyOffsetMs: 120,
    suggestedLatencyMs: null,
    completed: true,
    lanes: [],
    ...patch,
  };
}

const RANGE: RomCalibration = { min: 0, max: 1, samples: 90, movement: 'seated_march' };

function reset(): void {
  localStorage.clear();
  useStore.setState({
    screen: 'home',
    patients: [],
    activePatientId: null,
    historyDropped: {},
    mode: 'leg',
    lanes: defaultLanes('leg'),
    calibrations: [null, null],
    savedCalibrations: {},
    calibrationsByPatient: {},
    history: [],
    lastResult: null,
    settings: { ...DEFAULT_SETTINGS },
    inputMode: 'camera',
    persistenceFailed: false,
  });
}

describe('the patient a session is recorded against', () => {
  beforeEach(reset);

  it('starts as nobody — a device with no patient chosen has no honest answer', () => {
    expect(useStore.getState().activePatientId).toBeNull();
    expect(useStore.getState().config().patientId).toBe('');
  });

  it('is carried on the prescription, so a switch mid-song cannot re-attribute the run', () => {
    const a = useStore.getState().addPatient('Patient A');
    const config = useStore.getState().config();
    const b = useStore.getState().addPatient('Patient B');
    expect(config.patientId).toBe(a);
    expect(useStore.getState().config().patientId).toBe(b);
  });
});

describe('stored ranges are one person\'s', () => {
  beforeEach(reset);

  it('are never offered to another patient — switching swaps the whole map', () => {
    const a = useStore.getState().addPatient('A');
    useStore.getState().setCalibration(0, RANGE);
    const key = calibrationKey(useStore.getState().lanes[0]);
    expect(useStore.getState().savedCalibrations[key]).toBe(RANGE);

    const b = useStore.getState().addPatient('B');
    expect(useStore.getState().savedCalibrations[key]).toBeUndefined();
    // ...and the lane range measured on A does not survive into B's session either.
    expect(useStore.getState().calibrations[0]).toBeNull();

    useStore.getState().selectPatient(a);
    expect(useStore.getState().savedCalibrations[key]).toBe(RANGE);
    expect(useStore.getState().calibrationsByPatient[b]).toBeUndefined();
  });

  it('are not stored at all while nobody is selected — there is no honest key to file them under', () => {
    useStore.getState().setCalibration(0, RANGE);
    expect(useStore.getState().calibrationsByPatient).toEqual({});
    // The session in progress still gets to use the range it just measured.
    expect(useStore.getState().calibrations[0]).toBe(RANGE);
  });
});

describe('the session history', () => {
  beforeEach(reset);

  it('keeps each patient\'s sessions under their own id', () => {
    const a = useStore.getState().addPatient('A');
    const b = useStore.getState().addPatient('B');
    useStore.getState().addResult(result('a1', a));
    useStore.getState().addResult(result('b1', b));
    const history = useStore.getState().history;
    expect(history.filter((r) => r.patientId === a).map((r) => r.id)).toEqual(['a1']);
    expect(history.filter((r) => r.patientId === b).map((r) => r.id)).toEqual(['b1']);
  });

  it('trims the retention limit PER PATIENT, so a busy patient cannot evict a quiet one', () => {
    const a = useStore.getState().addPatient('A');
    const b = useStore.getState().addPatient('B');
    useStore.getState().addResult(result('b-first', b));
    for (let i = 0; i < MAX_HISTORY + 5; i++) useStore.getState().addResult(result(`a${i}`, a));

    const s = useStore.getState();
    expect(s.history.filter((r) => r.patientId === a)).toHaveLength(MAX_HISTORY);
    expect(s.history.filter((r) => r.patientId === b).map((r) => r.id)).toEqual(['b-first']);
    // The deletion is COUNTED, so the History screen can say the record is not complete.
    expect(s.historyDropped[a]).toBe(5);
    expect(s.historyDropped[b]).toBeUndefined();
  });

  it('files a record that arrived with no patient under the unassigned bucket, not under whoever is selected', () => {
    const a = useStore.getState().addPatient('A');
    useStore.getState().addResult({ ...result('orphan', a), patientId: '' });
    const stored = useStore.getState().history[0];
    expect(stored.patientId).toBe('unassigned');
    expect(useStore.getState().patients.some((p) => p.id === 'unassigned')).toBe(true);
    // ...and it is NOT in the selected patient's record.
    expect(useStore.getState().history.filter((r) => r.patientId === a)).toHaveLength(0);
  });

  it('deletes one session on its own — a mis-started run is not a reason to wipe a record', () => {
    const a = useStore.getState().addPatient('A');
    useStore.getState().addResult(result('keep', a));
    useStore.getState().addResult(result('drop', a));
    useStore.getState().deleteResult('drop');
    expect(useStore.getState().history.map((r) => r.id)).toEqual(['keep']);
  });

  it('clears only the ACTIVE patient — a tidy-up may not delete another patient\'s record', () => {
    const a = useStore.getState().addPatient('A');
    const b = useStore.getState().addPatient('B');
    useStore.getState().addResult(result('a1', a));
    useStore.getState().addResult(result('b1', b));
    useStore.getState().selectPatient(a);
    useStore.getState().clearHistory();
    expect(useStore.getState().history.map((r) => r.id)).toEqual(['b1']);
  });
});

describe('fixing the unassigned record', () => {
  beforeEach(reset);

  it('moves its sessions AND its ranges onto the patient they turn out to belong to', () => {
    const unassigned = useStore.getState().addPatient('Unassigned records');
    useStore.getState().setCalibration(0, RANGE);
    const key = calibrationKey(useStore.getState().lanes[0]);
    useStore.getState().addResult(result('old1', unassigned));
    useStore.getState().addResult(result('old2', unassigned));

    const real = useStore.getState().addPatient('Jane');
    const moved = useStore.getState().reassignSessions(unassigned, real);

    expect(moved).toBe(2);
    const s = useStore.getState();
    expect(s.history.every((r) => r.patientId === real)).toBe(true);
    expect(s.history.every((r) => r.patientName === 'Jane')).toBe(true);
    // Re-stamped with the receiving patient, not merely re-filed: the ROM screen refuses a range
    // stamped with somebody else, so leaving the old id on would make the app contradict the
    // reassignment the therapist just performed and demand a re-calibration it cannot justify.
    expect(s.calibrationsByPatient[real][key]).toEqual({ ...RANGE, patient: real });
    expect(s.calibrationsByPatient[unassigned]).toBeUndefined();
  });

  it('renaming it drops the "unassigned" badge — the therapist has answered the question', () => {
    const id = useStore.getState().addPatient('Unassigned records');
    useStore.setState({ patients: useStore.getState().patients.map((p) => ({ ...p, unassigned: true })) });
    useStore.getState().renamePatient(id, 'Jane Okafor');
    const p = useStore.getState().patients.find((x) => x.id === id)!;
    expect(p.name).toBe('Jane Okafor');
    expect(p.unassigned).toBeUndefined();
  });
});

describe('deleting a patient', () => {
  beforeEach(reset);

  it('is refused while a session is still filed under them', () => {
    const a = useStore.getState().addPatient('A');
    useStore.getState().addResult(result('a1', a));
    expect(useStore.getState().deletePatient(a)).toBe(false);
    expect(useStore.getState().patients).toHaveLength(1);
  });

  it('leaves nobody selected rather than silently selecting somebody else', () => {
    useStore.getState().addPatient('A');
    const b = useStore.getState().addPatient('B');
    expect(useStore.getState().deletePatient(b)).toBe(true);
    expect(useStore.getState().activePatientId).toBeNull();
  });
});

describe('dev-input runs', () => {
  beforeEach(reset);

  it('go to a record that is obviously not a person', () => {
    const id = useStore.getState().selectDeviceTestPatient();
    const p = useStore.getState().patients.find((x) => x.id === id)!;
    expect(p.deviceTest).toBe(true);
    expect(useStore.getState().activePatientId).toBe(id);
  });
});

/**
 * THE WAY BACK.
 *
 * The likeliest real error in this app is one session filed against the wrong person — likelier still
 * with two same-named patients on the tablet. A clinical system has to make that hard to commit AND
 * offer a correction that is not "delete the record of work the patient actually did".
 */
describe('correcting a mis-filed session', () => {
  beforeEach(reset);

  it('moves ONE session between two real patients, re-stamping the name it is filed under', () => {
    const a = useStore.getState().addPatient('J. Smith');
    const b = useStore.getState().addPatient('J. Smith (the other one)');
    useStore.getState().addResult(result('s1', a));
    useStore.getState().addResult(result('s2', a));

    expect(useStore.getState().moveResult('s1', b)).toBe(true);
    const s = useStore.getState();
    expect(s.history.find((r) => r.id === 's1')!.patientId).toBe(b);
    expect(s.history.find((r) => r.id === 's1')!.patientName).toBe('J. Smith (the other one)');
    expect(s.history.find((r) => r.id === 's2')!.patientId).toBe(a);
    // ...and it survives the reload, or it was not a correction.
    expect(JSON.parse(localStorage.getItem('beatRehab:history')!).find((r: { id: string }) => r.id === 's1').patientId).toBe(b);
  });

  it('refuses a move to a patient or a session that does not exist, and a no-op move', () => {
    const a = useStore.getState().addPatient('A');
    useStore.getState().addResult(result('s1', a));
    expect(useStore.getState().moveResult('s1', 'nobody')).toBe(false);
    expect(useStore.getState().moveResult('missing', a)).toBe(false);
    expect(useStore.getState().moveResult('s1', a)).toBe(false);
  });

  it('bulk reassignment works between two REAL patients, not only out of the unassigned record', () => {
    const a = useStore.getState().addPatient('A');
    const b = useStore.getState().addPatient('B');
    useStore.getState().addResult(result('s1', a));
    useStore.getState().addResult(result('s2', a));
    expect(useStore.getState().reassignSessions(a, b)).toBe(2);
    expect(useStore.getState().history.every((r) => r.patientId === b)).toBe(true);
  });
});

describe('a run the system drove is never a person\'s record', () => {
  beforeEach(reset);

  it('files a keyboard or autoplay run under the device-test record even with a patient selected', () => {
    const alma = useStore.getState().addPatient('Alma R.');
    useStore.getState().addResult(result('bot', alma, { inputMode: 'autoplay' }));
    const s = useStore.getState();
    expect(s.history[0].patientId).toBe('device-test');
    expect(s.history[0].patientName).toBe('Device test (not a patient)');
    // Not in her table, not in her session badge, not spending her retention budget.
    expect(s.history.filter((r) => r.patientId === alma)).toEqual([]);
    expect(s.patients.some((p) => p.id === 'device-test' && p.deviceTest)).toBe(true);
    // ...and the therapist is still recording against her for the next real session.
    expect(s.activePatientId).toBe(alma);
  });

  it('leaves camera sessions exactly where the prescription said', () => {
    const alma = useStore.getState().addPatient('Alma R.');
    useStore.getState().addResult(result('real', alma));
    expect(useStore.getState().history[0].patientId).toBe(alma);
  });
});

describe('clearing history', () => {
  beforeEach(reset);

  it('does NOTHING when no patient is selected — it is never a device-wide wipe', () => {
    const a = useStore.getState().addPatient('A');
    useStore.getState().addResult(result('s1', a));
    useStore.setState({ activePatientId: null });
    useStore.getState().clearHistory();
    expect(useStore.getState().history.map((r) => r.id)).toEqual(['s1']);
  });
});

describe('the correction cannot become a loophole', () => {
  beforeEach(reset);

  it('refuses to move a bot-driven run INTO a person\'s clinical record', () => {
    const alma = useStore.getState().addPatient('Alma R.');
    useStore.getState().addResult(result('bot', alma, { inputMode: 'autoplay' }));
    expect(useStore.getState().history[0].patientId).toBe('device-test');
    expect(useStore.getState().moveResult('bot', alma)).toBe(false);
    expect(useStore.getState().history[0].patientId).toBe('device-test');
  });

  it('lets a camera session be filed as a device test — a demo run on a real camera is not a record', () => {
    const alma = useStore.getState().addPatient('Alma R.');
    useStore.getState().selectDeviceTestPatient();
    useStore.getState().selectPatient(alma);
    useStore.getState().addResult(result('demo', alma));
    expect(useStore.getState().moveResult('demo', 'device-test')).toBe(true);
  });
});
