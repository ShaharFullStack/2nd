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
    const row = screen.getByTestId('history-table').querySelector('tbody tr:not(.visit-row)');
    const cells = Array.from(row!.querySelectorAll('td')).map((c) => c.textContent ?? '');
    expect(cells[2]).toContain('141');
    expect(cells[2]).toContain('1.2 s pacing');
    expect(cells[3]).toContain('Left Seated march');
    expect(cells[3]).toContain('41 reps');
  });

  /**
   * SEVERAL SONGS IN ONE VISIT ARE NOT SEVERAL VISITS.
   *
   * A 97 s song cannot fill a 40-minute slot and the Results screen ends with "Play again", so one
   * appointment routinely lands three or four rows in this table. Read flat they are three or four
   * appointments — a claim about attendance the record does not contain.
   */
  describe('a visit is one band of rows, not one row', () => {
    const HOUR = 3_600_000;
    /** Three runs inside one 40-minute slot, and one the following week. */
    const twoVisits = (): SessionResult[] => [
      session({ id: 'w2c', startedAt: 1_700_000_000_000 + 30 * 60_000, endedAt: 1_700_000_000_000 + 32 * 60_000, reps: 120 }),
      session({ id: 'w2b', startedAt: 1_700_000_000_000 + 15 * 60_000, endedAt: 1_700_000_000_000 + 17 * 60_000, reps: 130 }),
      session({ id: 'w2a', startedAt: 1_700_000_000_000, endedAt: 1_700_000_000_000 + 2 * 60_000, reps: 141 }),
      session({ id: 'w1', startedAt: 1_700_000_000_000 - 7 * 24 * HOUR, endedAt: 1_700_000_000_000 - 7 * 24 * HOUR + 120_000, reps: 90 }),
    ];

    it('groups the runs of one appointment under one header and totals them', () => {
      useStore.setState({ history: twoVisits() });
      render(<HistoryScreen />);
      const headers = Array.from(screen.getByTestId('history-table').querySelectorAll('tr.visit-row'));
      expect(headers).toHaveLength(2);
      // Newest visit first, with everything the therapist needs to tell one appointment from three.
      expect(headers[0].textContent).toContain('3 songs');
      expect(headers[0].textContent).toContain('391 movements'); // 120 + 130 + 141
      expect(headers[1].textContent).toContain('1 song');
      expect(headers[1].textContent).toContain('90 movements');
      // The runs themselves are all still there, in their own rows.
      expect(screen.getByTestId('history-table').querySelectorAll('tbody tr:not(.visit-row)')).toHaveLength(4);
    });

    it('says the grouping was inferred from the clock, because the app is never told otherwise', () => {
      useStore.setState({ history: twoVisits() });
      render(<HistoryScreen />);
      expect(screen.getByTestId('history-visit-legend').textContent).toMatch(/inferred/i);
      expect(screen.getByTestId('history-visit-legend').textContent).toMatch(/45 minutes/);
    });

    it('counts runs and visits separately in the header, so neither can stand in for the other', () => {
      useStore.setState({ history: twoVisits() });
      render(<HistoryScreen />);
      expect(screen.getByTestId('history-screen').textContent).toContain('4 runs in 2 visits');
    });

    it('keeps the header spanning the table when the scoring columns are shown', () => {
      useStore.setState({ history: twoVisits() });
      render(<HistoryScreen />);
      const span = () =>
        Number(screen.getByTestId('history-table').querySelector('tr.visit-row td')?.getAttribute('colspan'));
      const headCount = () => screen.getByTestId('history-table').querySelectorAll('thead th').length;
      expect(span()).toBe(headCount());
      fireEvent.click(screen.getByTestId('history-toggle-scoring'));
      expect(span()).toBe(headCount());
    });

    it('marks a visit whose runs were not all measured on the patient', () => {
      useStore.setState({ history: [session({ id: 'a' }), session({ id: 'b', startedAt: 1_700_000_000_000 + 300_000, inputMode: 'autoplay' })] });
      render(<HistoryScreen />);
      const header = screen.getByTestId('history-table').querySelector('tr.visit-row');
      expect(header?.textContent).toContain('1 of these runs did not measure the patient');
    });
  });

  it('still quarantines a run the patient did not drive', () => {
    useStore.setState({ history: [session({ inputMode: 'keyboard' })] });
    render(<HistoryScreen />);
    expect(screen.getByTestId('history-not-measured-s1').textContent).toContain('not measured');
  });
});
