import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, MAX_HISTORY, calibrationKey, defaultLanes, normalizeLanes, useStore } from './store.ts';
import { storageKey } from './persist.ts';
import type { SessionResult } from '../session/types.ts';
import type { RomCalibration } from '../vision/calibration.ts';

const CAL: RomCalibration = { min: 0, max: 1, samples: 90, movement: 'seated_march' };

function fakeResult(id: string, score = 100, patientId = 'p-test'): SessionResult {
  return {
    id,
    patientId,
    patientName: 'Test Patient',
    startedAt: 1,
    endedAt: 2,
    durationSec: 10,
    mode: 'leg',
    difficulty: 'medium',
    windowScale: 1,
    inputMode: 'camera',
    songId: 'demo-groove',
    songTitle: 'x',
    artist: 'y',
    attribution: '',
    score,
    stars: 3,
    accuracy: 0.5,
    starAccuracy: 0.5,
    maxCombo: 4,
    totalNotes: 10,
    hits: 5,
    perfects: 3,
    goods: 2,
    misses: 5,
    reps: 7,
    answerRate: 0.5,
    timingBiasMs: 10,
    timingBiasMadMs: 4,
    latencyOffsetMs: 120,
    suggestedLatencyMs: null,
    completed: true,
    lanes: [],
  };
}

describe('store', () => {
  beforeEach(() => {
    localStorage.clear();
    useStore.setState({
      screen: 'home',
      mode: 'leg',
      lanes: defaultLanes('leg'),
      calibrations: [null, null],
      savedCalibrations: {},
      difficulty: 'medium',
      windowScale: 1,
      history: [],
      settings: { ...DEFAULT_SETTINGS },
      inputMode: 'camera',
    });
  });

  it('keeps lane.index equal to the array position', () => {
    const s = useStore.getState();
    s.addLane();
    s.addLane();
    const lanes = useStore.getState().lanes;
    expect(lanes.map((l) => l.index)).toEqual([0, 1, 2, 3]);
    useStore.getState().removeLane(1);
    expect(useStore.getState().lanes.map((l) => l.index)).toEqual([0, 1, 2]);
  });

  it('never goes below two lanes or above four', () => {
    const s = () => useStore.getState();
    s().removeLane(0);
    expect(s().lanes).toHaveLength(2);
    s().addLane();
    s().addLane();
    s().addLane();
    expect(s().lanes).toHaveLength(4);
  });

  it('drops a lane calibration when the movement or side changes', () => {
    useStore.getState().setCalibration(0, CAL);
    expect(useStore.getState().calibrations[0]).toBe(CAL);
    useStore.getState().setLane(0, { movement: 'knee_extension' });
    // A different movement is a different measured quantity — the old range must not carry over.
    expect(useStore.getState().calibrations[0]).toBeNull();
  });

  it('offers a stored calibration back when the same movement+side returns', () => {
    useStore.getState().setCalibration(0, CAL);
    const key = calibrationKey(useStore.getState().lanes[0]);
    expect(useStore.getState().savedCalibrations[key]).toBe(CAL);
    useStore.getState().setLane(0, { movement: 'knee_extension' });
    useStore.getState().setLane(0, { movement: 'seated_march' });
    expect(useStore.getState().calibrations[0]).toBe(CAL);
  });

  it('switching mode replaces the lanes with that mode s defaults', () => {
    useStore.getState().setMode('hand');
    const lanes = useStore.getState().lanes;
    expect(lanes).toHaveLength(2);
    expect(lanes.every((l) => l.movement === 'hand_open_close')).toBe(true);
    expect(useStore.getState().calibrations).toEqual([null, null]);
  });

  it('clamps the window scale to the engine s legal range', () => {
    useStore.getState().setWindowScale(99);
    expect(useStore.getState().windowScale).toBeLessThanOrEqual(4);
    useStore.getState().setWindowScale(0.01);
    expect(useStore.getState().windowScale).toBeGreaterThanOrEqual(0.25);
  });

  it('stores results newest first and caps the history', () => {
    for (let i = 0; i < MAX_HISTORY + 5; i++) useStore.getState().addResult(fakeResult(`s${i}`, i));
    const h = useStore.getState().history;
    expect(h).toHaveLength(MAX_HISTORY);
    expect(h[0].id).toBe(`s${MAX_HISTORY + 4}`);
    expect(useStore.getState().lastResult?.id).toBe(`s${MAX_HISTORY + 4}`);
  });

  it('persists settings and history through localStorage', () => {
    useStore.getState().updateSettings({ sfx: false, scrollSec: 2 });
    useStore.getState().addResult(fakeResult('kept'));
    expect(JSON.parse(localStorage.getItem('beatRehab:settings') as string).sfx).toBe(false);
    expect(JSON.parse(localStorage.getItem('beatRehab:history') as string)[0].id).toBe('kept');
  });

  it('clamps the latency offset and remembers whether it was measured', () => {
    useStore.getState().setLatency(0.18, true, 'ok');
    expect(useStore.getState().latencyOffsetSec).toBeCloseTo(0.18);
    expect(useStore.getState().latencyMeasured).toBe(true);
    useStore.getState().setLatency(-5, false);
    expect(useStore.getState().latencyOffsetSec).toBe(0);
  });

  it('normalizeLanes only rewrites the entries that are wrong', () => {
    const lanes = [
      { index: 5, movement: 'seated_march' as const, side: 'left' as const },
      { index: 1, movement: 'seated_march' as const, side: 'right' as const },
    ];
    const out = normalizeLanes(lanes);
    expect(out[0].index).toBe(0);
    expect(out[1]).toBe(lanes[1]);
  });

  it('config() is the prescription the session modules consume', () => {
    const config = useStore.getState().config();
    expect(config.lanes).toHaveLength(2);
    expect(config.difficulty).toBe('medium');
    expect(config.songId).toBeTruthy();
  });
});


/**
 * THE WRITE PATH REPORTS WHAT ACTUALLY HAPPENED.
 *
 * The Results screen printed a green "Saved to history" badge unconditionally. Refuse the write —
 * which a shared clinic tablet really does, the retention cap being 100 sessions PER PATIENT — and
 * the badge still read saved over a record that existed nowhere but in memory. The verdict was
 * always there (`writeJson` returns it); it just never left the store.
 */
describe('recording a session reports whether it reached the disk', () => {
  const refuse = (): void => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
  };

  beforeEach(() => {
    localStorage.clear();
    useStore.setState({
      history: [],
      lastResult: null,
      lastSave: null,
      persistenceFailed: false,
      patients: [{ id: 'p-test', name: 'Test Patient', createdAt: 1, lastUsedAt: 1 }],
      activePatientId: 'p-test',
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('says the session was saved when the write landed, against that session’s own id', () => {
    useStore.getState().addResult(fakeResult('saved-1'));
    const save = useStore.getState().lastSave;
    expect(save).toEqual({ id: 'saved-1', ok: true, at: expect.any(Number), attempts: 1 });
    expect(JSON.parse(localStorage.getItem('beatRehab:history') as string)).toHaveLength(1);
  });

  it('says the session was NOT saved when the quota refuses it', () => {
    refuse();
    useStore.getState().addResult(fakeResult('lost-1'));
    expect(useStore.getState().lastSave).toMatchObject({ id: 'lost-1', ok: false, attempts: 1 });
    // The record is still in memory — the Results screen is holding the only copy, which is exactly
    // why it must say so rather than send the therapist away.
    expect(useStore.getState().history.map((r) => r.id)).toEqual(['lost-1']);
    expect(useStore.getState().persistenceFailed).toBe(true);
  });

  it('retries on demand and reports the second verdict, not the first', () => {
    refuse();
    useStore.getState().addResult(fakeResult('lost-2'));
    expect(useStore.getState().lastSave?.ok).toBe(false);

    // The therapist frees space (or the quota was transient) and taps "Try saving again".
    vi.restoreAllMocks();
    expect(useStore.getState().retrySaveLastResult()).toBe(true);
    expect(useStore.getState().lastSave).toMatchObject({ id: 'lost-2', ok: true, attempts: 2 });
    expect(JSON.parse(localStorage.getItem('beatRehab:history') as string).map((r: SessionResult) => r.id)).toEqual([
      'lost-2',
    ]);
  });

  it('a retry with nothing to save is a no-op, not a false claim', () => {
    useStore.setState({ lastResult: null, lastSave: null });
    expect(useStore.getState().retrySaveLastResult()).toBe(false);
    expect(useStore.getState().lastSave).toBeNull();
  });

  it('keeps the verdict stamped with the session it is about', () => {
    useStore.getState().addResult(fakeResult('first'));
    refuse();
    useStore.getState().addResult(fakeResult('second'));
    // Not "the last write failed" in the abstract: the failure belongs to `second`, and the screen
    // showing `second` is the one that may not claim a save.
    expect(useStore.getState().lastSave?.id).toBe('second');
    expect(useStore.getState().lastSave?.ok).toBe(false);
  });
});

/**
 * A STORED CALIBRATION IS DATA, NOT A SHAPE — the optional sub-fields especially. A range written by
 * an older build reaches the screens that read it, and `rest.durationSec.toFixed(1)` on a rest block
 * that predates `durationSec` threw inside the render of the screen that was trying to warn about
 * that very range. The store no longer casts what it read; it carries only the fields it can vouch
 * for, and "absent" is a state every reader already handles.
 */
describe('ranges reloaded from disk are sanitised, not cast', () => {
  beforeEach(() => localStorage.clear());

  const adopt = (map: unknown): void => {
    localStorage.setItem(storageKey('calibrations'), JSON.stringify(map));
    // The same path a second tab's write takes into this one.
    window.dispatchEvent(new StorageEvent('storage', { key: storageKey('calibrations'), storageArea: localStorage }));
  };

  it('drops a rest block that is missing the numbers its readers dereference', () => {
    adopt({ 'p-test': { 'seated_march:left': { min: 0.1, max: 0.5, samples: 90, rest: { still: false, spread: 0.09 } } } });
    const cal = useStore.getState().calibrationsByPatient['p-test']['seated_march:left'];
    expect(cal.min).toBe(0.1);
    expect(cal.max).toBe(0.5);
    expect(cal.rest).toBeUndefined();
  });

  it('keeps a rest block that carries all five numbers', () => {
    const rest = { still: true, spread: 0.01, drift: 0.002, durationSec: 2.4, samples: 72 };
    adopt({ 'p-test': { 'seated_march:left': { min: 0.1, max: 0.5, samples: 90, rest } } });
    expect(useStore.getState().calibrationsByPatient['p-test']['seated_march:left'].rest).toEqual(rest);
  });

  it('drops a posture this build does not have, rather than indexing on it', () => {
    adopt({ 'p-test': { 'seated_march:left': { min: 0.1, max: 0.5, samples: 90, posture: 'lying_prone' } } });
    expect(useStore.getState().calibrationsByPatient['p-test']['seated_march:left'].posture).toBeUndefined();
  });
});
