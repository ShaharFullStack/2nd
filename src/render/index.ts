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
  MISS_CUE_MARGIN_U,
  RESET_ARC_START,
  RESET_ARC_SWEEP,
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
  roadEdgeXAtY,
  boardHardwareTop,
  overlayPanelBox,
  project,
  isVisibleDepth,
  visibleTimeWindow,
  beatLineTimes,
  fillBeatLines,
  visibleTailSec,
  gemVisibleTailSec,
  fullyVisibleDepth,
  depthAtScale,
  projectInto,
  roadWidthFactor,
  MAX_BEAT_LINES,
  DEFAULT_GEOMETRY_OPTIONS,
  GEM_LANE_FRACTION,
  GEM_ASPECT,
  GEM_HEIGHT_CAP,
  RECEPTOR_GEM_RATIO,
  ROAD_HEIGHT_CAP,
  TAIL_BLEND_DEPTH,
  RECEPTOR_BAND_RATIO,
  clamp,
} from './geometry';
export type { HighwayGeometry, GeometryOptions, Projected, OverlayPanelBox, OverlayPanelRequest } from './geometry';
export { ParticlePool, emitHitBurst, makeRng, PARTICLE_SPARK, PARTICLE_RING, PARTICLE_STREAK, PARTICLE_SMOKE } from './particles';
export type { EmitOptions, ParticleKind } from './particles';
export { TextCache, DigitRoller, defaultCanvasFactory, fontPx, measureInk } from './text';
export type { TextStyle, TextSprite, CanvasFactory, Ctx2D, InkBox } from './text';
export { SpriteCache, blit, GEM_BUCKETS } from './sprites';
export type { Sprite } from './sprites';
export {
  GH_PALETTE,
  HIGH_CONTRAST_PALETTE,
  getPalette,
  laneColor,
  laneLabel,
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
export {
  receptorLook,
  receptorLookInto,
  receptorMarkSet,
  receptorGoalHolding,
  emptyReceptorLook,
  goalStrength,
  ReceptorHistory,
  DEFAULT_REARM_FRACTION,
  DEFAULT_MAX_GAP_SEC,
  GOAL_HOLD_SEC,
  GOAL_FADE_SEC,
  GOAL_MIN_SEC,
  LOST_HOLD_SEC,
  DEFAULT_MIN_INTERVAL_SEC,
  REFRACTORY_GUARD_MIN_SEC,
  refractoryGuard,
  METER_OVER_RANGE,
} from './receptor';
export type { ReceptorLook, LaneStateLike, ReceptorMarkSet } from './receptor';
export { runDemo, buildDemoChart, mountDemoIfRequested, DEMO_QUERY } from './demo';
export type { DemoOptions, DemoHandle } from './demo';
