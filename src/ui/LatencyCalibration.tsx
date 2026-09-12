/**
 * The latency screen — and, just as importantly, the screen EVERY next session passes through.
 *
 * The flow for a returning patient is New session → mode → setup → camera → ROM → here → play, so
 * whatever this screen leaves in the store is what the session is judged at. That makes its fast path
 * a clinical control, not a convenience:
 *
 *   SKIPPING KEEPS WHAT IS IN FORCE. It used to write the 120 ms default unconditionally, which meant
 *   an offset the therapist measured on the Results screen and applied FOR THIS SESSION was destroyed
 *   by the next screen of the same flow — while this screen simultaneously printed "current: 280 ms"
 *   in its sidebar. The default is now reachable only from the state it is for (nothing ever set on
 *   this device) and from a button that says out loud that it replaces the value it names.
 *
 * Every path off this screen therefore either KEEPS the offset in force, or names the number it is
 * about to store and the number that number replaces.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LatencyProbe, LatencyProbeResult } from '../audio/latencyProbe.ts';
import { formatDate } from '../session/results.ts';
import { runtime } from '../session/runtime.ts';
import { DEFAULT_LATENCY_SEC, laneFingertip, useStore } from '../state/store.ts';
import { movementInstructions } from '../vision/features.ts';
import { CameraPreview } from './CameraPreview.tsx';
import { DwellLegend, DwellTarget, singleDwellTarget, useDwellTargets } from './DwellTarget.tsx';
import type { DwellChoice } from './DwellTarget.tsx';
import { Screen, Toast, TopBar, laneName } from './common.tsx';

/** Measured clicks. Eight beats at 60 BPM is eight seconds of movement — as much as a patient will give. */
const BEATS = 8;

const DEFAULT_MS = Math.round(DEFAULT_LATENCY_SEC * 1000);

export default function LatencyCalibrationScreen() {
  const goto = useStore((s) => s.goto);
  const lanes = useStore((s) => s.lanes);
  const setLatency = useStore((s) => s.setLatency);
  const latencyOffsetSec = useStore((s) => s.latencyOffsetSec);
  const latencyMeasured = useStore((s) => s.latencyMeasured);
  const latencyNote = useStore((s) => s.latencyNote);
  const latencySetAt = useStore((s) => s.latencySetAt);
  // Where the hands-free target goes (a hand in hand mode, a knee in leg mode), and whether it breathes.
  const mode = useStore((s) => s.mode);
  const reducedMotion = useStore((s) => s.settings.reducedMotion);

  const probeRef = useRef<LatencyProbe | null>(null);
  const stopInput = useRef<(() => void) | null>(null);
  const [running, setRunning] = useState(false);
  const [beat, setBeat] = useState(0);
  const [taps, setTaps] = useState(0);
  const [result, setResult] = useState<LatencyProbeResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const lane0 = lanes[0];

  const cleanup = useCallback(() => {
    stopInput.current?.();
    stopInput.current = null;
    probeRef.current?.cancel();
    probeRef.current = null;
    setRunning(false);
  }, []);

  useEffect(() => cleanup, [cleanup]);

  const startProbe = async () => {
    setResult(null);
    setError(null);
    setTaps(0);
    try {
      const { mixer } = await runtime.ensureAudio();
      const probe = mixer.createLatencyProbe({ beats: BEATS });
      probeRef.current = probe;
      probe.start();
      setRunning(true);

      const vision = runtime.peekVision();
      if (vision) {
        stopInput.current = vision.onEvent((e) => {
          if (e.lane !== 0) return;
          probe.recordInput(e.ctxTime);
          setTaps((t) => t + 1);
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setRunning(false);
    }
  };

  // Visual metronome + completion, polled (never per frame — nothing here moves faster than a beat).
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => {
      const probe = probeRef.current;
      if (!probe) return;
      const idx = probe.nextClickIndex();
      setBeat(idx < 0 ? BEATS : idx);
      if (probe.isComplete()) {
        stopInput.current?.();
        stopInput.current = null;
        const r = probe.finish();
        probeRef.current = null;
        setRunning(false);
        setResult(r);
      }
    }, 60);
    return () => clearInterval(id);
  }, [running]);

  const accept = (sec: number, measured: boolean, note: string) => {
    setLatency(sec, measured, note);
    goto('play');
  };

  /** An offset is in force on this device (measured here, or applied from a run on the Results screen). */
  const inForce = latencySetAt !== null;
  const currentMs = Math.round(latencyOffsetSec * 1000);

  /**
   * Leave WITHOUT WRITING. This is the difference between "I have nothing to add" and "replace what
   * the therapist decided with a default" — the store is not touched, so the value applied for this
   * session is the value this session is judged at.
   */
  const keep = () => goto('play');

  /** The fast path: keep what is in force, or — only when nothing is — store the default. */
  const skip = () =>
    inForce
      ? keep()
      : accept(DEFAULT_LATENCY_SEC, false, `No latency has ever been measured on this device — the ${DEFAULT_MS} ms default was used`);
  const skipLabel = inForce ? `Skip, keep ${currentMs} ms →` : `Skip, use ${DEFAULT_MS} ms →`;

  // One sentence per fact, each ended: what the number is, when it was put in force, and what this
  // screen will do to it if the therapist walks past.
  const provenance = !inForce
    ? `Nothing has set an offset on this device yet, so skipping stores the ${DEFAULT_MS} ms default. It is a typical camera delay, not this camera's.`
    : [
        `${(latencyNote || (latencyMeasured ? 'Measured on this device' : 'Set without a measurement')).replace(/\.$/, '')}.`,
        latencySetAt ? `Put in force on this tablet ${formatDate(latencySetAt)}.` : '',
        'Skipping this screen keeps it — nothing here overwrites it unless you press a button that names the new number.',
      ]
        .filter(Boolean)
        .join(' ');

  /**
   * THE HANDS-FREE PATH THROUGH THE LATENCY CHECK.
   *
   * Both blocking presses on this screen are acknowledgements, and each gets the same target in turn:
   * before the probe it starts the metronome, after an acceptable probe it stores the number the
   * button names. The two GENUINE choices stay on their buttons — "measure again" and "discard the
   * offset in force and use the generic default" are therapist decisions about what this session is
   * judged at, and a discard in particular must never be reachable by a limb resting in the wrong
   * place. What the patient alone gets instead, when the probe produced nothing usable, is a target
   * that goes FORWARD on the offset already in force, naming it. Nobody is stranded, and nothing is
   * overwritten by a hold.
   *
   * No target is drawn while the metronome is running: the patient is doing a rep on every click, and
   * a target live during those eight seconds is exactly the accidental confirm this design refuses.
   */
  const dwellChoices: DwellChoice[] = useMemo(() => {
    if (running) return [];
    const target = singleDwellTarget(mode);
    if (!result) {
      return [{ id: 'start', target, label: 'Start', onConfirm: () => void startProbe() }];
    }
    if (result.accepted) {
      return [
        {
          id: 'accept',
          target,
          label: `Use ${Math.round(result.offsetSec * 1000)} ms`,
          onConfirm: () => accept(result.offsetSec, true, result.warning ? result.message : ''),
        },
      ];
    }
    return [
      {
        id: 'carry-on',
        target,
        label: inForce ? `Go on at ${currentMs} ms` : `Go on at ${DEFAULT_MS} ms`,
        onConfirm: skip,
      },
    ];
    // Same rule as the other screens: the hook keeps the live list and calls the current callback, so
    // rebuilding the trackers whenever a closure changes identity would discard a hold in progress.
  }, [running, result, mode, inForce, currentMs]);
  const dwell = useDwellTargets(dwellChoices);

  /** What the hold does right now, for the sentence beside the preview. */
  const dwellWhat = !result
    ? 'the circle to start the metronome'
    : result.accepted
      ? `the circle to use ${Math.round(result.offsetSec * 1000)} ms and start the song`
      : `the circle to go on at ${inForce ? currentMs : DEFAULT_MS} ms`;

  return (
    <Screen>
      <TopBar
        eyebrow="Latency check"
        title="Move on every click"
        onBack={() => goto('rom')}
        right={
          <button className="btn btn-ghost" onClick={skip} data-testid="latency-skip">
            {skipLabel}
          </button>
        }
      />

      <div className="row" style={{ alignItems: 'stretch', gap: 24 }}>
        <div className="card stack grow" style={{ gap: 18 }}>
          {/* THE PATIENT'S OWN WAY PAST THIS SCREEN. The preview is here rather than in the sidebar
              because it is the thing the patient has to see from the chair, and the sidebar is
              where the therapist's numbers live. */}
          {dwellChoices.length > 0 && (
            <div className="stack" style={{ gap: 12, width: 'min(440px, 100%)' }} data-testid="latency-handsfree">
              <CameraPreview overlay>
                {dwellChoices.map((choice) => (
                  <DwellTarget
                    key={choice.id}
                    choice={choice}
                    state={dwell.states[choice.id]}
                    reducedMotion={reducedMotion}
                    testId={`latency-dwell-${choice.id}`}
                  />
                ))}
              </CameraPreview>
              <DwellLegend session={dwell} what={dwellWhat} testId="latency-dwell-legend" />
            </div>
          )}
          {running && (
            <span className="dim" style={{ width: 'min(440px, 100%)' }} data-testid="latency-handsfree-paused">
              The hands-free circle is hidden while the metronome runs — you are moving on every click, and a target on
              screen during that would be confirmed by a repetition rather than by a decision. It comes back with the
              result.
            </span>
          )}
          {/* The patient is READ this while doing the reps that measure the delay. "do one finger
              opposition with the left side" does not say which digit, and on a two-pinch prescription
              the wrong finger measures a different quantity's latency. */}
          <p className="muted" data-testid="latency-instruction">
            {lane0
              ? `${laneName(lane0)}, on every click — ${movementInstructions(lane0.movement, laneFingertip(lane0))} ${BEATS} clicks after the count-in.`
              : 'Move on every click.'}
          </p>

          <div className="row" style={{ gap: 10 }} aria-label="metronome">
            {Array.from({ length: BEATS }, (_, i) => (
              <span
                key={i}
                className="badge"
                style={{
                  width: 44,
                  height: 44,
                  justifyContent: 'center',
                  borderColor: running && i === beat ? '#ff3d7f' : undefined,
                  background: running && i === beat ? 'rgba(255,61,127,0.35)' : undefined,
                }}
              >
                {i + 1}
              </span>
            ))}
            <div className="grow" />
            <span className="badge mono">{taps} movements seen</span>
          </div>

          {error && <Toast kind="bad">{error}</Toast>}

          {!running && !result && (
            <button className="btn btn-primary btn-lg" onClick={() => void startProbe()} data-testid="latency-start">
              Start the metronome
            </button>
          )}
          {running && <p className="muted">Listening… keep moving with the clicks.</p>}

          {/* WHAT THIS SCREEN IS FOR, under the controls rather than above them. It is context for
              the therapist, and putting it first pushed both the patient's circle and the therapist's
              own start button off the bottom of a 1024x768 tablet. */}
          <p className="muted" style={{ fontSize: '1.05rem' }}>
            A camera sees a movement 80–200 ms after it happens. This measures that delay so the game judges the movement,
            not the pipeline.
          </p>

          {result && (
            <div className="stack">
              <div className="row" style={{ alignItems: 'baseline', gap: 16 }}>
                <span className="big-number mono">{Math.round(result.apparentLagSec * 1000)} ms</span>
                <span className={result.accepted ? (result.warning ? 'badge badge-warn' : 'badge badge-ok') : 'badge badge-bad'}>
                  {result.accepted ? (result.warning ? 'measured, with a caveat' : 'confident') : 'not usable'}
                </span>
                <span className="dim mono">
                  {result.samples} of {result.totalClicks} beats paired · spread ±{Math.round((result.madSec ?? 0) * 1000)} ms
                </span>
              </div>
              <p className="muted">{result.message}</p>
              <div className="row">
                {result.accepted && (
                  <button
                    className="btn btn-primary btn-lg"
                    onClick={() => accept(result.offsetSec, true, result.warning ? result.message : '')}
                    data-testid="latency-accept"
                  >
                    Use {Math.round(result.offsetSec * 1000)} ms →
                  </button>
                )}
                <button className="btn" onClick={() => void startProbe()}>
                  Measure again
                </button>
                <button className="btn btn-ghost" onClick={skip} data-testid="latency-discard-result">
                  {inForce ? `Keep ${currentMs} ms` : `Use the ${DEFAULT_MS} ms default`}
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="card stack" style={{ width: 'min(340px, 100%)' }}>
          <h3>The offset in force</h3>
          {/* The number, WITH ITS PROVENANCE. A bare "current: 280 ms" badge cannot be judged: 280 ms
              measured from last Tuesday's run is a reason to skip, and 280 ms of unknown origin is a
              reason to re-measure. Both the label and the date come from the store, which now keeps
              them across a reload alongside the number they describe. */}
          <div className="row" style={{ alignItems: 'baseline', gap: 12 }}>
            <span className="big-number mono" data-testid="latency-current">
              {currentMs} ms
            </span>
            {inForce ? (
              <span className={latencyMeasured ? 'badge badge-ok' : 'badge badge-warn'}>
                {latencyMeasured ? 'measured' : 'not measured'}
              </span>
            ) : (
              <span className="badge badge-warn">nothing set yet</span>
            )}
          </div>
          <p className="muted" data-testid="latency-provenance">
            {provenance}
          </p>

          <p className="muted">
            An uncorrected offset does not look like a latency problem: it looks like a patient who cannot hit anything.
            The Results screen reports the timing bias it measured during play, so a bad calibration is visible afterwards
            too.
          </p>

          {/* The only path on this screen that throws the offset away, and it says so on the button. */}
          {inForce && currentMs !== DEFAULT_MS && (
            <div className="stack" style={{ gap: 8 }}>
              <button
                className="btn"
                data-testid="latency-use-default"
                onClick={() =>
                  accept(DEFAULT_LATENCY_SEC, false, `${DEFAULT_MS} ms default used — the ${currentMs} ms previously in force was discarded`)
                }
              >
                Discard it, use {DEFAULT_MS} ms
              </button>
              <span className="muted" style={{ fontSize: '0.92rem' }}>
                Replaces the {currentMs} ms above with the generic default. Only worth doing if the camera or the tablet
                has changed and there is no time to re-measure.
              </span>
            </div>
          )}
        </div>
      </div>
    </Screen>
  );
}
