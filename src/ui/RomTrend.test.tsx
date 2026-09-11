import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { LaneResultSummary, SessionResult, TrackingQuality } from '../session/types.ts';
import RomTrend from './RomTrend.tsx';

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

const PATIENT = 'p-test';

/** A stream that did what the measurement assumes. */
function tracking(patch: Partial<TrackingQuality> = {}): TrackingQuality {
  return {
    samples: 180, fpsMedian: 30, fpsLow: 28, inferenceMsMedian: 12,
    trackedFraction: 0.99, lowFpsFraction: 0, delegate: 'GPU', worstReason: null,
    ...patch,
  };
}

/** 11.8 fps with the landmarks usable for 62 % of the session — the case the whole module exists for. */
const POOR = tracking({ fpsMedian: 11.8, fpsLow: 8.2, trackedFraction: 0.62, lowFpsFraction: 0.7, worstReason: 'no_landmarks' });

function session(id: string, at: number, lanes: LaneResultSummary[]): SessionResult {
  return {
    id, patientId: PATIENT, patientName: 'Test Patient', startedAt: at, endedAt: at + 1, durationSec: 120,
    mode: 'leg', difficulty: 'medium', windowScale: 1, inputMode: 'camera',
    songId: 's', songTitle: 'S', artist: 'A', attribution: '',
    score: 1, stars: 3, accuracy: 0.8, starAccuracy: 0.8, maxCombo: 1, totalNotes: 10,
    hits: 8, perfects: 4, goods: 4, misses: 2, reps: 12, answerRate: 1,
    timingBiasMs: null, timingBiasMadMs: null, latencyOffsetMs: 120, suggestedLatencyMs: null,
    completed: true, lanes, tracking: tracking(),
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
    render(<RomTrend history={[]} patientId={PATIENT} />);
    expect(screen.queryByTestId('rom-trend')).toBeNull();
  });

  it('draws one card per movement, headed by the latest number and the direction', () => {
    render(<RomTrend history={IMPROVING} patientId={PATIENT} />);
    const card = screen.getByTestId('trend-knee_extension:left');
    // The title is DERIVED from movement/side/fingertip and is the FULL clinical name — never the
    // renderer's 46-pixel canvas abbreviation, and never read back from the stored name (which says
    // "L pinch" for every digit in records written before the fingertip reached it).
    expect(card.textContent).toContain('Left Knee extension');
    expect(card.textContent).toContain('72%'); // latest ROM
    expect(card.textContent).toContain('+20 pts'); // 0.52 → 0.72
    expect(card.textContent).toContain('3 camera sessions');
  });

  it('gives each movement and side its own card', () => {
    const history = [session('a', 1, [lane({ side: 'left' }), lane({ side: 'right', movementName: 'Right Knee extension' })])];
    render(<RomTrend history={history} patientId={PATIENT} />);
    expect(screen.getByTestId('trend-knee_extension:left')).toBeTruthy();
    expect(screen.getByTestId('trend-knee_extension:right')).toBeTruthy();
  });

  it('never draws an unmeasured session as a collapse in range', () => {
    const history = [
      session('b', 2, [lane({ romMean: 0.7 })]),
      session('a', 1, [lane({ romMean: null, romBest: null, romSamples: 0 })]),
    ];
    render(<RomTrend history={history} patientId={PATIENT} />);
    const card = screen.getByTestId('trend-knee_extension:left');
    expect(card.textContent).toMatch(/1 of these sessions did not measure range/);
    // The ROM sparkline is one measured point, drawn as a dot rather than a line down to zero.
    const rom = card.querySelector('svg[aria-label*="range of motion"]');
    expect(rom).toBeTruthy();
    expect(rom?.querySelector('polyline')).toBeNull();
  });

  it('says so when no session in the window measured range at all', () => {
    const history = [session('a', 1, [lane({ romMean: null, romBest: null, romSamples: 0 })])];
    render(<RomTrend history={history} patientId={PATIENT} />);
    expect(screen.getByTestId('trend-knee_extension:left').textContent).toMatch(/Range was not measured/);
  });

  it('warns when the calibrated range changed, so a falling percentage is not read as decline', () => {
    const history = [
      session('b', 2, [lane({ calibratedMin: 20, calibratedMax: 110, romMean: 0.55 })]),
      session('a', 1, [lane({ calibratedMin: 20, calibratedMax: 80, romMean: 0.6 })]),
    ];
    render(<RomTrend history={history} patientId={PATIENT} />);
    expect(screen.getByTestId('trend-knee_extension:left').textContent).toMatch(/calibrated range changed/i);
  });

  it('lets the therapist widen or narrow the window', () => {
    const many = Array.from({ length: 12 }, (_, i) => session(`s${11 - i}`, 12 - i, [lane({ romMean: (11 - i) / 20 })]));
    render(<RomTrend history={many} patientId={PATIENT} />);
    expect(screen.getByTestId('trend-knee_extension:left').textContent).toContain('8 camera sessions');
    fireEvent.click(screen.getByTestId('trend-window-4'));
    expect(screen.getByTestId('trend-knee_extension:left').textContent).toContain('4 camera sessions');
  });

  it('labels every chart for a screen reader', () => {
    render(<RomTrend history={IMPROVING} patientId={PATIENT} />);
    const svgs = screen.getByTestId('trend-knee_extension:left').querySelectorAll('svg');
    // ROM percentage, the same reps in degrees, and accuracy.
    expect(svgs.length).toBe(3);
    for (const svg of svgs) expect(svg.getAttribute('aria-label')).toMatch(/Left Knee extension/);
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
    render(<RomTrend history={history} patientId={PATIENT} />);
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
    render(<RomTrend history={history} patientId={PATIENT} />);
    expect(screen.queryByTestId('rom-trend')).toBeNull();
    expect(screen.getByTestId('rom-trend-empty').textContent).toMatch(/driven by keys, not by the\s+patient/i);
  });

  it('draws a real gain differently from noise — the chart, not just the badge', () => {
    // A +31 pt gain and a flat-with-jitter series must not render as the same near-flat line: this was
    // the whole complaint against a fixed 0..1 axis in 40 px of drawable height.
    const spread = (history: SessionResult[], label: string) => {
      cleanup();
      render(<RomTrend history={history} patientId={PATIENT} />);
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
          patientId={PATIENT}
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
    render(<RomTrend history={history} patientId={PATIENT} />);
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
    render(<RomTrend history={IMPROVING} patientId={PATIENT} />);
    const note = screen.getByTestId('trend-denominator-knee_extension:left');
    expect(note.textContent).toMatch(/range calibrated on the day/i);
    expect(note.textContent).toMatch(/20° to 80°/);
    expect(note.textContent).toMatch(/60° of travel/);
  });

  it('plots the peak in the movement own units as a SEPARATE quantity with its own title', () => {
    render(<RomTrend history={IMPROVING} patientId={PATIENT} />);
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
      
          patientId={PATIENT}
        />,
    );
    const card = screen.getByTestId('trend-knee_extension:left');
    expect(card.textContent).toContain('−20 pts'); // the percentage fell...
    expect(screen.getByTestId('trend-absolute-knee_extension:left').textContent).toContain('+16°'); // ...the joint did not
  });

  it('draws accuracy on an absolute scale with a different mark, so no false slope comparison is invited', () => {
    render(<RomTrend history={IMPROVING} patientId={PATIENT} />);
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
      
          patientId={PATIENT}
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
      lane({ movement: 'finger_opposition', side: 'left', fingertip, movementName: 'Left Finger opposition (index finger)', ...patch });
    render(
      <RomTrend
        history={[session('a', 1_000_000, [pinch('index', { lane: 0, romMean: 0.8 }), pinch('pinky', { lane: 1, romMean: 0.4 })])]}
      
          patientId={PATIENT}
        />,
    );
    const a = screen.getByTestId('trend-finger_opposition:left:index');
    const b = screen.getByTestId('trend-finger_opposition:left:pinky');
    expect(a.querySelector('h4')!.textContent).toBe('Left Finger opposition (index finger)');
    expect(b.querySelector('h4')!.textContent).toBe('Left Finger opposition (little finger)');
  });

  it('gives every chart in the document its own gradient id', () => {
    // Two cards that share a series name used to emit the same SVG id, and both areas then resolved
    // to whichever gradient the document defined first.
    render(<RomTrend history={IMPROVING} patientId={PATIENT} />);
    const ids = [...document.querySelectorAll('linearGradient')].map((g) => g.id);
    expect(ids.length).toBeGreaterThan(1);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('reports a single session honestly instead of inventing a trend', () => {
    render(<RomTrend history={[session('a', 1, [lane()])]} patientId={PATIENT} />);
    const card = screen.getByTestId('trend-knee_extension:left');
    expect(card.textContent).toContain('1 camera session');
    expect(card.textContent).toContain('no trend yet');
  });
});

/**
 * ONE CARD, ONE SET OF SESSIONS.
 *
 * The headline ROM and the change badge came from the last COMPLETE session (trends.ts refuses to
 * anchor a delta on a nine-rep walk-out); the chart plotted every point including the incomplete
 * ones; and the caption under the cards said the gap between the dashed start line and the last
 * point WAS the change. Three statements about three different sets of sessions.
 */
describe('the card, the chart and the caption describe the same sessions', () => {
  const aborted = (id: string, at: number, rom: number): SessionResult => ({
    ...session(id, at, [lane({ romMean: rom, reps: 3 })]),
    completed: false,
    endReason: 'quit',
    reps: 3,
  });

  it('sets an aborted run aside, and says so, when there are two complete sessions to compare', () => {
    const history = [aborted('d', 4_000_000, 0.2), ...IMPROVING];
    render(<RomTrend history={history} patientId={PATIENT} />);
    const card = screen.getByTestId('trend-knee_extension:left');
    // The headline is the last COMPLETE session — and so is the last point of the line beside it.
    expect(card.textContent).toContain('72%');
    expect(card.textContent).toContain('+20 pts');
    // The count on the badge is the set that is drawn, not the set that exists.
    expect(card.textContent).toContain('3 camera sessions');
    expect(screen.getByTestId('trend-incomplete-knee_extension:left').textContent).toContain('set aside');
    const note = screen.getByTestId('trend-set-aside-knee_extension:left');
    expect(note.textContent).toContain('not in the figures, the plots or the change badges');
    // Nothing is hidden: the reps performed in it are stated and the run is listed underneath.
    expect(note.textContent).toContain('3 movements');
    expect(screen.getByTestId('trend-points-knee_extension:left').textContent).toContain('4');
  });

  it('plots the aborted run when it is all there is, and says THAT instead', () => {
    const history = [aborted('b', 2_000_000, 0.2), session('a', 1_000_000, [lane({ romMean: 0.5 })])];
    render(<RomTrend history={history} patientId={PATIENT} />);
    const card = screen.getByTestId('trend-knee_extension:left');
    expect(card.textContent).toContain('20%'); // the aborted run IS the latest figure now
    expect(screen.queryByTestId('trend-set-aside-knee_extension:left')).toBeNull();
    expect(screen.getByTestId('trend-incomplete-knee_extension:left').textContent).toContain('ended early');
    expect(screen.getByTestId('trend-incomplete-knee_extension:left').textContent).not.toContain('set aside');
    expect(screen.getByTestId('trend-incomplete-change-knee_extension:left').textContent).toContain(
      'the figures, the plots and',
    );
  });

  it('counts only the sessions it draws in the rep total on the card', () => {
    const history = [aborted('d', 4_000_000, 0.2), ...IMPROVING];
    render(<RomTrend history={history} patientId={PATIENT} />);
    const card = screen.getByTestId('trend-knee_extension:left');
    // 3 complete sessions x 12 reps; the aborted run's 3 are named separately, never folded in.
    expect(card.textContent).toContain('36 movements performed');
    expect(card.textContent).not.toContain('39 movements performed');
  });
});

/**
 * THE PER-MOVEMENT LIST IS A TABLE IN A NARROW CARD, AND IT SAYS SO.
 *
 * Measured at 1024x768 on the History screen, this list laid out at 537 px inside a 435 px wrapper:
 * "Accuracy" was cut mid-word and REPS — the count Results and History were both rebuilt to lead
 * with — was entirely off the right-hand edge, with no scrollbar, no cue and no arrows. It was a
 * bare `.table-wrap`; it is now the same `ScrollTable` the Results tables use, and its columns are
 * ordered the way theirs are: when, then the work, then the range, then the grade.
 */
describe('the session-by-session list is reachable and ordered like the other screens', () => {
  it('puts the rep count immediately after the date, ahead of every scoring column', () => {
    render(<RomTrend history={IMPROVING} patientId={PATIENT} />);
    const heads = [...screen.getByTestId('trend-knee_extension:left').querySelectorAll('.trend-points thead th')].map(
      (th) => th.textContent?.trim(),
    );
    expect(heads[0]).toBe('Session');
    expect(heads[1]).toBe('Reps');
    expect(heads.indexOf('Accuracy')).toBeGreaterThan(heads.indexOf('Reps'));
    expect(heads.indexOf('ROM')).toBeGreaterThan(heads.indexOf('Reps'));
  });

  it('is a ScrollTable, so any width it does not fit in is announced rather than silently clipped', () => {
    render(<RomTrend history={IMPROVING} patientId={PATIENT} />);
    const card = screen.getByTestId('trend-knee_extension:left');
    const wrap = card.querySelector('[data-testid="trend-points-table-knee_extension:left"]');
    expect(wrap).not.toBeNull();
    expect(wrap?.classList.contains('table-wrap')).toBe(true);
    // jsdom lays everything out at zero width, so the cue itself cannot be asserted here; what is
    // asserted is that the table is wired to the component that measures the overflow and draws the
    // cue plus its two full-size arrows (see Results.tsx `ScrollTable`, and
    // critic/verify-ending-and-headline.mjs, which measures clientWidth against scrollWidth in a
    // real browser at 1024x768).
    expect(wrap?.parentElement?.className).toContain('stack');
  });

  it('still lists every session, including the ones the card set aside', () => {
    const mixed = [
      session('d', 4_000_000, [lane({ romMean: 0.74 })]),
      { ...session('c', 3_000_000, [lane({ romMean: 0.2, reps: 3 })]), completed: false, endReason: 'quit' as const },
      session('b', 2_000_000, [lane({ romMean: 0.64 })]),
      session('a', 1_000_000, [lane({ romMean: 0.52 })]),
    ];
    render(<RomTrend history={mixed} patientId={PATIENT} />);
    const rows = [...screen.getByTestId('trend-knee_extension:left').querySelectorAll('.trend-points tbody tr')];
    expect(rows.length).toBe(4);
    expect(rows.some((r) => (r.textContent ?? '').includes('stopped by therapist'))).toBe(true);
  });
});

/**
 * THE CONFOUND THIS WHOLE FILE IS ABOUT.
 *
 * A trend is the one view where a change in the EQUIPMENT and a change in the PATIENT look the same,
 * and this card is the surface a therapist changes a prescription on. A rise driven entirely by a
 * session measured at 11.8 fps with the limb usable 62 % of the time may not be drawn as four
 * identical dots and a green chip.
 */
describe('a session measured on a degraded stream is marked WHERE THE COMPARISON IS MADE', () => {
  const mixed = [
    { ...session('d', 4_000_000, [lane({ romMean: 0.71, accuracy: 0.9 })]), tracking: POOR },
    session('c', 3_000_000, [lane({ romMean: 0.33, accuracy: 0.6 })]),
    session('b', 2_000_000, [lane({ romMean: 0.27, accuracy: 0.55 })]),
    session('a', 1_000_000, [lane({ romMean: 0.21, accuracy: 0.5 })]),
  ];

  it('does not paint the delta green when the two ends were tracked differently', () => {
    render(<RomTrend history={mixed} patientId={PATIENT} />);
    const badge = screen.getByTestId('trend-rom-delta-knee_extension:left');
    // the number is still there — it is the measurement that was made
    expect(badge.textContent).toContain('+50 pts');
    // ...but it is not a win, and it says why inside its own box
    expect(badge.className).not.toContain('badge-ok');
    expect(badge.getAttribute('data-qualified')).toBe('true');
    expect(badge.textContent).toContain('measured unevenly');
  });

  it('qualifies the accuracy delta the same way — it is as much a property of the stream', () => {
    render(<RomTrend history={mixed} patientId={PATIENT} />);
    const badge = screen.getByTestId('trend-accuracy-delta-knee_extension:left');
    expect(badge.className).not.toContain('badge-ok');
    expect(badge.textContent).toContain('measured unevenly');
  });

  it('rings the degraded point on the plot rather than drawing it like the rest', () => {
    const { container } = render(<RomTrend history={mixed} patientId={PATIENT} />);
    // the last point (index 3 of the four plotted, oldest first) is the poor-tracked session
    expect(container.querySelector('[data-testid="spark-flag-3"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="spark-flag-0"]')).toBeNull();
    expect(container.querySelector('[data-testid="bars-flag-3"]')).toBeTruthy();
  });

  it('says on the card how many of ITS OWN sessions were measured badly', () => {
    render(<RomTrend history={mixed} patientId={PATIENT} />);
    const line = screen.getByTestId('trend-tracking-knee_extension:left');
    expect(line.textContent).toContain('1 of these 4 sessions');
    expect(line.textContent).toContain('degraded');
  });

  it('states the grade of every session in the session-by-session list', () => {
    render(<RomTrend history={mixed} patientId={PATIENT} />);
    expect(screen.getByTestId('trend-point-tracking-knee_extension:left-d').textContent).toBe('poor');
    expect(screen.getByTestId('trend-point-tracking-knee_extension:left-a').textContent).toBe('good');
  });

  it('treats a record with no tracking block as unknown, never as a clean stream', () => {
    const noBlock = [
      { ...session('b', 2_000_000, [lane({ romMean: 0.7 })]), tracking: undefined },
      session('a', 1_000_000, [lane({ romMean: 0.5 })]),
    ];
    render(<RomTrend history={noBlock} patientId={PATIENT} />);
    const badge = screen.getByTestId('trend-rom-delta-knee_extension:left');
    expect(badge.className).not.toContain('badge-ok');
    expect(badge.textContent).toContain('tracking unknown');
    expect(screen.getByTestId('trend-point-tracking-knee_extension:left-b').textContent).toBe('not recorded');
  });

  it('leaves a like-for-like comparison alone — the caveat is not furniture', () => {
    render(<RomTrend history={IMPROVING} patientId={PATIENT} />);
    const badge = screen.getByTestId('trend-rom-delta-knee_extension:left');
    expect(badge.className).toContain('badge-ok');
    expect(badge.getAttribute('data-qualified')).toBeNull();
    expect(screen.queryByTestId('trend-tracking-knee_extension:left')).toBeNull();
  });

  it('counts the sessions BEHIND THESE LINES, not the patient\'s whole camera history', () => {
    // twelve stored sessions, the four most recent all tracked good: with "Last 4" selected the
    // sentence under the plots must not be about the eight that are not on screen.
    const many: SessionResult[] = [];
    for (let i = 12; i >= 1; i--) {
      const good = i > 8;
      many.push({
        ...session(`s${i}`, i * 1_000_000, [lane({ romMean: 0.4 + i * 0.01 })]),
        tracking: good ? tracking() : POOR,
      });
    }
    render(<RomTrend history={many} patientId={PATIENT} />);
    fireEvent.click(screen.getByTestId('trend-window-4'));
    const mix = screen.getByTestId('trend-tracking-mix');
    expect(mix.textContent).toContain('All 4 camera sessions behind these lines');
    fireEvent.click(screen.getByTestId('trend-window-8'));
    expect(screen.getByTestId('trend-tracking-mix').textContent).toContain('Of the 8 camera sessions behind these lines');
  });
});
