import { beforeEach, describe, expect, it } from 'vitest';
import { windowsForLanes } from '../engine/difficulty.ts';
import { DIFFICULTIES } from '../engine/difficulty.ts';
import type { Chart, LaneSpec } from '../engine/types.ts';
import { ReplayInput } from '../input/ReplayInput.ts';
import type { ReplayEvent } from '../input/ReplayInput.ts';
import { createMockCanvas, mockCanvasFactory } from '../render/canvasMock.ts';
import { GameRunner } from './GameRunner.ts';
import type { RunSummary } from './GameRunner.ts';

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

interface Harness {
  runner: GameRunner;
  clock: FakeClock;
  input: ReplayInput;
  summaries: RunSummary[];
  advance: (to: number) => void;
}

async function setup(noteTimes: number[], events: ReplayEvent[], countdownSec = 0): Promise<Harness> {
  const clock = new FakeClock();
  const chart = chartOf(noteTimes);
  const summaries: RunSummary[] = [];
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
  return { runner, clock, input, summaries, advance };
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
