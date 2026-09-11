/**
 * WHO IS IN THE CHAIR IS THIS TAB'S BUSINESS. THE PATIENT LIST IS EVERYONE'S.
 *
 * `beatRehab:activePatient` used to be one device-wide localStorage slot, rewritten on every select,
 * add, rename and delete. The patient list has to be shared — it is a record — but the SELECTION is
 * not a record, it is the session this tab is about to run. With one slot, the therapist who opened a
 * second tab to look something up, and picked a patient there to read their history, moved the slot
 * the first tab would record against: the first tab's next reload came back pointed at somebody else,
 * silently, on the screen where a session is started.
 *
 * So the selection lives in `sessionStorage` (per tab, survives that tab's reloads) and the
 * localStorage slot is demoted to a hint for a tab that has never chosen — a hint the tab SAYS it is
 * using (`activePatientNotice`) instead of presenting another tab's choice as its own.
 *
 * A tab is simulated the way the rest of the store's two-tab suite does it — `vi.resetModules()` and
 * a fresh import over the same localStorage — plus its own `sessionStorage`, which is the half the
 * browser gives each tab for free and jsdom does not.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionResult } from '../session/types.ts';
import { storageKey } from './persist.ts';

/** A finished camera session, the shape `addResult` stores. */
function cameraResult(patientId: string, patientName: string): SessionResult {
  return {
    id: 's1', patientId, patientName, startedAt: 1, endedAt: 2, durationSec: 10, mode: 'leg',
    difficulty: 'medium', windowScale: 1, inputMode: 'camera', songId: 'demo-groove', songTitle: 'x',
    artist: '', attribution: '', score: 10, stars: 2, accuracy: 0.5, starAccuracy: 0.5, maxCombo: 2,
    totalNotes: 4, hits: 2, perfects: 1, goods: 1, misses: 2, reps: 4, answerRate: 1,
    timingBiasMs: null, timingBiasMadMs: null, latencyOffsetMs: 120, suggestedLatencyMs: null,
    completed: true, lanes: [],
  };
}

type Store = typeof import('./store.ts');

/** A per-tab sessionStorage, since jsdom has exactly one and two tabs need two. */
function makeTabStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
  } as Storage;
}

const realSession = window.sessionStorage;
function swapTabStorage(s: Storage): void {
  Object.defineProperty(window, 'sessionStorage', { value: s, configurable: true, writable: true });
}

/** Open a tab: its own sessionStorage, a fresh module instance, the device's shared localStorage. */
async function openTab(tab: Storage): Promise<Store> {
  swapTabStorage(tab);
  vi.resetModules();
  return (await import('./store.ts')) as Store;
}

const deviceHint = (): string | null => JSON.parse(localStorage.getItem(storageKey('activePatient')) ?? 'null');

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  swapTabStorage(realSession);
});

describe('the active patient is per tab', () => {
  it('does not hand this tab the patient another tab picked, even after a reload', async () => {
    const tabA = makeTabStorage();
    const tabB = makeTabStorage();

    const a = await openTab(tabA);
    const ann = a.useStore.getState().addPatient('Ann');
    const bob = a.useStore.getState().addPatient('Bob'); // both exist on the device
    a.useStore.getState().selectPatient(ann);
    expect(a.useStore.getState().activePatientId).toBe(ann);

    // The therapist opens a second tab and looks Bob up there.
    const b = await openTab(tabB);
    b.useStore.getState().selectPatient(bob);
    expect(b.useStore.getState().activePatientId).toBe(bob);

    // Tab A reloads (the case the device-wide slot lost): it comes back on ANN.
    const aAgain = await openTab(tabA);
    expect(aAgain.useStore.getState().activePatientId).toBe(ann);
    // …with nothing to warn about: that is this tab's own selection.
    expect(aAgain.useStore.getState().activePatientNotice).toBeNull();

    // And tab B reloading comes back on Bob. Two tabs, two chairs.
    const bAgain = await openTab(tabB);
    expect(bAgain.useStore.getState().activePatientId).toBe(bob);
  });

  it('keeps the patient LIST shared while the selection is not', async () => {
    const tabA = makeTabStorage();
    const tabB = makeTabStorage();
    const a = await openTab(tabA);
    const ann = a.useStore.getState().addPatient('Ann');
    const b = await openTab(tabB);
    const cara = b.useStore.getState().addPatient('Cara');
    // Tab A hears about the write the way the browser tells it: the list is the union…
    swapTabStorage(tabA);
    window.dispatchEvent(new StorageEvent('storage', { key: storageKey('patients'), storageArea: localStorage }));
    expect(a.useStore.getState().patients.map((p) => p.name).sort()).toEqual(['Ann', 'Cara']);
    // …and the chair is untouched.
    expect(a.useStore.getState().activePatientId).toBe(ann);
    expect(b.useStore.getState().activePatientId).toBe(cara);
  });

  it('a rename, an add and a delete elsewhere never move the device hint', async () => {
    const tabA = makeTabStorage();
    const a = await openTab(tabA);
    const ann = a.useStore.getState().addPatient('Ann');
    expect(deviceHint()).toBe(ann);

    const tabB = makeTabStorage();
    const b = await openTab(tabB);
    // Tab B never chooses anybody: it inherits the hint, then edits the shared record.
    const bo = b.useStore.getState().addPatient('Bo');
    b.useStore.getState().renamePatient(ann, 'Ann Reyes');
    expect(b.useStore.getState().deletePatient(bo)).toBe(true);
    // Only a real selection writes the hint: `addPatient` selects Bo, and deleting the patient in the
    // chair clears it — the rename in between never touched it, which is what used to move it.
    expect(deviceHint()).toBeNull();
    // …and the important half: tab A's own slot never moved.
    expect(JSON.parse(tabA.getItem(storageKey('activePatient')) ?? 'null')).toBe(ann);
    const aAgain = await openTab(tabA);
    expect(aAgain.useStore.getState().activePatientId).toBe(ann);
  });
});

describe('a change this tab did not make is said out loud', () => {
  it('says so when a fresh tab starts on the device hint rather than its own choice', async () => {
    const tabA = makeTabStorage();
    const a = await openTab(tabA);
    const ann = a.useStore.getState().addPatient('Ann');

    const fresh = await openTab(makeTabStorage());
    expect(fresh.useStore.getState().activePatientId).toBe(ann);
    expect(fresh.useStore.getState().activePatientNotice).toMatch(/last chosen on this device/i);
    // Confirming it is a human act, and it clears.
    fresh.useStore.getState().acknowledgeActivePatient();
    expect(fresh.useStore.getState().activePatientNotice).toBeNull();
    // As does choosing somebody, which is the other honest answer.
    const second = await openTab(makeTabStorage());
    expect(second.useStore.getState().activePatientNotice).not.toBeNull();
    second.useStore.getState().selectPatient(ann);
    expect(second.useStore.getState().activePatientNotice).toBeNull();
  });

  it('names a rename made in another tab instead of quietly changing the name on screen', async () => {
    const tabA = makeTabStorage();
    const a = await openTab(tabA);
    const ann = a.useStore.getState().addPatient('Ann');
    const b = await openTab(makeTabStorage());
    b.useStore.getState().renamePatient(ann, 'Ann Reyes');

    swapTabStorage(tabA);
    window.dispatchEvent(new StorageEvent('storage', { key: storageKey('patients'), storageArea: localStorage }));
    const s = a.useStore.getState();
    expect(s.patients.find((p) => p.id === ann)?.name).toBe('Ann Reyes');
    expect(s.activePatientId).toBe(ann);
    expect(s.activePatientNotice).toMatch(/Ann was renamed to Ann Reyes in another tab/i);
  });

  /**
   * SAYING IT WAS NOT ENOUGH — THE CHAIR HAS TO BE EMPTY TOO.
   *
   * Saying "Ann was deleted in another tab" while still HOLDING Ann's id is the worst of both: every
   * screen resolves the id to nobody and renders "No patient selected", while the id itself is still
   * truthy, so a `activePatientId === null` guard (the Start button's) passes and the camera session
   * behind it is filed under an id that is in no patient's list — invisible in the picker, unreachable
   * from History, impossible to move. A slot that names nobody real is not a selection: this module
   * already applies that rule at load, and it applies it here now. The sentence is what survives.
   */
  it('names a deletion made in another tab AND empties the chair, so nothing can be filed against a ghost', async () => {
    const tabA = makeTabStorage();
    const a = await openTab(tabA);
    const ann = a.useStore.getState().addPatient('Ann');
    const b = await openTab(makeTabStorage());
    // Deleting is refused while sessions exist, so this is the real (record-free) case.
    expect(b.useStore.getState().deletePatient(ann)).toBe(true);

    swapTabStorage(tabA);
    window.dispatchEvent(new StorageEvent('storage', { key: storageKey('patients'), storageArea: localStorage }));
    const s = a.useStore.getState();
    expect(s.patients.some((p) => p.id === ann)).toBe(false);
    expect(s.activePatientNotice).toMatch(/Ann was deleted in another tab/i);
    // The chair, and the ranges measured on the person who is no longer in it.
    expect(s.activePatientId).toBeNull();
    expect(s.savedCalibrations).toEqual({});
    expect(s.calibrations.every((c) => c === null)).toBe(true);
    // In storage too, both halves: a reload of this tab must not resurrect the ghost.
    expect(JSON.parse(tabA.getItem(storageKey('activePatient')) ?? 'null')).toBeNull();
    expect(deviceHint()).toBeNull();
    const aAgain = await openTab(tabA);
    expect(aAgain.useStore.getState().activePatientId).toBeNull();
    // And the record this tab would have written goes somewhere a therapist can reach it.
    expect(a.useStore.getState().config().patientId).toBe('');
  });

  /**
   * THE LAST DEFENCE, one layer below the Start button.
   *
   * The run that was already in flight when the delete landed carries the prescription's patient id
   * (SessionConfig.patientId, captured at Start), so a record can still arrive naming somebody who is
   * no longer in the list. It must not be written under that id: nothing in the app can reach it —
   * the picker does not list the patient, History scopes on the selection, and "move this session"
   * needs a record to move it FROM. It goes to the unassigned bucket, which is visible and moveable,
   * and it keeps the name it was recorded under so the therapist knows whose it was.
   */
  it('files a camera session whose patient is no longer in the list where a therapist can reach it', async () => {
    const tabA = makeTabStorage();
    const a = await openTab(tabA);
    const ann = a.useStore.getState().addPatient('Ann');
    const b = await openTab(makeTabStorage());
    expect(b.useStore.getState().deletePatient(ann)).toBe(true);
    swapTabStorage(tabA);
    window.dispatchEvent(new StorageEvent('storage', { key: storageKey('patients'), storageArea: localStorage }));

    a.useStore.getState().addResult(cameraResult(ann, 'Ann'));
    const s = a.useStore.getState();
    expect(s.history).toHaveLength(1);
    expect(s.history[0].patientId).not.toBe(ann);
    expect(s.history[0].patientId).toBe('unassigned');
    expect(s.history[0].patientName).toBe('Ann');
    // …and the record it was filed into is in the list, so History can open it and it can be moved.
    expect(s.patients.some((p) => p.id === 'unassigned')).toBe(true);
  });

  it('refuses to let "It is the right patient" be said about a patient who is not there', async () => {
    const tabA = makeTabStorage();
    const a = await openTab(tabA);
    const ann = a.useStore.getState().addPatient('Ann');
    // The state the guard is for: an id held while the list no longer has it. (The adoption above
    // clears it; this pins the store's own refusal, for any other route into the same state.)
    a.useStore.setState({ activePatientId: ann, patients: [], activePatientNotice: 'Ann was deleted in another tab.' });
    a.useStore.getState().acknowledgeActivePatient();
    expect(a.useStore.getState().activePatientNotice).toMatch(/deleted in another tab/i);
  });
});

describe('storage that refuses to work', () => {
  it('still runs the session when sessionStorage throws (private mode, blocked site data)', async () => {
    const hostile = {
      get length() {
        return 0;
      },
      clear: () => undefined,
      getItem: () => {
        throw new Error('blocked');
      },
      key: () => null,
      removeItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    } as unknown as Storage;
    const s = await openTab(hostile);
    const ann = s.useStore.getState().addPatient('Ann');
    expect(s.useStore.getState().activePatientId).toBe(ann);
    // The device hint still took it, so nothing about the selection was lost this session.
    expect(deviceHint()).toBe(ann);
    expect(s.useStore.getState().persistenceFailed).toBe(false);
  });
});
