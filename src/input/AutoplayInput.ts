/**
 * AutoplayInput: hits every chart note at its exact time (optionally with deterministic jitter and a
 * hit probability) — for screenshots (?autoplay=1) and pipeline tests.
 */
import type { Chart, Note } from '../engine/types.ts';
import { ReplayInput } from './ReplayInput.ts';
import type { ReplayEvent } from './ReplayInput.ts';
import type { CtxClock, SongTimeSource } from './types.ts';

export interface AutoplayInputConfig {
  chart: Pick<Chart, 'notes' | 'lanes'> | { notes: Note[]; lanes?: number };
  audioContext: CtxClock;
  songClock: SongTimeSource;
  /** Uniform jitter amplitude in ms: each hit is shifted by ±jitterMs (default 0). */
  jitterMs?: number;
  /** Fraction of notes actually hit (default 1). */
  hitFraction?: number;
  /** Seed for the deterministic PRNG (default 1). */
  seed?: number;
  /** Constant song-time offset added to every hit (seconds; simulates input latency). */
  offsetSec?: number;
  autoTick?: boolean;
  tickMs?: number;
}

/** mulberry32 PRNG. */
export function seededRandom(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Build the replay script for a chart. Exported so critics can inspect/modify it. */
export function autoplayEvents(notes: readonly Note[], opts: { jitterMs?: number; hitFraction?: number; seed?: number; offsetSec?: number } = {}): ReplayEvent[] {
  const rnd = seededRandom(opts.seed ?? 1);
  const jitter = (opts.jitterMs ?? 0) / 1000;
  const frac = opts.hitFraction ?? 1;
  const offset = opts.offsetSec ?? 0;
  const out: ReplayEvent[] = [];
  for (const n of notes) {
    const roll = rnd();
    const j = (rnd() * 2 - 1) * jitter;
    if (roll >= frac) continue;
    out.push({ lane: n.lane, songTime: n.time + offset + j, strength: 1 });
  }
  return out.sort((a, b) => a.songTime - b.songTime);
}

export class AutoplayInput extends ReplayInput {
  readonly script: ReplayEvent[];

  constructor(config: AutoplayInputConfig) {
    const script = autoplayEvents(config.chart.notes, config);
    super({
      events: script,
      audioContext: config.audioContext,
      songClock: config.songClock,
      lanes: config.chart.lanes ?? Math.max(4, ...config.chart.notes.map((n) => n.lane + 1)),
      autoTick: config.autoTick,
      tickMs: config.tickMs,
    });
    this.script = script;
  }
}
