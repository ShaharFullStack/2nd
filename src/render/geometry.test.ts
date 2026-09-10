import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GEOMETRY_OPTIONS,
  FAR_FADE_FRAC,
  MIN_PAST_LINE_SPEED,
  beatLineTimes,
  bucketRadius,
  clamp,
  depthAtY,
  depthOf,
  fillBeatLines,
  isVisibleDepth,
  MAX_BEAT_LINES,
  visibleTailSec,
  gemVisibleTailSec,
  fullyVisibleDepth,
  depthAtScale,
  projectInto,
  GEM_ASPECT,
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

describe('clamp', () => {
  it('clamps and is NaN-safe (a degenerate frame must not poison downstream state)', () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(-5, 0, 1)).toBe(0);
    expect(clamp(0.4, 0, 1)).toBe(0.4);
    // NaN used to fall through both comparisons and come back out as NaN, which then flowed into
    // dt → every smoothed accumulator in the renderer, permanently.
    expect(clamp(Number.NaN, 0, 1)).toBe(0);
    expect(clamp(Number.NaN, 0.25, 1)).toBe(0.25);
    expect(clamp(Number.POSITIVE_INFINITY, 0, 1)).toBe(1);
    expect(clamp(Number.NEGATIVE_INFINITY, 0, 1)).toBe(0);
  });
});

describe('makeGeometry', () => {
  it('places the strike line and horizon at the requested fractions', () => {
    const g = makeGeometry(W, H, 4);
    expect(g.strikeY).toBeCloseTo(DEFAULT_GEOMETRY_OPTIONS.strikeY * H, 6);
    expect(g.horizonY).toBeCloseTo(DEFAULT_GEOMETRY_OPTIONS.horizonY * H, 6);
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

  it('adapts road width to lane count (fewer lanes → narrower road, lane width barely moves)', () => {
    const g2 = makeGeometry(W, H, 2);
    const g4 = makeGeometry(W, H, 4);
    expect(g2.nearHalfWidth).toBeLessThan(g4.nearHalfWidth);
    expect(roadWidthFactor(2)).toBeLessThan(roadWidthFactor(4));
    expect(g2.gemRadiusNear).toBeGreaterThan(0);
    // Dropping lanes removes road, it does not stretch the remaining lanes into a wide empty ramp:
    // a 2-lane lane is at most 20% wider than a 4-lane lane (targets grow a little for the rehab
    // audience, the fret-board proportions stay).
    expect(g2.laneWidthNear).toBeGreaterThan(g4.laneWidthNear);
    expect(g2.laneWidthNear / g4.laneWidthNear).toBeLessThan(1.2);
  });

  it('proportions gems like a fret board: gem diameter is a large fraction of lane width', () => {
    // Clone Hero / GH frets fill ~70-85% of their lane. This is the single strongest cue that the
    // road is an instrument rather than a ramp, so it is pinned at every realistic aspect ratio.
    for (const [w, h] of [
      [1280, 720],
      [1920, 1080],
      [1366, 768],
      [1024, 768],
      [720, 1280],
      [800, 600],
    ]) {
      for (const lanes of [2, 3, 4]) {
        const g = makeGeometry(w, h, lanes);
        const fill = (g.gemRadiusNear * 2) / g.laneWidthNear;
        expect(fill, `${w}x${h} lanes=${lanes} gem/lane`).toBeGreaterThanOrEqual(0.7);
        expect(fill, `${w}x${h} lanes=${lanes} gem/lane`).toBeLessThanOrEqual(0.9);
        // Receptor ring sits just outside the gem but still inside its lane.
        expect(g.receptorRadius).toBeGreaterThan(g.gemRadiusNear);
        expect(g.receptorRadius * 2).toBeLessThanOrEqual(g.laneWidthNear);
        // The road stays on screen with room for the side panels.
        expect(g.nearHalfWidth * 2).toBeLessThan(w * 0.8);
      }
    }
  });
});

describe('the board is the composition, not an element in it', () => {
  // Three blind critics ranked this renderer against shipped Guitar-Hero-lineage frames and all
  // three named the same single deficit: the highway was a small trapezoid floating in a starfield
  // (43 % of frame height of note travel, 46 % of frame width at the strike line, a hard horizontal
  // cut at 35 % down the frame). These are the proportions that fix that, pinned so a future tweak
  // to one number cannot quietly give the board back.
  const SIZES: Array<[number, number]> = [
    [1920, 1080],
    [1280, 720],
    [1366, 768],
    [2560, 1080],
  ];

  it('runs the board from just under the top edge to below the bottom one', () => {
    for (const [w, h] of SIZES) {
      const g = makeGeometry(w, h, 4);
      const tag = `${w}x${h}`;
      // Far end high in the frame...
      expect(g.horizonY / h, `${tag} far end`).toBeLessThanOrEqual(0.15);
      // ...near end off the bottom edge, so the road never floats.
      expect(yAt(g, g.minDepth), `${tag} near end`).toBeGreaterThan(h);
      // Note travel: horizon → strike line.
      expect((g.strikeY - g.horizonY) / h, `${tag} travel`).toBeGreaterThanOrEqual(0.65);
    }
  });

  it('puts the strike line low, with room under it for fret hardware and hit bloom', () => {
    for (const [w, h] of SIZES) {
      const g = makeGeometry(w, h, 4);
      const tag = `${w}x${h}`;
      expect(g.strikeY / h, `${tag} strike`).toBeGreaterThanOrEqual(0.78);
      expect(g.strikeY / h, `${tag} strike`).toBeLessThanOrEqual(0.88);
      // Receptor + label band must fit between the line and the bottom edge, unclipped.
      expect((h - g.strikeY) / h, `${tag} apron`).toBeGreaterThanOrEqual(0.15);
      expect(g.strikeY + g.receptorRadius * GEM_ASPECT, `${tag} receptor bottom`).toBeLessThan(h);
    }
  });

  it('is 55-80% of frame width at the strike line (16:9; ultrawide is height-capped)', () => {
    for (const [w, h] of SIZES.filter(([sw, sh]) => sw / sh < 2.2)) {
      const g = makeGeometry(w, h, 4);
      const frac = (g.nearHalfWidth * 2) / w;
      expect(frac, `${w}x${h} board width`).toBeGreaterThanOrEqual(0.55);
      expect(frac, `${w}x${h} board width`).toBeLessThanOrEqual(0.8);
    }
  });

  it('tapers clearly but keeps the far half of the run readable', () => {
    const g = makeGeometry(1920, 1080, 4);
    // Lower bound: still an unmistakable road. Upper bound: a taper this loose is what keeps the
    // far half of the runway legible — at 0.22 the stretch from depth 0.5 to the horizon was 13 %
    // of frame height and the gems in it were 30 px ghosts, so a board carrying eight notes read
    // as a board carrying three. Tightening this again gives that wedge back.
    expect(DEFAULT_GEOMETRY_OPTIONS.farScale).toBeGreaterThanOrEqual(0.3);
    expect(DEFAULT_GEOMETRY_OPTIONS.farScale).toBeLessThanOrEqual(0.45);
    // Half the read-ahead time must land in the upper half of the run, not in a sliver at the top.
    expect(yAt(g, 0.5) / 1080).toBeGreaterThanOrEqual(0.28);
    // The dissolve band is a real stretch of board, not a hairline, and it ends well clear of the
    // read-ahead zone.
    expect(FAR_FADE_FRAC).toBeGreaterThanOrEqual(0.1);
    expect(FAR_FADE_FRAC).toBeLessThanOrEqual(0.25);
    const fadeEndY = g.horizonY + (g.strikeY - g.horizonY) * FAR_FADE_FRAC;
    expect(fadeEndY - g.horizonY).toBeGreaterThan(1080 * 0.06);
    expect(fadeEndY).toBeLessThan(1080 * 0.32);
  });

  it('holds two bars of read-ahead: a rehab chart puts 5+ gems on the board at once', () => {
    const g = makeGeometry(1920, 1080, 4);
    // 120 BPM, medium density = one note per beat (src/engine/difficulty.ts), i.e. 2 notes/second.
    const notesPerSec = 2;
    const onBoard = g.approachSec * notesPerSec;
    expect(g.approachSec).toBeGreaterThanOrEqual(2);
    expect(onBoard).toBeGreaterThanOrEqual(5);
    // ...and the furthest of them is still big enough to see from a clinic chair.
    const farRadius = g.gemRadiusNear * scaleAt(g, 1);
    expect((farRadius * 2) / 1080).toBeGreaterThanOrEqual(0.02);
  });

  it('leaves under a third of the frame to the backdrop', () => {
    const g = makeGeometry(1920, 1080, 4);
    // Trapezoid area of the visible road (top edge at the horizon, bottom edge clipped to the canvas).
    const topW = g.nearHalfWidth * 2 * scaleAt(g, 1);
    const dBottom = depthAtY(g, 1080);
    const botW = g.nearHalfWidth * 2 * scaleAt(g, dBottom);
    const area = ((topW + botW) / 2) * (1080 - g.horizonY);
    expect(area / (1920 * 1080)).toBeGreaterThan(0.4);
  });
});

describe('depth / scale / y', () => {
  const g = makeGeometry(W, H, 4);

  it('maps song time to depth: 0 at the strike line, 1 at the horizon after approachSec', () => {
    expect(depthOf(g, 10, 10)).toBe(0);
    expect(depthOf(g, 10 + g.approachSec, 10)).toBeCloseTo(1);
    expect(depthOf(g, 10 - g.approachSec / 4, 10)).toBeCloseTo(-0.25);
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
  it('is position- and speed-continuous at the line (a crossing gem never visibly brakes)', () => {
    const g = makeGeometry(W, H, 4);
    expect(scaleAt(g, 0)).toBe(1);
    expect(scaleAt(g, -1e-9)).toBeCloseTo(1, 6);
    // Screen-space speed (px of y per unit of depth) either side of the line, by finite difference.
    const speed = (d: number): number => (yAt(g, d - 1e-6) - yAt(g, d + 1e-6)) / 2e-6;
    const above = speed(1e-5);
    const below = speed(-1e-5);
    // The old hard switch made this ratio pastLineSpeed (0.42) — a 58 % step change at the receptor.
    expect(below / above).toBeGreaterThan(0.995);
    expect(below / above).toBeLessThan(1.005);
    // ...and it stays smooth all the way through the blend: no step anywhere below the line.
    // Sampled proportionally to the blend (which is a *duration*, so it shrinks as approachSec
    // grows): the claim is that ds/dd is Lipschitz across the line, not that any fixed depth step
    // is small.
    let prev = above;
    for (let d = 0; d > -0.4; d -= g.tailBlend / 25) {
      const v = speed(d);
      expect(Math.abs(v - prev) / above, `step at d=${d.toFixed(3)}`).toBeLessThan(0.05);
      prev = v;
    }
  });

  it('settles to exactly pastLineSpeed once the blend is over', () => {
    const g = makeGeometry(W, H, 4);
    const speed = (d: number): number => (yAt(g, d - 1e-6) - yAt(g, d + 1e-6)) / 2e-6;
    const above = speed(1e-5);
    expect(speed(-g.tailBlend - 0.05) / above).toBeCloseTo(g.pastLineSpeed, 4);
    expect(speed(-0.4) / above).toBeCloseTo(g.pastLineSpeed, 4);
    // Still exactly linear (constant speed) beyond the blend.
    const v1 = yAt(g, -0.25) - yAt(g, -0.2);
    const v2 = yAt(g, -0.35) - yAt(g, -0.3);
    expect(v1).toBeCloseTo(v2, 6);
  });

  it('depthAtY inverts yAt exactly through the eased tail', () => {
    for (const opts of [{}, { pastLineSpeed: 1 }, { pastLineSpeed: 0.2 }]) {
      const g = makeGeometry(W, H, 4, opts);
      for (let d = 1; d > -0.5; d -= 0.01) {
        expect(depthAtY(g, yAt(g, d)), `d=${d.toFixed(2)} p=${g.pastLineSpeed}`).toBeCloseTo(d, 6);
      }
    }
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

  /**
   * The judgment-cue bar: `visibleTailSec` counts a gem whose centre is up to two gem radii *below*
   * the canvas as "visible", which is right for culling and wrong for a cue a patient has to see.
   * The engine declares a miss at note.time + goodMs + grace = up to 280 ms past the line, so the
   * *whole* gem must still be inside the canvas that late — at every resolution and lane count.
   */
  it('keeps the WHOLE gem inside the canvas past the latest miss verdict (+280 ms)', () => {
    for (const [w, h] of [
      [1280, 720],
      [1920, 1080],
      [1366, 768],
      [720, 1280],
      [400, 800],
      [1024, 768],
      [1920, 600],
    ]) {
      for (const lanes of [2, 3, 4]) {
        const g = makeGeometry(w, h, lanes);
        const tail = gemVisibleTailSec(g);
        expect(tail, `${w}x${h} lanes=${lanes}`).toBeGreaterThanOrEqual(0.3);
        // ...and at exactly the verdict time the gem's lower edge is above the bottom edge.
        const d = depthOf(g, 0, 0.28);
        const s = scaleAt(g, d);
        const bottom = yAt(g, d) + g.gemRadiusNear * s * GEM_ASPECT;
        expect(bottom, `${w}x${h} lanes=${lanes} bottom`).toBeLessThanOrEqual(h);
        expect(tail).toBeLessThan(visibleTailSec(g)); // strictly stricter than the culling bound
      }
    }
  });

  it('fullyVisibleDepth / depthAtScale round-trip against yAt', () => {
    const g = makeGeometry(W, H, 4);
    const d = fullyVisibleDepth(g);
    const s = scaleAt(g, d);
    expect(yAt(g, d) + g.gemRadiusNear * s * GEM_ASPECT).toBeCloseTo(H, 6);
    expect(depthAtScale(g, scaleAt(g, -0.2))).toBeCloseTo(-0.2, 9);
    expect(depthAtScale(g, scaleAt(g, 0.7))).toBeCloseTo(0.7, 9);
    // A margin only ever shortens the tail.
    expect(gemVisibleTailSec(g, 20)).toBeLessThan(gemVisibleTailSec(g, 0));
  });

  it('projectInto writes into the caller object and matches project()', () => {
    const g = makeGeometry(W, H, 3);
    const out = { x: 0, y: 0, scale: 0, radius: 0 };
    for (const d of [-0.3, -0.05, 0, 0.4, 1]) {
      for (let lane = 0; lane < 3; lane++) {
        const ret = projectInto(g, lane, d, out);
        expect(ret).toBe(out);
        expect(out).toEqual(project(g, lane, d));
      }
    }
  });

  it('pastLineSpeed is tunable and clamped', () => {
    const slow = makeGeometry(W, H, 4, { pastLineSpeed: 0.3 });
    const fast = makeGeometry(W, H, 4, { pastLineSpeed: 1 });
    expect(visibleTailSec(slow)).toBeGreaterThan(visibleTailSec(fast));
    expect(makeGeometry(W, H, 4, { pastLineSpeed: 0 }).pastLineSpeed).toBe(MIN_PAST_LINE_SPEED);
    expect(makeGeometry(W, H, 4, { pastLineSpeed: 5 }).pastLineSpeed).toBe(1);
  });
});

describe('culling', () => {
  const g = makeGeometry(W, H, 4);

  it('minDepth is negative (notes stay visible a little past the line) and maxDepth is just past the horizon', () => {
    expect(g.minDepth).toBeLessThan(0);
    expect(g.minDepth).toBeGreaterThan(-1);
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
