import { useEffect, useRef, useState } from 'react';
import { attributionText } from '../audio/manifest.ts';
import type { SongManifest } from '../audio/manifest.ts';
import { DIFFICULTIES, windowsForLanes } from '../engine/difficulty.ts';
import { AutoplayInput } from '../input/AutoplayInput.ts';
import { KeyboardInput } from '../input/KeyboardInput.ts';
import type { InputSource } from '../input/types.ts';
import { GameRunner } from '../session/GameRunner.ts';
import type { HudSnapshot } from '../session/GameRunner.ts';
import { SILENT_GRID, buildSessionChart, songGridOf } from '../session/chart.ts';
import { buildSessionResult } from '../session/results.ts';
import { runtime } from '../session/runtime.ts';
import { useStore } from '../state/store.ts';
import { DEFAULT_REARM_FRACTION } from '../render/receptor.ts';
import { CameraPreview } from './CameraPreview.tsx';
import { Meter, Toast } from './common.tsx';

function LaneMeters({ source, threshold }: { source: InputSource; threshold: number }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const el = host.current;
      if (el) {
        const states = source.getLaneStates();
        const bars = el.children;
        for (let i = 0; i < bars.length && i < states.length; i++) {
          const fill = bars[i].firstElementChild as HTMLElement | null;
          if (!fill) continue;
          const s = states[i];
          const pct = Math.max(0, Math.min(1, s.value)) * 100;
          fill.style.height = `${pct}%`;
          fill.style.opacity = s.tracking === false ? '0.25' : '1';
          fill.style.filter = s.value >= threshold ? 'brightness(1.5)' : 'none';
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
  const [phase, setPhase] = useState<'loading' | 'running' | 'error'>('loading');
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
        source = await runtime.ensureVision({
          mode: config.mode,
          lanes: config.lanes,
          calibrations: st.calibrations,
          difficulty: config.difficulty,
          mirrored: settings.mirrored,
        });
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
        attribution: songManifest ? attributionText(songManifest) : undefined,
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
  }, [inputMode]);

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
            <div className="pip-note">lane meters · gold = hit level</div>
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
