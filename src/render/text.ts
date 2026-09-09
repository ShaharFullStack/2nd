/**
 * Cached text rendering. Text is rasterized once into small offscreen canvases (keyed by
 * string + style) and then blitted with drawImage, which is far cheaper than fillText with
 * shadows every frame. A bounded LRU keeps memory in check.
 */
import type { CanvasLike } from './types';

export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export interface TextStyle {
  /** CSS font, e.g. "700 32px system-ui". */
  font: string;
  color: string;
  /** Outline colour (optional). */
  stroke?: string;
  strokeWidth?: number;
  /** Glow colour (rendered with shadowBlur once into the cache, free thereafter). */
  glow?: string;
  glowBlur?: number;
}

export interface TextSprite {
  canvas: CanvasLike;
  width: number;
  height: number;
  /** Horizontal padding baked into the sprite. */
  padX: number;
  padY: number;
  /** Text advance width (unpadded). */
  textWidth: number;
}

export type CanvasFactory = (width: number, height: number) => CanvasLike;

/** Default scratch canvas factory: OffscreenCanvas when available, otherwise a DOM canvas. */
export function defaultCanvasFactory(width: number, height: number): CanvasLike {
  const w = Math.max(1, Math.ceil(width));
  const h = Math.max(1, Math.ceil(height));
  if (typeof OffscreenCanvas !== 'undefined') {
    return new OffscreenCanvas(w, h) as unknown as CanvasLike;
  }
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c as unknown as CanvasLike;
  }
  throw new Error('No canvas implementation available');
}

/** Rough font pixel size parser ("700 32px foo" → 32). */
export function fontPx(font: string): number {
  const m = /(\d+(?:\.\d+)?)px/.exec(font);
  return m ? parseFloat(m[1]) : 16;
}

export class TextCache {
  private map = new Map<string, TextSprite>();
  private readonly max: number;
  private readonly factory: CanvasFactory;
  /** Device pixel ratio the sprites are rasterized at. */
  dpr = 1;

  constructor(factory: CanvasFactory = defaultCanvasFactory, maxEntries = 256) {
    this.factory = factory;
    this.max = Math.max(8, maxEntries);
  }

  get size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }

  private key(text: string, s: TextStyle): string {
    return `${text}|${s.font}|${s.color}|${s.stroke ?? ''}|${s.strokeWidth ?? 0}|${s.glow ?? ''}|${s.glowBlur ?? 0}|${this.dpr}`;
  }

  /** Get (or rasterize) the sprite for a string. Returns null when no 2D context is available. */
  get(text: string, style: TextStyle): TextSprite | null {
    const k = this.key(text, style);
    const hit = this.map.get(k);
    if (hit) {
      // LRU touch
      this.map.delete(k);
      this.map.set(k, hit);
      return hit;
    }
    const sprite = this.rasterize(text, style);
    if (!sprite) return null;
    this.map.set(k, sprite);
    if (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    return sprite;
  }

  private rasterize(text: string, style: TextStyle): TextSprite | null {
    const px = fontPx(style.font);
    const blur = style.glow ? (style.glowBlur ?? px * 0.35) : 0;
    const sw = style.stroke ? (style.strokeWidth ?? Math.max(1, px * 0.08)) : 0;
    const padX = Math.ceil(blur + sw + px * 0.15);
    const padY = Math.ceil(blur + sw + px * 0.2);
    // Measure with a probe context; fall back to an estimate.
    const probe = this.factory(1, 1).getContext('2d');
    let textWidth = text.length * px * 0.6;
    if (probe) {
      probe.font = style.font;
      const m = probe.measureText(text);
      if (m && typeof m.width === 'number' && m.width > 0) textWidth = m.width;
    }
    const width = Math.ceil(textWidth + padX * 2);
    const height = Math.ceil(px * 1.3 + padY * 2);
    const dpr = this.dpr;
    const canvas = this.factory(width * dpr, height * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = style.font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const cx = width / 2;
    const cy = height / 2;
    if (style.glow) {
      ctx.shadowColor = style.glow;
      ctx.shadowBlur = blur;
      ctx.fillStyle = style.glow;
      ctx.fillText(text, cx, cy);
      ctx.fillText(text, cx, cy);
      ctx.shadowBlur = 0;
      ctx.shadowColor = 'transparent';
    }
    if (style.stroke) {
      ctx.lineJoin = 'round';
      ctx.lineWidth = sw * 2;
      ctx.strokeStyle = style.stroke;
      ctx.strokeText(text, cx, cy);
    }
    ctx.fillStyle = style.color;
    ctx.fillText(text, cx, cy);
    return { canvas, width, height, padX, padY, textWidth };
  }

  /**
   * Draw cached text centred at (x, y) in logical pixels. `scale` scales around the centre.
   * `align` shifts the anchor: 'center' (default) | 'left' | 'right'.
   */
  draw(
    ctx: Ctx2D,
    text: string,
    x: number,
    y: number,
    style: TextStyle,
    scale = 1,
    alpha = 1,
    align: 'center' | 'left' | 'right' = 'center',
  ): number {
    const sp = this.get(text, style);
    if (!sp) {
      // Fallback: direct text.
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.font = style.font;
      ctx.fillStyle = style.color;
      ctx.textAlign = align;
      ctx.textBaseline = 'middle';
      ctx.fillText(text, x, y);
      ctx.restore();
      return text.length * fontPx(style.font) * 0.6 * scale;
    }
    const w = sp.width * scale;
    const h = sp.height * scale;
    let cx = x;
    if (align === 'left') cx = x + (sp.textWidth * scale) / 2;
    else if (align === 'right') cx = x - (sp.textWidth * scale) / 2;
    if (alpha !== 1) {
      const prev = ctx.globalAlpha;
      ctx.globalAlpha = prev * alpha;
      ctx.drawImage(sp.canvas as unknown as CanvasImageSource, cx - w / 2, y - h / 2, w, h);
      ctx.globalAlpha = prev;
    } else {
      ctx.drawImage(sp.canvas as unknown as CanvasImageSource, cx - w / 2, y - h / 2, w, h);
    }
    return sp.textWidth * scale;
  }
}

/**
 * Rolling-digit number display (odometer style). Digits 0-9 are rasterized once into a
 * vertical strip; each digit cell shows a fractional scroll between consecutive digits.
 */
export class DigitRoller {
  private strip: CanvasLike | null = null;
  private cellW = 0;
  private cellH = 0;
  private stripDpr = 1;
  private stripKey = '';
  private readonly factory: CanvasFactory;

  constructor(factory: CanvasFactory = defaultCanvasFactory) {
    this.factory = factory;
  }

  private ensure(style: TextStyle, dpr: number): void {
    const key = `${style.font}|${style.color}|${style.glow ?? ''}|${dpr}`;
    if (this.strip && this.stripKey === key) return;
    const px = fontPx(style.font);
    const probe = this.factory(1, 1).getContext('2d');
    let w = px * 0.62;
    if (probe) {
      probe.font = style.font;
      for (let d = 0; d < 10; d++) {
        const m = probe.measureText(String(d));
        if (m && m.width > w) w = m.width;
      }
    }
    this.cellW = Math.ceil(w + px * 0.1);
    this.cellH = Math.ceil(px * 1.2);
    this.stripDpr = dpr;
    const canvas = this.factory(this.cellW * dpr, this.cellH * 10 * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      this.strip = null;
      return;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.font = style.font;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = style.color;
    if (style.glow) {
      ctx.shadowColor = style.glow;
      ctx.shadowBlur = px * 0.25;
    }
    for (let d = 0; d < 10; d++) {
      ctx.fillText(String(d), this.cellW / 2, this.cellH * d + this.cellH / 2);
    }
    this.strip = canvas;
    this.stripKey = key;
  }

  /** Digit cell width in logical px (after ensure). */
  get digitWidth(): number {
    return this.cellW;
  }

  /**
   * Draw `value` right-aligned at (rightX, centerY) with at least `minDigits` digits.
   * Fractional values roll the affected digits. Returns total width drawn.
   */
  draw(ctx: Ctx2D, value: number, rightX: number, centerY: number, style: TextStyle, minDigits = 6, dpr = 1): number {
    this.ensure(style, dpr);
    const v = Math.max(0, value);
    const intPart = Math.floor(v);
    const digits = Math.max(minDigits, String(intPart).length);
    const cw = this.cellW;
    const ch = this.cellH;
    if (!this.strip) {
      ctx.save();
      ctx.font = style.font;
      ctx.fillStyle = style.color;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(intPart).padStart(minDigits, '0'), rightX, centerY);
      ctx.restore();
      return cw * digits;
    }
    const strip = this.strip as unknown as CanvasImageSource;
    const sdpr = this.stripDpr;
    ctx.save();
    ctx.beginPath();
    ctx.rect(rightX - cw * digits, centerY - ch / 2, cw * digits, ch);
    ctx.clip();
    // Fractional roll: the lowest digit rolls by frac; higher digits roll only while lower ones wrap 9→0.
    const frac = v - intPart;
    let carry = frac;
    let pow = 1;
    for (let i = 0; i < digits; i++) {
      const digit = Math.floor(intPart / pow) % 10;
      const roll = carry; // 0..1 offset toward digit+1
      const x = rightX - cw * (i + 1);
      const offset = roll * ch;
      // current digit scrolled up by offset, next digit follows below
      ctx.drawImage(strip, 0, digit * ch * sdpr, cw * sdpr, ch * sdpr, x, centerY - ch / 2 - offset, cw, ch);
      if (roll > 0.0001) {
        const next = (digit + 1) % 10;
        ctx.drawImage(strip, 0, next * ch * sdpr, cw * sdpr, ch * sdpr, x, centerY - ch / 2 - offset + ch, cw, ch);
      }
      carry = digit === 9 ? carry : 0;
      pow *= 10;
    }
    ctx.restore();
    return cw * digits;
  }
}
