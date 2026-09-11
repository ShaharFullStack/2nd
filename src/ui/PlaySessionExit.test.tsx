/**
 * LEAVING THE PLAY SCREEN: what must happen to the camera, and to the reps already performed.
 *
 * Two bugs, one code path — the effect cleanup that runs when the screen goes away.
 *  - The camera was never released. `stopInputOnDispose: inputMode !== 'camera'` kept the device and
 *    the MediaPipe loop alive "for the next song", and no path out of play ever closed them.
 *  - The run was never finished. `finish()` ran only from `quit()` or the chart ending, so a session
 *    the therapist backed out of recorded nothing at all.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import type { LaneSpec } from '../engine/types.ts';
import { DEFAULT_SETTINGS, useStore } from '../state/store.ts';

const LANES: LaneSpec[] = [
  { index: 0, movement: 'seated_march', side: 'left' },
  { index: 1, movement: 'knee_extension', side: 'right' },
];

const vision = {
  getInvalidCalibrations: () => [],
  getLaneStates: () => LANES.map((l) => ({ lane: l.index, value: 0, armed: false })),
  getVideoElement: () => null,
  onEvent: () => () => {},
  start: async () => {},
  stop: () => {},
  staleFrameSec: 0.4,
  minIntervalSec: 0.2,
};

const releaseVisionUnless = vi.fn();

vi.mock('../session/runtime.ts', () => ({
  runtime: {
    ensureAudio: async () => ({
      ctx: { currentTime: 0, sampleRate: 48000, state: 'running' },
      mixer: {},
      sfx: { enabled: true },
    }),
    loadSong: async () => null,
    ensureVision: async () => vision,
    peekVision: () => vision,
    disposeVision: () => {},
    releaseVisionUnless,
    runner: null,
  },
}));

const { default: PlayScreen } = await import('./Play.tsx');

beforeEach(() => {
  releaseVisionUnless.mockClear();
  cleanup();
  useStore.setState({
    screen: 'play',
    mode: 'leg',
    lanes: LANES,
    calibrations: [null, null],
    savedCalibrations: {},
    difficulty: 'medium',
    windowScale: 1,
    songId: 'demo-groove',
    inputMode: 'camera',
    history: [],
    lastResult: null,
    settings: { ...DEFAULT_SETTINGS },
  });
});

describe('leaving the play screen', () => {
  it('hands the destination to the camera-release rule instead of keeping the device open', async () => {
    const view = render(<PlayScreen />);
    await waitFor(() => expect(screen.getByTestId('play-pip')).toBeTruthy());

    // The therapist ends the visit: the store navigates first, the screen unmounts after — so the
    // cleanup must read the screen it has ARRIVED at, not the one it is leaving.
    act(() => useStore.getState().goto('results'));
    view.unmount();

    expect(releaseVisionUnless).toHaveBeenCalledWith('results');
  });

  it('keeps the device across a remount that is still the play screen', async () => {
    const view = render(<PlayScreen />);
    await waitFor(() => expect(screen.getByTestId('play-pip')).toBeTruthy());
    view.unmount();
    // No navigation happened: a retry / remount asks the rule with 'play', which keeps the camera.
    expect(releaseVisionUnless).toHaveBeenCalledWith('play');
  });

  it('does not yank a therapist who navigated away onto the results screen', async () => {
    const view = render(<PlayScreen />);
    await waitFor(() => expect(screen.getByTestId('play-pip')).toBeTruthy());
    act(() => useStore.getState().goto('home'));
    view.unmount();
    // The run is finished during teardown (so its reps are recorded), but the navigation was the
    // therapist's: they asked for Home and Home is where they stay.
    expect(useStore.getState().screen).toBe('home');
  });

  it('files nothing for a play screen that was opened and left without a single rep', async () => {
    const view = render(<PlayScreen />);
    await waitFor(() => expect(screen.getByTestId('play-pip')).toBeTruthy());
    act(() => useStore.getState().goto('home'));
    view.unmount();
    // Not a session: nothing was judged and nothing was performed, so nothing spends the patient's
    // retention budget.
    expect(useStore.getState().history).toHaveLength(0);
    expect(useStore.getState().lastResult).toBeNull();
  });
});
