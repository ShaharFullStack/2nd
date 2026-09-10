// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { GOOD_STAR_WEIGHT, HEALTH_START, MAX_DELTA_SAMPLES, Scoring, multiplierForCombo, starAccuracyOf, starsForAccuracy } from './scoring.ts';
import type { HitEvent, Judgment } from './types.ts';

function ev(judgment: Judgment, lane = 0, deltaMs = 0): HitEvent {
  return { noteId: 0, lane, judgment, deltaMs, time: 0 };
}

describe('multiplierForCombo', () => {
  it('steps at 0/10/20/30', () => {
    expect([0, 9, 10, 19, 20, 29, 30, 100].map(multiplierForCombo)).toEqual([1, 1, 2, 2, 3, 3, 4, 4]);
  });
});

describe('Scoring', () => {
  it('scores perfect=100 good=50 with combo multiplier', () => {
    const s = new Scoring(2, 40);
    let expected = 0;
    for (let i = 0; i < 35; i++) {
      const mult = multiplierForCombo(i);
      const d = s.apply(ev(i % 2 === 0 ? 'perfect' : 'good'));
      const pts = (i % 2 === 0 ? 100 : 50) * mult;
      expect(d.points).toBe(pts);
      expected += pts;
    }
    const st = s.getState();
    expect(st.score).toBe(expected);
    expect(st.combo).toBe(35);
    expect(st.multiplier).toBe(4);
    expect(st.maxCombo).toBe(35);
    expect(st.totalNotes).toBe(40);
    // 10th hit (combo 9 before) still 1x, 11th gets 2x
    const s2 = new Scoring(1);
    for (let i = 0; i < 10; i++) expect(s2.apply(ev('perfect')).points).toBe(100);
    expect(s2.apply(ev('perfect')).points).toBe(200);
  });
  it('miss resets combo but keeps maxCombo; health clamps and never fails', () => {
    const s = new Scoring(1);
    expect(s.getHealth()).toBe(HEALTH_START);
    for (let i = 0; i < 12; i++) s.apply(ev('perfect'));
    expect(s.getMultiplier()).toBe(2);
    expect(s.getHealth()).toBeCloseTo(0.74, 9);
    const d = s.apply(ev('miss'));
    expect(d.points).toBe(0);
    expect(d.combo).toBe(0);
    expect(d.multiplier).toBe(1);
    expect(s.getHealth()).toBeCloseTo(0.71, 9);
    expect(s.getState().maxCombo).toBe(12);
    for (let i = 0; i < 100; i++) s.apply(ev('miss'));
    expect(s.getHealth()).toBe(0);
    for (let i = 0; i < 100; i++) s.apply(ev('good'));
    expect(s.getHealth()).toBe(1);
  });
  it('tracks per-lane stats, accuracy and timing bias', () => {
    const s = new Scoring(2);
    s.apply(ev('perfect', 0, 10));
    s.apply(ev('good', 0, 30));
    s.apply(ev('miss', 0));
    s.apply(ev('perfect', 1, -20));
    const st = s.getState();
    expect(st.lanes[0]).toMatchObject({ lane: 0, hits: 2, perfects: 1, goods: 1, misses: 1, judged: 3 });
    expect(st.lanes[0].accuracy).toBeCloseTo(2 / 3);
    expect(st.lanes[0].weightedAccuracy).toBeCloseTo(1.5 / 3);
    expect(st.lanes[0].meanDeltaMs).toBeCloseTo(20);
    expect(st.lanes[0].stdDeltaMs).toBeCloseTo(10);
    expect(st.lanes[1]).toMatchObject({ hits: 1, misses: 0, accuracy: 1, meanDeltaMs: -20, stdDeltaMs: 0 });
    expect(st.hits).toBe(3);
    expect(st.misses).toBe(1);
    expect(st.accuracy).toBeCloseTo(0.75);
    expect(st.meanDeltaMs).toBeCloseTo(20 / 3);
    expect(st.starAccuracy).toBeCloseTo((2 + 0.75) / 4);
    expect(st.stars).toBe(2);
    expect(JSON.parse(JSON.stringify(st))).toEqual(st); // plain snapshot
    s.reset();
    expect(s.getState()).toMatchObject({ score: 0, combo: 0, hits: 0, misses: 0, health: HEALTH_START, accuracy: 0 });
  });
  it('rejects out-of-range lanes instead of misattributing them', () => {
    const s = new Scoring(2);
    expect(s.getLaneCount()).toBe(2);
    expect(() => s.apply(ev('perfect', 2))).toThrow(/lane 2 out of range/);
    expect(() => s.apply(ev('miss', -1))).toThrow(RangeError);
    expect(s.getState().hits).toBe(0);
  });
  it('star rating', () => {
    expect([0, 0.2, 0.25, 0.5, 0.7, 0.85, 0.95, 1, Number.NaN].map(starsForAccuracy)).toEqual([0, 0, 1, 2, 3, 4, 5, 5, 0]);
    expect(GOOD_STAR_WEIGHT).toBe(0.75);
    expect(starAccuracyOf(0, 0, 0)).toBe(0);
  });
  it('stars reward timing: all-perfect is 5, all-good is 3, a miss-free run of mostly goods is not 5', () => {
    const perfect = new Scoring(1);
    for (let i = 0; i < 20; i++) perfect.apply(ev('perfect'));
    expect(perfect.getState().stars).toBe(5);
    const good = new Scoring(1);
    for (let i = 0; i < 20; i++) good.apply(ev('good'));
    expect(good.getState().accuracy).toBe(1);
    expect(good.getState().starAccuracy).toBeCloseTo(0.75);
    expect(good.getState().stars).toBe(3);
    const mixed = new Scoring(1);
    for (let i = 0; i < 20; i++) mixed.apply(ev(i < 4 ? 'perfect' : 'good'));
    expect(mixed.getState().stars).toBe(3); // (4 + 12) / 20 = 0.8
    const strong = new Scoring(1);
    for (let i = 0; i < 20; i++) strong.apply(ev(i < 18 ? 'perfect' : 'miss'));
    expect(strong.getState().stars).toBe(4); // 0.9
  });
});

describe('Scoring: unmatched inputs (rehab metrics that survive the good window)', () => {
  it('counts reps and an uncensored timing bias without ever penalising the patient', () => {
    const s = new Scoring(2, 10);
    s.apply(ev('perfect', 0, 10));
    const before = s.getState();
    for (let i = 0; i < 6; i++) s.recordUnmatchedInput(0, 180 + i);
    const st = s.getResults();
    // no penalty: score, combo, health and accuracy are exactly as before
    expect(st.score).toBe(before.score);
    expect(st.combo).toBe(before.combo);
    expect(st.health).toBe(before.health);
    expect(st.accuracy).toBe(before.accuracy);
    expect(st.judged).toBe(before.judged);
    // but the reps happened and the bias is visible
    expect(st.unmatched).toBe(6);
    expect(st.reps).toBe(7);
    expect(st.lanes[0].reps).toBe(7);
    expect(st.lanes[1].reps).toBe(0);
    expect(st.timingBiasSamples).toBe(7);
    expect(st.timingBiasMs).toBeCloseTo(182, 6); // median of [10,180,181,182,183,184,185]
    expect(st.lanes[0].timingBiasMs).toBeCloseTo(182, 6);
    expect(st.lanes[1].timingBiasMs).toBeNull();
    expect(st.lanes[1].timingBiasMadMs).toBeNull();
    // the same numbers are reachable without building the whole results object
    expect(s.getTimingBias().timingBiasMs).toBeCloseTo(182, 6);
    expect(s.getTimingBias(0).timingBiasMs).toBeCloseTo(182, 6);
    expect(s.getTimingBias(1)).toEqual({ timingBiasMs: null, timingBiasMadMs: null, timingBiasSamples: 0 });
    expect(s.getTimingBias(9).timingBiasSamples).toBe(0);
  });
  it('accepts inputs with no nearest note (still a rep, no timing sample) and rejects bad lanes', () => {
    const s = new Scoring(2);
    s.recordUnmatchedInput(1, null);
    expect(s.getReps(1)).toBe(1);
    expect(s.getUnmatchedCount(1)).toBe(1);
    expect(s.getResults().timingBiasSamples).toBe(0);
    expect(s.getResults().timingBiasMs).toBeNull();
    expect(s.getNearestDeltaSamplesMs(1)).toEqual([]);
    expect(() => s.recordUnmatchedInput(5, 0)).toThrow(/lane 5 out of range/);
    expect(() => s.recordUnmatchedInput(-1, 0)).toThrow(/out of range/);
  });
  it('samples are copies, pooled across lanes, and cleared by reset', () => {
    const s = new Scoring(2);
    s.recordUnmatchedInput(0, 100);
    s.recordUnmatchedInput(1, -50);
    expect(s.getNearestDeltaSamplesMs().sort((a, b) => a - b)).toEqual([-50, 100]);
    expect(s.getNearestDeltaSamplesMs(0)).toEqual([100]);
    s.getNearestDeltaSamplesMs(0).push(999);
    expect(s.getNearestDeltaSamplesMs(0)).toEqual([100]);
    s.reset();
    expect(s.getReps()).toBe(0);
    expect(s.getState().unmatched).toBe(0);
    expect(s.getResults().timingBiasMs).toBeNull();
    expect(s.getNearestDeltaSamplesMs()).toEqual([]);
  });
  it('caps the sample pool, keeping the MOST RECENT samples so a long session stays current', () => {
    const s = new Scoring(1);
    for (let i = 0; i < MAX_DELTA_SAMPLES; i++) s.recordUnmatchedInput(0, 100);
    expect(s.getResults().timingBiasMs).toBe(100);
    // the patient's timing changes for the rest of the session: the bias must follow it
    for (let i = 0; i < MAX_DELTA_SAMPLES + 500; i++) s.recordUnmatchedInput(0, -40);
    const samples = s.getNearestDeltaSamplesMs(0);
    expect(samples).toHaveLength(MAX_DELTA_SAMPLES);
    expect(samples.every((x) => x === -40)).toBe(true); // the opening is gone, not frozen in
    expect(s.getResults().timingBiasMs).toBe(-40);
    expect(s.getReps(0)).toBe(2 * MAX_DELTA_SAMPLES + 500); // the rep count is never capped
    // half-full ring: samples come back in chronological order
    const t = new Scoring(1);
    for (let i = 0; i < 5; i++) t.recordUnmatchedInput(0, i);
    expect(t.getNearestDeltaSamplesMs(0)).toEqual([0, 1, 2, 3, 4]);
  });
});

describe('Scoring: the latency timeline the samples live on', () => {
  it('rebases the sample pool when the calibration changes mid-session', () => {
    // 30 reps at a 150 ms uncalibrated offset, then the offset is applied and 30 perfect reps follow
    const s = new Scoring(1);
    for (let i = 0; i < 30; i++) s.recordUnmatchedInput(0, 150);
    expect(s.getTimingBias().timingBiasMs).toBeCloseTo(150, 9);
    s.setLatencyOffsetMs(150);
    expect(s.getLatencyOffsetMs()).toBe(150);
    // the samples already collected are re-expressed on the new timeline (they were 'on time' for
    // an input pipeline running 150 ms late), not left behind on the old one
    expect(s.getTimingBias().timingBiasMs).toBeCloseTo(0, 9);
    expect(s.getNearestDeltaSamplesMs(0).every((x) => Math.abs(x) < 1e-9)).toBe(true);
    for (let i = 0; i < 30; i++) s.apply({ noteId: i, lane: 0, judgment: 'perfect', deltaMs: 0, time: 0 });
    // NOT bimodal: a patient who was on time all along reads back as on time
    const r = s.getResults();
    expect(r.timingBiasMs!).toBeCloseTo(0, 9);
    expect(r.timingBiasMadMs!).toBeCloseTo(0, 9);
    expect(r.timingBiasSamples).toBe(60);
    expect(r.lanes[0].timingBiasMs!).toBeCloseTo(0, 9);
  });
  it('records hits and unmatched inputs on the same (offset-free) scale', () => {
    const s = new Scoring(1);
    s.setLatencyOffsetMs(100);
    s.apply({ noteId: 0, lane: 0, judgment: 'good', deltaMs: 20, time: 0 }); // raw 120
    s.recordUnmatchedInput(0, 20); // raw 120
    expect(s.getNearestDeltaSamplesMs(0)).toEqual([20, 20]);
    s.setLatencyOffsetMs(0);
    expect(s.getNearestDeltaSamplesMs(0)).toEqual([120, 120]);
    expect(s.getTimingBias().timingBiasMs).toBe(120);
    s.setLatencyOffsetMs(Number.NaN); // non-finite is ignored (treated as 0)
    expect(s.getLatencyOffsetMs()).toBe(0);
  });
});

describe('Scoring.getState is a per-frame snapshot (HUD binds to it every frame)', () => {
  it('is cached until scoring changes, frozen, and never recomputes the robust bias', () => {
    const s = new Scoring(2, 10);
    const a = s.getState();
    expect(s.getState()).toBe(a); // same object: no allocation, no work
    s.apply(ev('perfect', 0, 5));
    const b = s.getState();
    expect(b).not.toBe(a);
    expect(b.hits).toBe(1);
    expect(s.getState()).toBe(b);
    s.recordUnmatchedInput(1, 500);
    expect(s.getState()).not.toBe(b);
    expect(s.getState().unmatched).toBe(1);
    // frozen: a consumer cannot corrupt the cache by sorting lanes or patching a field
    expect(Object.isFrozen(s.getState())).toBe(true);
    expect(Object.isFrozen(s.getState().lanes)).toBe(true);
    expect(Object.isFrozen(s.getState().lanes[0])).toBe(true);
    s.reset();
    expect(s.getState().hits).toBe(0);
  });
  it('stays cheap with a full sample pool (the Play HUD reads it every frame)', () => {
    const s = new Scoring(4, 5000);
    for (let i = 0; i < MAX_DELTA_SAMPLES; i++) s.recordUnmatchedInput(i % 4, (i % 41) - 20);
    // cached reads: 20k of them must be far cheaper than one bias computation over the full pool
    const t0 = performance.now();
    for (let i = 0; i < 20000; i++) s.getState();
    const cachedMs = performance.now() - t0;
    const t1 = performance.now();
    s.getResults();
    const resultsMs = performance.now() - t1;
    expect(cachedMs).toBeLessThan(50);
    expect(cachedMs / 20000).toBeLessThan(0.002); // < 2 µs per frame read
    expect(resultsMs).toBeLessThan(200); // and the once-per-session results build is still bounded
    // a rebuild after a change is bias-free, so it does not scale with the sample pool
    const t2 = performance.now();
    for (let i = 0; i < 2000; i++) {
      s.apply(ev('perfect', i % 4, 3));
      s.getState();
    }
    expect((performance.now() - t2) / 2000).toBeLessThan(0.05); // < 50 µs per changed frame
  });
});

describe('Scoring: mean/std of deltaMs are rebased by a mid-session latency change', () => {
  // The regression: hit deltas used to go into the Welford accumulators RAW-on-the-old-timeline
  // while the nearest-note pool right beside them was stored offset-free. A patient 150 ms late for
  // 20 reps, calibrated (the module's own recommendation), then 20 reps dead on the note read back
  // as meanDeltaMs 75 / stdDeltaMs 75 — invented timing variability on a patient with none, on the
  // very numbers the spec asks the Results screen to show per lane.
  it('20 hits at +150 ms, calibrate, 20 hits dead on: mean and std both read 0', () => {
    const s = new Scoring(2, 40);
    for (let i = 0; i < 20; i++) s.apply(ev('good', 0, 150));
    expect(s.getState().meanDeltaMs).toBeCloseTo(150, 9);
    expect(s.getState().stdDeltaMs).toBeCloseTo(0, 9);
    expect(s.getTimingBias().timingBiasMs).toBeCloseTo(150, 9);

    s.setLatencyOffsetMs(150); // apply the suggested calibration
    // everything collected so far moves onto the new timeline, together
    expect(s.getState().meanDeltaMs).toBeCloseTo(0, 9);
    expect(s.getState().stdDeltaMs).toBeCloseTo(0, 9);
    expect(s.getTimingBias().timingBiasMs).toBeCloseTo(0, 9);

    for (let i = 0; i < 20; i++) s.apply(ev('perfect', 0, 0));
    const st = s.getState();
    expect(st.meanDeltaMs).toBeCloseTo(0, 9);
    expect(st.stdDeltaMs).toBeCloseTo(0, 9); // NOT 75: the pool is one timeline, not two
    expect(st.lanes[0].meanDeltaMs).toBeCloseTo(0, 9);
    expect(st.lanes[0].stdDeltaMs).toBeCloseTo(0, 9);
    const bias = s.getTimingBias(0);
    expect(bias.timingBiasMs).toBeCloseTo(0, 9);
    expect(bias.timingBiasMadMs).toBeCloseTo(0, 9);
    // and mean/std agree with the robust pair rather than contradicting it
    expect(Math.abs(st.meanDeltaMs - bias.timingBiasMs!)).toBeLessThan(1e-6);
  });
  it('std is invariant under a latency change, mean moves by exactly the change', () => {
    const s = new Scoring(1);
    for (const d of [-40, -10, 10, 40]) s.apply(ev('good', 0, d));
    const before = s.getState();
    expect(before.meanDeltaMs).toBeCloseTo(0, 9);
    const stdBefore = before.stdDeltaMs;
    expect(stdBefore).toBeGreaterThan(0);
    s.setLatencyOffsetMs(-80);
    const after = s.getState();
    expect(after).not.toBe(before); // the cached snapshot must be invalidated too
    expect(after.meanDeltaMs).toBeCloseTo(80, 9);
    expect(after.stdDeltaMs).toBeCloseTo(stdBefore, 9); // variability is not a function of the offset
    expect(after.lanes[0].meanDeltaMs).toBeCloseTo(80, 9);
  });
  it('reports 0 (not -offset) when no hit has been sampled yet', () => {
    const s = new Scoring(2);
    s.setLatencyOffsetMs(120);
    expect(s.getState().meanDeltaMs).toBe(0);
    expect(s.getState().stdDeltaMs).toBe(0);
    expect(s.getState().lanes[1].meanDeltaMs).toBe(0);
    s.apply(ev('miss', 0)); // misses carry no timing sample
    expect(s.getState().meanDeltaMs).toBe(0);
  });
  it('unmatched inputs and hits land on the same timeline', () => {
    const s = new Scoring(1);
    s.setLatencyOffsetMs(50);
    s.apply(ev('perfect', 0, 10)); // 10 ms late on the +50 timeline
    s.recordUnmatchedInput(0, 10);
    expect(s.getNearestDeltaSamplesMs(0)).toEqual([10, 10]);
    s.setLatencyOffsetMs(0);
    expect(s.getNearestDeltaSamplesMs(0)).toEqual([60, 60]);
    expect(s.getState().meanDeltaMs).toBeCloseTo(60, 9);
  });
});

describe('Scoring: out-of-range inputs are counted, never lost', () => {
  it('tallies them apart from reps and leaves score untouched', () => {
    const s = new Scoring(2, 10);
    expect(s.getState().outOfRange).toBe(0);
    expect(s.getLastOutOfRangeLane()).toBeNull();
    s.apply(ev('perfect', 0, 0));
    const before = s.getScore();
    s.recordOutOfRangeInput(7);
    s.recordOutOfRangeInput(-1);
    const st = s.getState();
    expect(st.outOfRange).toBe(2);
    expect(s.getOutOfRangeCount()).toBe(2);
    expect(s.getLastOutOfRangeLane()).toBe(-1);
    expect(s.getScore()).toBe(before); // never scored, never penalised
    expect(st.health).toBe(s.getHealth());
    // reps stays the sum of the lane reps: an unattributable movement is not a rep of any movement
    expect(st.reps).toBe(st.lanes.reduce((a, l) => a + l.reps, 0));
    expect(st.reps).toBe(1);
    s.reset();
    expect(s.getState().outOfRange).toBe(0);
    expect(s.getLastOutOfRangeLane()).toBeNull();
  });
});
