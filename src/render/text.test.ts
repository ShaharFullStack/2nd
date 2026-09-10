import { describe, expect, it } from 'vitest';
import { createMockCanvas, mockCanvasFactory, type MockCanvas } from './canvasMock';
import { GH_PALETTE, HIGH_CONTRAST_PALETTE, hexToRgb, laneColor, mixHex, movementLabel, multiplierTier, withAlpha } from './palette';
import { SpriteCache } from './sprites';
import { DigitRoller, TextCache, fontPx } from './text';

describe('palette', () => {
  it('follows GH order and wraps', () => {
    expect(laneColor(GH_PALETTE, 0).name).toBe('green');
    expect(laneColor(GH_PALETTE, 1).name).toBe('red');
    expect(laneColor(GH_PALETTE, 2).name).toBe('yellow');
    expect(laneColor(GH_PALETTE, 3).name).toBe('blue');
    expect(laneColor(GH_PALETTE, 5).name).toBe('green');
    expect(HIGH_CONTRAST_PALETTE.lanes.length).toBeGreaterThanOrEqual(4);
  });

  it('colour helpers', () => {
    expect(hexToRgb('#ff0080')).toEqual([255, 0, 128]);
    expect(hexToRgb('#fff')).toEqual([255, 255, 255]);
    expect(hexToRgb('garbage')).toEqual([255, 255, 255]);
    expect(withAlpha('#ff0000', 0.5)).toBe('rgba(255,0,0,0.500)');
    expect(withAlpha('#ff0000', 7)).toBe('rgba(255,0,0,1.000)');
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(mixHex('#000000', '#ffffff', 0)).toBe('#000000');
  });

  it('labels and tiers', () => {
    expect(movementLabel('seated_march', 'left')).toBe('L knee lift');
    expect(movementLabel('finger_opposition', 'right')).toBe('R pinch');
    expect(multiplierTier(1).label).toBe('x1');
    expect(multiplierTier(4).label).toBe('x4');
    expect(multiplierTier(6).label).toBe('x6');
    expect(multiplierTier(6).color).toBe(multiplierTier(4).color);
    expect(multiplierTier(0).label).toBe('x1');
  });
});

describe('TextCache', () => {
  it('rasterizes once and reuses the sprite (LRU bounded)', () => {
    const created: MockCanvas[] = [];
    const cache = new TextCache(mockCanvasFactory(created), 8);
    const style = { font: '700 20px sans-serif', color: '#fff', glow: '#f00' };
    const a = cache.get('hello', style);
    const b = cache.get('hello', style);
    expect(a).toBe(b);
    expect(cache.size).toBe(1);
    expect(a!.textWidth).toBe(5 * 8);
    // glow → shadowBlur was set on the sprite context while rasterizing
    const sprite = created[created.length - 1];
    expect(sprite.ctx.count('fillText')).toBeGreaterThanOrEqual(3);
    for (let i = 0; i < 20; i++) cache.get(`t${i}`, style);
    expect(cache.size).toBeLessThanOrEqual(8);
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it('draw() blits with alignment and scale', () => {
    const main = createMockCanvas(200, 100);
    const cache = new TextCache(mockCanvasFactory());
    const style = { font: '16px sans-serif', color: '#fff' };
    const w = cache.draw(main.ctx as unknown as CanvasRenderingContext2D, 'abc', 50, 50, style, 2, 0.5, 'left');
    expect(w).toBe(24 * 2);
    const blit = main.ctx.calls.find((c) => c.name === 'drawImage');
    expect(blit).toBeDefined();
    const [, dx, , dw] = blit!.args as [unknown, number, number, number];
    // left aligned: text starts at x=50 (sprite has padding so dx is a bit left)
    expect(dx).toBeLessThan(50);
    expect(dx + dw / 2).toBeGreaterThan(50);
    expect(main.ctx.props.globalAlpha).toBe(1); // restored
  });

  it('falls back to fillText when no scratch context is available', () => {
    const main = createMockCanvas(200, 100);
    const cache = new TextCache(() => ({ width: 1, height: 1, getContext: () => null }));
    cache.draw(main.ctx as unknown as CanvasRenderingContext2D, 'x', 0, 0, { font: '10px a', color: '#fff' });
    expect(main.ctx.count('fillText')).toBe(1);
  });

  it('fontPx parses px sizes', () => {
    expect(fontPx('italic 900 34px foo')).toBe(34);
    expect(fontPx('bold serif')).toBe(16);
  });
});

describe('DigitRoller', () => {
  const STYLE = { font: '800 30px sans-serif', color: '#fff', glow: '#7fa0ff', glowBlur: 10 };

  it('draws one strip blit per digit, two while a digit rolls', () => {
    const main = createMockCanvas(400, 100);
    const roller = new DigitRoller(mockCanvasFactory());
    roller.draw(main.ctx as unknown as CanvasRenderingContext2D, 1234, 380, 50, STYLE, 6, 1);
    expect(main.ctx.count('drawImage')).toBe(6);
    // A settled value is not clipped at all, so its glow is intact.
    expect(main.ctx.count('clip')).toBe(0);
    main.ctx.reset();
    roller.draw(main.ctx as unknown as CanvasRenderingContext2D, 1234.5, 380, 50, STYLE, 6, 1);
    expect(main.ctx.count('drawImage')).toBe(7);
    expect(main.ctx.count('clip')).toBe(1); // only the rolling digit is clipped
    main.ctx.reset();
    // 1239.5 → the 9 rolls to 0 and carries into the tens digit.
    roller.draw(main.ctx as unknown as CanvasRenderingContext2D, 1239.5, 380, 50, STYLE, 6, 1);
    expect(main.ctx.count('drawImage')).toBe(8);
    expect(main.ctx.count('clip')).toBe(2);
    expect(roller.digitWidth).toBeGreaterThan(0);
    expect(roller.digitHeight).toBeGreaterThan(0);
  });

  /**
   * The regression this exists for: the strip used to be laid out on a padded cell pitch while the
   * roll scrolled by that same pitch, so mid-roll the one-cell window showed the tail of the
   * outgoing digit, a blank band as tall as a third of the glyph, and then the head of the incoming
   * one. It read as a rendering fault, and since the score lerps toward its target the ones digit is
   * mid-roll for most of a song. Assert the ink of the two glyphs covers the window at every phase.
   */
  it('keeps the digit column continuously covered through a full 0→1 roll', () => {
    const roller = new DigitRoller(mockCanvasFactory());
    for (let phase = 0; phase <= 1.0001; phase += 0.02) {
      const main = createMockCanvas(400, 100);
      const ctx = main.ctx as unknown as CanvasRenderingContext2D;
      roller.draw(ctx, 1234 + phase, 380, 50, STYLE, 6, 1);
      const gh = roller.digitHeight;
      const winTop = 50 - gh / 2;
      const winBottom = 50 + gh / 2;
      // The rolling digit is the last-drawn column: collect its glyph spans. A cell blit's ink box
      // is the middle `gh` of the `dh`-tall cell.
      const blits = main.ctx.calls.filter((c) => c.name === 'drawImage') as Array<{ args: number[] }>;
      const rolling = blits.filter((b) => Math.abs(b.args[5] - (380 - roller.digitWidth * 0.5 - b.args[7] / 2)) < 0.001);
      const spans = rolling.map((b) => {
        const dy = b.args[6];
        const dh = b.args[8];
        const pad = (dh - gh) / 2;
        return [dy + pad, dy + pad + gh] as const;
      });
      // Union of the ink spans must cover the whole window with no gap.
      spans.sort((a, b) => a[0] - b[0]);
      let covered = winTop;
      for (const [a, b] of spans) {
        if (a > covered + 0.001) break; // gap
        covered = Math.max(covered, b);
      }
      expect(covered, `phase ${phase.toFixed(2)}: covered to ${covered} of ${winBottom}`).toBeGreaterThanOrEqual(winBottom - 0.001);
    }
  });

  it('lays digits out on a tight advance, unaffected by glow padding', () => {
    const plain = new DigitRoller(mockCanvasFactory());
    const glowy = new DigitRoller(mockCanvasFactory());
    const main = createMockCanvas(400, 100);
    const ctx = main.ctx as unknown as CanvasRenderingContext2D;
    plain.draw(ctx, 42, 380, 50, { font: '800 30px sans-serif', color: '#fff' }, 4, 1);
    glowy.draw(ctx, 42, 380, 50, STYLE, 4, 1);
    expect(glowy.digitWidth).toBe(plain.digitWidth);
    expect(glowy.digitHeight).toBe(plain.digitHeight);
  });

  it('ignores a non-finite value instead of rendering NaN digits', () => {
    const main = createMockCanvas(400, 100);
    const roller = new DigitRoller(mockCanvasFactory());
    expect(() => roller.draw(main.ctx as unknown as CanvasRenderingContext2D, Number.NaN, 380, 50, STYLE, 6, 1)).not.toThrow();
    expect(main.ctx.count('drawImage')).toBe(6);
  });
});

describe('TextCache.fit', () => {
  it('leaves text that fits alone and ellipsizes what does not', () => {
    const cache = new TextCache(mockCanvasFactory());
    const style = { font: '700 11px sans-serif', color: '#fff' }; // mock: 8 px per character
    expect(cache.measure('L knee lift', style)).toBe(11 * 8);
    expect(cache.fit('L knee lift', style, 200)).toBe('L knee lift');
    const cut = cache.fit('L knee lift', style, 48);
    expect(cut.endsWith('…')).toBe(true);
    expect(cache.measure(cut, style)).toBeLessThanOrEqual(48);
    expect(cache.fit('L knee lift', style, 0)).toBe('');
  });
});

describe('SpriteCache', () => {
  it('buckets gem sizes and caches per colour', () => {
    const created: MockCanvas[] = [];
    const cache = new SpriteCache(mockCanvasFactory(created));
    cache.setRadiusRange(5, 40, 1);
    const a = cache.gem(GH_PALETTE.lanes[0], 20);
    const b = cache.gem(GH_PALETTE.lanes[0], 20.5);
    const c = cache.gem(GH_PALETTE.lanes[1], 20);
    expect(a).not.toBeNull();
    expect(a!.sprite).toBe(b!.sprite);
    expect(a!.sprite).not.toBe(c!.sprite);
    expect(cache.size).toBe(2);
    expect(Math.abs(a!.radius - 20)).toBeLessThan(2);
    // Gem rendering uses gradients + ellipses + a shadow, all baked in offscreen.
    const gemCanvas = a!.sprite.canvas as MockCanvas;
    expect(gemCanvas.ctx.count('createRadialGradient')).toBeGreaterThanOrEqual(3);
    expect(gemCanvas.ctx.count('ellipse')).toBeGreaterThanOrEqual(4);
    expect(cache.glow('#ffffff')).not.toBeNull();
    expect(cache.receptor(GH_PALETTE.lanes[2], 30)).not.toBeNull();
    expect(cache.size).toBe(4);
    // Changing the range invalidates.
    cache.setRadiusRange(6, 50, 2);
    expect(cache.size).toBe(0);
  });

  it('gemSprite/bucketedRadius are the allocation-free hot-path form of gem()', () => {
    const cache = new SpriteCache(mockCanvasFactory());
    cache.setRadiusRange(5, 40, 1);
    const color = GH_PALETTE.lanes[1];
    const wrapped = cache.gem(color, 17);
    const direct = cache.gemSprite(color, 17);
    expect(direct).toBe(wrapped!.sprite);
    expect(cache.bucketedRadius(17)).toBe(wrapped!.radius);
    // Repeated lookups hit the cache and never rasterize again.
    const before = cache.size;
    for (let i = 0; i < 50; i++) {
      cache.gemSprite(color, 17);
      cache.receptor(color, 30);
      cache.glow(color.glow, 64);
      cache.beam(color.glow, 128, 256);
    }
    expect(cache.size).toBe(before + 3);
  });
});

describe('multiplierTier caching', () => {
  it('returns a stable object per tier instead of allocating above x4', () => {
    expect(multiplierTier(2)).toBe(multiplierTier(2));
    expect(multiplierTier(6)).toBe(multiplierTier(6));
    expect(multiplierTier(6).label).toBe('x6');
    expect(multiplierTier(6).color).toBe(multiplierTier(4).color);
    expect(multiplierTier(Number.NaN).label).toBe('x1');
    expect(multiplierTier(1e9).label).toBe('x99');
  });
});
