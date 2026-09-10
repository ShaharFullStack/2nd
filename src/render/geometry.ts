/**
 * Pure perspective geometry for the note highway. No DOM, fully unit-testable.
 *
 * Model: the road is a trapezoid converging on a vanishing point (vpX, vpY).
 * Depth `d` is a unitless parameter: d = 0 at the strike line, d = 1 at the far
 * road edge (horizon). A note at song time `t` has d = (t - songTime) / approachSec,
 * so notes travel horizon → strike line in `approachSec` seconds, and keep going
 * below the strike line (d < 0) until they leave the bottom of the canvas.
 *
 * Perspective scale s(d) = 1 / (1 + k·d) for d >= 0, with k chosen so that s(1) = farScale.
 * Screen y(d) = vpY + (strikeY - vpY) · s(d). Lane x and gem radius scale by s(d).
 * The vanishing point sits above the visible horizon so the road tapers naturally.
 *
 * Below the strike line (d < 0) the true perspective curve would fling gems off the bottom of
 * the canvas ~150 ms after the note time — long before the engine declares a miss
 * (note.time + goodMs 110–180 ms + 100 ms grace = 210–280 ms). So the tail settles to a constant
 * screen-space speed equal to `pastLineSpeed` × the speed at the strike line.
 *
 * It *eases* into that speed rather than switching to it: over the first `tailBlend` of depth below
 * the line, ds/dd ramps smoothly from the approach speed at the line down to the tail speed
 * (quadratic in depth, i.e. C¹ at both ends). A hard switch made every un-hit gem visibly brake to
 * 42 % speed exactly as it touched the receptor — a tell no Clone Hero gem has. Beyond `tailBlend`
 * the tail is exactly linear again, which keeps `depthAtY` closed-form (and therefore culling and
 * the panel geometry exact).
 *
 * Because x offsets and radius still scale with (y - vpY) the road edges stay perfectly straight
 * (no kink at the line); only the vertical speed changes.
 *
 * Two different "still visible" questions matter and there are two functions for them:
 *   - `visibleTailSec` / `minDepth` — how long a gem is *drawn* (its centre may be up to two gem
 *     radii below the bottom edge; used for culling and for the road/panel extent, which must run
 *     off the bottom of the canvas).
 *   - `gemVisibleTailSec` / `fullyVisibleDepth` — how long a gem is *entirely inside the canvas*.
 *     This is the one a judgment cue must be measured against: the engine declares a miss up to
 *     note.time + goodMs + grace ≈ 280 ms after the note time, and a miss cue half-way off the
 *     bottom edge is not a cue. With the default strikeY / pastLineSpeed this is ≥ 300 ms at
 *     720p, 1080p, portrait and ultrawide (see geometry.test.ts).
 */

export interface GeometryOptions {
  approachSec: number;
  horizonY: number;
  strikeY: number;
  farScale: number;
  roadWidth: number;
  /** Screen-space speed below the strike line relative to the speed at the line (MIN_PAST_LINE_SPEED..1). */
  pastLineSpeed: number;
}

/**
 * Depth over which the below-line scroll speed eases from the approach speed into the slower tail
 * (see module docs). ~0.11 s at the default 3.6 s approach: long enough that the deceleration is
 * not a visible step, short enough that the tail is still nearly its full length. It is expressed
 * in *depth*, so it shrank when `approachSec` grew — the eased stretch is a duration, not a
 * fraction of the road.
 */
export const TAIL_BLEND_DEPTH = 0.03;

export interface HighwayGeometry {
  width: number;
  height: number;
  laneCount: number;
  approachSec: number;
  /** Vanishing point (px). */
  vpX: number;
  vpY: number;
  /** Far road edge y (px) — where d = 1. */
  horizonY: number;
  /** Strike line y (px) — where d = 0. */
  strikeY: number;
  /** Perspective coefficient: s(d) = 1 / (1 + k d). */
  k: number;
  /** Linear tail speed factor below the strike line (see module docs). */
  pastLineSpeed: number;
  /** Depth below the line over which the scroll speed eases into the tail speed. */
  tailBlend: number;
  /** Road half-width at the strike line (px). */
  nearHalfWidth: number;
  /** Lane width at the strike line (px). */
  laneWidthNear: number;
  /** Gem radius at the strike line (px). */
  gemRadiusNear: number;
  /** Receptor ring radius at the strike line (px). */
  receptorRadius: number;
  /** Smallest depth still on screen (bottom edge). */
  minDepth: number;
  /** Largest depth we bother drawing (just past the horizon). */
  maxDepth: number;
}

/**
 * Board proportions. These are the composition, not a detail: a shipped note highway *is* the
 * frame. The far end sits just under the top edge and dissolves into the backdrop (`FAR_FADE_FRAC`)
 * instead of ending on a hard horizontal cut, the strike line sits low with ~18 % of the canvas
 * left below it for receptor hardware and hit bloom, and the board is two thirds of the canvas
 * wide at the line. Together that is ~71 % of canvas height of note travel (it was 43 %) and
 * `approachSec` seconds of read-ahead in view at once.
 *
 * `farScale` and `approachSec` are tied: screen speed at the strike line is
 * `(strikeY - horizonY) / (farScale * approachSec)` canvas-heights per second. Lengthening the
 * board without loosening the taper or slowing the scroll would fling gems past the receptor.
 *
 * `approachSec` is longer than a guitar game's (3.6 s, ~2 bars at 120 BPM) for a reason specific to
 * this product: a rehab chart's density is bounded by the patient, not by the chart generator —
 * every note is a rep, with a return-to-rest gap after it, which caps a 4-lane medium session at
 * roughly one note per second. The only way to put a shipped game's 5-8 gems on the board at once
 * is a longer runway, and a longer runway is separately right here (camera-to-judgment latency is
 * 80-200 ms and a knee lift takes time to initiate).
 */
export const DEFAULT_GEOMETRY_OPTIONS: GeometryOptions = {
  approachSec: 3.6,
  horizonY: 0.11,
  strikeY: 0.82,
  farScale: 0.22,
  roadWidth: 0.64,
  pastLineSpeed: 0.12,
};

/**
 * Fraction of the horizon→strike span over which the far end of the board dissolves into the
 * backdrop. Nothing — road, beat ladder, rails, gems — may become visible on a hard line.
 */
export const FAR_FADE_FRAC = 0.16;

/**
 * Floor for `pastLineSpeed`. Low, on purpose: with a full-height board the approach speed at the
 * strike line is high, and the engine's miss verdict lands up to 280 ms *after* the note time — the
 * gem it is a verdict about has to still be entirely on screen then (`gemVisibleTailSec`).
 */
export const MIN_PAST_LINE_SPEED = 0.1;

/** Gem aspect: gems are slightly squashed ellipses viewed from above, GH-style. */
export const GEM_ASPECT = 0.72;

/**
 * Gem radius as a fraction of lane width. Clone Hero / GH frets fill most of their lane
 * (diameter ≈ 0.75 × lane width) — that is what makes the road read as an instrument rather than a
 * wide empty ramp, so this is deliberately large. It also fixes the receptor ring at about a fifth
 * of the board's width at the strike line, which is where shipped fret hardware sits.
 */
export const GEM_LANE_FRACTION = 0.37;
/** Hard cap on gem radius as a fraction of canvas height (only binds on very wide aspect ratios). */
export const GEM_HEIGHT_CAP = 0.12;
/** Receptor ring radius relative to the gem radius (ring sits just outside the gem). */
export const RECEPTOR_GEM_RATIO = 1.12;
/** Road width is also capped relative to height so ultrawide canvases don't get a flat, empty road. */
export const ROAD_HEIGHT_CAP = 1.3;

/**
 * Clamp to [lo, hi]. NaN-safe on purpose: `NaN` maps to `lo` rather than propagating. A single
 * non-finite frame out of a live audio/vision pipeline (an unarmed song clock, a dropped tracker
 * sample) used to poison every smoothed accumulator in the renderer for the rest of the session.
 */
export function clamp(v: number, lo: number, hi: number): number {
  return v >= lo ? (v <= hi ? v : hi) : lo;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Road width factor by lane count. Close to `lanes / 4`, so removing a lane removes a lane's worth
 * of road instead of stretching the remaining lanes: the fret board keeps its proportions and the
 * gems keep filling their lanes. The small upward bias at 1–3 lanes (0.58 vs 0.5 at two lanes) gives
 * the rehab-friendly low lane counts slightly larger targets without emptying out the road.
 */
export function roadWidthFactor(laneCount: number): number {
  const n = clamp(Math.round(laneCount), 1, 5);
  return { 1: 0.34, 2: 0.58, 3: 0.8, 4: 1, 5: 1.16 }[n] ?? 1;
}

export function makeGeometry(
  width: number,
  height: number,
  laneCount: number,
  opts: Partial<GeometryOptions> = {},
): HighwayGeometry {
  const o = { ...DEFAULT_GEOMETRY_OPTIONS, ...opts };
  const lanes = Math.max(1, Math.round(laneCount));
  const farScale = clamp(o.farScale, 0.02, 0.95);
  const k = 1 / farScale - 1;
  const strikeY = o.strikeY * height;
  const horizonPx = o.horizonY * height;
  // vpY + (strikeY - vpY) * farScale = horizonPx  =>  vpY = (horizonPx - strikeY*farScale) / (1 - farScale)
  const vpY = (horizonPx - strikeY * farScale) / (1 - farScale);
  const roadPx = Math.min(width * o.roadWidth, height * ROAD_HEIGHT_CAP) * roadWidthFactor(lanes);
  const nearHalfWidth = roadPx / 2;
  const laneWidthNear = (nearHalfWidth * 2) / lanes;
  const gemRadiusNear = Math.min(laneWidthNear * GEM_LANE_FRACTION, height * GEM_HEIGHT_CAP);
  const receptorRadius = gemRadiusNear * RECEPTOR_GEM_RATIO;
  const g: HighwayGeometry = {
    width,
    height,
    laneCount: lanes,
    approachSec: Math.max(0.2, o.approachSec),
    vpX: width / 2,
    vpY,
    horizonY: horizonPx,
    strikeY,
    k,
    pastLineSpeed: clamp(o.pastLineSpeed, MIN_PAST_LINE_SPEED, 1),
    tailBlend: TAIL_BLEND_DEPTH,
    nearHalfWidth,
    laneWidthNear,
    gemRadiusNear,
    receptorRadius,
    minDepth: 0,
    maxDepth: 1.02,
  };
  // Depth at which a gem's centre is one radius below the bottom edge.
  g.minDepth = depthAtY(g, height + gemRadiusNear * 2);
  return g;
}

/** Depth parameter of a note: 0 at strike line, 1 at horizon, negative once past the line. */
export function depthOf(g: HighwayGeometry, noteTime: number, songTime: number): number {
  return (noteTime - songTime) / g.approachSec;
}

/**
 * Perspective scale at depth d (1 at strike line, farScale at horizon). Below the line the scale
 * grows with a speed that eases from the approach speed into `pastLineSpeed` × it over `tailBlend`
 * of depth, then linearly (see module docs). ds/dd is continuous everywhere, so a gem crossing the
 * receptor never visibly brakes.
 */
export function scaleAt(g: HighwayGeometry, d: number): number {
  if (d < 0) {
    const u = -d;
    const p = g.pastLineSpeed;
    const b = g.tailBlend;
    if (b > 0 && u < b) return 1 + g.k * (u - ((1 - p) * u * u) / (2 * b));
    return 1 + g.k * ((b * (1 + p)) / 2 + p * (u - b));
  }
  return 1 / (1 + g.k * d);
}

/** Screen y for depth d. */
export function yAt(g: HighwayGeometry, d: number): number {
  return g.vpY + (g.strikeY - g.vpY) * scaleAt(g, d);
}

/** Inverse of yAt: depth for a screen y (y must be below vpY). Exact, including the eased tail. */
export function depthAtY(g: HighwayGeometry, y: number): number {
  const s = (y - g.vpY) / (g.strikeY - g.vpY);
  if (s <= 0) return Number.POSITIVE_INFINITY;
  if (s > 1) {
    const p = g.pastLineSpeed;
    const b = g.tailBlend;
    const sBlendEnd = 1 + g.k * ((b * (1 + p)) / 2);
    if (b > 0 && s <= sBlendEnd) {
      // Invert s = 1 + k(u - (1-p)u²/(2b)) on u ∈ [0, b] — the smaller quadratic root.
      const a = (g.k * (1 - p)) / (2 * b);
      if (a < 1e-12) return -(s - 1) / g.k;
      const disc = Math.max(0, g.k * g.k - 4 * a * (s - 1));
      return -((g.k - Math.sqrt(disc)) / (2 * a));
    }
    return -(b + (s - sBlendEnd) / (g.k * p));
  }
  return (1 / s - 1) / g.k;
}

/** Seconds a gem stays on screen after crossing the strike line (before it is culled). */
export function visibleTailSec(g: HighwayGeometry): number {
  return -g.minDepth * g.approachSec;
}

/** Depth at which the perspective scale is `s` (inverse of `scaleAt`). */
export function depthAtScale(g: HighwayGeometry, s: number): number {
  return depthAtY(g, g.vpY + (g.strikeY - g.vpY) * s);
}

/**
 * Depth (negative, below the strike line) at which a near-radius gem's lower edge touches the
 * bottom of the canvas, i.e. the last depth at which the *whole* gem is still on screen.
 * `margin` (px) keeps it that much clear of the edge.
 */
export function fullyVisibleDepth(g: HighwayGeometry, margin = 0): number {
  const denom = g.strikeY - g.vpY + g.gemRadiusNear * GEM_ASPECT;
  if (!(denom > 0)) return g.minDepth;
  const s = (g.height - margin - g.vpY) / denom;
  if (!(s > 0)) return 0;
  if (s <= 1) return depthAtScale(g, s); // already off screen at (or above) the strike line
  return Math.max(depthAtScale(g, s), g.minDepth);
}

/**
 * Seconds a gem stays *entirely inside the canvas* after crossing the strike line. The miss
 * verdict lands at up to note.time + 280 ms, so this must stay comfortably above that.
 */
export function gemVisibleTailSec(g: HighwayGeometry, margin = 0): number {
  return -fullyVisibleDepth(g, margin) * g.approachSec;
}

/** Lane centre x at depth d. Lane 0 is leftmost. */
export function laneX(g: HighwayGeometry, lane: number, d: number): number {
  const offsetNear = -g.nearHalfWidth + g.laneWidthNear * (lane + 0.5);
  return g.vpX + offsetNear * scaleAt(g, d);
}

/** Left/right road edge x at depth d. */
export function roadEdgeX(g: HighwayGeometry, side: -1 | 1, d: number): number {
  return g.vpX + side * g.nearHalfWidth * scaleAt(g, d);
}

/** Lane divider x (boundary i, 0..laneCount) at depth d. */
export function laneBoundaryX(g: HighwayGeometry, boundary: number, d: number): number {
  const offsetNear = -g.nearHalfWidth + g.laneWidthNear * boundary;
  return g.vpX + offsetNear * scaleAt(g, d);
}

export interface Projected {
  x: number;
  y: number;
  scale: number;
  radius: number;
}

/**
 * Project a note (lane, depth) into an existing `Projected` — the allocation-free form, used once
 * per visible note per frame by the renderer's hot path. Returns `out`.
 */
export function projectInto(g: HighwayGeometry, lane: number, d: number, out: Projected): Projected {
  const s = scaleAt(g, d);
  out.x = g.vpX + (-g.nearHalfWidth + g.laneWidthNear * (lane + 0.5)) * s;
  out.y = g.vpY + (g.strikeY - g.vpY) * s;
  out.scale = s;
  out.radius = g.gemRadiusNear * s;
  return out;
}

/** Project a note (lane, depth) to screen. Allocates; use `projectInto` on the hot path. */
export function project(g: HighwayGeometry, lane: number, d: number): Projected {
  return projectInto(g, lane, d, { x: 0, y: 0, scale: 1, radius: 0 });
}

/** Whether a note at depth d should be drawn at all. */
export function isVisibleDepth(g: HighwayGeometry, d: number): boolean {
  return d >= g.minDepth && d <= g.maxDepth;
}

/** Song-time window [from, to] of notes that can be on screen. */
export function visibleTimeWindow(g: HighwayGeometry, songTime: number): { from: number; to: number } {
  return { from: songTime + g.minDepth * g.approachSec, to: songTime + g.maxDepth * g.approachSec };
}

/** Upper bound on beat lines on screen at once (fillBeatLines buffers should be this long). */
export const MAX_BEAT_LINES = 64;

/**
 * Line kinds written into `fillBeatLines`' `outBars`. `BEAT_LINE_BAR === 1` is load-bearing: it is
 * the flag `beatLineTimes` reports as `bar`, and it predates subdivisions.
 */
export const BEAT_LINE_BEAT = 0;
export const BEAT_LINE_BAR = 1;
export const BEAT_LINE_SUB = 2;

/**
 * Song times of beat lines currently on the road (from just below the strike line to the horizon),
 * with a flag for bar lines (every `beatsPerBar` beats) and for sub-beat lines (only emitted when
 * `subdivisions > 1`).
 */
export function beatLineTimes(
  g: HighwayGeometry,
  songTime: number,
  bpm: number,
  beatPhase: number,
  beatsPerBar = 4,
  beatIndexHint?: number,
  subdivisions = 1,
): Array<{ time: number; bar: boolean; sub: boolean }> {
  const out: Array<{ time: number; bar: boolean; sub: boolean }> = [];
  const times = new Float64Array(MAX_BEAT_LINES);
  const bars = new Uint8Array(MAX_BEAT_LINES);
  const n = fillBeatLines(g, songTime, bpm, beatPhase, times, bars, beatsPerBar, beatIndexHint, subdivisions);
  for (let i = 0; i < n; i++) out.push({ time: times[i], bar: bars[i] === BEAT_LINE_BAR, sub: bars[i] === BEAT_LINE_SUB });
  return out;
}

/**
 * Allocation-free variant of `beatLineTimes`: writes song times into `outTimes` and bar flags
 * (1 = bar line) into `outBars`, returns the count. Used by the renderer's hot path.
 */
export function fillBeatLines(
  g: HighwayGeometry,
  songTime: number,
  bpm: number,
  beatPhase: number,
  outTimes: Float64Array,
  outBars: Uint8Array,
  beatsPerBar = 4,
  beatIndexHint?: number,
  subdivisions = 1,
): number {
  if (!(bpm > 0) || !Number.isFinite(bpm)) return 0;
  const sub = Math.max(1, Math.round(subdivisions));
  const beatSec = 60 / bpm;
  const stepSec = beatSec / sub;
  const phase = clamp(beatPhase, 0, 0.999999);
  // Beat index of the most recent beat. Without a hint we assume beat 0 at song time 0.
  const beatIndex = beatIndexHint !== undefined && Number.isFinite(beatIndexHint) ? Math.floor(beatIndexHint) : Math.round(songTime / beatSec - phase);
  const lastBeatTime = songTime - phase * beatSec;
  const first = Math.floor((g.minDepth * g.approachSec) / stepSec) - 1;
  const last = Math.ceil((g.maxDepth * g.approachSec) / stepSec) + 1;
  const cap = Math.min(outTimes.length, outBars.length);
  let count = 0;
  for (let n = first; n <= last && count < cap; n++) {
    const t = lastBeatTime + n * stepSec;
    const d = depthOf(g, t, songTime);
    if (d < g.minDepth || d > 1) continue;
    let kind: number = BEAT_LINE_SUB;
    if (((n % sub) + sub) % sub === 0) {
      const idx = beatIndex + n / sub;
      kind = ((idx % beatsPerBar) + beatsPerBar) % beatsPerBar === 0 ? BEAT_LINE_BAR : BEAT_LINE_BEAT;
    }
    outTimes[count] = t;
    outBars[count] = kind;
    count++;
  }
  return count;
}

/** Quantize a gem radius into a sprite bucket so we can reuse a small set of pre-rendered sprites. */
export function radiusBucket(radius: number, minRadius: number, maxRadius: number, buckets: number): number {
  if (maxRadius <= minRadius) return 0;
  const t = clamp((radius - minRadius) / (maxRadius - minRadius), 0, 1);
  return Math.round(t * (buckets - 1));
}

export function bucketRadius(bucket: number, minRadius: number, maxRadius: number, buckets: number): number {
  if (buckets <= 1) return maxRadius;
  return minRadius + ((maxRadius - minRadius) * bucket) / (buckets - 1);
}
