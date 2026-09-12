import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { LaneResultSummary, SessionResult, TrackingQuality } from '../session/types.ts';
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

/**
 * A clean stream, unless a test says otherwise. Both fixtures carry one so the DEFAULT case on this
 * screen is a like-for-like comparison — which is what the green chips below are asserting about.
 */
function tracking(patch: Partial<TrackingQuality> = {}): TrackingQuality {
  return {
    samples: 190, fpsMedian: 29.5, fpsLow: 27, inferenceMsMedian: 11.5,
    trackedFraction: 0.99, lowFpsFraction: 0, delegate: 'GPU', worstReason: null,
    ...patch,
  };
}

/** The same stream at 11.8 fps with the limb usable for 62 % of the session. */
function poorTracking(): TrackingQuality {
  return tracking({ fpsMedian: 11.8, fpsLow: 8.2, trackedFraction: 0.62, lowFpsFraction: 0.71, worstReason: 'no_landmarks' });
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
    completed: true, lanes: [lane()], tracking: tracking(),
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
    lastSave: null,
    persistenceFailed: false,
    patients: [{ id: 'p1', name: 'R.K.', createdAt: 1, lastUsedAt: 1 }],
    activePatientId: 'p1',
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

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
/**
 * ONE NUMBER, ONE VERDICT.
 *
 * The ranking behind "biggest gain today" accepted any positive change while the badge beside it
 * printed "same as last time" for anything under both the movement's unit resolution and half a
 * point of range. A knee that moved 0.15° rendered both, one under the other, and the card header
 * named that limb as the day's achievement — on a mixed prescription, the unaffected one.
 */
describe('the range card never celebrates a change it has called unmeasurable', () => {
  /** Both sessions tracked cleanly, so the comparability chip has nothing to add to the verdict. */
  const GOOD = {
    samples: 200, fpsMedian: 30, fpsLow: 27, inferenceMsMedian: 18, trackedFraction: 0.98,
    lowFpsFraction: 0, delegate: 'GPU' as const, worstReason: null,
  };
  const knee = lane({ lane: 0, movement: 'knee_extension', side: 'right', movementName: 'Right Knee extension', romBest: 0.75, calibratedMin: 90, calibratedMax: 140 });
  const march = lane({ lane: 1, movement: 'seated_march', side: 'left', movementName: 'Left Seated march', romBest: 0.4, romMean: 0.3, calibratedMin: 0.1, calibratedMax: 0.5 });
  const today = result({ lanes: [knee, march], tracking: GOOD });
  // +0.15° on a 50° range: under a degree AND under half a point of its own range. The march is flat.
  const before = result({ id: 's1', startedAt: 1_600_000_000_000, tracking: GOOD, lanes: [{ ...knee, romBest: 0.75 - 0.15 / 50 }, march] });

  it('says "same as last time" without also saying "biggest gain today"', () => {
    useStore.setState({ lastResult: today, history: [today, before] });
    render(<ResultsScreen />);
    expect(screen.getByTestId('results-range-gain-0').textContent).toBe('same as last time');
    expect(screen.queryByTestId('results-range-improved-0')).toBeNull();
    expect(screen.queryByTestId('results-range-improved-1')).toBeNull();
    expect(screen.queryByTestId('results-range-most-improved')).toBeNull();
  });

  it('does not paint "same as last time" as a gain', () => {
    useStore.setState({ lastResult: today, history: [today, before] });
    render(<ResultsScreen />);
    expect(screen.getByTestId('results-range-gain-0').className).not.toContain('badge-ok');
  });

  it('still names a real gain, and paints that one', () => {
    // +5° is well over both floors.
    const wasWorse = result({ id: 's1', startedAt: 1_600_000_000_000, tracking: GOOD, lanes: [{ ...knee, romBest: 0.65 }, march] });
    useStore.setState({ lastResult: today, history: [today, wasWorse] });
    render(<ResultsScreen />);
    expect(screen.getByTestId('results-range-gain-0').textContent).toContain('+5°');
    expect(screen.getByTestId('results-range-gain-0').className).toContain('badge-ok');
    expect(screen.getByTestId('results-range-improved-0')).toBeTruthy();
    expect(screen.getByTestId('results-range-most-improved').textContent).toContain('Right Knee extension');
  });
});

describe('the wide tables are reachable at 1024', () => {
  it('puts compensation and range in the first half of the clinical table, not the last', () => {
    useStore.setState({ lastResult: result(), history: [result()] });
    render(<ResultsScreen />);
    const heads = Array.from(screen.getByTestId('results-clinical-table').querySelectorAll('th')).map((h) => h.textContent);
    expect(heads).toEqual(['Movement', 'Reps', 'Compensation', 'Range achieved', 'Notes hit', 'Timing']);
    // Nine columns became six: the two the safety reviewer lost are now third and fourth.
    expect(heads.indexOf('Compensation')).toBeLessThan(heads.length / 2);
  });

  /**
   * THE CUE MAY NOT NAME A COLUMN THE THERAPIST IS LOOKING STRAIGHT AT.
   *
   * The names used to be a hard-coded string handed in by the caller, so the trend table — measured
   * at 548 px inside a 506 px scroller with only "Accuracy" cut — told the reader that "the peak and
   * accuracy columns are off to the right". Over-stating loses no data, but on a project whose rule
   * is that a caption may not promise what the renderer does not draw, a cue that names columns it
   * has not measured is the same class of bug. jsdom lays nothing out, so the layout is stubbed and
   * the component is asked what it says about it.
   */
  it('names only the columns it measured as off screen, never the ones on it', () => {
    useStore.setState({ lastResult: result(), history: [result()] });
    const { container } = render(<ResultsScreen />);
    const wrap = screen.getByTestId('results-clinical-table');
    Object.defineProperty(wrap, 'scrollWidth', { value: 1302, configurable: true });
    Object.defineProperty(wrap, 'clientWidth', { value: 961, configurable: true });
    // The scroller spans 0..961; the last two header cells start past its right edge.
    wrap.getBoundingClientRect = () => ({ left: 0, right: 961, top: 0, bottom: 40, width: 961, height: 40, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    const heads = Array.from(wrap.querySelectorAll('th'));
    const edges = [0, 200, 380, 560, 980, 1160, 1302];
    heads.forEach((th, i) => {
      th.getBoundingClientRect = () => ({
        left: edges[i], right: edges[i + 1], top: 0, bottom: 40, width: edges[i + 1] - edges[i], height: 40,
        x: edges[i], y: 0, toJSON: () => ({}),
      }) as DOMRect;
    });
    useStore.setState({ lastResult: result({ maxCombo: 3 }), history: [result()] });
    render(<ResultsScreen />, { container });
    const cue = screen.getAllByTestId('results-clinical-table-scroll-cue')[0].textContent ?? '';
    expect(cue).toContain('Notes hit');
    expect(cue).toContain('Timing');
    // Everything that fits is NOT named.
    for (const on of ['Movement', 'Reps', 'Compensation', 'Range achieved']) expect(cue).not.toContain(`${on} column`);
    expect(cue).not.toContain('Compensation');
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

/**
 * TODAY AGAINST LAST TIME IS A COMPARISON OF TWO CAMERA STREAMS AS MUCH AS OF TWO PATIENTS' DAYS.
 *
 * "+0.02 vs last time" and "biggest gain today" in green, on a session this app graded poor, against
 * one it graded good, is the equipment presented as the patient — and a grey sentence lower down the
 * card does not undo a green chip.
 */
describe('a gain is not a gain when the two sessions were not measured alike', () => {
  const poorToday = () => result({ tracking: poorTracking(), lanes: [lane({ romBest: 0.9, romMean: 0.8 })] });

  it('strips the green from the gain chip and says why inside it', () => {
    useStore.setState({ lastResult: poorToday(), history: [poorToday(), lastWeek()] });
    render(<ResultsScreen />);
    const gain = screen.getByTestId('results-range-gain-0');
    expect(gain.textContent).toContain('vs last time');
    expect(gain.className).not.toContain('badge-ok');
    expect(gain.getAttribute('data-qualified')).toBe('true');
    expect(gain.textContent).toContain('measured unevenly');
  });

  it('will not hand "biggest gain today" to a session it cannot compare', () => {
    useStore.setState({ lastResult: poorToday(), history: [poorToday(), lastWeek()] });
    render(<ResultsScreen />);
    const badge = screen.getByTestId('results-range-improved-0');
    expect(badge.className).not.toContain('badge-ok');
    expect(badge.textContent).toContain('biggest change today');
    // …and the headline carries the same short tag the chips do, rather than a phrase of its own:
    // a therapist reading the badge and a therapist reading the line must be told the same thing.
    expect(screen.getByTestId('results-range-most-improved').textContent).toContain('Biggest change');
    expect(screen.getByTestId('results-range-most-improved').textContent).toContain('measured unevenly');
  });

  it('states the conditions of BOTH sessions beside the chips', () => {
    useStore.setState({ lastResult: poorToday(), history: [poorToday(), lastWeek()] });
    render(<ResultsScreen />);
    const note = screen.getByTestId('results-comparison-note');
    expect(note.textContent).toContain('tracked good');
    expect(note.textContent).toContain('poor');
    expect(note.textContent).toContain('camera rather than the patient');
  });

  it('qualifies the rep delta too — a lost limb is a lost rep', () => {
    useStore.setState({ lastResult: poorToday(), history: [poorToday(), lastWeek()] });
    render(<ResultsScreen />);
    expect(screen.getByTestId('results-reps-delta').textContent).toContain('vs last time');
    expect(screen.getByTestId('results-reps-delta-qualifier').textContent).toContain('measured unevenly');
  });

  it('treats a previous session with no tracking block as unknown, not as clean', () => {
    const old = { ...lastWeek(), tracking: undefined };
    useStore.setState({ lastResult: result(), history: [result(), old] });
    render(<ResultsScreen />);
    expect(screen.getByTestId('results-comparison-note').textContent).toContain('no tracking quality recorded');
    expect(screen.getByTestId('results-range-gain-0').className).not.toContain('badge-ok');
  });

  it('says nothing at all when both sessions were tracked well', () => {
    useStore.setState({ lastResult: result(), history: [result(), lastWeek()] });
    render(<ResultsScreen />);
    expect(screen.queryByTestId('results-comparison-note')).toBeNull();
    expect(screen.queryByTestId('results-reps-delta-qualifier')).toBeNull();
  });
});

/**
 * THE COMPARISON HAS TO SAY WHAT IT IS A COMPARISON AGAINST.
 *
 * Seeded live before this was fixed: patient Amara, previous session a 24-second walk-out with 19
 * movements. Results printed "Movements performed 98 · +79 vs last time", "+30 vs last time" per
 * movement and "Biggest gain since last session: Left Seated march", and a regex over the whole
 * rendered page for /ended early|stopped by|incomplete|did not finish/ matched NOTHING. One screen
 * later the ROM trend sets exactly those runs aside from every figure, and History labels the row
 * "stopped on purpose". Two screens, two rules, and the one a therapist reads first flattered.
 */
describe('today is compared against a whole session, and the screen says which one', () => {
  /** The walk-out: 24 seconds, 19 movements, stopped by the therapist. */
  const walkOut = () =>
    result({
      id: 'abort',
      startedAt: 1_650_000_000_000,
      endedAt: 1_650_000_024_000,
      durationSec: 24,
      reps: 19,
      completed: false,
      endReason: 'quit',
      lanes: [lane({ reps: 19, romMean: 0.35, romBest: 0.4 })],
    });

  it('skips a walk-out in favour of the last COMPLETED session, and names the one it kept', () => {
    useStore.setState({ lastResult: result(), history: [result(), walkOut(), lastWeek()] });
    render(<ResultsScreen />);

    // the delta is against last week's 26 reps, not against the walk-out's 19
    expect(screen.getByTestId('results-reps-delta').textContent).toContain('+12 vs last time');
    expect(screen.getByTestId('results-today-lane-0').textContent).toContain('+12 vs last time');

    const basis = screen.getByTestId('results-comparison-basis');
    expect(basis.textContent).toContain('the last session this patient completed');
    expect(basis.textContent).toContain('stopped on purpose');
    expect(basis.textContent).toContain('19 movements');
    // and the card the rows sit in says it too, beside the deltas themselves
    expect(screen.getByTestId('results-today').textContent).toContain('COMPLETED camera session');
  });

  it('never lets a walk-out silently stand in for last time', () => {
    useStore.setState({ lastResult: result(), history: [result(), walkOut(), lastWeek()] });
    render(<ResultsScreen />);
    // the exact regex the critic ran over the rendered page
    expect(document.body.textContent!).toMatch(/ended early|stopped by|incomplete|did not finish/);
  });

  it('still compares when every earlier session ended early — but not in green, and not silently', () => {
    useStore.setState({ lastResult: result(), history: [result(), walkOut()] });
    render(<ResultsScreen />);

    const delta = screen.getByTestId('results-reps-delta');
    expect(delta.textContent).toContain('+19 vs last time');
    expect(screen.getByTestId('results-reps-delta-qualifier').textContent).toContain('last session ended early');

    const gain = screen.getByTestId('results-range-gain-0');
    expect(gain.className).not.toContain('badge-ok');
    expect(gain.getAttribute('data-qualified')).toBe('true');
    expect(gain.textContent).toContain('last session ended early');

    expect(screen.getByTestId('results-range-improved-0').textContent).toContain('biggest change today');
    expect(screen.getByTestId('results-comparison-basis').textContent).toContain('did not reach the end of its chart');
    // the card that names the session compared with says what kind of session it was
    expect(screen.getByTestId('results-sessions').textContent).toContain('ended early');
  });

  it('says nothing about completeness when the previous session simply is the last one', () => {
    useStore.setState({ lastResult: result(), history: [result(), lastWeek()] });
    render(<ResultsScreen />);
    expect(screen.queryByTestId('results-comparison-basis')).toBeNull();
    expect(screen.queryByTestId('results-today-basis')).toBeNull();
    expect(screen.getByTestId('results-reps-delta').textContent).toBe('+12 vs last time');
  });

  /**
   * A STORED KEY THAT CHANGED MEANING. `reps` used to be the engine's event count and is now the sum
   * of the per-lane column; the two differ by construction on spasticity, clonus and tremor. Records
   * written under the old rule cannot be told apart by a version — but on exactly the records where
   * the definitions disagree, the record's own headline disagrees with its own column, and that is
   * the case the delta must not present as patient change.
   */
  it('flags a delta drawn across two definitions of "a movement"', () => {
    const oldRecord = { ...lastWeek(), reps: 20, lanes: [lane({ reps: 26, romMean: 0.4, romBest: 0.5 })] };
    useStore.setState({ lastResult: result(), history: [result(), oldRecord] });
    render(<ResultsScreen />);
    const tag = screen.getByTestId('results-reps-delta-qualifier');
    expect(tag.textContent).toContain('counted differently');
    expect(tag.getAttribute('title')).toContain('26');
  });
});


/**
 * THE BADGE THAT CLAIMS THE RECORD EXISTS HAS TO READ THE WRITE.
 *
 * It was a constant: a green "Saved to history" span in the markup, drawn whether or not
 * `localStorage` took the write. Refuse the write — a full quota is realistic on a shared clinic
 * tablet, where the 100-session cap is PER PATIENT — and the screen still said saved over a record
 * that existed nowhere but in this tab's memory. A therapist who walks away believing a record
 * exists when it does not is the worst failure this app has.
 */
describe('the Results screen says what really happened to the record', () => {
  const refuseStorage = (): void => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('quota', 'QuotaExceededError');
    });
  };

  /** Record a session through the real write path, so the badge is reading a real verdict. */
  const recordSession = (r: SessionResult = result()): void => {
    useStore.getState().addResult(r);
  };

  it('claims the save only when the write landed', () => {
    recordSession();
    render(<ResultsScreen />);
    expect(screen.getByTestId('results-save-state').textContent).toContain('Saved to history');
    expect(screen.queryByTestId('results-save-problem')).toBeNull();
    expect(screen.queryByTestId('results-save-retry')).toBeNull();
  });

  it('says the session is NOT on the device when the quota refuses it', () => {
    refuseStorage();
    recordSession();
    render(<ResultsScreen />);
    const badge = screen.getByTestId('results-save-state');
    expect(badge.textContent).toContain('NOT saved');
    expect(badge.className).toContain('badge-bad');
    expect(badge.textContent).not.toContain('Saved to history');
    // ...and it says what a therapist can DO about it, on the screen that makes the claim.
    expect(screen.getByTestId('results-save-problem')).toBeTruthy();
    expect(screen.getByTestId('results-save-retry')).toBeTruthy();
    expect(screen.getByTestId('results-save-export')).toBeTruthy();
    expect(screen.getByTestId('results-save-free-space')).toBeTruthy();
    // The card explains that leaving the screen loses the work, and how to free space.
    expect(screen.getByTestId('results-save').textContent).toContain('only copy of this session');
    expect(screen.getByTestId('results-save').textContent).toContain('100 sessions per patient');
  });

  it('flips to saved when the retry lands, and says how many tries it took', () => {
    refuseStorage();
    recordSession();
    render(<ResultsScreen />);
    expect(screen.getByTestId('results-save-state').textContent).toContain('NOT saved');

    vi.restoreAllMocks();
    fireEvent.click(screen.getByTestId('results-save-retry'));
    expect(screen.getByTestId('results-save-state').textContent).toContain('Saved to history');
    expect(screen.getByTestId('results-save-state').textContent).toContain('attempt 2');
    expect(screen.getByTestId('results-save-note').textContent).toContain('now in this patient');
  });

  it('says so, and does not claim a save, when a retry is refused again', () => {
    refuseStorage();
    recordSession();
    render(<ResultsScreen />);
    fireEvent.click(screen.getByTestId('results-save-retry'));
    expect(screen.getByTestId('results-save-state').textContent).toContain('NOT saved');
    expect(screen.getByTestId('results-save-note').textContent).toContain('Still refused');
  });

  it('hands the therapist the session as a file when the device will not keep it', () => {
    refuseStorage();
    recordSession();
    render(<ResultsScreen />);
    // jsdom has no real download; the button must not throw and must report the outcome either way.
    fireEvent.click(screen.getByTestId('results-save-export'));
    expect(screen.getByTestId('results-save')).toBeTruthy();
  });

  it('never borrows another session’s verdict: an unstamped record reads as unknown', () => {
    // A record that did not come through this tab's write path (reloaded, re-filed, or set by a
    // harness) has no verdict, and "unknown" is the only honest badge for it.
    useStore.setState({ lastResult: result(), history: [result()], lastSave: null });
    render(<ResultsScreen />);
    expect(screen.getByTestId('results-save-state').textContent).toContain('unknown');
    expect(screen.getByTestId('results-save-state').textContent).not.toContain('Saved to history');
    expect(screen.getByTestId('results-save-export')).toBeTruthy();
  });
});

/**
 * "TODAY, MOVEMENT BY MOVEMENT" IS A CROSS-SESSION COMPARISON LIKE EVERY OTHER ONE ON THIS SCREEN.
 *
 * Every cell in it subtracts two sessions, and it used to carry nothing about how those two were
 * measured or whether the earlier one ran to the end of its chart — while the range tiles two cards
 * up had lost their green for exactly that reason.
 */
describe('the per-movement card carries the same qualifiers as the rest of the screen', () => {
  it('is unqualified when the two sessions really are like for like', () => {
    useStore.setState({ lastResult: result(), history: [result(), lastWeek()] });
    render(<ResultsScreen />);
    expect(screen.queryByTestId('results-today-qualifier')).toBeNull();
    expect(screen.queryByTestId('results-today-comparison-note')).toBeNull();
    expect(screen.getByTestId('results-today-lane-0').textContent).toContain('+12 vs last time');
  });

  it('qualifies the header and every delta when the two were not tracked alike', () => {
    useStore.setState({ lastResult: result(), history: [result(), { ...lastWeek(), tracking: poorTracking() }] });
    render(<ResultsScreen />);
    expect(screen.getByTestId('results-today-qualifier').textContent).toBeTruthy();
    // The reps delta and the range delta in the rows carry it too — a therapist reading the table
    // need not have read the card header, and must not read "+12" as a clean finding.
    const row = screen.getByTestId('results-today-lane-0');
    expect(row.textContent).toContain('+12 vs last time ·');
    expect(row.querySelectorAll('.delta-qualified').length).toBeGreaterThan(0);
    // ...and the sentence that explains it sits under the rows it qualifies.
    expect(screen.getByTestId('results-today-comparison-note').textContent).toMatch(/camera|tracked|equipment/i);
  });

  it('qualifies it when last time ended early, not only when the camera was poor', () => {
    const aborted = { ...lastWeek(), completed: false, endReason: 'quit' as const, durationSec: 24, reps: 19 };
    useStore.setState({ lastResult: result(), history: [result(), aborted] });
    render(<ResultsScreen />);
    expect(screen.getByTestId('results-today-qualifier').textContent).toContain('ended early');
  });
});

/**
 * THE SUB-RESOLUTION CAPTION MAY NOT OVERSTATE THE BOUND. It printed "the change is under 1.00" for a
 * body-scaled ratio — a hundred times the step this screen prints in, and a whole unit of a quantity
 * whose entire calibrated range is routinely under 1.0.
 */
describe('a change too small for the movement’s own units states the true bound', () => {
  /** A seated march (ratio unit) whose best rep moved by well under 0.005 of the feature. */
  const ratioPair = () => {
    const today = lane({ movement: 'seated_march', movementName: 'Left Seated march', romBest: 0.61, romMean: 0.5, calibratedMin: 0.1, calibratedMax: 0.5 });
    // 0.01 of the calibrated range is 0.004 of the feature: over the half-point floor, under the
    // 0.01 this screen prints a body-scaled ratio to — the exact case the caption exists for.
    const then = { ...today, romBest: 0.6 };
    return {
      today: result({ lanes: [today] }),
      then: { ...lastWeek(), lanes: [then] },
    };
  };

  it('states 0.005 for a ratio, never 1.00', () => {
    const { today, then } = ratioPair();
    useStore.setState({ lastResult: today, history: [today, then] });
    render(<ResultsScreen />);
    const tile = screen.getByTestId('results-range-lane-0');
    expect(tile.textContent).toContain('pt vs last time');
    expect(tile.textContent).toContain('under 0.005');
    expect(tile.textContent).not.toContain('under 1.00');
  });

  it('states half a degree for a joint angle, never a whole one', () => {
    // 0.3° on a 50° range: under the degree the screen prints to, over the half-point floor.
    const today = result();
    const then = { ...lastWeek(), lanes: [lane({ romBest: 0.75 - 0.3 / 50 })] };
    useStore.setState({ lastResult: today, history: [today, then] });
    render(<ResultsScreen />);
    const tile = screen.getByTestId('results-range-lane-0');
    expect(tile.textContent).toContain('under 0.5°');
    expect(tile.textContent).not.toContain('under 1°');
  });
});

describe('the last screen of the session does not promise a door it cannot open', () => {
  /** The camera session a patient drove from the chair: the state that puts targets on this screen. */
  function handsFreeResults(): void {
    useStore.setState({ lastResult: result(), history: [result()], handsFree: true });
    render(<ResultsScreen />);
  }

  it('keeps "New session" on the therapist\u2019s button, where it is true', () => {
    handsFreeResults();
    // The rings themselves are only drawn over live camera frames, which a test environment has
    // none of — what they are labelled is asserted in the running app
    // (critic/handsfree-dead-ends.mjs reads the caption off `results-dwell-new`).
    expect(screen.getByRole('button', { name: 'New session' })).toBeTruthy();
    expect(screen.getByTestId('results-handsfree')).toBeTruthy();
  });

  it('says what holding it does — the camera goes off and the tablet goes back', () => {
    handsFreeResults();
    const note = screen.getByTestId('results-handback-note').textContent ?? '';
    expect(note).toMatch(/ends the patient.s own part of the visit/i);
    expect(note).toMatch(/camera is turned off/i);
    expect(note).toMatch(/does not start one/i);
  });

  it('the screen it hands to says the hands-free flow stops there', async () => {
    // The other half of the same promise: `goto('mode')` lands on a screen with no camera and no
    // targets, which is a dead end only while it does not admit to being one.
    const { default: ModeSelect } = await import('./ModeSelect.tsx');
    useStore.setState({ screen: 'mode' });
    cleanup();
    render(<ModeSelect />);
    const note = screen.getByTestId('mode-handsfree-note').textContent ?? '';
    expect(note).toMatch(/This step needs a hand/i);
    expect(note).toMatch(/camera is off/i);
    expect(note).toMatch(/takes over again at the camera check/i);
  });
});
