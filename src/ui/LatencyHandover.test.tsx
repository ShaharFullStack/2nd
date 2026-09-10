import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { LaneResultSummary, SessionResult } from '../session/types.ts';
import { DEFAULT_SETTINGS, defaultLanes, useStore } from '../state/store.ts';
import LatencyHandover from './LatencyHandover.tsx';

function lane(movement: LaneResultSummary['movement'] = 'seated_march'): LaneResultSummary {
  return {
    lane: 0, movement, side: 'left', label: 'L march',
    hits: 20, perfects: 8, goods: 12, misses: 10, judged: 30, accuracy: 0.66, reps: 34,
    timingBiasMs: 90, timingBiasMadMs: 15, romMean: 0.7, romBest: 0.9, romSamples: 30, romUncertain: 0,
    calibratedMin: 0, calibratedMax: 1, calibrationManual: false,
    compensationKind: null, compensationMonitored: false, compensationFlags: 0, compensationWorst: null,
  };
}

function result(patch: Partial<SessionResult> = {}): SessionResult {
  return {
    id: 's1', startedAt: 1_700_000_000_000, endedAt: 1_700_000_100_000, durationSec: 120,
    mode: 'leg', difficulty: 'medium', windowScale: 1, inputMode: 'camera',
    songId: 'demo-groove', songTitle: 'Demo Groove', artist: 'A', attribution: '',
    score: 1000, stars: 3, accuracy: 0.66, starAccuracy: 0.7, maxCombo: 12, totalNotes: 40,
    hits: 20, perfects: 8, goods: 12, misses: 10, reps: 34, health: 1,
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
});
