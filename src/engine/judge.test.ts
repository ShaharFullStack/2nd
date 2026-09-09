import { describe, expect, it } from 'vitest';
import { DIFFICULTIES } from './difficulty.ts';
import { Judge } from './judge.ts';
import type { Chart, Note } from './types.ts';

function chart(notes: Note[], lanes = 2): Chart {
  return { songId: 's', lanes, notes, bpm: 120, offset: 0, difficulty: DIFFICULTIES.medium, durationSec: 30, };
}
const W = { perfectMs: 70, goodMs: 140 };

describe('Judge.onInput', () => {
  it('judges perfect / good / none by distance', () => {
    const j = new Judge(chart([{ id: 0, lane: 0, time: 1 }]), W);
    expect(j.onInput(0, 1.5)).toBeNull(); // too late
    expect(j.getNoteState(0)).toBe('pending');
    const hit = j.onInput(0, 1.05);
    expect(hit).toEqual({ noteId: 0, lane: 0, judgment: 'perfect', deltaMs: expect.closeTo(50, 6), time: 1.05 });
    expect(j.getNoteState(0)).toBe('perfect');
    expect(j.onInput(0, 1.0)).toBeNull(); // already judged
  });
  it('good on the far side of perfect, early inputs give negative delta', () => {
    const j = new Judge(chart([{ id: 0, lane: 0, time: 1 }]), W);
    const hit = j.onInput(0, 0.9)!;
    expect(hit.judgment).toBe('good');
    expect(hit.deltaMs).toBeCloseTo(-100, 6);
    expect(j.getNoteState(0)).toBe('good');
  });
  it('window edges are inclusive', () => {
    const j = new Judge(chart([{ id: 0, lane: 0, time: 1 }, { id: 1, lane: 0, time: 3 }, { id: 2, lane: 0, time: 5 }]), W);
    expect(j.onInput(0, 1.07)!.judgment).toBe('perfect');
    expect(j.onInput(0, 3.14)!.judgment).toBe('good');
    expect(j.onInput(0, 5.1401)).toBeNull();
    expect(j.onInput(0, 4.86)!.judgment).toBe('good');
  });
  it('ignores inputs on lanes without candidates and unknown lanes', () => {
    const j = new Judge(chart([{ id: 0, lane: 0, time: 1 }]), W);
    expect(j.onInput(1, 1)).toBeNull();
    expect(j.onInput(7, 1)).toBeNull();
    expect(j.onInput(0, 1)!.judgment).toBe('perfect');
  });
  it('picks the nearest pending note when two are in range', () => {
    const j = new Judge(chart([{ id: 0, lane: 0, time: 1.0 }, { id: 1, lane: 0, time: 1.2 }]), W);
    expect(j.onInput(0, 1.12)!.noteId).toBe(1);
    expect(j.onInput(0, 1.12)!.noteId).toBe(0); // second input goes to the remaining one
    expect(j.getPendingCount()).toBe(0);
  });
  it('uses per-lane windows', () => {
    const j = new Judge(chart([{ id: 0, lane: 0, time: 1 }, { id: 1, lane: 1, time: 1 }]), [W, { perfectMs: 112, goodMs: 224 }]);
    expect(j.onInput(0, 1.2)).toBeNull();
    expect(j.onInput(1, 1.2)!.judgment).toBe('good');
    expect(j.onInput(1, 1.1)).toBeNull();
    expect(j.getWindows(1).goodMs).toBe(224);
  });
  it('applies the latency offset (input observed later than it happened)', () => {
    const j = new Judge(chart([{ id: 0, lane: 0, time: 1 }]), W, 0.12);
    // observed at 1.12 -> actually happened at 1.0
    const hit = j.onInput(0, 1.12)!;
    expect(hit.judgment).toBe('perfect');
    expect(hit.deltaMs).toBeCloseTo(0, 6);
    expect(hit.time).toBeCloseTo(1.0, 9);
    const j2 = new Judge(chart([{ id: 0, lane: 0, time: 1 }]), W);
    j2.setLatencyOffset(0.2);
    expect(j2.onInput(0, 1.0)).toBeNull(); // shifted to 0.8 => 200 ms early, outside good
    expect(j2.onInput(0, 1.2)!.deltaMs).toBeCloseTo(0, 6);
  });
});

describe('Judge.update', () => {
  it('reports misses once goodMs has elapsed, ordered by time across lanes', () => {
    const j = new Judge(chart([{ id: 0, lane: 1, time: 1.0 }, { id: 1, lane: 0, time: 1.05 }, { id: 2, lane: 0, time: 2 }]), W);
    expect(j.update(1.1)).toEqual([]);
    expect(j.update(1.139)).toEqual([]);
    const m = j.update(1.2);
    expect(m.map((e) => e.noteId)).toEqual([0, 1]);
    expect(m[0]).toMatchObject({ lane: 1, judgment: 'miss', deltaMs: 140 });
    expect(m[0].time).toBeCloseTo(1.14, 9);
    expect(j.getNoteState(0)).toBe('miss');
    expect(j.getNoteState(2)).toBe('pending');
    expect(j.update(1.3)).toEqual([]);
    expect(j.update(10).map((e) => e.noteId)).toEqual([2]);
    expect(j.getPendingCount()).toBe(0);
  });
  it('does not miss notes that were hit, and skips judged notes when advancing', () => {
    const j = new Judge(chart([{ id: 0, lane: 0, time: 1 }, { id: 1, lane: 0, time: 1.5 }, { id: 2, lane: 0, time: 2 }]), W);
    expect(j.onInput(0, 1.5)!.noteId).toBe(1);
    expect(j.update(3).map((e) => e.noteId)).toEqual([0, 2]);
    expect(j.getNoteState(1)).toBe('perfect');
  });
  it('miss timeline honours latency offset', () => {
    const j = new Judge(chart([{ id: 0, lane: 0, time: 1 }]), W, 0.1);
    expect(j.update(1.2)).toEqual([]); // shifted time 1.1 < 1.14
    expect(j.update(1.25).length).toBe(1);
  });
  it('a late input after a miss is ignored; reset restores pending', () => {
    const j = new Judge(chart([{ id: 0, lane: 0, time: 1 }]), W);
    j.update(2);
    expect(j.onInput(0, 1.1)).toBeNull();
    j.reset();
    expect(j.getNoteState(0)).toBe('pending');
    expect(j.getPendingCount()).toBe(1);
    expect(j.onInput(0, 1.1)!.judgment).toBe('good');
  });
  it('works with unsorted notes and non-sequential ids', () => {
    const j = new Judge(chart([{ id: 42, lane: 0, time: 3 }, { id: 7, lane: 0, time: 1 }]), W);
    expect(j.onInput(0, 1)!.noteId).toBe(7);
    expect(j.update(5).map((e) => e.noteId)).toEqual([42]);
    expect(j.getNoteState(999)).toBe('pending');
  });
});
