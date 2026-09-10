import { useCallback, useEffect, useRef, useState } from 'react';
import type { SongManifest } from '../audio/manifest.ts';
import { DIFFICULTIES, windowsForLanes } from '../engine/difficulty.ts';
import { AutoplayInput } from '../input/AutoplayInput.ts';
import { KeyboardInput } from '../input/KeyboardInput.ts';
import type { InputSource } from '../input/types.ts';
import type { InvalidCalibration } from '../input/VisionInput.ts';
import { GameRunner } from '../session/GameRunner.ts';
import type { HudSnapshot } from '../session/GameRunner.ts';
import { SILENT_GRID, buildSessionChart, songGridOf } from '../session/chart.ts';
import { buildSessionResult } from '../session/results.ts';
import { runtime } from '../session/runtime.ts';
import { useStore } from '../state/store.ts';
import { MOVEMENT_INFO } from '../vision/features.ts';
import { DEFAULT_REARM_FRACTION, receptorLookInto, type ReceptorLook } from '../render/receptor.ts';
import CameraFallback from './CameraFallback.tsx';
import { CameraPreview } from './CameraPreview.tsx';
import { Meter, Toast } from './common.tsx';

/**
 * The credit line drawn in the corner of the play screen.
 *
 * NOT `attributionText()`: that is the full licence sentence (a paragraph — "…is an original demo
 * track synthesized in-repo by scripts/gen-demo-stems.mjs…"), which has to be ellipsized to fit a
 * corner block and then reads as a truncated dev string sitting on live gameplay. The full text is
 * still shown in full where the licence asks for it — song select and the results screen. What a
 * clinic screen needs mid-song is who made it and under what licence.
 */
function playCredit(m: SongManifest): string {
  return `${m.artist} · ${m.license}`;
}

/** Grey column + violet cap of a locked-out lane — the receptor's lock cues, in CSS. */
const PIP_LOCK_FILL = 'linear-gradient(0deg, #3a3b42, #8b8d96)';
const PIP_LOCK_CAP = '#c08cff';

/**
 * The picture-in-picture lane meters, shown next to the camera preview for the whole session.
 *
 * ONE VOICE: these are the only other movement meters in the patient's field of view, so they must
 * say what the receptors say. They used to brighten on `value >= threshold` with no reference to
 * `armed`, under the caption "gold = hit level" — so at the exact moment a receptor correctly went
 * grey and said "lower to reset", the meter 300 px away lit up and said "hit level reached". That
 * is the same biofeedback lie the receptor contract exists to remove, and two meters disagreeing is
 * worse than either one being wrong.
 *
 * So the state comes from the same pure model the receptor uses (`receptorLookInto`), against the
 * same threshold and the same re-arm fraction: bright only when the lane would actually fire, grey
 * with a violet cap while it is locked out, and dropped to a hint while tracking is lost.
 */
function LaneMeters({ source, threshold }: { source: InputSource; threshold: number }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let raf = 0;
    const look: ReceptorLook = { fill: 0, over: 0, willFire: false, locked: false, resetProgress: 0, resetLevel: DEFAULT_REARM_FRACTION, glowTarget: 0, tracking: true };
    const tick = () => {
      const el = host.current;
      if (el) {
        const states = source.getLaneStates();
        const bars = el.children;
        for (let i = 0; i < bars.length && i < states.length; i++) {
          const fill = bars[i].firstElementChild as HTMLElement | null;
          if (!fill) continue;
          const s = states[i];
          receptorLookInto(look, s, threshold, DEFAULT_REARM_FRACTION);
          // No measurement ⇒ nothing derived from one: the bar empties rather than leaving a stale
          // column standing at 80 % while the camera cannot see the patient at all.
          const pct = look.tracking ? Math.max(0, Math.min(1, s.value)) * 100 : 0;
          fill.style.height = `${pct}%`;
          fill.style.opacity = look.tracking ? '1' : '0.25';
          // Brightness means "this is scoring" — armed AND tracked AND at threshold, never a full
          // meter on its own.
          fill.style.filter = look.willFire ? 'brightness(1.5)' : 'none';
          fill.style.background = look.locked ? PIP_LOCK_FILL : '';
          fill.style.borderTop = look.locked ? `3px solid ${PIP_LOCK_CAP}` : '';
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [source, threshold]);

  const count = source.getLaneStates().length;
  return (
    <div className="pip-meters" ref={host}>
      {Array.from({ length: count }, (_, i) => (
        <div className="vbar" key={i}>
          <i style={{ height: '0%' }} />
        </div>
      ))}
    </div>
  );
}

export default function PlayScreen() {
  const goto = useStore((s) => s.goto);
  const inputMode = useStore((s) => s.inputMode);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pipRef = useRef<HTMLDivElement>(null);
  const runnerRef = useRef<GameRunner | null>(null);

  const [hud, setHud] = useState<HudSnapshot | null>(null);
  const [phase, setPhase] = useState<'loading' | 'running' | 'error' | 'blocked' | 'camera'>('loading');
  /**
   * The thrown value from `ensureVision`, kept raw so CameraFallback can classify it.
   *
   * The camera can fail HERE and not only on the camera-check screen: unplugged between the check and
   * the count-in, permission revoked mid-visit, or a deep link straight to `?screen=play`. That used
   * to land on a bare "Could not start the session" with the exception text and one Back button — no
   * cause, no remedy, no retry, and no labelled keyboard fallback. It is the same failure the fallback
   * screen was built for, so it gets the same screen.
   */
  const [cameraError, setCameraError] = useState<unknown>(null);
  /** Bumped by Retry so the boot effect re-runs and re-requests the device for real. */
  const [attempt, setAttempt] = useState(0);
  /** The in-flight vision attempt, so Retry can await the REAL request rather than a fixed delay. */
  const visionAttempt = useRef<Promise<unknown> | null>(null);
  /** Lanes the camera input refuses to score — the session is not started at all while this is set. */
  const [blocked, setBlocked] = useState<InvalidCalibration[]>([]);
  const [progress, setProgress] = useState(0);
  const [loadNote, setLoadNote] = useState('Preparing session');
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [paused, setPaused] = useState(false);
  const [input, setInput] = useState<InputSource | null>(null);

  const threshold = DIFFICULTIES[useStore.getState().difficulty].thresholdFraction;

  useEffect(() => {
    let alive = true;
    let ownedInput: InputSource | null = null;

    const boot = async () => {
      const st = useStore.getState();
      const config = st.config();
      const settings = st.settings;

      setLoadNote('Starting audio');
      const { ctx, mixer, sfx } = await runtime.ensureAudio();
      sfx.enabled = settings.sfx;

      setLoadNote('Loading song');
      let songManifest: SongManifest | null = null;
      try {
        songManifest = await runtime.loadSong(config.songId, (p) => setProgress(p.fraction));
      } catch (err) {
        console.warn('[play] song load failed, running silently', err);
      }
      if (!alive) return;

      const grid = songManifest ? songGridOf(songManifest) : SILENT_GRID;
      const built = buildSessionChart(grid, config, songManifest);
      if (!alive) return;
      setWarnings(built.warnings);

      setLoadNote('Preparing input');
      let source: InputSource | ((clock: { songTime(n?: number): number; ctxTimeForSongTime(t: number): number }) => InputSource);
      if (inputMode === 'keyboard') {
        const kb = new KeyboardInput({ lanes: config.lanes.length, audioContext: ctx });
        ownedInput = kb;
        source = kb;
      } else if (inputMode === 'autoplay') {
        source = (songClock) => {
          const bot = new AutoplayInput({
            chart: built.chart,
            audioContext: ctx,
            songClock,
            jitterMs: 26,
            hitFraction: 0.94,
            seed: config.seed,
          });
          ownedInput = bot;
          return bot;
        };
      } else {
        let vision;
        try {
          const attempting = runtime.ensureVision({
            mode: config.mode,
            lanes: config.lanes,
            calibrations: st.calibrations,
            difficulty: config.difficulty,
            mirrored: settings.mirrored,
          });
          visionAttempt.current = attempting;
          vision = await attempting;
        } catch (err) {
          if (!alive) return;
          setCameraError(err);
          setPhase('camera');
          return;
        }
        if (!alive) return;
        // A LANE THAT PROVABLY CANNOT SCORE IS A HARD STOP, NOT A WARNING TO READ AFTERWARDS.
        // VisionInput refuses a range that measures a different quantity (another fingertip) or the
        // other limb (the other mirror convention), and a refused lane reads 0 and never triggers: the
        // patient would work through a whole song on a flat lane and meet the verdict as a 0% row on
        // the results screen. The app knows this BEFORE a note is scheduled, so it says so here — with
        // the reason and the way back to the screen that can fix it.
        const refused = vision.getInvalidCalibrations();
        if (refused.length > 0) {
          setBlocked(refused);
          setPhase('blocked');
          return;
        }
        source = vision;
      }
      if (!alive) return;

      const canvas = canvasRef.current;
      if (!canvas) throw new Error('canvas missing');

      const runner = new GameRunner({
        canvas,
        chart: built.chart,
        lanes: config.lanes,
        windows: windowsForLanes(config.lanes, config.difficulty, config.windowScale),
        clock: ctx,
        input: source,
        mixer: songManifest ? mixer : null,
        sfx,
        inputLatencySec: inputMode === 'camera' ? st.latencyOffsetSec : 0,
        missGraceMs: inputMode === 'camera' ? undefined : 0,
        thresholdFraction: DIFFICULTIES[config.difficulty].thresholdFraction,
        rearmFraction: DEFAULT_REARM_FRACTION,
        songTitle: songManifest?.title,
        attribution: songManifest ? playCredit(songManifest) : undefined,
        highwayOptions: {
          approachSec: settings.scrollSec,
          highContrast: settings.highContrast,
          reducedMotion: settings.reducedMotion,
          effectIntensity: settings.effectIntensity,
          showMissPopup: settings.showMissPopup,
        },
        // Camera sessions keep the camera open for the next song; dev inputs are ours to stop.
        stopInputOnDispose: inputMode !== 'camera',
        hudIntervalMs: 200,
        onHud: (h) => {
          setHud(h);
          setPaused(h.phase === 'paused');
        },
        onEnd: (summary) => {
          const store = useStore.getState();
          const result = buildSessionResult({
            summary,
            config,
            manifest: songManifest,
            inputMode: store.inputMode,
            latencyOffsetSec: inputMode === 'camera' ? store.latencyOffsetSec : 0,
            calibrations: store.calibrations,
          });
          store.addResult(result);
          store.goto('results');
        },
      });

      runnerRef.current = runner;
      runtime.runner = runner;
      setInput(runner.input);
      runner.resize();
      await runner.start();
      if (!alive) return;
      setPhase('running');
    };

    setCameraError(null);
    boot().catch((err: unknown) => {
      console.error('[play] failed to start', err);
      if (!alive) return;
      setError(err instanceof Error ? err.message : String(err));
      setPhase('error');
    });

    const onResize = () => runnerRef.current?.resize();
    window.addEventListener('resize', onResize);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        const runner = runnerRef.current;
        if (!runner) return;
        if (runner.getPhase() === 'paused') void runner.resume();
        else runner.pause();
      }
    };
    window.addEventListener('keydown', onKey);

    return () => {
      alive = false;
      window.removeEventListener('resize', onResize);
      window.removeEventListener('keydown', onKey);
      runnerRef.current?.dispose();
      runnerRef.current = null;
      runtime.runner = null;
      ownedInput?.stop();
    };
  }, [inputMode, attempt]);

  /**
   * Retry = re-request. The dead VisionInput is disposed so `ensureVision` cannot hand it back, the
   * boot effect re-runs, and this awaits the NEW attempt's own promise — so the button stays in its
   * "asking…" state for as long as the request actually takes.
   */
  const retryCamera = useCallback(async () => {
    const before = visionAttempt.current;
    runtime.disposeVision();
    setCameraError(null);
    setPhase('loading');
    setAttempt((n) => n + 1);
    for (let i = 0; i < 60 && visionAttempt.current === before; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    await visionAttempt.current?.catch(() => undefined);
  }, []);

  if (phase === 'camera') return <CameraFallback error={cameraError} onRetry={retryCamera} />;

  const countdown = hud?.countdown ?? 0;

  return (
    <div className="play-root">
      <canvas className="play-canvas" ref={canvasRef} data-testid="play-canvas" />

      <div className="play-chrome">
        {phase === 'running' && countdown > 0 && (
          <div className="countdown">
            {countdown}
            <small>get ready</small>
          </div>
        )}

        <button
          className="pause-btn"
          onClick={() => {
            const runner = runnerRef.current;
            if (!runner) return;
            if (runner.getPhase() === 'paused') void runner.resume();
            else runner.pause();
          }}
          aria-label={paused ? 'Resume' : 'Pause'}
          // Nothing to pause during the count-in: the song has not started and the mixer's transport
          // is already scheduled. Disabled rather than silently inert.
          disabled={hud?.phase === 'countdown'}
          title={hud?.phase === 'countdown' ? 'Starting…' : paused ? 'Resume (Esc)' : 'Pause (Esc)'}
        >
          {paused ? '▶' : '❚❚'}
        </button>

        {inputMode === 'camera' && input && (
          <div className="pip" ref={pipRef}>
            <CameraPreview className="pip-video" />
            <LaneMeters source={input} threshold={threshold} />
            <div className="pip-note">lane meters · bright = scoring · grey = lower to reset</div>
          </div>
        )}

        {/* Dev affordance, not product chrome: the keyboard fallback needs to show which key is which,
            the autoplay bot does not — it only ever appeared in screenshots, as a debug widget in
            the corner of the play field. */}
        {inputMode === 'keyboard' && input && (
          <div className="pip">
            <LaneMeters source={input} threshold={threshold} />
            <div className="pip-note">keys 1–4 / D F J K</div>
          </div>
        )}

        {phase === 'loading' && (
          <div className="overlay">
            <div className="card stack">
              <h2>{loadNote}…</h2>
              <div className="loading-bar">
                <Meter value={progress} label="loading" />
              </div>
              <p className="muted">Stems are loaded whole so every instrument stays sample-locked to the chart.</p>
            </div>
          </div>
        )}

        {phase === 'blocked' && (
          <div className="overlay" data-testid="play-blocked">
            <div className="card stack">
              <h2>{blocked.length > 1 ? `${blocked.length} lanes are not calibrated` : 'A lane is not calibrated'}</h2>
              <p className="muted">
                The session was not started: {blocked.length > 1 ? 'these lanes' : 'this lane'} would score nothing all
                song, and the patient would have no way to tell.
              </p>
              {blocked.map((b) => (
                <Toast kind="bad" key={b.lane}>
                  <strong data-testid={`play-blocked-${b.lane}`}>
                    Lane {b.lane + 1} ({MOVEMENT_INFO[b.movement].label}, {b.side}):
                  </strong>{' '}
                  {b.reason}.
                </Toast>
              ))}
              <div className="row">
                <button
                  className="btn btn-primary btn-lg grow"
                  onClick={() => goto('rom')}
                  data-testid="play-recalibrate"
                >
                  Re-calibrate {blocked.length > 1 ? 'these lanes' : 'this lane'} →
                </button>
                <button className="btn btn-lg" onClick={() => goto('setup')}>
                  Back to setup
                </button>
              </div>
            </div>
          </div>
        )}

        {phase === 'error' && (
          <div className="overlay">
            <div className="card stack">
              <h2>Could not start the session</h2>
              <p className="muted">{error}</p>
              <button className="btn btn-primary btn-lg" onClick={() => goto('setup')}>
                Back to setup
              </button>
            </div>
          </div>
        )}

        {paused && (
          <div className="overlay" data-testid="pause-overlay">
            <div className="card stack">
              <h2>Paused</h2>
              <p className="muted">The song and the chart restart together — the patient will not lose their place.</p>
              {warnings.map((w, i) => (
                <Toast key={i}>{w}</Toast>
              ))}
              <div className="row">
                <button className="btn btn-primary btn-lg grow" onClick={() => void runnerRef.current?.resume()}>
                  Resume
                </button>
                <button className="btn btn-lg" onClick={() => runnerRef.current?.quit()} data-testid="end-session">
                  End &amp; see results
                </button>
              </div>
              {hud && (
                <div className="row dim mono">
                  <span>{hud.score.toLocaleString()} pts</span>
                  <span>{hud.reps} reps</span>
                  <span>{hud.hits} hits</span>
                  <span>{hud.misses} misses</span>
                </div>
              )}
            </div>
          </div>
        )}

        {hud?.clockStalled && (
          <div className="overlay">
            <div className="card stack">
              <h2>Audio clock stopped</h2>
              <p className="muted">
                The browser suspended the audio context, which is the clock this game runs on. Tap to resume.
              </p>
              <button className="btn btn-primary btn-lg" onClick={() => void runtime.ensureAudio()}>
                Resume audio
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
