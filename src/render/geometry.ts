/**
 * Pure perspective geometry for the note highway. No DOM, fully unit-testable.
 *
 * Model: the road is a trapezoid converging on a vanishing point (vpX, vpY).
 * Depth `d` is a unitless parameter: d = 0 at the strike line, d = 1 at the far
 * road edge (horizon). A note at song time `t` has d = (t - songTime) / approachSec,
 * so notes travel horizon → strike line in `approachSec` seconds, and keep going
 * below the strike line (d < 0) until they leave the bottom of the canvas.
 *
 * Perspective scale s(d) = 1 / (1 + k·d), with k chosen so that s(1) = farScale.
 * Screen y(d) = vpY + (strikeY - vpY) · s(d). Lane x and gem radius scale by s(d).
 * The vanishing point sits above the visible horizon so the road tapers naturally.
 */

export interface GeometryOptions {
  approachSec: number;
  horizonY: number;
  strikeY: number;
  farScale: number;
  roadWidth: number;
}

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

export const DEFAULT_GEOMETRY_OPTIONS: GeometryOptions = {
  approachSec: 1.6,
  horizonY: 0.35,
  strikeY: 0.82,
  farScale: 0.28,
  roadWidth: 0.6,
};

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Road width factor by lane count: fewer lanes → narrower road so gems stay a sane size. */
export function roadWidthFactor(laneCount: number): number {
  const n = clamp(Math.round(laneCount), 1, 5);
  return { 1: 0.4, 2: 0.62, 3: 0.84, 4: 1, 5: 1.12 }[n] ?? 1;
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
  const nearHalfWidth = (width * o.roadWidth * roadWidthFactor(lanes)) / 2;
  const laneWidthNear = (nearHalfWidth * 2) / lanes;
  const gemRadiusNear = Math.min(laneWidthNear * 0.36, height * 0.05);
  const receptorRadius = gemRadiusNear * 1.18;
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

/** Perspective scale at depth d (1 at strike line, farScale at horizon). */
export function scaleAt(g: HighwayGeometry, d: number): number {
  const denom = 1 + g.k * d;
  // Guard against the singularity below the strike line (d → -1/k): cap the scale.
  if (denom < 0.05) return 20;
  return 1 / denom;
}

/** Screen y for depth d. */
export function yAt(g: HighwayGeometry, d: number): number {
  return g.vpY + (g.strikeY - g.vpY) * scaleAt(g, d);
}

/** Inverse of yAt: depth for a screen y (y must be below vpY). */
export function depthAtY(g: HighwayGeometry, y: number): number {
  const s = (y - g.vpY) / (g.strikeY - g.vpY);
  if (s <= 0) return Number.POSITIVE_INFINITY;
  return (1 / s - 1) / g.k;
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

/** Project a note (lane, depth) to screen. */
export function project(g: HighwayGeometry, lane: number, d: number): Projected {
  const s = scaleAt(g, d);
  return {
    x: g.vpX + (-g.nearHalfWidth + g.laneWidthNear * (lane + 0.5)) * s,
    y: g.vpY + (g.strikeY - g.vpY) * s,
    scale: s,
    radius: g.gemRadiusNear * s,
  };
}

/** Whether a note at depth d should be drawn at all. */
export function isVisibleDepth(g: HighwayGeometry, d: number): boolean {
  return d >= g.minDepth && d <= g.maxDepth;
}

/** Song-time window [from, to] of notes that can be on screen. */
export function visibleTimeWindow(g: HighwayGeometry, songTime: number): { from: number; to: number } {
  return { from: songTime + g.minDepth * g.approachSec, to: songTime + g.maxDepth * g.approachSec };
}

/**
 * Song times of beat lines currently on the road (from just below the strike line to the horizon),
 * with a flag for bar lines (every `beatsPerBar` beats).
 */
export function beatLineTimes(
  g: HighwayGeometry,
  songTime: number,
  bpm: number,
  beatPhase: number,
  beatsPerBar = 4,
  beatIndexHint?: number,
): Array<{ time: number; bar: boolean }> {
  const out: Array<{ time: number; bar: boolean }> = [];
  if (!(bpm > 0) || !Number.isFinite(bpm)) return out;
  const beatSec = 60 / bpm;
  const phase = clamp(beatPhase, 0, 0.999999);
  // Beat index of the most recent beat. Without a hint we assume beat 0 at song time 0.
  const beatIndex = beatIndexHint !== undefined && Number.isFinite(beatIndexHint) ? Math.floor(beatIndexHint) : Math.round(songTime / beatSec - phase);
  const lastBeatTime = songTime - phase * beatSec;
  const first = Math.floor((g.minDepth * g.approachSec) / beatSec) - 1;
  const last = Math.ceil((g.maxDepth * g.approachSec) / beatSec) + 1;
  for (let n = first; n <= last; n++) {
    const t = lastBeatTime + n * beatSec;
    const d = depthOf(g, t, songTime);
    if (d < g.minDepth || d > 1) continue;
    const idx = beatIndex + n;
    out.push({ time: t, bar: ((idx % beatsPerBar) + beatsPerBar) % beatsPerBar === 0 });
  }
  return out;
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
