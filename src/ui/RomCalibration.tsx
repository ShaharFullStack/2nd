import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DIFFICULTIES } from '../engine/difficulty.ts';
import type { InvalidCalibration } from '../input/VisionInput.ts';
import { runtime } from '../session/runtime.ts';
import { calibrationKey, laneFingertip, useStore } from '../state/store.ts';
import { RomCalibrator, calibrationMismatch } from '../vision/calibration.ts';
import type { CalibrationMismatch, CalibrationStatus, RomCalibration } from '../vision/calibration.ts';
import { MOVEMENT_INFO } from '../vision/features.ts';
import { CameraPreview } from './CameraPreview.tsx';
import { Meter, ProgressRing, Screen, Toast, TopBar } from './common.tsx';

interface Live {
  status: CalibrationStatus;
  value: number;
  tracking: boolean;
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
    const cal = vision?.createCalibrator(laneIndex) ?? new RomCalibrator(lane.movement);
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
      setLive({ status: cal.getStatus(), value, tracking: pipeline?.last.tracking ?? false });
    }, 80);

    return () => {
      off();
      clearInterval(poll);
      // Clear on the way out, not on the way in: the next lane must never show the previous lane's
      // meter for the frames before its own first poll lands.
      setLive(null);
    };
  }, [lane, laneIndex, generation]);

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
      const ctx = vision?.getCalibrationContext(laneIndex) ?? undefined;
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
  }, [lane, laneIndex, previous, generation]);

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

  const nudge = (delta: number) => {
    const cal = calibrator.current;
    if (!cal) return;
    cal.nudge(0, delta);
    const result = cal.getResult();
    if (result) finishLane(result);
  };

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
        title={`${lane.side === 'left' ? 'Left' : 'Right'} ${info.label.toLowerCase()}${laneFingertip(lane) ? ` — ${laneFingertip(lane)} finger` : ''}`}
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

      <div className="row" style={{ alignItems: 'stretch', gap: 24 }}>
        <div className="card stack grow" style={{ gap: 20 }}>
          <div className="row" style={{ gap: 24 }}>
            <ProgressRing value={ringValue} label={ringLabel} />
            <div className="stack grow" style={{ gap: 10 }}>
              <div className="eyebrow">{restPhase ? 'Hold still' : status?.phase === 'move' ? 'Now move' : 'Done'}</div>
              <p style={{ fontSize: '1.25rem' }}>{restPhase ? info.restInstruction : info.calibrationInstruction}</p>
              {/* The calibrator's message repeats the instruction in the quiet phases — only show it
                  when it is actually saying something else (progress, a problem, a next step). */}
              {status && status.message !== info.restInstruction && status.message !== info.calibrationInstruction && (
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

          {/* Any OTHER lane the runtime is refusing — including one killed by a setting changed after
              it was calibrated (flip the mirror switch and every stored range belongs to the other
              limb). Without this the therapist would have to walk back through the lanes to find it. */}
          {vetting.refusals
            .filter((r) => r.lane !== laneIndex || !rejectedReason)
            .map((r) => (
              <Toast kind="bad" key={r.lane}>
                <strong data-testid={`rom-refusal-${r.lane}`}>
                  Lane {r.lane + 1} ({MOVEMENT_INFO[r.movement].label}) will not score:
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
            <button className="btn" onClick={() => nudge(-0.05)} disabled={!laneDone}>
              Easier (−5% top)
            </button>
            <button className="btn" onClick={() => nudge(0.05)} disabled={!laneDone}>
              Harder (+5% top)
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
                    {laneFingertip(l) ? ` · ${laneFingertip(l)}` : ''}
                  </span>
                  <div className="grow" />
                  {refused && <span className="dim">not calibrated</span>}
                  {cal && (
                    <span className="dim mono">
                      {cal.min.toFixed(2)}→{cal.max.toFixed(2)}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          <span className="dim">
            Each range is stored with the movement, the side, the mirror convention — and, for finger opposition, the
            fingertip — it was measured on. A repeat session offers a range back only when all of those still match, and
            says so here when they do not, so one finger's (or one limb's) range is never handed to another.
          </span>
        </div>
      </div>
    </Screen>
  );
}
