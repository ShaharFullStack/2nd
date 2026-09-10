// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  CALIBRATION_BPM_RECOMMENDED,
  LATENCY_FRAME_SEC,
  LATENCY_MAX_OFFSET_SEC,
  LATENCY_MAX_REJECTED_FRACTION,
  LATENCY_PLAUSIBLE_OFFSET_SEC,
  beatIntervalOf,
  calibrateLatency,
  defaultPairingWindow,
  estimateLatency,
  estimateLatencyFromDeltas,
  mad,
  median,
  pairInputsToBeats,
  pairInputsToBeatsDetailed,
} from './latency.ts';

/** mulberry32 (local copy so the test does not depend on charts/). */
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
function gaussian(rand: () => number): number {
  const u = 1 - rand();
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

describe('median / mad', () => {
  it('handles odd, even and empty', () => {
    expect(median([])).toBe(0);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(mad([1, 2, 3, 4, 100])).toBe(1);
  });
});

describe('estimateLatency', () => {
  it('computes the median offset and rejects outliers > 250 ms from the median', () => {
    const pairs = [0.1, 0.12, 0.11, 0.13, 0.09, 0.1, 0.4, -0.3].map((d, i) => ({ expected: i, observed: i + d }));
    const est = estimateLatency(pairs);
    expect(est.offsetSec).toBeCloseTo(0.105, 9);
    expect(est.offsetMs).toBeCloseTo(105, 6);
    expect(est.samples).toBe(6);
    expect(est.rejected).toBe(2);
    expect(est.unpaired).toBe(0);
    expect(est.madSec).toBeCloseTo(0.01, 9);
    expect(est.confident).toBe(true);
    expect(est.confidence).toBeGreaterThanOrEqual(0.5);
    expect(est.quality).toBe('fair'); // 6 samples = exactly minSamples -> sampleScore 0.5
  });
  it('rejects relative to a robust centre, so a genuine 200 ms latency is not trimmed asymmetrically', () => {
    // spread ±60 ms about 200 ms: nothing should be rejected (old code cut everything above 250 ms)
    const ds = [0.14, 0.26, 0.2, 0.25, 0.15, 0.2, 0.26, 0.14, 0.2, 0.2];
    const est = estimateLatency(ds.map((d, i) => ({ expected: i, observed: i + d })));
    expect(est.rejected).toBe(0);
    expect(est.samples).toBe(10);
    expect(est.offsetSec).toBeCloseTo(0.2, 9);
    expect(est.confident).toBe(true);
    // a 300 ms consistent offset is perfectly valid data
    const e3 = estimateLatency([0.3, 0.31, 0.29, 0.3, 0.32, 0.28, 0.3].map((d, i) => ({ expected: i, observed: i + d })));
    expect(e3.samples).toBe(7);
    expect(e3.offsetSec).toBeCloseTo(0.3, 9);
    expect(e3.confident).toBe(true);
    // but > 1 s is implausible and > 250 ms from the median is an outlier
    const e4 = estimateLatency([0.3, 0.31, 0.29, 0.3, 0.32, 0.28, 0.3, 1.2, 0.7].map((d, i) => ({ expected: i, observed: i + d })));
    expect(e4.samples).toBe(7);
    expect(e4.rejected).toBe(2);
  });
  it('flags a large offset as advisory without failing the measurement (shared semantic with LatencyProbe)', () => {
    const late = estimateLatency([0.7, 0.71, 0.69, 0.7, 0.72, 0.68, 0.7, 0.7].map((d, i) => ({ expected: i, observed: i + d })));
    expect(late.offsetSec).toBeCloseTo(0.7, 9);
    expect(late.samples).toBe(8); // the samples themselves are consistent and kept
    expect(late.implausibleOffset).toBe(true);
    expect(late.offsetPlausibility).toBe(0);
    // the measurement is sound: a patient who consistently answers 700 ms late HAS been measured,
    // and 0.7 s is the right offset to compensate with. `confident` must not depend on magnitude —
    // src/audio/latencyProbe.ts maps it to `accepted`.
    expect(late.confident).toBe(true);
    expect(late.confidence).toBeGreaterThanOrEqual(0.5);
    expect(late.quality).not.toBe('none');
    // early is just as flagged
    const early = estimateLatency([-0.5, -0.5, -0.49, -0.51, -0.5, -0.5, -0.5, -0.5].map((d, i) => ({ expected: i, observed: i + d })));
    expect(early.implausibleOffset).toBe(true);
    expect(early.confident).toBe(true);
    // plausibility band: 0.3 s fully trusted, 0.35 s graded down, 0.4 s the flag edge
    const at = (d: number) => estimateLatency(Array.from({ length: 16 }, (_, i) => ({ expected: i, observed: i + d })));
    expect(at(0.3).offsetPlausibility).toBeCloseTo(1, 9);
    expect(at(0.3).confidence).toBeCloseTo(1, 9);
    expect(at(0.3).quality).toBe('good');
    expect(at(0.35).offsetPlausibility).toBeCloseTo(0.75, 9);
    expect(at(0.35).implausibleOffset).toBe(false);
    expect(at(LATENCY_MAX_OFFSET_SEC).offsetPlausibility).toBeCloseTo(0.5, 9);
    expect(at(LATENCY_MAX_OFFSET_SEC).implausibleOffset).toBe(false);
    expect(at(0.401).implausibleOffset).toBe(true);
    // measurement quality is untouched by the magnitude at every point of the band
    for (const d of [0.3, 0.35, LATENCY_MAX_OFFSET_SEC, 0.401, 0.9]) expect(at(d).confident).toBe(true);
    expect(LATENCY_PLAUSIBLE_OFFSET_SEC).toBeLessThan(LATENCY_MAX_OFFSET_SEC);
    // therapist override for slow pipelines silences the flag
    expect(at(0.5).implausibleOffset).toBe(true);
    const tolerant = estimateLatency(Array.from({ length: 16 }, (_, i) => ({ expected: i, observed: i + 0.5 })), { maxOffsetSec: 0.6, plausibleOffsetSec: 0.5 });
    expect(tolerant.implausibleOffset).toBe(false);
    expect(tolerant.confident).toBe(true);
    expect(estimateLatency([]).implausibleOffset).toBe(false);
    expect(estimateLatency([]).offsetPlausibility).toBe(0);
  });
  it('is not confident with too few samples, high spread, or mostly outliers', () => {
    expect(estimateLatency([{ expected: 0, observed: 0.1 }]).confident).toBe(false);
    const noisy = [0.0, 0.2, 0.05, 0.18, 0.02, 0.15, 0.01, 0.19].map((d, i) => ({ expected: i, observed: i + d }));
    const n = estimateLatency(noisy);
    expect(n.confident).toBe(false);
    expect(n.quality).toBe('poor');
    const manyBad = [0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.9, 0.9, 0.9, 0.9, 0.9].map((d, i) => ({ expected: i, observed: i + d }));
    const e = estimateLatency(manyBad);
    expect(e.samples).toBe(7);
    expect(e.rejected).toBe(5); // 5/12 > 40 % rejected
    expect(e.confident).toBe(false);
    const empty = estimateLatency([]);
    expect(empty.confident).toBe(false);
    expect(empty.offsetSec).toBe(0);
    expect(empty.confidence).toBe(0);
    expect(empty.quality).toBe('none');
    expect(estimateLatency([{ expected: 0, observed: Number.NaN }]).rejected).toBe(1);
  });
  it('rejected-fraction boundary on a 16-beat run: 5 rejected beats pass, 6 do not', () => {
    const beats = Array.from({ length: 16 }, (_, i) => 2 + i);
    const five = calibrateLatency(beats, beats.map((b, i) => b + (i < 11 ? 0.1 : 0.7)));
    expect(five.samples).toBe(11);
    expect(five.rejected).toBe(5);
    expect(five.confident).toBe(true);
    const six = calibrateLatency(beats, beats.map((b, i) => b + (i < 10 ? 0.1 : 0.7)));
    expect(six.samples).toBe(10);
    expect(six.rejected).toBe(6);
    expect(six.confident).toBe(false);
    expect(six.confidence).toBeLessThan(0.5);
    expect(six.quality).toBe('poor');
    expect(LATENCY_MAX_REJECTED_FRACTION).toBeCloseTo(1 / 3, 12);
  });
  it('counts unpaired beats as rejected', () => {
    const good = [0.1, 0.1, 0.1, 0.1, 0.1, 0.1].map((d, i) => ({ expected: i, observed: i + d }));
    expect(estimateLatency(good).confident).toBe(true);
    const e = estimateLatency(good, { unpaired: 10 });
    expect(e.rejected).toBe(10);
    expect(e.unpaired).toBe(10);
    expect(e.confident).toBe(false);
  });
  it('respects options', () => {
    const pairs = [0.3, 0.31, 0.29].map((d, i) => ({ expected: i, observed: i + d }));
    expect(estimateLatency(pairs, { maxAbsSec: 0.25 }).samples).toBe(0);
    const e = estimateLatency(pairs, { minSamples: 3 });
    expect(e.samples).toBe(3);
    expect(e.confident).toBe(true);
    expect(e.offsetSec).toBeCloseTo(0.3);
    expect(estimateLatency(pairs, { minSamples: 3, maxMadSec: 0.001 }).confident).toBe(false);
  });
  it('confidence is graded: confident <=> confidence >= 0.5', () => {
    const rand = prng(5);
    for (let trial = 0; trial < 200; trial++) {
      const n = 1 + Math.floor(rand() * 20);
      const sd = rand() * 0.12;
      const pairs = [];
      for (let i = 0; i < n; i++) pairs.push({ expected: i, observed: i + 0.15 + sd * gaussian(rand) });
      const e = estimateLatency(pairs, { unpaired: Math.floor(rand() * 8) });
      expect(e.confident).toBe(e.confidence >= 0.5);
      expect(e.confidence).toBeGreaterThanOrEqual(0);
      expect(e.confidence).toBeLessThanOrEqual(1);
    }
  });
});

describe('pairInputsToBeats', () => {
  it('matches each beat with its nearest input, each input at most once (explicit radius)', () => {
    const beats = [1, 2, 3, 4];
    const inputs = [1.1, 2.12, 2.5, 3.9, 6.0];
    const pairs = pairInputsToBeats(beats, inputs, 0.25);
    expect(pairs).toEqual([
      { expected: 1, observed: 1.1 },
      { expected: 2, observed: 2.12 },
      { expected: 4, observed: 3.9 },
    ]);
    const d = pairInputsToBeatsDetailed(beats, inputs, 0.25);
    expect(d.unpairedBeats).toBe(1);
    expect(d.spuriousInputs).toBe(2);
    expect(d.window).toEqual({ earlySec: 0.25, lateSec: 0.25 });
  });
  it('derives an asymmetric window from the beat interval by default', () => {
    expect(beatIntervalOf([0, 1, 2, 3])).toBe(1);
    expect(beatIntervalOf([5])).toBe(1);
    expect(beatIntervalOf([0, 0.5, 1.0])).toBe(0.5);
    expect(defaultPairingWindow(1)).toEqual({ earlySec: 0.25, lateSec: 0.75 });
    expect(defaultPairingWindow(0)).toEqual({ earlySec: 0.25, lateSec: 0.75 });
    // 60 bpm, a crossing consistently 300 ms after each beat (camera 200 ms + time to reach ROM threshold)
    const beats = Array.from({ length: 8 }, (_, i) => i);
    const inputs = beats.map((b) => b + 0.3);
    const d = pairInputsToBeatsDetailed(beats, inputs);
    expect(d.pairs.length).toBe(8);
    expect(d.unpairedBeats).toBe(0);
    expect(d.pairs.every((p) => Math.abs(p.observed - p.expected - 0.3) < 1e-9)).toBe(true);
    // an input 0.6 s after beat k pairs with beat k, not with beat k+1 (-0.4 s is outside the early window)
    expect(pairInputsToBeats([1, 2], [1.6])).toEqual([{ expected: 1, observed: 1.6 }]);
  });
});

describe('calibrateLatency (30 fps camera model)', () => {
  const FRAME = LATENCY_FRAME_SEC;
  const beatSec = 60 / CALIBRATION_BPM_RECOMMENDED;
  const beats = Array.from({ length: 16 }, (_, i) => 2 + i * beatSec);

  /** Simulate a patient with timing SD `sdSec` through a pipeline with latency `latencySec` sampled at 30 fps. */
  function simulate(rand: () => number, latencySec: number, sdSec: number, missProb = 0): number[] {
    const inputs: number[] = [];
    for (const b of beats) {
      if (rand() < missProb) continue;
      const physical = b + sdSec * gaussian(rand);
      const observed = physical + latencySec;
      inputs.push(Math.ceil(observed / FRAME) * FRAME); // seen on the next camera frame
    }
    return inputs;
  }

  it('a consistently late (300 ms) patient yields real data, not {samples:0, offset:0}', () => {
    const r = calibrateLatency(beats, beats.map((b) => b + 0.3));
    expect(r.samples).toBe(16);
    expect(r.rejected).toBe(0);
    expect(r.offsetSec).toBeCloseTo(0.3, 9);
    expect(r.confident).toBe(true);
    expect(r.quality).toBe('good');
    expect(r.implausibleOffset).toBe(false);
  });
  it('a slow patient answering 600 ms after each click pairs, is accepted, and is flagged for review', () => {
    const r = calibrateLatency(beats, beats.map((b) => b + 0.6));
    expect(r.samples).toBe(16);
    expect(r.pairing.unpairedBeats).toBe(0);
    expect(r.offsetSec).toBeCloseTo(0.6, 9);
    // accepted (this is exactly what src/audio/latencyProbe.test.ts asserts for the same recording)
    expect(r.confident).toBe(true);
    expect(r.quality).toBe('good');
    // ...but the magnitude is well beyond the documented 80-200 ms pipeline, so the screen warns
    expect(r.implausibleOffset).toBe(true);
    expect(r.offsetPlausibility).toBe(0);
  });
  it('unpaired beats are counted as rejected, so a patient who mostly did not move is diagnosed', () => {
    const r = calibrateLatency(beats, [beats[0] + 0.2, beats[3] + 0.2, beats[8] + 0.2]);
    expect(r.samples).toBe(3);
    expect(r.unpaired).toBe(13);
    expect(r.rejected).toBe(13);
    expect(r.confident).toBe(false);
    expect(r.pairing.unpairedBeats).toBe(13);
  });
  it('is confident for healthy (SD 25 ms) and impaired (SD 45 ms) tappers at 30 fps, with an accurate offset', () => {
    const rand = prng(2024);
    const trials = 300;
    for (const [sd, minRate] of [
      [0.025, 0.97],
      [0.045, 0.9],
    ] as const) {
      let confident = 0;
      let offsetErrs: number[] = [];
      for (let t = 0; t < trials; t++) {
        const latency = 0.08 + rand() * 0.12; // 80..200 ms pipeline
        const r = calibrateLatency(beats, simulate(rand, latency, sd));
        if (r.confident) confident++;
        offsetErrs.push(Math.abs(r.offsetSec - latency - FRAME / 2)); // quantisation adds ~half a frame
        expect(r.samples).toBe(16);
      }
      expect(confident / trials, `sd=${sd}`).toBeGreaterThanOrEqual(minRate);
      expect(median(offsetErrs)).toBeLessThan(0.02);
      offsetErrs = [];
    }
  });
  it('is not confident when the patient is erratic (SD 120 ms) or skips most beats', () => {
    const rand = prng(77);
    let confident = 0;
    for (let t = 0; t < 100; t++) if (calibrateLatency(beats, simulate(rand, 0.15, 0.12)).confident) confident++;
    expect(confident / 100).toBeLessThan(0.2);
    let skipConfident = 0;
    for (let t = 0; t < 100; t++) if (calibrateLatency(beats, simulate(rand, 0.15, 0.03, 0.6)).confident) skipConfident++;
    expect(skipConfident / 100).toBeLessThan(0.2);
  });
  it('ignores spurious extra movements between beats', () => {
    const rand = prng(3);
    const inputs = simulate(rand, 0.15, 0.02);
    const extras = beats.map((b) => b + 0.75 + 0.05 * rand());
    const r = calibrateLatency(beats, inputs.concat(extras));
    expect(r.samples).toBe(16);
    expect(r.pairing.spuriousInputs).toBe(16);
    expect(r.offsetSec).toBeCloseTo(0.15 + FRAME / 2, 1);
    expect(r.confident).toBe(true);
  });
});

describe('estimateLatencyFromDeltas (mid-session re-estimation)', () => {
  it('turns signed nearest-note distances into the same estimate as beat pairs', () => {
    const deltas = [0.18, 0.182, 0.179, 0.181, 0.18, 0.178, 0.183, 0.18];
    const a = estimateLatencyFromDeltas(deltas);
    const b = estimateLatency(deltas.map((d, i) => ({ expected: i, observed: i + d })));
    expect(a.offsetSec).toBeCloseTo(b.offsetSec, 12);
    expect(a.madSec).toBeCloseTo(b.madSec, 12);
    expect(a.samples).toBe(b.samples);
    expect(a.confident).toBe(true);
    expect(a.offsetSec).toBeCloseTo(0.18, 9);
    expect(a.implausibleOffset).toBe(false);
  });
  it('rejects outliers, is not confident on noise, and handles an empty pool', () => {
    const withOutliers = [0.18, 0.18, 0.19, 0.17, 0.18, 0.18, 0.9, -0.8];
    const r = estimateLatencyFromDeltas(withOutliers);
    expect(r.samples).toBe(6);
    expect(r.rejected).toBe(2);
    expect(r.offsetSec).toBeCloseTo(0.18, 6);
    const noisy = estimateLatencyFromDeltas([0.02, 0.2, -0.1, 0.15, -0.05, 0.18, 0.01, 0.22]);
    expect(noisy.confident).toBe(false);
    const empty = estimateLatencyFromDeltas([]);
    expect(empty.samples).toBe(0);
    expect(empty.confident).toBe(false);
    expect(empty.offsetSec).toBe(0);
  });
});
