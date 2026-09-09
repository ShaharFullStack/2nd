/**
 * Guitar-Hero style note highway renderer. Canvas 2D, DPR aware, no React, no per-frame
 * allocation on the hot path (sprites, text and particles are all cached / pooled).
 *
 * Usage:
 *   const hw = new Highway(canvas);           // canvas: HTMLCanvasElement or OffscreenCanvas
 *   hw.resize();                              // on mount + window resize (reads clientWidth/Height + DPR)
 *   requestAnimationFrame(() => hw.draw(frame));
 *
 * `draw(frame)` is a pure function of the RenderFrame plus a little internal animation state
 * (particles, popups, rolling score). It never mutates the frame.
 */
import type { Judgment } from '../engine/types';
import {
  beatLineTimes,
  clamp,
  depthAtY,
  depthOf,
  isVisibleDepth,
  laneBoundaryX,
  laneX,
  makeGeometry,
  project,
  roadEdgeX,
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
import { DigitRoller, TextCache, defaultCanvasFactory, type Ctx2D, type TextStyle } from './text';
import type { CanvasLike, HighwayOptions, RenderFrame, RenderNote, RenderStats } from './types';

export const DEFAULT_HIGHWAY_OPTIONS: HighwayOptions = {
  approachSec: 1.6,
  horizonY: 0.35,
  strikeY: 0.82,
  farScale: 0.28,
  roadWidth: 0.6,
  highContrast: false,
  showLabels: true,
  showStats: false,
  maxParticles: 600,
};

const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const WHITE_COLOR_INDEX = 250;
const MISS_COLOR_INDEX = 251;

interface Popup {
  active: boolean;
  judgment: Judgment;
  t0: number;
  x: number;
  y: number;
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

export class Highway {
  readonly canvas: CanvasLike;
  private ctx: Ctx2D | null;
  private opts: HighwayOptions;
  private geom: HighwayGeometry;
  private width = 1;
  private height = 1;
  private dpr = 1;
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

  // Effect state.
  private seenHits = new Map<number, number>();
  private laneFlashT0 = new Float32Array(8).fill(-10);
  private laneFlashKind = new Uint8Array(8); // 0 none, 1 hit, 2 miss
  private laneGlow = new Float32Array(8);
  private popups: Popup[] = [];
  private lastCombo = 0;
  private lastComboShown = 0;
  private comboBounceT0 = -10;
  private comboBreakT0 = -10;
  private lastMultiplier = 1;
  private multiplierPopT0 = -10;
  private displayScore = 0;
  private healthSmooth = 1;
  private lastSongTime: number | null = null;
  private sortBuf: RenderNote[] = [];

  private stats: RenderStats = { drawMs: 0, avgDrawMs: 0, maxDrawMs: 0, frames: 0, notesDrawn: 0, particles: 0, sprites: 0 };

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
    for (let i = 0; i < 8; i++) this.popups.push({ active: false, judgment: 'good', t0: 0, x: 0, y: 0 });
    this.resize();
  }

  /** Current geometry (rebuilt on resize / lane-count change). */
  get geometry(): HighwayGeometry {
    return this.geom;
  }

  get options(): Readonly<HighwayOptions> {
    return this.opts;
  }

  /** Update tunables at runtime (palette, approach speed, ...). */
  setOptions(patch: Partial<HighwayOptions>): void {
    this.opts = { ...this.opts, ...patch };
    this.palette = getPalette(this.opts.highContrast);
    this.sprites.clear();
    this.text.clear();
    this.rebuildGeometry(this.geom.laneCount);
  }

  getStats(): RenderStats {
    return { ...this.stats };
  }

  resetStats(): void {
    this.stats.avgDrawMs = 0;
    this.stats.maxDrawMs = 0;
  }

  /**
   * Resize the backing store. With no arguments, reads clientWidth/clientHeight (HTMLCanvasElement)
   * or the canvas' current width/height, and window.devicePixelRatio.
   */
  resize(width?: number, height?: number, dpr?: number): void {
    const c = this.canvas as CanvasLike & { clientWidth?: number; clientHeight?: number };
    const ratio = dpr ?? (typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 1);
    let w = width;
    let h = height;
    if (w === undefined || h === undefined) {
      if (typeof c.clientWidth === 'number' && c.clientWidth > 0 && typeof c.clientHeight === 'number' && c.clientHeight > 0) {
        w = c.clientWidth;
        h = c.clientHeight;
      } else {
        w = Math.max(1, c.width / this.dpr);
        h = Math.max(1, c.height / this.dpr);
      }
    }
    this.width = Math.max(1, Math.floor(w));
    this.height = Math.max(1, Math.floor(h));
    this.dpr = clamp(ratio, 0.5, 4);
    const bw = Math.round(this.width * this.dpr);
    const bh = Math.round(this.height * this.dpr);
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

  // ---------------------------------------------------------------------------------------------
  // Frame
  // ---------------------------------------------------------------------------------------------

  draw(frame: RenderFrame): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t0 = now();
    const laneCount = clamp(frame.lanes.length || 4, 1, 8);
    if (laneCount !== this.geom.laneCount) this.rebuildGeometry(laneCount);

    const st = frame.songTime;
    const dt = this.lastSongTime === null ? 0 : clamp(st - this.lastSongTime, 0, 0.1);
    this.lastSongTime = st;
    const energy = clamp(frame.energy ?? 0, 0, 1);
    const mult = clamp(frame.multiplier, 1, 8);
    const beat = clamp(frame.beatPhase, 0, 1);
    const beatPulse = Math.pow(1 - beat, 3); // 1 on the beat, decays quickly

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

    this.drawBackground(ctx, frame, energy, mult, beatPulse);
    this.drawRoad(ctx, frame, mult, beatPulse, energy);
    this.drawLaneFlashes(ctx, st);
    this.drawCombo(ctx, frame, st);
    this.drawStrikeLine(ctx, frame, beatPulse);
    this.drawReceptors(ctx, frame, dt, beat);
    this.stats.notesDrawn = this.drawNotes(ctx, frame);
    this.processHits(frame);
    this.particles.update(dt);
    this.drawParticles(ctx);
    this.drawPopups(ctx, st);
    this.drawHud(ctx, frame, dt, beatPulse);
    if (this.opts.showLabels) this.drawLabels(ctx, frame);
    if (this.opts.showStats) this.drawStats(ctx);

    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

    const ms = now() - t0;
    const s = this.stats;
    s.drawMs = ms;
    s.avgDrawMs = s.frames === 0 ? ms : s.avgDrawMs + (ms - s.avgDrawMs) * 0.05;
    if (ms > s.maxDrawMs) s.maxDrawMs = ms;
    s.frames++;
    s.particles = this.particles.count;
    s.sprites = this.sprites.size + this.text.size;
  }

  // ---------------------------------------------------------------------------------------------
  // Background: gradient, parallax stars, stage lights, side panels
  // ---------------------------------------------------------------------------------------------

  private drawBackground(ctx: Ctx2D, frame: RenderFrame, energy: number, mult: number, beatPulse: number): void {
    const W = this.width;
    const H = this.height;
    if (this.bgLayer) {
      ctx.drawImage(this.bgLayer as unknown as CanvasImageSource, 0, 0, W, H);
    } else {
      ctx.fillStyle = UI_COLORS.background0;
      ctx.fillRect(0, 0, W, H);
    }
    const intensity = 0.55 + (mult - 1) * 0.15 + energy * 0.5;
    // Parallax star layers (wrap horizontally)
    const t = frame.songTime;
    ctx.globalCompositeOperation = 'lighter';
    this.drawStarLayer(ctx, this.starFar, (t * 6) % W, 0.35 * intensity);
    this.drawStarLayer(ctx, this.starNear, (t * 14) % W, 0.5 * intensity);

    // Stage light beams from the top corners / centre, slowly sweeping.
    const beams = 3 + Math.min(3, Math.floor(mult));
    const baseAlpha = (0.035 + (mult - 1) * 0.02 + energy * 0.08) * (0.7 + beatPulse * 0.6);
    for (let i = 0; i < beams; i++) {
      const ox = (W * (i + 0.5)) / beams;
      const sweep = Math.sin(t * 0.6 + i * 1.7) * 0.5;
      const halfW = W * 0.06 * (1 + energy);
      const bx = ox + sweep * W * 0.35;
      const grad = ctx.createLinearGradient(ox, 0, bx, H * 0.8);
      const col = mult >= 4 ? '255,214,90' : mult >= 3 ? '120,170,255' : mult >= 2 ? '110,255,140' : '170,180,255';
      grad.addColorStop(0, `rgba(${col},${(baseAlpha * 1.5).toFixed(3)})`);
      grad.addColorStop(1, `rgba(${col},0)`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(ox - halfW * 0.25, 0);
      ctx.lineTo(ox + halfW * 0.25, 0);
      ctx.lineTo(bx + halfW * 2.2, H * 0.85);
      ctx.lineTo(bx - halfW * 2.2, H * 0.85);
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';

    // Side panels: dark slabs filling the space outside the road, with a beat-pulsing glow band
    // hugging each road edge.
    const g = this.geom;
    const panelTop = g.horizonY + (g.strikeY - g.horizonY) * 0.3;
    const dTop = depthAtY(g, panelTop);
    const yBottom = yAt(g, g.minDepth);
    const glowA = 0.1 + beatPulse * 0.18 + energy * 0.12;
    const tier = multiplierTier(mult);
    const bandW = 26 * this.u;
    for (let side = -1; side <= 1; side += 2) {
      const sd = side as -1 | 1;
      const outerX = sd < 0 ? 0 : W;
      const eTop = roadEdgeX(g, sd, dTop);
      const eBot = roadEdgeX(g, sd, g.minDepth);
      if (Math.abs(outerX - eBot) < 6) continue;
      const lp = ctx.createLinearGradient(0, panelTop, 0, H);
      lp.addColorStop(0, withAlpha(UI_COLORS.panel, 0));
      lp.addColorStop(0.35, withAlpha(UI_COLORS.panel, 0.7));
      lp.addColorStop(1, withAlpha(UI_COLORS.panel, 0.92));
      ctx.fillStyle = lp;
      ctx.beginPath();
      ctx.moveTo(outerX, panelTop);
      ctx.lineTo(eTop, panelTop);
      ctx.lineTo(eBot, yBottom);
      ctx.lineTo(outerX, yBottom);
      ctx.closePath();
      ctx.fill();
      // Glow band just outside the road edge.
      ctx.globalCompositeOperation = 'lighter';
      const sg = ctx.createLinearGradient(0, panelTop, 0, H);
      sg.addColorStop(0, withAlpha(tier.glow, 0));
      sg.addColorStop(0.55, withAlpha(tier.color, glowA));
      sg.addColorStop(1, withAlpha(tier.color, glowA * 0.5));
      ctx.fillStyle = sg;
      ctx.beginPath();
      ctx.moveTo(eTop, panelTop);
      ctx.lineTo(eTop + sd * bandW, panelTop);
      ctx.lineTo(eBot + sd * bandW, yBottom);
      ctx.lineTo(eBot, yBottom);
      ctx.closePath();
      ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  private drawStarLayer(ctx: Ctx2D, tile: CanvasLike | null, offset: number, alpha: number): void {
    if (!tile) return;
    const W = this.width;
    const h = this.height * 0.5;
    ctx.globalAlpha = clamp(alpha, 0, 1);
    const img = tile as unknown as CanvasImageSource;
    const ox = -offset;
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
    const asphalt = ctx.createLinearGradient(0, g.horizonY, 0, H);
    asphalt.addColorStop(0, '#2a2f44');
    asphalt.addColorStop(0.12, UI_COLORS.asphalt0);
    asphalt.addColorStop(1, UI_COLORS.asphalt1);
    ctx.fillStyle = asphalt;
    this.roadPath(ctx);
    ctx.fill();

    // Beat / bar lines
    const lines = beatLineTimes(g, frame.songTime, frame.bpm, frame.beatPhase, 4, frame.beatIndex);
    ctx.lineCap = 'butt';
    for (let pass = 0; pass < 2; pass++) {
      const bar = pass === 1;
      ctx.beginPath();
      let any = false;
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        if (l.bar !== bar) continue;
        const d = depthOf(g, l.time, frame.songTime);
        const y = yAt(g, d);
        ctx.moveTo(roadEdgeX(g, -1, d), y);
        ctx.lineTo(roadEdgeX(g, 1, d), y);
        any = true;
      }
      if (!any) continue;
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
    const fog = ctx.createLinearGradient(0, g.horizonY, 0, g.horizonY + (g.strikeY - g.horizonY) * 0.35);
    fog.addColorStop(0, 'rgba(90,110,200,0.55)');
    fog.addColorStop(1, 'rgba(90,110,200,0)');
    ctx.fillStyle = fog;
    this.roadPath(ctx);
    ctx.fill();

    // Edge rails: wide soft glow + thin bright line, colour by multiplier tier, pulse on beat.
    const tier = multiplierTier(mult);
    const railA = 0.35 + beatPulse * 0.4 + energy * 0.3;
    for (let side = -1; side <= 1; side += 2) {
      const s = side as -1 | 1;
      ctx.beginPath();
      ctx.moveTo(roadEdgeX(g, s, g.minDepth), yAt(g, g.minDepth));
      ctx.lineTo(roadEdgeX(g, s, 1), g.horizonY);
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = withAlpha(tier.glow, railA * 0.45);
      ctx.lineWidth = 9 * this.u;
      ctx.stroke();
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = withAlpha(mult >= 2 ? tier.color : UI_COLORS.rail, 0.5 + railA * 0.5);
      ctx.lineWidth = 2.2 * this.u;
      ctx.stroke();
    }
  }

  // Coloured lane flash on hit (lane colour) / miss (red tint), fading over ~0.3 s.
  private drawLaneFlashes(ctx: Ctx2D, st: number): void {
    const g = this.geom;
    for (let lane = 0; lane < g.laneCount; lane++) {
      const kind = this.laneFlashKind[lane];
      if (!kind) continue;
      const age = st - this.laneFlashT0[lane];
      const dur = kind === 1 ? 0.28 : 0.45;
      if (age < 0 || age > dur) {
        this.laneFlashKind[lane] = 0;
        continue;
      }
      const k = 1 - age / dur;
      const color = kind === 1 ? laneColor(this.palette, lane).glow : '#ff2020';
      const grad = ctx.createLinearGradient(0, g.strikeY, 0, g.horizonY);
      grad.addColorStop(0, withAlpha(color, (kind === 1 ? 0.55 : 0.4) * k));
      grad.addColorStop(0.6, withAlpha(color, 0.12 * k));
      grad.addColorStop(1, withAlpha(color, 0));
      ctx.fillStyle = grad;
      ctx.globalCompositeOperation = kind === 1 ? 'lighter' : 'source-over';
      ctx.beginPath();
      ctx.moveTo(laneBoundaryX(g, lane, g.minDepth), yAt(g, g.minDepth));
      ctx.lineTo(laneBoundaryX(g, lane + 1, g.minDepth), yAt(g, g.minDepth));
      ctx.lineTo(laneBoundaryX(g, lane + 1, 1), g.horizonY);
      ctx.lineTo(laneBoundaryX(g, lane, 1), g.horizonY);
      ctx.closePath();
      ctx.fill();
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
    const bandH = (14 + beatPulse * 8 + energy * 8) * this.u;
    // Soft glow band
    ctx.globalCompositeOperation = 'lighter';
    const band = ctx.createLinearGradient(0, y - bandH, 0, y + bandH);
    band.addColorStop(0, 'rgba(255,255,255,0)');
    band.addColorStop(0.5, `rgba(220,230,255,${(0.22 + beatPulse * 0.18).toFixed(3)})`);
    band.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = band;
    ctx.fillRect(x0, y - bandH, x1 - x0, bandH * 2);
    ctx.globalCompositeOperation = 'source-over';
    // Crisp line, brighter in the middle
    const line = ctx.createLinearGradient(x0, 0, x1, 0);
    line.addColorStop(0, 'rgba(255,255,255,0.35)');
    line.addColorStop(0.5, 'rgba(255,255,255,0.95)');
    line.addColorStop(1, 'rgba(255,255,255,0.35)');
    ctx.strokeStyle = line;
    ctx.lineWidth = 2.5 * this.u;
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(x1, y);
    ctx.stroke();
  }

  private drawReceptors(ctx: Ctx2D, frame: RenderFrame, dt: number, beat: number): void {
    const g = this.geom;
    const threshold = clamp(frame.thresholdFraction ?? 0.5, 0.05, 1);
    const r = g.receptorRadius;
    const ry = r * GEM_ASPECT;
    const glowSprite = this.sprites.glow('#ffffff', 64);
    for (let lane = 0; lane < g.laneCount; lane++) {
      const ls = frame.laneStates[lane];
      const value = ls ? clamp(ls.value, 0, 1.5) : 0;
      const armed = ls ? ls.armed : true;
      const tracking = ls ? ls.tracking : true;
      const color = laneColor(this.palette, lane);
      const x = laneX(g, lane, 0);
      const y = g.strikeY;
      // Fill fraction relative to threshold: 1 means "would trigger".
      const fill = clamp(value / threshold, 0, 1);
      // Smooth the glow so it breathes instead of flickering with camera noise.
      const target = tracking ? fill * fill : 0;
      this.laneGlow[lane] += (target - this.laneGlow[lane]) * clamp(dt * 14, 0, 1);
      const glowLevel = this.laneGlow[lane];
      const pulse = armed ? 1 + 0.035 * Math.sin(beat * Math.PI * 2) : 0.94;
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
        const grad = ctx.createLinearGradient(0, y - ry, 0, y + ry);
        const hot = fill >= 0.999;
        grad.addColorStop(0, withAlpha(hot ? color.bright : color.base, (hot ? 0.95 : 0.55) * alphaBase));
        grad.addColorStop(1, withAlpha(color.dark, 0.85 * alphaBase));
        ctx.fillStyle = grad;
        ctx.fillRect(x - r, top, r * 2, y + ry - top + 1);
        // Meniscus highlight
        ctx.fillStyle = withAlpha(color.bright, 0.7 * alphaBase);
        ctx.fillRect(x - r, top - 1, r * 2, Math.max(1, 2 * this.u));
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
    const st = frame.songTime;
    const buf = this.sortBuf;
    buf.length = 0;
    for (let i = 0; i < frame.notes.length; i++) {
      const n = frame.notes[i];
      if (n.state === 'hit') continue;
      if (n.lane < 0 || n.lane >= g.laneCount) continue;
      const d = depthOf(g, n.time, st);
      if (!isVisibleDepth(g, d)) continue;
      buf.push(n);
    }
    // Far notes first so nearer gems overlap them.
    buf.sort((a, b) => b.time - a.time);
    let drawn = 0;
    for (let i = 0; i < buf.length; i++) {
      const n = buf[i];
      const d = depthOf(g, n.time, st);
      const p = project(g, n.lane, d);
      const missed = n.state === 'miss';
      const color = missed ? this.palette.miss : laneColor(this.palette, n.lane);
      let alpha = 1;
      if (missed) {
        // Fizzle: fade quickly once past the line.
        alpha = d < 0 ? clamp(1 + d / 0.09, 0, 1) * 0.85 : 0.85;
      }
      // Fade in from the horizon.
      if (d > 0.85) alpha *= clamp((1.02 - d) / 0.17, 0, 1);
      if (alpha <= 0.01) continue;
      const gem = this.sprites.gem(color, p.radius);
      ctx.globalAlpha = alpha;
      if (gem) {
        blit(ctx, gem.sprite, p.x, p.y, p.radius / gem.radius);
      } else {
        ctx.fillStyle = color.base;
        ctx.beginPath();
        ctx.ellipse(p.x, p.y, p.radius, p.radius * GEM_ASPECT, 0, 0, Math.PI * 2);
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

  private processHits(frame: RenderFrame): void {
    const g = this.geom;
    const st = frame.songTime;
    const hits = frame.recentHits;
    for (let i = 0; i < hits.length; i++) {
      const e = hits[i];
      if (this.seenHits.has(e.noteId)) continue;
      this.seenHits.set(e.noteId, st);
      if (e.lane < 0 || e.lane >= g.laneCount) continue;
      const x = laneX(g, e.lane, 0);
      const y = g.strikeY;
      if (e.judgment === 'miss') {
        this.laneFlashT0[e.lane] = st;
        this.laneFlashKind[e.lane] = 2;
      } else {
        this.laneFlashT0[e.lane] = st;
        this.laneFlashKind[e.lane] = 1;
        const intensity = e.judgment === 'perfect' ? 1.25 : 0.8;
        emitHitBurst(this.particles, this.rng, x, y, g.gemRadiusNear, e.lane, intensity);
        if (e.judgment === 'perfect') {
          // Extra white core flash for perfects.
          this.particles.emit({ x, y, life: 0.18, size: g.gemRadiusNear * 1.6, endSize: g.gemRadiusNear * 0.4, color: WHITE_COLOR_INDEX, kind: PARTICLE_SPARK, alpha: 0.9 });
        }
      }
      const p = this.popups[e.lane % this.popups.length];
      p.active = true;
      p.judgment = e.judgment;
      p.t0 = st;
      p.x = x;
      p.y = y - g.receptorRadius * 2.4;
    }
    // Prune the de-dupe set occasionally.
    if (this.seenHits.size > 64) {
      for (const [id, t] of this.seenHits) {
        if (st - t > 3 || t > st + 1) this.seenHits.delete(id);
      }
    }
  }

  private particleColor(index: number): { base: string; glow: string } {
    if (index === WHITE_COLOR_INDEX) return { base: '#ffffff', glow: '#ffffff' };
    if (index === MISS_COLOR_INDEX) return { base: this.palette.miss.base, glow: this.palette.miss.glow };
    const c = laneColor(this.palette, index);
    return { base: c.bright, glow: c.glow };
  }

  private drawParticles(ctx: Ctx2D): void {
    const pool = this.particles;
    const n = pool.count;
    if (n === 0) return;
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    // Batch by colour index so strokes/fills share style.
    const seen: number[] = [];
    for (let i = 0; i < n; i++) {
      const c = pool.color[i];
      if (seen.indexOf(c) === -1) seen.push(c);
    }
    for (let ci = 0; ci < seen.length; ci++) {
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
      // Streaks (one path per colour)
      ctx.globalAlpha = 1;
      ctx.strokeStyle = col.base;
      ctx.lineWidth = Math.max(1, this.geom.gemRadiusNear * 0.09);
      ctx.beginPath();
      let anyStreak = false;
      for (let i = 0; i < n; i++) {
        if (pool.color[i] !== cidx || pool.kind[i] !== PARTICLE_STREAK) continue;
        const a = pool.alphaAt(i);
        if (a <= 0.02) continue;
        const len = 0.035;
        ctx.moveTo(pool.x[i], pool.y[i]);
        ctx.lineTo(pool.x[i] - pool.vx[i] * len, pool.y[i] - pool.vy[i] * len);
        anyStreak = true;
      }
      if (anyStreak) {
        ctx.globalAlpha = 0.8;
        ctx.stroke();
      }
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
    const dur = 0.75;
    for (let i = 0; i < this.popups.length; i++) {
      const p = this.popups[i];
      if (!p.active) continue;
      const age = st - p.t0;
      if (age < 0 || age > dur) {
        p.active = false;
        continue;
      }
      const t = age / dur;
      const rise = easeOutCubic(t) * this.geom.receptorRadius * 1.6;
      // Pop: overshoot then settle.
      const pop = age < 0.12 ? 0.6 + (age / 0.12) * 0.6 : age < 0.22 ? 1.2 - ((age - 0.12) / 0.1) * 0.2 : 1;
      const alpha = t < 0.6 ? 1 : 1 - (t - 0.6) / 0.4;
      const style = this.style(p.judgment === 'perfect' ? 'popupPerfect' : p.judgment === 'good' ? 'popupGood' : 'popupMiss');
      this.text.draw(ctx, JUDGMENT_STYLE[p.judgment].text, p.x, p.y - rise, style, pop, alpha);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // HUD
  // ---------------------------------------------------------------------------------------------

  private styleCache = new Map<string, TextStyle>();
  private styleU = -1;

  private style(name: string): TextStyle {
    if (this.styleU !== this.u) {
      this.styleCache.clear();
      this.styleU = this.u;
    }
    let s = this.styleCache.get(name);
    if (s) return s;
    const u = this.u;
    const px = (n: number) => Math.round(n * u);
    switch (name) {
      case 'popupPerfect':
        s = { font: `italic 900 ${px(34)}px ${FONT}`, color: JUDGMENT_STYLE.perfect.color, stroke: '#4a2a00', strokeWidth: px(2), glow: JUDGMENT_STYLE.perfect.glow, glowBlur: px(14) };
        break;
      case 'popupGood':
        s = { font: `italic 900 ${px(30)}px ${FONT}`, color: JUDGMENT_STYLE.good.color, stroke: '#0a1e4a', strokeWidth: px(2), glow: JUDGMENT_STYLE.good.glow, glowBlur: px(12) };
        break;
      case 'popupMiss':
        s = { font: `italic 800 ${px(24)}px ${FONT}`, color: JUDGMENT_STYLE.miss.color, stroke: '#3a0000', strokeWidth: px(2), glow: JUDGMENT_STYLE.miss.glow, glowBlur: px(8) };
        break;
      case 'combo':
        s = { font: `italic 900 ${px(64)}px ${FONT}`, color: '#ffffff', stroke: 'rgba(0,0,0,0.6)', strokeWidth: px(3), glow: '#8fb4ff', glowBlur: px(18) };
        break;
      case 'comboLabel':
        s = { font: `700 ${px(16)}px ${FONT}`, color: UI_COLORS.textDim, stroke: 'rgba(0,0,0,0.5)', strokeWidth: px(2) };
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

  private drawCombo(ctx: Ctx2D, frame: RenderFrame, st: number): void {
    const g = this.geom;
    const combo = Math.max(0, Math.floor(frame.combo));
    if (combo > this.lastCombo) this.comboBounceT0 = st;
    if (combo === 0 && this.lastCombo > 0) this.comboBreakT0 = st;
    this.lastCombo = combo;
    const x = g.vpX;
    const y = g.horizonY + (g.strikeY - g.horizonY) * 0.62;
    if (combo >= 2) {
      const age = st - this.comboBounceT0;
      const bounce = age >= 0 && age < 0.25 ? Math.pow(1 - age / 0.25, 2) : 0;
      const scale = 1 + bounce * 0.35;
      // Bigger, hotter as the combo grows.
      const heat = clamp(combo / 50, 0, 1);
      const alpha = 0.85;
      this.text.draw(ctx, String(combo), x, y, this.style('combo'), scale * (1 + heat * 0.25), alpha);
      this.text.draw(ctx, 'COMBO', x, y + 44 * this.u * (1 + heat * 0.25), this.style('comboLabel'), 1, 0.9);
    } else {
      const age = st - this.comboBreakT0;
      if (age >= 0 && age < 0.5) {
        // Combo break: brief red shake-out.
        const k = 1 - age / 0.5;
        const dx = Math.sin(age * 60) * 6 * this.u * k;
        this.text.draw(ctx, String(this.lastComboShown), x + dx, y, this.style('combo'), 1, k * 0.5);
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

    // Score (top-right, rolling digits)
    const target = Math.max(0, frame.score);
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
    this.healthSmooth += (health - this.healthSmooth) * clamp(dt * 6, 0, 1);
    const hv = this.healthSmooth;
    // Size the gauge from the free space left of the road at the strike line; keep it clear of the road edge.
    const leftPanelW = Math.max(0, roadEdgeX(g, -1, 0));
    const gaugeR = clamp(Math.min(leftPanelW * 0.3, H * 0.1, 90 * u), 18, 140);
    const gx = Math.max(gaugeR * 1.25 + pad, leftPanelW * 0.45);
    const gy = g.strikeY - gaugeR * 0.9;
    const a0 = Math.PI * 0.75;
    const a1 = Math.PI * 2.25;
    ctx.lineCap = 'round';
    ctx.lineWidth = gaugeR * 0.22;
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.beginPath();
    ctx.arc(gx, gy, gaugeR, a0, a1);
    ctx.stroke();
    const hcol = hv < 0.5 ? mixHex(ROCK_METER_COLORS.low, ROCK_METER_COLORS.mid, hv * 2) : mixHex(ROCK_METER_COLORS.mid, ROCK_METER_COLORS.high, (hv - 0.5) * 2);
    const danger = hv < 0.3 ? 0.5 + 0.5 * Math.sin(frame.songTime * 10) : 0;
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = withAlpha(hcol, 0.25 + beatPulse * 0.2 + danger * 0.3);
    ctx.lineWidth = gaugeR * 0.34;
    ctx.beginPath();
    ctx.arc(gx, gy, gaugeR, a0, a0 + (a1 - a0) * hv);
    ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = hcol;
    ctx.lineWidth = gaugeR * 0.2;
    ctx.beginPath();
    ctx.arc(gx, gy, gaugeR, a0, a0 + (a1 - a0) * Math.max(0.001, hv));
    ctx.stroke();
    // Needle
    const na = a0 + (a1 - a0) * hv;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = Math.max(2, gaugeR * 0.06);
    ctx.beginPath();
    ctx.moveTo(gx + Math.cos(na) * gaugeR * 0.55, gy + Math.sin(na) * gaugeR * 0.55);
    ctx.lineTo(gx + Math.cos(na) * gaugeR * 1.2, gy + Math.sin(na) * gaugeR * 1.2);
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(gx, gy, gaugeR * 0.1, 0, Math.PI * 2);
    ctx.fill();
    this.text.draw(ctx, 'ROCK', gx, gy + gaugeR * 0.55, this.style('hudLabel'), 1, 0.9);

    // Multiplier badge under the gauge
    const mult = Math.max(1, Math.floor(frame.multiplier));
    if (mult !== this.lastMultiplier) {
      this.multiplierPopT0 = frame.songTime;
      this.lastMultiplier = mult;
    }
    const tier = multiplierTier(mult);
    const popAge = frame.songTime - this.multiplierPopT0;
    const pop = popAge >= 0 && popAge < 0.3 ? 1 + 0.4 * Math.pow(1 - popAge / 0.3, 2) : 1;
    const bw = gaugeR * 1.5 * pop;
    const bh = gaugeR * 0.75 * pop;
    const bx = gx - bw / 2;
    const by = gy + gaugeR * 1.15;
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = withAlpha(tier.glow, 0.25 + beatPulse * 0.25 * (mult - 1));
    roundRectPath(ctx, bx - 6 * u, by - 6 * u, bw + 12 * u, bh + 12 * u, bh * 0.5);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    const bg = ctx.createLinearGradient(0, by, 0, by + bh);
    bg.addColorStop(0, tier.color);
    bg.addColorStop(1, mixHex(tier.color, '#000000', 0.45));
    ctx.fillStyle = bg;
    roundRectPath(ctx, bx, by, bw, bh, bh * 0.35);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = Math.max(1, 2 * u);
    ctx.stroke();
    this.text.draw(ctx, tier.label, gx, by + bh / 2, this.style('mult'), (bh / (40 * u)) * 1.0, 1);
  }

  private drawLabels(ctx: Ctx2D, frame: RenderFrame): void {
    const g = this.geom;
    const y = g.strikeY + g.receptorRadius * GEM_ASPECT + 22 * this.u;
    for (let lane = 0; lane < g.laneCount; lane++) {
      const spec = frame.lanes[lane];
      if (!spec) continue;
      const ls = frame.laneStates[lane];
      const tracking = ls ? ls.tracking : true;
      const color = laneColor(this.palette, lane);
      const label = movementLabel(spec.movement, spec.side);
      const x = laneX(g, lane, -0.02);
      this.text.draw(ctx, label, x, y, this.style(`laneLabel:${tracking ? color.bright : '#9a9aa0'}`), 1, tracking ? 1 : 0.6);
    }
  }

  private drawStats(ctx: Ctx2D): void {
    const s = this.stats;
    const txt = `draw ${s.drawMs.toFixed(2)}ms avg ${s.avgDrawMs.toFixed(2)} max ${s.maxDrawMs.toFixed(1)} | notes ${s.notesDrawn} | particles ${s.particles} | sprites ${s.sprites} | ${this.width}x${this.height}@${this.dpr}`;
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
