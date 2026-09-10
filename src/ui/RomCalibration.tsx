import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DIFFICULTIES } from '../engine/difficulty.ts';
import { runtime } from '../session/runtime.ts';
import { calibrationKey, laneFingertip, useStore } from '../state/store.ts';
import { RomCalibrator } from '../vision/calibration.ts';
import type { CalibrationStatus, RomCalibration } from '../vision/calibration.ts';
import { MOVEMENT_INFO } from '../vision/features.ts';
import { CameraPreview } from './CameraPreview.tsx';
import { Meter, ProgressRing, Screen, Toast, TopBar } from './common.tsx';

interface Live {
  status: CalibrationStatus;
  value: number;
  tracking: boolean;
}

export default function RomCalibrationScreen() {
  const goto = useStore((s) => s.goto);
  const lanes = useStore((s) => s.lanes);
  const difficulty = useStore((s) => s.difficulty);
  const setCalibration = useStore((s) => s.setCalibration);
  const savedCalibrations = useStore((s) => s.savedCalibrations);

  const [laneIndex, setLaneIndex] = useState(0);
  const [live, setLive] = useState<Live | null>(null);
  const [done, setDone] = useState<(RomCalibration | null)[]>(() => lanes.map(() => null));
  const calibrator = useRef<RomCalibrator | null>(null);
  const [generation, setGeneration] = useState(0);

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

  const finishLane = useCallback(
    (result: RomCalibration) => {
      setCalibration(laneIndex, result);
      runtime.peekVision()?.setCalibration(laneIndex, result);
      setDone((d) => {
        const next = d.slice();
        next[laneIndex] = result;
        return next;
      });
    },
    [laneIndex, setCalibration],
  );

  // Auto-finish as soon as the calibrator says it is done.
  useEffect(() => {
    if (!live || live.status.phase !== 'done') return;
    const cal = calibrator.current;
    const result = cal?.getResult() ?? null;
    if (result && !done[laneIndex]) finishLane(result);
  }, [live, done, laneIndex, finishLane]);

  const laneDone = done[laneIndex] ?? null;
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

  const usePrevious = () => {
    if (previous) finishLane(previous);
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
              <button className="btn btn-ghost" onClick={usePrevious}>
                Reuse last session's range
              </button>
            )}
          </div>
        </div>

        <div className="card stack" style={{ width: 'min(340px, 100%)' }}>
          <h3>Camera</h3>
          <CameraPreview overlay />
          <h3>Lanes</h3>
          <ul className="list-reset">
            {lanes.map((l, i) => (
              <li key={i} className="row">
                <span className={done[i] ? 'badge badge-ok' : i === laneIndex ? 'badge' : 'badge badge-warn'}>
                  {done[i] ? '✓' : i === laneIndex ? '●' : '—'}
                </span>
                <span className={i === laneIndex ? '' : 'muted'}>
                  {l.side === 'left' ? 'L' : 'R'} {MOVEMENT_INFO[l.movement].label}
                  {laneFingertip(l) ? ` · ${laneFingertip(l)}` : ''}
                </span>
                <div className="grow" />
                {done[i] && (
                  <span className="dim mono">
                    {(done[i] as RomCalibration).min.toFixed(2)}→{(done[i] as RomCalibration).max.toFixed(2)}
                  </span>
                )}
              </li>
            ))}
          </ul>
          <span className="dim">
            Each range is stored with the movement, the side — and, for finger opposition, the fingertip — it was
            measured on, so a repeat session can offer it back and never hands one finger's range to another.
          </span>
        </div>
      </div>
    </Screen>
  );
}
