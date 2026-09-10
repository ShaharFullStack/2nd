// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { DIFFICULTIES, FINE_MOTOR_WINDOW_MULTIPLIER, checkWindowScale, clampWindowScale, windowsFor, windowsForLanes } from './difficulty.ts';
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
  it('clamps the multiplier override like the scale, instead of handing the Judge a zero window', () => {
    // a therapist control that reaches 0 or a negative number must be caught here, not at Play time
    expect(windowsFor('seated_march', 'medium', 0)).toEqual({ perfectMs: 70 * 0.25, goodMs: 140 * 0.25 });
    expect(windowsFor('seated_march', 'medium', -1)).toEqual({ perfectMs: 70 * 0.25, goodMs: 140 * 0.25 });
    expect(windowsFor('seated_march', 'medium', 1000)).toEqual({ perfectMs: 280, goodMs: 560 });
    expect(windowsFor('seated_march', 'medium', Number.NaN)).toEqual({ perfectMs: 70, goodMs: 140 });
    for (const m of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1e9]) {
      const w = windowsFor('finger_opposition', 'hard', m, m);
      expect(w.perfectMs).toBeGreaterThan(0);
      expect(w.goodMs).toBeGreaterThanOrEqual(w.perfectMs);
      expect(Number.isFinite(w.goodMs)).toBe(true);
    }
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
    expect(windowsForLanes([{ index: 0, movement: 'seated_march', side: 'left' }], 'easy')).toHaveLength(1);
  });
  it('rejects lane specs that do not cover 0..n-1 exactly once (no silent gross-motor fallback)', () => {
    expect(() => windowsForLanes([{ index: 2, movement: 'finger_spread', side: 'left' }], 'easy')).toThrow(/index 2 out of range/);
    expect(() => windowsForLanes([{ index: -1, movement: 'seated_march', side: 'left' }], 'easy')).toThrow(/out of range/);
    expect(() => windowsForLanes([{ index: 0.5, movement: 'seated_march', side: 'left' }], 'easy')).toThrow(/out of range/);
    expect(() =>
      windowsForLanes(
        [
          { index: 0, movement: 'finger_spread', side: 'left' },
          { index: 0, movement: 'seated_march', side: 'right' },
        ],
        'easy',
      ),
    ).toThrow(/duplicate lane index 0/);
    expect(() => windowsForLanes([], 'easy')).toThrow(/no lanes/);
  });
});

describe('checkWindowScale (a clinical control must not silently apply a different number)', () => {
  it('reports the clamp instead of hiding it', () => {
    expect(checkWindowScale(1)).toEqual({ value: 1, clamped: false, reason: 'ok', message: null });
    expect(checkWindowScale(0.25)).toMatchObject({ value: 0.25, clamped: false, reason: 'ok' });
    expect(checkWindowScale(4)).toMatchObject({ value: 4, clamped: false, reason: 'ok' });

    // the probed cases: a therapist typing 0.1 was getting 0.25 — 2.5x what they asked for
    const low = checkWindowScale(0.1);
    expect(low).toMatchObject({ value: 0.25, clamped: true, reason: 'below_min' });
    expect(low.message).toMatch(/0\.1/);
    expect(checkWindowScale(0)).toMatchObject({ value: 0.25, clamped: true, reason: 'below_min' });
    expect(checkWindowScale(-2)).toMatchObject({ value: 0.25, clamped: true, reason: 'below_min' });
    expect(checkWindowScale(100)).toMatchObject({ value: 4, clamped: true, reason: 'above_max' });
    expect(checkWindowScale(Number.NaN)).toMatchObject({ value: 1, clamped: true, reason: 'non_finite' });
    expect(checkWindowScale(Number.POSITIVE_INFINITY)).toMatchObject({ value: 1, clamped: true, reason: 'non_finite' });
    for (const bad of [0, 0.1, 100, Number.NaN]) expect(checkWindowScale(bad).message).toBeTruthy();
  });
  it('agrees exactly with the silent clamp windowsFor applies', () => {
    for (const s of [-5, 0, 0.1, 0.25, 0.5, 1, 2, 4, 9, Number.NaN]) {
      expect(clampWindowScale(s)).toBe(checkWindowScale(s).value);
      const w = windowsFor('seated_march', 'easy', undefined, s);
      expect(w.goodMs).toBeCloseTo(180 * checkWindowScale(s).value, 9);
    }
  });
});
