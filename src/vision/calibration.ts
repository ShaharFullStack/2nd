/**
 * ROM calibration state machine.
 *   'rest'  : patient holds still: the last `restDurationSec` of samples (>= minRestSamples, and still)
 *             -> min = median(rest window). Compensation quantities measured over the same window
 *             -> compensationBaseline (medians).
 *   'move'  : patient performs `reps` comfortable reps -> max = 90th percentile of detected peaks
 *   'done'  : RomCalibration available (or error 'insufficient_range' with guidance)
 * Peaks are found with a simple prominence rule: a rise of >= prominence above the last trough starts a
 * candidate; the candidate's running maximum becomes a peak once the value drops >= prominence below it.
 *
 * SIGNAL PATH: feed the calibrator the SAME smoothed feature the play pipeline uses (LanePipeline /
 * `pushSample`), never the raw extractor output, so the calibrated range and the played value see an
 * identical filter and thresholdFraction of ROM is reachable at tempo.
 */
import type { Movement } from '../engine/types.ts';
import { DEFAULT_FINGERTIP, MOVEMENT_INFO, POSTURE_INFO, baselineFromSamples } from './features.ts';
import type { CompensationBaseline, CompensationSample, FeatureOptions, MovementPosture } from './features.ts';
import { clamp01 } from './landmarks.ts';
import type { Fingertip } from './landmarks.ts';
import { median, percentile } from './stats.ts';

export { median, percentile };

/**
 * What the rest window that produced `min` actually looked like.
 *
 * `min` is the ZERO the whole session is normalized from, and until this existed the fact that it might
 * be the median of a swinging baseline was ERASED rather than recorded: the rest phase auto-advances
 * after `restTimeoutSec` whether or not the patient ever held still, and the status then claimed
 * `restStill: true` because that flag only ever meant "still, right now, during the rest phase". Eleven
 * seconds of rest oscillating by half of seated_march's entire minimum ROM produced a calibration
 * indistinguishable from a clean one. It is now measured, carried with the calibration, and used:
 * `spread` is the noise floor the range has to stand out from (see requiredRom).
 */
export interface RestQuality {
  /** True when the window was accepted because it was STILL; false when the rest phase timed out. */
  still: boolean;
  /** 10th..90th percentile spread of the rest window (feature units) — the noise `min` sits in. */
  spread: number;
  /** Second-half median minus first-half median (feature units): baseline drift across the window. */
  drift: number;
  /** Seconds of rest actually observed in the window. */
  durationSec: number;
  /** Feature samples in the window. */
  samples: number;
}

export interface RomCalibration {
  /** Feature value at rest. */
  min: number;
  /** Feature value at comfortable maximum. */
  max: number;
  /** Number of feature samples that contributed. */
  samples: number;
  /** Detected rep peaks (feature units), for therapist review. */
  peaks?: number[];
  movement?: Movement;
  /** Rest-phase compensation baseline (median over the rest window), when the movement monitors one. */
  compensationBaseline?: CompensationBaseline | null;
  /** True when a therapist adjusted the range by hand (nudge/setRange) rather than it being measured. */
  manual?: boolean;
  /** Quality of the rest window `min` came from (absent for a hand-built / legacy calibration). */
  rest?: RestQuality | null;
  /** Date.now() when the calibration was captured — provenance, so a stale one can be spotted. */
  capturedAt?: number;
  /**
   * The posture the patient was in when it was captured (derived from the movement). A wrist_extension
   * range measured with the hand over the table edge normalizes nothing meaningful in a palm-to-camera
   * session, and without this the Setup screen could not tell.
   */
  posture?: MovementPosture;
  /**
   * finger_opposition ONLY: which fingertip was opposed while the range was measured.
   *
   * The therapist may choose the fingertip (docs/ARCHITECTURE.md:77) and the feature is
   * `1 - tip-to-thumb distance / palm size` for THAT tip, so an index range and a pinky range are ranges
   * of DIFFERENT QUANTITIES: a hand that can pinch its index to the thumb reaches ~1.0, while the same
   * hand pinching the (shorter, further) pinky peaks well below the index range's max. Playing one
   * against the other silently normalizes the wrong thing — a full pinch that reads 0.51 against a 0.65
   * threshold, i.e. a lane that cannot score all song with nothing to explain it. Recorded here so
   * `calibrationProblem` can refuse the pairing, exactly as it refuses a range measured for another
   * movement. Absent on a legacy/hand-built calibration, which is reported as a warning, not a refusal.
   */
  fingertip?: Fingertip;
  /**
   * The mirror convention the frames were measured under (FeatureOptions.mirrored; false = raw camera).
   *
   * THIS SELECTS THE LIMB, in BOTH modes, which is why it belongs on the calibration and not only on the
   * pipeline. On flipped frames Pose reports the patient's left leg in the RIGHT_* landmark slots
   * (poseSideIndices swaps them back) and the Hands model's "Left"/"Right" label means the opposite hand
   * (labelToPatientSide inverts it). So the SAME lane spec (`seated_march`/`left`) measured under the two
   * conventions measures the two DIFFERENT LEGS — and for the hemiparetic patient this game is for, the
   * unaffected limb's range is exactly the one that makes the affected lane unplayable (or trivially
   * playable). A stored range carries this so a later session under the other convention is refused
   * instead of silently normalizing one limb by the other's ROM. Absent on a legacy / hand-built
   * calibration, which is reported as a warning (not a refusal) when the lane is not on the default.
   */
  mirrored?: boolean;
  /** Session it was captured in, when the caller supplies one (localStorage history / therapist notes). */
  sessionId?: string;
  /**
   * WHOSE BODY this range was measured on (Patient.id).
   *
   * The last thing in this list that selects what the numbers mean, and the one that was missing.
   * `movement`, `fingertip` and `mirrored` establish WHICH QUANTITY and WHICH LIMB; none of them
   * establishes WHOSE. A clinic tablet is shared, ranges are offered back as "last session's range",
   * and one hemiparetic patient's calibrated knee extension handed to the next patient normalizes one
   * person's movement by another person's range: every percentage in the record is then wrong, the
   * lane is unplayable or trivially playable, and nothing on screen says why. Absent on a legacy /
   * hand-built calibration, which is warned about, not refused.
   */
  patient?: string;
}

/**
 * What the LANE is configured to measure right now, for the checks that compare a stored calibration
 * against the session about to use it. Only the options that change WHICH QUANTITY is measured belong
 * here (see FeatureOptions): a visibility gate or an aspect correction does not make a range wrong.
 */
export interface CalibrationContext {
  /** finger_opposition: the fingertip this lane opposes in play (default DEFAULT_FINGERTIP). */
  fingertip?: Fingertip;
  /** The mirror convention the lane plays under (default DEFAULT_MIRRORED = false). Selects the LIMB. */
  mirrored?: boolean;
  /**
   * The patient this session is recorded against (Patient.id) — WHOSE body the lane is measuring.
   *
   * Unlike `fingertip` and `mirrored` this cannot be derived from the feature options: nothing about a
   * landmark stream says who the person in front of the camera is. It is attached by the screen that
   * knows (`withPatient`), and left undefined by every caller that does not — an undefined context
   * patient means "the caller did not say", which can never refuse anything.
   */
  patient?: string;
}

/**
 * The lane's context WITH the patient it is being measured for attached.
 *
 * The one place a patient joins a CalibrationContext. `calibrationContext()` derives a context from
 * the feature options an extractor runs with, and the patient is not one of them (see above), so a
 * screen that knows the patient wraps the derived context here rather than assembling a literal —
 * which is the drift this file exists to prevent.
 */
export function withPatient(ctx: CalibrationContext | null | undefined, patient: string | null | undefined): CalibrationContext {
  const base: CalibrationContext = { ...(ctx ?? {}) };
  if (patient) base.patient = patient;
  else delete base.patient;
  return base;
}

/** The mirror convention assumed when nothing says otherwise: raw (un-flipped) camera frames. */
export const DEFAULT_MIRRORED = false;

/**
 * The CalibrationContext a lane measuring `movement` with these feature options is in.
 *
 * EVERY consumer must derive its context THROUGH THIS FUNCTION rather than assembling a literal. The
 * bug this file exists to prevent was exactly two hand-built literals that drifted apart: the
 * constructor path passed `{ fingertip }` and the runtime hand-over (`VisionInput.setCalibration`)
 * passed nothing, so a therapist-chosen fingertip made the same calibration valid on one path and
 * invalid on the other. One derivation, from the very options the feature extractor is given, is the
 * only thing that keeps them equal — including when a new quantity-selecting option is added here.
 *
 * WHAT IS IN, AND WHY THE REST IS NOT. Only options that change WHICH QUANTITY (or which limb) is
 * measured: `fingertip` (index vs pinky are different distances) and `mirrored` (the two conventions
 * measure OPPOSITE limbs). `minVisibility` is a gate — it decides whether a frame is measured at all,
 * not what the number means. `xScale` is an aspect CORRECTION whose whole purpose is to make the
 * feature identical on every camera, so a range measured with the correct one is comparable across
 * cameras. `worldLandmarks` is per-frame input. None of those make a stored range wrong.
 *
 * The fields are deliberately named like `CalibratorOptions`' so a calibration screen can spread the
 * context straight into the calibrator that will MEASURE the range (`new RomCalibrator(m, {...ctx})`),
 * which is what stamps it onto the result and closes the loop.
 */
export function calibrationContext(movement: Movement, opts?: Pick<FeatureOptions, 'fingertip' | 'mirrored'> | null): CalibrationContext {
  const ctx: CalibrationContext = { mirrored: opts?.mirrored ?? DEFAULT_MIRRORED };
  if (movement === 'finger_opposition') ctx.fingertip = opts?.fingertip ?? DEFAULT_FINGERTIP;
  return ctx;
}

/**
 * The fingertip mismatch between a stored calibration and the lane about to use it, or null when there
 * is none (not a finger_opposition calibration, no fingertip recorded, or the two agree).
 */
export function fingertipMismatch(cal: CalibrationRange | null | undefined, movement: Movement, ctx?: CalibrationContext): { calibrated: Fingertip; playing: Fingertip } | null {
  if (!cal || movement !== 'finger_opposition' || cal.fingertip === undefined) return null;
  const playing = ctx?.fingertip ?? DEFAULT_FINGERTIP;
  return cal.fingertip === playing ? null : { calibrated: cal.fingertip, playing };
}

/**
 * The mirror-convention mismatch between a stored calibration and the lane about to use it, or null
 * when there is none (nothing recorded — a legacy calibration — or the two agree).
 *
 * Applies to BOTH modes: on flipped frames the leg landmarks arrive under the other side's indices and
 * the hand labels mean the other hand, so either way the stored range belongs to the OTHER LIMB.
 */
export function mirrorMismatch(cal: CalibrationRange | null | undefined, ctx?: CalibrationContext): { calibrated: boolean; playing: boolean } | null {
  if (!cal || cal.mirrored === undefined) return null;
  const playing = ctx?.mirrored ?? DEFAULT_MIRRORED;
  return cal.mirrored === playing ? null : { calibrated: cal.mirrored, playing };
}

/** How a frame convention reads to a therapist. */
function mirrorLabel(mirrored: boolean): string {
  return mirrored ? 'a mirrored (selfie-flipped) camera image' : 'a raw (un-mirrored) camera image';
}

/**
 * The patient mismatch between a stored calibration and the session about to use it, or null when
 * there is none (nothing recorded on either side — a legacy range, or a caller that did not say who
 * this is — or the two agree).
 */
export function patientMismatch(cal: CalibrationRange | null | undefined, ctx?: CalibrationContext): { calibrated: string; playing: string } | null {
  if (!cal || cal.patient === undefined || !ctx?.patient) return null;
  return cal.patient === ctx.patient ? null : { calibrated: cal.patient, playing: ctx.patient };
}

/** Which lane configuration option a stored calibration disagrees with. */
export type CalibrationMismatchField = 'patient' | 'movement' | 'fingertip' | 'mirrored';

/**
 * A stored calibration that measures a DIFFERENT QUANTITY (or a different limb) from the lane about to
 * use it — not a degraded measurement, so there is nothing to salvage and the therapist has to know
 * what to do about it. `reason` is therapist-facing and always ends in the action to take.
 */
export interface CalibrationMismatch {
  field: CalibrationMismatchField;
  reason: string;
}

/**
 * The reason this stored range does not describe what this lane measures, or null when it does.
 *
 * ONE function, used by isCalibrationValid / calibrationProblem and by anything that offers a SAVED
 * calibration for reuse (the Setup screen's "use the previous range", a calibration reloaded from
 * localStorage in a later session whose lane options differ). The alternative — each caller comparing
 * the fields it happens to remember — is the bug class this whole file guards against.
 */
export function calibrationMismatch(cal: CalibrationRange | null | undefined, movement: Movement, ctx?: CalibrationContext): CalibrationMismatch | null {
  if (!cal) return null;
  // WHOSE BODY, first: a range measured on another person is not a degraded measurement of this one,
  // and no amount of agreement about movement, digit and mirror convention makes it one.
  const who = patientMismatch(cal, ctx);
  if (who) {
    return {
      field: 'patient',
      reason:
        'it was measured on a different patient, and a range of motion is one person\u2019s — normalizing this ' +
        'patient\u2019s movement by another patient\u2019s range makes every percentage in the record wrong. ' +
        'Re-calibrate this lane for the patient this session is recorded against',
    };
  }
  const tip = fingertipMismatch(cal, movement, ctx);
  if (tip) {
    // Same class of error as a range measured for another movement: the two numbers are ranges of
    // different quantities, so normalizing one with the other is not a degraded measurement.
    return {
      field: 'fingertip',
      reason: `it was measured opposing the ${tip.calibrated} finger, but this lane opposes the ${tip.playing} finger — re-calibrate this lane on the ${tip.playing} finger`,
    };
  }
  if (cal.movement && cal.movement !== movement) {
    // Ranges are in the MOVEMENT'S OWN unit (degrees vs frame-height ratio): normalizing one movement's
    // feature by another's range is not a degraded measurement, it is a different quantity.
    return {
      field: 'movement',
      reason: `it was measured for ${MOVEMENT_INFO[cal.movement].label.toLowerCase()}, not ${MOVEMENT_INFO[movement].label.toLowerCase()} — re-calibrate this lane`,
    };
  }
  const mir = mirrorMismatch(cal, ctx);
  if (mir) {
    return {
      field: 'mirrored',
      reason:
        `it was measured on ${mirrorLabel(mir.calibrated)} and this session runs on ${mirrorLabel(mir.playing)} — ` +
        'the two conventions swap which side the landmarks belong to, so this range describes the OTHER limb. ' +
        'Re-calibrate this lane, or set the mirror option back to the one it was measured with',
    };
  }
  return null;
}

/**
 * How many times the rest-window noise the calibrated range must span.
 *
 * WHY 3, AND WHY THIS EXISTS AT ALL. `minRom` is a fixed absolute constant with no relation to the noise
 * it is guarding against. On the automatic path the stillness guard bounds the rest spread at
 * `stillnessFraction` (0.35) of minRom, which INCIDENTALLY bounds the signal-to-noise ratio at ~1/0.35 ≈
 * 3 — but nothing bounds it after a rest timeout, or through setManualRange()/getProvisional(). This
 * makes that incidental ~3 explicit and applies it everywhere, which cuts both ways:
 *   - a hemiparetic patient with a SMALL BUT PERFECTLY CLEAN range (seated_march ROM 0.11 against the
 *     0.12 floor) is no longer told "Not enough movement was detected" and rescued by hand — a still
 *     rest window earns them a floor of half the nominal minRom;
 *   - a NOISY WIDE range (rest swinging ±0.06, i.e. a spread of ~0.11) is rejected even at a range of
 *     0.3, because 0.3 is less than 3× the noise its own zero is buried in.
 * At 3 the still-window auto path is unchanged (3 × 0.35 × minRom ≈ minRom); only the unbounded paths
 * and the clean small-ROM patient move.
 */
/**
 * Default step of the therapist's Easier/Harder buttons: 5 % OF THE MEASURED RANGE (max − min), in
 * whatever units the movement is in. See `RomCalibrator.previewNudgeTop`.
 */
export const ROM_NUDGE_FRACTION = 0.05;

/** Why a nudge stopped short of what was asked for. */
export type RomNudgeLimit = 'ok' | 'patient_best' | 'minimum_range' | 'no_range' | 'below_precision';

/** What an Easier/Harder press would do — everything the button needs to label itself. */
export interface RomNudgePreview {
  /** Signed change in feature units that would actually be applied (0 when `disabled`). */
  delta: number;
  currentMax: number;
  nextMax: number;
  /** The largest value this patient actually produced, or null when nothing was measured. */
  patientBest: number | null;
  /** The lowest top that still leaves a range distinguishable from rest noise. */
  floorMax: number;
  limit: RomNudgeLimit;
  /** True when pressing would change nothing (already at a bound, or no range yet). */
  disabled: boolean;
  /** Button-ready text: what the press will do, in the movement's own units. */
  label: string;
  /** Why it is capped, when it is. */
  note: string | null;
}

/**
 * The Easier/Harder maths, with no calibrator attached.
 *
 * Shared by `RomCalibrator.previewNudgeTop` (a range being measured now) and `previewRomNudge` (a
 * range already accepted for a lane — including one reused from a previous session, which no live
 * calibrator holds). Both must answer identically: the therapist presses ONE button and cannot know
 * which object is behind it.
 */
function buildNudgePreview(opts: {
  min: number | null;
  max: number | null;
  movement: Movement;
  patientBest: number | null;
  requiredRange: number;
  fraction: number;
}): RomNudgePreview {
  const { min, max, movement, patientBest, requiredRange, fraction } = opts;
  const unit = MOVEMENT_INFO[movement].unit;
  if (min === null || max === null || !Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(fraction) || fraction === 0) {
    return {
      delta: 0,
      currentMax: max ?? Number.NaN,
      nextMax: max ?? Number.NaN,
      patientBest,
      floorMax: Number.NaN,
      limit: 'no_range',
      disabled: true,
      label: fraction < 0 ? 'Easier' : 'Harder',
      note: 'No range has been measured for this lane yet.',
    };
  }
  const span = max - min;
  const wanted = max + fraction * span;
  const floorMax = min + requiredRange;
  let next = wanted;
  // RAISING IS BOUNDED BY EVIDENCE. With peaks on record the ceiling is the best rep the patient
  // actually produced; with NO peaks on record (a range typed in by hand, or a legacy stored one)
  // there is no evidence of anything above the current top, so the top is the ceiling and the button
  // says why. A target nobody has ever reached is not a harder exercise, it is an unplayable lane.
  if (fraction > 0) next = patientBest === null ? max : Math.min(wanted, Math.max(patientBest, max));
  // EASIER NEVER RAISES THE TARGET. The floor stops a range being shrunk below what can be told from
  // rest noise — but on a range that is ALREADY below it, `max(wanted, floorMax)` moved the top UP:
  // the button labelled "Easier" offered to take a 0.32 top to 0.42, which is a harder exercise, on
  // exactly the impaired lane that produced too small a range in the first place.
  if (fraction < 0) next = Math.min(max, Math.max(wanted, floorMax));
  const eps = Math.max(1e-9, Math.abs(span) * 1e-9);
  // WHAT THE BUTTON WILL PRINT, at a precision that shows the move. If even four decimals cannot
  // separate the two numbers the press is invisible to the therapist AND to the patient, so it is
  // not offered: a live button that says it will turn 0.33 into 0.33 is worse than a dead one.
  const [maxStr, nextStr] = formatFeaturePair(max, next, unit);
  const belowPrecision = Math.abs(next - max) > eps && maxStr === nextStr;
  const disabled = Math.abs(next - max) <= eps || belowPrecision;
  const pct = `${Math.abs(Math.round(fraction * 100))}%`;
  const verb = fraction < 0 ? 'Easier' : 'Harder';
  /** The lane's range is already below the minimum usable one: there is nothing to give back. */
  const belowFloor = fraction < 0 && max < floorMax - eps;
  let limit: RomNudgeLimit = 'ok';
  if (fraction > 0 && next < wanted - eps) limit = 'patient_best';
  else if (fraction < 0 && next > wanted + eps) limit = 'minimum_range';
  if (belowPrecision && limit === 'ok') limit = 'below_precision';
  const noEvidence = fraction > 0 && patientBest === null;
  const label = disabled
    ? `${verb} — ${
        noEvidence
          ? `no rep on record above ${formatFeature(max, unit)}`
          : limit === 'below_precision'
            ? `a step is smaller than this measurement can show (${maxStr})`
            : limit === 'patient_best'
              ? `already at this patient's best (${formatFeature(patientBest ?? max, unit)})`
              : belowFloor
                ? `this range is already smaller than a usable one (it needs a top of ${formatFeature(floorMax, unit)})`
                : `already at the smallest usable range (${formatFeature(floorMax, unit)})`
      }`
    : `${verb} — target ${maxStr} → ${nextStr} (${fraction < 0 ? '−' : '+'}${pct} of the measured range)`;
  const note = limit === 'below_precision'
    ? `A ${pct} step on a range this small is ${maxStr} either way once it is written down — there is nothing to press. Re-measure the lane if the range itself is wrong.`
    : noEvidence
    ? `This range carries no record of the reps behind it (it was set by hand or saved by an older version), so there is nothing above ${formatFeature(max, unit)} that this patient is known to have reached. Re-measure the lane to raise the target.`
    : limit === 'patient_best'
      ? `Capped at ${formatFeature(patientBest ?? max, unit)} — the most this patient reached during calibration. A target above that has never been produced.`
      : belowFloor
        ? `This lane's range is already below the ${formatFeature(floorMax, unit)} top the movement needs to be told from rest noise, so it cannot be made smaller — re-measure the lane, or ask for a larger movement.`
        : limit === 'minimum_range'
          ? `Held at ${formatFeature(floorMax, unit)} — any smaller and the range cannot be told from rest noise.`
          : null;
  return { delta: next - max, currentMax: max, nextMax: next, patientBest, floorMax, limit, disabled, label, note };
}

/** The best rep evidenced by a STORED range: the largest detected peak, or null when none was kept. */
export function calibrationPatientBest(cal: Pick<RomCalibration, 'peaks'>): number | null {
  let best = -Infinity;
  for (const p of cal.peaks ?? []) if (p > best) best = p;
  return Number.isFinite(best) ? best : null;
}

/**
 * What Easier/Harder would do to a range THE LANE ALREADY HOLDS — the form the Calibration screen
 * uses, because the accepted range may have been reused from a previous session (no live calibrator
 * ever measured it) and the therapist may nudge the same lane several times.
 *
 * `fraction` is a fraction OF THE MEASURED RANGE (max − min), never an absolute feature delta: the
 * old buttons added ±0.05 in feature units to every movement alike, which is a sixth of a
 * hemiparetic seated march and a twentieth of a degree of knee extension under the same "5 %" label.
 */
export function previewRomNudge(
  cal: RomCalibration,
  movement: Movement,
  fraction: number = ROM_NUDGE_FRACTION,
): RomNudgePreview {
  // A legacy / hand-built range carries no movement of its own; the LANE always knows what it is
  // measuring, and the units of the label come from that.
  const mv = cal.movement ?? movement;
  return buildNudgePreview({
    min: cal.min,
    max: cal.max,
    movement: mv,
    patientBest: calibrationPatientBest(cal),
    requiredRange: requiredRom(mv, cal.rest),
    fraction,
  });
}

/**
 * Apply `previewRomNudge` to a stored range, returning a NEW calibration (the input is never
 * mutated) marked `manual` — a therapist-set target is not a measured one and the record says so.
 * When the preview is disabled the calibration is returned unchanged.
 */
export function applyRomNudge(
  cal: RomCalibration,
  movement: Movement,
  fraction: number = ROM_NUDGE_FRACTION,
): { calibration: RomCalibration; preview: RomNudgePreview } {
  const preview = previewRomNudge(cal, movement, fraction);
  if (preview.disabled) return { calibration: cal, preview };
  return { calibration: { ...cal, max: preview.nextMax, manual: true }, preview };
}

/** A feature value in the movement's own units, for a therapist to read. */
export function formatFeature(value: number, unit: 'deg' | 'ratio'): string {
  if (!Number.isFinite(value)) return '—';
  return unit === 'deg' ? `${Math.round(value)}°` : value.toFixed(2);
}

/** Decimal places `formatFeature` uses, and the most a label may widen to (see `formatFeaturePair`). */
const FEATURE_DP: Readonly<Record<'deg' | 'ratio', number>> = Object.freeze({ deg: 0, ratio: 2 });
const FEATURE_MAX_DP = 4;

const atPrecision = (value: number, unit: 'deg' | 'ratio', dp: number): string =>
  unit === 'deg' ? `${value.toFixed(dp)}°` : value.toFixed(dp);

/**
 * Print two feature values at whatever precision it takes to TELL THEM APART.
 *
 * A button whose label reads "target 0.33 → 0.33" teaches the therapist nothing about what pressing
 * it does — and that is what `formatFeature`'s two decimal places produced for a real seated-march
 * nudge (0.3125 → 0.3256, a 4 % move on a body-scaled ratio). Degrees have the same failure one step
 * down (48.0° → 48.4° both print "48°"). The pair is widened by up to two extra places until the two
 * strings differ; if they still do not, the change is below what the measurement can express at all
 * and the caller disables the button rather than printing an identity.
 */
export function formatFeaturePair(a: number, b: number, unit: 'deg' | 'ratio'): [string, string] {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return [formatFeature(a, unit), formatFeature(b, unit)];
  const base = FEATURE_DP[unit];
  for (let dp = base; dp <= FEATURE_MAX_DP; dp++) {
    const sa = atPrecision(a, unit, dp);
    const sb = atPrecision(b, unit, dp);
    if (sa !== sb || dp === FEATURE_MAX_DP) return [sa, sb];
  }
  /* istanbul ignore next — the loop always returns */
  return [formatFeature(a, unit), formatFeature(b, unit)];
}

/**
 * WHAT THE NUMBER IS, for any screen that prints a bare feature value.
 *
 * `formatFeature` puts a degree sign on an angle and nothing at all on a ratio, because a ratio has
 * no symbol — which left a Results headline reading "0.34" with no statement anywhere of what 0.34
 * is a measure of. Every screen that shows a feature must be able to say it in words; this is the
 * words.
 */
export const FEATURE_UNIT_NOTE: Readonly<Record<'deg' | 'ratio', string>> = Object.freeze({
  deg: 'degrees at the joint',
  ratio: 'body-scaled ratio — the movement measured against this patient’s own torso (or palm) size, so it is comparable across sessions and cameras',
});

/** Short form of the above, for a caption that has no room for the sentence. */
export const FEATURE_UNIT_SHORT: Readonly<Record<'deg' | 'ratio', string>> = Object.freeze({
  deg: 'degrees',
  ratio: 'body-scaled ratio',
});

export const MIN_ROM_SNR = 3;

/**
 * The absolute floor never drops below this fraction of the movement's nominal minRom, however clean the
 * rest window is: at some point a range is too small to be a movement rather than a measurement, and the
 * feature's own quantization (landmark jitter of a fraction of a pixel) is not modelled by `spread`.
 */
export const SMALL_ROM_FLOOR_FRACTION = 0.5;

/**
 * A calibration older than this (6 h) is reported as stale: the camera has been moved, the chair is at a
 * different distance, the patient is sitting differently. It is a WARNING, not a refusal — a therapist
 * re-using this morning's range on purpose is legitimate — but it must be visible on the Setup screen.
 */
export const CALIBRATION_STALE_MS = 6 * 60 * 60 * 1000;

/** The (min, max) part of a calibration plus whatever provenance is available to judge it. */
export type CalibrationRange = Pick<RomCalibration, 'min' | 'max'> & Partial<RomCalibration>;

/**
 * The range this movement actually has to span for a calibration to be usable: the larger of the
 * absolute floor and MIN_ROM_SNR times the measured rest noise. With no rest measurement (a legacy or
 * hand-built calibration) it is exactly the movement's nominal minRom, as before.
 */
export function requiredRom(movement: Movement, rest?: RestQuality | null): number {
  const nominal = MOVEMENT_INFO[movement].minRom;
  if (!rest || !Number.isFinite(rest.spread) || rest.spread < 0) return nominal;
  // A window that was never still gets NO relaxation of the absolute floor - only the SNR tightening.
  const floor = rest.still ? nominal * SMALL_ROM_FLOOR_FRACTION : nominal;
  return Math.max(floor, rest.spread * MIN_ROM_SNR);
}

export type CalibrationPhase = 'rest' | 'move' | 'done';
export type CalibrationError = 'insufficient_range' | 'no_reps';

export interface CalibrationStatus {
  phase: CalibrationPhase;
  /** 0..1 progress of the rest hold. */
  restProgress: number;
  /**
   * During 'rest': whether the trailing window is still enough to be used. AFTER the rest phase: whether
   * the window that actually produced `min` was still — FALSE when the phase auto-advanced on
   * `restTimeoutSec` with the patient never settling. It used to read `true` in that case, which erased
   * the single most important caveat about the session's zero.
   */
  restStill: boolean;
  /** The rest window `min` came from (live window while in 'rest'), or null before any rest sample. */
  rest?: RestQuality | null;
  /** Non-fatal concerns a therapist screen should show (unsteady zero, drift, manual range). */
  warnings?: string[];
  /** Reps detected so far in the move phase. */
  repsDetected: number;
  repsRequired: number;
  /** Provisional / final min and max. */
  min: number | null;
  max: number | null;
  error: CalibrationError | null;
  /** Human guidance for the current state. */
  message: string;
  /** Samples fed to the current phase. */
  samples: number;
}

export interface CalibratorOptions {
  /** Seconds of rest samples to collect (default 2). */
  restDurationSec?: number;
  /** Minimum number of rest samples before the rest phase may end (default 30, i.e. >= 1 s at 30 fps). */
  minRestSamples?: number;
  /**
   * Stillness guard: the rest window's 10th..90th percentile spread must be below this fraction of
   * minRom before auto-advancing (default 0.35). The window keeps sliding until the patient is still.
   *
   * WHY 0.35 AND NOT MORE: `min` is the MEDIAN of this window and every normalized value in the session
   * is measured from it. At 0.75 a rest window drifting 42% of seated_march's minimum ROM counted as
   * "still", so `min` was a median over a moving target and the whole normalization could be biased by
   * a third of the guard value — the patient then plays a game whose zero is somewhere inside their
   * movement. Spread alone is also not enough: a slow, steady drift has a small spread at every instant,
   * so `restDriftFraction` additionally bounds the trend across the window.
   */
  stillnessFraction?: number;
  /**
   * Trend guard: |median(first half of the rest window) - median(second half)| must be below this
   * fraction of minRom (default 0.2). Catches a steadily drifting rest position, which a percentile
   * spread over the same window barely registers.
   */
  restDriftFraction?: number;
  /** Give up waiting for stillness and advance after this many seconds of rest (default 10). */
  restTimeoutSec?: number;
  /** Reps to collect (default 3). */
  reps?: number;
  /** Override the per-movement minimum ROM (feature units). */
  minRom?: number;
  /** Peak prominence in feature units (default 0.5 * minRom). */
  prominence?: number;
  /** Percentile (0..1) of peaks used as max (default 0.9). */
  peakPercentile?: number;
  /** Automatically advance rest -> move once the rest window is full (default true). */
  autoAdvance?: boolean;
  /** Maximum seconds in the move phase before giving up with 'no_reps' (default 30). */
  moveTimeoutSec?: number;
  /**
   * finger_opposition: the fingertip being opposed while this range is measured (default 'index').
   * Stamped on the produced RomCalibration so a session that plays a DIFFERENT fingertip is refused
   * instead of silently normalizing one quantity by another's range (see fingertipMismatch).
   */
  fingertip?: Fingertip;
  /**
   * The mirror convention the frames being measured are in (see RomCalibration.mirrored). Stamped on the
   * produced calibration so a later session under the OTHER convention is refused rather than playing
   * the unaffected limb's range on the affected limb. Omitted = not recorded (legacy behaviour).
   * A calibration screen should pass the lane's own context: `new RomCalibrator(m, { ...ctx })`.
   */
  mirrored?: boolean;
  /** Wall clock for the calibration's `capturedAt` provenance (default Date.now). Injectable for tests. */
  now?: () => number;
  /** Session id stamped on the produced calibration (provenance for the localStorage history). */
  sessionId?: string;
  /**
   * The patient whose body is being measured (Patient.id), stamped on the produced calibration so a
   * later session for a DIFFERENT patient is refused instead of normalizing one person's movement by
   * another person's range. A calibration screen passes the lane's context with the patient attached:
   * `new RomCalibrator(m, { ...withPatient(ctx, patientId) })`.
   */
  patient?: string;
}

/** What the calibrator consumes per frame (LanePipeline's LaneSample satisfies this). */
export interface CalibrationSample {
  /** Smoothed feature (null when tracking was lost this frame). */
  smoothed: number | null;
  /** Sample time (seconds). */
  t: number;
  /** Raw compensation quantities for the frame, if the movement monitors any. */
  compensationSample?: CompensationSample | null;
}

/** clamp((feature - min)/(max - min), 0, 1). Returns 0 for a degenerate range. */
export function normalizeFeature(cal: Pick<RomCalibration, 'min' | 'max'>, feature: number): number {
  return clamp01(normalizeFeatureRaw(cal, feature));
}

/**
 * (feature - min)/(max - min) WITHOUT the 0..1 clamp. Returns 0 for a degenerate range.
 * Cross-session ROM gain is the therapeutic outcome, so a patient who outgrows their calibration must
 * stay measurable: the clamped value drives thresholds/meters, this one drives the recorded metrics
 * (LaneRepEvent.rawPeak / LaneInputEvent.rawStrength).
 */
export function normalizeFeatureRaw(cal: Pick<RomCalibration, 'min' | 'max'>, feature: number): number {
  const range = cal.max - cal.min;
  if (!(range > 1e-9)) return 0;
  return (feature - cal.min) / range;
}

/**
 * True when a calibration spans at least the movement's minimum ROM (its `minRom`), i.e. when
 * normalizing against it is meaningful.
 *
 * THIS IS A BOUNDARY CHECK, NOT A FORMALITY. `setManualRange` accepts anything, `reconcile` only keeps
 * max above min by 1e-6, `getProvisional` hands back the range of an ERRORED calibration, and a stale
 * calibration can arrive from localStorage months later. Any of those can produce a range of, say,
 * 0.001 on seated_march (minRom 0.12) — and then 1% of the patient's real ROM is a full-scale hit, so
 * hand tremor scores. Every consumer that turns a feature into a SCORE must run this first; VisionInput
 * does, and refuses to play a lane that fails (see VisionInput.getInvalidCalibrationLanes).
 */
export function isCalibrationValid(cal: CalibrationRange | null | undefined, movement?: Movement, ctx?: CalibrationContext): boolean {
  if (!cal || !Number.isFinite(cal.min) || !Number.isFinite(cal.max)) return false;
  if (!movement) return cal.max - cal.min >= 1e-6;
  // Movement, fingertip, mirror convention: any of them makes this a range of something else.
  if (calibrationMismatch(cal, movement, ctx)) return false;
  return cal.max - cal.min >= requiredRom(movement, cal.rest);
}

/** Why a calibration was rejected (null = usable). Suitable for a therapist-facing message. */
export function calibrationProblem(cal: CalibrationRange | null | undefined, movement: Movement, ctx?: CalibrationContext): string | null {
  if (!cal) return null;
  if (!Number.isFinite(cal.min) || !Number.isFinite(cal.max)) return 'the range is not a number';
  const info = MOVEMENT_INFO[movement];
  const mismatch = calibrationMismatch(cal, movement, ctx);
  if (mismatch) return mismatch.reason;
  const rom = cal.max - cal.min;
  const needed = requiredRom(movement, cal.rest);
  if (rom >= needed) return null;
  // Keep a tiny range legible: "0%" reads as a formatting bug, "0.1%" reads as the actual problem.
  const fmt = (v: number) => {
    if (info.unit === 'deg') return `${v < 1 ? v.toFixed(1) : v.toFixed(0)}°`;
    const pct = v * 100;
    return `${pct > 0 && pct < 1 ? pct.toFixed(1) : pct.toFixed(0)}%`;
  };
  const base = `the calibrated range is only ${fmt(rom)}, below the ${fmt(needed)} minimum for ${info.label.toLowerCase()}`;
  // When the floor was RAISED by a noisy rest window, say so: "do a bigger movement" is the wrong
  // instruction when the real problem is that the resting position never stopped moving.
  if (cal.rest && needed > info.minRom * 1.001) {
    return `${base} — the resting position was drifting by ${fmt(cal.rest.spread)}, so the movement cannot be told apart from it. Re-do the rest hold with the limb supported and still`;
  }
  return base;
}

/**
 * Non-fatal concerns about an otherwise usable calibration: things a therapist screen must SAY rather
 * than a reason to refuse the lane. Range validity is checked by isCalibrationValid; this covers the
 * provenance that used to be invisible — an unsteady zero, a drifting baseline, a range typed in by
 * hand, and a calibration arriving from localStorage hours (or months) later, captured in a posture
 * nobody has re-checked.
 */
export function calibrationWarnings(cal: CalibrationRange | null | undefined, movement: Movement, now: number = Date.now(), ctx?: CalibrationContext): string[] {
  if (!cal) return [];
  const info = MOVEMENT_INFO[movement];
  const out: string[] = [];
  // A finger_opposition range with no fingertip recorded is only worth mentioning when the lane is NOT
  // playing the default: the older calibrations that lack the field were all measured on the index.
  if (movement === 'finger_opposition' && cal.fingertip === undefined && (ctx?.fingertip ?? DEFAULT_FINGERTIP) !== DEFAULT_FINGERTIP) {
    out.push(`This range does not record which fingertip it was measured with, and this lane opposes the ${ctx?.fingertip} finger. If it was measured on another finger, re-run the calibration.`);
  }
  // Same rule for the mirror convention: a range that does not record one was measured before the field
  // existed, i.e. on the default (raw) frames — worth saying only when this lane is NOT on the default,
  // because then the range may well describe the other limb.
  if (cal.mirrored === undefined && (ctx?.mirrored ?? DEFAULT_MIRRORED) !== DEFAULT_MIRRORED) {
    out.push('This range does not record whether the camera image was mirrored when it was measured, and this session mirrors it. If it was measured un-mirrored it describes the other limb — re-run the calibration.');
  }
  // A range with no patient stamp was measured before this device tracked patients (or by hand). It
  // cannot be refused — there is nothing to compare — but it must not read as "checked", because the
  // one thing it does not record is whose body it came from.
  if (cal.patient === undefined && ctx?.patient) {
    out.push('This range does not record which patient it was measured on. If it was measured on someone else it describes their range, not this patient\u2019s — re-run the calibration.');
  }
  const fmt = (v: number) => (info.unit === 'deg' ? `${Math.abs(v).toFixed(1)}°` : `${(Math.abs(v) * 100).toFixed(1)}%`);
  const rest = cal.rest;
  if (rest && !rest.still) {
    out.push(`The resting position was never steady while the zero was measured (it moved by ${fmt(rest.spread)} over ${rest.durationSec.toFixed(1)}s), so 0% may sit inside the movement. Re-do the rest hold.`);
  }
  if (rest && rest.still && Math.abs(rest.drift) > info.minRom * 0.2) {
    out.push(`The resting position drifted by ${fmt(rest.drift)} during the hold; the zero may be off by about that much.`);
  }
  if (cal.manual) out.push('The range was set by hand rather than measured, so it has not been checked against the patient\'s movement.');
  if (typeof cal.capturedAt === 'number' && Number.isFinite(cal.capturedAt)) {
    const ageMs = now - cal.capturedAt;
    if (ageMs > CALIBRATION_STALE_MS) {
      const hours = ageMs / 3600000;
      const age = hours >= 48 ? `${Math.round(hours / 24)} days` : `${Math.round(hours)} hours`;
      out.push(`This range was measured ${age} ago (${POSTURE_INFO[cal.posture ?? info.posture].label.toLowerCase()}). If the camera or the chair has moved since, re-run the calibration.`);
    }
  }
  return out;
}

export class RomCalibrator {
  readonly movement: Movement;
  readonly restDurationSec: number;
  readonly minRestSamples: number;
  readonly stillnessFraction: number;
  readonly restDriftFraction: number;
  readonly restTimeoutSec: number;
  readonly repsRequired: number;
  readonly minRom: number;
  readonly prominence: number;
  readonly peakPercentile: number;
  readonly autoAdvance: boolean;
  readonly moveTimeoutSec: number;
  readonly sessionId: string | undefined;
  /** finger_opposition only: the fingertip this range is being measured on. */
  readonly fingertip: Fingertip | undefined;
  /** The mirror convention of the frames being measured (undefined = the caller did not say). */
  readonly mirrored: boolean | undefined;
  /** The patient this range is being measured on (undefined = the caller did not say). */
  readonly patient: string | undefined;
  private readonly nowMs: () => number;

  private phase: CalibrationPhase = 'rest';
  private error: CalibrationError | null = null;
  /** Rest samples with times; only the trailing restDurationSec window is used. */
  private restSamples: number[] = [];
  private restTimes: number[] = [];
  /** Compensation samples with THEIR OWN times: they are sparser than the feature samples. */
  private restComp: CompensationSample[] = [];
  private restCompTimes: number[] = [];
  private restStart = NaN;
  private restEnd = NaN;
  private restTotal = 0;
  private restStill = false;
  /** The rest window that actually produced `min`, captured when the rest phase ended. */
  private restAtAdvance: RestQuality | null = null;
  private moveStart = NaN;
  private moveSamples = 0;
  private min: number | null = null;
  private max: number | null = null;
  private baseline: CompensationBaseline | null = null;
  private peaks: number[] = [];
  private manualAdjusted = false;
  /** Highest feature seen in the move phase, so a 'no_reps' lane still offers a starting range. */
  private moveMax = -Infinity;
  // peak detection
  /** Largest rise above a trough seen in the move phase (diagnostic for a 'no_reps' failure). */
  private bestRise = 0;
  /** Largest fall from a candidate peak seen while rising (same). */
  private bestFall = 0;
  private trough = Infinity;
  private candidate = -Infinity;
  private rising = false;

  constructor(movement: Movement, opts: CalibratorOptions = {}) {
    this.movement = movement;
    this.restDurationSec = opts.restDurationSec ?? 2;
    this.minRestSamples = opts.minRestSamples ?? 30;
    this.stillnessFraction = opts.stillnessFraction ?? 0.35;
    this.restDriftFraction = opts.restDriftFraction ?? 0.2;
    this.restTimeoutSec = opts.restTimeoutSec ?? 10;
    this.repsRequired = opts.reps ?? 3;
    this.minRom = opts.minRom ?? MOVEMENT_INFO[movement].minRom;
    this.prominence = opts.prominence ?? this.minRom * 0.5;
    this.peakPercentile = opts.peakPercentile ?? 0.9;
    this.autoAdvance = opts.autoAdvance ?? true;
    this.moveTimeoutSec = opts.moveTimeoutSec ?? 30;
    this.nowMs = opts.now ?? (() => Date.now());
    this.sessionId = opts.sessionId;
    this.fingertip = movement === 'finger_opposition' ? opts.fingertip ?? DEFAULT_FINGERTIP : undefined;
    this.mirrored = opts.mirrored;
    this.patient = opts.patient;
  }

  getPhase(): CalibrationPhase {
    return this.phase;
  }

  getError(): CalibrationError | null {
    return this.error;
  }

  isDone(): boolean {
    return this.phase === 'done';
  }

  /** 0..1: fraction of the rest window filled (time AND sample count). */
  restProgress(): number {
    if (this.phase !== 'rest') return 1;
    if (Number.isNaN(this.restStart)) return 0;
    const byTime = clamp01((this.restEnd - this.restStart) / this.restDurationSec);
    const byCount = clamp01(this.restSamples.length / this.minRestSamples);
    return Math.min(byTime, byCount);
  }

  /** True when the trailing rest window is quiet enough to define the rest position. */
  isRestStill(): boolean {
    return this.restStill;
  }

  /** Feed a pipeline sample (smoothed feature + optional compensation quantities). */
  pushSample(sample: CalibrationSample): CalibrationPhase {
    return this.push(sample.smoothed, sample.t, sample.compensationSample);
  }

  /**
   * Feed one feature sample at time tSec. Use the SMOOTHED feature from the lane pipeline. null samples
   * (tracking lost) are ignored. `comp` = this frame's raw compensation quantities (rest phase only).
   */
  push(feature: number | null, tSec: number, comp?: CompensationSample | null): CalibrationPhase {
    if (feature === null || !Number.isFinite(feature)) return this.phase;
    if (this.phase === 'rest') {
      if (Number.isNaN(this.restStart)) this.restStart = tSec;
      this.restEnd = tSec;
      this.restTotal++;
      this.restSamples.push(feature);
      this.restTimes.push(tSec);
      if (comp) {
        this.restComp.push(comp);
        this.restCompTimes.push(tSec);
      }
      // Slide the window: keep only the trailing restDurationSec (but never fewer than minRestSamples).
      while (this.restSamples.length > this.minRestSamples && this.restTimes[0] < tSec - this.restDurationSec) {
        this.restSamples.shift();
        this.restTimes.shift();
      }
      // The compensation baseline MUST describe the same rest window as `min`, so it is windowed on its
      // OWN timestamps against the feature window's start. Compensation is measured far less often than
      // the feature (the heel is the least reliably visible pose landmark), so a length-match would let
      // the baseline span several times the rest window and describe a completely different posture.
      // Only when every comp sample predates the window is the most recent one kept (best available).
      const windowStart = this.restTimes[0];
      while (this.restCompTimes.length > 1 && this.restCompTimes[0] < windowStart) {
        this.restComp.shift();
        this.restCompTimes.shift();
      }
      const windowFull = tSec - this.restStart >= this.restDurationSec && this.restSamples.length >= this.minRestSamples;
      this.restStill = windowFull && this.computeStillness();
      const timedOut = tSec - this.restStart >= this.restTimeoutSec && this.restSamples.length >= this.minRestSamples;
      if (this.autoAdvance && (this.restStill || timedOut)) this.beginMove();
    } else if (this.phase === 'move') {
      if (Number.isNaN(this.moveStart)) this.moveStart = tSec;
      this.moveSamples++;
      if (feature > this.moveMax) this.moveMax = feature;
      this.detectPeak(feature);
      if (this.peaks.length >= this.repsRequired) this.finish();
      else if (tSec - this.moveStart > this.moveTimeoutSec) {
        if (this.peaks.length > 0) this.finish();
        else {
          this.error = 'no_reps';
          this.phase = 'done';
        }
      }
    }
    return this.phase;
  }

  private computeStillness(): boolean {
    if (this.restSamples.length < 2) return false;
    const spread = percentile(this.restSamples, 0.9) - percentile(this.restSamples, 0.1);
    if (spread > this.minRom * this.stillnessFraction) return false;
    // Trend guard: a slow steady drift keeps the instantaneous spread small but moves the median the
    // whole session is normalized from. Compare the two halves of the window.
    const half = this.restSamples.length >> 1;
    if (half < 2) return true;
    const drift = Math.abs(median(this.restSamples.slice(this.restSamples.length - half)) - median(this.restSamples.slice(0, half)));
    return drift <= this.minRom * this.restDriftFraction;
  }

  /** 10th..90th percentile spread of the current rest window (0 with fewer than 2 samples). */
  restSpread(): number {
    if (this.restSamples.length < 2) return 0;
    return percentile(this.restSamples, 0.9) - percentile(this.restSamples, 0.1);
  }

  /**
   * Quality of the rest window as it stands right now (during 'rest'), or of the window that produced
   * `min` (afterwards). null before any rest sample exists.
   */
  getRestQuality(): RestQuality | null {
    return this.phase === 'rest' ? this.currentRestQuality() : this.restAtAdvance;
  }

  private currentRestQuality(): RestQuality | null {
    if (this.restSamples.length === 0) return null;
    const first = this.restTimes[0];
    const last = this.restTimes[this.restTimes.length - 1];
    return {
      still: this.restStill,
      spread: this.restSpread(),
      drift: this.restDrift(),
      durationSec: Number.isFinite(last - first) ? last - first : 0,
      samples: this.restSamples.length,
    };
  }

  /**
   * The range this calibration must span to be accepted: the absolute floor (`minRom`, halved when the
   * rest window was genuinely still) or MIN_ROM_SNR times the rest noise, whichever is larger. Same rule
   * as the module-level requiredRom(), but honouring a `minRom` override passed to this calibrator.
   */
  requiredRange(): number {
    const rest = this.restAtAdvance;
    if (!rest || !Number.isFinite(rest.spread) || rest.spread < 0) return this.minRom;
    const floor = rest.still ? this.minRom * SMALL_ROM_FLOOR_FRACTION : this.minRom;
    return Math.max(floor, rest.spread * MIN_ROM_SNR);
  }

  /** Drift of the rest window (second-half median minus first-half median), for a calibration screen. */
  restDrift(): number {
    const half = this.restSamples.length >> 1;
    if (half < 2) return 0;
    return median(this.restSamples.slice(this.restSamples.length - half)) - median(this.restSamples.slice(0, half));
  }

  /** Manually end the rest phase (e.g. therapist pressed "Next"). Requires at least one rest sample. */
  beginMove(): boolean {
    if (this.phase !== 'rest' || this.restSamples.length === 0) return false;
    // Capture what the window LOOKED LIKE before leaving the phase, whether it settled or timed out.
    this.restAtAdvance = this.currentRestQuality();
    this.min = median(this.restSamples);
    this.baseline = baselineFromSamples(this.restComp);
    this.phase = 'move';
    this.moveStart = NaN;
    this.moveSamples = 0;
    this.moveMax = -Infinity;
    this.peaks = [];
    this.trough = this.min;
    this.candidate = -Infinity;
    this.rising = false;
    this.bestRise = 0;
    this.bestFall = 0;
    this.error = null;
    return true;
  }

  private detectPeak(v: number): void {
    if (!this.rising) {
      if (v < this.trough) this.trough = v;
      // The biggest rise-from-a-trough seen so far: exactly the quantity the next line tests, kept so a
      // 'no_reps' failure can say WHY (see noRepsMessage) instead of blaming visibility.
      if (v - this.trough > this.bestRise) this.bestRise = v - this.trough;
      if (v - this.trough >= this.prominence) {
        this.rising = true;
        this.candidate = v;
      }
    } else {
      if (v > this.candidate) this.candidate = v;
      if (this.candidate - v > this.bestFall) this.bestFall = this.candidate - v;
      if (this.candidate - v >= this.prominence) {
        this.peaks.push(this.candidate);
        this.rising = false;
        this.trough = v;
        this.candidate = -Infinity;
      }
    }
  }

  /** Finish the move phase now with whatever peaks were detected (used by a therapist "Done" button). */
  finish(): CalibrationPhase {
    if (this.phase !== 'move') return this.phase;
    // A rep still in progress (rose but never fell back) counts as a peak.
    if (this.rising && this.candidate > -Infinity) this.peaks.push(this.candidate);
    if (this.peaks.length === 0) {
      this.error = 'no_reps';
      this.phase = 'done';
      return this.phase;
    }
    this.max = percentile(this.peaks, this.peakPercentile);
    this.error = this.max - (this.min as number) < this.requiredRange() ? 'insufficient_range' : null;
    this.phase = 'done';
    return this.phase;
  }

  /**
   * Restart the move phase (after insufficient_range / no_reps), keeping the rest baseline.
   * Returns true when the rest baseline could be reused and the calibrator is back in 'move'.
   *
   * When there are no rest samples to reuse — the therapist called setManualRange() straight from the
   * rest phase, or reset() ran — it falls back to a FULL RESET and returns false, so a "try again"
   * button restarts the rest hold instead of silently doing nothing (it used to leave the phase at
   * 'rest' with the old error intact, which reads to the therapist as a dead button).
   */
  retryMove(): boolean {
    if (this.restSamples.length === 0) {
      this.reset();
      return false;
    }
    this.phase = 'rest';
    this.max = null;
    this.error = null;
    return this.beginMove();
  }

  reset(): void {
    this.phase = 'rest';
    this.error = null;
    this.restSamples = [];
    this.restTimes = [];
    this.restComp = [];
    this.restCompTimes = [];
    this.restStart = NaN;
    this.restEnd = NaN;
    this.restTotal = 0;
    this.restStill = false;
    this.restAtAdvance = null;
    this.moveStart = NaN;
    this.moveSamples = 0;
    this.moveMax = -Infinity;
    this.min = null;
    this.max = null;
    this.baseline = null;
    this.peaks = [];
    this.manualAdjusted = false;
    this.trough = Infinity;
    this.candidate = -Infinity;
    this.rising = false;
  }

  /* ---------- therapist adjustment ---------- */

  /**
   * Shift min and/or max by feature-unit deltas.
   *
   * RAISING the top is BOUNDED by what the patient actually reached (`patientBest`): a raw delta from
   * a UI button must not be able to put the target above a value they have never produced. Lowering
   * stays raw, so the therapist-override flow (`setRange` then `nudge` down) can still produce — and
   * be told about — a range that is too small to score. Prefer `nudgeTop`, which is proportional to
   * the measured range and can tell the therapist what the button will do before they press it.
   */
  nudge(minDelta: number, maxDelta: number): void {
    if (this.min !== null) this.min += minDelta;
    if (this.max !== null) this.max = maxDelta > 0 ? this.boundedMax(this.max + maxDelta, 1) : this.max + maxDelta;
    this.manualAdjusted = true;
    this.reconcile();
  }

  /**
   * The largest value this patient actually produced during calibration: the biggest detected peak,
   * or (when the peak detector never fired) the largest feature seen in the move phase. Null when
   * nothing was measured at all — a range typed in by hand has no such evidence behind it.
   */
  patientBest(): number | null {
    let best = -Infinity;
    for (const p of this.peaks) if (p > best) best = p;
    if (this.moveMax > best) best = this.moveMax;
    return Number.isFinite(best) ? best : null;
  }

  /**
   * What "Easier"/"Harder" would do, WITHOUT doing it — the label the button should carry.
   *
   * `fraction` is a fraction OF THE MEASURED RANGE (max − min), not an absolute feature delta. The
   * old buttons added ±0.05 in feature units to every movement alike: on knee extension (degrees,
   * a ~40° range) that is a twentieth of a degree — invisible; on finger opposition (a ratio with a
   * range around 0.4) it is an eighth of the patient's entire range in one click. Proportional is
   * the only version of this control that means the same thing on every movement.
   *
   * Bounded at both ends: never above what the patient actually reached (`patientBest`), and never
   * so low that the range stops being distinguishable from rest noise (`requiredRange`).
   */
  previewNudgeTop(fraction: number = ROM_NUDGE_FRACTION): RomNudgePreview {
    return buildNudgePreview({
      min: this.min,
      max: this.max,
      movement: this.movement,
      patientBest: this.patientBest(),
      requiredRange: this.requiredRange(),
      fraction,
    });
  }

  /**
   * Move the top of the range by `fraction` of the measured range, bounded by what the patient
   * achieved. Returns the same preview object `previewNudgeTop` would have returned; when
   * `disabled` is true nothing was changed.
   */
  nudgeTop(fraction: number = ROM_NUDGE_FRACTION): RomNudgePreview {
    const preview = this.previewNudgeTop(fraction);
    if (preview.disabled) return preview;
    this.max = preview.nextMax;
    this.manualAdjusted = true;
    this.reconcile();
    return preview;
  }

  /**
   * Clamp a proposed top: never above what the patient reached (raising only), never below the
   * smallest range that can still be told from rest noise (lowering only).
   */
  private boundedMax(wanted: number, direction: number): number {
    const min = this.min;
    const max = this.max;
    if (min === null || max === null || !Number.isFinite(wanted)) return wanted;
    if (direction > 0) {
      const best = this.patientBest();
      // A ceiling below where the range already is must not DRAG the top down: it just means
      // "no further".
      return best === null ? wanted : Math.min(wanted, Math.max(best, max));
    }
    if (direction < 0) return Math.max(wanted, min + this.requiredRange());
    return wanted;
  }

  /** Set min/max directly (either may be null to keep the current value). */
  setRange(min: number | null, max: number | null): void {
    if (min !== null) this.min = min;
    if (max !== null) this.max = max;
    this.manualAdjusted = true;
    this.reconcile();
  }

  /**
   * After a therapist override the range is whatever they set, so BOTH failure modes are rescuable:
   * 'insufficient_range' (the reps were too small) and 'no_reps' (the peak detector never saw a rep —
   * a slow, smooth patient, or a lane that lost tracking mid-attempt). Clearing only the former left
   * getResult() null forever, so a lane the therapist had explicitly measured by hand could not be
   * played at all. A manual range that is still below the movement's minimum ROM stays an error.
   */
  private reconcile(): void {
    if (this.min !== null && this.max !== null && this.max < this.min + 1e-6) this.max = this.min + 1e-6;
    if (this.phase === 'done' && this.min !== null && this.max !== null) {
      this.error = this.max - this.min < this.requiredRange() ? 'insufficient_range' : null;
    }
  }

  private build(min: number, max: number): RomCalibration {
    const cal: RomCalibration = {
      min,
      max,
      samples: this.restTotal + this.moveSamples,
      peaks: this.peaks.slice(),
      movement: this.movement,
      compensationBaseline: this.baseline,
      manual: this.manualAdjusted,
      rest: this.restAtAdvance,
      capturedAt: this.nowMs(),
      posture: MOVEMENT_INFO[this.movement].posture,
    };
    if (this.sessionId !== undefined) cal.sessionId = this.sessionId;
    if (this.fingertip !== undefined) cal.fingertip = this.fingertip;
    if (this.mirrored !== undefined) cal.mirrored = this.mirrored;
    if (this.patient !== undefined) cal.patient = this.patient;
    return cal;
  }

  /** Final calibration, or null while not done / errored. */
  getResult(): RomCalibration | null {
    if (this.phase !== 'done' || this.error || this.min === null || this.max === null) return null;
    return this.build(this.min, this.max);
  }

  /**
   * Full therapist override from ANY phase: set both ends of the range and finish the calibration.
   * The escape hatch for a lane the automatic path cannot measure (a patient too slow/smooth for the
   * peak detector, a joint the therapist goniometers by hand): without it, a 'no_reps' lane could only
   * be retried, never overridden, and the session would have to drop the lane.
   * The rest-phase compensation baseline collected so far is kept.
   */
  setManualRange(min: number, max: number): void {
    if (this.phase === 'rest' && this.restSamples.length > 0) {
      if (this.baseline === null) this.baseline = baselineFromSamples(this.restComp);
      if (this.restAtAdvance === null) this.restAtAdvance = this.currentRestQuality();
    }
    this.min = min;
    this.max = max;
    this.manualAdjusted = true;
    this.phase = 'done';
    this.reconcile();
  }

  /** True when the current range came from (or was adjusted by) a therapist override. */
  isManual(): boolean {
    return this.manualAdjusted;
  }

  /**
   * Best-effort calibration even when errored (for therapist override). When no rep was detected at all
   * ('no_reps' leaves `max` unset) the largest feature seen during the move phase stands in, so the
   * therapist screen has a real starting range to nudge instead of nothing at all.
   */
  getProvisional(): RomCalibration | null {
    if (this.min === null) return null;
    const max = this.max ?? (this.moveMax > this.min ? this.moveMax : null);
    if (max === null) return null;
    return this.build(this.min, max);
  }

  /** Rest-phase compensation baseline (median), available from the move phase on. */
  getCompensationBaseline(): CompensationBaseline | null {
    return this.baseline;
  }

  /** Normalize a feature with the current (possibly provisional) range. 0 when no range yet. */
  normalize(feature: number): number {
    if (this.min === null || this.max === null) return 0;
    return normalizeFeature({ min: this.min, max: this.max }, feature);
  }

  /** Same as normalize() but unclamped, so exceeding the calibrated ROM stays measurable (>1). */
  normalizeRaw(feature: number): number {
    if (this.min === null || this.max === null) return 0;
    return normalizeFeatureRaw({ min: this.min, max: this.max }, feature);
  }

  /**
   * The rest window `min` and the compensation baseline are BOTH taken from (seconds, sample counts).
   * Exposed so a calibration screen (and the tests) can prove the two describe the same window.
   */
  getRestWindow(): { startSec: number; endSec: number; samples: number; compensationSamples: number } {
    return {
      startSec: this.restTimes.length > 0 ? this.restTimes[0] : NaN,
      endSec: this.restTimes.length > 0 ? this.restTimes[this.restTimes.length - 1] : NaN,
      samples: this.restSamples.length,
      compensationSamples: this.restComp.length,
    };
  }

  getStatus(): CalibrationStatus {
    const info = MOVEMENT_INFO[this.movement];
    let message: string;
    if (this.phase === 'rest') {
      const full = this.restProgress() >= 1;
      message = full && !this.restStill ? `${info.restInstruction} Hold still…` : info.restInstruction;
    } else if (this.phase === 'move') message = `${info.calibrationInstruction} (${this.peaks.length}/${this.repsRequired})`;
    else if (this.error === 'insufficient_range') {
      // When the floor was RAISED by a noisy rest window, "do a bigger movement" is the wrong
      // instruction: the range is fine, it is the zero it is measured from that will not hold still.
      const noisyRest = this.restAtAdvance !== null && this.requiredRange() > this.minRom * 1.001;
      message = noisyRest
        ? `The movement could not be told apart from the resting position, which was itself moving by ${this.formatValue(this.restAtAdvance!.spread)} (${this.formatRom()}). Support the limb, hold still, and calibrate again.`
        : `Not enough movement was detected (${this.formatRom()}). Try a bigger movement, move closer to the camera, or let the therapist adjust the range manually.`;
    } else if (this.error === 'no_reps') {
      message = this.noRepsMessage();
    } else message = this.manualAdjusted ? 'Range set manually by the therapist.' : 'Calibration complete.';
    const min = this.phase === 'rest' ? (this.restSamples.length > 0 ? median(this.restSamples) : null) : this.min;
    const rest = this.getRestQuality();
    // The rest window that produced `min` is reported as it WAS, not as the phase would like it to be:
    // an auto-advance on restTimeoutSec leaves this false for the rest of the calibration.
    const restStill = this.phase === 'rest' ? this.restStill : rest?.still ?? false;
    const warnings: string[] = [];
    if (this.phase !== 'rest' && rest && !rest.still) {
      warnings.push(`The resting position never settled (it moved by ${this.formatValue(rest.spread)} over ${rest.durationSec.toFixed(1)}s), so 0% may sit inside the movement. Re-do the rest hold if you can.`);
    }
    if (this.manualAdjusted) warnings.push('The range was set by hand rather than measured.');
    return {
      phase: this.phase,
      restProgress: this.restProgress(),
      restStill,
      rest,
      warnings,
      repsDetected: this.peaks.length,
      repsRequired: this.repsRequired,
      min,
      max: this.max,
      error: this.error,
      message,
      samples: this.phase === 'rest' ? this.restTotal : this.moveSamples,
    };
  }

  /**
   * Why no repetition was detected — the RANGE reason, when that is what it is.
   *
   * The peak rule needs a rise AND a fall of `prominence` (half the movement's minimum ROM). A patient
   * whose active range is below that floor — 8° of knee extension against a 10° prominence — produces
   * zero peaks, and the old message ("Make sure the whole limb is visible and try again") sent the
   * therapist to fix the CAMERA for a problem in the PATIENT's range. It is the one failure the
   * therapist can act on immediately, by setting the range by hand (`setManualRange`, offered from
   * `getProvisional`) or by prescribing an easier movement, and it was the one the message hid.
   * The visibility wording is kept for the case it actually describes: nothing was seen moving at all.
   */
  private noRepsMessage(): string {
    const need = this.formatValue(this.prominence);
    // Nothing ever rose above its own trough: the signal was flat (or absent) for the whole move phase.
    if (!(this.bestRise > 0)) {
      return 'No movement was detected at all. Make sure the whole limb is visible and try again.';
    }
    if (this.bestRise < this.prominence) {
      return `No repetitions were detected: the largest movement seen was ${this.formatValue(this.bestRise)}, and a repetition has to span at least ${need}. Try a bigger movement, or let the therapist set the range by hand.`;
    }
    // It rose far enough but never came back down: the limb is not returning to rest between reps.
    return `No repetitions were detected: the movement reached ${this.formatValue(this.bestRise)} but never returned toward the resting position (it has to come back down by ${need}). Lower the limb fully between repetitions, or let the therapist set the range by hand.`;
  }

  private formatValue(v: number): string {
    return MOVEMENT_INFO[this.movement].unit === 'deg' ? `${Math.abs(v).toFixed(1)}°` : `${(Math.abs(v) * 100).toFixed(1)}%`;
  }

  private formatRom(): string {
    const info = MOVEMENT_INFO[this.movement];
    const rom = this.min !== null && this.max !== null ? this.max - this.min : 0;
    const needed = this.requiredRange();
    return info.unit === 'deg'
      ? `${rom.toFixed(0)}° of ${needed.toFixed(0)}° needed`
      : `${(rom * 100).toFixed(0)}% of ${(needed * 100).toFixed(0)}% needed`;
  }
}
