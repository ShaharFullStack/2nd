import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
