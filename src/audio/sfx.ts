/**
 * Tiny synthesized feedback sounds (no audio files): hit tick, perfect sparkle, miss thud,
 * combo milestone. Everything is oscillators + gain envelopes on the shared AudioContext.
 *
 * Levels: the miss cue is deliberately quieter than the hit cue (see `DEFAULT_SFX_LEVELS`) so a
 * run of misses is a soft reminder rather than a barrage; per-kind levels are adjustable.
 */

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

/** Peak envelope gain of each cue before per-kind levels (the loudest partial). */
export const SFX_PEAKS: SfxLevels = { hit: 0.5, perfect: 0.45, miss: 0.5, combo: 0.32 };

export class Sfx {
  readonly ctx: BaseAudioContext;
  private readonly out: GainNode;
  private volumeValue: number;
  private enabledValue = true;
  private disposed = false;
  private readonly levels: SfxLevels;

  constructor(ctx: BaseAudioContext, destination?: AudioNode, volume: number = 0.5, levels: Partial<SfxLevels> = {}) {
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.volumeValue = clamp01(volume);
    this.out.gain.value = this.volumeValue;
    this.out.connect(destination ?? ctx.destination);
    this.levels = { ...DEFAULT_SFX_LEVELS, ...levels };
  }

  get volume(): number { return this.volumeValue; }
  set volume(v: number) {
    this.volumeValue = clamp01(v);
    const now = this.ctx.currentTime;
    this.out.gain.cancelScheduledValues(now);
    this.out.gain.setValueAtTime(this.out.gain.value, now);
    this.out.gain.linearRampToValueAtTime(this.volumeValue, now + 0.02);
  }

  get enabled(): boolean { return this.enabledValue; }
  set enabled(v: boolean) { this.enabledValue = v; }

  /** Per-kind level multiplier (0..1). */
  getLevel(kind: SfxKind): number { return this.levels[kind]; }
  setLevel(kind: SfxKind, level: number): void { this.levels[kind] = clamp01(level); }

  /** Effective peak gain of a cue's loudest partial (kind level × master volume). */
  effectivePeak(kind: SfxKind): number { return SFX_PEAKS[kind] * this.levels[kind] * this.volumeValue; }

  /** Play a sound; `when` is an AudioContext time (defaults to now). */
  play(kind: SfxKind, when?: number, milestone: number = 10): void {
    switch (kind) {
      case 'hit': this.hit(when); break;
      case 'perfect': this.perfect(when); break;
      case 'miss': this.miss(when); break;
      case 'combo': this.combo(milestone, when); break;
    }
  }

  /** Short bright tick. */
  hit(when?: number): void {
    const t = this.at(when);
    const l = this.levels.hit;
    this.tone({ type: 'triangle', freq: 1500, freqEnd: 900, start: t, dur: 0.045, peak: 0.5 * l });
    this.tone({ type: 'square', freq: 3200, start: t, dur: 0.015, peak: 0.12 * l, lowpass: 6000 });
  }

  /** Tick plus a rising three-note sparkle. */
  perfect(when?: number): void {
    const t = this.at(when);
    const l = this.levels.perfect;
    this.tone({ type: 'triangle', freq: 1800, freqEnd: 1200, start: t, dur: 0.04, peak: 0.45 * l });
    const notes = [1568, 2093, 3136];
    notes.forEach((f, i) => this.tone({ type: 'sine', freq: f, start: t + i * 0.035, dur: 0.16, peak: 0.28 * l, attack: 0.004 }));
  }

  /** Low, damped thud (quieter than the hit tick by default). */
  miss(when?: number): void {
    const t = this.at(when);
    const l = this.levels.miss;
    this.tone({ type: 'sine', freq: 150, freqEnd: 45, start: t, dur: 0.2, peak: 0.5 * l });
    this.tone({ type: 'square', freq: 95, freqEnd: 40, start: t, dur: 0.11, peak: 0.2 * l, lowpass: 220 });
  }

  /** Ascending arpeggio; longer for bigger milestones (10, 25, 50, …). */
  combo(milestone: number, when?: number): void {
    const t = this.at(when);
    const l = this.levels.combo;
    const count = Math.max(3, Math.min(6, 3 + Math.floor(milestone / 25)));
    const semis = [0, 4, 7, 12, 16, 19];
    for (let i = 0; i < count; i++) {
      const f = 880 * Math.pow(2, semis[i] / 12);
      const last = i === count - 1;
      this.tone({ type: 'triangle', freq: f, start: t + i * 0.07, dur: last ? 0.45 : 0.18, peak: 0.32 * l, attack: 0.005 });
      if (last) this.tone({ type: 'sine', freq: f * 2, start: t + i * 0.07, dur: 0.4, peak: 0.15 * l, attack: 0.01 });
    }
  }

  dispose(): void {
    this.disposed = true;
    this.out.disconnect();
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
