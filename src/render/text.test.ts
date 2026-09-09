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
  it('draws one strip blit per digit, two while a digit rolls', () => {
    const main = createMockCanvas(400, 100);
    const roller = new DigitRoller(mockCanvasFactory());
    const style = { font: '800 30px sans-serif', color: '#fff' };
    roller.draw(main.ctx as unknown as CanvasRenderingContext2D, 1234, 380, 50, style, 6, 1);
    expect(main.ctx.count('drawImage')).toBe(6);
    expect(main.ctx.count('clip')).toBe(1);
    main.ctx.reset();
    roller.draw(main.ctx as unknown as CanvasRenderingContext2D, 1234.5, 380, 50, style, 6, 1);
    expect(main.ctx.count('drawImage')).toBe(7);
    main.ctx.reset();
    // 1239.5 → the 9 rolls to 0 and carries into the tens digit.
    roller.draw(main.ctx as unknown as CanvasRenderingContext2D, 1239.5, 380, 50, style, 6, 1);
    expect(main.ctx.count('drawImage')).toBe(8);
    expect(roller.digitWidth).toBeGreaterThan(0);
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
});
