/**
 * THE SETUP SCREEN SAYS WHICH PATH THIS SESSION TAKES TO ITS RANGE OF MOTION, AND WHAT IT COSTS.
 *
 * In-song calibration is the default and the controlled range-of-motion screens are still one press
 * away — but a therapist cannot choose between them without being told what each one buys and what
 * it spends. The cost of "measure it first" is the patient's effort, in repetitions, counted from
 * the prescription actually on screen; the cost of "learn it in the song" is a range that is graded
 * no better than fair and that a trend will not subtract like-for-like from a measured one.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { LaneSpec } from '../engine/types.ts';
import { DEFAULT_SETTINGS, useStore } from '../state/store.ts';
import TherapistSetup from './TherapistSetup.tsx';

const HAND4: LaneSpec[] = [
  { index: 0, movement: 'hand_open_close', side: 'left' },
  { index: 1, movement: 'hand_open_close', side: 'right' },
  { index: 2, movement: 'finger_opposition', side: 'left', fingertip: 'index' },
  { index: 3, movement: 'finger_opposition', side: 'right', fingertip: 'index' },
];

beforeEach(() => {
  localStorage.clear();
  useStore.setState({
    screen: 'setup',
    mode: 'hand',
    lanes: HAND4,
    calibrations: HAND4.map(() => null),
    savedCalibrations: {},
    calibrationsByPatient: {},
    difficulty: 'easy',
    windowScale: 1,
    inputMode: 'camera',
    calibrationMode: 'in_song',
    settings: { ...DEFAULT_SETTINGS },
    history: [],
    lastResult: null,
    patients: [{ id: 'p1', name: 'R.K.', createdAt: 1, lastUsedAt: 1 }],
    activePatientId: 'p1',
  });
});
afterEach(cleanup);

describe('where this session gets its range of motion', () => {
  it('offers both paths, with in-song the one in force by default', () => {
    render(<TherapistSetup />);
    expect(screen.getByTestId('calmode-in_song').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('calmode-measured').getAttribute('aria-pressed')).toBe('false');
  });

  /** The complaint, in the therapist's own units: twelve maximum-effort reps from an impaired hand. */
  it('counts the repetitions the controlled path will demand of THIS prescription', () => {
    render(<TherapistSetup />);
    const measured = screen.getByTestId('calmode-measured');
    expect(measured.textContent).toContain('12 repetitions');
    expect(measured.textContent).toContain('4 rest holds');
  });

  it('says what the in-song path costs the record, not just what it saves the patient', () => {
    render(<TherapistSetup />);
    const cost = screen.getByTestId('setup-calibration-cost');
    expect(cost.textContent).toMatch(/learned in the song/i);
    expect(cost.textContent).toMatch(/graded no better than "fair"/i);
    expect(cost.textContent).toMatch(/will not subtract/i);
    // …and that the latency step goes with it, rather than leaving it unexplained.
    expect(cost.textContent).toMatch(/latency step is folded in/i);
  });

  it('changes what it promises when the therapist picks the controlled path', () => {
    render(<TherapistSetup />);
    fireEvent.click(screen.getByTestId('calmode-measured'));
    expect(useStore.getState().calibrationMode).toBe('measured');
    const cost = screen.getByTestId('setup-calibration-cost');
    expect(cost.textContent).toMatch(/range-of-motion screens and the latency metronome before the song/i);
    expect(cost.textContent).toMatch(/deliberate measurements/i);
  });

  /**
   * "We remember you" has to be TRUE. The count of lanes that will start on a saved range uses the
   * same validity check the session itself applies, so the sentence cannot promise a range the
   * session will then refuse — a range measured on another patient is not one of them.
   */
  it('counts only the saved ranges the session would actually accept', () => {
    const good = {
      min: 1, max: 2, samples: 100, movement: 'hand_open_close' as const,
      mirrored: false, patient: 'p1',
    };
    useStore.setState({
      savedCalibrations: {
        'hand_open_close:left': good,
        // Somebody else's hand: refused by calibrationMismatch, so it may not be counted.
        'hand_open_close:right': { ...good, patient: 'someone-else' },
      },
    });
    render(<TherapistSetup />);
    expect(screen.getByTestId('setup-calibration-cost').textContent).toContain('1 of 4 lanes');
  });
});
