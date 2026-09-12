/**
 * THE CAMERA HAS TO OUTLIVE THE SONG WHEN THE PATIENT IS THE CONTROLLER.
 *
 * `handsFree` is what `screenNeedsCamera` (session/runtime.ts) reads to decide whether the device is
 * released when play ends, and it used to be set only by the first dwell confirm. That made two dead
 * ends compound: a patient whose therapist had to tap them past a blocked camera check had never
 * confirmed anything, so the results screen — whose only controls are "Play again" and "New session"
 * — arrived with no camera and no targets, for exactly the patient least able to reach the tablet.
 *
 * The evidence is now the one that matters here: this session is driven BY THE CAMERA.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  onFrame: () => () => {},
  start: async () => {},
  stop: () => {},
  staleFrameSec: 0.4,
  minIntervalSec: 0.2,
};

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
    releaseVisionUnless: () => {},
    runner: null,
  },
}));

const { default: PlayScreen } = await import('./Play.tsx');

function setup(inputMode: 'camera' | 'keyboard'): void {
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
    inputMode,
    history: [],
    lastResult: null,
    handsFree: false,
    settings: { ...DEFAULT_SETTINGS },
  });
}

beforeEach(() => setup('camera'));

/**
 * THE LEAK THIS FILE USED TO SPRING, AND WHY IT MATTERED MORE HERE THAN ANYWHERE ELSE.
 *
 * `setup()` cleans up the PREVIOUS render, so the LAST render of the file was never unmounted: the
 * play screen's boot is asynchronous (`loadSong`, `new GameRunner`, `await runner.start()`) and
 * `play-pip` appears as soon as the input exists, i.e. BEFORE `start()` has resolved. The file
 * therefore ended with a mounted screen and a promise still in flight, whose `setPhase('running')`
 * landed after vitest had torn the jsdom environment down — `ReferenceError: window is not defined`,
 * thrown inside react-dom, reported as an unhandled error that vitest itself warns "might cause false
 * positive tests". On the one file whose subject is the hands-free play path, an assertion that may
 * have been evaluated against a half-booted screen is worth nothing.
 *
 * `cleanup()` here runs the screen's own effect teardown, which sets `alive = false` (so no state is
 * set from the boot that is still resolving), disposes the runner and releases the device. The `act`
 * flush afterwards lets the already-scheduled continuations run while the environment still exists,
 * rather than leaving them to fire into a torn-down one.
 */
afterEach(async () => {
  cleanup();
  await act(async () => {
    await Promise.resolve();
  });
});

describe('a camera session keeps its own way off the last screen', () => {
  it('records that this session is driven by the camera', async () => {
    render(<PlayScreen />);
    await waitFor(() => expect(screen.getByTestId('play-pip')).toBeTruthy());
    expect(useStore.getState().handsFree).toBe(true);
  });

  it('a keyboard session does not — the device is released when play ends, as before', async () => {
    setup('keyboard');
    render(<PlayScreen />);
    // WAIT FOR THE SCREEN THE CLAIM IS ABOUT, not for a store field the test set itself: `screen`
    // was already 'play' before the render, so this used to assert `handsFree` against a component
    // that had not necessarily run an effect yet — it would have passed with the effect deleted.
    // `play-pip` only mounts once the keyboard input source exists, which is inside the same boot
    // that would have set `handsFree` had this been a camera session.
    await waitFor(() => expect(screen.getByTestId('play-pip')).toBeTruthy());
    expect(useStore.getState().handsFree).toBe(false);
  });
});
