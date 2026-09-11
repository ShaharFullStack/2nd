import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DEVICE_TEST_PATIENT_ID } from '../session/types.ts';
import { isPatientDriven } from '../session/trends.ts';
import { DEFAULT_SETTINGS, defaultLanes, useStore } from '../state/store.ts';
import CameraFallback from './CameraFallback.tsx';

function domError(name: string, message: string): Error {
  const e = new Error(message);
  e.name = name;
  return e;
}

beforeEach(() => {
  localStorage.clear();
  useStore.setState({
    screen: 'camera',
    patients: [],
    activePatientId: null,
    history: [],
    mode: 'leg',
    lanes: defaultLanes('leg'),
    calibrations: [null, null],
    savedCalibrations: {},
    inputMode: 'camera',
    settings: { ...DEFAULT_SETTINGS },
  });
});
afterEach(cleanup);

describe('CameraFallback', () => {
  it('names the cause instead of printing the exception as a headline', () => {
    render(<CameraFallback error={domError('NotAllowedError', 'Permission denied')} onRetry={() => {}} />);
    expect(screen.getByText(/camera permission was refused/i)).toBeTruthy();
    expect(screen.queryByText('NotAllowedError')).toBeNull();
  });

  it('gives the right remedy for a missing device', () => {
    render(<CameraFallback error={domError('NotFoundError', 'Requested device not found')} onRetry={() => {}} />);
    expect(screen.getByText(/No camera was found/i)).toBeTruthy();
    expect(screen.getByText(/Plug the webcam in/i)).toBeTruthy();
  });

  it('separates a model failure from a camera failure', () => {
    render(<CameraFallback error={new Error('failed to load /models/pose_landmarker_lite.task')} onRetry={() => {}} />);
    expect(screen.getByText(/movement-tracking model failed to load/i)).toBeTruthy();
  });

  it('actually re-requests the camera when Retry is pressed', async () => {
    const onRetry = vi.fn(() => Promise.resolve());
    render(<CameraFallback error={domError('NotAllowedError', 'denied')} onRetry={onRetry} />);
    fireEvent.click(screen.getByTestId('camera-retry'));
    expect(onRetry).toHaveBeenCalledTimes(1);
    // The button reports that it is asking, then re-enables when the attempt settles.
    expect((screen.getByTestId('camera-retry') as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect((screen.getByTestId('camera-retry') as HTMLButtonElement).disabled).toBe(false));
  });

  it('does not offer a Retry that cannot possibly work', () => {
    render(<CameraFallback error={new Error('Camera not available: getUserMedia unsupported')} onRetry={() => {}} />);
    expect((screen.getByTestId('camera-retry') as HTMLButtonElement).disabled).toBe(true);
  });

  it('sends an unusable prescription back to Setup rather than at the camera', () => {
    render(
      <CameraFallback
        error={new Error('VisionInput: refusing to start on an unusable lane prescription — two movements of one hand')}
        onRetry={() => {}}
      />,
    );
    fireEvent.click(screen.getByTestId('camera-back-to-setup'));
    expect(useStore.getState().screen).toBe('setup');
  });

  it('offers the keyboard as a deliberate choice, with what it costs spelled out', () => {
    render(<CameraFallback error={domError('NotAllowedError', 'denied')} onRetry={() => {}} />);
    expect(screen.getByText(/no range of motion/i)).toBeTruthy();
    fireEvent.click(screen.getByTestId('camera-use-keyboard'));
    expect(useStore.getState().inputMode).toBe('keyboard');
    expect(useStore.getState().screen).toBe('play');
  });

  /**
   * THE PROMISE AND THE RECORD HAVE TO AGREE.
   *
   * The card said the run "will be stored in the history as a keyboard session and it will not appear
   * in the ROM trend" — which a therapist reads as "it will be in this patient's history, labelled".
   * `store.addResult` does something else entirely: every non-camera run is re-filed onto the
   * built-in "Device test (not a patient)" record, so it is not in the patient's history at all, does
   * not count as one of their sessions and never reaches their trend. This pins the sentence to the
   * behaviour, and the behaviour to the sentence — in one test, so neither can drift alone.
   */
  it('promises what the record actually does with a keyboard run', () => {
    useStore.setState({
      patients: [{ id: 'p-1', name: 'Alma Reyes', createdAt: 1, lastUsedAt: 1 }],
      activePatientId: 'p-1',
      history: [],
    });
    render(<CameraFallback error={domError('NotAllowedError', 'denied')} onRetry={() => {}} />);
    const note = screen.getByTestId('keyboard-record-note').textContent ?? '';
    expect(note).toMatch(/not stored under Alma Reyes/i);
    expect(note).toMatch(/Device test \(not a patient\)/i);
    expect(note).toMatch(/ROM trend/i);
    // No claim that it lands in the history as this patient's session.
    expect(note).not.toMatch(/stored in the history as a keyboard session/i);

    // …and that is what the store does with it.
    fireEvent.click(screen.getByTestId('camera-use-keyboard'));
    useStore.getState().addResult({
      id: 'kb-1', patientId: 'p-1', patientName: 'Alma Reyes',
      startedAt: 1, endedAt: 2, durationSec: 60,
      mode: 'leg', difficulty: 'medium', windowScale: 1, inputMode: 'keyboard',
      songId: 'demo-groove', songTitle: 'Demo', artist: '', attribution: '',
      score: 10, stars: 1, accuracy: 0.5, starAccuracy: 0.5, maxCombo: 2,
      totalNotes: 4, hits: 2, perfects: 1, goods: 1, misses: 2, reps: 2, answerRate: 1,
      timingBiasMs: null, timingBiasMadMs: null, latencyOffsetMs: 120, suggestedLatencyMs: null,
      completed: true, lanes: [],
    });
    const stored = useStore.getState().history[0];
    expect(stored.patientId).toBe(DEVICE_TEST_PATIENT_ID);
    expect(stored.patientName).toMatch(/not a patient/i);
    expect(useStore.getState().history.some((r) => r.patientId === 'p-1')).toBe(false);
    expect(isPatientDriven(stored)).toBe(false); // so it is not in the ROM trend either
  });

  it('keeps the raw message available as fine print', () => {
    render(<CameraFallback error={domError('NotReadableError', 'Could not start video source')} onRetry={() => {}} />);
    expect(screen.getByText('Could not start video source')).toBeTruthy();
  });

  it('escalates its advice after repeated failures', async () => {
    const onRetry = vi.fn(() => Promise.resolve());
    render(<CameraFallback error={domError('NotAllowedError', 'denied')} onRetry={onRetry} />);
    fireEvent.click(screen.getByTestId('camera-retry'));
    await waitFor(() => expect((screen.getByTestId('camera-retry') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('camera-retry'));
    await waitFor(() => expect(screen.getByText(/Still no camera after 2 attempts/i)).toBeTruthy());
  });

  /**
   * The case above only holds because this test keeps the component mounted across the retry. Both
   * real hosts clear the error before re-requesting, which UNMOUNTS this screen and resets its own
   * counter — so the count that matters comes in as a prop. PlayCameraFallback.test.tsx drives the
   * same escalation through the real host; this pins the seam.
   */
  it('escalates from the host retry count, which survives the screen being unmounted', () => {
    render(<CameraFallback error={domError('NotAllowedError', 'denied')} onRetry={() => {}} retries={3} />);
    expect(screen.getByText(/Still no camera after 3 attempts/i)).toBeTruthy();
  });

  it('does not escalate on the first failure', () => {
    render(<CameraFallback error={domError('NotAllowedError', 'denied')} onRetry={() => {}} retries={1} />);
    expect(screen.queryByText(/Still no camera after/i)).toBeNull();
  });
});
