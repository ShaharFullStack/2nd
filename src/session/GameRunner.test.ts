import { beforeEach, describe, expect, it } from 'vitest';
import { windowsForLanes } from '../engine/difficulty.ts';
import { DIFFICULTIES } from '../engine/difficulty.ts';
import type { Chart, LaneSpec } from '../engine/types.ts';
import { ReplayInput } from '../input/ReplayInput.ts';
import type { ReplayEvent } from '../input/ReplayInput.ts';
import { createMockCanvas, mockCanvasFactory } from '../render/canvasMock.ts';
import type { StemMixer } from '../audio/StemMixer.ts';
import { GameRunner } from './GameRunner.ts';
import type { PageLifecycle, RunSummary } from './GameRunner.ts';

const LANES: LaneSpec[] = [
  { index: 0, movement: 'seated_march', side: 'left' },
  { index: 1, movement: 'seated_march', side: 'right' },
];

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
    h.advance(6);
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
    h.advance(6);
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
