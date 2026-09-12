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
  buildSessionExport,
  endReasonLabel,
  formatDuration,
  formatMs,
  formatPercent,
  laneRangeSummaries,
  laneTrendKey,
  mostImprovedRange,
  rangeChange,
  subResolutionNote,
} from '../session/results.ts';
import type { LaneRangeSummary } from '../session/results.ts';
import { compareTracking, timingResolutionMs } from '../session/tracking.ts';
import type { TrackingComparison } from '../session/tracking.ts';
import { isPatientDriven, patientSessions } from '../session/trends.ts';
import type { LaneResultSummary, SessionResult } from '../session/types.ts';
import { MAX_HISTORY, useStore } from '../state/store.ts';
import { FEATURE_UNIT_SHORT, formatFeature } from '../vision/calibration.ts';
import { runtime } from '../session/runtime.ts';
import { CameraPreview } from './CameraPreview.tsx';
import { DwellLegend, DwellTarget, pairedDwellTargets, useDwellTargets } from './DwellTarget.tsx';
import type { DwellChoice } from './DwellTarget.tsx';
import { Meter, Screen, shortDate, Stars, Toast, TopBar } from './common.tsx';
import { MeasurementNote } from './ScopeNote.tsx';
import LatencyHandover from './LatencyHandover.tsx';
import { copyToClipboard, saveTextFile } from './download.ts';

/** "+12" / "−3" / "—". Deltas are stated as counts, never as a pass mark. */
function delta(now: number, then: number | null): string | null {
  if (then === null || !Number.isFinite(then)) return null;
  const d = now - then;
  if (d === 0) return 'same as last time';
  return `${d > 0 ? '+' : '−'}${Math.abs(Math.round(d))} vs last time`;
}

/**
 * THE SESSION EVERY COMPARISON ON THIS SCREEN IS DRAWN AGAINST, and what kind of session it was.
 *
 * Every "vs last time" here — the rep delta, each movement's row, each range tile's chip, "biggest
 * gain today" — spans exactly two sessions. Which two, and whether either of them ran to the end of
 * its chart, is the difference between a finding and an artefact, so it is decided once and carried
 * to every one of them.
 */
interface ComparisonBasis {
  /** The session compared against: the most recent one this patient COMPLETED, where one exists. */
  previous: SessionResult | null;
  /** Patient-driven runs NEWER than `previous`, passed over because they did not reach the end. */
  skipped: SessionResult[];
  /** True when `previous` itself ended early — this patient has no completed session yet. */
  incomplete: boolean;
}

const EMPTY_BASIS: ComparisonBasis = { previous: null, skipped: [], incomplete: false };

/**
 * A qualifier that rides INSIDE a delta chip, in the pattern `compareTracking` established.
 *
 * `tag` is short enough to sit in the badge (the therapist with ninety seconds reads the badge, not
 * the sentence under the card); `note` is the sentence, carried as the chip's title and printed in
 * full beside the figures it qualifies.
 */
interface CompareQualifier {
  tag: string;
  note: string;
}

/** Every reason this comparison is not a plain like-for-like one, in one chip and one sentence. */
function mergeQualifiers(parts: readonly (CompareQualifier | null)[]): CompareQualifier | null {
  const kept = parts.filter((q): q is CompareQualifier => q !== null);
  if (kept.length === 0) return null;
  return { tag: kept.map((q) => q.tag).join(' \u00b7 '), note: kept.map((q) => q.note).join(' ') };
}

/** "9 Sep (stopped by therapist, 0:24, 19 movements)" — what a run that ended early actually was. */
function abortedPhrase(s: SessionResult): string {
  return `${shortDate(s.startedAt)} (${endReasonLabel(s.endReason ?? null)}, ${formatDuration(s.durationSec)}, ${s.reps} movement${
    s.reps === 1 ? '' : 's'
  })`;
}

/**
 * WHAT THIS SCREEN IS COMPARING TODAY WITH, IN WORDS, whenever that is not simply "last time".
 *
 * Null on the ordinary case — the previous session was a whole session and it is the one being
 * compared against — because a caveat printed every session is a caveat read in none of them.
 *
 * Two lengths, because it is needed in two places and the same paragraph printed twice on one screen
 * reads as a rendering fault. `full` sits with the range tiles, which are the first comparison on the
 * page; `short` sits with the per-movement rows, whose own header already names the session, and
 * carries only the fact that header cannot: which run was passed over, and what it was.
 */
function basisSentence(basis: ComparisonBasis): { short: string; full: string } | null {
  const prev = basis.previous;
  if (!prev) return null;
  if (basis.incomplete) {
    const short = `Last time is ${abortedPhrase(prev)} \u2014 it did not reach the end of its chart.`;
    return {
      short,
      full: `${short} So it is a shorter session than today's, and the changes on this screen are partly the length of it. This patient has no completed camera session to compare with yet.`,
    };
  }
  if (basis.skipped.length === 0) return null;
  const list = basis.skipped.map(abortedPhrase).join(', ');
  const one = basis.skipped.length === 1;
  const short = `${one ? 'A more recent session' : `${basis.skipped.length} more recent sessions`} ended early and ${
    one ? 'is' : 'are'
  } not what today is compared against: ${list}.`;
  return {
    short,
    full: `Compared with ${shortDate(prev.startedAt)}, the last session this patient completed \u2014 not with the most recent one. ${short} ${
      one ? 'It is' : 'They are'
    } listed on the history screen.`,
  };
}

/**
 * DOES THIS RECORD'S OWN REP COUNT MEAN WHAT TODAY'S MEANS?
 *
 * `buildSessionResult` writes `reps` as the sum of the per-lane column (`max(engine events, reps the
 * camera observed)`); it used to write the engine's event count, and the two differ BY CONSTRUCTION
 * on spasticity, clonus and tremor, which is this app's core population. A stored record carries no
 * marker for which definition it was written under — but it does carry both numbers, and on a record
 * written under the old rule the headline disagrees with the column beneath it. Where the two agree
 * the definitions agree too and there is nothing to say; where they do not, "+79 vs last time" spans
 * two definitions of "a movement" and says so.
 */
function repsAgreeWithLanes(s: SessionResult): boolean {
  if (s.lanes.length === 0) return true;
  if (!s.lanes.every((l) => typeof l.reps === 'number' && Number.isFinite(l.reps))) return true;
  return s.reps === s.lanes.reduce((n, l) => n + l.reps, 0);
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
 *
 * WHICH IS A DECISION, NOT A FORMAT, so it is taken by `rangeChange` in session/results.ts and the
 * ranking that draws "biggest gain today" takes it there too. The two used to decide separately and
 * could therefore print both verdicts about one number, on one tile.
 */
function gainLabel(s: LaneRangeSummary): { text: string; kind: 'up' | 'down' | 'same'; note?: string } | null {
  const change = rangeChange(s);
  if (change.kind === 'none') return null;
  if (change.kind === 'same') return { text: 'same as last time', kind: 'same' };
  if (change.inUnits && s.gain !== null) {
    return { text: `${signedFeature(s.gain, s.unit)} vs last time`, kind: change.kind };
  }
  const pts = Math.abs(Math.round((s.gainPct ?? 0) * 100));
  return {
    // The badge stays one line at 1024 (measured: 18 characters is 184 px in a 265 px tile); the
    // unit it is in — which is NOT the movement's own unit here — goes on the line under it.
    text: `${change.kind === 'up' ? '+' : '−'}${pts} ${pts === 1 ? 'pt' : 'pts'} vs last time`,
    kind: change.kind,
    // THE BOUND HAS TO BE THE BOUND. This said `formatFeature(1, s.unit)` — "1°" for degrees, twice
    // the true bound, and "1.00" for a body-scaled ratio, a hundred times the step this app prints
    // in and a whole unit of a quantity whose entire calibrated range is routinely under 1.0. It
    // told the therapist the measurement was useless at exactly the moment it was resolved to 0.005.
    // `subResolutionNote` derives the sentence from `formatFeature`'s own rounding (session/results.ts).
    note: subResolutionNote(s.unit),
  };
}

/** "the Compensation column" / "the Notes hit and Timing columns" / "" when nothing was measured. */
function columnPhrase(names: readonly string[]): string {
  if (names.length === 0) return 'columns';
  if (names.length === 1) return `the ${names[0]} column`;
  const head = names.slice(0, -1).join(', ');
  return `the ${head} and ${names[names.length - 1]} columns`;
}

/** Header cells whose box is cut by the scroller's left or right edge, right now, in table order. */
function clippedColumns(el: HTMLElement): { right: string[]; left: string[] } {
  const right: string[] = [];
  const left: string[] = [];
  const box = el.getBoundingClientRect();
  // No layout at all (jsdom, a display:none ancestor): measure nothing rather than guess.
  if (box.width <= 0) return { right, left };
  for (const th of Array.from(el.querySelectorAll('thead th'))) {
    const name = (th.textContent ?? '').trim();
    if (!name) continue;
    const r = th.getBoundingClientRect();
    if (r.width <= 0) continue;
    if (r.right > box.right + 2) right.push(name);
    else if (r.left < box.left - 2) left.push(name);
  }
  return { right, left };
}

/**
 * A WIDE TABLE THAT SAYS IT IS WIDE — AND NAMES THE COLUMNS IT MEASURED, NOT THE ONES IT EXPECTED.
 *
 * `.table-wrap` is `overflow-x: auto` and nothing else. On the clinic target size (1024x768) the
 * clinical table measured 1302 px inside a 961 px scroller: the COMPENSATION badge and the best-rep
 * column were simply not on the screen, with no scrollbar drawn (overlay scrollbars on a touch
 * device appear only while scrolling) and no other hint that anything was missing. A therapist
 * reading "no compensation flags" off a table that never showed them the column is the worst
 * failure this screen has.
 *
 * So the overflow is MEASURED and, when there is any, stated in words and given two 44 px buttons
 * that really page the scroller.
 *
 * AND THE WORDS COME FROM THE SAME MEASUREMENT. The cue used to take the names of the missing
 * columns as a hard-coded string from the caller, so the trend table — 548 px inside a 506 px
 * scroller, with only "Accuracy" actually cut — told the therapist that "the peak and accuracy
 * columns are off to the right" while they were looking straight at the peak column. It over-stated
 * rather than under-stated, so no data was lost, but on a project whose rule is that a caption may
 * not promise what the renderer does not draw, a cue that names columns it has not measured is the
 * same class of bug. The header cells are measured against the scroller's own box on every scroll
 * and every resize, and only the ones whose box is cut are named. `offscreen` survives only as the
 * fallback for a table with no header row to measure.
 */
export function ScrollTable({
  children,
  offscreen,
  testId,
}: {
  children: ReactNode;
  /** Fallback wording for a table with no measurable header row. Normally unused. */
  offscreen?: string;
  testId?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<{ more: boolean; back: boolean; right: string[]; left: string[] } | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => {
      const slack = el.scrollWidth - el.clientWidth;
      if (slack <= 4) {
        setState((s) => (s === null ? s : null));
        return;
      }
      const cut = clippedColumns(el);
      const next = { more: el.scrollLeft < slack - 4, back: el.scrollLeft > 4, right: cut.right, left: cut.left };
      setState((s) =>
        s &&
        s.more === next.more &&
        s.back === next.back &&
        s.right.join('|') === next.right.join('|') &&
        s.left.join('|') === next.left.join('|')
          ? s
          : next,
      );
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

  /** What is cut right now, in the order a reader loses it. Never a column that is on screen. */
  const message = (s: { more: boolean; back: boolean; right: string[]; left: string[] }): string => {
    const parts: string[] = [];
    if (s.more) {
      parts.push(
        s.right.length > 0 || !offscreen
          ? `${columnPhrase(s.right)} ${s.right.length === 1 ? 'is' : 'are'} off to the right`
          : `${offscreen} are off to the right`,
      );
    }
    if (s.back) parts.push(`${columnPhrase(s.left)} ${s.left.length === 1 ? 'is' : 'are'} off to the left`);
    if (parts.length === 0) return 'This table is wider than the screen. Swipe it or use the arrows.';
    return `This table is wider than the screen — ${parts.join(', and ')}. Swipe it or use the arrows.`;
  };

  return (
    <div className="stack" style={{ gap: 8 }}>
      {/* ABOVE THE TABLE, NEXT TO THE HEADER ROW THE MISSING COLUMNS BELONG TO. A five-session
          history table is two screens tall, so a cue underneath it is a cue the therapist reads
          after they have finished reading the table they did not know was incomplete. */}
      {state && (
        <div className="row" style={{ gap: 10 }} data-testid={testId ? `${testId}-scroll-cue` : 'table-scroll-cue'}>
          {/* 44 px in BOTH directions: `.btn-sm` sets the height, and an arrow glyph in 12 px of
              padding is a 34 px-wide target without this. */}
          <button
            className="btn btn-sm"
            style={{ minWidth: 44 }}
            onClick={() => page(-1)}
            disabled={!state.back}
            aria-label="Scroll table left"
          >
            ←
          </button>
          <button
            className="btn btn-sm"
            style={{ minWidth: 44 }}
            onClick={() => page(1)}
            disabled={!state.more}
            aria-label="Scroll table right"
          >
            →
          </button>
          {/* Live, because the sentence changes as the scroller moves and a screen reader that read
              it once would be describing a position the table has left. */}
          <span className="dim" role="status" aria-live="polite">
            {message(state)}
          </span>
        </div>
      )}
      <div className="table-wrap" ref={ref} data-testid={testId}>
        {children}
      </div>
    </div>
  );
}

/**
 * One prescribed movement's range, as the headline treats it: on its own, against its own range.
 *
 * `qualified` is everything that is wrong with subtracting these two sessions: how each was tracked
 * (session/tracking.ts), and whether the earlier one ran to the end of its chart at all. It is not
 * decoration on the tile: "+0.02 vs last time" and "biggest gain today" in green, measured against a
 * session the app itself graded poor — or against a 24-second walk-out — is the equipment or the
 * clock rendered as the patient, and a grey sentence further down the card does not undo a green
 * chip for a therapist reading it in ninety seconds. So the chips themselves carry the verdict.
 */
function RangeTile({ s, improved, qualified }: { s: LaneRangeSummary; improved: boolean; qualified: CompareQualifier | null }) {
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
          {/* The tiles in this row are stretched to the tallest of them (a movement whose change has
              to be explained carries an extra two lines), so without this the shorter ones ended in
              ~110 px of empty panel and the badges sat at three different heights. */}
          <div className="grow" />
          <div className="row" style={{ gap: 8 }}>
            {/* THE COLOUR SAYS WHAT THE WORDS SAY. Keyed off `gainPct > 0` it painted the words
                "same as last time" green on any change above zero and grey on any change below it —
                two tiles reading identically and coloured oppositely. */}
            {gain !== null && (
              <span
                className={
                  qualified
                    ? 'badge badge-warn delta-qualified'
                    : gain.kind === 'up'
                      ? 'badge badge-ok'
                      : 'badge'
                }
                title={qualified?.note ?? undefined}
                data-qualified={qualified ? 'true' : undefined}
                data-testid={`results-range-gain-${s.lane}`}
              >
                {gain.text}
                {qualified && <span className="delta-tag"> · {qualified.tag}</span>}
              </span>
            )}
            {improved && (
              <span
                className={qualified ? 'badge badge-warn delta-qualified' : 'badge badge-ok'}
                title={qualified?.note ?? undefined}
                data-qualified={qualified ? 'true' : undefined}
                data-testid={`results-range-improved-${s.lane}`}
              >
                {qualified ? 'biggest change today' : 'biggest gain today'}
                {qualified && <span className="delta-tag"> · {qualified.tag}</span>}
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
          <div className="grow" />
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
  /** WHETHER THIS RECORD IS REALLY ON THE DEVICE — see `SaveOutcome` in state/store.ts. */
  const lastSave = useStore((s) => s.lastSave);
  const retrySave = useStore((s) => s.retrySaveLastResult);
  const [saveNote, setSaveNote] = useState<string | null>(null);
  /**
   * THE LAST SCREEN IS THE EASIEST ONE TO BE STRANDED ON.
   *
   * It ends with "Play again" and "New session", and a patient who has driven the whole session from
   * the chair can press neither. So when the patient has been confirming hands-free (`handsFree`, set
   * by the first dwell confirm), the camera is NOT released on arriving here — see
   * `screenNeedsCamera` — and the same two actions are offered as targets. Every other session
   * releases the device the moment play ends, exactly as before, and this screen says out loud that
   * the camera is still on and offers the control that turns it off.
   */
  const mode = useStore((s) => s.mode);
  const handsFree = useStore((s) => s.handsFree);
  const setHandsFree = useStore((s) => s.setHandsFree);
  const reducedMotion = useStore((s) => s.settings.reducedMotion);
  const dwellChoices: DwellChoice[] = useMemo(() => {
    if (!handsFree) return [];
    const [go, back] = pairedDwellTargets(mode);
    return [
      {
        id: 'again',
        target: go,
        label: 'Play again',
        onConfirm: () => {
          setSeed(seed + 1);
          goto('play');
        },
      },
      { id: 'new', target: back, label: 'New session', onConfirm: () => goto('mode') },
    ];
  }, [handsFree, mode, seed, setSeed, goto]);
  const dwell = useDwellTargets(dwellChoices);

  /**
   * WHICH SESSION "LAST TIME" IS — AND WHETHER IT IS A WHOLE SESSION.
   *
   * This used to be `mine[0]`: the most recent camera session, whatever it was. On a patient whose
   * last visit was a 24-second walk-out — 19 movements, `endReason: 'quit'` — today's 98 movements
   * rendered as "+79 vs last time", "+30 vs last time" per movement and "Biggest gain since last
   * session", with nothing anywhere on the screen saying what the comparison was against. One
   * screen later the ROM trend sets exactly those runs aside from every change figure, for the
   * reason written on it: a nine-rep walk-out is not the other end of a like-for-like comparison.
   * Two screens, two rules, and the one a therapist reads first was the one that flattered.
   *
   * So this screen now applies the trend's rule: the basis is the most recent session this patient
   * COMPLETED, and the shorter runs in between are named rather than silently skipped (a delta
   * against a session that is not the last one is its own way of misleading). When there is no
   * completed session at all, the comparison is still drawn — a first fortnight of aborted runs is
   * still the patient's own history — but it carries the same kind of qualifier the tracking verdict
   * rides on, in the chip itself, because a grey sentence underneath does not undo a green badge.
   */
  const basis: ComparisonBasis = useMemo(() => {
    if (!result || !isPatientDriven(result)) return EMPTY_BASIS;
    const mine = patientSessions(history, result.patientId).filter((s) => s.id !== result.id && isPatientDriven(s));
    // history is newest-first. `completed !== false` so a record written before the flag existed
    // reads as a whole session rather than as an abort nobody recorded.
    const i = mine.findIndex((s) => s.completed !== false);
    if (i >= 0) return { previous: mine[i], skipped: mine.slice(0, i), incomplete: false };
    return { previous: mine[0] ?? null, skipped: [], incomplete: mine.length > 0 };
  }, [history, result]);
  const previous = basis.previous;

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

  /**
   * WHETHER TODAY MAY BE SUBTRACTED FROM LAST TIME AT ALL.
   *
   * Every comparison on this screen — each lane's gain chip, "biggest gain today", the rep delta —
   * spans these two sessions, and they were measured on whatever camera and whatever machine load
   * each day happened to bring. `compareTracking` is the one place that decides; the chips read it so
   * that a change across a poor-tracked session and a good-tracked one cannot render as a plain win
   * anywhere on the screen.
   */
  const comparison: TrackingComparison | null = previous
    ? compareTracking(previous.tracking, result.tracking, {
        from: `the session on ${shortDate(previous.startedAt)}`,
        to: "today's session",
      })
    : null;
  const comparisonNote = comparison && comparison.kind !== 'like-for-like' ? comparison.note : null;

  /**
   * EVERYTHING THAT IS WRONG WITH SUBTRACTING THESE TWO SESSIONS, IN THE CHIP THAT DOES IT.
   *
   * Tracking was already here. Completeness was not, and it is the louder of the two: a session that
   * ended after 24 seconds is not a small measurement error, it is a different amount of therapy. A
   * chip that says "+79" in green over a walk-out is the screen telling the patient they had a big
   * day, and the qualifier has to be on the chip for the same reason the tracking one is.
   */
  const trackingQualifier: CompareQualifier | null =
    comparison && comparison.kind !== 'like-for-like' && comparison.tag !== null && comparison.note !== null
      ? { tag: comparison.tag, note: comparison.note }
      : null;
  const completenessQualifier: CompareQualifier | null =
    basis.incomplete && previous !== null
      ? {
          tag: 'last session ended early',
          note: `The session compared with \u2014 ${abortedPhrase(previous)} \u2014 did not reach the end of its chart, so it asked for fewer movements than today did.`,
        }
      : null;
  /** What qualifies every RANGE comparison on the screen (the tiles, the rows, "biggest gain"). */
  const rangeQualifier = mergeQualifiers([completenessQualifier, trackingQualifier]);
  /**
   * The rep delta carries one more: a previous record whose own headline disagrees with its own
   * per-lane column was written before "movements performed" became that column's total.
   */
  const repsQualifier = mergeQualifiers([
    completenessQualifier,
    previous !== null && !repsAgreeWithLanes(previous)
      ? {
          tag: 'counted differently',
          note: `That session's record stores ${previous.reps} movements while its own per-movement column adds up to ${previous.lanes.reduce(
            (n, l) => n + l.reps,
            0,
          )}: it was written before a movement the camera saw but scored nothing began to count. The difference below spans both definitions.`,
        }
      : null,
    trackingQualifier,
  ]);
  /** The sentence naming the session being compared against, when that needs saying at all. */
  const basisNote = basisSentence(basis);

  /**
   * THE VERDICT ON THIS RECORD, AND NEVER A STALE ONE ABOUT A DIFFERENT SESSION. `lastSave` is
   * stamped with the id it describes, so a record reached some other way — reloaded, re-filed, put
   * here by a harness — reports "unknown" rather than borrowing the previous session's green badge.
   */
  const saved = lastSave && lastSave.id === result.id ? lastSave : null;
  const saveState: 'saved' | 'failed' | 'unknown' = saved === null ? 'unknown' : saved.ok ? 'saved' : 'failed';

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

      {/* THE PATIENT'S OWN WAY OFF THE LAST SCREEN — shown only when they have actually been working
          hands-free, and honest that the camera is still running to provide it. */}
      {handsFree && dwell.live && dwellChoices.length > 0 && (
        <div className="card stack" data-testid="results-handsfree" style={{ gap: 12 }}>
          <div className="row">
            <h3 style={{ margin: 0 }}>Carry on without touching the screen</h3>
            <div className="grow" />
            <span className="badge badge-warn" data-testid="results-camera-on">
              camera still on
            </span>
          </div>
          {/* Capped, so the legend and the therapist's way out of this stay on screen with it at
              1024x768 — a full-card-width preview pushed both below the fold. */}
          <div style={{ width: 'min(560px, 100%)' }}>
            <CameraPreview overlay>
              {dwellChoices.map((choice) => (
                <DwellTarget
                  key={choice.id}
                  choice={choice}
                  state={dwell.states[choice.id]}
                  reducedMotion={reducedMotion}
                  testId={`results-dwell-${choice.id}`}
                />
              ))}
            </CameraPreview>
          </div>
          <DwellLegend session={dwell} what="the left circle to play again, the right one to start a new session" testId="results-dwell-legend" />
          <div className="row">
            <button
              className="btn"
              data-testid="results-camera-off"
              onClick={() => {
                setHandsFree(false);
                runtime.disposeVision();
              }}
            >
              Turn the camera off
            </button>
            <span className="dim">
              The camera was kept on after the song only because this session was driven from the chair. Turning it off
              leaves the buttons above, which is every other session&rsquo;s behaviour.
            </span>
          </div>
        </div>
      )}

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
              {/* "SINCE LAST SESSION" HAS TO BE THE SESSION IT IS ACTUALLY SINCE. Where that is not
                  the patient's most recent run — because the most recent run ended early — the
                  headline names the date it IS since, and where even that run ended early the whole
                  phrase drops to "change", the same demotion an unevenly-tracked pair gets. */}
              {rangeQualifier ? 'Biggest change since' : 'Biggest gain since'}{' '}
              {basis.skipped.length > 0 && previous ? `${shortDate(previous.startedAt)}` : 'last session'}:{' '}
              {improved.movementName}
              {rangeQualifier ? ` — ${rangeQualifier.tag}` : ''}
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
            <RangeTile key={s.lane} s={s} improved={improved?.lane === s.lane} qualified={rangeQualifier} />
          ))}
        </div>
        {/*
          WHAT THE COMPARISON IS WORTH, BESIDE THE CHIPS THAT MAKE IT. Only printed when the two
          sessions were NOT measured alike: on a like-for-like pair there is nothing to warn about,
          and a caveat that appears every session is a caveat that is read none of them.
        */}
        {comparisonNote && (
          <div className="dim" data-testid="results-comparison-note">
            <span className="badge badge-warn">{comparison?.tag}</span> {comparisonNote}
          </div>
        )}
        {/*
          WHAT "LAST TIME" IS, WHEREVER IT IS NOT SIMPLY THE LAST SESSION.

          The screen used to compare today against the most recent camera session whatever it was,
          so a patient whose previous visit was a 24-second walk-out read "+79 movements vs last
          time" with no word anywhere about what they were being compared against. The trend screen
          sets those runs aside; this one now does too, and says which session it kept.
        */}
        {basisNote && (
          <div className="dim" data-testid="results-comparison-basis">
            <span className={basis.incomplete ? 'badge badge-warn' : 'badge'}>
              {basis.incomplete ? 'last session ended early' : 'compared with the last completed session'}
            </span>{' '}
            {basisNote.full}
          </div>
        )}
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
            {/* "IN 1:37" WOULD NOW BE A CLAIM ABOUT THE INTERVAL, and the count no longer stops at
                the chart's last note: the song-end sequence keeps counting the movements the patient
                makes over it (GameRunner `onInput`), while the stored duration stays the SONG's
                length, which is what the dose was prescribed against. So the two facts are stated
                side by side rather than one inside the other. */}
            across {result.lanes.length} movement{result.lanes.length === 1 ? '' : 's'} · the song ran{' '}
            {formatDuration(result.durationSec)}
          </div>
          {/* A REP COUNT IS A CAMERA MEASUREMENT TOO. A stream whose landmarks were usable for 62 %
              of the session cannot have seen every rep, so a delta across it is qualified in the
              same words as the range chips rather than printed flat. */}
          <div className="dim" data-testid="results-reps-delta">
            {!isPatientDriven(result)
              ? 'Not compared: the patient did not drive this session'
              : previous
                ? (delta(result.reps, previous.reps) ?? '')
                : 'First recorded session for this patient'}
            {previous && isPatientDriven(result) && repsQualifier && (
              <>
                {' '}
                <span className="badge badge-warn" title={repsQualifier.note} data-testid="results-reps-delta-qualifier">
                  {repsQualifier.tag}
                </span>
              </>
            )}
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
          {/* The spacer both its neighbours carry. Without it this card's three short lines left
              109 px of empty panel at 1280 and 133 px at 1024 against their 21 px, and the row read
              as unfinished. Measured, both sizes. */}
          <div className="grow" />
          {answerRate !== null && <Meter value={answerRate} label="notes answered with a movement" />}
        </div>

        <div className="card stack" data-testid="results-sessions">
          <div className="eyebrow">Camera sessions recorded</div>
          <div className="big-number mono">{sessionsSoFar}</div>
          <div className="dim">
            {/* NAMED, because it is not always the last one: where the most recent run ended early
                the comparison is drawn against the last COMPLETED session, and this line is where a
                therapist checks which session that was. */}
            {previous
              ? `compared with ${shortDate(previous.startedAt)} — ${formatDuration(previous.durationSec)}, ${previous.reps} movement${previous.reps === 1 ? '' : 's'}${basis.incomplete ? ', ended early' : ''}`
              : 'this is the first'}
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

      {/*
        TODAY AGAINST LAST TIME, per movement — the question a rehab session is actually asking.

        AND IT IS A CROSS-SESSION COMPARISON LIKE EVERY OTHER ONE ON THIS SCREEN. This card was the
        last unqualified one: every cell in it subtracts two sessions ("+30 vs last time", "was
        110°") and it carried nothing about how those two sessions were measured or whether the
        earlier one ran to the end of its chart, while the range tiles two cards up had lost their
        green for exactly that reason. The architecture's rule is that the qualifier rides on the
        comparison; these rows ARE comparisons, so they carry the same verdict, from the same
        `compareTracking`/completeness merge, in the header and on each delta.
      */}
      <div className="card stack" data-testid="results-today">
        <div className="row">
          <h3>Today, movement by movement</h3>
          <div className="grow" />
          <span className="dim">
            {previous
              ? basis.incomplete
                ? `compared with ${shortDate(previous.startedAt)}, which ended early`
                : basis.skipped.length > 0
                  ? `compared with ${shortDate(previous.startedAt)}, this patient’s last COMPLETED camera session`
                  : 'compared with this patient’s last camera session'
              : result.inputMode === 'camera'
                ? 'no earlier camera session to compare with yet'
                : 'comparison is only drawn between camera sessions'}
            {previous && rangeQualifier && (
              <>
                {' '}
                <span className="badge badge-warn" title={rangeQualifier.note} data-testid="results-today-qualifier">
                  {rangeQualifier.tag}
                </span>
              </>
            )}
          </span>
        </div>
        <ScrollTable testId="results-today-table">
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
                      {was && (
                        <div className={repsQualifier ? 'dim delta-qualified' : 'dim'} title={repsQualifier?.note}>
                          {delta(s.reps, was.reps)}
                          {repsQualifier ? ` · ${repsQualifier.tag}` : ''}
                        </div>
                      )}
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
                            <div className={rangeQualifier ? 'dim delta-qualified' : 'dim'} title={rangeQualifier?.note}>
                              {signedFeature(s.gain, s.unit)} vs last time
                              {rangeQualifier ? ` · ${rangeQualifier.tag}` : ''}
                            </div>
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
        {/* The per-movement deltas in the rows above span the same two sessions as everything else on
            the screen, so the sentence that says which two sits with them rather than only at the
            top of the page. */}
        {basisNote && (
          <span className="dim" data-testid="results-today-basis">
            {basisNote.short}
          </span>
        )}
        {/* The same sentence the range card prints, because these rows span the same two sessions
            and a therapist reading this table need not have read that card. */}
        {comparisonNote && (
          <span className="dim" data-testid="results-today-comparison-note">
            <span className="badge badge-warn">{comparison?.tag}</span> {comparisonNote}
          </span>
        )}
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
          <ScrollTable testId="results-clinical-table">
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

      {/*
        DID THIS SESSION ACTUALLY REACH THE DEVICE?

        This was a constant green "Saved to history" badge: markup, drawn whether or not the write
        landed. Stub `localStorage` into refusing (a full quota — realistic on a shared clinic tablet,
        where the 100-session cap is PER PATIENT — or private mode, or blocked site data) and the
        badge still read saved, over a record that existed nowhere but in this tab's memory. A
        therapist who walks away believing a record exists when it does not is the worst failure this
        app has, and the verdict was always available: `writeJson` returns it, `persistHistory` now
        passes it on, and `addResult` stores it against this session's own id.

        So the claim is the verdict — and where the verdict is "no" the screen says what the
        therapist can DO about it, here, before they navigate away from the only copy: try again,
        take the session off the device by hand, or go and free space.
      */}
      <div className="card stack" data-testid="results-save">
        <div className="row">
          <div className="stack" style={{ gap: 4 }}>
            {saveState === 'saved' ? (
              <span className="badge badge-ok" data-testid="results-save-state">
                Saved to history{saved && saved.attempts > 1 ? ` — on attempt ${saved.attempts}` : ''}
              </span>
            ) : saveState === 'failed' ? (
              <span className="badge badge-bad" data-testid="results-save-state">
                NOT saved — this session is not on this device
              </span>
            ) : (
              <span className="badge badge-warn" data-testid="results-save-state">
                Saved state unknown for this session
              </span>
            )}
            <span className="attribution">{result.attribution}</span>
          </div>
          <div className="grow" />
          <button className="btn" onClick={() => goto('history')}>
            Session history
          </button>
        </div>
        {saveState !== 'saved' && (
          <Toast kind="bad">
            <strong data-testid="results-save-problem">
              {saveState === 'failed'
                ? 'This tablet refused to store the session.'
                : 'This screen cannot confirm the session was stored.'}
            </strong>{' '}
            {saveState === 'failed'
              ? `The browser's storage would not take the write — usually a full quota or site data blocked for this page. This device keeps at most ${MAX_HISTORY} sessions per patient, so deleting or exporting older records frees space. Until it is stored, the only copy of this session is on this screen: leaving it loses the work the patient just did.`
              : 'This tab did not record the write, so it cannot tell you whether the session reached the browser\u2019s storage. Save a copy before you leave the screen, and check the history screen for it.'}
            <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
              <button
                className="btn btn-primary"
                data-testid="results-save-retry"
                onClick={() => {
                  const ok = retrySave();
                  setSaveNote(
                    ok
                      ? 'Saved. The session is now in this patient\u2019s history on this device.'
                      : 'Still refused. Save the file below and keep it — that copy does not depend on this browser.',
                  );
                }}
              >
                Try saving again
              </button>
              <button
                className="btn"
                data-testid="results-save-export"
                onClick={() => {
                  void (async () => {
                    const file = buildSessionExport({
                      result,
                      reason: 'This session could not be stored on the device it was recorded on. This file is its only copy.',
                    });
                    const wrote = saveTextFile(file.filename, file.json, 'application/json');
                    const copied = await copyToClipboard(file.text);
                    setSaveNote(
                      wrote
                        ? `Saved ${file.filename}${copied ? ', and a readable copy is on the clipboard — paste it into your notes.' : '. This browser refused the clipboard, so open the file to read it.'}`
                        : copied
                          ? 'This browser refused the download, but a readable copy of the session is on the clipboard — paste it into your notes now.'
                          : 'This browser refused both the download and the clipboard. Write the figures above down before leaving this screen.',
                    );
                  })();
                }}
              >
                Save this session as a file
              </button>
              <button className="btn" data-testid="results-save-free-space" onClick={() => goto('history')}>
                Free space in the history
              </button>
            </div>
          </Toast>
        )}
        {saveNote && (
          <span className="dim" data-testid="results-save-note">
            {saveNote}
          </span>
        )}
      </div>
    </Screen>
  );
}
