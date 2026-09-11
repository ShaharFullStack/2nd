import { beforeEach, describe, expect, it } from 'vitest';
import { windowsForLanes } from '../engine/difficulty.ts';
import { DIFFICULTIES } from '../engine/difficulty.ts';
import type { Chart, LaneSpec } from '../engine/types.ts';
import { ReplayInput } from '../input/ReplayInput.ts';
import type { ReplayEvent } from '../input/ReplayInput.ts';
import type { InputSource, LaneInputEvent, LaneRepEvent, LaneState } from '../input/types.ts';
import { createMockCanvas, mockCanvasFactory } from '../render/canvasMock.ts';
import type { StemMixer } from '../audio/StemMixer.ts';
import { FINALE_SEC, FINALE_SKIP_GUARD_SEC } from '../render/Highway.ts';
import type { FinaleSpec } from '../render/Highway.ts';
import { GameRunner, sessionAchievement } from './GameRunner.ts';
import { buildSessionResult, formatDuration } from './results.ts';
import type { SessionConfig } from './types.ts';
import type { PageLifecycle, RunSummary } from './GameRunner.ts';

const LANES: LaneSpec[] = [
  { index: 0, movement: 'seated_march', side: 'left' },
  { index: 1, movement: 'seated_march', side: 'right' },
];

/** The same prescription as a `SessionConfig`, so a test can build the REPORT the card hands over to. */
const REPORT_CONFIG: SessionConfig = {
  patientId: 'p-test',
  mode: 'leg',
  lanes: LANES,
  difficulty: 'easy',
  windowScale: 1,
  songId: 'test',
  seed: 1,
};

/** A hand clock: the runner reads `currentTime` exactly like it reads an AudioContext. */
class FakeClock {
  currentTime = 0;
}

function chartOf(times: number[]): Chart {
  return {
    songId: 'test',
    lanes: 2,
    notes: times.map((t, i) => ({ id: i + 1, lane: i % 2, time: t })),
    bpm: 120,
    offset: 0,
    difficulty: DIFFICULTIES.easy,
    durationSec: 12,
  };
}

/**
 * The page, as the runner sees it (`PageLifecycle`): a tab that can be hidden and a page that can go
 * away. Hand-driven, because "the therapist looked away" and "the tablet slept" are the two events
 * this suite exists to fire.
 */
class FakePage implements PageLifecycle {
  hidden = false;
  private visibility = new Set<() => void>();
  private gone = new Set<() => void>();
  isHidden(): boolean { return this.hidden; }
  onVisibilityChange(cb: () => void): () => void {
    this.visibility.add(cb);
    return () => this.visibility.delete(cb);
  }
  onPageGone(cb: () => void): () => void {
    this.gone.add(cb);
    return () => this.gone.delete(cb);
  }
  /** The tab is backgrounded / the tablet is locked. */
  hide(): void {
    this.hidden = true;
    for (const cb of [...this.visibility]) cb();
  }
  show(): void {
    this.hidden = false;
    for (const cb of [...this.visibility]) cb();
  }
  /** `pagehide`: the tab is closed, or the page is discarded. */
  unload(): void {
    for (const cb of [...this.gone]) cb();
  }
  get listenerCount(): number { return this.visibility.size + this.gone.size; }
}

interface Harness {
  runner: GameRunner;
  clock: FakeClock;
  input: ReplayInput;
  summaries: RunSummary[];
  page: FakePage;
  advance: (to: number) => void;
}

async function setup(noteTimes: number[], events: ReplayEvent[], countdownSec = 0): Promise<Harness> {
  const clock = new FakeClock();
  const chart = chartOf(noteTimes);
  const summaries: RunSummary[] = [];
  const page = new FakePage();
  let input!: ReplayInput;
  const runner = new GameRunner({
    canvas: createMockCanvas(1280, 720),
    chart,
    lanes: LANES,
    windows: windowsForLanes(LANES, 'easy'),
    clock,
    input: (songClock) => {
      input = new ReplayInput({ events, audioContext: clock, songClock, lanes: 2, autoTick: false });
      return input;
    },
    thresholdFraction: 0.5,
    countdownSec,
    missGraceMs: 0,
    highwayOptions: { createCanvas: mockCanvasFactory() },
    // No self-scheduling: the test drives every frame.
    schedule: () => () => undefined,
    nowMs: () => clock.currentTime * 1000,
    lifecycle: page,
    onEnd: (s) => summaries.push(s),
  });
  await runner.start();
  const advance = (to: number): void => {
    for (let t = clock.currentTime; t <= to + 1e-9; t += 1 / 60) {
      clock.currentTime = Math.round(t * 1e6) / 1e6;
      input.tick();
      runner.step();
    }
  };
  return { runner, clock, input, summaries, page, advance };
}

describe('GameRunner', () => {
  let h: Harness;

  beforeEach(async () => {
    const notes = [1, 1.5, 2, 2.5];
    h = await setup(
      notes,
      notes.map((t, i) => ({ lane: i % 2, songTime: t, strength: 1 })),
    );
  });

  it('starts playing immediately with no count-in and scores the scripted hits', () => {
    expect(h.runner.getPhase()).toBe('playing');
    h.advance(2.6);
    const hud = h.runner.hud();
    expect(hud.hits).toBe(4);
    expect(hud.misses).toBe(0);
    expect(hud.score).toBeGreaterThan(0);
    expect(hud.reps).toBe(4);
    expect(hud.maxCombo).toBe(4);
  });

  it('counts a movement that matched no note as a rep, never as a penalty', async () => {
    const notes = [2];
    const late = await setup(notes, [{ lane: 0, songTime: 2.9, strength: 1 }]);
    late.advance(3.2);
    const hud = late.runner.hud();
    expect(hud.hits).toBe(0);
    // The patient moved: the rep is recorded even though nothing scored.
    expect(hud.reps).toBe(1);
    expect(hud.score).toBe(0);
  });

  it('freezes song time while paused and picks it up again on resume', async () => {
    h.advance(0.5);
    h.runner.pause();
    const frozen = h.runner.songTime();
    h.clock.currentTime += 5;
    h.runner.step();
    expect(h.runner.songTime()).toBeCloseTo(frozen, 6);
    await h.runner.resume();
    h.clock.currentTime += 0.25;
    expect(h.runner.songTime()).toBeCloseTo(frozen + 0.25, 3);
  });

  it('runs a count-in before song time zero', async () => {
    const notes = [1];
    const c = await setup(notes, [{ lane: 0, songTime: 1, strength: 1 }], 3);
    expect(c.runner.getPhase()).toBe('countdown');
    expect(c.runner.hud().countdown).toBe(3);
    c.clock.currentTime = 1.2;
    c.runner.step();
    expect(c.runner.hud().countdown).toBe(2);
    expect(c.runner.getPhase()).toBe('countdown');
    c.advance(4.2);
    expect(c.runner.getPhase()).toBe('playing');
    expect(c.runner.hud().hits).toBe(1);
  });

  it('ends after the last note and reports a summary the results screen can use', () => {
    // 4.0 s ends the chart; the song-end sequence then runs for FINALE_SEC before the report.
    h.advance(6);
    expect(h.runner.getPhase()).toBe('finale');
    expect(h.summaries).toHaveLength(0);
    h.advance(6 + FINALE_SEC + 0.2);
    expect(h.runner.getPhase()).toBe('ended');
    expect(h.summaries).toHaveLength(1);
    const s = h.summaries[0];
    expect(s.completed).toBe(true);
    expect(s.results.hits).toBe(4);
    expect(s.results.lanes).toHaveLength(2);
    expect(s.laneReps).toHaveLength(2);
    // An input source with no rep events reports no ROM samples rather than inventing them.
    expect(s.laneReps[0].peaks).toEqual([]);
  });

  it('quit() reports the run so far and marks it incomplete', () => {
    h.advance(1.6);
    h.runner.quit();
    expect(h.summaries).toHaveLength(1);
    expect(h.summaries[0].completed).toBe(false);
    expect(h.summaries[0].results.hits).toBeGreaterThan(0);
  });

  it('flags a stalled audio clock instead of silently freezing the game', () => {
    for (let i = 0; i < 70; i++) h.runner.step();
    expect(h.runner.hud().clockStalled).toBe(true);
  });

  it('dispose() stops the loop and is idempotent', () => {
    h.runner.dispose();
    h.runner.dispose();
    expect(h.runner.getPhase()).toBe('ended');
  });
});

describe('a paused run tells the renderer it is not accepting input', () => {
  it('flips every receptor to "no reading" for the pause, and back on resume', async () => {
    // THE ROUND-7 BLOCKER'S ROOT. `draw()` runs every animation frame whatever the phase, and
    // `input.getLaneStates()` is live through a pause because the camera is — but `onInput` drops an
    // event outright while the run is idle or ended, and `RhythmEngine` drops one stamped inside a
    // pause (not judged, not scored, not recorded). The phase is the only thing that knows, so the
    // phase is what the frame carries. See `RenderFrame.inputSuspended` and src/render/receptor.ts.
    const h = await setup([1, 1.5, 2, 2.5], []);
    h.advance(0.5);
    const live = h.runner.highway.receptorLookOf(0);
    expect(live?.tracking).toBe(true);
    expect(live?.suspended).toBe(false);

    h.runner.pause();
    h.runner.step();
    for (const l of LANES) {
      const look = h.runner.highway.receptorLookOf(l.index);
      expect(look?.suspended, `lane ${l.index}`).toBe(true);
      expect(look?.tracking, `lane ${l.index}`).toBe(false);
      expect(look?.goal ?? 0, `lane ${l.index}`).toBe(0);
    }
    // The gauge comes straight back — the stop blanks the display, it does not reset the session.
    await h.runner.resume();
    h.runner.step();
    expect(h.runner.highway.receptorLookOf(0)?.suspended).toBe(false);
    expect(h.runner.highway.receptorLookOf(0)?.tracking).toBe(true);
  });
});

/**
 * THE INTERRUPTED SESSION, WHICH USED TO RECORD NOTHING.
 *
 * `finish()` — the only path that builds a RunSummary and so the only path that can reach
 * `store.addResult` — ran from exactly two places: `quit()` and the chart ending. A patient who
 * stopped early, a therapist who pressed Back, a tab that was closed, a tablet that slept: the reps
 * already performed left no record at all. And nothing paused when the tab went away, so a
 * backgrounded page kept the audio clock running while animation frames stopped, and the session
 * came back as a wall of misses the patient never had a chance at.
 */
describe('every way a run can end still records the reps that were performed', () => {
  const notes = [1, 1.5, 2, 2.5];
  const hitAll: ReplayEvent[] = notes.map((t, i) => ({ lane: i % 2, songTime: t, strength: 1 }));

  it('the chart ending is the ONLY complete run', async () => {
    const h = await setup(notes, hitAll);
    h.advance(6 + FINALE_SEC + 0.2);
    expect(h.summaries[0].endReason).toBe('chart');
    expect(h.summaries[0].completed).toBe(true);
  });

  it('a therapist quit is recorded and marked incomplete', async () => {
    const h = await setup(notes, hitAll);
    h.advance(1.6);
    h.runner.quit();
    expect(h.summaries[0].endReason).toBe('quit');
    expect(h.summaries[0].completed).toBe(false);
  });

  it('leaving the play screen mid-song records the run rather than dropping it', async () => {
    const h = await setup(notes, hitAll);
    h.advance(1.6);
    const hitsSoFar = h.runner.hud().hits;
    expect(hitsSoFar).toBeGreaterThan(0);

    h.runner.dispose(); // exactly what the Play screen's effect cleanup does

    expect(h.summaries).toHaveLength(1);
    expect(h.summaries[0].endReason).toBe('abandoned');
    expect(h.summaries[0].completed).toBe(false);
    expect(h.summaries[0].results.hits).toBe(hitsSoFar);
    expect(h.summaries[0].songTime).toBeGreaterThan(1.5);
    // The endedAt stamp is real, so the record has a duration a therapist can read.
    expect(h.summaries[0].endedAt).toBeGreaterThanOrEqual(h.summaries[0].startedAt);
  });

  it('reports the run exactly once, however many ways out fire', async () => {
    const h = await setup(notes, hitAll);
    h.advance(1.6);
    h.runner.quit();
    h.page.unload();
    h.runner.dispose();
    h.runner.dispose();
    expect(h.summaries).toHaveLength(1);
    expect(h.summaries[0].endReason).toBe('quit'); // the first real ending wins
  });

  it('the page going away writes the record while there is still a page to write it', async () => {
    const h = await setup(notes, hitAll);
    h.advance(1.6);
    h.page.unload(); // pagehide: a closed tab, a navigation away, a discarded page
    expect(h.summaries).toHaveLength(1);
    expect(h.summaries[0].endReason).toBe('abandoned');
    expect(h.summaries[0].results.hits).toBeGreaterThan(0);
  });

  it('a run that was never started records nothing at all', async () => {
    // Not a session: a screen that was opened and left. There is nothing to file.
    const clock = new FakeClock();
    const summaries: RunSummary[] = [];
    const runner = new GameRunner({
      canvas: createMockCanvas(1280, 720),
      chart: chartOf([1]),
      lanes: LANES,
      windows: windowsForLanes(LANES, 'easy'),
      clock,
      input: (songClock) => new ReplayInput({ events: [], audioContext: clock, songClock, lanes: 2, autoTick: false }),
      thresholdFraction: 0.5,
      highwayOptions: { createCanvas: mockCanvasFactory() },
      schedule: () => () => undefined,
      lifecycle: null,
      onEnd: (s) => summaries.push(s),
    });
    runner.dispose();
    expect(summaries).toHaveLength(0);
    expect(runner.getPhase()).toBe('ended');
  });
});

describe('the session pauses itself when the therapist looks away', () => {
  const notes = [1, 1.5, 2, 2.5];

  it('a hidden tab pauses audio and the chart clock together, and does not resume itself', async () => {
    const h = await setup(notes, []);
    h.advance(0.5);
    const songTimeAtHide = h.runner.songTime();

    h.page.hide();
    expect(h.runner.getPhase()).toBe('paused');
    expect(h.runner.isPausedByPage()).toBe(true);
    expect(h.runner.hud().pausedByPage).toBe(true);

    // The clock runs on while the page is away — a real AudioContext does — and the song time does
    // NOT, which is the whole point: the notes that went by are not judged against an empty room.
    h.clock.currentTime += 30;
    h.runner.step();
    expect(h.runner.songTime()).toBeCloseTo(songTimeAtHide, 2);
    expect(h.runner.hud().misses).toBe(0);

    // Coming back is a human's decision: the patient has to be ready before the song moves again.
    h.page.show();
    expect(h.runner.getPhase()).toBe('paused');

    await h.runner.resume();
    expect(h.runner.getPhase()).toBe('playing');
    expect(h.runner.isPausedByPage()).toBe(false);
    expect(h.runner.hud().pausedByPage).toBe(false);
  });

  it('pauses the count-in too, so a hidden tab never starts a song nobody can see', async () => {
    const h = await setup(notes, [], 3);
    expect(h.runner.getPhase()).toBe('countdown');
    h.page.hide();
    expect(h.runner.getPhase()).toBe('paused');
  });

  it('leaves a therapist pause alone (it is already stopped, and it was not the page that stopped it)', async () => {
    const h = await setup(notes, []);
    h.advance(0.5);
    h.runner.pause();
    expect(h.runner.isPausedByPage()).toBe(false);
    h.page.hide();
    expect(h.runner.getPhase()).toBe('paused');
    expect(h.runner.isPausedByPage()).toBe(false); // still the therapist's pause, not the page's
  });

  it('stops listening to the page once the run is disposed', async () => {
    const h = await setup(notes, []);
    expect(h.page.listenerCount).toBeGreaterThan(0);
    h.runner.dispose();
    expect(h.page.listenerCount).toBe(0);
  });
});


/**
 * THE MIXER, AS THE RUNNER TALKS TO IT.
 *
 * Records which ducking calls the runner makes. It exists because the per-lane ducking fix — one
 * limb's misses dimming only that limb's instrument — is connected to the game in exactly three
 * lines of GameRunner (`setLaneCount`, `onLaneHit(hit.lane, …)`, `onLaneMiss(m.lane)`) and had no
 * unit test at all: a regression to the lane-agnostic `onHit()`/`onMiss()` would restore the bug the
 * whole feature exists to fix (one missed left-leg note silencing the reward the right leg is
 * earning) and every test in the suite would still pass.
 */
class FakeMixer {
  laneCount = -1;
  laneHits: number[] = [];
  laneMisses: number[] = [];
  /** The lane-agnostic calls. These must stay empty: they duck the whole band on any lane's miss. */
  bandHits = 0;
  bandMisses = 0;
  played = false;
  get isLoaded(): boolean { return true; }
  get outputLatencySec(): number { return 0; }
  setLaneCount(lanes: number): void { this.laneCount = lanes; }
  play(): void { this.played = true; }
  getSongStartCtxTime(): number { return 0; }
  onEnded(): () => void { return () => undefined; }
  onLaneHit(lane: number): void { this.laneHits.push(lane); }
  onLaneMiss(lane: number): void { this.laneMisses.push(lane); }
  onHit(): void { this.bandHits++; }
  onMiss(): void { this.bandMisses++; }
  pause(): number | null { return null; }
  async resume(): Promise<number | null> { return null; }
  stop(): void { undefined; }
}

async function setupWithMixer(
  noteTimes: number[],
  events: ReplayEvent[],
): Promise<Harness & { mixer: FakeMixer }> {
  const clock = new FakeClock();
  const chart = chartOf(noteTimes);
  const summaries: RunSummary[] = [];
  const page = new FakePage();
  const mixer = new FakeMixer();
  let input!: ReplayInput;
  const runner = new GameRunner({
    canvas: createMockCanvas(1280, 720),
    chart,
    lanes: LANES,
    windows: windowsForLanes(LANES, 'easy'),
    clock,
    mixer: mixer as unknown as StemMixer,
    input: (songClock) => {
      input = new ReplayInput({ events, audioContext: clock, songClock, lanes: 2, autoTick: false });
      return input;
    },
    thresholdFraction: 0.5,
    countdownSec: 0,
    missGraceMs: 0,
    highwayOptions: { createCanvas: mockCanvasFactory() },
    schedule: () => () => undefined,
    nowMs: () => clock.currentTime * 1000,
    lifecycle: page,
    onEnd: (s) => summaries.push(s),
  });
  await runner.start();
  const advance = (to: number): void => {
    for (let t = clock.currentTime; t <= to + 1e-9; t += 1 / 60) {
      clock.currentTime = Math.round(t * 1e6) / 1e6;
      input.tick();
      runner.step();
    }
  };
  return { runner, clock, input, summaries, page, advance, mixer };
}

describe('a miss dims the limb that missed, never the whole band', () => {
  it('ducks per lane: the strong side keeps its instrument while the weak side misses', async () => {
    // Lane 0 (left) hits all four of its notes; lane 1 (right) never moves at all.
    const notes = [1, 1.2, 1.6, 1.8, 2.2, 2.4];
    const events: ReplayEvent[] = notes
      .map((t, i) => ({ lane: i % 2, songTime: t, strength: 1 }))
      .filter((e) => e.lane === 0);
    const h = await setupWithMixer(notes, events);
    h.advance(4);

    // The mixer is told how many lanes to split the stems across BEFORE the song starts, or every
    // lane shares one instrument and the per-lane fix is dead on arrival.
    expect(h.mixer.laneCount).toBe(2);
    expect(h.mixer.played).toBe(true);
    // Hits are attributed to the lane that produced them...
    expect(h.mixer.laneHits.length).toBeGreaterThan(0);
    expect(new Set(h.mixer.laneHits)).toEqual(new Set([0]));
    // ...and misses to the lane that missed. The working limb's instrument is never touched.
    expect(h.mixer.laneMisses.length).toBeGreaterThan(0);
    expect(new Set(h.mixer.laneMisses)).toEqual(new Set([1]));
    // The lane-agnostic calls duck the player stem for the whole board: they must never be used.
    expect(h.mixer.bandHits).toBe(0);
    expect(h.mixer.bandMisses).toBe(0);
  });

  it('reports a hit and a miss in the same lane to that lane only', async () => {
    const notes = [1, 1.5];
    const h = await setupWithMixer(notes, [{ lane: 0, songTime: 1, strength: 1 }]);
    h.advance(3);
    expect(h.mixer.laneHits).toEqual([0]);
    expect(h.mixer.laneMisses).toEqual([1]);
  });
});

/**
 * THE ENDING THE SONG EARNS.
 *
 * The chart running out used to BE the end of the run: the last note landed, 1.5 s of empty highway
 * went by, and the screen cut to the results grid with the score odometer still mid-climb. The chart
 * ending now starts a song-end sequence on the board and the report waits for it.
 */
describe('the song ends with a payoff, not a cut', () => {
  const notes = [1, 1.5, 2, 2.5];
  const hitAll: ReplayEvent[] = notes.map((t, i) => ({ lane: i % 2, songTime: t, strength: 1 }));

  /**
   * A CAMERA, AS THE RUNNER SEES ONE: a threshold crossing (`onEvent`, which scores) and then the
   * completed rep (`onRep`, which carries the ROM peak and the compensation flags). `ReplayInput`
   * emits only the first, so the divergence between the two streams — the whole bug — cannot be
   * reproduced with it.
   */
  class RepInput implements InputSource {
    private evs = new Set<(e: LaneInputEvent) => void>();
    private reps = new Set<(e: LaneRepEvent) => void>();
    private states: LaneState[] = LANES.map((l) => ({ lane: l.index, value: 0, armed: true, tracking: true }));
    async start(): Promise<void> {}
    stop(): void {}
    onEvent(cb: (e: LaneInputEvent) => void): () => void {
      this.evs.add(cb);
      return () => this.evs.delete(cb);
    }
    onRep(cb: (e: LaneRepEvent) => void): () => void {
      this.reps.add(cb);
      return () => this.reps.delete(cb);
    }
    getLaneStates(): LaneState[] {
      return this.states;
    }
    /** One whole movement: the crossing the engine judges, then the rep the camera reports. */
    fire(lane: number, ctxTime: number, peak: number): void {
      for (const cb of [...this.evs]) cb({ lane, ctxTime, strength: peak });
      this.rep(lane, ctxTime, peak);
    }

    /**
     * A REP THE ENGINE NEVER HEARS ABOUT — and the ordinary case for the population this app is
     * for. `VisionInput` swallows a threshold crossing that falls inside its 300 ms re-trigger
     * guard: the rep is still reported (`emitted: false`, VisionInput.test.ts asserts
     * `reps.length > events.length` at 4 Hz) and it still reaches `laneReps`, but no
     * `LaneInputEvent` is emitted, so the engine's own rep count never sees it. Spasticity, clonus
     * and tremor produce these all session long.
     */
    rep(lane: number, ctxTime: number, peak: number): void {
      for (const cb of [...this.reps]) {
        cb({ lane, ctxTime, endCtxTime: ctxTime + 0.2, peak: Math.min(1, peak), rawPeak: peak });
      }
    }
  }

  /** The same hand-driven harness, with a camera-shaped input source. Countdown 0 ⇒ ctx time = song time. */
  async function setupWithReps(noteTimes: number[]): Promise<{
    runner: GameRunner;
    clock: FakeClock;
    summaries: RunSummary[];
    advance: (to: number) => void;
    repAt: (lane: number, songTime: number, peak: number) => void;
    repOnlyAt: (lane: number, songTime: number, peak: number) => void;
  }> {
    const clock = new FakeClock();
    const summaries: RunSummary[] = [];
    const input = new RepInput();
    const runner = new GameRunner({
      canvas: createMockCanvas(1280, 720),
      chart: chartOf(noteTimes),
      lanes: LANES,
      windows: windowsForLanes(LANES, 'easy'),
      clock,
      input,
      thresholdFraction: 0.5,
      countdownSec: 0,
      missGraceMs: 0,
      highwayOptions: { createCanvas: mockCanvasFactory() },
      schedule: () => () => undefined,
      nowMs: () => clock.currentTime * 1000,
      lifecycle: new FakePage(),
      onEnd: (s) => summaries.push(s),
    });
    await runner.start();
    const advance = (to: number): void => {
      for (let t = clock.currentTime; t <= to + 1e-9; t += 1 / 60) {
        clock.currentTime = Math.round(t * 1e6) / 1e6;
        runner.step();
      }
    };
    return {
      runner,
      clock,
      summaries,
      advance,
      repAt: (lane, songTime, peak) => input.fire(lane, songTime, peak),
      repOnlyAt: (lane, songTime, peak) => input.rep(lane, songTime, peak),
    };
  }

  it('plays the ending on the highway before handing over to the report', async () => {
    const h = await setup(notes, hitAll);
    h.advance(4.2);
    expect(h.runner.getPhase()).toBe('finale');
    expect(h.runner.highway.isFinaleActive()).toBe(true);
    // Nothing is reported yet: the patient is still being paid off.
    expect(h.summaries).toHaveLength(0);

    h.advance(4.2 + FINALE_SEC + 0.2);
    expect(h.runner.highway.finaleDone()).toBe(true);
    expect(h.runner.getPhase()).toBe('ended');
    expect(h.summaries).toHaveLength(1);
  });

  it('does not restart the ending when the mixer reports the song over as well', async () => {
    const h = await setup(notes, hitAll);
    h.advance(4.2);
    const t = h.runner.highway.finaleElapsed();
    h.advance(4.6);
    expect(h.runner.highway.finaleElapsed()).toBeGreaterThan(t);
    // A second chart-end (the mixer's `ended`, arriving after the clock's) must not rewind it.
    h.runner.step();
    expect(h.runner.highway.finaleElapsed()).toBeGreaterThan(t);
  });

  /**
   * SKIPPABLE BY A THERAPIST IN A HURRY — and not by the patient's own last rep. There is no
   * controller here, so the skip is "anything at all"; the guard is what stops a palm on the glass
   * eating the whole sequence on its first frame.
   */
  it('is skipped by any input, but not inside the opening guard', async () => {
    const h = await setup(notes, hitAll);
    // THE CHART END IS ASKED FOR, NOT GUESSED. Advancing to a round 4.05 s put the sequence 0.85 s
    // in — past the guard — so the one assertion that stops a palm on the glass eating the whole
    // payoff had never once run inside the guard it is about. The chart ends at the last note plus
    // the widest GOOD window plus the outro tail (`outroSecFor`), which is 3.18 s here.
    const chartEnd = h.runner.chartEndsAt();
    h.advance(chartEnd + 0.05);
    expect(h.runner.getPhase()).toBe('finale');
    expect(h.runner.highway.finaleElapsed()).toBeLessThan(FINALE_SKIP_GUARD_SEC);
    expect(h.runner.skipFinale()).toBe(false);
    expect(h.summaries).toHaveLength(0);

    h.advance(chartEnd + FINALE_SKIP_GUARD_SEC + 0.1);
    expect(h.runner.skipFinale()).toBe(true);
    expect(h.runner.getPhase()).toBe('ended');
    expect(h.summaries).toHaveLength(1);
    expect(h.summaries[0].endReason).toBe('chart');
    expect(h.summaries[0].completed).toBe(true);
  });

  /**
   * THE CURTAIN MAY NOT COME DOWN WHILE THE LAST NOTE IS STILL JUDGEABLE.
   *
   * `chartEndsAt` was `Math.min(durationSec, …)` with nothing under it, which silently broke the
   * contract `outroSecFor` states: the last note cannot be judged after its own GOOD window has
   * closed. Measured in the app with a fine-motor prescription at the widest therapist window
   * (`?difficulty=easy&scale=4`, two finger_opposition lanes): goodMs 1152, last note 96.000 s,
   * window closing 97.152 s, `chartEndsAt()` 97.000 — the ending starting 152 ms early. The hit was
   * still scored, so no figure lied, but the most impaired configuration (the one the widening
   * exists for) lost the gem, the hit sound and the combo cue on its final rep.
   */
  it('never starts the ending before the last note can no longer be judged', async () => {
    const clock = new FakeClock();
    const lanes: LaneSpec[] = [
      { index: 0, movement: 'finger_opposition', side: 'left' },
      { index: 1, movement: 'finger_opposition', side: 'right' },
    ];
    // The therapist's widest window on the widest difficulty: 180 ms x 1.6 fine motor x 4.
    const windows = windowsForLanes(lanes, 'easy', 4);
    const goodSec = Math.max(...windows.map((w) => w.goodMs)) / 1000;
    expect(goodSec).toBeCloseTo(1.152, 3);
    // A chart whose generated tail (1 s, charts/generate.ts) is SHORTER than that window.
    const chart: Chart = {
      songId: 'test', lanes: 2, bpm: 120, offset: 0, difficulty: DIFFICULTIES.easy,
      notes: [{ id: 1, lane: 0, time: 10 }, { id: 2, lane: 1, time: 12 }],
      durationSec: 13,
    };
    const runner = new GameRunner({
      canvas: createMockCanvas(1280, 720),
      chart,
      lanes,
      windows,
      clock,
      input: new RepInput(),
      thresholdFraction: 0.5,
      countdownSec: 0,
      missGraceMs: 0,
      highwayOptions: { createCanvas: mockCanvasFactory() },
      schedule: () => () => undefined,
      nowMs: () => clock.currentTime * 1000,
      lifecycle: new FakePage(),
      onEnd: () => undefined,
    });
    await runner.start();
    // The song is 13 s and the last note's window does not close until 13.152 s.
    expect(chart.durationSec).toBeLessThan(12 + goodSec);
    expect(runner.chartEndsAt()).toBeGreaterThanOrEqual(12 + goodSec - 1e-9);
    runner.dispose();
  });

  /**
   * A TAP THAT ALREADY MEANS SOMETHING IS NOT A TAP THAT MEANS "SKIP".
   *
   * The skip listener is on `window`, so it also caught the play screen's own chrome drawn over the
   * canvas: tapping PAUSE at t≈3 s of the ending landed on the report in 77 ms. Harmless to the
   * record and wrong for the person holding the tablet.
   */
  it('leaves a tap that lands on a control to that control', async () => {
    const h = await setup(notes, hitAll);
    const chartEnd = h.runner.chartEndsAt();
    h.advance(chartEnd + FINALE_SKIP_GUARD_SEC + 0.2);
    expect(h.runner.getPhase()).toBe('finale');

    const button = document.createElement('button');
    document.body.appendChild(button);
    button.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
    expect(h.runner.getPhase()).toBe('finale');
    expect(h.summaries).toHaveLength(0);

    // …and anywhere else still skips it, which is the whole affordance.
    document.body.dispatchEvent(new window.Event('pointerdown', { bubbles: true }));
    expect(h.runner.getPhase()).toBe('ended');
    expect(h.summaries).toHaveLength(1);
    button.remove();
  });

  /**
   * THE STORED SESSION IS THE CHART'S LENGTH, NOT THE CELEBRATION'S. `RunSummary.songTime` becomes
   * the duration on the record, which is the denominator of every reps-per-minute a therapist reads.
   */
  it('records the session length as of the chart ending, not the end of the sequence', async () => {
    const h = await setup(notes, hitAll);
    const chartEnd = h.runner.chartEndsAt();
    h.advance(chartEnd + 0.05);
    const atChartEnd = h.runner.songTime();
    expect(atChartEnd).toBeCloseTo(chartEnd, 1);
    h.advance(chartEnd + FINALE_SEC + 0.4);
    expect(h.summaries[0].songTime).toBeCloseTo(atChartEnd, 1);
    expect(h.summaries[0].songTime).toBeLessThan(atChartEnd + 1);
  });

  /**
   * A COMPLETED SONG STAYS COMPLETED. Everything that ends a run arrives at `finish()`, including a
   * therapist tapping "End & see results" over the payoff and the screen being left during it. None
   * of those un-finish a song that finished.
   */
  it('stays a complete run when it is quit or abandoned during the ending', async () => {
    const quit = await setup(notes, hitAll);
    quit.advance(4.2);
    quit.runner.quit();
    expect(quit.summaries[0].endReason).toBe('chart');
    expect(quit.summaries[0].completed).toBe(true);

    const gone = await setup(notes, hitAll);
    gone.advance(4.2);
    gone.runner.dispose();
    expect(gone.summaries[0].endReason).toBe('chart');
    expect(gone.summaries[0].completed).toBe(true);
  });

  /**
   * THE CARD LEADS WITH THE WORK, because `Highway` draws `stats[0]` as its hero figure.
   *
   * The runner is the only thing that knows what this session was, so it is the only thing that can
   * decide what the biggest number on the ending is. It is the rep count — the same quantity Results
   * and History were both corrected to lead with — and never the score.
   */
  it('hands the renderer the rep count as the hero figure, not the score', async () => {
    const h = await setup(notes, hitAll);
    let spec: FinaleSpec | null = null;
    const real = h.runner.highway.startFinale.bind(h.runner.highway);
    h.runner.highway.startFinale = (s: FinaleSpec) => {
      spec = spec ?? s;
      real(s);
    };
    h.advance(4.2);
    const seen = spec as FinaleSpec | null;
    expect(seen).not.toBeNull();
    const card = seen as FinaleSpec;
    expect(card.stats[0].label).toBe('MOVEMENTS');
    expect(Number(card.stats[0].value)).toBe(h.runner.hud().reps);
    expect(card.achievement).not.toContain(card.stats[0].value);
    // The score is present (the patient watched it all song) but it is not a stat column and it is
    // certainly not the first one.
    expect(card.stats.map((x) => x.label)).not.toContain('SCORE');
    expect(card.achievement).not.toMatch(/star|score|grade|rank/i);
  });

  /**
   * THE ENDING MAY NOT COST THE PATIENT A REP. Whatever the sequence does on screen, the record
   * handed to the report is the run that finished — the same counts, whether it plays out or a
   * therapist taps through it.
   */
  it('reports the same reps whether the ending runs out or is skipped', async () => {
    const played = await setup(notes, hitAll);
    played.advance(4.2);
    const atChartEnd = played.runner.hud().reps;
    expect(atChartEnd).toBeGreaterThan(0);
    played.advance(4.2 + FINALE_SEC + 0.3);
    expect(played.summaries[0].results.reps).toBe(atChartEnd);
    expect(played.summaries[0].completed).toBe(true);

    const skipped = await setup(notes, hitAll);
    skipped.advance(4.2 + FINALE_SKIP_GUARD_SEC + 0.1);
    expect(skipped.runner.skipFinale()).toBe(true);
    expect(skipped.summaries[0].results.reps).toBe(atChartEnd);
    expect(skipped.summaries[0].completed).toBe(true);
  });

  /**
   * THE BIGGEST WAY THIS ENDING COULD GO WRONG — AND DID.
   *
   * `onInput` returned early on the `finale` phase and `onRep` did not. On a camera session the
   * patient is mid-march when the music stops, so for the whole 6.6 s payoff the camera's rep
   * stream kept feeding `laneReps` — every per-movement rep count, every ROM peak, every
   * compensation flag on the report — while the session's headline count was frozen. The report
   * could then print "Movements performed 126" over a per-movement column adding up to more than
   * 126, and a rep the patient really performed was discarded because of HOW THE SONG ENDED, which
   * is the one thing `finish()` exists to prevent.
   */
  it('counts the movements made during the ending in the headline as well as the table', async () => {
    const h = await setupWithReps(notes);
    const chartEnd = h.runner.chartEndsAt();
    // Four marches during the song, on the notes.
    for (let i = 0; i < notes.length; i++) {
      h.advance(notes[i] + 0.05);
      h.repAt(i % 2, notes[i], 0.9);
    }
    h.advance(chartEnd + 0.05);
    expect(h.runner.getPhase()).toBe('finale');
    const before = h.runner.hud().reps;
    expect(before).toBe(4);

    // Three more marches over the celebration, on both prescribed lanes.
    h.repAt(0, chartEnd + 0.4, 0.7);
    h.repAt(1, chartEnd + 0.9, 0.6);
    h.repAt(0, chartEnd + 1.4, 0.8);
    h.advance(chartEnd + 1.6);

    expect(h.runner.hud().reps).toBe(before + 3);
    h.advance(chartEnd + FINALE_SEC + 0.3);
    const s = h.summaries[0];
    expect(s.completed).toBe(true);
    // THE TWO COUNTERS COVER THE SAME WINDOW. The headline is never less than its own column.
    const laneTotal = s.laneReps.reduce((n, l) => n + l.reps, 0);
    expect(s.results.reps).toBeGreaterThanOrEqual(laneTotal);
    expect(s.results.reps).toBe(before + 3);
    expect(laneTotal).toBe(before + 3);
    // And the range those reps reached is on the record beside them, not orphaned.
    expect(s.laneReps[0].peaks).toEqual([0.9, 0.9, 0.7, 0.8]);
  });

  /** The same agreement when a therapist taps through the payoff rather than letting it run. */
  it('keeps the two counts in step when the ending is skipped mid-way', async () => {
    const h = await setupWithReps(notes);
    const chartEnd = h.runner.chartEndsAt();
    h.advance(chartEnd + FINALE_SKIP_GUARD_SEC + 0.1);
    const before = h.runner.hud().reps;
    h.repAt(0, chartEnd + FINALE_SKIP_GUARD_SEC + 0.15, 0.5);
    h.advance(chartEnd + FINALE_SKIP_GUARD_SEC + 0.2);
    expect(h.runner.skipFinale()).toBe(true);
    const s = h.summaries[0];
    expect(s.results.reps).toBe(before + 1);
    expect(s.laneReps.reduce((n, l) => n + l.reps, 0)).toBe(1);
    // Skipping the celebration does not shorten the session that was filed.
    expect(s.songTime).toBeCloseTo(chartEnd, 1);
  });

  /**
   * AND THE CARD DOES NOT GO STALE WHILE IT IS BEING READ. If the ending counts those movements,
   * the figure on the ending has to be the figure on the report — or the payoff says 126 and the
   * grid seven seconds later says 129.
   */
  it('keeps the card\'s hero figure equal to the reps the report will print', async () => {
    const h = await setupWithReps(notes);
    const specs: FinaleSpec[] = [];
    const start = h.runner.highway.startFinale.bind(h.runner.highway);
    const update = h.runner.highway.updateFinale.bind(h.runner.highway);
    h.runner.highway.startFinale = (spec: FinaleSpec) => { specs.push(spec); start(spec); };
    h.runner.highway.updateFinale = (spec: FinaleSpec) => { specs.push(spec); update(spec); };

    const chartEnd = h.runner.chartEndsAt();
    h.advance(chartEnd + 0.05);
    h.repAt(0, chartEnd + 0.3, 0.9);
    h.repAt(1, chartEnd + 0.7, 0.9);
    h.advance(chartEnd + FINALE_SEC + 0.3);

    const last = specs[specs.length - 1];
    expect(specs.length).toBeGreaterThan(1);
    expect(last.stats[0].label).toBe('MOVEMENTS');
    expect(Number(last.stats[0].value)).toBe(h.summaries[0].results.reps);
    // SONG LENGTH is the CHART's length throughout — the celebration is not song time, and the
    // label no longer claims it is time spent moving (the reps made over the payoff are not in it).
    expect(last.stats[3].label).toBe('SONG LENGTH');
    expect(last.stats[3].value).toBe(specs[0].stats[3].value);
    expect(last.stats[3].value).toBe(formatDuration(h.summaries[0].songTime));
  });

  /**
   * THE PAYOFF AND THE REPORT ARE THE SAME SESSION, TWO SECONDS APART.
   *
   * Two labels on this card named quantities the report names differently, which is the one thing
   * clinical software may not do:
   *
   *   NOTES ANSWERED was `hits/judged`. "Notes answered" is `ScoreResults.attempted` everywhere
   *   else in this codebase — every hit PLUS every missed note a movement landed on
   *   (engine/scoring.ts `answerRateOf`) — and the difference is exactly the set of reps a patient
   *   performed and did not score. Measured on one live run: the card said "50/95" and the report
   *   said "a movement was made for 94 of the 95 notes offered". The patient whose latency is
   *   200 ms out is the patient `answerRateOf` exists for, and this card handed them a number less
   *   than half the one in their own record.
   *
   *   MOVEMENTS was the ENGINE's rep count, one per input event. The report prints the sum over
   *   lanes of `max(engine lane reps, the reps the camera observed)`, and a crossing swallowed by
   *   the camera's re-trigger guard reports the rep and emits no event at all — so on a session
   *   with tremor or clonus the two diverge by construction.
   *
   * Driven here with both: a note answered late enough to miss but close enough to be attributed
   * to it, and reps the camera reported with no crossing behind them.
   */
  it('prints the same notes-answered and movement counts the report will print', async () => {
    const h = await setupWithReps(notes);

    // Note 1 is hit. Note 2 is answered far too late to score — but the movement was made, which is
    // what "answered" counts. Notes 3 and 4 are never answered at all.
    h.advance(notes[0] + 0.02);
    h.repAt(0, notes[0], 0.95);
    h.advance(notes[1] + 0.4);
    h.repAt(1, notes[1] + 0.35, 0.8);
    // Two reps the camera saw and the engine never did (the refractory guard swallowed them).
    h.advance(notes[2] + 0.1);
    h.repOnlyAt(0, notes[2] + 0.05, 0.6);
    h.repOnlyAt(1, notes[2] + 0.08, 0.55);

    const specs: FinaleSpec[] = [];
    const start = h.runner.highway.startFinale.bind(h.runner.highway);
    const update = h.runner.highway.updateFinale.bind(h.runner.highway);
    h.runner.highway.startFinale = (spec: FinaleSpec) => { specs.push(spec); start(spec); };
    h.runner.highway.updateFinale = (spec: FinaleSpec) => { specs.push(spec); update(spec); };

    h.advance(h.runner.chartEndsAt() + FINALE_SEC + 0.3);
    const card = specs[specs.length - 1];
    const report = buildSessionResult({
      summary: h.summaries[0],
      config: REPORT_CONFIG,
      inputMode: 'camera',
      latencyOffsetSec: 0,
    });

    // The engine really did see fewer reps than the camera — without that this test proves nothing.
    expect(h.summaries[0].results.reps).toBeLessThan(report.reps);
    expect(card.stats[0].label).toBe('MOVEMENTS');
    expect(card.stats[0].value).toBe(String(report.reps));

    // NOTES ANSWERED, on the card and in the record, is the same fraction.
    const judged = report.hits + report.misses;
    const answered = report.lanes.reduce((n, l) => n + (l.attempted ?? 0), 0);
    expect(card.stats[1].label).toBe('NOTES ANSWERED');
    expect(card.stats[1].value).toBe(`${answered}/${judged}`);
    // And it is the quantity the Results screen prints, not hits: the late-but-made movement counts.
    expect(answered).toBeGreaterThan(report.hits);
    expect(Math.round((report.answerRate ?? 0) * judged)).toBe(answered);
  });

  /**
   * AND NOT THE MOVEMENTS MADE WHILE THE SESSION IS STOPPED. The engine drops an input stamped
   * inside a pause, the receptor row is blanked to "no reading", and the rep stream now agrees:
   * a session's duration does not contain the pause, so its figures must not either.
   */
  it('does not count a rep performed while the session is paused', async () => {
    const h = await setupWithReps(notes);
    h.advance(1.05);
    h.repAt(0, 1.0, 0.9);
    expect(h.runner.hud().reps).toBe(1);

    h.runner.pause();
    const pausedAt = h.clock.currentTime;
    h.clock.currentTime = pausedAt + 3;
    h.repAt(1, pausedAt + 1.5, 0.9);
    h.runner.step();
    expect(h.runner.hud().reps).toBe(1);

    await h.runner.resume();
    h.advance(h.clock.currentTime + 0.4);
    h.repAt(1, h.clock.currentTime - 0.1, 0.5);
    // Ctx time, not song time: the pause pushed the two apart by three seconds.
    h.advance(20);
    const s = h.summaries[0];
    expect(s.completed).toBe(true);
    expect(s.laneReps[1].reps).toBe(1);
    expect(s.laneReps[1].peaks).toEqual([0.5]);
    expect(s.results.reps).toBe(2);
  });

  /** Nothing can be judged once the chart has run out, so the receptors say so. */
  it('tells the renderer it is no longer accepting input', async () => {
    const h = await setup(notes, hitAll);
    h.advance(4.2);
    for (const l of LANES) expect(h.runner.highway.receptorLookOf(l.index)?.suspended, `lane ${l.index}`).toBe(true);
  });
});

/**
 * THE ONE SENTENCE THE ENDING SAYS ABOUT THIS SESSION.
 *
 * The hard case is a patient who answered six notes out of two hundred: this is the last thing the
 * game says to them, and it may not be a grade, a rank or a comparison.
 */
describe('the session achievement is warm to somebody who scored badly', () => {
  it('names the full range reached when a lane got there', () => {
    const a = sessionAchievement({
      reps: 40,
      hits: 2,
      judged: 90,
      maxCombo: 1,
      lanes: [
        { name: 'Left Seated march', bestPeak: 0.94 },
        { name: 'Right Knee extension', bestPeak: 0.4 },
      ],
    });
    // NO LANE IS RANKED. The headline counts the movements that got there; the names and their own
    // figures sit in the note, in prescription order.
    expect(a.text).toContain('Full range');
    expect(a.text).toContain('1 of 2 movements');
    expect(a.text).not.toContain('Left Seated march');
    expect(a.text).not.toContain('Right Knee extension');
    expect(a.note).toContain('Left Seated march');
    expect(a.note).toContain('94%');
    // EVERY MEASURED MOVEMENT IS LISTED, not only the ones that got there. Listing only the full
    // lanes made this line name one limb and not the other — see the test below for the case where
    // the one it named was the unaffected side.
    expect(a.note).toContain('Right Knee extension 40%');
  });

  /**
   * THE ENDING MAY NOT HAND THE UNAFFECTED SIDE THE SESSION'S ONE SENTENCE.
   *
   * This was a `max(bestPeak)` across the lanes. On the prescription this app is for — the affected
   * limb plus an unaffected one so the patient has a lane they can score in — the maximum is the
   * strong side essentially every time, so the last thing the game said before the report was the
   * name of the leg the patient did not come about. Results refuses to rank limbs seven seconds
   * later; this now agrees with it.
   */
  it('never names one limb as better than another, whatever the peaks are', () => {
    const a = sessionAchievement({
      reps: 88,
      hits: 4,
      judged: 120,
      maxCombo: 1,
      lanes: [
        { name: 'Left Seated march', bestPeak: 0.31 },
        { name: 'Right Knee extension', bestPeak: 0.97 },
      ],
    });
    // The strong side reached its whole range: that is said, as a COUNT, with the figure beside the
    // movement it belongs to — and the sentence itself names no limb.
    expect(a.text).toBe('Full range reached — 1 of 2 movements');
    expect(a.text).not.toMatch(/left|right|knee|march/i);
    expect(`${a.text} ${a.note}`).not.toMatch(/best|strongest|top|winner|better/i);
    expect(a.note).toContain('Right Knee extension 97%');
    // AND THE AFFECTED SIDE IS IN THE SENTENCE TOO. The note used to list only the lanes at full
    // range, so on exactly this prescription — the strong leg reaching its whole calibrated range,
    // the weak one at 31 % — the last line the game showed named the limb the patient did NOT come
    // about, and the one they did was absent from the ending entirely.
    expect(a.note).toContain('Left Seated march 31%');
    // The order is the prescription's, not the peaks': the weak lane is first because it is lane 0.
    expect(a.note!.indexOf('Left Seated march')).toBeLessThan(a.note!.indexOf('Right Knee extension'));
  });

  it('says "every movement" rather than a count when they all got there', () => {
    const a = sessionAchievement({
      reps: 60,
      hits: 30,
      judged: 40,
      maxCombo: 9,
      lanes: [
        { name: 'Left Seated march', bestPeak: 0.95 },
        { name: 'Right Knee extension', bestPeak: 0.92 },
      ],
    });
    expect(a.text).toBe('Full range reached — 2 of 2 movements');
    expect(a.note).toContain('Left Seated march 95%');
    expect(a.note).toContain('Right Knee extension 92%');
  });

  /**
   * THE RIBBON IS NEVER THE HERO FIGURE AGAIN.
   *
   * `Highway` draws `stats[0]` — movements performed — as the biggest thing on the card, and this
   * sentence sits on a gold ribbon directly beneath it, positioned and styled as the point of the
   * screen. It used to read "142 movements performed": the same number the patient had just read,
   * in a smaller font, on the one run this ladder exists for.
   */
  it('falls back to the work performed without restating the count above it', () => {
    const reps = 142;
    const a = sessionAchievement({ reps, hits: 6, judged: 200, maxCombo: 2, lanes: [{ name: 'Left Seated march', bestPeak: 0.3 }] });
    expect(a.text).toBe('Every movement counted');
    expect(a.text).not.toContain(String(reps));
    expect(a.note).not.toContain(String(reps));
    // The sentence that was doing the work is the sentence now, and the second line says something
    // the card does not say anywhere else.
    expect(a.note).toContain('Landed on a note or not');
    expect(a.note).toContain('Left Seated march 30%');
    // Nothing on this screen may read as a mark out of ten. A ROM figure is not one — but it is
    // only honest with the clause that says what it is a fraction OF, so the clause is required.
    expect(`${a.text} ${a.note}`).not.toMatch(/star|score|accuracy|grade|rank/i);
    expect(a.note).toContain('of the range calibrated for THAT movement today');
  });

  /** Every measured movement, in prescription order — an unranked list, exactly like the top rung. */
  it('lists every measured movement in prescription order when none reached full range', () => {
    const a = sessionAchievement({
      reps: 51,
      hits: 9,
      judged: 90,
      maxCombo: 3,
      lanes: [
        { name: 'Left Seated march', bestPeak: 0.42 },
        { name: 'Right Knee extension', bestPeak: 0.88 },
      ],
    });
    expect(a.note).toContain('Left Seated march 42%');
    expect(a.note).toContain('Right Knee extension 88%');
    expect(a.note?.indexOf('Left Seated march')).toBeLessThan(a.note?.indexOf('Right Knee extension') as number);
    expect(`${a.text} ${a.note}`).not.toMatch(/best|strongest|top|winner|better|worse/i);
  });

  /** A keyboard or replay run measures no range at all; the streak is then what there is to say. */
  it('names a run of notes when there was one worth naming and no range was measured', () => {
    const a = sessionAchievement({ reps: 30, hits: 20, judged: 40, maxCombo: 12, lanes: [{ name: 'L', bestPeak: null }] });
    expect(a.text).toBe('Every movement counted');
    expect(a.note).toContain('12 notes answered in a row');
  });

  it('says plainly when nothing was measured rather than inventing praise', () => {
    const a = sessionAchievement({ reps: 0, hits: 0, judged: 50, maxCombo: 0, lanes: [{ name: 'L', bestPeak: null }] });
    expect(a.text).toBe('Session recorded');
    expect(a.note).toContain('No movement was measured');
  });
});
