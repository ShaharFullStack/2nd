import { useStore } from '../state/store.ts';
import { isPersistenceAvailable } from '../state/persist.ts';
import { runtime } from '../session/runtime.ts';
import { Screen, Toast } from './common.tsx';
import PatientBanner from './PatientBanner.tsx';
import { MeasurementNote } from './ScopeNote.tsx';
import { formatDate, formatDuration, formatPercent, laneRangeSummaries } from '../session/results.ts';
import { formatFeature } from '../vision/calibration.ts';

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
  const setHandsFree = useStore((s) => s.setHandsFree);
  const patient = patients.find((p) => p.id === activePatientId) ?? null;
  // THE LAST SESSION FOR THE PATIENT ON SCREEN, never the tablet's last session — on a shared device
  // those are different people, and the second one belongs to nobody in particular.
  const last = activePatientId ? (history.find((r) => r.patientId === activePatientId) ?? null) : null;
  const patientSessions = activePatientId ? history.filter((r) => r.patientId === activePatientId).length : 0;
  /**
   * LAST SESSION'S RANGE, PER MOVEMENT, WITH THE MOVEMENT NAMED. Never a maximum across lanes.
   *
   * This card used to print one figure — `max(romBest)` over every lane — under the word "Best
   * range", with no movement anywhere near it. A hemiparetic prescription deliberately mixes the
   * affected limb with an unaffected one, so a maximum across lanes is the STRONG side by
   * construction: seeded with a real record (affected Left seated march 0.31 of its own 0.10–0.42
   * range; unaffected Right knee extension 65°), this card read "Best range 65°" — the right knee,
   * on the screen the patient reads before every single session. That is the exact defect the
   * Results headline was rebuilt to remove (see `laneRangeSummaries`), and a fix that contradicts
   * itself one screen later is not a fix. So this screen uses the SAME function Results does: every
   * prescribed movement, in prescription order, each against its OWN calibrated range, named.
   */
  const lastRanges = last ? laneRangeSummaries(last.lanes) : [];
  const lastMeasured = lastRanges.filter((r) => r.measured);

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
    // A new session has not been driven hands-free until it has been: the flag that keeps the camera
    // alive on the results screen is evidence, and last session's evidence is not this one's.
    setHandsFree(false);
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

      {/*
        THE ONE TAP THE SESSION NEEDS, AND IT IS NOT NEGOTIABLE.

        Every browser refuses to start audio without a genuine user gesture — `ctx.resume()` never
        even settles without one (see runtime.ts) — and this app's whole clock is that AudioContext.
        So exactly one real press has to happen, and it has to happen HERE: before the patient is in
        position, while somebody can still reach the tablet. Everything after it — framing the camera,
        every range, the latency check, the song, and the way off the results screen — is done by
        holding a limb over a circle on the preview.

        It is not hidden and it is not apologised for: it is the biggest thing on the screen, and the
        sentence under it says it is the last one.
      */}
      <div className="row only-tap" style={{ gap: 18 }}>
        <div className="row" style={{ gap: 18 }}>
          <button className="btn btn-primary btn-lg" onClick={start} data-testid="start-session">
            {activePatientId && !(inputMode === 'camera' && patient?.deviceTest) ? 'Start session' : 'Choose patient & start'}
          </button>
          <button className="btn btn-lg" onClick={() => goto('history')} data-testid="open-history">
            History {patientSessions > 0 && <span className="badge">{patientSessions}</span>}
          </button>
        </div>
        {inputMode === 'camera' && (
          <p className="muted" style={{ margin: 0, maxWidth: 620, fontSize: '1.05rem' }} data-testid="only-tap-note">
            <b>This is the only time the screen has to be touched.</b> Press it before the patient gets into position:
            the browser will not start the sound without one real press, and the song clock is that sound. From the
            camera check onwards the patient confirms every step themselves, by holding a hand or a knee inside a circle
            on the camera preview until the ring fills. The buttons all keep working for whoever is in the room.
          </p>
        )}
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
              <div className="stack" style={{ gap: 2 }}>
                <div className="eyebrow">Movements performed</div>
                <div className="big-number mono">{last.reps}</div>
              </div>
              <div className="stack" style={{ gap: 6 }} data-testid="home-last-ranges">
                <div className="eyebrow">Range reached, movement by movement</div>
                {lastMeasured.length === 0 ? (
                  <span className="dim">No range was measured in that session.</span>
                ) : (
                  lastRanges.map((r) => (
                    <div
                      key={r.lane}
                      className="row"
                      style={{ gap: 10, alignItems: 'baseline' }}
                      data-testid={`home-last-range-${r.lane}`}
                    >
                      <span style={{ minWidth: 0, flex: '1 1 auto' }}>{r.movementName}</span>
                      <span className="mono" style={{ fontWeight: 800, fontSize: '1.15rem', whiteSpace: 'nowrap' }}>
                        {!r.measured ? '—' : r.best === null ? formatPercent(r.bestFraction) : formatFeature(r.best, r.unit)}
                      </span>
                      <span className="dim" style={{ whiteSpace: 'nowrap' }}>
                        {r.measured ? `${formatPercent(r.bestFraction)} of its own range` : 'not measured'}
                      </span>
                    </div>
                  ))
                )}
                {/* THE UNITS ARE NEVER COMPARED ACROSS MOVEMENTS: a knee angle in degrees and a
                    body-scaled march ratio are different quantities, and the percentage beside each
                    figure is out of THAT movement's own calibrated range. */}
                <span className="dim">
                  Each figure is that movement's best rep against the range calibrated for it that day. Different
                  movements are never compared with each other.
                </span>
              </div>
              <div className="muted">
                {last.songTitle} · {last.mode === 'leg' ? 'Leg' : 'Hand'} · {last.difficulty}
              </div>
              <div className="dim">
                {formatDate(last.startedAt)} · {formatDuration(last.durationSec)}
                {last.laneRestSec === undefined ? '' : ` · paced at ${last.laneRestSec.toFixed(1)} s between reps`}
              </div>
              {/*
                THE SCOPE STATEMENT AND THE CONDITIONS, ON THE FIRST SCREEN THAT SHOWS A DEGREE.
                This card is the screen a therapist reads between patients and the one the patient
                reads before every session, and it prints a joint angle in the movement's own units —
                the same derived figure Results prints. It carried no statement of what those figures
                are and no word about how well the camera tracked the session they came from, so a
                range measured at 11 fps with the limb usable two thirds of the time read here as a
                clean number. The rule is that the caveat travels with the FIGURE, not with the
                screen it happened to be designed on.
              */}
              <MeasurementNote
                tracking={last.tracking}
                inputMode={last.inputMode}
                testId="home-measurement-note"
              />
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
