import { useCallback, useEffect, useRef, useState } from 'react';
import type { LatencyProbe, LatencyProbeResult } from '../audio/latencyProbe.ts';
import { runtime } from '../session/runtime.ts';
import { DEFAULT_LATENCY_SEC, useStore } from '../state/store.ts';
import { MOVEMENT_INFO } from '../vision/features.ts';
import { Screen, Toast, TopBar } from './common.tsx';

/** Measured clicks. Eight beats at 60 BPM is eight seconds of movement — as much as a patient will give. */
const BEATS = 8;

export default function LatencyCalibrationScreen() {
  const goto = useStore((s) => s.goto);
  const lanes = useStore((s) => s.lanes);
  const setLatency = useStore((s) => s.setLatency);
  const latencyOffsetSec = useStore((s) => s.latencyOffsetSec);

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

  return (
    <Screen>
      <TopBar
        eyebrow="Latency check"
        title="Move on every click"
        onBack={() => goto('rom')}
        right={
          <button className="btn btn-ghost" onClick={() => accept(DEFAULT_LATENCY_SEC, false, 'Skipped — default 120 ms used')}>
            Skip, use 120 ms →
          </button>
        }
      />

      <div className="row" style={{ alignItems: 'stretch', gap: 24 }}>
        <div className="card stack grow" style={{ gap: 18 }}>
          <p style={{ fontSize: '1.2rem' }}>
            A camera sees a movement 80–200 ms after it happens. This measures that delay so the game judges the movement,
            not the pipeline.
          </p>
          <p className="muted">
            {lane0
              ? `On every click, do one ${MOVEMENT_INFO[lane0.movement].label.toLowerCase()} with the ${lane0.side} side — ${BEATS} clicks after the count-in.`
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
                <button className="btn btn-ghost" onClick={() => accept(DEFAULT_LATENCY_SEC, false, 'Default 120 ms used')}>
                  Use default 120 ms
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="card stack" style={{ width: 'min(320px, 100%)' }}>
          <h3>Why this matters</h3>
          <p className="muted">
            An uncorrected offset does not look like a latency problem: it looks like a patient who cannot hit anything.
            The Results screen reports the timing bias it measured during play, so a bad calibration is visible afterwards
            too.
          </p>
          <div className="row">
            <span className="badge mono">current: {Math.round(latencyOffsetSec * 1000)} ms</span>
          </div>
        </div>
      </div>
    </Screen>
  );
}
