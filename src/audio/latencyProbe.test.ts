import { describe, expect, it } from 'vitest';
import {
  CALIBRATION_BPM_STEPS,
  LatencyProbe,
  PROBE_ALIAS_OFFSET_SEC,
  clickSchedule,
  computeProbeResult,
  diagnoseCalibration,
  diagnosisMessage,
  isBeatAliased,
  probeMessage,
  suggestedCalibrationBpm,
  type ProbeDiagnosis,
} from './latencyProbe';
import { CALIBRATION_BPM_RECOMMENDED, LATENCY_MAX_REJECTED_FRACTION, calibrateLatency } from '../engine/latency';

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

  // ---- the target population: a consistently slow patient must never hit a dead end -------------

  // 450 ms and 600 ms are past the engine's LATENCY_MAX_OFFSET_SEC (0.4 s) plausibility flag but
  // well inside the 60 BPM pairing window. Refusing these runs would leave inputLatencySec at 0,
  // miss every note at a 50–90 ms window and duck the player stem to silence for the whole song.
  for (const lag of [0.45, 0.6]) {
    it(`accepts a rehab patient who answers ${lag * 1000} ms after each click, with a warning and a remedy`, () => {
      const inputs = clicks.map((t, i) => t + lag + (i % 2 === 0 ? 0.02 : -0.02));
      const r = computeProbeResult(clicks, inputs);
      expect(r.pairing.unpairedBeats).toBe(0);
      expect(r.offsetSec).toBeCloseTo(lag, 6);
      expect(r.madSec).toBeCloseTo(0.02, 6); // their timing is excellent
      expect(r.implausibleOffset).toBe(true); // …but the lag is bigger than the camera pipeline
      expect(r.accepted).toBe(true); // accepted anyway: this offset is exactly what makes play fair
      expect(r.warning).toBe(true);
      expect(r.diagnosis).toBe('reacting-not-anticipating');
      expect(r.apparentLagSec).toBeCloseTo(lag, 6);
      expect(r.message).toMatch(new RegExp(`${Math.round(lag * 1000)} ms`));
      expect(r.message).toMatch(/accepted/i);
      // The remedy is concrete, not "try again". 450 ms already fits inside half of a 60 BPM beat,
      // so no slower tempo is offered; 600 ms does not, so 50 BPM (a 1.2 s beat) is.
      if (lag === 0.45) expect(r.suggestedBpm).toBeNull();
      else {
        expect(r.suggestedBpm).toBe(50);
        expect(CALIBRATION_BPM_STEPS).toContain(r.suggestedBpm!);
      }
    });
  }

  it('a lag under the plausibility flag is plain "ok" with no warning and no retry nag', () => {
    const inputs = clicks.map((t) => t + 0.25);
    const r = computeProbeResult(clicks, inputs);
    expect(r.diagnosis).toBe('ok');
    expect(r.accepted).toBe(true);
    expect(r.warning).toBe(false);
    expect(r.suggestedBpm).toBeNull();
  });

  it('rejects a beat-aliased run instead of reporting a confident negative offset', () => {
    // 800 ms lag at 60 BPM: every input lands past the +0.75 s window of the beat it answers and
    // pairs with the NEXT click, so the engine measures a tight, "confident" −0.2 s. Feeding that
    // to the session would judge the patient 200 ms EARLY — worse than not calibrating at all.
    const inputs = clicks.map((t) => t + 0.8);
    const r = computeProbeResult(clicks, inputs);
    expect(r.confident).toBe(true); // the engine, which cannot see the beat grid, is happy
    expect(r.offsetSec).toBeCloseTo(-0.2, 6);
    expect(r.pairing.unpairedBeats).toBe(1);
    expect(r.pairing.spuriousInputs).toBe(1);
    expect(r.accepted).toBe(false); // the probe knows the beat interval and refuses it
    expect(r.warning).toBe(false);
    expect(r.diagnosis).toBe('reacting-previous-beat');
    expect(r.apparentLagSec).toBeCloseTo(0.8, 6); // the lag they actually have
    expect(r.message).toMatch(/800 ms/);
    expect(r.suggestedBpm).toBe(30);
  });

  it('does not mistake ordinary anticipation for beat aliasing', () => {
    const inputs = clicks.map((t) => t - 0.05); // healthy negative mean asynchrony
    const r = computeProbeResult(clicks, inputs);
    expect(r.accepted).toBe(true);
    expect(r.diagnosis).toBe('ok');
    expect(Math.abs(r.offsetSec)).toBeLessThan(PROBE_ALIAS_OFFSET_SEC);
  });

  it('isBeatAliased needs a negative offset AND a leftover beat/input, and a known beat interval', () => {
    const aliased = calibrateLatency(clicks, clicks.map((t) => t + 0.8));
    expect(isBeatAliased(aliased, 1, 6)).toBe(true);
    expect(isBeatAliased(aliased, undefined, 6)).toBe(false); // no beat interval: cannot tell
    expect(isBeatAliased(aliased, 1, 99)).toBe(false); // too few samples to conclude anything
    const clean = calibrateLatency(clicks, clicks.map((t) => t - 0.05));
    expect(isBeatAliased(clean, 1, 6)).toBe(false);
  });

  it('suggestedCalibrationBpm picks a tempo where the lag is under half a beat', () => {
    expect(suggestedCalibrationBpm(0.6, 60)).toBe(50); // needs a 1.2 s beat → 50 BPM
    expect(suggestedCalibrationBpm(0.8, 60)).toBe(30); // needs 1.6 s → the slowest step
    expect(suggestedCalibrationBpm(5, 60)).toBe(30); // clamped, never returns an absurd tempo
    expect(suggestedCalibrationBpm(0.2, 60)).toBeNull(); // 60 BPM already has room
    expect(suggestedCalibrationBpm(0.45, 100)).toBe(60);
    expect(suggestedCalibrationBpm(0.6, 30)).toBeNull(); // already at the slowest useful tempo
    expect(suggestedCalibrationBpm(Number.NaN, 60)).toBeNull();
    expect(suggestedCalibrationBpm(0.5, 0)).toBeNull();
  });

  it('at 100 BPM (the original spec tempo) a 500 ms patient is caught, not silently mismeasured', () => {
    // this is why the probe defaults to 60 BPM: at a 0.6 s beat the same patient aliases, and the
    // alias bound has to scale with the beat (0.15 × beat) to catch the −0.1 s it produces
    const fast = clickSchedule(5, 100, 16);
    const r = computeProbeResult(fast, fast.map((t) => t + 0.5));
    expect(r.offsetSec).toBeCloseTo(-0.1, 6);
    expect(r.confident).toBe(true);
    expect(r.accepted).toBe(false);
    expect(r.diagnosis).toBe('reacting-previous-beat');
    expect(r.apparentLagSec).toBeCloseTo(0.5, 6);
    expect(r.suggestedBpm).toBe(60);
    // the same patient at the default 60 BPM is measured correctly and accepted
    const slow = clickSchedule(5, 60, 16);
    const ok = computeProbeResult(slow, slow.map((t) => t + 0.5));
    expect(ok.accepted).toBe(true);
    expect(ok.offsetSec).toBeCloseTo(0.5, 6);
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
    // the smallest number of far-off inputs (>0.25 s from the median but inside the late window)
    // that exceeds the engine's rejected-fraction threshold — derived from the constant so this
    // test tracks the engine's definition instead of hard-coding it
    const outliers = Math.floor(clicks.length * LATENCY_MAX_REJECTED_FRACTION) + 1;
    const tight = clicks.length - outliers;
    expect(outliers / clicks.length).toBeGreaterThan(LATENCY_MAX_REJECTED_FRACTION);
    expect(tight).toBeGreaterThanOrEqual(6); // still enough tight samples that "too-few" does not fire
    const inputs = clicks.map((t, i) => t + (i < tight ? 0.1 : 0.7));
    const r = computeProbeResult(clicks, inputs);
    expect(r.samples).toBe(tight);
    expect(r.rejected).toBe(outliers);
    expect(r.confident).toBe(false);
    expect(diagnoseCalibration(r, clicks.length)).toBe('too-many-outliers');
  });

  const ALL_DIAGNOSES: ProbeDiagnosis[] = [
    'ok', 'no-input', 'out-of-window', 'too-few', 'too-jittery', 'too-many-outliers',
    'reacting-not-anticipating', 'reacting-previous-beat',
  ];

  it('every diagnosis has a message', () => {
    for (const d of ALL_DIAGNOSES) {
      expect(diagnosisMessage(d).length).toBeGreaterThan(10);
      expect(probeMessage(d, { apparentLagSec: 0.5, suggestedBpm: 40 }).length).toBeGreaterThan(10);
    }
  });

  it('no diagnosis leaves the patient without an action', () => {
    // "try again" with nothing changed is a dead end: every failure names something to do
    for (const d of ALL_DIAGNOSES) {
      if (d === 'ok') continue;
      expect(probeMessage(d, { apparentLagSec: 0.6, suggestedBpm: 40 })).toMatch(/try|check|move|slower|run the calibration/i);
    }
  });

  it('out-of-window sizes its retry tempo from the recording itself (there are no pairs to measure)', () => {
    // 100 BPM (0.6 s beat), a 450 ms lag and a tight ±0.1 s window: 0.45 from the click answered,
    // 0.15 from the next one, so nothing pairs at all and there is no offset to read
    const fast = clickSchedule(5, 100, 16);
    const r = computeProbeResult(fast, fast.map((t) => t + 0.45), { window: 0.1 });
    expect(r.pairing.pairs).toHaveLength(0);
    expect(r.pairing.spuriousInputs).toBe(16);
    expect(r.diagnosis).toBe('out-of-window');
    expect(r.suggestedBpm).toBe(60); // 0.45 s lag needs a ≥0.9 s beat
    expect(r.message).toMatch(/60 BPM/);
    // at 60 BPM the same lag already fits in half a beat: the window, not the tempo, was the problem
    expect(computeProbeResult(clicks, clicks.map((t) => t + 0.5), { window: 0.2 }).suggestedBpm).toBeNull();
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
  gains: FakeGain[] = [];
  createGain() { const g = new FakeGain(); this.gains.push(g); return g; }
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

  it('cancel disconnects the envelope gain of every unplayed click, not just the oscillator', () => {
    const ctx = new FakeCtx();
    const p = new LatencyProbe(asCtx(ctx), { beats: 16, countIn: 4 });
    const out = ctx.gains[0]; // the probe's output bus
    p.start(1);
    const envs = ctx.gains.slice(1);
    expect(envs).toHaveLength(20);
    expect(envs.every((g) => g.connections[0] === out)).toBe(true);

    p.cancel();
    // the env gains are what is wired to `out`; leaving them behind strands 20 live nodes on the
    // bus, and they pile up every time the patient restarts calibration
    expect(envs.every((g) => g.connections.length === 0)).toBe(true);
    expect(ctx.oscs.every((o) => o.connections.length === 0)).toBe(true);

    // a second run wires up exactly its own 20 again
    p.start(10);
    const envs2 = ctx.gains.slice(21);
    expect(envs2).toHaveLength(20);
    expect(envs2.every((g) => g.connections[0] === out)).toBe(true);
    p.dispose();
    expect(ctx.gains.slice(21).every((g) => g.connections.length === 0)).toBe(true);
    expect(out.connections).toHaveLength(0);
  });
});
