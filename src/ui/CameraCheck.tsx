import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { windowsForLanes } from '../engine/difficulty.ts';
import { runtime } from '../session/runtime.ts';
import { READINESS_SAMPLES, TrackingRecorder, cameraReadiness } from '../session/tracking.ts';
import type { DeviceReadiness } from '../session/tracking.ts';
import type { TrackingQuality } from '../session/types.ts';
import { useStore } from '../state/store.ts';
import { requiredPostures } from '../vision/features.ts';
import { POSTURE_INFO } from '../vision/features.ts';
import type { VisionStatus } from '../input/types.ts';
import type { InvalidCalibration } from '../input/VisionInput.ts';
import type { DetectionResult } from '../vision/mediapipe.ts';
import { drawDetection, liveFrameAspect } from './overlay.ts';
import CameraFallback from './CameraFallback.tsx';
import { DwellLegend, DwellTarget, pairedDwellTargets, useDwellTargets } from './DwellTarget.tsx';
import type { DwellChoice } from './DwellTarget.tsx';
import { Screen, Toast, TopBar, laneName } from './common.tsx';

/**
 * A REMEDY MAY NOT CONTRADICT THE BADGE NEXT TO IT.
 *
 * The input layer's duty-cycling warning ends "Lower the difficulty or use a machine with graphics
 * acceleration" (src/input/VisionInput.ts). On a machine ALREADY on the GPU delegate that sentence
 * sits three lines under a badge reading "GPU", telling the therapist to go and get the thing they
 * have. The warning is right about everything else and is written where the measurement is taken, so
 * it is not suppressed — only the one clause that is false on this device is replaced, and anything
 * that does not match is passed through untouched.
 *
 * (The source sentence should say this itself; that file is not this screen's to edit.)
 */
export function reconcileDelegateHint(warning: string, delegate: 'GPU' | 'CPU' | null): string {
  if (delegate !== 'GPU') return warning;
  return warning.replace(
    /Lower the difficulty or use a machine with graphics acceleration\./,
    'This machine is already using the GPU, so graphics acceleration is not the remedy: lower the difficulty, close other tabs, or use a machine that can run this model faster.',
  );
}

/**
 * THE FRAME RATE, PRINTED SO IT CANNOT CONTRADICT THE NUMBER BESIDE IT.
 *
 * This screen showed `fps.toFixed(0)`, and on the device this app is hardest on that printed
 * "0 fps" next to "5244 ms/frame". Both were true — 0.19 rounds to 0 — and together they read as a
 * contradiction on the one screen whose whole job is to state what this device can do: a therapist
 * reads "0 fps" as "nothing is arriving" while the preview beside it is visibly, slowly moving, and
 * the remedy for a stalled camera is not the remedy for a slow one.
 *
 * So the precision follows the magnitude, and a rate of zero says "no frames" rather than printing a
 * number: zero is not a slow rate, it is the absence of one, and the two have different remedies.
 * (It is deliberately not "no frames YET": the same reading appears when a camera that was working
 * stops, and this badge cannot tell the two apart — the readiness card beside it can.)
 */
export function formatFps(fps: number | null | undefined): string {
  if (fps === null || fps === undefined || !Number.isFinite(fps)) return '– fps';
  if (fps <= 0) return 'no frames';
  if (fps >= 10) return `${fps.toFixed(0)} fps`;
  if (fps >= 1) return `${fps.toFixed(1)} fps`;
  return `${fps.toFixed(2)} fps`;
}

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
  /**
   * Share of the same readings in which AT LEAST ONE prescribed lane had landmarks — the difference
   * between "nothing is being tracked" and "one hand of a bilateral prescription has drifted out",
   * which this screen used to print the first sentence for over a preview drawing the second.
   */
  const [anyLandmarks, setAnyLandmarks] = useState<number | null>(null);
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
        // THE SHAPE OF THE FRAMES THESE LANDMARKS CAME FROM, asked of the camera every frame (it can
        // change mid-stream, and it is 0x0 until metadata lands). Without it the skeleton is painted
        // as if the sensor were the 4:3 the app asked for, while the <video> under it is cropped to
        // fill the box — so on a 16:9 webcam the dots sit ~0.6 of a dwell radius inboard of the limb
        // they came from, and a patient aiming at the dot misses the circle the tracker tests.
        drawDetection(ctx, latest.current, c.width, c.height, liveFrameAspect());
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
      // The lane count is what lets the recorder tell "no limb at all" from "one of two limbs has
      // drifted out of frame" — `VisionStatus.tracking` is every lane at once and cannot.
      recorder.current.sample(s, lanes.length);
      // THE VERDICT IS TAKEN OVER THE LAST FEW SECONDS, NOT OVER THE WHOLE VISIT. See
      // `TrackingRecorder.recent`: a cumulative median cannot come back, so a tablet that was busy
      // when this screen opened could never clear the gate again however well it ran afterwards.
      setObserved(recorder.current.recent());
      setAnyLandmarks(recorder.current.anyLandmarksFraction());
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
      setAnyLandmarks(null);
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
    setAnyLandmarks(null);
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
  /**
   * `VisionStatus.tracking` IS "EVERY LANE AT ONCE" (src/input/types.ts) — so on a bilateral
   * prescription one hand leaving the frame turns this badge off while the preview goes on drawing a
   * perfectly tracked skeleton of the other. The badge now says which of the two states it is in and
   * names the lane, because "not detected" over a visibly tracked limb is the screen contradicting
   * its own picture.
   */
  const partlyTracked =
    status !== null && !tracking && (status.untrackedLanes?.length ?? lanes.length) < lanes.length;
  const trackingBadge = (() => {
    if (tracking) return mode === 'leg' ? 'Person detected' : 'Hand detected';
    if (partlyTracked) {
      const missing = status?.untrackedLanes ?? [];
      const names = missing.map((i) => {
        const spec = lanes[i];
        return spec ? `lane ${i + 1} (${laneName(spec)})` : `lane ${i + 1}`;
      });
      return `Partly in frame — no landmarks for ${names.join(', ')}`;
    }
    return status?.message ?? 'Looking…';
  })();
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

  /**
   * IS THERE ANYTHING FOR THE CIRCLES TO FOLLOW — measured, before the patient is left alone.
   *
   * Readiness used to be about the DEVICE and the prescribed lanes only, so this screen could pass a
   * camera as ready, hand a patient a hands-free session, and leave them holding a limb at a ring that
   * cannot fill. In leg mode that is not an edge case but the common one: the dwell pointer is a HAND
   * (a knee cannot answer — vision/dwell.ts), and the app's own framing instruction talked about hips,
   * knees and feet. A patient who followed it had no pointer at all.
   *
   * So the verdict is told whether a pointer EXISTS, from the same session the rings are driven from —
   * `dwell.limb` is literally what the ring is following — sampled over the same rolling window the
   * rest of the verdict uses rather than glanced at, because a hand passing behind a knee for one frame
   * is not a patient with no hand. Nothing is claimed until the window is full, and a camera restart
   * starts a new one (a new framing is a new question).
   *
   * It WARNS rather than gates; the justification is in `withPointerVerdict`, and the short version is
   * that the hands-free escapes a blocked verdict is required to leave are these very circles.
   */
  const [pointerFraction, setPointerFraction] = useState<number | null>(null);
  const pointerNow = useRef<boolean | null>(null);

  const readiness: DeviceReadiness = useMemo(
    () =>
      cameraReadiness(starting ? null : observed, windows, {
        anyLandmarksFraction: anyLandmarks,
        pointer: pointerFraction === null ? null : { fraction: pointerFraction, mode },
      }),
    [starting, observed, windows, anyLandmarks, pointerFraction, mode],
  );

  /**
   * THE HANDS-FREE PATH PAST THIS SCREEN — AND BACK.
   *
   * WHAT THIS USED TO BE, AND WHY IT WAS THE WORST BUG IN THE FEATURE. There was one target, and it
   * was `enabled: !readiness.gate`. A disabled choice gets no tracker at all, so its phase is 'off'
   * and its progress is pinned at 0: the ring is STRUCTURALLY INCAPABLE of filling, and no amount of
   * holding does anything. The gate closes whenever one frame interval exceeds the widest hit window
   * in force — on `hard` that is anything under 9 fps, which MediaPipe Pose on a CPU-delegate clinic
   * tablet sits at routinely — and every escape from it was a button roughly 400 px below the fold
   * at 1024x768. A patient alone on a blocked camera check had no way forward and no way back: the
   * hands-free claim failed on its first screen.
   *
   * WHAT IT IS NOW. Two targets, ALWAYS enabled once the camera is up, drawn on the preview, which
   * is the top of the screen:
   *
   *  - FORWARD. When the device passes, it says "Continue" and means it. When the device is BLOCKED
   *    it says "Go on anyway" — because a device too slow to place a repetition inside a hit window
   *    is still perfectly able to track a limb parked on a circle, so the gate is a statement about
   *    the MEASUREMENT and not about the patient's ability to answer. What it costs is said in the
   *    patient's own words beside the preview (`blockedNote`) rather than left in a card they would
   *    have to scroll to: the session still plays and the movements are still recorded, the timing
   *    and the ranges are qualified, and nothing here pretends otherwise.
   *  - BACK. "Restart the camera" — the same `retry` the button performs, which is the only thing
   *    that fixes a camera that came up wrong, and which a patient alone could previously only reach
   *    by touching the tablet. Reversal has to be at least as reachable as activation, and on this
   *    screen the thing to reverse is a device verdict.
   *
   * The gate still gates the THERAPIST's primary button — that is what stops an appointment being
   * spent on a stream that cannot be measured — and the "Go on anyway" it now names is deliberately
   * a second, differently worded control rather than the green one.
   */
  const dwellChoices: DwellChoice[] = useMemo(() => {
    if (starting) return [];
    const [go, back] = pairedDwellTargets(mode);
    return [
      {
        id: 'continue',
        target: go,
        label: readiness.gate ? 'Go on anyway' : 'Continue',
        onConfirm: () => goto('rom'),
        tone: 'go',
      },
      {
        id: 'restart',
        target: back,
        label: 'Restart camera',
        onConfirm: () => void retry(),
        tone: 'back',
      },
    ];
  }, [mode, readiness.gate, starting, goto, retry]);
  const dwell = useDwellTargets(dwellChoices);
  /**
   * The ring's own pointer, read every render and averaged on the poll below. `null` = the dwell
   * session has no frames at all, and then NOTHING is claimed about a hand: "no hand is in the
   * picture" would be blaming the framing for a camera that has stopped delivering, which is a
   * different fault with a different remedy — and one the device verdict beside it already names.
   */
  pointerNow.current = dwell.live ? dwell.limb !== null : null;
  useEffect(() => {
    if (starting) {
      setPointerFraction(null);
      return;
    }
    let seen: boolean[] = [];
    const id = setInterval(() => {
      const now = pointerNow.current;
      if (now === null) {
        seen = [];
        setPointerFraction(null);
        return;
      }
      seen.push(now);
      if (seen.length > READINESS_SAMPLES) seen.shift();
      // Nothing is said until the window is full: "no hand yet" is how every check starts.
      setPointerFraction(seen.length < READINESS_SAMPLES ? null : seen.filter(Boolean).length / seen.length);
    }, 300);
    return () => clearInterval(id);
  }, [starting, attempt]);

  /**
   * WHAT GOING ON ANYWAY COSTS, said where the patient is already looking.
   *
   * The readiness card states this in full, on the right, below the fold at clinic-tablet heights.
   * A hands-free choice whose consequences are only legible to somebody who can scroll is not a
   * choice the patient made. This is the same verdict, in one sentence, under the preview.
   */
  const blockedNote = readiness.gate && readiness.kind === 'blocked' ? readiness.headline : null;

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
        {/* 520 px, not 760: at 1024x768 a 4:3 preview as wide as the column put the sentence that says
            which circle does what — and the limb the app is following — off the bottom of the screen.
            The targets are a fraction of the frame, so they scale with it and stay reachable. */}
        <div className="stack grow" style={{ gap: 14, maxWidth: 520 }}>
        {/* The preview (and the overlay with it) is always CSS-mirrored: the patient expects a mirror,
            and flipping both together keeps the landmarks on top of the limbs they came from. */}
        <div className="camera-frame mirror" ref={holder}>
          <canvas ref={canvas} />
          {dwellChoices.map((choice) => (
            <DwellTarget
              key={choice.id}
              choice={choice}
              state={dwell.states[choice.id]}
              reducedMotion={settings.reducedMotion}
              xScale={dwell.xScale}
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

        {/* THE VERDICT, ABOVE THE FOLD. Whatever this screen refuses to promise, the patient reads it
            here — beside the preview they are already looking at and beside the circle that acts on
            it — and not only in the card on the right, which at 1024x768 is below the fold. */}
        {blockedNote && (
          <Toast kind="bad">
            <strong data-testid="camera-blocked-note">{blockedNote}</strong> Left circle: go on anyway — the song plays
            and every movement is still counted, but today&rsquo;s timing and ranges carry that. Right circle: restart the
            camera.
          </Toast>
        )}

        {/* THE SENTENCE THE RING CANNOT CARRY: what the hold does, and which limb it is following.
            It sits under the preview because that is where the patient is already looking. */}
        {!starting && (
          <DwellLegend
            session={dwell}
            what={
              readiness.gate
                ? 'the left circle to go on anyway, the right one to restart the camera'
                : 'the left circle to go on to the range check, the right one to restart the camera'
            }
            testId="camera-dwell-legend"
          />
        )}
        </div>

        <div className="stack" style={{ width: 'min(380px, 100%)' }}>
          <div className="card stack">
            <h3>Tracking</h3>
            <div className="row">
              <span className={tracking ? 'badge badge-ok' : 'badge badge-warn'} data-testid="camera-tracking-badge">
                {trackingBadge}
              </span>
            </div>
            <div className="row">
              <span className="badge mono" data-testid="camera-fps">{status ? formatFps(status.fps) : '– fps'}</span>
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
                <Toast key={i}>{reconcileDelegateHint(w, status?.delegate ?? null)}</Toast>
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
                {/* THE SAME CHOICE THE PATIENT HAS. The hands-free target above can go on from a
                    blocked device, so the therapist must be able to as well — differently worded and
                    not the primary green button, because the gate's job is to stop somebody walking
                    forward UNAWARE, not to make the decision for them. */}
                <button
                  className="btn"
                  onClick={() => goto('rom')}
                  title={readiness.wont.join(' ')}
                  data-testid="camera-readiness-continue-anyway"
                >
                  Go on anyway (nothing above is measured any better)
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
