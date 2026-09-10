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
    // The title is DERIVED from movement/side/fingertip, not read back from the stored `label` (which
    // says "L knee extension" in this fixture, and says "L pinch" for every digit in records written
    // before the fingertip reached the label).
    expect(card.textContent).toContain('L knee ext');
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
    // ROM percentage, the same reps in degrees, and accuracy.
    expect(svgs.length).toBe(3);
    for (const svg of svgs) expect(svg.getAttribute('aria-label')).toMatch(/L knee ext/);
    // No two charts in one card may carry the same accessible name: they are different quantities.
    const names = [...svgs].map((svg) => svg.getAttribute('aria-label'));
    expect(new Set(names).size).toBe(names.length);
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
    // The FIGURES, not the whole card: "100%" is also the ceiling label on the accuracy axis, which is
    // a property of the chart and not a number claimed about anyone.
    const figures = [...card.querySelectorAll('.trend-figure .v')].map((e) => e.textContent);
    expect(figures).toContain('70%'); // the patient's accuracy, not the bot's 100 %
    expect(figures).not.toContain('100%');
    // ... and the bot's session is not a row in the per-session list either.
    expect(card.querySelectorAll('.trend-points tbody tr').length).toBe(2);
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

  it('puts session i at the SAME x in every chart in the card, however bunched the dates are', () => {
    // The failure this guards: the ROM line positioned points by real timestamp while the accuracy
    // columns positioned them by even index slot. Four sessions in one week, a fourteen-week gap and
    // two more, and the accuracy column above a ROM point belonged to a different session — inside one
    // card, under one pair of dates, with a caption claiming each point sits at its real date.
    const day = 86_400_000;
    const base = 400 * day;
    const days = [0, 2, 4, 6, 104, 106]; // bunched week, long gap, bunched pair
    const history = days
      .map((d, i) => session(`s${i}`, base + d * day, [lane({ romMean: 0.4 + i * 0.05, accuracy: 0.5 + i * 0.05 })]))
      .reverse(); // newest first, as the store keeps it
    render(<RomTrend history={history} />);
    const card = screen.getByTestId('trend-knee_extension:left');

    const line = card.querySelector('svg[aria-label*="range of motion"]')!;
    const pointXs = (line.querySelector('polyline')!.getAttribute('points') ?? '')
      .split(' ')
      .map((p) => Number(p.split(',')[0]));
    const bars = card.querySelector('svg[aria-label*="accuracy"]')!;
    const barXs = [...bars.querySelectorAll('rect')].map(
      (r) => Number(r.getAttribute('x')) + Number(r.getAttribute('width')) / 2,
    );

    expect(barXs.length).toBe(pointXs.length);
    barXs.forEach((bx, i) => expect(bx).toBeCloseTo(pointXs[i], 6));
    // ... and the shared axis really is a timeline: the fourteen-week gap is the widest gap on it.
    const gaps = pointXs.slice(1).map((x, i) => x - pointXs[i]);
    expect(Math.max(...gaps)).toBeGreaterThan(gaps[0] * 10);
  });

  it('discloses the denominator every percentage on the card is out of', () => {
    render(<RomTrend history={IMPROVING} />);
    const note = screen.getByTestId('trend-denominator-knee_extension:left');
    expect(note.textContent).toMatch(/range calibrated on the day/i);
    expect(note.textContent).toMatch(/20° to 80°/);
    expect(note.textContent).toMatch(/60° of travel/);
  });

  it('plots the peak in the movement own units as a SEPARATE quantity with its own title', () => {
    render(<RomTrend history={IMPROVING} />);
    const card = screen.getByTestId('trend-knee_extension:left');
    const abs = screen.getByTestId('trend-absolute-knee_extension:left');
    expect(abs.textContent).toContain('Peak angle reached');
    expect(abs.textContent).toContain('63°'); // 20 + 0.72 x 60
    expect(abs.textContent).toContain('+12°'); // 51° → 63°
    // Not folded into the ROM heading, and not "pts".
    expect(card.querySelector('svg[aria-label*="peak angle reached"]')).toBeTruthy();
    expect(abs.textContent).not.toContain('pts');
  });

  it('answers "did the range improve?" across a re-calibration that makes the percentage fall', () => {
    render(
      <RomTrend
        history={[
          session('b', 2_000_000, [lane({ romMean: 0.7, calibratedMin: 20, calibratedMax: 120 })]),
          session('a', 1_000_000, [lane({ romMean: 0.9, calibratedMin: 20, calibratedMax: 80 })]),
        ]}
      />,
    );
    const card = screen.getByTestId('trend-knee_extension:left');
    expect(card.textContent).toContain('−20 pts'); // the percentage fell...
    expect(screen.getByTestId('trend-absolute-knee_extension:left').textContent).toContain('+16°'); // ...the joint did not
  });

  it('draws accuracy on an absolute scale with a different mark, so no false slope comparison is invited', () => {
    render(<RomTrend history={IMPROVING} />);
    const card = screen.getByTestId('trend-knee_extension:left');
    const accuracy = card.querySelector('svg[aria-label*="accuracy"]')!;
    // Columns from a true zero out of a fixed 100 %, not a fourth autoscaled polyline.
    expect(accuracy.querySelectorAll('rect').length).toBe(3);
    expect(accuracy.querySelector('polyline')).toBeNull();
    expect(accuracy.textContent).toContain('100%');
    expect(accuracy.textContent).toContain('0%');
  });

  it('lists every session by date, and never writes "not measured" as a zero', () => {
    render(
      <RomTrend
        history={[
          session('c', 3_000_000, [lane({ romMean: 0.72 })]),
          session('b', 2_000_000, [lane({ romMean: null, romBest: null, romSamples: 0 })]),
          session('a', 1_000_000, [lane({ romMean: 0.52 })]),
        ]}
      />,
    );
    const rows = [...screen.getByTestId('trend-knee_extension:left').querySelectorAll('.trend-points tbody tr')];
    expect(rows.length).toBe(3);
    const middle = rows[1].textContent ?? '';
    expect(middle).toMatch(/not measured/);
    expect(middle).not.toMatch(/\b0%/);
  });

  it('titles two fingertips on one hand differently, even when the stored labels collide', () => {
    const pinch = (fingertip: 'index' | 'pinky', patch: Partial<LaneResultSummary>) =>
      lane({ movement: 'finger_opposition', side: 'left', fingertip, label: 'L pinch', ...patch });
    render(
      <RomTrend
        history={[session('a', 1_000_000, [pinch('index', { lane: 0, romMean: 0.8 }), pinch('pinky', { lane: 1, romMean: 0.4 })])]}
      />,
    );
    const a = screen.getByTestId('trend-finger_opposition:left:index');
    const b = screen.getByTestId('trend-finger_opposition:left:pinky');
    expect(a.querySelector('h4')!.textContent).toBe('L index pinch');
    expect(b.querySelector('h4')!.textContent).toBe('L little pinch');
  });

  it('gives every chart in the document its own gradient id', () => {
    // Two cards that share a series name used to emit the same SVG id, and both areas then resolved
    // to whichever gradient the document defined first.
    render(<RomTrend history={IMPROVING} />);
    const ids = [...document.querySelectorAll('linearGradient')].map((g) => g.id);
    expect(ids.length).toBeGreaterThan(1);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('reports a single session honestly instead of inventing a trend', () => {
    render(<RomTrend history={[session('a', 1, [lane()])]} />);
    const card = screen.getByTestId('trend-knee_extension:left');
    expect(card.textContent).toContain('1 camera session');
    expect(card.textContent).toContain('no trend yet');
  });
});
