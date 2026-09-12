/**
 * A RANGE WRITTEN BY AN OLDER BUILD MUST NOT TAKE THE SCREEN DOWN WITH IT.
 *
 * `RomCalibration`'s optional fields are optional because a stored range really can lack them: it
 * was written before the field existed, set by hand, or half-migrated. They are typed, but the value
 * comes off `localStorage`, so in practice every one of them is `unknown`.
 *
 * `calibrationWarnings` used to read them straight — `rest.durationSec.toFixed(1)` and
 * `POSTURE_INFO[cal.posture ?? info.posture].label` — which meant a legacy range with a rest block
 * that predates `durationSec`, or a posture this build no longer has, threw inside the render of the
 * screen that existed to WARN the therapist about that very range. The patient's own calibration is
 * what breaks the calibration screen: the failure mode is the one no fallback path can absorb.
 *
 * Nothing is invented to fill a gap here. A figure that is not there is left out of the sentence and
 * the warning is still given, because the warning is about the range, not about the figure.
 */
import { describe, expect, it } from 'vitest';
import { CALIBRATION_STALE_MS, calibrationProblem, calibrationWarnings, isCalibrationValid } from './calibration.ts';
import type { CalibrationRange } from './calibration.ts';

/** The smallest thing a stored range can be: two numbers and a sample count. */
const MINIMAL = { min: 90, max: 140, samples: 120 } as CalibrationRange;

/** A record from `localStorage`, with whatever an older build happened to put in it. */
const stored = (extra: Record<string, unknown>): CalibrationRange => ({ ...MINIMAL, ...extra }) as CalibrationRange;

describe('a legacy calibration is read, never dereferenced', () => {
  it('loads a minimal range — nothing but min, max and samples — with no warnings and no throw', () => {
    expect(() => calibrationWarnings(MINIMAL, 'knee_extension')).not.toThrow();
    expect(calibrationWarnings(MINIMAL, 'knee_extension')).toEqual([]);
    expect(isCalibrationValid(MINIMAL, 'knee_extension')).toBe(true);
    expect(calibrationProblem(MINIMAL, 'knee_extension')).toBeNull();
  });

  it('warns about an unsteady rest hold that never recorded how long it was', () => {
    const legacy = stored({ rest: { still: false, spread: 2.5 } });
    const out = calibrationWarnings(legacy, 'knee_extension');
    expect(out.join(' ')).toMatch(/never steady/i);
    // The spread it does have is stated; the duration it does not have is simply not claimed.
    expect(out.join(' ')).toContain('2.5°');
    expect(out.join(' ')).not.toMatch(/over .*s\)/);
    expect(out.join(' ')).not.toContain('undefined');
    expect(out.join(' ')).not.toContain('NaN');
  });

  it('warns about an unsteady rest hold that recorded nothing measurable at all', () => {
    const out = calibrationWarnings(stored({ rest: {} }), 'knee_extension');
    expect(out.join(' ')).toMatch(/never steady/i);
    expect(out.join(' ')).not.toContain('undefined');
  });

  it('ignores a drift it cannot read instead of comparing undefined with a threshold', () => {
    const out = calibrationWarnings(stored({ rest: { still: true, spread: 0.2 } }), 'knee_extension');
    expect(out).toEqual([]);
  });

  it('states a stale range’s age without a posture it cannot look up', () => {
    const now = Date.now();
    const legacy = stored({ capturedAt: now - 3 * CALIBRATION_STALE_MS, posture: 'lying_prone' });
    const out = calibrationWarnings(legacy, 'knee_extension', now);
    expect(out.join(' ')).toMatch(/was measured .* ago/i);
    // Falls back to the posture the MOVEMENT implies rather than indexing on a name this build
    // does not have — and never prints "undefined".
    expect(out.join(' ')).not.toContain('undefined');
    expect(out.join(' ')).toMatch(/\(.+\)/);
  });

  it('says nothing at all about a movement this build does not know', () => {
    expect(() => calibrationWarnings(MINIMAL, 'moon_walk' as never)).not.toThrow();
    expect(calibrationWarnings(MINIMAL, 'moon_walk' as never)).toEqual([]);
  });

  it('still reports a real, well-formed unsteady rest exactly as it did before', () => {
    const out = calibrationWarnings(
      stored({ rest: { still: false, spread: 2.5, drift: 0.1, durationSec: 10, samples: 300 } }),
      'knee_extension',
    );
    expect(out.join(' ')).toContain('2.5°');
    expect(out.join(' ')).toContain('over 10.0s');
  });
});
