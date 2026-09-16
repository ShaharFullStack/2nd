/**
 * CALIBRATING INSIDE THE MUSIC.
 *
 * The measured complaint: a four-lane hand prescription demanded twelve maximum-effort repetitions
 * from an impaired hand, four rest holds, four 1.8 s dwell holds and an eight-beat metronome before a
 * single note of music. The therapy was fatiguing before the game started, and the most motivating
 * thing in the product was on the far side of the wall.
 *
 * So the song starts immediately on a PROVISIONAL range and the real one is learned from the
 * patient's own first movements. This module owns the rules that make that safe. The measurement
 * itself is `InSongRangeLearner` (src/vision/calibration.ts); everything here is about WHEN a new
 * range may take effect and in WHICH DIRECTION.
 *
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 * RULE 1 — IT MAY NEVER GET HARDER MID-SONG.
 *
 * The bar a patient actually feels is not `thresholdFraction`, which never moves; it is
 * `min + thresholdFraction x (max - min)` in the movement's own units (`operativeThreshold`), and
 * that moves with the RANGE. Learn a bigger range while somebody is playing and the target rises
 * under them: the patient who was scoring starts missing, and the game has punished them for
 * achieving more. That is the exact opposite of rehab.
 *
 * So a lane's operative range changes AT MOST ONCE inside a song, at a single known moment:
 *
 *   [song start .. WARM-UP END)   the provisional range. Notes here are thinned, the hit windows are
 *                                 widened and a miss does not duck the patient's instrument — the
 *                                 app does not yet know this patient's range, so nothing that
 *                                 happens in this window is allowed to cost anything that matters.
 *   at WARM-UP END                ONE adoption, per the direction rule below. From here the target
 *                                 is fixed for the rest of the song and the therapist has a number
 *                                 they can defend.
 *   after WARM-UP END             FROZEN. The learner keeps observing (the record wants the peaks)
 *                                 but the operative range is never raised again, ever, by anything
 *                                 in this module.
 *
 * THE ONE EXCEPTION, and it is not an exception to the rule: a lane that has NO range at all when
 * the warm-up ends (the camera never saw that limb) may still receive its first one later. Going
 * from "cannot score at all" to "can score" does not raise a threshold; there was none.
 *
 * DIRECTION RULE at the adoption moment:
 *   - seeded from a SAVED range (a deliberate prior measurement): the learned range is adopted ONLY
 *     if it LOWERS the operative threshold. A therapist-measured range is better evidence than one
 *     gathered while chasing notes, so in-song learning may rescue a patient who cannot reach
 *     today's target — it may never raise a target that was properly measured.
 *   - seeded from the PROVISIONAL default: adopted whenever there is evidence. The default is an
 *     explicit placeholder — the most forgiving range the movement allows — not a measurement, and
 *     replacing it is the whole point.
 *
 * RULE 2 — NEVER PAST THE PATIENT'S OWN RANGE. The learner's top is a percentile OF THE PEAKS this
 * patient produced, so it can never exceed a value they actually reached. Nothing here adds to it.
 *
 * RULE 3 — THE RECORD SAYS HOW IT WAS MEASURED. Every range produced here carries
 * `measurement.method = 'in_song'`, which rides into `SessionResult.lanes[].calibrationMeasurement`,
 * the export and the trend exactly as the tracking-quality block does. See session/tracking.ts for
 * the grading and the comparison gate that keeps an in-song range from being silently subtracted
 * from a deliberately measured one.
 * ────────────────────────────────────────────────────────────────────────────────────────────────
 */
import type { LaneSpec, Movement } from '../engine/types.ts';
import type { VisionInput } from '../input/VisionInput.ts';
import {
  InSongRangeLearner,
  calibrationMismatch,
  calibrationProblem,
  isCalibrationValid,
  operativeThreshold,
} from '../vision/calibration.ts';
import type { CalibrationContext, RomCalibration } from '../vision/calibration.ts';
import type { CalibrationMode } from './types.ts';

/**
 * THE OPENING WINDOW, in song seconds from the first sample of audio.
 *
 * Long enough for a learner to see two or three repetitions in every lane at the pacing this app
 * prescribes (`DEFAULT_LANE_REST_SEC` 1.2 s, thinned by `WARMUP_LANE_REST_MULTIPLIER` inside the
 * window, so a lane is asked for a rep about every 3.6 s), and short enough that the patient spends
 * the overwhelming majority of the song against a target that is not moving. Twelve seconds of a
 * three-minute song is a twentieth of it.
 */
export const WARMUP_SEC = 12;

/**
 * How much further apart the warm-up's notes are than the therapist's own pacing floor.
 *
 * The opening has to be forgiving in the only way that matters to a patient: there must be TIME.
 * Missing while the app is still learning the range costs nothing that matters, but a dense opening
 * would still teach a patient in the first ten seconds that they cannot do this.
 */
export const WARMUP_LANE_REST_MULTIPLIER = 3;

/**
 * How much wider the judgment windows are inside the warm-up.
 *
 * A note answered with a movement that was measured against a provisional range is a note whose
 * timing is as uncertain as the range behind it, and on the in-song path the input latency has not
 * been measured on this device either (see `foldsInLatencyStep`). Doubling the windows for the
 * opening covers both; it is the same lever the therapist's `windowScale` already pulls, so nothing
 * new has to be understood to read it.
 */
export const WARMUP_WINDOW_SCALE = 2;

/** Sessions written before the choice existed all came through the range-of-motion screens. */
export function calibrationModeOf(config: { calibrationMode?: CalibrationMode }): CalibrationMode {
  return config.calibrationMode ?? 'measured';
}

/**
 * THE LATENCY METRONOME IS FOLDED IN ON THIS PATH, AND HERE IS THE ARGUMENT.
 *
 * The step is eight beats at 60 BPM — eight seconds of movement from the limb that is about to do
 * the session, for eight samples. What replaces it is not a guess: the engine already measures the
 * timing bias of EVERY judged crossing in the run (`RunSummary.suggestedLatencySec`,
 * `session/latencyAdvice.ts`), which on a three-minute chart is hundreds of samples of the same
 * quantity from the same pipeline — strictly more evidence than the eight. The Results screen
 * already offers that number, states what it replaces, and stores it with its provenance, so the
 * second session on a device is judged at a latency measured from the first.
 *
 * WHAT THE FIRST SESSION IS JUDGED AT, and why that is acceptable: the offset in force
 * (`DEFAULT_LATENCY_SEC`, 120 ms — the middle of the 80–200 ms pipeline this app documents) plus the
 * warm-up's doubled windows. `latencyAdvice.significant` is the project's own statement of when a
 * bias costs a patient anything: a bias smaller than ONE GOOD WINDOW costs nothing, because every
 * note still lands inside the window it was going to land in. At easy/medium the good window is
 * 180/140 ms and a fine-motor lane gets x1.6 on top, so a residual error of the size this default
 * can be wrong by does not move a judgment.
 *
 * It is folded in ONLY on the in-song path. A therapist who chose the controlled calibration is
 * choosing to measure, and the metronome is part of what they are choosing.
 */
export function foldsInLatencyStep(mode: CalibrationMode): boolean {
  return mode === 'in_song';
}

/** Where a lane's operative range came from — the range the session's percentages are against. */
export type LaneRangeSource =
  /** This patient's own stored range for this lane, which passed every context check. */
  | 'saved'
  /** The most forgiving range the movement allows, anchored on the patient's observed rest. */
  | 'provisional'
  /** Learned from the repetitions this patient performed in this song. */
  | 'learned'
  /** Nothing yet: the camera has not produced a usable frame for this lane. */
  | 'none';

export interface LaneSeed {
  /** `LaneSpec.index` of the lane this is for. */
  lane: number;
  movement: Movement;
  /** The range to start the song on, or null when there is no saved one to use. */
  cal: RomCalibration | null;
  source: LaneRangeSource;
  /**
   * Why a stored range was NOT used, when there was one and it was refused: a range measured on
   * another patient, another fingertip, the other mirror convention, another movement, or one too
   * narrow to be a calibration. Therapist-facing, and never swallowed — the session goes ahead on a
   * provisional range, and the reason the saved one was not good enough is shown.
   */
  refused: string | null;
}

/**
 * WHICH STORED RANGE, IF ANY, THIS LANE MAY START ON.
 *
 * THE REFUSALS ARE THE SAME REFUSALS. A range measured on a different patient, a different
 * fingertip, the other mirror convention or a different movement is not a degraded measurement of
 * this lane — it is a range of something else — and `isCalibrationValid` / `calibrationMismatch`
 * already say so for the whole app. Seeding does not get its own, looser, copy of that judgment: it
 * calls the same functions, and a range they refuse is dropped here rather than being handed to
 * VisionInput (which would refuse it again and leave the lane dead for the whole song).
 *
 * `ctxFor` is the lane's own CalibrationContext WITH the patient attached — derived, never
 * assembled by hand, exactly as everywhere else (`VisionInput.getCalibrationContext` + `withPatient`).
 */
export function seedCalibrations(
  lanes: readonly LaneSpec[],
  saved: readonly (RomCalibration | null | undefined)[],
  ctxFor: (laneIndex: number) => CalibrationContext | null | undefined,
): LaneSeed[] {
  return lanes.map((spec, i) => {
    const cal = saved[i] ?? null;
    const ctx = ctxFor(spec.index) ?? undefined;
    if (!cal) return { lane: spec.index, movement: spec.movement, cal: null, source: 'none', refused: null };
    if (isCalibrationValid(cal, spec.movement, ctx)) {
      return { lane: spec.index, movement: spec.movement, cal, source: 'saved', refused: null };
    }
    const mismatch = calibrationMismatch(cal, spec.movement, ctx);
    const refused = mismatch ? mismatch.reason : (calibrationProblem(cal, spec.movement, ctx) ?? 'the stored range is unusable');
    return { lane: spec.index, movement: spec.movement, cal: null, source: 'none', refused };
  });
}

/** What a lane's range is doing right now — everything a screen or a record needs to say it. */
export interface LaneCalibrationState {
  lane: number;
  movement: Movement;
  /** The range in force for this lane, or null when the camera has produced nothing to build one on. */
  cal: RomCalibration | null;
  source: LaneRangeSource;
  /** True once the warm-up has closed and this lane's range can no longer be raised. */
  frozen: boolean;
  /** Repetitions the learner has detected in this lane so far. */
  reps: number;
  /** Why a stored range was refused, when one was (see LaneSeed.refused). */
  refused: string | null;
}

export interface InSongCalibrationOptions {
  vision: VisionInput;
  lanes: readonly LaneSpec[];
  /** Seeds, in `lanes` order (from `seedCalibrations`). */
  seeds: readonly LaneSeed[];
  /** The difficulty's hit threshold — the fraction the operative threshold is computed with. */
  thresholdFraction: number;
  /** Song time now, in seconds. Negative (or -Infinity) before the song has started. */
  songTime: () => number;
  /** Song seconds at which the warm-up closes and the ranges freeze (default WARMUP_SEC). */
  warmupEndsAt?: number;
  /** The patient this session is recorded against, stamped on every learned range. */
  patientId?: string;
  /** Session id stamped on every learned range (provenance). */
  sessionId?: string;
  /** Wall clock for `capturedAt` (default Date.now). Injectable for tests. */
  now?: () => number;
}

interface LaneRuntime {
  spec: LaneSpec;
  learner: InSongRangeLearner;
  seed: LaneSeed;
  /** The range actually in force for this lane (null until one is installed). */
  cal: RomCalibration | null;
  source: LaneRangeSource;
  frozen: boolean;
}

/**
 * Drives the in-song learning for one session: feeds every lane's smoothed feature to its learner,
 * installs the provisional range as soon as there is a zero to anchor it on, adopts once at the end
 * of the warm-up, and then freezes.
 *
 * It is fed by `VisionInput.onFrame`, which hands over the SAME `LaneSample`s the play pipeline
 * produced — not a second extraction of the same landmarks. Calibration and play therefore see one
 * identical signal, which is the invariant the deliberate path states at the top of calibration.ts
 * and the only thing that makes `thresholdFraction` of ROM reachable at tempo.
 */
export class InSongCalibration {
  private readonly vision: VisionInput;
  private readonly lanes: LaneRuntime[];
  private readonly thresholdFraction: number;
  private readonly songTime: () => number;
  readonly warmupEndsAt: number;
  private detachFrames: (() => void) | null = null;
  private adopted = false;

  constructor(opts: InSongCalibrationOptions) {
    this.vision = opts.vision;
    this.thresholdFraction = opts.thresholdFraction;
    this.songTime = opts.songTime;
    this.warmupEndsAt = opts.warmupEndsAt ?? WARMUP_SEC;
    const now = opts.now;
    this.lanes = opts.lanes.map((spec, i) => {
      const seed = opts.seeds[i] ?? { lane: spec.index, movement: spec.movement, cal: null, source: 'none' as const, refused: null };
      const ctx = this.vision.getCalibrationContext(spec.index) ?? {};
      const learner = new InSongRangeLearner(spec.movement, {
        // The lane's own context, derived from the very feature options its extractor runs with, so
        // a range learned here records WHAT IT MEASURED and a later session can check it instead of
        // guessing. Exactly what `VisionInput.createCalibrator` does for the deliberate path.
        fingertip: ctx.fingertip,
        mirrored: ctx.mirrored,
        patient: opts.patientId,
        sessionId: opts.sessionId,
        ...(now ? { now } : {}),
      });
      return { spec, learner, seed, cal: seed.cal, source: seed.source, frozen: false };
    });
  }

  /**
   * Install the saved seeds and start consuming frames. Idempotent.
   *
   * The seeds go in HERE rather than through `ensureVision`, on purpose: a stored range that this
   * module refused (measured on another patient, another fingertip, the other limb) must never be
   * handed to VisionInput at all. Handing it over and letting VisionInput refuse it again would
   * leave the lane dead for the whole song, which is exactly the outcome the in-song path exists to
   * avoid — the lane gets a provisional range instead and the refusal is reported.
   */
  attach(): void {
    if (this.detachFrames) return;
    for (const l of this.lanes) {
      if (l.seed.cal) this.install(l, l.seed.cal, 'saved');
    }
    this.detachFrames = this.vision.onFrame((samples) => {
      for (let i = 0; i < this.lanes.length; i++) {
        const l = this.lanes[i];
        const s = samples[i];
        if (!s) continue;
        l.learner.push({ smoothed: s.smoothed, t: s.t });
      }
      this.update();
    });
  }

  /** Stop consuming frames. Idempotent; the ranges in force are kept. */
  detach(): void {
    this.detachFrames?.();
    this.detachFrames = null;
  }

  /** True once the warm-up has closed (the song time has passed `warmupEndsAt`). */
  isWarmedUp(): boolean {
    const t = this.songTime();
    return Number.isFinite(t) && t >= this.warmupEndsAt;
  }

  /**
   * One pass over the lanes: install what may be installed, adopt once when the warm-up closes.
   * Public so a test can drive it without a frame source.
   */
  update(): void {
    const warmedUp = this.isWarmedUp();
    for (const l of this.lanes) {
      if (!warmedUp) {
        // Before the warm-up closes: a lane with no range at all takes the provisional one the
        // moment its zero exists, which on a 30 fps stream is half a second into the count-in.
        if (l.cal === null) this.install(l, l.learner.provisional(), 'provisional');
        continue;
      }
      if (!l.frozen) {
        this.adopt(l);
        l.frozen = true;
        continue;
      }
      // FROZEN — with the one exception argued at the top of this file: a lane that still has no
      // range at all may receive its first. It had no threshold to raise.
      if (l.cal === null) this.install(l, l.learner.learned() ?? l.learner.provisional(), 'learned');
    }
    if (warmedUp) this.adopted = true;
  }

  /** The single adoption at the end of the warm-up. See the DIRECTION RULE at the top of this file. */
  private adopt(l: LaneRuntime): void {
    const learned = l.learner.learned();
    if (!learned) {
      // No evidence: whatever is in force stays in force. A lane the patient has not moved keeps the
      // forgiving provisional range rather than being given a target from nothing.
      if (l.cal === null) this.install(l, l.learner.provisional(), 'provisional');
      return;
    }
    if (l.cal !== null && l.source === 'saved') {
      // A deliberately measured range is better evidence than one gathered while chasing notes, so
      // it is only replaced when doing so makes the target EASIER — a patient who cannot reach
      // today what they reached on the calibration screen is rescued; one who can is left alone.
      const before = operativeThreshold(l.cal, this.thresholdFraction);
      const after = operativeThreshold(learned, this.thresholdFraction);
      if (!(after < before)) return;
    }
    this.install(l, learned, 'learned');
  }

  private install(l: LaneRuntime, cal: RomCalibration | null, source: LaneRangeSource): void {
    if (!cal) return;
    // The same vetting every other hand-over goes through. A range this module built for this lane
    // should always pass, and if it ever does not, the lane stays on what it had rather than going
    // dead: `setCalibration` returns false and the range is not recorded as in force.
    if (this.vision.setCalibration(l.spec.index, cal) === false) return;
    l.cal = cal;
    l.source = source;
  }

  /** True once the adoption moment has passed — the ranges are fixed for the rest of the song. */
  isFrozen(): boolean {
    return this.adopted;
  }

  /** Live per-lane state, in `lanes` order. */
  states(): LaneCalibrationState[] {
    return this.lanes.map((l) => ({
      lane: l.spec.index,
      movement: l.spec.movement,
      cal: l.cal,
      source: l.source,
      frozen: l.frozen,
      reps: l.learner.repsDetected(),
      refused: l.seed.refused,
    }));
  }

  /**
   * The ranges that were IN FORCE, in `lanes` order — the denominators every percentage in this
   * session's record is taken against, which is what `buildSessionResult` must be handed. Not the
   * best range the learner could build with hindsight: a record whose denominator is not the number
   * the patient actually played against is not a record of this session.
   */
  ranges(): (RomCalibration | null)[] {
    return this.lanes.map((l) => l.cal);
  }

  /** Reasons stored ranges were refused, one line per lane that had one. */
  refusals(): { lane: number; movement: Movement; reason: string }[] {
    const out: { lane: number; movement: Movement; reason: string }[] = [];
    for (const l of this.lanes) {
      if (l.seed.refused) out.push({ lane: l.spec.index, movement: l.spec.movement, reason: l.seed.refused });
    }
    return out;
  }
}
