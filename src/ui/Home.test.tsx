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

describe('the last-session card', () => {
  it('leads with movements performed and the range reached, never with a score or stars', () => {
    render(<Home />);
    const card = screen.getByText(/Last session/).parentElement as HTMLElement;
    expect(card.textContent).toContain('Movements performed');
    expect(card.textContent).toContain('271');
    expect(card.textContent).toContain('Best range');
    expect(card.textContent).toContain('60°'); // 20 + 0.8 × (70 − 20)
    // The grade is not on the screen the patient reads before they start.
    expect(card.textContent).not.toContain('4,200');
    expect(card.querySelector('.stars')).toBeNull();
    expect(card.textContent).not.toContain('accuracy');
  });

  it('states the pacing the session was given, so two rep counts are read against their doses', () => {
    render(<Home />);
    expect((screen.getByText(/Last session/).parentElement as HTMLElement).textContent).toContain('paced at 1.2 s');
  });
});
