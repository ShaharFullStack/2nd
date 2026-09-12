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
 *
 * AND A FOURTH THING, WHICH IS WHAT THIS SCREEN IS FOR A PATIENT SITTING ALONE.
 * Every hands-free step in this app is a limb held over a circle drawn on the camera preview. This
 * screen exists because there is no camera preview — so there is no circle, there is nothing to hold,
 * and the four controls below are all for somebody with a hand on the tablet. The patient who was
 * driving the session from the chair is, at this exact moment, stranded, and until now the screen
 * simply did not mention it: four buttons, no sentence.
 *
 * It says so now, first, in the same voice as the stalled-audio-clock screen in Play.tsx — which is
 * the other place in this app where the honest thing is to name a step that cannot be done by
 * movement. Saying it plainly is not a fix for the camera; it is the difference between a patient
 * holding a limb at a screen that will never respond and a patient who knows to call somebody.
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
  audio_gesture: '👆',
  unknown: '📷',
};

export default function CameraFallback({
  error,
  onRetry,
  retries = 0,
}: {
  error: unknown;
  onRetry: () => Promise<void> | void;
  /**
   * Retries the HOST has already made on this visit to the camera.
   *
   * This screen cannot count its own: both hosts clear the error before re-requesting, which unmounts
   * this component and resets its state, so a locally-held counter never got past 1 and the escalation
   * below — the advice for the single most likely clinic failure, a permission the browser remembered
   * on a shared tablet — was unreachable in the running app while its unit test passed. The count that
   * survives the remount lives with the thing doing the retrying.
   */
  retries?: number;
}) {
  const goto = useStore((s) => s.goto);
  const setInputMode = useStore((s) => s.setInputMode);
  /** Named so the sentence below is about the person in the chair, not about "the patient". */
  const patientName = useStore((s) => {
    const active = s.patients.find((p) => p.id === s.activePatientId);
    return active && !active.deviceTest ? active.name : null;
  });
  const [retrying, setRetrying] = useState(false);
  const [localAttempts, setLocalAttempts] = useState(0);
  // Whichever counted more: the host's (survives the remount) or this screen's own (for a host that
  // keeps the component mounted across the retry).
  const attempts = Math.max(localAttempts, retries);

  const failure = classifyCameraError(error);

  const retry = () => {
    setRetrying(true);
    setLocalAttempts((n) => n + 1);
    // The camera is re-REQUESTED, not just re-rendered: the caller disposes the vision input and
    // builds a new one, which calls getUserMedia again and re-prompts where the browser allows it.
    void Promise.resolve(onRetry()).finally(() => setRetrying(false));
  };

  return (
    <Screen testId="camera-fallback">
      <TopBar eyebrow="Camera check" title="The camera did not start" onBack={() => goto('setup')} />

      {/* THE SENTENCE A PATIENT ALONE IS OWED, BEFORE ANY REMEDY ADDRESSED TO SOMEBODY ELSE.
          First on the screen for the same reason the escape is first on the pause dialog: it is the
          part addressed to the person who cannot scroll, and everything under it is written for
          whoever is standing up. */}
      <div className="card stack" data-testid="camera-fallback-handsfree" style={{ borderColor: 'var(--gold)' }}>
        <h3 style={{ margin: 0 }}>This step cannot be done by moving — it needs a hand, or somebody to help</h3>
        <p className="muted" style={{ margin: 0, fontSize: '1.1rem' }}>
          Holding a hand or a knee inside a circle is how every other step of the session is confirmed, and that circle
          is drawn on the camera picture. There is no camera picture here — that is what has gone wrong — so there is
          nothing on this screen a movement can reach, however long it is held. {patientName ? `${patientName} cannot` : 'A patient sitting alone cannot'}{' '}
          get past this one from the chair.
        </p>
        <p className="muted" style={{ margin: 0, fontSize: '1.1rem' }}>
          <strong>Somebody needs to touch the tablet.</strong> The controls below are for them: what went wrong is named
          at the top of this screen and the remedy is under it, and the camera can be asked for again as many times as it
          takes. Nothing about the prescription has been lost while this screen is up.
        </p>
      </div>

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
        {/* WHAT THE RECORD ACTUALLY DOES, which is not what this card used to promise.
            It said the run "will be stored in the history as a keyboard session" — a therapist reads
            that as "it will be in this patient's history, labelled". It is not: `store.addResult`
            re-files EVERY non-camera run onto the built-in "Device test (not a patient)" record
            (state/store.ts), because a keypress is not a rep this person performed, and a run filed
            under them would inflate their session count, spend their retention budget and sit in
            their clinical history reading "not measured". Two honest options existed — file it under
            the patient with a label, or say where it really goes. Filing it under the patient is the
            thing the identity work exists to prevent, so the sentence is what changes. */}
        <p className="muted" style={{ margin: 0 }}>
          The chart, the song and the scoring all work. What is lost is the whole rehab measurement: keys 1–4
          (or D F J K) stand in for the movements, so this session records <b>no range of motion</b>, and its
          reps are keypresses rather than movements the patient performed.
        </p>
        <p className="muted" style={{ margin: 0 }} data-testid="keyboard-record-note">
          So it is <b>not stored under {patientName ?? 'this patient'}</b>: it is filed on its own under
          “Device test (not a patient)”, it does not count as one of {patientName ? `${patientName}'s` : 'their'}{' '}
          sessions, and it never appears in the ROM trend. If the patient works through it, the work is real — the
          record of it is not, and the next camera session is the one that measures them.
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
