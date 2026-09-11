import { describe, expect, it } from 'vitest';
import { windowsFor } from '../engine/difficulty.ts';
import { clampLatencyMs, latencyAdvice, narrowestGoodWindowMs } from './latencyAdvice.ts';
import type { LaneResultSummary, SessionResult } from './types.ts';

function lane(movement: LaneResultSummary['movement']): LaneResultSummary {
  return {
    lane: 0, movement, side: 'left', movementName: 'Left Seated march',
    hits: 1, perfects: 1, goods: 0, misses: 0, judged: 1, accuracy: 1, reps: 1,
    timingBiasMs: null, timingBiasMadMs: null, romMean: null, romBest: null, romSamples: 0, romUncertain: 0,
    calibratedMin: null, calibratedMax: null, calibrationManual: false,
    compensationKind: null, compensationMonitored: false, compensationFlags: 0, compensationWorst: null,
  };
}

type Result = Pick<SessionResult, 'suggestedLatencyMs' | 'latencyOffsetMs' | 'difficulty' | 'windowScale' | 'lanes' | 'inputMode'>;

function result(patch: Partial<Result> = {}): Result {
  return {
    suggestedLatencyMs: 200,
    latencyOffsetMs: 120,
    difficulty: 'medium',
    windowScale: 1,
    inputMode: 'camera',
    lanes: [lane('seated_march')],
    ...patch,
  };
}

describe('latencyAdvice guards the CAMERA offset', () => {
  it('marks a keyboard or autoplay run as not applicable, and never significant', () => {
    for (const inputMode of ['keyboard', 'autoplay'] as const) {
      // A huge disagreement on a keyboard run is a human's reaction time, not the camera's latency.
      const a = latencyAdvice(result({ inputMode, suggestedLatencyMs: 800 }))!;
      expect(a.appliesToCamera).toBe(false);
      expect(a.significant).toBe(false);
      expect(a.inputMode).toBe(inputMode);
    }
  });

  it('reports what the store will really keep, not the raw suggestion', () => {
    const low = latencyAdvice(result({ suggestedLatencyMs: -2 }))!;
    expect(low.suggestedMs).toBe(-2);
    expect(low.applicableMs).toBe(0);
    expect(low.clamped).toBe(true);

    const high = latencyAdvice(result({ suggestedLatencyMs: 4000 }))!;
    expect(high.applicableMs).toBe(1000);
    expect(high.clamped).toBe(true);

    const ok = latencyAdvice(result({ suggestedLatencyMs: 320 }))!;
    expect(ok.applicableMs).toBe(320);
    expect(ok.clamped).toBe(false);
  });
});

describe('latencyAdvice', () => {
  it('is null when the run produced no confident suggestion', () => {
    expect(latencyAdvice(result({ suggestedLatencyMs: null }))).toBeNull();
  });

  it('reports the before, the after and the difference', () => {
    const a = latencyAdvice(result())!;
    expect(a.currentMs).toBe(120);
    expect(a.suggestedMs).toBe(200);
    expect(a.deltaMs).toBe(80);
  });

  it('is significant only when the disagreement exceeds one good window', () => {
    // medium gross-motor good window is 140 ms.
    expect(narrowestGoodWindowMs(result())).toBe(140);
    expect(latencyAdvice(result({ suggestedLatencyMs: 259 }))!.significant).toBe(false); // 139 ms
    expect(latencyAdvice(result({ suggestedLatencyMs: 260 }))!.significant).toBe(false); // exactly 140
    expect(latencyAdvice(result({ suggestedLatencyMs: 261 }))!.significant).toBe(true);  // 141
  });

  it('works in both directions', () => {
    const a = latencyAdvice(result({ suggestedLatencyMs: 0, latencyOffsetMs: 200 }))!;
    expect(a.deltaMs).toBe(-200);
    expect(a.significant).toBe(true);
  });

  it('uses the NARROWEST lane window — a fine-motor lane must not hide a gross-motor one', () => {
    const mixed = result({ lanes: [lane('finger_opposition'), lane('knee_extension')] });
    const fine = windowsFor('finger_opposition', 'medium').goodMs; // 140 * 1.6 = 224
    const gross = windowsFor('knee_extension', 'medium').goodMs; // 140
    expect(fine).toBeGreaterThan(gross);
    expect(narrowestGoodWindowMs(mixed)).toBe(gross);
    // 150 ms of bias is inside the fine-motor window but outside the gross-motor one: act on it.
    expect(latencyAdvice({ ...mixed, latencyOffsetMs: 0, suggestedLatencyMs: 150 })!.significant).toBe(true);
  });

  it('follows the therapist window scale — wider windows tolerate more bias', () => {
    const wide = result({ windowScale: 2, suggestedLatencyMs: 350 }); // 230 ms of bias
    expect(narrowestGoodWindowMs(wide)).toBe(280);
    expect(latencyAdvice(wide)!.significant).toBe(false);
    expect(latencyAdvice({ ...wide, windowScale: 1 })!.significant).toBe(true);
  });

  it('falls back to the difficulty window when the record carries no lanes', () => {
    expect(narrowestGoodWindowMs(result({ lanes: [] }))).toBe(140);
    expect(latencyAdvice(result({ lanes: [] }))).not.toBeNull();
  });
});

describe('clampLatencyMs', () => {
  it('is the single source of the 0..1000 ms bound the store applies', () => {
    expect(clampLatencyMs(-2)).toBe(0);
    expect(clampLatencyMs(0)).toBe(0);
    expect(clampLatencyMs(123.4)).toBe(123);
    expect(clampLatencyMs(1000)).toBe(1000);
    expect(clampLatencyMs(5000)).toBe(1000);
    expect(clampLatencyMs(Number.NaN)).toBe(0);
  });
});
