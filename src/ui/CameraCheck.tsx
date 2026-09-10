import { useEffect, useRef, useState } from 'react';
import { runtime } from '../session/runtime.ts';
import { useStore } from '../state/store.ts';
import { MOVEMENT_INFO, requiredPostures } from '../vision/features.ts';
import { POSTURE_INFO } from '../vision/features.ts';
import type { VisionStatus } from '../input/types.ts';
import type { DetectionResult } from '../vision/mediapipe.ts';
import { drawDetection } from './overlay.ts';
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
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(true);

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

    runtime
      .ensureVision({ mode, lanes, calibrations, difficulty, mirrored: settings.mirrored })
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
        setError(err instanceof Error ? err.message : String(err));
      });

    const poll = setInterval(() => {
      const vision = runtime.peekVision();
      if (vision) setStatus(vision.getStatus());
    }, 300);

    return () => {
      alive = false;
      clearInterval(poll);
      if (raf) cancelAnimationFrame(raf);
      unsubscribe?.();
      // Reset on teardown so a restart (mirror toggle, lane change) shows "starting" again.
      setStarting(true);
      setStatus(null);
    };
  }, [mode, lanes, calibrations, difficulty, settings.mirrored]);

  const tracking = status?.tracking === true;
  const postures = requiredPostures(lanes);

  return (
    <Screen>
      <TopBar
        eyebrow="Camera check"
        title="Frame the patient"
        onBack={() => goto('setup')}
        right={
          <button className="btn btn-primary btn-lg" onClick={() => goto('rom')} disabled={!!error} data-testid="camera-continue">
            Calibrate movement →
          </button>
        }
      />

      <div className="row" style={{ alignItems: 'flex-start', gap: 24 }}>
        {/* The preview (and the overlay with it) is always CSS-mirrored: the patient expects a mirror,
            and flipping both together keeps the landmarks on top of the limbs they came from. */}
        <div className="camera-frame mirror grow" ref={holder} style={{ maxWidth: 760 }}>
          <canvas ref={canvas} />
          {starting && <div className="overlay">Starting camera…</div>}
          {error && (
            <div className="overlay">
              <div className="card stack">
                <h3>No camera</h3>
                <p className="muted">{error}</p>
                <button
                  className="btn"
                  onClick={() => {
                    setInputMode('keyboard');
                    goto('play');
                  }}
                >
                  Play with the keyboard instead
                </button>
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
            {/* Calibration/compensation warnings are guaranteed here — ROM calibration is the NEXT
                screen — so they would train the therapist to ignore this panel. They belong (and are
                shown) on the calibration screen itself. */}
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
