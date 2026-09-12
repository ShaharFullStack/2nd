/**
 * ENDING A SESSION IS THE ONE DESTRUCTIVE SELECT ON THE PLAY SCREEN, AND IT HAS TO BE UNDOABLE.
 *
 * WHAT THIS FILE PINS. The pause dialog's second circle used to be `onConfirm: () => runner.quit()`:
 * `finish('quit')` writes a truncated `RunSummary` into the patient's history and their trend, stops
 * the mixer and leaves the runner `ended` — a state nothing in the app comes back from. One hold, no
 * confirmation, no undo. The critic reproduced a FALSE confirm of that exact circle 3.30 s into the
 * first repetition of a seated march with hip circumduction, which is the compensation this app
 * promises never to penalise. Meanwhile the calibration screen tells the patient that "a confirm made
 * by accident can always be undone without touching the screen".
 *
 * So the act is asked twice and then held open, and what is asserted here is the property rather than
 * the wording: NOTHING IS WRITTEN AND THE RUN IS STILL ALIVE until the grace window expires, at every
 * stage, whichever control started it — and every way back returns a running song.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { LaneSpec } from '../engine/types.ts';
import { DEFAULT_SETTINGS, useStore } from '../state/store.ts';

const LANES: LaneSpec[] = [
  { index: 0, movement: 'seated_march', side: 'left' },
  { index: 1, movement: 'seated_march', side: 'right' },
];

const vision = {
  getInvalidCalibrations: () => [],
  getLaneStates: () => LANES.map((l) => ({ lane: l.index, value: 0, armed: false })),
  getVideoElement: () => null,
  getStatus: () => ({ warnings: [], lanes: [], tracking: true }),
  onEvent: () => () => {},
  onFrame: () => () => {},
  start: async () => {},
  stop: () => {},
  staleFrameSec: 0.4,
  minIntervalSec: 0.2,
};

const runtimeMock: { runner: { pause: (c?: boolean) => void; getPhase: () => string } | null } = { runner: null };

vi.mock('../session/runtime.ts', () => ({
  runtime: Object.assign(runtimeMock, {
    ensureAudio: async () => ({
      ctx: { currentTime: 0, sampleRate: 48000, state: 'running' },
      mixer: {},
      sfx: { enabled: true },
    }),
    loadSong: async () => null,
    ensureVision: async () => vision,
    peekVision: () => vision,
    disposeVision: () => undefined,
    releaseVisionUnless: () => undefined,
  }),
}));

const { default: PlayScreen } = await import('./Play.tsx');

beforeEach(() => {
  cleanup();
  runtimeMock.runner = null;
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
    handsFree: false,
    settings: { ...DEFAULT_SETTINGS },
  });
});

afterEach(async () => {
  cleanup();
  await act(async () => {
    await Promise.resolve();
  });
});

/**
 * Render the play screen and stop the run, so the pause dialog is up.
 *
 * `pause(true)` — the count-in is pausable from the page path, and with a mocked audio clock stuck at
 * `currentTime: 0` the runner never leaves the count-in. The dialog, the circles and the ending are
 * the same at either phase; what matters is that the run is PAUSED and not finished.
 */
async function pausedScreen(): Promise<void> {
  render(<PlayScreen />);
  await waitFor(() => expect(screen.getByTestId('play-pip')).toBeTruthy());
  await waitFor(() => expect(runtimeMock.runner).not.toBeNull());
  act(() => runtimeMock.runner?.pause(true));
  await waitFor(() => expect(screen.getByTestId('pause-overlay')).toBeTruthy());
}

/** Nothing has reached the patient's record, and the run can still be resumed. */
function nothingWritten(): void {
  expect(useStore.getState().history).toHaveLength(0);
  expect(useStore.getState().lastResult).toBeNull();
  expect(useStore.getState().screen).toBe('play');
  expect(runtimeMock.runner?.getPhase()).toBe('paused');
}

describe('ending a session is double-gated', () => {
  it('the pause dialog offers a stop that ASKS — one hold writes nothing', async () => {
    await pausedScreen();
    // Stage 0: the two circles the patient has always had, and the therapist's button.
    expect(screen.getByTestId('pause-dwell-resume')).toBeTruthy();
    expect(screen.getByTestId('pause-dwell-end')).toBeTruthy();
    expect(screen.queryByTestId('end-confirm')).toBeNull();

    // The destructive circle's own confirm handler, run exactly as a completed hold runs it.
    act(() => fireEvent.click(screen.getByTestId('end-session')));
    expect(screen.getByTestId('end-confirm')).toBeTruthy();
    nothingWritten();
    // ...and the dialog's own words say so, because a gate nobody understands is a gate they learn
    // to hold through.
    expect(screen.getByTestId('end-confirm').textContent).toMatch(/nothing has been written down yet/i);
  });

  it('the second hold starts a countdown, and STILL writes nothing', async () => {
    await pausedScreen();
    act(() => fireEvent.click(screen.getByTestId('end-session')));
    act(() => fireEvent.click(screen.getByTestId('end-confirm-btn')));
    expect(screen.getByTestId('end-grace')).toBeTruthy();
    expect(Number(screen.getByTestId('end-grace-left').textContent)).toBeGreaterThan(0);
    nothingWritten();
  });

  it('the grace window offers ONE circle and it is the way back', async () => {
    await pausedScreen();
    act(() => fireEvent.click(screen.getByTestId('end-session')));
    act(() => fireEvent.click(screen.getByTestId('end-confirm-btn')));
    // The only hands-free target during the undo window is "carry on": a second chance to confirm the
    // destructive act inside its own undo window would be the same bug with an extra step.
    expect(screen.getByTestId('pause-dwell-keep')).toBeTruthy();
    expect(screen.queryByTestId('pause-dwell-end')).toBeNull();
    expect(screen.queryByTestId('pause-dwell-end-confirm')).toBeNull();
  });

  it('carrying on from either stage gives the session back and un-arms the ending', async () => {
    for (const stage of ['confirm', 'grace'] as const) {
      await pausedScreen();
      act(() => fireEvent.click(screen.getByTestId('end-session')));
      if (stage === 'grace') act(() => fireEvent.click(screen.getByTestId('end-confirm-btn')));
      act(() => fireEvent.click(screen.getByTestId('end-carry-on')));
      // Back to a run that is not paused and not ended, with nothing filed…
      await waitFor(() => expect(runtimeMock.runner?.getPhase()).not.toBe('paused'));
      expect(runtimeMock.runner?.getPhase()).not.toBe('ended');
      expect(useStore.getState().history).toHaveLength(0);
      expect(useStore.getState().lastResult).toBeNull();
      // …and the next pause opens on the ordinary dialog, not half-way through an ending.
      act(() => runtimeMock.runner?.pause(true));
      await waitFor(() => expect(screen.getByTestId('pause-overlay')).toBeTruthy());
      expect(screen.queryByTestId('end-confirm')).toBeNull();
      expect(screen.queryByTestId('end-grace')).toBeNull();
      expect(screen.getByTestId('pause-dwell-end')).toBeTruthy();
      cleanup();
      await act(async () => {
        await Promise.resolve();
      });
      runtimeMock.runner = null;
      useStore.setState({ screen: 'play', history: [], lastResult: null });
    }
  });

  it('resuming by any other means also un-arms it — Escape, the pause button, the dialog', async () => {
    await pausedScreen();
    act(() => fireEvent.click(screen.getByTestId('end-session')));
    expect(screen.getByTestId('end-confirm')).toBeTruthy();
    act(() => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    await waitFor(() => expect(screen.queryByTestId('pause-overlay')).toBeNull());
    expect(useStore.getState().history).toHaveLength(0);
    expect(runtimeMock.runner?.getPhase()).not.toBe('ended');
  });

  /**
   * A CLOCK THE PATIENT CANNOT RESTART MUST NOT ALSO BE A CLOCK THAT SPENDS THEIR SESSION.
   *
   * When the browser suspends the AudioContext the stalled-clock screen goes FULL-BLEED over this
   * dialog — it is the whole control, deliberately, because only a trusted touch can start sound
   * again — so the circle that takes the ending back is behind it and answerable by nobody in the
   * chair. If the countdown kept running there, the one state in the app that provably cannot be
   * answered hands-free would be the state in which a session ends by itself.
   *
   * The mocked audio clock here is fixed at `currentTime: 0`, which is exactly what a suspended
   * context looks like to the runner (`stalledFrames`), so this is the real path and not a stub of it.
   */
  it('freezes the grace window while the audio clock is stalled', async () => {
    await pausedScreen();
    act(() => fireEvent.click(screen.getByTestId('end-session')));
    act(() => fireEvent.click(screen.getByTestId('end-confirm-btn')));
    // The runner reports a stalled clock after ~60 frames of a clock that does not advance.
    await waitFor(() => expect(screen.getByTestId('clock-stalled')).toBeTruthy(), { timeout: 4000 });
    const left = screen.getByTestId('end-grace-left').textContent;
    await new Promise((r) => setTimeout(r, 1500));
    // 1.5 s of a 10 s window would have moved a running countdown by at least one whole second.
    expect(screen.getByTestId('end-grace-left').textContent).toBe(left);
    nothingWritten();
  }, 15_000);

  it('"Stop now" is there for somebody who meant it, and it is the only other way out', async () => {
    await pausedScreen();
    act(() => fireEvent.click(screen.getByTestId('end-session')));
    act(() => fireEvent.click(screen.getByTestId('end-confirm-btn')));
    act(() => fireEvent.click(screen.getByTestId('end-now')));
    // Three deliberate acts, and only now is the run finished and filed.
    await waitFor(() => expect(runtimeMock.runner?.getPhase()).toBe('ended'));
  });
});
