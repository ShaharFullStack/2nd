import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { LaneResultSummary, SessionResult } from '../session/types.ts';
import { DEFAULT_SETTINGS, defaultLanes, useStore } from '../state/store.ts';
import ResultsScreen from './Results.tsx';

function lane(patch: Partial<LaneResultSummary> = {}): LaneResultSummary {
  return {
    lane: 0, movement: 'knee_extension', side: 'left', movementName: 'Left Knee extension',
    hits: 4, perfects: 1, goods: 3, misses: 36, judged: 40, accuracy: 0.1, reps: 38,
    timingBiasMs: 20, timingBiasMadMs: 15, romMean: 0.6, romBest: 0.75, romSamples: 38, romUncertain: 0,
    calibratedMin: 90, calibratedMax: 140, calibrationManual: false,
    compensationKind: null, compensationMonitored: false, compensationFlags: 0, compensationWorst: null,
    ...patch,
  };
}

function result(patch: Partial<SessionResult> = {}): SessionResult {
  return {
    id: 's2', patientId: 'p1', patientName: 'R.K.', startedAt: 1_700_000_000_000, endedAt: 1_700_000_100_000,
    durationSec: 100, mode: 'leg', difficulty: 'medium', windowScale: 1, inputMode: 'camera',
    songId: 'demo-groove', songTitle: 'Demo Groove', artist: 'A', attribution: 'CC BY',
    // the session the reviewer described: 10 % weighted accuracy, one star, 38 movements performed
    score: 400, stars: 1, accuracy: 0.1, starAccuracy: 0.1, maxCombo: 2, totalNotes: 40,
    hits: 4, perfects: 1, goods: 3, misses: 36, reps: 38, answerRate: 0.95,
    timingBiasMs: 20, timingBiasMadMs: 15, latencyOffsetMs: 120, suggestedLatencyMs: null,
    completed: true, lanes: [lane()],
    ...patch,
  };
}

/** Last week's session for the same patient: fewer reps, a smaller range. */
function lastWeek(): SessionResult {
  return result({
    id: 's1',
    startedAt: 1_600_000_000_000,
    endedAt: 1_600_000_090_000,
    durationSec: 90,
    reps: 26,
    lanes: [lane({ reps: 26, romMean: 0.4, romBest: 0.5 })],
  });
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
  });
});
afterEach(cleanup);

describe('the Results screen leads with the work, not with a grade', () => {
  it('puts movements performed and range achieved above the fold, and folds the score away', () => {
    useStore.setState({ lastResult: result(), history: [result()] });
    render(<ResultsScreen />);

    const reps = screen.getByTestId('results-reps');
    expect(reps.textContent).toContain('Movements performed');
    expect(reps.textContent).toContain('38');

    // range is reported in the movement's OWN units, not only as a percentage of today's calibration
    const range = screen.getByTestId('results-range');
    expect(range.textContent).toContain('128°'); // 90 + 0.75 x 50
    expect(range.textContent).toContain('Left Knee extension');

    // the grade still exists for the therapist, but inside the collapsed clinical section
    const clinical = screen.getByTestId('results-clinical');
    expect(clinical.tagName).toBe('DETAILS');
    expect((clinical as HTMLDetailsElement).open).toBe(false);
    expect(clinical.textContent).toContain('400'); // the score
    // ...and nothing outside it is a score, a star count or a bare "weighted accuracy" headline
    const above = document.body.textContent!.replace(clinical.textContent!, '');
    expect(above).not.toContain('weighted accuracy');
    expect(above).not.toContain('Score');
    expect(above.match(/★/g)).toBeNull();
  });

  it('reads this patient’s own history and states today against last time', () => {
    useStore.setState({ lastResult: result(), history: [result(), lastWeek()] });
    render(<ResultsScreen />);

    expect(screen.getByTestId('results-reps-delta').textContent).toBe('+12 vs last time');
    const row = screen.getByTestId('results-today-lane-0');
    expect(row.textContent).toContain('+12 vs last time'); // per movement too
    expect(row.textContent).toContain('120°'); // today's mean, 90 + 0.6 x 50
    expect(row.textContent).toContain('was 110°'); // last week's mean, 90 + 0.4 x 50
    expect(screen.getByTestId('results-sessions').textContent).toContain('2');
  });

  it('never compares across patients, and says so when there is nothing to compare with', () => {
    const other = { ...lastWeek(), id: 'other', patientId: 'p2', patientName: 'Someone else' };
    useStore.setState({ lastResult: result(), history: [result(), other] });
    render(<ResultsScreen />);
    expect(screen.getByTestId('results-reps-delta').textContent).toContain('First recorded session');
    expect(screen.getByTestId('results-today').textContent).toContain('no earlier camera session');
  });

  it('never compares a camera session with a keyboard or autoplay run', () => {
    const bot = { ...lastWeek(), id: 'bot', inputMode: 'autoplay' as const, reps: 400 };
    useStore.setState({ lastResult: result(), history: [result(), bot] });
    render(<ResultsScreen />);
    expect(screen.getByTestId('results-reps-delta').textContent).toContain('First recorded session');
  });

  it('shows what was measured when no range was recorded, instead of a zero', () => {
    const noRom = result({ lanes: [lane({ romSamples: 0, romMean: null, romBest: null })] });
    useStore.setState({ lastResult: noRom, history: [noRom] });
    render(<ResultsScreen />);
    expect(screen.getByTestId('results-range').textContent).toContain('no range was measured');
    expect(screen.getByTestId('results-today-lane-0').textContent).toContain('not measured');
  });
});


/**
 * THE TREMOR SESSION THE REVIEW FAILED THIS SCREEN ON: 189 notes offered, 12 hits, 280 movements
 * made. The old card divided movements by notes, clamped at 1, and rendered "KEPT MOVING / 100% /
 * movements made for 280 of the 189 notes offered" — an impossible sentence, a full green card, and
 * a silent fault toast, for a patient who landed 6 % of their notes.
 */
describe('a session where the patient moved and almost nothing scored', () => {
  const tremor = () =>
    result({
      hits: 12, perfects: 4, goods: 8, misses: 177, totalNotes: 189, reps: 280,
      accuracy: 12 / 189, starAccuracy: 0.05, stars: 1, score: 900,
      answerRate: 60 / 189, surplusMovements: 220,
      lanes: [lane({ hits: 12, misses: 177, judged: 189, accuracy: 12 / 189, reps: 280, attempted: 60, surplus: 220 })],
    });

  it('reports notes answered, bounded by the notes offered — never a green 100 %', () => {
    useStore.setState({ lastResult: tremor(), history: [tremor()] });
    render(<ResultsScreen />);
    const card = screen.getByTestId('results-consistency');
    expect(card.textContent).toContain('Notes answered');
    expect(card.textContent).toContain('32%');
    expect(card.textContent).not.toContain('100%');
    // the impossible sentence is gone: answered is counted against the notes that existed
    expect(card.textContent).toContain('60 of the 189 notes offered');
  });

  it('never prints more notes answered than were offered, even from an inconsistent record', () => {
    // Per-lane and session totals that disagree (a hand-built or half-migrated record) must not be
    // able to reproduce the impossible sentence this card was rebuilt to remove.
    const broken = tremor();
    useStore.setState({
      lastResult: { ...broken, lanes: [...broken.lanes, { ...broken.lanes[0], lane: 1, attempted: 900 }] },
    });
    render(<ResultsScreen />);
    const card = screen.getByTestId('results-consistency');
    expect(card.textContent).toContain('60 of the 189 notes offered');
    expect(card.textContent).not.toContain('960');
  });

  /**
   * THE COUNT AND THE PERCENTAGE MUST BE THE SAME CLAIM. The ≤ judged guard alone still let a
   * hand-built record print "74 %" directly above "a movement was made for 95 of the 97 notes
   * offered" (98 %) — one impossible sentence swapped for two figures that contradict each other.
   */
  it('never prints a count that disagrees with the percentage above it', () => {
    const broken = tremor();
    useStore.setState({
      // lane sum says 185 of 189 (98 %); the stored rate — the figure the headline shows — says 32 %.
      lastResult: { ...broken, lanes: [lane({ hits: 12, misses: 177, judged: 189, reps: 280, attempted: 185, surplus: 95 })] },
    });
    render(<ResultsScreen />);
    const card = screen.getByTestId('results-consistency');
    expect(card.textContent).toContain('32%');
    expect(card.textContent).toContain('60 of the 189 notes offered');
    expect(card.textContent).not.toContain('185 of the 189');
  });

  /**
   * The card used to caption this figure "the gauge on the highway" full stop. The live gauge holds
   * its needle up over the opening notes (ANSWER_WARMUP_NOTES) and the stored record does not, so on
   * a session stopped after a handful of notes — exactly what a struggling patient produces — the two
   * disagree, and the claim of identity was false there.
   */
  it('says how the stored figure differs from the live gauge instead of claiming they are the same', () => {
    useStore.setState({ lastResult: tremor() });
    render(<ResultsScreen />);
    const card = screen.getByTestId('results-consistency');
    expect(card.textContent).toContain('the quantity the gauge on the highway shows');
    expect(screen.getByTestId('results-answer-basis').textContent).toContain('Counted from the first note');
    expect(screen.getByTestId('results-answer-basis').textContent).toMatch(/eases its first \d+ notes/);
  });

  it('reports the movements that answered no note as their own figure, not as success', () => {
    useStore.setState({ lastResult: tremor() });
    render(<ResultsScreen />);
    expect(screen.getByTestId('results-surplus').textContent).toContain('220 further movements answered no note');
  });

  it('calls the fault for what it is — on the ratio, not only when nothing at all scored', () => {
    useStore.setState({ lastResult: tremor() });
    render(<ResultsScreen />);
    const toast = screen.getByTestId('results-fault');
    expect(toast.textContent).toMatch(/calibration or latency fault/);
    expect(toast.parentElement?.textContent).toContain('280 movements');
    expect(toast.parentElement?.textContent).toContain('only 12');
  });

  it('stays quiet for a session that is simply hard, not faulty', () => {
    useStore.setState({ lastResult: result({ hits: 20, misses: 20, reps: 40 }) });
    render(<ResultsScreen />);
    expect(screen.queryByTestId('results-fault')).toBeNull();
  });
});

describe('a rep count is only comparable against the dose that was asked for', () => {
  it('says when the pacing changed between the two sessions', () => {
    const now = result({ reps: 96, laneRestSec: 0.4 });
    const then = lastWeek();
    useStore.setState({ lastResult: now, history: [now, { ...then, laneRestSec: 3 }] });
    render(<ResultsScreen />);
    expect(screen.getByTestId('results-reps-delta').textContent).toContain('+70 vs last time');
    const note = screen.getByTestId('results-pacing-note').textContent ?? '';
    expect(note).toContain('3.0 s');
    expect(note).toContain('0.4 s');
    expect(note).toMatch(/partly the prescription, not the patient/);
  });

  it('says when the pacing of either session was never recorded', () => {
    const now = result({ reps: 60, laneRestSec: 1.2 });
    useStore.setState({ lastResult: now, history: [now, lastWeek()] });
    render(<ResultsScreen />);
    expect(screen.getByTestId('results-pacing-note').textContent).toMatch(/was not recorded/);
  });

  it('says nothing when both sessions were paced the same', () => {
    const now = result({ reps: 60, laneRestSec: 1.2 });
    useStore.setState({ lastResult: now, history: [now, { ...lastWeek(), laneRestSec: 1.2 }] });
    render(<ResultsScreen />);
    expect(screen.queryByTestId('results-pacing-note')).toBeNull();
  });
});

describe('a feature value is never printed without saying what it is a measure of', () => {
  it('names the unit under the range headline', () => {
    useStore.setState({ lastResult: result() });
    render(<ResultsScreen />);
    expect(screen.getByTestId('results-range-unit').textContent).toContain('degrees');

    cleanup();
    const march = result({
      lanes: [lane({ movement: 'seated_march', movementName: 'Left Seated march', calibratedMin: 0.05, calibratedMax: 0.45 })],
    });
    useStore.setState({ lastResult: march });
    render(<ResultsScreen />);
    expect(screen.getByTestId('results-range-unit').textContent).toContain('body-scaled ratio');
  });
});
