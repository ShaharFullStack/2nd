import { describe, expect, it } from 'vitest';
import { LaneTrigger } from './trigger.ts';
import { repSequence } from './fixtures.ts';

describe('LaneTrigger', () => {
  it('emits exactly one event per rep with hysteresis', () => {
    const trig = new LaneTrigger({ thresholdFraction: 0.6 });
    const seq = repSequence({ restSec: 1, reps: 5, repDurationSec: 1, amplitude: 1, noise: 0.05, seed: 3 });
    const events = [];
    for (const { t, amount } of seq) {
      const e = trig.push(amount, t);
      if (e) events.push(e);
    }
    expect(events).toHaveLength(5);
    // Each event lies on the rising half of its rep (rep k starts at 1 + k).
    events.forEach((e, k) => {
      expect(e.ctxTime).toBeGreaterThan(1 + k);
      expect(e.ctxTime).toBeLessThan(1 + k + 0.5);
      expect(e.strength).toBeGreaterThanOrEqual(0.6);
    });
  });

  it('does not re-trigger while hovering around the threshold (must fall below 0.6x)', () => {
    const trig = new LaneTrigger({ thresholdFraction: 0.5 });
    let t = 0;
    const step = (v: number) => trig.push(v, (t += 0.1));
    expect(step(0)).toBeNull();
    expect(step(0.7)).not.toBeNull();
    expect(trig.armed).toBe(false);
    for (const v of [0.4, 0.55, 0.35, 0.6, 0.31]) expect(step(v)).toBeNull();
    expect(trig.armed).toBe(false);
    expect(step(0.29)).toBeNull(); // below 0.3 => re-armed
    expect(trig.armed).toBe(true);
    expect(step(0.8)).not.toBeNull();
  });

  it('interpolates the crossing time between frames', () => {
    const trig = new LaneTrigger({ thresholdFraction: 0.5 });
    trig.push(0.2, 1.0);
    const e = trig.push(0.8, 1.1);
    expect(e).not.toBeNull();
    // 0.2 -> 0.8 over 100 ms; threshold 0.5 is halfway => 1.05
    expect(e!.ctxTime).toBeCloseTo(1.05, 9);
    expect(e!.strength).toBe(0.8);
  });

  it('uses the frame time when there is no previous frame (tracking just resumed)', () => {
    const trig = new LaneTrigger({ thresholdFraction: 0.5 });
    trig.push(null, 0.9);
    const e = trig.push(0.9, 1.0);
    expect(e!.ctxTime).toBe(1.0);
  });

  it('enforces the minimum re-trigger interval', () => {
    const trig = new LaneTrigger({ thresholdFraction: 0.5, minIntervalSec: 0.3 });
    expect(trig.push(0, 0)).toBeNull();
    expect(trig.push(1, 0.05)).not.toBeNull();
    trig.push(0, 0.1);
    expect(trig.armed).toBe(true);
    expect(trig.push(1, 0.15)).toBeNull(); // too soon, swallowed
    trig.push(0, 0.2);
    expect(trig.push(1, 0.5)).not.toBeNull();
  });

  it('tracks the peak and supports threshold changes / reset', () => {
    const trig = new LaneTrigger({ thresholdFraction: 0.5 });
    trig.push(0, 0);
    trig.push(0.6, 0.1);
    trig.push(0.95, 0.2);
    expect(trig.peakSinceTrigger).toBe(0.95);
    trig.setThreshold(0.9);
    expect(trig.rearmLevel).toBeCloseTo(0.54);
    trig.reset();
    expect(trig.armed).toBe(true);
    expect(trig.peakSinceTrigger).toBe(0);
  });
});
