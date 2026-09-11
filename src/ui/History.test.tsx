/**
 * THE HISTORY TABLE MAY NOT CONTRADICT THE RESULTS SCREEN.
 *
 * Results was corrected to lead with the work and fold the grade away for the therapist. The
 * per-session table one screen later still read WHEN | SESSION | SCORE | STARS | ACCURACY | REPS,
 * so the entertainment grade on an impairment came before the count of what the patient did — the
 * same failure, in the durable record rather than in the moment.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { LaneResultSummary, SessionResult } from '../session/types.ts';
import { DEFAULT_SETTINGS, defaultLanes, useStore } from '../state/store.ts';
import HistoryScreen from './History.tsx';

const PATIENT = 'p1';

function lane(patch: Partial<LaneResultSummary> = {}): LaneResultSummary {
  return {
    lane: 0, movement: 'seated_march', side: 'left', movementName: 'Left Seated march',
    hits: 8, perfects: 4, goods: 4, misses: 2, judged: 10, accuracy: 0.8, reps: 41,
    timingBiasMs: 12, timingBiasMadMs: 8, romMean: 0.62, romBest: 0.75, romSamples: 41, romUncertain: 0,
    calibratedMin: 0.1, calibratedMax: 0.5, calibrationManual: false,
    compensationKind: null, compensationMonitored: false, compensationFlags: 0, compensationWorst: null,
    ...patch,
  };
}

function session(patch: Partial<SessionResult> = {}): SessionResult {
  return {
    id: 's1', patientId: PATIENT, patientName: 'R.K.', startedAt: 1_700_000_000_000, endedAt: 1_700_000_100_000,
    durationSec: 97, mode: 'leg', difficulty: 'medium', windowScale: 1, inputMode: 'camera',
    songId: 'demo', songTitle: 'Demo Groove', artist: 'A', attribution: 'CC BY',
    score: 5100, stars: 4, accuracy: 0.82, starAccuracy: 0.8, maxCombo: 21, totalNotes: 120,
    hits: 96, perfects: 40, goods: 56, misses: 24, reps: 141, answerRate: 0.9,
    laneRestSec: 1.2,
    timingBiasMs: 12, timingBiasMadMs: 8, latencyOffsetMs: 120, suggestedLatencyMs: null,
    completed: true, lanes: [lane()],
    ...patch,
  };
}

beforeEach(() => {
  localStorage.clear();
  useStore.setState({
    screen: 'history',
    mode: 'leg',
    lanes: defaultLanes('leg'),
    calibrations: [null, null],
    savedCalibrations: {},
    settings: { ...DEFAULT_SETTINGS },
    history: [session()],
    historyDropped: {},
    patients: [{ id: PATIENT, name: 'R.K.', createdAt: 1, lastUsedAt: 2 }],
    activePatientId: PATIENT,
    lastResult: null,
  });
});
afterEach(cleanup);

const headings = (): (string | null)[] =>
  Array.from(screen.getByTestId('history-table').querySelectorAll('thead th')).map((h) => h.textContent);

describe('the session table leads with what the patient did', () => {
  it('puts movements performed and the movements worked ahead of every scoring column', () => {
    render(<HistoryScreen />);
    expect(headings()).toEqual(['When', 'Session', 'Movements performed', 'Range worked', 'Length']);
  });

  it('keeps the grade for the therapist, one tap away, and behind the work when it is shown', () => {
    render(<HistoryScreen />);
    // Not on screen by default: a patient reading over a shoulder sees the work, not a mark.
    expect(screen.getByTestId('history-table').textContent).not.toContain('5,100');
    fireEvent.click(screen.getByTestId('history-toggle-scoring'));
    const heads = headings();
    expect(heads).toContain('Score');
    expect(heads).toContain('Stars');
    expect(heads.indexOf('Movements performed')).toBeLessThan(heads.indexOf('Score'));
    expect(heads.indexOf('Movements performed')).toBeLessThan(heads.indexOf('Accuracy'));
    expect(screen.getByTestId('history-table').textContent).toContain('5,100');
  });

  it('states the rep count and the pacing it was asked for in the same cell', () => {
    render(<HistoryScreen />);
    const row = screen.getByTestId('history-table').querySelector('tbody tr');
    const cells = Array.from(row!.querySelectorAll('td')).map((c) => c.textContent ?? '');
    expect(cells[2]).toContain('141');
    expect(cells[2]).toContain('1.2 s pacing');
    expect(cells[3]).toContain('Left Seated march');
    expect(cells[3]).toContain('41 reps');
  });

  it('still quarantines a run the patient did not drive', () => {
    useStore.setState({ history: [session({ inputMode: 'keyboard' })] });
    render(<HistoryScreen />);
    expect(screen.getByTestId('history-not-measured-s1').textContent).toContain('not measured');
  });
});
