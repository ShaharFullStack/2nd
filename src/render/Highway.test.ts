import { describe, expect, it } from 'vitest';
import type { HitEvent, LaneSpec } from '../engine/types';
import { Highway, makeFrame } from './Highway';
import { createMockCanvas, mockCanvasFactory, type MockCanvas } from './canvasMock';
import { runDemo } from './demo';
import { laneX, roadEdgeX, visibleTailSec } from './geometry';
import { TextCache } from './text';
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
    const hw = new Highway(canvas, { createCanvas: mockCanvasFactory() });
    hw.resize(undefined, undefined, 2);
    hw.resize(undefined, undefined, 2);
    hw.resize(undefined, undefined, 2);
    // Attribute size is the backing store; logical = 150x75 at DPR 2.
    expect(canvas.width).toBe(300);
    expect(canvas.height).toBe(150);
    expect(hw.geometry.width).toBe(150);
    expect(hw.size).toEqual({ width: 150, height: 75, dpr: 2 });
    // Explicit logical size still wins and is stable across further no-arg calls.
    hw.resize(300, 150, 2);
    expect(canvas.width).toBe(600);
    hw.resize(undefined, undefined, 2);
    hw.resize(undefined, undefined, 2);
    expect(canvas.width).toBe(600);
    expect(hw.geometry.width).toBe(300);
  });

  it('accepts an OffscreenCanvas-like target (no client size) at DPR 2 without double scaling', () => {
    const canvas = createMockCanvas(1920, 1080);
    canvas.clientWidth = 0;
    canvas.clientHeight = 0;
    const hw = new Highway(canvas, { createCanvas: mockCanvasFactory() });
    hw.resize(undefined, undefined, 2);
    expect(canvas.width).toBe(1920);
    expect(canvas.height).toBe(1080);
    expect(hw.geometry.width).toBe(960);
    expect(() => hw.draw(makeFrame({ lanes: LANES }))).not.toThrow();
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
    for (const n of ['setTransform', 'drawImage', 'fill', 'stroke', 'beginPath', 'moveTo', 'lineTo', 'arc', 'createLinearGradient', 'clip']) {
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
    const comboSprite = scratch.find((c) => c.ctx.calls.some((k) => k.name === 'fillText' && k.args[0] === '12'));
    expect(comboSprite).toBeDefined();
    const blit = canvas.ctx.calls.find((c) => c.name === 'drawImage' && c.args[0] === comboSprite);
    expect(blit).toBeDefined();
    const [, dx, , dw] = blit!.args as [unknown, number, number, number];
    const cx = dx + dw / 2;
    expect(cx).toBeGreaterThan(roadEdgeX(hw.geometry, 1, 0));
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
    const { hw, scratch } = setup(1280, 720);
    hw.resize(1280, 720, 1);
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
    // One clip per lane for the meter fill (score digits also clip once).
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
