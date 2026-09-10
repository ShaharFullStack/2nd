import { describe, expect, it, vi } from 'vitest';
import type { HitEvent, LaneSpec } from '../engine/types';
import { Highway, POPUP_MAX_RISE_FRAC, makeFrame } from './Highway';
import { createMockCanvas, mockCanvasFactory, type MockCanvas } from './canvasMock';
import { runDemo } from './demo';
import { laneX, roadEdgeX, visibleTailSec } from './geometry';
import { TextCache, type Ctx2D } from './text';
import type { RenderFrame, RenderNote } from './types';

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
    expect(hw.geometry.strikeY).toBeCloseTo(0.82 * 500);
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
    // bg gradient + two star tiles at minimum
    expect(scratch.length).toBeGreaterThanOrEqual(3);
    const bg = scratch[0];
    expect(bg.ctx.count('fillRect')).toBeGreaterThan(0);
    expect(bg.ctx.count('createLinearGradient')).toBeGreaterThan(0);
  });

  it('exposes options and lets them be changed at runtime', () => {
    const { hw } = setup();
    expect(hw.options.approachSec).toBe(1.6);
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
    for (let t = 1.05; t < 5; t += 0.05) hw.draw(makeFrame({ lanes: LANES, songTime: t }));
    expect(hw.getStats().particles).toBe(0);
    // Same note id 4 s later (e.g. a chart that reuses ids per section) fires again.
    hw.draw(makeFrame({ lanes: LANES, songTime: 5.02, recentHits: ev(5) }));
    expect(hw.getStats().particles).toBe(burst);
  });

  it('parallax star tiles always cover the full width, including during a negative count-in', () => {
    const { canvas, hw } = setup(1280, 720);
    hw.resize(1280, 720, 1);
    for (const t of [-3, -0.5, 0, 7.3, 200.1]) {
      canvas.ctx.reset();
      hw.draw(makeFrame({ lanes: LANES, songTime: t }));
      const tiles = canvas.ctx.calls.filter((c) => c.name === 'drawImage' && c.args.length === 5 && c.args[3] === 1280 && c.args[4] === 360);
      expect(tiles.length).toBe(4);
      for (let i = 0; i < tiles.length; i += 2) {
        const dx0 = tiles[i].args[1] as number;
        const dx1 = tiles[i + 1].args[1] as number;
        expect(dx0, `t=${t}`).toBeLessThanOrEqual(0);
        expect(dx0).toBeGreaterThan(-1280);
        expect(dx1).toBeCloseTo(dx0 + 1280);
      }
    }
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

  it('receptor meter fill follows lane value (clip + fillRect) and glow grows toward threshold', () => {
    const { canvas, hw } = setup();
    hw.resize(1280, 720, 1);
    const idle = makeFrame({ lanes: LANES, songTime: 1, laneStates: LANES.map(() => ({ value: 0, armed: true, tracking: true })) });
    hw.draw(idle);
    canvas.ctx.reset();
    hw.draw({ ...idle, songTime: 1.02 });
    const clipsIdle = canvas.ctx.count('clip');
    const active = makeFrame({ lanes: LANES, songTime: 1.04, laneStates: LANES.map(() => ({ value: 0.8, armed: true, tracking: true })), thresholdFraction: 0.6 });
    canvas.ctx.reset();
    hw.draw(active);
    // One clip per lane for the meter fill.
    expect(canvas.ctx.count('clip')).toBeGreaterThanOrEqual(clipsIdle + 4);
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

  it('keeps every popup on screen when the same lane is hit twice inside a popup lifetime', () => {
    // 8th notes at 120 BPM are 250 ms apart and the popup lives 750 ms: with one slot per lane the
    // first PERFECT! was cancelled mid-flight.
    const { canvas, hw, scratch } = setup();
    hw.resize(1280, 720, 1);
    hw.draw(makeFrame({ lanes: LANES, songTime: 1 }));
    hw.draw(makeFrame({ lanes: LANES, songTime: 1.02, recentHits: [{ noteId: 1, lane: 2, judgment: 'perfect', deltaMs: 3, time: 1.02 }] }));
    canvas.ctx.reset();
    hw.draw(makeFrame({ lanes: LANES, songTime: 1.27, recentHits: [{ noteId: 2, lane: 2, judgment: 'perfect', deltaMs: 3, time: 1.27 }] }));
    const popupSprites = scratch.filter((c) => c.ctx.calls.some((k) => k.name === 'fillText' && k.args[0] === 'PERFECT!'));
    expect(popupSprites.length).toBeGreaterThan(0);
    const blits = canvas.ctx.calls.filter((c) => c.name === 'drawImage' && popupSprites.includes(c.args[0] as MockCanvas));
    expect(blits.length, 'both popups drawn').toBe(2);
    // The second popup is stacked above the first rather than drawn on top of it. Compare text
    // anchors (blit y + half the blit height) — the blit's own top edge moves with the pop scale.
    const ys = blits.map((b) => {
      const a = b.args as [unknown, number, number, number, number];
      return a[2] + a[4] / 2;
    });
    expect(Math.abs(ys[0] - ys[1])).toBeGreaterThan(10);
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
    expect(hazeCentres(0)).toContain(0.35 * 720);
    const before = scratch.length;
    hw.setOptions({ horizonY: 0.15 });
    expect(hw.geometry.horizonY).toBeCloseTo(0.15 * 720);
    // A fresh background layer was rasterized, with the haze at the new horizon (a stale layer left
    // a glow blob floating in the middle of the sky).
    expect(scratch.length).toBeGreaterThanOrEqual(before + 3);
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

  it('reducedMotion freezes the parallax layers and the beat pulse', () => {
    const offsets = (reducedMotion: boolean): number[] => {
      const { canvas, hw } = setup(1280, 720, { reducedMotion });
      hw.resize(1280, 720, 1);
      const out: number[] = [];
      for (const t of [0, 0.5, 1.25]) {
        canvas.ctx.reset();
        hw.draw(makeFrame({ lanes: LANES, songTime: t, beatPhase: (t * 2) % 1 }));
        const tiles = canvas.ctx.calls.filter((c) => c.name === 'drawImage' && c.args.length === 5 && c.args[3] === 1280 && c.args[4] === 360);
        out.push(tiles[0].args[1] as number);
      }
      return out;
    };
    const moving = offsets(false);
    const still = offsets(true);
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

  it('draws popups under the gems so a judgment can never hide the next target', () => {
    const { canvas, hw, scratch } = setup();
    hw.resize(1280, 720, 1);
    hw.draw(makeFrame({ lanes: LANES, songTime: 1 }));
    canvas.ctx.reset();
    const notes: RenderNote[] = [{ id: 5, lane: 1, time: 1.35, state: 'pending' }];
    hw.draw(makeFrame({ lanes: LANES, songTime: 1.02, notes, recentHits: [{ noteId: 1, lane: 1, judgment: 'perfect', deltaMs: 2, time: 1.02 }] }));
    const popupSprites = scratch.filter((c) => c.ctx.calls.some((k) => k.name === 'fillText' && k.args[0] === 'PERFECT!'));
    const gemSprites = scratch.filter((c) => c.ctx.calls.some((k) => k.name === 'ellipse') && !popupSprites.includes(c));
    const idx = (pred: (c: { name: string; args: unknown[] }) => boolean): number => canvas.ctx.calls.findIndex(pred);
    const popupAt = idx((c) => c.name === 'drawImage' && popupSprites.includes(c.args[0] as MockCanvas));
    const gemAt = canvas.ctx.calls.map((c, i) => ({ c, i })).filter(({ c }) => c.name === 'drawImage' && gemSprites.includes(c.args[0] as MockCanvas));
    expect(popupAt).toBeGreaterThan(-1);
    expect(gemAt.length).toBeGreaterThan(0);
    expect(gemAt[gemAt.length - 1].i).toBeGreaterThan(popupAt);
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
