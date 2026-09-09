export { Highway, DEFAULT_HIGHWAY_OPTIONS, makeFrame, RESTART_JUMP_SEC, MISS_FIZZLE_SEC, LONG_FRAME_MS } from './Highway';
export type { RenderFrame, RenderNote, RenderLaneState, NoteVisualState, HighwayOptions, RenderStats, CanvasLike } from './types';
export {
  makeGeometry,
  depthOf,
  scaleAt,
  yAt,
  depthAtY,
  laneX,
  laneBoundaryX,
  roadEdgeX,
  project,
  isVisibleDepth,
  visibleTimeWindow,
  beatLineTimes,
  fillBeatLines,
  visibleTailSec,
  MAX_BEAT_LINES,
  DEFAULT_GEOMETRY_OPTIONS,
} from './geometry';
export type { HighwayGeometry, GeometryOptions, Projected } from './geometry';
export { ParticlePool, emitHitBurst, makeRng, PARTICLE_SPARK, PARTICLE_RING, PARTICLE_STREAK } from './particles';
export type { EmitOptions, ParticleKind } from './particles';
export { TextCache, DigitRoller, defaultCanvasFactory, fontPx } from './text';
export type { TextStyle, TextSprite, CanvasFactory, Ctx2D } from './text';
export { SpriteCache, blit, GEM_ASPECT, GEM_BUCKETS } from './sprites';
export type { Sprite } from './sprites';
export {
  GH_PALETTE,
  HIGH_CONTRAST_PALETTE,
  getPalette,
  laneColor,
  movementLabel,
  multiplierTier,
  JUDGMENT_STYLE,
  MULTIPLIER_TIERS,
  UI_COLORS,
  withAlpha,
  mixHex,
  hexToRgb,
} from './palette';
export type { LaneColor, LanePalette } from './palette';
export { runDemo, buildDemoChart } from './demo';
export type { DemoOptions, DemoHandle } from './demo';
