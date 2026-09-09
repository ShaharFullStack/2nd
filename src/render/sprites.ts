/**
 * Pre-rendered sprites: gems (per lane colour × size bucket), glow halos, receptor rings.
 * Rendering shadows/gradients once here keeps per-frame draws to plain drawImage calls.
 */
import { bucketRadius, radiusBucket } from './geometry';
import type { LaneColor } from './palette';
import { withAlpha } from './palette';
import type { CanvasFactory } from './text';
import { defaultCanvasFactory } from './text';
import type { CanvasLike } from './types';

export interface Sprite {
  canvas: CanvasLike;
  /** Logical size (px). */
  width: number;
  height: number;
  /** Anchor point (logical px) that should be placed at the gem centre. */
  ax: number;
  ay: number;
}

export const GEM_BUCKETS = 12;
/** Gem aspect: gems are slightly squashed ellipses viewed from above, GH-style. */
export const GEM_ASPECT = 0.72;

export class SpriteCache {
  private map = new Map<string, Sprite>();
  private readonly factory: CanvasFactory;
  dpr = 1;
  minRadius = 4;
  maxRadius = 40;

  constructor(factory: CanvasFactory = defaultCanvasFactory) {
    this.factory = factory;
  }

  get size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }

  /** Configure the radius range covered by the size buckets (call on resize). */
  setRadiusRange(minRadius: number, maxRadius: number, dpr: number): void {
    const changed = minRadius !== this.minRadius || maxRadius !== this.maxRadius || dpr !== this.dpr;
    this.minRadius = Math.max(1, minRadius);
    this.maxRadius = Math.max(this.minRadius + 1, maxRadius);
    this.dpr = dpr;
    if (changed) this.clear();
  }

  /** Gem sprite for a colour at (approximately) the given radius. Returns null without a 2D context. */
  gem(color: LaneColor, radius: number): { sprite: Sprite; radius: number } | null {
    const b = radiusBucket(radius, this.minRadius, this.maxRadius, GEM_BUCKETS);
    const r = bucketRadius(b, this.minRadius, this.maxRadius, GEM_BUCKETS);
    const key = `gem|${color.base}|${b}`;
    let s = this.map.get(key);
    if (!s) {
      const made = this.makeGem(color, r);
      if (!made) return null;
      s = made;
      this.map.set(key, s);
    }
    return { sprite: s, radius: r };
  }

  /** Soft radial glow halo in a colour (drawn additively at various sizes). */
  glow(colorHex: string, radius = 32): Sprite | null {
    const key = `glow|${colorHex}|${radius}`;
    let s = this.map.get(key);
    if (!s) {
      const made = this.makeGlow(colorHex, radius);
      if (!made) return null;
      s = made;
      this.map.set(key, s);
    }
    return s;
  }

  /**
   * Soft volumetric stage-light cone: apex at the top centre, widening downward, with a feathered
   * edge and a vertical falloff. Drawn additively with a rotation around the apex.
   */
  beam(colorHex: string, width = 128, height = 256): Sprite | null {
    const key = `beam|${colorHex}|${width}x${height}`;
    let s = this.map.get(key);
    if (!s) {
      const made = this.makeBeam(colorHex, width, height);
      if (!made) return null;
      s = made;
      this.map.set(key, s);
    }
    return s;
  }

  /** Receptor ring (empty gem outline) for the strike line. */
  receptor(color: LaneColor, radius: number): Sprite | null {
    const r = Math.round(radius);
    const key = `rec|${color.base}|${r}`;
    let s = this.map.get(key);
    if (!s) {
      const made = this.makeReceptor(color, r);
      if (!made) return null;
      s = made;
      this.map.set(key, s);
    }
    return s;
  }

  private makeCanvas(width: number, height: number): { canvas: CanvasLike; ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D } | null {
    const dpr = this.dpr;
    const canvas = this.factory(Math.ceil(width * dpr), Math.ceil(height * dpr));
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { canvas, ctx };
  }

  private makeGem(color: LaneColor, r: number): Sprite | null {
    const ry = r * GEM_ASPECT;
    const shadowDy = r * 0.35;
    const pad = Math.ceil(r * 0.35);
    const w = r * 2 + pad * 2;
    const h = ry * 2 + pad * 2 + shadowDy;
    const made = this.makeCanvas(w, h);
    if (!made) return null;
    const { canvas, ctx } = made;
    const cx = w / 2;
    const cy = pad + ry;

    // Drop shadow
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.beginPath();
    ctx.ellipse(cx, cy + shadowDy, r * 1.02, ry * 0.95, 0, 0, Math.PI * 2);
    ctx.fill();

    // Outer coloured rim (radial gradient bright top-left → dark bottom-right)
    const rim = ctx.createRadialGradient(cx - r * 0.3, cy - ry * 0.4, r * 0.1, cx, cy, r * 1.05);
    rim.addColorStop(0, color.bright);
    rim.addColorStop(0.45, color.base);
    rim.addColorStop(1, color.dark);
    ctx.fillStyle = rim;
    ctx.beginPath();
    ctx.ellipse(cx, cy, r, ry, 0, 0, Math.PI * 2);
    ctx.fill();

    // Dark inner disc (the "button" face)
    const inner = ctx.createRadialGradient(cx, cy - ry * 0.15, r * 0.05, cx, cy, r * 0.66);
    inner.addColorStop(0, '#2a2d38');
    inner.addColorStop(0.7, '#12141c');
    inner.addColorStop(1, color.dark);
    ctx.fillStyle = inner;
    ctx.beginPath();
    ctx.ellipse(cx, cy, r * 0.64, ry * 0.6, 0, 0, Math.PI * 2);
    ctx.fill();

    // Coloured centre dot
    ctx.fillStyle = color.base;
    ctx.beginPath();
    ctx.ellipse(cx, cy, r * 0.34, ry * 0.32, 0, 0, Math.PI * 2);
    ctx.fill();

    // Bright specular highlight on the rim
    const hl = ctx.createRadialGradient(cx - r * 0.35, cy - ry * 0.55, 0, cx - r * 0.35, cy - ry * 0.55, r * 0.5);
    hl.addColorStop(0, 'rgba(255,255,255,0.95)');
    hl.addColorStop(0.5, 'rgba(255,255,255,0.35)');
    hl.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = hl;
    ctx.beginPath();
    ctx.ellipse(cx - r * 0.35, cy - ry * 0.55, r * 0.5, ry * 0.4, 0, 0, Math.PI * 2);
    ctx.fill();

    // Thin outline
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.lineWidth = Math.max(1, r * 0.06);
    ctx.beginPath();
    ctx.ellipse(cx, cy, r, ry, 0, 0, Math.PI * 2);
    ctx.stroke();

    return { canvas, width: w, height: h, ax: cx, ay: cy };
  }

  private makeGlow(colorHex: string, r: number): Sprite | null {
    const w = r * 2;
    const made = this.makeCanvas(w, w);
    if (!made) return null;
    const { canvas, ctx } = made;
    const g = ctx.createRadialGradient(r, r, 0, r, r, r);
    g.addColorStop(0, withAlpha(colorHex, 0.9));
    g.addColorStop(0.35, withAlpha(colorHex, 0.35));
    g.addColorStop(1, withAlpha(colorHex, 0));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, w);
    return { canvas, width: w, height: w, ax: r, ay: r };
  }

  private makeBeam(colorHex: string, w: number, h: number): Sprite | null {
    const made = this.makeCanvas(w, h);
    if (!made) return null;
    const { canvas, ctx } = made;
    const cx = w / 2;
    // Horizontal feather: bright core, transparent edges (multiplied by a vertical falloff below).
    const across = ctx.createLinearGradient(0, 0, w, 0);
    across.addColorStop(0, withAlpha(colorHex, 0));
    across.addColorStop(0.35, withAlpha(colorHex, 0.55));
    across.addColorStop(0.5, withAlpha(colorHex, 0.9));
    across.addColorStop(0.65, withAlpha(colorHex, 0.55));
    across.addColorStop(1, withAlpha(colorHex, 0));
    ctx.fillStyle = across;
    ctx.beginPath();
    ctx.moveTo(cx - w * 0.04, 0);
    ctx.lineTo(cx + w * 0.04, 0);
    ctx.lineTo(w, h);
    ctx.lineTo(0, h);
    ctx.closePath();
    ctx.fill();
    // Vertical falloff: erase toward the bottom so the cone dissolves instead of ending hard.
    ctx.globalCompositeOperation = 'destination-in';
    const down = ctx.createLinearGradient(0, 0, 0, h);
    down.addColorStop(0, 'rgba(0,0,0,1)');
    down.addColorStop(0.15, 'rgba(0,0,0,0.85)');
    down.addColorStop(0.6, 'rgba(0,0,0,0.35)');
    down.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = down;
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'source-over';
    return { canvas, width: w, height: h, ax: cx, ay: 0 };
  }

  private makeReceptor(color: LaneColor, r: number): Sprite | null {
    const ry = r * GEM_ASPECT;
    const pad = Math.ceil(r * 0.4);
    const w = r * 2 + pad * 2;
    const h = ry * 2 + pad * 2;
    const made = this.makeCanvas(w, h);
    if (!made) return null;
    const { canvas, ctx } = made;
    const cx = w / 2;
    const cy = h / 2;
    // Soft base shadow / socket
    const socket = ctx.createRadialGradient(cx, cy, r * 0.2, cx, cy, r * 1.25);
    socket.addColorStop(0, 'rgba(0,0,0,0.55)');
    socket.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = socket;
    ctx.fillRect(0, 0, w, h);
    // Button face: dark translucent disc with a top-lit bevel so the receptor reads as a fret button.
    const face = ctx.createRadialGradient(cx, cy - ry * 0.3, r * 0.1, cx, cy, r);
    face.addColorStop(0, 'rgba(60,66,90,0.55)');
    face.addColorStop(0.7, 'rgba(18,20,30,0.7)');
    face.addColorStop(1, withAlpha(color.dark, 0.85));
    ctx.fillStyle = face;
    ctx.beginPath();
    ctx.ellipse(cx, cy, r, ry, 0, 0, Math.PI * 2);
    ctx.fill();
    // Outer ring
    ctx.lineWidth = Math.max(2, r * 0.16);
    ctx.strokeStyle = color.base;
    ctx.beginPath();
    ctx.ellipse(cx, cy, r, ry, 0, 0, Math.PI * 2);
    ctx.stroke();
    // Inner darker ring
    ctx.lineWidth = Math.max(1, r * 0.06);
    ctx.strokeStyle = withAlpha(color.dark, 0.9);
    ctx.beginPath();
    ctx.ellipse(cx, cy, r * 0.8, ry * 0.78, 0, 0, Math.PI * 2);
    ctx.stroke();
    // Highlight arc
    ctx.lineWidth = Math.max(1, r * 0.07);
    ctx.strokeStyle = 'rgba(255,255,255,0.7)';
    ctx.beginPath();
    ctx.ellipse(cx, cy, r * 0.95, ry * 0.93, 0, Math.PI * 1.1, Math.PI * 1.7);
    ctx.stroke();
    return { canvas, width: w, height: h, ax: cx, ay: cy };
  }
}

/** Draw a sprite centred on its anchor at (x, y), scaled by `scale`. */
export function blit(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  s: Sprite,
  x: number,
  y: number,
  scale = 1,
): void {
  ctx.drawImage(
    s.canvas as unknown as CanvasImageSource,
    x - s.ax * scale,
    y - s.ay * scale,
    s.width * scale,
    s.height * scale,
  );
}
