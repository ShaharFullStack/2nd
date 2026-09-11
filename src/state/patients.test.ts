/**
 * THE MIGRATION IS THE DANGEROUS PART, so it is the part with the most tests here.
 *
 * Every device that already has sessions on it is about to gain patient identity. The one outcome that
 * must be impossible is somebody else's stored sessions and stored ranges silently becoming the record
 * of whoever opens the app next — which is exactly what "assign the existing data to the current
 * patient" would do, and exactly what a therapist would never be able to detect afterwards.
 */
import { describe, expect, it } from 'vitest';
import { UNASSIGNED_PATIENT_ID } from '../session/types.ts';
import type { SessionResult } from '../session/types.ts';
import {
  isLegacyCalibrationMap,
  makePatient,
  migrateToPatients,
  normalizePatientName,
  sortPatients,
  validatePatients,
} from './patients.ts';

function session(id: string, patch: Partial<SessionResult> = {}): SessionResult {
  return {
    id,
    patientId: 'p1',
    patientName: 'P One',
    startedAt: 1,
    endedAt: 2,
    durationSec: 10,
    mode: 'leg',
    difficulty: 'medium',
    windowScale: 1,
    inputMode: 'camera',
    songId: 's',
    songTitle: 'S',
    artist: '',
    attribution: '',
    score: 1,
    stars: 1,
    accuracy: 1,
    starAccuracy: 1,
    maxCombo: 1,
    totalNotes: 1,
    hits: 1,
    perfects: 1,
    goods: 0,
    misses: 0,
    reps: 1,
    answerRate: 1,
    timingBiasMs: null,
    timingBiasMadMs: null,
    latencyOffsetMs: 0,
    suggestedLatencyMs: null,
    completed: true,
    lanes: [],
    ...patch,
  };
}

const LEGACY_RANGE = { min: 0.1, max: 0.6, samples: 60, movement: 'seated_march' as const };

describe('a patient name', () => {
  it('is trimmed and collapsed, because it is typed on a tablet keyboard', () => {
    expect(normalizePatientName('  Jane   Okafor \n')).toBe('Jane Okafor');
  });

  it('is bounded, so one paste cannot fill the picker', () => {
    expect(normalizePatientName('x'.repeat(200))).toHaveLength(60);
  });

  it('never becomes an unnamed record by accident', () => {
    expect(makePatient('   ').name).toBe('Unnamed patient');
  });
});

describe('the stored patient list', () => {
  it('drops malformed entries and duplicate ids rather than failing the boot', () => {
    const list = validatePatients([
      { id: 'a', name: 'A', createdAt: 1, lastUsedAt: 2 },
      { id: 'a', name: 'A again', createdAt: 1, lastUsedAt: 2 },
      { name: 'no id' },
      null,
      'nonsense',
    ]);
    expect(list?.map((p) => p.id)).toEqual(['a']);
  });

  it('puts the most recently used patient first — the one the therapist is with', () => {
    const order = sortPatients([
      { id: 'old', name: 'Old', createdAt: 1, lastUsedAt: 10 },
      { id: 'new', name: 'New', createdAt: 2, lastUsedAt: 99 },
    ]);
    expect(order.map((p) => p.id)).toEqual(['new', 'old']);
  });
});

describe('migrating a device that already has records on it', () => {
  it('files pre-patient sessions under a visible "unassigned" record, never under a real patient', () => {
    const legacySession = { ...session('s1'), patientId: undefined } as unknown as SessionResult;
    const m = migrateToPatients([legacySession], { 'seated_march:left': LEGACY_RANGE }, []);

    expect(m.migrated).toBe(true);
    expect(m.patients).toHaveLength(1);
    expect(m.patients[0].id).toBe(UNASSIGNED_PATIENT_ID);
    expect(m.patients[0].unassigned).toBe(true);
    expect(m.history[0].patientId).toBe(UNASSIGNED_PATIENT_ID);
  });

  it('moves the old device-wide calibration map into that record, whole', () => {
    const m = migrateToPatients([], { 'seated_march:left': LEGACY_RANGE }, []);
    expect(m.calibrations[UNASSIGNED_PATIENT_ID]['seated_march:left'].max).toBe(0.6);
    // And nowhere else: a range measured on an unknown body is not offered to a named patient.
    expect(Object.keys(m.calibrations)).toEqual([UNASSIGNED_PATIENT_ID]);
  });

  it('does not touch records that already name a patient', () => {
    const m = migrateToPatients([session('s1', { patientId: 'p9' })], { p9: { 'seated_march:left': LEGACY_RANGE } }, [
      { id: 'p9', name: 'Nine', createdAt: 1, lastUsedAt: 1 },
    ]);
    expect(m.migrated).toBe(false);
    expect(m.history[0].patientId).toBe('p9');
    expect(m.patients.map((p) => p.id)).toEqual(['p9']);
    expect(m.calibrations.p9['seated_march:left'].max).toBe(0.6);
  });

  it('creates nothing on a brand-new device — an empty tablet has no unassigned record to explain', () => {
    const m = migrateToPatients([], {}, []);
    expect(m.migrated).toBe(false);
    expect(m.patients).toEqual([]);
    expect(m.calibrations).toEqual({});
  });

  it('tells the old flat calibration map apart from the per-patient one', () => {
    expect(isLegacyCalibrationMap({ 'seated_march:left': LEGACY_RANGE })).toBe(true);
    expect(isLegacyCalibrationMap({ p1: { 'seated_march:left': LEGACY_RANGE } })).toBe(false);
    expect(isLegacyCalibrationMap({})).toBe(false);
  });
});
