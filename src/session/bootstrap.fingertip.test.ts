/**
 * `?lanes=` grew a third segment for the fingertip, so a critic can drive a pinky-opposition session
 * without going through the Setup screen. Kept in its own file so the original URL suite stays as it
 * was written.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, defaultLanes, useStore } from '../state/store.ts';
import { applyUrlParams } from './bootstrap.ts';

beforeEach(() => {
  localStorage.clear();
  useStore.setState({
    screen: 'home',
    inputMode: 'camera',
    mode: 'leg',
    lanes: defaultLanes('leg'),
    calibrations: [null, null],
    savedCalibrations: {},
    difficulty: 'medium',
    windowScale: 1,
    seed: 1,
    settings: { ...DEFAULT_SETTINGS },
  });
});

describe('?lanes fingertip segment', () => {
  it('reads the fingertip for finger_opposition lanes', () => {
    applyUrlParams('?lanes=finger_opposition:left:pinky,finger_opposition:right:ring');
    const lanes = useStore.getState().lanes;
    expect(useStore.getState().mode).toBe('hand');
    expect(lanes.map((l) => l.fingertip)).toEqual(['pinky', 'ring']);
  });

  it('defaults to the index when the segment is omitted', () => {
    applyUrlParams('?lanes=finger_opposition:left,finger_opposition:right');
    expect(useStore.getState().lanes.map((l) => l.fingertip)).toEqual(['index', 'index']);
  });

  it('ignores a nonsense tip rather than refusing the lane', () => {
    applyUrlParams('?lanes=finger_opposition:left:thumb,finger_opposition:right:pinky');
    expect(useStore.getState().lanes.map((l) => l.fingertip)).toEqual(['index', 'pinky']);
  });

  it('drops a fingertip on a movement that has none', () => {
    applyUrlParams('?lanes=seated_march:left:pinky,knee_extension:right');
    const lanes = useStore.getState().lanes;
    expect(lanes.map((l) => l.fingertip)).toEqual([undefined, undefined]);
    expect(useStore.getState().mode).toBe('leg');
  });
});
