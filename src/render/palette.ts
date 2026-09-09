import type { Judgment, Movement, Side } from '../engine/types';

/** One lane's color set. All colors are hex `#rrggbb`. */
export interface LaneColor {
  name: string;
  /** Main gem / receptor color. */
  base: string;
  /** Highlight (top of gem, glow core). */
  bright: string;
  /** Shaded side of the gem. */
  dark: string;
  /** Halo / bloom color (used at low alpha). */
  glow: string;
}

export interface LanePalette {
  name: string;
  lanes: LaneColor[];
  /** Missed-note gem colors. */
  miss: LaneColor;
}

/** Guitar Hero order: green, red, yellow, blue (orange as a 5th if ever needed). */
export const GH_PALETTE: LanePalette = {
  name: 'guitar-hero',
  lanes: [
    { name: 'green', base: '#35d43a', bright: '#b9ffb0', dark: '#137a1b', glow: '#6cff70' },
    { name: 'red', base: '#ef3a3a', bright: '#ffc1b3', dark: '#8c1414', glow: '#ff6a5a' },
    { name: 'yellow', base: '#f6d431', bright: '#fff7bd', dark: '#9c7d08', glow: '#ffe96a' },
    { name: 'blue', base: '#3b8cff', bright: '#c5dcff', dark: '#153f8f', glow: '#6fb0ff' },
    { name: 'orange', base: '#ff8c1a', bright: '#ffd9b0', dark: '#8f4a05', glow: '#ffb060' },
  ],
  miss: { name: 'grey', base: '#6e6e74', bright: '#b8b8be', dark: '#33333a', glow: '#8a8a90' },
};

/**
 * Rehab-friendly palette: colorblind-safe, high luminance contrast against the dark road,
 * strongly distinct hues (cyan / orange / magenta / lime) with pale highlights.
 */
export const HIGH_CONTRAST_PALETTE: LanePalette = {
  name: 'high-contrast',
  lanes: [
    { name: 'cyan', base: '#19d3ff', bright: '#e6fbff', dark: '#0a6a86', glow: '#7fe8ff' },
    { name: 'orange', base: '#ff9b1f', bright: '#fff0d6', dark: '#8a4d00', glow: '#ffc76e' },
    { name: 'magenta', base: '#ff4fd8', bright: '#ffe0f7', dark: '#8a1f74', glow: '#ff8fe6' },
    { name: 'lime', base: '#c8ff2a', bright: '#f8ffd0', dark: '#5f8300', glow: '#e0ff7a' },
    { name: 'white', base: '#f4f4f4', bright: '#ffffff', dark: '#888888', glow: '#ffffff' },
  ],
  miss: { name: 'grey', base: '#7a7a80', bright: '#c4c4c8', dark: '#3a3a40', glow: '#9a9aa0' },
};

export function getPalette(highContrast: boolean): LanePalette {
  return highContrast ? HIGH_CONTRAST_PALETTE : GH_PALETTE;
}

/** Lane colors follow GH order regardless of lane count (first N colors). */
export function laneColor(palette: LanePalette, lane: number): LaneColor {
  const lanes = palette.lanes;
  return lanes[((lane % lanes.length) + lanes.length) % lanes.length];
}

/**
 * Judgment popup styles. GOOD is a pale, high-luminance blue so it reads as well as PERFECT on the
 * dark road (rehab audiences must see "good" feedback clearly); MISS is deliberately neutral grey.
 */
export const JUDGMENT_STYLE: Record<Judgment, { text: string; color: string; glow: string; stroke: string }> = {
  perfect: { text: 'PERFECT!', color: '#ffd84a', glow: '#ff9d00', stroke: '#4a2a00' },
  good: { text: 'GOOD', color: '#b6ecff', glow: '#2ea8ff', stroke: '#0a2a5a' },
  miss: { text: 'MISS', color: '#c8c8d0', glow: '#606068', stroke: '#1a1a20' },
};

/** Multiplier badge tiers: index = clamp(multiplier, 1, 4). */
export const MULTIPLIER_TIERS: Record<number, { color: string; glow: string; label: string }> = {
  1: { color: '#9aa0a8', glow: '#5a6068', label: 'x1' },
  2: { color: '#4ce06a', glow: '#1c8a34', label: 'x2' },
  3: { color: '#4aa8ff', glow: '#1c5fb8', label: 'x3' },
  4: { color: '#ffcf3a', glow: '#d08a00', label: 'x4' },
};

export function multiplierTier(multiplier: number): { color: string; glow: string; label: string } {
  const m = Math.max(1, Math.min(4, Math.floor(multiplier)));
  const tier = MULTIPLIER_TIERS[m];
  return multiplier > 4 ? { ...tier, label: `x${Math.floor(multiplier)}` } : tier;
}

/** Rock meter colors low → high. */
export const ROCK_METER_COLORS = { low: '#ff3b3b', mid: '#ffd23a', high: '#41e06a' };

export const UI_COLORS = {
  background0: '#05060c',
  background1: '#101528',
  asphalt0: '#171a26',
  asphalt1: '#0b0d15',
  laneDivider: 'rgba(255,255,255,0.08)',
  beatLine: 'rgba(255,255,255,0.13)',
  barLine: 'rgba(255,255,255,0.32)',
  strikeLine: '#ffffff',
  rail: '#8a9bff',
  panel: '#0e1120',
  text: '#f2f4ff',
  textDim: 'rgba(242,244,255,0.55)',
};

const MOVEMENT_LABEL: Record<Movement, string> = {
  seated_march: 'knee lift',
  knee_extension: 'knee ext',
  ankle_dorsiflexion: 'toe lift',
  hip_abduction: 'leg out',
  hand_open_close: 'open hand',
  wrist_extension: 'wrist up',
  finger_opposition: 'pinch',
  finger_spread: 'spread',
};

/** Short label drawn under a lane, e.g. "L knee lift". */
export function movementLabel(movement: Movement, side: Side): string {
  return `${side === 'left' ? 'L' : 'R'} ${MOVEMENT_LABEL[movement] ?? movement}`;
}

/** Parse `#rgb` / `#rrggbb` → [r,g,b]. Unknown formats return white. */
export function hexToRgb(hex: string): [number, number, number] {
  let h = hex.trim();
  if (h.startsWith('#')) h = h.slice(1);
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length !== 6 || Number.isNaN(parseInt(h, 16))) return [255, 255, 255];
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** `rgba(r,g,b,a)` string for a hex color. */
export function withAlpha(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex);
  const a = Math.max(0, Math.min(1, alpha));
  return `rgba(${r},${g},${b},${a.toFixed(3)})`;
}

/** Linear blend of two hex colors (t 0..1) → hex. */
export function mixHex(a: string, b: string, t: number): string {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  const k = Math.max(0, Math.min(1, t));
  const c = ca.map((v, i) => Math.round(v + (cb[i] - v) * k));
  return '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
}
