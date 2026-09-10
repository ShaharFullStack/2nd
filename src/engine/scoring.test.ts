// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { GOOD_STAR_WEIGHT, HEALTH_START, Scoring, multiplierForCombo, starAccuracyOf, starsForAccuracy } from './scoring.ts';
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
