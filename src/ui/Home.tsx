import { useStore } from '../state/store.ts';
import { isPersistenceAvailable } from '../state/persist.ts';
import { runtime } from '../session/runtime.ts';
import { Screen, Toast } from './common.tsx';
import PatientBanner from './PatientBanner.tsx';
import { formatDate, formatDuration, formatPercent } from '../session/results.ts';
import { formatFeature } from '../vision/calibration.ts';
import { MOVEMENT_INFO } from '../vision/features.ts';

const persistent = isPersistenceAvailable();

export default function Home() {
  const goto = useStore((s) => s.goto);
  const history = useStore((s) => s.history);
  const settings = useStore((s) => s.settings);
  const updateSettings = useStore((s) => s.updateSettings);
  const inputMode = useStore((s) => s.inputMode);
  const patients = useStore((s) => s.patients);
  const activePatientId = useStore((s) => s.activePatientId);
  const selectDeviceTestPatient = useStore((s) => s.selectDeviceTestPatient);
  const patient = patients.find((p) => p.id === activePatientId) ?? null;
  // THE LAST SESSION FOR THE PATIENT ON SCREEN, never the tablet's last session — on a shared device
  // those are different people, and the second one belongs to nobody in particular.
  const last = activePatientId ? (history.find((r) => r.patientId === activePatientId) ?? null) : null;
  const patientSessions = activePatientId ? history.filter((r) => r.patientId === activePatientId).length : 0;
  /** The best single rep of the last session, in the movement's own units — the work, not a grade. */
  const lastBest: string | null = (() => {
    if (!last) return null;
    let best: { text: string; frac: number } | null = null;
    for (const l of last.lanes) {
      if (l.romSamples <= 0 || l.romBest === null) continue;
      const unit = MOVEMENT_INFO[l.movement].unit;
      const abs =
        l.calibratedMin !== null && l.calibratedMax !== null
          ? l.calibratedMin + l.romBest * (l.calibratedMax - l.calibratedMin)
          : null;
      const text = abs !== null && Number.isFinite(abs) ? formatFeature(abs, unit) : formatPercent(l.romBest);
      if (best === null || l.romBest > best.frac) best = { text, frac: l.romBest };
    }
    return best?.text ?? null;
  })();

  /**
   * A session cannot start until the app knows whose it is.
   *
   * The one exception is a DEV INPUT (`?input=keyboard` / `?input=autoplay`): those runs are the system
   * driving the lanes, not a person moving — they are already excluded from every trend and badged
   * "not measured" — so they are filed under the built-in device-test record instead of stopping the
   * therapist at a patient screen they do not need. A camera session always stops: at no patient, AND
   * at the device-test record left selected by the last demo, which is not a person either.
   */
  const start = () => {
    // First user gesture: this is the only place an AudioContext may be created.
    void runtime.ensureAudio().catch((err) => console.warn('[home] audio unavailable', err));
    if (inputMode !== 'camera') {
      if (!activePatientId) selectDeviceTestPatient();
      goto('mode');
      return;
    }
    // A CAMERA session measures a body, so it needs a person — and the device-test record is not one.
    // Left selected after a demo it would quietly collect a real patient's ROM into a shared demo
    // bucket that every future demo also writes to, which is the pooling this whole screen exists to
    // stop. Same refusal as no patient at all.
    if (!activePatientId || patient?.deviceTest) {
      goto('patients');
      return;
    }
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
          {activePatientId && !(inputMode === 'camera' && patient?.deviceTest) ? 'Start session' : 'Choose patient & start'}
        </button>
        <button className="btn btn-lg" onClick={() => goto('history')} data-testid="open-history">
          History {patientSessions > 0 && <span className="badge">{patientSessions}</span>}
        </button>
      </div>

      <PatientBanner />

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
              min={2}
              max={6}
              step={0.2}
              value={settings.scrollSec}
              onChange={(e) => updateSettings({ scrollSec: Number(e.target.value) })}
            />
            <span className="dim">Slower scroll = more time to see the note coming.</span>
          </div>
        </div>

        <div className="card stack">
          <h3>{patient ? `Last session — ${patient.name}` : 'Last session'}</h3>
          {!patient ? (
            <p className="muted">
              Choose a patient to see their last session. Records on this tablet are kept per patient and
              are never shown to the wrong one.
            </p>
          ) : last ? (
            <>
              {/*
                THE PATIENT SITS IN FRONT OF THIS SCREEN BEFORE EVERY SESSION, with their own name on
                the card. It used to lead with five stars and a four-figure score — one filled star of
                five, under the name of somebody four weeks post-stroke. The grade was taken off the
                Results screen for that reason and survived here; it does not survive here either.
                What their last session was is WHAT THEY DID: movements performed, and the best range
                they reached. The score and stars remain in the clinical detail on Results and in the
                exported record, where a clinician reads them.
              */}
              <div className="row">
                <div className="stack" style={{ gap: 2 }}>
                  <div className="eyebrow">Movements performed</div>
                  <div className="big-number mono">{last.reps}</div>
                </div>
                <div className="grow" />
                <div className="stack" style={{ gap: 2, textAlign: 'right' }}>
                  <div className="eyebrow">Best range</div>
                  <div className="big-number mono">{lastBest ?? '—'}</div>
                </div>
              </div>
              <div className="muted">
                {last.songTitle} · {last.mode === 'leg' ? 'Leg' : 'Hand'} · {last.difficulty}
              </div>
              <div className="dim">
                {formatDate(last.startedAt)} · {formatDuration(last.durationSec)}
                {last.laneRestSec === undefined ? '' : ` · paced at ${last.laneRestSec.toFixed(1)} s between reps`}
              </div>
              <button className="btn" onClick={() => goto('history')}>
                See all {patientSessions} session{patientSessions === 1 ? '' : 's'}
              </button>
            </>
          ) : (
            <p className="muted">No sessions for {patient.name} yet. The first run takes about four minutes including calibration.</p>
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
