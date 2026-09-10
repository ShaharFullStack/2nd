/**
 * The patient must never be started on a song where a lane provably cannot score.
 *
 * A calibration VisionInput refused (a range measured on another fingertip, or under the other mirror
 * convention — a different quantity, or the other limb) leaves that lane reading a flat 0: no trigger,
 * no hit, no rep, all song. The app knows this before a single note is scheduled — `ensureVision`
 * returns an input whose `getInvalidCalibrations()` is already populated — so Play stops there instead
 * of letting the patient work through three minutes of a dead lane and meet the verdict as a 0% row on
 * the results screen.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { LaneSpec } from '../engine/types.ts';
import { DEFAULT_SETTINGS, useStore } from '../state/store.ts';
import type { InvalidCalibration } from '../input/VisionInput.ts';

const LANES: LaneSpec[] = [
  { index: 0, movement: 'finger_opposition', side: 'right', fingertip: 'pinky' },
  { index: 1, movement: 'hand_open_close', side: 'right' },
];

const refusals: InvalidCalibration[] = [];

const vision = {
  getInvalidCalibrations: () => refusals,
  getLaneStates: () => LANES.map((l) => ({ lane: l.index, value: 0, armed: false })),
  getVideoElement: () => null,
  onEvent: () => () => {},
  start: async () => {},
  stop: () => {},
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
    runner: null,
  },
}));

const { default: PlayScreen } = await import('./Play.tsx');

beforeEach(() => {
  refusals.length = 0;
  cleanup();
  useStore.setState({
    screen: 'play',
    mode: 'hand',
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

describe('Play refuses to start a session on a lane that cannot score', () => {
  it('names the lane, gives the reason and the action, and never reaches the game', async () => {
    refusals.push({
      lane: 0,
      movement: 'finger_opposition',
      side: 'right',
      reason:
        'it was measured opposing the index finger, but this lane opposes the pinky finger — re-calibrate this lane on the pinky finger',
    });

    render(<PlayScreen />);

    const blocked = await screen.findByTestId('play-blocked');
    expect(blocked.textContent).toMatch(/A lane is not calibrated/i);
    expect(screen.getByTestId('play-blocked-0').textContent).toMatch(/Lane 1/);
    expect(blocked.textContent).toMatch(/re-calibrate this lane on the pinky finger/i);
    // The way out is a button on this screen, not a console line.
    expect(screen.getByTestId('play-recalibrate')).toBeTruthy();
    // The session never started: no runner, no notes, no scoring on a dead lane.
    expect(useStore.getState().screen).toBe('play');
  });

  it('starts normally when nothing is refused', async () => {
    render(<PlayScreen />);
    await waitFor(() => expect(screen.queryByTestId('play-blocked')).toBeNull());
  });
});
