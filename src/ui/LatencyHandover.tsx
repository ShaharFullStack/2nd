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
 * Three rules this panel is held to, all learned the hard way:
 *
 *  1. IT IS THE CAMERA'S OFFSET. A keyboard run measures a human's reaction bias and the autoplay bot
 *     measures its own jitter; neither says anything about how long MediaPipe takes to see a hand.
 *     On a non-camera run the panel explains the number and offers NO button, because applying it
 *     would silently corrupt the next real session.
 *  2. IT OFFERS WHAT IT WILL STORE. The store keeps 0..1000 ms, so a −2 ms suggestion becomes 0 ms.
 *     The button names the value that will actually be in force, never the raw suggestion.
 *  3. IT IS UNDOABLE. Applying is a persisted write on a prominent primary button; a misclick must
 *     not cost a re-run of the latency screen, so the applied state keeps a revert next to it.
 *
 * It is shown prominently only when the disagreement exceeds one good window (see latencyAdvice):
 * below that, every note still lands in the window it was going to land in and there is nothing to
 * fix. Above it, honest movements are being judged outside the window and the session under-reports
 * what the patient did.
 */
import { useState } from 'react';
import { LATENCY_MAX_MS, LATENCY_MIN_MS, latencyAdvice } from '../session/latencyAdvice.ts';
import { formatDate } from '../session/results.ts';
import type { SessionResult } from '../session/types.ts';
import { useStore } from '../state/store.ts';
import type { LatencyChange } from '../state/store.ts';

const MODE_NOUN: Record<string, string> = {
  keyboard: 'keyboard',
  autoplay: 'autoplay bot',
  camera: 'camera',
};

export default function LatencyHandover({ result }: { result: SessionResult }) {
  const applySuggestedLatency = useStore((s) => s.applySuggestedLatency);
  const setLatency = useStore((s) => s.setLatency);
  const latencyOffsetSec = useStore((s) => s.latencyOffsetSec);
  const [applied, setApplied] = useState<LatencyChange | null>(null);

  const advice = latencyAdvice(result);
  if (!advice) return null;

  const source = `${result.songTitle}, ${formatDate(result.startedAt)}`;
  const apply = () => setApplied(applySuggestedLatency(advice.applicableMs, source));
  /**
   * Put back exactly what was in force before the click — INCLUDING its provenance.
   *
   * `latencyMeasured` and `latencyNote` are clinical facts about the offset — they are what the
   * latency screen prints beside the number in force, so a therapist can tell "280 ms measured from
   * last Tuesday's run" from "280 ms of unknown origin". Restoring the number while writing
   * `measured: false` would make undoing a misclick cost the previous value's provenance. The note is
   * restored too, and only replaced when there was none.
   */
  const revert = () => {
    if (!applied) return;
    setLatency(
      applied.previousMs / 1000,
      applied.previousMeasured,
      applied.previousNote || `${applied.previousMs} ms restored after undoing the ${source} suggestion`,
    );
    setApplied(null);
  };

  // A run the camera did not drive says nothing about the camera pipeline. Explain the number, offer
  // nothing to apply — this is the one case where the missing button IS the correct remedy.
  if (!advice.appliesToCamera) {
    return (
      <div className="card stack" data-testid="latency-handover">
        <div className="row">
          <span className="badge badge-warn">Not a camera measurement</span>
          <b>This run's {advice.suggestedMs} ms is not the camera's latency.</b>
        </div>
        <span className="dim" data-testid="latency-not-camera">
          The lanes were driven by the {MODE_NOUN[advice.inputMode] ?? advice.inputMode}, so the timing bias measures
          {advice.inputMode === 'autoplay' ? " the bot's own scheduling" : " whoever pressed the keys"} — not how long
          the camera takes to see a movement. The camera offset stays at {advice.currentMs} ms; re-measure it in a
          camera session or on the latency screen.
        </span>
      </div>
    );
  }

  // Already in force (the therapist applied it, or it was re-measured elsewhere): say so and stop.
  const currentMs = Math.round(latencyOffsetSec * 1000);
  const buttonMs = advice.applicableMs;
  const inForce = currentMs === buttonMs;
  // "Updated" is claimed only when there was something to update: a −2 ms suggestion that clamps onto
  // the 0 ms already in force must not render as a change the therapist made.
  const done = applied !== null || (inForce && advice.significant);

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
        {inForce ? (
          <span className="badge">already in force</span>
        ) : (
          <button className="btn" onClick={apply} data-testid="apply-latency">
            Use {buttonMs} ms anyway
          </button>
        )}
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
            {advice.deltaMs > 0 ? 'slower' : 'faster'} than the {advice.currentMs} ms{' '}
            <b>this session was judged at</b>. That is the equipment, not the patient: the accuracy and hit counts
            below are an under-estimate of what they did.
          </p>
        )}
        {/* TWO DIFFERENT NUMBERS, NAMED. The sentence above quotes the offset THIS RUN was judged at
            (it is a property of the stored record); the swap below quotes what is on the device right
            now. They are the same unless the latency screen has been re-run since the session, and a
            therapist deciding whether the suggestion is plausible must not have to guess which is
            which when they differ. */}
        {!done && advice.currentMs !== currentMs && (
          <p className="muted" style={{ margin: 0 }} data-testid="latency-drift">
            This device has been set to <b>{currentMs} ms</b> since that run — most likely the latency screen was
            re-run. {currentMs} ms is the value the swap below replaces; {advice.currentMs} ms is what the figures on
            this page were judged against.
          </p>
        )}
      </div>

      <div className="latency-swap">
        <div className="val now">
          <span className="eyebrow">{done ? 'Was (on this device)' : 'In force now (this device)'}</span>
          {/* The STORE's value, not the run's: this pair is what will change on this device. They are
              the same number unless the latency screen has been re-run since the session, and when
              they are not, the note above says so. */}
          <b className="mono">{applied ? applied.previousMs : currentMs} ms</b>
        </div>
        <span className="arrow" aria-hidden="true">
          →
        </span>
        <div className="val next">
          <span className="eyebrow">{done ? 'Now (on this device)' : 'Measured this run'}</span>
          <b className="mono">{applied ? applied.appliedMs : buttonMs} ms</b>
        </div>
        <div className="grow" />
        {done ? (
          <div className="row">
            <span className="badge badge-ok">Saved on this device</span>
            {applied && applied.previousMs !== applied.appliedMs && (
              <button className="btn" onClick={revert} data-testid="revert-latency">
                Undo — back to {applied.previousMs} ms
              </button>
            )}
          </div>
        ) : (
          <button className="btn btn-primary btn-lg" onClick={apply} data-testid="apply-latency">
            Use {buttonMs} ms next session
          </button>
        )}
      </div>

      {!done && advice.clamped && (
        <span className="dim" data-testid="latency-clamped">
          The run's raw figure is {advice.suggestedMs} ms; the offset is kept between {LATENCY_MIN_MS} and {LATENCY_MAX_MS} ms, so applying it
          stores {buttonMs} ms. A suggestion this far outside the range usually means too few clean hits to measure
          from — re-run the latency check if it repeats.
        </span>
      )}

      <span className="dim">
        {done
          ? 'The latency check on the next session starts from this value; re-run it if the camera or the room changes.'
          : 'Applying this skips nothing — the latency check is still offered before the next session, starting from this value.'}
      </span>
    </div>
  );
}
