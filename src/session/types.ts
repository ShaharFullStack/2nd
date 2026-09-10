/**
 * Session-level types: the therapist's prescription, and the record of what the patient did.
 *
 * Everything here is PLAIN JSON — it is written to localStorage and read back by the History screen
 * months later, so nothing in this file may hold a class instance, a DOM node or an audio handle.
 */
import type { DifficultyName, LaneSpec, Mode, Movement, Side } from '../engine/types.ts';

/** Which input drives the lanes. `camera` is the product; the other two are dev/critic affordances. */
export type InputMode = 'camera' | 'keyboard' | 'autoplay';

/** The therapist's prescription for one session. */
export interface SessionConfig {
  mode: Mode;
  /** 2..4 lanes, `index` equal to the array position. */
  lanes: LaneSpec[];
  difficulty: DifficultyName;
  /** Therapist multiplier on the timing windows (0.25..4; 1 = the difficulty's own windows). */
  windowScale: number;
  songId: string;
  /** Chart generation seed — the same seed and song gives the same chart. */
  seed: number;
}

/** Per-lane rehab metrics for the Results screen. */
export interface LaneResultSummary {
  lane: number;
  movement: Movement;
  side: Side;
  /** "L knee lift" style label. */
  label: string;
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

/** One completed (or abandoned) session, as persisted to localStorage. */
export interface SessionResult {
  id: string;
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
  health: number;
  timingBiasMs: number | null;
  timingBiasMadMs: number | null;
  /** Input latency in force during the run (ms). */
  latencyOffsetMs: number;
  /** What the run itself suggests the latency should have been (ms), when it is confident. */
  suggestedLatencyMs: number | null;
  /** False when the therapist quit before the chart finished. */
  completed: boolean;
  lanes: LaneResultSummary[];
}
