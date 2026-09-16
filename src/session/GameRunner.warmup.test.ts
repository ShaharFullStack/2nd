/**
 * THE OPENING THE APP IS NOT MEASURING IN.
 *
 * On the in-song calibration path the first seconds of the song are where the patient's range is
 * learned, so a note missed there is a note missed while the app could not state what it was asking
 * for. Two things follow, and both are the runner's job:
 *
 *  - THE HIT WINDOWS ARE WIDER, and they narrow back exactly once — after the last note that could
 *    still be judged under the wide ones has been judged, so no note the patient was inside is
 *    turned into a miss by the change;
 *  - A MISS DOES NOT DUCK THE PATIENT'S INSTRUMENT. Per-lane ducking is the reward the weak side is
 *    earning with every rep; taking it away for missing a target the app cannot yet name would be
 *    the app charging the patient for its own uncertainty.
 *
 * (The third part — far fewer notes in the opening — is the chart generator's, and is proved in
 * src/charts/warmup.test.ts.)
 */
import { describe, expect, it } from 'vitest';
import { windowsForLanes } from '../engine/difficulty.ts';
import { DIFFICULTIES } from '../engine/difficulty.ts';
import type { Chart, LaneSpec } from '../engine/types.ts';
import { ReplayInput } from '../input/ReplayInput.ts';
import type { ReplayEvent } from '../input/ReplayInput.ts';
import type { StemMixer } from '../audio/StemMixer.ts';
import { createMockCanvas, mockCanvasFactory } from '../render/canvasMock.ts';
import { GameRunner } from './GameRunner.ts';
import { WARMUP_WINDOW_SCALE } from './inSongCalibration.ts';

const LANES: LaneSpec[] = [
  { index: 0, movement: 'seated_march', side: 'left' },
  { index: 1, movement: 'seated_march', side: 'right' },
];

class FakeClock {
  currentTime = 0;
}

class FakeMixer {
  laneMisses: number[] = [];
  laneHits: number[] = [];
  get isLoaded(): boolean { return true; }
  get outputLatencySec(): number { return 0; }
  setLaneCount(): void { undefined; }
  play(): void { undefined; }
  getSongStartCtxTime(): number { return 0; }
  onEnded(): () => void { return () => undefined; }
  onLaneHit(lane: number): void { this.laneHits.push(lane); }
  onLaneMiss(lane: number): void { this.laneMisses.push(lane); }
  pause(): number | null { return null; }
  async resume(): Promise<number | null> { return null; }
  stop(): void { undefined; }
}

function chartOf(notes: { lane: number; time: number }[]): Chart {
  return {
    songId: 'test',
    lanes: 2,
    notes: notes.map((n, i) => ({ id: i + 1, lane: n.lane, time: n.time })),
    bpm: 120,
    offset: 0,
    difficulty: DIFFICULTIES.easy,
    durationSec: 60,
  };
}

async function setup(
  notes: { lane: number; time: number }[],
  events: ReplayEvent[],
  warmup: { endsAt: number; windowScale: number } | undefined,
) {
  const clock = new FakeClock();
  const mixer = new FakeMixer();
  let input!: ReplayInput;
  const runner = new GameRunner({
    canvas: createMockCanvas(1280, 720),
    chart: chartOf(notes),
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
    warmup,
    highwayOptions: { createCanvas: mockCanvasFactory() },
    schedule: () => () => undefined,
    nowMs: () => clock.currentTime * 1000,
    lifecycle: null,
  });
  await runner.start();
  const advance = (to: number): void => {
    for (let t = clock.currentTime; t <= to + 1e-9; t += 1 / 60) {
      clock.currentTime = Math.round(t * 1e6) / 1e6;
      input.tick();
      runner.step();
    }
  };
  return { runner, mixer, advance };
}

/** easy's good window is 180 ms; a movement 300 ms late is outside it and inside twice it. */
const LATE_SEC = 0.3;

describe('the warm-up opening', () => {
  it('judges a movement the prescription would have missed, while the range is still being learned', async () => {
    const h = await setup(
      [{ lane: 0, time: 1 }],
      [{ lane: 0, songTime: 1 + LATE_SEC, strength: 1 }],
      { endsAt: 8, windowScale: WARMUP_WINDOW_SCALE },
    );
    h.advance(3);
    expect(h.runner.hud().hits).toBe(1);
    expect(h.runner.hud().misses).toBe(0);
  });

  it('misses exactly the same movement once the warm-up has closed — the prescription is back', async () => {
    const h = await setup(
      [{ lane: 0, time: 12 }],
      [{ lane: 0, songTime: 12 + LATE_SEC, strength: 1 }],
      { endsAt: 8, windowScale: WARMUP_WINDOW_SCALE },
    );
    h.advance(14);
    expect(h.runner.hud().hits).toBe(0);
    expect(h.runner.hud().misses).toBe(1);
  });

  it('never has a warm-up at all when the ranges were measured before the song', async () => {
    const h = await setup(
      [{ lane: 0, time: 1 }],
      [{ lane: 0, songTime: 1 + LATE_SEC, strength: 1 }],
      undefined,
    );
    h.advance(3);
    expect(h.runner.hud().hits).toBe(0);
    expect(h.runner.hud().misses).toBe(1);
  });

  /**
   * THE WINDOWS MAY NOT NARROW UNDER A PENDING NOTE.
   *
   * A note offered inside the warm-up but answered just after the boundary was, for the patient, a
   * note in the warm-up. If the windows snapped back the instant the warm-up ended, that note would
   * turn into a miss because of when the clock crossed a line, not because of anything they did.
   * The runner therefore restores the prescription's windows only after the widest good window that
   * was in force has elapsed.
   */
  it('lets a note offered inside the warm-up keep the wide window it was offered under', async () => {
    const h = await setup(
      [{ lane: 0, time: 7.95 }],
      [{ lane: 0, songTime: 7.95 + LATE_SEC, strength: 1 }],
      { endsAt: 8, windowScale: WARMUP_WINDOW_SCALE },
    );
    h.advance(10);
    expect(h.runner.hud().hits).toBe(1);
  });

  it('does not dim the patient’s instrument for a miss while the range is unknown, and does after', async () => {
    const h = await setup(
      [
        { lane: 0, time: 1 },
        { lane: 1, time: 12 },
      ],
      [],
      { endsAt: 8, windowScale: WARMUP_WINDOW_SCALE },
    );
    h.advance(6);
    // The warm-up note was missed and the instrument was left alone.
    expect(h.runner.hud().misses).toBe(1);
    expect(h.mixer.laneMisses).toEqual([]);
    h.advance(14);
    // The one after the boundary ducks its own lane, exactly as it always did.
    expect(h.runner.hud().misses).toBe(2);
    expect(h.mixer.laneMisses).toEqual([1]);
  });

  it('ducks every miss when there is no warm-up', async () => {
    const h = await setup([{ lane: 0, time: 1 }], [], undefined);
    h.advance(3);
    expect(h.mixer.laneMisses).toEqual([0]);
  });
});
