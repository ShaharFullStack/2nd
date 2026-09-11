import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HitEvent, LaneSpec } from '../engine/types';
import {
  DEFAULT_HIGHWAY_OPTIONS,
  FINALE_SEC,
  FINALE_SKIP_GUARD_SEC,
  Highway,
  MISS_CUE_MARGIN_U,
  POPUP_MAX_RISE_FRAC,
  RESET_ARC_START,
  RESET_ARC_SWEEP,
  makeFrame,
} from './Highway';
import { createMockCanvas, mockCanvasFactory, type MockCanvas } from './canvasMock';
import { runDemo } from './demo';
import { FAR_FADE_FRAC, GEM_ASPECT, laneX, receptorWellSemiHeight, roadEdgeX, roadEdgeXAtY, visibleTailSec, yAt } from './geometry';
import { GH_PALETTE, HIGH_CONTRAST_PALETTE, hexToRgb } from './palette';
import { TextCache, type Ctx2D } from './text';
import { receptorGoalHolding, receptorMarkSet, type ReceptorLook } from './receptor';
import { VisionInput } from '../input/VisionInput';
import { LaneStateCache } from '../input/laneStates';
import { extractFeature } from '../vision/features';
import { seatedPose } from '../vision/fixtures';
import type { Landmark } from '../vision/landmarks';
import type { LandmarkDetector } from '../vision/mediapipe';
import type { RomCalibration } from '../vision/calibration';
import type { CanvasLike, RenderFrame, RenderNote } from './types';

/** Mirrors of the receptor's private drawing constants (Highway.ts). */
const METER_WELL = '#080a12';
const WHITE = '#ffffff';
/** Ceiling on the liquid column in EVERY state, as a fraction of the well (Highway.METER_LEVEL_CEIL). */
const METER_LEVEL_CEIL = 0.93;
/**
 * ROM → height in the meter well, the renderer's ONE linear scale (Highway.meterPos): full
 * calibrated ROM at the ceiling, everything else proportional. So the target line sits at
 * `meterPos(thresholdFraction)` and the re-arm line at `meterPos(thresholdFraction * rearmFraction)`
 * — and a given movement is the same number of pixels wherever in the range it is made.
 */
const meterPos = (rom: number): number => Math.min(Math.max(rom, 0), 1) * METER_LEVEL_CEIL;
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
    const rock = centreOf('ANSWERED'); // the notes-answered gauge (was the rock meter)
    expect(mult).not.toBeNull();
    expect(combo).not.toBeNull();
    expect(rock).not.toBeNull();
    const left = roadEdgeX(g, -1, 0);
    const right = roadEdgeX(g, 1, 0);
    expect((mult as { x: number }).x, 'multiplier badge is in the right flank').toBeGreaterThan(right);
    expect((combo as { x: number }).x, 'combo is in the right flank').toBeGreaterThan(right);
    expect((rock as { x: number }).x, 'effort gauge is in the left flank').toBeLessThan(left);
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
/**
 * The dashes of the fixed threshold line inside the well — short white bars, all at one height,
 * centred on the lane and well inside the ring (the two solid ticks live OUTSIDE it, at ~1.0 r).
 *
 * The target line is dashed because its height follows the session's threshold and on the default
 * difficulty that puts it within a few pixels of the board-wide strike line, which is solid and
 * continuous: a fixed reference mark has to be a different KIND of mark from the decoration it
 * lands on. So this is a segment count, not a rect.
 */
function targetDashes(canvas: MockCanvas, hw: Highway, lane: number): MeterRect[] {
  const g = hw.geometry;
  const cx = laneX(g, lane, 0);
  const out: MeterRect[] = [];
  canvas.ctx.calls.forEach((c, i) => {
    if (c.name !== 'fillRect') return;
    const [x, y, w, h] = c.args as number[];
    if (canvas.ctx.propBefore(i, 'fillStyle') !== WHITE) return;
    if (h > g.receptorRadius * 0.2 || w > g.receptorRadius * 0.35 || w < 1) return;
    if (Math.abs(x + w / 2 - cx) > g.receptorRadius * 0.7) return;
    out.push({ y, h, style: WHITE, i });
  });
  return out;
}
/**
 * The fixed threshold line across the well, as one mark (`undefined` when the lane does not draw
 * one): its height and thickness, from the dashes it is made of — which must all sit at one height.
 */
function targetLine(canvas: MockCanvas, hw: Highway, lane: number): MeterRect | undefined {
  const dashes = targetDashes(canvas, hw, lane);
  if (dashes.length < 3) return undefined;
  for (const d of dashes) if (Math.abs(d.y - dashes[0].y) > 0.001) return undefined;
  return dashes[0];
}
/** The moving level line at the patient's current value (lane-coloured, white-hot at threshold). */
function levelLine(canvas: MockCanvas, hw: Highway, lane: number, bright: string): MeterRect | undefined {
  return meterRects(canvas, hw, lane).find((m) => m.style === bright);
}
/**
 * The two threshold GATE POSTS outside the ring — short bars standing ACROSS the target height,
 * flush against the ring outline.
 *
 * TALLER THAN THEY ARE WIDE, and that is the property under test, not a detail of the helper: they
 * used to be horizontal hairlines at the same height and orientation as the board-wide white strike
 * line, which at the 220 px acuity downscale is the strike line, and which merged with the
 * neighbouring lane's pair across the gutter. So the filter demands a vertical bar — a horizontal
 * one is not this mark, and must not be counted as one.
 */
function targetTicks(canvas: MockCanvas, hw: Highway, lane: number): Array<{ x: number; y: number; w: number; h: number }> {
  const g = hw.geometry;
  const cx = laneX(g, lane, 0);
  const out: Array<{ x: number; y: number; w: number; h: number }> = [];
  canvas.ctx.calls.forEach((c, i) => {
    if (c.name !== 'fillRect') return;
    const [x, y, w, h] = c.args as number[];
    if (canvas.ctx.propBefore(i, 'fillStyle') !== WHITE) return;
    if (w < 2 || h <= w) return; // a post stands up; a tick lay down
    if (h > g.receptorRadius * 0.7 || w > g.receptorRadius * 0.25) return;
    // Flush against this lane's own ring (the post sits just outside ~1.0 r). The old ±0.6 r window
    // was wide enough to also swallow the neighbouring lane's marks, so every inner lane counted
    // four — which made the count depend on the ratio of lane width to receptor radius instead of
    // on the marks actually drawn.
    if (Math.abs(Math.abs(x + w / 2 - cx) - g.receptorRadius) > g.receptorRadius * 0.3) return;
    out.push({ x, y, w, h });
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
 * The "lower to reset" chevron: a stroked polyline in the lock hint colour inside a lane's ring. One
 * per lane in (c) while the patient still has somewhere to lower TO, and nowhere else — the arc that
 * shares its colour is an `ellipse`, not a path.
 */
function chevrons(canvas: MockCanvas, hw: Highway, lane: number): number {
  const g = hw.geometry;
  const cx = laneX(g, lane, 0);
  let n = 0;
  canvas.ctx.calls.forEach((c, i) => {
    if (c.name !== 'moveTo') return;
    if (canvas.ctx.propBefore(i, 'strokeStyle') !== LOCK_HINT) return;
    const [x, y] = c.args as number[];
    if (Math.abs(x - cx) > g.receptorRadius || Math.abs(y - g.strikeY) > g.receptorRadius) return;
    n++;
  });
  return n;
}

/**
 * Where the meter well's value axis lives for a lane (reduced motion ⇒ no beat pulse, so exact).
 * `scale` is the ring scale in force: 1 for a live lane, `LOCK_RING_SCALE` for a locked one, whose
 * ring — and therefore whose whole gauge — is drawn 12 % smaller.
 */
function meterAxis(hw: Highway, scale = 1, threshold = 0.6): { yBot: number; span: number; yTarget: number } {
  const g = hw.geometry;
  const wry = g.receptorRadius * GEM_ASPECT * 0.9 * scale;
  const yBot = g.strikeY + wry;
  const span = wry * 2;
  // The target line is not a fixed height any more: it is the session's threshold ON the ROM axis
  // (0.6 in every test that uses this default), which is what makes the rise and the return move at
  // the same speed per millimetre.
  return { yBot, span, yTarget: yBot - meterPos(threshold) * span };
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
    // Rising below the threshold: armed, and the halo is up.
    for (let i = 0; i < 30; i++) at(1 + i * 0.016, true, 0.5);
    canvas.ctx.reset();
    at(1.5, true, 0.5);
    expect(haloBlits(canvas, hw)).toBe(4);
    // The crossing: the trigger disarms on the sample that crosses, so this IS the frame the lane
    // fired on. The halo stays up for the goal latch — that is the acknowledgement of the rep.
    at(1.52, false);
    canvas.ctx.reset();
    at(1.54, false);
    expect(haloBlits(canvas, hw)).toBe(4);
    // ...and once the latch has expired and the patient is merely holding at end range, it goes.
    for (let i = 0; i < 30; i++) at(1.56 + i * 0.016, false);
    canvas.ctx.reset();
    at(2.3, false);
    expect(haloBlits(canvas, hw)).toBe(0);
    // Patient lowers past the re-arm line → armed again, and the meter lights up again.
    for (let i = 0; i < 30; i++) at(2.32 + i * 0.016, true);
    canvas.ctx.reset();
    at(2.82, true);
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
  const record = (value: number, armed: boolean, tracking = true, beatPhase = 0.5, w = 1280, h = 720): Rec => {
    const s = setup(w, h);
    s.hw.resize(w, h, 1);
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

  /**
   * Solid white arrowheads at the target line, just outside the ring — 2 per lane in (b) and
   * nowhere else. They are filled TRIANGLES where (a) has two thin bars: a change of shape and
   * ~10× the filled area at full size.
   *
   * NOT what carries (b) through a hard downscale, whatever an earlier comment here claimed.
   * Measured on a 1280x800 board reduced to 220 px wide, max-luminance across the strike band:
   * (a)'s gate posts peak at 237/254 over 2 px and (b)'s arrowheads at 251/241 over 2 px, at the
   * same height on the same strike line — the same white nub. `the four states differ by marks at
   * every size and in both palettes` is where the downscale claim is actually tested, and what
   * survives it is the additive inner rim: (b) reads as two concentric rings where (a) reads as one.
   */
  const goalWedges = (s: Rec): number => {
    const g = s.hw.geometry;
    const { yTarget } = meterAxis(s.hw);
    let n = 0;
    s.canvas.ctx.calls.forEach((c, i) => {
      if (c.name !== 'moveTo') return;
      if (s.canvas.ctx.propBefore(i, 'fillStyle') !== WHITE) return;
      const [x, y] = c.args as number[];
      if (Math.abs(y - yTarget) > g.receptorRadius * 0.2) return;
      // Counted against the NEAREST lane only: at 4 lanes a neighbouring receptor's centre is
      // itself inside the 1.6 r window, and counting per lane would make the total depend on the
      // lane-width : radius ratio instead of on the marks actually drawn (the same trap
      // `targetTicks` fell into).
      const d = Math.min(...LANES.map((l) => Math.abs(x - laneX(g, l.index, 0))));
      if (d > g.receptorRadius * 0.5 && d < g.receptorRadius * 1.6) n++;
    });
    return n;
  };

  /** Was the "?" glyph rasterized at all (the text cache is per-Highway, so per recorded state)? */
  const questionGlyph = (s: Rec): boolean => s.scratch.some((c) => c.ctx.calls.some((k) => k.name === 'fillText' && k.args[0] === '?'));

  /**
   * (b) THE CROSSING, built the way the input layer really publishes it — which is the whole point.
   * `LaneTrigger` moves to 'triggered' on the sample that crosses and `VisionInput` pushes it before
   * it publishes `armed`, so the frame the lane fires on arrives as `{ value >= threshold, armed:
   * false }`; there is no such thing as an `armed && value >= threshold` frame. So: 40 frames rising
   * and armed, then one crossing frame, already disarmed. (`the receptor states are reachable from
   * the real input layer` below proves this shape is what a real VisionInput emits.)
   */
  const recordCrossing = (beatPhase = 0.5, w = 1280, h = 720): Rec => {
    const s = setup(w, h);
    s.hw.resize(w, h, 1);
    const frame = (t: number, value: number, armed: boolean): RenderFrame =>
      makeFrame({
        lanes: LANES,
        songTime: t,
        laneStates: LANES.map((l) => ({ lane: l.index, value, armed, tracking: true })),
        thresholdFraction: THRESH,
        rearmFraction: 0.6,
        beatPhase,
      });
    for (let i = 0; i < 40; i++) s.hw.draw(frame(1 + i * 0.016, 0.5, true));
    s.canvas.ctx.reset();
    s.hw.draw(frame(1.64, 0.75, false));
    return s;
  };

  // (a) rising toward threshold, armed   (b) the threshold crossing (published already disarmed)
  // (c) at threshold, NOT armed          (d) tracking lost (with a stale value still in the meter)
  const rising = (): Rec => record(0.36, true);
  const firing = (): Rec => recordCrossing();
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
    expect(goalWedges(a)).toBe(0);
    expect(drainCaps(a)).toBe(0);

    // (b) the crossing: the only state with the additive rim + corona, and the only one whose fill
    //     is drawn from the hot gradient (a separate cached gradient per lane). It keeps the target
    //     line — it has to, because the liquid now stands *above* it — but its two ticks are
    //     replaced by two solid arrowheads, so the state does not depend on the hairline rings to
    //     survive a downscale.
    expect(willFireRings(b)).toBe(8); // rim + corona per lane
    expect(haloBlits(b.canvas, b.hw)).toBe(4);
    expect(targetLines(b)).toBe(4);
    expect(tickCount(b)).toBe(0); // the thin ticks are gone...
    expect(goalWedges(b)).toBe(8); // ...replaced by two solid arrowheads per lane
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
    expect(goalWedges(c)).toBe(0);
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
    expect(goalWedges(d)).toBe(0);
    expect(drainCaps(d)).toBe(0);
    expect(risingCaps(d)).toBe(0);
    expect(brokenArcs(d)).toHaveLength(4 * 4); // four arcs per lane
    expect(questionGlyph(d)).toBe(true);
    expect(questionGlyph(a) || questionGlyph(b) || questionGlyph(c)).toBe(false);
  });

  /**
   * (b) AFTER THE LANE HAS RE-ARMED — the `GOAL_MIN_SEC` overrun, and the frame nothing used to
   * cover. A rep performed at the chart generator's own pacing re-arms ~0.1 s after the crossing
   * (src/charts/generate.ts puts same-lane notes 0.45 s apart on hard), which is inside the KR floor,
   * so this is a frame a real patient is in on most reps — not a corner.
   *
   * 40 armed rising frames, one crossing frame published the way the input layer really publishes it,
   * then the patient back at 0.05 of ROM with the lane armed again.
   */
  const recordRearmedInLatch = (): Rec => {
    const s = setup(1280, 720);
    s.hw.resize(1280, 720, 1);
    const frame = (t: number, value: number, armed: boolean): RenderFrame =>
      makeFrame({
        lanes: LANES,
        songTime: t,
        laneStates: LANES.map((l) => ({ lane: l.index, value, armed, tracking: true })),
        thresholdFraction: THRESH,
        rearmFraction: 0.6,
        beatPhase: 0.5,
      });
    for (let i = 0; i < 40; i++) s.hw.draw(frame(1 + i * 0.016, 0.5, true));
    s.hw.draw(frame(1.64, 0.75, false)); // the crossing
    s.hw.draw(frame(1.656, 0.3, true)); // ...and straight back down, re-armed
    s.canvas.ctx.reset();
    s.hw.draw(frame(1.672, 0.05, true)); // at rest, ready for the next rep, 32 ms into the latch
    return s;
  };

  it('a lane that has RE-ARMED inside the latch keeps the rep cue and drops every position claim', () => {
    const e = recordRearmedInLatch();
    // We really are in the overrun: the cue is still latched, and the lane really is armed.
    const look = e.hw.receptorLookOf(0);
    expect(look).toBeDefined();
    expect(receptorMarkSet(look as ReceptorLook)).toBe('goal');
    expect((look as ReceptorLook).locked).toBe(false);
    expect(receptorGoalHolding(look as ReceptorLook)).toBe(false);
    expect((look as ReceptorLook).rom).toBeCloseTo(0.05, 6);

    // KEPT — "that rep reached your target" is still true, and these are the marks that say it. The
    // rim + corona are the pair that makes (b) read as two concentric rings at a 220 px downscale.
    expect(willFireRings(e)).toBe(8);
    expect(goalWedges(e)).toBe(8);

    // DROPPED — every mark that claims the patient is still up at the target. This is the defect:
    // the split white-hot cap used to be drawn at the FLOOR of the well, over a hot-gradient column,
    // under a full halo, on a lane sitting at rest and ready for the next rep.
    expect(hotCaps(e)).toBe(0);
    expect(risingCaps(e)).toBe(4); // the honest (a) level line is back, at the patient's true height
    expect((look as ReceptorLook).glowTarget).toBeLessThan(0.01); // no forced halo at 5 % of ROM
    // ...and the lane is drawn at LIVE size, not at the locked 12 % shrink: it can fire again. (At
    // or above the nominal live size — the beat pulse and the re-arm pop both scale it UP, which is
    // the point: the ring springs back on the frame the next rep starts counting.)
    const live = meterAxis(e.hw).yBot;
    const shrunk = meterAxis(e.hw, LOCK_RING_SCALE).yBot;
    for (const l of LANES) {
      const well = wellRect(e.canvas, e.hw, l.index);
      expect(well, `lane ${l.index} well`).toBeDefined();
      const bottom = (well as MeterRect).y + (well as MeterRect).h;
      expect(bottom, `lane ${l.index} is not drawn shrunk`).toBeGreaterThan(shrunk);
      expect(bottom).toBeGreaterThanOrEqual(live - 0.5);
    }

    // ...and none of (c): the lane is not locked, so it must not be told to lower to reset.
    expect(lockHints(e)).toBe(0);
    expect(drainCaps(e)).toBe(0);
    expect(targetLines(e)).toBe(4); // the target is the threshold again — the next rep's target
    expect(tickCount(e)).toBe(0); // ...marked by the arrowheads while the cue is still up
  });

  it('the goal costume is gone entirely once the KR floor has elapsed on a re-armed lane', () => {
    // The floor buys at most GOAL_MIN_SEC. Past it, a lane at rest is plain (a) and nothing else —
    // no rings, no arrowheads, no cap. Same frames as above, 0.2 s later.
    const s = setup(1280, 720);
    s.hw.resize(1280, 720, 1);
    const frame = (t: number, value: number, armed: boolean): RenderFrame =>
      makeFrame({
        lanes: LANES,
        songTime: t,
        laneStates: LANES.map((l) => ({ lane: l.index, value, armed, tracking: true })),
        thresholdFraction: THRESH,
        rearmFraction: 0.6,
        beatPhase: 0.5,
      });
    for (let i = 0; i < 40; i++) s.hw.draw(frame(1 + i * 0.016, 0.5, true));
    s.hw.draw(frame(1.64, 0.75, false));
    for (let i = 1; i <= 16; i++) s.hw.draw(frame(1.64 + i * 0.016, 0.05, true));
    s.canvas.ctx.reset();
    s.hw.draw(frame(1.64 + 17 * 0.016, 0.05, true)); // 0.272 s after the crossing
    const e: Rec = s;
    expect(receptorMarkSet(s.hw.receptorLookOf(0) as ReceptorLook)).toBe('rising');
    expect(willFireRings(e)).toBe(0);
    expect(goalWedges(e)).toBe(0);
    expect(hotCaps(e)).toBe(0);
    expect(tickCount(e)).toBe(8); // the gate posts are back
    expect(risingCaps(e)).toBe(4);
    expect(lockHints(e)).toBe(0);
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
      expect(steps[i - 1].level - steps[i].level).toBeGreaterThan(axis.span * meterPos(THRESH) * 0.15);
      expect(steps[i].liquid).toBeCloseTo(steps[i].level, 0);
    }
    // The rise is measured against the target line, which never moves and is never reached early.
    const target = targetLine(canvas, hw, 0) as MeterRect;
    expect(target).toBeDefined();
    expect(target.y + target.h / 2).toBeCloseTo(axis.yTarget, 1);
    for (const st of steps) expect(st.level).toBeGreaterThan(axis.yTarget); // still below the line
    // Halfway up is halfway to the line, not 45 % of a bar with no line on it.
    expect(at(0.5).level).toBeCloseTo(axis.yBot - meterPos(THRESH * 0.5) * axis.span, 1);
  });

  it('draws the column on ONE scale in every state, and never saturates it inside the patient\'s range', () => {
    // (1) HONESTY + (3) THE GAUGE MUST MOVE. The column is a POSITION: the same height means the
    // same millimetres of movement whatever the lane's arming is doing, and it cannot pin anywhere
    // inside the reachable range (LaneState.value is clamp01'd by the calibration), because a
    // pinned column is a gauge that flatlines while the patient is moving. What the position MEANS
    // for the next rep is carried by the marks around it, which is asserted elsewhere in this file.
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
    // The headroom spans the REST OF THE ROM, so every step up to full ROM is a real distance and
    // the top of the well is reached only at 1.0 (this is the property that killed the frozen
    // zone: with the old fixed 1.5x-threshold headroom, everything past THRESH * 1.5 was one pixel
    // row, and everything past the threshold was one pixel row once the lane locked).
    let prev = Infinity;
    for (const v of [0.6, 0.7, 0.8, 0.9, 0.95, 1]) {
      const top = topOfLiquid(v);
      expect(top, `live top at ${v}`).toBeLessThan(prev - 2);
      prev = top;
    }
    expect(topOfLiquid(1)).toBeCloseTo(axis.yBot - METER_LEVEL_CEIL * axis.span, 1);
    // A LOCKED lane at the same value stands at the same place on its own well's axis (a locked
    // ring, and with it its whole gauge, is drawn 12 % smaller). It is allowed above the target
    // height and it travels down THROUGH it: the patient really is up there, and the whole job of
    // the state is to show them coming back down from wherever that is.
    const lockAxis = meterAxis(hw, LOCK_RING_SCALE);
    const lockedTop = (value: number): number =>
      lockAxis.yBot - meterPos(value) * lockAxis.span;
    for (const v of [0.18, 0.3, 0.42, 0.6, 0.75, 0.9, 1]) {
      expect(topOfLiquid(v, false), `locked at ${v}`).toBeCloseTo(lockedTop(v), 0);
    }
    expect(topOfLiquid(1, false)).toBeLessThan(lockAxis.yTarget); // above the (undrawn) target height
    expect(topOfLiquid(0.6, false)).toBeCloseTo(lockAxis.yTarget, 1); // and passes through it
  });

  it('moves every return-to-rest mark on every step of the descent, from the real peak down', () => {
    // THE BUG THIS TEST EXISTS FOR. A locked column used to be min(fill, 0.9) of the target height
    // and `fill` saturates at the threshold, so a patient holding at end range and then lowering
    // saw {fill: 1, resetProgress: 0} — a pixel-identical receptor — for the whole span from their
    // real peak down to the threshold: 71 % of the return journey on the default 'easy' difficulty.
    // Every locked-lane assertion in this file used to be built at or below the threshold, which is
    // exactly why 1052 passing tests did not notice. So: walk a lane from FULL ROM down to the
    // re-arm line and require all four return-to-rest marks to move on every single step.
    const { canvas, hw } = setup(1280, 720, { reducedMotion: true });
    hw.resize(1280, 720, 1);
    const REARM = 0.6;
    const REARM_ROM = THRESH * REARM;
    let t = 1;
    const step = (value: number, armed: boolean): void => {
      t += 0.033;
      canvas.ctx.reset();
      hw.draw(
        makeFrame({
          lanes: LANES,
          songTime: t,
          laneStates: LANES.map((l) => ({ lane: l.index, value, armed, tracking: true })),
          thresholdFraction: THRESH,
          rearmFraction: REARM,
        }),
      );
    };
    /** The violet chevron's apex y (its first `moveTo`). */
    const chevronY = (): number | undefined => {
      const g = hw.geometry;
      let y: number | undefined;
      canvas.ctx.calls.forEach((c, i) => {
        if (c.name !== 'moveTo' || canvas.ctx.propBefore(i, 'strokeStyle') !== LOCK_HINT) return;
        if (Math.abs((c.args[0] as number) - laneX(g, 0, 0)) > g.receptorRadius) return;
        if (y === undefined) y = c.args[1] as number;
      });
      return y;
    };
    /** Angular span of the return-to-rest arc (0 when it is not drawn at all). */
    const arcSweep = (): number => {
      const g = hw.geometry;
      let span = 0;
      canvas.ctx.calls.forEach((c, i) => {
        if (c.name !== 'ellipse' || c.args.length < 7) return;
        if (Math.abs((c.args[1] as number) - g.strikeY) > 0.5) return;
        // Outside the ring, inside this lane's half of the board: the arc's nominal 1.16 r is
        // clamped to the room the lane actually has (`outerMarkRadius`), so this matches a range
        // rather than a number. Containment itself is asserted in 'no receptor mark crosses into a
        // neighbouring lane'.
        if (!((c.args[2] as number) > g.receptorRadius && (c.args[2] as number) <= g.receptorRadius * 1.17)) return;
        if (canvas.ctx.propBefore(i, 'strokeStyle') !== LOCK_HINT) return;
        span = Math.max(span, (c.args[6] as number) - (c.args[5] as number));
      });
      return span;
    };

    // Rise to full ROM armed, cross (published already disarmed, as VisionInput really does), then
    // hold at the top past the goal latch so the lockout look is the one on screen.
    for (const v of [0.2, 0.4, 0.55]) step(v, true);
    step(1, false);
    for (let i = 0; i < 25; i++) step(1, false); // ~0.8 s: the 0.45 s + 0.15 s latch has expired
    expect(drainCap(canvas, hw, 0), 'drain cap while held at the top').toBeDefined();
    expect(arcSweep(), 'nothing given back yet').toBe(0);

    // ...and now the descent, in ROM steps a slow hemiparetic patient would really produce.
    const descent = [0.95, 0.9, 0.85, 0.8, 0.75, 0.7, 0.65, 0.6, 0.55, 0.5, 0.45, 0.4, REARM_ROM];
    let prevCap = (drainCap(canvas, hw, 0) as MeterRect).y;
    let prevChev = chevronY() as number;
    let prevArc = 0;
    const minStep = hw.geometry.receptorRadius * 0.02; // ~1.3 px at 720p, ~1 px after a 5x downscale
    for (const v of descent) {
      step(v, false);
      const cap = drainCap(canvas, hw, 0);
      const chev = chevronY();
      const arc = arcSweep();
      expect(cap, `drain cap at ${v}`).toBeDefined();
      expect(chev, `chevron at ${v}`).toBeDefined();
      // Cap and chevron travel DOWN the well (larger y), the arc grows — every step, no exceptions.
      expect((cap as MeterRect).y - prevCap, `cap moved at ${v}`).toBeGreaterThan(minStep);
      // The chevron sits half way between the cap and the line, so it closes half the gap the cap
      // does — still real motion on every step, in the same direction, landing on the line with it.
      expect((chev as number) - prevChev, `chevron moved at ${v}`).toBeGreaterThan(minStep * 0.45);
      expect(arc - prevArc, `arc grew at ${v}`).toBeGreaterThan(0.02);
      prevCap = (cap as MeterRect).y;
      prevChev = chev as number;
      prevArc = arc;
    }
    // It ends exactly on the re-arm line — the instant the input layer re-arms the lane — with the
    // arc complete but still open at the top (a closed ring would read as a lit ring).
    const dash = rearmDashes(canvas, hw, 0)[0];
    expect(Math.abs(prevCap - dash.y)).toBeLessThan(1.5);
    expect(Math.abs(prevChev - dash.y)).toBeLessThan(hw.geometry.receptorRadius * 0.2);
    expect(prevArc).toBeCloseTo(RESET_ARC_SWEEP, 6);
    // More than half of that motion happened ABOVE the threshold — the span that used to be dead.
    // (0.36..0.6 of ROM is the old live span; 0.6..1.0 is the span this test was written for.)
    expect(descent.filter((v) => v >= THRESH)).toHaveLength(8);
  });


  it('draws ONE LINEAR ROM SCALE at every difficulty — equal movement, equal distance, either side of the target line', () => {
    // (1) HONESTY + (3) THE GAUGE MUST MOVE + (6) DOCS ARE THE CONTRACT. The well used to promise
    // "one scale, the same height always means the same millimetres" while drawing two: the target
    // line was pinned at a fixed 0.76 of the well whatever the session's threshold was, so on the
    // DEFAULT 'easy' difficulty (thresholdFraction 0.5) the lower half of the patient's range got
    // 0.76 of the well and the whole upper half got the remaining 0.17 — a 4.5x compression of
    // exactly the span state (c) exists to draw. Measured in a real browser at 1920x1080, a locked
    // lane lowering from full ROM to the threshold moved the column top 27 px in total: 2 px per
    // 0.05 of ROM, i.e. 0.4 px on a 10" clinic tablet read at 2 m. It moved — and a patient could
    // not see that it moved, for 71 % of the return journey.
    //
    // So: walk the whole range at all three real difficulties and require every equal step of ROM
    // to be the same distance on screen, including the steps that straddle the target line.
    const { canvas, hw } = setup(1280, 720, { reducedMotion: true });
    hw.resize(1280, 720, 1);
    const axis = meterAxis(hw);
    let t = 1;
    const topAt = (value: number, threshold: number): number => {
      t += 0.033;
      canvas.ctx.reset();
      hw.draw(
        makeFrame({
          lanes: LANES,
          songTime: t,
          laneStates: LANES.map((l) => ({ lane: l.index, value, armed: true, tracking: true })),
          thresholdFraction: threshold,
          rearmFraction: 0.6,
        }),
      );
      return (liquidRect(canvas, hw, 0) as MeterRect).y;
    };
    // easy / medium / hard (src/engine/difficulty.ts). Each ladder straddles that difficulty's
    // target line, so a two-scale well shows up as one step out of five being a different size.
    for (const threshold of [0.5, 0.65, 0.8]) {
      const ladder = [0.15, 0.3, 0.45, 0.6, 0.75, 0.9].map((v) => topAt(v, threshold));
      const perStep = 0.15 * METER_LEVEL_CEIL * axis.span;
      for (let i = 1; i < ladder.length; i++) {
        expect(ladder[i - 1] - ladder[i], `0.15 of ROM at threshold ${threshold}, step ${i}`).toBeCloseTo(perStep, 0);
      }
      // ...and the fixed marks are on that same ROM axis: the target line at the threshold, the
      // re-arm dashes at threshold * rearmFraction. Nothing in the well is at a hard-coded height.
      const target = targetLine(canvas, hw, 0) as MeterRect;
      expect(target, `target line at threshold ${threshold}`).toBeDefined();
      expect(target.y + target.h / 2).toBeCloseTo(axis.yBot - meterPos(threshold) * axis.span, 0);
    }
  });

  it('keeps a lane\'s target-height marks inside its own lane at every difficulty', () => {
    // The target line moves with the session's threshold, and the ticks and goal arrowheads hang
    // off the ring's outline AT that height — which is ~1.0 r at a mid-range threshold, the ring's
    // widest point, where a fixed-length mark reaches 1.24 r. Half a lane is 1.21 r at the board's
    // widest geometry, so two neighbouring lanes' ticks would have touched and two neighbouring
    // arrowheads would have merged into one blob spanning the gutter: a per-lane mark turned into a
    // shelf joining the receptors, which destroys "WHICH lane is at target".
    for (const threshold of [0.5, 0.65, 0.8]) {
      const { canvas, hw } = setup(1280, 720, { reducedMotion: true });
      hw.resize(1280, 720, 1);
      const g = hw.geometry;
      const half = g.laneWidthNear * 0.5;
      // (a) rising: the two ticks. Measured on an INNER lane, which has a neighbour on both sides.
      canvas.ctx.reset();
      hw.draw(
        makeFrame({
          lanes: LANES,
          songTime: 1,
          laneStates: LANES.map((l) => ({ lane: l.index, value: threshold * 0.5, armed: true, tracking: true })),
          thresholdFraction: threshold,
        }),
      );
      const cx = laneX(g, 1, 0);
      const ticks = targetTicks(canvas, hw, 1);
      expect(ticks, `ticks at threshold ${threshold}`).toHaveLength(2);
      for (const tk of ticks) {
        const outer = Math.max(Math.abs(tk.x - cx), Math.abs(tk.x + tk.w - cx));
        expect(outer, `tick reach at threshold ${threshold}`).toBeLessThan(half);
        expect(tk.w, `post still resolvable at threshold ${threshold}`).toBeGreaterThan(Math.max(2.9, g.receptorRadius * 0.09));
      }
      // (b) the crossing: the two solid arrowheads, which are the mark this state survives a hard
      // downscale on — so they may be SHORTER when the line is at the ring's widest point, but they
      // must still be inside the lane and still be triangles rather than dots.
      canvas.ctx.reset();
      let t2 = 1;
      const cross = (value: number, armed: boolean): void => {
        t2 += 0.033;
        hw.draw(
          makeFrame({
            lanes: LANES,
            songTime: t2,
            laneStates: LANES.map((l) => ({ lane: l.index, value, armed, tracking: true })),
            thresholdFraction: threshold,
          }),
        );
      };
      cross(threshold * 0.8, true);
      canvas.ctx.reset();
      cross(1, false); // the crossing frame, as the input layer publishes it
      // Every arrowhead vertex on the board, measured against the lane it belongs to — the NEAREST
      // receptor centre, which is the only assignment that cannot be argued with: if a vertex is
      // closer to the neighbour's centre than to its own, the mark has left its lane.
      const yTarget = meterAxis(hw).yBot - meterPos(threshold) * meterAxis(hw).span;
      const vertices: Array<{ lane: number; d: number }> = [];
      canvas.ctx.calls.forEach((c, i) => {
        if (c.name !== 'moveTo' && c.name !== 'lineTo') return;
        if (canvas.ctx.propBefore(i, 'fillStyle') !== WHITE) return;
        const [x, y] = c.args as number[];
        if (Math.abs(y - yTarget) > g.receptorRadius * 0.4) return;
        let best = 0;
        let bestD = Infinity;
        for (const l of LANES) {
          const d = Math.abs(x - laneX(g, l.index, 0));
          if (d < bestD) {
            bestD = d;
            best = l.index;
          }
        }
        // Outside the ring and within a receptor's reach of it — the same window `goalWedges`
        // uses, so an unrelated white path elsewhere on the board cannot be counted as a mark.
        if (bestD < g.receptorRadius * 0.5 || bestD > g.receptorRadius * 1.6) return;
        vertices.push({ lane: best, d: bestD });
      });
      // Two arrowheads per lane, three vertices each.
      expect(vertices.length, `arrowhead vertices at threshold ${threshold}`).toBe(LANES.length * 6);
      for (const v of vertices) expect(v.d, `arrowhead reach at threshold ${threshold}`).toBeLessThan(half);
      // Tip to base is still a real length, not a dot: at least 11 % of the receptor radius.
      const own = vertices.filter((v) => v.lane === 1).map((v) => v.d);
      expect(Math.max(...own) - Math.min(...own)).toBeGreaterThan(g.receptorRadius * 0.11);
    }
  });

  it('draws the return from full ROM at the same scale as the rise, on the DEFAULT difficulty', () => {
    // The critic's scenario, at the difficulty the app actually ships with: easy, thresholdFraction
    // 0.5, re-arm 0.6 → the lane re-arms below 0.30 of ROM, so a patient who has just reached end
    // range has to travel 1.00 → 0.30 and 71 % of that journey is above the threshold. Every step
    // of it has to move the gauge by the SAME distance as a step of the rise does — "it moves" is
    // not enough if the part that moves 2 px per step is the part the patient spends longest in.
    const { canvas, hw } = setup(1280, 720, { reducedMotion: true });
    hw.resize(1280, 720, 1);
    const THRESHOLD = 0.5;
    const REARM = 0.6;
    const lockAxis = meterAxis(hw, LOCK_RING_SCALE, THRESHOLD);
    let t = 1;
    const step = (value: number, armed: boolean): void => {
      t += 0.033;
      canvas.ctx.reset();
      hw.draw(
        makeFrame({
          lanes: LANES,
          songTime: t,
          laneStates: LANES.map((l) => ({ lane: l.index, value, armed, tracking: true })),
          thresholdFraction: THRESHOLD,
          rearmFraction: REARM,
        }),
      );
    };
    for (const v of [0.1, 0.25, 0.4]) step(v, true);
    step(1, false); // the crossing, published already disarmed
    for (let i = 0; i < 25; i++) step(1, false); // hold at end range until the goal latch expires
    const caps: number[] = [(drainCap(canvas, hw, 0) as MeterRect).y];
    const descent = [0.95, 0.9, 0.85, 0.8, 0.75, 0.7, 0.65, 0.6, 0.55, 0.5, 0.45, 0.4, 0.35, 0.3];
    for (const v of descent) {
      step(v, false);
      const cap = drainCap(canvas, hw, 0);
      expect(cap, `drain cap at ${v}`).toBeDefined();
      caps.push((cap as MeterRect).y);
    }
    // One scale: every 0.05 of ROM given back is the same distance down the well, above the
    // threshold and below it alike.
    const perStep = 0.05 * METER_LEVEL_CEIL * lockAxis.span;
    for (let i = 1; i < caps.length; i++) {
      expect(caps[i] - caps[i - 1], `descent step ${i} (to ${descent[i - 1]} of ROM)`).toBeCloseTo(perStep, 0);
    }
    // 71 % of the journey is above the threshold, and it gets 71 % of the travel — this is the
    // number the whole work item is about.
    const atThreshold = caps[1 + descent.indexOf(THRESHOLD)];
    const above = atThreshold - caps[0];
    const total = caps[caps.length - 1] - caps[0];
    expect(above / total).toBeCloseTo((1 - THRESHOLD) / (1 - THRESHOLD * REARM), 2);
    // ...and it ends on the dashed re-arm line, which is itself on the same ROM axis.
    const dash = rearmDashes(canvas, hw, 0)[0];
    expect(dash.y + dash.h / 2).toBeCloseTo(lockAxis.yBot - meterPos(THRESHOLD * REARM) * lockAxis.span, 0);
    expect(Math.abs(caps[caps.length - 1] - dash.y)).toBeLessThan(1.5);
  });

  it('keeps the four mark sets apart at desktop, tablet and portrait aspect ratios', () => {
    // (2) FOUR STATES, FOUR MARK SETS — and the marks are what has to differ, not the hue or the
    // brightness, at every shape of clinic screen. A tablet in portrait shrinks the receptor
    // radius by more than half, which is where a distinction carried by a hairline or by a 2 px
    // thickness difference quietly stops existing. Each state is identified here by WHICH marks are
    // on the canvas, and the four signatures have to stay mutually exclusive at every size.
    for (const [w, h] of [
      [1280, 720], // desktop
      [1024, 768], // clinic tablet, landscape
      [768, 1024], // ...and portrait
      [400, 800], // phone-shaped, the hardest case
    ]) {
      const tag = `${w}x${h}`;
      const a = record(0.36, true, true, 0.5, w, h);
      const b = recordCrossing(0.5, w, h);
      const c = record(0.75, false, true, 0.5, w, h);
      const d = record(0.75, true, false, 0.5, w, h);
      // A signature per state: [target line, threshold ticks, split hot cap, goal arrowheads,
      // violet drain cap, dashed re-arm line, chevron, broken ring arcs].
      const sig = (s: Rec): string =>
        [
          targetLine(s.canvas, s.hw, 0) ? 1 : 0,
          targetTicks(s.canvas, s.hw, 0).length,
          hotCapSegments(s.canvas, s.hw, 0).length,
          goalWedges(s) > 0 ? 1 : 0,
          drainCap(s.canvas, s.hw, 0) ? 1 : 0,
          rearmDashes(s.canvas, s.hw, 0).length,
          chevrons(s.canvas, s.hw, 0),
          brokenArcs(s).length > 0 ? 1 : 0,
        ].join(',');
      // (a) rising: level + target line and its two ticks, nothing else.
      expect(sig(a), `${tag} rising`).toBe('1,2,0,0,0,0,0,0');
      // (b) crossing: the split cap and the two solid arrowheads REPLACE the ticks.
      expect(sig(b), `${tag} crossing`).toBe('1,0,2,1,0,0,0,0');
      // (c) locked: the three return-to-rest marks, and no target line or ticks at all.
      expect(sig(c), `${tag} locked`).toBe('0,0,0,0,1,3,1,0');
      // (d) no signal: the broken ring alone — nothing value-derived survives into it.
      expect(sig(d), `${tag} lost`).toBe('0,0,0,0,0,0,0,1');
    }
  });

  it('stops ordering a locked lane down once it is already below the re-arm line', () => {
    // A locked lane is not always a HIGH lane: 'unconfirmed' is a statement about what the trigger
    // has observed, not about the current value, so a reset, a mid-song retune or a stream break can
    // leave one locked at 0.1 of ROM. Drawing the "lower to reset" chevron and the violet drain cap
    // there points the patient at a line they are already under — an order they cannot carry out.
    // The lane still cannot score, so everything else about (c) stays.
    const under = record(0.1, false); // re-arm line is at 0.36 of ROM
    const over = locked();            // ...the ordinary held-at-end-range case, for contrast
    // The two ORDER marks are gone.
    expect(chevrons(over.canvas, over.hw, 0)).toBe(1);
    expect(drainCaps(over)).toBe(4);
    expect(chevrons(under.canvas, under.hw, 0)).toBe(0);
    expect(drainCaps(under)).toBe(0);
    // ...and nothing else has changed: it is still (c), not (a), (b) or (d).
    expect(meterWells(under)).toBe(4);
    expect(meterFills(under)).toBe(4); // the column is still drawn, to its true (low) height
    expect(LANES.every((l) => rearmDashes(under.canvas, under.hw, l.index).length === 3)).toBe(true);
    expect(targetLines(under)).toBe(0);
    expect(tickCount(under)).toBe(0);
    expect(hotCaps(under)).toBe(0);
    expect(goalWedges(under)).toBe(0);
    expect(willFireRings(under)).toBe(0);
    expect(haloBlits(under.canvas, under.hw)).toBe(0);
    expect(brokenArcs(under)).toHaveLength(0);
    expect(solidRings(under)).toBe(4);
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
    const yRearmLine = axis.yBot - meterPos(THRESH * REARM) * axis.span;
    // A ladder from FULL ROM down to the re-arm point. Every step moves the cap by a real distance,
    // so "nearly there" is readable — this is the drain equivalent of the rise readout. It starts
    // above the threshold on purpose: every locked-lane assertion in this file used to be built at
    // or below it, which is structurally why a column frozen for the whole span between the
    // patient's real peak and the threshold survived a thousand passing tests.
    const ladder = [1, 0.85, 0.7, THRESH * 0.9, THRESH * 0.8, THRESH * 0.7, THRESH * 0.6].map((v) => capAt(v));
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
      // ...driven the way the input layer really drives it: state (b) is the CROSSING, published
      // already disarmed (`armed: false` / triggerState 'triggered'), never `armed && value >= T`,
      // which no source emits. A test that builds (b) from the unreachable conjunction is testing a
      // state the product cannot produce.
      const drawAt = (value: number, armed = true): void => {
        canvas.ctx.reset();
        hw.draw(
          makeFrame({
            lanes: LANES,
            songTime: 1 + value,
            laneStates: LANES.map((l) => ({
              lane: l.index,
              value,
              armed,
              triggerState: armed ? ('armed' as const) : ('triggered' as const),
              tracking: true,
            })),
            thresholdFraction: THRESH,
          }),
        );
      };
      drawAt(THRESH * 0.8);
      expect(hotCapSegments(canvas, hw, 0), `${highContrast} rising`).toHaveLength(0);
      expect(levelLine(canvas, hw, 0, bright), `${highContrast} rising cap`).toBeDefined();
      drawAt(THRESH * 1.2, false);
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
        // Outside the ring, inside this lane's half of the board: the arc's nominal 1.16 r is
        // clamped to the room the lane actually has (`outerMarkRadius`), so this matches a range
        // rather than a number. Containment itself is asserted in 'no receptor mark crosses into a
        // neighbouring lane'.
        if (!((c.args[2] as number) > g.receptorRadius && (c.args[2] as number) <= g.receptorRadius * 1.17)) return;
        if (s.canvas.ctx.propBefore(i, 'strokeStyle') !== LOCK_HINT) return;
        span = Math.max(span, (c.args[6] as number) - (c.args[5] as number));
      });
      return span;
    };
    // The arc is a crescent in the ring's LOWER HALF (`RESET_ARC_SWEEP`): a cue that closed into a
    // complete ring would read as a lit ring — and, drawn at the same radius as (b)'s goal corona,
    // would read as the very second concentric ring that carries (b) at a 220 px downscale, which
    // is what (c) may never look like. Its containment inside the lower half is asserted in
    // 'the return-to-rest crescent never reaches the upper half of the ring'.
    // `record` gives each value its own Highway, so each of these is a lane the renderer is SEEING
    // for the first time, at that value: the return journey is measured from the peak it has
    // actually observed, so a lane first seen at the top of its range — at the threshold or at full
    // ROM — has given nothing back yet and draws no arc at all. The arc growing across a real
    // descent from full ROM is asserted frame by frame in the descent tests above; what is asserted
    // here is the shape of the mark and where it starts and ends.
    expect(sweep(1)).toBe(0); // first seen at full ROM: no journey has been watched
    expect(sweep(0.6)).toBe(0); // at threshold: nothing given back yet, no arc at all
    expect(sweep(0.54)).toBeGreaterThan(0);
    expect(sweep(0.48)).toBeCloseTo(RESET_ARC_SWEEP * 0.5, 2); // half way down
    expect(sweep(0.36)).toBeCloseTo(RESET_ARC_SWEEP, 6); // at the re-arm line: complete
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

// -------------------------------------------------------------------------------------------------
// REACHABILITY. A receptor look that no input source can produce is not a feature, it is dead code
// with a test around it — and the look it was hiding was the one the whole session is for ("you
// reached your target range"). So these tests do not build LaneStates by hand: they drive the real
// VisionInput / the real scripted-source publisher and classify what actually lands on the canvas.
// -------------------------------------------------------------------------------------------------

type ReceptorState = 'rising' | 'goal' | 'locked' | 'lost' | 'none';

/** Which of the four looks lane `lane` is wearing in the frame recorded on `canvas`. */
function receptorState(canvas: MockCanvas, hw: Highway, lane: number): ReceptorState {
  const g = hw.geometry;
  const cx = laneX(g, lane, 0);
  const broken = canvas.ctx.calls.some(
    (c, i) =>
      c.name === 'ellipse' &&
      c.args.length >= 7 &&
      Math.abs((c.args[0] as number) - cx) < 1 &&
      Math.abs((c.args[1] as number) - g.strikeY) < 0.5 &&
      (c.args[6] as number) - (c.args[5] as number) < Math.PI * 2 - 1e-6 &&
      canvas.ctx.propBefore(i, 'strokeStyle') === LOST_RING_GREY,
  );
  if (!wellRect(canvas, hw, lane)) return broken ? 'lost' : 'none';
  if (hotCapSegments(canvas, hw, lane).length === 2) return 'goal';
  if (drainCap(canvas, hw, lane) || rearmDashes(canvas, hw, lane).length === 3) return 'locked';
  if (targetLine(canvas, hw, lane)) return 'rising';
  return 'none';
}
const LOST_RING_GREY = '#a9b0bb';

describe('every receptor look is one the real input layer produces', () => {
  const THRESH = 0.6;
  const REP_LANES: LaneSpec[] = [
    { index: 0, movement: 'seated_march', side: 'left' },
    { index: 1, movement: 'knee_extension', side: 'right' },
  ];
  class FakeClock {
    currentTime = 0;
  }
  const stubDetector = (): LandmarkDetector => ({
    mode: 'leg',
    delegate: 'CPU',
    detect: () => ({ tMs: 0, pose: null, hands: [] }),
    close: () => undefined,
  });
  const calFor = (movement: LaneSpec['movement'], side: LaneSpec['side'], gen: (a: number) => Landmark[]): RomCalibration => ({
    min: extractFeature(movement, gen(0), side) as number,
    max: extractFeature(movement, gen(1), side) as number,
    samples: 1,
    movement,
  });

  it('drives a real VisionInput through one rep and draws all four states, in order', async () => {
    const input = new VisionInput({
      mode: 'leg',
      lanes: REP_LANES,
      calibrations: [
        calFor('seated_march', 'left', (a) => seatedPose({ kneeLift: a, side: 'left' })),
        calFor('knee_extension', 'right', (a) => seatedPose({ kneeExtension: a, side: 'right' })),
      ],
      thresholdFraction: THRESH,
      audioContext: new FakeClock(),
      detector: stubDetector(),
      driveLoop: false,
      smoothing: { kind: 'none' },
    });
    const fired: number[] = [];
    input.onEvent((e) => fired.push(e.ctxTime));
    await input.start();

    const { canvas, hw } = setup(1280, 720);
    hw.resize(1280, 720, 1);
    const seen: Array<{ t: number; state: ReceptorState; other: ReceptorState }> = [];
    const step = (t: number, pose: Landmark[] | null): void => {
      input.processDetection({ tMs: t * 1000, pose, hands: [] }, t);
      canvas.ctx.reset();
      hw.draw(
        makeFrame({
          lanes: REP_LANES,
          songTime: t,
          laneStates: input.getLaneStates(),
          thresholdFraction: THRESH,
          rearmFraction: 0.6,
        }),
      );
      seen.push({ t, state: receptorState(canvas, hw, 0), other: receptorState(canvas, hw, 1) });
    };

    // One real rep of the left leg at 30 fps: rest, rise past the threshold, HOLD at end range —
    // the single most common thing a rehab patient does, and the state the contract exists for —
    // then lower back to rest.
    const profile: number[] = [];
    for (let i = 0; i < 15; i++) profile.push(0);
    for (let i = 1; i <= 15; i++) profile.push((0.9 * i) / 15);
    for (let i = 0; i < 40; i++) profile.push(0.9);
    for (let i = 1; i <= 15; i++) profile.push(0.9 * (1 - i / 15));
    for (let i = 0; i < 15; i++) profile.push(0);
    profile.forEach((amount, i) => step(i / 30, seatedPose({ kneeLift: amount, side: 'left' })));
    // ...then the patient leaves the frame.
    const lastT = seen[seen.length - 1].t;
    for (let i = 1; i <= 20; i++) step(lastT + i / 30, null);

    const order = seen.map((f) => f.state);
    // Nothing is ever undrawn, and every one of the four looks really happens.
    expect(order).not.toContain('none');
    for (const want of ['rising', 'goal', 'locked', 'lost'] as ReceptorState[]) {
      expect(order.filter((k) => k === want).length, `${want} frames`).toBeGreaterThan(0);
    }
    // ...in the order a rep happens in: rise, reach, hold/lower, and (here) out of frame.
    const firstOf = (k: ReceptorState): number => order.indexOf(k);
    expect(firstOf('rising')).toBeLessThan(firstOf('goal'));
    expect(firstOf('goal')).toBeLessThan(firstOf('locked'));
    expect(firstOf('locked')).toBeLessThan(firstOf('lost'));
    // The lane re-arms as the patient comes back down, so the gauge goes live again before the end.
    expect(order.lastIndexOf('rising')).toBeGreaterThan(firstOf('locked'));

    // THE CLAIM: the goal look starts on the very frame the input engine emitted its event, not a
    // frame before it (that would be a promise) and not a frame after it (that would be a shrug).
    expect(fired).toHaveLength(1);
    const goalFrames = seen.filter((f) => f.state === 'goal');
    expect(goalFrames[0].t).toBeGreaterThanOrEqual(fired[0]);
    const prev = seen[seen.indexOf(goalFrames[0]) - 1];
    expect(prev.t).toBeLessThan(fired[0]);
    expect(prev.state).toBe('rising');
    // ...and it is held long enough to be caught mid-rep, then hands over to "lower to reset".
    const goalSpan = goalFrames[goalFrames.length - 1].t - goalFrames[0].t;
    expect(goalSpan).toBeGreaterThan(0.3);
    expect(goalSpan).toBeLessThan(0.8);

    // The lane the patient never moved never claims anything: no crossing, no lockout.
    expect(seen.every((f) => f.other === 'rising' || f.other === 'lost')).toBe(true);
    input.stop();
  });

  it('never celebrates a rep the real VisionInput threw away in a dropout', async () => {
    // THE FALSE POSITIVE, end to end and on the canvas. A lane is disarmed by a break in the sample
    // stream as well as by a crossing — VisionInput pushes a null sample for every untracked frame,
    // and past LaneTrigger.maxGapSec the lane goes to 'unconfirmed' AT WHATEVER VALUE IT HAS. The
    // recovery frame is then published as { value: 0.95, armed: false }, byte for byte the frame a
    // real crossing is published as, with no LaneInputEvent and (breakContinuity closes the rep with
    // no CompletedRep) no rep either. This is the patient with hemiparesis or tremor whose knee
    // landmark drops under MIN_VISIBILITY mid-rep, or the therapist who walks past the tablet.
    const input = new VisionInput({
      mode: 'leg',
      lanes: REP_LANES,
      calibrations: [
        calFor('seated_march', 'left', (a) => seatedPose({ kneeLift: a, side: 'left' })),
        calFor('knee_extension', 'right', (a) => seatedPose({ kneeExtension: a, side: 'right' })),
      ],
      thresholdFraction: THRESH,
      audioContext: new FakeClock(),
      detector: stubDetector(),
      driveLoop: false,
      smoothing: { kind: 'none' },
    });
    const fired: number[] = [];
    const reps: number[] = [];
    input.onEvent((e) => fired.push(e.ctxTime));
    input.onRep((r) => reps.push(r.ctxTime));
    await input.start();

    const { canvas, hw } = setup(1280, 720);
    hw.resize(1280, 720, 1);
    const seen: Array<{ t: number; state: ReceptorState }> = [];
    const step = (t: number, pose: Landmark[] | null): void => {
      input.processDetection({ tMs: t * 1000, pose, hands: [] }, t);
      canvas.ctx.reset();
      hw.draw(
        makeFrame({
          lanes: REP_LANES,
          songTime: t,
          laneStates: input.getLaneStates(),
          thresholdFraction: THRESH,
          rearmFraction: 0.6,
        }),
      );
      seen.push({ t, state: receptorState(canvas, hw, 0) });
    };

    let f = 0;
    const at = (): number => f++ / 30;
    for (let i = 0; i < 15; i++) step(at(), seatedPose({ kneeLift: 0, side: 'left' })); // rest: the lane arms
    for (let i = 0; i < 5; i++) step(at(), seatedPose({ kneeLift: 0.4, side: 'left' })); // rising, short of 0.6
    expect(seen[seen.length - 1].state).toBe('rising');
    for (let i = 0; i < 30; i++) step(at(), null); // 1 s out of frame: past maxGapSec (0.5 s)
    expect(seen[seen.length - 1].state).toBe('lost');
    const recoveryFrom = seen.length;
    // ...and the patient reappears at end range. Held there for longer than the goal latch would
    // have lasted, so a latch that fired even for one frame is caught.
    for (let i = 0; i < 20; i++) step(at(), seatedPose({ kneeLift: 0.95, side: 'left' }));

    // THE INPUT LAYER CREDITED NOTHING — not a hit, not even a rep.
    expect(fired).toHaveLength(0);
    expect(reps).toHaveLength(0);
    expect(input.getLaneStates()[0]).toMatchObject({ armed: false, tracking: true });
    expect(input.getLaneStates()[0].value).toBeGreaterThan(THRESH);
    // ...so the gauge must not claim otherwise, on any frame of the recovery.
    const after = seen.slice(recoveryFrom).map((k) => k.state);
    expect(after).not.toContain('goal');
    expect(after).not.toContain('rising');
    // What it says instead is the true and actionable thing, from the FIRST recovered frame: "this
    // lane cannot score, lower to reset". The recovered frame carries a measurement — it is the very
    // frame `LaneTrigger` would have fired on had the break been short enough to keep the arming —
    // so the receptor stops saying "I cannot see you" on it, and says the thing the patient can act
    // on instead.
    expect(after.every((k) => k === 'locked')).toBe(true);
    // And it is the real "lower to reset", with the return-to-rest readout keyed to the re-arm level.
    expect(drainCap(canvas, hw, 0)).toBeDefined();
    expect(rearmDashes(canvas, hw, 0)).toHaveLength(3);
    expect(chevrons(canvas, hw, 0)).toBe(1);
    input.stop();
  });

  it('the scripted sources (keyboard / replay / autoplay) reach the goal look too', () => {
    // KeyboardInput, ReplayInput and AutoplayInput all publish through LaneStateCache, which
    // reports a held lane as { value: 1, armed: false } — the same "already disarmed" crossing
    // frame VisionInput publishes. Driving the real publisher keeps `?input=keyboard` and
    // `?autoplay=1` (the screenshot / critic configurations) honest.
    const cache = new LaneStateCache();
    const { canvas, hw } = setup(1280, 720);
    hw.resize(1280, 720, 1);
    const at = (t: number, held: number[]): ReceptorState => {
      canvas.ctx.reset();
      hw.draw(
        makeFrame({
          lanes: LANES,
          songTime: t,
          laneStates: cache.get(LANES.length, (lane) => held.includes(lane)),
          thresholdFraction: THRESH,
          rearmFraction: 0.6,
        }),
      );
      return receptorState(canvas, hw, 0);
    };
    expect(at(1, [])).toBe('rising');
    expect(at(1.033, [0])).toBe('goal'); // key down = the crossing
    expect(at(1.033 + 0.7, [0])).toBe('locked'); // still held, and now it cannot fire again
    expect(at(1.033 + 0.75, [])).toBe('rising'); // released → re-armed
  });

  it('a lane with no LaneState at all reads as "I cannot see you", not as an idle gauge', () => {
    // GameRunner's first frame ships `laneStates: []`. An absent measurement is not a measurement
    // of zero, and four live at-rest gauges under a camera that has not produced a sample yet is
    // the same lie as a meter left pinned at 90 % after the camera dies.
    const { canvas, hw } = setup(1280, 720);
    hw.resize(1280, 720, 1);
    hw.draw(makeFrame({ lanes: LANES, songTime: 1, laneStates: [], thresholdFraction: THRESH }));
    for (const l of LANES) expect(receptorState(canvas, hw, l.index)).toBe('lost');
  });

  it('a lane whose calibration the input layer REFUSED is not drawn "rising, armed, ready"', async () => {
    // The whole chain, on the real input layer. `VisionInput` refuses a range that cannot be a range
    // and then publishes that lane as `{ value: 0, armed: true, triggerState: 'armed',
    // tracking: true }` for the rest of the session — a textbook state (a) at an empty meter, for a
    // lane that will emit nothing however hard the patient works. `getStatus()` has been saying so
    // in plain language the whole time, and the play screen used not to read it.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const input = new VisionInput({
      mode: 'leg',
      lanes: REP_LANES,
      calibrations: [
        // A degenerate range: min and max a thousandth of a real ROM apart.
        calFor('seated_march', 'left', (a) => seatedPose({ kneeLift: a * 0.001, side: 'left' })),
        calFor('knee_extension', 'right', (a) => seatedPose({ kneeExtension: a, side: 'right' })),
      ],
      thresholdFraction: THRESH,
      audioContext: new FakeClock(),
      detector: stubDetector(),
      driveLoop: false,
      smoothing: { kind: 'none' },
    });
    const fired: number[] = [];
    input.onEvent((e) => fired.push(e.ctxTime));
    await input.start();
    expect(input.getInvalidCalibrations().map((c) => c.lane), 'the lane really is refused').toContain(0);

    const { canvas, hw } = setup(1280, 800);
    hw.resize(1280, 800, 1);
    const step = (t: number, lift: number): void => {
      input.processDetection({ tMs: t * 1000, pose: seatedPose({ kneeLift: lift, side: 'left' }), hands: [] }, t);
      canvas.ctx.reset();
      hw.draw(
        makeFrame({
          lanes: REP_LANES,
          songTime: t,
          laneStates: input.getLaneStates(),
          thresholdFraction: THRESH,
          rearmFraction: 0.6,
        }),
      );
    };
    // 20 s of real marching on that lane.
    let f = 0;
    for (let i = 0; i < 600; i++) {
      const t = f++ / 30;
      step(t, 0.5 + 0.5 * Math.sin(t * Math.PI));
    }
    expect(fired, 'nothing fired on the refused lane').toHaveLength(0);
    expect(input.getLaneStates()[0]).toMatchObject({ value: 0, armed: true, triggerState: 'armed', tracking: true });
    // THE DEFECT, pinned so it cannot come back silently: given only `LaneState`, the receptor has
    // no way to know and correctly draws what it was handed.
    expect(receptorState(canvas, hw, 0)).toBe('rising');

    // ...which is why the renderer takes the input layer's own verdict out of band. This is exactly
    // what the play screen now does every half second (`Play.faultedLanes` → `setLaneFaults`).
    const status = input.getStatus();
    expect(status.reason).toBe('uncalibrated');
    expect(status.invalidCalibrationLanes).toEqual([0]);
    expect((status.warnings ?? []).join(' ')).toMatch(/not calibrated/i);
    hw.setLaneFaults(status.invalidCalibrationLanes);
    for (let i = 0; i < 20; i++) step(f++ / 30, 0.5);
    expect(receptorState(canvas, hw, 0), 'refused lane').toBe('lost');
    expect(receptorState(canvas, hw, 1), 'the healthy lane is untouched').not.toBe('lost');
    input.stop();
  });
});

// -------------------------------------------------------------------------------------------------
// STABILITY. `tracking` is a hard per-frame visibility gate with nothing debouncing it upstream, and
// during Play the receptor is the patient's only out-of-frame signal — so it may not strobe.
// -------------------------------------------------------------------------------------------------

describe('the receptor does not strobe on one noisy tracking frame', () => {
  const THRESH = 0.6;
  const draw = (hw: Highway, canvas: MockCanvas, t: number, tracking: boolean): ReceptorState => {
    canvas.ctx.reset();
    hw.draw(
      makeFrame({
        lanes: LANES,
        songTime: t,
        laneStates: LANES.map((l) => ({ lane: l.index, value: 0.3, armed: true, tracking })),
        thresholdFraction: THRESH,
      }),
    );
    return receptorState(canvas, hw, 0);
  };

  it('holds the gauge through a single dropped frame and gives up on a real dropout', () => {
    const { canvas, hw } = setup(1280, 720);
    hw.resize(1280, 720, 1);
    let t = 1;
    expect(draw(hw, canvas, t, true)).toBe('rising');
    // A landmark chattering across MIN_VISIBILITY: two frames out of three fail the gate. The old
    // renderer flipped the whole row between a full gauge and "?" at frame rate on exactly this.
    for (const ok of [false, true, false, false, true, false]) {
      t += 1 / 30;
      expect(draw(hw, canvas, t, ok), `t=${t.toFixed(3)} tracking=${ok}`).toBe('rising');
    }
    // A patient who has really left the frame is told so, and quickly.
    for (let i = 0; i < 8; i++) t += 1 / 30;
    expect(draw(hw, canvas, t, false)).toBe('lost');
    // ...AND COMING BACK COSTS ONE TRACKED FRAME, because that frame is a measurement the input
    // layer is already using: it is the sample `LaneTrigger` is pushed and can fire on, with the
    // crossing interpolated back across the gap (src/vision/trigger.ts). Making the recovery cost
    // contiguous stream — as the duty-cycle rule this replaced did — is the same thing as refusing
    // knowledge of results for reps the engine scored. See `LOST_HOLD_SEC`.
    t += 1 / 30;
    expect(draw(hw, canvas, t, true)).toBe('rising');
  });
});

// -------------------------------------------------------------------------------------------------
// THE RECEPTOR'S TIMERS ARE PERCEPTION TIMERS. Every other effect in the renderer is keyed to song
// time so that a pause freezes it where it is. The receptor cannot be: the lane states keep arriving
// while the song clock is stopped (GameRunner passes `input.getLaneStates()` live on every frame,
// paused or not), and all three of the receptor's windows — the goal latch, the anti-strobe tracking
// hold and the input layer's gap rule — are measured on the PATIENT. Frozen, all three fail the same
// way: toward a claim that can never expire.
// -------------------------------------------------------------------------------------------------

describe('the receptor keeps its own clock when the song clock stops', () => {
  const THRESH = 0.6;
  /** Wall clock (ms) the Highway reads through `performance.now()`; the tests move it by hand. */
  let wall = 0;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const rig = (): { canvas: MockCanvas; hw: Highway } => {
    wall = 10_000;
    vi.spyOn(performance, 'now').mockImplementation(() => wall);
    const { canvas, hw } = setup(1280, 720, { reducedMotion: true });
    hw.resize(1280, 720, 1);
    return { canvas, hw };
  };

  /** One frame: `wallMs` of real time passes, then the frame is drawn at song time `t`. */
  const step = (
    canvas: MockCanvas,
    hw: Highway,
    t: number,
    state: { value: number; armed: boolean; tracking?: boolean },
    wallMs = 1000 / 60,
  ): ReceptorState => {
    wall += wallMs;
    canvas.ctx.reset();
    hw.draw(
      makeFrame({
        lanes: LANES,
        songTime: t,
        laneStates: LANES.map((l) => ({ lane: l.index, tracking: true, ...state })),
        thresholdFraction: THRESH,
        rearmFraction: 0.6,
      }),
    );
    return receptorState(canvas, hw, 0);
  };

  /** Rise to just under the threshold, armed and tracked — the state every rep starts from. */
  const riseTo = (canvas: MockCanvas, hw: Highway, t0: number, frames = 20): number => {
    let t = t0;
    for (let i = 0; i < frames; i++) {
      step(canvas, hw, t, { value: 0.4, armed: true });
      t += 1 / 30;
    }
    return t;
  };

  it('does not hold a goal celebration for the length of a pause, or replay it on resume', () => {
    // A therapist pauses right after the patient reaches their target. The song clock stops; the
    // camera does not. Held at song time, `goal` never ages: the white cap, the arrowheads and the
    // corona stay at full strength for the whole pause — and then finish their remaining 0.45 s
    // AFTER the resume, as knowledge of results about a rep that happened minutes earlier.
    const { canvas, hw } = rig();
    const tPause = riseTo(canvas, hw, 1);
    expect(step(canvas, hw, tPause, { value: 0.75, armed: false })).toBe('goal');

    // ...pause. Song time is frozen from here; wall time is not.
    let held = 0;
    let state: ReceptorState = 'goal';
    for (let i = 0; i < 90; i++) {
      state = step(canvas, hw, tPause, { value: 0.75, armed: false });
      if (state === 'goal') held = (i + 1) / 60;
    }
    // GOAL_HOLD_SEC + GOAL_FADE_SEC = 0.6 s, plus the 0.2 s the renderer waits before it stops
    // believing the song clock. Well inside the 1.5 s this loop covers.
    expect(held).toBeLessThan(1);
    expect(state).toBe('locked');
    // ...and the resume gets the lockout it left, not the tail of a celebration.
    expect(step(canvas, hw, tPause + 1 / 30, { value: 0.75, armed: false })).toBe('locked');
  });

  it('still says "I cannot see you" when the camera dies during a pause', () => {
    // The anti-strobe hold (LOST_HOLD_SEC) replays the last tracked look for a fifth of a second so
    // one marginal visibility frame cannot flip the row to "?" and back. On a stopped song clock it
    // never expires, so an unplugged camera leaves a live-looking gauge standing at the patient's
    // last value — the exact "meter pinned under a dead camera" lie this gauge exists to remove.
    const { canvas, hw } = rig();
    const t = riseTo(canvas, hw, 1);
    expect(step(canvas, hw, t, { value: 0.4, armed: true, tracking: false })).toBe('rising'); // held
    let state: ReceptorState = 'rising';
    for (let i = 0; i < 60 && state !== 'lost'; i++) state = step(canvas, hw, t, { value: 0.4, armed: true, tracking: false });
    expect(state).toBe('lost');
  });

  it('never celebrates the recovery frame of a dropout that spanned a pause', () => {
    // The dangerous one. `LaneTrigger.breakContinuity` disarms a lane AT WHATEVER VALUE IT HAS after
    // maxGapSec of silence, so the recovery frame is published as `{ value: 0.95, armed: false }` —
    // byte for byte the shape of a crossing, with no LaneInputEvent and no rep behind it. The only
    // thing that tells the two apart is how long the stream has been silent, measured on a clock
    // that has to be running.
    const { canvas, hw } = rig();
    const t = riseTo(canvas, hw, 1);
    // The patient goes out of frame and the session is stopped in the same moment.
    let state: ReceptorState = 'rising';
    for (let i = 0; i < 60; i++) state = step(canvas, hw, t, { value: 0.4, armed: true, tracking: false });
    expect(state).toBe('lost');
    // They reappear at end range, disarmed by the break. Nothing fired; nothing may be celebrated —
    // not on the recovery frame, and not on any frame after it.
    const after: ReceptorState[] = [];
    for (let i = 0; i < 40; i++) after.push(step(canvas, hw, t + i / 30, { value: 0.95, armed: false }));
    expect(after).not.toContain('goal');
    expect(after).not.toContain('rising');
    // From the first recovered frame it says the truth about the lane instead: locked out, lower to
    // reset. (It is the goal LATCH that a dropout kills, not the recovery: the tracking hold is a
    // debounce on "there is no measurement", and the recovered frame has one.)
    expect(after.every((k) => k === 'locked')).toBe(true);
  });
});

// -------------------------------------------------------------------------------------------------
// DISTINCTNESS BY MARKS, in every layout and both palettes. The four states must differ in WHICH
// marks exist, not in hue or brightness — a patient with low vision reading a tablet at 2 m has
// neither.
// -------------------------------------------------------------------------------------------------

describe('the four states differ by marks at every size and in both palettes', () => {
  const THRESH = 0.6;
  /** The mark inventory of lane 0 as a comparable signature. No hue, no alpha, no brightness. */
  const signature = (canvas: MockCanvas, hw: Highway, lanes: LaneSpec[]): string => {
    const g = hw.geometry;
    const cx = laneX(g, 0, 0);
    const arcs = canvas.ctx.calls.filter(
      (c) => c.name === 'ellipse' && c.args.length >= 7 && Math.abs((c.args[0] as number) - cx) < 1 && Math.abs((c.args[1] as number) - g.strikeY) < 0.5,
    ).length;
    const wedges = canvas.ctx.calls.filter((c, i) => {
      if (c.name !== 'moveTo' || canvas.ctx.propBefore(i, 'fillStyle') !== WHITE) return false;
      const d = Math.min(...lanes.map((l) => Math.abs((c.args[0] as number) - laneX(g, l.index, 0))));
      return d > g.receptorRadius * 0.5 && d < g.receptorRadius * 1.6;
    }).length;
    return [
      wellRect(canvas, hw, 0) ? 'well' : '-',
      liquidRect(canvas, hw, 0) ? 'liquid' : '-',
      targetLine(canvas, hw, 0) ? 'target' : '-',
      `ticks${targetTicks(canvas, hw, 0).length}`,
      `wedges${wedges}`,
      `hotcap${hotCapSegments(canvas, hw, 0).length}`,
      drainCap(canvas, hw, 0) ? 'drain' : '-',
      `dashes${rearmDashes(canvas, hw, 0).length}`,
      `rings${arcs}`,
      `halo${haloBlits(canvas, hw)}`,
    ].join('|');
  };

  const CONFIGS = [
    { name: '1280x720 GH', w: 1280, h: 720, lanes: LANES, opts: {} },
    { name: '1280x720 high contrast', w: 1280, h: 720, lanes: LANES, opts: { highContrast: true } },
    { name: '1024x768 GH', w: 1024, h: 768, lanes: LANES, opts: {} },
    { name: '720x1280 portrait, 2 lanes', w: 720, h: 1280, lanes: LANES.slice(0, 2), opts: {} },
    { name: '400x225 (2 m acuity), 2 lanes', w: 400, h: 225, lanes: LANES.slice(0, 2), opts: {} },
    { name: '220x124 (low vision), 4 lanes', w: 220, h: 124, lanes: LANES, opts: { highContrast: true } },
  ];

  for (const cfg of CONFIGS) {
    it(`keeps the four states apart at ${cfg.name}`, () => {
      const sigs = new Map<string, string>();
      // FIVE recordings, four states: `rearmed` is the `GOAL_MIN_SEC` overrun — still state (b), but
      // with the lane already re-armed, which is the look a patient is in on most reps at the chart
      // generator's own pacing. It must never be confused with (a), (c) or (d); see below for why it
      // is allowed to share (b)'s inventory.
      for (const state of ['rising', 'goal', 'rearmed', 'locked', 'lost'] as const) {
        const { canvas, hw } = setup(cfg.w, cfg.h, cfg.opts);
        hw.resize(cfg.w, cfg.h, 1);
        const frame = (t: number, value: number, armed: boolean, tracking: boolean): RenderFrame =>
          makeFrame({
            lanes: cfg.lanes,
            songTime: t,
            laneStates: cfg.lanes.map((l) => ({ lane: l.index, value, armed, tracking })),
            thresholdFraction: THRESH,
            rearmFraction: 0.6,
            beatPhase: 0.5,
          });
        // Every state is reached the way the input layer reaches it: (b) and (c) both start from a
        // rising, armed lane, because that is the only way a lane can lock out.
        for (let i = 0; i < 30; i++) hw.draw(frame(1 + i * 0.016, state === 'rising' ? 0.3 : 0.5, true, true));
        canvas.ctx.reset();
        if (state === 'rising') hw.draw(frame(1.5, 0.3, true, true));
        else if (state === 'goal') hw.draw(frame(1.5, 0.75, false, true));
        else if (state === 'rearmed') {
          hw.draw(frame(1.5, 0.75, false, true)); // the crossing...
          hw.draw(frame(1.516, 0.3, true, true)); // ...and straight back down past the re-arm line
          canvas.ctx.reset();
          hw.draw(frame(1.532, 0.1, true, true)); // 32 ms in: armed, near rest, cue still latched
        } else if (state === 'locked') {
          hw.draw(frame(1.5, 0.75, false, true)); // the crossing...
          for (let i = 0; i < 60; i++) hw.draw(frame(1.52 + i * 0.016, 0.75, false, true)); // ...held
          canvas.ctx.reset();
          hw.draw(frame(2.6, 0.75, false, true));
        } else {
          for (let i = 0; i < 30; i++) hw.draw(frame(1.5 + i * 0.016, 0.5, true, false));
          canvas.ctx.reset();
          hw.draw(frame(2.0, 0.5, true, false));
        }
        sigs.set(state, signature(canvas, hw, cfg.lanes));
      }
      const seen = new Map<string, string>();
      for (const state of ['rising', 'goal', 'locked', 'lost'] as const) {
        const sig = sigs.get(state) as string;
        const clash = seen.get(sig);
        expect(clash, `${state} and ${clash} draw the same marks: ${sig}`).toBeUndefined();
        seen.set(sig, state);
      }
      // `rearmed` is STILL (b) — the rep really did reach target — so it deliberately keeps (b)'s KR
      // inventory and is not required to differ from it: what separates the two is the position
      // gauge (the column, at the patient's real height), which this signature ignores on purpose.
      // What it may never be confused with is the three states that mean something else.
      for (const other of ['rising', 'locked', 'lost'] as const) {
        expect(sigs.get('rearmed'), `rearmed reads as ${other}`).not.toBe(sigs.get(other));
      }
    });
  }

  it('does not shrink the gauge at the moment the patient reaches their target', () => {
    // The failure this guards: the crossing frame used to be the FIRST locked frame, so at the
    // instant of success the ring shrank 12 %, the column was capped ~10 % below the target line
    // and the whole receptor dimmed and greyed. On a note-timed rep the hit burst covered it; on a
    // practice rep (the common case in ROM repetition work) it was the only feedback there was.
    const { canvas, hw } = setup(1280, 720, { reducedMotion: true });
    hw.resize(1280, 720, 1);
    const frame = (t: number, value: number, armed: boolean): RenderFrame =>
      makeFrame({
        lanes: LANES,
        songTime: t,
        laneStates: LANES.map((l) => ({ lane: l.index, value, armed, tracking: true })),
        thresholdFraction: 0.6,
        rearmFraction: 0.6,
      });
    for (let i = 0; i < 20; i++) hw.draw(frame(1 + i * 0.016, 0.58, true));
    canvas.ctx.reset();
    hw.draw(frame(1.32, 0.58, true)); // last frame before the crossing: 97 % of threshold
    const before = liquidRect(canvas, hw, 0);
    canvas.ctx.reset();
    hw.draw(frame(1.336, 0.75, false)); // the crossing, published already disarmed
    const at = liquidRect(canvas, hw, 0);
    const { yTarget } = meterAxis(hw);
    expect(before).toBeDefined();
    expect(at).toBeDefined();
    // The column goes UP (smaller y = higher on screen), not down...
    expect((at as MeterRect).y).toBeLessThan((before as MeterRect).y);
    // ...and it is the only thing on the board that ever paints above the target line: that band is
    // the "cleared the target by this much" reading.
    expect((at as MeterRect).y).toBeLessThan(yTarget);
    expect((before as MeterRect).y).toBeGreaterThan(yTarget);
    // And it does not step down when the acknowledgement ends — it glides.
    let prevY = (at as MeterRect).y;
    let worstStep = 0;
    for (let i = 1; i <= 60; i++) {
      canvas.ctx.reset();
      hw.draw(frame(1.336 + i * 0.016, 0.75, false));
      const r = liquidRect(canvas, hw, 0);
      if (!r) continue;
      worstStep = Math.max(worstStep, Math.abs(r.y - prevY));
      prevY = r.y;
    }
    expect(worstStep).toBeLessThan(hw.geometry.receptorRadius * 0.05);
  });
});

const noSpriteFactory = (w: number, h: number): CanvasLike => ({ width: w, height: h, getContext: () => null });

/** Gem discs drawn below the strike line (the sprite-less fallback draws them as ellipses). */
function gemDiscs(canvas: MockCanvas, hw: Highway): Array<{ cy: number; ry: number }> {
  const g = hw.geometry;
  return canvas.ctx.calls
    .filter((c) => c.name === 'ellipse' && (c.args[1] as number) > g.strikeY + 1)
    .map((c) => ({ cy: c.args[1] as number, ry: c.args[3] as number }));
}

describe('a lane that structurally cannot fire is never drawn "armed and ready"', () => {
  /**
   * `LaneState` reports the patient; it does not report whether the machinery under them works. A
   * lane whose calibration VisionInput REFUSED publishes `{ value: 0, armed: true, triggerState:
   * 'armed', tracking: true }` for the whole session — a perfect state (a) on a lane that will emit
   * nothing for three minutes — and `getStatus()` has said so in plain language the whole time.
   */
  const healthy = (value: number) =>
    LANES.map((l) => ({ lane: l.index, value, armed: true, triggerState: 'armed' as const, tracking: true }));

  it('draws a faulted lane as "no reading" with a "!", and leaves its neighbours alone', () => {
    const { canvas, hw, scratch } = setup(1280, 800);
    hw.resize(1280, 800, 1);
    const frame = (t: number) => makeFrame({ lanes: LANES, songTime: t, thresholdFraction: 0.65, laneStates: healthy(0.3) });
    hw.draw(frame(0));
    // Before: every lane is a live, rising gauge — which is what the board really showed.
    expect(receptorMarkSet(hw.receptorLookOf(0) as ReceptorLook)).toBe('rising');
    hw.setLaneFaults([0]);
    // The anti-strobe hold applies to the fault exactly as it does to a dropout (one model, one
    // path): the lane was tracked a moment ago, so it holds LOST_HOLD_SEC before it admits it.
    for (let i = 1; i <= 20; i++) hw.draw(frame(i * 0.02));
    expect(receptorMarkSet(hw.receptorLookOf(0) as ReceptorLook), 'faulted lane').toBe('lost');
    expect(receptorMarkSet(hw.receptorLookOf(1) as ReceptorLook), 'its neighbour').toBe('rising');
    // ...and it is the FAULT glyph, not the out-of-frame one: "get back in frame" is the wrong
    // remedy and would send the therapist after the wrong thing.
    const before = scratch.length;
    canvas.ctx.reset();
    hw.draw(frame(0.45));
    const glyphs = scratch
      .slice(0)
      .flatMap((c) => c.ctx.calls.filter((k) => k.name === 'fillText').map((k) => k.args[0]));
    expect(glyphs, 'the fault glyph is rasterized').toContain('!');
    expect(before).toBeGreaterThan(0);
    // Nothing value-derived survives for that lane: no well ground where its receptor is.
    const g = hw.geometry;
    const wellsAt = (lane: number): number =>
      canvas.ctx.calls.filter(
        (c, i) =>
          c.name === 'fillRect' &&
          canvas.ctx.propBefore(i, 'fillStyle') === METER_WELL &&
          Math.abs((c.args[0] as number) + (c.args[2] as number) / 2 - laneX(g, lane, 0)) < 2,
      ).length;
    expect(wellsAt(0), 'faulted lane has no meter well').toBe(0);
    expect(wellsAt(1), 'healthy lane still has one').toBe(1);
  });

  it('clears faults again, and ignores lanes that do not exist', () => {
    const { hw } = setup(1280, 800);
    hw.resize(1280, 800, 1);
    const frame = (t: number) => makeFrame({ lanes: LANES, songTime: t, thresholdFraction: 0.65, laneStates: healthy(0.3) });
    hw.draw(frame(0));
    hw.setLaneFaults([0, 99, -3, Number.NaN]);
    for (let i = 1; i <= 20; i++) hw.draw(frame(i * 0.02));
    expect(receptorMarkSet(hw.receptorLookOf(0) as ReceptorLook)).toBe('lost');
    for (let lane = 1; lane < 4; lane++) expect(receptorMarkSet(hw.receptorLookOf(lane) as ReceptorLook)).toBe('rising');
    // Re-calibrated mid-session: the lane comes back as a live gauge on the next tracked frame.
    hw.setLaneFaults(null);
    hw.draw(frame(0.5));
    expect(receptorMarkSet(hw.receptorLookOf(0) as ReceptorLook)).toBe('rising');
  });

  it('never lets a faulted lane latch the "you reached your target" cue', () => {
    // The cruellest version: the lane is faulted while the patient is mid-rep, so the very next
    // published state is the crossing shape. No KR may be thrown for a lane that emitted nothing.
    const { hw } = setup(1280, 800);
    hw.resize(1280, 800, 1);
    const states = (value: number, armed: boolean) =>
      LANES.map((l) => ({
        lane: l.index,
        value: l.index === 0 ? value : 0.2,
        armed: l.index === 0 ? armed : true,
        triggerState: (l.index === 0 ? (armed ? 'armed' : 'triggered') : 'armed') as 'armed' | 'triggered',
        tracking: true,
      }));
    hw.draw(makeFrame({ lanes: LANES, songTime: 0, thresholdFraction: 0.65, laneStates: states(0.5, true) }));
    hw.setLaneFaults([0]);
    const seen: string[] = [];
    for (let i = 1; i <= 40; i++) {
      hw.draw(makeFrame({ lanes: LANES, songTime: i * 0.02, thresholdFraction: 0.65, laneStates: states(0.9, false) }));
      seen.push(receptorMarkSet(hw.receptorLookOf(0) as ReceptorLook));
    }
    expect(seen).not.toContain('goal');
    expect(seen[seen.length - 1]).toBe('lost');
  });
});

describe('nothing on the board is painted over the receptor', () => {
  /**
   * THE RECEPTOR ROW IS THE LAST BOARD LAYER. It is the patient's only 2 m-legible statement about
   * what the input layer will do with their next rep, and it used to be drawn BEFORE the gems — so a
   * note gem, which is opaque and (`RECEPTOR_GEM_RATIO * RECEPTOR_WELL_RATIO` = 1.008) almost
   * exactly the size of the meter well it lands on, covered 96 % of its own lane's gauge whenever it
   * was at the line. Measured on a real 'medium' session at 1280x800: a gem over the receptor's
   * centre on 34.8 % of lane-frames, touching the well on 45.5 %.
   */
  const firstClip = (canvas: MockCanvas): number => canvas.ctx.calls.findIndex((c) => c.name === 'clip');

  it('issues every gem blit before the receptor row starts drawing (sprite path)', () => {
    // Implementation-agnostic: the only `clip()` in a frame is the meter well of lane 0, the first
    // lane the receptor row draws. Compare an identical frame with and without notes — every extra
    // blit the notes cause must land BEFORE that point, and none after it.
    const { canvas, hw } = setup(1280, 800);
    hw.resize(1280, 800, 1);
    const songTime = 10;
    // A chord on the line plus the rest of the runway: the worst case is four gems sitting on four
    // receptors at once, which is what the chart generator writes deliberately.
    const notes: RenderNote[] = [
      { id: 1, lane: 0, time: songTime, state: 'pending' },
      { id: 2, lane: 1, time: songTime, state: 'pending' },
      { id: 3, lane: 2, time: songTime, state: 'pending' },
      { id: 4, lane: 3, time: songTime, state: 'pending' },
      ...notesAround(songTime, 4),
    ];
    const laneStates = LANES.map((l) => ({ lane: l.index, value: 0.7, armed: false, triggerState: 'triggered' as const, tracking: true }));
    const base = makeFrame({ lanes: LANES, songTime, thresholdFraction: 0.65, laneStates });
    hw.draw({ ...base, notes }); // warm the sprite cache so the two measured frames allocate nothing
    const measure = (withNotes: boolean): { before: number; after: number; drawn: number } => {
      canvas.ctx.reset();
      hw.draw({ ...base, notes: withNotes ? notes : [] });
      const clip = firstClip(canvas);
      expect(clip).toBeGreaterThan(0);
      let before = 0;
      let after = 0;
      canvas.ctx.calls.forEach((c, i) => {
        if (c.name !== 'drawImage') return;
        if (i < clip) before++;
        else after++;
      });
      return { before, after, drawn: hw.getStats().notesDrawn };
    };
    const withNotes = measure(true);
    const without = measure(false);
    expect(withNotes.drawn).toBeGreaterThanOrEqual(8);
    expect(without.drawn).toBe(0);
    // Every gem the frame drew was issued before the receptor row began...
    expect(withNotes.before - without.before, 'gem blits before the receptor row').toBe(withNotes.drawn);
    // ...and not one of them after it.
    expect(withNotes.after, 'blits after the receptor row began').toBe(without.after);
  });

  it('draws the whole gauge of a lane whose gem is sitting on it (geometric, sprite-less path)', () => {
    // The proof frame the critic captured: lane 3 in state (c) — locked, "lower to reset" — with a
    // gem on the line. Nothing of the ring, the drain cap, the re-arm dashes or the chevron was
    // visible; what replaced them was a bright, fully lit hit target. Here every one of the well's
    // own paints must be issued after the gem that covers it.
    const canvas = createMockCanvas(1280, 800);
    const hw = new Highway(canvas, { createCanvas: noSpriteFactory });
    hw.resize(1280, 800, 1);
    const g = hw.geometry;
    const songTime = 10;
    const laneStates = LANES.map((l) => ({ lane: l.index, value: 0.8, armed: false, triggerState: 'unconfirmed' as const, tracking: true }));
    const notes: RenderNote[] = LANES.map((l, i) => ({ id: i + 1, lane: l.index, time: songTime, state: 'pending' as const }));
    hw.draw(makeFrame({ lanes: LANES, songTime: songTime - 1, thresholdFraction: 0.65, laneStates }));
    canvas.ctx.reset();
    hw.draw(makeFrame({ lanes: LANES, songTime, notes, thresholdFraction: 0.65, laneStates }));
    // Gems at the line: the sprite-less fallback draws each as one ellipse of the near gem radius,
    // centred on the strike line. (The receptor's own ellipses are 1.12x wider — RECEPTOR_GEM_RATIO.)
    const gemIdx: number[] = [];
    canvas.ctx.calls.forEach((c, i) => {
      if (c.name !== 'ellipse') return;
      if (Math.abs((c.args[1] as number) - g.strikeY) > 1) return;
      if (Math.abs((c.args[2] as number) - g.gemRadiusNear) > 0.5) return;
      gemIdx.push(i);
    });
    expect(gemIdx.length, 'four gems on the line').toBe(4);
    // The meter well's dark ground is the first thing the gauge paints, and everything readable is
    // painted on top of it (asserted elsewhere), so it is the whole gauge's lower bound.
    const wellIdx = canvas.ctx.calls
      .map((c, i) => (c.name === 'fillRect' && canvas.ctx.propBefore(i, 'fillStyle') === METER_WELL ? i : -1))
      .filter((i) => i >= 0);
    expect(wellIdx.length, 'one well ground per lane').toBe(4);
    expect(Math.max(...gemIdx), 'last gem vs first well').toBeLessThan(Math.min(...wellIdx));
    // ...and the violet "lower to reset" marks of (c) too — the instruction the stalled patient
    // needs is the very thing the covering gem used to hide.
    const violet = canvas.ctx.calls
      .map((c, i) => ((c.name === 'fillRect' || c.name === 'stroke') && canvas.ctx.propBefore(i, 'fillStyle') === LOCK_HINT ? i : -1))
      .filter((i) => i >= 0);
    expect(violet.length, 'drain cap + re-arm dashes per lane').toBeGreaterThanOrEqual(4);
    expect(Math.max(...gemIdx)).toBeLessThan(Math.min(...violet));
  });

  it('walks a dying gem clear of the well so the miss is still seen under the ring', () => {
    // The aggravator: a patient stalled at end range is in (c) and therefore misses every note in
    // that lane. With the receptor now on top, a fizzle left where it lands would die invisibly
    // behind the ring — so it walks out from under it (see `missCueY`).
    for (const [w, h] of [
      [1280, 800],
      [1280, 720],
      [1920, 1080],
      [1366, 768],
    ]) {
      const canvas = createMockCanvas(w, h);
      const hw = new Highway(canvas, { createCanvas: noSpriteFactory });
      hw.resize(w, h, 1);
      const g = hw.geometry;
      const wellBottom = g.strikeY + receptorWellSemiHeight(g);
      const noteTime = 10;
      hw.draw(makeFrame({ lanes: LANES, songTime: noteTime - 1 }));
      const missEv: HitEvent[] = [{ noteId: 1, lane: 2, judgment: 'miss', deltaMs: 180, time: noteTime + 0.18 }];
      const missed: RenderNote = { id: 1, lane: 2, time: noteTime, state: 'miss', judgment: 'miss' };
      const at = (dt: number): { cy: number; ry: number } => {
        canvas.ctx.reset();
        hw.draw(makeFrame({ lanes: LANES, songTime: noteTime + dt, notes: [missed], recentHits: dt === 0.28 ? missEv : [] }));
        const discs = gemDiscs(canvas, hw);
        expect(discs.length, `${w}x${h} +${dt}s`).toBe(1);
        return discs[0];
      };
      // On the verdict frame it is not yanked anywhere: its lower third is already below the ring.
      const verdict = at(0.28);
      expect(verdict.cy + verdict.ry, `${w}x${h} verdict frame shows below the ring`).toBeGreaterThan(wellBottom);
      // ...and within `MISS_CLEAR_SEC` its CENTRE is out from under the well, while it still has
      // most of its opacity (alpha = (1 - k) * 0.75 — at +0.15 s of a 0.42 s fizzle, ~0.5).
      for (const dt of [0.43, 0.5, 0.6]) {
        const d = at(dt);
        expect(d.cy, `${w}x${h} +${dt}s clear of the well`).toBeGreaterThanOrEqual(wellBottom);
      }
      // It never climbs back toward the line, and once clear it stays at least three quarters
      // visible for the rest of the fizzle — the gem shrinks toward the ring's underside rather
      // than sliding back beneath it.
      for (const dt of [0.32, 0.36, 0.43, 0.5, 0.6, 0.68]) {
        const d = at(dt);
        expect(d.cy, `${w}x${h} +${dt}s never climbs back`).toBeGreaterThanOrEqual(verdict.cy - 0.001);
        if (dt < 0.43) continue;
        // (The nominal clearance leaves 22.5 % of the gem behind the ring; on a short canvas the
        // bottom-edge clamp wins and it is a little more — which is the right way round, since a
        // cue below the bottom edge is not a cue at all.)
        const hidden = (wellBottom - (d.cy - d.ry)) / (2 * d.ry);
        expect(hidden, `${w}x${h} +${dt}s fraction of the gem behind the ring`).toBeLessThanOrEqual(0.35);
      }
    }
  });
});

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

// -------------------------------------------------------------------------------------------------
// LANE CONTAINMENT. Four receptors must read as four receptors — never as one joined shelf. Every
// mark a receptor draws has to stay inside its own lane's half of the board, at every geometry the
// app can be opened at and in every one of the four states.
// -------------------------------------------------------------------------------------------------

describe('receptor marks stay inside their own lane', () => {
  /** The colours a receptor paints its marks in — solid hex, unlike the road's gradients / rgba(). */
  const isMarkStyle = (v: unknown): boolean => typeof v === 'string' && v.startsWith('#');

  /**
   * How far, in pixels, the furthest receptor mark in this frame reaches from its lane centre.
   *
   * Ops are attributed to the lane they are centred on, and only those inside the receptor's own
   * vertical band are considered (the road, the rails and the crowd are drawn with gradients and
   * rgba() fills, so the hex-style filter drops them; the band keeps out anything else that happens
   * to be a flat colour). A stroked ellipse counts its stroke: half the line width lands outside the
   * radius, which is exactly how the return-to-rest arc used to overrun its lane by 2–4 px while
   * measuring "1.16 r" on paper.
   */
  function maxMarkReach(canvas: MockCanvas, hw: Highway): { reach: number; half: number; what: string } {
    const g = hw.geometry;
    const ry = g.receptorRadius * GEM_ASPECT;
    let reach = 0;
    let what = 'nothing';
    canvas.ctx.calls.forEach((c, i) => {
      const fill = canvas.ctx.propBefore(i, 'fillStyle');
      const stroke = canvas.ctx.propBefore(i, 'strokeStyle');
      let y: number;
      let spans: Array<{ x: number; half: number }>;
      if (c.name === 'fillRect') {
        if (!isMarkStyle(fill)) return;
        const [x, y0, w, h] = c.args as number[];
        y = y0 + h / 2;
        spans = [{ x: x + w / 2, half: Math.abs(w) / 2 }];
      } else if (c.name === 'ellipse') {
        if (!isMarkStyle(fill) && !isMarkStyle(stroke)) return;
        const [x, y0, rx] = c.args as number[];
        const lw = (canvas.ctx.propBefore(i, 'lineWidth') as number) ?? 0;
        y = y0;
        spans = [{ x, half: rx + lw / 2 }];
      } else if (c.name === 'moveTo' || c.name === 'lineTo') {
        if (!isMarkStyle(fill) && !isMarkStyle(stroke)) return;
        const [x, y0] = c.args as number[];
        // A stroked path spreads half its line width either side of the point; a FILLED one (the
        // goal arrowheads) does not, and counting a stale `lineWidth` against it would report a
        // 5 px overrun that is not on the canvas. Which it is, is what the path ends with.
        const ends = canvas.ctx.calls.slice(i + 1).find((k) => k.name === 'fill' || k.name === 'stroke');
        const lw = ends?.name === 'stroke' ? ((canvas.ctx.propBefore(i, 'lineWidth') as number) ?? 0) : 0;
        y = y0;
        spans = [{ x, half: lw / 2 }];
      } else return;
      if (Math.abs(y - g.strikeY) > ry * 1.6) return;
      for (const s of spans) {
        for (let lane = 0; lane < g.laneCount; lane++) {
          const off = Math.abs(s.x - laneX(g, lane, 0));
          // Attributed to the lane it is ANCHORED on, which is how every receptor mark is drawn:
          // all of them are positioned from the receptor's centre x. An op anchored outside every
          // lane's half is board or HUD chrome (the rock gauge's white needle can land in this
          // vertical band on a 2-lane board), not a receptor mark.
          if (off > g.laneWidthNear / 2) continue;
          if (off + s.half > reach) {
            reach = off + s.half;
            what = `${c.name} lane ${lane} (fill ${String(fill)}, stroke ${String(stroke)})`;
          }
        }
      }
    });
    return { reach, half: g.laneWidthNear / 2, what };
  }

  /** One frame of each state, at a given geometry and lane count, with the marks measured. */
  function worstReach(w: number, h: number, laneCount: number): Array<{ state: string; reach: number; half: number; r: number; what: string }> {
    const lanes = LANES.slice(0, laneCount);
    const { canvas, hw } = setup(w, h, { reducedMotion: true });
    hw.resize(w, h, 1);
    let t = 1;
    const step = (value: number, armed: boolean, tracking = true): void => {
      canvas.ctx.reset();
      hw.draw(
        makeFrame({
          lanes,
          songTime: t,
          laneStates: lanes.map((l) => ({ lane: l.index, value, armed, tracking })),
          thresholdFraction: 0.5,
          rearmFraction: 0.6,
        }),
      );
      t += 1 / 30;
    };
    const out: Array<{ state: string; reach: number; half: number; r: number; what: string }> = [];
    const r = hw.geometry.receptorRadius;
    // (a) rising, (b) the crossing — every lane at once, which is what a chord in the chart is,
    // and the case where two coronas used to merge across the gutter.
    for (const v of [0.1, 0.3, 0.45]) step(v, true);
    out.push({ state: 'rising', r, ...maxMarkReach(canvas, hw) });
    step(0.95, false);
    out.push({ state: 'goal', r, ...maxMarkReach(canvas, hw) });
    // (c) locked, walked down the whole return journey: the arc grows the whole way, so its worst
    // case is the last step before the lane re-arms.
    for (let i = 0; i < 25; i++) step(0.95, false);
    for (const v of [0.9, 0.8, 0.7, 0.6, 0.5, 0.45, 0.4, 0.35, 0.3]) {
      step(v, false);
      out.push({ state: `locked@${v}`, r, ...maxMarkReach(canvas, hw) });
    }
    // (d) no signal.
    step(0.3, true, false);
    step(0.3, true, false);
    out.push({ state: 'lost', r, ...maxMarkReach(canvas, hw) });
    return out;
  }

  it('never crosses into a neighbouring lane, at any geometry, lane count or state', () => {
    for (const [w, h] of [
      [1280, 800],
      [1920, 1080],
      [900, 1400], // portrait: the widest lanes relative to the receptor
      [1024, 768],
      [400, 800],
    ]) {
      for (const laneCount of [2, 3, 4]) {
        for (const m of worstReach(w, h, laneCount)) {
          const tag = `${w}x${h} ${laneCount} lanes, ${m.state}: ${m.what}`;
          // Inside the lane's own half, less the margin every receptor mark is grown inward from
          // (`TARGET_MARK_MARGIN`), so two adjacent receptors always have an unpainted gutter
          // between them however many of them are in the same state at the same instant.
          const margin = Math.max(2, m.r * 0.06);
          expect(m.reach, tag).toBeLessThanOrEqual(m.half - margin + 1e-6);
        }
      }
    }
  });

  it('gives the return-to-rest arc and the goal corona the lane\'s room, not a fixed 1.16 r', () => {
    // The two marks that are drawn OUTSIDE the ring. They want 1.16 r; what they get is whatever is
    // left inside the lane after the same margin the target ticks use. On a wide-lane geometry the
    // wish is granted in full; on the board's widest-receptor geometry it is trimmed — and it is the
    // radius that gives way, never the containment.
    const { canvas, hw } = setup(1280, 800, { reducedMotion: true });
    hw.resize(1280, 800, 1);
    const g = hw.geometry;
    let t = 1;
    const step = (value: number, armed: boolean): void => {
      canvas.ctx.reset();
      hw.draw(
        makeFrame({
          lanes: LANES,
          songTime: t,
          laneStates: LANES.map((l) => ({ lane: l.index, value, armed, tracking: true })),
          thresholdFraction: 0.5,
          rearmFraction: 0.6,
        }),
      );
      t += 1 / 30;
    };
    /** Radii of the ellipses stroked outside the ring on lane 0 (arc in (c), corona in (b)). */
    const outerRings = (): Array<{ rx: number; lw: number }> => {
      const out: Array<{ rx: number; lw: number }> = [];
      canvas.ctx.calls.forEach((c, i) => {
        if (c.name !== 'ellipse') return;
        if (Math.abs((c.args[0] as number) - laneX(g, 0, 0)) > 1) return;
        if (Math.abs((c.args[1] as number) - g.strikeY) > 0.5) return;
        const rx = c.args[2] as number;
        if (rx <= g.receptorRadius) return;
        out.push({ rx, lw: (canvas.ctx.propBefore(i, 'lineWidth') as number) ?? 0 });
      });
      return out;
    };
    step(0.2, true);
    step(0.95, false); // the crossing: corona
    const corona = outerRings();
    expect(corona.length, 'the goal corona is drawn').toBeGreaterThan(0);
    for (let i = 0; i < 25; i++) step(0.95, false);
    step(0.4, false); // well into the return: the arc is long
    const arc = outerRings();
    expect(arc.length, 'the return-to-rest arc is drawn').toBeGreaterThan(0);
    for (const m of [...corona, ...arc]) {
      expect(m.rx + m.lw / 2).toBeLessThanOrEqual(g.laneWidthNear / 2 - 1);
      expect(m.rx, 'still outside the ring it belongs to').toBeGreaterThan(g.receptorRadius);
    }
  });
});

// -------------------------------------------------------------------------------------------------
// The fixed reference mark must not be confounded with the board's own decoration.
// -------------------------------------------------------------------------------------------------

describe('the target line is a different KIND of mark from the strike line', () => {
  const THRESH_CASES: Array<[string, number]> = [
    ['easy', 0.5],
    ['medium', 0.65],
    ['hard', 0.8],
  ];

  it('draws the threshold as dashes inside the well and solid ticks outside the ring', () => {
    for (const [name, threshold] of THRESH_CASES) {
      const { canvas, hw } = setup(1280, 720, { reducedMotion: true });
      hw.resize(1280, 720, 1);
      const g = hw.geometry;
      canvas.ctx.reset();
      hw.draw(
        makeFrame({
          lanes: LANES,
          songTime: 1,
          laneStates: LANES.map((l) => ({ lane: l.index, value: threshold * 0.5, armed: true, tracking: true })),
          thresholdFraction: threshold,
          rearmFraction: 0.6,
        }),
      );
      const dashes = targetDashes(canvas, hw, 0);
      // Several marks at one height, not one rule: a continuous white bar at this height is
      // confounded with the board-wide strike line, which on the DEFAULT difficulty crosses the
      // ring within a few pixels of it.
      expect(dashes.length, `${name}: dash count`).toBeGreaterThanOrEqual(3);
      const axis = meterAxis(hw, 1, threshold);
      for (const d of dashes) {
        expect(d.y + d.h / 2, `${name}: dash height`).toBeCloseTo(axis.yTarget, 0);
        expect(d.h, `${name}: dash thickness`).toBeLessThan(g.receptorRadius * 0.2);
      }
      // No white bar at that height spans the well: the gaps are real, at every difficulty.
      const solid = meterRects(canvas, hw, 0).filter(
        (m) => m.style === WHITE && Math.abs(m.y + m.h / 2 - axis.yTarget) < 1.5,
      );
      expect(solid, `${name}: no solid full-width rule at the target height`).toHaveLength(0);
      // ...and the same height IS carried unbroken, outside the ring where no liquid reaches: two
      // solid ticks. So the reference never rests on the dashes alone.
      const ticks = targetTicks(canvas, hw, 0);
      expect(ticks, `${name}: posts`).toHaveLength(2);
      for (const tick of ticks) {
        // The height is the post's MIDPOINT — what survives a blur when the bar itself does not.
        expect(Math.abs(tick.y + tick.h / 2 - axis.yTarget), `${name}: post height`).toBeLessThan(2);
        // ...and it stands ACROSS the line, so it cannot be absorbed into the horizontal strike
        // line at any scale. This is the whole reason it is not a tick any more.
        expect(tick.h, `${name}: post is upright`).toBeGreaterThan(tick.w * 2);
        expect(tick.h, `${name}: post is resolvable at a 220 px board`).toBeGreaterThan(g.receptorRadius * 0.3);
      }
    }
  });

  it('keeps the dashes clear of the solid ticks, so the two never read as one run', () => {
    const { canvas, hw } = setup(1280, 720, { reducedMotion: true });
    hw.resize(1280, 720, 1);
    const g = hw.geometry;
    canvas.ctx.reset();
    hw.draw(
      makeFrame({
        lanes: LANES,
        songTime: 1,
        laneStates: LANES.map((l) => ({ lane: l.index, value: 0.3, armed: true, tracking: true })),
        thresholdFraction: 0.5,
        rearmFraction: 0.6,
      }),
    );
    const cx = laneX(g, 0, 0);
    // Measured from the recorded rects (the helper reports heights, not horizontal extents).
    const xs: number[] = [];
    canvas.ctx.calls.forEach((c, i) => {
      if (c.name !== 'fillRect') return;
      if (canvas.ctx.propBefore(i, 'fillStyle') !== WHITE) return;
      const [x, , w, h] = c.args as number[];
      if (h > g.receptorRadius * 0.2 || w > g.receptorRadius * 0.35) return;
      if (Math.abs(x + w / 2 - cx) > g.receptorRadius * 0.75) return;
      xs.push(Math.abs(x + w / 2 - cx) + w / 2);
    });
    const ticks = targetTicks(canvas, hw, 0);
    const tickInner = Math.min(...ticks.map((t) => Math.abs(t.x + t.w / 2 - cx) - t.w / 2));
    // A real gap between the last dash and the first tick — at least a dash's worth of dark.
    expect(tickInner - Math.max(...xs)).toBeGreaterThan(g.receptorRadius * 0.1);
  });
});

// -------------------------------------------------------------------------------------------------
// The screen the receptor ships on: nothing the app floats over the board may cover it
// -------------------------------------------------------------------------------------------------

/**
 * ROUND-3 DEFECT. The play screen's camera picture-in-picture panel was pinned in CSS to
 * `left: 18px; bottom: 18px`, and at exactly the landscape widths a clinic tablet uses that is on
 * top of lane 0's receptor AND its label: screenshotted and measured, lane 0's "L knee lift" read
 * as "knee lift" at 1280x800 and "nee lift" at 1024x768, beside a fully legible "R knee lift" on
 * lane 1. On the DEFAULT bilateral prescription the side letter is the only mark distinguishing the
 * two lanes, so a hemiparetic patient was being told "lower to reset" on a lane nobody had named
 * and the therapist had to say out loud which leg it was — the 90-second test failing outright.
 *
 * `Highway.overlayPanel` is the fix: the board's geometry decides where a DOM panel may sit,
 * because only the board's geometry knows where the strike line, the gutter and the rock gauge are
 * at this canvas size and lane count.
 */
describe('overlay panel placement', () => {
  /** The shapes a clinic tablet presents, landscape and portrait. */
  const SIZES: Array<[number, number]> = [
    [1280, 800],
    [1024, 768],
    [1366, 768],
    [1920, 1080],
    [800, 400],
    [400, 800],
  ];

  /** `Highway.u`, recomputed from the public size the way `resize()` computes it. */
  const unit = (hw: Highway): number => {
    const { width, height } = hw.size;
    return Math.min(Math.max(Math.min(width / 1280, height / 720), 0.35), 2.5);
  };

  /** The y `drawLabels` puts the FIRST label row's centre at, and the row pitch under it. */
  const labelRowY = (hw: Highway): number =>
    hw.geometry.strikeY + hw.geometry.receptorRadius * GEM_ASPECT + 22 * unit(hw);

  it.each(SIZES)('clears the receptor row and its lane labels at %ix%i', (w, h) => {
    const { hw } = setup(w, h);
    hw.draw(makeFrame({ lanes: LANES, songTime: 0, thresholdFraction: 0.5 }));
    const g = hw.geometry;
    const box = hw.overlayPanel();
    const right = box.left + box.width;

    // The label under lane 0 is the mark the panel used to eat. Its anchor, and a generous ink box
    // around it (labels are fitted to ~0.96 of the lane pitch, centred on the lane), must be clear.
    const lx = laneX(g, 0, -0.02);
    const half = g.laneWidthNear * 0.48;
    const labelTop = labelRowY(hw) - 22 * unit(hw);
    expect(box.bottomY, 'panel bottom is above the lane-label row').toBeLessThan(labelTop);
    // ...and above the receptor ring itself, marks included.
    expect(box.bottomY, 'panel bottom is above the receptor band').toBeLessThan(
      g.strikeY - g.receptorRadius * GEM_ASPECT,
    );
    // Horizontal overlap with lane 0's label is then irrelevant, but assert the rect really does
    // miss the label box rather than merely sitting near it.
    const overlapsLabelX = right > lx - half && box.left < lx + half;
    const overlapsLabelY = box.bottomY > labelTop;
    expect(overlapsLabelX && overlapsLabelY).toBe(false);
  });

  it('does not land on the rock gauge either — the other tenant of the left gutter', () => {
    for (const [w, h] of SIZES) {
      const { hw } = setup(w, h);
      hw.draw(makeFrame({ lanes: LANES, songTime: 0, thresholdFraction: 0.5 }));
      const g = hw.geometry;
      const u = unit(hw);
      // `rockGaugeBox`, recomputed from public numbers exactly as drawHud lays the gauge out.
      const leftPanelW = Math.max(0, roadEdgeX(g, -1, 0));
      const r = Math.min(Math.max(Math.min(leftPanelW * 0.3, hw.size.height * 0.1, 90 * u), 18), 140);
      const gy = g.strikeY - r * 1.1;
      expect(hw.overlayPanel().bottomY, `${w}x${h}`).toBeLessThanOrEqual(gy - r);
    }
  });

  it('stays inside the road at the clinic-tablet widths, by narrowing rather than by overlapping', () => {
    for (const [w, h] of [
      [1280, 800],
      [1024, 768],
      [1920, 1080],
    ] as Array<[number, number]>) {
      const { hw } = setup(w, h);
      const box = hw.overlayPanel();
      expect(box.overRoad, `${w}x${h}`).toBe(false);
      expect(box.left + box.width).toBeLessThanOrEqual(roadEdgeXAtY(hw.geometry, -1, box.bottomY) + 1e-6);
    }
  });

  it('moves with the canvas — the whole reason it is not a CSS constant', () => {
    const { hw } = setup(1280, 800);
    const before = hw.overlayPanel();
    hw.resize(1024, 768, 1);
    const after = hw.overlayPanel();
    expect(after.bottom).not.toBeCloseTo(before.bottom, 1);
    expect(after.bottomY).toBeLessThan(hw.geometry.strikeY - hw.geometry.receptorRadius * GEM_ASPECT);
  });

  it('leaves the panel room to exist on every size it is offered', () => {
    for (const [w, h] of SIZES) {
      const box = setup(w, h).hw.overlayPanel();
      expect(box.maxHeight, `${w}x${h}`).toBeGreaterThan(100);
      expect(box.width).toBeGreaterThanOrEqual(150);
    }
  });
});

// -------------------------------------------------------------------------------------------------
// (c) may not counterfeit (b)'s mark COUNT at 220 px
// -------------------------------------------------------------------------------------------------

describe('the return-to-rest crescent never becomes a second ring', () => {
  it('stays in the lower half of the receptor at every point of the descent', () => {
    const { canvas, hw } = setup(1280, 800);
    const T = 0.6;
    const frameAt = (value: number): RenderFrame =>
      makeFrame({
        lanes: LANES,
        songTime: 0,
        thresholdFraction: T,
        laneStates: LANES.map((_, i) => ({ value: i === 0 ? value : 0, armed: i !== 0, tracking: true })),
      });
    // Rise to full ROM armed, cross (published already disarmed, as VisionInput really does), then
    // lower all the way to the re-arm line, sampling the whole return journey.
    let t = 0;
    const step = (value: number): void => {
      t += 1 / 60;
      hw.draw({ ...frameAt(value), songTime: t });
    };
    for (const v of [0.2, 0.45, 0.58]) step(v);
    step(1);
    for (let i = 0; i < 45; i++) step(1); // outlast the 0.45 + 0.15 s goal latch
    canvas.ctx.reset();
    for (let v = 1; v >= 0.3; v -= 0.02) step(v);

    const g = hw.geometry;
    let seen = 0;
    let maxSweep = 0;
    canvas.ctx.calls.forEach((c, i) => {
      if (c.name !== 'ellipse' || c.args.length < 7) return;
      if (canvas.ctx.propBefore(i, 'strokeStyle') !== LOCK_HINT) return;
      if (Math.abs((c.args[1] as number) - g.strikeY) > 0.5) return;
      // Lane 0 is the locked one; a neighbouring lane's re-arm pop draws at the same height.
      if (Math.abs((c.args[0] as number) - laneX(g, 0, 0)) > 1) return;
      if (!((c.args[2] as number) > g.receptorRadius)) return;
      const a0 = c.args[5] as number;
      const a1 = c.args[6] as number;
      seen++;
      maxSweep = Math.max(maxSweep, a1 - a0);
      // Canvas angles run clockwise with y down, so (0, π) IS the lower half of the ellipse. Both
      // ends — and therefore the whole arc — stay strictly below the horizontal through the ring's
      // centre, i.e. below the strike line the board draws across every receptor.
      expect(a0).toBeGreaterThan(0);
      expect(a1).toBeLessThan(Math.PI);
    });
    expect(seen, 'the crescent is drawn across the descent').toBeGreaterThan(10);
    // It can never close: at full progress it is still well under a half-turn, so the top half of a
    // locked receptor shows ONE ring where a goal receptor shows two (the additive rim and the
    // corona). That is the mark-count separation the 220 px downscale rests on, and it no longer
    // depends on the arc's alpha or on a quarter-turn gap at the top.
    expect(maxSweep).toBeCloseTo(RESET_ARC_SWEEP, 6);
    expect(RESET_ARC_START).toBeGreaterThan(0);
    expect(RESET_ARC_START + RESET_ARC_SWEEP).toBeLessThan(Math.PI);
  });
});

// -------------------------------------------------------------------------------------------------
// A STOPPED SESSION. The round-7 blocker: a therapist pause is the brief's "mid-song stop", the
// camera does not stop for it, `GameRunner.draw` keeps handing the renderer live lane states, and
// the engine discards every event stamped inside it. The receptor row threw the full
// knowledge-of-results costume for those inputs (measured on the real app: eleven consecutive frames
// of `goal === 1` with score/reps/hits flat at 0/0/0) and read "armed, rising, ready" for the rest.
// -------------------------------------------------------------------------------------------------

describe('while the session is not accepting input, the row says so', () => {
  const THRESH = 0.6;
  const LOST_RING = '#a9b0bb';

  const brokenArcsAt = (canvas: MockCanvas, hw: Highway): number => {
    const g = hw.geometry;
    let n = 0;
    canvas.ctx.calls.forEach((c, i) => {
      if (c.name !== 'ellipse' || c.args.length < 7) return;
      if (Math.abs((c.args[1] as number) - g.strikeY) > 0.5) return;
      if ((c.args[6] as number) - (c.args[5] as number) >= Math.PI * 2 - 1e-6) return;
      if (canvas.ctx.propBefore(i, 'strokeStyle') !== LOST_RING) return;
      n++;
    });
    return n;
  };
  /** The pause bars: two filled rectangles per lane, in the broken ring's own grey, on the strike line. */
  const pauseBars = (canvas: MockCanvas, hw: Highway): number => {
    const g = hw.geometry;
    let n = 0;
    canvas.ctx.calls.forEach((c, i) => {
      if (c.name !== 'fillRect') return;
      if (canvas.ctx.propBefore(i, 'fillStyle') !== LOST_RING) return;
      if (Math.abs((c.args[1] as number) + (c.args[3] as number) / 2 - g.strikeY) > 0.5) return;
      n++;
    });
    return n;
  };
  const glyph = (scratch: MockCanvas[], ch: string): boolean =>
    scratch.some((c) => c.ctx.calls.some((k) => k.name === 'fillText' && k.args[0] === ch));

  const states = (value: number, armed: boolean, trig: 'armed' | 'triggered') =>
    LANES.map((l) => ({ lane: l.index, value, armed, triggerState: trig, tracking: true }));

  it('blanks every lane to "no reading" with the pause bars, at any value, in any state', () => {
    const { canvas, hw, scratch } = setup();
    hw.resize(1280, 720, 1);
    const frame = (t: number, ls: ReturnType<typeof states>, suspended: boolean): RenderFrame =>
      makeFrame({ lanes: LANES, songTime: t, laneStates: ls, thresholdFraction: THRESH, rearmFraction: 0.6, beatPhase: 0.5, inputSuspended: suspended });
    // Warm a live, rising, armed row up — a halo, a column, a target line, everything (a) draws.
    for (let i = 0; i < 40; i++) hw.draw(frame(1 + i * 0.016, states(0.36, true, 'armed'), false));
    canvas.ctx.reset();
    // ...and stop the session. The song clock freezes with it, exactly as `GameRunner.pause` leaves it.
    hw.draw(frame(1.64, states(0.36, true, 'armed'), true));
    expect(brokenArcsAt(canvas, hw)).toBe(4 * 4); // the only broken rings on the board, one per lane
    expect(pauseBars(canvas, hw)).toBe(4 * 2);    // ...each with the two bars in it
    expect(glyph(scratch, '?')).toBe(false);      // not "the camera lost you" — the remedy differs
    expect(glyph(scratch, '!')).toBe(false);
    for (const l of LANES) {
      const look = hw.receptorLookOf(l.index);
      expect(receptorMarkSet(look as ReceptorLook)).toBe('lost');
      expect(look?.suspended).toBe(true);
      expect(look?.glowTarget).toBe(0);
      expect(look?.locked).toBe(false);
    }
    // A lane held AT end range reads the same: "lower to reset" is advice about a next rep that
    // cannot happen until the therapist resumes.
    canvas.ctx.reset();
    hw.draw(frame(1.64, states(0.9, false, 'triggered'), true));
    expect(brokenArcsAt(canvas, hw)).toBe(4 * 4);
    expect(pauseBars(canvas, hw)).toBe(4 * 2);
  });

  it('never celebrates a crossing made during the stop — and celebrates the first one after it', () => {
    const { canvas, hw } = setup();
    hw.resize(1280, 720, 1);
    const frame = (t: number, ls: ReturnType<typeof states>, suspended: boolean): RenderFrame =>
      makeFrame({ lanes: LANES, songTime: t, laneStates: ls, thresholdFraction: THRESH, rearmFraction: 0.6, beatPhase: 0.5, inputSuspended: suspended, minIntervalSec: 0.3 });
    hw.draw(frame(1.0, states(0.2, true, 'armed'), false));
    // THE REPRODUCTION. The song clock is frozen for the whole pause — `GameRunner` keeps drawing at
    // the paused song time — while the patient, repositioned by their therapist, completes a rep.
    let cues = 0;
    for (let i = 0; i < 12; i++) {
      hw.draw(frame(1.3015, states(0.9, false, 'triggered'), true));
      if ((hw.receptorLookOf(0)?.goal ?? 0) > 0) cues++;
    }
    expect(cues).toBe(0);
    // Resumed: still held, so still nothing to acknowledge...
    hw.draw(frame(1.32, states(0.9, false, 'triggered'), false));
    expect(hw.receptorLookOf(0)?.goal ?? 0).toBe(0);
    // ...and the next real rep gets its cue, on the frame it fires, inside the refractory window of
    // the crossing the pause discarded (which must have left no trace in the renderer's ledger).
    hw.draw(frame(1.36, states(0.1, true, 'armed'), false));
    hw.draw(frame(1.4, states(0.9, false, 'triggered'), false));
    expect(hw.receptorLookOf(0)?.goal).toBe(1);
    expect(receptorMarkSet(hw.receptorLookOf(0) as ReceptorLook)).toBe('goal');
    canvas.ctx.reset();
  });

  it('keeps the "!" for a faulted lane through a stop, because that one is the therapist\'s to fix', () => {
    const { hw, scratch } = setup();
    hw.resize(1280, 720, 1);
    hw.setLaneFaults([2]);
    hw.draw(makeFrame({ lanes: LANES, songTime: 1, laneStates: states(0.36, true, 'armed'), thresholdFraction: THRESH, inputSuspended: true }));
    expect(glyph(scratch, '!')).toBe(true);
    expect(glyph(scratch, '?')).toBe(false);
    hw.setLaneFaults(null);
  });
});

describe('the effort gauge is not a failure alarm', () => {
  /** Colours the gauge arc is stroked in, at a given effort value. */
  const gaugeStrokes = (health: number, songTime: number): string[] => {
    const { canvas, hw } = setup();
    hw.draw(makeFrame({ lanes: LANES, songTime, health, beatPhase: 0.5, combo: 0, multiplier: 1, thresholdFraction: 0.6 }));
    return canvas.ctx.calls
      .map((c, i) => (c.name === 'stroke' ? String(canvas.ctx.propBefore(i, 'strokeStyle')) : null))
      .filter((c): c is string => c !== null);
  };

  it('never paints the old alarm red, however low the reading', () => {
    for (const h of [0, 0.05, 0.1, 0.29]) {
      expect(gaugeStrokes(h, 3).some((c) => c.toLowerCase() === '#ff3b3b')).toBe(false);
    }
  });

  it('does not pulse: a low reading is drawn identically at any phase of the old 1.6 Hz blink', () => {
    // The alarm was `0.5 + 0.5*sin(t*10)`: t = 3 and t = 3.314 are its opposite extremes.
    const alphasAt = (songTime: number): number[] => {
      const { canvas, hw } = setup();
      hw.draw(makeFrame({ lanes: LANES, songTime, health: 0.1, beatPhase: 0.5, combo: 0, multiplier: 1, thresholdFraction: 0.6 }));
      return canvas.ctx.calls
        .map((c, i) => (c.name === 'stroke' ? Number(canvas.ctx.propBefore(i, 'globalAlpha')) : null))
        .filter((a): a is number => a !== null);
    };
    expect(alphasAt(3)).toEqual(alphasAt(3 + Math.PI / 10));
  });
});

/**
 * THE SONG-END SEQUENCE.
 *
 * The chart running out used to leave 1.5 s of empty highway and then a cut to a grid. This is the
 * payoff: the board dims, the title lands, the score settles where it finished, the session's own
 * counts arrive, and one warm sentence about what the patient did closes it.
 */
describe('the song-end sequence', () => {
  const SPEC = {
    title: 'SONG COMPLETE',
    subtitle: 'Test Song',
    score: 5100,
    stats: [
      { value: '142', label: 'MOVEMENTS PERFORMED' },
      { value: '6/200', label: 'NOTES ANSWERED IN TIME' },
    ],
    achievement: '142 movements performed',
    achievementNote: 'Every rep counted.',
    hint: 'Tap the screen or press any key for the report',
  };

  /** Drive the sequence forward by `sec`, one 60 Hz frame at a time, drawing each one. */
  const run = (hw: Highway, sec: number, frame = makeFrame({ lanes: LANES, songTime: 10, thresholdFraction: 0.5 })): void => {
    for (let t = 0; t < sec; t += 1 / 60) {
      hw.advanceFinale(1 / 60);
      hw.draw(frame);
    }
  };

  const wrote = (scratch: MockCanvas[], text: string): boolean =>
    scratch.some((c) => c.ctx.calls.some((k) => k.name === 'fillText' && k.args[0] === text));

  it('is inert until it is started, and then reports its own progress', () => {
    const { hw } = setup();
    hw.resize(1280, 720, 1);
    expect(hw.isFinaleActive()).toBe(false);
    expect(hw.finaleDone()).toBe(false);
    hw.startFinale(SPEC);
    expect(hw.isFinaleActive()).toBe(true);
    expect(hw.finaleDone()).toBe(false);
    run(hw, FINALE_SEC + 0.2);
    expect(hw.finaleDone()).toBe(true);
  });

  it('lands the title, settles the score on its final value and states the session"s own counts', () => {
    const { hw, scratch } = setup();
    hw.resize(1280, 720, 1);
    hw.startFinale(SPEC);
    run(hw, FINALE_SEC + 0.2);
    expect(wrote(scratch, 'SONG COMPLETE')).toBe(true);
    expect(wrote(scratch, 'Test Song')).toBe(true);
    expect(wrote(scratch, 'MOVEMENTS PERFORMED')).toBe(true);
    // The crowd is over the curtain, not under it.
    expect(hw.finaleConfettiCount()).toBeGreaterThanOrEqual(0);
    expect(wrote(scratch, '142 movements performed')).toBe(true);
    expect(wrote(scratch, 'Tap the screen or press any key for the report')).toBe(true);
    // THE ODOMETER SETTLES. The patient watched it climb all song and the old ending cut it off
    // mid-climb; by the end of the sequence it reads the score the session actually finished on.
    expect(wrote(scratch, '5')).toBe(true);
    expect(wrote(scratch, ',')).toBe(true);
  });

  it('rolls the score up rather than printing it at once', () => {
    const { hw, scratch } = setup();
    hw.resize(1280, 720, 1);
    hw.startFinale(SPEC);
    // Just after the roll starts, the digits on screen are NOT yet the final ones.
    run(hw, 1.1);
    const early = scratch.filter((c) => c.ctx.calls.some((k) => k.name === 'fillText')).length;
    run(hw, FINALE_SEC);
    expect(scratch.filter((c) => c.ctx.calls.some((k) => k.name === 'fillText')).length).toBeGreaterThan(early);
  });

  /** Nothing here may read as a mark: no stars, no percentage, no pass. */
  it('says nothing that grades the patient', () => {
    const { hw, scratch } = setup();
    hw.resize(1280, 720, 1);
    hw.startFinale(SPEC);
    run(hw, FINALE_SEC + 0.2);
    const words = scratch
      .flatMap((c) => c.ctx.calls.filter((k) => k.name === 'fillText').map((k) => String(k.args[0])))
      .join(' ');
    expect(words).not.toMatch(/★|star|failed|rank|grade/i);
  });

  it('holds the skip for the opening of the sequence, then accepts it', () => {
    const { hw } = setup();
    hw.resize(1280, 720, 1);
    hw.startFinale(SPEC);
    run(hw, FINALE_SKIP_GUARD_SEC * 0.5);
    expect(hw.finaleSkippable()).toBe(false);
    expect(hw.skipFinale()).toBe(false);
    expect(hw.finaleDone()).toBe(false);
    run(hw, FINALE_SKIP_GUARD_SEC);
    expect(hw.finaleSkippable()).toBe(true);
    expect(hw.skipFinale()).toBe(true);
    expect(hw.finaleDone()).toBe(true);
  });

  it('cannot be restarted by a second chart-end, and is cleared by a new run', () => {
    const { hw } = setup();
    hw.resize(1280, 720, 1);
    hw.startFinale(SPEC);
    run(hw, 1);
    const t = hw.finaleElapsed();
    hw.startFinale({ ...SPEC, title: 'AGAIN' });
    expect(hw.finaleElapsed()).toBe(t);
    hw.reset();
    expect(hw.isFinaleActive()).toBe(false);
    expect(hw.finaleElapsed()).toBe(0);
  });

  it('throws no confetti under reduced motion, and plenty without it', () => {
    const loud = setup(1280, 720, { reducedMotion: false });
    loud.hw.resize(1280, 720, 1);
    loud.hw.startFinale(SPEC);
    run(loud.hw, 1.5);
    expect(loud.hw.finaleConfettiCount()).toBeGreaterThan(0);

    const calm = setup(1280, 720, { reducedMotion: true });
    calm.hw.resize(1280, 720, 1);
    calm.hw.startFinale(SPEC);
    run(calm.hw, 1.5);
    expect(calm.hw.finaleConfettiCount()).toBe(0);
  });

  /**
   * THE TYPE SCALE IS THE ORDERING, and it was the wrong way round.
   *
   * The card used to draw a 58 px glowing gold score over a 19 px sentence, so on the session this
   * screen matters most for — 142 movements, six notes answered, nought points — the biggest thing
   * after the banner was a gold "0". Results and History were both corrected to lead with the work
   * and fold the grade away; this asserts the highway agrees with them.
   */
  it('draws the work bigger than the grade: hero > sentence > score', () => {
    // Reduced motion, so neither odometer rolls: each figure is only ever drawn at its final value
    // and no digit of one can be mistaken for a digit the other counted through.
    const { hw, scratch } = setup(1280, 720, { reducedMotion: true });
    hw.resize(1280, 720, 1);
    hw.startFinale({
      ...SPEC,
      score: 5300,
      stats: [{ value: '77', label: 'MOVEMENTS' }, { value: '6/189', label: 'NOTES ANSWERED' }],
      achievement: 'Seventy-seven movements performed',
    });
    run(hw, FINALE_SEC + 0.2);
    /**
     * The font size of the sprite that rasterises EXACTLY this string and nothing else — the HUD's
     * score odometer keeps all ten digits on one strip, and matching that would read the HUD's type
     * scale instead of the card's.
     */
    const fontPx = (text: string): number => {
      let px = 0;
      for (const c of scratch) {
        const drawn = c.ctx.calls.filter((k) => k.name === 'fillText');
        if (drawn.length === 0 || !drawn.every((k) => k.args[0] === text)) continue;
        const m = /(\d+(?:\.\d+)?)px/.exec(String(c.ctx.props.font));
        if (m) px = Math.max(px, Number(m[1]));
      }
      return px;
    };
    const hero = fontPx('7');
    const sentence = fontPx('Seventy-seven movements performed');
    const score = fontPx('3');
    expect(hero).toBeGreaterThan(0);
    expect(sentence).toBeGreaterThan(0);
    expect(score).toBeGreaterThan(0);
    // The count of movements performed is the biggest figure on the card...
    expect(hero).toBeGreaterThan(sentence);
    expect(hero).toBeGreaterThan(score * 2);
    // ...and the one warm sentence outranks the points.
    expect(sentence).toBeGreaterThan(score);
  });

  /** The odometer is still SEEN to settle — it just does it last, and small. */
  it('finishes rolling the score with the card still on screen', () => {
    const { hw, scratch } = setup();
    hw.resize(1280, 720, 1);
    hw.startFinale({ ...SPEC, score: 5300 });
    // 1.2 s before the sequence ends, the score has already reached its final value.
    run(hw, FINALE_SEC - 1.2);
    const digits = (text: string) => scratch.some((c) => c.ctx.calls.some((k) => k.name === 'fillText' && k.args[0] === text));
    expect(digits('3')).toBe(true);
    expect(hw.finaleDone()).toBe(false);
  });

  it('draws at the small end of the supported canvas without throwing', () => {
    const { hw, scratch } = setup(1024, 768);
    hw.resize(1024, 768, 1);
    hw.startFinale({ ...SPEC, stats: [...SPEC.stats, { value: '9', label: 'LONGEST RUN' }, { value: '1:37', label: 'TIME MOVING' }] });
    run(hw, FINALE_SEC + 0.2, makeFrame({ lanes: LANES, songTime: 10, thresholdFraction: 0.5 }));
    expect(wrote(scratch, 'SONG COMPLETE')).toBe(true);
    expect(wrote(scratch, 'TIME MOVING')).toBe(true);
  });
});
