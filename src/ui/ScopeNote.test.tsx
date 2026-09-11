/**
 * THE SCOPE STATEMENT IS ON THE SCREENS THAT PRESENT MEASUREMENTS, and the measurement conditions
 * are beside the measurements.
 *
 * Both used to be missing entirely: the scope lived in the README while the app printed joint angles
 * and six-week trends, and the record carried no frame rate at all — so a range measured on a 12 fps
 * stream with the limb drifting out of frame was indistinguishable from one measured cleanly.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { SCOPE_SHORT, SCOPE_STATEMENT } from '../session/results.ts';
import type { LaneResultSummary, SessionResult, TrackingQuality } from '../session/types.ts';
import { DEFAULT_SETTINGS, defaultLanes, useStore } from '../state/store.ts';
import ResultsScreen from './Results.tsx';
import HistoryScreen from './History.tsx';

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

const CLEAN: TrackingQuality = {
  samples: 200, fpsMedian: 29, fpsLow: 27, inferenceMsMedian: 14,
  trackedFraction: 0.99, lowFpsFraction: 0, delegate: 'GPU', worstReason: null,
};
const BAD: TrackingQuality = {
  samples: 200, fpsMedian: 11, fpsLow: 6, inferenceMsMedian: 80,
  trackedFraction: 0.68, lowFpsFraction: 0.95, delegate: 'CPU', worstReason: 'low_visibility',
};

function result(patch: Partial<SessionResult> = {}): SessionResult {
  return {
    id: 's1', patientId: 'p1', patientName: 'R.K.', startedAt: 1_700_000_000_000, endedAt: 1_700_000_100_000,
    durationSec: 100, mode: 'leg', difficulty: 'medium', windowScale: 1, inputMode: 'camera',
    songId: 'demo-groove', songTitle: 'Groove Circuit', artist: 'A', attribution: 'CC0',
    score: 1200, stars: 3, accuracy: 0.67, starAccuracy: 0.6, maxCombo: 8, totalNotes: 20,
    hits: 10, perfects: 4, goods: 6, misses: 5, reps: 18, answerRate: 0.9, surplusMovements: 3,
    laneRestSec: 1.2, timingBiasMs: 20, timingBiasMadMs: 12, latencyOffsetMs: 120, suggestedLatencyMs: null,
    completed: true, lanes: [lane()],
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

describe('the Results screen says what its figures are', () => {
  it('carries the scope statement under the range card, where the degrees are', () => {
    useStore.setState({ lastResult: result({ tracking: CLEAN }), history: [result({ tracking: CLEAN })] });
    render(<ResultsScreen />);
    const note = screen.getByTestId('results-measurement-note');
    expect(note.textContent).toContain(SCOPE_STATEMENT);
    // and it is inside the card that prints the range, not parked at the bottom of the screen
    expect(screen.getByTestId('results-range').contains(note)).toBe(true);
  });

  it('states the conditions and grades a clean stream without nagging', () => {
    useStore.setState({ lastResult: result({ tracking: CLEAN }), history: [result({ tracking: CLEAN })] });
    render(<ResultsScreen />);
    expect(screen.getByTestId('results-measurement-note-grade').textContent).toContain('good');
    const text = screen.getByTestId('results-measurement-note-tracking').textContent ?? '';
    expect(text).toContain('29 fps');
    expect(text).toContain('99 %');
    expect(text).not.toMatch(/approximate|lower bounds/);
  });

  it('says a degraded session is degraded, in the words that change how it is read', () => {
    useStore.setState({ lastResult: result({ tracking: BAD }), history: [result({ tracking: BAD })] });
    render(<ResultsScreen />);
    expect(screen.getByTestId('results-measurement-note-grade').textContent).toContain('poor');
    const text = screen.getByTestId('results-measurement-note-tracking').textContent ?? '';
    expect(text).toContain('11 fps');
    expect(text).toContain('lower bounds');
    // the timing card states its own resolution: one camera frame, not the printed millisecond
    expect(screen.getByTestId('results-timing-resolution').textContent).toContain('91 ms');
  });

  it('a session with no tracking block reads as not recorded, never as a clean stream', () => {
    useStore.setState({ lastResult: result(), history: [result()] });
    render(<ResultsScreen />);
    const text = screen.getByTestId('results-measurement-note-tracking').textContent ?? '';
    expect(text).toContain('not recorded');
    expect(text).not.toContain('fps');
  });

  it('says nothing about tracking for a run the camera did not drive', () => {
    useStore.setState({ lastResult: result({ inputMode: 'keyboard' }), history: [] });
    render(<ResultsScreen />);
    expect(screen.getByTestId('results-measurement-note').textContent).toContain(SCOPE_STATEMENT);
    expect(screen.queryByTestId('results-measurement-note-tracking')).toBeNull();
  });
});

describe('the History screen says what its record is', () => {
  it('carries the scope statement, and each camera session carries its tracking quality', () => {
    useStore.setState({
      screen: 'history',
      history: [result({ id: 'a', tracking: BAD }), result({ id: 'b', startedAt: 1_600_000_000_000, tracking: CLEAN })],
    });
    render(<HistoryScreen />);
    expect(screen.getByTestId('history-scope').textContent).toContain(SCOPE_STATEMENT);
    expect(screen.getByTestId('history-tracking-a').textContent).toContain('11 fps');
    expect(screen.getByTestId('history-tracking-b').textContent).toContain('29 fps');
  });

  it('names the sessions in the trend that were measured on a degraded stream', () => {
    useStore.setState({
      screen: 'history',
      history: [
        result({ id: 'a', tracking: BAD }),
        result({ id: 'b', startedAt: 1_600_000_000_000, tracking: CLEAN }),
        result({ id: 'c', startedAt: 1_500_000_000_000 }),
      ],
    });
    render(<HistoryScreen />);
    const mix = screen.getByTestId('trend-tracking-mix').textContent ?? '';
    expect(mix).toContain('3 camera sessions');
    expect(mix).toContain('1 was measured on a degraded camera stream');
    expect(mix).toContain('1 has no tracking quality recorded');
    expect(screen.getByTestId('trend-scope-note').textContent).toContain(SCOPE_STATEMENT);
  });
});

describe('the short form is the same statement', () => {
  it('says game, not instrument, in both lengths', () => {
    for (const s of [SCOPE_STATEMENT, SCOPE_SHORT]) {
      expect(s).toMatch(/movement game/i);
      expect(s).toMatch(/instrument/i);
    }
  });
});
