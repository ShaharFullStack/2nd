import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { windowsForLanes } from '../engine/difficulty.ts';
import { runtime } from '../session/runtime.ts';
import { TrackingRecorder, cameraReadiness } from '../session/tracking.ts';
import type { DeviceReadiness } from '../session/tracking.ts';
import type { TrackingQuality } from '../session/types.ts';
import { useStore } from '../state/store.ts';
import { requiredPostures } from '../vision/features.ts';
import { POSTURE_INFO } from '../vision/features.ts';
import type { VisionStatus } from '../input/types.ts';
import type { InvalidCalibration } from '../input/VisionInput.ts';
import type { DetectionResult } from '../vision/mediapipe.ts';
import { drawDetection } from './overlay.ts';
import CameraFallback from './CameraFallback.tsx';
import { DwellLegend, DwellTarget, singleDwellTarget, useDwellTargets } from './DwellTarget.tsx';
import type { DwellChoice } from './DwellTarget.tsx';
import { Screen, Toast, TopBar, laneName } from './common.tsx';

export default function CameraCheck() {
  const goto = useStore((s) => s.goto);
  const mode = useStore((s) => s.mode);
  const lanes = useStore((s) => s.lanes);
  const calibrations = useStore((s) => s.calibrations);
  const difficulty = useStore((s) => s.difficulty);
  const windowScale = useStore((s) => s.windowScale);
  const settings = useStore((s) => s.settings);
  const updateSettings = useStore((s) => s.updateSettings);
  const setInputMode = useStore((s) => s.setInputMode);

  const holder = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const latest = useRef<DetectionResult | null>(null);
  const [status, setStatus] = useState<VisionStatus | null>(null);
  /**
   * WHAT THIS DEVICE IS ACTUALLY DOING, accumulated rather than glanced at.
   *
   * A single `getStatus()` is one 300 ms window and flickers between "person detected" and not on
   * every frame the model loses; a decision about whether an appointment can be spent here cannot be
   * taken off one of those. This is the SAME recorder the play screen uses to write the session's
   * tracking block, so what this screen promises and what the record later reports are graded by one
   * rule. Reset on every retry, because a new camera is a new device as far as this claim goes.
   */
  const recorder = useRef(new TrackingRecorder());
  const [observed, setObserved] = useState<TrackingQuality | null>(null);
  /** Lanes the runtime is refusing to score, with the reason (see the refusal block in the panel). */
  const [refusals, setRefusals] = useState<InvalidCalibration[]>([]);
  /** The thrown value, not a string: CameraFallback classifies a DOMException by its `name`. */
  const [error, setError] = useState<unknown>(null);
  const [starting, setStarting] = useState(true);
  /** Bumped by Retry to re-run the effect, which builds a NEW VisionInput and re-requests the device. */
  const [attempt, setAttempt] = useState(0);
  /** ctx-free wall clock of the attempt in flight, so the overlay can say how long it has been. */
  const [startedAt, setStartedAt] = useState(() => Date.now());
  const [elapsed, setElapsed] = useState(0);
  /** The in-flight ensureVision promise: Retry awaits THIS, not a fixed delay. */
  const attemptRef = useRef<Promise<unknown> | null>(null);

  useEffect(() => {
    let alive = true;
    let unsubscribe: (() => void) | null = null;
    let raf = 0;

    const paint = () => {
      const c = canvas.current;
      const ctx = c?.getContext('2d');
      if (c && ctx) {
        const w = c.clientWidth || 640;
        const h = c.clientHeight || 480;
        if (c.width !== w || c.height !== h) {
          c.width = w;
          c.height = h;
        }
        drawDetection(ctx, latest.current, c.width, c.height);
      }
      raf = requestAnimationFrame(paint);
    };

    const attempting = runtime.ensureVision({ mode, lanes, calibrations, difficulty, mirrored: settings.mirrored });
    attemptRef.current = attempting;
    attempting
      .then((vision) => {
        if (!alive) return;
        setStarting(false);
        setError(null);
        const video = vision.getVideoElement();
        if (video && holder.current && video.parentElement !== holder.current) {
          video.setAttribute('playsinline', '');
          video.muted = true;
          holder.current.prepend(video);
        }
        unsubscribe = vision.onFrame((_samples, _ctxTime, result) => {
          latest.current = result;
        });
        raf = requestAnimationFrame(paint);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setStarting(false);
        setError(err);
      });

    const poll = setInterval(() => {
      const vision = runtime.peekVision();
      if (!vision) return;
      const s = vision.getStatus();
      setStatus(s);
      recorder.current.sample(s);
      setObserved(recorder.current.summary());
      const bad = vision.getInvalidCalibrations();
      setRefusals((prev) =>
        prev.length === bad.length && prev.every((r, i) => r.lane === bad[i].lane && r.reason === bad[i].reason)
          ? prev
          : bad,
      );
    }, 300);

    return () => {
      alive = false;
      clearInterval(poll);
      if (raf) cancelAnimationFrame(raf);
      unsubscribe?.();
      // Reset on teardown so a restart (mirror toggle, lane change) shows "starting" again.
      setStarting(true);
      setStatus(null);
      setRefusals([]);
      recorder.current = new TrackingRecorder();
      setObserved(null);
    };
  }, [mode, lanes, calibrations, difficulty, settings.mirrored, attempt]);

  /**
   * Retry means RE-REQUEST, not re-render: the failed VisionInput is disposed so `ensureVision`
   * cannot hand back a dead one, then the effect re-runs and calls getUserMedia (and re-builds the
   * detector) from scratch. Awaited so the button can stay in its "asking…" state until it settles.
   */
  const retry = useCallback(async () => {
    const before = attemptRef.current;
    runtime.disposeVision();
    setError(null);
    setStatus(null);
    setRefusals([]);
    recorder.current = new TrackingRecorder();
    setObserved(null);
    setStarting(true);
    setStartedAt(Date.now());
    setAttempt((n) => n + 1);
    // Wait for the effect's teardown/setup pair to publish the NEW attempt, then await THAT — the
    // button's "asking…" state has to describe the real request. A fixed 350 ms delay re-enabled the
    // button a third of a second into a request that can take 45 s on a cold model download.
    for (let i = 0; i < 60 && attemptRef.current === before; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    await attemptRef.current?.catch(() => undefined);
  }, []);

  // A therapist with 90 seconds between patients may not be left on an unexplained spinner: the wait
  // is named, counted, and has both a way out and a labelled downgrade once it stops looking normal.
  useEffect(() => {
    if (!starting) return;
    setElapsed(Math.round((Date.now() - startedAt) / 1000));
    const t = setInterval(() => setElapsed(Math.round((Date.now() - startedAt) / 1000)), 500);
    return () => clearInterval(t);
  }, [starting, startedAt]);

  const tracking = status?.tracking === true;
  const postures = requiredPostures(lanes);

  /**
   * THE NARROWEST WINDOWS THIS PRESCRIPTION ACTUALLY GRANTS. Not the difficulty's base numbers: a
   * fine-motor lane gets ×1.6 and the therapist's window scale multiplies both, so the lane that
   * first stops being reachable is the one with the smallest window in force. That is the lane the
   * promise on this screen has to be made about.
   */
  const windows = useMemo(() => {
    if (lanes.length === 0) return { perfectMs: 0, goodMs: 0, difficulty };
    const per = windowsForLanes(lanes, difficulty, windowScale);
    return {
      perfectMs: Math.round(Math.min(...per.map((w) => w.perfectMs))),
      goodMs: Math.round(Math.min(...per.map((w) => w.goodMs))),
      difficulty,
    };
  }, [lanes, difficulty, windowScale]);

  const readiness: DeviceReadiness = useMemo(
    () => cameraReadiness(starting ? null : observed, windows),
    [starting, observed, windows],
  );

  /**
   * THE HANDS-FREE PATH PAST THIS SCREEN.
   *
   * `camera-continue` is an acknowledgement, not a choice — its gate is already computed from what
   * vision is reporting (`readiness.gate`) — so the patient holding a limb over the target confirms
   * exactly what the button confirms, under exactly the same gate. The button stays: a therapist in
   * the room is faster with it, and it is the only path while the readiness gate is closed.
   */
  const dwellChoices: DwellChoice[] = useMemo(
    () => [
      {
        id: 'continue',
        target: singleDwellTarget(mode),
        label: 'Continue',
        enabled: !readiness.gate && !starting,
        disabledNote: 'Not yet',
        onConfirm: () => goto('rom'),
      },
    ],
    [mode, readiness.gate, starting, goto],
  );
  const dwell = useDwellTargets(dwellChoices);

  // A camera that never started is not a corner of the camera-check screen — it is the screen.
  if (error !== null) return <CameraFallback error={error} onRetry={retry} retries={attempt} />;

  return (
    <Screen>
      <TopBar
        eyebrow="Camera check"
        title="Frame the patient"
        onBack={() => goto('setup')}
        right={
          /* THE GATE. Not a nag: at this point the next screen measures a rest position and three
             repetitions off landmarks that are not arriving, or off frames further apart than the
             widest hit window the prescription grants — an appointment spent to find out. It fires
             only on a positive finding and every one of them clears by itself. */
          <button
            className="btn btn-primary btn-lg"
            onClick={() => goto('rom')}
            disabled={readiness.gate}
            title={readiness.gate ? readiness.headline : undefined}
            data-testid="camera-continue"
          >
            Calibrate movement →
          </button>
        }
      />

      <div className="row" style={{ alignItems: 'flex-start', gap: 24 }}>
        <div className="stack grow" style={{ gap: 14, maxWidth: 760 }}>
        {/* The preview (and the overlay with it) is always CSS-mirrored: the patient expects a mirror,
            and flipping both together keeps the landmarks on top of the limbs they came from. */}
        <div className="camera-frame mirror" ref={holder}>
          <canvas ref={canvas} />
          {!starting &&
            dwellChoices.map((choice) => (
              <DwellTarget
                key={choice.id}
                choice={choice}
                state={dwell.states[choice.id]}
                reducedMotion={settings.reducedMotion}
                testId={`camera-dwell-${choice.id}`}
              />
            ))}
          {starting && (
            <div className="overlay" data-testid="camera-starting">
              <div className="card stack" style={{ maxWidth: 420 }}>
                <h3 style={{ margin: 0 }}>Starting the camera…</h3>
                <p className="muted" style={{ margin: 0 }}>
                  Asking the browser for the camera, then loading the MediaPipe runtime and the movement
                  model. The first run on a device transfers both — {mode === 'leg' ? '17 MB' : '19 MB'} in
                  this mode ({mode === 'leg' ? '11.5 MB of runtime plus a 5.5 MB pose model' : '11.5 MB of runtime plus a 7.5 MB hand model'}) —
                  and can take a minute on a clinic link; after that it is cached and this step is instant.
                </p>
                <div className="row">
                  <span className="badge mono" data-testid="camera-elapsed">
                    {elapsed}s
                  </span>
                  {elapsed >= 10 && <span className="badge badge-warn">longer than usual</span>}
                </div>
                {elapsed >= 10 && (
                  <>
                    <span className="dim">
                      If no permission prompt appeared, the browser may have blocked it silently — check the
                      camera icon in the address bar, then start over.
                    </span>
                    <div className="row">
                      <button className="btn" onClick={() => void retry()} data-testid="camera-start-over">
                        Start over
                      </button>
                      <button
                        className="btn btn-ghost"
                        onClick={() => {
                          runtime.disposeVision();
                          setInputMode('keyboard');
                          goto('play');
                        }}
                        data-testid="camera-starting-keyboard"
                      >
                        Run on the keyboard instead (no range of motion is measured)
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
        </div>

        {/* THE SENTENCE THE RING CANNOT CARRY: what the hold does, and which limb it is following.
            It sits under the preview because that is where the patient is already looking. */}
        {!starting && <DwellLegend session={dwell} what="to go on to the range check" testId="camera-dwell-legend" />}
        </div>

        <div className="stack" style={{ width: 'min(380px, 100%)' }}>
          <div className="card stack">
            <h3>Tracking</h3>
            <div className="row">
              <span className={tracking ? 'badge badge-ok' : 'badge badge-warn'}>
                {tracking ? (mode === 'leg' ? 'Person detected' : 'Hand detected') : (status?.message ?? 'Looking…')}
              </span>
            </div>
            <div className="row">
              <span className="badge mono">{status ? `${status.fps.toFixed(0)} fps` : '– fps'}</span>
              <span className="badge mono">{status ? `${status.inferenceMs.toFixed(0)} ms/frame` : '– ms'}</span>
              <span className="badge">{status?.delegate ?? 'starting'}</span>
            </div>
            {/* A REFUSAL is not a warning: the lane is dead until it is re-calibrated, and the most
                common way to earn one is on THIS screen — flipping the mirror switch below makes every
                stored range describe the other limb. It is shown here, with the way out. */}
            {refusals.map((r) => (
              <Toast kind="bad" key={r.lane}>
                <strong data-testid={`camera-refusal-${r.lane}`}>
                  Lane {r.lane + 1} ({laneName(lanes[r.lane] ?? r)}) will not score:
                </strong>{' '}
                {r.reason}.
              </Toast>
            ))}
            {refusals.length > 0 && (
              <button className="btn btn-primary" onClick={() => goto('rom')} data-testid="camera-recalibrate">
                Re-calibrate {refusals.length > 1 ? 'these lanes' : 'this lane'} →
              </button>
            )}
            {/* SOFT calibration/compensation warnings are guaranteed here — ROM calibration is the NEXT
                screen — so they would train the therapist to ignore this panel. They belong (and are
                shown) on the calibration screen itself. Refusals, above, do not: they are not fixed by
                walking forward, and nothing downstream used to show them at all. */}
            {status?.warnings
              ?.filter((w) => !/calibrat|compensation/i.test(w))
              .slice(0, 3)
              .map((w, i) => (
                <Toast key={i}>{w}</Toast>
              ))}
          </div>

          {/*
            WHAT THIS DEVICE WILL AND WILL NOT SUPPORT — the statement this screen did not make.
            Everywhere else in the flow either gates or says what comes next; here a therapist could
            walk a patient forward off a stream running at 1–2 fps with nothing detected, and find out
            at the end of the appointment. It is built from the same rolling observation the session's
            own tracking block is built from, so the promise and the later record cannot disagree.
          */}
          <div
            className="card stack"
            style={readiness.kind === 'blocked' ? { borderColor: 'var(--bad)' } : undefined}
            data-testid="camera-readiness"
            data-readiness={readiness.kind}
          >
            <div className="row">
              <h3 style={{ margin: 0 }}>This device</h3>
              <div className="grow" />
              <span
                className={
                  readiness.kind === 'ready'
                    ? 'badge badge-ok'
                    : readiness.kind === 'blocked'
                      ? 'badge badge-bad'
                      : readiness.kind === 'degraded'
                        ? 'badge badge-warn'
                        : 'badge'
                }
                data-testid="camera-readiness-badge"
              >
                {readiness.kind === 'measuring' ? 'checking' : readiness.kind}
              </span>
            </div>
            <p style={{ margin: 0 }} data-testid="camera-readiness-headline">
              {readiness.headline}
            </p>
            {readiness.will.length > 0 && (
              <ul className="list-reset dim" data-testid="camera-readiness-will">
                {readiness.will.map((line, i) => (
                  <li key={i}>✓ {line}</li>
                ))}
              </ul>
            )}
            {readiness.wont.length > 0 && (
              <ul className="list-reset" data-testid="camera-readiness-wont">
                {readiness.wont.map((line, i) => (
                  <li key={i}>✕ {line}</li>
                ))}
              </ul>
            )}
            {readiness.action && (
              <span className="dim" data-testid="camera-readiness-action">
                {readiness.action}
              </span>
            )}
            {/* A GATE MUST NOT BE A DEAD END. The camera can be re-requested, and a keyboard run
                still plays the song — it simply measures no range of motion, and says so. */}
            {readiness.gate && readiness.kind === 'blocked' && (
              <div className="row">
                <button className="btn" onClick={() => void retry()} data-testid="camera-readiness-retry">
                  Restart the camera
                </button>
                <button
                  className="btn btn-ghost"
                  onClick={() => {
                    runtime.disposeVision();
                    setInputMode('keyboard');
                    goto('play');
                  }}
                  data-testid="camera-readiness-keyboard"
                >
                  Run on the keyboard instead (no range of motion is measured)
                </button>
              </div>
            )}
          </div>

          <div className="card stack">
            <h3>Set up</h3>
            {postures.map((p) => (
              <p key={p} className="muted">
                {POSTURE_INFO[p].setup}
              </p>
            ))}
            <ul className="list-reset dim">
              {lanes.map((l, i) => (
                <li key={i}>
                  Lane {i + 1}: {laneName(l)}
                </li>
              ))}
            </ul>
            <label className="switch">
              <input
                type="checkbox"
                checked={settings.mirrored}
                onChange={(e) => updateSettings({ mirrored: e.target.checked })}
              />
              <span>Frames are mirrored before tracking</span>
            </label>
            <span className="dim">
              The preview is always shown mirrored (that is what a patient expects). This switch changes which LIMB each
              lane reads — only turn it on if the capture itself is flipped, and calibrate again after changing it.
            </span>
          </div>
        </div>
      </div>
    </Screen>
  );
}
