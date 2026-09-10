/**
 * The camera can fail at the START OF PLAY, not only on the camera-check screen: unplugged between
 * the check and the count-in, permission revoked in another tab, or a deep link straight to
 * `?screen=play` in camera mode.
 *
 * That path used to end on a bare "Could not start the session" with the raw exception text and one
 * Back button — no cause, no remedy, no retry, and no labelled keyboard fallback, even though the
 * classified fallback screen already existed one directory over. This pins the reuse.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
};

/** Fails the given number of times, then succeeds — so Retry can be shown to really re-request. */
const camera = { failures: 1, attempts: 0, error: (() => new DOMException('Permission denied', 'NotAllowedError'))() };

const disposeVision = vi.fn();

vi.mock('../session/runtime.ts', () => ({
  runtime: {
    ensureAudio: async () => ({
      ctx: { currentTime: 0, sampleRate: 48000, state: 'running' },
      mixer: {},
      sfx: { enabled: true },
    }),
    loadSong: async () => null,
    ensureVision: async () => {
      camera.attempts++;
      if (camera.attempts <= camera.failures) throw camera.error;
      return vision;
    },
    peekVision: () => vision,
    disposeVision,
    runner: null,
  },
}));

const { default: PlayScreen } = await import('./Play.tsx');

beforeEach(() => {
  camera.attempts = 0;
  camera.failures = 1;
  disposeVision.mockClear();
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
    settings: { ...DEFAULT_SETTINGS },
  });
});

describe('a camera failure during the Play boot', () => {
  it('classifies it, names the remedy and offers the labelled keyboard downgrade', async () => {
    render(<PlayScreen />);

    const fallback = await screen.findByTestId('camera-fallback');
    expect(fallback.textContent).toMatch(/permission/i);
    // Not the raw exception on its own: a cause, a remedy and a real Retry.
    expect(screen.getByTestId('camera-retry')).toBeTruthy();
    // The keyboard is offered as a deliberate downgrade with its measurement cost stated.
    expect(screen.getByTestId('camera-use-keyboard')).toBeTruthy();
    expect(fallback.textContent).toMatch(/no range of motion/i);
  });

  it('Retry re-requests the camera for real and reaches the session when it is granted', async () => {
    render(<PlayScreen />);
    await screen.findByTestId('camera-fallback');
    expect(camera.attempts).toBe(1);

    fireEvent.click(screen.getByTestId('camera-retry'));
    // The dead input is disposed so `ensureVision` cannot hand it back, and a NEW request is made.
    await waitFor(() => expect(camera.attempts).toBe(2));
    expect(disposeVision).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByTestId('camera-fallback')).toBeNull());
  });

  it('switching to the keyboard leaves the session on the keyboard, recorded as such', async () => {
    render(<PlayScreen />);
    await screen.findByTestId('camera-fallback');
    fireEvent.click(screen.getByTestId('camera-use-keyboard'));
    expect(useStore.getState().inputMode).toBe('keyboard');
  });
});
