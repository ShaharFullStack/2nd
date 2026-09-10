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
    expect(card.textContent).toContain('3 camera sessions');
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
    expect(screen.getByTestId('trend-knee_extension:left').textContent).toContain('8 camera sessions');
    fireEvent.click(screen.getByTestId('trend-window-4'));
    expect(screen.getByTestId('trend-knee_extension:left').textContent).toContain('4 camera sessions');
  });

  it('labels every chart for a screen reader', () => {
    render(<RomTrend history={IMPROVING} />);
    const svgs = screen.getByTestId('trend-knee_extension:left').querySelectorAll('svg');
    expect(svgs.length).toBe(2);
    for (const svg of svgs) expect(svg.getAttribute('aria-label')).toMatch(/L knee extension/);
  });

  it('never shows a bot or keyboard run as the patient improving', () => {
    // The failure this guards: two autoplay runs rendered as "L knee lift — ACCURACY 100%, +14 pts,
    // 7 movements performed". The bot's keypresses were being read as the patient's progress.
    const history = [
      { ...session('bot', 4, [lane({ accuracy: 1, reps: 7, romMean: null, romSamples: 0 })]), inputMode: 'autoplay' as const },
      session('cam2', 3, [lane({ romMean: 0.72, accuracy: 0.7, reps: 10 })]),
      session('cam1', 2, [lane({ romMean: 0.6, accuracy: 0.66, reps: 10 })]),
    ];
    render(<RomTrend history={history} />);
    const card = screen.getByTestId('trend-knee_extension:left');
    expect(card.textContent).toContain('2 camera sessions');
    expect(card.textContent).toContain('70%'); // the patient's accuracy, not the bot's 100 %
    expect(card.textContent).not.toContain('100%');
    expect(card.textContent).toContain('20 movements performed'); // 10 + 10, not 27
    // ... and the exclusion is stated, not silent.
    expect(screen.getByTestId('trend-excluded-knee_extension:left').textContent).toMatch(/1 autoplay session/i);
    expect(screen.getByTestId('trend-coverage').textContent).toMatch(/excluded from every figure/i);
  });

  it('offers no trend at all when every stored session was driven by keys', () => {
    const history = [{ ...session('kb', 1, [lane()]), inputMode: 'keyboard' as const }];
    render(<RomTrend history={history} />);
    expect(screen.queryByTestId('rom-trend')).toBeNull();
    expect(screen.getByTestId('rom-trend-empty').textContent).toMatch(/driven by keys, not by the\s+patient/i);
  });

  it('draws a real gain differently from noise — the chart, not just the badge', () => {
    // A +31 pt gain and a flat-with-jitter series must not render as the same near-flat line: this was
    // the whole complaint against a fixed 0..1 axis in 40 px of drawable height.
    const spread = (history: SessionResult[], label: string) => {
      cleanup();
      render(<RomTrend history={history} />);
      const svg = screen.getByTestId('trend-knee_extension:left').querySelector(`svg[aria-label*="${label}"]`)!;
      const ys = (svg.querySelector('polyline')!.getAttribute('points') ?? '')
        .split(' ')
        .map((p) => Number(p.split(',')[1]));
      return Math.max(...ys) - Math.min(...ys);
    };
    const gain = spread(
      [
        session('c', 3, [lane({ romMean: 0.77 })]),
        session('b', 2, [lane({ romMean: 0.6 })]),
        session('a', 1, [lane({ romMean: 0.46 })]),
      ],
      'range of motion',
    );
    const noise = spread(
      [
        session('c', 3, [lane({ romMean: 0.6 })]),
        session('b', 2, [lane({ romMean: 0.61 })]),
        session('a', 1, [lane({ romMean: 0.59 })]),
      ],
      'range of motion',
    );
    expect(gain).toBeGreaterThan(70); // a third of a percentage-range gain crosses most of the plot
    expect(gain).toBeGreaterThan(noise * 6);
  });

  it('spaces sessions by their real date, so a slow gain does not look like a fast one', () => {
    const day = 86_400_000;
    const xs = (gapDays: number) => {
      cleanup();
      render(
        <RomTrend
          history={[
            session('c', 100 * day, [lane({ romMean: 0.7 })]),
            session('b', 100 * day - gapDays * day, [lane({ romMean: 0.6 })]),
            session('a', 1 * day, [lane({ romMean: 0.5 })]),
          ]}
        />,
      );
      const svg = screen.getByTestId('trend-knee_extension:left').querySelector('svg[aria-label*="range of motion"]')!;
      return (svg.querySelector('polyline')!.getAttribute('points') ?? '').split(' ').map((p) => Number(p.split(',')[0]));
    };
    const recentPair = xs(2); // last two sessions two days apart
    const spreadOut = xs(50); // ... versus fifty
    expect(recentPair[1] - recentPair[0]).toBeGreaterThan(spreadOut[1] - spreadOut[0]);
  });

  it('reports a single session honestly instead of inventing a trend', () => {
    render(<RomTrend history={[session('a', 1, [lane()])]} />);
    const card = screen.getByTestId('trend-knee_extension:left');
    expect(card.textContent).toContain('1 camera session');
    expect(card.textContent).toContain('no trend yet');
  });
});
