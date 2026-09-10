// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { generateChart } from '../charts/generate.ts';
import { DIFFICULTIES } from './difficulty.ts';
import { DEFAULT_MISS_GRACE_MS } from './judge.ts';
import { RhythmEngine } from './rhythm.ts';
import type { Chart, DifficultyName } from './types.ts';

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
    expect(eng.scoring.getLatencyOffsetMs()).toBe(200); // one knob, both consumers
  });
  it('surfaces the miss grace the renderer has to account for', () => {
    const ctx = { currentTime: 0 };
    // the default is NOT the spec-exact 0: note states and misses lag the audible deadline by it,
    // which the note highway must know rather than discovering it as a late-flashing miss
    const eng = new RhythmEngine({ chart, windows: W, ctx });
    expect(eng.getMissGraceMs()).toBe(DEFAULT_MISS_GRACE_MS);
    eng.start(0);
    ctx.currentTime = 1.2; // note 0 deadline is 1.14
    expect(eng.tick().misses).toEqual([]);
    expect(eng.judge.getNoteState(0)).toBe('pending');
    ctx.currentTime = 1.1401 + DEFAULT_MISS_GRACE_MS / 1000;
    expect(eng.tick().misses.map((m) => m.noteId)).toEqual([0]);
    // a keyboard/replay source has no delivery delay: turn it off and the deadline is exact
    const exact = new RhythmEngine({ chart, windows: W, ctx: { currentTime: 0 }, missGraceMs: 0 });
    expect(exact.getMissGraceMs()).toBe(0);
    exact.start(0);
    expect(exact.tick(1.139).misses).toEqual([]);
    expect(exact.tick(1.1401).misses.map((m) => m.noteId)).toEqual([0]);
    exact.setMissGraceMs(50);
    expect(exact.getMissGraceMs()).toBe(50);
  });
  it('judges inputs stamped before a pause but delivered after it; ignores stamps from inside the pause', () => {
    const ctx = { currentTime: 0 };
    const eng = new RhythmEngine({ chart, windows: W, ctx });
    eng.start(0);
    ctx.currentTime = 1.02;
    eng.pause(1.02);
    // camera crossing at ctx 1.0 (note 0 at song time 1), delivered 100 ms later while paused
    const hit = eng.handleInput({ lane: 0, ctxTime: 1.0, strength: 1 })!;
    expect(hit.judgment).toBe('perfect');
    expect(eng.getScoreState().hits).toBe(1);
    // a movement made during the pause is not judged
    expect(eng.handleInput({ lane: 1, ctxTime: 1.5, strength: 1 })).toBeNull();
    eng.resume(5);
    ctx.currentTime = 5.5; // song time 1.52
    expect(eng.handleInput({ lane: 1, ctxTime: 5.48, strength: 1 })!.noteId).toBe(1);
    eng.stop();
    expect(eng.handleInput({ lane: 0, ctxTime: 6, strength: 1 })).toBeNull();
  });
});

/**
 * The mis-calibrated session. 180 ms sits squarely inside the 80–200 ms camera-latency band
 * docs/ARCHITECTURE.md documents, so "the therapist entered no offset" is an ordinary mistake, not
 * an exotic one. The patient performs every rep correctly and lands outside every good window.
 */
describe('a patient whose latency offset is 180 ms out', () => {
  const LATE = 0.18;

  function playPerfectlyLate(difficulty: DifficultyName, latencySec: number) {
    const chartN = generateChart({ id: 'demo', bpm: 120, offset: 0, durationSec: 120 }, 2, difficulty, 7);
    const windows = DIFFICULTIES[difficulty].windows;
    const ctx = { currentTime: 0 };
    const eng = new RhythmEngine({ chart: chartN, windows, ctx, inputLatencySec: latencySec, missGraceMs: 0 });
    eng.start(0);
    // one input per note, every one exactly LATE seconds after the note (a constant pipeline lag)
    let next = 0;
    for (let frame = 0; frame * (1 / 60) < 125; frame++) {
      const t = frame / 60;
      ctx.currentTime = t;
      while (next < chartN.notes.length && chartN.notes[next].time + LATE <= t) {
        const n = chartN.notes[next++];
        eng.handleInput({ lane: n.lane, ctxTime: n.time + LATE, strength: 1 });
      }
      eng.tick();
    }
    return { eng, chart: chartN, state: eng.getScoreResults() };
  }

  it('reports the reps performed and the true timing bias instead of an empty session', () => {
    for (const d of ['medium', 'hard'] as const) {
      const { chart: c, state, eng } = playPerfectlyLate(d, 0);
      // the scoring verdict is unchanged (and harsh): nothing landed inside the good window
      expect(state.hits).toBe(0);
      expect(state.misses).toBe(c.notes.length);
      expect(state.accuracy).toBe(0);
      // ...but the session is no longer indistinguishable from a patient who never moved
      expect(state.reps, d).toBe(c.notes.length);
      expect(state.unmatched).toBe(c.notes.length);
      expect(state.timingBiasMs!, d).toBeCloseTo(LATE * 1000, 3);
      expect(state.timingBiasMadMs!).toBeCloseTo(0, 6);
      for (const lane of state.lanes) {
        expect(lane.reps).toBeGreaterThan(0);
        expect(lane.timingBiasMs!).toBeCloseTo(LATE * 1000, 3);
      }
      // and the engine can name the fix
      const suggestion = eng.suggestedInputLatency()!;
      expect(suggestion.sec).toBeCloseTo(LATE, 4);
      expect(suggestion.adjustmentSec).toBeCloseTo(LATE, 4);
      expect(suggestion.estimate.confident).toBe(true);
    }
  });

  it('the suggested offset, applied, turns the same performance into a full-marks session', () => {
    const bad = playPerfectlyLate('medium', 0);
    const fixed = playPerfectlyLate('medium', bad.eng.suggestedInputLatency()!.sec);
    expect(fixed.state.hits).toBe(fixed.chart.notes.length);
    expect(fixed.state.misses).toBe(0);
    expect(fixed.state.unmatched).toBe(0);
    expect(fixed.state.reps).toBe(fixed.chart.notes.length);
    expect(fixed.state.stars).toBe(5);
    expect(fixed.state.health).toBe(1);
    expect(fixed.state.timingBiasMs!).toBeCloseTo(0, 3);
  });

  it('applying the calibration mid-session rebases the bias instead of leaving it bimodal', () => {
    // 24 s at a 150 ms uncalibrated offset, then the suggestion is applied and the rest is perfect.
    const LATE_2 = 0.15;
    const chartN = generateChart({ id: 'demo', bpm: 120, offset: 0, durationSec: 120 }, 2, 'medium', 7);
    const ctx = { currentTime: 0 };
    const eng = new RhythmEngine({ chart: chartN, windows: W, ctx, inputLatencySec: 0, missGraceMs: 0 });
    eng.start(0);
    let next = 0;
    let applied = false;
    for (let frame = 0; frame / 60 < 125; frame++) {
      const t = frame / 60;
      ctx.currentTime = t;
      while (next < chartN.notes.length && chartN.notes[next].time + LATE_2 <= t) {
        const n = chartN.notes[next++];
        eng.handleInput({ lane: n.lane, ctxTime: n.time + LATE_2, strength: 1 });
      }
      eng.tick();
      if (!applied && t >= 24) {
        const s = eng.suggestedInputLatency()!;
        expect(s.sec).toBeCloseTo(LATE_2, 3);
        eng.setInputLatency(s.sec);
        applied = true;
      }
    }
    expect(applied).toBe(true);
    const r = eng.getScoreResults();
    // the patient was on time throughout: the clinical number must say so, not the 75 ms mean of
    // "before" and "after" the correction
    expect(r.timingBiasMs!).toBeCloseTo(0, 3);
    expect(r.timingBiasMadMs!).toBeCloseTo(0, 3);
    expect(r.reps).toBe(chartN.notes.length);
    // everything after the correction was judged, and the suggestion has converged to "no change"
    expect(r.hits).toBeGreaterThan(chartN.notes.length * 0.7);
    const after = eng.suggestedInputLatency()!;
    expect(after.adjustmentSec).toBeCloseTo(0, 3);
    expect(after.sec).toBeCloseTo(LATE_2, 3);
  });

  it('extra and involuntary movements are counted as reps but never scored against the patient', () => {
    const ctx = { currentTime: 0 };
    const eng = new RhythmEngine({ chart, windows: W, ctx });
    eng.start(0);
    const clean = new RhythmEngine({ chart, windows: W, ctx: { currentTime: 0 } });
    clean.start(0);
    for (const t of [0.2, 0.35, 0.5, 3.9, 4.5]) {
      ctx.currentTime = t;
      expect(eng.handleInput({ lane: 0, ctxTime: t, strength: 1 })).toBeNull();
    }
    ctx.currentTime = 5;
    eng.tick();
    clean.tick(5);
    const a = eng.getScoreState();
    const b = clean.getScoreState();
    expect(a.score).toBe(b.score);
    expect(a.health).toBe(b.health);
    expect(a.misses).toBe(b.misses);
    expect(a.combo).toBe(b.combo);
    expect(a.unmatched).toBe(5);
    expect(b.unmatched).toBe(0);
    expect(a.reps).toBe(5);
  });

  it('suggestedInputLatency stays silent until there is data and when the bias is not consistent', () => {
    const ctx = { currentTime: 0 };
    const eng = new RhythmEngine({ chart, windows: W, ctx });
    expect(eng.suggestedInputLatency()).toBeNull(); // no inputs yet
    eng.start(0);
    eng.handleInput({ lane: 0, ctxTime: 1.5, strength: 1 });
    expect(eng.suggestedInputLatency()).toBeNull(); // one sample is not an estimate
    const erratic = new RhythmEngine({ chart, windows: W, ctx: { currentTime: 0 } });
    erratic.start(0);
    for (const [lane, t] of [[0, 1.5], [1, 2.1], [0, 2.6], [1, 3.1], [0, 3.6], [1, 4.1]] as const) {
      erratic.handleInput({ lane, ctxTime: t, strength: 1 });
    }
    const s = erratic.suggestedInputLatency();
    expect(s === null || s.estimate.madSec > 0).toBe(true);
  });

  it('handleInputDetailed exposes the same numbers as handleInput plus the near miss', () => {
    const ctx = { currentTime: 0 };
    const eng = new RhythmEngine({ chart, windows: W, ctx });
    eng.start(0);
    const r = eng.handleInputDetailed({ lane: 0, ctxTime: 1.3, strength: 1 })!;
    expect(r.hit).toBeNull();
    expect(r.nearestNoteId).toBe(0);
    expect(r.nearestDeltaMs).toBeCloseTo(300, 6);
    expect(eng.getScoreState().unmatched).toBe(1);
    expect(eng.handleInputDetailed({ lane: 0, ctxTime: 99, strength: 1 })!.nearestNoteId).toBe(2);
    eng.stop();
    expect(eng.handleInputDetailed({ lane: 0, ctxTime: 1, strength: 1 })).toBeNull();
  });
});

describe('RhythmEngine: the advertised calibration workflow leaves ONE timeline behind', () => {
  /** A long chart of one note per half second in each lane, so a whole session can be played. */
  function longChart(lanes = 2, n = 40): Chart {
    const notes: Chart['notes'] = [];
    for (let i = 0; i < n; i++) notes.push({ id: i, lane: i % lanes, time: 1 + i * 0.5 });
    return { songId: 'long', lanes, bpm: 120, offset: 0, difficulty: DIFFICULTIES.easy, durationSec: n * 0.5 + 4, notes };
  }

  it('suggestedInputLatency -> setInputLatency: mean/std and median/MAD all agree afterwards', () => {
    // The exact scenario the module recommends: play badly calibrated, apply the suggestion, play on.
    const ctx = { currentTime: 0 };
    const c = longChart();
    const eng = new RhythmEngine({ chart: c, windows: { perfectMs: 90, goodMs: 180 }, ctx, missGraceMs: 0 });
    eng.start(0);
    // 20 reps, every one of them 150 ms after its note (a camera pipeline nobody calibrated)
    for (let i = 0; i < 20; i++) {
      eng.tick(c.notes[i].time + 0.15);
      eng.handleInput({ lane: c.notes[i].lane, ctxTime: c.notes[i].time + 0.15, strength: 1 });
    }
    const before = eng.getScoreState();
    expect(before.meanDeltaMs).toBeCloseTo(150, 6);
    const suggestion = eng.suggestedInputLatency()!;
    expect(suggestion).not.toBeNull();
    expect(suggestion.sec).toBeCloseTo(0.15, 3);

    eng.setInputLatency(suggestion.sec);
    // the remaining reps are performed dead on the note, observed 150 ms later by the same camera
    for (let i = 20; i < 40; i++) {
      eng.tick(c.notes[i].time + 0.15);
      eng.handleInput({ lane: c.notes[i].lane, ctxTime: c.notes[i].time + 0.15, strength: 1 });
    }
    const st = eng.getScoreState();
    // the whole session is one timeline: 0 bias and 0 variability, NOT 75/75
    expect(st.meanDeltaMs).toBeCloseTo(0, 3);
    expect(st.stdDeltaMs).toBeCloseTo(0, 3);
    expect(st.hits).toBe(40);
    const results = eng.getScoreResults();
    expect(results.timingBiasMs!).toBeCloseTo(0, 3);
    expect(results.timingBiasMadMs!).toBeCloseTo(0, 3);
    for (const l of results.lanes) {
      expect(l.meanDeltaMs).toBeCloseTo(0, 3);
      expect(l.stdDeltaMs).toBeCloseTo(0, 3);
      // the two estimators a Results screen may render side by side must not disagree
      expect(Math.abs(l.meanDeltaMs - l.timingBiasMs!)).toBeLessThan(1);
    }
  });

  it('counts an input on a lane the chart does not have instead of dropping it', () => {
    const ctx = { currentTime: 0 };
    const eng = new RhythmEngine({ chart, windows: W, ctx });
    eng.start(0);
    // a mis-wired keyboard map / LaneSpec.index off by one: it must not throw out of the input
    // callback (that kills the session) and must not vanish (a rep performed is never lost)
    const r = eng.handleInputDetailed({ lane: 5, ctxTime: 1, strength: 1 })!;
    expect(r.hit).toBeNull();
    expect(r.lane).toBe(5);
    expect(r.nearestNoteId).toBeNull();
    expect(eng.handleInput({ lane: -1, ctxTime: 1.1, strength: 1 })).toBeNull();
    expect(eng.handleInput({ lane: 1.5, ctxTime: 1.2, strength: 1 })).toBeNull();
    const st = eng.getScoreState();
    expect(st.outOfRange).toBe(3);
    expect(st.unmatched).toBe(0); // not misattributed to a real lane either
    expect(st.reps).toBe(0);
    expect(st.score).toBe(0);
    expect(st.health).toBe(0.5); // never penalised
    expect(eng.scoring.getLastOutOfRangeLane()).toBe(1.5);
    // and the bare Judge still throws for the same lane, so the bug is loud where it is a bug
    expect(() => eng.judge.onInput(5, 1)).toThrow(RangeError);
  });

  it('a therapist window scale can be re-applied mid-session without losing the run', () => {
    const ctx = { currentTime: 0 };
    const eng = new RhythmEngine({ chart, windows: { perfectMs: 20, goodMs: 40 }, ctx, missGraceMs: 0 });
    eng.start(0);
    eng.handleInput({ lane: 0, ctxTime: 1, strength: 1 }); // note 0: perfect on the tight windows
    expect(eng.getScoreState().hits).toBe(1);
    // note 1 at 1.5 is 80 ms away: rejected at goodMs 40, accepted after the therapist widens to 3x
    expect(eng.handleInput({ lane: 1, ctxTime: 1.58, strength: 1 })).toBeNull();
    eng.setWindows([{ perfectMs: 60, goodMs: 120 }, { perfectMs: 60, goodMs: 120 }]);
    expect(eng.getWindows(1).goodMs).toBe(120);
    expect(eng.handleInput({ lane: 1, ctxTime: 1.58, strength: 1 })!.judgment).toBe('good');
    // everything judged before the change is untouched: score, combo and note states all survive
    expect(eng.judge.getNoteState(0)).toBe('perfect');
    expect(eng.getScoreState().hits).toBe(2);
    expect(eng.getScoreState().combo).toBe(2);
    // an invalid set is rejected whole, leaving the session on the windows it had
    expect(() => eng.setWindows([{ perfectMs: 200, goodMs: 120 }, { perfectMs: 60, goodMs: 120 }])).toThrow(RangeError);
    expect(() => eng.setWindows([{ perfectMs: 60, goodMs: 120 }])).toThrow(/1 timing window/);
    expect(eng.getWindows(0).goodMs).toBe(120);
  });
});
