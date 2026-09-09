// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { DIFFICULTIES } from './difficulty.ts';
import { DEFAULT_MISS_GRACE_MS } from './judge.ts';
import { RhythmEngine } from './rhythm.ts';
import type { Chart } from './types.ts';

const chart: Chart = {
  songId: 's',
  lanes: 2,
  bpm: 120,
  offset: 0,
  difficulty: DIFFICULTIES.medium,
  durationSec: 10,
  notes: [
    { id: 0, lane: 0, time: 1 },
    { id: 1, lane: 1, time: 1.5 },
    { id: 2, lane: 0, time: 2 },
    { id: 3, lane: 1, time: 2.5 },
  ],
};
const W = { perfectMs: 70, goodMs: 140 };

describe('RhythmEngine', () => {
  it('applies the calibration latency exactly once, from ctx-stamped input events', () => {
    const ctx = { currentTime: 100 };
    const eng = new RhythmEngine({ chart, windows: W, ctx, inputLatencySec: 0.15 });
    expect(eng.getInputLatency()).toBe(0.15);
    expect(eng.judge.getMissGrace()).toBe(DEFAULT_MISS_GRACE_MS);
    expect(eng.handleInput({ lane: 0, ctxTime: 101, strength: 1 })).toBeNull(); // idle: ignored
    expect(eng.tick().misses).toEqual([]);
    eng.start(100);
    // note 0 at song time 1 -> physically moved at ctx 101, camera saw it at 101.15
    const hit = eng.handleInput({ lane: 0, ctxTime: 101.15, strength: 1 })!;
    expect(hit.judgment).toBe('perfect');
    expect(hit.deltaMs).toBeCloseTo(0, 6);
    expect(eng.getLastHitDelta()!.points).toBe(100);
    // without latency compensation this same event would have been 150 ms late (a 'miss' at goodMs 140)
    const raw = new RhythmEngine({ chart, windows: W, ctx, inputLatencySec: 0 });
    raw.start(100);
    expect(raw.handleInput({ lane: 0, ctxTime: 101.15, strength: 1 })).toBeNull();
  });
  it('tick applies misses to scoring with the grace, and reports completion', () => {
    const ctx = { currentTime: 0 };
    const eng = new RhythmEngine({ chart, windows: W, ctx, missGraceMs: 100 });
    eng.start(0);
    ctx.currentTime = 1.2;
    expect(eng.tick().misses).toEqual([]); // deadline 1.14 + grace 0.1
    expect(eng.handleInput({ lane: 0, ctxTime: 1.1, strength: 1 })!.judgment).toBe('good'); // delivered late but stamped in-window
    ctx.currentTime = 1.8;
    const t = eng.tick();
    expect(t.misses.map((m) => m.noteId)).toEqual([1]);
    expect(t.songTime).toBeCloseTo(1.8);
    expect(eng.getScoreState().misses).toBe(1);
    expect(eng.getScoreState().hits).toBe(1);
    expect(eng.isComplete()).toBe(false);
    eng.pause(2);
    ctx.currentTime = 50;
    expect(eng.tick().misses).toEqual([]); // frozen while paused
    eng.resume(50);
    ctx.currentTime = 51;
    expect(eng.tick().pending).toBe(0);
    expect(eng.isComplete()).toBe(true);
    expect(eng.visibleNotes(2.5, 1).map((n) => n.id)).toEqual([2, 3]);
    eng.reset();
    expect(eng.clock.getState()).toBe('idle');
    expect(eng.judge.getPendingCount()).toBe(4);
    expect(eng.getScoreState().score).toBe(0);
    expect(eng.getLastHitDelta()).toBeNull();
    eng.setInputLatency(0.2);
    expect(eng.judge.getLatencyOffset()).toBe(0.2);
  });
});
