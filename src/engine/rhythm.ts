import { DEFAULT_MISS_GRACE_MS, Judge } from './judge.ts';
import type { InputResult } from './judge.ts';
import { estimateLatencyFromDeltas } from './latency.ts';
import type { LatencyEstimate } from './latency.ts';
import { NoteCursor, SongClock } from './scheduler.ts';
import type { ClockSource } from './scheduler.ts';
import { Scoring } from './scoring.ts';
import type { ScoreDelta, ScoreResults, ScoreState, TimingBias } from './scoring.ts';
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
  /**
   * Miss grace (ms) covering the input pipeline's capture→delivery delay. Default
   * `DEFAULT_MISS_GRACE_MS` (100), NOT the spec-exact 0 that a bare `Judge` uses: camera inputs are
   * timestamped at capture and delivered after inference, so a note whose good window closed at the
   * audible deadline must stay hittable for one delivery delay longer.
   *
   * Consequence for the renderer: note states (`Judge.getNoteState`), `TickResult.misses` and
   * `isComplete()` lag the audible deadline by this much. Read it back with `getMissGraceMs()` and
   * either delay the "miss" animation by the same amount or accept a `missGraceMs`-late flash; pass
   * 0 here for a keyboard/replay input source, which has no delivery delay.
   */
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
    this.scoring.setLatencyOffsetMs(this.judge.getLatencyOffset() * 1000);
    this.cursor = new NoteCursor(opts.chart, opts.tailSec ?? 0.5);
  }

  /**
   * The single input-latency knob. Applying a mid-session calibration also rebases the timing-bias
   * samples collected so far (they are stored offset-free), so the Results screen reports one
   * honest bias instead of a bimodal mixture of "before" and "after" the correction, and
   * `suggestedInputLatency()` keeps converging. Judgments already made are not revisited.
   */
  setInputLatency(sec: number): void {
    this.judge.setLatencyOffset(sec);
    this.scoring.setLatencyOffsetMs(sec * 1000);
  }

  getInputLatency(): number {
    return this.judge.getLatencyOffset();
  }

  /**
   * Miss grace (ms): how far behind the audible deadline (`note.time + goodMs`) note states and
   * `TickResult.misses` run. Default `DEFAULT_MISS_GRACE_MS`; see `RhythmEngineOptions.missGraceMs`.
   */
  getMissGraceMs(): number {
    return this.judge.getMissGrace();
  }

  setMissGraceMs(ms: number): void {
    this.judge.setMissGrace(ms);
  }

  /**
   * Apply a new therapist window scale mid-session without losing the run: pass fresh windows
   * (`windowsForLanes(lanes, difficulty, scale)`), keeping every judgment, the score and the cursor.
   * Judgments already made are not revisited; see `Judge.setWindows`.
   */
  setWindows(windows: TimingWindows | TimingWindows[]): void {
    this.judge.setWindows(windows);
  }

  /** Windows currently in force for a lane. @throws RangeError for a lane outside the chart. */
  getWindows(lane: number): TimingWindows {
    return this.judge.getWindows(lane);
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
   *
   * An input that matches no note is never penalised, but it is recorded: the rep is counted and
   * its distance to the nearest unjudged note feeds the uncensored timing bias
   * (`ScoreState.reps` / `timingBiasMs`, `suggestedInputLatency()`). An input on a lane the chart
   * does not have does not throw here either — it is counted in `ScoreState.outOfRange`.
   */
  handleInput(e: LaneInputEvent): HitEvent | null {
    return this.handleInputDetailed(e)?.hit ?? null;
  }

  /**
   * `handleInput` with the diagnostics: the nearest unjudged note's distance even when nothing was
   * hit. Returns null when the clock is idle or the stamp falls inside a pause (nothing recorded).
   */
  handleInputDetailed(e: LaneInputEvent): InputResult | null {
    const songTime = this.clock.songTimeOf(e.ctxTime);
    if (songTime === null) return null;
    // The InputSource is the untrusted boundary: a mis-wired keyboard map or an off-by-one
    // LaneSpec.index delivers a lane this chart does not have. `Judge.onInputDetailed` throws for
    // that (like every other lane-indexed API), but throwing out of the input callback would kill a
    // patient's session over a wiring bug. Count it instead — a rep performed is never lost, and
    // `ScoreState.outOfRange` above 0 names the bug for dev tools and the Results screen.
    if (!Number.isInteger(e.lane) || e.lane < 0 || e.lane >= this.chart.lanes) {
      this.scoring.recordOutOfRangeInput(e.lane);
      return { hit: null, lane: e.lane, time: songTime - this.judge.getLatencyOffset(), nearestDeltaMs: null, nearestNoteId: null };
    }
    const r = this.judge.onInputDetailed(e.lane, songTime);
    if (r.hit) this.lastHit = this.scoring.apply(r.hit);
    // WHICH note the movement was nearest, not only how far off it was: `Scoring` counts a missed
    // note as ANSWERED when a movement landed on it, and that count is what the HUD gauge shows.
    else this.scoring.recordUnmatchedInput(e.lane, r.nearestDeltaMs, r.nearestNoteId);
    return r;
  }

  /**
   * Re-estimate the input latency from what has been played so far: the current offset plus the
   * robust centre of every input's distance to the note it was aiming at (hits *and* inputs the
   * good window rejected). Returns null when too little data has accumulated, or when the estimate
   * is not a consistent bias (`estimate.confident === false`).
   *
   * Use it to tell the therapist mid-session "the camera offset looks ~180 ms out" — apply it with
   * `setInputLatency(suggested)`. Judgments already made are not revisited.
   *
   * @param lane restrict to one lane (default: all lanes pooled).
   */
  suggestedInputLatency(lane?: number): { sec: number; adjustmentSec: number; estimate: LatencyEstimate } | null {
    const samples = this.scoring.getNearestDeltaSamplesMs(lane);
    if (samples.length === 0) return null;
    const estimate = estimateLatencyFromDeltas(samples.map((ms) => ms / 1000));
    if (!estimate.confident) return null;
    return { sec: this.getInputLatency() + estimate.offsetSec, adjustmentSec: estimate.offsetSec, estimate };
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

  /**
   * Per-frame HUD snapshot: cached and frozen, so binding to it every frame costs nothing and the
   * same object comes back until the score actually changes. Robust timing bias is not in it (it
   * costs two sorts of the sample pool) — the Results screen calls `getScoreResults()` once.
   */
  getScoreState(): ScoreState {
    return this.scoring.getState();
  }

  /** `getScoreState()` plus the robust timing bias, overall and per lane. Results screen; not per frame. */
  getScoreResults(): ScoreResults {
    return this.scoring.getResults();
  }

  /** Robust timing bias for a lane (or all lanes pooled) on the current latency timeline. */
  getTimingBias(lane?: number): TimingBias {
    return this.scoring.getTimingBias(lane);
  }

  isComplete(): boolean {
    return this.judge.getPendingCount() === 0;
  }
}
