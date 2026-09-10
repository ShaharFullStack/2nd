import { useStore } from '../state/store.ts';
import { isPersistenceAvailable } from '../state/persist.ts';
import { runtime } from '../session/runtime.ts';
import { Screen, Stars, Toast } from './common.tsx';
import { formatDate, formatPercent } from '../session/results.ts';

const persistent = isPersistenceAvailable();

export default function Home() {
  const goto = useStore((s) => s.goto);
  const history = useStore((s) => s.history);
  const settings = useStore((s) => s.settings);
  const updateSettings = useStore((s) => s.updateSettings);
  const inputMode = useStore((s) => s.inputMode);
  const last = history[0] ?? null;

  const start = () => {
    // First user gesture: this is the only place an AudioContext may be created.
    void runtime.ensureAudio().catch((err) => console.warn('[home] audio unavailable', err));
    goto('mode');
  };

  return (
    <Screen>
      <div className="stack" style={{ gap: 8, paddingTop: '4vh' }}>
        <div className="eyebrow">Camera-controlled rhythm therapy</div>
        <h1 className="title">Beat Rehab</h1>
        <p className="muted" style={{ maxWidth: 620, fontSize: '1.1rem' }}>
          A prescribed set of movements becomes the controller. The patient plays the song with their
          own range of motion; you get reps, ROM, timing and compensation flags at the end.
        </p>
      </div>

      <div className="row" style={{ gap: 18 }}>
        <button className="btn btn-primary btn-lg" onClick={start} data-testid="start-session">
          Start session
        </button>
        <button className="btn btn-lg" onClick={() => goto('history')} data-testid="open-history">
          History {history.length > 0 && <span className="badge">{history.length}</span>}
        </button>
      </div>

      {inputMode !== 'camera' && (
        <Toast>
          Dev input mode: <b>{inputMode}</b> — the camera screens are skipped.{' '}
          {inputMode === 'keyboard' ? 'Keys 1–4 (or D F J K) play the lanes.' : 'A bot plays the chart.'}
        </Toast>
      )}

      {!persistent && <Toast kind="bad">This browser is not storing data — session history will be lost when the tab closes.</Toast>}

      <div className="card-grid">
        <div className="card stack">
          <h3>Display &amp; sound</h3>
          <label className="switch">
            <input type="checkbox" checked={settings.sfx} onChange={(e) => updateSettings({ sfx: e.target.checked })} />
            <span>Hit &amp; miss sound cues</span>
          </label>
          <label className="switch">
            <input
              type="checkbox"
              checked={settings.highContrast}
              onChange={(e) => updateSettings({ highContrast: e.target.checked })}
            />
            <span>High-contrast lanes</span>
          </label>
          <label className="switch">
            <input
              type="checkbox"
              checked={settings.reducedMotion}
              onChange={(e) => updateSettings({ reducedMotion: e.target.checked })}
            />
            <span>Reduced motion (calmer background)</span>
          </label>
          <div className="field">
            <label htmlFor="scroll">Scroll speed — {settings.scrollSec.toFixed(1)} s of runway</label>
            <input
              id="scroll"
              type="range"
              min={0.9}
              max={2.6}
              step={0.1}
              value={settings.scrollSec}
              onChange={(e) => updateSettings({ scrollSec: Number(e.target.value) })}
            />
            <span className="dim">Slower scroll = more time to see the note coming.</span>
          </div>
        </div>

        <div className="card stack">
          <h3>Last session</h3>
          {last ? (
            <>
              <div className="row">
                <Stars value={last.stars} />
                <div className="grow" />
                <div className="big-number mono">{last.score.toLocaleString()}</div>
              </div>
              <div className="muted">
                {last.songTitle} · {last.mode === 'leg' ? 'Leg' : 'Hand'} · {last.difficulty}
              </div>
              <div className="dim">
                {formatDate(last.startedAt)} · {formatPercent(last.accuracy)} accuracy · {last.reps} reps
              </div>
              <button className="btn" onClick={() => goto('history')}>
                See all sessions
              </button>
            </>
          ) : (
            <p className="muted">No sessions yet. The first run takes about four minutes including calibration.</p>
          )}
        </div>

        <div className="card stack">
          <h3>How a session runs</h3>
          <ol className="muted" style={{ margin: 0, paddingLeft: '1.2em', lineHeight: 1.9 }}>
            <li>Pick leg or hand mode</li>
            <li>Prescribe 2–4 movements, difficulty and a song</li>
            <li>Frame the camera</li>
            <li>Calibrate range of motion per movement</li>
            <li>Measure camera latency</li>
            <li>Play — then review the results</li>
          </ol>
        </div>
      </div>
    </Screen>
  );
}
