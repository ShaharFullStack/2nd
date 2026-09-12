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
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
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

describe('a camera session keeps its own way off the last screen', () => {
  it('records that this session is driven by the camera', async () => {
    render(<PlayScreen />);
    await waitFor(() => expect(screen.getByTestId('play-pip')).toBeTruthy());
    expect(useStore.getState().handsFree).toBe(true);
  });

  it('a keyboard session does not — the device is released when play ends, as before', async () => {
    setup('keyboard');
    render(<PlayScreen />);
    await waitFor(() => expect(useStore.getState().screen).toBe('play'));
    expect(useStore.getState().handsFree).toBe(false);
  });
});
