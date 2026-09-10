/**
 * Tiny synthesized feedback sounds (no audio files): hit tick, perfect sparkle, miss thud,
 * combo milestone. Everything is oscillators + gain envelopes on the shared AudioContext.
 *
 * Levels: the miss cue is deliberately quieter than the hit cue (see `DEFAULT_SFX_LEVELS`) so a
 * run of misses is a soft reminder rather than a barrage; per-kind levels are adjustable.
 *
 * Per-lane layer (ARCHITECTURE "optional per-lane hit SFX layer, toggleable"): when `perLane`
 * is on (default) the hit tick and the perfect sparkle are transposed by `LANE_SEMITONES[lane]`
 * so each lane has its own pitch; `perLane = false` makes every lane sound identical.
 *
 * ROUTING — the destination is not optional in practice. `new Sfx(ctx)` connects straight to
 * `ctx.destination`, which BYPASSES StemMixer's master gain and limiter, and the music already
 * runs at a ~0.9 ceiling: adding an un-limited cue on top hard-clips on exactly the moments the
 * patient is being rewarded. Always route through the mixer:
 *     const sfx = mixer.createSfx();            // or: new Sfx(mixer.ctx, mixer.sfxBus)
 * `sfxBusPeak()` / `Sfx.busPeak()` report the worst-case level this bus adds, and
 * `StemMixer`'s headroom budget (headroom.test.ts) includes it.
 */

import { SmoothGain } from './ducking';

export type SfxKind = 'hit' | 'perfect' | 'miss' | 'combo';

export type SfxLevels = Record<SfxKind, number>;

/** Per-kind gain multipliers (0..1) applied on top of the master `volume`. */
export const DEFAULT_SFX_LEVELS: SfxLevels = { hit: 1, perfect: 1, miss: 0.55, combo: 0.9 };

export interface ToneSpec {
  type: OscillatorType;
  freq: number;
  /** Optional exponential frequency glide target reached at the end of the tone. */
  freqEnd?: number;
  start: number;
  dur: number;
  /** Peak envelope gain (before the kind level and master volume). */
  peak: number;
  attack?: number;
  /** Optional lowpass cutoff (Hz). */
  lowpass?: number;
}

const FLOOR = 1e-4;

/** Peak envelope gain of the loudest single partial of each cue, before per-kind levels. */
export const SFX_PEAKS: SfxLevels = { hit: 0.5, perfect: 0.45, miss: 0.5, combo: 0.32 };

/** Transposition of the hit/perfect cues per lane (semitones; lanes beyond the list wrap). */
export const LANE_SEMITONES: readonly number[] = [0, 3, 7, 12];

/** Frequency ratio applied to the hit/perfect cues of `lane` (1 for an undefined lane). */
export function laneRatio(lane: number | undefined): number {
  if (lane === undefined || !Number.isFinite(lane)) return 1;
  const i = ((Math.floor(lane) % LANE_SEMITONES.length) + LANE_SEMITONES.length) % LANE_SEMITONES.length;
  return Math.pow(2, LANE_SEMITONES[i] / 12);
}

export interface SfxPlayOptions {
  /** Combo milestone (10, 25, 50, …) for the 'combo' cue. */
  milestone?: number;
  /** Lane index for the per-lane hit/perfect variation. */
  lane?: number;
}

export interface CueOptions {
  /** Per-kind level multiplier already applied to every partial's peak (default 1). */
  level?: number;
  /** Frequency ratio for the per-lane variation (default 1). */
  ratio?: number;
  /** Combo milestone for the 'combo' cue (default 10). */
  milestone?: number;
}

/**
 * The partials of one cue, with `start` relative to the cue's own onset. Single source of truth:
 * `Sfx` plays exactly these specs, and `envelopeSumPeak` measures them for the headroom proof.
 */
export function cueTones(kind: SfxKind, opts: CueOptions = {}): ToneSpec[] {
  const l = opts.level ?? 1;
  const r = opts.ratio ?? 1;
  switch (kind) {
    case 'hit':
      return [
        { type: 'triangle', freq: 1500 * r, freqEnd: 900 * r, start: 0, dur: 0.045, peak: 0.5 * l },
        { type: 'square', freq: 3200 * r, start: 0, dur: 0.015, peak: 0.12 * l, lowpass: 6000 },
      ];
    case 'perfect': {
      const out: ToneSpec[] = [{ type: 'triangle', freq: 1800 * r, freqEnd: 1200 * r, start: 0, dur: 0.04, peak: 0.45 * l }];
      [1568, 2093, 3136].forEach((f, i) => out.push({ type: 'sine', freq: f * r, start: i * 0.035, dur: 0.16, peak: 0.28 * l, attack: 0.004 }));
      return out;
    }
    case 'miss':
      return [
        { type: 'sine', freq: 150, freqEnd: 45, start: 0, dur: 0.2, peak: 0.5 * l },
        { type: 'square', freq: 95, freqEnd: 40, start: 0, dur: 0.11, peak: 0.2 * l, lowpass: 220 },
      ];
    case 'combo': {
      const milestone = opts.milestone ?? 10;
      const count = Math.max(3, Math.min(6, 3 + Math.floor(milestone / 25)));
      const semis = [0, 4, 7, 12, 16, 19];
      const out: ToneSpec[] = [];
      for (let i = 0; i < count; i++) {
        const f = 880 * Math.pow(2, semis[i] / 12);
        const last = i === count - 1;
        out.push({ type: 'triangle', freq: f, start: i * 0.07, dur: last ? 0.45 : 0.18, peak: 0.32 * l, attack: 0.005 });
        if (last) out.push({ type: 'sine', freq: f * 2, start: i * 0.07, dur: 0.4, peak: 0.15 * l, attack: 0.01 });
      }
      return out;
    }
  }
}

/** Value of one partial's exponential attack/decay envelope at time `t` (relative to the cue onset). */
export function envelopeAt(spec: ToneSpec, t: number): number {
  const attack = spec.attack ?? 0.002;
  const t0 = spec.start;
  if (t <= t0 || t >= t0 + spec.dur) return 0;
  const peak = Math.max(spec.peak, FLOOR);
  if (t < t0 + attack) return FLOOR * Math.pow(peak / FLOOR, (t - t0) / attack);
  return peak * Math.pow(FLOOR / peak, (t - t0 - attack) / (spec.dur - attack));
}

/**
 * Worst-case peak of a cue: the maximum over time of the SUM of its partials' envelopes. Summing
 * envelopes (rather than taking the loudest partial) is the coherent worst case — partials of
 * different frequencies rarely align in phase, so this is an upper bound, which is what a headroom
 * budget needs. Sampled at 1 kHz, which resolves the 2–5 ms attacks that dominate the peak.
 */
export function envelopeSumPeak(specs: readonly ToneSpec[], stepSec = 0.001): number {
  let end = 0;
  for (const s of specs) end = Math.max(end, s.start + s.dur);
  let peak = 0;
  for (let t = 0; t <= end; t += stepSec) {
    let sum = 0;
    for (const s of specs) sum += envelopeAt(s, t);
    if (sum > peak) peak = sum;
  }
  return peak;
}

/** Worst-case (coherently summed) peak of each cue at level 1 and volume 1. */
export const SFX_CUE_PEAKS: SfxLevels = {
  hit: envelopeSumPeak(cueTones('hit')),
  perfect: envelopeSumPeak(cueTones('perfect')),
  miss: envelopeSumPeak(cueTones('miss')),
  combo: envelopeSumPeak(cueTones('combo', { milestone: 100 })),
};

/**
 * Worst-case peak the SFX bus can present to the master at `volume` with `levels`: the loudest
 * single cue (a hit and a combo milestone can coincide, but the combo cue is much quieter and its
 * arpeggio peaks 70 ms later, so the loudest single cue is the operative bound).
 */
export function sfxBusPeak(volume: number, levels: Partial<SfxLevels> = {}): number {
  const l: SfxLevels = { ...DEFAULT_SFX_LEVELS, ...levels };
  let peak = 0;
  for (const k of Object.keys(SFX_CUE_PEAKS) as SfxKind[]) peak = Math.max(peak, SFX_CUE_PEAKS[k] * l[k]);
  return peak * Math.max(0, volume);
}

export class Sfx {
  readonly ctx: BaseAudioContext;
  private readonly out: GainNode;
  private readonly volumeCtl: SmoothGain;
  private volumeValue: number;
  private enabledValue = true;
  private perLaneValue = true;
  private disposed = false;
  private readonly levels: SfxLevels;

  constructor(ctx: BaseAudioContext, destination?: AudioNode, volume: number = 0.5, levels: Partial<SfxLevels> = {}) {
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.volumeValue = clamp01(volume);
    this.volumeCtl = new SmoothGain(this.out.gain, this.volumeValue);
    this.out.connect(destination ?? ctx.destination);
    this.levels = { ...DEFAULT_SFX_LEVELS, ...levels };
  }

  get volume(): number { return this.volumeValue; }
  /** Anchored 20 ms ramp (a slider can set this every frame without steps). */
  set volume(v: number) {
    this.volumeValue = clamp01(v);
    this.volumeCtl.set(this.volumeValue, this.ctx.currentTime, 0.02);
  }

  get enabled(): boolean { return this.enabledValue; }
  set enabled(v: boolean) { this.enabledValue = v; }

  /** Per-lane pitch variation of the hit/perfect cues (default on). */
  get perLane(): boolean { return this.perLaneValue; }
  set perLane(v: boolean) { this.perLaneValue = v; }

  /** Per-kind level multiplier (0..1). */
  getLevel(kind: SfxKind): number { return this.levels[kind]; }
  setLevel(kind: SfxKind, level: number): void { this.levels[kind] = clamp01(level); }

  /** Effective peak gain of a cue's loudest partial (kind level × master volume). */
  effectivePeak(kind: SfxKind): number { return SFX_PEAKS[kind] * this.levels[kind] * this.volumeValue; }

  /**
   * Worst-case peak this Sfx can present to its destination right now (loudest cue, partials
   * summed coherently). `StemMixer`'s headroom budget uses this — see headroom.test.ts.
   */
  busPeak(): number { return sfxBusPeak(this.volumeValue, this.levels); }

  /**
   * Play a sound; `when` is an AudioContext time (defaults to now). The third argument is the
   * combo milestone (number, kept for the original API) or `{ milestone, lane }`.
   */
  play(kind: SfxKind, when?: number, opts: number | SfxPlayOptions = {}): void {
    const o: SfxPlayOptions = typeof opts === 'number' ? { milestone: opts } : opts;
    switch (kind) {
      case 'hit': this.hit(when, o.lane); break;
      case 'perfect': this.perfect(when, o.lane); break;
      case 'miss': this.miss(when); break;
      case 'combo': this.combo(o.milestone ?? 10, when); break;
    }
  }

  /** Short bright tick (transposed per lane when `perLane`). */
  hit(when?: number, lane?: number): void {
    this.playCue('hit', when, { level: this.levels.hit, ratio: this.ratio(lane) });
  }

  /** Tick plus a rising three-note sparkle (transposed per lane when `perLane`). */
  perfect(when?: number, lane?: number): void {
    this.playCue('perfect', when, { level: this.levels.perfect, ratio: this.ratio(lane) });
  }

  /** Low, damped thud (quieter than the hit tick by default). */
  miss(when?: number): void {
    this.playCue('miss', when, { level: this.levels.miss });
  }

  /** Ascending arpeggio; longer for bigger milestones (10, 25, 50, …). */
  combo(milestone: number, when?: number): void {
    this.playCue('combo', when, { level: this.levels.combo, milestone });
  }

  dispose(): void {
    this.disposed = true;
    this.out.disconnect();
  }

  private ratio(lane: number | undefined): number { return this.perLaneValue ? laneRatio(lane) : 1; }

  /** Schedule every partial of `kind` at ctx time `when` (specs are relative to the onset). */
  private playCue(kind: SfxKind, when: number | undefined, opts: CueOptions): void {
    const t = this.at(when);
    for (const spec of cueTones(kind, opts)) this.tone({ ...spec, start: t + spec.start });
  }

  private at(when?: number): number {
    const now = this.ctx.currentTime;
    return when === undefined ? now : Math.max(now, when);
  }

  private tone(spec: ToneSpec): void {
    if (this.disposed || !this.enabledValue || this.volumeValue <= 0 || spec.peak <= FLOOR) return;
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = spec.type;
    osc.frequency.setValueAtTime(spec.freq, spec.start);
    if (spec.freqEnd !== undefined) osc.frequency.exponentialRampToValueAtTime(spec.freqEnd, spec.start + spec.dur);
    const env = ctx.createGain();
    const attack = spec.attack ?? 0.002;
    env.gain.setValueAtTime(FLOOR, spec.start);
    env.gain.exponentialRampToValueAtTime(spec.peak, spec.start + attack);
    env.gain.exponentialRampToValueAtTime(FLOOR, spec.start + spec.dur);
    let tail: AudioNode = env;
    if (spec.lowpass !== undefined) {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = spec.lowpass;
      env.connect(lp);
      tail = lp;
    }
    osc.connect(env);
    tail.connect(this.out);
    osc.onended = () => { osc.disconnect(); env.disconnect(); if (tail !== env) tail.disconnect(); };
    osc.start(spec.start);
    osc.stop(spec.start + spec.dur + 0.02);
  }
}

function clamp01(v: number): number { return Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0)); }
