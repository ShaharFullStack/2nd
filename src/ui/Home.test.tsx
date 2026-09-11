/**
 * The screen the patient sits in front of BEFORE every session.
 *
 * The grade was taken off the Results screen because a report card on an impairment is not a rehab
 * result — and it survived one screen earlier, with the patient's own name above it: "Last session —
 * A.H. (R hemiparesis)" led with one filled star of five and a four-figure score. `starsForAccuracy`
 * floors at 1, so a session where nothing landed still showed a star: a participation mark presented
 * as a score. This pins the card to the work instead.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { SessionResult } from '../session/types.ts';
import { DEFAULT_SETTINGS, defaultLanes, useStore } from '../state/store.ts';

vi.mock('../session/runtime.ts', () => ({ runtime: { ensureAudio: () => Promise.resolve(null) } }));

const { default: Home } = await import('./Home.tsx');

function lastSession(patch: Partial<SessionResult> = {}): SessionResult {
  return {
    id: 's1', patientId: 'p1', patientName: 'A.H.', startedAt: 1_700_000_000_000, endedAt: 1_700_000_100_000,
    durationSec: 240, mode: 'leg', difficulty: 'medium', windowScale: 1, inputMode: 'camera',
    songId: 'demo-groove', songTitle: 'Demo Groove', artist: 'A', attribution: 'CC BY',
    score: 4200, stars: 1, accuracy: 0.1, starAccuracy: 0.1, maxCombo: 3, totalNotes: 189,
    hits: 12, perfects: 4, goods: 8, misses: 177, reps: 271, answerRate: 0.32, laneRestSec: 1.2,
    timingBiasMs: 20, timingBiasMadMs: 15, latencyOffsetMs: 120, suggestedLatencyMs: null,
    completed: true,
    lanes: [
      {
        lane: 0, movement: 'knee_extension', side: 'left', movementName: 'Left Knee extension',
        hits: 12, perfects: 4, goods: 8, misses: 177, judged: 189, accuracy: 0.06, reps: 271,
        timingBiasMs: 20, timingBiasMadMs: 15, romMean: 0.6, romBest: 0.8, romSamples: 271, romUncertain: 0,
        calibratedMin: 20, calibratedMax: 70, calibrationManual: false,
        compensationKind: null, compensationMonitored: false, compensationFlags: 0, compensationWorst: null,
      },
    ],
    ...patch,
  };
}

beforeEach(() => {
  localStorage.clear();
  useStore.setState({
    screen: 'home',
    mode: 'leg',
    lanes: defaultLanes('leg'),
    settings: { ...DEFAULT_SETTINGS },
    inputMode: 'camera',
    patients: [{ id: 'p1', name: 'A.H.', createdAt: 1, lastUsedAt: 2 }],
    activePatientId: 'p1',
    history: [lastSession()],
  });
});
afterEach(cleanup);

/** A hemiparetic prescription: the affected left seated march beside an unaffected right knee. */
function mixedPrescription(): SessionResult {
  return lastSession({
    reps: 84,
    lanes: [
      {
        lane: 0, movement: 'seated_march', side: 'left', movementName: 'Left Seated march',
        hits: 4, perfects: 1, goods: 3, misses: 41, judged: 45, accuracy: 0.09, reps: 45,
        timingBiasMs: 20, timingBiasMadMs: 15, romMean: 0.6, romBest: 0.67, romSamples: 45, romUncertain: 0,
        calibratedMin: 0.1, calibratedMax: 0.42, calibrationManual: false,
        compensationKind: null, compensationMonitored: false, compensationFlags: 0, compensationWorst: null,
      },
      {
        lane: 1, movement: 'knee_extension', side: 'right', movementName: 'Right Knee extension',
        hits: 30, perfects: 20, goods: 10, misses: 9, judged: 39, accuracy: 0.77, reps: 39,
        timingBiasMs: 12, timingBiasMadMs: 9, romMean: 0.85, romBest: 0.91, romSamples: 39, romUncertain: 0,
        calibratedMin: 8, calibratedMax: 70, calibrationManual: false,
        compensationKind: null, compensationMonitored: false, compensationFlags: 0, compensationWorst: null,
      },
    ],
  });
}

describe('the last-session card', () => {
  it('leads with movements performed and the range reached, never with a score or stars', () => {
    render(<Home />);
    const card = screen.getByText(/Last session/).parentElement as HTMLElement;
    expect(card.textContent).toContain('Movements performed');
    expect(card.textContent).toContain('271');
    expect(card.textContent).toContain('Left Knee extension');
    expect(card.textContent).toContain('60°'); // 20 + 0.8 × (70 − 20)
    // The grade is not on the screen the patient reads before they start.
    expect(card.textContent).not.toContain('4,200');
    expect(card.querySelector('.stars')).toBeNull();
    expect(card.textContent).not.toContain('accuracy');
  });

  /**
   * THE DEFECT RESULTS WAS REBUILT TO REMOVE, ONE SCREEN EARLIER.
   *
   * This card printed `max(romBest)` over every lane as an unlabelled "Best range". A hemiparetic
   * prescription mixes the affected limb with an unaffected one on purpose, so the maximum is the
   * strong side by construction: with the affected left seated march at 67 % of its own range and
   * the unaffected right knee at 91 % of its own, the card read "Best range 65°" — the right knee,
   * with no movement name anywhere near it, on the screen the patient reads before every session.
   */
  it('never lets the strong side stand in for the weak one: every movement is named beside its own figure', () => {
    useStore.setState({ history: [mixedPrescription()] });
    render(<Home />);
    const card = screen.getByTestId('home-last-ranges');
    // Both movements are present, each named, in prescription order.
    const march = screen.getByTestId('home-last-range-0').textContent ?? '';
    const knee = screen.getByTestId('home-last-range-1').textContent ?? '';
    expect(march).toContain('Left Seated march');
    expect(march).toContain('0.31'); // 0.10 + 0.67 × 0.32
    expect(march).toContain('67%');
    expect(knee).toContain('Right Knee extension');
    expect(knee).toContain('64°'); // 8 + 0.91 × 62
    expect(knee).toContain('91%');
    // There is no single unlabelled headline figure left to mistake for "the patient's range".
    expect(card.textContent).not.toContain('Best range');
    expect(card.textContent).toContain('Different movements are never compared with each other.');
  });

  it('says so plainly when a session measured no range at all', () => {
    const none = mixedPrescription();
    useStore.setState({
      history: [{ ...none, lanes: none.lanes.map((l) => ({ ...l, romSamples: 0, romBest: null, romMean: null })) }],
    });
    render(<Home />);
    expect(screen.getByTestId('home-last-ranges').textContent).toContain('No range was measured in that session.');
  });

  it('states the pacing the session was given, so two rep counts are read against their doses', () => {
    render(<Home />);
    expect((screen.getByText(/Last session/).parentElement as HTMLElement).textContent).toContain('paced at 1.2 s');
  });
});
