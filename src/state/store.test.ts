import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, MAX_HISTORY, calibrationKey, defaultLanes, normalizeLanes, useStore } from './store.ts';
import type { SessionResult } from '../session/types.ts';
import type { RomCalibration } from '../vision/calibration.ts';

const CAL: RomCalibration = { min: 0, max: 1, samples: 90, movement: 'seated_march' };

function fakeResult(id: string, score = 100): SessionResult {
  return {
    id,
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
    health: 0.5,
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
