import { describe, expect, it } from 'vitest';
import { LatencyProbe, clickSchedule, computeProbeResult, diagnoseCalibration, diagnosisMessage } from './latencyProbe';
import { CALIBRATION_BPM_RECOMMENDED, calibrateLatency } from '../engine/latency';

describe('clickSchedule', () => {
  it('spaces clicks by 60/bpm from the start time', () => {
    const c = clickSchedule(10, 100, 4);
    expect(c).toHaveLength(4);
    expect(c[0]).toBe(10);
    expect(c[1]).toBeCloseTo(10.6, 9);
    expect(c[3]).toBeCloseTo(11.8, 9);
  });
});

describe('computeProbeResult (delegates to engine calibrateLatency)', () => {
  const clicks = clickSchedule(5, 60, 16);

  it('returns exactly the engine estimate for the same recording', () => {
    const inputs = clicks.map((t, i) => t + 0.14 + (i % 3) * 0.01);
    const r = computeProbeResult(clicks, inputs);
    const e = calibrateLatency(clicks, inputs);
    expect(r.offsetSec).toBe(e.offsetSec);
    expect(r.madSec).toBe(e.madSec);
    expect(r.samples).toBe(e.samples);
    expect(r.confidence).toBe(e.confidence);
    expect(r.accepted).toBe(e.confident);
    expect(r.accepted).toBe(true);
    expect(r.diagnosis).toBe('ok');
    expect(r.totalClicks).toBe(16);
    expect(r.inputs).toBe(16);
    expect(r.samplesMs).toHaveLength(16);
    expect(r.samplesMs[0]).toBeCloseTo(140, 6);
    expect(r.offsetSec).toBeCloseTo(0.15, 6);
  });

  it('accepts a slow rehab patient who answers 600 ms after each click at 60 BPM', () => {
    const inputs = clicks.map((t, i) => t + 0.6 + (i % 2 === 0 ? 0.02 : -0.02));
    const r = computeProbeResult(clicks, inputs);
    expect(r.pairing.unpairedBeats).toBe(0);
    expect(r.accepted).toBe(true);
    expect(r.offsetSec).toBeCloseTo(0.6, 6);
  });

  it('diagnoses no input', () => {
    const r = computeProbeResult(clicks, []);
    expect(r.accepted).toBe(false);
    expect(r.diagnosis).toBe('no-input');
    expect(r.offsetSec).toBe(0);
    expect(r.pairing.unpairedBeats).toBe(16);
    expect(r.message).toMatch(/camera/i);
  });

  it('diagnoses inputs that fall outside the pairing window as out-of-window', () => {
    // symmetric ±0.2 s window, patient consistently 0.5 s late → nothing pairs, but inputs exist
    const inputs = clicks.map((t) => t + 0.5);
    const r = computeProbeResult(clicks, inputs, { window: 0.2 });
    expect(r.pairing.pairs).toHaveLength(0);
    expect(r.pairing.spuriousInputs).toBe(16);
    expect(r.diagnosis).toBe('out-of-window');
    expect(r.message).toMatch(/slower tempo/);
  });

  it('diagnoses too few answered beats', () => {
    const inputs = clicks.slice(0, 3).map((t) => t + 0.1);
    const r = computeProbeResult(clicks, inputs);
    expect(r.samples).toBe(3);
    expect(r.diagnosis).toBe('too-few');
  });

  it('diagnoses jitter', () => {
    const inputs = clicks.map((t, i) => t + (i % 2 === 0 ? 0.05 : 0.25));
    const r = computeProbeResult(clicks, inputs);
    expect(r.samples).toBe(16);
    expect(r.madSec).toBeGreaterThan(0.05);
    expect(r.diagnosis).toBe('too-jittery');
  });

  it('diagnoses outlier-heavy runs', () => {
    // 10 tight samples, 6 far-off (>0.25 s from the median but inside the late window)
    const inputs = clicks.map((t, i) => t + (i < 10 ? 0.1 : 0.7));
    const r = computeProbeResult(clicks, inputs);
    expect(r.samples).toBe(10);
    expect(r.rejected).toBe(6);
    expect(r.confident).toBe(false);
    expect(diagnoseCalibration(r, 16)).toBe('too-many-outliers');
  });

  it('every diagnosis has a message', () => {
    for (const d of ['ok', 'no-input', 'out-of-window', 'too-few', 'too-jittery', 'too-many-outliers'] as const) {
      expect(diagnosisMessage(d).length).toBeGreaterThan(10);
    }
  });
});

// ---------------------------------------------------------------- LatencyProbe class with a fake context

class FakeParam {
  value = 0;
  events: [string, number, number][] = [];
  setValueAtTime(v: number, t: number) { this.events.push(['set', v, t]); this.value = v; return this; }
  exponentialRampToValueAtTime(v: number, t: number) { this.events.push(['exp', v, t]); return this; }
  linearRampToValueAtTime(v: number, t: number) { this.events.push(['lin', v, t]); return this; }
  cancelScheduledValues() { return this; }
}
class FakeNode {
  connections: FakeNode[] = [];
  connect(n: FakeNode) { this.connections.push(n); return n; }
  disconnect() { this.connections = []; }
}
class FakeGain extends FakeNode { gain = new FakeParam(); }
class FakeOsc extends FakeNode {
  type = 'sine';
  frequency = new FakeParam();
  onended: (() => void) | null = null;
  startAt: number | null = null;
  stopAt: number | null = null;
  start(t: number) { this.startAt = t; }
  stop(t?: number) { if (this.startAt === null) throw new Error('InvalidStateError'); this.stopAt = t ?? -1; }
}
class FakeCtx {
  currentTime = 0;
  state: 'suspended' | 'running' | 'closed' = 'running';
  destination = new FakeNode();
  oscs: FakeOsc[] = [];
  createGain() { return new FakeGain(); }
  createOscillator() { const o = new FakeOsc(); this.oscs.push(o); return o; }
}
const asCtx = (c: FakeCtx) => c as unknown as BaseAudioContext;

describe('LatencyProbe', () => {
  it('defaults to the engine-recommended tempo and the asymmetric pairing window', () => {
    const p = new LatencyProbe(asCtx(new FakeCtx()));
    expect(p.bpm).toBe(CALIBRATION_BPM_RECOMMENDED);
    expect(p.beatSec).toBe(1);
    expect(p.window).toEqual({ earlySec: 0.25, lateSec: 0.75 });
    expect(new LatencyProbe(asCtx(new FakeCtx()), { window: 0.3 }).window).toEqual({ earlySec: 0.3, lateSec: 0.3 });
  });

  it('refuses to start on a suspended context (clicks would burst on resume)', () => {
    const ctx = new FakeCtx();
    ctx.state = 'suspended';
    const p = new LatencyProbe(asCtx(ctx));
    expect(() => p.start()).toThrow(/suspended/);
    expect(p.isRunning).toBe(false);
    expect(ctx.oscs).toHaveLength(0);
  });

  it('schedules count-in + measured clicks on the ctx clock, accents every 4 measured clicks', () => {
    const ctx = new FakeCtx();
    ctx.currentTime = 10;
    const p = new LatencyProbe(asCtx(ctx), { bpm: 120, beats: 8, countIn: 2 });
    const s = p.start();
    expect(s.countInTimes).toEqual([10.5, 11]);
    expect(s.clickTimes).toHaveLength(8);
    expect(s.clickTimes[0]).toBeCloseTo(11.5, 9);
    expect(s.clickTimes[7]).toBeCloseTo(15, 9);
    expect(s.endsAt).toBeCloseTo(15 + 0.75 * 0.5, 9);
    expect(ctx.oscs).toHaveLength(10);
    expect(ctx.oscs.map((o) => o.startAt)).toEqual([...s.countInTimes, ...s.clickTimes]);
    // count-in clicks are never accented; measured clicks 0 and 4 are
    const freqs = ctx.oscs.map((o) => o.frequency.value);
    expect(freqs.slice(0, 2)).toEqual([1000, 1000]);
    expect(freqs.slice(2)).toEqual([1500, 1000, 1000, 1000, 1500, 1000, 1000, 1000]);
    expect(p.isRunning).toBe(true);
    expect(p.nextClickIndex(11.6)).toBe(1);
    expect(p.nextClickIndex(16)).toBe(-1);
    expect(p.isComplete(14)).toBe(false);
    expect(p.isComplete(s.endsAt)).toBe(true);
  });

  it('never schedules the first click in the past', () => {
    const ctx = new FakeCtx();
    ctx.currentTime = 20;
    const p = new LatencyProbe(asCtx(ctx), { countIn: 0, beats: 2 });
    const s = p.start(3);
    expect(s.clickTimes[0]).toBeCloseTo(20.05, 9);
  });

  it('records inputs only while running and ignores count-in inputs', () => {
    const ctx = new FakeCtx();
    const p = new LatencyProbe(asCtx(ctx), { beats: 4, countIn: 2 });
    p.recordInput(1);
    expect(p.inputTimes).toEqual([]);
    const s = p.start(1); // count-in at 1, 2; measured at 3, 4, 5, 6
    p.recordInput(1.2); // count-in
    p.recordInput(2.2); // count-in
    p.recordInput(3.15);
    p.recordInput(Number.NaN);
    p.recordInput(4.1);
    expect(p.countInInputs).toBe(2);
    expect(p.inputTimes).toEqual([3.15, 4.1]);
    expect(s.clickTimes).toEqual([3, 4, 5, 6]);
  });

  it('finish silences pending clicks, stops recording and returns the engine result', () => {
    const ctx = new FakeCtx();
    const p = new LatencyProbe(asCtx(ctx), { beats: 8, countIn: 0, latency: { minSamples: 4 } });
    const s = p.start(1);
    for (const t of s.clickTimes) p.recordInput(t + 0.2);
    const r = p.finish();
    expect(p.isRunning).toBe(false);
    expect(ctx.oscs.every((o) => o.stopAt === -1)).toBe(true);
    expect(r.samples).toBe(8);
    expect(r.offsetSec).toBeCloseTo(0.2, 9);
    expect(r.accepted).toBe(true);
    expect(r.diagnosis).toBe('ok');
    p.recordInput(9);
    expect(p.inputTimes).toHaveLength(8);
    p.dispose();
  });

  it('cancel clears the recording and start can be called again', () => {
    const ctx = new FakeCtx();
    const p = new LatencyProbe(asCtx(ctx), { beats: 2, countIn: 0 });
    p.start(1);
    p.recordInput(1.1);
    p.cancel();
    expect(p.clickTimes).toEqual([]);
    expect(p.inputTimes).toEqual([]);
    expect(p.isRunning).toBe(false);
    ctx.currentTime = 5;
    const s = p.start();
    expect(s.clickTimes[0]).toBeCloseTo(5.5, 9);
  });
});
