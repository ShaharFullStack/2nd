/**
 * TWO TABS ON ONE CLINIC TABLET, WHICH USED TO SILENTLY DESTROY EACH OTHER'S DATA.
 *
 * The store reads localStorage ONCE, at module load, and every write replays that whole in-memory
 * copy over the key. A second tab — the therapist's History tab, or yesterday's tab nobody closed —
 * therefore held a snapshot from before the first tab recorded anything, and its next write deleted
 * every session, patient and range the other tab had added since.
 *
 * A second tab is simulated exactly as the browser makes one: `vi.resetModules()` and a fresh import
 * of the store, which re-runs the module-load snapshot against the SAME localStorage. That is the
 * real failure mode, not an approximation of it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionResult } from '../session/types.ts';
import type { RomCalibration } from '../vision/calibration.ts';
import { storageKey } from './persist.ts';

type Store = typeof import('./store.ts');

function result(id: string, patientId: string, startedAt: number): SessionResult {
  return {
    id,
    patientId,
    patientName: 'Pat',
    startedAt,
    endedAt: startedAt + 1,
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
  };
}

/** Open a tab: a fresh module instance over the localStorage that is already on the device. */
async function openTab(): Promise<Store> {
  vi.resetModules();
  return (await import('./store.ts')) as Store;
}

function historyOnDisk(): SessionResult[] {
  return JSON.parse(localStorage.getItem(storageKey('history')) ?? '[]') as SessionResult[];
}

describe('two tabs, one tablet', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('does not let the second tab delete the first tab\'s sessions', async () => {
    const tabA = await openTab();
    const tabB = await openTab(); // opened before either has recorded anything

    const pid = tabA.useStore.getState().addPatient('Ann');
    tabA.useStore.getState().addResult(result('run-A', pid, 1_000));
    // Tab B has been sitting on the setup screen this whole time; now its session ends.
    tabB.useStore.getState().addResult(result('run-B', pid, 2_000));

    expect(historyOnDisk().map((r) => r.id).sort()).toEqual(['run-A', 'run-B']);
    // …and the tab that wrote last holds both, so its OWN next write cannot drop the other again.
    expect(tabB.useStore.getState().history.map((r) => r.id).sort()).toEqual(['run-A', 'run-B']);
  });

  it('keeps the merged history newest-first, the order every screen reads', async () => {
    const tabA = await openTab();
    const tabB = await openTab();
    tabA.useStore.getState().addResult(result('older', 'p', 1_000));
    tabB.useStore.getState().addResult(result('newer', 'p', 5_000));
    expect(tabB.useStore.getState().history.map((r) => r.id)).toEqual(['newer', 'older']);
  });

  it('keeps a patient added in the other tab', async () => {
    const tabA = await openTab();
    const tabB = await openTab();
    tabA.useStore.getState().addPatient('Ann');
    tabB.useStore.getState().addPatient('Bob');
    const names = JSON.parse(localStorage.getItem(storageKey('patients')) ?? '[]').map((p: { name: string }) => p.name);
    expect(names.sort()).toEqual(['Ann', 'Bob']);
  });

  it('keeps the other tab\'s ranges, and the NEWER capture wins for the same lane', async () => {
    const tabA = await openTab();
    const tabB = await openTab();
    const pid = tabA.useStore.getState().addPatient('Ann');
    // Tab B learns about the patient the way the browser tells it, then puts them in its own chair.
    window.dispatchEvent(new StorageEvent('storage', { key: storageKey('patients'), storageArea: localStorage }));
    tabB.useStore.getState().selectPatient(pid); // the same person, in both tabs

    const old: RomCalibration = { min: 0, max: 1, samples: 90, movement: 'seated_march', capturedAt: 1_000 };
    const fresh: RomCalibration = { min: 0, max: 2, samples: 90, movement: 'seated_march', capturedAt: 9_000 };
    tabA.useStore.getState().setCalibration(0, fresh);
    tabB.useStore.getState().setCalibration(1, old); // a different lane, in the other tab

    const stored = JSON.parse(localStorage.getItem(storageKey('calibrations')) ?? '{}') as Record<string, Record<string, RomCalibration>>;
    const lanes = tabB.useStore.getState().lanes;
    const keyA = tabB.calibrationKey(lanes[0]);
    const keyB = tabB.calibrationKey(lanes[1]);
    expect(stored[pid][keyA].max).toBe(2); // tab A's range survived tab B's write
    expect(stored[pid][keyB].max).toBe(1);

    // …and a stale range never displaces a newer one measured in the other tab.
    tabB.useStore.getState().setCalibration(0, { ...old, max: 0.5 });
    const after = JSON.parse(localStorage.getItem(storageKey('calibrations')) ?? '{}') as Record<string, Record<string, RomCalibration>>;
    expect(after[pid][keyA].max).toBe(2);
  });

  it('a deletion is not undone by the merge', async () => {
    const tab = await openTab();
    const pid = tab.useStore.getState().addPatient('Ann');
    tab.useStore.getState().addResult(result('keep', pid, 1_000));
    tab.useStore.getState().addResult(result('bin', pid, 2_000));
    tab.useStore.getState().deleteResult('bin');
    // A later write must not read 'bin' back off disk and resurrect it.
    tab.useStore.getState().addResult(result('third', pid, 3_000));
    expect(historyOnDisk().map((r) => r.id).sort()).toEqual(['keep', 'third']);
  });

  it('adopts the other tab\'s write when the browser announces it', async () => {
    const tabA = await openTab();
    const tabB = await openTab();
    const pid = tabA.useStore.getState().addPatient('Ann');
    tabA.useStore.getState().addResult(result('run-A', pid, 1_000));

    // jsdom does not deliver storage events between module instances; the browser does. Fire the one
    // the browser would have fired for tab A's write.
    expect(tabB.useStore.getState().history).toHaveLength(0);
    window.dispatchEvent(new StorageEvent('storage', { key: storageKey('history'), storageArea: localStorage }));
    expect(tabB.useStore.getState().history.map((r) => r.id)).toEqual(['run-A']);

    window.dispatchEvent(new StorageEvent('storage', { key: storageKey('patients'), storageArea: localStorage }));
    expect(tabB.useStore.getState().patients.map((p) => p.name)).toEqual(['Ann']);
  });

  it('does not let another tab re-point the patient this tab has in the chair', async () => {
    const tabA = await openTab();
    const tabB = await openTab();
    const ann = tabA.useStore.getState().addPatient('Ann');
    const bob = tabB.useStore.getState().addPatient('Bob');
    expect(tabB.useStore.getState().activePatientId).toBe(bob);
    window.dispatchEvent(new StorageEvent('storage', { key: storageKey('patients'), storageArea: localStorage }));
    // Tab A selected Ann; tab B is still recording against Bob.
    expect(tabA.useStore.getState().activePatientId).toBe(ann);
    expect(tabB.useStore.getState().activePatientId).toBe(bob);
  });
});

/**
 * THE SAME INSTANT, NOT THE SAME MINUTE.
 *
 * Taking turns is the realistic case and the reconcile-on-write above fixes it. What it cannot fix
 * is two tabs whose reads both happen before either write lands — `localStorage` read-modify-write
 * is not atomic across tabs, so the second write replaces the first tab's session outright. Measured
 * with two real tabs in one browser context: 3 trials out of 3 lost a session, gone from disk and
 * from the recording tab's own memory. A lost session is lost clinical evidence, with no error and
 * no undo, so it may not happen at all.
 *
 * The interleaving is reproduced by freezing every key at the value it had when the window opened,
 * for the duration of both writes — which is exactly what two tabs reading before either writes
 * looks like from inside the store.
 */
describe('two tabs recording in the same instant', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  /** Run `both` with every localStorage key frozen at its pre-window value. */
  function simultaneously(both: () => void): void {
    const real = Storage.prototype.getItem;
    const frozen = new Map<string, string | null>();
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key: string) {
      if (!frozen.has(key)) frozen.set(key, real.call(this, key));
      return frozen.get(key) ?? null;
    });
    try {
      both();
    } finally {
      spy.mockRestore();
    }
  }

  it('keeps BOTH sessions — neither tab may destroy the other\'s record', async () => {
    const tabA = await openTab();
    const tabB = await openTab();
    const pid = tabA.useStore.getState().addPatient('Ann');
    window.dispatchEvent(new StorageEvent('storage', { key: storageKey('patients'), storageArea: localStorage }));

    simultaneously(() => {
      tabA.useStore.getState().addResult(result('run-A', pid, 1_000));
      tabB.useStore.getState().addResult(result('run-B', pid, 2_000));
    });

    // Straight after the collision one of them is gone: that is the bug, and it is not fixable at
    // write time. What is required is that it does not SURVIVE.
    await tabA.recordsSettled();
    await tabB.recordsSettled();

    expect(historyOnDisk().map((r) => r.id).sort()).toEqual(['run-A', 'run-B']);
  });

  it('brings the restored list into the tab that was clobbered, not just onto disk', async () => {
    const tabA = await openTab();
    const tabB = await openTab();
    const pid = tabA.useStore.getState().addPatient('Ann');
    window.dispatchEvent(new StorageEvent('storage', { key: storageKey('patients'), storageArea: localStorage }));

    simultaneously(() => {
      tabA.useStore.getState().addResult(result('run-A', pid, 1_000));
      tabB.useStore.getState().addResult(result('run-B', pid, 2_000));
    });
    await tabA.recordsSettled();
    await tabB.recordsSettled();

    // The tab whose write was overwritten has adopted the union: its own run is still there.
    expect(tabA.useStore.getState().history.map((r) => r.id).sort()).toEqual(['run-A', 'run-B']);
  });

  it('still propagates a deletion — a repair restores, it never resurrects', async () => {
    const tabA = await openTab();
    const tabB = await openTab();
    const pid = tabA.useStore.getState().addPatient('Ann');
    window.dispatchEvent(new StorageEvent('storage', { key: storageKey('patients'), storageArea: localStorage }));
    tabA.useStore.getState().addResult(result('run-A', pid, 1_000));
    await tabA.recordsSettled();

    window.dispatchEvent(new StorageEvent('storage', { key: storageKey('history'), storageArea: localStorage }));
    tabB.useStore.getState().deleteResult('run-A');
    await tabB.recordsSettled();
    await tabA.recordsSettled();

    expect(historyOnDisk()).toEqual([]);
  });
});
