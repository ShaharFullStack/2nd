/**
 * Latency calibration probe.
 *
 * Plays a synthesized metronome on a steady grid (default 100 BPM) using the AudioContext
 * clock, records the ctx timestamps of the patient's inputs (LaneInputEvent.ctxTime) and
 * returns robust offset statistics: median (the latency to compensate) and MAD (jitter).
 *
 * Note: src/engine/latency.ts did not exist when this was written, so the median/MAD
 * helpers live here (`robustStats`) and are exported for reuse.
 */

export interface LatencyProbeOptions {
  bpm?: number;
  /** Number of clicks (beats) in the measurement. */
  beats?: number;
  /** Extra clicks at the start that are played but not used for statistics. */
  countIn?: number;
  clickFreq?: number;
  accentFreq?: number;
  /** Accent every N clicks (default 4). */
  accentEvery?: number;
  /** Max |input - click| that still counts as a match, in seconds (default: 45 % of the beat). */
  matchWindowSec?: number;
  /** Lead before the first click when start() is called without a time (default 0.5 s). */
  startDelaySec?: number;
  destination?: AudioNode;
  volume?: number;
  /** Fewest matched beats for `accepted` (default max(4, half of `beats`)). */
  minMatched?: number;
  /** Largest MAD (ms) for `accepted` (default 60). */
  maxMadMs?: number;
}

export interface LatencyStats {
  n: number;
  medianMs: number;
  /** Median absolute deviation from the median (raw, not scaled). */
  madMs: number;
  /** 1.4826 × MAD — a robust estimate of the standard deviation. */
  sigmaMs: number;
  meanMs: number;
  minMs: number;
  maxMs: number;
}

export interface MatchResult {
  /** input - click, seconds, one per matched click (in click order). */
  offsetsSec: number[];
  matched: number;
  /** Clicks with no input inside the window. */
  unmatchedClicks: number;
  /** Inputs that matched no click. */
  spurious: number;
}

export interface LatencyResult extends LatencyStats {
  /** Median offset in seconds — feed this to the engine as `inputLatencySec`. */
  offsetSec: number;
  matched: number;
  unmatchedClicks: number;
  spurious: number;
  totalClicks: number;
  accepted: boolean;
  /** Per-beat offsets in ms (for plotting). */
  samplesMs: number[];
}

export function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Median / MAD / mean / min / max. All inputs and outputs in milliseconds. */
export function robustStats(valuesMs: number[]): LatencyStats {
  const n = valuesMs.length;
  if (n === 0) return { n: 0, medianMs: NaN, madMs: NaN, sigmaMs: NaN, meanMs: NaN, minMs: NaN, maxMs: NaN };
  const med = median(valuesMs);
  const mad = median(valuesMs.map((v) => Math.abs(v - med)));
  let sum = 0, min = Infinity, max = -Infinity;
  for (const v of valuesMs) { sum += v; if (v < min) min = v; if (v > max) max = v; }
  return { n, medianMs: med, madMs: mad, sigmaMs: 1.4826 * mad, meanMs: sum / n, minMs: min, maxMs: max };
}

/** ctx times of `count` clicks starting at `startCtxTime`. */
export function clickSchedule(startCtxTime: number, bpm: number, count: number): number[] {
  const beat = 60 / bpm;
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(startCtxTime + i * beat);
  return out;
}

/**
 * Pair each click with the closest input inside ±maxAbsSec (each input used at most once,
 * closest pairs first). Offsets are input − click, so camera latency shows up positive.
 */
export function matchInputsToClicks(clickTimes: number[], inputTimes: number[], maxAbsSec: number): MatchResult {
  const pairs: { c: number; i: number; d: number }[] = [];
  for (let c = 0; c < clickTimes.length; c++) {
    for (let i = 0; i < inputTimes.length; i++) {
      const d = inputTimes[i] - clickTimes[c];
      if (Math.abs(d) <= maxAbsSec) pairs.push({ c, i, d });
    }
  }
  pairs.sort((a, b) => Math.abs(a.d) - Math.abs(b.d));
  const usedClick = new Set<number>();
  const usedInput = new Set<number>();
  const offsetByClick = new Map<number, number>();
  for (const p of pairs) {
    if (usedClick.has(p.c) || usedInput.has(p.i)) continue;
    usedClick.add(p.c);
    usedInput.add(p.i);
    offsetByClick.set(p.c, p.d);
  }
  const offsetsSec = [...offsetByClick.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]);
  return {
    offsetsSec,
    matched: offsetsSec.length,
    unmatchedClicks: clickTimes.length - offsetsSec.length,
    spurious: inputTimes.length - usedInput.size,
  };
}

/** Pure part of the probe: from click + input times to a LatencyResult. */
export function computeLatencyResult(
  clickTimes: number[],
  inputTimes: number[],
  opts: { matchWindowSec: number; minMatched: number; maxMadMs: number },
): LatencyResult {
  const m = matchInputsToClicks(clickTimes, inputTimes, opts.matchWindowSec);
  const samplesMs = m.offsetsSec.map((s) => s * 1000);
  const stats = robustStats(samplesMs);
  const accepted = m.matched >= opts.minMatched && Number.isFinite(stats.madMs) && stats.madMs <= opts.maxMadMs;
  return {
    ...stats,
    offsetSec: Number.isFinite(stats.medianMs) ? stats.medianMs / 1000 : 0,
    matched: m.matched,
    unmatchedClicks: m.unmatchedClicks,
    spurious: m.spurious,
    totalClicks: clickTimes.length,
    accepted,
    samplesMs,
  };
}

export class LatencyProbe {
  readonly ctx: BaseAudioContext;
  private readonly opts: Required<Omit<LatencyProbeOptions, 'destination' | 'matchWindowSec' | 'minMatched'>> & { matchWindowSec: number; minMatched: number };
  private readonly destination: AudioNode;
  private readonly out: GainNode;
  private clicks: number[] = [];
  private countInClicks: number[] = [];
  private inputs: number[] = [];
  private nodes: OscillatorNode[] = [];
  private running = false;
  private endsAtCtx = 0;

  constructor(ctx: BaseAudioContext, options: LatencyProbeOptions = {}) {
    this.ctx = ctx;
    const bpm = options.bpm ?? 100;
    const beats = options.beats ?? 16;
    this.opts = {
      bpm,
      beats,
      countIn: options.countIn ?? 4,
      clickFreq: options.clickFreq ?? 1000,
      accentFreq: options.accentFreq ?? 1500,
      accentEvery: options.accentEvery ?? 4,
      matchWindowSec: options.matchWindowSec ?? (60 / bpm) * 0.45,
      startDelaySec: options.startDelaySec ?? 0.5,
      volume: options.volume ?? 0.6,
      minMatched: options.minMatched ?? Math.max(4, Math.ceil(beats / 2)),
      maxMadMs: options.maxMadMs ?? 60,
    };
    this.destination = options.destination ?? ctx.destination;
    this.out = ctx.createGain();
    this.out.gain.value = this.opts.volume;
    this.out.connect(this.destination);
  }

  get isRunning(): boolean { return this.running; }
  /** ctx times of the measured clicks (excludes count-in). */
  get clickTimes(): number[] { return [...this.clicks]; }
  get inputTimes(): number[] { return [...this.inputs]; }
  get beatSec(): number { return 60 / this.opts.bpm; }
  /** ctx time when the last click has sounded (plus one beat of grace for the final input). */
  get endsAt(): number { return this.endsAtCtx; }

  /** Schedule all clicks. Returns the measured-click schedule and the ctx time the session ends. */
  start(atCtxTime?: number): { clickTimes: number[]; countInTimes: number[]; endsAt: number } {
    this.cancel();
    const first = Math.max(this.ctx.currentTime + 0.05, atCtxTime ?? this.ctx.currentTime + this.opts.startDelaySec);
    const all = clickSchedule(first, this.opts.bpm, this.opts.countIn + this.opts.beats);
    this.countInClicks = all.slice(0, this.opts.countIn);
    this.clicks = all.slice(this.opts.countIn);
    this.inputs = [];
    all.forEach((t, i) => {
      const accent = (i - this.opts.countIn) % this.opts.accentEvery === 0 && i >= this.opts.countIn;
      this.click(t, accent);
    });
    this.endsAtCtx = all[all.length - 1] + this.beatSec;
    this.running = true;
    return { clickTimes: this.clickTimes, countInTimes: [...this.countInClicks], endsAt: this.endsAtCtx };
  }

  /** Feed an input timestamp (LaneInputEvent.ctxTime). Ignored when not running. */
  recordInput(ctxTime: number): void {
    if (!this.running) return;
    this.inputs.push(ctxTime);
  }

  /** True once the last click (plus grace) has passed. */
  isComplete(now: number = this.ctx.currentTime): boolean { return this.running && now >= this.endsAtCtx; }

  /** Index of the next click at/after `now` (for a visual metronome); -1 when done. */
  nextClickIndex(now: number = this.ctx.currentTime): number {
    return this.clicks.findIndex((t) => t >= now);
  }

  /** Stop scheduled clicks and compute the statistics. */
  finish(): LatencyResult {
    this.silence();
    this.running = false;
    return computeLatencyResult(this.clicks, this.inputs, this.opts);
  }

  cancel(): void {
    this.silence();
    this.running = false;
    this.clicks = [];
    this.countInClicks = [];
    this.inputs = [];
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
