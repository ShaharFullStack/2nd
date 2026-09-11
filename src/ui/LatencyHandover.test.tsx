import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { LaneResultSummary, SessionResult } from '../session/types.ts';
import { DEFAULT_SETTINGS, defaultLanes, useStore } from '../state/store.ts';
import LatencyHandover from './LatencyHandover.tsx';

function lane(movement: LaneResultSummary['movement'] = 'seated_march'): LaneResultSummary {
  return {
    lane: 0, movement, side: 'left', movementName: 'Left Seated march',
    hits: 20, perfects: 8, goods: 12, misses: 10, judged: 30, accuracy: 0.66, reps: 34,
    timingBiasMs: 90, timingBiasMadMs: 15, romMean: 0.7, romBest: 0.9, romSamples: 30, romUncertain: 0,
    calibratedMin: 0, calibratedMax: 1, calibrationManual: false,
    compensationKind: null, compensationMonitored: false, compensationFlags: 0, compensationWorst: null,
  };
}

function result(patch: Partial<SessionResult> = {}): SessionResult {
  return {
    id: 's1', patientId: 'p-test', patientName: 'Test Patient', startedAt: 1_700_000_000_000, endedAt: 1_700_000_100_000, durationSec: 120,
    mode: 'leg', difficulty: 'medium', windowScale: 1, inputMode: 'camera',
    songId: 'demo-groove', songTitle: 'Demo Groove', artist: 'A', attribution: '',
    score: 1000, stars: 3, accuracy: 0.66, starAccuracy: 0.7, maxCombo: 12, totalNotes: 40,
    hits: 20, perfects: 8, goods: 12, misses: 10, reps: 34, answerRate: 1,
    timingBiasMs: 90, timingBiasMadMs: 15,
    latencyOffsetMs: 120, suggestedLatencyMs: 320,
    completed: true, lanes: [lane()],
    ...patch,
  };
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
    latencyOffsetSec: 0.12,
    latencyMeasured: false,
    latencyNote: '',
  });
});
afterEach(cleanup);

describe('LatencyHandover', () => {
  it('shows nothing when the run had no confident suggestion', () => {
    render(<LatencyHandover result={result({ suggestedLatencyMs: null })} />);
    expect(screen.queryByTestId('latency-handover')).toBeNull();
  });

  it('shows the before AND the after so the therapist can judge the new value', () => {
    render(<LatencyHandover result={result()} />);
    const panel = screen.getByTestId('latency-handover');
    expect(panel.textContent).toContain('120 ms');
    expect(panel.textContent).toContain('320 ms');
  });

  it('is prominent only when the run is out by more than one good window', () => {
    // medium gross-motor good window is 140 ms; 130 ms of bias costs nothing.
    render(<LatencyHandover result={result({ suggestedLatencyMs: 250 })} />);
    expect(screen.getByTestId('latency-handover').className).not.toContain('latency-panel');
    expect(screen.getByText(/Latency looks right/)).toBeTruthy();
    cleanup();

    render(<LatencyHandover result={result({ suggestedLatencyMs: 261 })} />);
    expect(screen.getByTestId('latency-handover').className).toContain('latency-panel');
  });

  it('applying writes the measured value to the store for the next session', () => {
    render(<LatencyHandover result={result()} />);
    fireEvent.click(screen.getByTestId('apply-latency'));
    expect(useStore.getState().latencyOffsetSec).toBeCloseTo(0.32, 6);
    expect(useStore.getState().latencyMeasured).toBe(true);
    expect(useStore.getState().latencyNote).toContain('Demo Groove');
  });

  it('after applying it reports the swap it made rather than offering it again', () => {
    render(<LatencyHandover result={result()} />);
    fireEvent.click(screen.getByTestId('apply-latency'));
    const panel = screen.getByTestId('latency-handover');
    expect(panel.className).toContain('applied');
    expect(panel.textContent).toContain('Was');
    expect(panel.textContent).toContain('120 ms'); // what it was
    expect(panel.textContent).toContain('320 ms'); // what it is now
    expect(screen.queryByTestId('apply-latency')).toBeNull();
  });

  it('recognises a value that is already in force and does not nag', () => {
    useStore.setState({ latencyOffsetSec: 0.32 });
    render(<LatencyHandover result={result()} />);
    expect(screen.getByTestId('latency-handover').textContent).toContain('Camera offset updated');
    expect(screen.queryByTestId('apply-latency')).toBeNull();
  });

  it('still lets the therapist adopt a small, harmless correction', () => {
    render(<LatencyHandover result={result({ suggestedLatencyMs: 200 })} />);
    fireEvent.click(screen.getByTestId('apply-latency'));
    expect(useStore.getState().latencyOffsetSec).toBeCloseTo(0.2, 6);
  });

  it('uses the narrowest lane window — a fine-motor lane does not mask a gross-motor one', () => {
    // 150 ms of bias: inside the fine-motor good window (224 ms), outside the gross-motor one (140).
    render(
      <LatencyHandover
        result={result({ latencyOffsetMs: 0, suggestedLatencyMs: 150, lanes: [lane('finger_opposition'), lane('knee_extension')] })}
      />,
    );
    expect(screen.getByTestId('latency-handover').className).toContain('latency-panel');
  });

  it('offers NOTHING to apply on a keyboard or autoplay run, and says why', () => {
    // `latencyOffsetSec` is the CAMERA pipeline's offset. A human's +80 ms reaction bias on a keyboard
    // run, written here, silently corrupts the next real session.
    render(<LatencyHandover result={result({ inputMode: 'keyboard', suggestedLatencyMs: 320 })} />);
    expect(screen.queryByTestId('apply-latency')).toBeNull();
    expect(screen.getByTestId('latency-not-camera').textContent).toMatch(/not how long the camera takes/i);
    expect(useStore.getState().latencyOffsetSec).toBeCloseTo(0.12, 6);
    cleanup();

    render(<LatencyHandover result={result({ inputMode: 'autoplay', suggestedLatencyMs: -2 })} />);
    expect(screen.queryByTestId('apply-latency')).toBeNull();
    expect(screen.getByTestId('latency-handover').textContent).toMatch(/bot's own scheduling/i);
  });

  it('never offers a value the store would silently clamp away', () => {
    // The old panel's button read "Use -2 ms anyway" and wrote 0 ms.
    render(<LatencyHandover result={result({ latencyOffsetMs: 400, suggestedLatencyMs: -2 })} />);
    const button = screen.getByTestId('apply-latency');
    expect(button.textContent).toContain('0 ms');
    expect(button.textContent).not.toContain('-2 ms');
    expect(screen.getByTestId('latency-clamped').textContent).toMatch(/raw figure is -2 ms/);
    fireEvent.click(button);
    expect(useStore.getState().latencyOffsetSec).toBe(0);
    // The before/after pair is the STORE's value (120 ms) — what actually changes on this device.
    expect(screen.getByTestId('latency-handover').textContent).toContain('120 ms');
  });

  it('clamps an implausibly large suggestion to the value it will store', () => {
    render(<LatencyHandover result={result({ suggestedLatencyMs: 4000 })} />);
    expect(screen.getByTestId('apply-latency').textContent).toContain('1000 ms');
    fireEvent.click(screen.getByTestId('apply-latency'));
    expect(useStore.getState().latencyOffsetSec).toBe(1);
  });

  it('can be undone — a misclick on a persisted write must not cost a re-calibration', () => {
    render(<LatencyHandover result={result()} />);
    fireEvent.click(screen.getByTestId('apply-latency'));
    expect(useStore.getState().latencyOffsetSec).toBeCloseTo(0.32, 6);

    const undo = screen.getByTestId('revert-latency');
    expect(undo.textContent).toContain('120 ms');
    fireEvent.click(undo);
    expect(useStore.getState().latencyOffsetSec).toBeCloseTo(0.12, 6);
    expect(useStore.getState().latencyNote).toMatch(/restored after undoing/i);
    // ... and the offer comes back, so the therapist can change their mind again.
    expect(screen.getByTestId('apply-latency')).toBeTruthy();
  });

  it('an undo restores the PROVENANCE of the value, not only its number', () => {
    // `latencyMeasured` is what the calibration screen keys its "already measured" state off. Undo
    // used to write `measured: false` unconditionally, so correcting a misclick quietly demoted a
    // value the latency screen HAD measured to an unmeasured one.
    useStore.getState().setLatency(0.12, true, 'measured on the latency screen, 10 taps');
    render(<LatencyHandover result={result()} />);
    fireEvent.click(screen.getByTestId('apply-latency'));
    fireEvent.click(screen.getByTestId('revert-latency'));

    expect(useStore.getState().latencyOffsetSec).toBeCloseTo(0.12, 6);
    expect(useStore.getState().latencyMeasured).toBe(true);
    expect(useStore.getState().latencyNote).toBe('measured on the latency screen, 10 taps');
  });

  it('leaves an unmeasured value unmeasured when it is restored', () => {
    render(<LatencyHandover result={result()} />);
    fireEvent.click(screen.getByTestId('apply-latency'));
    fireEvent.click(screen.getByTestId('revert-latency'));
    expect(useStore.getState().latencyMeasured).toBe(false);
    expect(useStore.getState().latencyNote).toMatch(/restored after undoing/i);
  });

  it('names the two different offsets apart when the device has moved on since the run', () => {
    // The prose quotes the offset THIS RUN was judged at (from the stored record); the swap widget
    // quotes what is on the device right now. They diverge when the latency screen has been re-run
    // between the session and reading its results, and used to sit 40 px apart, unlabelled, with a
    // therapist deciding plausibility against whichever one they happened to read.
    useStore.setState({ latencyOffsetSec: 0 });
    render(<LatencyHandover result={result({ latencyOffsetMs: 120, suggestedLatencyMs: 320 })} />);
    const drift = screen.getByTestId('latency-drift');
    expect(drift.textContent).toMatch(/0 ms is the value the swap below replaces/i);
    expect(drift.textContent).toMatch(/120 ms is what the figures on this page were judged against/i);
  });

  it('says nothing about a drift when there is none', () => {
    render(<LatencyHandover result={result()} />);
    expect(screen.queryByTestId('latency-drift')).toBeNull();
  });

  it('does not claim an update when the clamped value was already in force', () => {
    useStore.setState({ latencyOffsetSec: 0 });
    render(<LatencyHandover result={result({ latencyOffsetMs: 0, suggestedLatencyMs: -2 })} />);
    const panel = screen.getByTestId('latency-handover');
    expect(panel.textContent).not.toMatch(/Camera offset updated/);
    expect(screen.queryByTestId('apply-latency')).toBeNull();
  });
});
