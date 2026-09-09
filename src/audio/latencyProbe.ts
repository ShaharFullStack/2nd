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
 * Tempo: the engine recommends 60 BPM (`CALIBRATION_BPM_RECOMMENDED`). A slow, seated movement
 * measured through a 30 fps camera can lag the click by 300–700 ms; with a 1 s beat and the
 * engine's asymmetric pairing window (−25 % / +75 % of the beat) such inputs still pair with the
 * beat they answer instead of being counted as early hits of the next one.
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

/** Why a calibration run was not confident (for the calibration screen's remedy text). */
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
  | 'too-many-outliers';

export interface LatencyProbeResult extends CalibrationResult {
  /** Same as `confident` (kept as the probe's verdict name). */
  accepted: boolean;
  totalClicks: number;
  /** Inputs recorded during the measured part of the run. */
  inputs: number;
  /** observed − expected for every paired beat, in ms and in beat order (for plotting). */
  samplesMs: number[];
  diagnosis: ProbeDiagnosis;
  /** Short, patient-facing explanation of `diagnosis`. */
  message: string;
}

/** ctx times of `count` clicks starting at `startCtxTime`. */
export function clickSchedule(startCtxTime: number, bpm: number, count: number): number[] {
  const beat = 60 / bpm;
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(startCtxTime + i * beat);
  return out;
}

export function diagnosisMessage(d: ProbeDiagnosis): string {
  switch (d) {
    case 'ok': return 'Calibration succeeded.';
    case 'no-input': return 'No movement was detected. Check that the camera sees you and try a bigger movement.';
    case 'out-of-window': return 'Your movements were detected, but too far from the clicks to be measured. Try to move exactly on each click; a slower tempo can help.';
    case 'too-few': return 'Not enough clicks were answered. Try to move on every click.';
    case 'too-jittery': return 'Your timing varied a lot between clicks. Try again, moving as steadily as you can.';
    case 'too-many-outliers': return 'Several movements were far from the beat. Try again, moving on every click.';
  }
}

/** Classify a calibration run; pure so the calibration screen can be unit-tested against it. */
export function diagnoseCalibration(
  r: CalibrationResult,
  totalBeats: number,
  opts: LatencyOptions = {},
): ProbeDiagnosis {
  const minSamples = opts.minSamples ?? LATENCY_MIN_SAMPLES;
  const maxMad = opts.maxMadSec ?? LATENCY_MAX_MAD_SEC;
  const maxRejected = opts.maxRejectedFraction ?? LATENCY_MAX_REJECTED_FRACTION;
  const { pairing } = r;
  if (pairing.pairs.length === 0 && pairing.spuriousInputs === 0) return 'no-input';
  if (r.confident) return 'ok';
  const unpairedFraction = totalBeats > 0 ? pairing.unpairedBeats / totalBeats : 1;
  // inputs exist but do not pair: the patient is answering the clicks outside the window
  if (unpairedFraction > maxRejected && pairing.spuriousInputs >= Math.ceil(pairing.unpairedBeats / 2)) return 'out-of-window';
  if (r.samples < minSamples) return 'too-few';
  if (r.madSec > maxMad) return 'too-jittery';
  return 'too-many-outliers';
}

/**
 * Pure part of the probe: measured click times + recorded input times → result.
 * Delegates all statistics to the engine (`calibrateLatency`).
 */
export function computeProbeResult(
  clickTimes: readonly number[],
  inputTimes: readonly number[],
  opts: { window?: number | PairingWindow; latency?: LatencyOptions } = {},
): LatencyProbeResult {
  const cal = calibrateLatency(clickTimes, inputTimes, { ...opts.latency, window: opts.window });
  const diagnosis = diagnoseCalibration(cal, clickTimes.length, opts.latency);
  return {
    ...cal,
    accepted: cal.confident,
    totalClicks: clickTimes.length,
    inputs: inputTimes.length,
    samplesMs: cal.pairing.pairs.map((p) => (p.observed - p.expected) * 1000),
    diagnosis,
    message: diagnosisMessage(diagnosis),
  };
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
  private nodes: OscillatorNode[] = [];
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
    return computeProbeResult(this.clicks, this.inputs, { window: this.opts.window, latency: this.opts.latency });
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
    osc.onended = () => { osc.disconnect(); env.disconnect(); this.nodes = this.nodes.filter((n) => n !== osc); };
    osc.start(at);
    osc.stop(at + 0.05);
    this.nodes.push(osc);
  }

  private silence(): void {
    for (const osc of this.nodes) { osc.onended = null; try { osc.stop(); } catch { /* already stopped */ } osc.disconnect(); }
    this.nodes = [];
  }
}
