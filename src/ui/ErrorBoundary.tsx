/**
 * THE LAST PLACE THE CAMERA CAN BE TURNED OFF.
 *
 * Every other release path is tied to NAVIGATION: the runtime watches the store for a screen that
 * does not need frames, and the Play screen releases in its effect cleanup. A render that throws
 * changes neither — `screen` is still 'play', the component never unmounts on its own — so without
 * this the recording indicator stays lit above a blank white page for as long as the tab is open,
 * with MediaPipe still inferring on every frame. On a shared clinic tablet a camera that is on with
 * nothing on screen to say so is a privacy incident, not a crash report.
 *
 * So a crash releases the device, and only then says so. The order inside that release is
 * load-bearing, and it is NOT React's to give: React tells the boundary first and runs the failed
 * subtree's effect cleanup afterwards, so this component cannot assume the Play screen has already
 * saved anything. `runtime.dispose()` is what makes it safe — it finishes the runner (writing the
 * reps the patient actually performed to localStorage, as an interrupted session) before it releases
 * the camera and the audio context. That order is pinned in src/session/runtime.dispose.test.ts.
 *
 * The screen it shows is for a therapist mid-visit, not for a developer: what happened, that the
 * camera is off, that the session up to that point was saved, and one large button back to safety.
 * The message itself is kept — folded away — because a clinic that reports a bug needs it.
 */
import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { runtime } from '../session/runtime.ts';
import { useStore } from '../state/store.ts';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[app] a screen failed to render', error, info.componentStack);
    try {
      runtime.dispose();
    } catch (err) {
      console.error('[app] releasing the camera after a crash failed', err);
    }
  }

  private restart = (): void => {
    this.setState({ error: null });
    try {
      useStore.getState().goto('home');
    } catch (err) {
      console.error('[app] could not return home after a crash', err);
      location.reload();
    }
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="screen" data-testid="app-crash">
        <div className="overlay">
          <div className="card stack">
            <h2>Something went wrong on this screen</h2>
            <p className="muted">
              <strong>The camera has been turned off</strong> and anything the patient had already done
              in a running session was saved to this device's history before it stopped.
            </p>
            <button className="btn btn-primary btn-lg" onClick={this.restart} data-testid="crash-home">
              Back to the start
            </button>
            <details className="fold">
              <summary className="dim">Technical detail (for a bug report)</summary>
              <pre className="mono" style={{ whiteSpace: 'pre-wrap', marginTop: 8 }}>
                {error.message || String(error)}
              </pre>
            </details>
          </div>
        </div>
      </div>
    );
  }
}
