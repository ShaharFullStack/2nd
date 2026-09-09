import { afterEach, describe, expect, it } from 'vitest';
import { DIFFICULTIES, FINE_MOTOR_WINDOW_MULTIPLIER, getGlobalWindowScale, resetGlobalWindowScale, setGlobalWindowScale, windowsFor } from './difficulty.ts';

afterEach(() => resetGlobalWindowScale());

describe('DIFFICULTIES', () => {
  it('matches the architecture contract', () => {
    expect(DIFFICULTIES.easy).toEqual({ name: 'easy', thresholdFraction: 0.5, noteDensity: 0.5, windows: { perfectMs: 90, goodMs: 180 } });
    expect(DIFFICULTIES.medium).toEqual({ name: 'medium', thresholdFraction: 0.65, noteDensity: 1, windows: { perfectMs: 70, goodMs: 140 } });
    expect(DIFFICULTIES.hard).toEqual({ name: 'hard', thresholdFraction: 0.8, noteDensity: 1.5, windows: { perfectMs: 50, goodMs: 110 } });
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
  it('applies the global therapist scale and clamps it', () => {
    setGlobalWindowScale(1.5);
    expect(getGlobalWindowScale()).toBe(1.5);
    expect(windowsFor('knee_extension', 'medium')).toEqual({ perfectMs: 105, goodMs: 210 });
    expect(windowsFor('knee_extension', 'medium', undefined, 1)).toEqual({ perfectMs: 70, goodMs: 140 });
    setGlobalWindowScale(100);
    expect(getGlobalWindowScale()).toBe(4);
    setGlobalWindowScale(Number.NaN);
    expect(getGlobalWindowScale()).toBe(4);
  });
});
