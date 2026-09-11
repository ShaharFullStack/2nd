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
    expect(screen.getByTestId('results-answer-basis').textContent).toContain('counted from the first note');
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

/**
 * THE HEADLINE MAY NOT HAND ITSELF TO THE STRONG SIDE.
 *
 * "RANGE ACHIEVED 64°" was `max(romBest)` across every lane. A hemiparetic prescription deliberately
 * mixes the affected limb with an unaffected one, so that maximum is the strong leg essentially every
 * time: the screen celebrated the limb the patient did not come about and put the one they did into a
 * table below the fold.
 */
describe('range achieved is per limb, never a maximum across limbs', () => {
  /** The reviewer's own session: a strong right knee and the weak left march that is the reason. */
  const mixed = () =>
    result({
      lanes: [
        lane({
          lane: 0, movement: 'seated_march', side: 'left', movementName: 'Left Seated march',
          romMean: 0.3, romBest: 0.34, calibratedMin: 0.1, calibratedMax: 0.5, reps: 20,
        }),
        lane({
          lane: 1, movement: 'knee_extension', side: 'right', movementName: 'Right Knee extension',
          romMean: 0.8, romBest: 0.9, calibratedMin: 100, calibratedMax: 160, reps: 22,
        }),
      ],
    });

  it('gives every prescribed movement its own figure, in prescription order', () => {
    useStore.setState({ lastResult: mixed(), history: [mixed()] });
    render(<ResultsScreen />);
    const weak = screen.getByTestId('results-range-lane-0');
    const strong = screen.getByTestId('results-range-lane-1');
    expect(weak.textContent).toContain('Left Seated march');
    expect(weak.textContent).toContain('0.24'); // 0.1 + 0.34 x 0.4
    expect(strong.textContent).toContain('Right Knee extension');
    expect(strong.textContent).toContain('154°'); // 100 + 0.9 x 60

    // The affected side is not below the strong one in the DOM, and no single figure stands for both.
    const tiles = screen.getByTestId('results-range').querySelectorAll('[data-testid^="results-range-lane-"]');
    expect(tiles).toHaveLength(2);
    expect(tiles[0]).toBe(weak);
  });

  it('never prints one lane"s best as THE range for the session', () => {
    useStore.setState({ lastResult: mixed(), history: [mixed()] });
    render(<ResultsScreen />);
    const card = screen.getByTestId('results-range');
    // The old headline: a bare 154° with no movement attached to it.
    expect(card.textContent).toContain('Ranges from different movements are never compared');
    for (const id of ['results-range-lane-0', 'results-range-lane-1']) {
      const tile = screen.getByTestId(id);
      // Every figure names the movement it belongs to, inside the same tile.
      expect(tile.textContent).toMatch(/(Seated march|Knee extension)/);
    }
  });

  it('singles out only the movement that IMPROVED, and ranks the gain against its own range', () => {
    // The weak march gains a fifth of its own range; the strong knee gains a twentieth of its.
    const before = result({
      id: 's1', startedAt: 1_600_000_000_000,
      lanes: [
        lane({ lane: 0, movement: 'seated_march', side: 'left', movementName: 'Left Seated march', romMean: 0.1, romBest: 0.14, calibratedMin: 0.1, calibratedMax: 0.5 }),
        lane({ lane: 1, movement: 'knee_extension', side: 'right', movementName: 'Right Knee extension', romMean: 0.8, romBest: 0.85, calibratedMin: 100, calibratedMax: 160 }),
      ],
    });
    const now = mixed();
    useStore.setState({ lastResult: now, history: [now, before] });
    render(<ResultsScreen />);
    // +0.20 of its own range for the march beats +0.05 for the knee, even though the knee moved 3°
    // and the march moved 0.08 in its own units.
    expect(screen.getByTestId('results-range-most-improved').textContent).toContain('Left Seated march');
    expect(screen.getByTestId('results-range-improved-0')).toBeTruthy();
    expect(screen.queryByTestId('results-range-improved-1')).toBeNull();
  });

  it('says so per movement when a lane measured no range at all', () => {
    const r = result({ lanes: [lane({ lane: 0, romSamples: 0, romMean: null, romBest: null })] });
    useStore.setState({ lastResult: r, history: [r] });
    render(<ResultsScreen />);
    expect(screen.getByTestId('results-range-lane-0').textContent).toContain('no range was measured');
  });
});

/**
 * EVERY CLINICALLY LOAD-BEARING COLUMN HAS TO BE REACHABLE ON THE CLINIC TABLET.
 *
 * Measured at 1024x768, the clinical table laid out at 1302 px inside a 961 px scroller: the
 * compensation badge and the best rep were off the right-hand edge with no scrollbar and no cue.
 */
describe('the wide tables are reachable at 1024', () => {
  it('puts compensation and range in the first half of the clinical table, not the last', () => {
    useStore.setState({ lastResult: result(), history: [result()] });
    render(<ResultsScreen />);
    const heads = Array.from(screen.getByTestId('results-clinical-table').querySelectorAll('th')).map((h) => h.textContent);
    expect(heads).toEqual(['Movement', 'Reps', 'Compensation', 'Range achieved', 'Notes hit', 'Timing']);
    // Nine columns became six: the two the safety reviewer lost are now third and fourth.
    expect(heads.indexOf('Compensation')).toBeLessThan(heads.length / 2);
  });

  it('announces the overflow in words, with buttons that move it, when there really is some', () => {
    useStore.setState({ lastResult: result(), history: [result()] });
    const { container } = render(<ResultsScreen />);
    const wrap = screen.getByTestId('results-clinical-table');
    // jsdom lays nothing out, so the overflow is simulated — the component reads these two numbers.
    Object.defineProperty(wrap, 'scrollWidth', { value: 1302, configurable: true });
    Object.defineProperty(wrap, 'clientWidth', { value: 961, configurable: true });
    // Re-render so the measuring effect runs again against the stubbed layout.
    useStore.setState({ lastResult: result({ maxCombo: 3 }), history: [result()] });
    render(<ResultsScreen />, { container });
    const cue = screen.getAllByTestId('results-clinical-table-scroll-cue')[0];
    expect(cue.textContent).toContain('wider than the screen');
    expect(cue.textContent).toContain('off to the right');
    expect(cue.querySelectorAll('button')).toHaveLength(2);
  });
});
