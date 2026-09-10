import { describe, expect, it, vi } from 'vitest';
import type { HitEvent, LaneSpec } from '../engine/types';
import { DEFAULT_HIGHWAY_OPTIONS, Highway, MISS_CUE_MARGIN_U, POPUP_MAX_RISE_FRAC, makeFrame } from './Highway';
import { createMockCanvas, mockCanvasFactory, type MockCanvas } from './canvasMock';
import { runDemo } from './demo';
import { FAR_FADE_FRAC, GEM_ASPECT, laneX, roadEdgeX, visibleTailSec, yAt } from './geometry';
import { GH_PALETTE, HIGH_CONTRAST_PALETTE, hexToRgb } from './palette';
import { TextCache, type Ctx2D } from './text';
import type { CanvasLike, RenderFrame, RenderNote } from './types';

/** Mirrors of the receptor's private drawing constants (Highway.ts). */
const METER_WELL = '#080a12';
const WHITE = '#ffffff';
const METER_TARGET_POS = 0.76;
/** Ceiling on a locked lane's column, as a fraction of the target height (Highway.LOCK_LEVEL_CEIL). */
const LOCK_LEVEL_CEIL = 0.9;
/** A locked receptor's ring — and with it its whole gauge — is drawn 12 % smaller (Highway pulse). */
const LOCK_RING_SCALE = 0.88;
/** Drain cap / re-arm line / chevron / return-to-rest arc — violet, a hue no lane palette contains. */
const LOCK_HINT = '#c08cff';

const LANES: LaneSpec[] = [
  { index: 0, movement: 'seated_march', side: 'left' },
  { index: 1, movement: 'seated_march', side: 'right' },
  { index: 2, movement: 'knee_extension', side: 'left' },
  { index: 3, movement: 'knee_extension', side: 'right' },
];

function setup(width = 1280, height = 720, opts: Record<string, unknown> = {}): { canvas: MockCanvas; hw: Highway; scratch: MockCanvas[] } {
  const canvas = createMockCanvas(width, height);
  const scratch: MockCanvas[] = [];
  const hw = new Highway(canvas, { createCanvas: mockCanvasFactory(scratch), ...opts });
  return { canvas, hw, scratch };
}

function notesAround(songTime: number, approach: number): RenderNote[] {
  const out: RenderNote[] = [];
  let id = 1;
  for (let i = 0; i < 12; i++) {
    out.push({ id: id++, lane: i % 4, time: songTime + (i / 12) * approach, state: 'pending' });
  }
  return out;
}

describe('Highway construction / resize', () => {
  it('sizes the backing store by DPR and rebuilds geometry', () => {
    const { canvas, hw } = setup(1000, 500);
    hw.resize(1000, 500, 2);
    expect(canvas.width).toBe(2000);
    expect(canvas.height).toBe(1000);
    expect(hw.geometry.width).toBe(1000);
    expect(hw.geometry.height).toBe(500);
    expect(hw.geometry.strikeY).toBeCloseTo(DEFAULT_HIGHWAY_OPTIONS.strikeY * 500);
  });

  it('reads clientWidth/clientHeight when no size given', () => {
    const { canvas, hw } = setup(640, 360);
    hw.resize(undefined, undefined, 1);
    expect(canvas.width).toBe(640);
    expect(hw.geometry.width).toBe(640);
  });

  it('is idempotent for a canvas without CSS sizing (never re-multiplies the backing store by DPR)', () => {
    const canvas = createMockCanvas(300, 150);
    canvas.clientWidth = 0;
    canvas.clientHeight = 0;
    // Constructed at DPR 1 (jsdom): attribute size is the backing store → logical 300x150.
    const hw = new Highway(canvas, { createCanvas: mockCanvasFactory() });
    expect(hw.size).toEqual({ width: 300, height: 150, dpr: 1 });
    expect(canvas.width).toBe(300);
    // DPR changes to 2: the logical size is kept, the backing store becomes 600 — once.
    hw.resize(undefined, undefined, 2);
    hw.resize(undefined, undefined, 2);
    hw.resize(undefined, undefined, 2);
    hw.resize();
    hw.resize(undefined, undefined, 2);
    expect(canvas.width).toBe(600);
    expect(canvas.height).toBe(300);
    expect(hw.geometry.width).toBe(300);
    expect(hw.size).toEqual({ width: 300, height: 150, dpr: 2 });
    // Explicit logical size wins and stays stable across further no-arg calls.
    hw.resize(200, 100, 2);
    hw.resize(undefined, undefined, 2);
    hw.resize(undefined, undefined, 2);
    expect(canvas.width).toBe(400);
    expect(hw.geometry.width).toBe(200);
  });

  it('accepts an OffscreenCanvas-like target (no client size) on a DPR 2 main thread without double scaling', () => {
    const desc = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio');
    Object.defineProperty(window, 'devicePixelRatio', { value: 2, configurable: true, writable: true });
    try {
      const canvas = createMockCanvas(1920, 1080);
      canvas.clientWidth = 0;
      canvas.clientHeight = 0;
      const hw = new Highway(canvas, { createCanvas: mockCanvasFactory() });
      hw.resize();
      hw.resize();
      expect(canvas.width).toBe(1920);
      expect(canvas.height).toBe(1080);
      expect(hw.size).toEqual({ width: 960, height: 540, dpr: 2 });
      expect(hw.geometry.width).toBe(960);
      expect(() => hw.draw(makeFrame({ lanes: LANES }))).not.toThrow();
    } finally {
      if (desc) Object.defineProperty(window, 'devicePixelRatio', desc);
    }
  });

  it('accepts LaneState objects straight from an InputSource (tracking optional, extra lane field)', () => {
    const { hw } = setup();
    const laneStates = LANES.map((l) => ({ lane: l.index, value: 0.3, armed: true }));
    expect(() => hw.draw(makeFrame({ lanes: LANES, laneStates }))).not.toThrow();
  });

  it('pre-renders background layers into scratch canvases', () => {
    const { scratch } = setup();
    // The baked venue (gradient, haze, stage wash, truss, PA stacks) + the crowd band.
    expect(scratch.length).toBeGreaterThanOrEqual(2);
    const bg = scratch[0];
    expect(bg.ctx.count('fillRect')).toBeGreaterThan(0);
    expect(bg.ctx.count('createLinearGradient')).toBeGreaterThan(0);
  });

  it('exposes options and lets them be changed at runtime', () => {
    const { hw } = setup();
    expect(hw.options.approachSec).toBe(DEFAULT_HIGHWAY_OPTIONS.approachSec);
    hw.setOptions({ approachSec: 2.2, highContrast: true });
    expect(hw.geometry.approachSec).toBe(2.2);
    expect(hw.options.highContrast).toBe(true);
  });
});

describe('Highway.draw', () => {
  it('does not throw on an empty frame and issues the core call families', () => {
    const { canvas, hw } = setup();
    hw.resize(1280, 720, 1);
    canvas.ctx.reset();
    const frame = makeFrame({ lanes: LANES, songTime: 3, bpm: 120, beatPhase: 0.25 });
    expect(() => hw.draw(frame)).not.toThrow();
    const names = canvas.ctx.names();
    // DPR transform, background blit, road fill, beat lines, strike line, gauge arcs, receptor sprites.
    // (No `clip` here on purpose: an idle frame has no receptor meter fill and a settled score is
    // drawn unclipped, so clipping is asserted where it is actually used — see the meter test.)
    for (const n of ['setTransform', 'drawImage', 'fill', 'stroke', 'beginPath', 'moveTo', 'lineTo', 'arc', 'createLinearGradient']) {
      expect(names.has(n), `expected ${n} to be called`).toBe(true);
    }
    const stats = hw.getStats();
    expect(stats.frames).toBe(1);
    expect(stats.notesDrawn).toBe(0);
    expect(stats.drawMs).toBeGreaterThanOrEqual(0);
  });

  it('draws visible notes as sprite blits (drawImage) and culls off-screen ones', () => {
    const { canvas, hw } = setup();
    hw.resize(1280, 720, 1);
    const approach = hw.geometry.approachSec;
    const notes = notesAround(10, approach);
    // Off-screen notes: far future and long past, plus a hit note that must not be drawn.
    notes.push({ id: 900, lane: 0, time: 10 + approach * 3, state: 'pending' });
    notes.push({ id: 901, lane: 1, time: 10 - 5, state: 'pending' });
    notes.push({ id: 902, lane: 2, time: 10 + 0.3, state: 'hit', judgment: 'perfect' });
    const frame = makeFrame({ lanes: LANES, songTime: 10, notes });
    canvas.ctx.reset();
    hw.draw(frame);
    expect(hw.getStats().notesDrawn).toBe(12);
    const before = canvas.ctx.count('drawImage');
    // A frame with no notes draws strictly fewer images.
    canvas.ctx.reset();
    hw.draw(makeFrame({ lanes: LANES, songTime: 10.001 }));
    expect(canvas.ctx.count('drawImage')).toBeLessThan(before);
    expect(before - canvas.ctx.count('drawImage')).toBeGreaterThanOrEqual(12);
  });

  it('blits notes at the projected lane x / strike y when the note time equals songTime', () => {
    const { canvas, hw } = setup();
    hw.resize(1280, 720, 1);
    hw.draw(makeFrame({ lanes: LANES, songTime: 0 }));
    canvas.ctx.reset();
    const frame = makeFrame({ lanes: LANES, songTime: 5, notes: [{ id: 1, lane: 2, time: 5, state: 'pending' }] });
    hw.draw(frame);
    const g = hw.geometry;
    const expectedX = laneX(g, 2, 0);
    // Find a drawImage whose destination rect is centred on the gem anchor (x ± few px, y near strike).
    const blits = canvas.ctx.calls.filter((c) => c.name === 'drawImage' && c.args.length === 5);
    const hit = blits.some((c) => {
      const [, dx, dy, dw, dh] = c.args as [unknown, number, number, number, number];
      const cx = dx + dw / 2;
      return Math.abs(cx - expectedX) < 2 && dy < g.strikeY && dy + dh > g.strikeY;
    });
    expect(hit).toBe(true);
  });

  it('spawns particles and popups for new hit events (deduped by noteId)', () => {
    const { canvas, hw } = setup();
    hw.resize(1280, 720, 1);
    hw.draw(makeFrame({ lanes: LANES, songTime: 1 }));
    const hits: HitEvent[] = [
      { noteId: 1, lane: 0, judgment: 'perfect', deltaMs: 5, time: 1.0 },
      { noteId: 2, lane: 3, judgment: 'good', deltaMs: 60, time: 1.01 },
    ];
    canvas.ctx.reset();
    hw.draw(makeFrame({ lanes: LANES, songTime: 1.02, recentHits: hits, combo: 2 }));
    const s1 = hw.getStats();
    expect(s1.particles).toBeGreaterThan(20);
    // Ring shockwave + particle streaks → ellipse strokes and lighter compositing.
    expect(canvas.ctx.count('ellipse')).toBeGreaterThan(0);
    expect(canvas.ctx.calls.some((c) => c.name === 'drawImage')).toBe(true);
    const particlesAfterFirst = s1.particles;
    // Same events again: no new bursts.
    hw.draw(makeFrame({ lanes: LANES, songTime: 1.03, recentHits: hits, combo: 2 }));
    expect(hw.getStats().particles).toBeLessThanOrEqual(particlesAfterFirst);
    // Particles die out over time.
    for (let t = 1.05; t < 3; t += 0.05) hw.draw(makeFrame({ lanes: LANES, songTime: t, recentHits: [], combo: 2 }));
    expect(hw.getStats().particles).toBe(0);
  });

  it('misses spawn only a small grey puff (no hit burst) and tint the lane', () => {
    const { canvas, hw } = setup();
    hw.resize(1280, 720, 1);
    hw.draw(makeFrame({ lanes: LANES, songTime: 1 }));
    const miss: HitEvent[] = [{ noteId: 7, lane: 1, judgment: 'miss', deltaMs: 180, time: 1.18 }];
    hw.draw(makeFrame({ lanes: LANES, songTime: 1.28, recentHits: miss }));
    // A hit burst is 20+ particles; the miss puff is a handful.
    expect(hw.getStats().particles).toBeGreaterThan(0);
    expect(hw.getStats().particles).toBeLessThan(10);
    canvas.ctx.reset();
    hw.draw(makeFrame({ lanes: LANES, songTime: 1.3, recentHits: miss, notes: [{ id: 7, lane: 1, time: 1, state: 'miss', judgment: 'miss' }] }));
    // Lane flash fills a 4-point lane trapezoid.
    expect(canvas.ctx.count('closePath')).toBeGreaterThan(0);
    // The missed (grey) note is still drawn while it fizzles past the line...
    expect(hw.getStats().notesDrawn).toBe(1);
    // ...and is gone once the fizzle has run its course.
    hw.draw(makeFrame({ lanes: LANES, songTime: 1.3 + 0.5, notes: [{ id: 7, lane: 1, time: 1, state: 'miss', judgment: 'miss' }] }));
    expect(hw.getStats().notesDrawn).toBe(0);
  });

  it('keeps a pending gem visible until the engine can declare a miss and draws the miss fizzle then (engine timing)', () => {
    // Engine: miss declared at note.time + goodMs (110..180) + grace 100 = 210..280 ms; the miss
    // HitEvent carries time = note.time + goodMs and deltaMs = goodMs.
    for (const [w, h] of [
      [1280, 720],
      [1920, 1080],
      [720, 1280],
    ]) {
      for (const laneCount of [2, 3, 4]) {
        const { hw } = setup(w, h);
        hw.resize(w, h, 1);
        const lanes = LANES.slice(0, laneCount);
        hw.draw(makeFrame({ lanes, songTime: 9 }));
        expect(visibleTailSec(hw.geometry)).toBeGreaterThanOrEqual(0.4);
        const noteTime = 10;
        const pending: RenderNote = { id: 1, lane: laneCount - 1, time: noteTime, state: 'pending' };
        for (const dtMs of [0, 100, 150, 200, 250, 280]) {
          hw.draw(makeFrame({ lanes, songTime: noteTime + dtMs / 1000, notes: [pending] }));
          expect(hw.getStats().notesDrawn, `${w}x${h} lanes=${laneCount} pending +${dtMs}ms`).toBe(1);
        }
        // Engine flips it to miss at +280 ms.
        const missEv: HitEvent[] = [{ noteId: 1, lane: laneCount - 1, judgment: 'miss', deltaMs: 180, time: noteTime + 0.18 }];
        const missed: RenderNote = { ...pending, state: 'miss', judgment: 'miss' };
        hw.draw(makeFrame({ lanes, songTime: noteTime + 0.28, notes: [missed], recentHits: missEv }));
        expect(hw.getStats().notesDrawn, `${w}x${h} lanes=${laneCount} miss @+280ms`).toBe(1);
        // Still fizzling 150 ms after the verdict, gone 500 ms after it.
        hw.draw(makeFrame({ lanes, songTime: noteTime + 0.43, notes: [missed], recentHits: missEv }));
        expect(hw.getStats().notesDrawn).toBe(1);
        hw.draw(makeFrame({ lanes, songTime: noteTime + 0.78, notes: [missed] }));
        expect(hw.getStats().notesDrawn).toBe(0);
      }
    }
  });

  it('draws the lane tint on the very frame a judgment arrives, at every song time', () => {
    // Regression: storing the flash start time in a Float32Array rounded it *up* for about half of
    // all song times (fround(6.28) = 6.28000020980835), so `songTime - t0` came out negative on the
    // frame the flash was created and the "age < 0" branch cleared it before it ever drew — the
    // hit / miss lane tint silently vanished for those notes. The lane trapezoid is the one extra
    // closed path in the frame, so compare an identical frame with and without the event.
    const closedPaths = (songTime: number, hits: HitEvent[]): number => {
      const { canvas, hw } = setup(1280, 720);
      hw.resize(1280, 720, 1);
      hw.draw(makeFrame({ lanes: LANES, songTime: songTime - 0.1 }));
      canvas.ctx.reset();
      hw.draw(makeFrame({ lanes: LANES, songTime, recentHits: hits }));
      return canvas.ctx.count('closePath');
    };
    // 6.28 / 10.02 / 44.05 round up under Float32; 1.28 / 3.5 round down or are exact.
    for (const st of [6.28, 10.02, 44.05, 1.28, 3.5, 17.31]) {
      const miss: HitEvent[] = [{ noteId: 1, lane: 1, judgment: 'miss', deltaMs: 180, time: st - 0.1 }];
      const hit: HitEvent[] = [{ noteId: 2, lane: 2, judgment: 'perfect', deltaMs: 4, time: st }];
      expect(closedPaths(st, miss) - closedPaths(st, []), `miss lane tint at songTime ${st}`).toBe(1);
      expect(closedPaths(st, hit) - closedPaths(st, []), `hit lane flash at songTime ${st}`).toBe(1);
    }
    // ...and it keeps drawing on following frames until it expires (miss tint lasts ~0.45 s).
    const { canvas, hw } = setup(1280, 720);
    hw.resize(1280, 720, 1);
    hw.draw(makeFrame({ lanes: LANES, songTime: 6.18 }));
    const base = (() => {
      canvas.ctx.reset();
      hw.draw(makeFrame({ lanes: LANES, songTime: 6.2 }));
      return canvas.ctx.count('closePath');
    })();
    const miss: HitEvent[] = [{ noteId: 9, lane: 0, judgment: 'miss', deltaMs: 180, time: 6.18 }];
    for (const st of [6.28, 6.4, 6.6]) {
      canvas.ctx.reset();
      hw.draw(makeFrame({ lanes: LANES, songTime: st, recentHits: miss }));
      expect(canvas.ctx.count('closePath') - base, `miss tint still up at ${st}`).toBe(1);
    }
    // Expired (> 0.45 s after the verdict).
    canvas.ctx.reset();
    hw.draw(makeFrame({ lanes: LANES, songTime: 6.8, recentHits: miss }));
    expect(canvas.ctx.count('closePath') - base).toBe(0);
  });

  it('fizzles a miss note from the time the renderer first sees it even without a HitEvent', () => {
    const { hw } = setup();
    hw.resize(1280, 720, 1);
    hw.draw(makeFrame({ lanes: LANES, songTime: 5 }));
    const missed: RenderNote = { id: 3, lane: 0, time: 5, state: 'miss', judgment: 'miss' };
    hw.draw(makeFrame({ lanes: LANES, songTime: 5.25, notes: [missed] }));
    expect(hw.getStats().notesDrawn).toBe(1);
    hw.draw(makeFrame({ lanes: LANES, songTime: 5.45, notes: [missed] }));
    expect(hw.getStats().notesDrawn).toBe(1);
    hw.draw(makeFrame({ lanes: LANES, songTime: 5.8, notes: [missed] }));
    expect(hw.getStats().notesDrawn).toBe(0);
  });

  it('shows the neutral MISS popup only when showMissPopup is enabled', () => {
    const missEv: HitEvent[] = [{ noteId: 1, lane: 1, judgment: 'miss', deltaMs: 180, time: 2.18 }];
    const run = (showMissPopup: boolean): boolean => {
      const { hw, scratch } = setup(1280, 720, { showMissPopup });
      hw.resize(1280, 720, 1);
      hw.draw(makeFrame({ lanes: LANES, songTime: 2 }));
      hw.draw(makeFrame({ lanes: LANES, songTime: 2.28, recentHits: missEv }));
      return scratch.some((c) => c.ctx.calls.some((k) => k.name === 'fillText' && k.args[0] === 'MISS'));
    };
    expect(run(false)).toBe(false);
    expect(run(true)).toBe(true);
  });

  it('draws the combo counter off the note path (in the side panel) so popups cannot collide with it', () => {
    const { canvas, hw, scratch } = setup();
    hw.resize(1280, 720, 1);
    hw.draw(makeFrame({ lanes: LANES, songTime: 3, combo: 12 }));
    canvas.ctx.reset();
    hw.draw(makeFrame({ lanes: LANES, songTime: 3.02, combo: 12 }));
    // The combo is drawn as one sprite per digit; they are the only sprites in the combo font.
    const comboFont = /italic 900 \d+px/;
    const digitSprites = scratch.filter(
      (c) => comboFont.test(String(c.ctx.props.font)) && c.ctx.calls.some((k) => k.name === 'fillText' && (k.args[0] === '1' || k.args[0] === '2')),
    );
    expect(digitSprites.length).toBe(2);
    const blits = canvas.ctx.calls.filter((c) => c.name === 'drawImage' && digitSprites.includes(c.args[0] as MockCanvas));
    expect(blits.length).toBe(2);
    for (const b of blits) {
      const [, dx, , dw] = b.args as [unknown, number, number, number];
      expect(dx + dw / 2).toBeGreaterThan(roadEdgeX(hw.geometry, 1, 0));
    }
  });

  it('replays hit effects after a restart (auto-detected backward songTime jump) and after reset()', () => {
    const { hw } = setup();
    hw.resize(1280, 720, 1);
    const hits: HitEvent[] = [{ noteId: 1, lane: 0, judgment: 'perfect', deltaMs: 5, time: 10.0 }];
    hw.draw(makeFrame({ lanes: LANES, songTime: 9.9 }));
    hw.draw(makeFrame({ lanes: LANES, songTime: 10.02, recentHits: hits, combo: 1, score: 100 }));
    const first = hw.getStats().particles;
    expect(first).toBeGreaterThan(20);
    // Same song restarted with the same ids: songTime jumps back → effects fire again.
    hw.draw(makeFrame({ lanes: LANES, songTime: 0 }));
    expect(hw.getStats().particles).toBe(0);
    hw.draw(makeFrame({ lanes: LANES, songTime: 9.9 }));
    hw.draw(makeFrame({ lanes: LANES, songTime: 10.02, recentHits: hits, combo: 1, score: 100 }));
    expect(hw.getStats().particles).toBe(first);
    // Explicit reset() clears particles and de-dupe immediately, without a time jump.
    hw.reset();
    expect(hw.getStats().particles).toBe(0);
    hw.draw(makeFrame({ lanes: LANES, songTime: 10.03, recentHits: hits, combo: 1, score: 100 }));
    expect(hw.getStats().particles).toBe(first);
  });

  it('prunes the hit de-dupe map by time so ids can recur without growing memory', () => {
    const { hw } = setup();
    hw.resize(1280, 720, 1);
    const ev = (t: number): HitEvent[] => [{ noteId: 42, lane: 0, judgment: 'good', deltaMs: 10, time: t }];
    hw.draw(makeFrame({ lanes: LANES, songTime: 1 }));
    hw.draw(makeFrame({ lanes: LANES, songTime: 1.02, recentHits: ev(1) }));
    const burst = hw.getStats().particles;
    // Retention is `approachSec + 1` (a note can never be culled, forgotten and then resurrected
    // while still on screen), so wait past that before reusing the id.
    const later = 2 + hw.options.approachSec + 1;
    for (let t = 1.05; t < later; t += 0.05) hw.draw(makeFrame({ lanes: LANES, songTime: t }));
    expect(hw.getStats().particles).toBe(0);
    // Same note id a full retention window later (e.g. a chart that reuses ids per section) fires again.
    hw.draw(makeFrame({ lanes: LANES, songTime: later + 0.02, recentHits: ev(later) }));
    expect(hw.getStats().particles).toBe(burst);
  });

  it('fills the outer thirds with a venue: the crowd band spans the full width on every frame', () => {
    const { canvas, hw } = setup(1280, 720);
    hw.resize(1280, 720, 1);
    // The crowd band is the one backdrop layer that moves; it must be present (and full width) at
    // every song time, including a negative count-in, or the gutters are a gradient again.
    for (const t of [-3, -0.5, 0, 7.3, 200.1]) {
      canvas.ctx.reset();
      hw.draw(makeFrame({ lanes: LANES, songTime: t, beatPhase: 0 }));
      const band = canvas.ctx.calls.filter((c) => c.name === 'drawImage' && c.args.length === 5 && c.args[3] === 1280 && Math.abs((c.args[4] as number) - 720 * 0.2) < 1);
      expect(band.length, `t=${t}`).toBe(1);
      const y = band[0].args[2] as number;
      expect(y, `t=${t}`).toBeGreaterThan(0);
      expect(y + 720 * 0.2, `t=${t}`).toBeLessThanOrEqual(720);
    }
  });

  it('bobs the crowd on the beat and holds it still under reduced motion', () => {
    const bandY = (opts: Record<string, unknown>, beatPhase: number): number => {
      const { canvas, hw } = setup(1280, 720, opts);
      hw.resize(1280, 720, 1);
      canvas.ctx.reset();
      hw.draw(makeFrame({ lanes: LANES, songTime: 4, beatPhase }));
      const band = canvas.ctx.calls.find((c) => c.name === 'drawImage' && c.args.length === 5 && c.args[3] === 1280 && Math.abs((c.args[4] as number) - 144) < 1);
      expect(band).toBeDefined();
      return (band as { args: unknown[] }).args[2] as number;
    };
    // On the beat the band lifts; off the beat it sits back down.
    expect(bandY({}, 0)).toBeLessThan(bandY({}, 0.9));
    expect(bandY({ reducedMotion: true }, 0)).toBeCloseTo(bandY({ reducedMotion: true }, 0.9), 6);
  });

  it('re-sizes lane labels when the lane count changes on a reused instance', () => {
    // Small canvas: the label size is driven by lane width rather than the 22px cap.
    const { hw, scratch } = setup(640, 360);
    hw.resize(640, 360, 1);
    const fontFor = (): string => {
      const c = scratch.filter((s) => s.ctx.calls.some((k) => k.name === 'fillText' && k.args[0] === 'L knee lift')).pop();
      return String(c?.ctx.props.font);
    };
    hw.draw(makeFrame({ lanes: LANES, songTime: 1 }));
    const font4 = fontFor();
    hw.draw(makeFrame({ lanes: LANES.slice(0, 2), songTime: 1.02 }));
    const font2 = fontFor();
    expect(font4).toMatch(/px/);
    expect(font2).not.toBe(font4);
  });

  it('reports frame-interval stats (frameMs / fps / longFrames) in addition to draw time', () => {
    const { hw } = setup();
    for (let i = 0; i < 4; i++) hw.draw(makeFrame({ lanes: LANES, songTime: i * 0.016 }));
    const s = hw.getStats();
    expect(s.frameMs).toBeGreaterThanOrEqual(0);
    expect(s.avgFrameMs).toBeGreaterThanOrEqual(0);
    expect(s.fps).toBeGreaterThanOrEqual(0);
    expect(s.longFrames).toBeGreaterThanOrEqual(0);
    hw.resetStats();
    expect(hw.getStats().longFrames).toBe(0);
  });

  it('handles 2, 3 and 4 lanes and rebuilds geometry when lane count changes', () => {
    const { hw } = setup();
    hw.resize(1280, 720, 1);
    for (const n of [2, 3, 4, 3, 2]) {
      const lanes = LANES.slice(0, n);
      const frame = makeFrame({ lanes, songTime: 2, notes: notesAround(2, 1.6).filter((x) => x.lane < n) });
      expect(() => hw.draw(frame)).not.toThrow();
      expect(hw.geometry.laneCount).toBe(n);
    }
  });

  it('tolerates degenerate input (NaN bpm, empty lane states, out-of-range lane ids, huge combo)', () => {
    const { hw } = setup(320, 200);
    hw.resize(320, 200, 3);
    const frame: RenderFrame = {
      songTime: 100,
      notes: [
        { id: 1, lane: 9, time: 100.2, state: 'pending' },
        { id: 2, lane: -1, time: 100.2, state: 'pending' },
        { id: 3, lane: 0, time: 100.2, state: 'pending' },
      ],
      lanes: LANES.slice(0, 2),
      laneStates: [],
      combo: 99999,
      multiplier: 12,
      score: 1e9,
      health: 2,
      recentHits: [{ noteId: 55, lane: 9, judgment: 'perfect', deltaMs: 0, time: 100 }],
      bpm: Number.NaN,
      beatPhase: 1.5,
      energy: 3,
      thresholdFraction: 0,
    };
    expect(() => hw.draw(frame)).not.toThrow();
    expect(hw.getStats().notesDrawn).toBe(1);
  });

  it('draws HUD text via cached sprites (labels, score digits, title) and optional stats overlay', () => {
    const { canvas, hw, scratch } = setup(1280, 720, { showStats: true });
    hw.resize(1280, 720, 1);
    const before = scratch.length;
    canvas.ctx.reset();
    hw.draw(makeFrame({ lanes: LANES, songTime: 4, combo: 12, multiplier: 2, score: 12345, songTitle: 'Song', attribution: 'by someone' }));
    // Text sprites and digit strip were rasterized into scratch canvases...
    expect(scratch.length).toBeGreaterThan(before);
    const textCanvases = scratch.slice(before).filter((c) => c.ctx.count('fillText') > 0);
    expect(textCanvases.length).toBeGreaterThan(3);
    // ...and the main context only blits them (plus the stats overlay's direct fillText).
    expect(canvas.ctx.count('fillText')).toBe(1);
    // Second frame reuses cached sprites: no new scratch canvases.
    const after = scratch.length;
    hw.draw(makeFrame({ lanes: LANES, songTime: 4.02, combo: 12, multiplier: 2, score: 12345, songTitle: 'Song', attribution: 'by someone' }));
    expect(scratch.length).toBe(after);
    expect(hw.getStats().sprites).toBeGreaterThan(0);
  });

  it('receptor meter fill follows lane value (clip + fillRect), and the well is drawn even when empty', () => {
    const { canvas, hw } = setup();
    hw.resize(1280, 720, 1);
    const at = (t: number, value: number): void => {
      canvas.ctx.reset();
      hw.draw(makeFrame({ lanes: LANES, songTime: t, laneStates: LANES.map(() => ({ value, armed: true, tracking: true })), thresholdFraction: 0.6 }));
    };
    // One clip per lane, every frame: the gauge exists at rest too (an empty gauge is a reading).
    at(1, 0);
    expect(canvas.ctx.count('clip')).toBeGreaterThanOrEqual(4);
    expect(wellRect(canvas, hw, 0)).toBeDefined();
    expect(liquidRect(canvas, hw, 0)).toBeUndefined();
    // ...and liquid appears, rising, once there is a value.
    at(1.02, 0.2);
    const low = liquidRect(canvas, hw, 0);
    at(1.04, 0.5);
    const high = liquidRect(canvas, hw, 0);
    expect(low).toBeDefined();
    expect(high).toBeDefined();
    expect((high as MeterRect).y).toBeLessThan((low as MeterRect).y);
    expect((high as MeterRect).h).toBeGreaterThan((low as MeterRect).h);
  });

  it('keeps stats moving averages and resetStats clears max', () => {
    const { hw } = setup();
    for (let i = 0; i < 5; i++) hw.draw(makeFrame({ lanes: LANES, songTime: i * 0.016 }));
    const s = hw.getStats();
    expect(s.frames).toBe(5);
    expect(s.avgDrawMs).toBeGreaterThanOrEqual(0);
    hw.resetStats();
    expect(hw.getStats().maxDrawMs).toBe(0);
    expect(hw.getStats().frames).toBe(5);
  });

  it('is a no-op (no throw) when the canvas has no 2D context', () => {
    const canvas = createMockCanvas(100, 100);
    canvas.getContext = () => null;
    const hw = new Highway(canvas, { createCanvas: mockCanvasFactory() });
    expect(() => hw.draw(makeFrame({ lanes: LANES }))).not.toThrow();
    expect(hw.getStats().frames).toBe(0);
  });
});

describe('judgment feedback is never dropped', () => {
  // The renderer supports two integration shapes: HitEvents in `recentHits`, and the integrator
  // flipping `RenderNote.state` (+ `judgment`). In practice both happen, a frame apart, in either
  // order. Feedback must fire exactly once, whichever arrives first.
  const missEvent = (id: number, lane: number, noteTime: number): HitEvent[] => [
    { noteId: id, lane, judgment: 'miss', deltaMs: 180, time: noteTime + 0.18 },
  ];

  /** closePath count for the *last* frame drawn; the lane flash trapezoid is the one extra closed path. */
  function closedPaths(build: (hw: Highway) => void, final: (hw: Highway) => void): number {
    const { canvas, hw } = setup(1280, 720);
    hw.resize(1280, 720, 1);
    hw.draw(makeFrame({ lanes: LANES, songTime: 9.9 }));
    build(hw);
    canvas.ctx.reset();
    final(hw);
    return canvas.ctx.count('closePath');
  }

  it('fires the miss puff and lane tint when the state flip lands a frame BEFORE the event', () => {
    // Regression: the state-flip path used to write the note id into the same map processHits
    // de-dupes on, so the real miss event arriving one frame later was treated as already seen —
    // the red lane tint and the grey puff (the two loudest miss cues) never fired at all.
    const { hw } = setup();
    hw.resize(1280, 720, 1);
    const missed: RenderNote = { id: 5, lane: 1, time: 10, state: 'miss', judgment: 'miss' };
    hw.draw(makeFrame({ lanes: LANES, songTime: 9.9 }));
    // Frame 1: state already 'miss', recentHits still empty.
    hw.draw(makeFrame({ lanes: LANES, songTime: 10.28, notes: [missed] }));
    const afterFlip = hw.getStats().particles;
    expect(afterFlip, 'grey puff on the state-flip frame').toBeGreaterThan(0);
    // Frame 2: the engine's miss event finally shows up — no second puff, no silent frame.
    hw.draw(makeFrame({ lanes: LANES, songTime: 10.3, notes: [missed], recentHits: missEvent(5, 1, 10) }));
    expect(hw.getStats().particles, 'event must be de-duped, not replayed').toBeLessThanOrEqual(afterFlip);

    // The red lane tint is up on the state-flip frame and stays up when the event arrives.
    const noop = (): void => undefined;
    const base = closedPaths(noop, (hw2) => hw2.draw(makeFrame({ lanes: LANES, songTime: 10.28 })));
    const flip = closedPaths(noop, (hw2) => hw2.draw(makeFrame({ lanes: LANES, songTime: 10.28, notes: [missed] })));
    expect(flip - base, 'miss lane tint on the state-flip frame').toBe(1);
    const both = closedPaths(
      (hw2) => hw2.draw(makeFrame({ lanes: LANES, songTime: 10.28, notes: [missed] })),
      (hw2) => hw2.draw(makeFrame({ lanes: LANES, songTime: 10.3, notes: [missed], recentHits: missEvent(5, 1, 10) })),
    );
    const baseTwo = closedPaths(
      (hw2) => hw2.draw(makeFrame({ lanes: LANES, songTime: 10.28 })),
      (hw2) => hw2.draw(makeFrame({ lanes: LANES, songTime: 10.3 })),
    );
    expect(both - baseTwo, 'miss lane tint still up on the event frame').toBe(1);
  });

  it('fires miss feedback exactly once when the event lands BEFORE the state flip (either order)', () => {
    const { hw } = setup();
    hw.resize(1280, 720, 1);
    hw.draw(makeFrame({ lanes: LANES, songTime: 9.9 }));
    hw.draw(makeFrame({ lanes: LANES, songTime: 10.28, recentHits: missEvent(6, 2, 10) }));
    const afterEvent = hw.getStats().particles;
    expect(afterEvent).toBeGreaterThan(0);
    const missed: RenderNote = { id: 6, lane: 2, time: 10, state: 'miss', judgment: 'miss' };
    hw.draw(makeFrame({ lanes: LANES, songTime: 10.3, notes: [missed] }));
    expect(hw.getStats().particles).toBeLessThanOrEqual(afterEvent);
  });

  it('fires the hit burst from a state flip alone (no HitEvent ever) and reads RenderNote.judgment', () => {
    const burstFor = (judgment: 'perfect' | 'good'): number => {
      const { hw } = setup();
      hw.resize(1280, 720, 1);
      hw.draw(makeFrame({ lanes: LANES, songTime: 9.9 }));
      hw.draw(makeFrame({ lanes: LANES, songTime: 10.02, notes: [{ id: 8, lane: 0, time: 10, state: 'hit', judgment }] }));
      return hw.getStats().particles;
    };
    const good = burstFor('good');
    const perfect = burstFor('perfect');
    expect(good).toBeGreaterThan(15);
    // `judgment` has a visual consequence: a perfect throws more debris (plus the white core flash).
    expect(perfect).toBeGreaterThan(good);
  });

  it('never re-fires effects for a stale judged note left in the frame', () => {
    const { hw } = setup();
    hw.resize(1280, 720, 1);
    const stale: RenderNote = { id: 9, lane: 0, time: 10, state: 'hit', judgment: 'perfect' };
    hw.draw(makeFrame({ lanes: LANES, songTime: 9.9 }));
    // Handed to us 2 s after its note time: far outside the judgment window, so no burst.
    hw.draw(makeFrame({ lanes: LANES, songTime: 12, notes: [stale] }));
    expect(hw.getStats().particles).toBe(0);
    // ...and it keeps not firing frame after frame, including after the de-dupe map is pruned.
    for (let t = 12.02; t < 20; t += 0.05) hw.draw(makeFrame({ lanes: LANES, songTime: t, notes: [stale] }));
    expect(hw.getStats().particles).toBe(0);
  });

  it('shows exactly one judgment label at a time, however fast the hits come', () => {
    // Two PERFECT! labels on screen at once — one of them orphaned in empty lane space, or both
    // stacked over the receptor the patient is trying to read — was the defect all three blind
    // critics called a duplication bug. A new verdict retires the previous label; the combo, the
    // lane flash and the burst carry everything the second label would have said.
    const { canvas, hw, scratch } = setup();
    hw.resize(1280, 720, 1);
    hw.draw(makeFrame({ lanes: LANES, songTime: 1 }));
    hw.draw(makeFrame({ lanes: LANES, songTime: 1.02, recentHits: [{ noteId: 1, lane: 2, judgment: 'perfect', deltaMs: 3, time: 1.02 }] }));
    const countPopups = (): number => {
      const sprites = scratch.filter((c) => c.ctx.calls.some((k) => k.name === 'fillText' && k.args[0] === 'PERFECT!'));
      return canvas.ctx.calls.filter((c) => c.name === 'drawImage' && sprites.includes(c.args[0] as MockCanvas)).length;
    };
    canvas.ctx.reset();
    hw.draw(makeFrame({ lanes: LANES, songTime: 1.12 }));
    expect(countPopups(), 'the first label is up').toBe(1);
    // Same lane, an 8th note later (250 ms at 120 BPM) — well inside the old 750 ms lifetime.
    canvas.ctx.reset();
    hw.draw(makeFrame({ lanes: LANES, songTime: 1.27, recentHits: [{ noteId: 2, lane: 2, judgment: 'perfect', deltaMs: 3, time: 1.27 }] }));
    expect(countPopups(), 'one label, not two').toBe(1);
    // ...and a different lane replaces it just the same, rather than sitting beside it.
    canvas.ctx.reset();
    hw.draw(makeFrame({ lanes: LANES, songTime: 1.3, recentHits: [{ noteId: 3, lane: 0, judgment: 'perfect', deltaMs: 3, time: 1.3 }] }));
    expect(countPopups(), 'one label across lanes').toBe(1);
  });

  it('anchors the judgment label above the receptor ring it belongs to, never over it', () => {
    const { canvas, hw, scratch } = setup();
    hw.resize(1280, 720, 1);
    const g = hw.geometry;
    hw.draw(makeFrame({ lanes: LANES, songTime: 1 }));
    canvas.ctx.reset();
    hw.draw(makeFrame({ lanes: LANES, songTime: 1.02, recentHits: [{ noteId: 1, lane: 2, judgment: 'perfect', deltaMs: 3, time: 1.02 }] }));
    const sprites = scratch.filter((c) => c.ctx.calls.some((k) => k.name === 'fillText' && k.args[0] === 'PERFECT!'));
    const blit = canvas.ctx.calls.find((c) => c.name === 'drawImage' && sprites.includes(c.args[0] as MockCanvas));
    expect(blit).toBeDefined();
    const a = (blit as { args: unknown[] }).args as [unknown, number, number, number, number];
    // Bottom edge of the label clears the top of the receptor ring.
    expect(a[2] + a[4]).toBeLessThan(g.strikeY - g.receptorRadius * GEM_ASPECT);
    // ...and it is over the lane that was hit.
    expect(Math.abs(a[1] + a[3] / 2 - laneX(g, 2, 0))).toBeLessThan(g.laneWidthNear * 0.5);
  });
});

describe('the board reads as a shipped highway', () => {
  it('fades gems in over the far dissolve instead of popping them onto a hard edge', () => {
    const { canvas, hw } = setup(1920, 1080);
    hw.resize(1920, 1080, 1);
    const g = hw.geometry;
    const approach = hw.options.approachSec;
    const notes: RenderNote[] = [
      { id: 1, lane: 0, time: approach * 0.99, state: 'pending' }, // at the far edge
      { id: 2, lane: 1, time: approach * 0.4, state: 'pending' }, // well down the board
    ];
    canvas.ctx.reset();
    hw.draw(makeFrame({ lanes: LANES, songTime: 0, notes }));
    // Gem blits, identified by their y: the far one sits just under the horizon.
    const blits = canvas.ctx.calls.filter((c) => c.name === 'drawImage' && c.args.length === 5);
    const alphaAt = (yLo: number, yHi: number): number => {
      let a = -1;
      canvas.ctx.calls.forEach((c, i) => {
        if (!blits.includes(c)) return;
        const cy = (c.args[2] as number) + (c.args[4] as number) / 2;
        if (cy < yLo || cy > yHi) return;
        a = Math.max(a, canvas.ctx.propBefore(i, 'globalAlpha') as number);
      });
      return a;
    };
    const fadeEnd = g.horizonY + (g.strikeY - g.horizonY) * 0.16;
    const far = alphaAt(g.horizonY - 40, fadeEnd);
    const near = alphaAt(fadeEnd + 40, g.strikeY);
    expect(far, 'a gem at the far edge is nearly transparent').toBeGreaterThanOrEqual(0);
    expect(far).toBeLessThan(0.4);
    expect(near, 'a gem on the board proper is at full alpha').toBeCloseTo(1, 2);
  });

  it('keeps the HUD in the flanks: nothing it paints sits on the board', () => {
    // The song caption used to render straight through the multiplier badge in the bottom-left
    // corner, and the badge itself sat where the caption lived. Combo + multiplier are now one
    // group on the right flank, the rock meter is the whole of the left flank, and the board
    // between the rails belongs to the chart.
    const { canvas, hw, scratch } = setup(1920, 1080);
    hw.resize(1920, 1080, 1);
    const g = hw.geometry;
    canvas.ctx.reset();
    hw.draw(makeFrame({ lanes: LANES, songTime: 4, combo: 22, multiplier: 3, score: 3698, health: 0.8 }));
    const centreOf = (text: string): { x: number; y: number } | null => {
      const sprites = scratch.filter((c) => c.ctx.calls.some((k) => k.name === 'fillText' && k.args[0] === text));
      const blit = canvas.ctx.calls.find((c) => c.name === 'drawImage' && sprites.includes(c.args[0] as MockCanvas));
      if (!blit) return null;
      const a = blit.args as [unknown, number, number, number, number];
      return { x: a[1] + a[3] / 2, y: a[2] + a[4] / 2 };
    };
    const mult = centreOf('x3');
    const combo = centreOf('COMBO');
    const rock = centreOf('ROCK');
    expect(mult).not.toBeNull();
    expect(combo).not.toBeNull();
    expect(rock).not.toBeNull();
    const left = roadEdgeX(g, -1, 0);
    const right = roadEdgeX(g, 1, 0);
    expect((mult as { x: number }).x, 'multiplier badge is in the right flank').toBeGreaterThan(right);
    expect((combo as { x: number }).x, 'combo is in the right flank').toBeGreaterThan(right);
    expect((rock as { x: number }).x, 'rock meter is in the left flank').toBeLessThan(left);
    // Multiplier reads as part of the streak group, directly under the combo, not in a far corner.
    expect((mult as { y: number }).y).toBeGreaterThan((combo as { y: number }).y);
    expect((mult as { y: number }).y - (combo as { y: number }).y).toBeLessThan(g.height * 0.15);
  });
});

describe('runtime options actually take effect', () => {
  it('setOptions({maxParticles}) resizes the pool instead of silently doing nothing', () => {
    const { hw } = setup();
    hw.resize(1280, 720, 1);
    const hits: HitEvent[] = LANES.map((l, i) => ({ noteId: i + 1, lane: l.index, judgment: 'perfect' as const, deltaMs: 2, time: 1 }));
    hw.draw(makeFrame({ lanes: LANES, songTime: 1 }));
    hw.draw(makeFrame({ lanes: LANES, songTime: 1.02, recentHits: hits }));
    expect(hw.getStats().particles).toBeGreaterThan(50);
    hw.setOptions({ maxParticles: 10 });
    expect(hw.options.maxParticles).toBe(10);
    hw.reset();
    hw.draw(makeFrame({ lanes: LANES, songTime: 2 }));
    hw.draw(makeFrame({ lanes: LANES, songTime: 2.02, recentHits: hits.map((h) => ({ ...h, noteId: h.noteId + 100 })) }));
    expect(hw.getStats().particles).toBeLessThanOrEqual(10);
    expect(hw.getStats().particles).toBeGreaterThan(0);
  });

  it('setOptions re-bakes the pre-rendered background at the new horizon', () => {
    const { hw, scratch } = setup();
    hw.resize(1280, 720, 1);
    const hazeCentres = (from: number): number[] =>
      scratch
        .slice(from)
        .flatMap((c) => c.ctx.calls.filter((k) => k.name === 'createRadialGradient' && (k.args as number[])[3] === 640))
        .map((k) => (k.args as number[])[4]);
    expect(hazeCentres(0)).toContain(DEFAULT_HIGHWAY_OPTIONS.horizonY * 720);
    const before = scratch.length;
    hw.setOptions({ horizonY: 0.15 });
    expect(hw.geometry.horizonY).toBeCloseTo(0.15 * 720);
    // A fresh background layer was rasterized, with the haze at the new horizon (a stale layer left
    // a glow blob floating in the middle of the sky).
    expect(scratch.length).toBeGreaterThanOrEqual(before + 2);
    expect(hazeCentres(before)).toContain(0.15 * 720);
  });

  it('resize() with unchanged size/DPR is a no-op (no background re-bake, no cache wipe)', () => {
    const { hw, scratch } = setup(1920, 1080);
    hw.resize(1920, 1080, 1);
    hw.draw(makeFrame({ lanes: LANES, songTime: 1, songTitle: 'Song', score: 1234 }));
    const before = scratch.length;
    const spritesBefore = hw.getStats().sprites;
    for (let i = 0; i < 60; i++) hw.resize();
    for (let i = 0; i < 60; i++) hw.resize(1920, 1080, 1);
    expect(scratch.length, 'no scratch canvases allocated by redundant resizes').toBe(before);
    hw.draw(makeFrame({ lanes: LANES, songTime: 1.02, songTitle: 'Song', score: 1234 }));
    expect(hw.getStats().sprites).toBe(spritesBefore);
    // A real change still resizes.
    hw.resize(1600, 900, 1);
    expect(hw.geometry.width).toBe(1600);
    expect(scratch.length).toBeGreaterThan(before);
  });

  it('effectIntensity 0 keeps judgment feedback (ring, lane flash, popup) but stops the fireworks', () => {
    const run = (effectIntensity: number): { particles: number; popup: boolean; tint: number } => {
      const { canvas, hw, scratch } = setup(1280, 720, { effectIntensity });
      hw.resize(1280, 720, 1);
      hw.draw(makeFrame({ lanes: LANES, songTime: 1 }));
      canvas.ctx.reset();
      hw.draw(makeFrame({ lanes: LANES, songTime: 1.02, recentHits: [{ noteId: 1, lane: 0, judgment: 'perfect', deltaMs: 2, time: 1.02 }] }));
      const sprites = scratch.filter((c) => c.ctx.calls.some((k) => k.name === 'fillText' && k.args[0] === 'PERFECT!'));
      const blits = canvas.ctx.calls.filter((c) => c.name === 'drawImage' && sprites.includes(c.args[0] as MockCanvas));
      return { particles: hw.getStats().particles, popup: blits.length > 0, tint: canvas.ctx.count('closePath') };
    };
    const loud = run(1);
    const calm = run(0);
    expect(loud.particles).toBeGreaterThan(20);
    expect(calm.particles).toBeGreaterThan(0); // the shockwave ring survives
    expect(calm.particles).toBeLessThan(5);
    expect(calm.popup).toBe(true);
    expect(calm.tint).toBeGreaterThanOrEqual(loud.tint - 1); // lane flash trapezoid still drawn
  });

  it('reducedMotion freezes the sweeping stage rig and the beat pulse', () => {
    const angles = (reducedMotion: boolean): number[] => {
      const { canvas, hw } = setup(1280, 720, { reducedMotion });
      hw.resize(1280, 720, 1);
      const out: number[] = [];
      for (const t of [0, 0.5, 1.25]) {
        canvas.ctx.reset();
        hw.draw(makeFrame({ lanes: LANES, songTime: t, beatPhase: (t * 2) % 1 }));
        // Each beam is rotated about its hanging point; the first rotate of the frame is enough.
        const rot = canvas.ctx.calls.find((c) => c.name === 'rotate');
        expect(rot).toBeDefined();
        out.push((rot as { args: unknown[] }).args[0] as number);
      }
      return out;
    };
    const moving = angles(false);
    const still = angles(true);
    expect(new Set(still).size).toBe(1);
    expect(new Set(moving).size).toBeGreaterThan(1);
  });
});

describe('strike line', () => {
  it('draws the glow as a band spanning the whole board, not a stretched radial sprite', () => {
    // A single radial glow sprite stretched across the road is an ellipse: brightest at road
    // centre, dimmest at the outermost receptors. It must be a fill across the full road width.
    const { canvas, hw } = setup();
    hw.resize(1280, 720, 1);
    canvas.ctx.reset();
    hw.draw(makeFrame({ lanes: LANES, songTime: 2 }));
    const g = hw.geometry;
    const x0 = roadEdgeX(g, -1, 0);
    const x1 = roadEdgeX(g, 1, 0);
    const band = canvas.ctx.calls.filter((c) => {
      if (c.name !== 'fillRect') return false;
      const [x, y, w, h] = c.args as [number, number, number, number];
      return Math.abs(x - x0) < 1 && Math.abs(w - (x1 - x0)) < 1 && y < g.strikeY && y + h > g.strikeY;
    });
    expect(band.length).toBe(1);
    // ...drawn additively, and centred on the strike line.
    const i = canvas.ctx.calls.indexOf(band[0]);
    expect(canvas.ctx.propBefore(i, 'globalCompositeOperation')).toBe('lighter');
    const [, y, , h] = band[0].args as [number, number, number, number];
    expect(y + h / 2).toBeCloseTo(g.strikeY, 5);
  });
});

describe('particle rendering', () => {
  /**
   * Alphas applied to streak strokes in one frame. Streaks are stroked between the spark blits and
   * the ring shockwave's `ellipse`, so that window isolates them from the road/rail strokes.
   */
  function streakAlphas(calls: Array<{ name: string; args: unknown[] }>, propBefore: (i: number, p: string) => unknown): number[] {
    let ring = -1;
    for (let i = 0; i < calls.length; i++) {
      if (calls[i].name !== 'ellipse') continue;
      const next = calls.slice(i + 1).find((c) => !c.name.startsWith('set:'));
      if (next && next.name === 'stroke') {
        ring = i;
        break;
      }
    }
    if (ring < 0) return [];
    let lastBlit = -1;
    for (let i = 0; i < ring; i++) if (calls[i].name === 'drawImage') lastBlit = i;
    const out: number[] = [];
    for (let i = lastBlit + 1; i < ring; i++) if (calls[i].name === 'stroke') out.push(propBefore(i, 'globalAlpha') as number);
    return out;
  }

  it('fades streak particles over their life instead of burning at a constant alpha', () => {
    const { canvas, hw } = setup();
    hw.resize(1280, 720, 1);
    hw.draw(makeFrame({ lanes: LANES, songTime: 1 }));
    hw.draw(makeFrame({ lanes: LANES, songTime: 1.01, recentHits: [{ noteId: 1, lane: 0, judgment: 'perfect', deltaMs: 2, time: 1.01 }] }));
    const seen = new Set<number>();
    for (let t = 1.03; t < 1.5; t += 0.02) {
      canvas.ctx.reset();
      hw.draw(makeFrame({ lanes: LANES, songTime: t }));
      for (const a of streakAlphas(canvas.ctx.calls, canvas.ctx.propBefore)) {
        expect(a).toBeGreaterThan(0);
        expect(a).toBeLessThanOrEqual(0.85);
        seen.add(Number(a.toFixed(4)));
      }
    }
    // More than one alpha level over the burst's life, including a faded one near the end.
    expect(seen.size).toBeGreaterThan(1);
    expect(Math.min(...seen)).toBeLessThan(0.5);
  });
});

describe('TextCache allocation', () => {
  it('allocates one scratch canvas per new string after the shared probe exists', () => {
    const created: MockCanvas[] = [];
    const cache = new TextCache(mockCanvasFactory(created));
    const style = { font: '700 20px sans-serif', color: '#fff' };
    cache.get('1', style);
    const afterFirst = created.length; // probe + sprite
    expect(afterFirst).toBe(2);
    cache.get('2', style);
    cache.get('3', style);
    expect(created.length).toBe(afterFirst + 2);
  });

  it('drawChars costs one sprite per distinct character, not per distinct string', () => {
    const created: MockCanvas[] = [];
    const cache = new TextCache(mockCanvasFactory(created));
    const target = createMockCanvas(200, 100);
    const style = { font: '700 20px sans-serif', color: '#fff' };
    for (let v = 0; v < 200; v++) cache.drawChars(target.ctx as unknown as Ctx2D, String(v), 100, 50, style);
    // probe + at most the 10 digit glyphs.
    expect(created.length).toBeLessThanOrEqual(11);
    expect(cache.size).toBeLessThanOrEqual(10);
    // Each character is blitted.
    expect(target.ctx.count('drawImage')).toBeGreaterThan(200);
  });

  it('a combo that changes every frame does not allocate a canvas per value', () => {
    const { hw, scratch } = setup();
    hw.resize(1280, 720, 1);
    hw.draw(makeFrame({ lanes: LANES, songTime: 1, combo: 2 }));
    const before = scratch.length;
    for (let c = 3; c < 160; c++) hw.draw(makeFrame({ lanes: LANES, songTime: 1 + c * 0.02, combo: c }));
    // 10 digit glyphs (plus a little slack), not ~157 large glowing string sprites.
    expect(scratch.length - before).toBeLessThan(16);
  });
});

describe('demo', () => {
  it('runs the scripted chart against a mock canvas, producing hits, misses and combos', () => {
    const canvas = createMockCanvas(1280, 720);
    let t = 0;
    const scheduled: Array<() => void> = [];
    const handle = runDemo(canvas, {
      createCanvas: mockCanvasFactory(),
      now: () => t,
      schedule: (cb) => {
        scheduled.push(cb);
        return () => undefined;
      },
      durationSec: 20,
    });
    let sawHit = false;
    let sawMiss = false;
    let maxCombo = 0;
    for (let songTime = 0; songTime < 20; songTime += 1 / 30) {
      const f = handle.step(songTime);
      if (f.recentHits.some((h) => h.judgment !== 'miss')) sawHit = true;
      if (f.recentHits.some((h) => h.judgment === 'miss')) sawMiss = true;
      maxCombo = Math.max(maxCombo, f.combo);
      expect(f.lanes.length).toBe(4);
      expect(f.beatPhase).toBeGreaterThanOrEqual(0);
      expect(f.beatPhase).toBeLessThan(1);
    }
    expect(sawHit).toBe(true);
    expect(sawMiss).toBe(true);
    expect(maxCombo).toBeGreaterThan(3);
    expect(handle.highway.getStats().frames).toBeGreaterThan(500);
    // Scheduler was used by the internal tick and stop() is safe.
    expect(scheduled.length).toBeGreaterThan(0);
    t = 1;
    scheduled[0]();
    handle.stop();
  });
});

describe('degenerate input degrades gracefully', () => {
  const healthyStates = LANES.map(() => ({ value: 0.9, armed: true, tracking: true }));
  const healthy = (t: number): RenderFrame =>
    makeFrame({ lanes: LANES, songTime: t, health: 0.8, score: 4200, combo: 7, multiplier: 2, laneStates: healthyStates, thresholdFraction: 0.6 });

  it('a single NaN frame does not permanently switch off the receptor glow, rock meter or score', () => {
    // The receptor halo is the primary biofeedback cue ("you are approaching threshold"). It used
    // to disappear for the rest of the session after one non-finite songTime, because clamp()
    // passed NaN through into dt and from there into every smoothed accumulator.
    const control = setup();
    const poisoned = setup();
    control.hw.resize(1280, 720, 1);
    poisoned.hw.resize(1280, 720, 1);
    control.hw.draw(healthy(1));
    poisoned.hw.draw(healthy(1));
    poisoned.hw.draw({
      ...healthy(1.1),
      songTime: Number.NaN,
      health: Number.NaN,
      score: Number.NaN,
      combo: Number.NaN,
      multiplier: Number.NaN,
      beatPhase: Number.NaN,
      energy: Number.NaN,
      bpm: Number.NaN,
    });
    for (let i = 1; i <= 40; i++) {
      control.hw.draw(healthy(1 + i * 0.1));
      poisoned.hw.draw(healthy(1 + i * 0.1));
    }
    control.canvas.ctx.reset();
    poisoned.canvas.ctx.reset();
    control.hw.draw(healthy(5.2));
    poisoned.hw.draw(healthy(5.2));
    // Identical frames: the halo blits, the gauge arcs and the score digits are all back.
    expect(poisoned.canvas.ctx.count('drawImage')).toBe(control.canvas.ctx.count('drawImage'));
    expect(poisoned.canvas.ctx.count('arc')).toBe(control.canvas.ctx.count('arc'));
    expect(poisoned.canvas.ctx.count('fillRect')).toBe(control.canvas.ctx.count('fillRect'));
  });

  it('never issues a non-finite coordinate, even on the poisoned frame itself', () => {
    const { canvas, hw } = setup();
    hw.resize(1280, 720, 1);
    hw.draw(healthy(1));
    canvas.ctx.reset();
    expect(() =>
      hw.draw({
        ...healthy(1.1),
        songTime: Number.NaN,
        health: Number.NaN,
        score: Number.NaN,
        combo: Number.NaN,
        multiplier: Number.NaN,
        beatPhase: Number.NaN,
        energy: Number.NaN,
        notes: [{ id: 1, lane: 0, time: 1.4, state: 'pending' }],
      }),
    ).not.toThrow();
    for (const call of canvas.ctx.calls) {
      for (const a of call.args) {
        if (typeof a === 'number') expect(Number.isFinite(a), `${call.name}(${String(a)})`).toBe(true);
      }
    }
  });

  it('warns exactly once when thresholdFraction is missing (the meter would lie about the trigger point)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { hw } = setup();
      hw.resize(1280, 720, 1);
      for (let i = 0; i < 5; i++) hw.draw(makeFrame({ lanes: LANES, songTime: i * 0.1 }));
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('thresholdFraction');
      // A frame that supplies it does not warn at all.
      const other = setup();
      other.hw.resize(1280, 720, 1);
      other.hw.draw(makeFrame({ lanes: LANES, songTime: 0, thresholdFraction: 0.55 }));
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('judgment popups stay out of the note approach path', () => {
  /** Popup sprites are the scratch canvases that rasterized the judgment word. */
  function popupBlits(canvas: MockCanvas, scratch: MockCanvas[], word: string): Array<{ x: number; y: number; w: number; h: number }> {
    const sprites = scratch.filter((c) => c.ctx.calls.some((k) => k.name === 'fillText' && k.args[0] === word));
    return canvas.ctx.calls
      .filter((c) => c.name === 'drawImage' && sprites.includes(c.args[0] as MockCanvas))
      .map((c) => {
        const a = c.args as [unknown, number, number, number, number];
        return { x: a[1], y: a[2], w: a[3], h: a[4] };
      });
  }

  it('never rises more than POPUP_MAX_RISE_FRAC of the board above the strike line', () => {
    for (const [w, h] of [
      [1280, 720],
      [1920, 1080],
      [720, 1280],
    ]) {
      const { canvas, hw, scratch } = setup(w, h);
      hw.resize(w, h, 1);
      const g = hw.geometry;
      const cap = (g.strikeY - g.horizonY) * POPUP_MAX_RISE_FRAC;
      let highest = g.strikeY;
      // Four hits in a row on one lane: the popups stack, so this is the worst case.
      hw.draw(makeFrame({ lanes: LANES, songTime: 1 }));
      for (let i = 0; i < 4; i++) {
        const t = 1.02 + i * 0.12;
        hw.draw(makeFrame({ lanes: LANES, songTime: t, recentHits: [{ noteId: i, lane: 1, judgment: 'perfect', deltaMs: 2, time: t }] }));
      }
      for (let t = 1.02; t < 2.3; t += 0.02) {
        canvas.ctx.reset();
        hw.draw(makeFrame({ lanes: LANES, songTime: t }));
        // Text anchor, not the blit's top edge: the sprite carries transparent glow padding.
        for (const b of popupBlits(canvas, scratch, 'PERFECT!')) highest = Math.min(highest, b.y + b.h / 2);
      }
      expect(g.strikeY - highest, `${w}x${h}`).toBeLessThanOrEqual(cap + 1);
      // ...and the *ink* still occupies only a small slice of the board: the popup lives near the
      // fret (Clone Hero style) instead of flying up through the note approach path.
      const u = Math.min(Math.max(Math.min(w / 1280, h / 720), 0.35), 2.5);
      const inkTop = g.strikeY - highest + Math.round(22 * u) * 0.7;
      expect(inkTop / (g.strikeY - g.horizonY), `${w}x${h}`).toBeLessThan(0.42);
    }
  });

  it('draws the judgment word over its own burst, so it is legible for its whole life', () => {
    // It used to be drawn under the gems AND under the particle layer, and the burst is emitted at
    // the point the word is anchored to: every PERFECT! came out struck through by its own spark
    // streaks. Two independent blind reviewers read that as a rendering bug. The word goes last.
    const { canvas, hw, scratch } = setup();
    hw.resize(1280, 720, 1);
    hw.draw(makeFrame({ lanes: LANES, songTime: 1 }));
    canvas.ctx.reset();
    const notes: RenderNote[] = [{ id: 5, lane: 1, time: 1.35, state: 'pending' }];
    hw.draw(makeFrame({ lanes: LANES, songTime: 1.02, notes, recentHits: [{ noteId: 1, lane: 1, judgment: 'perfect', deltaMs: 2, time: 1.02 }] }));
    const popupSprites = scratch.filter((c) => c.ctx.calls.some((k) => k.name === 'fillText' && k.args[0] === 'PERFECT!'));
    const popupAt = canvas.ctx.calls.findIndex((c) => c.name === 'drawImage' && popupSprites.includes(c.args[0] as MockCanvas));
    expect(popupAt).toBeGreaterThan(-1);
    // The burst is additive sprite work around the struck lane; all of it lands before the word.
    const g = hw.geometry;
    const burst = canvas.ctx.calls
      .map((c, i) => ({ c, i }))
      .filter(
        ({ c, i }) =>
          c.name === 'drawImage' &&
          c.args.length === 5 &&
          canvas.ctx.propBefore(i, 'globalCompositeOperation') === 'lighter' &&
          Math.abs((c.args[1] as number) + (c.args[3] as number) / 2 - laneX(g, 1, 0)) < g.laneWidthNear * 1.5,
      );
    expect(burst.length).toBeGreaterThan(0);
    expect(popupAt).toBeGreaterThan(burst[burst.length - 1].i);
  });

  it('keeps the judgment word at full strength for most of its life instead of leaving a ghost', () => {
    const { canvas, hw, scratch } = setup();
    hw.resize(1280, 720, 1);
    hw.draw(makeFrame({ lanes: LANES, songTime: 1, recentHits: [{ noteId: 1, lane: 1, judgment: 'perfect', deltaMs: 2, time: 1 }] }));
    const popupSprites = scratch.filter((c) => c.ctx.calls.some((k) => k.name === 'fillText' && k.args[0] === 'PERFECT!'));
    const alphaAt = (dt: number): number => {
      canvas.ctx.reset();
      hw.draw(makeFrame({ lanes: LANES, songTime: 1 + dt }));
      const i = canvas.ctx.calls.findIndex((c) => c.name === 'drawImage' && popupSprites.includes(c.args[0] as MockCanvas));
      return i < 0 ? 0 : (canvas.ctx.propBefore(i, 'globalAlpha') as number);
    };
    // Two thirds of the way through its life it is still fully opaque...
    expect(alphaAt(0.33)).toBeCloseTo(1, 3);
    // ...and it is never caught hanging around at a quarter opacity with no burst under it.
    for (const dt of [0.4, 0.44, 0.48, 0.52]) {
      const a = alphaAt(dt);
      expect(a === 0 || a > 0.3, `alpha ${a} at +${dt}s`).toBe(true);
    }
  });
});

describe('the board looks occupied', () => {
  /** A gem/receptor sprite: an ellipse, no text, and small — the baked venue layers are full size. */
  const isGemSprite = (c: MockCanvas): boolean =>
    c.width <= 512 && c.ctx.calls.some((k) => k.name === 'ellipse') && !c.ctx.calls.some((k) => k.name === 'fillText');

  /** Gem sprite blits (ring sprites are centred on the strike line; text sprites carry fillText). */
  const gemBlits = (canvas: MockCanvas, hw: Highway, scratch: MockCanvas[]): Array<{ y: number; alpha: number }> => {
    const g = hw.geometry;
    const gemSprites = scratch.filter((c) => isGemSprite(c));
    const out: Array<{ y: number; alpha: number }> = [];
    canvas.ctx.calls.forEach((c, i) => {
      if (c.name !== 'drawImage' || c.args.length !== 5) return;
      if (!gemSprites.includes(c.args[0] as MockCanvas)) return;
      const y = (c.args[2] as number) + (c.args[4] as number) / 2;
      if (y > g.strikeY - 4) return; // receptor rings and anything already at the line
      out.push({ y, alpha: canvas.ctx.propBefore(i, 'globalAlpha') as number });
    });
    return out;
  };

  it('draws every gem of a 2 notes/second chart, spread over the whole run', () => {
    // Medium difficulty at 120 BPM is one note per beat. This is the number three blind reviewers
    // measured us on: the board carried 2-4 legible gems where a shipped one carries 6-14.
    const { canvas, hw, scratch } = setup(1920, 1080);
    hw.resize(1920, 1080, 1);
    const notes: RenderNote[] = [];
    for (let i = 0; i < 12; i++) notes.push({ id: i + 1, lane: i % 4, time: 10 + i * 0.5, state: 'pending' });
    canvas.ctx.reset();
    hw.draw(makeFrame({ lanes: LANES, songTime: 10, notes }));
    expect(hw.getStats().notesDrawn).toBeGreaterThanOrEqual(8);
    const blits = gemBlits(canvas, hw, scratch);
    // ...and they are spread out, not stacked at the near end: the run from the far edge to the
    // strike line is cut into quarters and none of them is empty.
    const g = hw.geometry;
    for (let q = 0; q < 4; q++) {
      const yFar = yAt(g, 1 - q / 4);
      const yNear = yAt(g, 1 - (q + 1) / 4);
      expect(blits.some((b) => b.y >= yFar && b.y <= yNear), `quarter ${q} of the run is empty`).toBe(true);
    }
  });

  it('holds gems at full strength down the whole run instead of fading them to ghosts', () => {
    const { canvas, hw, scratch } = setup(1920, 1080);
    hw.resize(1920, 1080, 1);
    const notes: RenderNote[] = [];
    for (let i = 0; i < 12; i++) notes.push({ id: i + 1, lane: i % 4, time: 10 + i * 0.5, state: 'pending' });
    canvas.ctx.reset();
    hw.draw(makeFrame({ lanes: LANES, songTime: 10, notes }));
    const blits = gemBlits(canvas, hw, scratch);
    expect(blits.length).toBeGreaterThanOrEqual(7);
    // Every gem the renderer decides to draw is drawn to be READ. Gems used to fade in linearly
    // over the board's whole dissolve band, which put three or four of the eight on the board at
    // 15-40 % alpha: the road was carrying them and the frame was not showing them. They now ramp
    // up over the top third of that band only, and hold at >= GEM_FAR_ALPHA after it.
    for (const b of blits) expect(b.alpha, `gem at y=${Math.round(b.y)}`).toBeGreaterThanOrEqual(0.8);
    // The band itself is unchanged — the ROAD still dissolves, so nothing appears on a hard line.
    expect(FAR_FADE_FRAC).toBeGreaterThan(0.1);
  });

  it('never draws a gem bigger than it was at the strike line once it is past it', () => {
    // Below the line the perspective tail magnifies: an un-hit gem used to swell past the receptor
    // ring it was sitting on, and the two merged into one same-coloured blob.
    const { canvas, hw, scratch } = setup(1920, 1080);
    hw.resize(1920, 1080, 1);
    const g = hw.geometry;
    const gemSprites = () => scratch.filter((c) => isGemSprite(c));
    const widthAt = (dt: number): number => {
      canvas.ctx.reset();
      hw.draw(makeFrame({ lanes: LANES, songTime: 10 + dt, notes: [{ id: 1, lane: 2, time: 10, state: 'pending' }] }));
      const w = canvas.ctx.calls
        .filter((c) => c.name === 'drawImage' && c.args.length === 5 && gemSprites().includes(c.args[0] as MockCanvas))
        // The receptor ring is centred exactly on the strike line; the gem is below it by now.
        .filter((c) => (c.args[2] as number) + (c.args[4] as number) / 2 > g.strikeY + 4)
        .map((c) => c.args[3] as number);
      expect(w.length, `no gem drawn at +${dt}s`).toBe(1);
      return w[0];
    };
    const first = widthAt(0.08);
    for (const dt of [0.16, 0.3, 0.45, 0.6]) {
      expect(widthAt(dt), `gem width at +${dt}s`).toBeLessThanOrEqual(first + 1);
    }
  });
});

describe('lane labels fit their lanes', () => {
  /** Text extents (not sprite extents — sprites carry transparent padding) of every lane label. */
  function labelSpans(canvas: MockCanvas, scratch: MockCanvas[]): Array<{ x0: number; x1: number; y: number; text: string }> {
    const out: Array<{ x0: number; x1: number; y: number; text: string }> = [];
    for (const c of canvas.ctx.calls) {
      if (c.name !== 'drawImage') continue;
      const src = c.args[0] as MockCanvas;
      if (!scratch.includes(src)) continue;
      const drawn = src.ctx.calls.find((k) => k.name === 'fillText');
      const text = drawn ? String(drawn.args[0]) : '';
      if (!/^[LR] /.test(text)) continue;
      const a = c.args as [unknown, number, number, number, number];
      const cx = a[1] + a[3] / 2;
      const tw = text.length * 8; // canvasMock measureText
      out.push({ x0: cx - tw / 2, x1: cx + tw / 2, y: a[2], text });
    }
    return out;
  }

  it('leaves roomy labels alone on a desktop canvas, on one row', () => {
    const { canvas, hw, scratch } = setup(1280, 720);
    hw.resize(1280, 720, 1);
    canvas.ctx.reset();
    hw.draw(makeFrame({ lanes: LANES, songTime: 1 }));
    const spans = labelSpans(canvas, scratch);
    expect(spans.length).toBe(4);
    expect(spans.map((s) => s.text)).toEqual(['L knee lift', 'R knee lift', 'L knee ext', 'R knee ext']);
    expect(new Set(spans.map((s) => s.y)).size).toBe(1);
  });

  it('never overlaps a neighbour on a narrow portrait canvas (staggered rows + ellipsis)', () => {
    for (const [w, h] of [
      [400, 800],
      [360, 640],
      [720, 1280],
    ]) {
      const { canvas, hw, scratch } = setup(w, h);
      hw.resize(w, h, 1);
      canvas.ctx.reset();
      hw.draw(makeFrame({ lanes: LANES, songTime: 1 }));
      const spans = labelSpans(canvas, scratch);
      expect(spans.length, `${w}x${h}`).toBe(4);
      for (const s of spans) expect(s.text.length, `${w}x${h} "${s.text}"`).toBeGreaterThan(1);
      // Group by row: labels on the same row must not overlap.
      const rows = new Map<number, typeof spans>();
      for (const s of spans) {
        const row = rows.get(s.y) ?? [];
        row.push(s);
        rows.set(s.y, row);
      }
      for (const row of rows.values()) {
        row.sort((a, b) => a.x0 - b.x0);
        for (let i = 1; i < row.length; i++) {
          expect(row[i].x0, `${w}x${h} "${row[i - 1].text}" / "${row[i].text}"`).toBeGreaterThanOrEqual(row[i - 1].x1 - 0.001);
        }
      }
      // Labels stay inside the canvas.
      for (const s of spans) {
        expect(s.x0, `${w}x${h}`).toBeGreaterThan(-1);
        expect(s.x1, `${w}x${h}`).toBeLessThan(w + 1);
        expect(s.y, `${w}x${h}`).toBeLessThan(h);
      }
    }
  });
});

// -------------------------------------------------------------------------------------------------
// Receptor honesty: the meter must mean exactly what the input engine means.
// -------------------------------------------------------------------------------------------------

/** Additive sprite blits centred on a receptor — i.e. the "this lane is live" halo. */
function haloBlits(canvas: MockCanvas, hw: Highway): number {
  const g = hw.geometry;
  let n = 0;
  canvas.ctx.calls.forEach((c, i) => {
    if (c.name !== 'drawImage' || c.args.length !== 5) return;
    const dx = c.args[1] as number;
    const dy = c.args[2] as number;
    const dw = c.args[3] as number;
    const dh = c.args[4] as number;
    if (Math.abs(dy + dh / 2 - g.strikeY) > 1) return;
    if (canvas.ctx.propBefore(i, 'globalCompositeOperation') !== 'lighter') return;
    for (let lane = 0; lane < g.laneCount; lane++) if (Math.abs(dx + dw / 2 - laneX(g, lane, 0)) < 1) n++;
  });
  return n;
}

/**
 * The receptor's meter well is built from full-width `fillRect`s, and each one is identifiable by
 * the fill style in force when it was issued:
 *   - the WELL ground   → the flat dark `#080a12` (drawn every frame, empty or not)
 *   - the LIQUID        → a cached gradient, i.e. an *object* rather than a colour string
 *   - the LEVEL LINE    → the lane's `bright` colour (white `#ffffff` at the trigger point)
 *   - the TARGET LINE   → white `#ffffff`, ~2 px, at a fixed height
 * `i` is the call index, which is how the tests prove the marks are painted ON TOP of the receptor
 * sprite rather than under its translucent button face.
 */
interface MeterRect {
  y: number;
  h: number;
  style: unknown;
  i: number;
}
function meterRects(canvas: MockCanvas, hw: Highway, lane: number): MeterRect[] {
  const g = hw.geometry;
  const out: MeterRect[] = [];
  canvas.ctx.calls.forEach((c, i) => {
    if (c.name !== 'fillRect') return;
    const [x, y, w, h] = c.args as number[];
    if (w < g.receptorRadius * 1.4) return;
    if (Math.abs(x + w / 2 - laneX(g, lane, 0)) > 0.5) return;
    out.push({ y, h, style: canvas.ctx.propBefore(i, 'fillStyle'), i });
  });
  return out;
}
/** The liquid column (the only meter mark filled with a gradient). */
function liquidRect(canvas: MockCanvas, hw: Highway, lane: number): MeterRect | undefined {
  return meterRects(canvas, hw, lane).find((m) => typeof m.style === 'object' && m.style !== null);
}
/** The flat dark ground of the well (drawn whether or not there is any liquid). */
function wellRect(canvas: MockCanvas, hw: Highway, lane: number): MeterRect | undefined {
  return meterRects(canvas, hw, lane).find((m) => m.style === METER_WELL);
}
/** The fixed threshold line across the well (`undefined` when the lane does not draw one). */
function targetLine(canvas: MockCanvas, hw: Highway, lane: number): MeterRect | undefined {
  const g = hw.geometry;
  return meterRects(canvas, hw, lane).find((m) => m.style === WHITE && m.h < g.receptorRadius * 0.2);
}
/** The moving level line at the patient's current value (lane-coloured, white-hot at threshold). */
function levelLine(canvas: MockCanvas, hw: Highway, lane: number, bright: string): MeterRect | undefined {
  return meterRects(canvas, hw, lane).find((m) => m.style === bright);
}
/** The two threshold ticks outside the ring — short bars flush against the ring outline. */
function targetTicks(canvas: MockCanvas, hw: Highway, lane: number): Array<{ x: number; y: number; w: number }> {
  const g = hw.geometry;
  const cx = laneX(g, lane, 0);
  const out: Array<{ x: number; y: number; w: number }> = [];
  canvas.ctx.calls.forEach((c, i) => {
    if (c.name !== 'fillRect') return;
    const [x, y, w, h] = c.args as number[];
    if (canvas.ctx.propBefore(i, 'fillStyle') !== WHITE) return;
    if (h > g.receptorRadius * 0.2 || w > g.receptorRadius * 0.5 || w < 2) return;
    // Flush against this lane's own ring (the tick centre sits at ~1.0 r). The old ±0.6 r window
    // was wide enough to also swallow the neighbouring lane's ticks, so every inner lane counted
    // four — which made the count depend on the ratio of lane width to receptor radius instead of
    // on the marks actually drawn.
    if (Math.abs(Math.abs(x + w / 2 - cx) - g.receptorRadius) > g.receptorRadius * 0.3) return;
    out.push({ x, y, w });
  });
  return out;
}
/**
 * The two white segments of the SPLIT level cap — the mark that appears at the trigger point. They
 * are half-width bars either side of a central gap, so they are narrower than the full-width target
 * line and wider than a re-arm dash or a threshold tick, and unlike the rising cap they are white
 * in every palette. `[]` in every state but (b).
 */
function hotCapSegments(canvas: MockCanvas, hw: Highway, lane: number): Array<{ x: number; y: number; w: number; h: number }> {
  const g = hw.geometry;
  const cx = laneX(g, lane, 0);
  const out: Array<{ x: number; y: number; w: number; h: number }> = [];
  canvas.ctx.calls.forEach((c, i) => {
    if (c.name !== 'fillRect') return;
    const [x, y, w, h] = c.args as number[];
    if (canvas.ctx.propBefore(i, 'fillStyle') !== WHITE) return;
    if (h > g.receptorRadius * 0.2) return; // a line, not the well or the liquid
    if (w < g.receptorRadius * 0.4 || w > g.receptorRadius * 1.4) return; // not a tick, not the target line
    if (Math.abs(x + w / 2 - cx) > g.receptorRadius) return; // inside this lane's ring
    out.push({ x, y, w, h });
  });
  return out;
}
/** The violet drain cap on top of a locked lane's column (full-width, so `meterRects` sees it). */
function drainCap(canvas: MockCanvas, hw: Highway, lane: number): MeterRect | undefined {
  const g = hw.geometry;
  return meterRects(canvas, hw, lane).find((m) => m.style === LOCK_HINT && m.h < g.receptorRadius * 0.2);
}
/** The dashed re-arm line inside a locked lane's well (three short violet bars at one height). */
function rearmDashes(canvas: MockCanvas, hw: Highway, lane: number): Array<{ y: number; h: number }> {
  const g = hw.geometry;
  const cx = laneX(g, lane, 0);
  const out: Array<{ y: number; h: number }> = [];
  canvas.ctx.calls.forEach((c, i) => {
    if (c.name !== 'fillRect') return;
    const [x, y, w, h] = c.args as number[];
    if (canvas.ctx.propBefore(i, 'fillStyle') !== LOCK_HINT) return;
    if (h > g.receptorRadius * 0.2 || w > g.receptorRadius * 0.5) return;
    if (Math.abs(x + w / 2 - cx) > g.receptorRadius) return;
    out.push({ y, h });
  });
  return out;
}

/**
 * Where the meter well's value axis lives for a lane (reduced motion ⇒ no beat pulse, so exact).
 * `scale` is the ring scale in force: 1 for a live lane, `LOCK_RING_SCALE` for a locked one, whose
 * ring — and therefore whose whole gauge — is drawn 12 % smaller.
 */
function meterAxis(hw: Highway, scale = 1): { yBot: number; span: number; yTarget: number } {
  const g = hw.geometry;
  const wry = g.receptorRadius * GEM_ASPECT * 0.9 * scale;
  const yBot = g.strikeY + wry;
  const span = wry * 2;
  return { yBot, span, yTarget: yBot - METER_TARGET_POS * span };
}

const serialize = (canvas: MockCanvas): string[] => canvas.ctx.calls.map((c) => `${c.name}(${JSON.stringify(c.args.map((a) => (typeof a === 'number' ? Math.round(a * 100) / 100 : typeof a === 'object' ? 'obj' : a)))})`);

/** Multiset symmetric difference between two recorded frames. */
function callDiff(a: string[], b: string[]): number {
  const counts = new Map<string, number>();
  for (const k of a) counts.set(k, (counts.get(k) ?? 0) + 1);
  for (const k of b) counts.set(k, (counts.get(k) ?? 0) - 1);
  let d = 0;
  for (const v of counts.values()) d += Math.abs(v);
  return d;
}

describe('receptor tells the truth about whether the lane can fire', () => {
  const VALUE = 0.75;
  const THRESH = 0.6;
  const states = (armed: boolean): RenderFrame['laneStates'] => LANES.map((l) => ({ lane: l.index, value: VALUE, armed, tracking: true }));
  /** Draw enough frames for the smoothed halo to settle, then record exactly one more. */
  const settled = (armed: boolean): { canvas: MockCanvas; hw: Highway; scratch: MockCanvas[] } => {
    const s = setup(1280, 720);
    s.hw.resize(1280, 720, 1);
    for (let i = 0; i < 30; i++) {
      s.hw.draw(makeFrame({ lanes: LANES, songTime: 1 + i * 0.016, laneStates: states(armed), thresholdFraction: THRESH, beatPhase: 0.5 }));
    }
    s.canvas.ctx.reset();
    s.hw.draw(makeFrame({ lanes: LANES, songTime: 1.5, laneStates: states(armed), thresholdFraction: THRESH, beatPhase: 0.5 }));
    return s;
  };

  it('gives a lane held past threshold but not re-armed a categorically different receptor', () => {
    // The patient is holding at end range: value 0.75 against a 0.6 threshold, but the lane has
    // already fired and cannot fire again until the value drops below 0.6 * 0.6 = 0.36. Showing
    // them a lit, "hot", haloed receptor for the whole hold is the lie this test exists to prevent.
    const live = settled(true);
    const held = settled(false);

    // 1. The halo — "you are at / near the trigger point" — is present live and gone entirely.
    expect(haloBlits(live.canvas, live.hw)).toBe(4);
    expect(haloBlits(held.canvas, held.hw)).toBe(0);

    // 2. The locked lane gets its own cues: a re-arm line and a "lower to reset" chevron.
    const hint = (c: MockCanvas): number =>
      c.ctx.calls.filter((k) => (k.name === 'set:fillStyle' || k.name === 'set:strokeStyle') && k.args[0] === LOCK_HINT).length;
    expect(hint(held.canvas)).toBeGreaterThanOrEqual(4 * 2); // per lane: dashes + chevron
    expect(hint(live.canvas)).toBe(0);

    // 3. The ring is rasterized in a desaturated version of the lane colour — not the live lane
    //    colour, and not the dead grey either. Replacing the hue outright cost the lane its identity
    //    at the exact instant the patient is looking at it (lockout starts on the frame the note is
    //    struck), and two blind reviewers read the struck fret as a stray sprite because of it.
    const ringStrokes = (scratch: MockCanvas[]): string[] =>
      scratch.flatMap((c) => c.ctx.calls.filter((k) => k.name === 'set:strokeStyle').map((k) => String(k.args[0])));
    const green = '#35d43a';
    const deadGrey = '#55565e';
    const heldStrokes = ringStrokes(held.scratch);
    expect(heldStrokes).not.toContain(deadGrey);
    expect(heldStrokes).not.toContain(green);
    expect(ringStrokes(live.scratch)).toContain(green);
    // The locked green ring is still recognisably green (G clearly above R and B) and clearly
    // duller than the live one.
    const sat = (hex: string): number => {
      const [r, gg, b] = hexToRgb(hex);
      return Math.max(r, gg, b) - Math.min(r, gg, b);
    };
    const lockedGreen = heldStrokes.find((c) => /^#[0-9a-f]{6}$/i.test(c) && hexToRgb(c)[1] > hexToRgb(c)[0] + 20 && hexToRgb(c)[1] > hexToRgb(c)[2] + 20);
    expect(lockedGreen, `locked ring strokes: ${heldStrokes.join(' ')}`).toBeDefined();
    expect(sat(lockedGreen as string)).toBeLessThan(sat(green) * 0.6);
    expect(sat(lockedGreen as string)).toBeGreaterThan(sat(deadGrey) + 20);

    // 4. And the frames genuinely differ: the old implementation differed by 3 calls out of 252
    //    (a clip ellipse, one globalAlpha and the ring blit size), i.e. a 30 % dim of the outline.
    const diff = callDiff(serialize(live.canvas), serialize(held.canvas));
    expect(diff).toBeGreaterThan(40);
  });

  it('drains the halo when a lane locks out mid-hold and pops it back on re-arm', () => {
    const { canvas, hw } = setup(1280, 720);
    hw.resize(1280, 720, 1);
    const at = (t: number, armed: boolean, value = VALUE): void => {
      hw.draw(makeFrame({ lanes: LANES, songTime: t, laneStates: states(armed).map((s) => ({ ...s, value })), thresholdFraction: THRESH }));
    };
    for (let i = 0; i < 30; i++) at(1 + i * 0.016, true);
    canvas.ctx.reset();
    at(1.5, true);
    expect(haloBlits(canvas, hw)).toBe(4);
    // Lane fires → unarmed. The halo drains over a few frames rather than snapping, but it goes.
    for (let i = 0; i < 30; i++) at(1.52 + i * 0.016, false);
    canvas.ctx.reset();
    at(2.02, false);
    expect(haloBlits(canvas, hw)).toBe(0);
    // Patient lowers past the re-arm line → armed again, and the meter lights up again.
    for (let i = 0; i < 30; i++) at(2.04 + i * 0.016, true);
    canvas.ctx.reset();
    at(2.54, true);
    expect(haloBlits(canvas, hw)).toBe(4);
  });

  it('only a lane that would actually fire gets the "full" read', () => {
    // The halo grows with the meter and is the "you are at the trigger point" signal, so it must
    // scale with the value while armed — and be absent entirely while the lane cannot fire.
    expect(settledHalo(0.75, true).size).toBeGreaterThan(settledHalo(0.3, true).size);
    expect(settledHalo(0.75, true).alpha).toBeGreaterThan(settledHalo(0.3, true).alpha);
    expect(settledHalo(0.3, true).count).toBe(4);
    expect(settledHalo(0.75, false).count).toBe(0);
    expect(settledHalo(0.3, false).count).toBe(0);
    // Lost tracking is also "cannot fire": no halo either.
    expect(settledHalo(0.9, true, false).count).toBe(0);
  });

  /** Halo blit count / diameter / alpha after the smoothing settles, for one lane state. */
  function settledHalo(value: number, armed: boolean, tracking = true): { count: number; size: number; alpha: number } {
    const { canvas, hw } = setup(1280, 720);
    hw.resize(1280, 720, 1);
    const ls = LANES.map((l) => ({ lane: l.index, value, armed, tracking }));
    for (let i = 0; i < 30; i++) hw.draw(makeFrame({ lanes: LANES, songTime: 1 + i * 0.016, laneStates: ls, thresholdFraction: THRESH }));
    canvas.ctx.reset();
    hw.draw(makeFrame({ lanes: LANES, songTime: 1.5, laneStates: ls, thresholdFraction: THRESH }));
    const g = hw.geometry;
    let size = 0;
    let alpha = 0;
    canvas.ctx.calls.forEach((c, i) => {
      if (c.name !== 'drawImage' || c.args.length !== 5) return;
      const dx = c.args[1] as number;
      const dy = c.args[2] as number;
      const dw = c.args[3] as number;
      const dh = c.args[4] as number;
      if (Math.abs(dy + dh / 2 - g.strikeY) > 1) return;
      if (canvas.ctx.propBefore(i, 'globalCompositeOperation') !== 'lighter') return;
      if (Math.abs(dx + dw / 2 - laneX(g, 0, 0)) > 1) return;
      size = Math.max(size, dw);
      alpha = Math.max(alpha, canvas.ctx.propBefore(i, 'globalAlpha') as number);
    });
    return { count: haloBlits(canvas, hw), size, alpha };
  }

  it('honours a session-specific rearmFraction for the re-arm line', () => {
    const lineY = (rearmFraction: number | undefined): number => {
      const { canvas, hw } = setup(1280, 720);
      hw.resize(1280, 720, 1);
      const f = makeFrame({
        lanes: LANES,
        songTime: 1,
        laneStates: LANES.map((l) => ({ lane: l.index, value: 0.75, armed: false })),
        thresholdFraction: THRESH,
        ...(rearmFraction === undefined ? {} : { rearmFraction }),
      });
      hw.draw(f);
      // First dash of the first lane's re-arm line. Matched as a DASH (short, violet, inside the
      // ring), not merely as "the first violet rect" — the locked lane also paints a full-width
      // violet drain cap, and picking that up instead would make this test independent of
      // rearmFraction and pass for the wrong reason.
      const dashes = rearmDashes(canvas, hw, 0);
      expect(dashes).toHaveLength(3);
      return dashes[0].y;
    };
    // A lower re-arm fraction means the patient must come further down: the line sits lower in the
    // ring, i.e. at a *larger* y.
    expect(lineY(0.3)).toBeGreaterThan(lineY(0.6));
    expect(lineY(undefined)).toBeCloseTo(lineY(0.6), 6);
  });
});

// -------------------------------------------------------------------------------------------------
// Four input states, four receptor looks. A patient reads this from ~2 m mid-exercise, so the
// difference between "keep going", "that scored", "come back down first" and "I cannot see you"
// cannot be a brightness step: each state has to change WHICH marks are on screen.
// -------------------------------------------------------------------------------------------------

describe('the receptor draws four distinct states', () => {
  const THRESH = 0.6;
  const LOST_RING = '#a9b0bb'; // broken "no signal" ring
  type Rec = { canvas: MockCanvas; hw: Highway; scratch: MockCanvas[] };

  /** Warm the smoothed halo up on one lane state, then record exactly one frame of it. */
  const record = (value: number, armed: boolean, tracking = true, beatPhase = 0.5): Rec => {
    const s = setup(1280, 720);
    s.hw.resize(1280, 720, 1);
    const ls = LANES.map((l) => ({ lane: l.index, value, armed, tracking }));
    const frame = (t: number): RenderFrame =>
      makeFrame({ lanes: LANES, songTime: t, laneStates: ls, thresholdFraction: THRESH, rearmFraction: 0.6, beatPhase });
    for (let i = 0; i < 40; i++) s.hw.draw(frame(1 + i * 0.016));
    s.canvas.ctx.reset();
    s.hw.draw(frame(1.64));
    return s;
  };

  /** Lanes whose gauge has liquid in it (the gradient-filled column). */
  const meterFills = (s: Rec): number => LANES.filter((l) => liquidRect(s.canvas, s.hw, l.index)).length;
  /** Lanes whose gauge exists at all (well ground, drawn whenever there is a measurement). */
  const meterWells = (s: Rec): number => LANES.filter((l) => wellRect(s.canvas, s.hw, l.index)).length;
  /** Lanes showing the fixed threshold line, and lanes showing its two ticks outside the ring. */
  const targetLines = (s: Rec): number => LANES.filter((l) => targetLine(s.canvas, s.hw, l.index)).length;
  const tickCount = (s: Rec): number => LANES.reduce((n, l) => n + targetTicks(s.canvas, s.hw, l.index).length, 0);

  /** Additive rings stroked on a receptor — the "this rep is scoring" rim + corona. */
  const willFireRings = (s: Rec): number => {
    const g = s.hw.geometry;
    let n = 0;
    s.canvas.ctx.calls.forEach((c, i) => {
      if (c.name !== 'ellipse' || Math.abs((c.args[1] as number) - g.strikeY) > 0.5) return;
      if (s.canvas.ctx.propBefore(i, 'globalCompositeOperation') !== 'lighter') return;
      n++;
    });
    return n;
  };

  /** Arc segments of the broken "no signal" ring (a partial ellipse in the lost-tracking grey). */
  const brokenArcs = (s: Rec): Array<{ rx: number; ry: number }> => {
    const g = s.hw.geometry;
    const out: Array<{ rx: number; ry: number }> = [];
    s.canvas.ctx.calls.forEach((c, i) => {
      if (c.name !== 'ellipse' || c.args.length < 7) return;
      if (Math.abs((c.args[1] as number) - g.strikeY) > 0.5) return;
      if ((c.args[6] as number) - (c.args[5] as number) >= Math.PI * 2 - 1e-6) return;
      if (s.canvas.ctx.propBefore(i, 'strokeStyle') !== LOST_RING) return;
      out.push({ rx: c.args[2] as number, ry: c.args[3] as number });
    });
    return out;
  };

  /** Ring-sized sprite blits centred on a receptor (the solid lane / grey ring, never the halo). */
  const solidRings = (s: Rec): number => {
    const g = s.hw.geometry;
    let n = 0;
    s.canvas.ctx.calls.forEach((c, i) => {
      if (c.name !== 'drawImage' || c.args.length !== 5) return;
      const dx = c.args[1] as number;
      const dy = c.args[2] as number;
      const dw = c.args[3] as number;
      const dh = c.args[4] as number;
      if (Math.abs(dy + dh / 2 - g.strikeY) > 1 || dw < g.receptorRadius * 2) return;
      if (s.canvas.ctx.propBefore(i, 'globalCompositeOperation') === 'lighter') return; // halo
      if (LANES.some((l) => Math.abs(dx + dw / 2 - laneX(g, l.index, 0)) < 1)) n++;
    });
    return n;
  };

  const lockHints = (s: Rec): number =>
    s.canvas.ctx.calls.filter((c) => (c.name === 'set:fillStyle' || c.name === 'set:strokeStyle') && c.args[0] === LOCK_HINT).length;

  /** Segments of the split white level cap — 2 per lane in (b), none anywhere else. */
  const hotCaps = (s: Rec): number => LANES.reduce((n, l) => n + hotCapSegments(s.canvas, s.hw, l.index).length, 0);
  /** Lanes carrying the violet drain cap on top of their column — 4 in (c), none anywhere else. */
  const drainCaps = (s: Rec): number => LANES.filter((l) => drainCap(s.canvas, s.hw, l.index)).length;
  /** Lanes drawing the continuous lane-tinted rising cap (the "and it counts" level line). */
  const risingCaps = (s: Rec): number =>
    LANES.filter((l) => levelLine(s.canvas, s.hw, l.index, GH_PALETTE.lanes[l.index].bright)).length;

  /** Was the "?" glyph rasterized at all (the text cache is per-Highway, so per recorded state)? */
  const questionGlyph = (s: Rec): boolean => s.scratch.some((c) => c.ctx.calls.some((k) => k.name === 'fillText' && k.args[0] === '?'));

  // (a) rising toward threshold, armed   (b) at threshold, armed
  // (c) at threshold, NOT armed          (d) tracking lost (with a stale value still in the meter)
  const rising = (): Rec => record(0.36, true);
  const firing = (): Rec => record(0.75, true);
  const locked = (): Rec => record(0.75, false);
  const lost = (): Rec => record(0.75, true, false);

  it('gives each of the four states its own set of marks, not its own brightness', () => {
    const a = rising();
    const b = firing();
    const c = locked();
    const d = lost();

    // (a) rising: a gauge with liquid in it, a moving level line, the fixed target line and its two
    //     ticks outside the ring, a halo that is not yet full — and no "will fire" rings, no lock
    //     cues, no broken ring. "Keep going, this much further."
    expect(meterWells(a)).toBe(4);
    expect(meterFills(a)).toBe(4);
    expect(targetLines(a)).toBe(4);
    expect(tickCount(a)).toBe(8); // two per lane, one either side of the ring
    expect(haloBlits(a.canvas, a.hw)).toBe(4);
    expect(willFireRings(a)).toBe(0);
    expect(lockHints(a)).toBe(0);
    expect(brokenArcs(a)).toHaveLength(0);
    expect(solidRings(a)).toBe(4);
    expect(risingCaps(a)).toBe(4); // one continuous lane-tinted cap per lane
    expect(hotCaps(a)).toBe(0);
    expect(drainCaps(a)).toBe(0);

    // (b) at/over threshold and armed: the only state with the additive rim + corona, and the only
    //     one whose fill is drawn from the hot gradient (a separate cached gradient per lane). It
    //     keeps the target line — it has to, because the liquid now stands *above* it.
    expect(willFireRings(b)).toBe(8); // rim + corona per lane
    expect(haloBlits(b.canvas, b.hw)).toBe(4);
    expect(targetLines(b)).toBe(4);
    expect(tickCount(b)).toBe(8);
    expect(lockHints(b)).toBe(0);
    expect(brokenArcs(b)).toHaveLength(0);
    expect(solidRings(b)).toBe(4);
    // The cap SPLITS at the trigger point: one bar becomes two. A count of marks, not a brightness.
    expect(hotCaps(b)).toBe(8);
    expect(risingCaps(b)).toBe(0);
    expect(drainCaps(b)).toBe(0);

    // (c) at/over threshold but NOT armed: no halo, no "will fire" ring, and — just as important —
    //     no target line and no ticks anywhere, because the threshold is not what the patient is
    //     aiming at any more. Instead, the return-to-rest cues. This is the state the whole
    //     contract exists for.
    expect(haloBlits(c.canvas, c.hw)).toBe(0);
    expect(willFireRings(c)).toBe(0);
    expect(targetLines(c)).toBe(0);
    expect(tickCount(c)).toBe(0);
    expect(lockHints(c)).toBeGreaterThanOrEqual(8); // drain cap + dashes + chevron per lane
    expect(meterFills(c)).toBe(4); // the height is still the patient's real value
    expect(brokenArcs(c)).toHaveLength(0);
    expect(solidRings(c)).toBe(4);
    expect(drainCaps(c)).toBe(4); // the violet bar the patient has to bring down to the dashes
    expect(hotCaps(c)).toBe(0);
    expect(risingCaps(c)).toBe(0);
    for (const l of LANES) expect(rearmDashes(c.canvas, c.hw, l.index), `lane ${l.index} dashes`).toHaveLength(3);

    // (d) tracking lost: nothing that encodes a value is drawn at all — no well, no fill, no target
    //     line, no halo, no lock cues, no solid ring — just the broken ring and the "?".
    expect(meterWells(d)).toBe(0);
    expect(meterFills(d)).toBe(0);
    expect(targetLines(d)).toBe(0);
    expect(tickCount(d)).toBe(0);
    expect(haloBlits(d.canvas, d.hw)).toBe(0);
    expect(willFireRings(d)).toBe(0);
    expect(lockHints(d)).toBe(0);
    expect(solidRings(d)).toBe(0);
    expect(hotCaps(d)).toBe(0);
    expect(drainCaps(d)).toBe(0);
    expect(risingCaps(d)).toBe(0);
    expect(brokenArcs(d)).toHaveLength(4 * 4); // four arcs per lane
    expect(questionGlyph(d)).toBe(true);
    expect(questionGlyph(a) || questionGlyph(b) || questionGlyph(c)).toBe(false);
  });

  // -----------------------------------------------------------------------------------------------
  // (a) is the state the ring exists for: during the rise the patient must be able to tell "half
  // way" from "nearly there" at 2 m. These tests are about that, and about the reason it used to be
  // impossible — the gauge was painted UNDER the receptor sprite's translucent dark button face.
  // -----------------------------------------------------------------------------------------------

  it('paints the whole gauge ON TOP of the receptor sprite, never under its button face', () => {
    // The sprite is an opaque-ish dark disc across the entire ellipse. Anything drawn before it is
    // seen through a scrim: measured on real pixels, that turned a 0 → 100 % ramp into a diffuse
    // warm-up with no resolvable level and a +19/255 meniscus. Draw order IS the fix, so it is what
    // this asserts: for every lane, every meter mark is issued after that lane's ring blit.
    const s = rising();
    const g = s.hw.geometry;
    for (const l of LANES) {
      const ringAt = s.canvas.ctx.calls.findIndex((c, i) => {
        if (c.name !== 'drawImage' || c.args.length !== 5) return false;
        const [, dx, dy, dw, dh] = c.args as [unknown, number, number, number, number];
        if (Math.abs(dy + dh / 2 - g.strikeY) > 1 || dw < g.receptorRadius * 2) return false;
        if (s.canvas.ctx.propBefore(i, 'globalCompositeOperation') === 'lighter') return false; // halo
        return Math.abs(dx + dw / 2 - laneX(g, l.index, 0)) < 1;
      });
      expect(ringAt, `lane ${l.index} ring`).toBeGreaterThan(-1);
      const marks = meterRects(s.canvas, s.hw, l.index);
      expect(marks.length, `lane ${l.index} marks`).toBeGreaterThanOrEqual(3); // well + liquid + target
      for (const m of marks) expect(m.i, `lane ${l.index} mark at ${m.i} vs ring at ${ringAt}`).toBeGreaterThan(ringAt);
    }
  });

  it('reads out the whole rise, not just "not yet / there"', () => {
    // A gauge, not a glow: the level line and the top of the liquid move by a real distance for
    // each step of effort, and every step is measured against the SAME fixed target line.
    const { canvas, hw } = setup(1280, 720, { reducedMotion: true });
    hw.resize(1280, 720, 1);
    const axis = meterAxis(hw);
    const bright = GH_PALETTE.lanes[0].bright;
    const at = (fraction: number): { level: number; liquid: number } => {
      canvas.ctx.reset();
      hw.draw(
        makeFrame({
          lanes: LANES,
          songTime: 1 + fraction,
          laneStates: LANES.map((l) => ({ lane: l.index, value: THRESH * fraction, armed: true, tracking: true })),
          thresholdFraction: THRESH,
        }),
      );
      const line = levelLine(canvas, hw, 0, bright);
      const liquid = liquidRect(canvas, hw, 0);
      expect(line).toBeDefined();
      expect(liquid).toBeDefined();
      return { level: (line as MeterRect).y + (line as MeterRect).h / 2, liquid: (liquid as MeterRect).y };
    };
    const steps = [0.2, 0.4, 0.6, 0.8, 0.99].map(at);
    for (let i = 1; i < steps.length; i++) {
      // Monotonic, and each 20 % of the rise moves the level by a fifth of the target height —
      // ~4 % of the receptor's height per step is what "a little higher" has to look like.
      expect(steps[i].level).toBeLessThan(steps[i - 1].level);
      expect(steps[i - 1].level - steps[i].level).toBeGreaterThan(axis.span * METER_TARGET_POS * 0.15);
      expect(steps[i].liquid).toBeCloseTo(steps[i].level, 0);
    }
    // The rise is measured against the target line, which never moves and is never reached early.
    const target = targetLine(canvas, hw, 0) as MeterRect;
    expect(target).toBeDefined();
    expect(target.y + target.h / 2).toBeCloseTo(axis.yTarget, 1);
    for (const st of steps) expect(st.level).toBeGreaterThan(axis.yTarget); // still below the line
    // Halfway up is halfway to the line, not 45 % of a bar with no line on it.
    expect(at(0.5).level).toBeCloseTo(axis.yBot - 0.5 * METER_TARGET_POS * axis.span, 1);
  });

  it('is the only state that paints liquid above the target line, and only once it really fires', () => {
    const { canvas, hw } = setup(1280, 720, { reducedMotion: true });
    hw.resize(1280, 720, 1);
    const axis = meterAxis(hw);
    const topOfLiquid = (value: number, armed = true): number => {
      canvas.ctx.reset();
      hw.draw(
        makeFrame({
          lanes: LANES,
          songTime: 1 + value,
          laneStates: LANES.map((l) => ({ lane: l.index, value, armed, tracking: true })),
          thresholdFraction: THRESH,
        }),
      );
      return (liquidRect(canvas, hw, 0) as MeterRect).y;
    };
    expect(topOfLiquid(THRESH * 0.99)).toBeGreaterThan(axis.yTarget); // below the line
    expect(topOfLiquid(THRESH)).toBeCloseTo(axis.yTarget, 1); // exactly on it
    expect(topOfLiquid(THRESH * 1.25)).toBeLessThan(axis.yTarget - 1); // into the headroom
    expect(topOfLiquid(THRESH * 1.5)).toBeLessThan(topOfLiquid(THRESH * 1.25)); // and further
    // A locked lane at the same value never reaches the line's height, let alone crosses it: the
    // headroom is a "you cleared the target" cue it has not earned, and a column stopping flush ON
    // the trigger height reads as being at the trigger point. It is capped a visible band short.
    // A locked ring is also drawn 12 % smaller, so its gauge has its own axis; the ceiling is a
    // fraction of THAT well, and the shortfall against the live target line is larger still.
    const lockAxis = meterAxis(hw, LOCK_RING_SCALE);
    const capped = lockAxis.yBot - METER_TARGET_POS * LOCK_LEVEL_CEIL * lockAxis.span;
    for (const v of [THRESH, THRESH * 1.25, THRESH * 1.5, THRESH * 3]) {
      expect(topOfLiquid(v, false), `locked at ${v}`).toBeGreaterThan(axis.yTarget);
      expect(topOfLiquid(v, false) - axis.yTarget, `locked gap at ${v}`).toBeGreaterThan(4); // ≥1 px at 4×
      expect(topOfLiquid(v, false), `locked at ${v}`).toBeCloseTo(capped, 0);
    }
    // Below that ceiling the locked column is the patient's true value on its own well's scale —
    // that is what makes it a gauge they can lower against the re-arm line.
    for (const f of [0.3, 0.5, 0.7]) {
      expect(topOfLiquid(THRESH * f, false), `locked at ${f}×`).toBeCloseTo(lockAxis.yBot - METER_TARGET_POS * f * lockAxis.span, 0);
    }
  });

  it('turns the locked column into a "how much further to lower" gauge that ends on the re-arm line', () => {
    // (4) ACTIONABLE REMEDY: the locked state must say how much further to lower, keyed to the real
    // re-arm level (thresholdFraction * rearmFraction). The drain cap is that readout, and it lands
    // exactly on the dashed re-arm line at the instant the input layer re-arms the lane.
    const { canvas, hw } = setup(1280, 720, { reducedMotion: true });
    hw.resize(1280, 720, 1);
    const axis = meterAxis(hw, LOCK_RING_SCALE); // a locked ring is drawn 12 % smaller
    const REARM = 0.6;
    const capAt = (value: number): { cap: number; dashes: number } => {
      canvas.ctx.reset();
      hw.draw(
        makeFrame({
          lanes: LANES,
          songTime: 1 + value,
          laneStates: LANES.map((l) => ({ lane: l.index, value, armed: false, tracking: true })),
          thresholdFraction: THRESH,
          rearmFraction: REARM,
        }),
      );
      const cap = drainCap(canvas, hw, 0) as MeterRect;
      const dashes = rearmDashes(canvas, hw, 0);
      expect(cap, `drain cap at ${value}`).toBeDefined();
      expect(dashes, `dashes at ${value}`).toHaveLength(3);
      return { cap: cap.y + cap.h / 2, dashes: dashes[0].y + dashes[0].h / 2 };
    };
    // The dashed line never moves: it is the fixed reference the cap is coming down to.
    const yRearmLine = axis.yBot - METER_TARGET_POS * REARM * axis.span;
    // A ladder from the ceiling down to the re-arm point. Every step moves the cap by a real
    // distance, so "nearly there" is readable — this is the drain equivalent of the rise readout.
    const ladder = [0.9, 0.8, 0.7, 0.6].map((f) => capAt(THRESH * f));
    for (const step of ladder) expect(Math.abs(step.dashes - yRearmLine)).toBeLessThan(1.5);
    for (let i = 1; i < ladder.length; i++) {
      expect(ladder[i].cap).toBeGreaterThan(ladder[i - 1].cap); // travelling DOWN the well
      expect(ladder[i].cap - ladder[i - 1].cap).toBeGreaterThan(axis.span * 0.05);
    }
    // ...and it finishes on the line, not near it: at value === threshold * rearmFraction the lane
    // re-arms, and that is the frame the cap and the dashes coincide.
    expect(Math.abs(ladder[ladder.length - 1].cap - ladder[ladder.length - 1].dashes)).toBeLessThan(1.5);
    expect(Math.abs(ladder[ladder.length - 1].cap - yRearmLine)).toBeLessThan(1.5);
    // A session that tunes the re-arm fraction moves both marks together.
    const tuned = setup(1280, 720, { reducedMotion: true });
    tuned.hw.resize(1280, 720, 1);
    tuned.hw.draw(
      makeFrame({
        lanes: LANES,
        songTime: 2,
        laneStates: LANES.map((l) => ({ lane: l.index, value: THRESH * 0.4, armed: false, tracking: true })),
        thresholdFraction: THRESH,
        rearmFraction: 0.4,
      }),
    );
    const tunedCap = drainCap(tuned.canvas, tuned.hw, 0) as MeterRect;
    const tunedDash = rearmDashes(tuned.canvas, tuned.hw, 0)[0];
    expect(Math.abs(tunedCap.y + tunedCap.h / 2 - (tunedDash.y + tunedDash.h / 2))).toBeLessThan(1.5);
    // ...and a tuned line really is a different height, not the default one relabelled.
    expect(tunedDash.y).toBeGreaterThan(yRearmLine + 4);
  });

  it('separates (a) from (b) by a mark count, in the high-contrast palette too', () => {
    // (2) FOUR STATES, FOUR MARK-SETS. In HIGH_CONTRAST a lane's bright tint is already near-white
    // (#e6fbff), so the old (a)→(b) cue — "the cap goes white and doubles in thickness" — was two
    // near-white bars differing by ~2 px, at or below acuity at 2 m for the low-vision patients
    // that palette exists for. The cap now SPLITS, which is a change in how many marks there are.
    for (const highContrast of [false, true]) {
      const { canvas, hw } = setup(1280, 720, { reducedMotion: true, highContrast });
      hw.resize(1280, 720, 1);
      const bright = (highContrast ? HIGH_CONTRAST_PALETTE : GH_PALETTE).lanes[0].bright;
      const drawAt = (value: number): void => {
        canvas.ctx.reset();
        hw.draw(
          makeFrame({
            lanes: LANES,
            songTime: 1 + value,
            laneStates: LANES.map((l) => ({ lane: l.index, value, armed: true, tracking: true })),
            thresholdFraction: THRESH,
          }),
        );
      };
      drawAt(THRESH * 0.8);
      expect(hotCapSegments(canvas, hw, 0), `${highContrast} rising`).toHaveLength(0);
      expect(levelLine(canvas, hw, 0, bright), `${highContrast} rising cap`).toBeDefined();
      drawAt(THRESH * 1.2);
      const segs = hotCapSegments(canvas, hw, 0);
      expect(segs, `${highContrast} firing`).toHaveLength(2);
      expect(levelLine(canvas, hw, 0, bright), `${highContrast} firing has no continuous cap`).toBeUndefined();
      // Two bars at the same height with a real gap between them, above the target line.
      expect(segs[0].y).toBeCloseTo(segs[1].y, 3);
      const gap = Math.abs(segs[1].x - (segs[0].x + segs[0].w));
      expect(gap).toBeGreaterThan(hw.geometry.receptorRadius * 0.2);
      for (const s of segs) expect(s.y + s.h / 2).toBeLessThan(meterAxis(hw).yTarget);
      // The gap has to be a hole in the dark well, not a hole in the near-white hot liquid: the
      // segments sit ON the level, they do not straddle it.
      const liquid = liquidRect(canvas, hw, 0) as MeterRect;
      for (const s of segs) expect(s.y + s.h).toBeCloseTo(liquid.y, 0);
      // ...and the target line below them is still the one continuous white bar in the well.
      const target = targetLine(canvas, hw, 0) as MeterRect;
      expect(target).toBeDefined();
      expect(target.y + target.h / 2).toBeCloseTo(meterAxis(hw).yTarget, 1);
    }
  });

  it('no two of the four states paint the same frame', () => {
    const frames: Array<[string, string[]]> = [
      ['rising', serialize(rising().canvas)],
      ['firing', serialize(firing().canvas)],
      ['locked', serialize(locked().canvas)],
      ['lost', serialize(lost().canvas)],
    ];
    for (let i = 0; i < frames.length; i++) {
      for (let j = i + 1; j < frames.length; j++) {
        const diff = callDiff(frames[i][1], frames[j][1]);
        // Far more than a globalAlpha or two: a whole class of marks differs in every pair.
        expect(diff, `${frames[i][0]} vs ${frames[j][0]}`).toBeGreaterThan(20);
      }
    }
  });

  it('a full meter alone never claims "ready" — only armed + tracked + full does', () => {
    // Same value, same threshold, three different truths about whether the next rep can register.
    expect(willFireRings(firing())).toBeGreaterThan(0);
    expect(willFireRings(locked())).toBe(0);
    expect(willFireRings(lost())).toBe(0);
    // ...and the halo, the other "you are there" cue, follows the same rule.
    expect(haloBlits(firing().canvas, firing().hw)).toBe(4);
    expect(haloBlits(locked().canvas, locked().hw)).toBe(0);
    expect(haloBlits(lost().canvas, lost().hw)).toBe(0);
  });

  it('the lost-tracking receptor ignores a stale value and does not dance with the beat', () => {
    // A lane-level dropout leaves the last sample behind; VisionInput reports value 0 for a dead
    // stream. Either way the number is not a measurement, so a 0.95 value paints exactly what a 0
    // value paints.
    const hot = serialize(record(0.95, true, false).canvas);
    const zero = serialize(record(0, true, false).canvas);
    expect(callDiff(hot, zero)).toBe(0);
    // The live ring pulses on the beat; a dead signal must not, or "no data" reads as rhythm.
    const onBeat = brokenArcs(record(0.5, true, false, 0));
    const offBeat = brokenArcs(record(0.5, true, false, 0.5));
    expect(onBeat).toHaveLength(16);
    expect(offBeat).toHaveLength(16);
    expect(onBeat[0].rx).toBeCloseTo(offBeat[0].rx, 6);
    expect(onBeat[0].ry).toBeCloseTo(offBeat[0].ry, 6);
    // The live receptor, by contrast, does change size with the beat.
    const ringSize = (s: Rec): number => {
      const g = s.hw.geometry;
      let w = 0;
      s.canvas.ctx.calls.forEach((c, i) => {
        if (c.name !== 'drawImage' || c.args.length !== 5) return;
        const dy = c.args[2] as number;
        const dh = c.args[4] as number;
        if (Math.abs(dy + dh / 2 - g.strikeY) > 1) return;
        if (s.canvas.ctx.propBefore(i, 'globalCompositeOperation') === 'lighter') return; // halo
        if (Math.abs((c.args[1] as number) + (c.args[3] as number) / 2 - laneX(g, 0, 0)) > 1) return;
        w = Math.max(w, c.args[3] as number);
      });
      return w;
    };
    expect(ringSize(record(0.36, true, true, 0))).toBeGreaterThan(ringSize(record(0.36, true, true, 0.5)));
  });

  it('grows the return-to-rest arc as the patient lowers back toward the re-arm level', () => {
    // Re-arm happens below threshold * 0.6 = 0.36 of ROM. The arc answers "how much further?", so
    // it must be absent while they are still at the top and closed at the line.
    const sweep = (value: number): number => {
      const s = record(value, false);
      const g = s.hw.geometry;
      let span = 0;
      s.canvas.ctx.calls.forEach((c, i) => {
        if (c.name !== 'ellipse' || c.args.length < 7) return;
        if (Math.abs((c.args[1] as number) - g.strikeY) > 0.5) return;
        // The arc sits just outside the ring; the meter's clip ellipse is inside it.
        if (Math.abs((c.args[2] as number) - g.receptorRadius * 1.16) > 0.5) return;
        if (s.canvas.ctx.propBefore(i, 'strokeStyle') !== LOCK_HINT) return;
        span = Math.max(span, (c.args[6] as number) - (c.args[5] as number));
      });
      return span;
    };
    // The arc spans at most 1.5π, leaving the top quarter of the ring permanently open: a cue that
    // closed into a complete ring would read as a lit ring, which is what (c) may never look like.
    expect(sweep(0.6)).toBe(0); // at threshold: nothing given back yet, no arc at all
    expect(sweep(0.54)).toBeGreaterThan(0);
    expect(sweep(0.48)).toBeCloseTo(Math.PI * 0.75, 2); // half way down
    expect(sweep(0.36)).toBeCloseTo(Math.PI * 1.5, 6); // at the re-arm line: complete, still open
    expect(sweep(0.48)).toBeGreaterThan(sweep(0.54));
    // It is a locked-lane cue only: a live lane never draws it.
    const live = record(0.48, true);
    expect(lockHints(live)).toBe(0);
  });

  it('tracking loss outranks the hysteresis lockout (one cue at a time, and it is the true one)', () => {
    // A lane can be both unarmed and untracked (the tracker dropped out mid-hold). Telling the
    // patient to "lower to reset" while the camera cannot see them is advice they cannot act on.
    const both = record(0.75, false, false);
    expect(lockHints(both)).toBe(0);
    expect(meterFills(both)).toBe(0);
    expect(brokenArcs(both)).toHaveLength(16);
    expect(callDiff(serialize(both.canvas), serialize(lost().canvas))).toBe(0);
  });
});

// -------------------------------------------------------------------------------------------------
// Judgment cues land on screen; decoration never becomes the loudest thing.
// -------------------------------------------------------------------------------------------------

/** A canvas factory with no 2D context: forces every sprite path into its plain-ctx fallback. */
const noSpriteFactory = (w: number, h: number): CanvasLike => ({ width: w, height: h, getContext: () => null });

/** Gem discs drawn below the strike line (the sprite-less fallback draws them as ellipses). */
function gemDiscs(canvas: MockCanvas, hw: Highway): Array<{ cy: number; ry: number }> {
  const g = hw.geometry;
  return canvas.ctx.calls
    .filter((c) => c.name === 'ellipse' && (c.args[1] as number) > g.strikeY + 1)
    .map((c) => ({ cy: c.args[1] as number, ry: c.args[3] as number }));
}

describe('the miss cue lands inside the canvas', () => {
  it('keeps the whole dying gem on screen from the verdict through the fizzle, at every resolution', () => {
    // The engine declares a miss at note.time + goodMs (180) + grace (100) = +280 ms. Previously
    // the gem's centre was 707/720 at that instant with a 74 px radius — 59 % of the gem inside the
    // canvas, and its centre crossed the bottom edge 45 ms later. "notesDrawn === 1" said nothing
    // about that, so this test measures the drawn disc.
    for (const [w, h] of [
      [1280, 720],
      [1920, 1080],
      [720, 1280],
      [400, 800],
      [1366, 768],
    ]) {
      for (const laneCount of [2, 3, 4]) {
        const canvas = createMockCanvas(w, h);
        const hw = new Highway(canvas, { createCanvas: noSpriteFactory });
        hw.resize(w, h, 1);
        const lanes = LANES.slice(0, laneCount);
        const noteTime = 10;
        const lane = laneCount - 1;
        hw.draw(makeFrame({ lanes, songTime: noteTime - 1 }));
        const missEv: HitEvent[] = [{ noteId: 1, lane, judgment: 'miss', deltaMs: 180, time: noteTime + 0.18 }];
        const missed: RenderNote = { id: 1, lane, time: noteTime, state: 'miss', judgment: 'miss' };
        for (const dt of [0.28, 0.34, 0.45, 0.6, 0.69]) {
          canvas.ctx.reset();
          hw.draw(makeFrame({ lanes, songTime: noteTime + dt, notes: [missed], recentHits: dt === 0.28 ? missEv : [] }));
          const discs = gemDiscs(canvas, hw);
          expect(discs.length, `${w}x${h} lanes=${laneCount} +${dt}s`).toBe(1);
          const u = Math.min(2.5, Math.max(0.35, Math.min(w / 1280, h / 720)));
          expect(discs[0].cy + discs[0].ry, `${w}x${h} lanes=${laneCount} +${dt}s bottom edge`).toBeLessThanOrEqual(h - MISS_CUE_MARGIN_U * u + 0.001);
          expect(discs[0].cy - discs[0].ry, `${w}x${h} lanes=${laneCount} +${dt}s top edge`).toBeGreaterThan(0);
        }
      }
    }
  });

  it('holds a pending gem fully on screen until the miss verdict can arrive', () => {
    for (const [w, h] of [
      [1280, 720],
      [1920, 1080],
      [720, 1280],
    ]) {
      const canvas = createMockCanvas(w, h);
      const hw = new Highway(canvas, { createCanvas: noSpriteFactory });
      hw.resize(w, h, 1);
      const pending: RenderNote = { id: 1, lane: 0, time: 10, state: 'pending' };
      for (const dtMs of [30, 100, 200, 280]) {
        canvas.ctx.reset();
        hw.draw(makeFrame({ lanes: LANES, songTime: 10 + dtMs / 1000, notes: [pending] }));
        const discs = gemDiscs(canvas, hw);
        expect(discs.length, `${w}x${h} +${dtMs}ms`).toBe(1);
        expect(discs[0].cy + discs[0].ry, `${w}x${h} +${dtMs}ms`).toBeLessThanOrEqual(h);
      }
    }
  });

  it('draws the miss puff as smoke over the road, never as an additive white smudge', () => {
    // showLabels off so the only things drawn below the receptors are the puff particles.
    const { canvas, hw } = setup(1280, 720, { showLabels: false });
    hw.resize(1280, 720, 1);
    const g = hw.geometry;
    hw.draw(makeFrame({ lanes: LANES, songTime: 1 }));
    const miss: HitEvent[] = [{ noteId: 7, lane: 1, judgment: 'miss', deltaMs: 180, time: 1.18 }];
    hw.draw(makeFrame({ lanes: LANES, songTime: 1.28, recentHits: miss }));
    canvas.ctx.reset();
    hw.draw(makeFrame({ lanes: LANES, songTime: 1.32 }));
    expect(hw.getStats().particles).toBeGreaterThan(0);
    let additiveBelowLine = 0;
    let normalBelowLine = 0;
    let maxSmokeAlpha = 0;
    canvas.ctx.calls.forEach((c, i) => {
      if (c.name !== 'drawImage' || c.args.length !== 5) return;
      const dy = c.args[2] as number;
      const dh = c.args[4] as number;
      // Below the receptor ring's centre line. (The cutoff used to be 0.5 r; the board's scroll
      // speed at the strike line halved when the taper loosened, so a 140 ms-old miss cue now dies
      // much closer to the line — which is the point of the tail, and is what keeps it on screen.)
      if (dy + dh / 2 < g.strikeY + g.receptorRadius * 0.2) return;
      if (canvas.ctx.propBefore(i, 'globalCompositeOperation') === 'lighter') additiveBelowLine++;
      else {
        normalBelowLine++;
        maxSmokeAlpha = Math.max(maxSmokeAlpha, canvas.ctx.propBefore(i, 'globalAlpha') as number);
      }
    });
    expect(additiveBelowLine).toBe(0);
    expect(normalBelowLine).toBeGreaterThan(0);
    expect(maxSmokeAlpha).toBeLessThan(0.5);
  });

  it('does not resurrect a stale missed note forever', () => {
    // A missed note left in frame.notes for the rest of the song used to be re-registered every
    // time the de-dupe ledger pruned it (~3 s) and redrawn, invisibly, below the canvas.
    const { hw } = setup(1280, 720);
    hw.resize(1280, 720, 1);
    const missed: RenderNote = { id: 4, lane: 2, time: 5, state: 'miss', judgment: 'miss' };
    hw.draw(makeFrame({ lanes: LANES, songTime: 5, notes: [missed] }));
    let drawnAfterFizzle = 0;
    for (let t = 5.6; t < 16; t += 0.05) {
      hw.draw(makeFrame({ lanes: LANES, songTime: t, notes: [missed] }));
      drawnAfterFizzle += hw.getStats().notesDrawn;
    }
    expect(drawnAfterFizzle).toBe(0);
  });
});

describe('runtime controls are real controls, not decoration', () => {
  it('setOptions only rebuilds what changed (a therapist slider must not thrash the renderer)', () => {
    const { hw, scratch } = setup(1280, 720);
    hw.resize(1280, 720, 1);
    hw.draw(makeFrame({ lanes: LANES, songTime: 1, combo: 5, score: 100, songTitle: 'x', attribution: 'y' }));
    const before = scratch.length;
    for (let i = 0; i < 20; i++) {
      hw.setOptions({ effectIntensity: i / 20 });
      hw.draw(makeFrame({ lanes: LANES, songTime: 1 + i * 0.016, combo: 5, score: 100, songTitle: 'x', attribution: 'y' }));
    }
    // Was ~12 fresh scratch canvases per call (full-screen background + 2 star tiles + re-baked
    // sprites and text) — 242 for this loop.
    expect(scratch.length - before).toBeLessThanOrEqual(4);
    // reducedMotion / showLabels / showStats / maxParticles-unchanged are equally free.
    const before2 = scratch.length;
    for (let i = 0; i < 10; i++) {
      hw.setOptions({ reducedMotion: i % 2 === 0, showLabels: true, showMissPopup: i % 2 === 0 });
      hw.draw(makeFrame({ lanes: LANES, songTime: 2 + i * 0.016 }));
    }
    expect(scratch.length - before2).toBeLessThanOrEqual(4);
  });

  it('still rebuilds when the palette or the geometry actually changes', () => {
    const { hw, scratch } = setup(1280, 720);
    hw.resize(1280, 720, 1);
    hw.draw(makeFrame({ lanes: LANES, songTime: 1 }));
    const beforeGeom = scratch.length;
    hw.setOptions({ strikeY: 0.7 });
    expect(hw.geometry.strikeY).toBeCloseTo(0.7 * 720);
    expect(scratch.length).toBeGreaterThan(beforeGeom); // background re-baked at the new horizon
    const beforePalette = scratch.length;
    hw.setOptions({ highContrast: true });
    hw.draw(makeFrame({ lanes: LANES, songTime: 1.02 }));
    expect(scratch.length).toBeGreaterThan(beforePalette); // sprites re-rasterized in the new palette
    // And the particle budget still applies immediately.
    hw.setOptions({ maxParticles: 40 });
    for (let i = 0; i < 6; i++) {
      hw.draw(
        makeFrame({
          lanes: LANES,
          songTime: 2 + i * 0.016,
          recentHits: [{ noteId: 100 + i, lane: i % 4, judgment: 'perfect', deltaMs: 2, time: 2 + i * 0.016 }],
        }),
      );
    }
    expect(hw.getStats().particles).toBeLessThanOrEqual(40);
  });

  it('keeps every HUD string legible on a small canvas (attribution is a licence obligation)', () => {
    const { canvas, hw, scratch } = setup(400, 800);
    hw.resize(400, 800, 1);
    canvas.ctx.reset();
    hw.draw(
      makeFrame({
        lanes: LANES,
        songTime: 1,
        combo: 12,
        score: 4200,
        multiplier: 2,
        songTitle: 'Some Song',
        attribution: '"Some Song" by Some Artist (ccmixter.org) is licensed under CC BY 4.0',
      }),
    );
    // Every rasterized string in the frame, with the font size it was drawn at.
    const drawn: Array<{ text: string; px: number }> = [];
    for (const c of canvas.ctx.calls) {
      if (c.name !== 'drawImage') continue;
      const src = c.args[0] as MockCanvas;
      if (!scratch.includes(src)) continue;
      const t = src.ctx.calls.find((k) => k.name === 'fillText');
      const f = src.ctx.calls.find((k) => k.name === 'set:font');
      if (!t || !f) continue;
      const m = /(\d+(?:\.\d+)?)px/.exec(String(f.args[0]));
      if (m) drawn.push({ text: String(t.args[0]), px: Number(m[1]) });
    }
    expect(drawn.length).toBeGreaterThan(3);
    for (const d of drawn) expect(d.px, `"${d.text}" at ${d.px}px`).toBeGreaterThanOrEqual(11);
    // The long attribution is ellipsized rather than run under the score readout.
    const attr = drawn.find((d) => d.text.startsWith('"Some Song" by'));
    expect(attr).toBeDefined();
    expect((attr as { text: string }).text.endsWith('…')).toBe(true);
    expect((attr as { text: string }).text.length * 8).toBeLessThanOrEqual(400);
  });
});

describe('degenerate frame values are treated as missing, not as extremes', () => {
  /** Alpha in force for the wide edge-rail glow stroke (lineWidth 9 at u = 1). */
  function railGlowAlpha(canvas: MockCanvas): number {
    const i = canvas.ctx.calls.findIndex((c) => c.name === 'set:lineWidth' && Math.abs((c.args[0] as number) - 9) < 1e-6);
    expect(i).toBeGreaterThan(-1);
    return canvas.ctx.propBefore(i + 1, 'globalAlpha') as number;
  }
  const frameAt = (beatPhase: number, opts: Record<string, unknown> = {}): { canvas: MockCanvas; alpha: number; calls: string[] } => {
    const { canvas, hw } = setup(1280, 720, opts);
    hw.resize(1280, 720, 1);
    hw.draw(makeFrame({ lanes: LANES, songTime: 1, beatPhase }));
    canvas.ctx.reset();
    hw.draw(makeFrame({ lanes: LANES, songTime: 1.016, beatPhase }));
    return { canvas, alpha: railGlowAlpha(canvas), calls: serialize(canvas) };
  };

  it('a non-finite beatPhase goes flat instead of pinning every pulse at maximum', () => {
    const onBeat = frameAt(0); // pow(1-0, 3) = 1 → maximum pulse
    const offBeat = frameAt(0.5);
    const missing = frameAt(Number.NaN);
    // The bug: clamp(NaN) === 0 === the on-beat value, so a NaN clock rendered a permanent downbeat.
    expect(callDiff(missing.calls, onBeat.calls)).toBeGreaterThan(0);
    expect(missing.alpha).toBeLessThan(onBeat.alpha);
    expect(missing.alpha).toBeGreaterThan(offBeat.alpha);
    // "Missing" renders exactly like reduced motion's steady mid pulse, in one place for the whole frame.
    expect(missing.alpha).toBeCloseTo(frameAt(0, { reducedMotion: true }).alpha, 9);
    expect(missing.alpha).toBeCloseTo(frameAt(0.5, { reducedMotion: true }).alpha, 9);
  });

  it('a non-finite multiplier holds tier 1 instead of freezing the badge mid-pop', () => {
    const badge = (multiplier: number): number[] => {
      const { canvas, hw } = setup(1280, 720);
      hw.resize(1280, 720, 1);
      for (let i = 0; i < 40; i++) hw.draw(makeFrame({ lanes: LANES, songTime: 1 + i * 0.016, multiplier }));
      canvas.ctx.reset();
      hw.draw(makeFrame({ lanes: LANES, songTime: 2, multiplier }));
      // roundRectPath is used only for the multiplier badge (glow slab + badge body).
      return canvas.ctx.calls.filter((c) => c.name === 'quadraticCurveTo').flatMap((c) => c.args as number[]);
    };
    const sane = badge(1);
    expect(sane.length).toBeGreaterThan(0);
    // With Math.floor(NaN) the badge sat at its 1.4x overshoot forever and BADGE_KEYS[NaN] became
    // an `undefined` gradient-cache key.
    expect(badge(Number.NaN)).toEqual(sane);
    expect(badge(Number.POSITIVE_INFINITY)).toEqual(sane);
    // Sanity: the metric does respond to the pop, so the equality above has teeth — a multiplier
    // that really changes restarts the badge pop and the badge is momentarily bigger.
    const { canvas, hw } = setup(1280, 720);
    hw.resize(1280, 720, 1);
    for (let i = 0; i < 40; i++) hw.draw(makeFrame({ lanes: LANES, songTime: 1 + i * 0.016, multiplier: 1 }));
    canvas.ctx.reset();
    hw.draw(makeFrame({ lanes: LANES, songTime: 2, multiplier: 2 }));
    const popped = canvas.ctx.calls.filter((c) => c.name === 'quadraticCurveTo').flatMap((c) => c.args as number[]);
    expect(popped).not.toEqual(sane);
  });
});

describe('lanes are matched by identity, not by array position', () => {
  const THRESH = 1;
  /** Liquid top edge per lane — the height the patient reads as "this is where I am". */
  function meterTops(canvas: MockCanvas, hw: Highway): number[] {
    const g = hw.geometry;
    const out = new Array<number>(g.laneCount).fill(Number.NaN);
    for (let lane = 0; lane < g.laneCount; lane++) {
      const m = liquidRect(canvas, hw, lane);
      if (m) out[lane] = m.y;
    }
    return out;
  }
  const values = [0.2, 0.45, 0.7, 0.95];
  const draw = (laneStates: RenderFrame['laneStates']): { canvas: MockCanvas; hw: Highway } => {
    const { canvas, hw } = setup(1280, 720);
    hw.resize(1280, 720, 1);
    hw.draw(makeFrame({ lanes: LANES, songTime: 1, laneStates, thresholdFraction: THRESH }));
    canvas.ctx.reset();
    hw.draw(makeFrame({ lanes: LANES, songTime: 1.016, laneStates, thresholdFraction: THRESH }));
    return { canvas, hw };
  };

  it('reads RenderLaneState.lane so getLaneStates() may arrive in any order', () => {
    const ordered = LANES.map((l) => ({ lane: l.index, value: values[l.index], armed: true, tracking: true }));
    const shuffled = [ordered[2], ordered[0], ordered[3], ordered[1]];
    const a = draw(ordered);
    const b = draw(shuffled);
    expect(meterTops(b.canvas, b.hw)).toEqual(meterTops(a.canvas, a.hw));
    // Sanity: the four lanes really do read differently, so the comparison has teeth.
    expect(new Set(meterTops(a.canvas, a.hw)).size).toBe(4);
    // Without the ids, array position is all there is — and it maps the meters differently.
    const untagged = shuffled.map((s) => ({ value: s.value, armed: s.armed, tracking: s.tracking }));
    const c = draw(untagged);
    expect(meterTops(c.canvas, c.hw)).not.toEqual(meterTops(a.canvas, a.hw));
  });

  it('reads LaneSpec.index for the movement labels', () => {
    const labelAt = (lanes: LaneSpec[]): Array<{ x: number; text: string }> => {
      const { canvas, hw, scratch } = setup(1280, 720);
      hw.resize(1280, 720, 1);
      canvas.ctx.reset();
      hw.draw(makeFrame({ lanes, songTime: 1 }));
      const g = hw.geometry;
      const out: Array<{ x: number; text: string }> = [];
      for (const c of canvas.ctx.calls) {
        if (c.name !== 'drawImage') continue;
        const src = c.args[0] as MockCanvas;
        if (!scratch.includes(src)) continue;
        const t = src.ctx.calls.find((k) => k.name === 'fillText');
        if (!t || !/^[LR] /.test(String(t.args[0]))) continue;
        const a = c.args as [unknown, number, number, number, number];
        const cx = a[1] + a[3] / 2;
        let lane = 0;
        for (let i = 0; i < g.laneCount; i++) if (Math.abs(cx - laneX(g, i, -0.02)) < Math.abs(cx - laneX(g, lane, -0.02))) lane = i;
        out.push({ x: lane, text: String(t.args[0]) });
      }
      return out.sort((p, q) => p.x - q.x);
    };
    const inOrder = labelAt(LANES);
    const reordered = labelAt([LANES[3], LANES[1], LANES[2], LANES[0]]);
    expect(reordered).toEqual(inOrder);
  });

  it('warns once when the lane ids cannot be trusted, and falls back to array position', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const { hw } = setup(1280, 720);
      hw.resize(1280, 720, 1);
      const bad = LANES.map((l) => ({ lane: 9 - l.index, value: 0.5, armed: true }));
      for (let i = 0; i < 5; i++) hw.draw(makeFrame({ lanes: LANES, songTime: 1 + i * 0.016, laneStates: bad, thresholdFraction: 1 }));
      const laneWarnings = warn.mock.calls.filter((c) => String(c[0]).includes('do not cover lanes'));
      expect(laneWarnings.length).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });
});
