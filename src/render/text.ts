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

/**
 * One shared 1x1 measuring context per factory-owning cache, so rasterizing a new string costs one
 * canvas allocation (the sprite), not two.
 */
class ProbeContext {
  private ctx: Ctx2D | null | undefined;
  private readonly factory: CanvasFactory;
  constructor(factory: CanvasFactory) {
    this.factory = factory;
  }
  get(): Ctx2D | null {
    if (this.ctx === undefined) this.ctx = this.factory(1, 1).getContext('2d');
    return this.ctx;
  }
}

/** Ink box of a run of text: how far the glyphs actually extend above / below the baseline. */
export interface InkBox {
  ascent: number;
  descent: number;
  width: number;
}

/**
 * Measure the ink box of `text` with an already-configured context, falling back to font-size
 * ratios when the engine does not report `actualBoundingBox*` (jsdom stubs, old Safari).
 */
export function measureInk(ctx: Ctx2D, text: string, px: number): InkBox {
  const m = ctx.measureText(text) as TextMetrics | undefined;
  const width = m && typeof m.width === 'number' && m.width > 0 ? m.width : text.length * px * 0.6;
  const a = m && typeof m.actualBoundingBoxAscent === 'number' && m.actualBoundingBoxAscent > 0 ? m.actualBoundingBoxAscent : px * 0.72;
  const d = m && typeof m.actualBoundingBoxDescent === 'number' && m.actualBoundingBoxDescent >= 0 ? m.actualBoundingBoxDescent : px * 0.02;
  return { ascent: a, descent: d, width };
}

export class TextCache {
  private map = new Map<string, TextSprite>();
  /** Cached advance widths (cold path: label fitting, not per-frame drawing). */
  private widths = new Map<string, number>();
  private fits = new Map<string, string>();
  private readonly max: number;
  private readonly factory: CanvasFactory;
  private readonly probe: ProbeContext;
  /** Device pixel ratio the sprites are rasterized at. */
  dpr = 1;

  constructor(factory: CanvasFactory = defaultCanvasFactory, maxEntries = 256) {
    this.factory = factory;
    this.probe = new ProbeContext(factory);
    this.max = Math.max(8, maxEntries);
  }

  get size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
    this.widths.clear();
    this.fits.clear();
  }

  /**
   * Advance width of `text` in logical px, without rasterizing anything. Cached, and meant for the
   * cold path (fitting a label to a lane on resize) rather than per-frame use.
   */
  measure(text: string, style: TextStyle): number {
    const k = `${style.font}|${text}`;
    const hit = this.widths.get(k);
    if (hit !== undefined) return hit;
    const px = fontPx(style.font);
    let w = text.length * px * 0.6;
    const probe = this.probe.get();
    if (probe) {
      probe.font = style.font;
      const m = probe.measureText(text);
      if (m && typeof m.width === 'number' && m.width > 0) w = m.width;
    }
    if (this.widths.size > 512) this.widths.clear();
    this.widths.set(k, w);
    return w;
  }

  /**
   * Longest prefix of `text` that fits `maxWidth`, with a trailing ellipsis when it had to cut
   * (returns `text` unchanged when it already fits). Used for lane labels on narrow canvases, where
   * an untruncated label would collide with its neighbours. Cached; cold path only.
   */
  fit(text: string, style: TextStyle, maxWidth: number): string {
    if (!(maxWidth > 0)) return '';
    if (this.measure(text, style) <= maxWidth) return text;
    const k = `${style.font}|${Math.round(maxWidth)}|${text}`;
    const hit = this.fits.get(k);
    if (hit !== undefined) return hit;
    let out = '';
    for (let n = text.length - 1; n >= 1; n--) {
      const candidate = `${text.slice(0, n).trimEnd()}…`;
      if (this.measure(candidate, style) <= maxWidth) {
        out = candidate;
        break;
      }
    }
    if (this.fits.size > 256) this.fits.clear();
    this.fits.set(k, out);
    return out;
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
    // Measure with the shared probe context; fall back to an estimate.
    const probe = this.probe.get();
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
   * Draw a short string as a row of per-character sprites, centred at (x, y). Costs one cached
   * sprite per distinct *character* rather than per distinct *string*, so a value that changes
   * every few frames (the combo counter) never rasterizes a new canvas mid-song and can never
   * flood the LRU with large glowing sprites. Use `draw()` for static strings (labels, titles).
   * Returns the drawn width in logical px.
   */
  drawChars(ctx: Ctx2D, text: string, x: number, y: number, style: TextStyle, scale = 1, alpha = 1): number {
    let total = 0;
    for (let i = 0; i < text.length; i++) {
      const sp = this.get(text[i], style);
      if (!sp) return this.draw(ctx, text, x, y, style, scale, alpha);
      total += sp.textWidth;
    }
    const w = total * scale;
    let cx = x - w / 2;
    const prev = ctx.globalAlpha;
    if (alpha !== 1) ctx.globalAlpha = prev * alpha;
    for (let i = 0; i < text.length; i++) {
      const sp = this.get(text[i], style);
      if (!sp) continue;
      const cw = sp.textWidth * scale;
      ctx.drawImage(
        sp.canvas as unknown as CanvasImageSource,
        cx + cw / 2 - (sp.width * scale) / 2,
        y - (sp.height * scale) / 2,
        sp.width * scale,
        sp.height * scale,
      );
      cx += cw;
    }
    if (alpha !== 1) ctx.globalAlpha = prev;
    return w;
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
 * Rolling-digit number display (odometer style). Digits 0-9 are rasterized once into a vertical
 * strip and a rolling digit scrolls from one glyph to the next behind a one-glyph-tall window.
 *
 * The roll pitch is the *ink box* of the digits (`glyphH`), not the strip's cell height: the strip
 * cells are padded so each digit's glow/stroke can be baked in without bleeding into its
 * neighbours, but rolling by the padded pitch would put that padding — i.e. a blank band as tall as
 * a third of the glyph — through the middle of the window on every roll, which reads as a rendering
 * fault rather than an odometer. Rolling by `glyphH` keeps the outgoing and incoming glyphs exactly
 * contiguous, so the digit column is never empty at any point of a 0→1 roll.
 *
 * A settled digit (roll ≈ 0) is blitted whole and unclipped, so its glow is intact; only a rolling
 * digit is clipped to the one-glyph window (where the clipped halo is invisible because it moves).
 */
export class DigitRoller {
  private strip: CanvasLike | null = null;
  /** Horizontal advance per digit (the layout pitch). */
  private advW = 0;
  /** Source cell size in the strip: the advance box plus padding for glow / stroke. */
  private cellW = 0;
  private cellH = 0;
  /** Roll pitch = the digits' ink height. The visible window is exactly this tall. */
  private glyphH = 0;
  private stripDpr = 1;
  private stripKey = '';
  private readonly factory: CanvasFactory;
  private readonly probe: ProbeContext;

  constructor(factory: CanvasFactory = defaultCanvasFactory) {
    this.factory = factory;
    this.probe = new ProbeContext(factory);
  }

  private ensure(style: TextStyle, dpr: number): void {
    const key = `${style.font}|${style.color}|${style.glow ?? ''}|${style.stroke ?? ''}|${dpr}`;
    if (this.strip && this.stripKey === key) return;
    const px = fontPx(style.font);
    const blur = style.glow ? (style.glowBlur ?? px * 0.25) : 0;
    const sw = style.stroke ? (style.strokeWidth ?? Math.max(1, px * 0.08)) : 0;
    const probe = this.probe.get();
    let w = px * 0.62;
    let ascent = px * 0.72;
    let descent = px * 0.02;
    if (probe) {
      probe.font = style.font;
      for (let d = 0; d < 10; d++) {
        const ink = measureInk(probe, String(d), px);
        if (ink.width > w) w = ink.width;
        if (ink.ascent > ascent) ascent = ink.ascent;
        if (ink.descent > descent) descent = ink.descent;
      }
    }
    // Padding must cover everything painted outside the glyph box (glow + stroke) so a cell blit
    // never carries a neighbouring digit's ink. It is padding, not pitch: the layout advance
    // (`advW`) and the roll pitch (`glyphH`) both stay tight to the glyphs.
    const pad = Math.ceil(blur + sw + 1);
    this.glyphH = Math.max(1, Math.ceil(ascent + descent));
    this.advW = Math.ceil(w + px * 0.1);
    this.cellW = this.advW + pad * 2;
    this.cellH = this.glyphH + pad * 2;
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
    ctx.textBaseline = 'alphabetic';
    if (style.glow) {
      ctx.shadowColor = style.glow;
      ctx.shadowBlur = blur;
    }
    // Ink box of cell d spans [d*cellH + padY, d*cellH + padY + glyphH], i.e. it is centred in the
    // cell, so a cell blit positioned by its glyph centre lands the glyph exactly on that centre.
    for (let d = 0; d < 10; d++) {
      const baseline = this.cellH * d + pad + ascent;
      if (style.stroke) {
        ctx.lineJoin = 'round';
        ctx.lineWidth = sw * 2;
        ctx.strokeStyle = style.stroke;
        ctx.strokeText(String(d), this.cellW / 2, baseline);
      }
      ctx.fillStyle = style.color;
      ctx.fillText(String(d), this.cellW / 2, baseline);
    }
    this.strip = canvas;
    this.stripKey = key;
  }

  /** Digit advance (layout pitch) in logical px (after ensure). */
  get digitWidth(): number {
    return this.advW;
  }

  /** Roll pitch / visible window height in logical px (after ensure). */
  get digitHeight(): number {
    return this.glyphH;
  }

  /**
   * Draw `value` right-aligned at (rightX, centerY) with at least `minDigits` digits.
   * Fractional values roll the affected digits. Returns total width drawn.
   */
  draw(ctx: Ctx2D, value: number, rightX: number, centerY: number, style: TextStyle, minDigits = 6, dpr = 1): number {
    this.ensure(style, dpr);
    const v = Number.isFinite(value) ? Math.max(0, value) : 0;
    const intPart = Math.floor(v);
    const digits = Math.max(minDigits, String(intPart).length);
    const aw = this.advW;
    const cw = this.cellW;
    const ch = this.cellH;
    const gh = this.glyphH;
    if (!this.strip) {
      ctx.save();
      ctx.font = style.font;
      ctx.fillStyle = style.color;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(intPart).padStart(minDigits, '0'), rightX, centerY);
      ctx.restore();
      return aw * digits;
    }
    const strip = this.strip as unknown as CanvasImageSource;
    const sdpr = this.stripDpr;
    // Fractional roll: the lowest digit rolls by frac; higher digits roll only while lower ones wrap 9→0.
    const frac = v - intPart;
    let carry = frac;
    let pow = 1;
    for (let i = 0; i < digits; i++) {
      const digit = Math.floor(intPart / pow) % 10;
      const roll = carry; // 0..1 offset toward digit+1
      // Cell blits are centred on the digit's advance box, so the padding never shifts the layout.
      const cx = rightX - aw * (i + 0.5);
      const x = cx - cw / 2;
      if (roll > 0.0001) {
        // Rolling: clip to exactly one glyph height (full cell width, so the halo stays intact
        // sideways) and scroll two contiguous glyphs through it.
        const offset = roll * gh;
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, centerY - gh / 2, cw, gh);
        ctx.clip();
        ctx.drawImage(strip, 0, digit * ch * sdpr, cw * sdpr, ch * sdpr, x, centerY - ch / 2 - offset, cw, ch);
        const next = (digit + 1) % 10;
        ctx.drawImage(strip, 0, next * ch * sdpr, cw * sdpr, ch * sdpr, x, centerY - ch / 2 - offset + gh, cw, ch);
        ctx.restore();
      } else {
        ctx.drawImage(strip, 0, digit * ch * sdpr, cw * sdpr, ch * sdpr, x, centerY - ch / 2, cw, ch);
      }
      carry = digit === 9 ? carry : 0;
      pow *= 10;
    }
    return aw * digits;
  }
}
