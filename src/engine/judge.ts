import type { Chart, HitEvent, Judgment, Note, TimingWindows } from './types.ts';

export type NoteState = 'pending' | Judgment;

const STATE_PENDING = 0;
const STATE_PERFECT = 1;
const STATE_GOOD = 2;
const STATE_MISS = 3;
const STATE_NAMES: readonly NoteState[] = ['pending', 'perfect', 'good', 'miss'];

const EMPTY: readonly HitEvent[] = Object.freeze([]) as readonly HitEvent[];

/**
 * Pure, deterministic hit judge.
 *
 * Time base: every time passed in is *song time in seconds* as derived from the audio clock.
 * `latencyOffsetSec` (input pipeline latency, from calibration) is subtracted internally, so an
 * input observed at song time t is judged at (t - latencyOffsetSec). `update()` uses the same
 * shifted timeline so misses are declared consistently with hits.
 *
 * Rehab rules: an input with no candidate note is ignored (no penalty for extra movements).
 */
export class Judge {
  readonly chart: Chart;
  private readonly windows: TimingWindows[];
  private latencyOffsetSec: number;

  /** notes sorted by time per lane */
  private readonly laneNotes: Note[][];
  /** per lane: index of first note that is still pending (all before it are judged) */
  private readonly laneCursor: number[];
  /** state per note index (index into chart.notes) */
  private readonly states: Uint8Array;
  private readonly indexById: Map<number, number>;
  private pendingCount: number;
  private missScratch: HitEvent[] = [];

  constructor(chart: Chart, windows: TimingWindows | TimingWindows[], latencyOffsetSec = 0) {
    this.chart = chart;
    const lanes = Math.max(1, chart.lanes);
    this.windows = [];
    for (let l = 0; l < lanes; l++) {
      const w = Array.isArray(windows) ? (windows[l] ?? windows[windows.length - 1]) : windows;
      if (!w) throw new Error('Judge: no timing windows supplied');
      this.windows.push({ perfectMs: w.perfectMs, goodMs: w.goodMs });
    }
    this.latencyOffsetSec = latencyOffsetSec;
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
      if (n.lane >= 0 && n.lane < lanes) this.laneNotes[n.lane].push(n);
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

  getWindows(lane: number): TimingWindows {
    return this.windows[lane] ?? this.windows[this.windows.length - 1];
  }

  /** Number of notes not yet judged. */
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
   * deltaMs is positive when the input is late.
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
   * Advance the judge to `songTimeSec`, declaring misses for pending notes whose good window has
   * elapsed. Returns newly missed notes ordered by note time (a shared empty array when none —
   * do not mutate/retain the result).
   */
  update(songTimeSec: number): readonly HitEvent[] {
    const t = songTimeSec - this.latencyOffsetSec;
    let out: HitEvent[] | null = null;
    for (let lane = 0; lane < this.laneNotes.length; lane++) {
      const notes = this.laneNotes[lane];
      const goodSec = this.windows[lane].goodMs / 1000;
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
        out.push({ noteId: n.id, lane, judgment: 'miss', deltaMs: this.windows[lane].goodMs, time: n.time + goodSec });
      }
      this.laneCursor[lane] = i;
    }
    if (out === null) return EMPTY;
    if (out.length > 1) out.sort((a, b) => a.time - b.time || a.noteId - b.noteId);
    // hand back a fresh copy so callers may retain it; scratch is reused
    return out.slice();
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
