/**
 * What the patient did today — and only then, for the therapist, how it scored.
 *
 * THIS SCREEN USED TO BE A REPORT CARD ON AN IMPAIRMENT. It led with a score, five stars (zero of
 * them below 25 % weighted accuracy) and a bare "10 % weighted accuracy", followed by a nine-column
 * clinical table; it never read the history, so a patient four weeks post-stroke saw a grade with no
 * memory and no direction. A rehab session is not graded: it is counted. So the headline is now the
 * work — movements performed, range achieved, today against last time — the clinical detail is kept
 * in full but folded away for the therapist, and the score has stopped being the first thing anybody
 * reads.
 *
 * The comparison is PATIENT-SCOPED and CAMERA-ONLY, through `patientSessions`/`isPatientDriven`
 * (session/trends.ts): a clinic tablet's history is device-wide, and a keyboard or autoplay run is
 * the system producing the input, not the patient producing a movement.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ANSWER_WARMUP_NOTES } from '../engine/scoring.ts';
import {
  endReasonLabel,
  formatDuration,
  formatMs,
  formatPercent,
  laneRangeSummaries,
  laneTrendKey,
  mostImprovedRange,
} from '../session/results.ts';
import type { LaneRangeSummary } from '../session/results.ts';
import { timingResolutionMs } from '../session/tracking.ts';
import { isPatientDriven, patientSessions } from '../session/trends.ts';
import type { LaneResultSummary, SessionResult } from '../session/types.ts';
import { useStore } from '../state/store.ts';
import { FEATURE_UNIT_SHORT, formatFeature } from '../vision/calibration.ts';
import { Meter, Screen, Stars, Toast, TopBar } from './common.tsx';
import { MeasurementNote } from './ScopeNote.tsx';
import LatencyHandover from './LatencyHandover.tsx';

/** "+12" / "−3" / "—". Deltas are stated as counts, never as a pass mark. */
function delta(now: number, then: number | null): string | null {
  if (then === null || !Number.isFinite(then)) return null;
  const d = now - then;
  if (d === 0) return 'same as last time';
  return `${d > 0 ? '+' : '−'}${Math.abs(Math.round(d))} vs last time`;
}

/** A signed change in the movement's own units, for the per-limb range tiles. */
function signedFeature(d: number, unit: 'deg' | 'ratio'): string {
  const sign = d > 0 ? '+' : '−';
  return `${sign}${formatFeature(Math.abs(d), unit)}`;
}

/** True when a change is smaller than the units it would be printed in can show. */
function belowResolution(d: number, unit: 'deg' | 'ratio'): boolean {
  return formatFeature(Math.abs(d), unit) === formatFeature(0, unit);
}

/**
 * WHAT CHANGED SINCE LAST TIME, in a unit that can actually show it.
 *
 * A knee that went 152.6° → 153.2° printed "+0° vs last time", which is neither the truth ("no
 * change") nor the measurement (+0.6°) — it is the rounding, presented as a finding. Where the
 * movement's own units cannot resolve the change, the same change is stated as a share of THAT
 * movement's calibrated range, which is the quantity the ranking uses anyway; where neither can
 * resolve it, it really is no change and says so.
 */
function gainLabel(s: LaneRangeSummary): { text: string; note?: string } | null {
  if (s.gain === null && s.gainPct === null) return null;
  if (s.gain !== null && !belowResolution(s.gain, s.unit)) return { text: `${signedFeature(s.gain, s.unit)} vs last time` };
  if (s.gainPct !== null && Math.abs(s.gainPct) >= 0.005) {
    const pts = Math.abs(Math.round(s.gainPct * 100));
    return {
      // The badge stays one line at 1024 (measured: 18 characters is 184 px in a 265 px tile); the
      // unit it is in — which is NOT the movement's own unit here — goes on the line under it.
      text: `${s.gainPct > 0 ? '+' : '−'}${pts} ${pts === 1 ? 'pt' : 'pts'} vs last time`,
      note: `in points of this movement’s own calibrated range: the change is under ${formatFeature(1, s.unit)}`,
    };
  }
  return { text: 'same as last time' };
}

/**
 * A WIDE TABLE THAT SAYS IT IS WIDE, AND CAN BE MOVED WITHOUT A MOUSE.
 *
 * `.table-wrap` is `overflow-x: auto` and nothing else. On the clinic target size (1024x768) the
 * clinical table measured 1302 px inside a 961 px scroller: the COMPENSATION badge and the best-rep
 * column were simply not on the screen, with no scrollbar drawn (overlay scrollbars on a touch
 * device appear only while scrolling) and no other hint that anything was missing. A therapist
 * reading "no compensation flags" off a table that never showed them the column is the worst
 * failure this screen has.
 *
 * So the overflow is MEASURED and, when there is any, stated in words and given two full-size
 * buttons. Both are live: the message names the columns that are off-screen and the arrows page the
 * scroller, so the columns are reachable by touch on a tablet with no keyboard and no mouse.
 */
export function ScrollTable({
  children,
  offscreen,
  testId,
}: {
  children: ReactNode;
  /** The columns a reader loses first — named in the cue, because "scroll" alone says nothing. */
  offscreen: string;
  testId?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<{ more: boolean; back: boolean } | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => {
      const slack = el.scrollWidth - el.clientWidth;
      if (slack <= 4) {
        setState((s) => (s === null ? s : null));
        return;
      }
      const next = { more: el.scrollLeft < slack - 4, back: el.scrollLeft > 4 };
      setState((s) => (s && s.more === next.more && s.back === next.back ? s : next));
    };
    read();
    el.addEventListener('scroll', read, { passive: true });
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(read);
    ro?.observe(el);
    return () => {
      el.removeEventListener('scroll', read);
      ro?.disconnect();
    };
  });

  const page = (dir: 1 | -1) => {
    const el = ref.current;
    if (!el) return;
    el.scrollBy({ left: dir * Math.max(160, el.clientWidth * 0.7), behavior: 'smooth' });
  };

  return (
    <div className="stack" style={{ gap: 8 }}>
      {/* ABOVE THE TABLE, NEXT TO THE HEADER ROW THE MISSING COLUMNS BELONG TO. A five-session
          history table is two screens tall, so a cue underneath it is a cue the therapist reads
          after they have finished reading the table they did not know was incomplete. */}
      {state && (
        <div className="row" style={{ gap: 10 }} data-testid={testId ? `${testId}-scroll-cue` : 'table-scroll-cue'}>
          <button className="btn btn-sm" onClick={() => page(-1)} disabled={!state.back} aria-label="Scroll table left">
            ←
          </button>
          <button className="btn btn-sm" onClick={() => page(1)} disabled={!state.more} aria-label="Scroll table right">
            →
          </button>
          <span className="dim">
            {state.more
              ? `This table is wider than the screen — ${offscreen} are off to the right. Swipe it or use the arrows.`
              : 'Scrolled to the end of this table — the arrows bring the first columns back.'}
          </span>
        </div>
      )}
      <div className="table-wrap" ref={ref} data-testid={testId}>
        {children}
      </div>
    </div>
  );
}

/** One prescribed movement's range, as the headline treats it: on its own, against its own range. */
function RangeTile({ s, improved }: { s: LaneRangeSummary; improved: boolean }) {
  const gain = gainLabel(s);
  return (
    <div
      className="stack"
      style={{
        gap: 6,
        padding: '14px 16px',
        borderRadius: 14,
        border: '1px solid var(--line)',
        background: 'rgba(255,255,255,0.03)',
        minWidth: 0,
      }}
      data-testid={`results-range-lane-${s.lane}`}
    >
      <div className="eyebrow" style={{ whiteSpace: 'normal' }}>
        {s.movementName}
      </div>
      {s.measured ? (
        <>
          <div className="big-number mono" style={{ fontSize: 'clamp(1.9rem, 3.2vw, 2.6rem)' }}>
            {s.best === null ? formatPercent(s.bestFraction) : formatFeature(s.best, s.unit)}
          </div>
          <div className="dim">
            best rep · {formatPercent(s.bestFraction)} of this movement’s own calibrated range · {s.reps} reps
          </div>
          <div className="row" style={{ gap: 8 }}>
            {gain !== null && (
              <span className={(s.gainPct ?? 0) > 0 ? 'badge badge-ok' : 'badge'} data-testid={`results-range-gain-${s.lane}`}>
                {gain.text}
              </span>
            )}
            {improved && (
              <span className="badge badge-ok" data-testid={`results-range-improved-${s.lane}`}>
                biggest gain today
              </span>
            )}
          </div>
          {gain?.note && <div className="dim">{gain.note}</div>}
        </>
      ) : (
        <>
          <div className="big-number mono" style={{ fontSize: 'clamp(1.9rem, 3.2vw, 2.6rem)' }}>
            —
          </div>
          <div className="dim">no range was measured in this movement</div>
        </>
      )}
    </div>
  );
}

export default function ResultsScreen() {
  const goto = useStore((s) => s.goto);
  const result = useStore((s) => s.lastResult);
  const setSeed = useStore((s) => s.setSeed);
  const seed = useStore((s) => s.seed);
  const history = useStore((s) => s.history);

  /**
   * The previous session THIS patient drove, if any. The record for the run just finished is already
   * in the history, so it is excluded by id rather than by position.
   */
  const previous: SessionResult | null = useMemo(() => {
    if (!result || !isPatientDriven(result)) return null;
    const mine = patientSessions(history, result.patientId).filter((s) => s.id !== result.id && isPatientDriven(s));
    return mine[0] ?? null; // history is newest-first
  }, [history, result]);

  const previousLanes = useMemo(() => {
    const map = new Map<string, LaneResultSummary>();
    for (const l of previous?.lanes ?? []) map.set(laneTrendKey(l), l);
    return map;
  }, [previous]);

  /**
   * PER LIMB, IN PRESCRIPTION ORDER, NEVER A MAXIMUM ACROSS LANES. See `laneRangeSummaries` — the
   * headline used to be `max(romBest)` over every lane, which on a mixed hemiparetic prescription
   * picks the unaffected side essentially every time.
   */
  const ranges = useMemo(() => laneRangeSummaries(result?.lanes ?? [], previousLanes), [result, previousLanes]);
  const improved = useMemo(() => mostImprovedRange(ranges), [ranges]);

  if (!result) {
    return (
      <Screen>
        <TopBar title="No session to show" onBack={() => goto('home')} />
        <button className="btn btn-primary btn-lg" onClick={() => goto('home')}>
          Back to start
        </button>
      </Screen>
    );
  }

  const measuredRanges = ranges.filter((r) => r.measured);
  /** This lane, last time — for the rep delta beside each movement. */
  const previousByLane = new Map<number, LaneResultSummary | null>(
    result.lanes.map((l) => [l.lane, previousLanes.get(laneTrendKey(l)) ?? null]),
  );
  /** The units in play, for the one sentence that says what the figures above are measured in. */
  const units = Array.from(new Set(measuredRanges.map((r) => r.unit)));
  const sessionsSoFar = patientSessions(history, result.patientId).filter(isPatientDriven).length;

  /** The finest timing difference this session's camera stream could resolve (null when unrecorded). */
  const timingRes = result.tracking ? timingResolutionMs(result.tracking) : null;

  const judged = result.hits + result.misses;
  /** Notes answered with a movement, bounded by the notes offered — null on a pre-`answerRate` record. */
  const answerRate = typeof result.answerRate === 'number' && Number.isFinite(result.answerRate) ? result.answerRate : null;
  /**
   * Counted from the lanes where the record carries them; the rate is the fallback for older ones.
   *
   * AND NEVER MORE THAN THE NOTES OFFERED, AND NEVER AT ODDS WITH THE PERCENTAGE ABOVE IT. The screen
   * must not be able to print "a movement was made for 120 of the 189 notes" from a record whose
   * per-lane and session totals disagree (a hand-built or half-migrated record) — and it must not be
   * able to print a 74 % headline over a count that works out at 98 % either, which the ≤ judged test
   * alone allowed. Real records derive both figures from the same Scoring totals, so the two agree and
   * the lane sum (the exact integer) is used; when they do not, the count is derived from the rate
   * that is being displayed, so the card says one thing.
   */
  const laneAttempted = result.lanes.every((l) => typeof l.attempted === 'number')
    ? result.lanes.reduce((n, l) => n + (l.attempted ?? 0), 0)
    : null;
  const fromRate = Math.round((answerRate ?? 0) * judged);
  const answered =
    laneAttempted !== null && laneAttempted <= judged && (answerRate === null || Math.abs(laneAttempted - fromRate) <= 1)
      ? laneAttempted
      : fromRate;
  const surplus =
    typeof result.surplusMovements === 'number' && Number.isFinite(result.surplusMovements)
      ? result.surplusMovements
      : null;
  /**
   * MOVING AND NOT SCORING. Fires on the ratio, so the common partial fault (280 movements, 12 hits)
   * is called out as loudly as the total one. Ten movements is the floor for saying anything at all:
   * below that there is no evidence either way.
   */
  const fault = isPatientDriven(result) && result.reps >= 10 && result.hits <= 0.25 * result.reps;

  /** How the two sessions' PRESCRIBED dose differed, or null when they asked for the same thing. */
  const pacingNote: string | null = (() => {
    if (!previous) return null;
    const now = result.laneRestSec;
    const then = previous.laneRestSec;
    if (now === undefined || then === undefined) {
      return 'The pacing of one of these sessions was not recorded, so the number of reps ASKED FOR may have differed — read the change in reps with that in mind.';
    }
    if (Math.abs(now - then) < 0.05) return null;
    // PER LANE, not per limb — the same correction the setup card and the export carry: the rest is
    // between two reps of the SAME MOVEMENT, and a limb with two lanes on it can be asked for both
    // inside it. This sentence is read beside a rep count, so the unit has to be the right one.
    return `The pacing differed: last session allowed ${then.toFixed(1)} s between two reps of the same movement and this one ${now.toFixed(1)} s (that rest is per lane, not per limb), so the two sessions asked for different numbers of reps. The change in reps performed is partly the prescription, not the patient.`;
  })();

  return (
    <Screen testId="results-screen">
      <TopBar
        eyebrow={`${result.patientName || 'No patient recorded'} · ${result.completed ? 'Session complete' : `Session ${endReasonLabel(result.endReason ?? null)}`}`}
        title={result.songTitle}
        right={
          <>
            <button
              className="btn btn-lg"
              onClick={() => {
                setSeed(seed + 1);
                goto('play');
              }}
              data-testid="play-again"
            >
              Play again
            </button>
            <button className="btn btn-primary btn-lg" onClick={() => goto('mode')}>
              New session
            </button>
          </>
        }
      />

      {/*
        A SESSION THE PATIENT DID NOT DRIVE IS NOT A CLINICAL RESULT, and it says so before any figure
        on the screen is read. Every number below (score, "movements performed", accuracy, timing) is a
        property of the keyboard or of the autoplay bot; none of it was measured on the patient, and
        none of it reaches the progress trend on the History screen.
      */}
      {result.inputMode !== 'camera' && (
        <div className="quarantine" data-testid="results-not-measured">
          <span className="glyph" aria-hidden="true">
            {result.inputMode === 'autoplay' ? '🤖' : '⌨️'}
          </span>
          <div className="stack" style={{ gap: 6 }}>
            <h3 style={{ margin: 0 }}>
              {result.inputMode === 'autoplay' ? 'Autoplay demo — not a patient session' : 'Keyboard session — no movement was measured'}
            </h3>
            <p className="muted" style={{ margin: 0 }}>
              The lanes were driven by {result.inputMode === 'autoplay' ? 'the autoplay bot' : 'keys 1–4'}, not by the
              patient's movement. The figures below describe{' '}
              {result.inputMode === 'autoplay' ? 'the bot' : 'whoever pressed the keys'}: no range of motion was
              recorded, the reps are keypresses, and this session is excluded from the progress trend on the history
              screen.
            </p>
          </div>
        </div>
      )}

      {/*
        THE HEADLINE IS THE WORK — AND THE WORK IS PER LIMB.

        This card used to print ONE figure, `max(romBest)` across every lane, under the words "RANGE
        ACHIEVED". A hemiparetic prescription mixes an affected limb with an unaffected one on
        purpose, so the maximum is the strong side almost every time: the screen celebrated the leg
        the patient did not come about and filed the one they did into a table below the fold. There
        is no "affected side" field to headline instead — `Patient` holds a name and an id and
        nothing else, deliberately — and inventing one from the numbers would be a clinical claim
        made up by a UI. So every prescribed movement gets its own figure, against its OWN calibrated
        range, in prescription order, and nothing is ranked except a patient against themselves.
      */}
      <div className="card stack" data-testid="results-range">
        <div className="row">
          <div className="eyebrow">Range achieved · every movement worked</div>
          <div className="grow" />
          {improved && (
            <span className="dim" data-testid="results-range-most-improved">
              Biggest gain since last session: {improved.movementName}
            </span>
          )}
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: `repeat(auto-fit, minmax(${ranges.length > 2 ? 210 : 260}px, 1fr))`,
            gap: 12,
            alignItems: 'stretch',
          }}
        >
          {ranges.map((s) => (
            <RangeTile key={s.lane} s={s} improved={improved?.lane === s.lane} />
          ))}
        </div>
        {/* WHAT THE NUMBERS ARE. A ratio movement prints a bare "0.34" — the unit has no symbol, so
            it has to be said in words or the figures above mean nothing. */}
        <div className="dim" data-testid="results-range-unit">
          {measuredRanges.length === 0
            ? 'No range was measured in this session.'
            : `Each figure is that movement’s best rep, measured in ${units
                .map((u) => FEATURE_UNIT_SHORT[u])
                .join(' and ')}${units.includes('ratio') ? ' — the movement against this patient’s own torso (or palm) size' : ' at the joint'}, out of the range calibrated for THAT movement today. Ranges from different movements are never compared with each other.`}
        </div>
        {/*
          WHAT THESE FIGURES ARE, AND HOW WELL THEY WERE MEASURED — under the degrees, where they are
          read. The scope statement used to live only in the README while this card printed a joint
          angle to one decimal place; the tracking line beside it is the difference between a range
          measured on a steady 30 fps stream and one measured on a 12 fps stream with the limb
          drifting out of frame, which the record could not previously tell apart at all.
        */}
        <MeasurementNote tracking={result.tracking} inputMode={result.inputMode} full testId="results-measurement-note" />
      </div>

      <div className="card-grid" style={{ alignItems: 'stretch' }}>
        <div className="card stack" data-testid="results-reps">
          <div className="eyebrow">Movements performed</div>
          <div className="big-number mono">{result.reps}</div>
          <div className="dim">
            across {result.lanes.length} movement{result.lanes.length === 1 ? '' : 's'} in {formatDuration(result.durationSec)}
          </div>
          <div className="dim" data-testid="results-reps-delta">
            {!isPatientDriven(result)
              ? 'Not compared: the patient did not drive this session'
              : previous
                ? (delta(result.reps, previous.reps) ?? '')
                : 'First recorded session for this patient'}
          </div>
          {/* Only when the song did not run to the end: otherwise judged == the whole chart and the
              line says nothing. A short session is a fact about the dose, so it is stated. */}
          {result.totalNotes > judged && judged > 0 && (
            <div className="dim" data-testid="results-short-session">
              {judged} of the {result.totalNotes} notes prescribed were reached before the session ended
            </div>
          )}
          <div className="grow" />
          {/* MOVEMENTS THAT ANSWERED NO NOTE ARE A FACT ABOUT THE MOVEMENTS, so they belong to this
              card rather than to the notes-answered one — where they also left that cell three lines
              taller than its neighbours and set the height of the whole row. */}
          <div className="dim" data-testid="results-surplus">
            {surplus === null
              ? ''
              : surplus > 0
                ? `${surplus} further movement${surplus === 1 ? '' : 's'} answered no note (${result.reps} performed in total)`
                : 'every movement performed answered a note'}
          </div>
        </div>

        {/*
          NOTES ANSWERED — the highway gauge's own quantity, bounded by the notes that were offered.
          It used to be movements ÷ notes CLAMPED to 1, which produced a full green card and the
          sentence "movements made for 280 of the 189 notes offered" for a tremor session that landed
          6 % of its notes. The clamp hid the one case it mattered for; the surplus is now its own
          figure below, because more movements than notes is a finding, not a success.
        */}
        <div className="card stack" data-testid="results-consistency">
          <div className="eyebrow">Notes answered</div>
          <div className="big-number mono">{answerRate === null ? '—' : formatPercent(answerRate)}</div>
          <div className="dim">
            {answerRate === null
              ? 'not recorded for this session'
              : `a movement was made for ${answered} of the ${judged} notes offered — the quantity the gauge on the highway shows`}
          </div>
          {answerRate !== null && <Meter value={answerRate} label="notes answered with a movement" />}
        </div>

        <div className="card stack" data-testid="results-sessions">
          <div className="eyebrow">Camera sessions recorded</div>
          <div className="big-number mono">{sessionsSoFar}</div>
          <div className="dim">
            {previous ? `last session ${formatDuration(previous.durationSec)}, ${previous.reps} movements` : 'this is the first'}
          </div>
          {/* The spacer is what makes this card FILL its cell. The grid stretches every card to the
              tallest in the row, and this one carries three short lines: without it the button sat
              directly under the caption with ~300 px of empty panel below it at 1280. */}
          <div className="grow" />
          <button className="btn" onClick={() => goto('history')} data-testid="open-history-from-results">
            Progress over time
          </button>
        </div>
      </div>

      {/*
        A REP COUNT IS ONLY COMPARABLE AGAINST THE DOSE THAT WAS ASKED FOR. Pacing is the control
        that sets that dose directly — the same patient, song and difficulty gives 24 reps a lane at
        3.0 s and 96 at 0.4 s — so "+26 vs last time" is meaningless unless both sessions were asked
        for the same number. It is a paragraph, and a paragraph inside one grid cell is what stretched
        the whole row and left the short cards with a field of empty panel; it belongs to the
        comparison, not to one card, so it sits across the row it qualifies.
      */}
      {/* NOT THE SAME NUMBER AS THE GAUGE ON A SHORT SESSION. The live gauge holds its needle up over
          the opening notes so one missed first note does not empty it; the stored record is the
          measurement itself, from note one. On the session a therapist stops after a handful of
          notes — exactly what a struggling patient produces — the two differ, and this card used to
          caption the figure "the gauge on the highway" full stop. Like the pacing note, it is a
          paragraph about a figure rather than part of it, and a paragraph inside one grid cell sets
          the height of the whole row. */}
      {answerRate !== null && (
        <div className="dim" data-testid="results-answer-basis">
          Notes answered is counted from the first note. The gauge on the highway eases its first{' '}
          {ANSWER_WARMUP_NOTES} notes, so a session stopped after a few notes reads higher there than here.
        </div>
      )}
      {previous && isPatientDriven(result) && pacingNote && (
        <div className="dim" data-testid="results-pacing-note">
          {pacingNote}
        </div>
      )}

      {/*
        THE FAULT TOAST FIRES ON A RATIO, NOT ON ZERO. Gated on `hits === 0` it never fired for the
        far more common partial fault: 280 movements, 12 hits, and the screen said nothing at all
        while a 100 % card sat above it. A patient who is moving and not scoring is a measurement
        problem until proven otherwise, and the threshold is the same one a therapist would use by
        eye — most of the work produced no score.
      */}
      {fault && (
        <Toast kind="bad">
          <strong data-testid="results-fault">This looks like a calibration or latency fault, not a performance.</strong>{' '}
          The patient performed {result.reps} movements and {result.hits === 0 ? 'none of them' : `only ${result.hits}`}{' '}
          scored{judged > 0 ? ` against ${judged} notes` : ''}
          {result.timingBiasMs !== null ? `, with the timing running ${formatMs(result.timingBiasMs)}` : ''}. Check the
          ROM ranges and re-run the latency check before reading anything below as the patient's performance.
        </Toast>
      )}

      {/* TODAY AGAINST LAST TIME, per movement — the question a rehab session is actually asking. */}
      <div className="card stack" data-testid="results-today">
        <div className="row">
          <h3>Today, movement by movement</h3>
          <div className="grow" />
          <span className="dim">
            {previous
              ? 'compared with this patient’s last camera session'
              : result.inputMode === 'camera'
                ? 'no earlier camera session to compare with yet'
                : 'comparison is only drawn between camera sessions'}
          </span>
        </div>
        <ScrollTable offscreen="the best-rep column and the comparison with last time" testId="results-today-table">
          <table className="table">
            <thead>
              <tr>
                <th>Movement</th>
                <th>Reps</th>
                <th>Range (mean rep)</th>
                <th>Best rep</th>
              </tr>
            </thead>
            <tbody>
              {ranges.map((s) => {
                const was = previousByLane.get(s.lane) ?? null;
                const wasMean =
                  was && was.romSamples > 0 && was.romMean !== null && was.calibratedMin !== null && was.calibratedMax !== null
                    ? was.calibratedMin + was.romMean * (was.calibratedMax - was.calibratedMin)
                    : null;
                return (
                  <tr key={s.lane} data-testid={`results-today-lane-${s.lane}`}>
                    <td style={{ whiteSpace: 'normal' }}>
                      <b>{s.movementName}</b>
                    </td>
                    <td>
                      <b className="mono">{s.reps}</b>
                      {was && <div className="dim">{delta(s.reps, was.reps)}</div>}
                    </td>
                    <td>
                      {s.measured ? (
                        <>
                          <span className="mono">{s.mean === null ? formatPercent(s.meanFraction) : formatFeature(s.mean, s.unit)}</span>
                          <div className="dim">
                            {formatPercent(s.meanFraction)} of the calibrated range
                            {wasMean !== null && s.mean !== null ? ` · was ${formatFeature(wasMean, s.unit)}` : ''}
                          </div>
                        </>
                      ) : (
                        <span className="dim">not measured</span>
                      )}
                    </td>
                    <td>
                      {s.bestFraction === null ? (
                        <span className="dim">—</span>
                      ) : (
                        <>
                          <span className="mono">
                            {s.best === null ? formatPercent(s.bestFraction) : formatFeature(s.best, s.unit)}
                          </span>
                          {s.gain !== null && !belowResolution(s.gain, s.unit) && (
                            <div className="dim">{signedFeature(s.gain, s.unit)} vs last time</div>
                          )}
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </ScrollTable>
        {previous && previous.difficulty !== result.difficulty && (
          <span className="dim">
            Last session was prescribed at {previous.difficulty} and this one at {result.difficulty}: the accuracy is
            not comparable. Whether the REPS are comparable depends on the pacing, stated above.
          </span>
        )}
        {previous && pacingNote && <span className="dim">{pacingNote}</span>}
      </div>

      <LatencyHandover result={result} />

      {/* THE CLINICAL DETAIL, kept in full — and kept out of the patient's first glance. */}
      <details className="card stack" data-testid="results-clinical">
        <summary className="dim">Clinical detail — scoring, timing and compensation</summary>

        <div className="card-grid" style={{ marginTop: 12 }}>
          <div className="stack" style={{ gap: 4 }}>
            <div className="eyebrow">Score</div>
            <div className="big-number mono">{result.score.toLocaleString()}</div>
            <Stars value={result.stars} />
            <div className="dim">
              {formatPercent(result.starAccuracy)} of notes hit with the timing weighted (goods count 0.75) · best combo{' '}
              {result.maxCombo}
            </div>
          </div>
          <div className="stack" style={{ gap: 4 }}>
            <div className="eyebrow">Notes hit</div>
            <div className="big-number mono">{result.hits}</div>
            <div className="dim">
              {result.misses} missed of {result.totalNotes} notes · {result.difficulty} · windows ×
              {result.windowScale.toFixed(2)}
            </div>
            <Meter value={result.totalNotes > 0 ? result.hits / result.totalNotes : 0} label="notes hit" />
          </div>
          <div className="stack" style={{ gap: 4 }}>
            <div className="eyebrow">Timing bias</div>
            <div className="big-number mono">{formatMs(result.timingBiasMs)}</div>
            <div className="dim">
              spread ±{result.timingBiasMadMs === null ? '—' : Math.round(result.timingBiasMadMs)} ms · latency offset in
              force {result.latencyOffsetMs} ms
            </div>
            {/* A MILLISECOND FIGURE READ OFF A CAMERA IS BOUNDED BY THE CAMERA. A movement is only
                ever seen in the frame it was sampled in, so at 12 fps this number is an ±83 ms
                quantity however many decimal places it is printed to. */}
            {result.inputMode === 'camera' && (
              <div className="dim" data-testid="results-timing-resolution">
                {timingRes === null
                  ? 'The camera frame rate was not recorded for this session, so the resolution of this figure is unknown.'
                  : `Resolved no finer than ${timingRes} ms — one frame of the camera stream this was measured from.`}
              </div>
            )}
          </div>
        </div>

        {/*
          NINE COLUMNS BECAME SIX, AND THE TWO THAT MATTERED MOST STOPPED BEING LAST.

          Measured at 1024x768: this table laid out at 1302 px inside a 961 px scroller, so
          COMPENSATION — the safety column — and the best rep sat off the right-hand edge with no
          scrollbar and no cue. Columns that were separate only because they were separate numbers
          are now one cell each (hits/missed under one "Notes" heading, mean and best range under
          one "Range" heading), which is how a therapist reads them anyway, and COMPENSATION is the
          third column rather than the ninth. Whatever width is left over is still announced and
          reachable by `ScrollTable`.
        */}
        <div style={{ marginTop: 12 }}>
          <ScrollTable offscreen="the timing and notes columns" testId="results-clinical-table">
            <table className="table">
              <thead>
                <tr>
                  <th>Movement</th>
                  <th>Reps</th>
                  <th>Compensation</th>
                  <th>Range achieved</th>
                  <th>Notes hit</th>
                  <th>Timing</th>
                </tr>
              </thead>
              <tbody>
                {result.lanes.map((l) => (
                  <tr key={l.lane} data-testid={`results-clinical-lane-${l.lane}`}>
                    <td style={{ whiteSpace: 'normal' }}>
                      <b>{l.movementName}</b>
                    </td>
                    <td className="mono">{l.reps}</td>
                    <td>
                      {l.compensationKind === null ? (
                        <span className="dim">n/a</span>
                      ) : !l.compensationMonitored ? (
                        <span className="badge badge-warn">not measured</span>
                      ) : l.compensationFlags === 0 ? (
                        <span className="badge badge-ok">clean</span>
                      ) : (
                        <span className="badge badge-bad">
                          {l.compensationFlags} × {l.compensationKind.replace('_', ' ')}
                        </span>
                      )}
                    </td>
                    <td>
                      {l.romSamples > 0 ? (
                        <>
                          <span className="mono">
                            {formatPercent(l.romMean)} mean · {formatPercent(l.romBest)} best
                          </span>
                          <div className="dim">
                            of calibrated range, {l.romSamples} reps
                            {l.calibratedMin !== null && l.calibratedMax !== null
                              ? ` (${l.calibratedMin.toFixed(2)}→${l.calibratedMax.toFixed(2)}${l.calibrationManual ? ', set by hand' : ''})`
                              : ''}
                          </div>
                        </>
                      ) : (
                        <span className="dim">not measured</span>
                      )}
                    </td>
                    <td className="mono">
                      <span>
                        {l.hits} / {l.hits + l.misses}
                      </span>
                      <div className="dim">
                        {formatPercent(l.accuracy)} · {l.perfects} perfect · {l.goods} good
                      </div>
                    </td>
                    <td className="mono">
                      <span>{formatMs(l.timingBiasMs)}</span>
                      {l.timingBiasMadMs !== null && <div className="dim">±{Math.round(l.timingBiasMadMs)} ms</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollTable>
        </div>
        {result.lanes.some((l) => l.romUncertain > 0) && (
          <span className="dim">
            Some reps were measured across dropped camera frames; their range is a lower bound and is marked uncertain in
            the stored record.
          </span>
        )}
      </details>

      <div className="card row">
        <div className="stack" style={{ gap: 4 }}>
          <span className="badge badge-ok">Saved to history</span>
          <span className="attribution">{result.attribution}</span>
        </div>
        <div className="grow" />
        <button className="btn" onClick={() => goto('history')}>
          Session history
        </button>
      </div>
    </Screen>
  );
}
