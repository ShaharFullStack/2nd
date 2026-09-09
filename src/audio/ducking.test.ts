import { describe, expect, it } from 'vitest';
import { DEFAULT_DUCK_OPTIONS, DuckController, MIN_GAIN, dbToGain, gainToDb, rampGain, targetGainForCombo, type GainParamLike } from './ducking';

type Call = ['cancel', number] | ['set', number, number] | ['exp', number, number];

/** Records automation calls; `value` is whatever the last setValueAtTime/ramp targeted (good enough for tests). */
class FakeAudioParam implements GainParamLike {
  value: number;
  calls: Call[] = [];
  constructor(value = 1) { this.value = value; }
  cancelScheduledValues(t: number) { this.calls.push(['cancel', t]); return this; }
  setValueAtTime(v: number, t: number) { this.calls.push(['set', v, t]); this.value = v; return this; }
  exponentialRampToValueAtTime(v: number, t: number) { this.calls.push(['exp', v, t]); this.value = v; return this; }
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

describe('rampGain', () => {
  it('cancels, anchors the current value and ramps exponentially', () => {
    const p = new FakeAudioParam(1);
    rampGain(p, 10, 0.05, 0.04);
    expect(p.calls).toEqual([['cancel', 10], ['set', 1, 10], ['exp', 0.05, 10.04]]);
  });
  it('never schedules a value of 0 (exponential ramps cannot reach it)', () => {
    const p = new FakeAudioParam(0);
    const to = rampGain(p, 1, 0, 0.05);
    expect(to).toBe(MIN_GAIN);
    expect(p.calls[1]).toEqual(['set', MIN_GAIN, 1]);
    expect(p.calls[2]).toEqual(['exp', MIN_GAIN, 1.05]);
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
    d.hit(6, 1);
    expect(d.ducked).toBe(false);
    expect(p.calls).toEqual([['cancel', 6], ['set', 0.05, 6], ['exp', 1, 6.06]]);
  });

  it('ducking persists across consecutive misses until the next hit', () => {
    const p = new FakeAudioParam(1);
    const d = new DuckController(p);
    d.miss(1); d.miss(2); d.miss(3);
    expect(d.ducked).toBe(true);
    expect(p.lastRamp()[1]).toBe(0.05);
    expect(p.value).toBe(0.05);
    d.hit(4, 1);
    expect(p.value).toBe(1);
  });

  it('a streak of 8+ raises the restored level by +2 dB, then drops back when the combo resets', () => {
    const p = new FakeAudioParam(1);
    const d = new DuckController(p);
    for (let combo = 1; combo <= 7; combo++) { d.hit(combo, combo); expect(p.lastRamp()[1]).toBe(1); }
    d.hit(8, 8);
    expect(p.lastRamp()[1]).toBeCloseTo(1.2589, 3);
    expect(d.target).toBeCloseTo(1.2589, 3);
    d.miss(9);
    expect(p.lastRamp()[1]).toBe(0.05);
    d.hit(10, 1);
    expect(p.lastRamp()[1]).toBe(1);
  });

  it('honours custom options', () => {
    const p = new FakeAudioParam(1);
    const d = new DuckController(p, { missGain: 0.2, missRampMs: 100, hitRampMs: 10, hitGain: 0.8 });
    d.miss(0);
    expect(p.lastRamp()).toEqual(['exp', 0.2, 0.1]);
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
  });

  it('rebind restores the old param and controls the new one', () => {
    const a = new FakeAudioParam(1);
    const b = new FakeAudioParam(1);
    const d = new DuckController(a);
    d.miss(1);
    d.rebind(b, 2);
    expect(a.value).toBe(1);
    expect(a.calls.slice(-2)).toEqual([['cancel', 2], ['set', 1, 2]]);
    d.miss(3);
    expect(b.lastRamp()[1]).toBe(0.05);
    expect(a.lastRamp()[1]).toBe(0.05); // the ramp from before the rebind, no new automation on a
    expect(a.calls.filter((c) => c[0] === 'exp')).toHaveLength(1);
  });
});
