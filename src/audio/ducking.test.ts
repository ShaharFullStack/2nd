import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DUCK_OPTIONS, DuckController, MIN_GAIN, assignLaneStems, dbToGain, duckGainForMisses, gainToDb, rampGain, rampValueAt,
  scheduleRamp, targetGainForCombo,
  type GainParamLike, type RampState,
} from './ducking';

/** One miss = one step (−3 dB); the run bottoms out at `missGain` after three. */
const D1 = duckGainForMisses(1);
const D2 = duckGainForMisses(2);
const D3 = duckGainForMisses(3);

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
  it('one miss dips by one step (−3 dB) in 40 ms, never to silence; hit restores to 1.0 in 60 ms', () => {
    const p = new FakeAudioParam(1);
    const d = new DuckController(p);
    d.miss(5);
    expect(d.ducked).toBe(true);
    expect(D1).toBeCloseTo(0.7079, 4); // the patient still hears their instrument
    expect(p.calls).toEqual([['cancel', 5], ['set', 1, 5], ['exp', expect.closeTo(D1, 12), 5.04]]);
    p.calls = [];
    p.now = 6;
    d.hit(6, 1);
    expect(d.ducked).toBe(false);
    expect(d.missRun).toBe(0);
    expect(p.calls).toEqual([['cancel', 6], ['set', expect.closeTo(D1, 12), 6], ['exp', 1, 6.06]]);
  });

  it('the duck is proportionate: it deepens per consecutive miss and stops at the floor', () => {
    expect(duckGainForMisses(0)).toBe(1);
    expect(gainToDb(D1)).toBeCloseTo(-3, 9);
    expect(gainToDb(D2)).toBeCloseTo(-6, 9);
    expect(gainToDb(D3)).toBeCloseTo(-9, 9);
    // the floor is a floor: an endless run of misses never silences the instrument
    for (const n of [4, 10, 500]) expect(duckGainForMisses(n)).toBe(DEFAULT_DUCK_OPTIONS.missGain);
    expect(DEFAULT_DUCK_OPTIONS.missGain).toBeGreaterThan(0.3);
    expect(duckGainForMisses(-2)).toBe(1);
    expect(duckGainForMisses(Number.NaN)).toBe(1);
  });

  it('a hit in the middle of a miss ramp anchors at the analytic mid-ramp value (no click)', () => {
    const p = new FakeAudioParam(1);
    const d = new DuckController(p);
    d.miss(10); // 1 → D1 over [10, 10.04]
    p.now = 10.02;
    const mid = Math.sqrt(D1);
    expect(d.valueAt(10.02)).toBeCloseTo(mid, 12);
    expect(p.value).toBeCloseTo(mid, 12); // the faithful fake agrees
    p.calls = [];
    d.hit(10.02, 1);
    expect(p.calls[0]).toEqual(['cancel', 10.02]);
    expect(p.calls[1][0]).toBe('set');
    expect(p.calls[1][1]).toBeCloseTo(mid, 12); // anchored mid-ramp, not at D1 and not at 1
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
    d.hit(1, 1); // D1 → 1 over [1, 1.06]
    stale.calls = [];
    d.miss(1.03);
    const expected = D1 * Math.pow(1 / D1, 0.5);
    expect(stale.calls[1][0]).toBe('set');
    expect(stale.calls[1][1]).toBeCloseTo(expected, 12);
    expect(stale.calls[2]).toEqual(['exp', expect.closeTo(D1, 12), expect.closeTo(1.07, 12)]);
  });

  it('ducking deepens step by step across consecutive misses and one hit restores it fully', () => {
    const p = new FakeAudioParam(1);
    const d = new DuckController(p);
    d.miss(1);
    expect(p.lastRamp()[1]).toBeCloseTo(D1, 12);
    p.now = 2; d.miss(2);
    expect(p.lastRamp()[1]).toBeCloseTo(D2, 12);
    p.now = 3; d.miss(3);
    expect(d.ducked).toBe(true);
    expect(d.missRun).toBe(3);
    expect(p.lastRamp()[1]).toBeCloseTo(D3, 12);
    p.now = 4;
    expect(p.value).toBeCloseTo(D3, 12);
    expect(d.valueAt(4)).toBeCloseTo(D3, 12);
    d.hit(4, 1);
    p.now = 5;
    expect(p.value).toBe(1);
    // an explicit run length (a replay/critic) overrides the controller's own count
    d.miss(5, 3);
    expect(p.lastRamp()[1]).toBeCloseTo(D3, 12);
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
    expect(p.lastRamp()[1]).toBeCloseTo(D1, 12);
    p.now = 10;
    d.hit(10, 1);
    expect(p.lastRamp()[1]).toBe(1);
  });

  it('honours custom options', () => {
    const p = new FakeAudioParam(1);
    const d = new DuckController(p, { missGain: 0.2, missStepDb: -20, missRampMs: 100, hitRampMs: 10, hitGain: 0.8 });
    d.miss(0);
    expect(p.lastRamp()).toEqual(['exp', 0.2, 0.1]); // one −20 dB step is already past the 0.2 floor
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

  it('reset(now, rampSec) ramps back from the ducked value instead of stepping (click-free seek/stop)', () => {
    const p = new FakeAudioParam(1);
    const d = new DuckController(p);
    d.miss(1);
    p.now = 1.06; // the miss ramp has landed
    p.calls = [];
    d.reset(1.06, 0.008); // transport fade length: the stem is still audible for 8 ms
    expect(d.ducked).toBe(false);
    expect(d.missRun).toBe(0);
    expect(p.calls).toEqual([['cancel', 1.06], ['set', expect.closeTo(D1, 12), 1.06], ['exp', 1, 1.068]]);
    expect(d.valueAt(1.06)).toBeCloseTo(D1, 12); // continuous: no step at the anchor
    expect(d.valueAt(1.064)).toBeCloseTo(Math.sqrt(D1), 12);
    expect(d.valueAt(1.068)).toBe(1);
    // mid-ramp interruption anchors on the analytic value, exactly like hit()/miss()
    const q = new FakeAudioParam(1);
    const e = new DuckController(q);
    e.miss(0);
    q.calls = [];
    e.reset(0.02, 0.008); // half way down the 40 ms miss ramp
    expect(q.calls[1]).toEqual(['set', expect.closeTo(Math.pow(D1, 0.5), 12), 0.02]);
    // already at the nominal level: nothing to ramp, the hard write stays (and is a no-op)
    const r = new FakeAudioParam(1);
    const f = new DuckController(r);
    r.calls = [];
    f.reset(3, 0.008);
    expect(r.calls).toEqual([['cancel', 3], ['set', 1, 3]]);
  });

  it('rebind ramps the old param back (no click) and controls the new one', () => {
    const a = new FakeAudioParam(1);
    const b = new FakeAudioParam(1);
    const d = new DuckController(a);
    d.miss(1); // a is ducked one step by t = 1.04
    a.now = b.now = 2;
    d.rebind(b, 2);
    // the outgoing stem must be RAMPED back over the hit ramp, not hard-written: a
    // setValueAtTime(1) here would jump the ducked level → 1.0 in one sample.
    expect(a.calls.slice(-3)).toEqual([['cancel', 2], ['set', expect.closeTo(D1, 12), 2], ['exp', 1, 2.06]]);
    expect(a.value).toBeCloseTo(D1, 12); // anchored at where the miss ramp actually left it
    b.now = 3;
    d.miss(3);
    expect(b.lastRamp()[1]).toBeCloseTo(D1, 12);
    expect(b.calls.slice(0, 2)).toEqual([['cancel', 2], ['set', 1, 2]]); // rebind pins the new stem at the nominal level
    expect(b.calls[3]).toEqual(['set', 1, 3]); // the miss ramp anchors on that level
    // exactly two ramps on a: the miss duck and the rebind restore — nothing after the handover
    expect(a.calls.filter((c) => c[0] === 'exp')).toHaveLength(2);
  });
});

// ---------------------------------------------------------------- cancelAndHoldAtTime + linear ramps

import { SmoothGain, linearRampValueAt, supportsCancelAndHold, type LinearParamLike } from './ducking';

type HoldCall = Call | ['hold', number] | ['lin', number, number];

/** Fake with cancelAndHoldAtTime (Chrome/Safari/Firefox ≥ 137): the audio thread anchors itself. */
class FakeHoldParam implements GainParamLike, LinearParamLike {
  value: number;
  calls: HoldCall[] = [];
  constructor(v = 1) { this.value = v; }
  cancelScheduledValues(t: number) { this.calls.push(['cancel', t]); return this; }
  cancelAndHoldAtTime(t: number) { this.calls.push(['hold', t]); return this; }
  setValueAtTime(v: number, t: number) { this.calls.push(['set', v, t]); this.value = v; return this; }
  exponentialRampToValueAtTime(v: number, t: number) { this.calls.push(['exp', v, t]); return this; }
  linearRampToValueAtTime(v: number, t: number) { this.calls.push(['lin', v, t]); return this; }
}

describe('scheduleRamp with cancelAndHoldAtTime', () => {
  it('feature-detects the method', () => {
    expect(supportsCancelAndHold(new FakeHoldParam())).toBe(true);
    expect(supportsCancelAndHold(new FakeAudioParam() as unknown as { cancelAndHoldAtTime?: unknown })).toBe(false);
    expect(supportsCancelAndHold({})).toBe(false);
  });

  it('holds on the audio thread instead of pinning the analytic anchor, and still tracks the ramp', () => {
    const p = new FakeHoldParam(1);
    const d = new DuckController(p);
    d.miss(10);
    expect(p.calls).toEqual([['hold', 10], ['exp', expect.closeTo(D1, 12), 10.04]]); // no cancel/set pair
    d.hit(10.02, 1);
    expect(p.calls.slice(2)).toEqual([['hold', 10.02], ['exp', 1, 10.08]]);
    // the controller's own tracking is unchanged: anchored at the analytic mid-ramp value
    expect(d.currentRamp.from).toBeCloseTo(Math.sqrt(D1), 12);
    expect(d.valueAt(10.05)).toBeCloseTo(Math.sqrt(D1) * Math.pow(1 / Math.sqrt(D1), 0.5), 12);
    // reset/rebind pin the nominal level explicitly (they are not ramps)
    d.reset(11);
    expect(p.calls.slice(-2)).toEqual([['cancel', 11], ['set', 1, 11]]);
  });
});

describe('linear ramps / SmoothGain', () => {
  it('linearRampValueAt interpolates linearly and clamps outside the ramp', () => {
    const r: RampState = { from: 0.8, to: 0.2, t0: 1, t1: 2 };
    expect(linearRampValueAt(r, 0)).toBe(0.8);
    expect(linearRampValueAt(r, 1.5)).toBeCloseTo(0.5, 12);
    expect(linearRampValueAt(r, 1.25)).toBeCloseTo(0.65, 12);
    expect(linearRampValueAt(r, 3)).toBe(0.2);
  });

  it('sets the initial value and anchors successive ramps on the analytic position (a dragged slider)', () => {
    const p = new FakeHoldParam(1);
    const g = new SmoothGain(p, 0.5);
    expect(p.value).toBe(0.5);
    expect(g.target).toBe(0.5);
    g.set(1, 10, 0.1);
    expect(p.calls).toEqual([['hold', 10], ['lin', 1, expect.closeTo(10.1, 12)]]);
    g.set(0, 10.05, 0.1); // halfway: analytic value 0.75, regardless of what `.value` reports
    expect(g.currentRamp).toEqual({ from: expect.closeTo(0.75, 12), to: 0, t0: 10.05, t1: expect.closeTo(10.15, 12) });
    expect(g.valueAt(10.1)).toBeCloseTo(0.375, 12);
    expect(g.target).toBe(0);
    // without cancelAndHoldAtTime the analytic anchor is pinned with setValueAtTime
    const legacy: LinearParamLike & { calls: HoldCall[] } = {
      value: 0.2,
      calls: [],
      cancelScheduledValues(t: number) { this.calls.push(['cancel', t]); },
      setValueAtTime(v: number, t: number) { this.calls.push(['set', v, t]); },
      linearRampToValueAtTime(v: number, t: number) { this.calls.push(['lin', v, t]); },
    };
    const h = new SmoothGain(legacy);
    h.set(1, 0, 0.1);
    h.set(0.5, 0.05, 0.1);
    expect(legacy.calls.slice(-3)).toEqual([['cancel', 0.05], ['set', expect.closeTo(0.6, 12), 0.05], ['lin', 0.5, expect.closeTo(0.15, 12)]]);
    // negatives are clamped and the ramp never shorter than 1 ms
    expect(h.set(-1, 1, 0).to).toBe(0);
    expect(h.currentRamp.t1).toBeCloseTo(1.001, 12);
  });
});

describe('assignLaneStems (the weak side must not mute the whole band)', () => {
  const stems = ['drums', 'bass', 'keys', 'gtr'];

  it('gives every lane its own stem while one stem is left to carry the song', () => {
    const a = assignLaneStems(stems, 'drums', 2);
    expect(a.mode).toBe('per-lane');
    expect(a.perLane).toEqual(['drums', 'bass']);
    expect(a.bed).toEqual(['keys', 'gtr']);
    const b = assignLaneStems(stems, 'keys', 3);
    expect(b.perLane).toEqual(['keys', 'drums', 'bass']); // the player stem is always lane 1's
    expect(b.bed).toEqual(['gtr']);
    expect(b.summary).toContain('own instrument');
  });

  it('never assigns the last stem, so a total miss run cannot silence the song', () => {
    const a = assignLaneStems(stems, 'drums', 4);
    expect(a.mode).toBe('shared');
    expect(a.perLane).toEqual(['drums', 'drums', 'drums', 'drums']);
    expect(a.bed).toEqual(['bass', 'keys', 'gtr']);
    expect(a.summary).toContain('too few');
    const two = assignLaneStems(['drums', 'bass'], 'drums', 2);
    expect(two.mode).toBe('shared');
    expect(two.bed).toEqual(['bass']);
  });

  it('survives a missing player stem and an empty song', () => {
    expect(assignLaneStems(stems, 'nope', 2).perLane).toEqual(['drums', 'bass']);
    const empty = assignLaneStems([], 'drums', 2);
    expect(empty.mode).toBe('shared');
    expect(empty.bed).toEqual([]);
  });
});


describe('the mix summary names which limb has which instrument', () => {
  const stems = ['drums', 'bass', 'keys', 'lead'];

  it('maps lane → instrument, so a therapist knows what to listen for on the weak side', () => {
    const a = assignLaneStems(stems, 'drums', 2, ['Left · Seated march', 'Right · Seated march']);
    expect(a.mode).toBe('per-lane');
    // The set of instruments is not enough: "drums, bass" cannot tell you which one is the weak leg.
    expect(a.summary).toContain('Left · Seated march → drums');
    expect(a.summary).toContain('Right · Seated march → bass');
    expect(a.summary).toMatch(/never take the reward away from the limb that is working/);
  });

  it('names the lanes in the shared-stem case too, where they all duck the same instrument', () => {
    const a = assignLaneStems(['drums', 'bass'], 'drums', 3, ['L march', 'R march', 'L toe lift']);
    expect(a.mode).toBe('shared');
    expect(a.summary).toContain('L march → drums');
    expect(a.summary).toContain('L toe lift → drums');
  });

  it('falls back to lane numbers when no labels are supplied', () => {
    expect(assignLaneStems(stems, 'drums', 2).summary).toContain('lane 1 → drums');
  });
});
