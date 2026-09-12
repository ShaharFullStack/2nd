/**
 * HOW WELL THE RANGE WAS MEASURED, ON THE SCREEN THAT ACCEPTS IT AND THE ONE THAT REUSES IT.
 *
 * The calibrated range is the denominator of every ROM percentage this app prints, exports and
 * trends. Two ranges with identical min→max readouts — one from a clean stream with three tight reps,
 * one from an 11 fps stream that lost the limb for a third of the hold — used to be indistinguishable
 * everywhere, starting here. These tests pin that the grade reaches the therapist at the three moments
 * they can act on it: while the range is being built, as it is accepted, and before last session's is
 * reused.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { LaneSpec } from '../engine/types.ts';
import { DEFAULT_SETTINGS, calibrationKey, useStore } from '../state/store.ts';
import { RomCalibrator, calibrationContext } from '../vision/calibration.ts';
import type { CalibrationMeasurement, RomCalibration } from '../vision/calibration.ts';

const LANES: LaneSpec[] = [{ index: 0, movement: 'knee_extension', side: 'left' }];

function measurement(patch: Partial<CalibrationMeasurement> = {}): CalibrationMeasurement {
  return {
    frames: 150, tracked: 149, trackedFraction: 0.99, fpsMedian: 30, fpsLow: 27,
    durationSec: 5, reps: 3, repSpread: 2, repSpreadFraction: 0.05,
    ...patch,
  };
}

function range(measurementBlock: CalibrationMeasurement | null | undefined): RomCalibration {
  return {
    min: 20, max: 70, samples: 150, movement: 'knee_extension', mirrored: false,
    capturedAt: Date.now(), measurement: measurementBlock,
  };
}

const vision = {
  createCalibrator: () => new RomCalibrator('knee_extension', { ...calibrationContext('knee_extension', { mirrored: false }) }),
  getCalibrationContext: () => calibrationContext('knee_extension', { mirrored: false }),
  getPipeline: () => null,
  onFrame: () => () => {},
  getInvalidCalibrations: () => [],
  getVideoElement: () => null,
  setCalibration: () => true,
};

vi.mock('../session/runtime.ts', () => ({ runtime: { peekVision: () => vision } }));

const { default: RomCalibrationScreen } = await import('./RomCalibration.tsx');

beforeEach(() => {
  localStorage.clear();
  useStore.setState({
    screen: 'rom', mode: 'leg', lanes: LANES, calibrations: [null], savedCalibrations: {},
    difficulty: 'medium', windowScale: 1, inputMode: 'camera', persistenceFailed: false,
    settings: { ...DEFAULT_SETTINGS },
  });
});

afterEach(cleanup);

function saveRange(cal: RomCalibration): void {
  useStore.setState({ savedCalibrations: { [calibrationKey(LANES[0])]: cal } });
}

describe('the range offered back from last session carries how it was measured', () => {
  it('grades a clean stored range good, before the therapist reuses it', async () => {
    saveRange(range(measurement()));
    render(<RomCalibrationScreen />);

    const chip = await screen.findByTestId('rom-reuse-quality-chip');
    expect(chip.textContent).toBe('measured good');
    expect(chip.className).toContain('badge-ok');
    // Reusing a range is adopting its measurement; the note says so in those words.
    expect(screen.getByTestId('rom-reuse-quality-note').textContent).toMatch(/today.s denominator/i);
  });

  it('grades a ragged stored range poor and says which way the error points', async () => {
    saveRange(range(measurement({ fpsMedian: 11, fpsLow: 8, trackedFraction: 0.62, repSpreadFraction: 0.5 })));
    render(<RomCalibrationScreen />);

    const chip = await screen.findByTestId('rom-reuse-quality-chip');
    expect(chip.textContent).toBe('measured poor');
    expect(chip.className).toContain('badge-bad');
    const note = screen.getByTestId('rom-reuse-quality-note').textContent ?? '';
    expect(note).toContain('11 fps');
    expect(note).toMatch(/too low/);
    expect(note).toMatch(/larger percentage/);
  });

  it('a stored range with no measurement block reads "quality not recorded", never good', async () => {
    saveRange(range(null));
    render(<RomCalibrationScreen />);

    const chip = await screen.findByTestId('rom-reuse-quality-chip');
    expect(chip.textContent).toBe('quality not recorded');
    expect(chip.className).not.toContain('badge-ok');
    expect(screen.getByTestId('rom-reuse-quality-note').textContent).toMatch(/set by hand, or captured before/i);
  });
});

describe('the range this screen accepts carries how it was measured', () => {
  it('shows the grade on the accepted range and on the lane list', async () => {
    saveRange(range(measurement({ fpsMedian: 20, fpsLow: 18 })));
    render(<RomCalibrationScreen />);

    fireEvent.click(await screen.findByTestId('rom-reuse'));

    await waitFor(() => expect(screen.getByTestId('rom-lane-badge-0').textContent).toBe('✓'));
    const accepted = screen.getByTestId('rom-accepted-quality-chip');
    // 20 fps is usable but below the rate the figures assume: fair, not good.
    expect(accepted.textContent).toBe('measured fair');
    expect(screen.getByTestId('rom-lane-quality-0').textContent).toBe('measured fair');
    expect(screen.getByTestId('rom-accepted-quality-note').textContent).toMatch(/20 fps/);
  });

  it('a hand-set range is accepted, and says its quality was never measured', async () => {
    saveRange(range(undefined));
    render(<RomCalibrationScreen />);

    fireEvent.click(await screen.findByTestId('rom-reuse'));

    await waitFor(() => expect(screen.getByTestId('rom-lane-badge-0').textContent).toBe('✓'));
    expect(screen.getByTestId('rom-accepted-quality-chip').textContent).toBe('quality not recorded');
    expect(screen.getByTestId('rom-lane-quality-0').textContent).toBe('quality not recorded');
  });
});
