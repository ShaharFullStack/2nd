/**
 * THE PATIENT'S CUE FOR *WHICH* MOVEMENT MAY NEVER BE THE LANE COLOUR ALONE.
 *
 * `?lanes=finger_opposition:left:index,finger_opposition:left:pinky` is the prescription the fingertip
 * choice was built for. The data layer carried it correctly from the first version — the calibration
 * key, the VisionInput feature options, the trend key and the stored `LaneResultSummary.fingertip` all
 * separate an index lane from a little-finger lane — but the DISPLAY NAME did not: `movementLabel()`
 * had no fingertip dimension, so the highway drew "L pinch" under both lanes and the therapist's
 * per-movement records came back with two identically titled cards.
 *
 * This file pins the name at the two places a human reads it: the label drawn under the lane the
 * patient is acting on, and the sentence a therapist is shown when a lane needs attention.
 */
import { describe, expect, it } from 'vitest';
import type { LaneSpec } from '../engine/types.ts';
import { Highway, makeFrame } from '../render/Highway.ts';
import { createMockCanvas, mockCanvasFactory, type MockCanvas } from '../render/canvasMock.ts';
import { laneLabel } from '../render/palette.ts';
import { laneName } from './common.tsx';

/** Every string the highway actually painted under a lane, in lane order. */
function drawnLabels(canvas: MockCanvas, scratch: MockCanvas[]): string[] {
  const out: Array<{ x: number; text: string }> = [];
  for (const c of canvas.ctx.calls) {
    if (c.name !== 'drawImage') continue;
    const src = c.args[0] as MockCanvas;
    if (!scratch.includes(src)) continue;
    const drawn = src.ctx.calls.find((k) => k.name === 'fillText');
    const text = drawn ? String(drawn.args[0]) : '';
    if (!/^[LR] /.test(text)) continue;
    out.push({ x: c.args[1] as number, text });
  }
  return out.sort((a, b) => a.x - b.x).map((s) => s.text);
}

function render(lanes: LaneSpec[]): { canvas: MockCanvas; hw: Highway; scratch: MockCanvas[] } {
  const canvas = createMockCanvas(1280, 720);
  const scratch: MockCanvas[] = [];
  const hw = new Highway(canvas, { createCanvas: mockCanvasFactory(scratch) });
  hw.resize(1280, 720, 1);
  canvas.ctx.reset();
  hw.draw(makeFrame({ lanes, songTime: 1, thresholdFraction: 0.6 }));
  return { canvas, hw, scratch };
}

const TWO_TIPS: LaneSpec[] = [
  { index: 0, movement: 'finger_opposition', side: 'left', fingertip: 'index' },
  { index: 1, movement: 'finger_opposition', side: 'left', fingertip: 'pinky' },
];

describe('the label drawn under a lane', () => {
  it('names the prescribed digit, so two pinch lanes on one hand are not the same word twice', () => {
    const { canvas, scratch } = render(TWO_TIPS);
    const labels = drawnLabels(canvas, scratch);
    expect(labels).toEqual(['L index pinch', 'L little pinch']);
  });

  it('says "little", not "pinky" — the word a therapist says out loud', () => {
    expect(laneLabel({ movement: 'finger_opposition', side: 'right', fingertip: 'pinky' })).toBe('R little pinch');
    expect(laneLabel({ movement: 'finger_opposition', side: 'left', fingertip: 'middle' })).toBe('L middle pinch');
  });

  it('names the DEFAULT digit for a lane the therapist never touched — it is still measured on it', () => {
    const { canvas, scratch } = render([
      { index: 0, movement: 'finger_opposition', side: 'right' },
      { index: 1, movement: 'hand_open_close', side: 'right' },
    ]);
    expect(drawnLabels(canvas, scratch)).toEqual(['R index pinch', 'R open hand']);
  });

  it('leaves every movement without a fingertip dimension exactly as it was', () => {
    const { canvas, scratch } = render([
      { index: 0, movement: 'seated_march', side: 'left' },
      { index: 1, movement: 'knee_extension', side: 'right' },
    ]);
    expect(drawnLabels(canvas, scratch)).toEqual(['L knee lift', 'R knee ext']);
  });

  it('re-cuts the label when only the fingertip changes on a reused highway', () => {
    // The label cache keys on the lane spec. Keyed on movement+side alone it would keep painting the
    // previous digit's name after the therapist changed the prescription.
    const canvas = createMockCanvas(1280, 720);
    const scratch: MockCanvas[] = [];
    const hw = new Highway(canvas, { createCanvas: mockCanvasFactory(scratch) });
    hw.resize(1280, 720, 1);
    hw.draw(makeFrame({ lanes: TWO_TIPS, songTime: 1, thresholdFraction: 0.6 }));
    canvas.ctx.reset();
    hw.draw(
      makeFrame({
        lanes: [
          { index: 0, movement: 'finger_opposition', side: 'left', fingertip: 'ring' },
          { index: 1, movement: 'finger_opposition', side: 'left', fingertip: 'pinky' },
        ],
        songTime: 2,
        thresholdFraction: 0.6,
      }),
    );
    expect(drawnLabels(canvas, scratch)).toEqual(['L ring pinch', 'L little pinch']);
  });
});

describe('the sentence a therapist is shown about a lane', () => {
  it('names the digit, so "this lane will not score" points at one lane', () => {
    expect(laneName(TWO_TIPS[0])).toBe('Left Finger opposition (index finger)');
    expect(laneName(TWO_TIPS[1])).toBe('Left Finger opposition (little finger)');
    expect(laneName(TWO_TIPS[0])).not.toBe(laneName(TWO_TIPS[1]));
  });

  it('assumes the default digit rather than staying silent about which finger', () => {
    expect(laneName({ movement: 'finger_opposition', side: 'right' })).toBe('Right Finger opposition (index finger)');
  });

  it('adds nothing to a movement that has no fingertip', () => {
    expect(laneName({ movement: 'ankle_dorsiflexion', side: 'left' })).toBe('Left Ankle dorsiflexion');
  });
});
