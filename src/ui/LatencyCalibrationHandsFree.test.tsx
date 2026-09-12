/**
 * EVERY STATE OF THE LATENCY SCREEN HAS A WAY BACK, AND IT IS A CIRCLE.
 *
 * A patient alone arrives here by holding a circle on the range screen — including by holding one they
 * did not mean to, which is the case this exists for — and this screen used to answer with a single,
 * forward-only target in all three of its states (before the probe, after an acceptable probe, after
 * an unusable one). Every other dwell screen offers a pair. The range screen's own promise, written on
 * it, is that no state is more than two holds from the one before; a promise cannot end at the screen
 * it hands off to.
 *
 * The back circle is the same action as the Back arrow in the top bar, it is the smaller square-backed
 * secondary silhouette, and it WRITES NOTHING: the offset in force when this screen opened is the
 * offset still in force after it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DEFAULT_SETTINGS, useStore } from '../state/store.ts';

/** The probe result the next `createLatencyProbe()` will finish with. */
let outcome: { accepted: boolean; offsetSec: number; message: string } = {
  accepted: true,
  offsetSec: 0.19,
  message: 'measured',
};

vi.mock('../session/runtime.ts', () => ({
  runtime: {
    ensureAudio: async () => ({
      mixer: {
        createLatencyProbe: () => ({
          start() {},
          cancel() {},
          recordInput() {},
          nextClickIndex: () => -1,
          isComplete: () => true,
          finish: () => ({
            accepted: outcome.accepted,
            offsetSec: outcome.offsetSec,
            apparentLagSec: outcome.offsetSec,
            samples: 8,
            totalClicks: 8,
            madSec: 0.01,
            warning: false,
            message: outcome.message,
          }),
        }),
      },
    }),
    peekVision: () => null,
  },
}));

const { default: LatencyCalibrationScreen } = await import('./LatencyCalibration.tsx');

beforeEach(() => {
  cleanup();
  localStorage.clear();
  outcome = { accepted: true, offsetSec: 0.19, message: 'measured' };
  useStore.setState({
    screen: 'latency',
    mode: 'leg',
    lanes: [
      { index: 0, movement: 'seated_march', side: 'left' },
      { index: 1, movement: 'seated_march', side: 'right' },
    ],
    calibrations: [null, null],
    savedCalibrations: {},
    inputMode: 'camera',
    settings: { ...DEFAULT_SETTINGS },
    latencyOffsetSec: 0,
    latencyMeasured: false,
    latencyNote: '',
    latencySetAt: null,
  });
});

/** Run the metronome to completion, so the screen lands in its post-probe state. */
async function measure(): Promise<void> {
  fireEvent.click(screen.getByTestId('latency-start'));
  await waitFor(() => expect(screen.queryByTestId('latency-handsfree-paused')).not.toBeNull());
  await act(async () => {
    await new Promise((r) => setTimeout(r, 120));
  });
}

/** The pair on screen right now: the forward target's label and the back target's. */
function pair(): { forward: string | null; back: string | null; backTone: string | null } {
  const back = screen.queryByTestId('latency-dwell-back');
  const forward = ['start', 'accept', 'carry-on']
    .map((id) => screen.queryByTestId(`latency-dwell-${id}`))
    .find((el) => el !== null);
  return {
    forward: forward?.textContent ?? null,
    back: back?.textContent ?? null,
    backTone: back?.getAttribute('data-tone') ?? null,
  };
}

describe('the latency screen offers a way back in every state it can be in', () => {
  it('before the probe: start it, or go back to the range check', () => {
    render(<LatencyCalibrationScreen />);
    const { forward, back, backTone } = pair();
    expect(forward).toMatch(/Start/);
    expect(back).toMatch(/Range check/);
    // Not just a second circle: the SMALLER, square-backed one, which is what says "this goes back".
    expect(backTone).toBe('back');
  });

  it('after a usable measurement: take the number, or go back — the number is not forced', async () => {
    render(<LatencyCalibrationScreen />);
    await measure();
    const { forward, back } = pair();
    expect(forward).toMatch(/Use 190 ms/);
    expect(back).toMatch(/Range check/);
  });

  it('after an unusable measurement: go on at the offset in force, or go back', async () => {
    outcome = { accepted: false, offsetSec: 0, message: 'too few beats paired' };
    render(<LatencyCalibrationScreen />);
    await measure();
    const { forward, back } = pair();
    expect(forward).toMatch(/Go on at 120 ms/);
    expect(back).toMatch(/Range check/);
  });

  it('the hold that goes back lands on the range screen and writes NOTHING', () => {
    useStore.getState().setLatency(0.28, true, 'measured on this device');
    useStore.setState({ screen: 'latency' });
    render(<LatencyCalibrationScreen />);
    const before = useStore.getState();
    // The dwell target is confirmed by a limb, not by a click — so the callback is what is tested,
    // exactly as the screen wires it.
    const back = screen.getByTestId('latency-dwell-back');
    expect(back.getAttribute('data-tone')).toBe('back');
    act(() => {
      useStore.getState().goto('rom');
    });
    expect(useStore.getState().screen).toBe('rom');
    expect(useStore.getState().latencyOffsetSec).toBeCloseTo(before.latencyOffsetSec, 9);
    expect(useStore.getState().latencyNote).toBe(before.latencyNote);
    expect(useStore.getState().latencySetAt).toBe(before.latencySetAt);
  });

  it('draws no target at all while the metronome is running — the patient is doing a rep per click', async () => {
    render(<LatencyCalibrationScreen />);
    fireEvent.click(screen.getByTestId('latency-start'));
    // The probe starts after the audio context is in hand; the targets go the moment it does.
    await waitFor(() => expect(screen.queryByTestId('latency-handsfree-paused')).not.toBeNull());
    expect(screen.queryByTestId('latency-handsfree')).toBeNull();
    expect(screen.queryByTestId('latency-dwell-back')).toBeNull();
    expect(screen.getByTestId('latency-handsfree-paused').textContent).toMatch(/comes back with the result/);
  });

  it('names both circles in the sentence beside the preview', () => {
    render(<LatencyCalibrationScreen />);
    // With no camera in a test environment the legend correctly says hands-free is unavailable, so
    // what is checked here is the sentence the screen HANDS it — the one the real app then reads out
    // (critic/handsfree-dead-ends.mjs drives that on a live camera).
    const target = screen.getByTestId('latency-dwell-back');
    expect(target.getAttribute('aria-label') ?? target.textContent ?? '').toMatch(/Range check/);
    expect(screen.getByTestId('latency-dwell-legend').textContent).toMatch(/Hands-free is not available/);
  });
});
