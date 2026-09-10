import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, defaultLanes, useStore } from '../state/store.ts';
import { applyUrlParams, installDebugHandle, startPlayNow } from './bootstrap.ts';

describe('URL affordances', () => {
  beforeEach(() => {
    localStorage.clear();
    useStore.setState({
      screen: 'home',
      inputMode: 'camera',
      mode: 'leg',
      lanes: defaultLanes('leg'),
      calibrations: [null, null],
      difficulty: 'medium',
      windowScale: 1,
      seed: 1,
      settings: { ...DEFAULT_SETTINGS },
    });
  });

  it('defaults to the camera', () => {
    expect(applyUrlParams('')).toBe('camera');
    expect(useStore.getState().inputMode).toBe('camera');
  });

  it('accepts ?input=keyboard and ?input=autoplay', () => {
    expect(applyUrlParams('?input=keyboard')).toBe('keyboard');
    expect(applyUrlParams('?input=autoplay')).toBe('autoplay');
    expect(useStore.getState().inputMode).toBe('autoplay');
  });

  it('accepts the documented ?autoplay=1 alias', () => {
    expect(applyUrlParams('?autoplay=1')).toBe('autoplay');
  });

  it('parses a lane list and derives the mode from it', () => {
    applyUrlParams('?lanes=hand_open_close:left,finger_spread:right');
    const s = useStore.getState();
    expect(s.mode).toBe('hand');
    expect(s.lanes.map((l) => `${l.movement}:${l.side}`)).toEqual(['hand_open_close:left', 'finger_spread:right']);
    expect(s.lanes.map((l) => l.index)).toEqual([0, 1]);
  });

  it('ignores unknown movements and refuses a one-lane prescription', () => {
    applyUrlParams('?lanes=not_a_movement:left');
    expect(useStore.getState().lanes).toHaveLength(2);
    expect(useStore.getState().lanes[0].movement).toBe('seated_march');
  });

  it('parses difficulty, song, seed and window scale', () => {
    applyUrlParams('?difficulty=hard&song=demo-sunrise&seed=42&scale=1.5');
    const s = useStore.getState();
    expect(s.difficulty).toBe('hard');
    expect(s.songId).toBe('demo-sunrise');
    expect(s.seed).toBe(42);
    expect(s.windowScale).toBeCloseTo(1.5);
  });

  it('ignores a bogus difficulty rather than crashing the boot', () => {
    applyUrlParams('?difficulty=impossible');
    expect(useStore.getState().difficulty).toBe('medium');
  });

  it('startPlayNow applies a prescription and jumps to the play screen', () => {
    startPlayNow({ difficulty: 'easy', songId: 'demo-groove', inputMode: 'autoplay', seed: 3 });
    const s = useStore.getState();
    expect(s.screen).toBe('play');
    expect(s.difficulty).toBe('easy');
    expect(s.inputMode).toBe('autoplay');
    expect(s.seed).toBe(3);
  });

  it('installs the critic handle on globalThis', () => {
    const handle = installDebugHandle();
    expect((globalThis as unknown as { __beatRehab: unknown }).__beatRehab).toBe(handle);
    handle.gotoScreen('history');
    expect(useStore.getState().screen).toBe('history');
    expect(handle.getScore()).toBeNull();
    expect(handle.getState().screen).toBe('history');
  });
});
