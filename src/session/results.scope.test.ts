/**
 * THE SCOPE STATEMENT AND THE MEASUREMENT CONDITIONS HAVE TO TRAVEL WITH THE DATA.
 *
 * An exported record is read off the device — in a note, in an email, printed, months later, with
 * this app nowhere in sight. Whatever the screens say about what these numbers are is worth nothing
 * at that point unless the file says it too, so both halves are pinned here: the file states what
 * produced the figures, and it states per session how well the camera was tracking while it did.
 */
import { describe, expect, it } from 'vitest';
import { SCOPE_STATEMENT, buildPatientExport } from './results.ts';
import type { LaneResultSummary, Patient, SessionResult, TrackingQuality } from './types.ts';

const PATIENT: Patient = { id: 'p1', name: 'R.K.', createdAt: 1_700_000_000_000, lastUsedAt: 1_700_000_000_000 };

function lane(patch: Partial<LaneResultSummary> = {}): LaneResultSummary {
  return {
    lane: 0, movement: 'knee_extension', side: 'left', movementName: 'Left Knee extension',
    hits: 10, perfects: 4, goods: 6, misses: 5, judged: 15, accuracy: 0.67, reps: 18,
    timingBiasMs: 20, timingBiasMadMs: 12, romMean: 0.6, romBest: 0.8, romSamples: 18, romUncertain: 0,
    calibratedMin: 90, calibratedMax: 140, calibrationManual: false,
    compensationKind: null, compensationMonitored: false, compensationFlags: 0, compensationWorst: null,
    ...patch,
  };
}

const TRACKING: TrackingQuality = {
  samples: 120, fpsMedian: 11, fpsLow: 7, inferenceMsMedian: 70,
  trackedFraction: 0.72, lowFpsFraction: 0.9, delegate: 'CPU', worstReason: 'low_visibility',
};

function session(patch: Partial<SessionResult> = {}): SessionResult {
  return {
    id: 's1', patientId: 'p1', patientName: 'R.K.', startedAt: 1_700_000_000_000, endedAt: 1_700_000_100_000,
    durationSec: 100, mode: 'leg', difficulty: 'medium', windowScale: 1, inputMode: 'camera',
    songId: 'demo-groove', songTitle: 'Groove Circuit', artist: 'A', attribution: 'CC0',
    score: 1200, stars: 3, accuracy: 0.67, starAccuracy: 0.6, maxCombo: 8, totalNotes: 20,
    hits: 10, perfects: 4, goods: 6, misses: 5, reps: 18, answerRate: 0.9, surplusMovements: 3,
    laneRestSec: 1.2, timingBiasMs: 20, timingBiasMadMs: 12, latencyOffsetMs: 120, suggestedLatencyMs: null,
    completed: true, lanes: [lane()],
    ...patch,
  };
}

describe('the exported record states its own scope', () => {
  it('puts the scope statement in the readable text and in the JSON', () => {
    const out = buildPatientExport({ patient: PATIENT, sessions: [session()], now: () => 1_700_000_200_000 });
    expect(out.text).toContain(SCOPE_STATEMENT);
    const json = JSON.parse(out.json) as { scope: string; version: number };
    expect(json.scope).toBe(SCOPE_STATEMENT);
    expect(json.version).toBe(3);
  });

  it('says it even when the patient has no sessions at all', () => {
    const out = buildPatientExport({ patient: PATIENT, sessions: [], now: () => 1 });
    expect(out.text).toContain(SCOPE_STATEMENT);
    expect((JSON.parse(out.json) as { scope: string }).scope).toBe(SCOPE_STATEMENT);
  });
});

describe('the exported record states how well each session was measured', () => {
  it('states the conditions, the timing resolution and the caveat for a degraded session', () => {
    const out = buildPatientExport({ patient: PATIENT, sessions: [session({ tracking: TRACKING })], now: () => 2 });
    expect(out.text).toContain('11 fps');
    expect(out.text).toContain('72 %');
    expect(out.text).toContain('91 ms'); // one frame at 11 fps — the finest difference this can resolve
    expect(out.text).toContain('lower bounds');
    // and the machine-readable half carries the block itself
    const json = JSON.parse(out.json) as { sessions: SessionResult[]; fields: Record<string, string> };
    expect(json.sessions[0].tracking).toEqual(TRACKING);
    expect(json.fields.tracking).toContain('lower bound');
  });

  it('a camera session with no tracking block reads as NOT RECORDED, never as a clean stream', () => {
    const out = buildPatientExport({ patient: PATIENT, sessions: [session()], now: () => 2 });
    expect(out.text).toContain('Tracking: Tracking quality was not recorded');
    expect(out.text).not.toContain('fps');
  });

  it('says nothing about tracking for a run with no camera', () => {
    const out = buildPatientExport({
      patient: PATIENT,
      sessions: [session({ inputMode: 'keyboard' })],
      now: () => 2,
    });
    // "not recorded" against a keyboard run would imply a camera that failed; there was no camera.
    expect(out.text).not.toContain('Tracking:');
    expect(out.text).toContain("NOT THE PATIENT'S PERFORMANCE");
  });
});
