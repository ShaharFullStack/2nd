// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { DIFFICULTIES } from './difficulty.ts';
import { NoteCursor, SongClock, beatAt, invalidateSortedNotes, visibleNotes } from './scheduler.ts';
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
  it('songTimeOf maps stamps before the pause point while paused, null otherwise', () => {
    const c = new SongClock({ currentTime: 0 });
    expect(c.songTimeOf(1)).toBeNull(); // idle
    c.start(10);
    expect(c.songTimeOf(12)).toBe(2);
    c.pause(12.5);
    expect(c.songTime(13)).toBe(2.5);
    expect(c.songTimeOf(12.4)).toBeCloseTo(2.4, 9); // stamped before the pause, delivered after
    expect(c.songTimeOf(12.5)).toBeCloseTo(2.5, 9);
    expect(c.songTimeOf(12.6)).toBeNull(); // stamped during the pause
    c.resume(20);
    // stamps from inside the pause interval stay rejected after the resume: a movement made while
    // the song was stopped must not be able to claim a note near the pause boundary
    expect(c.songTimeOf(12.6)).toBeNull();
    expect(c.songTimeOf(19.9)).toBeNull();
    expect(c.songTimeOf(12.5)).toBeCloseTo(2.5, 9); // the pause point itself is still valid
    expect(c.songTimeOf(12.4)).toBeCloseTo(2.4, 9);
    expect(c.songTimeOf(20)).toBeCloseTo(2.5, 9); // the resume point is the pause point in song time
    expect(c.songTimeOf(21)).toBeCloseTo(3.5, 9);
    expect(c.songTimeOf(21)).toBeCloseTo(c.songTime(21), 9);
    c.setAvOffset(0.05);
    expect(c.songTimeOf(21)).toBeCloseTo(3.55, 9);
    // ReplayInput round trip: ctxTimeForSongTime then songTime is the identity (the A/V offset cancels)
    expect(c.songTime(c.ctxTimeForSongTime(7.25))).toBeCloseTo(7.25, 9);
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
  it('accepts a chart directly (spec signature), statelessly', () => {
    expect(visibleNotes(chart, 10, 1).map((n) => n.time)).toEqual([9.5, 10, 10.5, 11]);
    expect(visibleNotes(chart, 20, 0.6).map((n) => n.time)).toEqual([19.5, 20, 20.5]);
    const other: Chart = { ...chart, notes: [{ id: 0, lane: 0, time: 20 }] };
    expect(visibleNotes(other, 20, 1).map((n) => n.id)).toEqual([0]);
    expect(visibleNotes(chart, 5, 0).map((n) => n.time)).toEqual([4.5, 5]);
  });
  it('rebuilds the memoised order when the notes array is replaced or grows', () => {
    const mutable: Chart = { ...chart, notes: [{ id: 0, lane: 0, time: 1 }] };
    expect(visibleNotes(mutable, 1, 0).map((n) => n.id)).toEqual([0]);
    mutable.notes = [{ id: 0, lane: 0, time: 1 }, { id: 1, lane: 1, time: 1 }];
    expect(visibleNotes(mutable, 1, 0).map((n) => n.id)).toEqual([0, 1]);
    mutable.notes.push({ id: 2, lane: 0, time: 1 });
    expect(visibleNotes(mutable, 1, 0).map((n) => n.id)).toEqual([0, 1, 2]);
    const cur = new NoteCursor(mutable);
    expect(cur.sourceNotes).toBe(mutable.notes);
  });
  it('two consumers may poll the same chart at different times without disturbing each other', () => {
    // the highway is at song time 40 while a preview strip redraws the opening bar, every frame
    const highway: Note[] = [];
    const preview: Note[] = [];
    for (let frame = 0; frame < 200; frame++) {
      const t = 40 + frame * 0.01;
      visibleNotes(chart, t, 2, highway);
      visibleNotes(chart, 1, 2, preview);
      expect(preview.map((n) => n.time)).toEqual([0.5, 1, 1.5, 2, 2.5, 3]);
      expect(highway[0].time).toBeGreaterThanOrEqual(t - 0.5);
      expect(highway[highway.length - 1].time).toBeLessThanOrEqual(t + 2);
    }
    // and the answer is identical whatever order the calls came in
    const a = visibleNotes(chart, 12.3, 1.5);
    visibleNotes(chart, 0, 1);
    visibleNotes(chart, 49, 1);
    expect(visibleNotes(chart, 12.3, 1.5)).toEqual(a);
  });
  it('does not sort the caller\'s notes array in place', () => {
    const unsorted: Note[] = [{ id: 0, lane: 0, time: 3 }, { id: 1, lane: 0, time: 1 }];
    const c: Chart = { ...chart, notes: unsorted };
    expect(visibleNotes(c, 1, 0).map((n) => n.id)).toEqual([1]);
    expect(unsorted.map((n) => n.id)).toEqual([0, 1]);
  });
  it('notices an endpoint retime and can be invalidated explicitly after an interior edit', () => {
    // the memo is keyed on the notes array object, so an in-place edit is a live footgun for the
    // chart editor / dev tools. Endpoint edits are caught in O(1); interior ones need the escape hatch.
    const notes: Note[] = [
      { id: 0, lane: 0, time: 1 },
      { id: 1, lane: 0, time: 2 },
      { id: 2, lane: 0, time: 3 },
    ];
    const c: Chart = { ...chart, notes };
    expect(visibleNotes(c, 3, 0).map((n) => n.id)).toEqual([2]);
    notes[2].time = 0.5; // last note dragged to the front: detected by the endpoint signature
    expect(visibleNotes(c, 0.5, 0).map((n) => n.id)).toEqual([2]);
    expect(visibleNotes(c, 3, 0).map((n) => n.id)).toEqual([]);
    notes[2] = { id: 2, lane: 0, time: 9 }; // replaced note object: also detected
    expect(visibleNotes(c, 9, 0).map((n) => n.id)).toEqual([2]);
    // an interior edit that breaks the order is invisible to an O(1) check — the documented
    // escape hatch fixes it
    notes[1].time = 0.1;
    expect(visibleNotes(c, 0.1, 0).map((n) => n.id)).toEqual([]); // stale, as documented
    invalidateSortedNotes(c);
    expect(visibleNotes(c, 0.1, 0).map((n) => n.id)).toEqual([1]);
    invalidateSortedNotes(notes); // also accepts the array itself
    expect(visibleNotes(c, 0.1, 0).map((n) => n.id)).toEqual([1]);
  });
});
