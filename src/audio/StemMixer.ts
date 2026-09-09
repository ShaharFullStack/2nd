/**
 * StemMixer — multi-stem, sample-synchronous Web Audio playback with per-stem gain and
 * player-stem ducking (docs/ARCHITECTURE.md "Audio contract").
 *
 * Graph:  source ─ duck ─ volume ─┐
 *         source ─ duck ─ volume ─┼─ master ─ [limiter] ─ destination
 *         …                        ┘
 *
 * Time base: AudioContext.currentTime is the only clock. `getSongTime()` is
 * `offset + (ctx.currentTime - startCtxTime)` while playing; the engine adds its own
 * latency compensation when judging inputs.
 *
 * Master stage: the optional DynamicsCompressorNode is configured as a brick-wall style
 * *limiter* (threshold −3 dBFS, ratio 20, 1 ms attack, 50 ms release), not a program
 * compressor — a compressor sitting after the stem sum would release when the player stem is
 * ducked and swell the other stems by several dB, masking the "your instrument went silent"
 * cue. With the limiter the master defaults to 0.8; without it to 0.6 so four stems peaking
 * at 0.93/0.65/0.52/0.50 cannot hard-clip at the destination.
 */

import type { FetchLike, SongManifest, StemSpec } from './manifest';
import { stemUrl } from './manifest';
import { DuckController, type DuckOptions } from './ducking';

export type MixerState = 'idle' | 'loading' | 'ready' | 'playing' | 'paused' | 'ended';

export interface LoadProgress {
  /** Overall progress 0..1 (per stem: download weighted 0.85, decode 0.15). */
  fraction: number;
  /** Bytes received so far across all stems. */
  bytesLoaded: number;
  /** Sum of Content-Length over the stems that reported one (grows as responses arrive). */
  bytesTotal: number;
  /** True once every stem reported a Content-Length (then bytesLoaded/bytesTotal is exact). */
  bytesTotalKnown: boolean;
  stemsDecoded: number;
  stemCount: number;
  /** Stem the event is about. */
  stemId: string;
  phase: 'downloading' | 'fetched' | 'decoded';
}

export interface StemMixerOptions {
  /** Pass the app-wide AudioContext (created after a user gesture). One is created lazily if absent. */
  ctx?: AudioContext;
  /** Insert a limiter (DynamicsCompressorNode with limiter settings) on the master bus (default true). */
  compressor?: boolean;
  /** Master gain (default `DEFAULT_MASTER_GAIN.limiter` = 0.8 with the limiter, `.none` = 0.6 without). */
  masterGain?: number;
  duck?: Partial<DuckOptions>;
  /** Minimum scheduling lead when `play()` is called without an explicit ctx time (default 30 ms). */
  startLeadSec?: number;
  fetch?: FetchLike;
}

/** Default master headroom (see the module comment). */
export const DEFAULT_MASTER_GAIN = { limiter: 0.8, none: 0.6 } as const;

/** Limiter settings applied to the master DynamicsCompressorNode. */
export const LIMITER_SETTINGS = { threshold: -3, knee: 0, ratio: 20, attack: 0.001, release: 0.05 } as const;

/** Weight of the download phase in per-stem progress (the rest is decoding). */
export const PROGRESS_DOWNLOAD_WEIGHT = 0.85;

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

function contentLength(res: Response): number | null {
  const h = res.headers.get('content-length');
  if (!h || !/^\d+$/.test(h.trim())) return null;
  const n = Number(h);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Read a response body while reporting received bytes. Uses the streaming reader when available
 * (so an 8 MB stem reports progress every chunk); falls back to arrayBuffer() otherwise.
 */
export async function readBodyWithProgress(
  res: Response,
  onChunk: (received: number, total: number | null) => void,
): Promise<ArrayBuffer> {
  const total = contentLength(res);
  const body = res.body;
  if (!body || typeof body.getReader !== 'function') {
    const ab = await res.arrayBuffer();
    onChunk(ab.byteLength, total ?? ab.byteLength);
    return ab;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  onChunk(0, total);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    received += value.byteLength;
    onChunk(received, total);
  }
  const out = new Uint8Array(received);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out.buffer;
}

interface StemLoadState { received: number; total: number | null; fetched: boolean; decoded: boolean }

/** Pure aggregation of per-stem load state into a LoadProgress (exported for tests). */
export function aggregateProgress(states: readonly StemLoadState[], stemId: string, phase: LoadProgress['phase']): LoadProgress {
  let fraction = 0;
  let bytesLoaded = 0;
  let bytesTotal = 0;
  let known = states.length > 0;
  let stemsDecoded = 0;
  for (const s of states) {
    bytesLoaded += s.received;
    if (s.total !== null) bytesTotal += s.total; else known = false;
    const dl = s.fetched ? 1 : s.total !== null ? Math.min(1, s.received / s.total) : 0;
    fraction += PROGRESS_DOWNLOAD_WEIGHT * dl + (s.decoded ? 1 - PROGRESS_DOWNLOAD_WEIGHT : 0);
    if (s.decoded) stemsDecoded++;
  }
  return {
    fraction: states.length === 0 ? 1 : Math.min(1, fraction / states.length),
    bytesLoaded,
    bytesTotal,
    bytesTotalKnown: known,
    stemsDecoded,
    stemCount: states.length,
    stemId,
    phase,
  };
}

export class StemMixer {
  readonly ctx: AudioContext;
  readonly master: GainNode;
  /** The master limiter (a DynamicsCompressorNode with `LIMITER_SETTINGS`), or null when disabled. */
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

    const useLimiter = options.compressor ?? true;
    this.master = this.ctx.createGain();
    this.master.gain.value = options.masterGain ?? (useLimiter ? DEFAULT_MASTER_GAIN.limiter : DEFAULT_MASTER_GAIN.none);
    if (useLimiter) {
      const c = this.ctx.createDynamicsCompressor();
      c.threshold.value = LIMITER_SETTINGS.threshold;
      c.knee.value = LIMITER_SETTINGS.knee;
      c.ratio.value = LIMITER_SETTINGS.ratio;
      c.attack.value = LIMITER_SETTINGS.attack;
      c.release.value = LIMITER_SETTINGS.release;
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
   * Progress is byte-accurate (Content-Length + streamed body) so a 30 MB download moves the bar
   * continuously; events are throttled to ≥0.5 % steps plus every phase change.
   */
  async loadSong(manifest: SongManifest, baseUrl: string = '/songs', onProgress?: (p: LoadProgress) => void): Promise<void> {
    const gen = ++this.loadGeneration;
    this.unload();
    this.mixerState = 'loading';
    this.currentManifest = manifest;
    const states: StemLoadState[] = manifest.stems.map(() => ({ received: 0, total: null, fetched: false, decoded: false }));
    let lastFraction = -1;
    const report = (i: number, phase: LoadProgress['phase']) => {
      if (!onProgress || gen !== this.loadGeneration) return;
      const p = aggregateProgress(states, manifest.stems[i].id, phase);
      if (phase === 'downloading' && p.fraction - lastFraction < 0.005) return;
      lastFraction = p.fraction;
      onProgress(p);
    };
    let decoded: { spec: StemSpec; buffer: AudioBuffer }[];
    try {
      decoded = await Promise.all(manifest.stems.map(async (spec, i) => {
        const url = stemUrl(baseUrl, manifest, spec);
        const res = await this.fetchImpl(url);
        if (!res.ok) throw new Error(`stem "${spec.id}" (${url}) failed to load: HTTP ${res.status}`);
        const data = await readBodyWithProgress(res, (received, total) => {
          states[i].received = received;
          states[i].total = total;
          report(i, 'downloading');
        });
        states[i].fetched = true;
        states[i].received = data.byteLength;
        if (states[i].total === null || states[i].total !== data.byteLength) states[i].total = data.byteLength;
        report(i, 'fetched');
        const buffer = await decodeAudio(this.ctx, data);
        states[i].decoded = true;
        report(i, 'decoded');
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
   * Starting at/after the end of every stem ends the song immediately (state 'ended', listeners fire).
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
    this.startCtxTime = startAt;
    this.duckController?.reset(now);
    if (!longest?.source) {
      // nothing left to play (offset ≥ every stem's duration): end right away
      this.finishPlayback();
      return startAt;
    }
    longest.source.onended = () => {
      if (gen !== this.playGeneration || this.mixerState !== 'playing') return;
      this.finishPlayback();
    };
    this.mixerState = 'playing';
    return startAt;
  }

  pause(): void {
    if (this.mixerState !== 'playing') return;
    // clamp: negative while waiting for a scheduled start, never past the end
    this.offsetSec = Math.max(0, Math.min(this.getSongTime(), this.getDuration()));
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
  /** Analytic gain of the player stem right now (for a UI meter). */
  getPlayerStemGain(): number { return this.duckController?.valueAt(this.ctx.currentTime) ?? 1; }

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

  private finishPlayback(): void {
    this.offsetSec = this.getDuration();
    this.mixerState = 'ended';
    this.clearSources();
    for (const cb of [...this.endedListeners]) cb();
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
