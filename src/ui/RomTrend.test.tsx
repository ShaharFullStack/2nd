import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { LaneResultSummary, SessionResult } from '../session/types.ts';
import RomTrend from './RomTrend.tsx';

function lane(patch: Partial<LaneResultSummary> = {}): LaneResultSummary {
  return {
    lane: 0, movement: 'knee_extension', side: 'left', label: 'L knee extension',
    hits: 8, perfects: 4, goods: 4, misses: 2, judged: 10, accuracy: 0.8, reps: 12,
    timingBiasMs: null, timingBiasMadMs: null,
    romMean: 0.6, romBest: 0.75, romSamples: 12, romUncertain: 0,
    calibratedMin: 20, calibratedMax: 80, calibrationManual: false,
    compensationKind: null, compensationMonitored: false, compensationFlags: 0, compensationWorst: null,
    ...patch,
  };
}

function session(id: string, at: number, lanes: LaneResultSummary[]): SessionResult {
  return {
    id, startedAt: at, endedAt: at + 1, durationSec: 120,
    mode: 'leg', difficulty: 'medium', windowScale: 1, inputMode: 'camera',
    songId: 's', songTitle: 'S', artist: 'A', attribution: '',
    score: 1, stars: 3, accuracy: 0.8, starAccuracy: 0.8, maxCombo: 1, totalNotes: 10,
    hits: 8, perfects: 4, goods: 4, misses: 2, reps: 12, health: 1,
    timingBiasMs: null, timingBiasMadMs: null, latencyOffsetMs: 120, suggestedLatencyMs: null,
    completed: true, lanes,
  };
}

const IMPROVING = [
  session('c', 3_000_000, [lane({ romMean: 0.72, accuracy: 0.9 })]),
  session('b', 2_000_000, [lane({ romMean: 0.64, accuracy: 0.84 })]),
  session('a', 1_000_000, [lane({ romMean: 0.52, accuracy: 0.7 })]),
];

afterEach(cleanup);

describe('RomTrend', () => {
  it('renders nothing when there is no history to trend', () => {
    render(<RomTrend history={[]} />);
    expect(screen.queryByTestId('rom-trend')).toBeNull();
  });

  it('draws one card per movement, headed by the latest number and the direction', () => {
    render(<RomTrend history={IMPROVING} />);
    const card = screen.getByTestId('trend-knee_extension:left');
    expect(card.textContent).toContain('L knee extension');
    expect(card.textContent).toContain('72%'); // latest ROM
    expect(card.textContent).toContain('+20 pts'); // 0.52 → 0.72
    expect(card.textContent).toContain('3 sessions');
  });

  it('gives each movement and side its own card', () => {
    const history = [session('a', 1, [lane({ side: 'left' }), lane({ side: 'right', label: 'R knee extension' })])];
    render(<RomTrend history={history} />);
    expect(screen.getByTestId('trend-knee_extension:left')).toBeTruthy();
    expect(screen.getByTestId('trend-knee_extension:right')).toBeTruthy();
  });

  it('never draws an unmeasured session as a collapse in range', () => {
    const history = [
      session('b', 2, [lane({ romMean: 0.7 })]),
      session('a', 1, [lane({ romMean: null, romBest: null, romSamples: 0 })]),
    ];
    render(<RomTrend history={history} />);
    const card = screen.getByTestId('trend-knee_extension:left');
    expect(card.textContent).toMatch(/1 of these sessions did not measure range/);
    // The ROM sparkline is one measured point, drawn as a dot rather than a line down to zero.
    const rom = card.querySelector('svg[aria-label*="range of motion"]');
    expect(rom).toBeTruthy();
    expect(rom?.querySelector('polyline')).toBeNull();
  });

  it('says so when no session in the window measured range at all', () => {
    const history = [session('a', 1, [lane({ romMean: null, romBest: null, romSamples: 0 })])];
    render(<RomTrend history={history} />);
    expect(screen.getByTestId('trend-knee_extension:left').textContent).toMatch(/Range was not measured/);
  });

  it('warns when the calibrated range changed, so a falling percentage is not read as decline', () => {
    const history = [
      session('b', 2, [lane({ calibratedMin: 20, calibratedMax: 110, romMean: 0.55 })]),
      session('a', 1, [lane({ calibratedMin: 20, calibratedMax: 80, romMean: 0.6 })]),
    ];
    render(<RomTrend history={history} />);
    expect(screen.getByTestId('trend-knee_extension:left').textContent).toMatch(/calibrated range changed/i);
  });

  it('lets the therapist widen or narrow the window', () => {
    const many = Array.from({ length: 12 }, (_, i) => session(`s${11 - i}`, 12 - i, [lane({ romMean: (11 - i) / 20 })]));
    render(<RomTrend history={many} />);
    expect(screen.getByTestId('trend-knee_extension:left').textContent).toContain('8 sessions');
    fireEvent.click(screen.getByTestId('trend-window-4'));
    expect(screen.getByTestId('trend-knee_extension:left').textContent).toContain('4 sessions');
  });

  it('labels every chart for a screen reader', () => {
    render(<RomTrend history={IMPROVING} />);
    const svgs = screen.getByTestId('trend-knee_extension:left').querySelectorAll('svg');
    expect(svgs.length).toBe(2);
    for (const svg of svgs) expect(svg.getAttribute('aria-label')).toMatch(/L knee extension/);
  });

  it('reports a single session honestly instead of inventing a trend', () => {
    render(<RomTrend history={[session('a', 1, [lane()])]} />);
    const card = screen.getByTestId('trend-knee_extension:left');
    expect(card.textContent).toContain('1 session');
    expect(card.textContent).toContain('no trend yet');
  });
});
