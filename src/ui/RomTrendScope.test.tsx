/**
 * THE HEADER BADGE AND THE CHANGE BADGE MUST DESCRIBE THE SAME SESSIONS.
 *
 * A trend card holds two sets: the sessions it plots, and the two ends every change badge is taken
 * across. The header warning was counted over the first, the chips over the second, and both used the
 * words "measured unevenly" — so a card could print a plain green "▲ +12 pts" four lines under its own
 * warning, with nothing on screen to say the two sentences were about different sessions. A therapist
 * with ninety seconds reads that as a contradiction and discounts one of them.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { LaneResultSummary, SessionResult, TrackingQuality } from '../session/types.ts';
import RomTrend from './RomTrend.tsx';

const PATIENT = 'p-scope';
const CARD = 'trend-knee_extension:left';

function lane(patch: Partial<LaneResultSummary> = {}): LaneResultSummary {
  return {
    lane: 0, movement: 'knee_extension', side: 'left', movementName: 'Left Knee extension',
    hits: 8, perfects: 4, goods: 4, misses: 2, judged: 10, accuracy: 0.8, reps: 12,
    timingBiasMs: null, timingBiasMadMs: null,
    romMean: 0.6, romBest: 0.75, romSamples: 12, romUncertain: 0,
    calibratedMin: 20, calibratedMax: 80, calibrationManual: false,
    compensationKind: null, compensationMonitored: false, compensationFlags: 0, compensationWorst: null,
    ...patch,
  };
}

function tracking(patch: Partial<TrackingQuality> = {}): TrackingQuality {
  return {
    samples: 180, fpsMedian: 30, fpsLow: 28, inferenceMsMedian: 12,
    trackedFraction: 0.99, lowFpsFraction: 0, delegate: 'GPU', worstReason: null,
    ...patch,
  };
}

/** 11.8 fps with the limb usable for 62 % of it — a session graded poor. */
const POOR = tracking({ fpsMedian: 11.8, fpsLow: 8.2, trackedFraction: 0.62, lowFpsFraction: 0.7, worstReason: 'no_landmarks' });

function session(id: string, at: number, rom: number, t: TrackingQuality | undefined): SessionResult {
  return {
    id, patientId: PATIENT, patientName: 'Scope Patient', startedAt: at, endedAt: at + 1, durationSec: 120,
    mode: 'leg', difficulty: 'medium', windowScale: 1, inputMode: 'camera',
    songId: 's', songTitle: 'S', artist: 'A', attribution: '',
    score: 1, stars: 3, accuracy: 0.8, starAccuracy: 0.8, maxCombo: 1, totalNotes: 10,
    hits: 8, perfects: 4, goods: 4, misses: 2, reps: 12, answerRate: 1,
    timingBiasMs: null, timingBiasMadMs: null, latencyOffsetMs: 120, suggestedLatencyMs: null,
    completed: true, lanes: [lane({ romMean: rom, romBest: rom + 0.05 })], tracking: t,
  };
}

const DAY = 86_400_000;

afterEach(cleanup);

describe('the card header and its change badges name the same sessions', () => {
  /**
   * The reported case: the degraded session is IN THE MIDDLE, so the delta's own two ends were both
   * tracked good. Both statements are true; the words must not be.
   */
  it('does not borrow the delta chips’ phrase when the unevenness sits between the ends', () => {
    const history = [
      session('d', 4 * DAY, 0.72, tracking()),
      session('c', 3 * DAY, 0.4, POOR),
      session('b', 2 * DAY, 0.58, tracking()),
      session('a', 1 * DAY, 0.52, tracking()),
    ];
    render(<RomTrend history={history} patientId={PATIENT} />);

    // The header still counts the degraded session it draws…
    const header = screen.getByTestId(`trend-tracking-${CARD.replace('trend-', '')}`);
    expect(header.textContent).toContain('1 of these 4 sessions was measured on a degraded camera stream');
    // …but it does NOT wear the chips' tag, because no chip is wearing it.
    const badge = screen.getByTestId(`trend-tracking-badge-${CARD.replace('trend-', '')}`);
    expect(badge.textContent).toBe('uneven between the ends');
    expect(badge.className).not.toContain('badge-warn');

    // And it names the two sessions the change figures really span, and why they are not qualified.
    const scope = screen.getByTestId(`trend-tracking-scope-${CARD.replace('trend-', '')}`);
    expect(scope.textContent).toMatch(/change figures below are taken across/);
    expect(scope.textContent).toMatch(/BOTH of those were tracked good/);

    // The delta itself stays unqualified — its two ends really were measured alike.
    const delta = screen.getByTestId(`trend-rom-delta-${CARD.replace('trend-', '')}`);
    expect(delta.getAttribute('data-qualified')).toBeNull();
  });

  /** The other half: when the delta really does span the degraded session, the words agree again. */
  it('wears the delta chips’ phrase when a change badge is really carrying it', () => {
    const history = [
      session('c', 3 * DAY, 0.72, POOR),
      session('b', 2 * DAY, 0.58, tracking()),
      session('a', 1 * DAY, 0.52, tracking()),
    ];
    render(<RomTrend history={history} patientId={PATIENT} />);

    const key = CARD.replace('trend-', '');
    const badge = screen.getByTestId(`trend-tracking-badge-${key}`);
    expect(badge.textContent).toBe('measured unevenly');
    expect(badge.className).toContain('badge-warn');
    expect(screen.getByTestId(`trend-tracking-scope-${key}`).textContent).toMatch(/each change badge says so on itself/);

    const delta = screen.getByTestId(`trend-rom-delta-${key}`);
    expect(delta.getAttribute('data-qualified')).toBe('true');
    expect(delta.textContent).toContain('measured unevenly');
  });

  it('a missing tracking block at an end qualifies the delta, and the header says so', () => {
    const history = [
      session('c', 3 * DAY, 0.72, undefined),
      session('b', 2 * DAY, 0.58, tracking()),
      session('a', 1 * DAY, 0.52, tracking()),
    ];
    render(<RomTrend history={history} patientId={PATIENT} />);
    const key = CARD.replace('trend-', '');
    expect(screen.getByTestId(`trend-tracking-${key}`).textContent).toContain('no tracking quality recorded');
    expect(screen.getByTestId(`trend-tracking-badge-${key}`).textContent).toBe('measured unevenly');
    expect(screen.getByTestId(`trend-rom-delta-${key}`).getAttribute('data-qualified')).toBe('true');
  });

  it('says plainly when there is no change figure for the warning to reach', () => {
    const history = [session('a', 1 * DAY, 0.52, POOR)];
    render(<RomTrend history={history} patientId={PATIENT} />);
    const key = CARD.replace('trend-', '');
    expect(screen.getByTestId(`trend-tracking-scope-${key}`).textContent).toMatch(/no change figure on this card/);
  });

  it('says nothing at all when every session on the card was measured alike', () => {
    const history = [
      session('c', 3 * DAY, 0.72, tracking()),
      session('b', 2 * DAY, 0.58, tracking()),
      session('a', 1 * DAY, 0.52, tracking()),
    ];
    render(<RomTrend history={history} patientId={PATIENT} />);
    expect(screen.queryByTestId(`trend-tracking-${CARD.replace('trend-', '')}`)).toBeNull();
  });
});
