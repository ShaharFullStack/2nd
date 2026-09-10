/**
 * Store behaviour added for the therapist gaps: the fingertip dimension of a finger_opposition lane,
 * and adopting a run's measured latency for the next session.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { LaneSpec } from '../engine/types.ts';
import type { RomCalibration } from '../vision/calibration.ts';
import { storageKey } from './persist.ts';
import { DEFAULT_SETTINGS, calibrationKey, defaultLanes, laneFingertip, normalizeLaneFingertip, useStore } from './store.ts';

const cal = (min: number, max: number): RomCalibration => ({ min, max, samples: 90, movement: 'finger_opposition' });

function reset(lanes: LaneSpec[] = defaultLanes('hand')) {
  localStorage.clear();
  useStore.setState({
    screen: 'setup',
    mode: 'hand',
    lanes,
    calibrations: lanes.map(() => null),
    savedCalibrations: {},
    difficulty: 'medium',
    windowScale: 1,
    history: [],
    settings: { ...DEFAULT_SETTINGS },
    inputMode: 'camera',
    latencyOffsetSec: 0.12,
    latencyMeasured: false,
    latencyNote: '',
    latencySetAt: null,
  });
}

describe('lane fingertip', () => {
  beforeEach(() => reset());

  it('only finger_opposition has a fingertip, and it defaults to the index', () => {
    expect(laneFingertip({ movement: 'hand_open_close' })).toBeUndefined();
    expect(laneFingertip({ movement: 'finger_opposition' })).toBe('index');
    expect(laneFingertip({ movement: 'finger_opposition', fingertip: 'pinky' })).toBe('pinky');
  });

  it('drops a fingertip a movement cannot carry', () => {
    const cleaned = normalizeLaneFingertip({ index: 0, movement: 'wrist_extension', side: 'left', fingertip: 'ring' });
    expect(cleaned.fingertip).toBeUndefined();
  });

  it('the calibration key carries the fingertip only where it means something', () => {
    expect(calibrationKey({ movement: 'seated_march', side: 'left' })).toBe('seated_march:left');
    expect(calibrationKey({ movement: 'finger_opposition', side: 'left' })).toBe('finger_opposition:left:index');
    expect(calibrationKey({ movement: 'finger_opposition', side: 'left', fingertip: 'pinky' })).toBe('finger_opposition:left:pinky');
  });

  it('switching a lane to finger_opposition gives it the default tip', () => {
    useStore.getState().setLane(0, { movement: 'finger_opposition' });
    expect(useStore.getState().lanes[0].fingertip).toBe('index');
  });

  it('switching a lane away from finger_opposition forgets the tip', () => {
    useStore.getState().setLane(0, { movement: 'finger_opposition', fingertip: 'ring' });
    useStore.getState().setLane(0, { movement: 'hand_open_close' });
    expect(useStore.getState().lanes[0].fingertip).toBeUndefined();
  });

  it('a different fingertip is a different calibration — it must not inherit the old range', () => {
    const s = useStore.getState();
    s.setLane(0, { movement: 'finger_opposition', fingertip: 'index' });
    s.setCalibration(0, cal(0.1, 0.95));
    expect(useStore.getState().calibrations[0]).not.toBeNull();

    // The therapist moves this lane to the little finger: a hand that pinches its index to the thumb
    // reaches ~1.0 while the same hand's pinky peaks far lower. Reusing the index range would leave a
    // lane that cannot reach its hit threshold all song, with nothing on screen to explain it.
    useStore.getState().setLane(0, { fingertip: 'pinky' });
    expect(useStore.getState().calibrations[0]).toBeNull();

    // Going back offers the stored index range again.
    useStore.getState().setLane(0, { fingertip: 'index' });
    expect(useStore.getState().calibrations[0]?.max).toBeCloseTo(0.95);
  });

  it('stores the two fingertips under separate keys', () => {
    const s = useStore.getState();
    s.setLane(0, { movement: 'finger_opposition', fingertip: 'index' });
    s.setCalibration(0, cal(0.1, 0.95));
    useStore.getState().setLane(0, { fingertip: 'pinky' });
    useStore.getState().setCalibration(0, cal(0.05, 0.5));
    const saved = useStore.getState().savedCalibrations;
    expect(saved['finger_opposition:left:index'].max).toBeCloseTo(0.95);
    expect(saved['finger_opposition:left:pinky'].max).toBeCloseTo(0.5);
  });

  it('a fingertip survives a round trip through the persisted config', () => {
    useStore.getState().setLane(0, { movement: 'finger_opposition', fingertip: 'middle' });
    const raw = JSON.parse(localStorage.getItem(storageKey('lastConfig')) ?? '{}') as { lanes?: LaneSpec[] };
    expect(raw.lanes?.[0].fingertip).toBe('middle');
  });

  it('addLane never proposes a lane that duplicates an existing movement/side/tip', () => {
    reset([
      { index: 0, movement: 'finger_opposition', side: 'left', fingertip: 'index' },
      { index: 1, movement: 'finger_opposition', side: 'right', fingertip: 'index' },
    ]);
    useStore.getState().addLane();
    const lanes = useStore.getState().lanes;
    const keys = lanes.map((l) => calibrationKey(l));
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('applySuggestedLatency', () => {
  beforeEach(() => reset());

  it('writes the measured value and reports the before/after', () => {
    const change = useStore.getState().applySuggestedLatency(205, 'Demo Groove');
    expect(change).toEqual({ previousMs: 120, appliedMs: 205, deltaMs: 85, previousMeasured: false, previousNote: '' });
    expect(useStore.getState().latencyOffsetSec).toBeCloseTo(0.205, 6);
    expect(useStore.getState().latencyMeasured).toBe(true);
    expect(useStore.getState().latencyNote).toContain('Demo Groove');
  });

  it('reports the PROVENANCE of the value it replaced, so an undo can restore it losslessly', () => {
    // The failure this guards: Undo on the Results hand-over wrote `measured: false` unconditionally,
    // so correcting a misclick silently downgraded a value the latency screen HAD measured — and the
    // calibration screen keys its "already measured" state off exactly that flag.
    useStore.getState().setLatency(0.14, true, 'measured on the latency screen');
    const change = useStore.getState().applySuggestedLatency(265, 'Demo Groove');
    expect(change?.previousMs).toBe(140);
    expect(change?.previousMeasured).toBe(true);
    expect(change?.previousNote).toBe('measured on the latency screen');
  });

  it('persists so the next session starts from it', () => {
    useStore.getState().applySuggestedLatency(205);
    expect(localStorage.getItem(storageKey('latency'))).toBe('0.205');
  });

  it('stamps the write, so a later screen can tell "0 ms in force" from "nothing set yet"', () => {
    // The latency screen's fast path turns on exactly this: with nothing ever set it may store the
    // 120 ms default, and with something in force it may not.
    expect(useStore.getState().latencySetAt).toBeNull();
    useStore.getState().applySuggestedLatency(205, 'Demo Groove');
    expect(useStore.getState().latencySetAt).toBeGreaterThan(0);
  });

  it('persists the provenance next to the number, so a reload does not strip it', () => {
    useStore.getState().applySuggestedLatency(205, 'Demo Groove');
    const meta = JSON.parse(localStorage.getItem(storageKey('latencyMeta')) as string);
    expect(meta.measured).toBe(true);
    expect(meta.note).toContain('Demo Groove');
    expect(meta.at).toBeGreaterThan(0);
  });

  it('clamps to the range the engine accepts', () => {
    expect(useStore.getState().applySuggestedLatency(-50)?.appliedMs).toBe(0);
    expect(useStore.getState().applySuggestedLatency(9999)?.appliedMs).toBe(1000);
  });

  it('refuses a value that is not a number rather than zeroing the offset', () => {
    expect(useStore.getState().applySuggestedLatency(Number.NaN)).toBeNull();
    expect(useStore.getState().latencyOffsetSec).toBeCloseTo(0.12, 6);
  });
});
