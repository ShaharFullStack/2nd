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
    this.state = 'running';
  }

  pause(ctxTime: number = this.ctx.currentTime): void {
    if (this.state !== 'running') return;
    this.pausedAtCtx = ctxTime;
    this.state = 'paused';
  }

  resume(ctxTime: number = this.ctx.currentTime): void {
    if (this.state !== 'paused') return;
    this.pausedTotal += Math.max(0, ctxTime - this.pausedAtCtx);
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

/**
 * Moving cursor over the (time-sorted) chart notes for per-frame rendering queries.
 * Amortized O(1) per frame: the head only advances as notes scroll out of view.
 */
export class NoteCursor {
  /** Chart notes sorted by time (a copy; the chart itself is not mutated). */
  readonly notes: readonly Note[];
  readonly chart: Chart;
  private head = 0;
  private tailSec: number;
  private readonly range: NoteRange = { start: 0, end: 0 };

  /**
   * @param tailSec how long (seconds) a note stays "visible" after its time has passed
   *                (so hit/miss animations can draw it); default 0.5 s.
   */
  constructor(chart: Chart, tailSec = 0.5) {
    this.chart = chart;
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

const cursorByChart = new WeakMap<Chart, NoteCursor>();

/**
 * Visible notes for a frame — the spec signature `visibleNotes(chart, songTime, lookaheadSec)`.
 * The moving cursor is kept per chart (WeakMap) so repeated calls with the same chart are amortized
 * O(1); notes within `tailSec` (default 0.5 s) after their time are included so hit/miss animations
 * can draw them. Pass a `NoteCursor` instead of a chart to control the tail explicitly, and `out` to
 * avoid per-frame allocation.
 */
export function visibleNotes(source: Chart | NoteCursor, songTime: number, lookaheadSec: number, out?: Note[]): Note[] {
  let cursor: NoteCursor;
  if (source instanceof NoteCursor) cursor = source;
  else {
    let c = cursorByChart.get(source);
    if (!c) {
      c = new NoteCursor(source);
      cursorByChart.set(source, c);
    }
    cursor = c;
  }
  return cursor.collect(songTime, lookaheadSec, out);
}
