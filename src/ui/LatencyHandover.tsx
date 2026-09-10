/**
 * The Results screen's latency hand-over: "this run says the offset should have been X, not Y —
 * use X for the next session?".
 *
 * Why this is a first-class control and not a line of advice. The camera pipeline's latency is the
 * one calibration a therapist cannot judge by eye: the patient moves, the note is judged 150 ms
 * later, and everything downstream (accuracy, ROM samples, the rep/hit gap) is wrong by the same
 * amount. The run itself measures it better than the ten-tap latency screen does — a whole song of
 * judged crossings — so the useful thing to do with that number is to OFFER IT, with the value it
 * replaces next to it so the therapist can refuse an implausible one.
 *
 * It is shown prominently only when the disagreement exceeds one good window (see latencyAdvice):
 * below that, every note still lands in the window it was going to land in and there is nothing to
 * fix. Above it, honest movements are being judged outside the window and the session under-reports
 * what the patient did.
 */
import { useState } from 'react';
import { latencyAdvice } from '../session/latencyAdvice.ts';
import { formatDate } from '../session/results.ts';
import type { SessionResult } from '../session/types.ts';
import { useStore } from '../state/store.ts';
import type { LatencyChange } from '../state/store.ts';

export default function LatencyHandover({ result }: { result: SessionResult }) {
  const applySuggestedLatency = useStore((s) => s.applySuggestedLatency);
  const latencyOffsetSec = useStore((s) => s.latencyOffsetSec);
  const [applied, setApplied] = useState<LatencyChange | null>(null);

  const advice = latencyAdvice(result);
  if (!advice) return null;

  // Already in force (the therapist applied it, or it was re-measured elsewhere): say so and stop.
  const currentMs = Math.round(latencyOffsetSec * 1000);
  const done = applied !== null || currentMs === advice.suggestedMs;

  if (!advice.significant && !done) {
    // Real but harmless: a note, not a call to action.
    return (
      <div className="card row" data-testid="latency-handover">
        <span className="badge badge-ok">Latency looks right</span>
        <span className="dim">
          The run suggests {advice.suggestedMs} ms against the {advice.currentMs} ms in force — inside one good
          window (±{Math.round(advice.goodWindowMs)} ms), so nothing was judged out of position.
        </span>
        <div className="grow" />
        <button
          className="btn"
          onClick={() => setApplied(applySuggestedLatency(advice.suggestedMs, `${result.songTitle}, ${formatDate(result.startedAt)}`))}
          data-testid="apply-latency"
        >
          Use {advice.suggestedMs} ms anyway
        </button>
      </div>
    );
  }

  return (
    <div className={done ? 'latency-panel applied' : 'latency-panel'} data-testid="latency-handover">
      <div className="stack" style={{ gap: 6 }}>
        <div className="eyebrow">{done ? 'Camera offset updated' : 'Camera offset is out by more than a good window'}</div>
        <h3 style={{ margin: 0 }}>
          {done
            ? `The next session will be judged at ${applied?.appliedMs ?? currentMs} ms.`
            : `Movements were judged ${Math.abs(advice.deltaMs)} ms ${advice.deltaMs > 0 ? 'late' : 'early'}.`}
        </h3>
        {!done && (
          <p className="muted" style={{ margin: 0 }}>
            A good window in this session is ±{Math.round(advice.goodWindowMs)} ms, so a steady{' '}
            {Math.abs(advice.deltaMs)} ms of bias pushed honest movements outside it — the camera pipeline is{' '}
            {advice.deltaMs > 0 ? 'slower' : 'faster'} than the {advice.currentMs} ms this session assumed. That is the
            equipment, not the patient: the accuracy and hit counts below are an under-estimate of what they did.
          </p>
        )}
      </div>

      <div className="latency-swap">
        <div className="val now">
          <span className="eyebrow">{done ? 'Was' : 'In force now'}</span>
          <b className="mono">{applied ? applied.previousMs : advice.currentMs} ms</b>
        </div>
        <span className="arrow" aria-hidden="true">
          →
        </span>
        <div className="val next">
          <span className="eyebrow">{done ? 'Now' : 'Measured this run'}</span>
          <b className="mono">{applied ? applied.appliedMs : advice.suggestedMs} ms</b>
        </div>
        <div className="grow" />
        {done ? (
          <span className="badge badge-ok">Saved on this device</span>
        ) : (
          <button
            className="btn btn-primary btn-lg"
            onClick={() => setApplied(applySuggestedLatency(advice.suggestedMs, `${result.songTitle}, ${formatDate(result.startedAt)}`))}
            data-testid="apply-latency"
          >
            Use {advice.suggestedMs} ms next session
          </button>
        )}
      </div>

      <span className="dim">
        {done
          ? 'The latency check on the next session starts from this value; re-run it if the camera or the room changes.'
          : 'Applying this skips nothing — the latency check is still offered before the next session, starting from this value.'}
      </span>
    </div>
  );
}
