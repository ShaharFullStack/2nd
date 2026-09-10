/**
 * Latency calibration probe (the audio half of the calibration screen).
 *
 * Plays a synthesized metronome on a steady grid using the AudioContext clock, records the ctx
 * timestamps of the patient's inputs (LaneInputEvent.ctxTime) and hands the (expected beat,
 * observed input) recording to the engine's calibration math.
 *
 * All statistics — pairing inputs to beats, outlier rejection, median/MAD, confidence — live in
 * src/engine/latency.ts (`calibrateLatency`) and are NOT re-implemented here, so the engine and
 * the calibration screen share one definition of `inputLatencySec`. This file only owns the
 * click scheduling, the recording, and a UI-facing diagnosis of *why* a run was not confident.
 *
 * Tempo (DELIBERATE DEVIATION from the original spec's "100 BPM grid" — see the handoff notes):
 * the probe defaults to the engine's `CALIBRATION_BPM_RECOMMENDED` = 60 BPM, overridable with
 * `options.bpm`. A slow, seated movement measured through a 30 fps camera can lag the click by
 * 300–700 ms. At 100 BPM the beat is 0.6 s and the engine's asymmetric pairing window is only
 * +0.45 s, so a 600 ms patient pairs with the *next* click and is measured at −0.15 s — a
 * confident, silently wrong calibration. At 60 BPM the window is +0.75 s and the same patient is
 * measured correctly. 100 BPM still works for anyone inside ~400 ms; pass `{ bpm: 100 }` for it.
 *
 * Slow patients (the target population) are the reason for three behaviours here:
 *  - a well-measured large lag is ACCEPTED (`accepted`) and flagged (`warning`,
 *    diagnosis 'reacting-not-anticipating'): the engine's `confident` deliberately ignores the
 *    offset magnitude, because subtracting 600 ms is exactly what makes the session fair. The
 *    alternative — refusing the run — leaves `inputLatencySec` at 0, every note is missed, and
 *    the player stem stays ducked to 0.05 for the whole song.
 *  - a lag so large that inputs pair with the FOLLOWING click ("aliasing") produces a confident
 *    but negative offset. That is detected (diagnosis 'reacting-previous-beat'), rejected, and
 *    the true lag is reported as `apparentLagSec`.
 *  - every non-'ok' diagnosis carries a concrete remedy; when the remedy is a slower metronome,
 *    `suggestedBpm` is the tempo to re-run at, so the screen can offer one button.
 *
 * Usage: `await mixer.resumeContext()` (user gesture) → `probe.start()` → feed every input via
 * `probe.recordInput(e.ctxTime)` → when `probe.isComplete()` call `probe.finish()`.
 */

import {
  CALIBRATION_BEATS_RECOMMENDED,
  CALIBRATION_BPM_RECOMMENDED,
  LATENCY_MAX_MAD_SEC,
  LATENCY_MAX_REJECTED_FRACTION,
  LATENCY_MIN_SAMPLES,
  beatIntervalOf,
  calibrateLatency,
  defaultPairingWindow,
  type CalibrationResult,
  type LatencyOptions,
  type PairingWindow,
} from '../engine/latency';

export interface LatencyProbeOptions {
  /** Metronome tempo (default `CALIBRATION_BPM_RECOMMENDED` = 60). */
  bpm?: number;
  /** Number of measured clicks (default `CALIBRATION_BEATS_RECOMMENDED` = 16). */
  beats?: number;
  /** Extra clicks at the start that are played but not measured (default 4). */
  countIn?: number;
  clickFreq?: number;
  accentFreq?: number;
  /** Accent every N measured clicks (default 4). */
  accentEvery?: number;
  /**
   * Pairing window: a symmetric radius in seconds or an explicit {earlySec, lateSec}.
   * Default: the engine's asymmetric window for the beat interval (25 % early / 75 % late).
   */
  window?: number | PairingWindow;
  /** Lead before the first click when start() is called without a time (default 0.5 s). */
  startDelaySec?: number;
  destination?: AudioNode;
  volume?: number;
  /** Thresholds forwarded to the engine's `estimateLatency` (minSamples, maxMadSec, …). */
  latency?: LatencyOptions;
}

/** Why a calibration run was / was not usable (for the calibration screen's remedy text). */
export type ProbeDiagnosis =
  | 'ok'
  /** No input at all was recorded — camera/lane not triggering. */
  | 'no-input'
  /** Inputs were recorded but most landed outside the pairing window (too slow/late or too early). */
  | 'out-of-window'
  /** Too few beats paired (patient skipped beats). */
  | 'too-few'
  /** Enough samples but the spread (MAD) is above the threshold — inconsistent timing. */
  | 'too-jittery'
  /** Enough paired samples but too many were rejected as outliers. */
  | 'too-many-outliers'
  /**
   * ACCEPTED with a warning: the run is well measured but the lag is bigger than the camera
   * pipeline can explain (`implausibleOffset`) — the patient is *reacting* to each click instead
   * of moving with it. The offset is still the right value to feed the engine; a slower tempo
   * (`suggestedBpm`) shrinks the reaction component if the therapist wants a tighter number.
   */
  | 'reacting-not-anticipating'
  /**
   * REJECTED: the lag is so long that each movement pairs with the *following* click, which
   * yields a confident but negative (physically impossible) offset. `apparentLagSec` holds the
   * true lag; re-run at `suggestedBpm`.
   */
  | 'reacting-previous-beat';

export interface LatencyProbeResult extends CalibrationResult {
  /**
   * The probe's verdict: `confident` AND not beat-aliased. `true` for a well-measured slow
   * patient (see `warning`) — refusing those is what locks them out of the game.
   */
  accepted: boolean;
  /** Accepted, but the therapist should see `message` (currently: 'reacting-not-anticipating'). */
  warning: boolean;
  totalClicks: number;
  /** Beat interval of the recording (seconds). */
  beatSec: number;
  /**
   * The lag the patient actually has, in seconds: `offsetSec`, except on a beat-aliased run
   * where it is `offsetSec + beatSec` (what the negative measurement really means).
   */
  apparentLagSec: number;
  /** A slower metronome tempo to re-run at, or null when the tempo is not the problem. */
  suggestedBpm: number | null;
  /** Inputs recorded during the measured part of the run. */
  inputs: number;
  /** observed − expected for every paired beat, in ms and in beat order (for plotting). */
  samplesMs: number[];
  diagnosis: ProbeDiagnosis;
  /** Short, patient-facing explanation of `diagnosis`, with the concrete numbers filled in. */
  message: string;
}

/**
 * A measured offset below −this is read as beat aliasing rather than anticipation: sensorimotor
 * synchronisation research puts the negative mean asynchrony of healthy tappers at 20–80 ms and
 * of impaired populations nearer zero, so −120 ms "early" through a camera pipeline that adds
 * 80–200 ms of positive latency is not a real measurement.
 */
export const PROBE_ALIAS_OFFSET_SEC = 0.12;
/** …and anticipation also scales with the beat, so at fast tempi the bound is a fraction of it. */
export const PROBE_ALIAS_BEAT_FRACTION = 0.15;

/**
 * How negative an offset must be at this beat interval before it is read as aliasing.
 * NOTE the hard limit of the method: a lag of exactly one beat measures as 0 and is invisible to
 * any single-tempo probe. That is why the default tempo is slow (60 BPM, beat 1 s ≫ any plausible
 * lag) rather than the spec's 100 BPM.
 */
export function aliasLimitSec(beatSec: number): number {
  return Math.min(PROBE_ALIAS_OFFSET_SEC, PROBE_ALIAS_BEAT_FRACTION * beatSec);
}

/** Tempi the calibration screen offers, slowest last. */
export const CALIBRATION_BPM_STEPS: readonly number[] = [60, 50, 40, 30];

/**
 * Slowest-but-one tempo at which a lag of `lagSec` fits inside HALF a beat, so it can never be
 * confused with the next click. Returns null when `currentBpm` already has that much room (or the
 * lag is not positive), i.e. when a slower tempo is not the remedy.
 */
export function suggestedCalibrationBpm(lagSec: number, currentBpm: number): number | null {
  if (!Number.isFinite(lagSec) || !Number.isFinite(currentBpm) || currentBpm <= 0) return null;
  const needBeat = Math.max(0, lagSec) * 2;
  if (needBeat <= 0 || needBeat <= 60 / currentBpm + 1e-9) return null;
  const maxBpm = 60 / needBeat;
  // 1e-9 slack: 60 / (0.6 × 2) is 49.999999999999993 in binary floating point, and the 50 BPM step
  // must not be skipped because of it
  const pick = CALIBRATION_BPM_STEPS.find((b) => b <= maxBpm * (1 + 1e-9)) ?? CALIBRATION_BPM_STEPS[CALIBRATION_BPM_STEPS.length - 1];
  return pick < currentBpm ? pick : null;
}

/** ctx times of `count` clicks starting at `startCtxTime`. */
export function clickSchedule(startCtxTime: number, bpm: number, count: number): number[] {
  const beat = 60 / bpm;
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(startCtxTime + i * beat);
  return out;
}

/** Generic (number-free) text for a diagnosis; `probeMessage` fills in the measured values. */
export function diagnosisMessage(d: ProbeDiagnosis): string {
  switch (d) {
    case 'ok': return 'Calibration succeeded.';
    case 'no-input': return 'No movement was detected. Check that the camera sees you and try a bigger movement.';
    case 'out-of-window': return 'Your movements were detected, but too far from the clicks to be measured. Try to move exactly on each click; a slower tempo can help.';
    case 'too-few': return 'Not enough clicks were answered. Try to move on every click.';
    case 'too-jittery': return 'Your timing varied a lot between clicks. Try again, moving as steadily as you can.';
    case 'too-many-outliers': return 'Several movements were far from the beat. Try again, moving on every click.';
    case 'reacting-not-anticipating': return 'Your timing was very steady, but you move well after each click rather than with it. That is fine — the game will allow for it. A slower tempo makes it easier to move with the click.';
    case 'reacting-previous-beat': return 'You move almost a full beat after each click, so the clicks could not be told apart. Please run the calibration again at a slower tempo.';
  }
}

/** `diagnosisMessage` with the run's own numbers (lag in ms, the tempo to retry at) filled in. */
export function probeMessage(d: ProbeDiagnosis, detail: { apparentLagSec?: number; suggestedBpm?: number | null } = {}): string {
  const base = diagnosisMessage(d);
  const lagMs = Math.round((detail.apparentLagSec ?? 0) * 1000);
  const retry = detail.suggestedBpm ? ` Try ${detail.suggestedBpm} BPM.` : '';
  switch (d) {
    case 'reacting-not-anticipating':
      return `You move about ${lagMs} ms after each click — very steadily, so the game can compensate exactly. Calibration accepted.${retry}`;
    case 'reacting-previous-beat':
      return `You move about ${lagMs} ms after each click, almost a full beat, so the clicks could not be told apart.${retry || ' Please run the calibration again at a slower tempo.'}`;
    case 'out-of-window':
      return `${base}${retry}`;
    default:
      return base;
  }
}

export interface DiagnoseOptions extends LatencyOptions {
  /** Beat interval of the recording (seconds); enables the beat-aliasing check. */
  beatSec?: number;
}

/**
 * True when a confident-looking result is really the patient answering the *previous* click:
 * a negative offset is physically impossible for a camera pipeline, and the leftover unpaired
 * beat / spurious input at the ends of the recording corroborate the one-beat shift.
 */
export function isBeatAliased(r: CalibrationResult, beatSec: number | undefined, minSamples: number): boolean {
  if (!beatSec || !Number.isFinite(beatSec) || beatSec <= 0) return false;
  if (r.samples < minSamples) return false;
  if (r.offsetSec >= -aliasLimitSec(beatSec)) return false;
  return r.pairing.unpairedBeats >= 1 || r.pairing.spuriousInputs >= 1;
}

/** Classify a calibration run; pure so the calibration screen can be unit-tested against it. */
export function diagnoseCalibration(
  r: CalibrationResult,
  totalBeats: number,
  opts: DiagnoseOptions = {},
): ProbeDiagnosis {
  const minSamples = opts.minSamples ?? LATENCY_MIN_SAMPLES;
  const maxMad = opts.maxMadSec ?? LATENCY_MAX_MAD_SEC;
  const maxRejected = opts.maxRejectedFraction ?? LATENCY_MAX_REJECTED_FRACTION;
  const { pairing } = r;
  if (pairing.pairs.length === 0 && pairing.spuriousInputs === 0) return 'no-input';
  // Checked before `confident`: an aliased run looks perfectly measured but its sign is wrong.
  if (isBeatAliased(r, opts.beatSec, minSamples)) return 'reacting-previous-beat';
  // The engine's `confident` deliberately ignores the offset *magnitude* (see engine/latency.ts):
  // a steady 600 ms lag is a good measurement of a slow patient, not a failed calibration.
  if (r.confident) return r.implausibleOffset ? 'reacting-not-anticipating' : 'ok';
  const unpairedFraction = totalBeats > 0 ? pairing.unpairedBeats / totalBeats : 1;
  // inputs exist but do not pair: the patient is answering the clicks outside the window
  if (unpairedFraction > maxRejected && pairing.spuriousInputs >= Math.ceil(pairing.unpairedBeats / 2)) return 'out-of-window';
  if (r.samples < minSamples) return 'too-few';
  if (r.madSec > maxMad) return 'too-jittery';
  return 'too-many-outliers';
}

/**
 * Pure part of the probe: measured click times + recorded input times → result.
 * Delegates all statistics to the engine (`calibrateLatency`); adds the probe-level verdict
 * (`accepted` / `warning`), the beat-aliasing check and the remedy (`suggestedBpm`).
 */
export function computeProbeResult(
  clickTimes: readonly number[],
  inputTimes: readonly number[],
  opts: { window?: number | PairingWindow; latency?: LatencyOptions; beatSec?: number } = {},
): LatencyProbeResult {
  const cal = calibrateLatency(clickTimes, inputTimes, { ...opts.latency, window: opts.window });
  const beatSec = opts.beatSec ?? beatIntervalOf(clickTimes);
  const diagnosis = diagnoseCalibration(cal, clickTimes.length, { ...opts.latency, beatSec });
  const aliased = diagnosis === 'reacting-previous-beat';
  const apparentLagSec = aliased ? cal.offsetSec + beatSec : cal.offsetSec;
  // For 'out-of-window' the pairs are empty, so the recording itself is the only evidence of how
  // late the patient is: use the median input-to-nearest-click distance to size the retry tempo.
  const lagForRemedy = diagnosis === 'out-of-window' ? medianLagFromPrecedingClick(clickTimes, inputTimes) : apparentLagSec;
  const bpm = beatSec > 0 ? 60 / beatSec : 0;
  const needsSlower = diagnosis === 'reacting-previous-beat' || diagnosis === 'reacting-not-anticipating' || diagnosis === 'out-of-window';
  const suggestedBpm = needsSlower ? suggestedCalibrationBpm(lagForRemedy, bpm) : null;
  return {
    ...cal,
    accepted: cal.confident && !aliased,
    warning: diagnosis === 'reacting-not-anticipating',
    totalClicks: clickTimes.length,
    beatSec,
    apparentLagSec,
    suggestedBpm,
    inputs: inputTimes.length,
    samplesMs: cal.pairing.pairs.map((p) => (p.observed - p.expected) * 1000),
    diagnosis,
    message: probeMessage(diagnosis, { apparentLagSec, suggestedBpm }),
  };
}

/**
 * Median lag from each input back to the click *preceding* it (seconds). Used only to size the
 * retry tempo when nothing paired: "nearest click" would read a 500 ms lag at a 600 ms beat as
 * −100 ms early, which is the very confusion the slower tempo is meant to remove, so the
 * physically correct assumption (latency is positive) is used instead.
 */
function medianLagFromPrecedingClick(clickTimes: readonly number[], inputTimes: readonly number[]): number {
  if (clickTimes.length === 0 || inputTimes.length === 0) return 0;
  const clicks = clickTimes.slice().sort((a, b) => a - b);
  const lags: number[] = [];
  for (const t of inputTimes) {
    let best = Number.NaN;
    for (const c of clicks) {
      if (c > t) break;
      best = t - c;
    }
    if (Number.isFinite(best)) lags.push(best);
  }
  lags.sort((a, b) => a - b);
  if (lags.length === 0) return 0;
  const mid = lags.length >> 1;
  return lags.length % 2 === 1 ? lags[mid] : (lags[mid - 1] + lags[mid]) / 2;
}

interface ResolvedOptions {
  bpm: number;
  beats: number;
  countIn: number;
  clickFreq: number;
  accentFreq: number;
  accentEvery: number;
  window: PairingWindow;
  startDelaySec: number;
  volume: number;
  latency: LatencyOptions;
}

export class LatencyProbe {
  readonly ctx: BaseAudioContext;
  private readonly opts: ResolvedOptions;
  private readonly destination: AudioNode;
  private readonly out: GainNode;
  private clicks: number[] = [];
  private countInClicks: number[] = [];
  private inputs: number[] = [];
  private ignoredEarlyInputs = 0;
  /** Scheduled clicks, oscillator AND its envelope gain: both must be disconnected on cancel. */
  private nodes: { osc: OscillatorNode; env: GainNode }[] = [];
  private running = false;
  private endsAtCtx = 0;

  constructor(ctx: BaseAudioContext, options: LatencyProbeOptions = {}) {
    this.ctx = ctx;
    const bpm = options.bpm ?? CALIBRATION_BPM_RECOMMENDED;
    if (!(bpm > 0) || !Number.isFinite(bpm)) throw new Error(`LatencyProbe: invalid bpm ${bpm}`);
    const beatSec = 60 / bpm;
    const w = options.window;
    this.opts = {
      bpm,
      beats: options.beats ?? CALIBRATION_BEATS_RECOMMENDED,
      countIn: options.countIn ?? 4,
      clickFreq: options.clickFreq ?? 1000,
      accentFreq: options.accentFreq ?? 1500,
      accentEvery: options.accentEvery ?? 4,
      window: typeof w === 'number' ? { earlySec: w, lateSec: w } : (w ?? defaultPairingWindow(beatSec)),
      startDelaySec: options.startDelaySec ?? 0.5,
      volume: options.volume ?? 0.6,
      latency: options.latency ?? {},
    };
    this.destination = options.destination ?? ctx.destination;
    this.out = ctx.createGain();
    this.out.gain.value = this.opts.volume;
    this.out.connect(this.destination);
  }

  get isRunning(): boolean { return this.running; }
  /** ctx times of the measured clicks (excludes count-in). */
  get clickTimes(): number[] { return [...this.clicks]; }
  get countInTimes(): number[] { return [...this.countInClicks]; }
  get inputTimes(): number[] { return [...this.inputs]; }
  get beatSec(): number { return 60 / this.opts.bpm; }
  get bpm(): number { return this.opts.bpm; }
  get window(): PairingWindow { return { ...this.opts.window }; }
  /** ctx time when the last click has sounded plus the late window (grace for the final input). */
  get endsAt(): number { return this.endsAtCtx; }

  /**
   * Schedule the count-in and all measured clicks. The context MUST be running (call
   * `mixer.resumeContext()` / `ctx.resume()` after a user gesture first): on a suspended context
   * `currentTime` is frozen and every click would fire as one burst on resume.
   */
  start(atCtxTime?: number): { clickTimes: number[]; countInTimes: number[]; endsAt: number } {
    if (this.ctx.state !== 'running') {
      throw new Error(`LatencyProbe.start(): AudioContext is "${this.ctx.state}" — resume it after a user gesture before starting the metronome`);
    }
    this.cancel();
    const first = Math.max(this.ctx.currentTime + 0.05, atCtxTime ?? this.ctx.currentTime + this.opts.startDelaySec);
    const all = clickSchedule(first, this.opts.bpm, this.opts.countIn + this.opts.beats);
    this.countInClicks = all.slice(0, this.opts.countIn);
    this.clicks = all.slice(this.opts.countIn);
    this.inputs = [];
    this.ignoredEarlyInputs = 0;
    all.forEach((t, i) => {
      const measured = i >= this.opts.countIn;
      const accent = measured && (i - this.opts.countIn) % this.opts.accentEvery === 0;
      this.click(t, accent);
    });
    this.endsAtCtx = all[all.length - 1] + Math.max(this.opts.window.lateSec, 0.1);
    this.running = true;
    return { clickTimes: this.clickTimes, countInTimes: this.countInTimes, endsAt: this.endsAtCtx };
  }

  /**
   * Feed an input timestamp (LaneInputEvent.ctxTime). Ignored when not running and during the
   * count-in (anything earlier than the first measured click's early window).
   */
  recordInput(ctxTime: number): void {
    if (!this.running || !Number.isFinite(ctxTime)) return;
    if (this.clicks.length > 0 && ctxTime < this.clicks[0] - this.opts.window.earlySec) { this.ignoredEarlyInputs++; return; }
    this.inputs.push(ctxTime);
  }

  /** Inputs that arrived during the count-in (not measured). */
  get countInInputs(): number { return this.ignoredEarlyInputs; }

  /** True once the last click plus its late window has passed. */
  isComplete(now: number = this.ctx.currentTime): boolean { return this.running && now >= this.endsAtCtx; }

  /** Index of the next measured click at/after `now` (for a visual metronome); -1 when done. */
  nextClickIndex(now: number = this.ctx.currentTime): number {
    return this.clicks.findIndex((t) => t >= now);
  }

  /** Stop scheduled clicks and compute the result (engine statistics). */
  finish(): LatencyProbeResult {
    this.silence();
    this.running = false;
    return computeProbeResult(this.clicks, this.inputs, {
      window: this.opts.window,
      latency: this.opts.latency,
      beatSec: this.beatSec,
    });
  }

  cancel(): void {
    this.silence();
    this.running = false;
    this.clicks = [];
    this.countInClicks = [];
    this.inputs = [];
    this.ignoredEarlyInputs = 0;
  }

  dispose(): void {
    this.cancel();
    this.out.disconnect();
  }

  private click(at: number, accent: boolean): void {
    const osc = this.ctx.createOscillator();
    osc.type = 'square';
    osc.frequency.value = accent ? this.opts.accentFreq : this.opts.clickFreq;
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(1e-4, at);
    env.gain.exponentialRampToValueAtTime(accent ? 1 : 0.7, at + 0.002);
    env.gain.exponentialRampToValueAtTime(1e-4, at + 0.04);
    osc.connect(env);
    env.connect(this.out);
    osc.onended = () => { osc.disconnect(); env.disconnect(); this.nodes = this.nodes.filter((n) => n.osc !== osc); };
    osc.start(at);
    osc.stop(at + 0.05);
    this.nodes.push({ osc, env });
  }

  /**
   * Stop and fully disconnect every pending click. The `env` gain has to go too: it is what is
   * connected to `this.out`, so leaving it behind strands one node per unplayed click on the bus
   * and they accumulate across cancel()/start() cycles (a 16-beat probe cancelled early = 20).
   */
  private silence(): void {
    for (const { osc, env } of this.nodes) {
      osc.onended = null;
      try { osc.stop(); } catch { /* already stopped */ }
      osc.disconnect();
      env.disconnect();
    }
    this.nodes = [];
  }
}
