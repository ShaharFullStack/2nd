/**
 * LanePipeline: the ONE per-lane signal path shared by ROM calibration and play.
 *
 *   landmarks --extract--> raw feature --filter (unit-free, linear)--> smoothed --normalize--> value 0..1
 *
 * The default filter is linear and unit-free (EMA / first-order low-pass, see filters.ts LaneFilterSpec)
 * and is applied BEFORE normalization. Because ROM normalization is affine, this is identical to
 * filtering the normalized value (filter(normalize(x)) == normalize(filter(x)) before clamping) and the
 * filter delay is the same for every lane whatever its feature unit (degrees or ratio). The one
 * non-linear option, 'oneEuro', is opt-in and is made unit-aware here: its `featureScale` is filled in
 * from the movement's own minRom, so one spec means the same responsiveness on a degrees lane and a
 * ratio lane, at the cost of a delay that is a worst case rather than a constant. The calibrator is fed
 * `smoothed` from this very object (RomCalibrator.pushSample), so calibration and play see the same
 * signal and thresholdFraction of ROM is reachable at tempo.
 *
 * Compensation (heel lift / trunk lean) is measured per frame when a baseline is available (from the
 * calibration's rest-phase median, or set explicitly).
 */
import type { LaneSpec, Movement, Side } from '../engine/types.ts';
import type { RomCalibration } from './calibration.ts';
import { normalizeFeature, normalizeFeatureRaw } from './calibration.ts';
import { DEFAULT_FINGERTIP, MOVEMENT_INFO, compensationKind, evaluateCompensation, extractFeature, measureCompensation } from './features.ts';
import type { CompensationBaseline, CompensationResult, CompensationSample, FeatureOptions } from './features.ts';
import { DEFAULT_LANE_FILTER, createFilter, filterGroupDelaySec, resolveLaneFilter } from './filters.ts';
import { DEFAULT_MAX_GAP_SEC } from './trigger.ts';
import type { LaneFilterSpec, ScalarFilter } from './filters.ts';
import type { Fingertip, Landmark } from './landmarks.ts';

export interface LanePipelineOptions {
  movement: Movement;
  side: Side;
  /** Feature options (fingertip, minVisibility). `worldLandmarks` is supplied per frame via push(). */
  featureOptions?: Omit<FeatureOptions, 'worldLandmarks'>;
  /** Smoothing (default MOVEMENT_INFO[movement].smoothing = EMA 0.5); a 'oneEuro' spec is unit-resolved here. */
  smoothing?: LaneFilterSpec;
  /** Initial calibration (null during calibration itself). */
  calibration?: RomCalibration | null;
  /** Compensation baseline override (default: calibration.compensationBaseline). */
  compensationBaseline?: CompensationBaseline | null;
  /**
   * Longest break in the sample stream the smoothing filter carries state across (default 0.5 s, the
   * same window VisionInput's stall watchdog and LaneTrigger use). After a longer gap — an occlusion, a
   * wedged camera, a backgrounded tab — the filter is reset, so the first recovered frame reports where
   * the patient IS rather than a blend with a limb position from seconds ago. (Blending is not just a
   * cosmetic meter error: while the stale value sits above the re-arm level the lane cannot re-arm, so
   * the first note after recovery can be lost.)
   */
  maxGapSec?: number;
}

export interface LaneSample {
  /** Sample time (seconds, AudioContext base). */
  t: number;
  /** True when the movement's landmarks were usable this frame. */
  tracking: boolean;
  /** Raw feature (null when not tracking). */
  raw: number | null;
  /** Smoothed feature in feature units (null when not tracking). */
  smoothed: number | null;
  /** Normalized 0..1 of calibrated ROM (0 when not tracking or no calibration). */
  value: number;
  /**
   * Same normalization WITHOUT the 0..1 clamp: >1 when the patient exceeded their calibrated ROM.
   * `value` drives thresholds and meters; this one keeps cross-session ROM gain measurable.
   */
  rawValue: number;
  /** This frame's raw compensation quantities (null when not monitored / not visible). */
  compensationSample: CompensationSample | null;
  /** Compensation evaluated against the baseline (null when no baseline / not monitored). */
  compensation: CompensationResult | null;
}

const NOT_TRACKING: Readonly<Omit<LaneSample, 't'>> = Object.freeze({
  tracking: false, raw: null, smoothed: null, value: 0, rawValue: 0, compensationSample: null, compensation: null,
});

export class LanePipeline {
  readonly movement: Movement;
  readonly side: Side;
  readonly smoothing: LaneFilterSpec;
  private readonly filter: ScalarFilter;
  private readonly opts: FeatureOptions;
  private calibration: RomCalibration | null;
  private baselineOverride: CompensationBaseline | null | undefined;
  private maxGapSec: number;
  /** Time of the last sample that actually reached the filter (NaN before the first). */
  private lastFeatureTime = NaN;
  private _last: LaneSample = { t: NaN, ...NOT_TRACKING };

  constructor(options: LanePipelineOptions) {
    this.movement = options.movement;
    this.side = options.side;
    // resolveLaneFilter fills in the unit scale a 'oneEuro' spec needs, so one spec means the same
    // responsiveness on a degrees lane and a ratio lane (see filters.ts LaneFilterSpec).
    this.smoothing = resolveLaneFilter(options.smoothing ?? MOVEMENT_INFO[options.movement].smoothing ?? DEFAULT_LANE_FILTER, MOVEMENT_INFO[options.movement].minRom);
    this.filter = createFilter(this.smoothing);
    this.opts = { ...(options.featureOptions ?? {}) };
    this.calibration = options.calibration ?? null;
    this.baselineOverride = options.compensationBaseline;
    this.maxGapSec = options.maxGapSec !== undefined && Number.isFinite(options.maxGapSec) && options.maxGapSec > 0 ? options.maxGapSec : DEFAULT_MAX_GAP_SEC;
  }

  static forLane(spec: LaneSpec, options: Omit<LanePipelineOptions, 'movement' | 'side'> = {}): LanePipeline {
    return new LanePipeline({ movement: spec.movement, side: spec.side, ...options });
  }

  /** Last sample produced (t = NaN before the first push). */
  get last(): LaneSample {
    return this._last;
  }

  getCalibration(): RomCalibration | null {
    return this.calibration;
  }

  /** Swap the calibration (therapist nudge / calibration finished). The filter state is kept. */
  setCalibration(cal: RomCalibration | null): void {
    this.calibration = cal;
  }

  setCompensationBaseline(baseline: CompensationBaseline | null | undefined): void {
    this.baselineOverride = baseline;
  }

  /**
   * Frame aspect correction (width/height) applied to every mixed-axis geometry op — see
   * FeatureOptions.xScale. VisionInput sets it from the live camera so the feature is in frame-height
   * units and the per-movement guards mean the same physical amount on any webcam.
   */
  setXScale(xScale: number): void {
    const s = Number.isFinite(xScale) && xScale > 0 ? xScale : 1;
    if (this.opts.xScale === s) return;
    this.opts.xScale = s;
  }

  getXScale(): number {
    return this.opts.xScale ?? 1;
  }

  /**
   * THE MEASUREMENT IDENTITY of this pipeline: which limb it reads and which quantity it computes.
   *
   * `mirrored` selects the LIMB (see FeatureOptions.mirrored / poseSideIndices: on flipped frames the
   * patient's left leg arrives under the RIGHT_* indices) and `fingertip` selects WHAT finger_opposition
   * measures. A pipeline handed from the calibration screen to the play session carries these with it, so
   * VisionInput can compare them against the session's own configuration instead of assuming — the
   * failure that mismatch produces (the affected lane reading a flat 0 for a whole session while the
   * status stays green) is the one this module exists to prevent. `minVisibility`/`xScale` are gates and
   * scale corrections rather than identity, so VisionInput pushes those onto a reused pipeline.
   */
  getFeatureOptions(): Readonly<Omit<FeatureOptions, 'worldLandmarks'>> {
    const { worldLandmarks: _ignored, ...rest } = this.opts;
    void _ignored;
    return Object.freeze({ ...rest });
  }

  /** Mirror convention the features are extracted under (false = raw, un-flipped frames). */
  getMirrored(): boolean {
    return this.opts.mirrored ?? false;
  }

  /**
   * Change the mirror convention. This RE-POINTS THE PIPELINE AT THE OTHER LIMB, so it is only ever
   * correct before any sample has been taken (or when the frame source itself changed); the filter state
   * and the calibration describe the previous limb, so both are dropped.
   */
  setMirrored(mirrored: boolean): void {
    if (this.getMirrored() === mirrored) return;
    this.opts.mirrored = mirrored;
    this.reset();
  }

  /** finger_opposition: which fingertip opposes the thumb ('index' by default). */
  getFingertip(): Fingertip {
    return this.opts.fingertip ?? DEFAULT_FINGERTIP;
  }

  /** Change the opposed fingertip. Like setMirrored, this changes WHAT is measured: the filter resets. */
  setFingertip(fingertip: Fingertip): void {
    if (this.getFingertip() === fingertip) return;
    this.opts.fingertip = fingertip;
    this.reset();
  }

  /** Longest break in the sample stream the filter carries state across (see LanePipelineOptions). */
  getMaxGapSec(): number {
    return this.maxGapSec;
  }

  /** Align the filter's break window with the session's stall watchdog (VisionInput.staleFrameSec). */
  setMaxGapSec(maxGapSec: number): void {
    if (Number.isFinite(maxGapSec) && maxGapSec > 0) this.maxGapSec = maxGapSec;
  }

  /** Pose visibility gate in effect (undefined = the module default MIN_VISIBILITY). */
  getMinVisibility(): number | undefined {
    return this.opts.minVisibility;
  }

  /** Push the session's visibility gate onto the pipeline (a gate, not a measurement identity). */
  setMinVisibility(minVisibility: number | undefined): void {
    if (minVisibility === undefined) return;
    this.opts.minVisibility = minVisibility;
  }

  /** Baseline in effect: explicit override, else the calibration's rest-phase median. */
  getCompensationBaseline(): CompensationBaseline | null {
    if (this.baselineOverride !== undefined) return this.baselineOverride;
    return this.calibration?.compensationBaseline ?? null;
  }

  /** The compensation this lane's movement monitors, or null when it monitors none. */
  getCompensationKind(): ReturnType<typeof compensationKind> {
    return compensationKind(this.movement);
  }

  /**
   * True when compensation is actually being MEASURED on this lane: the movement monitors one AND a rest
   * baseline is in effect. False with a baseline missing means the lane produces no compensation flags at
   * all — which reads on a results screen exactly like "no compensation was observed" unless somebody
   * says otherwise, so VisionInput reports it (see VisionInput.getUnmonitoredCompensationLanes).
   */
  isCompensationMonitored(): boolean {
    return compensationKind(this.movement) !== null && this.getCompensationBaseline() !== null;
  }

  /** Reset the filter (tracking resumed after a long gap, or session restart). */
  reset(): void {
    this.filter.reset();
    this.lastFeatureTime = NaN;
    this._last = { t: NaN, ...NOT_TRACKING };
  }

  /** Delay the filter adds to a slow movement at the given frame rate (seconds; identical for all lanes). */
  filterDelaySec(fps: number): number {
    return filterGroupDelaySec(this.smoothing, fps);
  }

  /**
   * Process one frame. `landmarks` = the 33 pose landmarks (leg) or the selected hand's 21 landmarks
   * (hand); `world` = matching pose world landmarks when available.
   */
  push(landmarks: readonly Landmark[] | null | undefined, tSec: number, world?: readonly Landmark[] | null): LaneSample {
    this.opts.worldLandmarks = world ?? null;
    const raw = landmarks ? extractFeature(this.movement, landmarks, this.side, this.opts) : null;
    const compSample = raw !== null && landmarks && compensationKind(this.movement) ? measureCompensation(this.movement, landmarks, this.side, this.opts) : null;
    this.opts.worldLandmarks = null;
    return this.pushFeature(raw, tSec, compSample);
  }

  /** Process an already-extracted raw feature (tests / synthetic streams). */
  pushFeature(raw: number | null, tSec: number, compensationSample: CompensationSample | null = null): LaneSample {
    if (raw === null || !Number.isFinite(raw)) {
      this._last = { t: tSec, ...NOT_TRACKING };
      return this._last;
    }
    // A long break (or a clock that went backwards) makes the filter's memory describe another moment
    // in the session: start again from this sample instead of averaging across the blackout.
    const gap = Number.isNaN(this.lastFeatureTime) ? 0 : tSec - this.lastFeatureTime;
    if (gap > this.maxGapSec || gap < 0) this.filter.reset();
    this.lastFeatureTime = tSec;
    const smoothed = this.filter.filter(raw, tSec);
    const value = this.calibration ? normalizeFeature(this.calibration, smoothed) : 0;
    const rawValue = this.calibration ? normalizeFeatureRaw(this.calibration, smoothed) : 0;
    const baseline = this.getCompensationBaseline();
    const compensation = compensationSample && baseline ? evaluateCompensation(compensationSample, baseline) : null;
    this._last = { t: tSec, tracking: true, raw, smoothed, value, rawValue, compensationSample, compensation };
    return this._last;
  }
}
