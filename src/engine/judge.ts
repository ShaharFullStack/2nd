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
 * Rehab rules: an input with no candidate note is ignored (no penalty for extra movements).
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
   * @param windows one TimingWindows for every lane, or an array indexed by lane (the last entry
   *                is reused for lanes beyond the array).
   * @param options `JudgeOptions`, or a bare number for `latencyOffsetSec` (legacy form).
   * @throws RangeError when the chart has duplicate note ids or lanes outside [0, chart.lanes).
   */
  constructor(chart: Chart, windows: TimingWindows | TimingWindows[], options: number | JudgeOptions = {}) {
    validateChartForJudge(chart);
    const opts: JudgeOptions = typeof options === 'number' ? { latencyOffsetSec: options } : options;
    this.chart = chart;
    const lanes = chart.lanes;
    this.windows = [];
    for (let l = 0; l < lanes; l++) {
      const w = Array.isArray(windows) ? (windows[l] ?? windows[windows.length - 1]) : windows;
      if (!w) throw new Error('Judge: no timing windows supplied');
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

  getWindows(lane: number): TimingWindows {
    return this.windows[lane] ?? this.windows[this.windows.length - 1];
  }

  /** Number of notes not yet judged (0 = every note has been hit or missed). */
  getPendingCount(): number {
    return this.pendingCount;
  }

  getNoteState(noteId: number): NoteState {
    const idx = this.indexById.get(noteId);
    if (idx === undefined) return 'pending';
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
   */
  onInput(lane: number, songTimeSec: number): HitEvent | null {
    const notes = this.laneNotes[lane];
    if (!notes) return null;
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
   * Advance the judge to `songTimeSec`, declaring misses for pending notes whose good window
   * (plus miss grace) has elapsed. Returns newly missed notes ordered by note time; a shared
   * frozen empty array when none. Miss events carry `time` = note time + goodMs (the deadline).
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
    if (out.length > 1) out.sort((a, b) => a.time - b.time || a.noteId - b.noteId);
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
