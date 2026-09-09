// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { DIFFICULTIES, FINE_MOTOR_WINDOW_MULTIPLIER, clampWindowScale, windowsFor, windowsForLanes } from './difficulty.ts';
import type { LaneSpec } from './types.ts';

describe('DIFFICULTIES', () => {
  it('matches the architecture contract', () => {
    expect(DIFFICULTIES.easy).toEqual({ name: 'easy', thresholdFraction: 0.5, noteDensity: 0.5, windows: { perfectMs: 90, goodMs: 180 } });
    expect(DIFFICULTIES.medium).toEqual({ name: 'medium', thresholdFraction: 0.65, noteDensity: 1, windows: { perfectMs: 70, goodMs: 140 } });
    expect(DIFFICULTIES.hard).toEqual({ name: 'hard', thresholdFraction: 0.8, noteDensity: 1.5, windows: { perfectMs: 50, goodMs: 110 } });
  });
  it('is deep-frozen', () => {
    expect(Object.isFrozen(DIFFICULTIES.easy.windows)).toBe(true);
    expect(() => {
      (DIFFICULTIES.easy.windows as { perfectMs: number }).perfectMs = 1;
    }).toThrow();
    expect(DIFFICULTIES.easy.windows.perfectMs).toBe(90);
  });
});

describe('windowsFor', () => {
  it('returns base windows for gross motor movements', () => {
    expect(windowsFor('seated_march', 'medium')).toEqual({ perfectMs: 70, goodMs: 140 });
    expect(windowsFor('hand_open_close', DIFFICULTIES.hard)).toEqual({ perfectMs: 50, goodMs: 110 });
  });
  it('applies x1.6 to fine motor movements', () => {
    const w = windowsFor('finger_opposition', 'easy');
    expect(w.perfectMs).toBeCloseTo(90 * FINE_MOTOR_WINDOW_MULTIPLIER);
    expect(w.goodMs).toBeCloseTo(180 * FINE_MOTOR_WINDOW_MULTIPLIER);
    expect(windowsFor('finger_spread', 'hard').goodMs).toBeCloseTo(110 * 1.6);
  });
  it('honours multiplier override', () => {
    expect(windowsFor('finger_spread', 'easy', 1)).toEqual({ perfectMs: 90, goodMs: 180 });
    expect(windowsFor('seated_march', 'easy', 2)).toEqual({ perfectMs: 180, goodMs: 360 });
  });
  it('applies an explicit therapist scale and clamps it (no global state)', () => {
    expect(windowsFor('knee_extension', 'medium', undefined, 1.5)).toEqual({ perfectMs: 105, goodMs: 210 });
    expect(windowsFor('knee_extension', 'medium')).toEqual({ perfectMs: 70, goodMs: 140 });
    expect(clampWindowScale(100)).toBe(4);
    expect(clampWindowScale(0)).toBe(0.25);
    expect(clampWindowScale(Number.NaN)).toBe(1);
    expect(windowsFor('knee_extension', 'medium', undefined, 100)).toEqual({ perfectMs: 280, goodMs: 560 });
  });
  it('builds per-lane windows from lane specs', () => {
    const lanes: LaneSpec[] = [
      { index: 1, movement: 'finger_spread', side: 'left' },
      { index: 0, movement: 'hand_open_close', side: 'right' },
    ];
    const w = windowsForLanes(lanes, 'medium', 2);
    expect(w[0]).toEqual({ perfectMs: 140, goodMs: 280 });
    expect(w[1].goodMs).toBeCloseTo(140 * 1.6 * 2);
    expect(windowsForLanes([{ index: 2, movement: 'seated_march', side: 'left' }], 'easy')).toHaveLength(3);
  });
});
