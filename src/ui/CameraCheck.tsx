import { useCallback, useEffect, useRef, useState } from 'react';
import { runtime } from '../session/runtime.ts';
import { laneFingertip, useStore } from '../state/store.ts';
import { MOVEMENT_INFO, requiredPostures } from '../vision/features.ts';
import { POSTURE_INFO } from '../vision/features.ts';
import type { VisionStatus } from '../input/types.ts';
import type { InvalidCalibration } from '../input/VisionInput.ts';
import type { DetectionResult } from '../vision/mediapipe.ts';
import { drawDetection } from './overlay.ts';
import CameraFallback from './CameraFallback.tsx';
import { Screen, Toast, TopBar } from './common.tsx';

export default function CameraCheck() {
  const goto = useStore((s) => s.goto);
  const mode = useStore((s) => s.mode);
  const lanes = useStore((s) => s.lanes);
  const calibrations = useStore((s) => s.calibrations);
  const difficulty = useStore((s) => s.difficulty);
  const settings = useStore((s) => s.settings);
  const updateSettings = useStore((s) => s.updateSettings);
  const setInputMode = useStore((s) => s.setInputMode);

  const holder = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const latest = useRef<DetectionResult | null>(null);
  const [status, setStatus] = useState<VisionStatus | null>(null);
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
      setStatus(vision.getStatus());
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

  // A camera that never started is not a corner of the camera-check screen — it is the screen.
  if (error !== null) return <CameraFallback error={error} onRetry={retry} />;

  return (
    <Screen>
      <TopBar
        eyebrow="Camera check"
        title="Frame the patient"
        onBack={() => goto('setup')}
        right={
          <button className="btn btn-primary btn-lg" onClick={() => goto('rom')} data-testid="camera-continue">
            Calibrate movement →
          </button>
        }
      />

      <div className="row" style={{ alignItems: 'flex-start', gap: 24 }}>
        {/* The preview (and the overlay with it) is always CSS-mirrored: the patient expects a mirror,
            and flipping both together keeps the landmarks on top of the limbs they came from. */}
        <div className="camera-frame mirror grow" ref={holder} style={{ maxWidth: 760 }}>
          <canvas ref={canvas} />
          {starting && (
            <div className="overlay" data-testid="camera-starting">
              <div className="card stack" style={{ maxWidth: 420 }}>
                <h3 style={{ margin: 0 }}>Starting the camera…</h3>
                <p className="muted" style={{ margin: 0 }}>
                  Asking the browser for the camera, then loading the movement model. The first run on a
                  device downloads that model (about 8 MB) and can take a minute; after that it is cached.
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
                  Lane {r.lane + 1} ({MOVEMENT_INFO[r.movement].label}) will not score:
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
                  Lane {i + 1}: {l.side === 'left' ? 'Left' : 'Right'} {MOVEMENT_INFO[l.movement].label}
                  {laneFingertip(l) ? ` (${laneFingertip(l)} finger)` : ''}
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
