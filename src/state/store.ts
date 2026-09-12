/**
 * The app store: everything the screens share that is plain data.
 *
 * Live handles (AudioContext, StemMixer, VisionInput, the game loop) deliberately do NOT live here —
 * they are in src/session/runtime.ts. React never re-renders per frame in this app, and a store that
 * held a mixer would tempt exactly that.
 */
import { create } from 'zustand';
import { DEFAULT_LANE_REST_SEC, clampLaneRestSec } from '../charts/generate.ts';
import { DIFFICULTIES, clampWindowScale } from '../engine/difficulty.ts';
import type { DifficultyName, Fingertip, LaneSpec, Mode, Movement, Side } from '../engine/types.ts';
import { FINGERTIPS, HAND_MOVEMENTS, LEG_MOVEMENTS } from '../engine/types.ts';
import type { RomCalibration } from '../vision/calibration.ts';
import { POSTURE_INFO } from '../vision/features.ts';
import { LATENCY_MAX_MS, LATENCY_MIN_MS, clampLatencyMs } from '../session/latencyAdvice.ts';
import { clinicalLaneName } from '../session/results.ts';
import type { InputMode, Patient, SessionConfig, SessionResult } from '../session/types.ts';
import { DEVICE_TEST_PATIENT_ID, UNASSIGNED_PATIENT_ID } from '../session/types.ts';
import type { CalibrationsByPatient } from './patients.ts';
import { deviceTestPatient, makePatient, migrateToPatients, normalizePatientName, unassignedPatient, validatePatients } from './patients.ts';
import { createListSync, createMapSync, onExternalChange, readJson, storageKey, writeJson } from './persist.ts';

export type Screen =
  | 'home'
  | 'patients'
  | 'mode'
  | 'setup'
  | 'camera'
  | 'rom'
  | 'latency'
  | 'play'
  | 'results'
  | 'history';

export interface Settings {
  /** Hit / miss sound cues on top of the music. */
  sfx: boolean;
  /** Rehab-friendly high-contrast lane colors instead of the Guitar Hero palette. */
  highContrast: boolean;
  /**
   * Seconds a note takes to travel the highway (lower = faster scroll). This is the renderer's
   * read-ahead window: at medium (one note per beat) a 120 BPM chart puts `scrollSec × 2` gems on
   * the board at once, so it is also the number that decides whether the highway looks occupied or
   * abandoned. Keep it in step with `DEFAULT_GEOMETRY_OPTIONS.approachSec` in src/render/geometry.ts.
   */
  scrollSec: number;
  /** Freeze parallax/shake for vestibular sensitivity. */
  reducedMotion: boolean;
  /** Decorative effect intensity 0..1 (judgment feedback is never removed). */
  effectIntensity: number;
  /** Show a MISS popup (off by default for the rehab audience). */
  showMissPopup: boolean;
  /** Frames are horizontally flipped before detection (changes which limb a lane reads). */
  mirrored: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  sfx: true,
  highContrast: false,
  // 4 s = DEFAULT_GEOMETRY_OPTIONS.approachSec (src/render/geometry.ts). At 1.6 s this default
  // silently overrode the renderer's whole composition: three gems on a board built for eight.
  scrollSec: 4,
  reducedMotion: false,
  effectIntensity: 1,
  showMissPopup: false,
  mirrored: false,
};

export const MIN_LANES = 2;
export const MAX_LANES = 4;
export const DEFAULT_SONG_ID = 'demo-groove';

const HISTORY_KEY = 'history';
const SETTINGS_KEY = 'settings';
const LATENCY_KEY = 'latency';
/**
 * Provenance for the offset in LATENCY_KEY, in its own key so the number itself keeps the bare-number
 * shape every earlier build wrote (and every earlier build can still read).
 *
 * Split out rather than folded in because the two answer different questions and only one of them is
 * safe to lose: the OFFSET decides how a session is judged, the PROVENANCE only decides what the
 * latency screen says about it. A tablet whose meta blob is corrupt still judges the next session at
 * the value the therapist applied.
 */
const LATENCY_META_KEY = 'latencyMeta';
const CONFIG_KEY = 'lastConfig';
const CALIBRATION_KEY = 'calibrations';
/** The patient list. Its ABSENCE is what tells the loader this device predates patient identity. */
const PATIENTS_KEY = 'patients';
/**
 * The patient the next session will be recorded against, or absent when nobody has been chosen.
 *
 * PER TAB, NOT PER DEVICE. This used to be one localStorage slot, rewritten on every select, add,
 * rename and delete — so a therapist who opened a second tab to look something up, and picked a
 * patient there to read their history, moved the slot the FIRST tab would record against on its next
 * reload. The patient list is shared (it is a record); who is in the chair is not — it is this tab's
 * session.
 *
 * So the selection lives in `sessionStorage`, which is scoped to the tab and survives its reloads.
 * The localStorage slot of the same name is kept as a HINT ONLY: the last patient chosen anywhere on
 * this device, used to seed a tab that has never chosen one (and by the seeded fixtures the critics
 * write). A tab that starts on the hint says so (`activePatientNotice`) rather than presenting
 * another tab's choice as its own.
 */
const ACTIVE_PATIENT_KEY = 'activePatient';

/**
 * The per-tab half of `ACTIVE_PATIENT_KEY`. Wrapped like every other storage access: a tablet in
 * private mode or with site data blocked throws on `sessionStorage` itself, and losing the selection
 * must never be a reason to lose the session in progress.
 */
function tabStorage(): Storage | null {
  try {
    if (typeof sessionStorage === 'undefined') return null;
    return sessionStorage;
  } catch {
    return null;
  }
}

function readTabActivePatient(): string | null {
  const s = tabStorage();
  if (!s) return null;
  try {
    const raw = s.getItem(storageKey(ACTIVE_PATIENT_KEY));
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'string' && parsed.length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Record the selection: this TAB's slot (authoritative for this tab) and the device hint (the seed a
 * brand-new tab may start from). Returns false when neither could be written, which is what raises
 * `persistenceFailed`.
 */
function writeActivePatient(id: string | null): boolean {
  const s = tabStorage();
  let tabOk = false;
  try {
    if (s) {
      if (id === null) s.removeItem(storageKey(ACTIVE_PATIENT_KEY));
      else s.setItem(storageKey(ACTIVE_PATIENT_KEY), JSON.stringify(id));
      tabOk = true;
    }
  } catch {
    tabOk = false;
  }
  const deviceOk = writeJson(ACTIVE_PATIENT_KEY, id);
  return tabOk || deviceOk;
}
/**
 * How many sessions the retention limit has already deleted, per patient.
 *
 * Kept because the deletion itself is invisible: a therapist who sees 100 sessions cannot tell whether
 * that is all of them. This is what lets the History screen say "and 7 older ones have been deleted"
 * instead of quietly presenting a truncated record as the whole record.
 */
const HISTORY_DROPPED_KEY = 'historyDropped';

/**
 * Input latency used when NOTHING has ever been measured or applied on this device (seconds).
 *
 * It is a last resort, not a floor. The latency screen offers it only when `latencySetAt` is null;
 * once any value is in force — a measurement, or an offset the therapist applied on the Results
 * screen for exactly this session — skipping the screen keeps that value. A "skip" that wrote 120 ms
 * over an applied 280 ms destroyed the one control the Results screen has, on the single screen every
 * next session passes through.
 */
export const DEFAULT_LATENCY_SEC = 0.12;

/** Provenance of the offset in force: was it measured, what wrote it, and when. */
export interface LatencyMeta {
  measured: boolean;
  note: string;
  /** Epoch ms of the write. 0 when it was restored from a build that did not record one. */
  at: number;
}

function validateLatencyMeta(raw: unknown): LatencyMeta | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<LatencyMeta>;
  return {
    measured: r.measured === true,
    note: typeof r.note === 'string' ? r.note : '',
    at: Number.isFinite(r.at) ? (r.at as number) : 0,
  };
}

export function defaultLanes(mode: Mode): LaneSpec[] {
  const m: Movement = mode === 'leg' ? 'seated_march' : 'hand_open_close';
  return [
    { index: 0, movement: m, side: 'left' },
    { index: 1, movement: m, side: 'right' },
  ];
}

export function movementsFor(mode: Mode): Movement[] {
  return mode === 'leg' ? [...LEG_MOVEMENTS] : [...HAND_MOVEMENTS];
}

/** Renumber `index` to the array position — every lane-indexed API in the app relies on it. */
export function normalizeLanes(lanes: LaneSpec[]): LaneSpec[] {
  return lanes.map((l, i) => normalizeLaneFingertip(l.index === i ? l : { ...l, index: i }));
}

/** The fingertip a finger_opposition lane opposes when the therapist has not chosen one. */
export const DEFAULT_LANE_FINGERTIP: Fingertip = 'index';

/**
 * The fingertip lane `spec` is actually measured on: the therapist's choice for finger_opposition,
 * and undefined for every other movement (which has no fingertip dimension at all).
 */
export function laneFingertip(spec: Pick<LaneSpec, 'movement' | 'fingertip'>): Fingertip | undefined {
  if (spec.movement !== 'finger_opposition') return undefined;
  return spec.fingertip && FINGERTIPS.includes(spec.fingertip) ? spec.fingertip : DEFAULT_LANE_FINGERTIP;
}

/**
 * Drop a fingertip a movement cannot carry, and give finger_opposition the default when it has none.
 * Applied on every write so a lane switched away from finger_opposition and back does not resurrect
 * the old tip, and so the calibration key of a lane never depends on a stale field.
 */
export function normalizeLaneFingertip(spec: LaneSpec): LaneSpec {
  const tip = laneFingertip(spec);
  if (tip === spec.fingertip) return spec;
  if (tip === undefined) {
    const { fingertip: _drop, ...rest } = spec;
    return rest;
  }
  return { ...spec, fingertip: tip };
}

/**
 * Calibrations are keyed by movement+side (+fingertip, for finger_opposition) so a second session on
 * the same lane can reuse them.
 *
 * The fingertip is part of the key because it selects WHICH QUANTITY was measured: the feature is
 * `1 - tip-to-thumb distance / palm size` for that one tip, and a hand that pinches its index to the
 * thumb reaches ~1.0 while the same hand's pinky peaks well below the index range's max. Keying them
 * together would hand a pinky lane the index range and produce a lane that cannot score all song.
 */
export function calibrationKey(spec: Pick<LaneSpec, 'movement' | 'side' | 'fingertip'>): string {
  const tip = laneFingertip(spec);
  return tip ? `${spec.movement}:${spec.side}:${tip}` : `${spec.movement}:${spec.side}`;
}

function isLaneSpec(v: unknown): v is LaneSpec {
  const l = v as LaneSpec | null;
  if (!(!!l && typeof l.index === 'number' && typeof l.movement === 'string' && (l.side === 'left' || l.side === 'right'))) return false;
  return l.fingertip === undefined || FINGERTIPS.includes(l.fingertip);
}

function validateSettings(raw: unknown): Settings | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<Settings>;
  return {
    sfx: typeof r.sfx === 'boolean' ? r.sfx : DEFAULT_SETTINGS.sfx,
    highContrast: typeof r.highContrast === 'boolean' ? r.highContrast : DEFAULT_SETTINGS.highContrast,
    scrollSec: Number.isFinite(r.scrollSec) ? Math.min(6, Math.max(2, r.scrollSec as number)) : DEFAULT_SETTINGS.scrollSec,
    reducedMotion: typeof r.reducedMotion === 'boolean' ? r.reducedMotion : DEFAULT_SETTINGS.reducedMotion,
    effectIntensity: Number.isFinite(r.effectIntensity) ? Math.min(1, Math.max(0, r.effectIntensity as number)) : DEFAULT_SETTINGS.effectIntensity,
    showMissPopup: typeof r.showMissPopup === 'boolean' ? r.showMissPopup : DEFAULT_SETTINGS.showMissPopup,
    mirrored: typeof r.mirrored === 'boolean' ? r.mirrored : DEFAULT_SETTINGS.mirrored,
  };
}

/**
 * Reload the stored sessions, repairing the two fields a record written by an older build lacks.
 *
 * `movementName` used to be `label`, the renderer's 46-pixel canvas abbreviation ("L knee ext"). The
 * full clinical name is REBUILT here from the structured fields that were always stored (movement,
 * side, fingertip) rather than parsed back out of the abbreviation — so an old record gains the right
 * name, not a guess at one. `patientId` is left alone here; the patient migration owns it.
 */
function validateHistory(raw: unknown): SessionResult[] | null {
  if (!Array.isArray(raw)) return null;
  const ok = raw.filter((r) => {
    const v = r as Partial<SessionResult> | null;
    return !!v && typeof v.id === 'string' && typeof v.score === 'number' && Array.isArray(v.lanes);
  }) as SessionResult[];
  return ok.map((r) => ({
    ...r,
    patientName: typeof r.patientName === 'string' ? r.patientName : '',
    lanes: r.lanes.map((l) =>
      typeof l.movementName === 'string' && l.movementName.length > 0
        ? l
        : { ...l, movementName: clinicalLaneName({ movement: l.movement, side: l.side, fingertip: l.fingertip }) },
    ),
  }));
}

function validateConfig(raw: unknown): Partial<SessionConfig> | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<SessionConfig>;
  const lanes = Array.isArray(r.lanes) ? r.lanes.filter(isLaneSpec) : [];
  return {
    mode: r.mode === 'hand' ? 'hand' : 'leg',
    lanes: lanes.length >= MIN_LANES ? normalizeLanes(lanes.slice(0, MAX_LANES)) : undefined,
    difficulty: r.difficulty === 'easy' || r.difficulty === 'hard' ? r.difficulty : 'medium',
    windowScale: Number.isFinite(r.windowScale) ? clampWindowScale(r.windowScale as number) : 1,
    laneRestSec: Number.isFinite(r.laneRestSec) ? clampLaneRestSec(r.laneRestSec as number) : DEFAULT_LANE_REST_SEC,
    songId: typeof r.songId === 'string' ? r.songId : DEFAULT_SONG_ID,
  };
}

/**
 * Reload saved ranges, dropping any whose STAMP disagrees with the KEY it is filed under.
 *
 * A calibration is a range OF SOMETHING and the key (`movement:side[:fingertip]`) is this file's claim
 * about what that something is. Checking only that min/max are finite let a blob that says
 * `movement: 'knee_extension'` be served to a `seated_march` lane — degrees normalizing a frame-height
 * ratio. VisionInput would refuse it at the boundary (which is the right architecture: the runtime is
 * the authority), but a range that is provably mis-filed should never be offered to the therapist as
 * "last session's range" in the first place. Reachable from a migrated or hand-edited localStorage,
 * and from any future change to the key format — the entries written under the old shape are still
 * there. The mirror convention is NOT in the key (it is session-wide, not per-lane), so it stays a
 * boundary check against the lane's live context, not a filing check.
 */
function validateCalibrationMap(raw: unknown): Record<string, RomCalibration> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, RomCalibration> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const c = v as Partial<RomCalibration> | null;
    if (!c || !Number.isFinite(c.min) || !Number.isFinite(c.max)) continue;
    const [movement, , tip] = k.split(':');
    if (c.movement !== undefined && c.movement !== movement) {
      console.warn(`[store] dropping saved calibration "${k}": it is stamped ${c.movement}, which is not what that key measures. Re-calibrate that lane.`);
      continue;
    }
    if (c.fingertip !== undefined && tip !== undefined && c.fingertip !== tip) {
      console.warn(`[store] dropping saved calibration "${k}": it was measured on the ${c.fingertip} finger, not the ${tip} finger. Re-calibrate that lane.`);
      continue;
    }
    // EVERY OPTIONAL SUB-FIELD OF A STORED RANGE IS UNTRUSTED. This map comes off `localStorage` —
    // written by an older build, hand-edited, or half-migrated — and it used to be cast to
    // `RomCalibration` whole on the strength of two finite numbers. A `rest` block missing
    // `durationSec`, or a `posture` naming a posture this build does not have, then reached the
    // screens that read them and threw on the dereference. A field that cannot be trusted is simply
    // not carried: absent is a state every reader already handles.
    out[k] = sanitizeCalibration(c);
  }
  return out;
}

/**
 * Drop the optional sub-fields of a stored range that are not the shape this build expects.
 *
 * `min`/`max` are checked by the caller; everything else here is optional by design (a legacy or
 * hand-built calibration simply lacks it), so a malformed one is dropped rather than repaired — a
 * guessed rest duration or a substituted posture would be a number this app invented.
 */
function sanitizeCalibration(c: Partial<RomCalibration>): RomCalibration {
  const out = { ...c } as RomCalibration;
  const rest = c.rest;
  if (rest === undefined || rest === null) {
    delete (out as { rest?: unknown }).rest;
  } else if (
    typeof rest !== 'object' ||
    typeof (rest as RestQualityLike).still !== 'boolean' ||
    !Number.isFinite((rest as RestQualityLike).spread) ||
    !Number.isFinite((rest as RestQualityLike).drift) ||
    !Number.isFinite((rest as RestQualityLike).durationSec) ||
    !Number.isFinite((rest as RestQualityLike).samples)
  ) {
    console.warn('[store] a saved calibration carries an unreadable rest block; dropping it (the range itself is kept).');
    delete (out as { rest?: unknown }).rest;
  }
  if (c.posture !== undefined && !(c.posture in POSTURE_INFO)) {
    console.warn(`[store] a saved calibration names an unknown posture "${String(c.posture)}"; dropping the field.`);
    delete (out as { posture?: unknown }).posture;
  }
  if (c.peaks !== undefined && !Array.isArray(c.peaks)) delete (out as { peaks?: unknown }).peaks;
  if (c.capturedAt !== undefined && !Number.isFinite(c.capturedAt)) delete (out as { capturedAt?: unknown }).capturedAt;
  return out;
}

/** The five numbers a stored rest block has to carry before anything may read it. */
type RestQualityLike = { still: unknown; spread: unknown; drift: unknown; durationSec: unknown; samples: unknown };

/** The same filing check, applied inside each patient's own store of ranges. */
function validateCalibrationsByPatient(raw: CalibrationsByPatient): CalibrationsByPatient {
  const out: CalibrationsByPatient = {};
  for (const [patientId, map] of Object.entries(raw)) out[patientId] = validateCalibrationMap(map);
  return out;
}

/**
 * WHAT ACTUALLY HAPPENED TO THE RECORD OF A FINISHED SESSION.
 *
 * The Results screen printed a green "Saved to history" badge unconditionally — a constant string in
 * the markup, drawn whether or not `localStorage` had taken the write. On a shared clinic tablet the
 * quota really does run out (the retention cap is 100 sessions PER PATIENT, so several patients on one
 * device is several hundred records plus the ranges), and private-mode or blocked site data refuses
 * every write outright. A therapist who walks away believing a record exists when it does not is the
 * worst failure this app has, and it was one boolean away from being sayable: `writeJson` has always
 * returned whether the write landed.
 *
 * So the write path now reports its verdict, and the screen that makes the claim reads it.
 */
export interface SaveOutcome {
  /** The session this verdict is about — so a stale verdict can never be shown beside a new record. */
  id: string;
  /** True when the session really reached `localStorage`. */
  ok: boolean;
  /** Epoch ms of the attempt. */
  at: number;
  /** How many attempts have been made, including the automatic one. A retry bumps it. */
  attempts: number;
}

/** What `applySuggestedLatency` did: the offset before, the offset after, both in milliseconds. */
export interface LatencyChange {
  previousMs: number;
  appliedMs: number;
  deltaMs: number;
  /**
   * The PROVENANCE of the value that was replaced, so an Undo can put back what was really there.
   *
   * `latencyMeasured` is the label the latency screen prints beside the offset in force
   * ("measured" / "not measured"), and a revert that wrote `false` unconditionally downgraded a
   * measured offset to an unmeasured one as the price of correcting a misclick. Undo has to be
   * lossless or it is not an undo.
   */
  previousMeasured: boolean;
  previousNote: string;
}

export interface AppState {
  screen: Screen;
  /**
   * Everyone this device keeps records for. Local only; nothing here ever leaves the browser except
   * through the therapist's own export.
   */
  patients: Patient[];
  /**
   * WHO the next session is recorded against, or null when nobody has been chosen.
   *
   * Null is a real state and the app is expected to stop there: a device that has just been migrated,
   * or one whose last patient was deleted, has no honest answer to "whose session is this", and
   * guessing is the exact failure this identity work exists to prevent.
   */
  activePatientId: string | null;
  /**
   * A sentence for the therapist when the patient in this tab's chair was NOT put there by this tab:
   * seeded from the device hint when the tab opened, or renamed/deleted in another tab since. Null
   * when the selection is this tab's own and nothing has happened to it elsewhere.
   *
   * The selection itself is per tab (see `ACTIVE_PATIENT_KEY`) and no other tab can move it. This is
   * the other half of that rule: what another tab DID change — the shared patient record — is said
   * out loud instead of appearing as a name that quietly turned into a different one.
   */
  activePatientNotice: string | null;
  /** The therapist has read `activePatientNotice`; it is this tab's selection now. */
  acknowledgeActivePatient: () => void;
  /** Sessions already deleted by the retention limit, per patient — what the record is missing. */
  historyDropped: Record<string, number>;
  /** Screen the user came from, so Back on a leaf screen is not a guess. */
  previousScreen: Screen | null;
  inputMode: InputMode;

  mode: Mode;
  lanes: LaneSpec[];
  difficulty: DifficultyName;
  windowScale: number;
  /**
   * THE PRESCRIBED PACING: minimum seconds between two reps in one lane. A therapist control, not a
   * difficulty side effect — see charts/generate.ts `DEFAULT_LANE_REST_SEC`.
   */
  laneRestSec: number;
  songId: string;
  seed: number;

  /** Per-lane ROM calibration for the CURRENT prescription (same order as `lanes`). */
  calibrations: (RomCalibration | null)[];
  /**
   * The ACTIVE PATIENT's stored ranges, keyed movement:side(:fingertip), so their next session can
   * offer them back. A view of `calibrationsByPatient[activePatientId]`, swapped whole when the
   * patient changes — a range measured on one person is never in the map another person is offered.
   */
  savedCalibrations: Record<string, RomCalibration>;
  /** Every patient's ranges. The persisted shape; `savedCalibrations` is the slice on screen. */
  calibrationsByPatient: CalibrationsByPatient;

  latencyOffsetSec: number;
  /** True when the offset in force came from a measurement (the probe, or a whole run's crossings). */
  latencyMeasured: boolean;
  /** One line of provenance for the offset in force, shown wherever the number is shown. */
  latencyNote: string;
  /**
   * When the offset in force was written, epoch ms — and, more importantly, WHETHER one is in force
   * at all. `null` means nothing has ever set a latency on this device, and only then may a screen
   * fall back to DEFAULT_LATENCY_SEC. `0` means a value is in force but was restored from a build
   * that did not record its date.
   */
  latencySetAt: number | null;

  settings: Settings;
  history: SessionResult[];
  lastResult: SessionResult | null;
  /**
   * Whether `lastResult` actually reached the disk, and how many tries it took. Null before any
   * session has been recorded in this tab. See `SaveOutcome`.
   */
  lastSave: SaveOutcome | null;
  persistenceFailed: boolean;

  /**
   * THIS SESSION CANNOT BE LEFT WITHOUT TOUCHING THE SCREEN.
   *
   * It is not a preference and it is never persisted: it is the evidence, gathered from what actually
   * happened, that there may be nobody in the room but the patient — and the only thing that decides
   * whether the camera is kept alive on the results screen, where the therapist's two buttons would
   * otherwise be the only way off the last screen of the session (see `screenNeedsCamera`). Cleared
   * when a new session is started from Home, and by the patient's own "turn the camera off".
   *
   * WHAT COUNTS AS THAT EVIDENCE, AND WHY IT WIDENED. It used to be set ONLY by the first dwell
   * confirm (src/ui/DwellTarget.tsx), which sounds right and was the wrong test: a patient whose
   * therapist had to tap them past a blocked camera check never confirmed anything, so the one person
   * least able to reach the tablet was guaranteed to arrive at the results screen with no camera and
   * no targets. Two dead ends that compounded into one. A CAMERA SESSION REACHING THE PLAY SCREEN now
   * sets it too (src/ui/Play.tsx): in a camera session the patient's limb IS the controller, which is
   * the fact that matters here. A keyboard or autoplay run releases the device the moment play ends,
   * exactly as before, and the results screen says out loud that the camera is still on.
   */
  handsFree: boolean;

  goto: (screen: Screen) => void;
  setInputMode: (m: InputMode) => void;
  setHandsFree: (on: boolean) => void;
  /** Create a patient and make them the one the next session is recorded against. Returns the id. */
  addPatient: (name: string) => string;
  /** Switch patients: swaps in their stored ranges and clears the lane ranges measured for the last. */
  selectPatient: (id: string) => void;
  renamePatient: (id: string, name: string) => void;
  /** Delete a patient. Refused (returns false) while any session is still filed under them. */
  deletePatient: (id: string) => boolean;
  /**
   * Move every session AND every stored range from one patient to another — the fix for the
   * "unassigned" record once the therapist works out whose those sessions were.
   */
  reassignSessions: (fromId: string, toId: string) => number;
  /**
   * Select the built-in device-test record, creating it if needed, and return its id.
   *
   * The escape hatch for keyboard / autoplay runs, which are the system driving the lanes rather than
   * a person moving: they need somewhere to go that is not a patient's clinical record.
   */
  selectDeviceTestPatient: () => string;
  setMode: (m: Mode) => void;
  setLanes: (lanes: LaneSpec[]) => void;
  setLane: (index: number, patch: Partial<Pick<LaneSpec, 'movement' | 'side' | 'fingertip'>>) => void;
  addLane: () => void;
  removeLane: (index: number) => void;
  setDifficulty: (d: DifficultyName) => void;
  setWindowScale: (s: number) => void;
  /** Set the pacing floor (seconds of rest between reps in one lane); clamped to the safe range. */
  setLaneRestSec: (sec: number) => void;
  setSong: (id: string) => void;
  setSeed: (seed: number) => void;
  setCalibration: (lane: number, cal: RomCalibration | null) => void;
  clearCalibrations: () => void;
  setLatency: (sec: number, measured: boolean, note?: string) => void;
  /**
   * Adopt the offset a finished run suggests as the one the NEXT session runs with. Returns the
   * before/after pair (ms) so the screen can show the therapist exactly what changed, or null when
   * there was nothing usable to apply.
   */
  applySuggestedLatency: (suggestedMs: number, source?: string) => LatencyChange | null;
  updateSettings: (patch: Partial<Settings>) => void;
  addResult: (r: SessionResult) => void;
  /**
   * Try to write the session on the Results screen to disk again, after the therapist has freed some
   * space (or after nothing at all — a quota refusal can be transient). Returns whether it landed and
   * updates `lastSave` either way, so the badge is never a guess.
   */
  retrySaveLastResult: () => boolean;
  /** Delete ONE stored session (the therapist's undo for a run that was not a session). */
  deleteResult: (id: string) => void;
  /**
   * Re-file ONE stored session onto another patient. Returns false when there was nothing to move.
   *
   * The way back from the likeliest real error in this app: a session recorded against the wrong
   * person. Without it the only correction is `deleteResult` — destroying a record of work the
   * patient actually did in order to fix a label — which is not a correction a clinical system may
   * require. The stored `patientName` is re-stamped with the receiving patient's current name so an
   * export carries the name the session is now filed under, and `historyDropped` is untouched: what
   * the retention limit already deleted stayed deleted for the patient it was deleted from.
   *
   * A non-camera run can only be moved to the device-test record: the correction must not become the
   * route by which a bot's score reaches a person's history.
   */
  moveResult: (resultId: string, toPatientId: string) => boolean;
  /** Delete every session belonging to the ACTIVE patient. Other patients are untouched. */
  clearHistory: () => void;
  config: () => SessionConfig;
}

const persistedSettings = readJson<Settings>(SETTINGS_KEY, DEFAULT_SETTINGS, validateSettings);
const rawHistory = readJson<SessionResult[]>(HISTORY_KEY, [], validateHistory);
// `null` when the key is absent: "no offset has ever been set on this device" is a different state
// from "the offset is 0 ms", and the latency screen's skip path turns on the difference.
const persistedLatency = readJson<number | null>(LATENCY_KEY, null, (raw) => (Number.isFinite(raw) ? (raw as number) : null));
const persistedLatencyMeta = readJson<LatencyMeta | null>(LATENCY_META_KEY, null, validateLatencyMeta);
const persistedConfig = readJson<Partial<SessionConfig>>(CONFIG_KEY, {}, validateConfig);
// Read RAW: the shape decides whether this device predates patients, and `migrateToPatients` is the
// one place allowed to decide what that means. Validation of the ranges themselves happens after.
const rawCalibrations = readJson<unknown>(CALIBRATION_KEY, {});
const persistedPatients = readJson<Patient[]>(PATIENTS_KEY, [], validatePatients);
/** This TAB's own selection (sessionStorage), and the device-wide HINT it falls back to. */
const tabActivePatient = readTabActivePatient();
const deviceActivePatientHint = readJson<string | null>(ACTIVE_PATIENT_KEY, null, (raw) =>
  typeof raw === 'string' && raw.length > 0 ? raw : null,
);
function validateDropped(raw: unknown): Record<string, number> | null {
  if (!raw || typeof raw !== 'object') return null;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (Number.isFinite(v) && (v as number) > 0) out[k] = Math.floor(v as number);
  }
  return out;
}

const persistedDropped = readJson<Record<string, number>>(HISTORY_DROPPED_KEY, {}, validateDropped);

/**
 * WHAT HAPPENS TO THE RECORDS THAT WERE ALREADY HERE.
 *
 * Sessions and ranges written before this device tracked patients have exactly one honest owner:
 * "we do not know". They are filed under a visible `unassigned` patient that the therapist can rename
 * (if these really are one person's) or whose sessions they can move onto a real patient — and,
 * critically, that record is NOT made active. The next session cannot start until a human says whose
 * it is, so nothing old is ever re-attributed to whoever opens the app next.
 */
const migration = migrateToPatients(rawHistory, rawCalibrations, persistedPatients);
const persistedHistory = migration.history;
const persistedCalibrations = validateCalibrationsByPatient(migration.calibrations);
const initialPatients = migration.patients;
// A stored selection that no longer names a real patient is not a selection — of either kind. This
// tab's own choice wins whenever it still names somebody; the device hint is what a tab that has
// never chosen (or whose patient has been deleted since) starts from.
const isReal = (id: string | null): boolean => id !== null && initialPatients.some((p) => p.id === id);
const initialTabPatient = isReal(tabActivePatient) ? tabActivePatient : null;
const initialHintPatient = isReal(deviceActivePatientHint) ? deviceActivePatientHint : null;
const initialActivePatient = initialTabPatient ?? initialHintPatient;
/**
 * True when this tab did NOT choose the patient it starts on — it was seeded from the device hint
 * (another tab's choice, or this device's last one before the tab was opened). The UI says so and
 * asks the therapist to confirm; silently presenting someone else's choice as this tab's is the
 * whole failure this split exists to prevent.
 */
const initialActiveInherited = initialActivePatient !== null && initialTabPatient === null;

/**
 * THE SHARED COLLECTIONS, AND WHY THEY ARE NOT WRITTEN WITH A BARE `writeJson` ANY MORE.
 *
 * Everything below this line is read ONCE, at module load, and every write replays the whole
 * in-memory copy over the key. With two tabs open on one clinic tablet — the therapist keeps
 * yesterday's tab open, or opens History beside a running session — the second tab's copy is a
 * snapshot from before the first tab recorded anything, so its next write DELETED every session,
 * patient and range the other tab had added since. Silently.
 *
 * Each collection now goes through a sync channel (src/state/persist.ts): the write re-reads the key
 * and carries over anything this tab has never seen, and a `storage` event from another tab is
 * adopted (see `adoptExternalRecords` at the foot of this file). The STORED SHAPES ARE UNCHANGED —
 * this is the write mechanism, not the schema.
 *
 * Sessions are re-sorted newest-first when a merge brings another tab's runs in, because that is the
 * order `addResult` maintains and the order every screen reads them in.
 */
/**
 * A repair ran (src/state/persist.ts): another tab's simultaneous write had taken records off disk
 * and they were put back, alongside that tab's own. The list handed over IS what is on disk, so the
 * store adopts it — the in-memory copy and the disk copy diverging is the bug this whole mechanism
 * exists to prevent. `useStore` is defined below and these fire from a lock callback (never during
 * module evaluation), so the reference is live by the time it is used.
 */
function adoptRepaired(patch: () => Partial<AppState>): void {
  try {
    useStore.setState(patch());
  } catch (err) {
    console.warn('[store] adopting a repaired record list failed', err);
  }
}

const historySync = createListSync<SessionResult>(HISTORY_KEY, {
  idOf: (r) => r.id,
  validate: validateHistory,
  order: (a, b) => b.startedAt - a.startedAt,
  onRepaired: (history) => adoptRepaired(() => ({ history })),
});
const patientsSync = createListSync<Patient>(PATIENTS_KEY, {
  idOf: (p) => p.id,
  validate: validatePatients,
  onRepaired: (patients) => adoptRepaired(() => ({ patients })),
});
/**
 * Ranges are merged PER LANE, and the newer capture wins: two tabs calibrating the same patient is
 * the same therapist working, and the range they measured last is the one they meant. A range with
 * no `capturedAt` (hand-built, or written by a build that predates the stamp) never displaces a
 * stamped one.
 */
const calibrationSync = createMapSync<Record<string, RomCalibration>>(CALIBRATION_KEY, {
  validate: (raw) => (raw && typeof raw === 'object' ? validateCalibrationsByPatient(raw as CalibrationsByPatient) : null),
  mergeValue: (mine, theirs) => {
    const out: Record<string, RomCalibration> = { ...theirs, ...mine };
    let changed = false;
    for (const [lane, cal] of Object.entries(theirs)) {
      const ours = mine[lane];
      if (!ours) { changed = true; continue; }
      if ((cal.capturedAt ?? 0) > (ours.capturedAt ?? 0)) {
        out[lane] = cal;
        changed = true;
      }
    }
    return changed ? out : mine;
  },
  onRepaired: (map) =>
    adoptRepaired(() => {
      const calibrationsByPatient = map as CalibrationsByPatient;
      const active = useStore.getState().activePatientId;
      return { calibrationsByPatient, savedCalibrations: (active && calibrationsByPatient[active]) || {} };
    }),
});
/** Deletion counters: the honest reconciliation of "how many were trimmed" is the larger count. */
const droppedSync = createMapSync<number>(HISTORY_DROPPED_KEY, {
  validate: validateDropped,
  mergeValue: (mine, theirs) => Math.max(mine, theirs),
  onRepaired: (historyDropped) => adoptRepaired(() => ({ historyDropped })),
});

// What THIS tab has seen. Anything on disk outside these sets belongs to another tab and is kept.
historySync.know(persistedHistory);
patientsSync.know(initialPatients);
calibrationSync.know(persistedCalibrations);
droppedSync.know(persistedDropped);

if (migration.migrated) {
  patientsSync.write(initialPatients);
  historySync.write(persistedHistory);
  calibrationSync.write(persistedCalibrations);
}

// A slot that names nobody real is not a selection: clear it rather than offering it to the next tab.
if (initialActivePatient === null && (tabActivePatient !== null || deviceActivePatientHint !== null)) {
  writeActivePatient(null);
}

const initialMode: Mode = persistedConfig.mode ?? 'leg';
const initialLanes = persistedConfig.lanes ?? defaultLanes(initialMode);

/**
 * Sessions kept per patient. Older ones are deleted on write — and the deletion is COUNTED
 * (`historyDropped`) and stated on the History screen, because a record that silently stops at 100 is
 * indistinguishable from a complete one. The per-patient limit also means a busy patient can never
 * evict another patient's record, which a device-wide cap did.
 */
export const MAX_HISTORY = 100;

export const useStore = create<AppState>((set, get) => {
  const persistSettings = (s: Settings): void => {
    if (!writeJson(SETTINGS_KEY, s)) set({ persistenceFailed: true });
  };
  /**
   * Sessions, reconciled with whatever another tab has recorded since this one loaded. When the
   * merge brings runs in, the store ADOPTS the merged list: the in-memory copy and the disk copy
   * must not diverge, or the next write would drop the other tab's runs again.
   *
   * Safe to call from anywhere `set` is legal — never from inside a `set` updater.
   */
  const persistHistory = (h: SessionResult[]): boolean => {
    const { ok, merged, changed } = historySync.write(h);
    if (!ok) set({ persistenceFailed: true });
    if (changed) set({ history: merged });
    // RETURNED, not only flagged. `persistenceFailed` is a device-wide sticky warning; the Results
    // screen needs the verdict on THIS write, beside the badge that claims it.
    return ok;
  };
  // Calibrations are persisted through the same failure-reporting path as settings and history: on a
  // shared clinic tablet the quota is small, and a write that silently fails loses every range the
  // therapist just measured with nothing on screen to say so (see `persistenceFailed`, surfaced on the
  // ROM calibration screen).
  // Returns the flag rather than calling `set` because its only caller is inside a `set` updater.
  // Returns the reconciled map alongside the verdict rather than calling `set`, because one of its
  // callers is inside a `set` updater (`setCalibration`) and must fold the result into its own return.
  const persistCalibrations = (c: CalibrationsByPatient): { ok: boolean; merged: CalibrationsByPatient } => {
    const { ok, merged } = calibrationSync.write(c);
    return { ok, merged };
  };
  /**
   * The patient list, reconciled with the other tabs'. Returns what was actually written so a caller
   * inside a `set` updater can put the merged list into state; callers outside one can ignore it (the
   * store adopts it here).
   *
   * The ACTIVE PATIENT is deliberately not written here. It is this tab's selection, not a shared
   * record, and writing it on every add/rename/delete is exactly how a second tab used to move the
   * slot the first tab would record against; `persistActivePatient` writes it, and only the two calls
   * that actually change who is in the chair reach it.
   */
  const persistPatients = (list: Patient[]): Patient[] => {
    const { ok, merged, changed } = patientsSync.write(list);
    if (!ok) set({ persistenceFailed: true });
    return changed ? merged : list;
  };
  /** Who is in THIS tab's chair (sessionStorage), plus the device hint a fresh tab may start from. */
  const persistActivePatient = (id: string | null): void => {
    if (!writeActivePatient(id)) set({ persistenceFailed: true });
  };
  const persistDropped = (d: Record<string, number>): Record<string, number> => droppedSync.write(d).merged;
  const persistConfig = (): void => {
    const s = get();
    writeJson(CONFIG_KEY, { mode: s.mode, lanes: s.lanes, difficulty: s.difficulty, windowScale: s.windowScale, laneRestSec: s.laneRestSec, songId: s.songId });
  };

  return {
    screen: 'home',
    patients: initialPatients,
    activePatientId: initialActivePatient,
    activePatientNotice: initialActiveInherited
      ? `This tab opened on the patient last chosen on this device. Check it is the person in front of you before you record a session against them.`
      : null,
    historyDropped: persistedDropped,
    previousScreen: null,
    inputMode: 'camera',

    mode: initialMode,
    lanes: initialLanes,
    difficulty: persistedConfig.difficulty ?? 'medium',
    windowScale: persistedConfig.windowScale ?? 1,
    laneRestSec: persistedConfig.laneRestSec ?? DEFAULT_LANE_REST_SEC,
    songId: persistedConfig.songId ?? DEFAULT_SONG_ID,
    seed: 1,

    calibrations: initialLanes.map(() => null),
    savedCalibrations: (initialActivePatient && persistedCalibrations[initialActivePatient]) || {},
    calibrationsByPatient: persistedCalibrations,

    latencyOffsetSec: persistedLatency ?? 0,
    // Provenance survives the reload with the number it describes. It used to be reset to
    // `false`/`''` on every load while the offset persisted, so the screens that quote the offset
    // could only ever quote it anonymously.
    latencyMeasured: persistedLatency !== null && (persistedLatencyMeta?.measured ?? false),
    latencyNote: persistedLatency !== null ? (persistedLatencyMeta?.note ?? '') : '',
    latencySetAt: persistedLatency === null ? null : (persistedLatencyMeta?.at ?? 0),

    settings: persistedSettings,
    history: persistedHistory,
    lastResult: null,
    lastSave: null,
    persistenceFailed: false,
    handsFree: false,

    acknowledgeActivePatient: () =>
      set((s) => {
        if (s.activePatientNotice === null) return s;
        // "It is the right patient" is a statement about a PERSON. When the selection names nobody in
        // the list — the cross-tab delete below, or a slot left over from one — there is nothing to
        // confirm, and clearing the sentence would remove the only account of what happened. The
        // setup screen does not offer the button in that state; this is the same rule in the store,
        // so no other caller can dismiss it either.
        if (s.activePatientId !== null && !s.patients.some((p) => p.id === s.activePatientId)) return s;
        return { activePatientNotice: null };
      }),

    goto: (screen) => set((s) => (s.screen === screen ? s : { screen, previousScreen: s.screen })),
    setInputMode: (inputMode) => set({ inputMode }),
    setHandsFree: (handsFree) => set((s) => (s.handsFree === handsFree ? s : { handsFree })),

    addPatient: (name) => {
      const patient = makePatient(name);
      set((s) => ({ patients: [...s.patients, patient] }));
      get().selectPatient(patient.id);
      return patient.id;
    },

    /**
     * Switching patients swaps the WHOLE calibration context, not just a name in a header.
     *
     * The per-lane ranges in `calibrations` were measured on the person who is leaving the chair, so
     * they are dropped and re-seeded from the new patient's own stored ranges — nothing measured on
     * one body can survive into a session recorded against another. (The calibration screen refuses
     * such a range as well: two independent defences, because this is the one that must not fail.)
     */
    selectPatient: (id) =>
      set((s) => {
        const patient = s.patients.find((p) => p.id === id);
        if (!patient) return s;
        const saved = s.calibrationsByPatient[id] ?? {};
        const patients = persistPatients(s.patients.map((p) => (p.id === id ? { ...p, lastUsedAt: Date.now() } : p)));
        persistActivePatient(id);
        return {
          patients,
          activePatientId: id,
          // Chosen HERE, by a human, just now: nothing left to warn about.
          activePatientNotice: null,
          savedCalibrations: saved,
          calibrations: s.lanes.map((l) => saved[calibrationKey(l)] ?? null),
        };
      }),

    renamePatient: (id, name) =>
      set((s) => {
        const clean = normalizePatientName(name);
        if (!clean) return s;
        // A renamed "unassigned" record is a claim about whose those sessions are, so the badge goes:
        // the therapist has just answered the question the record was holding open.
        const patients = persistPatients(
          s.patients.map((p) => (p.id === id ? { ...p, name: clean, unassigned: undefined } : p)),
        );
        return { patients };
      }),

    deletePatient: (id) => {
      const s = get();
      // Refused while sessions remain: deleting a patient must never be a way to lose a record by
      // accident. The therapist deletes the sessions (or exports them) first, deliberately.
      if (s.history.some((r) => r.patientId === id)) return false;
      const patients = s.patients.filter((p) => p.id !== id);
      const calibrationsByPatient = { ...s.calibrationsByPatient };
      delete calibrationsByPatient[id];
      const activePatientId = s.activePatientId === id ? null : s.activePatientId;
      const stored = persistCalibrations(calibrationsByPatient);
      if (activePatientId !== s.activePatientId) persistActivePatient(activePatientId);
      set({
        patients: persistPatients(patients),
        calibrationsByPatient: stored.merged,
        activePatientId,
        activePatientNotice: activePatientId === s.activePatientId ? s.activePatientNotice : null,
        savedCalibrations: (activePatientId && stored.merged[activePatientId]) || {},
        calibrations: activePatientId === s.activePatientId ? s.calibrations : s.lanes.map(() => null),
        persistenceFailed: s.persistenceFailed || !stored.ok,
      });
      return true;
    },

    reassignSessions: (fromId, toId) => {
      const s = get();
      if (fromId === toId || !s.patients.some((p) => p.id === toId)) return 0;
      const target = s.patients.find((p) => p.id === toId);
      const moved = s.history.filter((r) => r.patientId === fromId);
      if (moved.length === 0 && !s.calibrationsByPatient[fromId]) return 0;
      const history = s.history.map((r) =>
        r.patientId === fromId ? { ...r, patientId: toId, patientName: target?.name ?? r.patientName } : r,
      );
      // The ranges move with the sessions: they were measured on the same body, and leaving them
      // behind would mean the receiving patient is offered nothing while an orphan map keeps a range
      // nobody can be handed.
      const calibrationsByPatient = { ...s.calibrationsByPatient };
      const from = calibrationsByPatient[fromId];
      if (from) {
        // RE-STAMPED, not just re-filed. Each range carries the patient it was measured on, and the
        // ROM screen refuses one stamped with anybody else (vision/calibration.ts `patientMismatch`).
        // A reassignment is a therapist ASSERTING that this body is that person; leaving the old stamp
        // on would have the app answer that assertion with "measured on a different patient" and force
        // a re-calibration it cannot justify — the stamp, not the body, is what disagreed.
        const restamped: Record<string, RomCalibration> = {};
        for (const [k, cal] of Object.entries(from)) restamped[k] = { ...cal, patient: toId };
        calibrationsByPatient[toId] = { ...restamped, ...(calibrationsByPatient[toId] ?? {}) };
        delete calibrationsByPatient[fromId];
      }
      const dropped = { ...s.historyDropped };
      if (dropped[fromId]) {
        dropped[toId] = (dropped[toId] ?? 0) + dropped[fromId];
        delete dropped[fromId];
      }
      const stored = persistCalibrations(calibrationsByPatient);
      set({
        history,
        calibrationsByPatient: stored.merged,
        historyDropped: persistDropped(dropped),
        savedCalibrations: (s.activePatientId && stored.merged[s.activePatientId]) || {},
        persistenceFailed: s.persistenceFailed || !stored.ok,
      });
      persistHistory(history);
      return moved.length;
    },

    selectDeviceTestPatient: () => {
      const s = get();
      if (!s.patients.some((p) => p.id === DEVICE_TEST_PATIENT_ID)) {
        set({ patients: [...s.patients, deviceTestPatient()] });
      }
      get().selectPatient(DEVICE_TEST_PATIENT_ID);
      return DEVICE_TEST_PATIENT_ID;
    },

    setMode: (mode) =>
      set((s) => {
        if (s.mode === mode) return s;
        const lanes = defaultLanes(mode);
        return { mode, lanes, calibrations: lanes.map((l) => s.savedCalibrations[calibrationKey(l)] ?? null) };
      }),

    setLanes: (lanes) =>
      set((s) => {
        const next = normalizeLanes(lanes.slice(0, MAX_LANES));
        return { lanes: next, calibrations: next.map((l) => s.savedCalibrations[calibrationKey(l)] ?? null) };
      }),

    setLane: (index, patch) => {
      set((s) => {
        if (index < 0 || index >= s.lanes.length) return s;
        const lanes = s.lanes.map((l, i) => (i === index ? normalizeLaneFingertip({ ...l, ...patch }) : l));
        const calibrations = s.calibrations.slice();
        // A different movement or side is a different quantity: the old range must not carry over.
        calibrations[index] = s.savedCalibrations[calibrationKey(lanes[index])] ?? null;
        return { lanes: normalizeLanes(lanes), calibrations };
      });
      persistConfig();
    },

    addLane: () => {
      set((s) => {
        if (s.lanes.length >= MAX_LANES) return s;
        const options = movementsFor(s.mode);
        const used = new Set(s.lanes.map((l) => calibrationKey(l)));
        let pick: LaneSpec | null = null;
        for (const movement of options) {
          for (const side of ['left', 'right'] as Side[]) {
            const candidate: LaneSpec = normalizeLaneFingertip({ index: s.lanes.length, movement, side });
            if (!used.has(calibrationKey(candidate))) {
              pick = candidate;
              break;
            }
          }
          if (pick) break;
        }
        const lane = normalizeLaneFingertip(pick ?? { index: s.lanes.length, movement: options[0], side: 'left' as Side });
        return { lanes: [...s.lanes, lane], calibrations: [...s.calibrations, s.savedCalibrations[calibrationKey(lane)] ?? null] };
      });
      persistConfig();
    },

    removeLane: (index) => {
      set((s) => {
        if (s.lanes.length <= MIN_LANES) return s;
        const lanes = normalizeLanes(s.lanes.filter((_, i) => i !== index));
        return { lanes, calibrations: s.calibrations.filter((_, i) => i !== index) };
      });
      persistConfig();
    },

    setDifficulty: (difficulty) => {
      set({ difficulty: DIFFICULTIES[difficulty] ? difficulty : 'medium' });
      persistConfig();
    },

    setWindowScale: (windowScale) => {
      set({ windowScale: clampWindowScale(windowScale) });
      persistConfig();
    },

    setLaneRestSec: (sec) => {
      set({ laneRestSec: clampLaneRestSec(sec) });
      persistConfig();
    },

    setSong: (songId) => {
      set({ songId });
      persistConfig();
    },

    setSeed: (seed) => set({ seed }),

    setCalibration: (lane, cal) =>
      set((s) => {
        if (lane < 0 || lane >= s.lanes.length) return s;
        const calibrations = s.calibrations.slice();
        calibrations[lane] = cal;
        const savedCalibrations = { ...s.savedCalibrations };
        if (cal) savedCalibrations[calibrationKey(s.lanes[lane])] = cal;
        // Filed under the patient it was measured on. With no patient selected the range is used for
        // this session but NOT stored: there is no honest key to store it under, and a range in the
        // wrong patient's drawer is exactly what "reuse last session's range" would hand over next.
        const calibrationsByPatient = s.activePatientId
          ? { ...s.calibrationsByPatient, [s.activePatientId]: savedCalibrations }
          : s.calibrationsByPatient;
        const stored = s.activePatientId
          ? persistCalibrations(calibrationsByPatient)
          : { ok: true, merged: calibrationsByPatient };
        return {
          calibrations,
          // The merged map is what is on disk, so it is what this tab holds: another tab's ranges for
          // other patients (and for lanes this one has not measured) survive here too.
          savedCalibrations: s.activePatientId ? (stored.merged[s.activePatientId] ?? savedCalibrations) : savedCalibrations,
          calibrationsByPatient: stored.merged,
          persistenceFailed: s.persistenceFailed || !stored.ok,
        };
      }),

    clearCalibrations: () => set((s) => ({ calibrations: s.lanes.map(() => null) })),

    setLatency: (sec, measured, note = '') => {
      // Bounds (not rounding) from the same place the Results hand-over reads them, so the value the
      // therapist is offered is the value that ends up in force.
      const latencyOffsetSec = Number.isFinite(sec) ? Math.max(LATENCY_MIN_MS / 1000, Math.min(LATENCY_MAX_MS / 1000, sec)) : 0;
      const latencySetAt = Date.now();
      set({ latencyOffsetSec, latencyMeasured: measured, latencyNote: note, latencySetAt });
      writeJson(LATENCY_KEY, latencyOffsetSec);
      // Written second and separately: if this write is the one the quota refuses, the offset is
      // still in force and merely loses its label.
      writeJson(LATENCY_META_KEY, { measured, note, at: latencySetAt } satisfies LatencyMeta);
    },

    applySuggestedLatency: (suggestedMs, source = '') => {
      if (!Number.isFinite(suggestedMs)) return null;
      const before = get();
      const previousMs = Math.round(before.latencyOffsetSec * 1000);
      const previousMeasured = before.latencyMeasured;
      const previousNote = before.latencyNote;
      // The same clamp the panel labels its button with, so what is offered is what is stored.
      const appliedMs = clampLatencyMs(suggestedMs);
      const appliedSec = appliedMs / 1000;
      // `measured` stays true: the value came from a whole run's worth of judged crossings, which is
      // strictly more evidence than the ten taps of the latency screen.
      get().setLatency(appliedSec, true, source ? `${appliedMs} ms measured from ${source}` : `${appliedMs} ms measured from the last run`);
      return { previousMs, appliedMs, deltaMs: appliedMs - previousMs, previousMeasured, previousNote };
    },

    updateSettings: (patch) => {
      const settings = { ...get().settings, ...patch };
      set({ settings });
      persistSettings(settings);
    },

    addResult: (record) => {
      const s = get();
      // A record with no patient on it is not a record of anybody. It cannot be dropped (the patient
      // did the work) and it must not be attributed to whoever is selected NOW, so it goes where every
      // other ownerless record goes: the unassigned bucket, visible and re-assignable.
      //
      // AND: a run the SYSTEM drove is not this person's record, whoever was selected when it started.
      // A keyboard or autoplay run is the bot's score, its reps and its ROM; filed under a patient it
      // inflates their session count, spends their retention budget and sits inside their clinical
      // history reading "not measured". Those runs go to the built-in device-test record — which is
      // exactly what patients.ts `deviceTestPatient` says they do, now enforced rather than asserted.
      const devInput = record.inputMode !== 'camera';
      // AND: an id that names NOBODY IN THE LIST is not a filing either — it is a record nobody can
      // reach. A patient deleted in another tab leaves exactly that id behind (see
      // `adoptExternalRecords`), and a session filed under it is invisible in the patient list,
      // unreachable from History and impossible to move. It goes where every other ownerless record
      // goes: the unassigned bucket, where it is visible and can be re-filed onto a real patient.
      const filed = !!record.patientId && s.patients.some((p) => p.id === record.patientId);
      const needsDeviceTest = devInput && !s.patients.some((p) => p.id === DEVICE_TEST_PATIENT_ID);
      const needsUnassigned = !devInput && !filed && !s.patients.some((p) => p.id === UNASSIGNED_PATIENT_ID);
      const r = devInput
        ? { ...record, patientId: DEVICE_TEST_PATIENT_ID, patientName: 'Device test (not a patient)' }
        : filed
          ? record
          : { ...record, patientId: UNASSIGNED_PATIENT_ID, patientName: record.patientName || 'Unassigned records' };
      if (needsDeviceTest || needsUnassigned) {
        const patients = [...s.patients, needsDeviceTest ? deviceTestPatient() : unassignedPatient()];
        set({ patients: persistPatients(patients) });
      }
      const all = [r, ...get().history];
      // The cap is PER PATIENT: one patient's twentieth session must not push another patient's
      // first one off the device. Everything trimmed is counted, and the History screen says so.
      const mine = all.filter((x) => x.patientId === r.patientId);
      const drop = new Set(mine.slice(MAX_HISTORY).map((x) => x.id));
      const history = drop.size > 0 ? all.filter((x) => !drop.has(x.id)) : all;
      const historyDropped = drop.size > 0
        ? { ...s.historyDropped, [r.patientId]: (s.historyDropped[r.patientId] ?? 0) + drop.size }
        : s.historyDropped;
      set({ history, lastResult: r, historyDropped: drop.size > 0 ? persistDropped(historyDropped) : historyDropped });
      // THE BADGE ON THE NEXT SCREEN IS THIS BOOLEAN. Set before the patient list is touched below,
      // so a failure to write the patient's `lastUsedAt` (cosmetic) can never be mistaken for a
      // failure to write the session (the record itself).
      const saved = persistHistory(history);
      set({ lastSave: { id: r.id, ok: saved, at: Date.now(), attempts: 1 } });
      // Recording a session is what makes a patient "recent" — the picker orders on it. Read the
      // list back out of the store: the unassigned fallback above may have just added to it.
      const after = get();
      const patients = after.patients.map((p) => (p.id === r.patientId ? { ...p, lastUsedAt: Date.now() } : p));
      set({ patients: persistPatients(patients) });
    },

    retrySaveLastResult: () => {
      const s = get();
      const last = s.lastResult;
      if (!last) return false;
      // Written from the store's own history, not from the record alone: the list is what is on disk,
      // and a session dropped from it by a retention trim must not be re-appended by a retry.
      const ok = persistHistory(s.history.some((r) => r.id === last.id) ? s.history : [last, ...s.history]);
      set({ lastSave: { id: last.id, ok, at: Date.now(), attempts: (s.lastSave?.attempts ?? 0) + 1 } });
      return ok;
    },

    deleteResult: (id) => {
      const s = get();
      const history = s.history.filter((r) => r.id !== id);
      if (history.length === s.history.length) return;
      set({ history, lastResult: s.lastResult?.id === id ? null : s.lastResult });
      persistHistory(history);
    },

    moveResult: (resultId, toPatientId) => {
      const s = get();
      const target = s.patients.find((p) => p.id === toPatientId);
      const current = s.history.find((r) => r.id === resultId);
      if (!target || !current || current.patientId === toPatientId) return false;
      // The correction may not undo the invariant above: a keyboard/autoplay run is the bot's score
      // and cannot be moved INTO a person's clinical record, only between non-person records.
      if (current.inputMode !== 'camera' && !target.deviceTest) return false;
      const moved = { ...current, patientId: toPatientId, patientName: target.name };
      const history = s.history.map((r) => (r.id === resultId ? moved : r));
      set({ history, lastResult: s.lastResult?.id === resultId ? moved : s.lastResult });
      persistHistory(history);
      return true;
    },

    clearHistory: () => {
      const s = get();
      // Scoped to the patient on screen. A device-wide wipe behind one confirm dialog is how one
      // patient's tidy-up deletes another patient's record.
      const active = s.activePatientId;
      // NO PATIENT IS A NO-OP, not "everybody". There is no confirm dialog in this app worded for a
      // device-wide wipe, and the only one that reaches here is worded for a single patient; a
      // fallback that deleted every patient's sessions behind it is a data-loss bug waiting for a
      // refactor to expose it.
      if (active === null) return;
      const history = s.history.filter((r) => r.patientId !== active);
      const historyDropped = { ...s.historyDropped };
      delete historyDropped[active];
      set({ history, historyDropped: persistDropped(historyDropped), lastResult: null });
      persistHistory(history);
    },

    config: () => {
      const s = get();
      return {
        patientId: s.activePatientId ?? '',
        mode: s.mode,
        lanes: s.lanes,
        difficulty: s.difficulty,
        windowScale: s.windowScale,
        laneRestSec: s.laneRestSec,
        songId: s.songId,
        seed: s.seed,
      };
    },
  };
});

/**
 * ANOTHER TAB JUST WROTE. Adopt it.
 *
 * The other tab's write already reconciled in everything of ours it could see (see the sync channels
 * above), so what is on disk now is the union of both tabs — which makes adopting it wholesale the
 * thing that both brings its new sessions here AND propagates a deletion it made. Without this, two
 * tabs diverge until one of them overwrites the other.
 *
 * WHAT IS NOT ADOPTED, and why:
 *   - `activePatientId` / `calibrations`: the patient in the chair and the ranges the run in progress
 *     is being judged against belong to THIS tab's session. A therapist looking something up in a
 *     second tab must not re-point the session running in the first one. ONE EXCEPTION, and it is not
 *     a re-pointing: if the other tab DELETED that patient, the id names nobody, and holding it is
 *     how a camera session gets filed against a record that is not in the list. The selection is
 *     cleared (fail closed) and the deletion is stated.
 *   - `settings`, the last config, the latency offset: device preferences, last-write-wins, and
 *     changing scroll speed or judgment offset under a running session would be worse than stale.
 *   - `lastResult`: the results screen shows the run this tab just finished.
 * Only the RECORDS — the things that cannot be reconstructed if they are lost — are adopted.
 */
function adoptExternalRecords(name: string): void {
  const s = useStore.getState();
  if (name === HISTORY_KEY) {
    useStore.setState({ history: historySync.read() });
  } else if (name === PATIENTS_KEY) {
    const patients = patientsSync.read();
    // WHAT THE OTHER TAB DID TO THE PERSON IN THIS TAB'S CHAIR, SAID OUT LOUD. The list is shared, so
    // a rename or a delete made next door lands here — and it used to land as a name that had quietly
    // become a different name, under a session about to be recorded. The selection itself never moves
    // (that is this tab's), only the record it points at, and that change is now a sentence.
    const active = s.activePatientId;
    const before = active ? s.patients.find((p) => p.id === active) : null;
    const after = active ? patients.find((p) => p.id === active) : null;
    let activePatientNotice = s.activePatientNotice;
    if (active && before && !after) {
      activePatientNotice = `${before.name} was deleted in another tab. Choose who this session is for before recording it.`;
      // AND THE SELECTION GOES WITH THE RECORD IT NAMED. Saying so was not enough: this tab was left
      // holding an id that names nobody, which reads as "No patient selected" on every screen while
      // still being truthy — the Start button stayed enabled and the camera session behind it was
      // filed under the dead id, invisible in the patient list and unreachable from History. A slot
      // that names nobody real is not a selection (the same rule this module applies at load), so it
      // is cleared here, in the tab's storage too, and the ranges measured on the departed patient go
      // with it exactly as they do on `selectPatient`. The sentence above is what survives.
      writeActivePatient(null);
      useStore.setState({
        patients,
        activePatientNotice,
        activePatientId: null,
        savedCalibrations: {},
        calibrations: s.lanes.map(() => null),
      });
      return;
    } else if (before && after && before.name !== after.name) {
      activePatientNotice = `${before.name} was renamed to ${after.name} in another tab.`;
    }
    useStore.setState({ patients, activePatientNotice });
  } else if (name === CALIBRATION_KEY) {
    const calibrationsByPatient = calibrationSync.read() as CalibrationsByPatient;
    useStore.setState({
      calibrationsByPatient,
      savedCalibrations: (s.activePatientId && calibrationsByPatient[s.activePatientId]) || {},
    });
  } else if (name === HISTORY_DROPPED_KEY) {
    useStore.setState({ historyDropped: droppedSync.read() });
  }
}

/**
 * Resolves once every clobber repair scheduled so far has run (src/state/persist.ts). Exported for
 * tests, which need a deterministic point after a simulated two-tab collision; nothing in the app
 * waits on it — the repair is fire-and-forget by design.
 */
export function recordsSettled(): Promise<void> {
  return Promise.all([historySync.settled(), patientsSync.settled(), calibrationSync.settled(), droppedSync.settled()]).then(
    () => undefined,
  );
}

/** Live in the browser only; the unsubscribe is exported for tests. */
export const stopCrossTabSync = onExternalChange(
  [HISTORY_KEY, PATIENTS_KEY, CALIBRATION_KEY, HISTORY_DROPPED_KEY],
  adoptExternalRecords,
);
