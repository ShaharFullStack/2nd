/**
 * Tiny synthesized feedback sounds (no audio files): hit tick, perfect sparkle, miss thud,
 * combo milestone. Everything is oscillators + gain envelopes on the shared AudioContext.
 */

export type SfxKind = 'hit' | 'perfect' | 'miss' | 'combo';

interface ToneSpec {
  type: OscillatorType;
  freq: number;
  /** Optional exponential frequency glide target reached at the end of the tone. */
  freqEnd?: number;
  start: number;
  dur: number;
  peak: number;
  attack?: number;
  /** Optional lowpass cutoff (Hz). */
  lowpass?: number;
}

const FLOOR = 1e-4;

export class Sfx {
  readonly ctx: BaseAudioContext;
  private readonly out: GainNode;
  private volumeValue: number;
  private enabledValue = true;
  private disposed = false;

  constructor(ctx: BaseAudioContext, destination?: AudioNode, volume: number = 0.5) {
    this.ctx = ctx;
    this.out = ctx.createGain();
    this.volumeValue = Math.max(0, Math.min(1, volume));
    this.out.gain.value = this.volumeValue;
    this.out.connect(destination ?? ctx.destination);
  }

  get volume(): number { return this.volumeValue; }
  set volume(v: number) {
    this.volumeValue = Math.max(0, Math.min(1, v));
    const now = this.ctx.currentTime;
    this.out.gain.cancelScheduledValues(now);
    this.out.gain.setValueAtTime(this.out.gain.value, now);
    this.out.gain.linearRampToValueAtTime(this.volumeValue, now + 0.02);
  }

  get enabled(): boolean { return this.enabledValue; }
  set enabled(v: boolean) { this.enabledValue = v; }

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
    this.tone({ type: 'triangle', freq: 1500, freqEnd: 900, start: t, dur: 0.045, peak: 0.5 });
    this.tone({ type: 'square', freq: 3200, start: t, dur: 0.015, peak: 0.12, lowpass: 6000 });
  }

  /** Tick plus a rising three-note sparkle. */
  perfect(when?: number): void {
    const t = this.at(when);
    this.tone({ type: 'triangle', freq: 1800, freqEnd: 1200, start: t, dur: 0.04, peak: 0.45 });
    const notes = [1568, 2093, 3136];
    notes.forEach((f, i) => this.tone({ type: 'sine', freq: f, start: t + i * 0.035, dur: 0.16, peak: 0.28, attack: 0.004 }));
  }

  /** Low, damped thud. */
  miss(when?: number): void {
    const t = this.at(when);
    this.tone({ type: 'sine', freq: 150, freqEnd: 45, start: t, dur: 0.2, peak: 0.9 });
    this.tone({ type: 'square', freq: 95, freqEnd: 40, start: t, dur: 0.11, peak: 0.35, lowpass: 220 });
  }

  /** Ascending arpeggio; longer for bigger milestones (10, 25, 50, …). */
  combo(milestone: number, when?: number): void {
    const t = this.at(when);
    const count = Math.max(3, Math.min(6, 3 + Math.floor(milestone / 25)));
    const semis = [0, 4, 7, 12, 16, 19];
    for (let i = 0; i < count; i++) {
      const f = 880 * Math.pow(2, semis[i] / 12);
      const last = i === count - 1;
      this.tone({ type: 'triangle', freq: f, start: t + i * 0.07, dur: last ? 0.45 : 0.18, peak: 0.32, attack: 0.005 });
      if (last) this.tone({ type: 'sine', freq: f * 2, start: t + i * 0.07, dur: 0.4, peak: 0.15, attack: 0.01 });
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
    if (this.disposed || !this.enabledValue || this.volumeValue <= 0) return;
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
