// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { DIFFICULTIES } from './difficulty.ts';
import { Judge, validateChartForJudge, validateTimingWindows } from './judge.ts';
import type { NoteState } from './judge.ts';
import type { Chart, HitEvent, Note, TimingWindows } from './types.ts';

function chart(notes: Note[], lanes = 2): Chart {
  return { songId: 's', lanes, notes, bpm: 120, offset: 0, difficulty: DIFFICULTIES.medium, durationSec: 30 };
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
  it('ignores inputs on lanes without candidates, but THROWS for a lane the chart does not have', () => {
    const j = new Judge(chart([{ id: 0, lane: 0, time: 1 }]), W);
    expect(j.onInput(1, 1)).toBeNull(); // lane exists, no note near: ignored, no penalty (rehab rule)
    // a lane outside the chart is a wiring bug (keyboard map / LaneSpec.index off by one). Returning
    // null made every rep on that lane vanish from the score AND the rep count with no signal —
    // the one path that silently lost a rep. It now fails like every other lane-indexed API.
    expect(() => j.onInput(7, 1)).toThrow(/lane 7 out of range \[0, 2\)/);
    expect(() => j.onInput(-1, 1)).toThrow(RangeError);
    expect(() => j.onInputDetailed(7, 1)).toThrow(RangeError);
    expect(() => j.nearestNote(7, 1)).toThrow(RangeError);
    expect(j.getPendingCount()).toBe(1); // nothing was judged by any of that
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
    const j2 = new Judge(chart([{ id: 0, lane: 0, time: 1 }]), W, { latencyOffsetSec: 0.2 });
    expect(j2.getLatencyOffset()).toBe(0.2);
    expect(j2.onInput(0, 1.0)).toBeNull(); // shifted to 0.8 => 200 ms early, outside good
    expect(j2.onInput(0, 1.2)!.deltaMs).toBeCloseTo(0, 6);
  });
});

describe('Judge.onInputDetailed (rejected inputs are ignored for scoring, never lost for metrics)', () => {
  it('reports the distance to the nearest note even when nothing matched', () => {
    const j = new Judge(chart([{ id: 0, lane: 0, time: 1 }, { id: 1, lane: 0, time: 3 }]), W);
    // 300 ms late: no hit (goodMs 140), but the distance to note 0 is still known
    const r = j.onInputDetailed(0, 1.3);
    expect(r.hit).toBeNull();
    expect(r.nearestNoteId).toBe(0);
    expect(r.nearestDeltaMs).toBeCloseTo(300, 6);
    expect(r.time).toBeCloseTo(1.3, 9);
    expect(j.getNoteState(0)).toBe('pending'); // no penalty: the note is untouched
    expect(j.getPendingCount()).toBe(2);
    // early inputs give a negative delta, and the nearest note may be ahead of the input
    const e = j.onInputDetailed(0, 2.4);
    expect(e.hit).toBeNull();
    expect(e.nearestNoteId).toBe(1);
    expect(e.nearestDeltaMs).toBeCloseTo(-600, 6);
  });
  it('measures against the note grid, not against what is still pending', () => {
    // the whole point: a patient 300 ms late arrives after their note was declared a miss.
    // "nearest still-pending note" would report -700 ms (the NEXT note) and hide the calibration error.
    const j = new Judge(chart([{ id: 0, lane: 0, time: 1 }, { id: 1, lane: 0, time: 2 }]), W);
    expect(j.update(1.5).map((e) => e.noteId)).toEqual([0]);
    expect(j.getNoteState(0)).toBe('miss');
    const r = j.onInputDetailed(0, 1.3);
    expect(r.hit).toBeNull();
    expect(r.nearestNoteId).toBe(0);
    expect(r.nearestDeltaMs).toBeCloseTo(300, 6);
    // a hit note is equally valid as a reference point
    expect(j.onInputDetailed(0, 2)!.hit!.noteId).toBe(1);
    expect(j.onInputDetailed(0, 2.3).nearestDeltaMs).toBeCloseTo(300, 6);
  });
  it('matches onInput exactly when a note is in range, and reports the same delta', () => {
    const j = new Judge(chart([{ id: 0, lane: 0, time: 1 }]), W);
    const r = j.onInputDetailed(0, 1.05);
    expect(r.hit).toEqual({ noteId: 0, lane: 0, judgment: 'perfect', deltaMs: expect.closeTo(50, 6), time: 1.05 });
    expect(r.nearestNoteId).toBe(0);
    expect(r.nearestDeltaMs).toBeCloseTo(r.hit!.deltaMs, 9);
  });
  it('nearestDeltaMs is NOT the hit delta when the true nearest note is already judged', () => {
    // documented explicitly because the two numbers must not be conflated: `hit` matches the nearest
    // UNJUDGED note, `nearestDeltaMs` measures the note grid. Attribute a matched input with
    // hit.deltaMs (which is exactly what Scoring does).
    const j = new Judge(chart([{ id: 0, lane: 0, time: 1.0 }, { id: 1, lane: 0, time: 1.1 }]), W);
    expect(j.onInput(0, 1.0)!.noteId).toBe(0);
    const r = j.onInputDetailed(0, 1.04);
    expect(r.hit!.noteId).toBe(1);
    expect(r.hit!.deltaMs).toBeCloseTo(-60, 6);
    expect(r.nearestNoteId).toBe(0);
    expect(r.nearestDeltaMs).toBeCloseTo(40, 6);
  });
  it('reports null distances only for a lane with no notes at all', () => {
    const j = new Judge(chart([{ id: 0, lane: 0, time: 1 }]), W);
    expect(j.onInputDetailed(1, 1).nearestDeltaMs).toBeNull(); // empty lane: exists, holds no notes
    expect(() => j.onInputDetailed(9, 1)).toThrow(RangeError); // lane not in the chart: a bug, not "empty"
    expect(j.nearestNote(1, 1)).toBeNull();
    j.update(100);
    expect(j.onInputDetailed(0, 1).nearestDeltaMs).toBeCloseTo(0, 9); // judged, but still a reference
  });
  it('honours the latency offset', () => {
    const j = new Judge(chart([{ id: 0, lane: 0, time: 1 }, { id: 1, lane: 0, time: 2 }]), W, 0.2);
    expect(j.onInputDetailed(0, 1.2).hit!.judgment).toBe('perfect');
    const r = j.onInputDetailed(0, 1.9); // shifted to 1.7
    expect(r.nearestNoteId).toBe(1);
    expect(r.nearestDeltaMs).toBeCloseTo(-300, 6);
    expect(j.nearestNote(0, 1.9)!.id).toBe(1);
  });
  it('picks the nearest note on either side, ties to the earlier one, and clamps at the ends', () => {
    const j = new Judge(chart([{ id: 0, lane: 0, time: 1 }, { id: 1, lane: 0, time: 3 }]), W);
    expect(j.onInputDetailed(0, 2).nearestNoteId).toBe(0);
    expect(j.onInputDetailed(0, 2.001).nearestNoteId).toBe(1);
    expect(j.onInputDetailed(0, 1.9).nearestNoteId).toBe(0);
    expect(j.nearestNote(0, -50)!.id).toBe(0);
    expect(j.nearestNote(0, 1e6)!.id).toBe(1);
  });
});

describe('Judge validation', () => {
  it('throws on duplicate note ids', () => {
    expect(() => new Judge(chart([{ id: 0, lane: 0, time: 1 }, { id: 0, lane: 1, time: 2 }]), W)).toThrow(/duplicate note id 0/);
  });
  it('throws on lanes outside [0, chart.lanes)', () => {
    expect(() => new Judge(chart([{ id: 0, lane: 2, time: 1 }], 2), W)).toThrow(/lane 2 out of range/);
    expect(() => new Judge(chart([{ id: 0, lane: -1, time: 1 }], 2), W)).toThrow(/out of range/);
    expect(() => new Judge(chart([{ id: 0, lane: 0.5, time: 1 }], 2), W)).toThrow(/out of range/);
    expect(() => validateChartForJudge(chart([{ id: 0, lane: 0, time: Number.NaN }]))).toThrow(/non-finite/);
    expect(() => validateChartForJudge(chart([], 0))).toThrow(/lanes/);
    expect(() => validateChartForJudge(chart([{ id: 0, lane: 0, time: 1 }]))).not.toThrow();
  });
  it('throws on invalid timing windows (perfect > good, non-positive, non-finite)', () => {
    const c = chart([{ id: 0, lane: 0, time: 1 }]);
    expect(() => new Judge(c, { perfectMs: 500, goodMs: 100 })).toThrow(/perfectMs 500 exceeds goodMs 100/);
    expect(() => new Judge(c, { perfectMs: 0, goodMs: 100 })).toThrow(/positive/);
    expect(() => new Judge(c, { perfectMs: -10, goodMs: 100 })).toThrow(/positive/);
    expect(() => new Judge(c, { perfectMs: Number.NaN, goodMs: 100 })).toThrow(/finite/);
    expect(() => new Judge(c, { perfectMs: 50, goodMs: Number.POSITIVE_INFINITY })).toThrow(/finite/);
    expect(() => new Judge(c, [W, { perfectMs: 200, goodMs: 100 }])).toThrow(/lane 1 windows/);
    expect(() => new Judge(c, [])).toThrow(/no timing windows/);
    // a short array used to reuse its last entry for the remaining lanes: a 4-lane chart with two
    // entries silently gave lanes 2-3 the wrong (gross-motor) windows. windowsForLanes throws for a
    // missing index; so must this, or the two contracts disagree.
    const c4 = chart([{ id: 0, lane: 3, time: 1 }], 4);
    expect(() => new Judge(c4, [W, W])).toThrow(/2 timing window\(s\) supplied for a 4-lane chart/);
    expect(() => new Judge(c4, [W, W, W, W, W])).toThrow(/5 timing window\(s\)/);
    expect(() => new Judge(c4, [W, W, W, W])).not.toThrow();
    expect(() => new Judge(c4, W)).not.toThrow(); // one object still means "the same for every lane"
    // and a lane outside the chart has no windows to report
    const j4 = new Judge(c4, [W, W, W, { perfectMs: 112, goodMs: 224 }]);
    expect(j4.getWindows(3).goodMs).toBe(224);
    expect(() => j4.getWindows(4)).toThrow(/lane 4 out of range/);
    expect(() => j4.getWindows(-1)).toThrow(/out of range/);
    expect(() => validateTimingWindows({ perfectMs: 70, goodMs: 70 })).not.toThrow();
    expect(() => validateTimingWindows(undefined as unknown as TimingWindows)).toThrow(/missing/);
    expect(new Judge(c, { perfectMs: 70, goodMs: 70 }).onInput(0, 1.07)!.judgment).toBe('perfect');
  });
  it('pendingCount reaches 0 once every note is judged', () => {
    const notes: Note[] = [];
    for (let i = 0; i < 50; i++) notes.push({ id: i, lane: i % 3, time: i * 0.5 });
    const j = new Judge(chart(notes, 3), W);
    j.onInput(1, 0.5);
    j.update(1e9);
    expect(j.getPendingCount()).toBe(0);
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
  it('orders misses by note time even when per-lane windows differ (fine-motor x1.6 lanes)', () => {
    // lane 0: gross motor 140 ms; lane 1: fine motor 224 ms. Note 1 (lane 1) is earlier but its deadline is later.
    const j = new Judge(chart([{ id: 0, lane: 0, time: 1.1 }, { id: 1, lane: 1, time: 1.05 }, { id: 2, lane: 0, time: 1.2 }]), [W, { perfectMs: 112, goodMs: 224 }]);
    const m = j.update(2);
    expect(m.map((e) => e.noteId)).toEqual([1, 0, 2]);
    expect(m[0].time).toBeCloseTo(1.05 + 0.224, 9);
    expect(m[1].time).toBeCloseTo(1.1 + 0.14, 9);
    expect(m[0].deltaMs).toBe(224);
  });
  it('returned arrays are independent of later updates', () => {
    const j = new Judge(chart([{ id: 0, lane: 0, time: 1 }, { id: 1, lane: 0, time: 2 }]), W);
    const a = j.update(1.5);
    const b = j.update(3);
    expect(a.map((e) => e.noteId)).toEqual([0]);
    expect(b.map((e) => e.noteId)).toEqual([1]);
    expect(j.update(4)).toEqual([]);
    expect(Object.isFrozen(j.update(5))).toBe(true);
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
  it('miss grace: an in-window input delivered after the frame that passed the deadline still hits', () => {
    const noGrace = new Judge(chart([{ id: 0, lane: 0, time: 1 }]), W);
    expect(noGrace.update(1.2).length).toBe(1);
    expect(noGrace.onInput(0, 1.1)).toBeNull(); // camera frame stamped 1.1, delivered at 1.2: lost without grace

    const j = new Judge(chart([{ id: 0, lane: 0, time: 1 }, { id: 1, lane: 0, time: 3 }]), W, { missGraceMs: 100 });
    expect(j.getMissGrace()).toBe(100);
    expect(j.update(1.2)).toEqual([]); // deadline 1.14 + grace 0.1 = 1.24
    expect(j.onInput(0, 1.1)!.judgment).toBe('good');
    expect(j.update(3.239)).toEqual([]);
    const m = j.update(3.24);
    expect(m.length).toBe(1);
    expect(m[0].time).toBeCloseTo(3.14, 9); // miss time is still the nominal deadline
    j.setMissGrace(0);
    expect(j.getMissGrace()).toBe(0);
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
    // an id that is not in the chart reads back as undefined, never as a plausible 'pending' note
    expect(j.getNoteState(999)).toBeUndefined();
    expect(j.hasNote(999)).toBe(false);
    expect(j.hasNote(42)).toBe(true);
  });
});

/* ---------- brute-force reference fuzz ---------- */

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Naive O(n) per-call reference judge with the same semantics. */
class RefJudge {
  readonly state = new Map<number, NoteState>();
  private readonly notes: Note[];
  private readonly windows: TimingWindows[];
  private readonly latency: number;
  private readonly graceSec: number;
  constructor(notes: Note[], windows: TimingWindows[], latency: number, graceSec: number) {
    this.notes = notes;
    this.windows = windows;
    this.latency = latency;
    this.graceSec = graceSec;
    for (const n of notes) this.state.set(n.id, 'pending');
  }
  onInput(lane: number, t0: number): HitEvent | null {
    const t = t0 - this.latency;
    const w = this.windows[lane];
    let best: Note | null = null;
    for (const n of this.notes) {
      if (n.lane !== lane || this.state.get(n.id) !== 'pending') continue;
      const d = Math.abs(n.time - t) * 1000;
      if (d > w.goodMs + 1e-9) continue;
      if (best === null || d < Math.abs(best.time - t) * 1000 - 1e-12 || (Math.abs(Math.abs(best.time - t) * 1000 - d) <= 1e-12 && (n.time < best.time || (n.time === best.time && n.id < best.id)))) best = n;
    }
    if (!best) return null;
    const deltaMs = (t - best.time) * 1000;
    const judgment = Math.abs(deltaMs) <= w.perfectMs + 1e-9 ? 'perfect' : 'good';
    this.state.set(best.id, judgment);
    return { noteId: best.id, lane, judgment, deltaMs, time: t };
  }
  update(u0: number): HitEvent[] {
    const u = u0 - this.latency - this.graceSec;
    const out: { noteTime: number; ev: HitEvent }[] = [];
    for (const n of this.notes) {
      if (this.state.get(n.id) !== 'pending') continue;
      const goodSec = this.windows[n.lane].goodMs / 1000;
      if (n.time + goodSec <= u) {
        this.state.set(n.id, 'miss');
        out.push({ noteTime: n.time, ev: { noteId: n.id, lane: n.lane, judgment: 'miss', deltaMs: this.windows[n.lane].goodMs, time: n.time + goodSec } });
      }
    }
    // ordered by note time (then id), not by deadline
    return out.sort((a, b) => a.noteTime - b.noteTime || a.ev.noteId - b.ev.noteId).map((x) => x.ev);
  }
}

describe('Judge matches a brute-force reference under random interleavings', () => {
  it('random per-lane windows, latency offsets, miss grace, out-of-order inputs, interleaved updates', () => {
    let inputs = 0;
    for (let seed = 1; seed <= 120; seed++) {
      const rand = prng(seed);
      const lanes = 1 + Math.floor(rand() * 4);
      const n = 5 + Math.floor(rand() * 60);
      const notes: Note[] = [];
      const ids = Array.from({ length: n }, (_, i) => i * 3 + 1);
      for (let i = 0; i < n; i++) notes.push({ id: ids[i], lane: Math.floor(rand() * lanes), time: Math.round(rand() * 20 * 100) / 100 });
      const windows: TimingWindows[] = [];
      for (let l = 0; l < lanes; l++) {
        const good = 60 + rand() * 250;
        windows.push({ perfectMs: good * (0.3 + rand() * 0.5), goodMs: good });
      }
      const latency = rand() < 0.3 ? 0 : rand() * 0.3;
      const graceMs = rand() < 0.5 ? 0 : rand() * 150;
      const judge = new Judge({ songId: 'f', lanes, notes: notes.slice().sort(() => rand() - 0.5), bpm: 120, offset: 0, difficulty: DIFFICULTIES.hard, durationSec: 21 }, windows, {
        latencyOffsetSec: latency,
        missGraceMs: graceMs,
      });
      const ref = new RefJudge(notes, windows, latency, graceMs / 1000);
      let frame = 0;
      const steps = 200 + Math.floor(rand() * 300);
      for (let s = 0; s < steps; s++) {
        if (rand() < 0.45) {
          frame += rand() * 0.12;
          const a = judge.update(frame);
          const b = ref.update(frame);
          expect(a).toEqual(b);
        } else {
          // inputs are stamped up to 150 ms before the current frame (capture vs delivery), sometimes near a note
          const near = notes[Math.floor(rand() * n)];
          const t = rand() < 0.5 ? frame - rand() * 0.15 : near.time + (rand() - 0.5) * 0.5 + latency;
          const lane = rand() < 0.9 ? Math.floor(rand() * lanes) : lanes + 1;
          if (lane >= lanes) {
            // a lane the chart does not have is a wiring bug, not an input: it throws, and nothing
            // may be judged as a side effect
            const pendingBefore = judge.getPendingCount();
            expect(() => judge.onInput(lane, t)).toThrow(RangeError);
            expect(() => judge.onInputDetailed(lane, t)).toThrow(RangeError);
            expect(judge.getPendingCount()).toBe(pendingBefore);
            continue;
          }
          inputs++;
          // half the inputs go through onInputDetailed: it must judge identically and, when it
          // rejects, still report the true nearest-unjudged-note distance (brute-forced here)
          let a: HitEvent | null;
          if (rand() < 0.5) {
            let nearest: Note | null = null;
            const shifted = t - latency;
            for (const nt of notes) {
              if (nt.lane !== lane) continue;
              if (nearest === null) {
                nearest = nt;
                continue;
              }
              const d = Math.abs(nt.time - shifted);
              const best = Math.abs(nearest.time - shifted);
              // ties go to the earlier note (then the lower id), matching laneNotes' sort order
              if (d < best - 1e-12 || (Math.abs(d - best) <= 1e-12 && (nt.time < nearest.time || (nt.time === nearest.time && nt.id < nearest.id)))) nearest = nt;
            }
            const det = judge.onInputDetailed(lane, t);
            a = det.hit;
            expect(det.nearestNoteId).toBe(nearest === null ? null : nearest.id);
            expect(det.nearestDeltaMs === null).toBe(nearest === null);
            if (nearest !== null) expect(det.nearestDeltaMs!).toBeCloseTo((shifted - nearest.time) * 1000, 9);
          } else {
            a = judge.onInput(lane, t);
          }
          const b = ref.onInput(lane, t);
          if (a === null || b === null) expect(a).toBe(b);
          else {
            expect(a.noteId).toBe(b.noteId);
            expect(a.judgment).toBe(b.judgment);
            expect(a.deltaMs).toBeCloseTo(b.deltaMs, 9);
          }
        }
      }
      judge.update(1e6);
      ref.update(1e6);
      for (const nt of notes) expect(judge.getNoteState(nt.id)).toBe(ref.state.get(nt.id));
      expect(judge.getPendingCount()).toBe(0);
    }
    expect(inputs).toBeGreaterThan(10000);
  });
});

describe('Judge.setWindows (the therapist window scale is tunable mid-session)', () => {
  it('re-applies windows without discarding note states, the cursor or the score', () => {
    const j = new Judge(chart([{ id: 0, lane: 0, time: 1 }, { id: 1, lane: 0, time: 3 }, { id: 2, lane: 1, time: 3 }]), { perfectMs: 20, goodMs: 40 });
    expect(j.onInput(0, 1.01)!.judgment).toBe('perfect');
    expect(j.onInput(0, 3.08)).toBeNull(); // 80 ms out: outside goodMs 40
    j.setWindows({ perfectMs: 60, goodMs: 120 });
    expect(j.getWindows(0)).toEqual({ perfectMs: 60, goodMs: 120 });
    expect(j.getWindows(1)).toEqual({ perfectMs: 60, goodMs: 120 });
    expect(j.getNoteState(0)).toBe('perfect'); // judged before the change, untouched
    expect(j.getPendingCount()).toBe(2);
    expect(j.onInput(0, 3.08)!.judgment).toBe('good'); // now inside the wider window
  });
  it('takes per-lane windows and one lane at a time', () => {
    const j = new Judge(chart([{ id: 0, lane: 0, time: 1 }, { id: 1, lane: 1, time: 1 }]), W);
    j.setWindows([{ perfectMs: 10, goodMs: 20 }, { perfectMs: 100, goodMs: 200 }]);
    expect(j.getWindows(0).goodMs).toBe(20);
    expect(j.getWindows(1).goodMs).toBe(200);
    j.setLaneWindows(0, { perfectMs: 50, goodMs: 150 });
    expect(j.getWindows(0)).toEqual({ perfectMs: 50, goodMs: 150 });
    expect(j.getWindows(1).goodMs).toBe(200); // untouched
  });
  it('validates the whole set before changing anything', () => {
    const j = new Judge(chart([{ id: 0, lane: 0, time: 1 }]), W);
    expect(() => j.setWindows([W])).toThrow(/1 timing window\(s\) supplied for a 2-lane chart/);
    expect(() => j.setWindows([])).toThrow(/no timing windows/);
    expect(() => j.setWindows([{ perfectMs: 10, goodMs: 20 }, { perfectMs: 300, goodMs: 20 }])).toThrow(/exceeds goodMs/);
    expect(() => j.setWindows({ perfectMs: 0, goodMs: 20 })).toThrow(/positive/);
    expect(() => j.setWindows({ perfectMs: Number.NaN, goodMs: 20 })).toThrow(/finite/);
    expect(() => j.setLaneWindows(4, W)).toThrow(/lane 4 out of range/);
    expect(() => j.setLaneWindows(0, { perfectMs: 30, goodMs: 10 })).toThrow(/exceeds goodMs/);
    // every rejection left the original windows in force (lane 1 would have taken the bad set first)
    expect(j.getWindows(0)).toEqual(W);
    expect(j.getWindows(1)).toEqual(W);
  });
  it('does not alias the caller\'s window objects', () => {
    const mutable = { perfectMs: 60, goodMs: 120 };
    const j = new Judge(chart([{ id: 0, lane: 0, time: 1 }]), W);
    j.setWindows(mutable);
    mutable.goodMs = 9999;
    expect(j.getWindows(0).goodMs).toBe(120);
  });
  it('narrowing the windows can retire a note that is already past its new deadline', () => {
    const j = new Judge(chart([{ id: 0, lane: 0, time: 1 }]), { perfectMs: 200, goodMs: 400 });
    j.update(1.3); // still inside the 400 ms window
    expect(j.getNoteState(0)).toBe('pending');
    j.setWindows({ perfectMs: 20, goodMs: 40 });
    const missed = j.update(1.3);
    expect(missed.map((e) => e.noteId)).toEqual([0]);
    expect(missed[0].deltaMs).toBe(40); // the deadline reported is the one now in force
  });
});
