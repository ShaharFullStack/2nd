import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SFX_LEVELS, LANE_SEMITONES, SFX_CUE_PEAKS, SFX_PEAKS, Sfx, cueTones, envelopeAt,
  laneRatio, sfxBusPeak, type SfxKind,
} from './sfx';

// ---------------------------------------------------------------- fake Web Audio

type Ev = ['set' | 'exp' | 'lin' | 'cancel', number, number];
class FakeParam {
  value: number;
  events: Ev[] = [];
  constructor(v = 0) { this.value = v; }
  setValueAtTime(v: number, t: number) { this.events.push(['set', v, t]); this.value = v; return this; }
  // ramps are recorded only: `.value` keeps the last setValueAtTime (the tone's start frequency / envelope floor)
  exponentialRampToValueAtTime(v: number, t: number) { this.events.push(['exp', v, t]); return this; }
  linearRampToValueAtTime(v: number, t: number) { this.events.push(['lin', v, t]); return this; }
  cancelScheduledValues(t: number) { this.events.push(['cancel', 0, t]); return this; }
}
class FakeNode {
  connections: FakeNode[] = [];
  connect(n: FakeNode) { this.connections.push(n); return n; }
  disconnect() { this.connections = []; }
}
class FakeGain extends FakeNode { gain = new FakeParam(1); }
class FakeFilter extends FakeNode { type = 'lowpass'; frequency = new FakeParam(350); }
class FakeOsc extends FakeNode {
  type = 'sine';
  frequency = new FakeParam(440);
  onended: (() => void) | null = null;
  startAt: number | null = null;
  stopAt: number | null = null;
  start(t: number) { this.startAt = t; }
  stop(t: number) { this.stopAt = t; }
}
class FakeCtx {
  currentTime = 0;
  destination = new FakeNode();
  oscs: FakeOsc[] = [];
  gains: FakeGain[] = [];
  filters: FakeFilter[] = [];
  createGain() { const g = new FakeGain(); this.gains.push(g); return g; }
  createOscillator() { const o = new FakeOsc(); this.oscs.push(o); return o; }
  createBiquadFilter() { const f = new FakeFilter(); this.filters.push(f); return f; }
}
const asCtx = (c: FakeCtx) => c as unknown as BaseAudioContext;

/** Peak envelope gain scheduled for oscillator `o` (its gain node's exponential ramp target). */
function envPeak(o: FakeOsc): number {
  const env = o.connections[0] as FakeGain;
  const exp = env.gain.events.filter((e) => e[0] === 'exp');
  return Math.max(...exp.map((e) => e[1]));
}
/** Final node before the Sfx output bus for oscillator `o`. */
function tail(o: FakeOsc): FakeNode {
  let n = o.connections[0];
  while (n.connections.length === 1 && n.connections[0] instanceof FakeFilter) n = n.connections[0];
  return n;
}

const KINDS: SfxKind[] = ['hit', 'perfect', 'miss', 'combo'];

describe('cueTones (the single source of truth for what Sfx schedules)', () => {
  it('is exactly what play() puts on the graph, so the headroom budget measures the real cues', () => {
    for (const kind of KINDS) {
      const ctx = new FakeCtx();
      ctx.currentTime = 2;
      const sfx = new Sfx(asCtx(ctx), undefined, 1);
      sfx.perLane = false;
      sfx.play(kind, 2, { milestone: 100 });
      const specs = cueTones(kind, { level: DEFAULT_SFX_LEVELS[kind], milestone: 100 });
      expect(ctx.oscs).toHaveLength(specs.length);
      expect(ctx.oscs.map((o) => o.startAt)).toEqual(specs.map((s) => 2 + s.start));
      expect(ctx.oscs.map((o) => o.frequency.value)).toEqual(specs.map((s) => s.freq));
      expect(ctx.oscs.map(envPeak)).toEqual(specs.map((s) => s.peak));
    }
  });

  it('busPeak scales the loudest cue by the volume and tracks per-kind levels', () => {
    const sfx = new Sfx(asCtx(new FakeCtx()), undefined, 1);
    expect(sfx.busPeak()).toBeCloseTo(sfxBusPeak(1), 12);
    expect(sfx.busPeak()).toBeGreaterThan(SFX_PEAKS.hit); // partials sum above the loudest one
    sfx.volume = 0.25;
    expect(sfx.busPeak()).toBeCloseTo(sfxBusPeak(1) * 0.25, 12);
    sfx.volume = 1;
    sfx.setLevel('hit', 0);
    sfx.setLevel('perfect', 0);
    sfx.setLevel('combo', 0);
    // with the loud cues silenced the bus peak is the miss cue's
    expect(sfx.busPeak()).toBeCloseTo(SFX_CUE_PEAKS.miss * DEFAULT_SFX_LEVELS.miss, 12);
  });

  it('envelopeAt is zero outside the partial and peaks at the end of the attack', () => {
    const [spec] = cueTones('hit');
    expect(envelopeAt(spec, -1)).toBe(0);
    expect(envelopeAt(spec, spec.start)).toBe(0);
    expect(envelopeAt(spec, spec.start + spec.dur)).toBe(0);
    expect(envelopeAt(spec, spec.start + (spec.attack ?? 0.002))).toBeCloseTo(spec.peak, 9);
    expect(envelopeAt(spec, spec.start + spec.dur / 2)).toBeLessThan(spec.peak);
  });
});

describe('Sfx', () => {
  it('routes through one output gain at the requested volume to the given destination', () => {
    const ctx = new FakeCtx();
    const dest = new FakeNode();
    const sfx = new Sfx(asCtx(ctx), dest as unknown as AudioNode, 0.4);
    expect(sfx.volume).toBe(0.4);
    const out = ctx.gains[0];
    expect(out.gain.value).toBe(0.4);
    expect(out.connections).toEqual([dest]);
    expect(new Sfx(asCtx(new FakeCtx())).volume).toBe(0.5);
    const c2 = new FakeCtx();
    new Sfx(asCtx(c2));
    expect(c2.gains[0].connections).toEqual([c2.destination]);
  });

  it('every kind schedules oscillators at the requested time with envelopes that end after they start', () => {
    for (const kind of KINDS) {
      const ctx = new FakeCtx();
      ctx.currentTime = 5;
      const sfx = new Sfx(asCtx(ctx));
      const out = ctx.gains[0];
      sfx.play(kind, 5.25);
      expect(ctx.oscs.length, kind).toBeGreaterThan(0);
      for (const o of ctx.oscs) {
        expect(o.startAt, kind).toBeGreaterThanOrEqual(5.25);
        expect(o.stopAt!, kind).toBeGreaterThan(o.startAt!);
        // env: floor → peak → floor, all within [start, stop]
        const env = o.connections[0] as FakeGain;
        const [set, ...exps] = env.gain.events;
        expect(set[0]).toBe('set');
        expect(set[2]).toBe(o.startAt);
        expect(exps.map((e) => e[0])).toEqual(['exp', 'exp']);
        expect(exps[1][2]).toBeLessThanOrEqual(o.stopAt!);
        expect(exps[1][1]).toBeLessThan(1e-3);
        expect(tail(o).connections, kind).toEqual([out]);
      }
      // the first partial starts exactly at the requested time
      expect(Math.min(...ctx.oscs.map((o) => o.startAt!))).toBe(5.25);
    }
  });

  it('never schedules in the past: a `when` before now is clamped to now', () => {
    const ctx = new FakeCtx();
    ctx.currentTime = 9;
    new Sfx(asCtx(ctx)).hit(2);
    expect(ctx.oscs.map((o) => o.startAt)).toEqual([9, 9]);
    new Sfx(asCtx(ctx)).miss();
    expect(ctx.oscs.slice(2).every((o) => o.startAt === 9)).toBe(true);
  });

  it('the miss cue is quieter than the hit cue by default and per-kind levels are adjustable', () => {
    const ctx = new FakeCtx();
    const sfx = new Sfx(asCtx(ctx), undefined, 1);
    expect(DEFAULT_SFX_LEVELS.miss).toBeLessThan(DEFAULT_SFX_LEVELS.hit);
    expect(sfx.effectivePeak('miss')).toBeLessThan(sfx.effectivePeak('hit'));
    sfx.hit();
    const hitPeak = Math.max(...ctx.oscs.map(envPeak));
    ctx.oscs = [];
    sfx.miss();
    const missPeak = Math.max(...ctx.oscs.map(envPeak));
    expect(hitPeak).toBe(SFX_PEAKS.hit);
    expect(missPeak).toBeCloseTo(SFX_PEAKS.miss * DEFAULT_SFX_LEVELS.miss, 9);
    expect(missPeak).toBeLessThan(hitPeak);

    // a therapist can turn the miss cue up or off
    sfx.setLevel('miss', 1);
    expect(sfx.getLevel('miss')).toBe(1);
    ctx.oscs = [];
    sfx.miss();
    expect(Math.max(...ctx.oscs.map(envPeak))).toBe(SFX_PEAKS.miss);
    sfx.setLevel('miss', 0);
    ctx.oscs = [];
    sfx.miss();
    expect(ctx.oscs).toHaveLength(0);
    sfx.setLevel('hit', 7); // clamped
    expect(sfx.getLevel('hit')).toBe(1);
    const custom = new Sfx(asCtx(new FakeCtx()), undefined, 0.5, { combo: 0.25 });
    expect(custom.getLevel('combo')).toBe(0.25);
    expect(custom.effectivePeak('combo')).toBeCloseTo(SFX_PEAKS.combo * 0.25 * 0.5, 9);
  });

  it('miss thud is a low-passed low tone; hit tick a short bright tone', () => {
    const ctx = new FakeCtx();
    const sfx = new Sfx(asCtx(ctx));
    sfx.miss();
    expect(ctx.filters).toHaveLength(1);
    expect(ctx.filters[0].frequency.value).toBeLessThan(400);
    expect(Math.max(...ctx.oscs.map((o) => o.frequency.value))).toBeLessThan(200);
    const missLen = Math.max(...ctx.oscs.map((o) => o.stopAt! - o.startAt!));
    ctx.oscs = [];
    sfx.hit();
    expect(Math.min(...ctx.oscs.map((o) => o.frequency.value))).toBeGreaterThan(1000);
    const hitLen = Math.max(...ctx.oscs.map((o) => o.stopAt! - o.startAt!));
    expect(hitLen).toBeLessThan(missLen);
  });

  it('combo arpeggio grows with the milestone and perfect adds a rising sparkle', () => {
    const count = (milestone: number) => {
      const ctx = new FakeCtx();
      new Sfx(asCtx(ctx)).combo(milestone);
      return ctx.oscs.length;
    };
    expect(count(10)).toBe(3 + 1); // 3 notes + octave shimmer on the last
    expect(count(25)).toBe(4 + 1);
    expect(count(100)).toBe(6 + 1);
    expect(count(1000)).toBe(6 + 1); // capped
    const ctx = new FakeCtx();
    new Sfx(asCtx(ctx)).perfect(1);
    const sparkle = ctx.oscs.slice(1);
    expect(sparkle.map((o) => o.frequency.value)).toEqual([1568, 2093, 3136]);
    expect(sparkle.map((o) => o.startAt)).toEqual([1, 1.035, 1.07]);
  });

  it('is silent when disabled, muted or disposed', () => {
    const ctx = new FakeCtx();
    const sfx = new Sfx(asCtx(ctx));
    sfx.enabled = false;
    for (const k of KINDS) sfx.play(k);
    expect(ctx.oscs).toHaveLength(0);
    sfx.enabled = true;
    sfx.volume = 0;
    sfx.hit();
    expect(ctx.oscs).toHaveLength(0);
    sfx.volume = 0.7;
    sfx.hit();
    expect(ctx.oscs).toHaveLength(2);
    sfx.dispose();
    expect(ctx.gains[0].connections).toHaveLength(0);
    sfx.hit();
    expect(ctx.oscs).toHaveLength(2);
  });

  it('volume changes ramp the output gain (no zipper) and are clamped to 0..1', () => {
    const ctx = new FakeCtx();
    ctx.currentTime = 3;
    const sfx = new Sfx(asCtx(ctx), undefined, 0.5);
    const out = ctx.gains[0];
    sfx.volume = 2;
    expect(sfx.volume).toBe(1);
    expect(out.gain.events).toEqual([['cancel', 0, 3], ['set', 0.5, 3], ['lin', 1, 3.02]]);
    sfx.volume = Number.NaN;
    expect(sfx.volume).toBe(0);
  });
});

describe('per-lane hit layer', () => {
  it('transposes the hit/perfect cues per lane, wraps lanes, and can be switched off', () => {
    const ratio = (lane: number | undefined, perLane = true, kind: 'hit' | 'perfect' = 'hit') => {
      const ctx = new FakeCtx();
      const sfx = new Sfx(asCtx(ctx));
      sfx.perLane = perLane;
      if (kind === 'hit') sfx.hit(0, lane); else sfx.perfect(0, lane);
      return ctx.oscs[0].frequency.value / (kind === 'hit' ? 1500 : 1800);
    };
    expect(LANE_SEMITONES).toEqual([0, 3, 7, 12]);
    expect(laneRatio(undefined)).toBe(1);
    expect(laneRatio(0)).toBe(1);
    expect(laneRatio(1)).toBeCloseTo(Math.pow(2, 3 / 12), 12);
    expect(laneRatio(3)).toBe(2);
    expect(laneRatio(4)).toBe(1); // wraps
    expect(laneRatio(-1)).toBe(2);
    expect(ratio(undefined)).toBe(1);
    expect(ratio(2)).toBeCloseTo(Math.pow(2, 7 / 12), 12);
    expect(ratio(2, true, 'perfect')).toBeCloseTo(Math.pow(2, 7 / 12), 12);
    expect(ratio(2, false)).toBe(1); // toggled off: every lane identical
    // the glide target and the sparkle notes are transposed with the tick
    const ctx = new FakeCtx();
    new Sfx(asCtx(ctx)).perfect(0, 3);
    expect(ctx.oscs.slice(1).map((o) => o.frequency.value)).toEqual([1568 * 2, 2093 * 2, 3136 * 2]);
    expect(ctx.oscs[0].frequency.events.find((e) => e[0] === 'exp')?.[1]).toBe(1200 * 2);
    // play() accepts the options object and the legacy milestone number
    const c2 = new FakeCtx();
    const s2 = new Sfx(asCtx(c2));
    s2.play('hit', 0, { lane: 3 });
    expect(c2.oscs[0].frequency.value).toBe(3000);
    c2.oscs = [];
    s2.play('combo', 0, 25);
    expect(c2.oscs).toHaveLength(5);
    c2.oscs = [];
    s2.play('combo', 0, { milestone: 100 });
    expect(c2.oscs).toHaveLength(7);
    // miss and combo never vary per lane
    c2.oscs = [];
    s2.play('miss', 0, { lane: 3 });
    expect(c2.oscs[0].frequency.value).toBe(150);
  });

  it('volume ramps anchor on the analytic value when the slider moves faster than the ramp', () => {
    const ctx = new FakeCtx();
    ctx.currentTime = 1;
    const sfx = new Sfx(asCtx(ctx), undefined, 0);
    const out = ctx.gains[0];
    sfx.volume = 1; // 0 → 1 over [1, 1.02]
    ctx.currentTime = 1.01;
    sfx.volume = 0.2; // half-way through the previous ramp: anchored at 0.5, not at its target 1
    expect(out.gain.value).toBeCloseTo(0.5, 12); // the anchor setValueAtTime wrote by the fake
    expect(out.gain.events.slice(-3)).toEqual([['cancel', 0, 1.01], ['set', expect.closeTo(0.5, 12), 1.01], ['lin', 0.2, expect.closeTo(1.03, 12)]]);
  });
});
