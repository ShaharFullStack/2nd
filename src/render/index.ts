export {
  Highway,
  DEFAULT_HIGHWAY_OPTIONS,
  makeFrame,
  RESTART_JUMP_SEC,
  MISS_FIZZLE_SEC,
  LONG_FRAME_MS,
  STATE_JUDGMENT_EARLY_SEC,
  STATE_JUDGMENT_LATE_SEC,
  POPUP_MAX_RISE_FRAC,
} from './Highway';
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
  roadWidthFactor,
  MAX_BEAT_LINES,
  DEFAULT_GEOMETRY_OPTIONS,
  GEM_LANE_FRACTION,
  GEM_HEIGHT_CAP,
  RECEPTOR_GEM_RATIO,
  ROAD_HEIGHT_CAP,
  TAIL_BLEND_DEPTH,
  clamp,
} from './geometry';
export type { HighwayGeometry, GeometryOptions, Projected } from './geometry';
export { ParticlePool, emitHitBurst, makeRng, PARTICLE_SPARK, PARTICLE_RING, PARTICLE_STREAK } from './particles';
export type { EmitOptions, ParticleKind } from './particles';
export { TextCache, DigitRoller, defaultCanvasFactory, fontPx, measureInk } from './text';
export type { TextStyle, TextSprite, CanvasFactory, Ctx2D, InkBox } from './text';
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
