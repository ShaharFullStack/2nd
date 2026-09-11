/**
 * The patient list: who this device keeps records for, and the migration that gave the records that
 * were already here an honest owner.
 *
 * WHY THIS IS ITS OWN MODULE. Everything about patient identity that is PURE — making an id, cleaning
 * a typed name, validating what came back out of localStorage, and deciding what happens to data
 * written before any of this existed — lives here so it can be tested without a store, and so the one
 * decision that must never be got wrong (what happens to pre-patient records) is written down in one
 * place instead of inside a zustand initializer.
 *
 * THE MIGRATION RULE, IN ONE SENTENCE: records that were written with no patient on them are filed
 * under a visible "unassigned" patient which is NOT selected, so the therapist has to say who the next
 * session is for, and the old records are never silently attributed to whoever opens the app next.
 */
import type { Patient, SessionResult } from '../session/types.ts';
import { DEVICE_TEST_PATIENT_ID, UNASSIGNED_PATIENT_ID } from '../session/types.ts';
import type { RomCalibration } from '../vision/calibration.ts';

/** Longest display name kept. A name is a label on a tablet, not a free-text field. */
export const MAX_PATIENT_NAME = 60;

export function newPatientId(now: number = Date.now()): string {
  const rand = Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
  return `p${now.toString(36)}-${rand}`;
}

/** Trim, collapse whitespace and bound the length. Returns '' for a name that is only whitespace. */
export function normalizePatientName(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, MAX_PATIENT_NAME);
}

export function makePatient(name: string, now: number = Date.now()): Patient {
  return { id: newPatientId(now), name: normalizePatientName(name) || 'Unnamed patient', createdAt: now, lastUsedAt: 0 };
}

/**
 * The record pre-patient sessions are migrated into.
 *
 * It is named for what it IS. "Unassigned records" is the truth about those sessions — the device kept
 * them without ever recording whose they were — and the name stays on screen (with its badge) until a
 * therapist renames it to the patient they belong to, or moves them onto an existing patient.
 */
export function unassignedPatient(now: number = Date.now()): Patient {
  return { id: UNASSIGNED_PATIENT_ID, name: 'Unassigned records', createdAt: now, lastUsedAt: now, unassigned: true };
}

/**
 * The built-in record that keyboard / autoplay runs are filed under.
 *
 * A dev-input run is the SYSTEM driving the lanes (see session/trends.ts); it is already excluded from
 * every trend and badged "not measured" in the history table. Filing it under a patient would put a
 * bot's score inside a person's clinical record, so it gets a record of its own that is obviously not
 * a person.
 *
 * ENFORCED, NOT ASSUMED: `store.addResult` re-files every non-camera run here regardless of who is
 * selected, and both entry points into a session (Home, TherapistSetup) refuse to run a CAMERA session
 * against this record. The rule used to hold only when no patient happened to be selected, which meant
 * an autoplay demo run with a patient on screen landed a bot's score, reps and session count inside
 * that person's history.
 */
export function deviceTestPatient(now: number = Date.now()): Patient {
  return { id: DEVICE_TEST_PATIENT_ID, name: 'Device test (not a patient)', createdAt: now, lastUsedAt: now, deviceTest: true };
}

function isPatient(v: unknown): v is Patient {
  const p = v as Partial<Patient> | null;
  return !!p && typeof p.id === 'string' && p.id.length > 0 && typeof p.name === 'string';
}

/** Repair a persisted patient list: drop malformed entries and de-duplicate ids. */
export function validatePatients(raw: unknown): Patient[] | null {
  if (!Array.isArray(raw)) return null;
  const seen = new Set<string>();
  const out: Patient[] = [];
  for (const v of raw) {
    if (!isPatient(v)) continue;
    if (seen.has(v.id)) continue;
    seen.add(v.id);
    out.push({
      id: v.id,
      name: normalizePatientName(v.name) || 'Unnamed patient',
      createdAt: Number.isFinite(v.createdAt) ? v.createdAt : 0,
      lastUsedAt: Number.isFinite(v.lastUsedAt) ? v.lastUsedAt : 0,
      ...(v.unassigned ? { unassigned: true as const } : {}),
      ...(v.deviceTest ? { deviceTest: true as const } : {}),
    });
  }
  return out;
}

/** Most recently used first, then most recently created — today's patient is at the top. */
export function sortPatients(list: readonly Patient[]): Patient[] {
  return list.slice().sort((a, b) => b.lastUsedAt - a.lastUsedAt || b.createdAt - a.createdAt || a.name.localeCompare(b.name));
}

/** Per-patient calibration stores: `{ [patientId]: { [movement:side[:tip]]: range } }`. */
export type CalibrationsByPatient = Record<string, Record<string, RomCalibration>>;

/** True for a value shaped like a stored range (the legacy, un-scoped calibration map's values). */
function looksLikeCalibration(v: unknown): boolean {
  const c = v as Partial<RomCalibration> | null;
  return !!c && typeof c === 'object' && Number.isFinite(c.min) && Number.isFinite(c.max);
}

/**
 * True when the persisted calibration blob is the OLD device-wide `{ key: range }` map rather than the
 * per-patient `{ patientId: { key: range } }` one. An empty object is treated as the new shape: there
 * is nothing to migrate either way.
 */
export function isLegacyCalibrationMap(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  return Object.values(raw as Record<string, unknown>).some(looksLikeCalibration);
}

/**
 * What a patient-less device has to become.
 *
 * Given the history and calibrations already on the device, return the patient list, the id every
 * orphan record belongs to, and whether anything actually had to move. Nothing here selects a patient:
 * `activePatientId` stays null so the next session cannot start until a human says whose it is.
 */
export interface Migration {
  patients: Patient[];
  history: SessionResult[];
  calibrations: CalibrationsByPatient;
  /** True when records had to be moved — the caller persists the new shape only then. */
  migrated: boolean;
}

export function migrateToPatients(
  history: readonly SessionResult[],
  rawCalibrations: unknown,
  existing: readonly Patient[],
  now: number = Date.now(),
): Migration {
  const patients = existing.slice();
  const legacy = isLegacyCalibrationMap(rawCalibrations);
  const orphanSessions = history.filter((s) => typeof s.patientId !== 'string' || s.patientId.length === 0);
  const needsUnassigned = orphanSessions.length > 0 || legacy;

  if (needsUnassigned && !patients.some((p) => p.id === UNASSIGNED_PATIENT_ID)) {
    patients.push(unassignedPatient(now));
  }

  const migratedHistory = history.map((s) =>
    typeof s.patientId === 'string' && s.patientId.length > 0
      ? s
      : { ...s, patientId: UNASSIGNED_PATIENT_ID, patientName: s.patientName || 'Unassigned records' },
  );

  let calibrations: CalibrationsByPatient = {};
  if (legacy) {
    // The whole old map belongs to "whoever used this tablet": one bucket, under the unassigned
    // record. Splitting it across patients would be inventing information we do not have.
    calibrations = { [UNASSIGNED_PATIENT_ID]: rawCalibrations as Record<string, RomCalibration> };
  } else if (rawCalibrations && typeof rawCalibrations === 'object' && !Array.isArray(rawCalibrations)) {
    for (const [pid, map] of Object.entries(rawCalibrations as Record<string, unknown>)) {
      if (!map || typeof map !== 'object' || Array.isArray(map)) continue;
      const inner: Record<string, RomCalibration> = {};
      for (const [k, v] of Object.entries(map as Record<string, unknown>)) {
        if (looksLikeCalibration(v)) inner[k] = v as RomCalibration;
      }
      calibrations[pid] = inner;
    }
  }

  return { patients, history: migratedHistory, calibrations, migrated: needsUnassigned };
}

/* ────────────────────────────────────────────────────────────────────────────────────────────────
 * TELLING TWO PATIENTS APART.
 *
 * This app stores the minimum identity it can: a display name and nothing else (see `Patient`). That
 * is the right privacy call and it has one consequence that has to be paid for here — on a shared
 * tablet, in a clinic whose own rules push toward initials, TWO PATIENTS WILL HAVE THE SAME NAME.
 * "J. Smith" and "J. Smith" rendered as two identical rows turns the one screen whose entire job is
 * "getting this wrong must be hard" into a coin flip, and a mis-filed session pools a ROM trend and
 * hands the wrong body's calibrated range back.
 *
 * The disambiguator cannot come from a new identifier (that is the privacy trade this app has already
 * made). It comes from metadata the device ALREADY holds and simply never showed: when this patient
 * was last seen, when the record was created, and — as the guaranteed-unique last resort — the tail of
 * the local id. `labelPatients` is the single place that decides, so the picker row, the confirmation
 * banner and the reassign-target button can never disagree about which J. Smith is which.
 * ──────────────────────────────────────────────────────────────────────────────────────────────── */

/** What the app knows about a patient's use of the device, for labelling. */
export interface PatientUsage {
  /** Sessions currently stored for them. */
  sessions: number;
  /** Start time of their most recent stored session, or 0 when there is none. */
  lastSessionAt: number;
}

export interface PatientLabel {
  id: string;
  name: string;
  /**
   * The parenthetical that separates this patient from every OTHER patient sharing their name, or ''
   * when the name is already unique on this device. Guaranteed distinct within a same-named group.
   */
  tag: string;
  /** `name` plus `tag` — what any control that names a patient must render. Never ambiguous. */
  display: string;
  /** The always-shown second line: sessions stored, and when they were last seen. */
  detail: string;
  /** True when at least one other patient on this device carries the same name. */
  ambiguous: boolean;
}

/** Case- and whitespace-insensitive name identity. Two patients "collide" when this matches. */
export function nameKey(name: string): string {
  return normalizePatientName(name).toLocaleLowerCase();
}

/** Every OTHER patient already carrying this name. Empty when the name is free. */
export function findNameMatches(list: readonly Patient[], name: string, excludeId?: string): Patient[] {
  const key = nameKey(name);
  if (!key) return [];
  return list.filter((p) => p.id !== excludeId && nameKey(p.name) === key);
}

/** A short, stable, non-identifying tail of the local id — the tiebreaker that can never collide. */
export function shortId(id: string): string {
  const tail = id.replace(/[^a-z0-9]/gi, '');
  return tail.slice(-4).toLowerCase() || id;
}

function formatDay(ts: number): string {
  try {
    return new Date(ts).toLocaleDateString(undefined, { dateStyle: 'medium' });
  } catch {
    return new Date(ts).toISOString().slice(0, 10);
  }
}

function usageOf(usage: Record<string, PatientUsage> | undefined, id: string): PatientUsage {
  return usage?.[id] ?? { sessions: 0, lastSessionAt: 0 };
}

/** "4 sessions · last seen Aug 14, 2026" — the line every patient row shows, ambiguous or not. */
function detailFor(p: Patient, u: PatientUsage): string {
  const count = u.sessions === 1 ? '1 session' : `${u.sessions} sessions`;
  const seen = u.lastSessionAt > 0
    ? `last session ${formatDay(u.lastSessionAt)}`
    : p.lastUsedAt > 0
      ? `selected ${formatDay(p.lastUsedAt)}, no session recorded`
      : 'no sessions yet';
  const added = p.createdAt > 0 ? ` · added ${formatDay(p.createdAt)}` : '';
  if (p.deviceTest) return `${count} · not a person: keyboard and autoplay runs are filed here`;
  if (p.unassigned) return `${count} · ${seen} · recorded before this device tracked patients`;
  return `${count} · ${seen}${added}`;
}

/**
 * Label every patient so that no two controls on any screen can read identically.
 *
 * For each patient sharing a name with another, the first candidate that is UNIQUE FOR THEM within
 * that group wins: last session date, then the date the record was added, then the id tail (which
 * always is). Per-patient rather than per-group so the common case — two people last seen on
 * different days — reads like something a therapist actually knows ("the one I saw on Tuesday")
 * instead of a hex suffix, while a pathological group still cannot produce two identical rows.
 */
export function labelPatients(
  patients: readonly Patient[],
  usage?: Record<string, PatientUsage>,
): PatientLabel[] {
  const groups = new Map<string, Patient[]>();
  for (const p of patients) {
    const key = nameKey(p.name);
    const g = groups.get(key);
    if (g) g.push(p);
    else groups.set(key, [p]);
  }

  return patients.map((p) => {
    const u = usageOf(usage, p.id);
    const group = groups.get(nameKey(p.name)) ?? [p];
    const ambiguous = group.length > 1;
    let tag = '';
    if (ambiguous) {
      const others = group.filter((o) => o.id !== p.id);
      const candidates: string[] = [];
      const mine = usageOf(usage, p.id);
      const lastSeen = mine.lastSessionAt;
      if (others.every((o) => usageOf(usage, o.id).lastSessionAt !== lastSeen)) {
        candidates.push(lastSeen > 0 ? `last session ${formatDay(lastSeen)}` : 'no sessions yet');
      }
      if (p.createdAt > 0 && others.every((o) => o.createdAt !== p.createdAt)) {
        candidates.push(`added ${formatDay(p.createdAt)}`);
      }
      candidates.push(`id ${shortId(p.id)}`);
      tag = candidates[0];
    }
    return {
      id: p.id,
      name: p.name,
      tag,
      display: tag ? `${p.name} (${tag})` : p.name,
      detail: detailFor(p, u),
      ambiguous,
    };
  });
}

/** `labelPatients` as a lookup, for screens that render one patient at a time (the banner). */
export function labelIndex(patients: readonly Patient[], usage?: Record<string, PatientUsage>): Record<string, PatientLabel> {
  const out: Record<string, PatientLabel> = {};
  for (const l of labelPatients(patients, usage)) out[l.id] = l;
  return out;
}

/** Sessions-stored / last-session-date per patient, derived from the device-wide history. */
export function patientUsage(history: readonly SessionResult[]): Record<string, PatientUsage> {
  const out: Record<string, PatientUsage> = {};
  for (const r of history) {
    const u = out[r.patientId] ?? (out[r.patientId] = { sessions: 0, lastSessionAt: 0 });
    u.sessions++;
    if (r.startedAt > u.lastSessionAt) u.lastSessionAt = r.startedAt;
  }
  return out;
}
