import type { Chart, HitEvent, Judgment, Note, TimingWindows } from './types.ts';

export type NoteState = 'pending' | Judgment;

const STATE_PENDING = 0;
const STATE_PERFECT = 1;
const STATE_GOOD = 2;
const STATE_MISS = 3;
const STATE_NAMES: readonly NoteState[] = ['pending', 'perfect', 'good', 'miss'];

const EMPTY: readonly HitEvent[] = Object.freeze([]) as readonly HitEvent[];

export interface JudgeOptions {
  /**
   * Input pipeline latency (seconds, from calibration). An input observed at song time t is judged
   * at (t - latencyOffsetSec); `update()` runs on the same shifted timeline. Apply it HERE ONLY —
   * never also shift the SongClock (see `RhythmEngine` for the composed recipe).
   */
  latencyOffsetSec?: number;
  /**
   * Grace (ms) that `update()` lags behind the frame time before declaring a miss. Needed when
   * inputs are timestamped at capture (camera frame) but delivered later (inference): an in-window
   * hit delivered 30–100 ms after its timestamp must not already have been turned into a miss.
   * Default 0 (spec-exact: miss when note time + goodMs has elapsed); `RhythmEngine` defaults to
   * `DEFAULT_MISS_GRACE_MS`. Misses keep their nominal `time` (note time + goodMs) regardless.
   */
  missGraceMs?: number;
}

/** Miss grace used by `RhythmEngine`: covers 30 fps capture + inference delivery delay. */
export const DEFAULT_MISS_GRACE_MS = 100;

/**
 * The full outcome of one input, including the inputs the rehab rule tells us to ignore.
 *
 * `onInput` returns `null` for an input that matched no note, which is the right *scoring*
 * behaviour (extra/involuntary movements must never be punished) but throws away the one number a
 * therapist needs: how far the movement was from the note it was clearly aiming at. A patient whose
 * latency calibration is 180 ms out performs every rep correctly and scores zero; with
 * `nearestDeltaMs` recorded the session can still report the reps performed and re-estimate the
 * offset (`estimateLatencyFromDeltas`). Use `onInputDetailed` wherever the result is measured
 * rather than merely rendered.
 */
export interface InputResult {
  /** The judged hit (already applied to the note's state), or null when no note matched. */
  hit: HitEvent | null;
  lane: number;
  /** Latency-shifted song time of the input (the timeline judgment happens on). */
  time: number;
  /**
   * Signed distance in ms (positive = input late) to the nearest note of this lane — measured
   * against the note grid itself, without the good window and without regard to what has already
   * been judged, so it is censored by neither scoring nor miss detection. Null only when the lane
   * holds no notes at all (a lane outside the chart throws instead of reading back as empty).
   *
   * NOT always equal to `hit.deltaMs`: `hit` matches the nearest *unjudged* note, this measures the
   * nearest note of any state. They differ exactly when the true nearest note has already been hit
   * or missed — notes at 1.00 (already hit) and 1.10, input at 1.04, gives `hit.deltaMs = -60` and
   * `nearestDeltaMs = +40`. Attribute a matched input's timing with `hit.deltaMs`, and use
   * `nearestDeltaMs` only for the inputs that matched nothing (which is exactly how `Scoring`
   * consumes it: `apply(hit)` samples `hit.deltaMs`, `recordUnmatchedInput` samples this).
   */
  nearestDeltaMs: number | null;
  /** Id of the note `nearestDeltaMs` refers to, or null. */
  nearestNoteId: number | null;
}

/** Validate a timing window: finite, positive, perfectMs <= goodMs. Throws RangeError. */
export function validateTimingWindows(w: TimingWindows, label = 'windows'): void {
  if (!w || typeof w !== 'object') throw new RangeError(`Judge: ${label} missing`);
  const { perfectMs, goodMs } = w;
  if (!Number.isFinite(perfectMs) || !Number.isFinite(goodMs)) throw new RangeError(`Judge: ${label} must be finite (got perfect ${perfectMs}, good ${goodMs})`);
  if (perfectMs <= 0 || goodMs <= 0) throw new RangeError(`Judge: ${label} must be positive (got perfect ${perfectMs}, good ${goodMs})`);
  if (perfectMs > goodMs) throw new RangeError(`Judge: ${label} perfectMs ${perfectMs} exceeds goodMs ${goodMs}`);
}

/** Validate chart invariants the Judge relies on: unique ids, lanes in [0, chart.lanes), finite times. Throws. */
export function validateChartForJudge(chart: Chart): void {
  const lanes = chart.lanes;
  if (!Number.isInteger(lanes) || lanes < 1) throw new RangeError(`Judge: chart.lanes must be a positive integer (got ${lanes})`);
  const seen = new Set<number>();
  for (let i = 0; i < chart.notes.length; i++) {
    const n = chart.notes[i];
    if (!Number.isInteger(n.lane) || n.lane < 0 || n.lane >= lanes) throw new RangeError(`Judge: note ${n.id} lane ${n.lane} out of range [0, ${lanes})`);
    if (!Number.isFinite(n.time)) throw new RangeError(`Judge: note ${n.id} has non-finite time`);
    if (seen.has(n.id)) throw new RangeError(`Judge: duplicate note id ${n.id}`);
    seen.add(n.id);
  }
}

/**
 * Pure, deterministic hit judge.
 *
 * Time base: every time passed in is *song time in seconds* as derived from the audio clock
 * (`SongClock.songTime(ctxTime)`). `latencyOffsetSec` is subtracted internally from both inputs
 * and update times, so hits and misses live on one consistent timeline.
 *
 * Ordering contract: judgment is timestamp-exact. An input at song time t is judged identically
 * whether it arrives before or after `update(u)` as long as its note has not been declared missed,
 * i.e. as long as t' <= note.time + goodMs and u' - missGrace < note.time + goodMs (primes = shifted
 * times). Inputs delivered later than `missGraceMs` after their own timestamp may lose to a miss;
 * choose the grace to cover the input pipeline's delivery delay.
 *
 * Rehab rules: an input with no candidate note is ignored (no penalty for extra movements) — but it
 * is not *forgotten*: `onInputDetailed` reports the distance to the nearest unjudged note so reps
 * performed and the true timing bias survive the scoring window (see `InputResult`).
 * Allocation: `onInput` allocates only the returned event; `update` returns a shared frozen empty
 * array when nothing was missed.
 */
export class Judge {
  readonly chart: Chart;
  private readonly windows: TimingWindows[];
  private latencyOffsetSec: number;
  private missGraceSec: number;

  /** notes sorted by time per lane */
  private readonly laneNotes: Note[][];
  /** per lane: index of first note that is still pending (all before it are judged) */
  private readonly laneCursor: number[];
  /** state per note index (index into chart.notes) */
  private readonly states: Uint8Array;
  private readonly indexById: Map<number, number>;
  private pendingCount: number;
  private readonly missScratch: HitEvent[] = [];

  /**
   * @param windows one TimingWindows for every lane, or an array with EXACTLY `chart.lanes`
   *                entries indexed by lane (from `windowsForLanes`).
   * @param options `JudgeOptions`, or a bare number for `latencyOffsetSec` (legacy form).
   * @throws RangeError when the chart has duplicate note ids or lanes outside [0, chart.lanes), the
   *         window array's length does not match `chart.lanes`, or a window is non-finite,
   *         non-positive or has perfectMs > goodMs.
   */
  constructor(chart: Chart, windows: TimingWindows | TimingWindows[], options: number | JudgeOptions = {}) {
    validateChartForJudge(chart);
    const opts: JudgeOptions = typeof options === 'number' ? { latencyOffsetSec: options } : options;
    this.chart = chart;
    const lanes = chart.lanes;
    if (Array.isArray(windows)) {
      // A short array used to silently reuse its last entry for every lane past the end, which is
      // how a 4-lane chart got the gross-motor windows on its two fine-motor lanes. `windowsForLanes`
      // throws for a missing index; so does this.
      if (windows.length === 0) throw new RangeError('Judge: no timing windows supplied');
      if (windows.length !== lanes) {
        throw new RangeError(`Judge: ${windows.length} timing window(s) supplied for a ${lanes}-lane chart (pass one per lane, or a single TimingWindows for all)`);
      }
    }
    this.windows = [];
    for (let l = 0; l < lanes; l++) {
      const w = Array.isArray(windows) ? windows[l] : windows;
      if (!w) throw new RangeError('Judge: no timing windows supplied');
      validateTimingWindows(w, `lane ${l} windows`);
      this.windows.push({ perfectMs: w.perfectMs, goodMs: w.goodMs });
    }
    this.latencyOffsetSec = opts.latencyOffsetSec ?? 0;
    this.missGraceSec = Math.max(0, opts.missGraceMs ?? 0) / 1000;
    this.states = new Uint8Array(chart.notes.length);
    this.indexById = new Map();
    this.laneNotes = [];
    this.laneCursor = [];
    for (let l = 0; l < lanes; l++) {
      this.laneNotes.push([]);
      this.laneCursor.push(0);
    }
    chart.notes.forEach((n, i) => {
      this.indexById.set(n.id, i);
      this.laneNotes[n.lane].push(n);
    });
    for (const arr of this.laneNotes) arr.sort((a, b) => a.time - b.time || a.id - b.id);
    this.pendingCount = chart.notes.length;
  }

  setLatencyOffset(sec: number): void {
    this.latencyOffsetSec = sec;
  }

  getLatencyOffset(): number {
    return this.latencyOffsetSec;
  }

  setMissGrace(ms: number): void {
    this.missGraceSec = Math.max(0, ms) / 1000;
  }

  getMissGrace(): number {
    return this.missGraceSec * 1000;
  }

  /** Windows of a lane. @throws RangeError for a lane outside [0, chart.lanes). */
  getWindows(lane: number): TimingWindows {
    const w = this.windows[lane];
    if (w === undefined) throw new RangeError(`Judge: lane ${lane} out of range [0, ${this.windows.length})`);
    return w;
  }

  /**
   * Replace the timing windows mid-session, keeping every judgment made so far, the lane cursors
   * and the score. The spec calls the therapist window scale tunable, so it must be adjustable
   * during Play without rebuilding the Judge (which would reset all note states).
   *
   * Takes the same argument as the constructor: one `TimingWindows` for every lane, or exactly
   * `chart.lanes` of them indexed by lane (from `windowsForLanes`). Validated identically.
   *
   * Already-judged notes are NOT revisited — widening the windows does not un-miss a note, and
   * narrowing them does not take a hit back. What changes is every judgment from here on, plus the
   * miss deadline of notes still pending: widening `goodMs` gives pending notes more time,
   * narrowing it can make a note that is already past its new deadline miss on the next `update`.
   *
   * @throws RangeError on the same conditions as the constructor (wrong count, non-finite,
   *         non-positive, perfectMs > goodMs) — and then nothing is changed.
   */
  setWindows(windows: TimingWindows | TimingWindows[]): void {
    const lanes = this.windows.length;
    if (Array.isArray(windows)) {
      if (windows.length === 0) throw new RangeError('Judge: no timing windows supplied');
      if (windows.length !== lanes) {
        throw new RangeError(`Judge: ${windows.length} timing window(s) supplied for a ${lanes}-lane chart (pass one per lane, or a single TimingWindows for all)`);
      }
    }
    // validate everything BEFORE mutating, so a bad set leaves the session on its old windows
    const next: TimingWindows[] = [];
    for (let l = 0; l < lanes; l++) {
      const w = Array.isArray(windows) ? windows[l] : windows;
      if (!w) throw new RangeError('Judge: no timing windows supplied');
      validateTimingWindows(w, `lane ${l} windows`);
      next.push({ perfectMs: w.perfectMs, goodMs: w.goodMs });
    }
    for (let l = 0; l < lanes; l++) this.windows[l] = next[l];
  }

  /**
   * Replace one lane's windows (see `setWindows`). @throws RangeError for a lane outside
   * [0, chart.lanes) or an invalid window; nothing is changed in either case.
   */
  setLaneWindows(lane: number, w: TimingWindows): void {
    if (this.windows[lane] === undefined) throw new RangeError(`Judge: lane ${lane} out of range [0, ${this.windows.length})`);
    validateTimingWindows(w, `lane ${lane} windows`);
    this.windows[lane] = { perfectMs: w.perfectMs, goodMs: w.goodMs };
  }

  /** Number of notes not yet judged (0 = every note has been hit or missed). */
  getPendingCount(): number {
    return this.pendingCount;
  }

  /** True when `noteId` belongs to this chart. */
  hasNote(noteId: number): boolean {
    return this.indexById.has(noteId);
  }

  /**
   * State of a note of this chart, or `undefined` for an id the chart does not contain — a stale or
   * wrong id must not read back as a plausible 'pending' note the renderer keeps drawing.
   */
  getNoteState(noteId: number): NoteState | undefined {
    const idx = this.indexById.get(noteId);
    if (idx === undefined) return undefined;
    return STATE_NAMES[this.states[idx]];
  }

  /** Reset all judgments (e.g. restart). */
  reset(): void {
    this.states.fill(STATE_PENDING);
    this.laneCursor.fill(0);
    this.pendingCount = this.chart.notes.length;
  }

  /**
   * Judge an input on `lane` observed at `songTimeSec`.
   * Returns the HitEvent for the nearest pending note within ±goodMs, or null (input ignored).
   * deltaMs is positive when the input is late. `time` is the latency-shifted input time.
   *
   * @throws RangeError when `lane` is outside [0, chart.lanes) — as `getWindows`, `Scoring.apply`
   *         and `Scoring.recordUnmatchedInput` already did. Returning null there made a mis-wired
   *         lane index (a keyboard map or an off-by-one `LaneSpec.index`) indistinguishable from
   *         "the patient moved and no note was near", so every rep on that lane vanished from the
   *         score AND from the rep count with no signal at all — the one path in this module that
   *         silently loses a rep. Callers that take lane indices from an untrusted InputSource
   *         should range-check first and count the rejects; `RhythmEngine.handleInputDetailed`
   *         does exactly that (`ScoreState.outOfRange`) rather than crashing the session.
   */
  onInput(lane: number, songTimeSec: number): HitEvent | null {
    const notes = this.laneNotes[lane];
    if (notes === undefined) throw new RangeError(`Judge: lane ${lane} out of range [0, ${this.laneNotes.length})`);
    const w = this.windows[lane];
    const t = songTimeSec - this.latencyOffsetSec;
    const goodSec = w.goodMs / 1000;
    const hi = t + goodSec;

    let best: Note | null = null;
    let bestAbs = Infinity;
    for (let i = this.laneCursor[lane]; i < notes.length; i++) {
      const n = notes[i];
      if (n.time > hi) break;
      if (this.states[this.indexById.get(n.id)!] !== STATE_PENDING) continue;
      const abs = Math.abs(n.time - t);
      if (abs < bestAbs) {
        bestAbs = abs;
        best = n;
      } else if (best !== null && abs > bestAbs) {
        break; // sorted: distances only grow from here
      }
    }
    if (best === null) return null;
    const deltaMs = (t - best.time) * 1000;
    if (Math.abs(deltaMs) > w.goodMs + 1e-9) return null;
    const judgment: Judgment = Math.abs(deltaMs) <= w.perfectMs + 1e-9 ? 'perfect' : 'good';
    this.mark(best, judgment === 'perfect' ? STATE_PERFECT : STATE_GOOD, lane);
    return { noteId: best.id, lane, judgment, deltaMs, time: t };
  }

  /**
   * Nearest note of `lane` to the (already latency-shifted) song time `t`, ties to the earlier one.
   * O(log n) binary search, allocation-free, and — deliberately — independent of judgment state.
   *
   * Judgment state must not enter here: a patient whose offset is 180 ms out arrives *after* their
   * note has already been declared a miss, so "nearest still-pending note" would measure against
   * the following note and report the bias as −820 ms instead of +180 ms. Restricting the search
   * would reintroduce exactly the censoring this method exists to remove. The distance to the note
   * grid is a pure function of (chart, lane, time), which also makes it deterministic and
   * order-independent.
   *
   * Returns null when the lane exists but holds no notes.
   * @throws RangeError when `lane` is outside [0, chart.lanes) — see `onInput`.
   */
  nearestNote(lane: number, songTimeSec: number): Note | null {
    const notes = this.laneNotes[lane];
    if (notes === undefined) throw new RangeError(`Judge: lane ${lane} out of range [0, ${this.laneNotes.length})`);
    if (notes.length === 0) return null;
    const t = songTimeSec - this.latencyOffsetSec;
    let lo = 0;
    let hi = notes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (notes[mid].time < t) lo = mid + 1;
      else hi = mid;
    }
    const after = lo < notes.length ? notes[lo] : null;
    let before: Note | null = null;
    if (lo > 0) {
      // among notes sharing a time, always return the lowest id, so the answer never depends on
      // which duplicate the search happened to land on
      let k = lo - 1;
      while (k > 0 && notes[k - 1].time === notes[k].time) k--;
      before = notes[k];
    }
    if (after === null) return before;
    if (before === null) return after;
    return t - before.time <= after.time - t ? before : after;
  }

  /**
   * `onInput` plus the diagnostics the rehab metrics need: the distance to the nearest unjudged
   * note in the lane even when the input matched nothing. Judgment and note states are byte-for-byte
   * what `onInput` would produce — this only adds observation. Allocates one result object per call
   * (inputs are a few per second, not per frame).
   *
   * @throws RangeError when `lane` is outside [0, chart.lanes) — see `onInput`.
   */
  onInputDetailed(lane: number, songTimeSec: number): InputResult {
    const t = songTimeSec - this.latencyOffsetSec;
    const nearest = this.nearestNote(lane, songTimeSec);
    const hit = this.onInput(lane, songTimeSec);
    return {
      hit,
      lane,
      time: t,
      nearestDeltaMs: nearest === null ? null : (t - nearest.time) * 1000,
      nearestNoteId: nearest === null ? null : nearest.id,
    };
  }

  /**
   * Advance the judge to `songTimeSec`, declaring misses for pending notes whose good window
   * (plus miss grace) has elapsed. Returns newly missed notes ordered by *note time* (then id) —
   * not by deadline, which differs per lane when fine-motor (x1.6) and gross-motor lanes are mixed;
   * a shared frozen empty array when none. Miss events carry `time` = note time + goodMs (the
   * deadline) and `deltaMs` = goodMs.
   */
  update(songTimeSec: number): readonly HitEvent[] {
    const t = songTimeSec - this.latencyOffsetSec - this.missGraceSec;
    let out: HitEvent[] | null = null;
    for (let lane = 0; lane < this.laneNotes.length; lane++) {
      const notes = this.laneNotes[lane];
      const goodMs = this.windows[lane].goodMs;
      const goodSec = goodMs / 1000;
      const deadline = t - goodSec;
      let i = this.laneCursor[lane];
      for (; i < notes.length; i++) {
        const n = notes[i];
        if (n.time > deadline) break;
        const idx = this.indexById.get(n.id)!;
        if (this.states[idx] !== STATE_PENDING) continue;
        this.states[idx] = STATE_MISS;
        this.pendingCount--;
        if (out === null) {
          out = this.missScratch;
          out.length = 0;
        }
        out.push({ noteId: n.id, lane, judgment: 'miss', deltaMs: goodMs, time: n.time + goodSec });
      }
      this.laneCursor[lane] = i;
    }
    if (out === null) return EMPTY;
    if (out.length > 1) out.sort((a, b) => a.time - a.deltaMs / 1000 - (b.time - b.deltaMs / 1000) || a.noteId - b.noteId);
    // hand back a fresh copy so callers may retain it; scratch is reused
    const copy = out.slice();
    out.length = 0;
    return copy;
  }

  private mark(note: Note, state: number, lane: number): void {
    const idx = this.indexById.get(note.id)!;
    this.states[idx] = state;
    this.pendingCount--;
    // advance cursor past leading judged notes
    const notes = this.laneNotes[lane];
    let c = this.laneCursor[lane];
    while (c < notes.length && this.states[this.indexById.get(notes[c].id)!] !== STATE_PENDING) c++;
    this.laneCursor[lane] = c;
  }
}
