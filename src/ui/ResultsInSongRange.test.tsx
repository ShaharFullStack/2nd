/**
 * THE RESULTS SCREEN SAYS WHERE ITS 0–100 % CAME FROM.
 *
 * Every range figure on that screen is a percentage OF a range. When the range was learned inside
 * the music rather than measured on the calibration screen, the therapist reading "62 % of range"
 * has to be able to see that from the screen — and the chip that subtracts today from last time has
 * to lose its green when the two were not arrived at the same way. This is the UI end of
 * session/calibrationMethod.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { CalibrationMeasurement } from '../vision/calibration.ts';
import type { LaneResultSummary, SessionResult, TrackingQuality } from '../session/types.ts';
import { DEFAULT_SETTINGS, defaultLanes, useStore } from '../state/store.ts';
import ResultsScreen from './Results.tsx';

const CLEAN: TrackingQuality = {
  samples: 200, fpsMedian: 29, fpsLow: 27, inferenceMsMedian: 14,
  trackedFraction: 0.99, lowFpsFraction: 0, delegate: 'GPU', worstReason: null,
};

const BLOCK = {
  frames: 900, tracked: 895, trackedFraction: 0.994, fpsMedian: 30, fpsLow: 28,
  durationSec: 30, reps: 4, repSpread: 2, repSpreadFraction: 0.05,
} satisfies Omit<CalibrationMeasurement, 'method'>;

const MEASURED: CalibrationMeasurement = { ...BLOCK, method: 'rom_screen' };
const IN_SONG: CalibrationMeasurement = { ...BLOCK, method: 'in_song' };

function lane(patch: Partial<LaneResultSummary> = {}): LaneResultSummary {
  return {
    lane: 0, movement: 'knee_extension', side: 'left', movementName: 'Left Knee extension',
    hits: 10, perfects: 4, goods: 6, misses: 5, judged: 15, accuracy: 0.67, reps: 18,
    timingBiasMs: 20, timingBiasMadMs: 12, romMean: 0.6, romBest: 0.8, romSamples: 18, romUncertain: 0,
    calibratedMin: 90, calibratedMax: 140, calibrationManual: false,
    compensationKind: null, compensationMonitored: false, compensationFlags: 0, compensationWorst: null,
    ...patch,
  };
}

function result(patch: Partial<SessionResult> = {}): SessionResult {
  return {
    id: 's1', patientId: 'p1', patientName: 'R.K.', startedAt: 1_700_000_000_000, endedAt: 1_700_000_100_000,
    durationSec: 100, mode: 'leg', difficulty: 'medium', windowScale: 1, inputMode: 'camera',
    songId: 'demo-groove', songTitle: 'Groove Circuit', artist: 'A', attribution: 'CC0',
    score: 1200, stars: 3, accuracy: 0.67, starAccuracy: 0.6, maxCombo: 8, totalNotes: 20,
    hits: 10, perfects: 4, goods: 6, misses: 5, reps: 18, answerRate: 0.9, surplusMovements: 3,
    laneRestSec: 1.2, timingBiasMs: 20, timingBiasMadMs: 12, latencyOffsetMs: 120, suggestedLatencyMs: null,
    completed: true, tracking: CLEAN, lanes: [lane()],
    ...patch,
  };
}

beforeEach(() => {
  localStorage.clear();
  useStore.setState({
    screen: 'results',
    mode: 'leg',
    lanes: defaultLanes('leg'),
    calibrations: [null, null],
    savedCalibrations: {},
    settings: { ...DEFAULT_SETTINGS },
    history: [],
    lastResult: null,
    patients: [{ id: 'p1', name: 'R.K.', createdAt: 1, lastUsedAt: 1 }],
    activePatientId: 'p1',
  });
});
afterEach(cleanup);

describe('the range card says how the range behind its percentages was arrived at', () => {
  it('marks an in-song range as learned in song, in the chip and in the sentence', () => {
    const r = result({ calibrationMode: 'in_song', lanes: [lane({ calibrationMeasurement: IN_SONG })] });
    useStore.setState({ lastResult: r, history: [r] });
    render(<ResultsScreen />);
    expect(screen.getByTestId('results-measurement-note-calibration-grade').textContent).toContain('learned in song');
    expect(screen.getByTestId('results-measurement-note-calibration').textContent).toMatch(/while the song was playing/);
  });

  it('marks a deliberately measured range as measured, and does not nag about it', () => {
    const r = result({ calibrationMode: 'measured', lanes: [lane({ calibrationMeasurement: MEASURED })] });
    useStore.setState({ lastResult: r, history: [r] });
    render(<ResultsScreen />);
    const chip = screen.getByTestId('results-measurement-note-calibration-grade');
    expect(chip.textContent).toContain('measured');
    expect(chip.textContent).not.toContain('learned in song');
    expect(screen.getByTestId('results-measurement-note-calibration').textContent).not.toMatch(/while the song was playing/);
  });

  it('says "not recorded" for a range that carries no measurement at all', () => {
    const r = result({ lanes: [lane({ calibrationMeasurement: null })] });
    useStore.setState({ lastResult: r, history: [r] });
    render(<ResultsScreen />);
    expect(screen.getByTestId('results-measurement-note-calibration-grade').textContent).toContain('not recorded');
  });
});

describe('today is not subtracted from last time as if the two ranges were alike', () => {
  /**
   * The failure this prevents: last week's range came off the calibration screen, today's was
   * learned in the song, and the screen prints a green "+12 %" that is partly a change of method.
   * The qualifier rides INSIDE the chip, exactly as the tracking one does — a grey sentence under a
   * green chip is not a qualifier.
   */
  it('strips the green from the gain chip and says why inside it', () => {
    const before = result({
      id: 's0', startedAt: 1_600_000_000_000, endedAt: 1_600_000_100_000,
      calibrationMode: 'measured', lanes: [lane({ romMean: 0.5, calibrationMeasurement: MEASURED })],
    });
    const today = result({
      calibrationMode: 'in_song', lanes: [lane({ romMean: 0.7, calibrationMeasurement: IN_SONG })],
    });
    useStore.setState({ lastResult: today, history: [today, before] });
    render(<ResultsScreen />);
    const chip = screen.getByTestId('results-range-gain-0');
    expect(chip.textContent).toMatch(/ranges measured differently/);
    expect(chip.className).not.toMatch(/badge-ok/);
  });

  it('leaves a like-for-like pair alone — the caveat is not furniture', () => {
    const before = result({
      id: 's0', startedAt: 1_600_000_000_000, endedAt: 1_600_000_100_000,
      calibrationMode: 'measured', lanes: [lane({ romMean: 0.5, calibrationMeasurement: MEASURED })],
    });
    const today = result({
      calibrationMode: 'measured', lanes: [lane({ romMean: 0.7, calibrationMeasurement: MEASURED })],
    });
    useStore.setState({ lastResult: today, history: [today, before] });
    render(<ResultsScreen />);
    expect(screen.getByTestId('results-range-gain-0').textContent).not.toMatch(/ranges measured differently/);
  });
});
