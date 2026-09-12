/**
 * "0 fps" BESIDE "5244 ms/frame" IS A CONTRADICTION ON THE SCREEN THAT EXISTS TO STATE FACTS.
 *
 * Both numbers were true — 0.19 fps rounds to 0 — but the camera check's whole job is to say what this
 * device can and cannot do, and a therapist reading "0 fps" reads "nothing is arriving" while the
 * preview beside it is visibly, slowly moving. The remedy for a stalled camera is not the remedy for
 * a slow one, so the two must not print the same.
 */
import { describe, expect, it } from 'vitest';
import { formatFps } from './CameraCheck.tsx';

describe('the frame rate is printed at the precision it deserves', () => {
  it('a device at 0.19 fps says so, instead of rounding itself to zero', () => {
    expect(formatFps(0.19)).toBe('0.19 fps');
    // The number the same device prints next to it, for reference: 1 / 5.244 s.
    expect(formatFps(1 / 5.244)).toBe('0.19 fps');
  });

  it('a slow but usable camera keeps one decimal, where the difference decides the gate', () => {
    expect(formatFps(5.6)).toBe('5.6 fps');
    expect(formatFps(9.94)).toBe('9.9 fps');
  });

  it('a healthy camera reads as it always did', () => {
    expect(formatFps(30)).toBe('30 fps');
    expect(formatFps(29.5)).toBe('30 fps');
    expect(formatFps(12.4)).toBe('12 fps');
  });

  it('no frames at all is a different statement from a slow frame rate', () => {
    expect(formatFps(0)).toBe('no frames');
    expect(formatFps(null)).toBe('– fps');
    expect(formatFps(undefined)).toBe('– fps');
    expect(formatFps(Number.NaN)).toBe('– fps');
  });
});
