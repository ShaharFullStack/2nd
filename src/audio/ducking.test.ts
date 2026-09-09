import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DUCK_OPTIONS, DuckController, MIN_GAIN, dbToGain, gainToDb, rampGain, rampValueAt, scheduleRamp, targetGainForCombo,
  type GainParamLike, type RampState,
} from './ducking';

type Call = ['cancel', number] | ['set', number, number] | ['exp', number, number];

/**
 * Faithful fake AudioParam: `value` reports the analytic automation value at the fake clock
 * `now` (set by the test), exactly like a browser that keeps `.value` in sync with rendering.
 */
class FakeAudioParam implements GainParamLike {
  calls: Call[] = [];
  now = 0;
  private ramp: RampState;
  constructor(value = 1) { this.ramp = { from: value, to: value, t0: 0, t1: 0 }; }
  get value(): number { return rampValueAt(this.ramp, this.now); }
  set value(v: number) { this.ramp = { from: v, to: v, t0: this.now, t1: this.now }; }
  cancelScheduledValues(t: number) { this.calls.push(['cancel', t]); return this; }
  setValueAtTime(v: number, t: number) { this.calls.push(['set', v, t]); this.ramp = { from: v, to: v, t0: t, t1: t }; return this; }
  exponentialRampToValueAtTime(v: number, t: number) { this.calls.push(['exp', v, t]); this.ramp = { from: this.ramp.to, to: v, t0: this.ramp.t1, t1: t }; return this; }
  lastRamp(): ['exp', number, number] { const c = [...this.calls].reverse().find((x) => x[0] === 'exp'); if (!c) throw new Error('no ramp'); return c as ['exp', number, number]; }
}

describe('gain math', () => {
  it('converts dB to gain and back', () => {
    expect(dbToGain(0)).toBe(1);
    expect(dbToGain(2)).toBeCloseTo(1.2589, 3);
    expect(gainToDb(dbToGain(-6))).toBeCloseTo(-6, 9);
  });
  it('targetGainForCombo applies the +2 dB streak boost from 8 combo', () => {
    expect(targetGainForCombo(0)).toBe(1);
    expect(targetGainForCombo(7)).toBe(1);
    expect(targetGainForCombo(8)).toBeCloseTo(1.2589, 3);
    expect(targetGainForCombo(50)).toBeCloseTo(1.2589, 3);
    expect(targetGainForCombo(8, { ...DEFAULT_DUCK_OPTIONS, streakThreshold: 10 })).toBe(1);
    expect(targetGainForCombo(3, { ...DEFAULT_DUCK_OPTIONS, streakThreshold: 3, streakBoostDb: 6 })).toBeCloseTo(dbToGain(6));
  });
});

describe('rampValueAt', () => {
  const r: RampState = { from: 1, to: 0.05, t0: 10, t1: 10.04 };
  it('is the start value before t0 and the target after t1', () => {
    expect(rampValueAt(r, 9)).toBe(1);
    expect(rampValueAt(r, 10)).toBe(1);
    expect(rampValueAt(r, 10.04)).toBe(0.05);
    expect(rampValueAt(r, 11)).toBe(0.05);
  });
  it('interpolates exponentially (geometric midpoint at half time)', () => {
    expect(rampValueAt(r, 10.02)).toBeCloseTo(Math.sqrt(1 * 0.05), 12);
    expect(rampValueAt(r, 10.01)).toBeCloseTo(Math.pow(0.05, 0.25), 12);
  });
});

describe('scheduleRamp / rampGain', () => {
  it('cancels, anchors the given value and ramps exponentially', () => {
    const p = new FakeAudioParam(1);
    const r = scheduleRamp(p, 1, 10, 0.05, 0.04);
    expect(p.calls).toEqual([['cancel', 10], ['set', 1, 10], ['exp', 0.05, 10.04]]);
    expect(r).toEqual({ from: 1, to: 0.05, t0: 10, t1: 10.04 });
  });
  it('rampGain anchors at param.value', () => {
    const p = new FakeAudioParam(0.3);
    expect(rampGain(p, 10, 0.05, 0.04)).toBe(0.05);
    expect(p.calls).toEqual([['cancel', 10], ['set', 0.3, 10], ['exp', 0.05, 10.04]]);
  });
  it('never schedules a value of 0 (exponential ramps cannot reach it)', () => {
    const p = new FakeAudioParam(0);
    const to = rampGain(p, 1, 0, 0.05);
    expect(to).toBe(MIN_GAIN);
    expect(p.calls[1]).toEqual(['set', MIN_GAIN, 1]);
    expect(p.calls[2]).toEqual(['exp', MIN_GAIN, 1.05]);
  });
  it('enforces a minimum ramp length of 1 ms', () => {
    const p = new FakeAudioParam(1);
    expect(scheduleRamp(p, 1, 2, 0.5, 0).t1).toBeCloseTo(2.001, 12);
  });
});

describe('DuckController', () => {
  it('miss ducks to 0.05 in 40 ms; hit restores to 1.0 in 60 ms', () => {
    const p = new FakeAudioParam(1);
    const d = new DuckController(p);
    d.miss(5);
    expect(d.ducked).toBe(true);
    expect(p.calls).toEqual([['cancel', 5], ['set', 1, 5], ['exp', 0.05, 5.04]]);
    p.calls = [];
    p.now = 6;
    d.hit(6, 1);
    expect(d.ducked).toBe(false);
    expect(p.calls).toEqual([['cancel', 6], ['set', 0.05, 6], ['exp', 1, 6.06]]);
  });

  it('a hit in the middle of a miss ramp anchors at the analytic mid-ramp value (no click)', () => {
    const p = new FakeAudioParam(1);
    const d = new DuckController(p);
    d.miss(10); // 1 → 0.05 over [10, 10.04]
    p.now = 10.02;
    const mid = Math.sqrt(0.05);
    expect(d.valueAt(10.02)).toBeCloseTo(mid, 12);
    expect(p.value).toBeCloseTo(mid, 12); // the faithful fake agrees
    p.calls = [];
    d.hit(10.02, 1);
    expect(p.calls[0]).toEqual(['cancel', 10.02]);
    expect(p.calls[1][0]).toBe('set');
    expect(p.calls[1][1]).toBeCloseTo(mid, 12); // anchored mid-ramp, not at 0.05 and not at 1
    expect(p.calls[2]).toEqual(['exp', 1, 10.08]);
    expect(d.currentRamp).toEqual({ from: expect.closeTo(mid, 12), to: 1, t0: 10.02, t1: 10.08 });
  });

  it('a miss in the middle of a hit ramp anchors mid-ramp too, and the anchor does not depend on param.value', () => {
    // a lagging browser: param.value is stale (still the old target)
    const stale: GainParamLike & { calls: Call[] } = {
      value: 0.05,
      calls: [],
      cancelScheduledValues(t: number) { this.calls.push(['cancel', t]); },
      setValueAtTime(v: number, t: number) { this.calls.push(['set', v, t]); },
      exponentialRampToValueAtTime(v: number, t: number) { this.calls.push(['exp', v, t]); },
    };
    const d = new DuckController(stale);
    d.miss(0);
    d.hit(1, 1); // 0.05 → 1 over [1, 1.06]
    stale.calls = [];
    d.miss(1.03);
    const expected = 0.05 * Math.pow(1 / 0.05, 0.5);
    expect(stale.calls[1][0]).toBe('set');
    expect(stale.calls[1][1]).toBeCloseTo(expected, 12);
    expect(stale.calls[2]).toEqual(['exp', 0.05, expect.closeTo(1.07, 12)]);
  });

  it('ducking persists across consecutive misses until the next hit', () => {
    const p = new FakeAudioParam(1);
    const d = new DuckController(p);
    d.miss(1); p.now = 2; d.miss(2); p.now = 3; d.miss(3);
    expect(d.ducked).toBe(true);
    expect(p.lastRamp()[1]).toBe(0.05);
    p.now = 4;
    expect(p.value).toBe(0.05);
    expect(d.valueAt(4)).toBe(0.05);
    d.hit(4, 1);
    p.now = 5;
    expect(p.value).toBe(1);
  });

  it('a streak of 8+ raises the restored level by +2 dB, then drops back when the combo resets', () => {
    const p = new FakeAudioParam(1);
    const d = new DuckController(p);
    for (let combo = 1; combo <= 7; combo++) { p.now = combo; d.hit(combo, combo); expect(p.lastRamp()[1]).toBe(1); }
    p.now = 8;
    d.hit(8, 8);
    expect(p.lastRamp()[1]).toBeCloseTo(1.2589, 3);
    expect(d.target).toBeCloseTo(1.2589, 3);
    p.now = 9;
    d.miss(9);
    expect(p.lastRamp()[1]).toBe(0.05);
    p.now = 10;
    d.hit(10, 1);
    expect(p.lastRamp()[1]).toBe(1);
  });

  it('honours custom options', () => {
    const p = new FakeAudioParam(1);
    const d = new DuckController(p, { missGain: 0.2, missRampMs: 100, hitRampMs: 10, hitGain: 0.8 });
    d.miss(0);
    expect(p.lastRamp()).toEqual(['exp', 0.2, 0.1]);
    p.now = 1;
    d.hit(1, 0);
    expect(p.lastRamp()).toEqual(['exp', 0.8, 1.01]);
  });

  it('reset restores instantly and clears the ducked flag', () => {
    const p = new FakeAudioParam(1);
    const d = new DuckController(p);
    d.miss(1);
    p.calls = [];
    d.reset(2);
    expect(d.ducked).toBe(false);
    expect(p.calls).toEqual([['cancel', 2], ['set', 1, 2]]);
    expect(d.valueAt(2.5)).toBe(1);
  });

  it('rebind restores the old param and controls the new one', () => {
    const a = new FakeAudioParam(1);
    const b = new FakeAudioParam(1);
    const d = new DuckController(a);
    d.miss(1);
    a.now = b.now = 2;
    d.rebind(b, 2);
    expect(a.value).toBe(1);
    expect(a.calls.slice(-2)).toEqual([['cancel', 2], ['set', 1, 2]]);
    b.now = 3;
    d.miss(3);
    expect(b.lastRamp()[1]).toBe(0.05);
    expect(b.calls.slice(0, 2)).toEqual([['cancel', 2], ['set', 1, 2]]); // rebind pins the new stem at the nominal level
    expect(b.calls[3]).toEqual(['set', 1, 3]); // the miss ramp anchors on that level
    expect(a.calls.filter((c) => c[0] === 'exp')).toHaveLength(1); // no new automation on a
  });
});
