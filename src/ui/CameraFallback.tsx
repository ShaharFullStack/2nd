/**
 * What the therapist sees when the camera cannot be started.
 *
 * This used to be a small overlay reading "No camera: <exception message>" with a single
 * "Play with the keyboard instead" button. Three things were wrong with that, and this screen exists
 * to fix exactly those three:
 *
 *  1. It did not say what went wrong. A refused permission, an unplugged webcam, a camera held by a
 *     video call and a model that failed to download all have DIFFERENT remedies, and only the first
 *     of them is fixed by anything the therapist can do inside this app.
 *  2. There was no way back. Once the camera failed the screen stayed failed; the therapist had to
 *     reload — losing the prescription — even after allowing the permission.
 *  3. The keyboard escape hatch was presented as the fix. It is not: this is a camera-controlled
 *     rehab game, and a keyboard session measures no range of motion and records no reps the patient
 *     performed. It is offered here as a labelled, deliberate choice with its cost spelled out.
 */
import { useState } from 'react';
import { classifyCameraError } from '../session/cameraError.ts';
import { useStore } from '../state/store.ts';
import { Screen, Toast, TopBar } from './common.tsx';

const GLYPH: Record<string, string> = {
  permission: '🔒',
  no_device: '🔌',
  device_busy: '📵',
  unsupported: '🚫',
  model: '📦',
  prescription: '⚠️',
  unknown: '📷',
};

export default function CameraFallback({ error, onRetry }: { error: unknown; onRetry: () => Promise<void> | void }) {
  const goto = useStore((s) => s.goto);
  const setInputMode = useStore((s) => s.setInputMode);
  const [retrying, setRetrying] = useState(false);
  const [attempts, setAttempts] = useState(0);

  const failure = classifyCameraError(error);

  const retry = () => {
    setRetrying(true);
    setAttempts((n) => n + 1);
    // The camera is re-REQUESTED, not just re-rendered: the caller disposes the vision input and
    // builds a new one, which calls getUserMedia again and re-prompts where the browser allows it.
    void Promise.resolve(onRetry()).finally(() => setRetrying(false));
  };

  return (
    <Screen testId="camera-fallback">
      <TopBar eyebrow="Camera check" title="The camera did not start" onBack={() => goto('setup')} />

      <div className="fallback-hero">
        <span className="glyph" aria-hidden="true">
          {GLYPH[failure.kind] ?? GLYPH.unknown}
        </span>
        <div className="stack" style={{ gap: 8 }}>
          <h3>{failure.title}</h3>
          <p className="muted" style={{ margin: 0 }}>
            {failure.detail}
          </p>
        </div>
      </div>

      <div className="card stack">
        <h3>Try this first</h3>
        <p style={{ margin: 0, fontSize: '1.15rem' }}>{failure.remedy}</p>
        <div className="row">
          <button
            className="btn btn-primary btn-lg"
            onClick={retry}
            disabled={retrying || !failure.retryable}
            data-testid="camera-retry"
          >
            {retrying ? 'Asking for the camera…' : 'Retry the camera'}
          </button>
          {failure.kind === 'prescription' && (
            <button className="btn btn-lg" onClick={() => goto('setup')} data-testid="camera-back-to-setup">
              Change the lanes
            </button>
          )}
          {!failure.retryable && failure.kind !== 'prescription' && (
            <span className="dim">Retrying cannot help with this one — the fallback below is the way to run today's session.</span>
          )}
        </div>
        {attempts > 1 && !retrying && (
          <Toast>
            Still no camera after {attempts} attempts. A permission the browser has remembered may need clearing
            from the site settings, and a reload picks up a webcam that was plugged in after the page loaded.
          </Toast>
        )}
      </div>

      <div className="card stack">
        <h3>Or run this session on the keyboard</h3>
        <p className="muted" style={{ margin: 0 }}>
          The chart, the song and the scoring all work. What is lost is the whole rehab measurement: keys 1–4
          (or D F J K) stand in for the movements, so this session records <b>no range of motion</b>, and its
          reps are keypresses rather than movements the patient performed. It will be stored in the history as a
          keyboard session and it will not appear in the ROM trend.
        </p>
        <div className="row">
          <button
            className="btn btn-lg"
            onClick={() => {
              setInputMode('keyboard');
              goto('play');
            }}
            data-testid="camera-use-keyboard"
          >
            Run on the keyboard anyway →
          </button>
          <button className="btn btn-ghost btn-lg" onClick={() => goto('setup')}>
            Back to the prescription
          </button>
        </div>
      </div>

      <details className="card">
        <summary className="dim">Technical detail</summary>
        <p className="fallback-raw">{failure.raw}</p>
      </details>
    </Screen>
  );
}
