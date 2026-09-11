/**
 * A CRASH MUST TURN THE CAMERA OFF.
 *
 * Every other release path in the app is tied to navigation: the runtime watches the store for a
 * screen that does not need frames, and the Play screen releases in its effect cleanup. A render
 * that throws changes neither — `screen` is still 'play' — so before the boundary existed, a render
 * error left the recording indicator lit above a blank page with MediaPipe still inferring, for as
 * long as the tab stayed open. On a shared clinic tablet that is a privacy incident.
 */
import { useEffect } from 'react';
import type React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useStore } from '../state/store.ts';

const runtime = { dispose: vi.fn() };
vi.mock('../session/runtime.ts', () => ({ runtime }));

const { default: ErrorBoundary } = await import('./ErrorBoundary.tsx');

function Boom(): never {
  throw new Error('landmarker exploded');
}

afterEach(() => {
  cleanup();
  runtime.dispose.mockClear();
  vi.restoreAllMocks();
});

describe('the app error boundary', () => {
  it('releases the camera, the audio and the runner when a screen throws', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(runtime.dispose).toHaveBeenCalledTimes(1);
  });

  it('tells the therapist the camera is off and that the session was saved', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId('app-crash')).toBeTruthy();
    expect(screen.getByText(/camera has been turned off/i)).toBeTruthy();
    // The engineering detail is kept for a bug report, but folded away from the therapist.
    expect(screen.getByText('landmarker exploded').closest('details')).toBeTruthy();
  });

  it('offers one way out that does not need the tab reloaded', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    useStore.setState({ screen: 'play' });
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    fireEvent.click(screen.getByTestId('crash-home'));
    expect(useStore.getState().screen).toBe('home');
  });

  /**
   * WHERE THE "IT WAS SAVED" GUARANTEE ACTUALLY LIVES.
   *
   * It is tempting to assume React unmounts the failed subtree — running the Play screen's cleanup,
   * which is what records an interrupted run — before `componentDidCatch`. It does NOT: the boundary
   * is told first, and the child's effect cleanup runs after. So the boundary may not rely on the
   * screen having saved anything; what saves the run is `runtime.dispose()` itself, which finishes
   * the runner (writing the reps to disk) BEFORE it releases the camera. That order is pinned in
   * runtime.dispose.test.ts; this test only pins that the boundary does not release anything by some
   * other route first.
   */
  it('releases through runtime.dispose() and nothing else', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const order: string[] = [];
    runtime.dispose.mockImplementation(() => order.push('runtime.dispose'));
    function Screen({ boom }: { boom: boolean }): React.ReactElement {
      useEffect(() => () => {
        order.push('screen unmounted');
      }, []);
      if (boom) throw new Error('mid-session crash');
      return <p>playing</p>;
    }
    const { rerender } = render(
      <ErrorBoundary>
        <Screen boom={false} />
      </ErrorBoundary>,
    );
    rerender(
      <ErrorBoundary>
        <Screen boom />
      </ErrorBoundary>,
    );
    expect(order.filter((s) => s === 'runtime.dispose')).toHaveLength(1);
  });

  it('renders its children untouched when nothing throws', () => {
    render(
      <ErrorBoundary>
        <p>all well</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText('all well')).toBeTruthy();
    expect(runtime.dispose).not.toHaveBeenCalled();
  });
});
