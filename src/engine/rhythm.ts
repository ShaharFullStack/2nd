import { DEFAULT_MISS_GRACE_MS, Judge } from './judge.ts';
import { NoteCursor, SongClock } from './scheduler.ts';
import type { ClockSource } from './scheduler.ts';
import { Scoring } from './scoring.ts';
import type { ScoreDelta, ScoreState } from './scoring.ts';
import type { Chart, HitEvent, Note, TimingWindows } from './types.ts';
import type { LaneInputEvent } from '../input/types.ts';

const NO_EVENTS: readonly HitEvent[] = Object.freeze([]) as readonly HitEvent[];

export interface RhythmEngineOptions {
  chart: Chart;
  /** Per-lane windows (from `windowsForLanes`) or one set for every lane. */
  windows: TimingWindows | TimingWindows[];
  /** AudioContext (or any {currentTime}). */
  ctx: ClockSource;
  /** Calibrated input pipeline latency (seconds, `CalibrationResult.offsetSec`). Applied exactly once. */
  inputLatencySec?: number;
  /** Miss grace (ms) covering the input pipeline's capture→delivery delay. Default `DEFAULT_MISS_GRACE_MS`. */
  missGraceMs?: number;
  /** Audio/visual alignment offset for the SongClock (seconds). Default 0. Not the calibration value. */
  avOffsetSec?: number;
  /** Seconds a note stays visible after its time (for animations). Default 0.5. */
  tailSec?: number;
}

export interface TickResult {
  songTime: number;
  /** Notes newly declared missed this tick (already applied to scoring). Shared frozen array when empty. */
  misses: readonly HitEvent[];
  /** Number of notes still pending; 0 = chart complete. */
  pending: number;
}

/**
 * The integration recipe, composed: SongClock + Judge + Scoring + NoteCursor with the latency
 * calibration applied exactly once.
 *
 *   const engine = new RhythmEngine({ chart, windows, ctx: audioContext, inputLatencySec: calib.offsetSec });
 *   engine.start(startCtxTime);                       // same ctx time you pass to StemMixer.start
 *   input.onEvent((e) => { const hit = engine.handleInput(e); if (hit) render.flash(hit); });
 *   frame: const { songTime, misses } = engine.tick(); render.draw(engine.visibleNotes(songTime, lookahead, out), …);
 *
 * Time flow: LaneInputEvent.ctxTime → clock.songTime(ctxTime) → judge (subtracts inputLatencySec once).
 * Do not shift the SongClock by the calibration value and do not pre-subtract it from ctxTime.
 */
export class RhythmEngine {
  readonly chart: Chart;
  readonly clock: SongClock;
  readonly judge: Judge;
  readonly scoring: Scoring;
  readonly cursor: NoteCursor;
  private lastHit: ScoreDelta | null = null;

  constructor(opts: RhythmEngineOptions) {
    this.chart = opts.chart;
    this.clock = new SongClock(opts.ctx, { avOffsetSec: opts.avOffsetSec ?? 0 });
    this.judge = new Judge(opts.chart, opts.windows, {
      latencyOffsetSec: opts.inputLatencySec ?? 0,
      missGraceMs: opts.missGraceMs ?? DEFAULT_MISS_GRACE_MS,
    });
    this.scoring = new Scoring(opts.chart.lanes, opts.chart.notes.length);
    this.cursor = new NoteCursor(opts.chart, opts.tailSec ?? 0.5);
  }

  /** The single input-latency knob. */
  setInputLatency(sec: number): void {
    this.judge.setLatencyOffset(sec);
  }

  getInputLatency(): number {
    return this.judge.getLatencyOffset();
  }

  start(ctxTime?: number, songTimeAtStart = 0): void {
    this.clock.start(ctxTime, songTimeAtStart);
  }

  pause(ctxTime?: number): void {
    this.clock.pause(ctxTime);
  }

  resume(ctxTime?: number): void {
    this.clock.resume(ctxTime);
  }

  stop(): void {
    this.clock.stop();
  }

  /** Restart from the beginning: clears judgments, score and cursor (clock must be started again). */
  reset(): void {
    this.clock.stop();
    this.judge.reset();
    this.scoring.reset();
    this.cursor.reset();
    this.lastHit = null;
  }

  /** Song time now (or at `ctxTime`). */
  songTime(ctxTime?: number): number {
    return this.clock.songTime(ctxTime);
  }

  /**
   * Judge an input event (ctx-timestamped). Returns the HitEvent (already applied to scoring) or
   * null when it matched no note. Ignored while the clock is idle; while paused, events stamped
   * before the pause point are still judged (a camera crossing captured just before `pause()` and
   * delivered ~100 ms later must not lose its rep), later stamps are ignored.
   */
  handleInput(e: LaneInputEvent): HitEvent | null {
    const songTime = this.clock.songTimeOf(e.ctxTime);
    if (songTime === null) return null;
    const hit = this.judge.onInput(e.lane, songTime);
    if (hit) this.lastHit = this.scoring.apply(hit);
    return hit;
  }

  /** Per-frame: advance misses (applied to scoring). */
  tick(ctxTime?: number): TickResult {
    const songTime = this.clock.songTime(ctxTime);
    // paused: song time is frozen so nothing new can be missed; idle: nothing to judge yet
    const misses = this.clock.getState() === 'idle' ? NO_EVENTS : this.judge.update(songTime);
    for (let i = 0; i < misses.length; i++) this.scoring.apply(misses[i]);
    return { songTime, misses, pending: this.judge.getPendingCount() };
  }

  /** Notes to draw for this frame (reuse `out` to avoid allocation). */
  visibleNotes(songTime: number, lookaheadSec: number, out?: Note[]): Note[] {
    return this.cursor.collect(songTime, lookaheadSec, out);
  }

  /** Points/combo/health delta of the most recent hit (null before the first). */
  getLastHitDelta(): ScoreDelta | null {
    return this.lastHit;
  }

  getScoreState(): ScoreState {
    return this.scoring.getState();
  }

  isComplete(): boolean {
    return this.judge.getPendingCount() === 0;
  }
}
