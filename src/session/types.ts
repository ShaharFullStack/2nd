/**
 * Session-level types: the therapist's prescription, and the record of what the patient did.
 *
 * Everything here is PLAIN JSON — it is written to localStorage and read back by the History screen
 * months later, so nothing in this file may hold a class instance, a DOM node or an audio handle.
 */
import type { DifficultyName, Fingertip, LaneSpec, Mode, Movement, Side } from '../engine/types.ts';

/** Which input drives the lanes. `camera` is the product; the other two are dev/critic affordances. */
export type InputMode = 'camera' | 'keyboard' | 'autoplay';

/**
 * WHY A SESSION STOPPED — stored, not just computed.
 *
 * `completed` alone flattens three different clinical facts into one "ended early": a therapist who
 * decided the patient had had enough, a patient who was taken out of the chair, and a tablet that
 * went to sleep mid-song. The first is a judgment to record; the last is EQUIPMENT FAILURE, and a
 * therapist reading a 40-second run months later has no way to tell them apart. The runner has
 * always known which it was (`RunEndReason`); this is that fact reaching disk.
 *
 *   'chart'     — the chart finished. The only complete run.
 *   'quit'      — a human pressed "End & see results".
 *   'abandoned' — the session was taken away: the play screen was left, or the page went away
 *                 (tab closed, tablet slept).
 *
 * Optional because records written before it existed do not carry it, and a record with no reason
 * must read as "not stated", never as a guess.
 */
export type SessionEndReason = 'chart' | 'quit' | 'abandoned';

/**
 * A person this device keeps records for.
 *
 * DELIBERATELY THE MINIMUM. A clinic tablet is shared and this app has no server, no login and no
 * encryption: everything here sits in localStorage in the clear, so the only identifiers it may hold
 * are the ones it cannot work without. A display name the therapist chooses (initials, a first name,
 * a room number — whatever the clinic's own rules allow) and an id. NO date of birth, no address, no
 * medical record number, no diagnosis: none of them make a range of motion mean more, and all of them
 * make a lost tablet worse.
 */
export interface Patient {
  /** Stable local id. Never shown; it is what every record and every calibration is keyed on. */
  id: string;
  /** What the therapist typed. The ONLY identifying field this app stores. */
  name: string;
  createdAt: number;
  /** Last time a session was started for this patient (0 = never). Orders the picker. */
  lastUsedAt: number;
  /**
   * True for the ONE record that pre-patient sessions were migrated into. Those sessions were
   * recorded on a device-wide history with no patient on them at all, so they belong to "whoever used
   * this tablet before patients existed" and to nobody else. The flag keeps that visible on every
   * screen until a therapist renames the record or reassigns its sessions.
   */
  unassigned?: boolean;
  /**
   * True for the built-in record that keyboard / autoplay sessions are filed under. Those runs are the
   * SYSTEM producing the input (see trends.ts), so they are not any patient's record and must never be
   * mixed into one.
   */
  deviceTest?: boolean;
}

/** The record pre-patient sessions and calibrations are migrated into. */
export const UNASSIGNED_PATIENT_ID = 'unassigned';

/** The record keyboard / autoplay runs are filed under — a device test, not a person. */
export const DEVICE_TEST_PATIENT_ID = 'device-test';

/** The therapist's prescription for one session. */
export interface SessionConfig {
  /**
   * WHOSE session this is (Patient.id). Carried on the prescription rather than read from the store at
   * the end of the run, so the record cannot be attributed to whoever happens to be selected when the
   * song stops — switching patient mid-song produces a record for the patient it was started for.
   */
  patientId: string;
  mode: Mode;
  /** 2..4 lanes, `index` equal to the array position. */
  lanes: LaneSpec[];
  difficulty: DifficultyName;
  /** Therapist multiplier on the timing windows (0.25..4; 1 = the difficulty's own windows). */
  windowScale: number;
  /**
   * THE PACING FLOOR: minimum seconds between two reps in ONE lane (charts/generate.ts
   * `DEFAULT_LANE_REST_SEC`). Prescribed for physiology — time to return to rest — rather than
   * inherited from the difficulty preset. Optional so records written before the control existed
   * still parse; absent means the old difficulty-derived spacing was in force.
   */
  laneRestSec?: number;
  songId: string;
  /** Chart generation seed — the same seed and song gives the same chart. */
  seed: number;
}

/** Per-lane rehab metrics for the Results screen. */
export interface LaneResultSummary {
  lane: number;
  movement: Movement;
  side: Side;
  /**
   * finger_opposition ONLY: the fingertip the therapist prescribed for this lane. Recorded because the
   * feature (and therefore romMean/romBest and the calibrated range below) is a DIFFERENT QUANTITY per
   * tip — a cross-session ROM trend that pooled an index lane with a pinky lane would show a collapse
   * in range that is really just a change of finger. Absent on every other movement and on records
   * written before the therapist could choose.
   */
  fingertip?: Fingertip;
  /**
   * The FULL clinical name of what was measured — "Left Knee extension", "Left Finger opposition
   * (index finger)".
   *
   * This used to be the renderer's lane abbreviation ("L knee ext"), which exists for one reason: it
   * has to fit under a ~46 px lane on a portrait canvas. A clinical record read months later, printed,
   * or handed to another clinician is not a 46 px canvas, and "L toe lift" is not what the movement is
   * called. The abbreviation stays where it belongs — on the highway (render/palette.ts `laneLabel`).
   */
  movementName: string;
  hits: number;
  perfects: number;
  goods: number;
  misses: number;
  judged: number;
  /** hits / judged. */
  accuracy: number;
  /**
   * Movements the patient actually performed in this lane (hits + inputs that matched no note).
   * Always >= hits: a mis-calibrated latency shows up as reps >> hits, not as "the patient did nothing".
   */
  reps: number;
  /**
   * Notes in this lane the patient ANSWERED with a movement: hits plus missed notes a movement
   * landed nearest to (engine/scoring.ts `answerRateOf`). Bounded by `judged` by construction.
   * Optional: records written before the gauge stopped being a clamped movements-per-note ratio do
   * not carry it, and must read as "not recorded" rather than as zero.
   */
  attempted?: number;
  /** Movements in this lane that answered no note at all (`reps - attempted`). Tremor, clonus, latency. */
  surplus?: number;
  /** Median signed timing error in ms (positive = late), null when nothing was measured. */
  timingBiasMs: number | null;
  timingBiasMadMs: number | null;
  /** Mean peak ROM across completed reps, as a fraction of the calibrated range (unclamped). */
  romMean: number | null;
  /** Best single rep's peak ROM (unclamped fraction of the calibrated range). */
  romBest: number | null;
  /** Reps whose ROM was actually measured (camera sessions only). */
  romSamples: number;
  /** Reps whose peak is only a lower bound (frames were dropped / the rep was cut short). */
  romUncertain: number;
  /**
   * The calibrated range this session's percentages are measured against, in the movement's own
   * feature units (degrees or a torso-normalized ratio). Stored so a later session can be compared
   * against the range that was actually in force, not just against its own 100 %.
   */
  calibratedMin: number | null;
  calibratedMax: number | null;
  /** True when the therapist set or nudged that range by hand rather than measuring it. */
  calibrationManual: boolean;
  /** Compensation the movement monitors, or null when it monitors none. */
  compensationKind: 'heel_lift' | 'trunk_lean' | null;
  /** True when a rest baseline was actually in effect — otherwise `compensationFlags` means "not measured". */
  compensationMonitored: boolean;
  /** Reps flagged for compensation. */
  compensationFlags: number;
  /** Worst compensation magnitude seen (feature units), null when none/not measured. */
  compensationWorst: number | null;
}

/**
 * HOW WELL THE CAMERA WAS TRACKING WHILE THIS SESSION'S NUMBERS WERE MEASURED.
 *
 * A range measured from a 12 fps stream with the limb half out of frame is not the same number as
 * one from a clean 30 fps stream, and a record that cannot tell them apart cannot be trended. Every
 * field is observed, never estimated (see session/tracking.ts for what is and is not claimed).
 */
export interface TrackingQuality {
  /** Health-report samples this block is built from (one every `TRACKING_SAMPLE_MS` while playing). */
  samples: number;
  /** Median frames per second the detector actually processed. */
  fpsMedian: number;
  /** Tenth percentile of the same — what the worst stretches of the session looked like. */
  fpsLow: number;
  /** Median milliseconds the model needed per frame on this machine. */
  inferenceMsMedian: number;
  /** Share of samples (0..1) in which every prescribed lane had usable landmarks. */
  trackedFraction: number;
  /** Share of samples (0..1) whose frame rate was under the engine's usable floor. */
  lowFpsFraction: number;
  /** Inference backend in use ('CPU' means no graphics acceleration was available). */
  delegate: 'GPU' | 'CPU' | null;
  /** The most frequent non-ok tracking reason, or null when the stream stayed healthy. */
  worstReason: string | null;
}

/** One completed (or abandoned) session, as persisted to localStorage. */
export interface SessionResult {
  id: string;
  /** The patient this session was recorded against (Patient.id). Every screen scopes on it. */
  patientId: string;
  /**
   * The patient's display name AS IT WAS when the session was recorded.
   *
   * The id is canonical and the screens resolve the current name through it; this is here so an
   * EXPORTED record is readable on its own, off the device, without the patient list beside it.
   */
  patientName: string;
  /** Date.now() at the first note. */
  startedAt: number;
  endedAt: number;
  /** Song seconds actually played. */
  durationSec: number;
  mode: Mode;
  difficulty: DifficultyName;
  windowScale: number;
  inputMode: InputMode;
  songId: string;
  songTitle: string;
  artist: string;
  attribution: string;
  score: number;
  stars: number;
  /** hits / judged over the whole chart. */
  accuracy: number;
  /** (perfects + 0.75 goods) / judged — what `stars` is derived from. */
  starAccuracy: number;
  maxCombo: number;
  totalNotes: number;
  hits: number;
  perfects: number;
  goods: number;
  misses: number;
  /** Movements performed across all lanes (hits + unmatched). The rehab rep count. */
  reps: number;
  /**
   * NOTES ANSWERED per note judged, 0..1 (engine/scoring.ts `answerRateOf`) — the quantity the
   * highway gauge shows.
   *
   * THIS FIELD REPLACES `health`, AND THE RENAME IS THE POINT. `health` meant three different things
   * across the life of this record — a rock meter, then movements-per-note-offered clamped to 1, and
   * now notes answered — and a stored record that changes meaning under a stable key is unreadable.
   * A record written before this carries `health` and no `answerRate`, and every screen shows it as
   * "not recorded" rather than mixing two quantities into one trend. The export format version was
   * bumped with it (session/results.ts).
   */
  answerRate?: number;
  /** Movements that answered no note at all, across all lanes (`reps - attempted`). */
  surplusMovements?: number;
  /**
   * THE PACING PRESCRIBED (SessionConfig.laneRestSec): the least time between two reps of ONE LANE
   * — one movement on one side. A limb carrying two lanes can be asked for a rep in each inside it,
   * so its ceiling is twice this lane ceiling (`limbRepsPerMinuteAt`).
   *
   * Recorded because it is the control that directly sets the rep count — the same patient, song and
   * difficulty gives 24 reps per lane at 3.0 s and 96 at 0.4 s. Without it "+26 movements vs last
   * time" compares two sessions that may have differed four-fold in the reps ASKED FOR, and a
   * cross-session comparison built on an unrecorded dose is not a comparison. Absent on records
   * written before the control existed.
   */
  laneRestSec?: number;
  timingBiasMs: number | null;
  timingBiasMadMs: number | null;
  /** Input latency in force during the run (ms). */
  latencyOffsetMs: number;
  /** What the run itself suggests the latency should have been (ms), when it is confident. */
  suggestedLatencyMs: number | null;
  /** False when the therapist quit before the chart finished. */
  completed: boolean;
  /**
   * What stopped the run (`completed === (endReason === 'chart')`). Absent on records written before
   * this was stored — those keep reading as the unqualified "ended early" (`endReasonLabel`) rather
   * than being given a reason nobody recorded.
   */
  endReason?: SessionEndReason;
  /**
   * THE CONDITIONS THE MEASUREMENT WAS TAKEN IN — frame rate, inference time and tracking loss.
   *
   * Absent on a session with no camera to describe (keyboard, autoplay) and on every record written
   * before this was stored; both must read as "not recorded", never as a clean stream. Screens that
   * print a degree value or a millisecond value are expected to print this beside it.
   */
  tracking?: TrackingQuality;
  lanes: LaneResultSummary[];
}
