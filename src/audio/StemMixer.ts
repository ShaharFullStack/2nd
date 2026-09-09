/**
 * StemMixer — multi-stem, sample-synchronous Web Audio playback with per-stem gain and
 * player-stem ducking (docs/ARCHITECTURE.md "Audio contract").
 *
 * Graph:  source ─ duck ─ volume ─┐
 *         source ─ duck ─ volume ─┼─ master ─ [compressor] ─ destination
 *         …                        ┘
 *
 * Time base: AudioContext.currentTime is the only clock. `getSongTime()` is
 * `offset + (ctx.currentTime - startCtxTime)` while playing; the engine adds its own
 * latency compensation when judging inputs.
 */

import type { FetchLike, SongManifest, StemSpec } from './manifest';
import { stemUrl } from './manifest';
import { DuckController, type DuckOptions } from './ducking';

export type MixerState = 'idle' | 'loading' | 'ready' | 'playing' | 'paused' | 'ended';

export interface LoadProgress {
  /** Completed steps (each stem counts twice: fetched + decoded). */
  loaded: number;
  total: number;
  stemId: string;
  phase: 'fetched' | 'decoded';
}

export interface StemMixerOptions {
  /** Pass the app-wide AudioContext (created after a user gesture). One is created lazily if absent. */
  ctx?: AudioContext;
  /** Insert a gentle DynamicsCompressorNode on the master bus (default true). */
  compressor?: boolean;
  masterGain?: number;
  duck?: Partial<DuckOptions>;
  /** Minimum scheduling lead when `play()` is called without an explicit ctx time (default 30 ms). */
  startLeadSec?: number;
  fetch?: FetchLike;
}

interface Stem {
  spec: StemSpec;
  buffer: AudioBuffer;
  duck: GainNode;
  volume: GainNode;
  source: AudioBufferSourceNode | null;
}

function decodeAudio(ctx: BaseAudioContext, data: ArrayBuffer): Promise<AudioBuffer> {
  return new Promise<AudioBuffer>((resolve, reject) => {
    const maybePromise = ctx.decodeAudioData(data, resolve, reject);
    if (maybePromise && typeof (maybePromise as Promise<AudioBuffer>).then === 'function') {
      (maybePromise as Promise<AudioBuffer>).then(resolve, reject);
    }
  });
}

export class StemMixer {
  readonly ctx: AudioContext;
  readonly master: GainNode;
  readonly compressor: DynamicsCompressorNode | null;
  /** Last node of the master chain (connect analysers here). */
  readonly output: AudioNode;

  private readonly ownsContext: boolean;
  private readonly startLeadSec: number;
  private readonly fetchImpl: FetchLike;
  private readonly duckOptions: Partial<DuckOptions>;

  private stems = new Map<string, Stem>();
  private stemOrder: string[] = [];
  private currentManifest: SongManifest | null = null;
  private playerStemId: string | null = null;
  private duckController: DuckController | null = null;

  private mixerState: MixerState = 'idle';
  private offsetSec = 0;
  private startCtxTime = 0;
  private playGeneration = 0;
  private loadGeneration = 0;
  private endedListeners = new Set<() => void>();

  constructor(options: StemMixerOptions = {}) {
    if (options.ctx) { this.ctx = options.ctx; this.ownsContext = false; }
    else { this.ctx = new AudioContext(); this.ownsContext = true; }
    this.startLeadSec = options.startLeadSec ?? 0.03;
    this.duckOptions = options.duck ?? {};
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));

    this.master = this.ctx.createGain();
    this.master.gain.value = options.masterGain ?? 1;
    if (options.compressor ?? true) {
      const c = this.ctx.createDynamicsCompressor();
      c.threshold.value = -12;
      c.knee.value = 20;
      c.ratio.value = 3;
      c.attack.value = 0.005;
      c.release.value = 0.15;
      this.master.connect(c);
      c.connect(this.ctx.destination);
      this.compressor = c;
      this.output = c;
    } else {
      this.master.connect(this.ctx.destination);
      this.compressor = null;
      this.output = this.master;
    }
  }

  // ------------------------------------------------------------------ status

  get state(): MixerState { return this.mixerState; }
  get isPlaying(): boolean { return this.mixerState === 'playing'; }
  get isLoaded(): boolean { return this.stems.size > 0; }
  get manifest(): SongManifest | null { return this.currentManifest; }
  get stemIds(): string[] { return [...this.stemOrder]; }
  get playerStem(): string | null { return this.playerStemId; }
  get isDucked(): boolean { return this.duckController?.ducked ?? false; }

  /** Song length in seconds (longest stem; falls back to the manifest while unloaded). */
  getDuration(): number {
    let d = 0;
    for (const s of this.stems.values()) d = Math.max(d, s.buffer.duration);
    return d > 0 ? d : (this.currentManifest?.durationSec ?? 0);
  }

  // ------------------------------------------------------------------ loading

  /**
   * Fetch + decode every stem of `manifest` in parallel. Resolves when all are ready.
   * `baseUrl` is the songs root (stems resolve to `${baseUrl}/${manifest.id}/${stem.file}`).
   */
  async loadSong(manifest: SongManifest, baseUrl: string = '/songs', onProgress?: (p: LoadProgress) => void): Promise<void> {
    const gen = ++this.loadGeneration;
    this.unload();
    this.mixerState = 'loading';
    this.currentManifest = manifest;
    const total = manifest.stems.length * 2;
    let loaded = 0;
    const report = (stemId: string, phase: LoadProgress['phase']) => {
      loaded++;
      onProgress?.({ loaded, total, stemId, phase });
    };
    let decoded: { spec: StemSpec; buffer: AudioBuffer }[];
    try {
      decoded = await Promise.all(manifest.stems.map(async (spec) => {
        const url = stemUrl(baseUrl, manifest, spec);
        const res = await this.fetchImpl(url);
        if (!res.ok) throw new Error(`stem "${spec.id}" (${url}) failed to load: HTTP ${res.status}`);
        const data = await res.arrayBuffer();
        report(spec.id, 'fetched');
        const buffer = await decodeAudio(this.ctx, data);
        report(spec.id, 'decoded');
        return { spec, buffer };
      }));
    } catch (err) {
      if (gen === this.loadGeneration) { this.mixerState = 'idle'; this.currentManifest = null; }
      throw err;
    }
    if (gen !== this.loadGeneration) return; // superseded by a newer loadSong()
    for (const { spec, buffer } of decoded) {
      const duck = this.ctx.createGain();
      const volume = this.ctx.createGain();
      duck.connect(volume);
      volume.connect(this.master);
      this.stems.set(spec.id, { spec, buffer, duck, volume, source: null });
      this.stemOrder.push(spec.id);
    }
    this.offsetSec = 0;
    this.mixerState = 'ready';
    this.setPlayerStem(manifest.playerStem);
  }

  /** Drop the loaded song (keeps the master chain). */
  unload(): void {
    this.stopSources();
    for (const s of this.stems.values()) { s.duck.disconnect(); s.volume.disconnect(); }
    this.stems.clear();
    this.stemOrder = [];
    this.currentManifest = null;
    this.playerStemId = null;
    this.duckController = null;
    this.offsetSec = 0;
    this.mixerState = 'idle';
  }

  // ------------------------------------------------------------------ transport

  /**
   * Start every stem at the same ctx time (sample-accurate). `atCtxTime` defaults to
   * now + startLead; `fromSongTime` defaults to the current position (0 after load/stop,
   * the pause point after pause). Returns the ctx time at which audio starts.
   */
  play(atCtxTime?: number, fromSongTime?: number): number {
    if (this.stems.size === 0) throw new Error('StemMixer.play(): no song loaded');
    this.stopSources();
    if (fromSongTime !== undefined) this.offsetSec = fromSongTime;
    else if (this.mixerState === 'ended') this.offsetSec = 0;
    this.offsetSec = Math.max(0, this.offsetSec);
    const now = this.ctx.currentTime;
    const startAt = Math.max(now + this.startLeadSec, atCtxTime ?? 0);
    const gen = ++this.playGeneration;
    let longest: Stem | null = null;
    for (const stem of this.stems.values()) {
      if (this.offsetSec >= stem.buffer.duration) continue; // this stem is already over
      const src = this.ctx.createBufferSource();
      src.buffer = stem.buffer;
      src.connect(stem.duck);
      src.start(startAt, this.offsetSec);
      stem.source = src;
      if (!longest || stem.buffer.duration > longest.buffer.duration) longest = stem;
    }
    if (longest?.source) {
      longest.source.onended = () => {
        if (gen !== this.playGeneration || this.mixerState !== 'playing') return;
        this.offsetSec = this.getDuration();
        this.mixerState = 'ended';
        this.clearSources();
        for (const cb of this.endedListeners) cb();
      };
    }
    this.startCtxTime = startAt;
    this.mixerState = 'playing';
    this.duckController?.reset(now);
    return startAt;
  }

  pause(): void {
    if (this.mixerState !== 'playing') return;
    this.offsetSec = Math.min(this.getSongTime(), this.getDuration());
    this.stopSources();
    this.mixerState = 'paused';
  }

  /**
   * Resume the AudioContext (must follow a user gesture on most browsers) and, if the song
   * was paused, continue playback from the pause point.
   */
  async resume(): Promise<void> {
    await this.resumeContext();
    if (this.mixerState === 'paused') this.play();
  }

  /** Only resume the AudioContext (no transport change). Safe to call repeatedly. */
  async resumeContext(): Promise<void> {
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  seek(songTime: number): void {
    const t = Math.max(0, Math.min(songTime, this.getDuration()));
    if (this.mixerState === 'playing') { this.play(undefined, t); return; }
    this.offsetSec = t;
    if (this.mixerState === 'ended') this.mixerState = 'ready';
  }

  stop(): void {
    this.stopSources();
    this.offsetSec = 0;
    if (this.stems.size > 0) this.mixerState = 'ready';
    this.duckController?.reset(this.ctx.currentTime);
  }

  onEnded(cb: () => void): () => void {
    this.endedListeners.add(cb);
    return () => { this.endedListeners.delete(cb); };
  }

  // ------------------------------------------------------------------ time

  /** Current song time in seconds (negative while waiting for a scheduled start). */
  getSongTime(): number {
    if (this.mixerState === 'playing') return this.offsetSec + (this.ctx.currentTime - this.startCtxTime);
    return this.offsetSec;
  }

  /** ctx time corresponding to song time 0 (valid while playing). */
  getSongStartCtxTime(): number { return this.startCtxTime - this.offsetSec; }
  songTimeToCtxTime(songTime: number): number { return this.getSongStartCtxTime() + songTime; }
  ctxTimeToSongTime(ctxTime: number): number { return ctxTime - this.getSongStartCtxTime(); }

  // ------------------------------------------------------------------ gains

  setStemGain(id: string, gain: number, rampSec: number = 0.02): void {
    const stem = this.requireStem(id);
    const now = this.ctx.currentTime;
    const p = stem.volume.gain;
    p.cancelScheduledValues(now);
    p.setValueAtTime(p.value, now);
    p.linearRampToValueAtTime(Math.max(0, gain), now + rampSec);
  }
  getStemGain(id: string): number { return this.requireStem(id).volume.gain.value; }

  setMasterGain(gain: number, rampSec: number = 0.02): void {
    const now = this.ctx.currentTime;
    const p = this.master.gain;
    p.cancelScheduledValues(now);
    p.setValueAtTime(p.value, now);
    p.linearRampToValueAtTime(Math.max(0, gain), now + rampSec);
  }
  getMasterGain(): number { return this.master.gain.value; }

  // ------------------------------------------------------------------ ducking

  setPlayerStem(id: string): void {
    const stem = this.requireStem(id);
    const now = this.ctx.currentTime;
    if (this.duckController) this.duckController.rebind(stem.duck.gain, now);
    else this.duckController = new DuckController(stem.duck.gain, this.duckOptions);
    this.playerStemId = id;
  }

  /** Restore the player stem (60 ms ramp); `combo` = consecutive hits including this one. */
  onHit(combo: number = 0): void { this.duckController?.hit(this.ctx.currentTime, combo); }
  /** Duck the player stem to missGain (40 ms ramp); stays ducked until the next hit. */
  onMiss(): void { this.duckController?.miss(this.ctx.currentTime); }

  // ------------------------------------------------------------------ teardown

  dispose(): void {
    this.unload();
    this.endedListeners.clear();
    this.master.disconnect();
    this.compressor?.disconnect();
    if (this.ownsContext && this.ctx.state !== 'closed') void this.ctx.close();
  }

  // ------------------------------------------------------------------ internals

  private requireStem(id: string): Stem {
    const stem = this.stems.get(id);
    if (!stem) throw new Error(`StemMixer: unknown stem "${id}"`);
    return stem;
  }

  private stopSources(): void {
    this.playGeneration++; // invalidates pending onended callbacks
    for (const stem of this.stems.values()) {
      if (stem.source) {
        stem.source.onended = null;
        try { stem.source.stop(); } catch { /* not started yet or already stopped */ }
        stem.source.disconnect();
        stem.source = null;
      }
    }
  }

  private clearSources(): void {
    for (const stem of this.stems.values()) {
      if (stem.source) { stem.source.onended = null; stem.source.disconnect(); stem.source = null; }
    }
  }
}
