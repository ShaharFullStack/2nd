import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GEOMETRY_OPTIONS,
  beatLineTimes,
  bucketRadius,
  depthAtY,
  depthOf,
  fillBeatLines,
  isVisibleDepth,
  MAX_BEAT_LINES,
  visibleTailSec,
  laneBoundaryX,
  laneX,
  makeGeometry,
  project,
  radiusBucket,
  roadEdgeX,
  roadWidthFactor,
  scaleAt,
  visibleTimeWindow,
  yAt,
} from './geometry';

const W = 1920;
const H = 1080;

describe('makeGeometry', () => {
  it('places the strike line and horizon at the requested fractions', () => {
    const g = makeGeometry(W, H, 4);
    expect(g.strikeY).toBeCloseTo(0.82 * H, 6);
    expect(g.horizonY).toBeCloseTo(0.35 * H, 6);
    expect(yAt(g, 0)).toBeCloseTo(g.strikeY, 6);
    expect(yAt(g, 1)).toBeCloseTo(g.horizonY, 6);
    // Vanishing point sits above the visible horizon.
    expect(g.vpY).toBeLessThan(g.horizonY);
    expect(g.vpX).toBe(W / 2);
  });

  it('honours custom options', () => {
    const g = makeGeometry(W, H, 4, { strikeY: 0.9, horizonY: 0.3, approachSec: 2.5, farScale: 0.1 });
    expect(yAt(g, 0)).toBeCloseTo(0.9 * H);
    expect(yAt(g, 1)).toBeCloseTo(0.3 * H);
    expect(g.approachSec).toBe(2.5);
    expect(scaleAt(g, 1)).toBeCloseTo(0.1);
  });

  it('adapts road width to lane count (fewer lanes → narrower road, gems stay sane)', () => {
    const g2 = makeGeometry(W, H, 2);
    const g4 = makeGeometry(W, H, 4);
    expect(g2.nearHalfWidth).toBeLessThan(g4.nearHalfWidth);
    expect(roadWidthFactor(2)).toBeLessThan(roadWidthFactor(4));
    expect(g2.laneWidthNear).toBeGreaterThan(g4.laneWidthNear);
    expect(g2.gemRadiusNear).toBeLessThanOrEqual(H * 0.05);
    expect(g2.gemRadiusNear).toBeGreaterThan(0);
  });
});

describe('depth / scale / y', () => {
  const g = makeGeometry(W, H, 4);

  it('maps song time to depth: 0 at the strike line, 1 at the horizon after approachSec', () => {
    expect(depthOf(g, 10, 10)).toBe(0);
    expect(depthOf(g, 10 + g.approachSec, 10)).toBeCloseTo(1);
    expect(depthOf(g, 10 - 0.4, 10)).toBeCloseTo(-0.25);
  });

  it('scale is 1 at the strike line, farScale at the horizon and monotonic between', () => {
    expect(scaleAt(g, 0)).toBe(1);
    expect(scaleAt(g, 1)).toBeCloseTo(DEFAULT_GEOMETRY_OPTIONS.farScale);
    let prev = scaleAt(g, 0);
    for (let d = 0.05; d <= 1; d += 0.05) {
      const s = scaleAt(g, d);
      expect(s).toBeLessThan(prev);
      prev = s;
    }
  });

  it('y decreases monotonically with depth and notes below the line move faster (perspective)', () => {
    let prev = yAt(g, -0.05);
    for (let d = 0; d <= 1; d += 0.05) {
      const y = yAt(g, d);
      expect(y).toBeLessThan(prev);
      prev = y;
    }
    const nearStep = yAt(g, 0) - yAt(g, 0.1);
    const farStep = yAt(g, 0.9) - yAt(g, 1.0);
    expect(nearStep).toBeGreaterThan(farStep * 3);
  });

  it('depthAtY inverts yAt', () => {
    for (const d of [-0.05, 0, 0.2, 0.5, 0.9, 1]) {
      expect(depthAtY(g, yAt(g, d))).toBeCloseTo(d, 6);
    }
    expect(depthAtY(g, g.vpY - 1)).toBe(Number.POSITIVE_INFINITY);
  });

  it('a note at the strike line time projects exactly onto the strike line', () => {
    const p = project(g, 1, depthOf(g, 5, 5));
    expect(p.y).toBeCloseTo(g.strikeY);
    expect(p.radius).toBeCloseTo(g.gemRadiusNear);
    expect(p.scale).toBe(1);
  });
});

describe('lane x', () => {
  const g = makeGeometry(W, H, 4);

  it('lanes are evenly spaced at the strike line and symmetric about centre', () => {
    const xs = [0, 1, 2, 3].map((l) => laneX(g, l, 0));
    expect(xs[0]).toBeLessThan(xs[1]);
    expect(xs[1]).toBeLessThan(xs[2]);
    expect(xs[2]).toBeLessThan(xs[3]);
    expect(xs[1] - xs[0]).toBeCloseTo(g.laneWidthNear);
    expect(xs[0] + xs[3]).toBeCloseTo(W);
    expect(xs[1] + xs[2]).toBeCloseTo(W);
  });

  it('lanes converge toward the vanishing point with depth', () => {
    const near = laneX(g, 3, 0) - laneX(g, 0, 0);
    const far = laneX(g, 3, 1) - laneX(g, 0, 1);
    expect(far).toBeCloseTo(near * DEFAULT_GEOMETRY_OPTIONS.farScale);
    expect(Math.abs(laneX(g, 0, 1) - g.vpX)).toBeLessThan(Math.abs(laneX(g, 0, 0) - g.vpX));
  });

  it('road edges and lane boundaries line up', () => {
    expect(roadEdgeX(g, -1, 0)).toBeCloseTo(laneBoundaryX(g, 0, 0));
    expect(roadEdgeX(g, 1, 0)).toBeCloseTo(laneBoundaryX(g, 4, 0));
    expect(roadEdgeX(g, 1, 0) - roadEdgeX(g, -1, 0)).toBeCloseTo(g.nearHalfWidth * 2);
    // Each lane centre lies between its boundaries
    for (let l = 0; l < 4; l++) {
      expect(laneX(g, l, 0.5)).toBeGreaterThan(laneBoundaryX(g, l, 0.5));
      expect(laneX(g, l, 0.5)).toBeLessThan(laneBoundaryX(g, l + 1, 0.5));
    }
  });

  it('a 2-lane road centres both lanes around the middle', () => {
    const g2 = makeGeometry(W, H, 2);
    expect((laneX(g2, 0, 0) + laneX(g2, 1, 0)) / 2).toBeCloseTo(W / 2);
  });
});

describe('tail below the strike line', () => {
  it('is continuous at the line and linear (constant screen speed) below it', () => {
    const g = makeGeometry(W, H, 4);
    expect(scaleAt(g, 0)).toBe(1);
    expect(scaleAt(g, -1e-9)).toBeCloseTo(1, 6);
    const v1 = yAt(g, -0.05) - yAt(g, 0);
    const v2 = yAt(g, -0.1) - yAt(g, -0.05);
    const v3 = yAt(g, -0.2) - yAt(g, -0.15);
    expect(v1).toBeCloseTo(v2, 6);
    expect(v2).toBeCloseTo(v3, 6);
    // Slower than the approach speed at the line by pastLineSpeed.
    const above = yAt(g, 0) - yAt(g, 0.001);
    expect(v1 / 50).toBeCloseTo(above * g.pastLineSpeed, 2);
  });

  it('road edges stay straight through the line (x offset proportional to y - vpY)', () => {
    const g = makeGeometry(W, H, 4);
    const slope = (d: number): number => (roadEdgeX(g, 1, d) - g.vpX) / (yAt(g, d) - g.vpY);
    expect(slope(-0.2)).toBeCloseTo(slope(0.5), 9);
    expect(slope(g.minDepth)).toBeCloseTo(slope(1), 9);
  });

  it('keeps a gem on screen at least 400 ms past the line at common resolutions and lane counts', () => {
    for (const [w, h] of [
      [1280, 720],
      [1920, 1080],
      [1366, 768],
      [720, 1280],
      [1024, 768],
    ]) {
      for (const lanes of [2, 3, 4]) {
        const g = makeGeometry(w, h, lanes);
        expect(visibleTailSec(g), `${w}x${h} lanes=${lanes}`).toBeGreaterThanOrEqual(0.4);
      }
    }
  });

  it('pastLineSpeed is tunable and clamped', () => {
    const slow = makeGeometry(W, H, 4, { pastLineSpeed: 0.3 });
    const fast = makeGeometry(W, H, 4, { pastLineSpeed: 1 });
    expect(visibleTailSec(slow)).toBeGreaterThan(visibleTailSec(fast));
    expect(makeGeometry(W, H, 4, { pastLineSpeed: 0 }).pastLineSpeed).toBe(0.2);
    expect(makeGeometry(W, H, 4, { pastLineSpeed: 5 }).pastLineSpeed).toBe(1);
  });
});

describe('culling', () => {
  const g = makeGeometry(W, H, 4);

  it('minDepth is negative (notes stay visible a little past the line) and maxDepth is just past the horizon', () => {
    expect(g.minDepth).toBeLessThan(0);
    expect(g.minDepth).toBeGreaterThan(-0.5);
    expect(g.maxDepth).toBeGreaterThan(1);
  });

  it('isVisibleDepth accepts on-road depths and rejects far / gone ones', () => {
    expect(isVisibleDepth(g, 0)).toBe(true);
    expect(isVisibleDepth(g, 0.5)).toBe(true);
    expect(isVisibleDepth(g, 1)).toBe(true);
    expect(isVisibleDepth(g, 1.5)).toBe(false);
    expect(isVisibleDepth(g, -1)).toBe(false);
    expect(isVisibleDepth(g, g.minDepth - 0.001)).toBe(false);
  });

  it('visibleTimeWindow brackets songTime by approachSec', () => {
    const w = visibleTimeWindow(g, 20);
    expect(w.from).toBeLessThan(20);
    expect(w.to).toBeCloseTo(20 + g.maxDepth * g.approachSec);
    expect(w.to - 20).toBeGreaterThan(g.approachSec);
  });
});

describe('beat lines', () => {
  const g = makeGeometry(W, H, 4);

  it('returns beat lines on the road with bar flags every 4 beats', () => {
    const lines = beatLineTimes(g, 8.0, 120, 0);
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      const d = depthOf(g, l.time, 8);
      expect(d).toBeGreaterThanOrEqual(g.minDepth);
      expect(d).toBeLessThanOrEqual(1);
    }
    const bars = lines.filter((l) => l.bar);
    expect(bars.length).toBeGreaterThan(0);
    // songTime 8 s at 120 BPM = beat 16 → a bar line exactly at songTime
    expect(lines.some((l) => Math.abs(l.time - 8) < 1e-9 && l.bar)).toBe(true);
    // Lines are spaced by exactly one beat.
    const sorted = lines.map((l) => l.time).sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i] - sorted[i - 1]).toBeCloseTo(0.5);
  });

  it('respects beatPhase offset', () => {
    const lines = beatLineTimes(g, 8.1, 120, 0.2);
    expect(lines.some((l) => Math.abs(l.time - 8.0) < 1e-6)).toBe(true);
  });

  it('uses the beat index hint for bar placement when given', () => {
    const lines = beatLineTimes(g, 8.0, 120, 0, 4, 17);
    const atNow = lines.find((l) => Math.abs(l.time - 8) < 1e-9);
    expect(atNow?.bar).toBe(false);
    expect(lines.find((l) => Math.abs(l.time - 9.5) < 1e-9)?.bar).toBe(true);
  });

  it('fillBeatLines matches beatLineTimes without allocating', () => {
    const times = new Float64Array(MAX_BEAT_LINES);
    const bars = new Uint8Array(MAX_BEAT_LINES);
    for (const [st, bpm, phase] of [
      [8, 120, 0],
      [8.1, 120, 0.2],
      [-2.3, 95, 0.7],
      [100.37, 174, 0.11],
    ]) {
      const ref = beatLineTimes(g, st, bpm, phase);
      const n = fillBeatLines(g, st, bpm, phase, times, bars);
      expect(n).toBe(ref.length);
      for (let i = 0; i < n; i++) {
        expect(times[i]).toBeCloseTo(ref[i].time, 9);
        expect(bars[i] === 1).toBe(ref[i].bar);
      }
    }
    expect(fillBeatLines(g, 1, 0, 0, times, bars)).toBe(0);
    // Respects the buffer capacity.
    expect(fillBeatLines(g, 1, 600, 0, new Float64Array(3), new Uint8Array(3))).toBeLessThanOrEqual(3);
  });

  it('is empty for invalid bpm', () => {
    expect(beatLineTimes(g, 1, 0, 0)).toEqual([]);
    expect(beatLineTimes(g, 1, Number.NaN, 0)).toEqual([]);
  });
});

describe('radius buckets', () => {
  it('quantizes and reconstructs radii within the range', () => {
    expect(radiusBucket(4, 4, 40, 12)).toBe(0);
    expect(radiusBucket(40, 4, 40, 12)).toBe(11);
    expect(radiusBucket(100, 4, 40, 12)).toBe(11);
    expect(radiusBucket(0, 4, 40, 12)).toBe(0);
    for (let r = 4; r <= 40; r += 3) {
      const b = radiusBucket(r, 4, 40, 12);
      expect(Math.abs(bucketRadius(b, 4, 40, 12) - r)).toBeLessThanOrEqual((36 / 11) * 0.5 + 1e-9);
    }
    expect(bucketRadius(0, 4, 40, 1)).toBe(40);
  });
});
