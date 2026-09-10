/**
 * The latency screen reads a sentence to the PATIENT while they do the reps that measure the delay.
 *
 * It used to be assembled from `MOVEMENT_INFO[movement].label` and the side — "do one finger
 * opposition with the left side" — which does not say WHICH DIGIT. On the prescription this app
 * exists for (two finger_opposition lanes on one hand) that sentence is ambiguous, and a patient who
 * opposes the wrong finger has the wrong quantity's pipeline delay measured and stored as the
 * session's offset.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { storageKey } from '../state/persist.ts';
import { DEFAULT_SETTINGS, useStore } from '../state/store.ts';

vi.mock('../session/runtime.ts', () => ({
  runtime: {
    ensureAudio: async () => ({ mixer: { createLatencyProbe: () => ({ start() {}, cancel() {}, recordInput() {} }) } }),
    peekVision: () => null,
  },
}));

const { default: LatencyCalibrationScreen } = await import('./LatencyCalibration.tsx');

beforeEach(() => {
  cleanup();
  localStorage.clear();
  useStore.setState({
    screen: 'latency',
    mode: 'hand',
    lanes: [
      { index: 0, movement: 'finger_opposition', side: 'left', fingertip: 'pinky' },
      { index: 1, movement: 'hand_open_close', side: 'left' },
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

/** Put an offset in force the way the Results screen does, then land on the latency screen. */
function applyFromResults(ms: number, source = 'Demo Groove, 8 Sep 2026'): void {
  useStore.getState().applySuggestedLatency(ms, source);
  useStore.setState({ screen: 'latency' });
}

describe('the sentence the patient is read on the latency screen', () => {
  it('names the prescribed digit, in both the lane name and the instruction', () => {
    render(<LatencyCalibrationScreen />);
    const line = screen.getByTestId('latency-instruction').textContent ?? '';
    expect(line).toMatch(/Left Finger opposition \(little finger\)/);
    expect(line).toMatch(/Touch your thumb to your little finger/);
    expect(line).not.toMatch(/to your fingertip/);
  });

  it('leaves a movement with no fingertip dimension on its own wording', () => {
    useStore.setState({ lanes: [{ index: 0, movement: 'seated_march', side: 'right' }, { index: 1, movement: 'knee_extension', side: 'right' }] });
    render(<LatencyCalibrationScreen />);
    const line = screen.getByTestId('latency-instruction').textContent ?? '';
    expect(line).toMatch(/Right Seated march/);
    expect(line).toMatch(/Lift your knee up toward the ceiling/);
  });
});

describe('what the latency screen leaves in force', () => {
  it('SKIP KEEPS the offset the therapist applied for this session — it does not write the default', () => {
    // The whole point of the Results hand-over: "use 280 ms next session". The next session's flow
    // runs straight through this screen, and the top-right button used to write 120 ms over it.
    applyFromResults(280);
    render(<LatencyCalibrationScreen />);

    const skip = screen.getByTestId('latency-skip');
    expect(skip.textContent).toMatch(/keep 280 ms/i);

    fireEvent.click(skip);
    expect(useStore.getState().latencyOffsetSec).toBeCloseTo(0.28, 6);
    expect(useStore.getState().latencyMeasured).toBe(true);
    expect(localStorage.getItem(storageKey('latency'))).toBe('0.28');
    expect(useStore.getState().screen).toBe('play');
  });

  it('offers the default only on a device where nothing has ever been set', () => {
    render(<LatencyCalibrationScreen />);
    const skip = screen.getByTestId('latency-skip');
    expect(skip.textContent).toMatch(/use 120 ms/i);
    fireEvent.click(skip);
    expect(useStore.getState().latencyOffsetSec).toBeCloseTo(0.12, 6);
    expect(useStore.getState().latencyMeasured).toBe(false);
    expect(useStore.getState().screen).toBe('play');
  });

  it('never writes a default over a measured 0 ms — "0 in force" is not "nothing set"', () => {
    useStore.getState().setLatency(0, true, 'measured on the latency screen');
    useStore.setState({ screen: 'latency' });
    render(<LatencyCalibrationScreen />);
    expect(screen.getByTestId('latency-skip').textContent).toMatch(/keep 0 ms/i);
    fireEvent.click(screen.getByTestId('latency-skip'));
    expect(useStore.getState().latencyOffsetSec).toBe(0);
  });

  it('discards the value in force only from a button that names both numbers', () => {
    applyFromResults(280);
    render(<LatencyCalibrationScreen />);
    const discard = screen.getByTestId('latency-use-default');
    expect(discard.textContent).toMatch(/use 120 ms/i);
    // The consequence is on the card next to it, not implied by the word "default".
    expect(discard.parentElement?.textContent).toMatch(/Replaces the 280 ms above/);
    fireEvent.click(discard);
    expect(useStore.getState().latencyOffsetSec).toBeCloseTo(0.12, 6);
    expect(useStore.getState().latencyNote).toMatch(/280 ms previously in force was discarded/);
  });

  it('shows the offset with its provenance, not as an anonymous badge', () => {
    applyFromResults(280);
    render(<LatencyCalibrationScreen />);
    expect(screen.getByTestId('latency-current').textContent).toBe('280 ms');
    const why = screen.getByTestId('latency-provenance').textContent ?? '';
    expect(why).toMatch(/Demo Groove/);
    expect(why).toMatch(/Skipping this screen keeps it/);
  });

  it('says plainly that nothing is set yet, rather than printing 0 ms as a calibration', () => {
    render(<LatencyCalibrationScreen />);
    expect(screen.getByTestId('latency-provenance').textContent).toMatch(/Nothing has set an offset on this device yet/);
    expect(screen.queryByTestId('latency-use-default')).toBeNull();
  });
});
