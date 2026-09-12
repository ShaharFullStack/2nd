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
import type { FinaleSpec } from '../render/Highway.ts';
import type { CanvasLike, HighwayOptions, RenderFrame, RenderNote } from '../render/types.ts';
import { clinicalLaneName, formatDuration } from './results.ts';
import type { SessionEndReason } from './types.ts';

/**
 * `'finale'` is the song-end sequence: the chart has run out, nothing more can be judged, and the
 * board is paying the session off (see `Highway.startFinale`) before the report screen. It is a
 * phase rather than a flag because everything that asks "is this run still going?" — the input
 * path, the pause button, the receptor row's honesty flag — has to answer the same way about it.
 */
export type RunnerPhase = 'idle' | 'countdown' | 'playing' | 'paused' | 'finale' | 'ended';

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

/** What `sessionAchievement` needs: the run's own totals, no history and no calibration. */
export interface AchievementInput {
  reps: number;
  hits: number;
  judged: number;
  maxCombo: number;
  /** Per lane: the clinical name and the best rep peak as a fraction of the calibrated range. */
  lanes: { name: string; bestPeak: number | null }[];
}

/** The peak that counts as "you reached the whole range you calibrated today". */
export const FULL_RANGE_FRACTION = 0.9;
/** A run of notes worth naming out loud. */
export const STREAK_WORTH_NAMING = 8;
/** Movements named one by one in the achievement's second line before it says "and N more". */
export const ACHIEVEMENT_MAX_NAMED = 2;

/**
 * The measured lanes, each with the peak it reached as a fraction of ITS OWN calibrated range, in
 * prescription order — and the clause that says what the percentages are of.
 *
 * THE CLAUSE IS NOT OPTIONAL AND IS NEVER SHORTENED. "95%" beside a limb name reads as 95 % of a
 * normal joint, which is a different and far larger claim than 95 % of the range this patient's
 * therapist calibrated for that movement this morning. `Highway` wraps this line rather than
 * ellipsising it (`wrapFinaleNote`) precisely so the clause survives at 1024x768, where the old
 * single fitted line rendered "— of the range calibrated fo…".
 */
function rangeNote(lanes: readonly { name: string; bestPeak: number | null }[]): string {
  const named = lanes
    .slice(0, ACHIEVEMENT_MAX_NAMED)
    .map((l) => `${l.name} ${Math.round((l.bestPeak as number) * 100)}%`)
    .join(' · ');
  const rest = lanes.length - Math.min(lanes.length, ACHIEVEMENT_MAX_NAMED);
  return `${named}${rest > 0 ? ` · and ${rest} more` : ''} — each of the range calibrated for THAT movement today.`;
}

/**
 * ONE TRUE, WARM SENTENCE ABOUT THIS SESSION — and its quieter second line.
 *
 * THE HARD CASE IS THE ONE THAT MATTERS. A patient four weeks post-stroke can finish a song having
 * answered six notes out of two hundred, and this sentence is the last thing the game says to them.
 * So nothing here is conditional on scoring well, nothing is a grade, and nothing is comparative:
 * the ladder is ordered by what is most SPECIFIC to today, and its bottom rung — movements
 * performed — is true of every session in which the patient moved at all, which is every session
 * this screen is shown after. The only case with nothing to celebrate is the one where nothing was
 * measured, and that is said plainly rather than dressed up.
 */
export function sessionAchievement(input: AchievementInput): { text: string; note?: string } {
  /**
   * NO LANE IS RANKED AGAINST ANOTHER, HERE OR ANYWHERE ELSE ON THIS SCREEN.
   *
   * This used to be `max(bestPeak)` over the lanes, which is the same mistake the Results headline
   * was corrected out of one screen later: a hemiparetic prescription deliberately mixes the
   * affected limb with an unaffected one, so the lane that gets furthest through its own calibrated
   * range is the strong side essentially every time — and the last thing the game said before the
   * report was the name of the limb the patient did not come about.
   *
   * A lane reaching the whole range calibrated for it is still worth saying, so it is said as a
   * COUNT of the movements that got there, with each figure printed beside the movement it belongs
   * to and in prescription order. A count is not a ranking and it cannot promote one limb over
   * another.
   */
  const measured = input.lanes.filter((l) => l.bestPeak !== null);
  const full = measured.filter((l) => (l.bestPeak as number) >= FULL_RANGE_FRACTION);
  if (full.length > 0) {
    /**
     * AND THE SECOND LINE LISTS EVERY MEASURED MOVEMENT, NOT ONLY THE ONES THAT GOT THERE.
     *
     * The count in the headline already stops one limb standing in for the session. The note did
     * not: it listed only the lanes at full range, so on the exact prescription this app is for —
     * the affected limb plus an unaffected one — a session where the STRONG side reached its whole
     * range printed "Right Knee extension 97%" and the reason the patient came ("Left Seated march",
     * at 31 %) appeared nowhere at all. This was the one rung where a limb IS named, and it was the
     * rung most likely to name the strong one.
     *
     * So the list is the same list the rung below prints: every movement that was measured, in
     * prescription order, with its own figure against its own calibrated range. Which ones reached
     * the whole of it is readable from the figures, and no limb is ranked against another.
     */
    return {
      text: measured.length > 1 ? `Full range reached — ${full.length} of ${measured.length} movements` : 'Full range reached',
      note: rangeNote(measured),
    };
  }
  /**
   * THE RIBBON MAY NOT BE THE HERO FIGURE AGAIN.
   *
   * This rung used to read `${input.reps} movements performed`, and the card draws `stats[0]` —
   * the same count — directly above it in a font more than twice the size. Observed at 1024x768 on
   * a deliberately bad run: "4 MOVEMENTS" as the hero, and the gold ribbon positioned and styled as
   * the point of the screen restating "4 movements performed" two lines below it. For the patient
   * this ladder was written for — the one who answered six notes out of two hundred — the session's
   * own achievement was a number they had just read, in a smaller font.
   *
   * The sentence that was doing the work was the quiet second line, so it IS the sentence now, and
   * the second line carries what the card does not say anywhere else: the range each prescribed
   * movement actually reached today, in prescription order, with the clause that says what those
   * percentages are OF. No lane is ranked against another here either — the list is every measured
   * movement in the order it was prescribed, not the best of them.
   */
  if (input.reps > 0) {
    const note =
      measured.length > 0
        ? `Landed on a note or not. ${rangeNote(measured)}`
        : input.maxCombo >= STREAK_WORTH_NAMING
          ? `${input.maxCombo} notes answered in a row at your best — and every rep counted, on a note or not.`
          : 'Landed on a note or not: the movement is the work.';
    return { text: 'Every movement counted', note };
  }
  if (input.judged > 0) {
    return {
      text: 'Session recorded',
      note: 'No movement was measured this time — worth checking the camera and the ranges.',
    };
  }
  return { text: 'Session recorded', note: undefined };
}

/** Seconds of judged notes kept in `recentHits` so the renderer can spawn their effects. */
const RECENT_HIT_SEC = 1.2;
/** Never play more than one miss cue in this window, however many notes expire at once. */
const MISS_CUE_COOLDOWN_SEC = 0.15;
const DEFAULT_COUNTDOWN_SEC = 3;
/**
 * Song seconds between the LAST NOTE'S WINDOW CLOSING and the song-end sequence starting.
 *
 * This used to be a flat 1.5 s of silence, and it is the gap the patient described: "the chart ends,
 * there is 1.5 s of empty highway, and I am cut straight to a grid". A shipped rhythm game starts
 * its payoff within about a note of the chart running out, and there was never anything happening in
 * that second and a half — the last gem has been judged, nothing more can be, and the board is empty.
 *
 * What the tail actually has to cover is two things, so it is derived from them rather than guessed:
 * the last note cannot be judged after its own GOOD window has closed (`outroSecFor`), and its hit
 * or miss effect needs a few frames on screen before the curtain comes down. That comes out around
 * 0.65 s on the default windows — roughly one note at 120 bpm — instead of 1.5 s of nothing.
 */
const OUTRO_TAIL_SEC = 0.5;

/**
 * The song seconds after the last note before the ending may start: the widest GOOD window in force
 * (no note can be judged later than that) plus `OUTRO_TAIL_SEC` for the last gem's own effect.
 */
export function outroSecFor(windows: TimingWindows | TimingWindows[]): number {
  const all = Array.isArray(windows) ? windows : [windows];
  let widestMs = 0;
  for (const w of all) widestMs = Math.max(widestMs, w.goodMs);
  return widestMs / 1000 + OUTRO_TAIL_SEC;
}

/**
 * A TAP THAT ALREADY MEANS SOMETHING IS NOT A TAP THAT MEANS "SKIP".
 *
 * The song-end sequence is skipped by anything at all — a tap anywhere, any key — because the
 * patient's hands may be the thing being measured and there is no controller to press. The listener
 * is on `window`, so it also caught the chrome drawn over the canvas: tapping PAUSE during the
 * ending landed on the report in 77 ms (verified live at t≈3 s; the record itself was correct).
 * Harmless to the data and wrong for the person holding the tablet — a control that does something
 * other than what it says. A tap that lands on a real control is left to that control.
 */
function isOwnControl(target: EventTarget | null): boolean {
  const el = target as { closest?: (sel: string) => unknown } | null;
  if (!el || typeof el.closest !== 'function') return false;
  return el.closest('button, a, input, select, textarea, summary, [role="button"]') !== null;
}

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
  /**
   * Song time at the moment the CHART ran out, captured before the song-end sequence starts.
   *
   * The sequence keeps the loop (and the audio clock) running for several more seconds, and
   * `RunSummary.songTime` becomes the stored session duration. Without this, every completed
   * session would be filed six seconds longer than it was, and the reps-per-minute a therapist
   * reads off it would be wrong by that much.
   */
  private chartEndSongTime: number | null = null;
  /** Song seconds after the last note before the ending starts (see `outroSecFor`). */
  private readonly outroSec: number;
  /** Listener teardown for the "anything at all skips the ending" handlers. */
  private finaleSkipOff: Array<() => void> = [];
  /** Wall ms at the previous finale frame, so the sequence advances on real elapsed time. */
  private finaleLastWallMs: number | null = null;
  /**
   * The counts the card on screen was last built from, so the ending is re-rendered when — and only
   * when — the patient has actually done something since. See `refreshFinale`.
   */
  private finaleStamp = '';
  /** Rep events seen from the input source, for `finaleStamp` (the camera's stream, not the engine's). */
  private repEvents = 0;
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
    this.outroSec = outroSecFor(options.windows);

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
    if (this.mixer) this.unsubscribe.push(this.mixer.onEnded(() => this.endOfChart()));

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

  /**
   * THE ENDING MAY NOT COST THE PATIENT A REP.
   *
   * This used to return early on `finale`, and `onRep` — the camera's rep stream, which feeds
   * `laneReps` and through it every per-movement figure on the report — had no such guard. On a
   * camera session the patient is mid-march when the music stops, so the two counters diverged for
   * the whole 6.6 s payoff: the per-movement column kept climbing while "Movements performed" was
   * frozen, and the report printed a headline its own table contradicted. Worse, a movement that
   * matched no note is a rep by the project's oldest rule, and this line was throwing those away
   * because of how the song ended.
   *
   * So the input path runs to `finish()`, exactly as `engine.tick()` and `onRep` already did. What
   * it does NOT do during the ending is celebrate: the mixer has stopped, the card is up, and a
   * combo cue over the payoff belongs to a song that is over. Nothing can be judged either — the
   * chart does not end until the widest GOOD window of the last note has closed (`outroSecFor`) —
   * so the only thing reaching scoring here is the rep itself.
   */
  private onInput(e: LaneInputEvent): void {
    if (this.phase === 'ended' || this.phase === 'idle') return;
    const hit = this.engine.handleInput(e);
    if (!hit || this.phase === 'finale') return;
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

  /**
   * THE TWO STREAMS ACCEPT AND REJECT THE SAME MOVEMENTS.
   *
   * `onInput` is judged by the engine, which drops an event whose stamp falls inside a pause: the
   * receptor row has been blanked to "no reading" and the screen has told the patient nothing is
   * being measured, so a movement made then is not part of the session. This stream had no such
   * rule at all, so a rep performed over a therapist pause landed in the per-movement table, the
   * ROM peaks and the compensation counters of a session whose duration does not contain it.
   *
   * The test is the engine's own — `songTimeOf` returns null for exactly the stamps the engine
   * refuses (idle, or inside a pause) — so the two can no longer disagree about one movement. A rep
   * whose CROSSING happened before the pause and which finished after it still counts: it is the
   * same stamp the input event carried, and the patient really performed it.
   */
  private onRep(e: LaneRepEvent): void {
    const stats = this.laneReps[e.lane];
    if (!stats) return;
    if (this.engine.clock.songTimeOf(e.ctxTime) === null) return;
    this.repEvents++;
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

    if (this.phase === 'playing' && songTime >= this.endSongTime()) this.endOfChart();
    else if (this.phase === 'finale') {
      // WALL TIME, NOT SONG TIME. The mixer has stopped by now, so the audio clock is no longer the
      // thing the patient is watching; `nowMs` is the runner's own injectable wall clock, which is
      // also what lets a test (and the critic harness) step the whole sequence deterministically.
      const wall = this.nowMs();
      const dt = this.finaleLastWallMs === null ? 0 : Math.max(0, wall - this.finaleLastWallMs) / 1000;
      this.finaleLastWallMs = wall;
      this.refreshFinale();
      this.highway.advanceFinale(dt);
      if (this.highway.finaleDone()) this.finish('chart');
    }
  }

  /**
   * The song time at which the chart is over and the ending may start.
   *
   * THE SONG'S LENGTH IS A CAP, BUT IT IS NOT ALLOWED TO CUT THE LAST NOTE'S WINDOW.
   *
   * This was `Math.min(durationSec, …)` with nothing under it, which silently broke the contract
   * `outroSecFor` states two hundred lines up: the last note cannot be judged after its own GOOD
   * window has closed. Measured in the app with a fine-motor prescription at the widest therapist
   * window (`?difficulty=easy&scale=4`, two finger_opposition lanes): goodMs 1152, last note at
   * 96.000 s, the window closing at 97.152 s, and this returning 97.000 — the curtain 152 ms before
   * the patient's last rep could no longer be scored. The chart generator only guarantees a 1 s tail
   * (charts/generate.ts), and 180 ms x 1.6 fine-motor x 4 is 1.152 s. The hit was still SCORED
   * (`onInput` judges before the finale guard), so no figure lied — but the most impaired
   * configuration, which is the one this widening exists for, lost the gem, the hit sound and the
   * combo cue on its final rep, under the curtain.
   *
   * So the cap applies to the part of the tail that is presentation (the gem's own effect,
   * `OUTRO_TAIL_SEC`) and never to the part that is judgment.
   */
  chartEndsAt(): number {
    const notes = this.chart.notes;
    const lastNote = notes.length > 0 ? notes[notes.length - 1].time : 0;
    const wanted = Math.max(lastNote + this.outroSec, this.outroSec);
    /** The instant after which nothing can be judged: the widest GOOD window of the last note. */
    const lastJudgeableAt = lastNote + Math.max(0, this.outroSec - OUTRO_TAIL_SEC);
    return Math.max(lastJudgeableAt, Math.min(this.chart.durationSec, wanted));
  }

  private endSongTime(): number {
    return this.chartEndsAt();
  }

  /**
   * THE CHART HAS RUN OUT — AND THAT IS NOT THE SAME EVENT AS "SHOW THE REPORT".
   *
   * It used to be. The song's last note landed, 1.5 s of empty highway went by, and the screen cut
   * to a results grid: a score odometer that had been climbing for 97 seconds simply stopped
   * existing, mid-climb. Every shipped rhythm game pays the player off at the end of a song, and
   * this one has more reason to than most — the run IS the rehab session. So the chart ending now
   * starts the ending (`Highway.startFinale`), the loop keeps drawing it, and `step()` hands over to
   * the report when it is done or when anybody skips it.
   *
   * Reached from both chart-end paths (the clock passing `endSongTime`, and the mixer reporting the
   * song over), whichever fires first; the second is a no-op.
   */
  private endOfChart(): void {
    if (this.ended || this.phase === 'finale' || this.phase === 'ended' || this.phase === 'idle') return;
    this.chartEndSongTime = this.engine.songTime();
    this.phase = 'finale';
    this.finaleLastWallMs = null;
    this.finaleStamp = this.countStamp();
    this.highway.startFinale(this.finaleSpec());
    this.watchFinaleSkip();
    this.emitHud(true);
  }

  /**
   * MOVEMENTS PERFORMED, COUNTED EXACTLY AS THE REPORT COUNTS THEM.
   *
   * The card used to print `ScoreResults.reps` — the ENGINE's count, one per input event it was
   * handed. `buildSessionResult` (session/results.ts) prints the sum over lanes of
   * `max(engine lane reps, the reps the camera actually observed)`, and the two differ BY
   * CONSTRUCTION whenever the camera reported a rep that produced no input event: a crossing
   * swallowed by `VisionInput`'s 300 ms re-trigger guard reports the rep and emits nothing to
   * score (src/input/VisionInput.ts, `emitted: false`), and `onRep` counts every one of them.
   * That is the ordinary case for spasticity, clonus and tremor — this app's core population — so
   * the payoff said "96 MOVEMENTS" and the report two seconds later said 131, under labels that
   * mean the same thing. The comment at results.ts:139 says the headline must be the sum of the
   * column under it; this is that same sum, computed from the same two sources.
   */
  private repsPerformed(r: ScoreResults): number {
    let n = 0;
    for (let i = 0; i < this.lanes.length; i++) {
      n += Math.max(r.lanes[i]?.reps ?? 0, this.laneReps[i]?.reps ?? 0);
    }
    return n;
  }

  /** Everything the ending says, built from this run alone. See `Highway.FinaleSpec`. */
  private finaleSpec(): FinaleSpec {
    const r = this.engine.getScoreResults();
    const judged = r.hits + r.misses;
    const reps = this.repsPerformed(r);
    const achievement = sessionAchievement({
      reps,
      hits: r.hits,
      judged,
      maxCombo: r.maxCombo,
      lanes: this.lanes.map((spec, i) => {
        const peaks = this.laneReps[i]?.peaks ?? [];
        return { name: clinicalLaneName(spec), bestPeak: peaks.length > 0 ? Math.max(...peaks) : null };
      }),
    });
    return {
      title: 'SONG COMPLETE',
      subtitle: this.opts.songTitle,
      score: r.score,
      // THE WORK FIRST, exactly as the report does it: movements performed leads, and the score
      // above is the animation the patient was owed the end of, not the verdict on the session.
      stats: [
        // Short enough to fit a quarter of the card at 1024x768 — a label the layout has to clip
        // ("MOVEMENTS PERFOR…") is not a label.
        { value: String(reps), label: 'MOVEMENTS' },
        /**
         * NOTES ANSWERED IS ONE QUANTITY IN THIS CODEBASE, AND THIS IS IT.
         *
         * It was `hits/judged`, which is a DIFFERENT number wearing the same label. "Notes
         * answered" is defined in engine/scoring.ts (`answerRateOf`) as every hit PLUS every
         * missed note that had a movement land nearest to it — `ScoreResults.attempted` — and the
         * Results screen prints exactly that ("a movement was made for 94 of the 95 notes
         * offered"), the stored record stores exactly that (`SessionResult.answerRate`), and the
         * gauge on this very canvas, captioned ANSWERED, shows exactly that. Measured on one run:
         * this card read "50/95 NOTES ANSWERED" and the report read 94/95 two seconds later.
         *
         * The gap is not cosmetic and it is not random. `attempted - hits` is precisely the set of
         * reps a patient performed and did not score — the patient whose latency offset is 200 ms
         * out, which is the case `answerRateOf` was written for ("they DID the rep"). Printing
         * hits under this label took that population's session away from them in the last sentence
         * the game says to them.
         */
        { value: `${r.attempted}/${judged}`, label: 'NOTES ANSWERED' },
        { value: String(r.maxCombo), label: 'LONGEST RUN' },
        // The SONG's length, and `formatDuration` is what the report formats it with. It was
        // labelled TIME MOVING — which this is not: the reps made over the celebration are counted
        // into the session and are not in it — and rounded where the report floors, so a 4.7 s
        // chart ended "0:05" here and "the song ran 0:04" on the next screen.
        { value: formatDuration(this.chartEndSongTime ?? this.engine.songTime()), label: 'SONG LENGTH' },
      ],
      achievement: achievement.text,
      ...(achievement.note === undefined ? {} : { achievementNote: achievement.note }),
      // AND THE PATIENT IS TOLD THE SONG IS OVER. A camera session has nothing that says "stop"
      // except the music stopping, and the reps made over the payoff are counted into this session
      // (`onInput`) — so the line that says the ending can be skipped also says they can ease off.
      // AND THE COUNT IS STILL RUNNING, SAID UNDER THE COUNT. The receptors behind this card stay
      // live because they are still measuring (see `draw`), and the hero figure keeps climbing; the
      // one thing that HAS stopped is scoring, because the chart has no notes left.
      heroNote: 'still counting \u2014 no notes left to hit',
      hint: 'Ease off when you\u2019re ready \u2014 movements still count \u00b7 tap or press any key for the report',
    };
  }

  /** Everything the card's figures are derived from, as a cheap equality key. */
  private countStamp(): string {
    const s = this.engine.getScoreState();
    return `${s.reps}|${s.hits}|${s.misses}|${s.maxCombo}|${s.score}|${this.repEvents}`;
  }

  /**
   * KEEP THE CARD TRUE WHILE IT IS ON SCREEN.
   *
   * The ending now counts the movements made during it (see `onInput`), so a card built once at the
   * chart's end would have gone stale the first time the patient marched through the confetti — the
   * payoff would say 126 movements and the report seven seconds later would say 131. Instead the
   * spec is rebuilt whenever a count changes and handed back to the renderer, which keeps its own
   * clock: the odometer the patient has been watching all song simply carries on counting them.
   * Nothing else about the sequence moves.
   */
  private refreshFinale(): void {
    const stamp = this.countStamp();
    if (stamp === this.finaleStamp) return;
    this.finaleStamp = stamp;
    this.highway.updateFinale(this.finaleSpec());
  }

  /**
   * ANYTHING AT ALL SKIPS IT — a tap anywhere, any key.
   *
   * There is no controller in this app and the patient's hands may be the thing being measured, so
   * a "press A to continue" prompt has nobody to press it. The therapist standing beside the tablet
   * taps the screen. `Highway.finaleSkippable` holds the first half second so the last note landing
   * is not eaten by a palm still resting on the glass.
   */
  private watchFinaleSkip(): void {
    if (typeof window === 'undefined' || this.finaleSkipOff.length > 0) return;
    const skip = (e: Event) => {
      if (isOwnControl(e.target)) return;
      this.skipFinale();
    };
    for (const type of ['keydown', 'pointerdown', 'touchstart'] as const) {
      window.addEventListener(type, skip, { passive: true });
      this.finaleSkipOff.push(() => window.removeEventListener(type, skip));
    }
  }

  private stopWatchingFinaleSkip(): void {
    for (const off of this.finaleSkipOff) off();
    this.finaleSkipOff = [];
  }

  /**
   * Cut the song-end sequence short and go to the report. Returns false while the skip guard is
   * still up (see `Highway.finaleSkippable`) or when no sequence is playing.
   */
  skipFinale(): boolean {
    if (this.phase !== 'finale') return false;
    if (!this.highway.skipFinale()) return false;
    this.finish('chart');
    return true;
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
    //
    // 'finale' USED TO BE IN THIS LIST, AND IT WAS THE ONE ENTRY THAT WAS NOT TRUE.
    //
    // The song-end sequence counts: `onInput` returns early only AFTER the engine has judged, `onRep`
    // records every rep the input source reports, and the card's own MOVEMENTS figure is rebuilt and
    // visibly ticks up as the patient keeps going (`refreshFinale`). So for 6.6 seconds the board
    // told the patient "nothing you do registers" — four broken rings with pause bars — while the
    // number in the middle of the screen counted exactly what they were doing, and the report
    // afterwards kept it. A pause is a state in which a movement is discarded; the ending is not one,
    // and the two must not wear the same mark. What is true of the ending — no notes are left to
    // score, the movements still count — is said in words on the card (`FinaleSpec.heroNote`).
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
    this.stopWatchingFinaleSkip();
    /**
     * ONCE THE CHART HAS RUN OUT, THE RUN IS COMPLETE — whatever happens during the ending.
     *
     * The song-end sequence holds the runner open for a few more seconds, and anything that ends a
     * run arrives here: "End & see results" tapped over the payoff, the screen being left, the tab
     * closing. None of those un-finish a song that finished. Before the sequence existed this was
     * not expressible, because the chart ending WAS the end of the run; now it has to be said, or a
     * completed session filed itself as 'interrupted' for the crime of being walked away from
     * during its own celebration. The stored duration is the chart's end, not the celebration's.
     */
    if (this.chartEndSongTime !== null) reason = 'chart';
    const songTime = this.chartEndSongTime ?? this.engine.songTime();
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
    this.stopWatchingFinaleSkip();
    this.mixer?.stop();
    if (this.opts.stopInputOnDispose) this.input.stop();
    this.phase = 'ended';
  }
}
