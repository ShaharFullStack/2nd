import type { Chart, Note } from './types.ts';

/** Minimal AudioContext-like clock source. */
export interface ClockSource {
  readonly currentTime: number;
}

export type SongClockState = 'idle' | 'running' | 'paused';

/**
 * Song clock driven by AudioContext.currentTime.
 * songTime = (ctxNow - startCtxTime - totalPausedSec) + avOffsetSec
 *
 * LATENCY — one knob only. The calibration value (`inputLatencySec`) belongs to the Judge
 * (`JudgeOptions.latencyOffsetSec`) or, better, to `RhythmEngine`, which owns both. The SongClock
 * deliberately has NO input-latency parameter: an input observed at ctx time t is converted with
 * `songTime(t)` and the Judge subtracts the latency once. `avOffsetSec` is a constant audio/visual
 * alignment offset (e.g. output latency of the audio device) — leave it at 0 unless you are aligning
 * the highway to the speakers; it is never the calibration value.
 */
export class SongClock {
  private readonly ctx: ClockSource;
  private avOffsetSec: number;
  private startCtx = 0;
  private pausedAtCtx = 0;
  private pausedTotal = 0;
  /** ctx time of the most recent `resume()`; stamps inside (pausedAtCtx, resumedAtCtx) are rejected. */
  private resumedAtCtx = -Infinity;
  /** Duration of the most recent completed pause, so stamps from before it map correctly after it. */
  private lastPauseSec = 0;
  private state: SongClockState = 'idle';

  constructor(ctx: ClockSource, opts: { avOffsetSec?: number } = {}) {
    this.ctx = ctx;
    this.avOffsetSec = opts.avOffsetSec ?? 0;
  }

  getState(): SongClockState {
    return this.state;
  }

  isRunning(): boolean {
    return this.state === 'running';
  }

  /** Audio/visual alignment offset added to song time (NOT the input latency calibration). */
  setAvOffset(sec: number): void {
    this.avOffsetSec = sec;
  }

  getAvOffset(): number {
    return this.avOffsetSec;
  }

  /**
   * Start the song. `ctxTime` is the AudioContext time at which song time `songTimeAtStart` occurs
   * (default: now / 0). Schedule audio sources to start at the same ctx time.
   */
  start(ctxTime: number = this.ctx.currentTime, songTimeAtStart = 0): void {
    this.startCtx = ctxTime - songTimeAtStart;
    this.pausedTotal = 0;
    this.pausedAtCtx = 0;
    this.resumedAtCtx = -Infinity;
    this.lastPauseSec = 0;
    this.state = 'running';
  }

  pause(ctxTime: number = this.ctx.currentTime): void {
    if (this.state !== 'running') return;
    this.pausedAtCtx = ctxTime;
    this.resumedAtCtx = -Infinity;
    this.state = 'paused';
  }

  resume(ctxTime: number = this.ctx.currentTime): void {
    if (this.state !== 'paused') return;
    this.lastPauseSec = Math.max(0, ctxTime - this.pausedAtCtx);
    this.pausedTotal += this.lastPauseSec;
    this.resumedAtCtx = Math.max(ctxTime, this.pausedAtCtx);
    this.state = 'running';
  }

  stop(): void {
    this.state = 'idle';
  }

  /** Song time (seconds) at AudioContext time `nowCtx` (default: now). Frozen while paused; 0 while idle. */
  songTime(nowCtx: number = this.ctx.currentTime): number {
    if (this.state === 'idle') return 0;
    const t = this.state === 'paused' ? this.pausedAtCtx : nowCtx;
    return t - this.startCtx - this.pausedTotal + this.avOffsetSec;
  }

  /**
   * Song time at which the event stamped `ctxTime` occurred, for events delivered late (e.g. a camera
   * crossing stamped before `pause()` but delivered after it). Unlike `songTime`, a paused clock still
   * maps stamps up to the pause point.
   *
   * Returns null while idle, for stamps after the pause point while paused, and — after `resume()` —
   * for stamps that fall inside the pause interval just ended: a movement made while the song was
   * stopped must not be able to claim a note sitting near the pause boundary.
   *
   * A stamp from *before* the most recent pause is still mapped correctly after the resume (the
   * pause that had not yet happened when it was taken is not subtracted). Only the most recent
   * pause is remembered; anything older than that is far beyond any input-delivery delay (~100 ms).
   */
  songTimeOf(ctxTime: number): number | null {
    if (this.state === 'idle') return null;
    if (this.state === 'paused' && ctxTime > this.pausedAtCtx) return null;
    let paused = this.pausedTotal;
    if (this.state === 'running' && this.resumedAtCtx > -Infinity) {
      if (ctxTime > this.pausedAtCtx && ctxTime < this.resumedAtCtx) return null;
      if (ctxTime <= this.pausedAtCtx) paused -= this.lastPauseSec;
    }
    return ctxTime - this.startCtx - paused + this.avOffsetSec;
  }

  /** AudioContext time at which song time `songTime` will occur (valid while running or paused). */
  ctxTimeForSongTime(songTime: number): number {
    return songTime - this.avOffsetSec + this.startCtx + this.pausedTotal;
  }
}

/* ---------- beat helpers ---------- */

export interface BeatInfo {
  /** Fractional beat index (can be negative before the first beat). */
  beat: number;
  /** Phase within the current beat, 0..1. */
  phase: number;
  /** Integer beat index (floor). */
  beatIndex: number;
  /** Position within bar, 0..beatsPerBar-1. */
  beatInBar: number;
  bar: number;
}

export function beatAt(bpm: number, offset: number, songTime: number, beatsPerBar = 4): BeatInfo {
  const beat = ((songTime - offset) * bpm) / 60;
  const beatIndex = Math.floor(beat);
  const phase = beat - beatIndex;
  const bar = Math.floor(beatIndex / beatsPerBar);
  const beatInBar = beatIndex - bar * beatsPerBar;
  return { beat, phase, beatIndex, beatInBar, bar };
}

/* ---------- note cursor ---------- */

export interface NoteRange {
  /** inclusive start index into `NoteCursor.notes` */
  start: number;
  /** exclusive end index */
  end: number;
}

/** How long a note stays "visible" after its time by default (hit/miss animations). */
export const DEFAULT_TAIL_SEC = 0.5;

/**
 * Moving cursor over the (time-sorted) chart notes for per-frame rendering queries.
 * Amortized O(1) per frame: the head only advances as notes scroll out of view.
 *
 * One cursor per consumer: it holds a playback position, so two consumers polling one cursor at
 * different song times make it seek back and forth. `RhythmEngine` owns one; the chart form of
 * `visibleNotes` is stateless and safe to share instead.
 */
export class NoteCursor {
  /** Chart notes sorted by time (a copy; the chart itself is not mutated). */
  readonly notes: readonly Note[];
  readonly chart: Chart;
  /** The `chart.notes` array the sorted copy was taken from (staleness check for `visibleNotes`). */
  readonly sourceNotes: readonly Note[];
  private head = 0;
  private tailSec: number;
  private readonly range: NoteRange = { start: 0, end: 0 };

  /**
   * @param tailSec how long (seconds) a note stays "visible" after its time has passed
   *                (so hit/miss animations can draw it); default 0.5 s.
   */
  constructor(chart: Chart, tailSec = DEFAULT_TAIL_SEC) {
    this.chart = chart;
    this.sourceNotes = chart.notes;
    this.notes = chart.notes.slice().sort((a, b) => a.time - b.time || a.id - b.id);
    this.tailSec = tailSec;
  }

  setTail(tailSec: number): void {
    this.tailSec = tailSec;
  }

  getTail(): number {
    return this.tailSec;
  }

  reset(): void {
    this.head = 0;
  }

  /** Index of the first note that is still within the tail (everything before has scrolled out). */
  getHead(): number {
    return this.head;
  }

  /** Move head so that notes[head] is the first note with time >= songTime - tailSec. Handles seeks backwards. */
  advance(songTime: number): number {
    const cutoff = songTime - this.tailSec;
    const notes = this.notes;
    let h = this.head;
    while (h < notes.length && notes[h].time < cutoff) h++;
    while (h > 0 && notes[h - 1].time >= cutoff) h--;
    this.head = h;
    return h;
  }

  /**
   * Visible range [start, end) for notes with time in [songTime - tailSec, songTime + lookaheadSec].
   * Returns a reused object — copy the fields if you need to keep them.
   */
  visibleRange(songTime: number, lookaheadSec: number): NoteRange {
    const start = this.advance(songTime);
    const limit = songTime + lookaheadSec;
    const notes = this.notes;
    let end = start;
    while (end < notes.length && notes[end].time <= limit) end++;
    this.range.start = start;
    this.range.end = end;
    return this.range;
  }

  /** Fill `out` (cleared first) with the visible notes and return it. */
  collect(songTime: number, lookaheadSec: number, out: Note[] = []): Note[] {
    const r = this.visibleRange(songTime, lookaheadSec);
    out.length = 0;
    for (let i = r.start; i < r.end; i++) out.push(this.notes[i]);
    return out;
  }
}

/**
 * Time-sorted view of a chart's notes, memoised per notes array.
 *
 * This is a *pure* memo — a cached derivation of an immutable input, keyed on the exact array
 * object — not a hidden cursor. Two consumers polling the same chart at different song times share
 * the sorted copy and nothing else, so neither can perturb the other (the earlier WeakMap held a
 * mutable playback position, which they could).
 */
interface SortedMemo {
  len: number;
  /** endpoint identity + times: an O(1) staleness signature, see `sortedNotesOf` */
  first: Note | undefined;
  last: Note | undefined;
  firstTime: number;
  lastTime: number;
  sorted: readonly Note[];
}

const sortedByNotes = new WeakMap<readonly Note[], SortedMemo>();

/**
 * Drop the memoised sorted view of a notes array — call it after editing note *times in place*
 * (a chart editor / dev tools), which the O(1) staleness signature cannot always detect.
 * Building a new chart object with a new notes array needs no invalidation.
 */
export function invalidateSortedNotes(source: Chart | readonly Note[]): void {
  sortedByNotes.delete(Array.isArray(source) ? (source as readonly Note[]) : (source as Chart).notes);
}

function sortedNotesOf(chart: Chart): readonly Note[] {
  const src = chart.notes;
  const n = src.length;
  const cached = sortedByNotes.get(src);
  // Staleness signature, all O(1): length, the identity of the endpoint note objects, and their
  // times. It catches a replaced array, a grown/shrunk one, a replaced or retimed first/last note
  // — the common editor edits. It cannot catch a time edit on a note strictly inside the array;
  // for that the editor must call `invalidateSortedNotes` (or rebuild the chart).
  if (
    cached !== undefined &&
    cached.len === n &&
    cached.first === src[0] &&
    cached.last === src[n - 1] &&
    cached.firstTime === (src[0]?.time ?? 0) &&
    cached.lastTime === (src[n - 1]?.time ?? 0)
  ) {
    return cached.sorted;
  }
  let ordered = true;
  for (let i = 1; i < n; i++) {
    if (src[i].time < src[i - 1].time) {
      ordered = false;
      break;
    }
  }
  const sorted = ordered ? src.slice() : src.slice().sort((a, b) => a.time - b.time || a.id - b.id);
  sortedByNotes.set(src, {
    len: n,
    first: src[0],
    last: src[n - 1],
    firstTime: src[0]?.time ?? 0,
    lastTime: src[n - 1]?.time ?? 0,
    sorted,
  });
  return sorted;
}

/** First index with notes[i].time >= t (binary search over a time-sorted array). */
function lowerBoundByTime(notes: readonly Note[], t: number): number {
  let lo = 0;
  let hi = notes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (notes[mid].time < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Visible notes for a frame — the spec signature `visibleNotes(chart, songTime, lookaheadSec)`.
 *
 * Given a Chart this is stateless: O(log n) binary search over a memoised time-sorted view of
 * `chart.notes`, so any number of consumers (highway, preview strip, a React StrictMode double
 * render) may call it at any song times, in any order, and each gets the same answer at the same
 * cost. There is no shared playback position. The memo is keyed on the `chart.notes` array object
 * and validated in O(1) against its length and its endpoint notes' identity and times, so
 * replacing the array, changing its length, or retiming/replacing the first or last note all
 * invalidate it. A time edit on a note strictly INSIDE the array cannot be detected that cheaply —
 * after such an edit call `invalidateSortedNotes(chart)` (or build a new chart object / a fresh
 * `NoteCursor`).
 *
 * Given a `NoteCursor` it uses that cursor's amortized-O(1) advance instead. For a hot per-frame
 * loop over a long chart prefer the cursor (`RhythmEngine.cursor` is one per engine).
 *
 * Notes within `tailSec` (default 0.5 s for the cursor form) after their time are included so
 * hit/miss animations can draw them. Pass `out` to avoid per-frame allocation.
 */
export function visibleNotes(source: Chart | NoteCursor, songTime: number, lookaheadSec: number, out?: Note[]): Note[] {
  if (source instanceof NoteCursor) return source.collect(songTime, lookaheadSec, out);
  const notes = sortedNotesOf(source);
  const result = out ?? [];
  result.length = 0;
  const limit = songTime + lookaheadSec;
  for (let i = lowerBoundByTime(notes, songTime - DEFAULT_TAIL_SEC); i < notes.length; i++) {
    if (notes[i].time > limit) break;
    result.push(notes[i]);
  }
  return result;
}
