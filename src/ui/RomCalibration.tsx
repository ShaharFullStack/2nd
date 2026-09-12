import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DIFFICULTIES } from '../engine/difficulty.ts';
import type { InvalidCalibration } from '../input/VisionInput.ts';
import { runtime } from '../session/runtime.ts';
import { calibrationKey, laneFingertip, useStore } from '../state/store.ts';
import {
  ROM_NUDGE_FRACTION,
  RomCalibrator,
  applyRomNudge,
  calibrationMismatch,
  formatFeature,
  previewRomNudge,
  withPatient,
} from '../vision/calibration.ts';
import type {
  CalibrationMeasurement,
  CalibrationMismatch,
  CalibrationStatus,
  RomCalibration,
  RomNudgePreview,
} from '../vision/calibration.ts';
import {
  CALIBRATION_NOT_RECORDED,
  calibrationConditions,
  calibrationGrade,
  calibrationSentence,
} from '../session/tracking.ts';
import type { TrackingGrade } from '../session/tracking.ts';
import { FINGERTIP_NAME, MOVEMENT_INFO, movementCalibrationInstruction } from '../vision/features.ts';
import { CameraPreview } from './CameraPreview.tsx';
import { Meter, ProgressRing, Screen, Toast, TopBar, laneName } from './common.tsx';
import PatientBanner from './PatientBanner.tsx';
import { ScopeNote } from './ScopeNote.tsx';

/** "little finger" for a lane that has a prescribed tip, "" for a movement with no tip dimension. */
function tipName(spec: Parameters<typeof laneFingertip>[0]): string {
  const tip = laneFingertip(spec);
  return tip ? FINGERTIP_NAME[tip] : '';
}

interface Live {
  status: CalibrationStatus;
  value: number;
  tracking: boolean;
  /**
   * How well THIS attempt is being measured, as it is being measured. A therapist can move the chair,
   * turn on a light or close a browser tab while the range is still being built; they cannot after it
   * has been stamped onto the record as the denominator of everything that follows.
   */
  measurement: CalibrationMeasurement | null;
}

const GRADE_CLASS: Readonly<Record<TrackingGrade, string>> = Object.freeze({
  good: 'badge badge-ok',
  fair: 'badge badge-warn',
  poor: 'badge badge-bad',
});

/**
 * HOW WELL A RANGE WAS MEASURED, wherever a range is shown.
 *
 * `null` is NOT "good": a range with no measurement block was typed in by hand or captured before
 * this device recorded one, and it says so in those words.
 */
function CalibrationQualityChip({
  measurement,
  testId,
}: {
  measurement: CalibrationMeasurement | null | undefined;
  testId?: string;
}) {
  if (!measurement) {
    return (
      <span className="badge badge-warn" title={CALIBRATION_NOT_RECORDED} data-testid={testId}>
        quality not recorded
      </span>
    );
  }
  const grade = calibrationGrade(measurement);
  return (
    <span className={GRADE_CLASS[grade]} title={calibrationConditions(measurement)} data-testid={testId}>
      measured {grade}
    </span>
  );
}

/**
 * What the RUNTIME thinks of the ranges this screen has handed it, re-read on a timer exactly the way
 * CameraCheck re-reads getStatus().
 *
 * This screen used to be the only reader of a verdict it never asked for: `setCalibration` returns
 * false and `getInvalidCalibrations()` fills with an actionable sentence, and the screen painted a
 * green ✓, a min→max readout and an enabled "Next lane →" over a lane the engine had just killed. A
 * refusal that only reaches console.error is the same silent acceptance the module boundary exists to
 * prevent, moved up one layer.
 */
interface Vetting {
  /** Lanes VisionInput is currently refusing to score, with the therapist-facing reason. */
  refusals: InvalidCalibration[];
  /** Why the saved range offered by "Reuse last session's range" does not apply here (null = it does). */
  previousProblem: CalibrationMismatch | null;
}

const NO_VETTING: Vetting = { refusals: [], previousProblem: null };

export default function RomCalibrationScreen() {
  const goto = useStore((s) => s.goto);
  const lanes = useStore((s) => s.lanes);
  const difficulty = useStore((s) => s.difficulty);
  const setCalibration = useStore((s) => s.setCalibration);
  const savedCalibrations = useStore((s) => s.savedCalibrations);
  const persistenceFailed = useStore((s) => s.persistenceFailed);
  // WHOSE BODY is being measured. It is stamped on every range captured here and checked against every
  // range offered back, because `movement:side[:fingertip]` says what was measured and not on whom.
  const patientId = useStore((s) => s.activePatientId);

  const [laneIndex, setLaneIndex] = useState(0);
  const [live, setLive] = useState<Live | null>(null);
  const [done, setDone] = useState<(RomCalibration | null)[]>(() => lanes.map(() => null));
  const calibrator = useRef<RomCalibrator | null>(null);
  const [generation, setGeneration] = useState(0);
  /**
   * The runtime's refusal of a range measured HERE, tagged with the attempt it belongs to
   * (`laneIndex:generation`). Tagging rather than clearing in an effect means a new lane or a Redo
   * simply stops matching, so a stale refusal can never outlive the range it describes — and no
   * cascading render is needed to retire it.
   */
  const [rejected, setRejected] = useState<{ attempt: string; reason: string } | null>(null);
  const [vetting, setVetting] = useState<Vetting>(NO_VETTING);

  /** Identifies one attempt at one lane: a Redo (generation++) or a lane change starts a new one. */
  const attemptKey = `${laneIndex}:${generation}`;
  /** The refusal that belongs to the attempt on screen right now (null once it is superseded). */
  const rejectedReason = rejected?.attempt === attemptKey ? rejected.reason : null;

  const lane = lanes[laneIndex];
  const info = lane ? MOVEMENT_INFO[lane.movement] : null;
  /** The "do three reps" wording for THIS lane — fingertip-aware, so it names the prescribed digit. */
  const moveInstruction = lane ? movementCalibrationInstruction(lane.movement, laneFingertip(lane)) : '';
  const threshold = DIFFICULTIES[difficulty].thresholdFraction;
  const previous = lane ? savedCalibrations[calibrationKey(lane)] : undefined;

  // One calibrator per lane per attempt; the vision pipeline it reads is the SAME object the game
  // will play with, so the calibration and the session see identical smoothing.
  useEffect(() => {
    if (!lane) return;
    const vision = runtime.peekVision();
    // The calibrator MUST be built from the lane's own context (which fingertip it opposes, which
    // mirror convention its frames are in) — that is what stamps the resulting range with what it
    // actually measured, so a later session can check it instead of guessing. A bare
    // `new RomCalibrator(movement)` produces a range no boundary check can validate; it is only the
    // fallback for the (dev) case where no vision input exists.
    const cal =
      vision?.createCalibrator(laneIndex, patientId ? { patient: patientId } : {}) ??
      new RomCalibrator(lane.movement, patientId ? { patient: patientId } : {});
    calibrator.current = cal;

    if (!vision) return;
    const off = vision.onFrame((samples) => {
      const sample = samples[laneIndex];
      if (!sample) return;
      cal.pushSample(sample);
    });

    const poll = setInterval(() => {
      const vision2 = runtime.peekVision();
      const pipeline = vision2?.getPipeline(laneIndex) ?? null;
      const smoothed = pipeline?.last.smoothed ?? null;
      const provisional = cal.getProvisional();
      const value = smoothed !== null && provisional ? cal.normalize(smoothed) : 0;
      setLive({
        status: cal.getStatus(),
        value,
        tracking: pipeline?.last.tracking ?? false,
        measurement: cal.getMeasurement(),
      });
    }, 80);

    return () => {
      off();
      clearInterval(poll);
      // Clear on the way out, not on the way in: the next lane must never show the previous lane's
      // meter for the frames before its own first poll lands.
      setLive(null);
    };
  }, [lane, laneIndex, generation, patientId]);

  /**
   * Hand a measured range to the runtime and BELIEVE ITS ANSWER.
   *
   * `VisionInput.setCalibration` returns false when it refuses the range (too narrow to tell movement
   * from noise, or measured on another fingertip / under the other mirror convention, i.e. a range of
   * a different quantity or of the other limb). A refused lane reads 0 and never triggers for the whole
   * song, so every state that follows from "this lane is calibrated" — the ✓, the min→max readout, the
   * enabled Next button and the localStorage write that offers this range back next week — is a lie
   * unless the runtime accepted it. The refusal is shown here, on the screen that can fix it, because
   * this is the only screen that can.
   */
  const finishLane = useCallback(
    (result: RomCalibration) => {
      const vision = runtime.peekVision();
      if (vision) {
        const accepted = vision.setCalibration(laneIndex, result);
        if (!accepted) {
          const reason =
            vision.getInvalidCalibrations().find((c) => c.lane === laneIndex)?.reason ??
            'the calibrated range is unusable';
          setRejected({ attempt: attemptKey, reason });
          setDone((d) => {
            if (d[laneIndex] === null) return d;
            const next = d.slice();
            next[laneIndex] = null;
            return next;
          });
          return;
        }
      }
      setRejected(null);
      setCalibration(laneIndex, result);
      setDone((d) => {
        const next = d.slice();
        next[laneIndex] = result;
        return next;
      });
    },
    [attemptKey, laneIndex, setCalibration],
  );

  // Auto-finish as soon as the calibrator says it is done. THIS ATTEMPT'S refusal is part of the guard:
  // without it a refused range is re-offered on every 80 ms poll (the calibrator stays in 'done'
  // forever), which is an infinite refusal loop instead of one message.
  useEffect(() => {
    if (!live || live.status.phase !== 'done') return;
    const cal = calibrator.current;
    const result = cal?.getResult() ?? null;
    if (result && !done[laneIndex] && rejectedReason === null) finishLane(result);
  }, [live, done, laneIndex, rejectedReason, finishLane]);

  /**
   * Re-read the runtime's verdicts (refused lanes; whether the saved range on offer applies to THIS
   * lane's context) on a timer, the way CameraCheck re-reads getStatus. It is polled rather than
   * computed once because both inputs can change under the screen: another lane's calibration is
   * handed over as the therapist works down the list, and the vision input is created asynchronously.
   */
  useEffect(() => {
    const read = () => {
      const vision = runtime.peekVision();
      const refusals = vision?.getInvalidCalibrations() ?? [];
      // The lane's OWN context, derived by VisionInput from the very feature options its extractor
      // runs with — never rebuilt here from the fields this screen happens to remember.
      // The lane's derived context, PLUS the patient — which no feature option can tell it (see
      // `withPatient`). Without the patient attached here, a range measured on somebody else passes
      // every check this screen makes.
      const ctx = withPatient(vision?.getCalibrationContext(laneIndex), patientId);
      const previousProblem = lane && previous ? calibrationMismatch(previous, lane.movement, ctx) : null;
      setVetting((v) =>
        v.previousProblem?.reason === previousProblem?.reason &&
        v.refusals.length === refusals.length &&
        v.refusals.every((r, i) => r.lane === refusals[i].lane && r.reason === refusals[i].reason)
          ? v
          : { refusals, previousProblem },
      );
    };
    read();
    const poll = setInterval(read, 300);
    return () => clearInterval(poll);
  }, [lane, laneIndex, previous, generation, patientId]);

  // "Done" means the RUNTIME holds a usable range for this lane, not that this screen measured one.
  const laneRefused = vetting.refusals.some((r) => r.lane === laneIndex) || rejectedReason !== null;
  const laneDone = laneRefused ? null : (done[laneIndex] ?? null);
  const status = live?.status ?? null;
  const restPhase = status?.phase === 'rest';

  const retry = () => {
    setDone((d) => {
      const next = d.slice();
      next[laneIndex] = null;
      return next;
    });
    setGeneration((g) => g + 1);
  };

  /**
   * EASIER / HARDER, IN THE UNITS THE MOVEMENT IS IN.
   *
   * These two buttons used to call `cal.nudge(0, ±0.05)` — an ABSOLUTE feature-unit step — under
   * labels that said "5 %". On seated march (a torso-normalised ratio whose whole hemiparetic range
   * is around 0.3) one press moved the hit threshold by about a sixth of everything the patient has;
   * on knee extension (degrees) the same press moved it 0.05°, so the therapist pressed a dead
   * button twenty times to gain one degree. They now go through `previewNudgeTop`/`nudgeTop`, which
   * step by a fraction OF THIS PATIENT'S MEASURED RANGE, refuse to put the target above the best rep
   * the patient actually produced, refuse to shrink the range below what can be told from rest
   * noise, and hand back the sentence the button carries — so the label states the target it is
   * about to set, in degrees or in ratio, before it is pressed.
   */
  const nudge = (fraction: number) => {
    // The range ACTUALLY IN FORCE for this lane is nudged — which may be one reused from a previous
    // session that no live calibrator ever measured. Nudging the calibrator instead would be a dead
    // button on exactly that path, and would disagree with the label (which reads the same range).
    const current = done[laneIndex];
    if (!current) return;
    const { calibration, preview } = applyRomNudge(current, lane.movement, fraction);
    if (preview.disabled) return;
    // Keep the live calibrator in step so a Redo-free re-finish cannot resurrect the old top.
    calibrator.current?.setRange(null, calibration.max);
    finishLane(calibration);
  };

  /**
   * What each button WILL do to this lane, recomputed whenever the lane, the measured range or a
   * previous nudge changes. `laneDone` is in the dependency list because `getResult()` builds a fresh
   * object on every accepted range, so a re-measure and a nudge both change identity here.
   */
  const nudgeDown: RomNudgePreview | null = useMemo(
    () => (laneDone && lane ? previewRomNudge(laneDone, lane.movement, -ROM_NUDGE_FRACTION) : null),
    [laneDone, lane],
  );
  const nudgeUp: RomNudgePreview | null = useMemo(
    () => (laneDone && lane ? previewRomNudge(laneDone, lane.movement, ROM_NUDGE_FRACTION) : null),
    [laneDone, lane],
  );

  const next = () => {
    if (laneIndex + 1 < lanes.length) {
      setLaneIndex(laneIndex + 1);
      setGeneration((g) => g + 1);
    } else {
      goto('latency');
    }
  };

  /**
   * Offer last session's range ONLY when it describes what this lane measures now.
   *
   * The saved-calibration key is `movement:side[:fingertip]` — it does not carry the mirror
   * convention, and the convention selects WHICH LIMB every lane reads. So a range saved un-mirrored
   * and reused after the mirror switch is flipped is a genuinely inapplicable range that the store
   * will happily hand over: it has to be refused HERE, with the reason and the action, rather than
   * pushed at a runtime that refuses it where no therapist is looking.
   */
  const previousProblem = vetting.previousProblem;
  const usePrevious = () => {
    if (previous && !previousProblem) finishLane(previous);
  };

  const ringValue = useMemo(() => {
    if (!status) return 0;
    if (status.phase === 'rest') return status.restProgress;
    if (status.phase === 'move') return status.repsRequired > 0 ? status.repsDetected / status.repsRequired : 0;
    return 1;
  }, [status]);

  const ringLabel = useMemo(() => {
    if (!status) return '…';
    if (status.phase === 'rest') return `${Math.round(status.restProgress * 100)}%`;
    if (status.phase === 'move') return `${status.repsDetected}/${status.repsRequired}`;
    return '✓';
  }, [status]);

  if (!lane || !info) {
    return (
      <Screen>
        <TopBar title="Nothing to calibrate" onBack={() => goto('setup')} />
      </Screen>
    );
  }

  return (
    <Screen>
      <TopBar
        eyebrow={`Range of motion — lane ${laneIndex + 1} of ${lanes.length}`}
        title={`${lane.side === 'left' ? 'Left' : 'Right'} ${info.label.toLowerCase()}${tipName(lane) ? ` \u2014 ${tipName(lane)}` : ''}`}
        onBack={() => goto('camera')}
        right={
          <button
            className="btn btn-primary btn-lg"
            onClick={next}
            disabled={!laneDone}
            data-testid="rom-next"
          >
            {laneIndex + 1 < lanes.length ? 'Next lane →' : 'Latency check →'}
          </button>
        }
      />

      <PatientBanner blocking />

      <div className="row" style={{ alignItems: 'stretch', gap: 24 }}>
        <div className="card stack grow" style={{ gap: 20 }}>
          <div className="row" style={{ gap: 24 }}>
            <ProgressRing value={ringValue} label={ringLabel} />
            <div className="stack grow" style={{ gap: 10 }}>
              <div className="eyebrow">{restPhase ? 'Hold still' : status?.phase === 'move' ? 'Now move' : 'Done'}</div>
              {/* THE SENTENCE THE PATIENT IS READ WHILE BEING MEASURED. It must name the digit that was
                  prescribed: `MOVEMENT_INFO.calibrationInstruction` says "touch your thumb to the
                  fingertip", which is wrong for three of the four tips a therapist can choose, and the
                  patient performing the rep is the one person who cannot see the heading above. */}
              <p style={{ fontSize: '1.25rem' }} data-testid="rom-instruction">
                {restPhase ? info.restInstruction : moveInstruction}
              </p>
              {/* The calibrator's message repeats the instruction in the quiet phases — only show it
                  when it is actually saying something else (progress, a problem, a next step). */}
              {status && status.message !== info.restInstruction && status.message !== info.calibrationInstruction && status.message !== moveInstruction && (
                <p className="muted">{status.message}</p>
              )}
            </div>
          </div>

          <div className="stack" style={{ gap: 8 }}>
            <div className="row">
              <span className="eyebrow">Live movement</span>
              <div className="grow" />
              <span className={live?.tracking ? 'badge badge-ok' : 'badge badge-warn'}>
                {live?.tracking ? 'tracking' : 'not visible'}
              </span>
            </div>
            <Meter value={live?.value ?? 0} threshold={threshold} big label="live range of motion" />
            <span className="dim">
              The gold line is where a hit registers at this difficulty ({Math.round(threshold * 100)}% of the calibrated range).
            </span>
            {/* HOW WELL THIS RANGE IS BEING MEASURED, WHILE IT CAN STILL BE FIXED. The chair, the
                light and the browser tabs are all movable now and none of them is movable once the
                range is stamped onto the record as the denominator of every later percentage. */}
            {status && status.phase !== 'done' && live?.measurement && (
              <span className="dim" data-testid="rom-live-quality">
                <CalibrationQualityChip measurement={live.measurement} testId="rom-live-quality-chip" />{' '}
                {calibrationConditions(live.measurement)} — this is the stream the range is being built from.
              </span>
            )}
          </div>

          {status?.error === 'insufficient_range' && (
            <Toast kind="bad">
              The range measured is too small to tell movement from noise. Ask for a bigger, slower movement — or nudge the
              top of the range down if this really is the patient's maximum.
            </Toast>
          )}
          {status?.error === 'no_reps' && (
            <Toast kind="bad">No complete repetitions were detected. Three clear reps, returning to rest between each.</Toast>
          )}
          {status?.warnings?.map((w, i) => (
            <Toast key={i}>{w}</Toast>
          ))}

          {/* The runtime refused the range this screen just measured. Loudest thing on the screen: the
              lane is dead until it is re-done, and this is where it gets re-done. */}
          {rejectedReason && (
            <Toast kind="bad">
              <strong data-testid="rom-rejected">This range was not accepted for lane {laneIndex + 1}:</strong>{' '}
              {rejectedReason}.
            </Toast>
          )}

          {/* THE QUALITY OF THE DENOMINATOR, ON THE SCREEN THAT ACCEPTS IT. `laneDone` is the range the
              runtime has taken for this lane — the scale every ROM figure, export and trend line for
              this movement is a percentage of. A range from three ragged reps on an 11 fps stream and
              one from a clean stream produce identical min→max readouts, and nothing else in the app
              can tell them apart afterwards. */}
          {laneDone && (
            <div className="stack" style={{ gap: 4 }} data-testid="rom-accepted-quality">
              <div className="row">
                <span className="eyebrow">How this range was measured</span>
                <CalibrationQualityChip measurement={laneDone.measurement} testId="rom-accepted-quality-chip" />
              </div>
              <span className="dim" data-testid="rom-accepted-quality-note">
                {laneDone.measurement ? calibrationSentence(laneDone.measurement) : CALIBRATION_NOT_RECORDED}
              </span>
            </div>
          )}

          {/* Any OTHER lane the runtime is refusing — including one killed by a setting changed after
              it was calibrated (flip the mirror switch and every stored range belongs to the other
              limb). Without this the therapist would have to walk back through the lanes to find it. */}
          {vetting.refusals
            .filter((r) => r.lane !== laneIndex || !rejectedReason)
            .map((r) => (
              <Toast kind="bad" key={r.lane}>
                <strong data-testid={`rom-refusal-${r.lane}`}>
                  Lane {r.lane + 1} ({laneName(lanes[r.lane] ?? r)}) will not score:
                </strong>{' '}
                {r.reason}.
              </Toast>
            ))}

          {previous && !laneDone && previousProblem && (
            <Toast kind="bad">
              <strong data-testid="rom-reuse-problem">Last session's range cannot be reused here:</strong>{' '}
              {previousProblem.reason}.
            </Toast>
          )}

          {/* REUSING A RANGE IS ADOPTING ITS MEASUREMENT. The checks above establish that the stored
              range describes this patient, this limb and this quantity; none of them says how well it
              was measured, and reusing it makes its frame rate and its rep spread the denominator of
              today's session too. */}
          {previous && !laneDone && !previousProblem && (
            <div className="stack" style={{ gap: 4 }} data-testid="rom-reuse-quality">
              <div className="row">
                <span className="eyebrow">Last session's range</span>
                <span className="dim mono">
                  {formatFeature(previous.min, info.unit)} → {formatFeature(previous.max, info.unit)}
                </span>
                <CalibrationQualityChip measurement={previous.measurement} testId="rom-reuse-quality-chip" />
              </div>
              <span className="dim" data-testid="rom-reuse-quality-note">
                {previous.measurement ? calibrationSentence(previous.measurement) : CALIBRATION_NOT_RECORDED} Reusing it
                makes it today&rsquo;s denominator too.
              </span>
            </div>
          )}

          {persistenceFailed && (
            <Toast kind="bad">
              This tablet is not saving calibrations (its storage is full or blocked), so nothing measured here will be
              offered back next session. Free up browser storage, or expect to re-calibrate every time.
            </Toast>
          )}

          <div className="row">
            <button className="btn" onClick={retry} data-testid="rom-redo">
              Redo this lane
            </button>
            <button
              className="btn"
              onClick={() => nudge(-ROM_NUDGE_FRACTION)}
              disabled={!laneDone || nudgeDown === null || nudgeDown.disabled}
              title={nudgeDown?.note ?? undefined}
              data-testid="rom-nudge-easier"
            >
              {nudgeDown?.label ?? 'Easier'}
            </button>
            <button
              className="btn"
              onClick={() => nudge(ROM_NUDGE_FRACTION)}
              disabled={!laneDone || nudgeUp === null || nudgeUp.disabled}
              title={nudgeUp?.note ?? undefined}
              data-testid="rom-nudge-harder"
            >
              {nudgeUp?.label ?? 'Harder'}
            </button>
            {previous && !laneDone && (
              <button
                className="btn btn-ghost"
                onClick={usePrevious}
                disabled={previousProblem !== null}
                data-testid="rom-reuse"
              >
                {previousProblem ? 'Cannot reuse last session’s range' : "Reuse last session's range"}
              </button>
            )}
          </div>

          {/* WHY a button is refusing to move any further — the bound, stated in the movement's own
              units. A capped "Harder" is not a broken button: it is the patient's best rep. */}
          {(nudgeUp?.note || nudgeDown?.note) && (
            <span className="dim" data-testid="rom-nudge-note">
              {[nudgeUp?.note, nudgeDown?.note].filter(Boolean).join(' ')}
            </span>
          )}
          {laneDone && (
            <span className="dim">
              Easier / Harder move the top of the range by {Math.round(ROM_NUDGE_FRACTION * 100)}% OF THIS PATIENT'S
              MEASURED RANGE — the same proportion on a movement measured in degrees and one measured as a body-scaled
              ratio — and can never set a target above the best rep they actually produced.
            </span>
          )}
        </div>

        <div className="card stack" style={{ width: 'min(340px, 100%)' }}>
          <h3>Camera</h3>
          <CameraPreview overlay />
          <h3>Lanes</h3>
          <ul className="list-reset">
            {lanes.map((l, i) => {
              // A lane the runtime is refusing is NOT done, whatever this screen measured: the ✓ and the
              // min→max readout describe a range that will not score a single note.
              const refused = vetting.refusals.some((r) => r.lane === i) || (i === laneIndex && rejectedReason !== null);
              const cal = refused ? null : done[i];
              return (
                <li key={i} className="row">
                  <span
                    className={
                      refused ? 'badge badge-bad' : cal ? 'badge badge-ok' : i === laneIndex ? 'badge' : 'badge badge-warn'
                    }
                    data-testid={`rom-lane-badge-${i}`}
                  >
                    {refused ? '✕' : cal ? '✓' : i === laneIndex ? '●' : '—'}
                  </span>
                  <span className={i === laneIndex ? '' : 'muted'}>
                    {l.side === 'left' ? 'L' : 'R'} {MOVEMENT_INFO[l.movement].label}
                    {tipName(l) ? ` · ${tipName(l)}` : ''}
                  </span>
                  <div className="grow" />
                  {refused && <span className="dim">not calibrated</span>}
                  {cal && (
                    // IN THE UNITS THE MOVEMENT IS IN: a knee range is degrees and read "20° → 60°",
                    // not a bare "20.00→60.00" that means nothing next to a ratio lane's "0.08→0.40".
                    <span className="dim mono" data-testid={`rom-lane-range-${i}`}>
                      {formatFeature(cal.min, MOVEMENT_INFO[l.movement].unit)} →{' '}
                      {formatFeature(cal.max, MOVEMENT_INFO[l.movement].unit)}
                    </span>
                  )}
                  {/* Every lane's denominator, graded, in the one list that shows them all: a session
                      whose four ranges were measured differently is not four comparable lanes. */}
                  {cal && <CalibrationQualityChip measurement={cal.measurement} testId={`rom-lane-quality-${i}`} />}
                </li>
              );
            })}
          </ul>
          {/* WHERE THE RANGE IS FIRST PUT INTO DEGREES, the one line that says what kind of number it
              is. Every percentage on the results and trend screens is measured against the range set
              here, so this is the first place the scope has to be stated. */}
          <ScopeNote testId="rom-scope" />
          <span className="dim">
            Each range is stored with the PATIENT, the movement, the side, the mirror convention — and, for finger
            opposition, the fingertip — it was measured on. A repeat session offers a range back only when all of those
            still match, and says so here when they do not, so one person's (or one finger's, or one limb's) range is
            never handed to another.
          </span>
        </div>
      </div>
    </Screen>
  );
}
