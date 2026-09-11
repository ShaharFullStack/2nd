/**
 * The game loop, in a plain class.
 *
 * React renders the Play screen's chrome (pause button, camera PiP, attribution card) and nothing
 * else: every frame this class reads the audio clock, judges the queued input events, and hands the
 * renderer a RenderFrame. No React state is touched per frame — the HUD callback is throttled to
 * `hudIntervalMs` and only fires when something a human can read has actually changed.
 *
 *   const runner = new GameRunner({ canvas, chart, lanes, windows, clock: ctx, input, mixer, sfx, ... });
 *   await runner.start();          // 3-2-1 countdown, then the song
 *   runner.pause(); await runner.resume();
 *   runner.dispose();
 */
import type { Sfx } from '../audio/sfx.ts';
import type { StemMixer } from '../audio/StemMixer.ts';
import { RhythmEngine } from '../engine/rhythm.ts';
import { beatAt } from '../engine/scheduler.ts';
import type { ClockSource } from '../engine/scheduler.ts';
import type { ScoreResults } from '../engine/scoring.ts';
import type { Chart, HitEvent, LaneSpec, Note, TimingWindows } from '../engine/types.ts';
import type { CompensationKindName, InputSource, LaneInputEvent, LaneRepEvent, SongTimeSource } from '../input/types.ts';
import { Highway } from '../render/Highway.ts';
import type { CanvasLike, HighwayOptions, RenderFrame, RenderNote } from '../render/types.ts';
import type { SessionEndReason } from './types.ts';

export type RunnerPhase = 'idle' | 'countdown' | 'playing' | 'paused' | 'ended';

/**
 * WHY THE RUN STOPPED. Every one of these persists a RunSummary — the reps the patient actually
 * performed are a clinical record whatever ended the song, and the only dishonest outcome is a run
 * that reports nothing.
 *
 *   'chart'     — the chart finished (or the mixer reported the song had). The only complete run.
 *   'quit'      — the therapist pressed "End & see results".
 *   'abandoned' — the session was taken away from the patient: the play screen was left (Back, a
 *                 deep link, a remount), or the page itself went away (tab closed, tablet slept).
 *                 Recorded exactly like a quit, and marked incomplete just as honestly.
 */
export type RunEndReason = SessionEndReason;

/** What the React chrome is allowed to know, at ~10 Hz. */
export interface HudSnapshot {
  phase: RunnerPhase;
  /** 3, 2, 1 during the count-in; 0 once the song is running. */
  countdown: number;
  songTime: number;
  durationSec: number;
  score: number;
  combo: number;
  maxCombo: number;
  multiplier: number;
  health: number;
  stars: number;
  accuracy: number;
  hits: number;
  misses: number;
  /** Movements performed (hits + inputs that matched no note) — the rehab number. */
  reps: number;
  notesRemaining: number;
  /** True when the audio clock has stopped advancing (suspended context / no audio device). */
  clockStalled: boolean;
  /** Paused because the PAGE went away (tab hidden / tablet locked), not because a human asked. */
  pausedByPage: boolean;
}

/** Rep-level rehab metrics accumulated per lane during the run (camera sessions produce these). */
export interface LaneRepStats {
  lane: number;
  /** Completed reps the input source reported (0 for keyboard/replay, which report no reps). */
  reps: number;
  /** Peak ROM of each completed rep, as an unclamped fraction of the calibrated range. */
  peaks: number[];
  /** Reps whose peak is only a lower bound (dropped frames / cut short). */
  uncertain: number;
  compensationKind: CompensationKindName | null;
  /** True when a rest baseline was in effect for at least one rep (otherwise flags mean "not measured"). */
  compensationMonitored: boolean;
  compensationFlags: number;
  compensationWorst: number | null;
}

export interface RunSummary {
  results: ScoreResults;
  laneReps: LaneRepStats[];
  /** False when the run did not reach the end of the chart (`endReason` says what did happen). */
  completed: boolean;
  /** What stopped the run. `completed === (endReason === 'chart')`. */
  endReason: RunEndReason;
  /** Song seconds played. */
  songTime: number;
  startedAt: number;
  endedAt: number;
  /** What the run says the input latency should have been (seconds), when the estimate is confident. */
  suggestedLatencySec: number | null;
}

export interface GameRunnerOptions {
  canvas: CanvasLike;
  chart: Chart;
  lanes: LaneSpec[];
  /** Per-lane timing windows (`windowsForLanes`). */
  windows: TimingWindows | TimingWindows[];
  /** The single clock — an AudioContext. */
  clock: ClockSource;
  /** The input source, or a factory that needs the song clock (ReplayInput / AutoplayInput do). */
  input: InputSource | ((songClock: SongTimeSource) => InputSource);
  mixer?: StemMixer | null;
  sfx?: Sfx | null;
  /** Calibrated camera latency (seconds). Applied exactly once, inside the engine. */
  inputLatencySec?: number;
  /** Delivery grace for the miss verdict; pass 0 for keyboard/replay (no pipeline delay). */
  missGraceMs?: number;
  /** Fraction of ROM that counts as a hit — the receptors fill against it. */
  thresholdFraction: number;
  rearmFraction?: number;
  /**
   * The input layer's break-in-the-stream window (`VisionInput.staleFrameSec`), forwarded to the
   * renderer as `RenderFrame.maxGapSec`.
   *
   * IT IS A COUPLING, NOT A TUNABLE. The receptor expires its own crossing evidence on exactly the
   * clock `LaneTrigger` throws its arming away on, because the disarm an occlusion causes is
   * published as byte-for-byte the same frame a real threshold crossing is. Leaving this unset made
   * the renderer fall back to `DEFAULT_MAX_GAP_SEC` and the two agreed only because nothing has
   * ever passed `staleFrameSec`; the first session that tuned it would have desynchronised the
   * receptor's peak expiry and its inferred-edge guard silently. Undefined is still honoured (the
   * scripted inputs have no such window) — it just is not the camera path's answer any more.
   */
  maxGapSec?: number;
  /**
   * The input layer's REFRACTORY window (`VisionInput.minIntervalSec`), forwarded to the renderer as
   * `RenderFrame.minIntervalSec`. Same coupling as `maxGapSec`, for the same reason: a crossing
   * swallowed by it locks the lane out and reports a rep but emits NO `LaneInputEvent` and scores
   * nothing, and a receptor that does not know the number celebrates it anyway. Undefined for the
   * scripted inputs, which emit every crossing and have no such window.
   */
  minIntervalSec?: number;
  countdownSec?: number;
  highwayOptions?: Partial<HighwayOptions>;
  songTitle?: string;
  attribution?: string;
  onHud?: (hud: HudSnapshot) => void;
  onEnd?: (summary: RunSummary) => void;
  hudIntervalMs?: number;
  /** Start the input source on start() (default true). */
  startInput?: boolean;
  /** Stop the input source on dispose() (default false — the camera outlives one song). */
  stopInputOnDispose?: boolean;
  /**
   * The page-lifecycle source the runner watches, or null to watch nothing (tests, headless use).
   * Defaults to the real `document` + `window` when they exist. See `watchPageLifecycle`.
   */
  lifecycle?: PageLifecycle | null;
  /** rAF replacement (tests drive frames by hand). Returns a cancel function. */
  schedule?: (cb: () => void) => () => void;
  /** Wall clock in ms for HUD throttling (default performance.now). */
  nowMs?: () => number;
}

/** Seconds of judged notes kept in `recentHits` so the renderer can spawn their effects. */
const RECENT_HIT_SEC = 1.2;
/** Never play more than one miss cue in this window, however many notes expire at once. */
const MISS_CUE_COOLDOWN_SEC = 0.15;
const DEFAULT_COUNTDOWN_SEC = 3;
/** Song seconds of silence after the last note before the results screen. */
const OUTRO_SEC = 1.5;

/**
 * The page-lifecycle facts the runner acts on, as an interface so a test can be the page.
 *
 * `hidden` is `document.visibilityState === 'hidden'`: the tab was backgrounded, the tablet was
 * locked, the therapist switched app. `onPageGone` is `pagehide` — the last moment at which anything
 * can be written to localStorage.
 */
export interface PageLifecycle {
  isHidden(): boolean;
  onVisibilityChange(cb: () => void): () => void;
  onPageGone(cb: () => void): () => void;
}

/** The real page, when there is one. */
export function browserLifecycle(): PageLifecycle | null {
  const doc = typeof document !== 'undefined' ? document : null;
  const win = typeof window !== 'undefined' ? window : null;
  if (!doc || !win) return null;
  return {
    isHidden: () => doc.visibilityState === 'hidden',
    onVisibilityChange: (cb) => {
      doc.addEventListener('visibilitychange', cb);
      return () => doc.removeEventListener('visibilitychange', cb);
    },
    onPageGone: (cb) => {
      win.addEventListener('pagehide', cb);
      return () => win.removeEventListener('pagehide', cb);
    },
  };
}

function defaultSchedule(cb: () => void): () => void {
  if (typeof requestAnimationFrame === 'function') {
    const id = requestAnimationFrame(() => cb());
    return () => cancelAnimationFrame(id);
  }
  const id = setTimeout(cb, 16);
  return () => clearTimeout(id);
}

export class GameRunner {
  readonly engine: RhythmEngine;
  readonly highway: Highway;
  readonly chart: Chart;
  readonly input: InputSource;

  private readonly opts: GameRunnerOptions;
  private readonly clock: ClockSource;
  private readonly mixer: StemMixer | null;
  private readonly sfx: Sfx | null;
  private readonly lanes: LaneSpec[];
  private readonly countdownSec: number;
  private readonly hudIntervalMs: number;
  private readonly nowMs: () => number;
  private readonly schedule: (cb: () => void) => () => void;

  private phase: RunnerPhase = 'idle';
  private cancelFrame: (() => void) | null = null;
  private unsubscribe: Array<() => void> = [];
  private recentHits: HitEvent[] = [];
  private noteBuf: Note[] = [];
  private renderNotes: RenderNote[] = [];
  private frame: RenderFrame;
  private lastHudAt = -Infinity;
  private lastMissCueSongTime = -Infinity;
  private lastComboMilestone = 0;
  private startedAt = 0;
  private endedAt = 0;
  private lastCtxTime = -1;
  private stalledFrames = 0;
  private laneReps: LaneRepStats[];
  private ended = false;
  private disposed = false;
  private readonly lifecycle: PageLifecycle | null;
  /**
   * True while the run is paused BECAUSE THE PAGE WENT AWAY, as opposed to a therapist pause. Kept
   * so a run that is interrupted and never comes back is honest about it, and so the automatic
   * pause is not mistaken for one a human asked for.
   */
  private pausedByPage = false;

  constructor(options: GameRunnerOptions) {
    this.opts = options;
    this.chart = options.chart;
    this.clock = options.clock;
    this.mixer = options.mixer ?? null;
    this.sfx = options.sfx ?? null;
    this.lanes = options.lanes;
    this.countdownSec = options.countdownSec ?? DEFAULT_COUNTDOWN_SEC;
    this.hudIntervalMs = options.hudIntervalMs ?? 100;
    this.nowMs = options.nowMs ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    this.schedule = options.schedule ?? defaultSchedule;
    this.lifecycle = options.lifecycle === undefined ? browserLifecycle() : options.lifecycle;

    this.engine = new RhythmEngine({
      chart: options.chart,
      windows: options.windows,
      ctx: options.clock,
      inputLatencySec: options.inputLatencySec ?? 0,
      missGraceMs: options.missGraceMs,
    });

    this.highway = new Highway(options.canvas, {
      approachSec: 1.6,
      ...options.highwayOptions,
    });

    this.input = typeof options.input === 'function' ? options.input(this.engine.clock) : options.input;

    this.laneReps = this.lanes.map((l) => ({
      lane: l.index,
      reps: 0,
      peaks: [],
      uncertain: 0,
      compensationKind: null,
      compensationMonitored: false,
      compensationFlags: 0,
      compensationWorst: null,
    }));

    this.frame = {
      songTime: 0,
      notes: [],
      lanes: this.lanes,
      laneStates: [],
      combo: 0,
      multiplier: 1,
      score: 0,
      health: 0.5,
      recentHits: this.recentHits,
      bpm: options.chart.bpm,
      beatPhase: 0,
      beatIndex: 0,
      songTitle: options.songTitle,
      attribution: options.attribution,
      thresholdFraction: options.thresholdFraction,
      rearmFraction: options.rearmFraction,
      maxGapSec: options.maxGapSec,
      minIntervalSec: options.minIntervalSec,
      // Set per frame from the phase (see `draw`). Starts true: the runner is 'idle' until `start()`.
      inputSuspended: true,
    };
  }

  getPhase(): RunnerPhase {
    return this.phase;
  }

  /**
   * True when the run is paused because the PAGE went away (tab hidden, tablet locked, app switched)
   * rather than because a human pressed pause. The play screen says so on the pause overlay: a
   * therapist who comes back to a stopped session is owed the reason it stopped.
   */
  isPausedByPage(): boolean {
    return this.phase === 'paused' && this.pausedByPage;
  }

  /** Song time now (the timeline notes are judged against). */
  songTime(): number {
    return this.engine.songTime();
  }

  /** Start the input source, the audio and the loop. Resolves once the countdown has been scheduled. */
  async start(): Promise<void> {
    if (this.phase !== 'idle' || this.disposed) return;
    if (this.opts.startInput !== false) await this.input.start();

    this.subscribe();

    const lead = Math.max(0, this.countdownSec);
    if (this.mixer && this.mixer.isLoaded) {
      // Wire the lanes to stems BEFORE the first note: a miss must dim the instrument of the limb
      // that missed, not the whole band (see ducking.ts `assignLaneStems`).
      this.mixer.setLaneCount(this.chart.lanes);
      this.mixer.play(this.clock.currentTime + lead);
      this.engine.start(this.mixer.getSongStartCtxTime());
    } else {
      this.engine.start(this.clock.currentTime + lead);
    }

    this.startedAt = Date.now();
    this.phase = lead > 0 ? 'countdown' : 'playing';
    this.emitHud(true);
    this.loop();
  }

  private subscribe(): void {
    this.unsubscribe.push(this.input.onEvent((e) => this.onInput(e)));

    const rep = (this.input as { onRep?: (cb: (e: LaneRepEvent) => void) => () => void }).onRep;
    if (typeof rep === 'function') {
      this.unsubscribe.push(rep.call(this.input, (e: LaneRepEvent) => this.onRep(e)));
    }
    if (this.mixer) this.unsubscribe.push(this.mixer.onEnded(() => this.finish('chart')));

    // NOTHING PAUSED WHEN THE THERAPIST LOOKED AWAY. A backgrounded tab stops getting animation
    // frames while the AudioContext clock keeps running, so the song ran on without the board: on
    // return, every note that went by in the meantime was judged in one tick as a wall of misses the
    // patient never had a chance at, and the mixer had been playing to an empty room. The tab going
    // hidden is the patient not being able to play, so the run stops exactly as it does for the
    // pause button — audio and chart clock together — and waits for a human to resume it.
    if (this.lifecycle) {
      this.unsubscribe.push(
        this.lifecycle.onVisibilityChange(() => {
          if (!this.lifecycle?.isHidden()) return;
          if (this.phase !== 'playing' && this.phase !== 'countdown') return;
          this.pausedByPage = true;
          this.pause(true);
        }),
      );
      // THE LAST MOMENT ANYTHING CAN BE SAVED. `pagehide` is the only event that fires for a closed
      // tab, a navigation away and a tablet that discards the page — and localStorage is synchronous,
      // so the run's record is written here rather than evaporating with the page.
      this.unsubscribe.push(this.lifecycle.onPageGone(() => this.finish('abandoned')));
    }
  }

  private onInput(e: LaneInputEvent): void {
    if (this.phase === 'ended' || this.phase === 'idle') return;
    const hit = this.engine.handleInput(e);
    if (!hit) return;
    this.pushRecent(hit);
    const state = this.engine.getScoreState();
    this.mixer?.onLaneHit(hit.lane, state.combo);
    if (this.sfx) {
      if (hit.judgment === 'perfect') this.sfx.perfect(undefined, hit.lane);
      else this.sfx.hit(undefined, hit.lane);
      const milestone = Math.floor(state.combo / 10) * 10;
      if (milestone >= 10 && milestone !== this.lastComboMilestone) {
        this.lastComboMilestone = milestone;
        this.sfx.combo(milestone);
      }
    }
    if (state.combo === 0) this.lastComboMilestone = 0;
  }

  private onRep(e: LaneRepEvent): void {
    const stats = this.laneReps[e.lane];
    if (!stats) return;
    stats.reps++;
    const peak = e.rawPeak ?? e.peak;
    if (Number.isFinite(peak)) stats.peaks.push(peak);
    if (e.truncated || e.gapped) stats.uncertain++;
    if (e.compensationMonitored) stats.compensationMonitored = true;
    if (e.compensation) {
      stats.compensationFlags++;
      stats.compensationKind = e.compensation.kind;
      stats.compensationWorst = Math.max(stats.compensationWorst ?? 0, e.compensation.value);
    }
  }

  private pushRecent(e: HitEvent): void {
    this.recentHits.push(e);
    if (this.recentHits.length > 64) this.recentHits.splice(0, this.recentHits.length - 64);
  }

  private loop(): void {
    this.cancelFrame = this.schedule(() => {
      this.cancelFrame = null;
      if (this.disposed || this.phase === 'ended') return;
      try {
        this.step();
      } catch (err) {
        console.error('[GameRunner] frame failed', err);
      }
      // via the getter: `step()` may have ended the run, and reading the field directly here
      // would let the compiler assume the narrowing from the guard above still holds.
      if (!this.disposed && this.getPhase() !== 'ended') this.loop();
    });
  }

  /** One frame. Public so tests (and a critic) can drive the loop by hand. */
  step(): void {
    const ctxNow = this.clock.currentTime;
    if (ctxNow === this.lastCtxTime) this.stalledFrames++;
    else this.stalledFrames = 0;
    this.lastCtxTime = ctxNow;

    const { songTime, misses } = this.engine.tick(ctxNow);
    if (misses.length > 0) {
      for (const m of misses) {
        this.pushRecent(m);
        // Per lane, one step per miss: the weak side dims its own stem only, and only in proportion
        // to the run of misses. A single miss anywhere used to drop the player's instrument to 5 %.
        this.mixer?.onLaneMiss(m.lane);
      }
      if (this.sfx && songTime - this.lastMissCueSongTime > MISS_CUE_COOLDOWN_SEC) {
        this.lastMissCueSongTime = songTime;
        this.sfx.miss();
      }
      this.lastComboMilestone = 0;
    }

    if (this.phase === 'countdown' && songTime >= 0) this.phase = 'playing';

    this.draw(songTime);
    this.emitHud(false);

    if (this.phase === 'playing' && songTime >= this.endSongTime()) this.finish('chart');
  }

  private endSongTime(): number {
    const notes = this.chart.notes;
    const lastNote = notes.length > 0 ? notes[notes.length - 1].time : 0;
    return Math.min(this.chart.durationSec, Math.max(lastNote + OUTRO_SEC, OUTRO_SEC));
  }

  private draw(songTime: number): void {
    // Judge against `songTime`; DRAW what the listener is hearing (one output buffer earlier).
    const drawTime = songTime - (this.mixer?.outputLatencySec ?? 0);
    const notes = this.engine.visibleNotes(drawTime, this.highway.options.approachSec + 0.2, this.noteBuf);
    this.noteBuf = notes;

    while (this.renderNotes.length < notes.length) {
      this.renderNotes.push({ id: 0, lane: 0, time: 0, state: 'pending' });
    }
    const out: RenderNote[] = [];
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      const rn = this.renderNotes[i];
      rn.id = n.id;
      rn.lane = n.lane;
      rn.time = n.time;
      const judged = this.engine.judge.getNoteState(n.id);
      if (judged === 'pending') {
        rn.state = 'pending';
        rn.judgment = undefined;
      } else if (judged === 'miss') {
        rn.state = 'miss';
        rn.judgment = 'miss';
      } else {
        rn.state = 'hit';
        rn.judgment = judged;
      }
      out.push(rn);
    }

    // Prune effects that have already played out (kept keyed on song time so a pause freezes them).
    let cut = 0;
    while (cut < this.recentHits.length && drawTime - this.recentHits[cut].time > RECENT_HIT_SEC) cut++;
    if (cut > 0) this.recentHits.splice(0, cut);

    const s = this.engine.getScoreState();
    const beat = beatAt(this.chart.bpm, this.chart.offset, drawTime);
    const f = this.frame;
    f.songTime = drawTime;
    f.notes = out;
    f.laneStates = this.input.getLaneStates();
    f.combo = s.combo;
    f.multiplier = s.multiplier;
    f.score = s.score;
    f.health = s.health;
    f.recentHits = this.recentHits;
    f.beatPhase = beat.phase;
    f.beatIndex = beat.beatIndex;
    // IS THE SESSION ACCEPTING INPUT? The frame keeps being drawn while it is not — a pause has to
    // leave the gems, the popups and the bursts frozen where they are, and this loop keeps running
    // so it can — and `input.getLaneStates()` above is LIVE either way, because the camera does not
    // stop for a therapist pause. But `onInput` drops an event outright while the run is idle or
    // ended, and `RhythmEngine.handleInputDetailed` drops one stamped inside a pause (not judged,
    // not scored, not recorded), so on those frames the receptor row's live gauge would be promising
    // a rep that cannot happen. The renderer is told, and blanks the row to "no reading". See
    // `RenderFrame.inputSuspended`.
    f.inputSuspended = this.phase === 'paused' || this.phase === 'idle' || this.phase === 'ended';
    this.highway.draw(f);
  }

  private emitHud(force: boolean): void {
    const cb = this.opts.onHud;
    if (!cb) return;
    const now = this.nowMs();
    if (!force && now - this.lastHudAt < this.hudIntervalMs) return;
    this.lastHudAt = now;
    cb(this.hud());
  }

  hud(): HudSnapshot {
    const s = this.engine.getScoreState();
    const songTime = this.engine.songTime();
    return {
      phase: this.phase,
      countdown: songTime < 0 ? Math.max(1, Math.ceil(-songTime)) : 0,
      songTime,
      durationSec: this.chart.durationSec,
      score: s.score,
      combo: s.combo,
      maxCombo: s.maxCombo,
      multiplier: s.multiplier,
      health: s.health,
      stars: s.stars,
      accuracy: s.accuracy,
      hits: s.hits,
      misses: s.misses,
      reps: s.reps,
      notesRemaining: s.totalNotes - s.judged,
      clockStalled: this.stalledFrames > 60,
      pausedByPage: this.isPausedByPage(),
    };
  }

  /**
   * Pause (Esc, the pause button, or the page going away). Audio and the song clock stop together,
   * so nothing drifts across the gap.
   *
   * A count-in is pausable too — only from the page path, which is the one case where the patient
   * genuinely cannot see the screen. The button stays disabled for it (the mixer transport is
   * already scheduled and there is nothing yet to lose).
   */
  pause(includeCountdown = false): void {
    if (this.phase !== 'playing' && !(includeCountdown && this.phase === 'countdown')) return;
    const at = this.mixer?.pause();
    this.engine.pause(at ?? undefined);
    this.phase = 'paused';
    this.emitHud(true);
  }

  /** Resume, keeping audio and the chart in sync (the mixer decides the restart time). */
  async resume(): Promise<void> {
    if (this.phase !== 'paused') return;
    this.pausedByPage = false;
    let at: number | null = null;
    if (this.mixer) at = await this.mixer.resume();
    if (this.disposed) return;
    this.engine.resume(at ?? undefined);
    this.phase = 'playing';
    this.emitHud(true);
  }

  /** Give up on the run (therapist quit). The results so far are still reported. */
  quit(): void {
    this.finish('quit');
  }

  /**
   * End the run and report it. EVERY exit path comes through here — the chart ending, the therapist
   * quitting, the play screen being left, the page being closed — because a RunSummary is the only
   * thing that reaches the patient's history, and reps that were actually performed must not
   * evaporate because of how the session ended.
   */
  private finish(reason: RunEndReason): void {
    if (this.ended || this.phase === 'idle') {
      if (this.phase === 'idle') this.phase = 'ended';
      return;
    }
    this.ended = true;
    const songTime = this.engine.songTime();
    const completed = reason === 'chart';
    this.phase = 'ended';
    this.endedAt = Date.now();
    if (this.cancelFrame) {
      this.cancelFrame();
      this.cancelFrame = null;
    }
    this.mixer?.stop();
    let suggested: number | null = null;
    try {
      suggested = this.engine.suggestedInputLatency()?.sec ?? null;
    } catch {
      suggested = null;
    }
    const summary: RunSummary = {
      results: this.engine.getScoreResults(),
      laneReps: this.laneReps,
      completed,
      endReason: reason,
      songTime,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      suggestedLatencySec: suggested,
    };
    this.emitHud(true);
    this.opts.onEnd?.(summary);
  }

  /** Canvas size changed (mount / window resize / rotation). */
  resize(width?: number, height?: number, dpr?: number): void {
    this.highway.resize(width, height, dpr);
  }

  /** Apply therapist display settings mid-song. */
  setHighwayOptions(patch: Partial<HighwayOptions>): void {
    this.highway.setOptions(patch);
  }

  /**
   * Tear the run down. A run that was started and never ended is FINISHED first, as 'abandoned': the
   * play screen unmounting (Back, a deep link, a remount, a fatal error) is the commonest way a
   * session is interrupted, and it used to be the way a patient's reps were silently thrown away —
   * `finish()` ran only from `quit()` or from the chart ending. `onEnd` therefore fires during
   * teardown; see Play.tsx, which records the result but does NOT navigate if the screen has already
   * moved on.
   */
  dispose(): void {
    if (this.disposed) return;
    this.finish('abandoned');
    this.disposed = true;
    if (this.cancelFrame) {
      this.cancelFrame();
      this.cancelFrame = null;
    }
    for (const u of this.unsubscribe) u();
    this.unsubscribe = [];
    this.mixer?.stop();
    if (this.opts.stopInputOnDispose) this.input.stop();
    this.phase = 'ended';
  }
}
