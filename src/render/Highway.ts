/**
 * Guitar-Hero style note highway renderer. Canvas 2D, DPR aware, no React. Bounded allocations on
 * the hot path: sprites, gradients and text are cached, particles are pooled, beat lines and
 * particle colour batches go through preallocated typed arrays. (A few small per-frame
 * allocations remain — e.g. the `getStats()` copy and a handful of colour strings in rarely
 * changing branches — but nothing that scales with note or particle count.)
 *
 * Usage:
 *   const hw = new Highway(canvas);           // canvas: HTMLCanvasElement or OffscreenCanvas
 *   hw.resize();                              // on mount + window resize (reads clientWidth/Height + DPR)
 *   requestAnimationFrame(() => hw.draw(frame));
 *   hw.reset();                               // on song restart / new session (same instance)
 *
 * Sizing rules (`resize()` with no arguments):
 *   - HTMLCanvasElement with CSS size: logical size = clientWidth/clientHeight, backing = × DPR.
 *   - Otherwise (OffscreenCanvas, or a canvas with no CSS sizing) the *attribute* size is taken as
 *     the backing store on first use, logical = attribute / DPR, and later no-arg calls keep the
 *     logical size — the backing store is never re-multiplied by DPR. Call `resize(w, h, dpr)`
 *     to set an explicit logical size.
 *
 * `draw(frame)` is a pure function of the RenderFrame plus a little internal animation state
 * (particles, popups, rolling score). It never mutates the frame. A backward jump of more than
 * `RESTART_JUMP_SEC` in `songTime` is treated as a restart and resets that state automatically.
 *
 * Judgment feedback — two supported integration shapes, and no silent path between them:
 *   - push `HitEvent`s into `frame.recentHits` (the engine's own output), and/or
 *   - flip a note's `state` to 'hit' / 'miss' (and set `judgment`).
 * Whichever the renderer sees first for a given note id produces the burst / flash / tint / popup;
 * the other is de-duped. So an integrator that flips state on the verdict frame and only delivers
 * the event a frame later still gets exactly one set of effects, on the earlier frame — and an
 * integrator that never sends events at all still gets full feedback.
 *
 * Clinical presentation: `highContrast`, `effectIntensity` (0..1) and `reducedMotion` are all
 * runtime-adjustable through `setOptions()`, as is `maxParticles`. Turning the decoration down
 * never removes a judgment cue: at `effectIntensity: 0` a hit still gets a shockwave ring, a lane
 * flash and a popup, and a miss still gets a grey fizzling gem, a puff and a red lane tint.
 *
 * The next target always wins over decoration: judgment popups are small, capped at
 * `POPUP_MAX_RISE_FRAC` of the board above the strike line, and painted *underneath* the gems, so
 * they can never hide an oncoming note. Lane labels are fitted to the lane pitch — staggered onto
 * two rows, and ellipsized only if that is still not enough — so they never collide on a narrow
 * canvas.
 *
 * Degenerate input degrades gracefully. A non-finite `songTime`, `score`, `health`, `combo`,
 * `multiplier`, `beatPhase` or `energy` is treated as a missing value for that frame and cannot
 * reach the smoothed accumulators (receptor glow, rock meter, rolling score): the renderer keeps
 * drawing at the last good song time and recovers completely on the next healthy frame.
 *
 * Pixel-level verification (fret proportions, strike-line uniformity, projection accuracy, miss and
 * hit feedback, the rolling-score odometer, frame cost) lives in `pixel-check.mjs` next to this
 * file: `node src/render/pixel-check.mjs` renders real frames in headless Chromium and asserts on
 * the framebuffer. It is not part of `vitest run` (it needs a browser binary) — the integrator
 * should wire it up as an npm script, `"check:render": "node src/render/pixel-check.mjs"`, so a
 * regression in the *look* is caught by CI and not only by someone reading this comment.
 */
import type { Judgment } from '../engine/types';
import {
  MAX_BEAT_LINES,
  clamp,
  depthAtY,
  depthOf,
  fillBeatLines,
  isVisibleDepth,
  laneBoundaryX,
  laneX,
  makeGeometry,
  project,
  roadEdgeX,
  scaleAt,
  yAt,
  type HighwayGeometry,
} from './geometry';
import {
  JUDGMENT_STYLE,
  ROCK_METER_COLORS,
  UI_COLORS,
  getPalette,
  laneColor,
  mixHex,
  movementLabel,
  multiplierTier,
  withAlpha,
  type LanePalette,
} from './palette';
import { PARTICLE_RING, PARTICLE_SPARK, PARTICLE_STREAK, ParticlePool, emitHitBurst, makeRng } from './particles';
import { GEM_ASPECT, SpriteCache, blit } from './sprites';
import { DigitRoller, TextCache, defaultCanvasFactory, fontPx, type Ctx2D, type TextStyle } from './text';
import type { CanvasLike, HighwayOptions, RenderFrame, RenderNote, RenderStats } from './types';

export const DEFAULT_HIGHWAY_OPTIONS: HighwayOptions = {
  approachSec: 1.6,
  horizonY: 0.35,
  strikeY: 0.82,
  farScale: 0.28,
  roadWidth: 0.46,
  pastLineSpeed: 0.42,
  highContrast: false,
  showLabels: true,
  showMissPopup: false,
  showStats: false,
  maxParticles: 600,
  effectIntensity: 1,
  reducedMotion: false,
};

/** Backward songTime jump (s) that is interpreted as a restart (effects/rolling state reset). */
export const RESTART_JUMP_SEC = 2;
/** How long a missed gem takes to grey out, shrink and fade after the engine declares the miss. */
export const MISS_FIZZLE_SEC = 0.42;
/** Frame interval above which a frame counts as "long" (dropped at 60 Hz). */
export const LONG_FRAME_MS = 25;
/**
 * How far a note's `state` flip may be from its note time and still be treated as a fresh judgment
 * by the no-event fallback in `processHits` (early / late bounds, seconds). The late bound is well
 * inside the de-dupe map's retention window, so a note that lingers in `frame.notes` can never be
 * forgotten and then re-fire its effects.
 */
export const STATE_JUDGMENT_EARLY_SEC = 0.6;
export const STATE_JUDGMENT_LATE_SEC = 1;

const MAX_LANES = 8;
/** Judgment popup slots. More than one per lane so 8th notes on a repeated lane never cut each other off. */
const POPUP_SLOTS = 16;
/** Judgment popup lifetime (s). */
const POPUP_SEC = 0.75;
/** Popup anchor above the strike line, in receptor radii. */
const POPUP_BASE_R = 0.95;
/** Extra offset per stacked popup in the same lane, in receptor radii (at most two stack). */
const POPUP_STACK_R = 0.45;
/** How far a popup (anchor + rise) may sit above the strike line, as a fraction of horizon→strike. */
export const POPUP_MAX_RISE_FRAC = 0.34;
/** Popup float distance over its life, in receptor radii (a third of that under reduced motion). */
const POPUP_RISE_R = 0.35;
/** Half-height of the strike line glow band, in UI units. */
const STRIKE_BAND_H = 16;
/** Alpha bands used to batch fading particle streaks (one path + stroke per non-empty band). */
const STREAK_ALPHA_BANDS = 4;
const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const WHITE_COLOR_INDEX = 250;
const MISS_COLOR_INDEX = 251;
const BEAM_SPRITE_W = 128;
const BEAM_SPRITE_H = 256;
const BEAM_HEX = ['#aab4ff', '#6eff8c', '#78aaff', '#ffd65a'];
// Static gradient-cache keys (avoid building strings on the hot path).
const BAND_KEYS = ['band1', 'band2', 'band3', 'band4'];
const BADGE_KEYS = ['badge1', 'badge2', 'badge3', 'badge4'];
const FLASH_KEYS = Array.from({ length: MAX_LANES }, (_, i) => `flashHit${i}`);
const METER_KEYS = Array.from({ length: MAX_LANES }, (_, i) => `meter${i}`);
const METER_HOT_KEYS = Array.from({ length: MAX_LANES }, (_, i) => `meterHot${i}`);

interface Popup {
  active: boolean;
  judgment: Judgment;
  t0: number;
  x: number;
  y: number;
  lane: number;
}

function now(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
}

function easeOutCubic(t: number): number {
  const u = 1 - clamp(t, 0, 1);
  return 1 - u * u * u;
}

function roundRectPath(ctx: Ctx2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

const byTimeDesc = (a: RenderNote, b: RenderNote): number => b.time - a.time;

export class Highway {
  readonly canvas: CanvasLike;
  private ctx: Ctx2D | null;
  private opts: HighwayOptions;
  private geom: HighwayGeometry;
  private width = 1;
  private height = 1;
  private dpr = 1;
  /** True once a logical size has been established (see sizing rules in the header). */
  private sized = false;
  /** UI scale unit (1 at 1280x720). */
  private u = 1;
  private palette: LanePalette;

  private readonly factory: (w: number, h: number) => CanvasLike;
  private readonly sprites: SpriteCache;
  private readonly text: TextCache;
  private readonly digits: DigitRoller;
  private readonly particles: ParticlePool;
  private readonly rng = makeRng(0xbeef);

  // Static background layer (gradient) and star tiles for parallax.
  private bgLayer: CanvasLike | null = null;
  private starFar: CanvasLike | null = null;
  private starNear: CanvasLike | null = null;

  // Cached CanvasGradient objects (static per geometry / palette); alpha is applied via globalAlpha.
  private grads = new Map<string, CanvasGradient>();

  // Effect state.
  /**
   * noteId → songTime at which this note's judgment feedback was produced. Written by whichever
   * arrives first: a `HitEvent` in `recentHits`, or a note whose `state` the integrator flipped to
   * hit/miss. Purely a de-dupe ledger, so the two paths can never both fire *and* can never both
   * stay silent (the old code shared this map with the miss fizzle clock, which made a state flip
   * one frame ahead of the event swallow the miss burst and lane tint entirely).
   */
  private seenHits = new Map<number, number>();
  /** noteId → songTime the miss fizzle started (separate clock from the de-dupe ledger above). */
  private missT0 = new Map<number, number>();
  /**
   * Song time each lane's flash started. Float64 on purpose: a Float32Array would round the stored
   * song time (e.g. 6.28 → 6.28000020980835) and make `songTime - laneFlashT0[lane]` come out
   * *negative* on the very frame the flash is created — which used to clear it before it ever drew,
   * silently dropping the hit / miss lane tint on roughly half of all judgments.
   */
  private laneFlashT0 = new Float64Array(MAX_LANES).fill(-10);
  private laneFlashKind = new Uint8Array(MAX_LANES); // 0 none, 1 hit, 2 miss
  private laneGlow = new Float32Array(MAX_LANES);
  private popups: Popup[] = [];
  private lastCombo = 0;
  /** Scratch for the allocation-free de-dupe/fizzle map pruning (see `prune*` below). */
  private pruneNow = 0;
  private pruneKeep = 3;
  private lastComboShown = 0;
  private comboBounceT0 = -10;
  private comboBreakT0 = -10;
  private lastMultiplier = 1;
  private multiplierPopT0 = -10;
  private displayScore = 0;
  private healthSmooth = 1;
  private lastSongTime: number | null = null;
  /**
   * Sanitized song time for the frame being drawn. Every internal draw step reads this instead of
   * `frame.songTime`, so one non-finite value out of the audio clock (`ctx.currentTime -
   * songStartCtxTime` before the start time is armed) cannot reach any smoothed accumulator.
   */
  private stNow = 0;
  private warnedThreshold = false;
  private lastDrawWall = -1;
  private sortBuf: RenderNote[] = [];
  private beatTimes = new Float64Array(MAX_BEAT_LINES);
  private beatBars = new Uint8Array(MAX_BEAT_LINES);
  private colorBatch = new Uint16Array(64);

  private stats: RenderStats = {
    drawMs: 0,
    avgDrawMs: 0,
    maxDrawMs: 0,
    frameMs: 0,
    avgFrameMs: 0,
    fps: 0,
    longFrames: 0,
    frames: 0,
    notesDrawn: 0,
    particles: 0,
    sprites: 0,
  };

  constructor(canvas: CanvasLike, options: Partial<HighwayOptions> = {}) {
    this.canvas = canvas;
    this.opts = { ...DEFAULT_HIGHWAY_OPTIONS, ...options };
    this.factory = this.opts.createCanvas ?? defaultCanvasFactory;
    this.ctx = canvas.getContext('2d', { alpha: false }) ?? canvas.getContext('2d');
    this.sprites = new SpriteCache(this.factory);
    this.text = new TextCache(this.factory, 320);
    this.digits = new DigitRoller(this.factory);
    this.particles = new ParticlePool(this.opts.maxParticles);
    this.palette = getPalette(this.opts.highContrast);
    this.geom = makeGeometry(1, 1, 4, this.opts);
    for (let i = 0; i < POPUP_SLOTS; i++) this.popups.push({ active: false, judgment: 'good', t0: 0, x: 0, y: 0, lane: 0 });
    this.resize();
  }

  /** Decorative effect scale 0..1 (`effectIntensity`, clamped). */
  private get eff(): number {
    return clamp(this.opts.effectIntensity, 0, 1);
  }

  /**
   * Alpha scale for *judgment feedback* (lane flash, miss tint, popups). Follows `effectIntensity`
   * but never drops below 0.55 — a calmer presentation must still be an unmistakable one.
   */
  private get coreEff(): number {
    return 0.55 + 0.45 * this.eff;
  }

  /** Current geometry (rebuilt on resize / lane-count change). */
  get geometry(): HighwayGeometry {
    return this.geom;
  }

  get options(): Readonly<HighwayOptions> {
    return this.opts;
  }

  /** Logical (CSS px) size and DPR currently in use. */
  get size(): { width: number; height: number; dpr: number } {
    return { width: this.width, height: this.height, dpr: this.dpr };
  }

  /**
   * Update tunables at runtime (palette, approach speed, effect intensity, particle budget, ...).
   * Every option in `HighwayOptions` takes effect on the next `draw()`: caches that depend on the
   * palette or geometry are dropped, the pre-rendered background is re-baked at the new horizon,
   * and the particle pool is reallocated when `maxParticles` changes.
   */
  setOptions(patch: Partial<HighwayOptions>): void {
    this.opts = { ...this.opts, ...patch };
    this.palette = getPalette(this.opts.highContrast);
    this.sprites.clear();
    this.text.clear();
    this.grads.clear();
    this.particles.setCapacity(this.opts.maxParticles);
    this.rebuildGeometry(this.geom.laneCount);
    // The background layer bakes in the horizon position and the canvas size, so any change to
    // horizonY / strikeY / farScale / roadWidth leaves a stale haze blob floating in the sky.
    this.buildBackground();
  }

  getStats(): RenderStats {
    return { ...this.stats };
  }

  resetStats(): void {
    this.stats.avgDrawMs = 0;
    this.stats.maxDrawMs = 0;
    this.stats.longFrames = 0;
    this.stats.avgFrameMs = 0;
    this.stats.fps = 0;
    this.lastDrawWall = -1;
  }

  /**
   * Clear all transient animation state: seen hit ids, particles, popups, lane flashes / glow,
   * rolling score, smoothed health, combo & multiplier pop timers. Call when a song (re)starts
   * with the same Highway instance. Draw stats and caches are kept.
   */
  reset(): void {
    this.seenHits.clear();
    this.missT0.clear();
    this.particles.clear();
    for (const p of this.popups) p.active = false;
    this.laneFlashT0.fill(-10);
    this.laneFlashKind.fill(0);
    this.laneGlow.fill(0);
    this.lastCombo = 0;
    this.lastComboShown = 0;
    this.comboBounceT0 = -10;
    this.comboBreakT0 = -10;
    this.lastMultiplier = 1;
    this.multiplierPopT0 = -10;
    this.displayScore = 0;
    this.healthSmooth = 1;
    this.lastSongTime = null;
    this.stats.particles = 0;
    this.stats.notesDrawn = 0;
  }

  /**
   * Resize the backing store. See the sizing rules in the file header. Idempotent *and cheap*:
   * when the logical size, DPR and backing store are all unchanged the call returns before
   * re-baking the background (a full-screen canvas plus two star tiles, ~130 radial gradients) and
   * before dropping the text cache — window-drag resize storms are free after the first event.
   */
  resize(width?: number, height?: number, dpr?: number): void {
    const c = this.canvas as CanvasLike & { clientWidth?: number; clientHeight?: number };
    const ratio = clamp(dpr ?? (typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 1), 0.5, 4);
    let w = width;
    let h = height;
    if (w === undefined || h === undefined) {
      if (typeof c.clientWidth === 'number' && c.clientWidth > 0 && typeof c.clientHeight === 'number' && c.clientHeight > 0) {
        w = c.clientWidth;
        h = c.clientHeight;
      } else if (this.sized) {
        // No CSS size: keep the established logical size, never re-derive it from the attributes.
        w = this.width;
        h = this.height;
      } else {
        // First sizing of an un-styled / offscreen canvas: its attribute size *is* the backing store.
        w = Math.max(1, c.width / ratio);
        h = Math.max(1, c.height / ratio);
      }
    }
    const lw = Math.max(1, Math.floor(w));
    const lh = Math.max(1, Math.floor(h));
    const bw = Math.round(lw * ratio);
    const bh = Math.round(lh * ratio);
    if (this.sized && lw === this.width && lh === this.height && ratio === this.dpr && c.width === bw && c.height === bh) {
      return; // Nothing changed — don't reallocate the background layers or wipe the text cache.
    }
    this.width = lw;
    this.height = lh;
    this.dpr = ratio;
    this.sized = true;
    if (c.width !== bw) c.width = bw;
    if (c.height !== bh) c.height = bh;
    this.u = clamp(Math.min(this.width / 1280, this.height / 720), 0.35, 2.5);
    this.text.dpr = this.dpr;
    this.text.clear();
    this.rebuildGeometry(this.geom.laneCount);
    this.buildBackground();
  }

  private rebuildGeometry(laneCount: number): void {
    this.geom = makeGeometry(this.width, this.height, laneCount, this.opts);
    const g = this.geom;
    this.sprites.setRadiusRange(g.gemRadiusNear * this.opts.farScale * 0.9, g.gemRadiusNear * 1.4, this.dpr);
    this.grads.clear();
  }

  private buildBackground(): void {
    const W = this.width;
    const H = this.height;
    const bg = this.factory(W * this.dpr, H * this.dpr);
    const bctx = bg.getContext('2d');
    if (bctx) {
      bctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      const grad = bctx.createLinearGradient(0, 0, 0, H);
      grad.addColorStop(0, UI_COLORS.background0);
      grad.addColorStop(0.45, UI_COLORS.background1);
      grad.addColorStop(1, UI_COLORS.background0);
      bctx.fillStyle = grad;
      bctx.fillRect(0, 0, W, H);
      // Horizon haze
      const haze = bctx.createRadialGradient(W / 2, this.geom.horizonY, 0, W / 2, this.geom.horizonY, W * 0.6);
      haze.addColorStop(0, 'rgba(120,140,255,0.22)');
      haze.addColorStop(0.5, 'rgba(80,90,200,0.06)');
      haze.addColorStop(1, 'rgba(0,0,0,0)');
      bctx.fillStyle = haze;
      bctx.fillRect(0, 0, W, H);
      this.bgLayer = bg;
    } else {
      this.bgLayer = null;
    }
    this.starFar = this.makeStarTile(W, H * 0.5, 90, 1.1, 0.55, 11);
    this.starNear = this.makeStarTile(W, H * 0.5, 40, 1.9, 0.85, 23);
  }

  private makeStarTile(w: number, h: number, count: number, size: number, alpha: number, seed: number): CanvasLike | null {
    const tile = this.factory(w * this.dpr, h * this.dpr);
    const ctx = tile.getContext('2d');
    if (!ctx) return null;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const rng = makeRng(seed);
    for (let i = 0; i < count; i++) {
      const x = rng() * w;
      const y = rng() * h;
      const r = size * (0.4 + rng() * 0.8) * this.u;
      const a = alpha * (0.4 + rng() * 0.6);
      const g = ctx.createRadialGradient(x, y, 0, x, y, r * 2.5);
      g.addColorStop(0, `rgba(255,255,255,${a.toFixed(2)})`);
      g.addColorStop(0.4, `rgba(200,215,255,${(a * 0.35).toFixed(2)})`);
      g.addColorStop(1, 'rgba(200,215,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x - r * 2.5, y - r * 2.5, r * 5, r * 5);
    }
    return tile;
  }

  /** Cached gradient by key; `make` runs once per key until the next geometry / palette change. */
  private grad(key: string, make: () => CanvasGradient): CanvasGradient {
    let g = this.grads.get(key);
    if (!g) {
      g = make();
      this.grads.set(key, g);
    }
    return g;
  }

  // ---------------------------------------------------------------------------------------------
  // Frame
  // ---------------------------------------------------------------------------------------------

  draw(frame: RenderFrame): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t0 = now();
    const laneCount = clamp(frame.lanes.length || 4, 1, MAX_LANES);
    if (laneCount !== this.geom.laneCount) this.rebuildGeometry(laneCount);

    // Degenerate input from a live pipeline must degrade gracefully: a non-finite song time is
    // treated as "no time passed" (the frame still draws, at the last good time) rather than
    // flowing into dt and from there into every smoothed accumulator, permanently.
    const st = Number.isFinite(frame.songTime) ? frame.songTime : (this.lastSongTime ?? 0);
    this.stNow = st;
    if (this.lastSongTime !== null && st < this.lastSongTime - RESTART_JUMP_SEC) this.reset();
    const dt = this.lastSongTime === null ? 0 : clamp(st - this.lastSongTime, 0, 0.1);
    this.lastSongTime = st;
    const energy = clamp(frame.energy ?? 0, 0, 1);
    const mult = clamp(frame.multiplier, 1, 8);
    const beat = clamp(frame.beatPhase, 0, 1);
    // 1 on the beat, decays quickly. Reduced motion holds it at a steady mid value so every
    // beat-driven glow / size pulse in the frame goes flat in one place instead of ten.
    const beatPulse = this.opts.reducedMotion ? 0.3 : Math.pow(1 - beat, 3);

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

    this.processHits(frame);
    this.drawBackground(ctx, energy, mult, beatPulse);
    this.drawRoad(ctx, frame, mult, beatPulse, energy);
    this.drawLaneFlashes(ctx, st);
    this.drawStrikeLine(ctx, frame, beatPulse);
    this.drawReceptors(ctx, frame, dt, beat);
    // Popups go *under* the gems on purpose: judgment text is redundant feedback (the lane flash,
    // the burst and the combo all say the same thing), the next target is not. Drawing them here
    // means a popup can never hide an oncoming note even if it overlaps one.
    this.drawPopups(ctx, st);
    this.stats.notesDrawn = this.drawNotes(ctx, frame);
    this.particles.update(dt);
    this.drawParticles(ctx);
    this.drawHud(ctx, frame, dt, beatPulse);
    this.drawCombo(ctx, frame, st);
    if (this.opts.showLabels) this.drawLabels(ctx, frame);
    if (this.opts.showStats) this.drawStats(ctx);

    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

    const t1 = now();
    const ms = t1 - t0;
    const s = this.stats;
    s.drawMs = ms;
    s.avgDrawMs = s.frames === 0 ? ms : s.avgDrawMs + (ms - s.avgDrawMs) * 0.05;
    if (ms > s.maxDrawMs) s.maxDrawMs = ms;
    if (this.lastDrawWall >= 0) {
      const fm = t0 - this.lastDrawWall;
      s.frameMs = fm;
      s.avgFrameMs = s.avgFrameMs === 0 ? fm : s.avgFrameMs + (fm - s.avgFrameMs) * 0.05;
      s.fps = s.avgFrameMs > 0 ? 1000 / s.avgFrameMs : 0;
      if (fm > LONG_FRAME_MS) s.longFrames++;
    }
    this.lastDrawWall = t0;
    s.frames++;
    s.particles = this.particles.count;
    s.sprites = this.sprites.size + this.text.size;
  }

  // ---------------------------------------------------------------------------------------------
  // Background: gradient, parallax stars, stage lights, side panels
  // ---------------------------------------------------------------------------------------------

  private drawBackground(ctx: Ctx2D, energy: number, mult: number, beatPulse: number): void {
    const W = this.width;
    const H = this.height;
    if (this.bgLayer) {
      ctx.drawImage(this.bgLayer as unknown as CanvasImageSource, 0, 0, W, H);
    } else {
      ctx.fillStyle = UI_COLORS.background0;
      ctx.fillRect(0, 0, W, H);
    }
    const eff = this.eff;
    const still = this.opts.reducedMotion;
    const intensity = (0.55 + (mult - 1) * 0.15 + energy * 0.5) * eff;
    // Parallax star layers (wrap horizontally). Positive modulo: songTime is negative in a count-in.
    // Reduced motion freezes the scroll (the layers still light the stage, they just stop moving).
    const t = this.stNow;
    if (intensity > 0.01) {
      ctx.globalCompositeOperation = 'lighter';
      this.drawStarLayer(ctx, this.starFar, still ? 0 : (((t * 6) % W) + W) % W, 0.35 * intensity);
      this.drawStarLayer(ctx, this.starNear, still ? 0 : (((t * 14) % W) + W) % W, 0.5 * intensity);
    }

    // Stage light cones from the top edge, slowly sweeping: soft pre-rendered sprites rotated
    // about their apex (no per-frame gradients, no hard edges).
    const tierIdx = clamp(Math.floor(mult) - 1, 0, 3);
    const beamSprite = eff > 0.02 ? this.sprites.beam(BEAM_HEX[tierIdx], BEAM_SPRITE_W, BEAM_SPRITE_H) : null;
    if (beamSprite) {
      const beams = mult >= 3 ? 4 : 3;
      const baseAlpha = clamp((0.16 + (mult - 1) * 0.05 + energy * 0.22) * (0.75 + beatPulse * 0.45) * eff, 0, 0.7);
      const len = H * 0.95;
      const wide = W * 0.22 * (1 + energy * 0.5);
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < beams; i++) {
        const ox = (W * (i + 0.5)) / beams;
        const sweep = still ? 0 : Math.sin(t * 0.5 + i * 1.7) * 0.42;
        const angle = sweep - ((ox - W / 2) / W) * 0.5;
        ctx.save();
        ctx.translate(ox, -H * 0.02);
        ctx.rotate(angle);
        ctx.globalAlpha = baseAlpha;
        ctx.drawImage(beamSprite.canvas as unknown as CanvasImageSource, -wide / 2, 0, wide, len);
        ctx.restore();
      }
      ctx.globalAlpha = 1;
    }
    ctx.globalCompositeOperation = 'source-over';

    // Side panels: dark slabs filling the space outside the road, with a beat-pulsing glow band
    // hugging each road edge.
    const g = this.geom;
    const panelTop = g.horizonY + (g.strikeY - g.horizonY) * 0.3;
    const dTop = depthAtY(g, panelTop);
    const yBottom = yAt(g, g.minDepth);
    const glowA = (0.1 + beatPulse * 0.18 + energy * 0.12) * eff;
    const tier = multiplierTier(mult);
    const bandW = 26 * this.u;
    const panelGrad = this.grad('panel', () => {
      const lp = ctx.createLinearGradient(0, panelTop, 0, H);
      lp.addColorStop(0, withAlpha(UI_COLORS.panel, 0));
      lp.addColorStop(0.35, withAlpha(UI_COLORS.panel, 0.7));
      lp.addColorStop(1, withAlpha(UI_COLORS.panel, 0.92));
      return lp;
    });
    const bandGrad = this.grad(BAND_KEYS[tierIdx], () => {
      const sg = ctx.createLinearGradient(0, panelTop, 0, H);
      sg.addColorStop(0, withAlpha(tier.glow, 0));
      sg.addColorStop(0.55, tier.color);
      sg.addColorStop(1, withAlpha(tier.color, 0.5));
      return sg;
    });
    for (let side = -1; side <= 1; side += 2) {
      const sd = side as -1 | 1;
      const outerX = sd < 0 ? 0 : W;
      const eTop = roadEdgeX(g, sd, dTop);
      const eBot = roadEdgeX(g, sd, g.minDepth);
      if (Math.abs(outerX - eBot) < 6) continue;
      ctx.fillStyle = panelGrad;
      ctx.beginPath();
      ctx.moveTo(outerX, panelTop);
      ctx.lineTo(eTop, panelTop);
      ctx.lineTo(eBot, yBottom);
      ctx.lineTo(outerX, yBottom);
      ctx.closePath();
      ctx.fill();
      // Glow band just outside the road edge.
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = glowA;
      ctx.fillStyle = bandGrad;
      ctx.beginPath();
      ctx.moveTo(eTop, panelTop);
      ctx.lineTo(eTop + sd * bandW, panelTop);
      ctx.lineTo(eBot + sd * bandW, yBottom);
      ctx.lineTo(eBot, yBottom);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  private drawStarLayer(ctx: Ctx2D, tile: CanvasLike | null, offset: number, alpha: number): void {
    if (!tile) return;
    const W = this.width;
    const h = this.height * 0.5;
    ctx.globalAlpha = clamp(alpha, 0, 1);
    const img = tile as unknown as CanvasImageSource;
    const ox = -offset; // in (-W, 0]: the two tiles always cover [0, W)
    ctx.drawImage(img, ox, 0, W, h);
    ctx.drawImage(img, ox + W, 0, W, h);
    ctx.globalAlpha = 1;
  }

  // ---------------------------------------------------------------------------------------------
  // Road
  // ---------------------------------------------------------------------------------------------

  private roadPath(ctx: Ctx2D): void {
    const g = this.geom;
    const dNear = g.minDepth;
    ctx.beginPath();
    ctx.moveTo(roadEdgeX(g, -1, dNear), yAt(g, dNear));
    ctx.lineTo(roadEdgeX(g, 1, dNear), yAt(g, dNear));
    ctx.lineTo(roadEdgeX(g, 1, 1), g.horizonY);
    ctx.lineTo(roadEdgeX(g, -1, 1), g.horizonY);
    ctx.closePath();
  }

  private drawRoad(ctx: Ctx2D, frame: RenderFrame, mult: number, beatPulse: number, energy: number): void {
    const g = this.geom;
    const H = this.height;
    // Asphalt
    ctx.fillStyle = this.grad('asphalt', () => {
      const asphalt = ctx.createLinearGradient(0, g.horizonY, 0, H);
      asphalt.addColorStop(0, '#2a2f44');
      asphalt.addColorStop(0.12, UI_COLORS.asphalt0);
      asphalt.addColorStop(1, UI_COLORS.asphalt1);
      return asphalt;
    });
    this.roadPath(ctx);
    ctx.fill();

    // Beat / bar lines
    const nLines = fillBeatLines(g, this.stNow, frame.bpm, frame.beatPhase, this.beatTimes, this.beatBars, 4, frame.beatIndex);
    ctx.lineCap = 'butt';
    for (let pass = 0; pass < 2; pass++) {
      ctx.beginPath();
      let any = false;
      for (let i = 0; i < nLines; i++) {
        if (this.beatBars[i] !== pass) continue;
        const d = depthOf(g, this.beatTimes[i], this.stNow);
        const y = yAt(g, d);
        ctx.moveTo(roadEdgeX(g, -1, d), y);
        ctx.lineTo(roadEdgeX(g, 1, d), y);
        any = true;
      }
      if (!any) continue;
      const bar = pass === 1;
      ctx.strokeStyle = bar ? UI_COLORS.barLine : UI_COLORS.beatLine;
      ctx.lineWidth = (bar ? 2.5 : 1.2) * this.u;
      ctx.stroke();
    }

    // Lane dividers
    ctx.beginPath();
    for (let b = 1; b < g.laneCount; b++) {
      ctx.moveTo(laneBoundaryX(g, b, g.minDepth), yAt(g, g.minDepth));
      ctx.lineTo(laneBoundaryX(g, b, 1), g.horizonY);
    }
    ctx.strokeStyle = UI_COLORS.laneDivider;
    ctx.lineWidth = 1.5 * this.u;
    ctx.stroke();

    // Fog toward the horizon
    ctx.fillStyle = this.grad('fog', () => {
      const fog = ctx.createLinearGradient(0, g.horizonY, 0, g.horizonY + (g.strikeY - g.horizonY) * 0.35);
      fog.addColorStop(0, 'rgba(90,110,200,0.55)');
      fog.addColorStop(1, 'rgba(90,110,200,0)');
      return fog;
    });
    this.roadPath(ctx);
    ctx.fill();

    // Edge rails: wide soft glow + thin bright line, colour by multiplier tier, pulse on beat.
    const tier = multiplierTier(mult);
    const railA = (0.35 + beatPulse * 0.4 + energy * 0.3) * this.eff;
    for (let side = -1; side <= 1; side += 2) {
      const s = side as -1 | 1;
      ctx.beginPath();
      ctx.moveTo(roadEdgeX(g, s, g.minDepth), yAt(g, g.minDepth));
      ctx.lineTo(roadEdgeX(g, s, 1), g.horizonY);
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = clamp(railA * 0.45, 0, 1);
      ctx.strokeStyle = tier.glow;
      ctx.lineWidth = 9 * this.u;
      ctx.stroke();
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = clamp(0.5 + railA * 0.5, 0, 1);
      ctx.strokeStyle = mult >= 2 ? tier.color : UI_COLORS.rail;
      ctx.lineWidth = 2.2 * this.u;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  // Coloured lane flash on hit (lane colour) / miss (soft red tint), fading over ~0.3–0.45 s.
  private drawLaneFlashes(ctx: Ctx2D, st: number): void {
    const g = this.geom;
    for (let lane = 0; lane < g.laneCount; lane++) {
      const kind = this.laneFlashKind[lane];
      if (!kind) continue;
      const age = st - this.laneFlashT0[lane];
      const dur = kind === 1 ? 0.28 : 0.45;
      // A tiny negative age is clock jitter on the frame the flash was created — draw it anyway.
      // Only a real backward jump (or an expired flash) clears the slot.
      if (age > dur || age < -0.05) {
        this.laneFlashKind[lane] = 0;
        continue;
      }
      // Judgment feedback: scaled by coreEff (never below 0.55) rather than by effectIntensity, so
      // "calmer effects" softens the tint without ever making a miss look like nothing happened.
      const k = (1 - clamp(age, 0, dur) / dur) * this.coreEff;
      const grad = this.grad(kind === 1 ? FLASH_KEYS[lane] : 'flashMiss', () => {
        const color = kind === 1 ? laneColor(this.palette, lane).glow : '#ff3030';
        const lg = ctx.createLinearGradient(0, g.strikeY, 0, g.horizonY);
        lg.addColorStop(0, withAlpha(color, kind === 1 ? 0.55 : 0.3));
        lg.addColorStop(0.6, withAlpha(color, 0.12));
        lg.addColorStop(1, withAlpha(color, 0));
        return lg;
      });
      ctx.fillStyle = grad;
      ctx.globalAlpha = k;
      ctx.globalCompositeOperation = kind === 1 ? 'lighter' : 'source-over';
      ctx.beginPath();
      ctx.moveTo(laneBoundaryX(g, lane, g.minDepth), yAt(g, g.minDepth));
      ctx.lineTo(laneBoundaryX(g, lane + 1, g.minDepth), yAt(g, g.minDepth));
      ctx.lineTo(laneBoundaryX(g, lane + 1, 1), g.horizonY);
      ctx.lineTo(laneBoundaryX(g, lane, 1), g.horizonY);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Strike line + receptors
  // ---------------------------------------------------------------------------------------------

  private drawStrikeLine(ctx: Ctx2D, frame: RenderFrame, beatPulse: number): void {
    const g = this.geom;
    const y = g.strikeY;
    const x0 = roadEdgeX(g, -1, 0);
    const x1 = roadEdgeX(g, 1, 0);
    const energy = clamp(frame.energy ?? 0, 0, 1);
    // Soft glow band. A cached *vertical* gradient filled across the road: uniform left-to-right
    // like a Clone Hero fret board, so the outer lanes' receptors sit in exactly as much light as
    // the middle ones. (Stretching one radial glow sprite across the road made an ellipse — bright
    // at road centre, visibly dimmer at the outermost receptors.)
    const bandH = STRIKE_BAND_H * this.u;
    const band = this.grad('strikeBand', () => {
      const bg = ctx.createLinearGradient(0, y - bandH, 0, y + bandH);
      bg.addColorStop(0, 'rgba(220,230,255,0)');
      bg.addColorStop(0.34, 'rgba(220,230,255,0.30)');
      bg.addColorStop(0.5, 'rgba(230,240,255,0.85)');
      bg.addColorStop(0.66, 'rgba(220,230,255,0.30)');
      bg.addColorStop(1, 'rgba(220,230,255,0)');
      return bg;
    });
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = clamp((0.42 + beatPulse * 0.26 + energy * 0.18) * this.coreEff, 0, 1);
    ctx.fillStyle = band;
    ctx.fillRect(x0, y - bandH, x1 - x0, bandH * 2);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    // Crisp line — flat white across the whole board, like a fret line: the outer lanes' receptors
    // must sit on exactly as bright a line as the middle ones.
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.lineWidth = 3 * this.u;
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(x1, y);
    ctx.stroke();
  }

  private drawReceptors(ctx: Ctx2D, frame: RenderFrame, dt: number, beat: number): void {
    const g = this.geom;
    // The receptor meter is biofeedback: it must fill against the same threshold the engine fires
    // on (Difficulty.thresholdFraction, per session, from calibration). Falling back to 0.5 without
    // saying so would show a full ring at a threshold that does not trigger — so say so, once.
    if (!Number.isFinite(frame.thresholdFraction as number)) {
      if (!this.warnedThreshold) {
        this.warnedThreshold = true;
        if (typeof console !== 'undefined' && typeof console.warn === 'function') {
          console.warn(
            '[Highway] RenderFrame.thresholdFraction is missing: receptor meters are filling against the default 0.5, ' +
              "not this session's calibrated Difficulty.thresholdFraction. Pass it on every frame.",
          );
        }
      }
    }
    const threshold = clamp(frame.thresholdFraction ?? 0.5, 0.05, 1);
    const r = g.receptorRadius;
    const ry = r * GEM_ASPECT;
    const glowSprite = this.sprites.glow('#ffffff', 64);
    for (let lane = 0; lane < g.laneCount; lane++) {
      const ls = frame.laneStates[lane];
      const value = ls ? clamp(ls.value, 0, 1.5) : 0;
      const armed = ls ? ls.armed : true;
      const tracking = ls ? ls.tracking !== false : true;
      const color = laneColor(this.palette, lane);
      const x = laneX(g, lane, 0);
      const y = g.strikeY;
      // Fill fraction relative to threshold: 1 means "would trigger".
      const fill = clamp(value / threshold, 0, 1);
      // Smooth the glow so it breathes instead of flickering with camera noise.
      const target = tracking ? fill * fill : 0;
      const prevGlow = Number.isFinite(this.laneGlow[lane]) ? this.laneGlow[lane] : 0;
      this.laneGlow[lane] = prevGlow + (target - prevGlow) * clamp(dt * 14, 0, 1);
      const glowLevel = this.laneGlow[lane];
      const pulse = armed ? 1 + (this.opts.reducedMotion ? 0 : 0.035 * Math.sin(beat * Math.PI * 2)) : 0.94;
      const alphaBase = tracking ? 1 : 0.4;

      // Halo behind the receptor grows with the meter.
      if (glowSprite && glowLevel > 0.02) {
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = glowLevel * 0.9 * alphaBase;
        const laneGlowSprite = this.sprites.glow(color.glow, 64) ?? glowSprite;
        const gs = (r * (2.2 + glowLevel * 1.4)) / 64;
        blit(ctx, laneGlowSprite, x, y, gs);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
      }

      // Meter fill: liquid rising inside the ring.
      if (fill > 0.01) {
        ctx.save();
        ctx.beginPath();
        ctx.ellipse(x, y, r * 0.92 * pulse, ry * 0.9 * pulse, 0, 0, Math.PI * 2);
        ctx.clip();
        const top = y + ry - fill * ry * 2;
        const hot = fill >= 0.999;
        ctx.fillStyle = this.grad(hot ? METER_HOT_KEYS[lane] : METER_KEYS[lane], () => {
          const grad = ctx.createLinearGradient(0, y - ry, 0, y + ry);
          grad.addColorStop(0, withAlpha(hot ? color.bright : color.base, hot ? 0.95 : 0.55));
          grad.addColorStop(1, withAlpha(color.dark, 0.85));
          return grad;
        });
        ctx.globalAlpha = alphaBase;
        ctx.fillRect(x - r, top, r * 2, y + ry - top + 1);
        // Meniscus highlight
        ctx.fillStyle = color.bright;
        ctx.globalAlpha = 0.7 * alphaBase;
        ctx.fillRect(x - r, top - 1, r * 2, Math.max(1, 2 * this.u));
        ctx.globalAlpha = 1;
        ctx.restore();
      }

      // Ring sprite
      const spr = this.sprites.receptor(color, r);
      ctx.globalAlpha = alphaBase * (armed ? 1 : 0.7);
      if (spr) blit(ctx, spr, x, y, pulse);
      else {
        ctx.strokeStyle = color.base;
        ctx.lineWidth = Math.max(2, r * 0.16);
        ctx.beginPath();
        ctx.ellipse(x, y, r * pulse, ry * pulse, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      if (!tracking) {
        this.text.draw(ctx, '?', x, y, this.style('receptorQ'), 1, 0.85);
      }
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Notes
  // ---------------------------------------------------------------------------------------------

  private drawNotes(ctx: Ctx2D, frame: RenderFrame): number {
    const g = this.geom;
    const st = this.stNow;
    const buf = this.sortBuf;
    buf.length = 0;
    for (let i = 0; i < frame.notes.length; i++) {
      const n = frame.notes[i];
      if (n.state === 'hit') continue;
      if (n.lane < 0 || n.lane >= g.laneCount) continue;
      const d = depthOf(g, n.time, st);
      if (n.state === 'miss') {
        // Missed gems are culled by fizzle time, not depth (they decelerate while dying, see below).
        if (d > g.maxDepth) continue;
        let seenAt = this.missT0.get(n.id);
        if (seenAt === undefined) {
          // Defensive: processHits registers the fizzle clock for every miss it sees, so this only
          // fires for a miss handed to us long after its note time (outside the judgment window).
          seenAt = st;
          this.missT0.set(n.id, st);
        }
        if (st - seenAt >= MISS_FIZZLE_SEC) continue;
      } else if (!isVisibleDepth(g, d)) continue;
      buf.push(n);
    }
    // Far notes first so nearer gems overlap them.
    buf.sort(byTimeDesc);
    let drawn = 0;
    for (let i = 0; i < buf.length; i++) {
      const n = buf[i];
      const d = depthOf(g, n.time, st);
      const p = project(g, n.lane, d);
      const missed = n.state === 'miss';
      const color = missed ? this.palette.miss : laneColor(this.palette, n.lane);
      let alpha = 1;
      let radius = p.radius;
      let y = p.y;
      if (missed) {
        // Fizzle driven by time since the engine declared the miss (first frame we saw the event),
        // not by depth — the verdict can arrive up to ~280 ms after the note time. The gem greys,
        // shrinks, fades and decelerates (it only keeps 35% of its scroll motion) so the whole
        // fizzle happens in view instead of below the canvas edge.
        const seenAt = this.missT0.get(n.id) ?? st;
        const k = clamp((st - seenAt) / MISS_FIZZLE_SEC, 0, 1);
        const dSeen = depthOf(g, n.time, seenAt);
        const ySeen = yAt(g, dSeen);
        y = ySeen + (p.y - ySeen) * 0.35 + k * g.gemRadiusNear * 0.4;
        alpha = (1 - k) * 0.75;
        // Shrink from the size it had when the miss was declared. Below the strike line the
        // perspective tail *magnifies* gems, so scaling the live radius made a dying gem the
        // biggest thing on the board — the opposite of a fizzle.
        const rSeen = g.gemRadiusNear * scaleAt(g, dSeen);
        radius = (rSeen + (p.radius - rSeen) * 0.35) * (1 - k * 0.5);
      } else if (d < 0) {
        // Pending gem past the line: keep full colour (a late hit may still land) but dim gently
        // toward the bottom so it reads as "getting away".
        alpha = 1 - 0.3 * clamp(d / g.minDepth, 0, 1);
      }
      // Fade in from the horizon.
      if (d > 0.85) alpha *= clamp((1.02 - d) / 0.17, 0, 1);
      if (alpha <= 0.01) continue;
      // `gemSprite` + `bucketedRadius` rather than `gem()`: no result object per note per frame.
      const gem = this.sprites.gemSprite(color, radius);
      ctx.globalAlpha = alpha;
      if (gem) {
        blit(ctx, gem, p.x, y, radius / this.sprites.bucketedRadius(radius));
      } else {
        ctx.fillStyle = color.base;
        ctx.beginPath();
        ctx.ellipse(p.x, y, radius, radius * GEM_ASPECT, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      drawn++;
    }
    ctx.globalAlpha = 1;
    return drawn;
  }

  // ---------------------------------------------------------------------------------------------
  // Hit processing → particles, flashes, popups
  // ---------------------------------------------------------------------------------------------

  /**
   * Turn one judgment into feedback: lane flash / red tint, particles, judgment popup, fizzle clock.
   * Called at most once per note id (see `seenHits`), from either of the two paths in `processHits`.
   */
  private applyJudgment(noteId: number, lane: number, judgment: Judgment, noteTime: number, st: number): void {
    const g = this.geom;
    this.seenHits.set(noteId, st);
    if (judgment === 'miss' && !this.missT0.has(noteId)) this.missT0.set(noteId, st);
    if (lane < 0 || lane >= g.laneCount) return;
    const x = laneX(g, lane, 0);
    const y = g.strikeY;
    const eff = this.eff;
    this.laneFlashT0[lane] = st;
    if (judgment === 'miss') {
      this.laneFlashKind[lane] = 2;
      // Grey puff where the gem currently is, so the fizzle is attached to the gem rather than to
      // the receptor. Count scales with effectIntensity but never to zero — the puff plus the red
      // lane tint plus the greying gem are the three miss cues and none of them may go missing.
      const d = depthOf(g, noteTime, st);
      const p = project(g, lane, clamp(d, g.minDepth, 1));
      const puffs = Math.max(2, Math.round(6 * eff));
      for (let k = 0; k < puffs; k++) {
        const ang = -Math.PI / 2 + (this.rng() - 0.5) * 2.4;
        const speed = p.radius * (1.5 + this.rng() * 2);
        this.particles.emit({
          x: p.x + (this.rng() - 0.5) * p.radius,
          y: p.y,
          vx: Math.cos(ang) * speed,
          vy: Math.sin(ang) * speed,
          life: 0.35 + this.rng() * 0.2,
          size: p.radius * 0.35,
          endSize: p.radius * 0.9,
          color: MISS_COLOR_INDEX,
          alpha: 0.35,
          drag: 2,
          kind: PARTICLE_SPARK,
        });
      }
      if (!this.opts.showMissPopup) return;
    } else {
      this.laneFlashKind[lane] = 1;
      const intensity = (judgment === 'perfect' ? 1.25 : 0.8) * eff;
      if (intensity > 0.02) {
        emitHitBurst(this.particles, this.rng, x, y, g.gemRadiusNear, lane, intensity);
      } else {
        // Calmest setting: the shockwave ring alone (still an unmistakable "you hit it").
        this.particles.emit({ x, y, life: 0.32, size: g.gemRadiusNear * 0.8, endSize: g.gemRadiusNear * 2.6, color: lane, alpha: 0.9, kind: PARTICLE_RING });
      }
      if (judgment === 'perfect' && eff > 0.02) {
        // Brief white core flash for perfects (small enough to leave the receptor readable).
        this.particles.emit({ x, y, life: 0.14, size: g.gemRadiusNear * 0.7, endSize: g.gemRadiusNear * 0.25, color: WHITE_COLOR_INDEX, kind: PARTICLE_SPARK, alpha: 0.7 });
      }
    }
    this.spawnPopup(judgment, lane, x, y, st);
  }

  /**
   * Claim a popup slot. Slots are a shared ring rather than one per lane, so a second hit on the
   * same lane inside the 0.75 s popup lifetime (8th notes at 120 BPM are 250 ms apart) no longer
   * cancels the first popup mid-flight; overlapping popups in one lane are stacked upward instead.
   *
   * The stack — and the rise applied in `drawPopups` — are capped at `POPUP_MAX_RISE_FRAC` of the
   * board height above the strike line, which at every resolution is well under a quarter second of
   * approach time. Clone Hero keeps its judgment text small and near the fret; a popup that flies
   * half way up the board in 50 px italics is decoration sitting on the one thing a rehab patient
   * has to see, and popups are drawn beneath the gems for the same reason.
   */
  private spawnPopup(judgment: Judgment, lane: number, x: number, y: number, st: number): void {
    const g = this.geom;
    let slot = -1;
    let oldest = 0;
    let stack = 0;
    for (let i = 0; i < this.popups.length; i++) {
      const p = this.popups[i];
      if (!p.active) {
        if (slot < 0) slot = i;
        continue;
      }
      if (p.lane === lane && st - p.t0 < POPUP_SEC * 0.55) stack++;
      if (this.popups[oldest].active && p.t0 < this.popups[oldest].t0) oldest = i;
    }
    if (slot < 0) slot = oldest;
    const p = this.popups[slot];
    p.active = true;
    p.judgment = judgment;
    p.t0 = st;
    p.lane = lane;
    p.x = x;
    const R = g.receptorRadius;
    const cap = (g.strikeY - g.horizonY) * POPUP_MAX_RISE_FRAC;
    p.y = y - Math.min(R * POPUP_BASE_R + Math.min(stack, 2) * R * POPUP_STACK_R, cap);
  }

  private processHits(frame: RenderFrame): void {
    const g = this.geom;
    const st = this.stNow;
    // 1. Judgment events from the engine. `time` is the judgment time and `deltaMs` the timing
    //    error, so the note's own time is time - deltaMs/1000 (matches src/engine/judge.ts).
    const hits = frame.recentHits;
    for (let i = 0; i < hits.length; i++) {
      const e = hits[i];
      if (this.seenHits.has(e.noteId)) continue;
      this.applyJudgment(e.noteId, e.lane, e.judgment, e.time - e.deltaMs / 1000, st);
    }
    // 2. Fallback for the (documented, and common) integration shape where a note's `state` is
    //    flipped to hit/miss on the frame the verdict lands and the matching HitEvent only shows up
    //    in `recentHits` on a later frame — or never, for integrators that drive the renderer from
    //    note state alone. Whichever path gets there first produces the feedback; the other is
    //    de-duped by `seenHits`, so every judgment is drawn exactly once and none is dropped.
    const notes = frame.notes;
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      if (n.state === 'pending') continue;
      if (this.seenHits.has(n.id)) continue;
      const age = st - n.time;
      // Only a *fresh* verdict counts: a stale hit/miss note left in the frame long after its time
      // must not re-fire effects once its de-dupe entry has been pruned.
      if (age < -STATE_JUDGMENT_EARLY_SEC || age > STATE_JUDGMENT_LATE_SEC) continue;
      const judgment: Judgment = n.state === 'miss' ? 'miss' : n.judgment === 'perfect' ? 'perfect' : 'good';
      this.applyJudgment(n.id, n.lane, judgment, n.time, st);
    }
    // Prune both maps every frame: entries older than the visible window (so a note can never be
    // culled, forgotten and then resurrected while still on screen) or from the future (restart).
    // `forEach` over the map does not allocate an entry array per element the way `for..of` does.
    this.pruneNow = st;
    this.pruneKeep = Math.max(3, g.approachSec + 1);
    this.seenHits.forEach(this.pruneSeen);
    this.missT0.forEach(this.pruneMiss);
  }

  private readonly pruneSeen = (t: number, id: number): void => {
    if (this.pruneNow - t > this.pruneKeep || t > this.pruneNow + 1) this.seenHits.delete(id);
  };

  private readonly pruneMiss = (t: number, id: number): void => {
    if (this.pruneNow - t > this.pruneKeep || t > this.pruneNow + 1) this.missT0.delete(id);
  };

  /**
   * Colours for a particle colour index. Fills (and returns) a scratch object rather than a fresh
   * one — it is called once per colour batch per frame and the result is consumed immediately.
   */
  private readonly pcolor = { base: '#ffffff', glow: '#ffffff' };

  private particleColor(index: number): { base: string; glow: string } {
    const out = this.pcolor;
    if (index === WHITE_COLOR_INDEX) {
      out.base = '#ffffff';
      out.glow = '#ffffff';
    } else if (index === MISS_COLOR_INDEX) {
      out.base = this.palette.miss.base;
      out.glow = this.palette.miss.glow;
    } else {
      const c = laneColor(this.palette, index);
      out.base = c.bright;
      out.glow = c.glow;
    }
    return out;
  }

  private drawParticles(ctx: Ctx2D): void {
    const pool = this.particles;
    const n = pool.count;
    if (n === 0) return;
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    // Batch by colour index so strokes/fills share style (preallocated scratch, no per-frame array).
    const seen = this.colorBatch;
    let seenN = 0;
    for (let i = 0; i < n && seenN < seen.length; i++) {
      const c = pool.color[i];
      let found = false;
      for (let j = 0; j < seenN; j++) {
        if (seen[j] === c) {
          found = true;
          break;
        }
      }
      if (!found) seen[seenN++] = c;
    }
    for (let ci = 0; ci < seenN; ci++) {
      const cidx = seen[ci];
      const col = this.particleColor(cidx);
      const glowSprite = this.sprites.glow(col.glow, 32);
      // Sparks (sprite blits)
      for (let i = 0; i < n; i++) {
        if (pool.color[i] !== cidx || pool.kind[i] !== PARTICLE_SPARK) continue;
        const size = pool.sizeAt(i);
        if (size <= 0.2) continue;
        ctx.globalAlpha = pool.alphaAt(i);
        if (glowSprite) blit(ctx, glowSprite, pool.x[i], pool.y[i], (size * 2.6) / 32);
        else {
          ctx.fillStyle = col.base;
          ctx.beginPath();
          ctx.arc(pool.x[i], pool.y[i], size, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      // Streaks. Grouped into a few alpha bands: each band is one path + one stroke, so streaks
      // actually fade out over their life (a single fixed-alpha batch made them burn at constant
      // brightness and then pop out of existence, which reads as a glitch next to the fading
      // sparks and rings) while the draw count stays bounded by the band count, not the particle count.
      ctx.strokeStyle = col.base;
      ctx.lineWidth = Math.max(1, this.geom.gemRadiusNear * 0.09);
      for (let band = STREAK_ALPHA_BANDS; band >= 1; band--) {
        const lo = (band - 1) / STREAK_ALPHA_BANDS;
        const hi = band / STREAK_ALPHA_BANDS;
        let anyStreak = false;
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
          if (pool.color[i] !== cidx || pool.kind[i] !== PARTICLE_STREAK) continue;
          const a = pool.alphaAt(i);
          if (a <= 0.02 || a <= lo || a > hi) continue;
          const len = 0.035;
          ctx.moveTo(pool.x[i], pool.y[i]);
          ctx.lineTo(pool.x[i] - pool.vx[i] * len, pool.y[i] - pool.vy[i] * len);
          anyStreak = true;
        }
        if (anyStreak) {
          ctx.globalAlpha = hi * 0.85;
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
      // Rings (shockwaves)
      for (let i = 0; i < n; i++) {
        if (pool.color[i] !== cidx || pool.kind[i] !== PARTICLE_RING) continue;
        const t = pool.progress(i);
        const size = pool.sizeAt(i);
        ctx.globalAlpha = pool.alpha[i] * (1 - t);
        ctx.strokeStyle = col.base;
        ctx.lineWidth = Math.max(1, size * 0.18 * (1 - t) + 1);
        ctx.beginPath();
        ctx.ellipse(pool.x[i], pool.y[i], size, size * GEM_ASPECT, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  private drawPopups(ctx: Ctx2D, st: number): void {
    const dur = POPUP_SEC;
    const still = this.opts.reducedMotion;
    const g = this.geom;
    const cap = (g.strikeY - g.horizonY) * POPUP_MAX_RISE_FRAC;
    for (let i = 0; i < this.popups.length; i++) {
      const p = this.popups[i];
      if (!p.active) continue;
      const age = st - p.t0;
      // A tiny negative age is clock jitter on the frame the popup was created (see laneFlashT0).
      if (age < -0.05 || age > dur) {
        p.active = false;
        continue;
      }
      const t = clamp(age, 0, dur) / dur;
      const rise = easeOutCubic(t) * g.receptorRadius * POPUP_RISE_R * (still ? 0.35 : 1);
      // Hard cap on anchor + rise together: a popup never climbs further than POPUP_MAX_RISE_FRAC of
      // the board above the strike line, at any resolution, however many are stacked.
      const above = Math.min(g.strikeY - p.y + rise, cap);
      // Pop: overshoot then settle.
      const pop = still ? 1 : age < 0.12 ? 0.7 + (age / 0.12) * 0.5 : age < 0.22 ? 1.2 - ((age - 0.12) / 0.1) * 0.2 : 1;
      const alpha = t < 0.6 ? 1 : 1 - (t - 0.6) / 0.4;
      const style = this.style(p.judgment === 'perfect' ? 'popupPerfect' : p.judgment === 'good' ? 'popupGood' : 'popupMiss');
      this.text.draw(ctx, JUDGMENT_STYLE[p.judgment].text, p.x, g.strikeY - above, style, pop, alpha);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // HUD
  // ---------------------------------------------------------------------------------------------

  private styleCache = new Map<string, TextStyle>();
  private styleU = -1;
  private styleLaneW = -1;

  private style(name: string): TextStyle {
    if (this.styleU !== this.u || this.styleLaneW !== this.geom.laneWidthNear) {
      this.styleCache.clear();
      this.styleU = this.u;
      this.styleLaneW = this.geom.laneWidthNear;
    }
    let s = this.styleCache.get(name);
    if (s) return s;
    const u = this.u;
    const px = (n: number) => Math.round(n * u);
    switch (name) {
      // Popup text is deliberately small (Clone Hero scale, not a splash screen): it sits just
      // above the fret, inside the note approach path, so it must not be a billboard.
      case 'popupPerfect':
        s = { font: `italic 900 ${px(22)}px ${FONT}`, color: JUDGMENT_STYLE.perfect.color, stroke: JUDGMENT_STYLE.perfect.stroke, strokeWidth: px(2), glow: JUDGMENT_STYLE.perfect.glow, glowBlur: px(9) };
        break;
      case 'popupGood':
        s = { font: `italic 900 ${px(22)}px ${FONT}`, color: JUDGMENT_STYLE.good.color, stroke: JUDGMENT_STYLE.good.stroke, strokeWidth: px(2), glow: JUDGMENT_STYLE.good.glow, glowBlur: px(9) };
        break;
      case 'popupMiss':
        s = { font: `italic 700 ${px(17)}px ${FONT}`, color: JUDGMENT_STYLE.miss.color, stroke: JUDGMENT_STYLE.miss.stroke, strokeWidth: px(2), glow: JUDGMENT_STYLE.miss.glow, glowBlur: px(5) };
        break;
      case 'combo':
        s = { font: `italic 900 ${px(56)}px ${FONT}`, color: '#ffffff', stroke: 'rgba(0,0,0,0.6)', strokeWidth: px(3), glow: '#8fb4ff', glowBlur: px(16) };
        break;
      case 'comboLabel':
        s = { font: `700 ${px(15)}px ${FONT}`, color: UI_COLORS.textDim, stroke: 'rgba(0,0,0,0.5)', strokeWidth: px(2) };
        break;
      case 'hudLabel':
        s = { font: `700 ${px(14)}px ${FONT}`, color: UI_COLORS.textDim };
        break;
      case 'score':
        s = { font: `800 ${px(36)}px ${FONT}`, color: UI_COLORS.text, glow: '#7fa0ff', glowBlur: px(10) };
        break;
      case 'title':
        s = { font: `700 ${px(20)}px ${FONT}`, color: UI_COLORS.text };
        break;
      case 'attribution':
        s = { font: `400 ${px(12)}px ${FONT}`, color: UI_COLORS.textDim };
        break;
      case 'mult':
        s = { font: `italic 900 ${px(30)}px ${FONT}`, color: '#ffffff', stroke: 'rgba(0,0,0,0.5)', strokeWidth: px(2) };
        break;
      case 'receptorQ':
        s = { font: `900 ${px(20)}px ${FONT}`, color: '#ffffff', stroke: '#000000', strokeWidth: px(2) };
        break;
      case 'stats':
        s = { font: `${px(12)}px ui-monospace, Menlo, Consolas, monospace`, color: '#9cffb0' };
        break;
      default: {
        // laneLabel:<hex>
        const color = name.startsWith('laneLabel:') ? name.slice('laneLabel:'.length) : UI_COLORS.text;
        const lw = this.geom.laneWidthNear;
        const fs = clamp(Math.round(lw * 0.14), 11, Math.round(22 * Math.max(1, u)));
        s = { font: `700 ${fs}px ${FONT}`, color, stroke: 'rgba(0,0,0,0.75)', strokeWidth: Math.max(1, Math.round(fs * 0.12)) };
      }
    }
    this.styleCache.set(name, s);
    return s;
  }

  /**
   * Combo counter. Lives in the right side panel (opposite the rock meter), off the note path so
   * judgment popups never draw through it. When the side panel is too narrow (portrait / 4 lanes
   * on a narrow canvas) it moves to the top centre above the horizon.
   */
  private drawCombo(ctx: Ctx2D, frame: RenderFrame, st: number): void {
    const g = this.geom;
    const u = this.u;
    const combo = Number.isFinite(frame.combo) ? Math.max(0, Math.floor(frame.combo)) : 0;
    if (combo > this.lastCombo) this.comboBounceT0 = st;
    if (combo === 0 && this.lastCombo > 0) this.comboBreakT0 = st;
    this.lastCombo = combo;
    const rightEdge = roadEdgeX(g, 1, 0);
    const panelW = this.width - rightEdge;
    let x: number;
    let y: number;
    if (panelW >= 110 * u) {
      x = rightEdge + panelW / 2;
      y = g.strikeY - g.receptorRadius * 2.2;
    } else {
      x = g.vpX;
      y = Math.max(52 * u, g.horizonY - 40 * u);
    }
    const heat = clamp(combo / 50, 0, 1);
    const labelDy = 34 * u * (1 + heat * 0.2);
    const still = this.opts.reducedMotion;
    if (combo >= 2) {
      const age = st - this.comboBounceT0;
      const bounce = !still && age >= 0 && age < 0.25 ? Math.pow(1 - age / 0.25, 2) : 0;
      const scale = (1 + bounce * 0.35) * (1 + heat * 0.2);
      // Per-character sprites: the combo value changes constantly, so a whole-string sprite would
      // rasterize (and cache) a new ~350 KB canvas on every increment.
      this.text.drawChars(ctx, String(combo), x, y, this.style('combo'), scale, 0.95);
      this.text.draw(ctx, 'COMBO', x, y + labelDy, this.style('comboLabel'), 1, 0.9);
    } else {
      const age = st - this.comboBreakT0;
      if (age >= 0 && age < 0.5) {
        // Combo break: brief shake-out.
        const k = 1 - age / 0.5;
        const dx = still ? 0 : Math.sin(age * 60) * 6 * u * k;
        this.text.drawChars(ctx, String(this.lastComboShown), x + dx, y, this.style('combo'), 1, k * 0.5);
      }
    }
    if (combo >= 2) this.lastComboShown = combo;
  }

  private drawHud(ctx: Ctx2D, frame: RenderFrame, dt: number, beatPulse: number): void {
    const W = this.width;
    const H = this.height;
    const u = this.u;
    const g = this.geom;
    const pad = 16 * u;

    // Score (top-right, rolling digits). A non-finite score (or a display value that somehow went
    // non-finite) snaps rather than sticking there for the rest of the song.
    const target = Number.isFinite(frame.score) ? Math.max(0, frame.score) : 0;
    if (!Number.isFinite(this.displayScore)) this.displayScore = target;
    if (Math.abs(target - this.displayScore) < 0.5) this.displayScore = target;
    else this.displayScore += (target - this.displayScore) * clamp(dt * 9, 0, 1);
    const scoreStyle = this.style('score');
    this.text.draw(ctx, 'SCORE', W - pad, pad + 8 * u, this.style('hudLabel'), 1, 1, 'right');
    this.digits.draw(ctx, this.displayScore, W - pad, pad + 38 * u, scoreStyle, 6, this.dpr);

    // Song title / attribution (top-left)
    if (frame.songTitle) this.text.draw(ctx, frame.songTitle, pad, pad + 10 * u, this.style('title'), 1, 1, 'left');
    if (frame.attribution) this.text.draw(ctx, frame.attribution, pad, pad + 32 * u, this.style('attribution'), 1, 1, 'left');

    // Rock meter (left, arc gauge)
    const health = clamp(frame.health, 0, 1);
    if (!Number.isFinite(this.healthSmooth)) this.healthSmooth = health;
    this.healthSmooth += (health - this.healthSmooth) * clamp(dt * 6, 0, 1);
    const hv = this.healthSmooth;
    // Size the gauge from the free space left of the road at the strike line; keep it clear of the road edge.
    const leftPanelW = Math.max(0, roadEdgeX(g, -1, 0));
    const gaugeR = clamp(Math.min(leftPanelW * 0.3, H * 0.1, 90 * u), 18, 140);
    const gx = Math.max(gaugeR * 1.25 + pad, leftPanelW * 0.45);
    const gy = g.strikeY - gaugeR * 1.1;
    const a0 = Math.PI * 0.75;
    const a1 = Math.PI * 2.25;
    ctx.lineCap = 'round';
    ctx.lineWidth = gaugeR * 0.22;
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.beginPath();
    ctx.arc(gx, gy, gaugeR, a0, a1);
    ctx.stroke();
    const hcol = hv < 0.5 ? mixHex(ROCK_METER_COLORS.low, ROCK_METER_COLORS.mid, hv * 2) : mixHex(ROCK_METER_COLORS.mid, ROCK_METER_COLORS.high, (hv - 0.5) * 2);
    const danger = hv < 0.3 ? (this.opts.reducedMotion ? 0.5 : 0.5 + 0.5 * Math.sin(this.stNow * 10)) : 0;
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = clamp(0.25 + beatPulse * 0.2 + danger * 0.3, 0, 1);
    ctx.strokeStyle = hcol;
    ctx.lineWidth = gaugeR * 0.34;
    ctx.beginPath();
    ctx.arc(gx, gy, gaugeR, a0, a0 + (a1 - a0) * hv);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = hcol;
    ctx.lineWidth = gaugeR * 0.2;
    ctx.beginPath();
    ctx.arc(gx, gy, gaugeR, a0, a0 + (a1 - a0) * Math.max(0.001, hv));
    ctx.stroke();
    // Needle: pivots at the hub and sweeps *inside* the arc like a real gauge.
    const na = a0 + (a1 - a0) * hv;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = Math.max(2, gaugeR * 0.07);
    ctx.beginPath();
    ctx.moveTo(gx, gy);
    ctx.lineTo(gx + Math.cos(na) * gaugeR * 0.82, gy + Math.sin(na) * gaugeR * 0.82);
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(gx, gy, gaugeR * 0.12, 0, Math.PI * 2);
    ctx.fill();
    // Label in the arc's bottom gap.
    this.text.draw(ctx, 'ROCK', gx, gy + gaugeR * 0.95, this.style('hudLabel'), 1, 0.9);

    // Multiplier badge under the gauge
    const mult = Math.max(1, Math.floor(frame.multiplier));
    if (mult !== this.lastMultiplier) {
      this.multiplierPopT0 = this.stNow;
      this.lastMultiplier = mult;
    }
    const tier = multiplierTier(mult);
    const popAge = this.stNow - this.multiplierPopT0;
    const pop = !this.opts.reducedMotion && popAge >= 0 && popAge < 0.3 ? 1 + 0.4 * Math.pow(1 - popAge / 0.3, 2) : 1;
    const bw = gaugeR * 1.5 * pop;
    const bh = gaugeR * 0.75 * pop;
    const bx = gx - bw / 2;
    const by = gy + gaugeR * 1.3;
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = clamp(0.25 + beatPulse * 0.25 * (mult - 1), 0, 1);
    ctx.fillStyle = tier.glow;
    roundRectPath(ctx, bx - 6 * u, by - 6 * u, bw + 12 * u, bh + 12 * u, bh * 0.5);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = this.grad(BADGE_KEYS[Math.min(mult, 4) - 1], () => {
      const bg = ctx.createLinearGradient(0, by, 0, by + gaugeR * 0.75);
      bg.addColorStop(0, tier.color);
      bg.addColorStop(1, mixHex(tier.color, '#000000', 0.45));
      return bg;
    });
    roundRectPath(ctx, bx, by, bw, bh, bh * 0.35);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = Math.max(1, 2 * u);
    ctx.stroke();
    this.text.draw(ctx, tier.label, gx, by + bh / 2, this.style('mult'), (bh / (40 * u)) * 1.0, 1);
  }

  /**
   * Style-cache keys for the lane labels, built once per palette instead of interpolated every
   * frame (four template strings per frame is the kind of steady garbage this renderer avoids).
   * Index 0 = tracking (lane colour), index 1 = lost tracking (grey).
   */
  private labelKeys: string[][] = [];
  private labelKeyPalette = '';

  private laneLabelKey(lane: number, tracking: boolean): string {
    if (this.labelKeyPalette !== this.palette.name) {
      this.labelKeys.length = 0;
      for (let i = 0; i < MAX_LANES; i++) this.labelKeys.push([`laneLabel:${laneColor(this.palette, i).bright}`, 'laneLabel:#9a9aa0']);
      this.labelKeyPalette = this.palette.name;
    }
    return this.labelKeys[lane][tracking ? 0 : 1];
  }

  /**
   * Fitted lane labels. Recomputed only when the lanes or the layout change (never per frame): a
   * label is measured against the lane pitch and, when the labels are too wide for it, the rows are
   * staggered (odd lanes drop one line) so each label gets nearly two lane widths before anything
   * is ellipsized. Without this, four lanes on a 400 px-wide portrait canvas give a 46 px lane and
   * an 11 px font floor, i.e. "L knee lift" running straight through both neighbours.
   */
  private labelText: string[] = [];
  private labelMovement: string[] = [];
  private labelSide: string[] = [];
  private labelStagger = false;
  private labelRowH = 0;
  private labelU = -1;
  private labelLaneW = -1;

  private ensureLabels(frame: RenderFrame): void {
    const g = this.geom;
    let ok = this.labelText.length === g.laneCount && this.labelU === this.u && this.labelLaneW === g.laneWidthNear;
    if (ok) {
      for (let lane = 0; lane < g.laneCount; lane++) {
        const spec = frame.lanes[lane];
        if (!spec || this.labelMovement[lane] !== spec.movement || this.labelSide[lane] !== spec.side) {
          ok = false;
          break;
        }
      }
    }
    if (ok) return;
    const style = this.style(this.laneLabelKey(0, true));
    const pitch = g.laneWidthNear;
    this.labelText.length = 0;
    this.labelMovement.length = 0;
    this.labelSide.length = 0;
    let widest = 0;
    for (let lane = 0; lane < g.laneCount; lane++) {
      const spec = frame.lanes[lane];
      const raw = spec ? movementLabel(spec.movement, spec.side) : '';
      this.labelText.push(raw);
      this.labelMovement.push(spec ? spec.movement : '');
      this.labelSide.push(spec ? spec.side : '');
      widest = Math.max(widest, this.text.measure(raw, style));
    }
    // One row while everything fits inside its lane; two staggered rows otherwise (labels on the
    // same row are then two lanes apart, so they may be up to ~1.9 lane widths wide).
    this.labelStagger = widest > pitch * 0.96 && g.laneCount > 1;
    const allowed = this.labelStagger ? pitch * 1.9 : pitch * 0.96;
    for (let lane = 0; lane < g.laneCount; lane++) {
      this.labelText[lane] = this.text.fit(this.labelText[lane], style, allowed);
    }
    this.labelRowH = fontPx(style.font) * 1.15;
    this.labelU = this.u;
    this.labelLaneW = g.laneWidthNear;
  }

  private drawLabels(ctx: Ctx2D, frame: RenderFrame): void {
    const g = this.geom;
    this.ensureLabels(frame);
    const y = g.strikeY + g.receptorRadius * GEM_ASPECT + 22 * this.u;
    const rowH = this.labelRowH;
    for (let lane = 0; lane < g.laneCount; lane++) {
      const label = this.labelText[lane];
      if (!label) continue;
      const ls = frame.laneStates[lane];
      const tracking = ls ? ls.tracking !== false : true;
      const x = laneX(g, lane, -0.02);
      const row = this.labelStagger ? lane % 2 : 0;
      this.text.draw(ctx, label, x, y + row * rowH, this.style(this.laneLabelKey(lane, tracking)), 1, tracking ? 1 : 0.6);
    }
  }

  private drawStats(ctx: Ctx2D): void {
    const s = this.stats;
    const txt = `draw ${s.drawMs.toFixed(2)}ms avg ${s.avgDrawMs.toFixed(2)} max ${s.maxDrawMs.toFixed(1)} | frame ${s.avgFrameMs.toFixed(1)}ms (${s.fps.toFixed(0)} fps, ${s.longFrames} long) | notes ${s.notesDrawn} | particles ${s.particles} | sprites ${s.sprites} | ${this.width}x${this.height}@${this.dpr}`;
    const st = this.style('stats');
    ctx.save();
    ctx.font = st.font;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    const w = txt.length * 7.2 * this.u + 16;
    ctx.fillRect(this.width - w - 8, this.height - 26 * this.u, w, 22 * this.u);
    ctx.fillStyle = st.color;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(txt, this.width - 16, this.height - 15 * this.u);
    ctx.restore();
  }
}

/** Convenience: build a RenderFrame with sensible defaults (useful for tests and demos). */
export function makeFrame(partial: Partial<RenderFrame> & Pick<RenderFrame, 'lanes'>): RenderFrame {
  const lanes = partial.lanes;
  return {
    songTime: 0,
    notes: [],
    laneStates: lanes.map(() => ({ value: 0, armed: true, tracking: true })),
    combo: 0,
    multiplier: 1,
    score: 0,
    health: 0.5,
    recentHits: [],
    bpm: 120,
    beatPhase: 0,
    ...partial,
  };
}
