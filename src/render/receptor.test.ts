import { describe, expect, it } from 'vitest';
import { DEFAULT_REARM_FRACTION, receptorLook, receptorLookInto, type ReceptorLook } from './receptor';

const T = 0.6; // a plausible calibrated thresholdFraction

describe('receptorLook — the meter means what the engine means', () => {
  it('fills against thresholdFraction, not against 1.0', () => {
    expect(receptorLook({ value: 0, armed: true }, T).fill).toBe(0);
    expect(receptorLook({ value: 0.3, armed: true }, T).fill).toBeCloseTo(0.5, 6);
    expect(receptorLook({ value: 0.6, armed: true }, T).fill).toBe(1);
    // Past threshold the meter stays full (it cannot read "more than triggering").
    expect(receptorLook({ value: 0.95, armed: true }, T).fill).toBe(1);
  });

  it('reads "will fire" exactly when the lane would fire', () => {
    // Armed and at threshold: the lane fires. This is the only state that gets the hot fill + halo.
    expect(receptorLook({ value: 0.6, armed: true }, T).willFire).toBe(true);
    // One notch below threshold: no.
    expect(receptorLook({ value: 0.599, armed: true }, T).willFire).toBe(false);
    // Full value but NOT re-armed (patient holding at end range after a rep): the lane cannot fire,
    // so the receptor must not claim it will. This is the case the whole state model exists for.
    expect(receptorLook({ value: 0.95, armed: false }, T).willFire).toBe(false);
    // Tracking lost: nothing can fire.
    expect(receptorLook({ value: 0.95, armed: true, tracking: false }, T).willFire).toBe(false);
  });

  it('locks out an unarmed lane and never gives it a halo', () => {
    const held = receptorLook({ value: 0.9, armed: false }, T);
    expect(held.locked).toBe(true);
    expect(held.glowTarget).toBe(0);
    const live = receptorLook({ value: 0.9, armed: true }, T);
    expect(live.locked).toBe(false);
    expect(live.glowTarget).toBeGreaterThan(0.9);
  });

  it('tracks progress back toward the re-arm line while locked', () => {
    // Re-arm happens below threshold * 0.6 = 0.36 of ROM.
    const at = (value: number): number => receptorLook({ value, armed: false }, T).resetProgress;
    expect(at(0.6)).toBe(0); // still at the top, nothing given back yet
    expect(at(0.48)).toBeCloseTo(0.5, 6); // half way down to the re-arm line
    expect(at(0.36)).toBe(1); // at the line — about to re-arm
    expect(at(0.1)).toBe(1);
    expect(at(0.8)).toBe(0); // above threshold: still 0, never negative
    // An armed lane is not "resetting" at all.
    expect(receptorLook({ value: 0.5, armed: true }, T).resetProgress).toBe(0);
  });

  it('puts the re-arm line where the engine re-arms', () => {
    expect(receptorLook({ value: 0.9, armed: false }, T).resetLevel).toBeCloseTo(DEFAULT_REARM_FRACTION, 6);
    expect(receptorLook({ value: 0.9, armed: false }, T, 0.4).resetLevel).toBeCloseTo(0.4, 6);
    // resetProgress follows the tuned re-arm fraction too (line at 0.6 * 0.4 = 0.24 of ROM).
    expect(receptorLook({ value: 0.24, armed: false }, T, 0.4).resetProgress).toBe(1);
    expect(receptorLook({ value: 0.42, armed: false }, T, 0.4).resetProgress).toBeCloseTo(0.5, 6);
  });

  it('lost tracking dims but does not claim a lockout', () => {
    const lost = receptorLook({ value: 0.9, armed: true, tracking: false }, T);
    expect(lost.tracking).toBe(false);
    expect(lost.locked).toBe(false); // it is not "lower to reset", it is "I cannot see you"
    expect(lost.glowTarget).toBe(0);
  });

  it('degenerate inputs clamp instead of propagating', () => {
    expect(receptorLook({ value: Number.NaN, armed: true }, T).fill).toBe(0);
    expect(receptorLook({ value: 5, armed: true }, T).fill).toBe(1);
    expect(receptorLook({ value: -3, armed: true }, T).fill).toBe(0);
    expect(receptorLook({ value: 0.5, armed: true }, Number.NaN).fill).toBeGreaterThan(0);
    expect(Number.isFinite(receptorLook({ value: 0.5, armed: false }, 0, Number.NaN).resetProgress)).toBe(true);
    // No lane state at all: idle, tracked, armed.
    const none = receptorLook(undefined, T);
    expect(none.fill).toBe(0);
    expect(none.locked).toBe(false);
    expect(none.tracking).toBe(true);
  });

  it('receptorLookInto reuses the caller object (hot path allocates nothing)', () => {
    const out: ReceptorLook = { fill: 0, over: 0, willFire: false, locked: false, resetProgress: 0, resetLevel: 0.6, glowTarget: 0, tracking: true };
    const a = receptorLookInto(out, { value: 0.9, armed: true }, T, DEFAULT_REARM_FRACTION);
    expect(a).toBe(out);
    expect(out.willFire).toBe(true);
    receptorLookInto(out, { value: 0.9, armed: false }, T, DEFAULT_REARM_FRACTION);
    expect(out.willFire).toBe(false);
    expect(out.locked).toBe(true);
    expect(out).toEqual(receptorLook({ value: 0.9, armed: false }, T));
  });
});
