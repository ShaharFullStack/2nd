import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { assignLaneStems, duckDepthDb } from '../audio/ducking.ts';
import { attributionText } from '../audio/manifest.ts';
import type { SongEntry } from '../audio/manifest.ts';
import {
  LANE_REST_STEP_SEC,
  MAX_LANE_REST_SEC,
  MIN_LANE_REST_SEC,
  chartDose,
  clampLaneRestSec,
  generateChartDetailed,
  limbRepsPerMinuteAt,
  repsPerMinuteAt,
} from '../charts/generate.ts';
import { DIFFICULTIES, DIFFICULTY_NAMES, windowsFor } from '../engine/difficulty.ts';
import { FINGERTIPS } from '../engine/types.ts';
import type { DifficultyName, Fingertip, LaneSpec, Side } from '../engine/types.ts';
import { SILENT_GRID, songGridOf } from '../session/chart.ts';
import { formatDuration, limbLabel } from '../session/results.ts';
import { runtime } from '../session/runtime.ts';
import { MAX_LANES, MIN_LANES, laneFingertip, movementsFor, useStore } from '../state/store.ts';
import { MOVEMENT_INFO, laneConflicts, movementInstructions } from '../vision/features.ts';
import { Screen, Toast, TopBar } from './common.tsx';
import PatientBanner from './PatientBanner.tsx';

const DIFFICULTY_BLURB: Record<DifficultyName, string> = {
  easy: 'Half the range counts as a hit, one note every other beat. Start here.',
  medium: 'Two thirds of range, roughly one note per beat.',
  hard: 'Near-full range, one and a half notes per beat.',
};

const FINGERTIP_LABEL: Record<Fingertip, string> = { index: 'Index', middle: 'Middle', ring: 'Ring', pinky: 'Little' };

/** Bytes as a therapist reads them: "4.3 MB", "812 kB". */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 kB';
  if (bytes < 1_000_000) return `${Math.max(1, Math.round(bytes / 1000))} kB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/**
 * The one line under a Listen button that is mid-download. It says which of the two paths the press
 * took, because they differ by an order of magnitude: the ranged audition fetches the twelve seconds
 * it plays, and the fallback fetches the entire song because the server refused to send less.
 */
function previewCostLabel(cost: { bytes: number; total: number | null; full: boolean } | null): string {
  // Nothing has arrived yet — "0 kB" would be a figure pretending to be progress. No "press to
  // cancel" hint on any of these: the button beside them reads Stop, which is the affordance itself.
  if (!cost || (!cost.full && cost.bytes <= 0)) return 'Loading the preview…';
  if (!cost.full) return `Loading 12 s · ${formatBytes(cost.bytes)}`;
  const of = cost.total ? ` of ${formatBytes(cost.total)}` : '';
  return `Whole song · ${formatBytes(cost.bytes)}${of} — this server will not send just the preview`;
}

function laneLabel(l: LaneSpec): string {
  const tip = laneFingertip(l);
  const base = `${l.side === 'left' ? 'Left' : 'Right'} · ${MOVEMENT_INFO[l.movement].label}`;
  return tip ? `${base} · ${FINGERTIP_LABEL[tip].toLowerCase()} finger` : base;
}

export default function TherapistSetup() {
  const goto = useStore((s) => s.goto);
  const mode = useStore((s) => s.mode);
  const lanes = useStore((s) => s.lanes);
  const setLane = useStore((s) => s.setLane);
  const addLane = useStore((s) => s.addLane);
  const removeLane = useStore((s) => s.removeLane);
  const difficulty = useStore((s) => s.difficulty);
  const setDifficulty = useStore((s) => s.setDifficulty);
  const windowScale = useStore((s) => s.windowScale);
  const setWindowScale = useStore((s) => s.setWindowScale);
  const songId = useStore((s) => s.songId);
  const setSong = useStore((s) => s.setSong);
  const inputMode = useStore((s) => s.inputMode);
  const seed = useStore((s) => s.seed);
  const laneRestSec = useStore((s) => s.laneRestSec);
  const setLaneRestSec = useStore((s) => s.setLaneRestSec);
  /** Set when the patient in this tab's chair was not put there by this tab (see the banner below). */
  const activePatientNotice = useStore((s) => s.activePatientNotice);
  const acknowledgeActivePatient = useStore((s) => s.acknowledgeActivePatient);

  const [catalog, setCatalog] = useState<SongEntry[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    runtime
      .songCatalog()
      .then((entries) => {
        if (!alive) return;
        setCatalog(entries);
        if (entries.length > 0 && !entries.some((e) => e.id === songId)) setSong(entries[0].id);
      })
      .catch((err: unknown) => alive && setCatalogError(String(err)));
    return () => {
      alive = false;
    };
  }, [songId, setSong]);

  /**
   * THE SELECTED SONG DOWNLOADS WHILE THE PRESCRIPTION IS BEING WRITTEN.
   *
   * The stems are the whole weight of a session (12 MB for demo-groove, and 34 MB before they were
   * regenerated at 16 kHz): fetched after Start, they are a progress bar the patient sits through.
   * Nothing on this screen needs them, and by the time it is left the song is decided — so the load
   * runs against the seconds the therapist spends choosing movements, difficulty and pacing.
   *
   * Settled selection only (a ~1.2 s pause after the last change), so flicking through the catalogue
   * starts one download rather than four; `prefetchSong` itself declines while an audition is in
   * flight and is idempotent per song, so this can fire as often as it likes.
   *
   * WITH ONE EXCEPTION: THE SONG THAT IS ALREADY SELECTED WHEN THIS SCREEN OPENS. There is nothing
   * to debounce about it — nobody has flicked anywhere yet, it is the default or the therapist's own
   * last choice, and on a throttled link those 1.2 s are 1.2 s of the patient's session spent doing
   * nothing. The debounce is for CHANGES, so it applies from the second selection onward.
   */
  const prefetched = useRef<string | null>(null);
  useEffect(() => {
    const entry = catalog?.find((e) => e.id === songId);
    if (!entry || entry.status !== 'ready') return;
    if (prefetched.current === null) {
      prefetched.current = entry.id;
      runtime.prefetchSong(entry.id);
      return;
    }
    const id = setTimeout(() => {
      prefetched.current = entry.id;
      runtime.prefetchSong(entry.id);
    }, 1200);
    return () => clearTimeout(id);
  }, [catalog, songId]);

  /**
   * Which audition request is the current one. Loading a song's stems is async, so two quick clicks
   * (Listen on A, then Listen on B) could resolve out of order and leave A's `playPreview` landing
   * after B was loaded — the wrong song playing under a button that says B. Every request takes a
   * token; a resolution whose token is stale touches neither the UI nor the transport (beyond
   * silencing itself). The other Listen buttons are held disabled while a request is in flight, so the
   * common case never races at all.
   */
  const previewSeq = useRef(0);

  /** Song id currently being auditioned (null = nothing playing), and the one being fetched for it. */
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  /**
   * WHAT THIS AUDITION IS COSTING, AND HOW TO STOP IT.
   *
   * An audition is normally 4 MB of ranged requests and a quarter of a second. But the moment the
   * server (or a proxy) refuses `Range`, it falls back to loading the whole song — 34 MB for the demo
   * tracks — and on clinic wi-fi that is a button that says "… loading" for a minute with every
   * Listen disabled and no way out. The therapist has ninety seconds between patients; a press they
   * cannot take back is the expensive failure here, not the megabytes.
   *
   * So the press reports itself: bytes so far, which path it took, and the button that started it
   * stays LIVE as its own Stop. `cancel` aborts the ranged fetches and, on the fallback, unloads the
   * mixer mid-download.
   */
  const previewAbort = useRef<AbortController | null>(null);
  const [previewCost, setPreviewCost] = useState<{ bytes: number; total: number | null; full: boolean } | null>(null);

  // The audition stops itself after ~12 s (and on any transport call), so the button state has to be
  // read back from the mixer rather than assumed. Cheap poll, no per-frame React work.
  useEffect(() => {
    const poll = setInterval(() => {
      setPreviewing((current) => {
        const live = runtime.previewingSongId();
        return live === current ? current : live;
      });
    }, 250);
    return () => clearInterval(poll);
  }, []);

  // Never leave a song playing behind us — leaving Setup by any route stops the audition, and
  // invalidates any audition still loading so it cannot start playing after we are gone.
  useEffect(
    () => () => {
      previewSeq.current++;
      previewAbort.current?.abort();
      previewAbort.current = null;
      runtime.stopPreview();
    },
    [],
  );

  const stopPreview = useCallback(() => {
    previewAbort.current?.abort();
    previewAbort.current = null;
    runtime.stopPreview();
    setPreviewing(null);
    setPreviewLoading(null);
    setPreviewCost(null);
  }, []);

  const togglePreview = useCallback(
    (entry: SongEntry) => {
      setPreviewError(null);
      // The same button is the stop, whether the audition is PLAYING or still downloading. A press
      // that cannot be taken back is the thing this screen must never have.
      if (previewing === entry.id || previewLoading === entry.id) {
        previewSeq.current++;
        stopPreview();
        return;
      }
      const seq = ++previewSeq.current;
      const abort = new AbortController();
      previewAbort.current = abort;
      setPreviewLoading(entry.id);
      setPreviewCost({ bytes: 0, total: null, full: false });
      const fresh = (): boolean => previewSeq.current === seq;
      // Called straight from the click handler: this is the gesture that creates the AudioContext.
      runtime
        .previewSong(entry.id, undefined, {
          signal: abort.signal,
          // The cheap path: bytes of the ranged windows, counted as each stem lands.
          onProgress: (p) => fresh() && setPreviewCost({ bytes: p.bytes, total: null, full: false }),
          // The expensive path. Receiving ANY of these means the audition fell back to the whole
          // song, which is the fact the therapist is owed before they wait for it.
          onLoadProgress: (p) =>
            fresh() && setPreviewCost({ bytes: p.bytesLoaded, total: p.bytesTotalKnown ? p.bytesTotal : null, full: true }),
        })
        .then((manifest) => {
          if (!fresh()) {
            // Superseded by a stop or by leaving the screen — but the load may still have reached the
            // mixer, so silence it rather than leaving a song playing on an abandoned screen.
            if (runtime.previewingSongId() === entry.id) runtime.stopPreview();
            return;
          }
          setPreviewLoading(null);
          setPreviewCost(null);
          if (!manifest) {
            // A cancel is a decision, not a failure: it says nothing on screen beyond going quiet.
            if (abort.signal.aborted) return;
            setPreviewError(`"${entry.manifest?.title ?? entry.id}" has no downloaded stems to play.`);
            return;
          }
          setPreviewing(entry.id);
        })
        .catch((err: unknown) => {
          if (!fresh()) return;
          setPreviewLoading(null);
          setPreviewCost(null);
          if (abort.signal.aborted || (err as Error)?.name === 'AbortError') return;
          setPreviewError(err instanceof Error ? err.message : String(err));
        });
    },
    [previewing, previewLoading, stopPreview],
  );

  const conflicts = useMemo(() => laneConflicts(lanes), [lanes]);
  // No patient is as blocking as a lane conflict: this is the last screen before a recording, and a
  // session with nobody to record it against has nowhere honest to go.
  const activePatientId = useStore((s) => s.activePatientId);
  const patients = useStore((s) => s.patients);
  const activePatient = patients.find((p) => p.id === activePatientId) ?? null;
  /**
   * NO PATIENT MEANS NOBODY IN THE LIST, NOT "THE SLOT IS EMPTY".
   *
   * This used to read `activePatientId === null`, which misses the state a second tab creates: delete
   * the patient next door and this tab is left holding an id that names nobody. The banner said "No
   * patient selected" in red while THIS button stayed enabled, and the camera session behind it was
   * filed under the dead id — invisible in the patient list, unreachable from History, unmoveable.
   * The question the Start button has to answer is "is there a real record to file this against",
   * and the only honest way to ask it is to look the id up.
   */
  const noPatient = activePatient === null;
  // The built-in device-test record is not a person. A keyboard/autoplay run belongs there; a CAMERA
  // run measures somebody's range of motion and must never be filed into a bucket shared by every
  // demo this tablet has ever run. Refused here exactly as a missing patient is.
  const deviceTestCamera = inputMode === 'camera' && !!activePatient?.deviceTest;
  const blocking = conflicts.filter((c) => c.severity === 'error');
  const cannotStart = blocking.length > 0 || noPatient || deviceTestCamera;
  const movements = movementsFor(mode);

  const selected = catalog?.find((e) => e.id === songId) ?? null;

  /**
   * THE DOSE, measured with the app's own generator on the song that is actually prescribed.
   *
   * A therapist prescribing exercise is prescribing a number of repetitions at a rate, and until this
   * card existed the Setup screen never said either one: "medium, 2 lanes" silently meant 189 notes,
   * ~95 reps per limb at ~58 reps/min, and the figure moved whenever the difficulty, the lane count
   * or the song changed for unrelated reasons. Generating the real chart (same seed, same pacing) is
   * the only honest way to answer it — the density budget is not a closed form.
   */
  const dose = useMemo(() => {
    const grid = selected?.manifest ? songGridOf(selected.manifest) : SILENT_GRID;
    try {
      const result = generateChartDetailed(grid, lanes.length, difficulty, seed, {
        minLaneSpacingSec: clampLaneRestSec(laneRestSec),
      });
      // GROUPED BY LIMB, because that is the unit the dose is prescribed in: a limb carrying two
      // lanes is asked for the sum of both, and quoting one lane's figure as the limb's was wrong by
      // the number of lanes on it.
      return {
        ...chartDose(result.chart, lanes.map((l) => l.side)),
        warnings: result.warnings,
        silent: !selected?.manifest,
      };
    } catch {
      return null;
    }
  }, [selected, lanes, difficulty, seed, laneRestSec]);

  /** The limb the pacing ceiling has to be quoted for: the one carrying the most lanes. */
  const mostLanesOnALimb = dose ? Math.max(1, ...dose.perLimb.map((l) => l.laneIndices.length)) : 1;
  const busiestLimb = dose?.perLimb[0] ?? null;

  /** Which stem each lane's misses dim (audio/ducking.ts) — the mix the patient will hear. */
  const mix = useMemo(() => {
    const m = selected?.manifest;
    if (!m) return null;
    return assignLaneStems(m.stems.map((st) => st.id), m.playerStem, lanes.length, lanes.map(laneLabel));
  }, [selected, lanes]);
  // The depth depends on the mode, so the numbers on this card are read off the SAME function the
  // mixer runs (`duckOptionsFor`): a shared instrument dips one step and stops there.
  const depth = duckDepthDb(mix?.mode ?? 'per-lane');
  const stepDb = Math.round(depth.stepDb);
  const floorDb = Math.round(depth.floorDb);

  /**
   * One place that clamps and quantises the pacing, whichever control moved it — and it is the SAME
   * clamp the generator runs (`clampLaneRestSec` snaps to the 0.1 s grid), so the number this screen
   * prints is always the number the chart is built with.
   */
  const setPacing = (value: number) => {
    if (!Number.isFinite(value)) return;
    setLaneRestSec(clampLaneRestSec(value));
  };
  const stepPacing = (delta: number) => setPacing(laneRestSec + delta);

  const start = () => {
    // The audition is a temporary segment the mixer unwinds; stopping it here is belt-and-braces so
    // the therapist never hears the preview bleed into the count-in.
    stopPreview();
    void runtime.ensureAudio().catch(() => undefined);
    // THE SONG STARTS DOWNLOADING HERE, not on the play screen with the patient already in position:
    // a camera session goes camera check → ROM → latency before the first note, minutes in which the
    // stems can arrive. Idempotent — pressing Start later joins this load rather than restarting it.
    runtime.prefetchSong(songId);
    goto(inputMode === 'camera' ? 'camera' : 'play');
  };

  return (
    <Screen>
      <TopBar
        eyebrow="Step 2 of 3"
        title={mode === 'leg' ? 'Prescribe the leg session' : 'Prescribe the hand session'}
        onBack={() => goto('mode')}
        right={
          <button className="btn btn-primary btn-lg" disabled={cannotStart} onClick={start} data-testid="setup-start">
            {inputMode === 'camera' ? 'Set up camera →' : 'Start session →'}
          </button>
        }
      />

      {/* WHOSE SESSION THIS IS, on the screen where it is prescribed — the last place to catch a
          wrong patient before the record exists. */}
      <PatientBanner blocking />
      {/* WHO PUT THIS PATIENT IN THE CHAIR. The selection is per TAB (state/store.ts
          `ACTIVE_PATIENT_KEY`): no other tab can move it. What another tab CAN do is open this one on
          the device's last choice, or rename/delete the patient underneath it — and that used to
          happen as a name quietly becoming a different name on the screen where the session is
          prescribed. It is a sentence now, and it stays until a human says it is the right person. */}
      {activePatientNotice && (
        <div className="toast" data-testid="active-patient-notice" role="status">
          <div className="row" style={{ gap: 12 }}>
            <span>{activePatientNotice}</span>
            <div className="grow" />
            {/* "It is the right patient" is a claim about a person, so it is only offered when there
                IS one. After a cross-tab DELETE there is nothing to confirm — tapping it would assert
                that a deleted record is the right patient and clear the only sentence saying so — and
                the single remaining way out is to choose somebody. Same for a tab whose inherited
                hint named nobody real. */}
            {!noPatient && (
              <button className="btn btn-ghost" onClick={acknowledgeActivePatient} data-testid="active-patient-ack">
                It is the right patient
              </button>
            )}
            <button className="btn btn-ghost" onClick={() => goto('patients')} data-testid="active-patient-change">
              Choose patient
            </button>
          </div>
        </div>
      )}
      {deviceTestCamera && (
        <div className="toast toast-bad" data-testid="setup-device-test-block">
          <div className="row">
            <span>
              <b>This is the device-test record, not a patient.</b> Keyboard and autoplay runs are filed
              here; a camera session measures a real range of motion and cannot be. Choose the patient
              this session is for.
            </span>
            <div className="grow" />
            <button className="btn btn-primary" onClick={() => goto('patients')} data-testid="setup-choose-patient">
              Choose patient
            </button>
          </div>
        </div>
      )}

      <div className="card stack">
        <div className="row">
          <h3>Lanes ({lanes.length})</h3>
          <span className="dim">2–4 movements, one lane each. Notes arrive in the lane's colour.</span>
          <div className="grow" />
          <button className="btn" onClick={addLane} disabled={lanes.length >= MAX_LANES} data-testid="add-lane">
            + Add lane
          </button>
        </div>

        <ul className="list-reset">
          {lanes.map((lane, i) => (
            <li className="lane-row" key={i}>
              <div className="stack" style={{ gap: 6 }}>
                <div className="row" style={{ gap: 10 }}>
                  <span className="badge">Lane {i + 1}</span>
                  <b>{laneLabel(lane)}</b>
                </div>
                {/* The one string a patient is actually read aloud: it names the prescribed digit,
                    not "your fingertip". */}
                <span className="dim" data-testid={`lane-${i}-instructions`}>
                  {movementInstructions(lane.movement, laneFingertip(lane))}
                </span>
              </div>

              <select
                className="control"
                value={lane.movement}
                aria-label={`Lane ${i + 1} movement`}
                onChange={(e) => setLane(i, { movement: e.target.value as LaneSpec['movement'] })}
              >
                {movements.map((m) => (
                  <option key={m} value={m}>
                    {MOVEMENT_INFO[m].label}
                  </option>
                ))}
              </select>

              <div className="row" style={{ gap: 12 }}>
                <div className="seg" role="group" aria-label={`Lane ${i + 1} side`}>
                  {(['left', 'right'] as Side[]).map((side) => (
                    <button key={side} aria-pressed={lane.side === side} onClick={() => setLane(i, { side })}>
                      {side === 'left' ? 'L' : 'R'}
                    </button>
                  ))}
                </div>

                {/* finger_opposition only: which fingertip opposes the thumb. It is not cosmetic —
                    the feature is `1 - tip-to-thumb distance / palm size` for THIS tip, so the range
                    is calibrated, stored and judged per fingertip. */}
                {laneFingertip(lane) && (
                  <div className="tip-choice">
                    <span className="eyebrow">Fingertip</span>
                    <div className="seg seg-sm" role="group" aria-label={`Lane ${i + 1} fingertip`}>
                      {FINGERTIPS.map((tip) => (
                        <button
                          key={tip}
                          aria-pressed={laneFingertip(lane) === tip}
                          onClick={() => setLane(i, { fingertip: tip })}
                          data-testid={`lane-${i}-tip-${tip}`}
                        >
                          {FINGERTIP_LABEL[tip]}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <button
                className="btn btn-ghost btn-danger"
                onClick={() => removeLane(i)}
                disabled={lanes.length <= MIN_LANES}
                aria-label={`Remove lane ${i + 1}`}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>

        {lanes.some((l) => laneFingertip(l)) && (
          <span className="dim">
            Each fingertip is calibrated and stored separately: opposing the little finger is a different
            movement from opposing the index, and one range cannot normalise the other.
          </span>
        )}

        {conflicts.map((c, i) => (
          <Toast key={i} kind={c.severity === 'error' ? 'bad' : 'warn'}>
            <b>Lanes {c.lanes[0] + 1} &amp; {c.lanes[1] + 1}:</b> {c.message}
          </Toast>
        ))}
      </div>

      <div className="stack">
        <h3>Difficulty</h3>
        <div className="card-grid">
          {DIFFICULTY_NAMES.map((name) => {
            const d = DIFFICULTIES[name];
            return (
              <button
                key={name}
                className="card pick"
                aria-pressed={difficulty === name}
                onClick={() => setDifficulty(name)}
                data-testid={`difficulty-${name}`}
              >
                <div className="pick-title" style={{ textTransform: 'capitalize' }}>
                  {name}
                </div>
                <div className="pick-sub">{DIFFICULTY_BLURB[name]}</div>
                <div className="row" style={{ gap: 8 }}>
                  <span className="badge">Hit at {Math.round(d.thresholdFraction * 100)}% of ROM</span>
                  <span className="badge">{d.noteDensity} notes/beat</span>
                  <span className="badge">
                    ±{d.windows.perfectMs}/{d.windows.goodMs} ms
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <div className="card stack" data-testid="setup-dose">
        <div className="row">
          <h3>Dose</h3>
          <span className="dim">What this prescription asks the patient's body to do, before you start it.</span>
        </div>

        {dose === null ? (
          <Toast kind="bad">This song's beat grid cannot be charted, so the dose cannot be measured.</Toast>
        ) : (
          <>
            <div className="card-grid">
              <div className="stack" style={{ gap: 4 }}>
                <div className="eyebrow">Reps per lane</div>
                <div className="big-number mono" data-testid="dose-reps-per-lane">{Math.round(dose.repsPerLane)}</div>
                <div className="dim">{dose.notes} notes over {formatDuration(dose.spanSec)} of movement</div>
              </div>
              {/* THE BUSIEST LIMB, WHICH IS THE SUM OF THE LANES ON IT. This tile used to print the
                  busiest LANE under a "each limb" label: a prescription that puts two lanes on one
                  limb (left knee extension AND left ankle dorsiflexion, two fingertips on one hand)
                  asks that limb for both, so the figure a therapist doses from was half the truth. */}
              <div className="stack" style={{ gap: 4 }}>
                <div className="eyebrow">Reps per minute, busiest limb</div>
                <div className="big-number mono" data-testid="dose-reps-per-min">{Math.round(dose.repsPerMinPerLimb)}</div>
                <div className="dim" data-testid="dose-limb-note">
                  {busiestLimb
                    ? `the rate the ${limbLabel(busiestLimb.key, mode).toLowerCase()} is asked to work at` +
                      (busiestLimb.laneIndices.length > 1
                        ? ` — its ${busiestLimb.laneIndices.length} lanes added together`
                        : '')
                    : 'the rate ONE limb is asked to work at'}
                </div>
              </div>
              <div className="stack" style={{ gap: 4 }}>
                <div className="eyebrow">Reps per minute, whole body</div>
                <div className="big-number mono">{Math.round(dose.totalRepsPerMin)}</div>
                <div className="dim">{lanes.length} lanes together</div>
              </div>
            </div>

            <ul className="list-reset dim" style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
              <li className="eyebrow">Per lane</li>
              {lanes.map((l, i) => (
                <li key={i} data-testid={`dose-lane-${i}`}>
                  <b>{dose.perLane[i] ?? 0}</b> × {laneLabel(l)}
                </li>
              ))}
            </ul>

            {/* And the same reps totalled per LIMB — the line that makes the tile above checkable,
                and the only place a two-lane limb's real workload is written down. */}
            <ul
              className="list-reset dim"
              style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}
              data-testid="dose-limbs"
            >
              <li className="eyebrow">Per limb</li>
              {dose.perLimb.map((l) => (
                <li key={l.key} data-testid={`dose-limb-${l.key}`}>
                  <b>{l.reps}</b> reps for the {limbLabel(l.key, mode).toLowerCase()}
                  {l.laneIndices.length > 1 ? ` (${l.laneIndices.length} lanes on it, added)` : ''} ·{' '}
                  {Math.round(l.repsPerMin)} reps/min
                </li>
              ))}
            </ul>

            {dose.silent && (
              <span className="dim">
                No audio is downloaded for this song, so the dose is measured on its beat grid — the reps are real, the
                music is not.
              </span>
            )}
          </>
        )}

        <div className="stack" style={{ gap: 6 }} data-testid="setup-pacing">
          <div className="row" style={{ gap: 12 }}>
            <h4 style={{ margin: 0 }}>Pacing — rest between two reps of the SAME movement</h4>
            <div className="grow" />
            {/* ONE UNBREAKABLE GROUP. The stepper used to be five siblings of the heading's flex row,
                so at 1024 px the "+" wrapped to a second line with "−" left behind at the far right,
                and at 820 px the number went with it: the one control on this screen whose job is
                prescribing a dose read as broken on both clinic-tablet widths. The −/number/+/badge
                are one nowrap group that moves to its own line as a unit. */}
            <div
              style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'nowrap' }}
              data-testid="pacing-stepper"
            >
              {/* A specific 1.5 s on a shared tablet cannot depend on landing a drag: the value is
                  typed or stepped, and the slider is the coarse control below. */}
              <button
                className="btn btn-ghost"
                onClick={() => stepPacing(-LANE_REST_STEP_SEC)}
                disabled={laneRestSec <= MIN_LANE_REST_SEC + 1e-6}
                aria-label="Less rest between reps (0.1 s faster)"
                data-testid="pacing-down"
              >
                − 0.1 s
              </button>
              <input
                className="control mono"
                type="number"
                min={MIN_LANE_REST_SEC}
                max={MAX_LANE_REST_SEC}
                step={LANE_REST_STEP_SEC}
                style={{ width: 88, textAlign: 'right', flex: '0 0 auto' }}
                value={laneRestSec.toFixed(1)}
                aria-label="Minimum rest between reps in one lane, seconds"
                data-testid="pacing-number"
                onChange={(e) => setPacing(Number(e.target.value))}
              />
              <span className="dim">s</span>
              <button
                className="btn btn-ghost"
                onClick={() => stepPacing(LANE_REST_STEP_SEC)}
                disabled={laneRestSec >= MAX_LANE_REST_SEC - 1e-6}
                aria-label="More rest between reps (0.1 s slower)"
                data-testid="pacing-up"
              >
                + 0.1 s
              </button>
              {/* The pacing AND the ceiling it implies, in one badge — the dose itself is the card above. */}
              <span className="badge" style={{ whiteSpace: 'nowrap' }} data-testid="pacing-value">
                {laneRestSec.toFixed(1)} s · ≤{Math.round(repsPerMinuteAt(laneRestSec))} reps/min per lane
              </span>
            </div>
          </div>
          <input
            type="range"
            /* The clamp floor IS a 0.1 s step now (charts/generate.ts), so the slider, the stepper and
               the stored value share one grid and one floor. */
            min={MIN_LANE_REST_SEC}
            max={MAX_LANE_REST_SEC}
            step={LANE_REST_STEP_SEC}
            value={laneRestSec}
            aria-label="Minimum rest between reps in one lane, seconds (slider)"
            data-testid="pacing-slider"
            onChange={(e) => setPacing(Number(e.target.value))}
          />
          <div className="row dim" style={{ justifyContent: 'space-between' }}>
            <span>{MIN_LANE_REST_SEC.toFixed(1)} s — fastest (little time to return to rest)</span>
            <span>{(MAX_LANE_REST_SEC / 2).toFixed(1)} s</span>
            <span>{MAX_LANE_REST_SEC.toFixed(1)} s — slowest</span>
          </div>
          {/* The pacing floor is PHYSIOLOGY, and it used to be a side effect of the difficulty preset:
              picking "medium" for the timing windows also picked 0.6 s between reps of the same limb.
              ONE reps-per-minute figure is the dose (the card above, measured on the real chart); the
              figure here is the CEILING this pacing allows. They were shown side by side as two bare
              "reps/min" numbers, which invites reading the ceiling as the prescription. */}
          <span className="dim" data-testid="pacing-explainer">
            An impaired leg needs to come back to rest before the next rep — set this for the patient in front of you,
            not for the feel of the song. It is not part of the difficulty: changing the windows above does not move it.
            At {laneRestSec.toFixed(1)} s no LANE can be asked for more than{' '}
            {Math.round(repsPerMinuteAt(laneRestSec))} reps/min.{' '}
            {mostLanesOnALimb > 1
              ? `This prescription puts ${mostLanesOnALimb} lanes on one limb, so that limb's ceiling is ${Math.round(
                  limbRepsPerMinuteAt(laneRestSec, mostLanesOnALimb),
                )} reps/min — the rest is between two reps of the same movement, not between two reps of the same limb. `
              : 'One lane per limb here, so that is the limb ceiling too. '}
            This song and difficulty actually deliver{' '}
            <b>
              {dose === null ? '—' : Math.round(dose.repsPerMinPerLimb)} reps/min for the{' '}
              {busiestLimb ? limbLabel(busiestLimb.key, mode).toLowerCase() : 'busiest limb'}
            </b>
            , which is the dose above.
          </span>
          {dose && dose.warnings.some((w) => w.startsWith('note density reduced')) && (
            <span className="dim">
              This pacing is the binding constraint on this song: the chart has been thinned to honour it, which is the
              intended behaviour — the dose above is what will actually be asked for.
            </span>
          )}
        </div>
      </div>

      <div className="card stack" data-testid="setup-mix">
        <div className="row">
          <h3>What the patient hears</h3>
          <span className="dim">A missed note changes the mix. This is exactly how much.</span>
        </div>
        <span className="dim" data-testid="mix-summary">
          {mix
            ? mix.rule
            : 'This song has no downloaded stems, so nothing is ducked — the session runs silently against the same clock.'}
        </span>
        {/* WHICH INSTRUMENT IS THE WEAK SIDE. The set of instruments is not enough: a therapist
            listening for whether the affected limb is being rewarded has to know what to listen for. */}
        {mix && (
          <ul className="list-reset dim" style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
            {lanes.map((l, i) => (
              <li key={i} data-testid={`mix-lane-${i}`}>
                <b>{laneLabel(l)}</b> → {mix.perLane[i] ?? '—'}
                {mix.mode === 'shared' ? ' (shared)' : ''}
              </li>
            ))}
          </ul>
        )}
        {/* The weak side IS the therapy. A miss used to drop the player's instrument to 5 % and hold it
            there until the next hit, anywhere on the board — so one missed left-leg note silenced the
            reward a patient was earning with every right-leg rep.

            CONDITIONAL ON THE ASSIGNMENT. "A miss in one lane never touches another lane's instrument"
            is true only in per-lane mode. Both shipped songs have four stems, so every FOUR-lane
            session — a bilateral hand session — shares one instrument, and printing the per-lane
            sentence there made this card, the card added to make the mix honest, the least honest
            thing on the screen. */}
        {mix === null ? null : mix.mode === 'per-lane' ? (
          <span className="dim" data-testid="mix-claim">
            A missed note lowers <b>that lane's</b> instrument by about {stepDb} dB, and a run of misses in the same lane
            by at most {floorDb} dB. It is never silenced, a miss in one lane never touches another lane's instrument,
            and the next hit in that lane brings it straight back.
          </span>
        ) : (
          <span className="dim" data-testid="mix-claim">
            All {lanes.length} lanes share <b>{mix.perLane[0]}</b>, so a missed note in <b>any</b> lane lowers it — by
            about {stepDb} dB and no further, however long the run of misses, because that instrument is the reward for
            the limb that is working too. It is never silenced, the next hit in any lane brings it straight back, and{' '}
            {mix.bed.length === 1 ? 'the other stem plays' : `the other ${mix.bed.length} stems play`} at full level
            throughout.{' '}
            {mix.capacity >= MIN_LANES
              ? `For an instrument of its own per lane on this song, run ${mix.capacity} lane${mix.capacity === 1 ? '' : 's'} or fewer, or choose a song with more stems.`
              : 'This song has too few stems for any lane to have an instrument of its own.'}
          </span>
        )}
      </div>

      <div className="card stack">
        <div className="row">
          <h3>Timing window</h3>
          <span className="badge">×{windowScale.toFixed(2)}</span>
          <div className="grow" />
          <span className="dim">
            {lanes.map((l, i) => {
              const w = windowsFor(l.movement, difficulty, undefined, windowScale);
              return (
                <span key={i} style={{ marginLeft: 12 }}>
                  L{i + 1} ±{Math.round(w.perfectMs)}/{Math.round(w.goodMs)} ms
                </span>
              );
            })}
          </span>
        </div>
        <input
          type="range"
          min={0.5}
          max={3}
          step={0.05}
          value={windowScale}
          aria-label="Timing window scale"
          onChange={(e) => setWindowScale(Number(e.target.value))}
        />
        <span className="dim">
          Widen the windows for patients whose movement is slow to initiate — fine-motor lanes already get ×1.6 on top of this.
        </span>
      </div>

      <div className="stack">
        <h3>Song</h3>
        {catalogError && <Toast kind="bad">Could not read the song list: {catalogError}</Toast>}
        {!catalog && !catalogError && <p className="muted">Loading songs…</p>}
        {previewError && <Toast kind="bad">{previewError}</Toast>}
        <div className="card-grid">
          {catalog?.map((entry) => {
            const m = entry.manifest;
            const ready = entry.status === 'ready';
            const isPreviewing = previewing === entry.id;
            const isLoading = previewLoading === entry.id;
            const from = m?.previewStart ?? 0;
            return (
              <div key={entry.id} className={songId === entry.id ? 'song-card selected' : 'song-card'}>
                <button
                  className="pick"
                  aria-pressed={songId === entry.id}
                  onClick={() => setSong(entry.id)}
                  disabled={!m}
                  data-testid={`song-${entry.id}`}
                >
                  <div className="row">
                    <span
                      className="art"
                      aria-hidden="true"
                      style={{ background: ready ? 'linear-gradient(140deg,#ff3d7f,#35d6ff)' : '#1d2438' }}
                    >
                      {ready ? '♫' : '↓'}
                    </span>
                    <div className="stack" style={{ gap: 2 }}>
                      <div className="pick-title">{m?.title ?? entry.id}</div>
                      <div className="pick-sub">
                        {m ? `${m.artist} · ${m.bpm} BPM · ${Math.round(m.durationSec)} s` : (entry.error ?? 'Unreadable manifest')}
                      </div>
                    </div>
                  </div>
                </button>

                <div className="song-actions">
                  <button
                    className="btn btn-preview"
                    aria-pressed={isPreviewing}
                    // ONLY THE OTHER buttons go dead while a press is in flight. The one that started
                    // it stays live, because it is the only way to stop it.
                    disabled={!ready || (previewLoading !== null && !isLoading)}
                    onClick={() => togglePreview(entry)}
                    data-testid={`preview-${entry.id}`}
                    aria-label={
                      isLoading
                        ? `Stop loading ${m?.title ?? entry.id}${previewCost ? ` — ${formatBytes(previewCost.bytes)} downloaded so far` : ''}`
                        : isPreviewing
                          ? `Stop the preview of ${m?.title ?? entry.id}`
                          : `Hear ${m?.title ?? entry.id}`
                    }
                  >
                    {isLoading ? '■ Stop' : isPreviewing ? '■ Stop' : '▶ Listen'}
                  </button>
                  <span className="dim" data-testid={`preview-status-${entry.id}`}>
                    {isLoading
                      ? previewCostLabel(previewCost)
                      : isPreviewing
                        ? 'Playing — stops itself'
                        : ready
                          ? `12 s from ${Math.floor(from / 60)}:${Math.floor(from % 60).toString().padStart(2, '0')}`
                          : 'no audio yet'}
                  </span>
                  {songId === entry.id && (
                    <>
                      <div className="grow" />
                      <span className="badge badge-ok">Prescribed</span>
                    </>
                  )}
                </div>

                {!ready && m && (
                  <span className="badge badge-warn">
                    Needs fetch — {entry.missingStems.length} stem{entry.missingStems.length === 1 ? '' : 's'} missing (npm run fetch-stems)
                  </span>
                )}
                {m && <div className="attribution">{attributionText(m)}</div>}
              </div>
            );
          })}
        </div>
        <span className="dim">
          A preview is an audition, not the session: whichever spot you listen to, pressing start begins
          the prescribed chart at the top of the song.
        </span>
        {catalog?.some((e) => e.id === songId && e.status !== 'ready') && (
          <Toast>
            This song's stems are not downloaded. The session will still run — the chart plays silently
            against the same clock — but the patient hears nothing.
          </Toast>
        )}
      </div>

      <div className="row" style={{ paddingBottom: 24 }}>
        <button className="btn btn-primary btn-lg grow" disabled={cannotStart} onClick={start}>
          {inputMode === 'camera' ? 'Set up camera →' : 'Start session →'}
        </button>
      </div>
    </Screen>
  );
}
