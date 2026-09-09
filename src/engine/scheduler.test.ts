// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { DIFFICULTIES } from './difficulty.ts';
import { NoteCursor, SongClock, beatAt, visibleNotes } from './scheduler.ts';
import type { Chart, Note } from './types.ts';

describe('SongClock', () => {
  it('tracks song time with pause/resume and A/V offset', () => {
    const ctx = { currentTime: 0 };
    const c = new SongClock(ctx);
    expect(c.getState()).toBe('idle');
    expect(c.songTime()).toBe(0);
    ctx.currentTime = 10;
    c.start(10.5); // scheduled slightly ahead
    expect(c.songTime(10.5)).toBe(0);
    expect(c.songTime(12.5)).toBe(2);
    expect(c.ctxTimeForSongTime(2)).toBe(12.5);
    c.pause(12.5);
    expect(c.songTime(15)).toBe(2);
    c.resume(15);
    expect(c.songTime(16)).toBeCloseTo(3);
    ctx.currentTime = 17;
    expect(c.songTime()).toBeCloseTo(4);
    expect(c.ctxTimeForSongTime(4)).toBeCloseTo(17);
    c.setAvOffset(0.05);
    expect(c.getAvOffset()).toBe(0.05);
    expect(c.songTime(17)).toBeCloseTo(4.05);
    expect(c.ctxTimeForSongTime(4.05)).toBeCloseTo(17);
    c.pause();
    c.pause(); // idempotent
    c.resume(20);
    c.resume();
    expect(c.songTime(21)).toBeCloseTo(5.05);
    c.stop();
    expect(c.isRunning()).toBe(false);
    expect(c.songTime(100)).toBe(0); // idle again: 0, not the offset
  });
  it('supports starting mid-song', () => {
    const c = new SongClock({ currentTime: 5 }, { avOffsetSec: 0 });
    c.start(5, 30);
    expect(c.songTime(6)).toBe(31);
  });
});

describe('beatAt', () => {
  it('computes beat, phase and bar', () => {
    const b = beatAt(120, 0.5, 0.5 + 2.75);
    expect(b.beat).toBeCloseTo(5.5);
    expect(b.beatIndex).toBe(5);
    expect(b.phase).toBeCloseTo(0.5);
    expect(b.bar).toBe(1);
    expect(b.beatInBar).toBe(1);
  });
});

describe('NoteCursor / visibleNotes', () => {
  const notes: Note[] = [];
  for (let i = 0; i < 100; i++) notes.push({ id: 99 - i, lane: i % 2, time: (99 - i) * 0.5 });
  const chart: Chart = { songId: 's', lanes: 2, notes, bpm: 120, offset: 0, difficulty: DIFFICULTIES.easy, durationSec: 60 };

  it('returns notes within [t - tail, t + lookahead] and advances monotonically', () => {
    const cur = new NoteCursor(chart, 0.5);
    expect(cur.notes[0].id).toBe(0);
    expect(cur.getTail()).toBe(0.5);
    const out: Note[] = [];
    expect(visibleNotes(cur, 0, 2, out).map((n) => n.time)).toEqual([0, 0.5, 1, 1.5, 2]);
    expect(visibleNotes(cur, 10, 1, out)).toBe(out);
    expect(out.map((n) => n.time)).toEqual([9.5, 10, 10.5, 11]);
    expect(cur.getHead()).toBe(19);
    // going backwards (seek) still works
    expect(cur.collect(3, 0.4).map((n) => n.time)).toEqual([2.5, 3]);
    expect(cur.getHead()).toBe(5);
    expect(cur.collect(1000, 1)).toEqual([]);
    expect(cur.getHead()).toBe(100);
    const r = cur.visibleRange(49.5, 5);
    expect(r).toEqual({ start: 98, end: 100 });
  });
  it('accepts a chart directly (spec signature) and keeps a cursor per chart', () => {
    expect(visibleNotes(chart, 10, 1).map((n) => n.time)).toEqual([9.5, 10, 10.5, 11]);
    expect(visibleNotes(chart, 20, 0.6).map((n) => n.time)).toEqual([19.5, 20, 20.5]);
    const other: Chart = { ...chart, notes: [{ id: 0, lane: 0, time: 20 }] };
    expect(visibleNotes(other, 20, 1).map((n) => n.id)).toEqual([0]);
    expect(visibleNotes(chart, 5, 0).map((n) => n.time)).toEqual([4.5, 5]);
  });
});
