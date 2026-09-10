/**
 * StemMixer — multi-stem, sample-synchronous Web Audio playback with per-stem gain and
 * player-stem ducking (docs/ARCHITECTURE.md "Audio contract").
 *
 * Graph:  source ─ duck ─ volume ─┐
 *         source ─ duck ─ volume ─┼─ transport ─┐
 *         …                        ┘             ├─ master ─ [limiter] ─ destination
 *                          Sfx ─ sfxBus ────────┘
 *
 * `transport` is a GainNode used only for click-free stops: pause/seek/stop/unload ramp it to
 * MIN_GAIN over `STOP_FADE_SEC` and stop the sources after the fade; play() ramps it back up so
 * that it is at 1.0 exactly when the new sources start (or over the first 5 ms when resuming
 * mid-waveform, where a hard onset would click).
 *
 * Time base — the mixer IS the song clock (ARCHITECTURE: "AudioContext.currentTime is the single
 * clock"). It implements the input module's `SongTimeSource` (`songTime(nowCtx?)`,
 * `ctxTimeForSongTime`), so ReplayInput/AutoplayInput and the UI can read one clock, and every
 * transport call returns the ctx time it committed to:
 *   play()   → ctx time at which audio starts (verified, see below)
 *   pause()  → ctx time of the pause point
 *   resume() → resolves with the ctx time at which audio restarts (after ctx.resume())
 * If the engine's own SongClock is used as well, drive it with these values
 * (`engine.start(mixer.play(at), from)`, `engine.pause(mixer.pause())`,
 * `engine.resume(await mixer.resume())`) and the two clocks agree exactly.
 *
 * The song↔ctx mapping (`ctxTimeForSongTime` / `ctxTimeToSongTime`) is exact and invertible in
 * EVERY transport state, not only while playing: the ctx time of song time 0 is stored when a
 * segment starts (play/seek/stop) and is deliberately left alone by pause(), so a stamp taken
 * just before a pause still resolves to the ctx time it really happened at — the same rule the
 * engine SongClock follows. An input source that stamps events with `ctxTimeForSongTime()` may
 * therefore be ticked while the therapist has the session paused.
 *
 * Verified start: `play()` schedules every source at `startAt = now + startLeadSec` (default
 * 100 ms — a MediaPipe inference frame on the main thread can block for >30 ms) and then re-reads
 * `ctx.currentTime`. If the main thread stalled long enough that the deadline is within
 * `START_GUARD_QUANTA` render quanta, the sources would start late while the clock reported the
 * early time, so they are discarded and rescheduled from the new `now`. The returned start time
 * is therefore the time the audio thread actually starts the buffers.
 *
 * Master stage / headroom — every figure below is measured by headroom.test.ts from the committed
 * WAVs and from the SFX specs `Sfx` actually schedules, and asserted there to two decimals, so a
 * regeneration that moves them fails the suite instead of leaving this comment wrong.
 *
 * Worst realistic sum at the destination = four stems summed sample-wise (2.05 groove /
 * 1.99 sunrise), with the +2 dB streak boost on the player stem (2.28 / 2.23), plus the loudest
 * SFX cue at the top of the slider (the hit tick, 0.62 — SFX ride on `sfxBus`, which joins the
 * master bus, so they are inside the budget rather than clipping past it). Worst case: 2.90.
 *  - without the limiter the master default is 0.32, so 2.90 × 0.32 = 0.93 never hard-clips;
 *  - with the limiter (DynamicsCompressorNode, threshold −3 dB, ratio 20, knee 0, 1 ms attack,
 *    50 ms release — a limiter, not a program compressor, which would release when the player
 *    stem is ducked and swell the other stems) the master default is 0.8: the peak into the
 *    limiter is 2.32 (+7.3 dBFS); Chromium/WebKit/Gecko's kernel catches it with its ~6 ms
 *    look-ahead and applies an automatic make-up gain of (1/curve(0 dB))^0.6 ≈ +1.7 dB
 *    (`limiterOutputPeak` models this), for an output ceiling of ≈0.91. A limiter with this
 *    threshold only reaches 0 dBFS for inputs ≥ +20 dBFS.
 */

import type { FetchLike, SongManifest, StemSpec } from './manifest';
import { stemUrl } from './manifest';
import type { SongTimeSource } from '../input/types';
import { DuckController, MIN_GAIN, SmoothGain, rampValueAt, scheduleRamp, type DuckOptions, type RampState } from './ducking';
import { Sfx, type SfxLevels } from './sfx';

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
  /** Master gain (default `DEFAULT_MASTER_GAIN.limiter` = 0.8 with the limiter, `.none` = 0.45 without). */
  masterGain?: number;
  duck?: Partial<DuckOptions>;
  /**
   * Minimum scheduling lead when `play()` is called without an explicit ctx time (default
   * `DEFAULT_START_LEAD_SEC` = 100 ms). Must exceed a main-thread stall (MediaPipe inference).
   */
  startLeadSec?: number;
  fetch?: FetchLike;
}

/** Default master headroom (see the module comment). */
export const DEFAULT_MASTER_GAIN = { limiter: 0.8, none: 0.32 } as const;

/** Limiter settings applied to the master DynamicsCompressorNode. */
export const LIMITER_SETTINGS = { threshold: -3, knee: 0, ratio: 20, attack: 0.001, release: 0.05 } as const;

/** Default lead between play() and the audio start (see the module comment). */
export const DEFAULT_START_LEAD_SEC = 0.1;

/**
 * Sources are rescheduled when, after scheduling, the deadline is closer than this many render
 * quanta (128 frames) to `ctx.currentTime`: the audio thread may already have passed it.
 */
export const START_GUARD_QUANTA = 3;

/** Fade applied on pause/seek/stop before the sources are stopped (and on resume before full level). */
export const STOP_FADE_SEC = 0.008;
/** Fade-in applied after the start time when resuming mid-waveform. */
export const RESUME_FADE_SEC = 0.005;

/** Weight of the download phase in per-stem progress (the rest is decoding). */
export const PROGRESS_DOWNLOAD_WEIGHT = 0.85;

/** Default preview length / fade-out used by `playPreview`. */
export const DEFAULT_PREVIEW_SEC = 12;
export const DEFAULT_PREVIEW_FADE_SEC = 1.0;

const dbToLin = (db: number): number => Math.pow(10, db / 20);
const linToDb = (x: number): number => 20 * Math.log10(Math.max(x, 1e-9));

/**
 * Automatic make-up gain of the WebAudio DynamicsCompressorNode kernel (Chromium's
 * DynamicsCompressorKernel, also used by WebKit and Gecko): (1 / curve(0 dBFS))^0.6.
 */
export function limiterMakeupGain(settings: { threshold: number; ratio: number } = LIMITER_SETTINGS): number {
  const fullRangeDb = settings.threshold + (0 - settings.threshold) / settings.ratio; // static curve at 0 dBFS
  return Math.pow(1 / dbToLin(fullRangeDb), 0.6);
}

/**
 * Modelled steady-state output peak of the master limiter for a given linear input peak (static
 * curve with knee 0 plus the automatic make-up gain). Attack/look-ahead dynamics are ignored,
 * which is accurate for the kernel's ~6 ms pre-delay and 1 ms attack.
 */
export function limiterOutputPeak(inputPeak: number, settings: { threshold: number; ratio: number } = LIMITER_SETTINGS): number {
  const inDb = linToDb(inputPeak);
  const outDb = inDb <= settings.threshold ? inDb : settings.threshold + (inDb - settings.threshold) / settings.ratio;
  return dbToLin(outDb) * limiterMakeupGain(settings);
}

interface Stem {
  spec: StemSpec;
  buffer: AudioBuffer;
  duck: GainNode;
  volume: GainNode;
  volumeCtl: SmoothGain;
  source: AudioBufferSourceNode | null;
}

function decodeAudio(ctx: BaseAudioContext, data: ArrayBuffer): Promise<AudioBuffer> {
  return new Promise<AudioBuffer>((resolve, reject) => {
    let maybePromise: Promise<AudioBuffer> | void;
    try {
      maybePromise = ctx.decodeAudioData(data, resolve, reject);
    } catch (err) {
      reject(err);
      return;
    }
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

function abortError(): Error {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}

/**
 * Read a response body while reporting received bytes. Uses the streaming reader when available
 * (so an 8 MB stem reports progress every chunk); falls back to arrayBuffer() otherwise.
 * An aborted `signal` cancels the reader and rejects with an AbortError.
 */
export async function readBodyWithProgress(
  res: Response,
  onChunk: (received: number, total: number | null) => void,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const total = contentLength(res);
  const body = res.body;
  if (signal?.aborted) throw abortError();
  if (!body || typeof body.getReader !== 'function') {
    const ab = await res.arrayBuffer();
    if (signal?.aborted) throw abortError();
    onChunk(ab.byteLength, total ?? ab.byteLength);
    return ab;
  }
  const reader = body.getReader();
  const onAbort = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener('abort', onAbort, { once: true });
  // With a Content-Length the body is written straight into one final buffer: keeping the chunks
  // and then copying them costs a second full copy of every stem, and four parallel 8.5 MB stems
  // on a clinic tablet already carry ~70 MB of decoded AudioBuffers. `chunks` is only the fallback
  // for a chunked/compressed response (no usable Content-Length) or a body longer than announced.
  let out: Uint8Array | null = total !== null ? new Uint8Array(total) : null;
  const chunks: Uint8Array[] = [];
  let received = 0;
  let complete = false;
  try {
    onChunk(0, total);
    for (;;) {
      const { done, value } = await reader.read();
      if (signal?.aborted) throw abortError();
      if (done) break;
      if (!value) continue;
      if (out && received + value.byteLength <= out.length) out.set(value, received);
      else { if (out) { chunks.push(out.subarray(0, received)); out = null; } chunks.push(value); }
      received += value.byteLength;
      onChunk(received, total);
    }
    complete = true;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    // Abort, network error or a throwing onChunk leaves the body half-read: cancel the reader so
    // the socket is released now instead of at GC time (loadSong aborts its SIBLING downloads, but
    // nothing else releases the stream that threw).
    if (!complete) { try { void reader.cancel().catch(() => undefined); } catch { /* already errored */ } }
  }
  // `.buffer` is typed ArrayBufferLike (it could be a SharedArrayBuffer for a view we did not
  // allocate); these two were allocated here, so they are plain ArrayBuffers.
  if (out) return (received === out.length ? out.buffer : out.buffer.slice(0, received)) as ArrayBuffer;
  const joined = new Uint8Array(received);
  let off = 0;
  for (const c of chunks) { joined.set(c, off); off += c.byteLength; }
  return joined.buffer;
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

export class StemMixer implements SongTimeSource {
  readonly ctx: AudioContext;
  /** Click-free stop/start fades (between the stem sum and the master). */
  readonly transport: GainNode;
  /**
   * Bus for feedback SFX: post-transport (so cues are not faded out by pause/seek) but PRE-master
   * and pre-limiter, so they share the song's headroom instead of clipping past it. Connect an
   * `Sfx` here — `mixer.createSfx()` does it for you.
   */
  readonly sfxBus: GainNode;
  readonly master: GainNode;
  /** The master limiter (a DynamicsCompressorNode with `LIMITER_SETTINGS`), or null when disabled. */
  readonly compressor: DynamicsCompressorNode | null;
  /** Last node of the master chain (connect analysers here). */
  readonly output: AudioNode;

  private readonly ownsContext: boolean;
  private readonly startLeadSec: number;
  private readonly fetchImpl: FetchLike;
  private readonly duckOptions: Partial<DuckOptions>;
  private readonly masterCtl: SmoothGain;
  private transportRamp: RampState = { from: 1, to: 1, t0: -Infinity, t1: -Infinity };

  private stems = new Map<string, Stem>();
  private stemOrder: string[] = [];
  private currentManifest: SongManifest | null = null;
  private playerStemId: string | null = null;
  private duckController: DuckController | null = null;

  private mixerState: MixerState = 'idle';
  /** Song time the current segment started from (while paused/stopped/ended: the position). */
  private offsetSec = 0;
  /** ctx time at which the current segment started (i.e. at which song time `offsetSec` occurred). */
  private startCtxTime = 0;
  /**
   * ctx time of song time 0 on the CURRENT mapping — the single source of truth for
   * song↔ctx conversion. Kept as its own field (rather than derived from
   * `startCtxTime - offsetSec`) because `pause()` moves `offsetSec` to the pause point while
   * `startCtxTime` still refers to the start of the segment; deriving it there shifted the whole
   * mapping by the elapsed playback time. Rebased by play/seek/stop, NOT by pause (a paused
   * mapping still resolves stamps up to the pause point, like the engine SongClock).
   */
  private songStartCtx = 0;
  private playGeneration = 0;
  private loadGeneration = 0;
  private loadAbort: AbortController | null = null;
  private previewTimer: ReturnType<typeof setTimeout> | null = null;
  private retireTimers = new Map<ReturnType<typeof setTimeout>, () => void>();
  private endedListeners = new Set<() => void>();

  constructor(options: StemMixerOptions = {}) {
    if (options.ctx) { this.ctx = options.ctx; this.ownsContext = false; }
    else { this.ctx = new AudioContext(); this.ownsContext = true; }
    this.startLeadSec = options.startLeadSec ?? DEFAULT_START_LEAD_SEC;
    this.duckOptions = options.duck ?? {};
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));

    const useLimiter = options.compressor ?? true;
    this.transport = this.ctx.createGain();
    this.transport.gain.value = 1;
    this.master = this.ctx.createGain();
    this.masterCtl = new SmoothGain(this.master.gain, options.masterGain ?? (useLimiter ? DEFAULT_MASTER_GAIN.limiter : DEFAULT_MASTER_GAIN.none));
    this.transport.connect(this.master);
    this.sfxBus = this.ctx.createGain();
    this.sfxBus.gain.value = 1;
    this.sfxBus.connect(this.master);
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
   *
   * A load that is superseded by a newer `loadSong()`, or cut short by `unload()` / `dispose()`,
   * aborts its downloads (AbortSignal) and resolves quietly without touching the mixer; only a
   * failure of the *current* load rejects (state returns to 'idle', nothing half-loaded).
   */
  async loadSong(manifest: SongManifest, baseUrl: string = '/songs', onProgress?: (p: LoadProgress) => void): Promise<void> {
    // Validate BEFORE touching the mixer: `parseManifest` guards this for loaded song.json files,
    // but a hand-built manifest whose playerStem is not a stem would otherwise download and decode
    // everything and only then throw out of setPlayerStem, leaving a 'ready' mixer with no duck
    // controller (onHit/onMiss silently doing nothing for the rest of the session).
    if (manifest.stems.length === 0) throw new Error(`song "${manifest.id}": manifest has no stems`);
    const ids = new Set(manifest.stems.map((s) => s.id));
    if (ids.size !== manifest.stems.length) throw new Error(`song "${manifest.id}": stem ids must be unique`);
    if (!ids.has(manifest.playerStem)) {
      throw new Error(`song "${manifest.id}": playerStem "${manifest.playerStem}" is not one of the stems (${[...ids].join(', ')})`);
    }
    this.unload();
    const gen = ++this.loadGeneration;
    const abort = new AbortController();
    this.loadAbort = abort;
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
        const res = await this.fetchImpl(url, { signal: abort.signal });
        if (!res.ok) throw new Error(`stem "${spec.id}" (${url}) failed to load: HTTP ${res.status}`);
        const data = await readBodyWithProgress(res, (received, total) => {
          states[i].received = received;
          states[i].total = total;
          report(i, 'downloading');
        }, abort.signal);
        states[i].fetched = true;
        states[i].received = data.byteLength;
        if (states[i].total === null || states[i].total !== data.byteLength) states[i].total = data.byteLength;
        report(i, 'fetched');
        if (abort.signal.aborted) throw abortError();
        const buffer = await decodeAudio(this.ctx, data);
        if (abort.signal.aborted) throw abortError();
        states[i].decoded = true;
        report(i, 'decoded');
        return { spec, buffer };
      }));
    } catch (err) {
      if (gen !== this.loadGeneration) return; // superseded / unloaded: nothing to report
      abort.abort(); // stop the sibling downloads of a failed load
      this.loadAbort = null;
      this.mixerState = 'idle';
      this.currentManifest = null;
      throw err;
    }
    if (gen !== this.loadGeneration) return; // superseded by a newer loadSong()
    this.loadAbort = null;
    for (const { spec, buffer } of decoded) {
      const duck = this.ctx.createGain();
      const volume = this.ctx.createGain();
      duck.connect(volume);
      volume.connect(this.transport);
      this.stems.set(spec.id, { spec, buffer, duck, volume, volumeCtl: new SmoothGain(volume.gain, 1), source: null });
      this.stemOrder.push(spec.id);
    }
    this.offsetSec = 0;
    this.songStartCtx = this.ctx.currentTime;
    this.setPlayerStem(manifest.playerStem); // validated above; state flips only once it succeeded
    this.mixerState = 'ready';
  }

  /** Drop the loaded song (keeps the master chain); aborts an in-flight loadSong(). */
  unload(): void {
    this.loadGeneration++;
    if (this.loadAbort) { this.loadAbort.abort(); this.loadAbort = null; }
    this.clearPreviewTimer();
    const wasPlaying = this.stopSources();
    const old = [...this.stems.values()];
    const disconnectOld = () => { for (const s of old) { s.duck.disconnect(); s.volume.disconnect(); } };
    if (wasPlaying) this.retire(disconnectOld); else disconnectOld();
    this.stems.clear();
    this.stemOrder = [];
    this.currentManifest = null;
    this.playerStemId = null;
    this.duckController = null;
    this.offsetSec = 0;
    this.songStartCtx = this.ctx.currentTime;
    this.mixerState = 'idle';
  }

  // ------------------------------------------------------------------ transport

  /**
   * Start every stem at the same ctx time (sample-accurate). `atCtxTime` defaults to
   * now + startLead; `fromSongTime` defaults to the current position (0 after load/stop,
   * the pause point after pause). Returns the ctx time at which audio actually starts (verified
   * against the audio thread, see the module comment) — so `engine.start(mixer.play())` always
   * starts the engine clock on a song that is really sounding.
   *
   * play() therefore never returns silently: an implicit position at/after the end of the song
   * (the song ended, or `seek()` was clamped to the end) restarts from 0, and an explicit
   * `fromSongTime` past the end is a programming error and throws `RangeError` — use
   * `seek(getDuration())` if you mean "jump to the end".
   */
  play(atCtxTime?: number, fromSongTime?: number): number {
    if (this.stems.size === 0) throw new Error('StemMixer.play(): no song loaded');
    const duration = this.getDuration();
    if (fromSongTime !== undefined) {
      if (!Number.isFinite(fromSongTime)) throw new RangeError(`StemMixer.play(): fromSongTime must be finite, got ${fromSongTime}`);
      if (duration > 0 && fromSongTime >= duration) {
        throw new RangeError(`StemMixer.play(): fromSongTime ${fromSongTime.toFixed(3)} s is at/after the end of "${this.currentManifest?.id ?? 'song'}" (${duration.toFixed(3)} s)`);
      }
    }
    this.clearPreviewTimer();
    const wasAudible = this.stopSources();
    if (fromSongTime !== undefined) this.offsetSec = fromSongTime;
    this.offsetSec = Math.max(0, this.offsetSec);
    // 'ended', or a position parked at the end by seek(): start over rather than start silent
    if (duration > 0 && this.offsetSec >= duration) this.offsetSec = 0;

    const gen = ++this.playGeneration;
    const active: Stem[] = [];
    let longest: Stem | null = null;
    for (const stem of this.stems.values()) {
      if (this.offsetSec >= stem.buffer.duration) continue; // this stem is already over
      active.push(stem);
      if (!longest || stem.buffer.duration > longest.buffer.duration) longest = stem;
    }
    const now = this.ctx.currentTime;
    if (!longest) {
      // Defensive: unreachable for a normal song (the position was clamped into [0, duration)
      // above), only a zero-length buffer set can land here. End right away rather than pretend.
      this.startCtxTime = now;
      this.songStartCtx = now - this.offsetSec;
      this.duckController?.reset(now, wasAudible ? STOP_FADE_SEC : 0);
      this.finishPlayback();
      return now;
    }

    const startAt = this.scheduleSources(active, atCtxTime);
    this.startCtxTime = startAt;
    this.songStartCtx = startAt - this.offsetSec;
    this.rampTransportIn(startAt, this.offsetSec > 0);
    // Anchored ramp, not a hard write: the sources stopped above are still audible for
    // STOP_FADE_SEC, and a ducked player stem stepping 0.05 → 1.0 in one sample would click.
    this.duckController?.reset(now, wasAudible ? STOP_FADE_SEC : 0);
    longest.source!.onended = () => {
      if (gen !== this.playGeneration || this.mixerState !== 'playing') return;
      this.finishPlayback();
    };
    this.mixerState = 'playing';
    return startAt;
  }

  /**
   * Pause (click-free fade, then the sources stop). Returns the ctx time of the pause point, i.e.
   * the value to hand to an external clock's `pause(ctxTime)`. Returns null when not playing.
   *
   * `songStartCtx` is deliberately NOT touched: while paused, `ctxTimeForSongTime()` keeps mapping
   * on the segment that was running, so a not-yet-delivered input stamped before the pause still
   * resolves to the ctx time it really happened at (engine SongClock semantics).
   */
  pause(): number | null {
    if (this.mixerState !== 'playing') return null;
    const now = this.ctx.currentTime;
    // clamp: negative while waiting for a scheduled start, never past the end
    this.offsetSec = Math.max(0, Math.min(this.songTime(now), this.getDuration()));
    this.clearPreviewTimer();
    this.stopSources();
    this.mixerState = 'paused';
    return now;
  }

  /**
   * Resume the AudioContext (must follow a user gesture on most browsers) and, if the song
   * was paused, continue playback from the pause point. Resolves with the ctx time at which the
   * audio restarts (the value for an external clock's `resume(ctxTime)`), or null when nothing
   * was paused. The restart is scheduled only after `ctx.resume()` has settled, so the returned
   * time is exact — it includes both the resume latency and the scheduling lead.
   */
  async resume(): Promise<number | null> {
    await this.resumeContext();
    if (this.mixerState !== 'paused') return null;
    return this.play();
  }

  /** Only resume the AudioContext (no transport change). Safe to call repeatedly. */
  async resumeContext(): Promise<void> {
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  /**
   * Jump to `songTime` (clamped to [0, duration]). While playing the sources are faded out and
   * restarted, and the ctx time at which audio resumes at the new position is returned — re-base
   * an external clock with `start(ctxTime, songTime)`. Returns null when no audio was (re)started:
   * not playing, or seeking to the very end, which ends the song (state 'ended', listeners fire).
   */
  seek(songTime: number): number | null {
    const duration = this.getDuration();
    const t = Math.max(0, Math.min(songTime, duration));
    if (this.mixerState === 'playing') {
      if (duration > 0 && t >= duration) {
        const now = this.ctx.currentTime;
        const wasAudible = this.stopSources();
        this.clearPreviewTimer();
        this.startCtxTime = now;
        this.songStartCtx = now - t;
        this.duckController?.reset(now, wasAudible ? STOP_FADE_SEC : 0);
        this.finishPlayback();
        return null;
      }
      return this.play(undefined, t);
    }
    this.offsetSec = t;
    this.songStartCtx = this.ctx.currentTime - t; // the frozen position maps to now
    if (this.mixerState === 'ended') this.mixerState = 'ready';
    return null;
  }

  stop(): void {
    this.clearPreviewTimer();
    const wasAudible = this.stopSources();
    const now = this.ctx.currentTime;
    this.offsetSec = 0;
    this.songStartCtx = now;
    if (this.stems.size > 0) this.mixerState = 'ready';
    // ramped while the stopped sources are still fading out (see play())
    this.duckController?.reset(now, wasAudible ? STOP_FADE_SEC : 0);
  }

  /**
   * Song-select preview: play `durationSec` from `fromSongTime` (default manifest.previewStart)
   * with a fade-out over the last `fadeSec`, then stop. Any transport call cancels it.
   * Returns the ctx start time.
   */
  playPreview(durationSec: number = DEFAULT_PREVIEW_SEC, fadeSec: number = DEFAULT_PREVIEW_FADE_SEC, fromSongTime?: number): number {
    const requested = fromSongTime ?? this.currentManifest?.previewStart ?? 0;
    const duration = this.getDuration();
    // a previewStart past the end (or a longer manifest than the stems) previews from the top
    // rather than throwing out of play()
    const from = Number.isFinite(requested) && requested > 0 && (duration <= 0 || requested < duration) ? requested : 0;
    const startAt = this.play(undefined, from);
    if (this.mixerState !== 'playing') return startAt;
    const remaining = Math.max(0, this.getDuration() - this.offsetSec);
    const len = Math.min(Math.max(0, durationSec), remaining);
    const endAt = startAt + len;
    const fade = Math.min(Math.max(fadeSec, STOP_FADE_SEC), len);
    const p = this.transport.gain;
    p.cancelScheduledValues(endAt - fade);
    p.setValueAtTime(1, endAt - fade);
    p.exponentialRampToValueAtTime(MIN_GAIN, endAt);
    this.transportRamp = { from: 1, to: MIN_GAIN, t0: endAt - fade, t1: endAt };
    const gen = this.playGeneration;
    this.previewTimer = setTimeout(() => {
      this.previewTimer = null;
      if (gen === this.playGeneration && this.mixerState === 'playing') this.stop();
    }, Math.max(0, (endAt - this.ctx.currentTime) * 1000));
    return startAt;
  }

  onEnded(cb: () => void): () => void {
    this.endedListeners.add(cb);
    return () => { this.endedListeners.delete(cb); };
  }

  // ------------------------------------------------------------------ time (SongTimeSource)

  /**
   * Song time (seconds) at ctx time `nowCtx` (default: now). Negative while waiting for a
   * scheduled start; frozen at the pause point while paused; the position (0 after load/stop,
   * the duration after the song ended) otherwise.
   */
  songTime(nowCtx: number = this.ctx.currentTime): number {
    if (this.mixerState === 'playing') return this.offsetSec + (nowCtx - this.startCtxTime);
    return this.offsetSec;
  }

  /**
   * ctx time at which song time `songTime` occurs, on the mapping of the current/last play
   * segment. Exact inverse of `ctxTimeToSongTime()` in every state, and identical to the engine
   * SongClock's `ctxTimeForSongTime()`:
   *  - playing: `ctxTimeForSongTime(songTime(t)) === t` for every t;
   *  - paused: the segment mapping is kept, so the pause point maps back to the ctx time of the
   *    pause (a stamp taken just before the pause resolves to when it really happened);
   *  - ready/ended after stop/seek: the position maps to the ctx time of that stop/seek.
   */
  ctxTimeForSongTime(songTime: number): number { return this.songStartCtx + songTime; }

  /**
   * Delay between a sample leaving the graph and reaching the speaker: `ctx.outputLatency` where
   * the browser reports it (10–60 ms wired, 150 ms+ over Bluetooth), else `ctx.baseLatency`, else 0.
   *
   * JUDGMENT is unaffected — the latency probe closes the loop through the same speakers, so its
   * `inputLatencySec` already contains this term. RENDERING is affected: `songTime()` is the time
   * the graph is *producing*, which is `outputLatencySec` AHEAD of what the patient hears. A
   * renderer that draws `songTime()` shows the note hitting the line while the beat is still in
   * the buffer. Draw `displaySongTime()` instead.
   */
  get outputLatencySec(): number {
    const ctx = this.ctx as AudioContext & { outputLatency?: number; baseLatency?: number };
    const out = typeof ctx.outputLatency === 'number' && Number.isFinite(ctx.outputLatency) ? ctx.outputLatency : 0;
    const base = typeof ctx.baseLatency === 'number' && Number.isFinite(ctx.baseLatency) ? ctx.baseLatency : 0;
    return Math.max(0, out || base);
  }

  /** Song time the listener is *hearing* at `nowCtx` — what a renderer should draw. */
  displaySongTime(nowCtx: number = this.ctx.currentTime): number {
    return this.songTime(nowCtx) - this.outputLatencySec;
  }

  /** Alias of `songTime()` (kept for the original API). */
  getSongTime(): number { return this.songTime(); }
  /** ctx time corresponding to song time 0 on the current mapping (see `ctxTimeForSongTime`). */
  getSongStartCtxTime(): number { return this.songStartCtx; }
  songTimeToCtxTime(songTime: number): number { return this.ctxTimeForSongTime(songTime); }
  ctxTimeToSongTime(ctxTime: number): number { return ctxTime - this.getSongStartCtxTime(); }

  // ------------------------------------------------------------------ gains

  /** Per-stem volume (anchored linear ramp, safe to call from a slider at any rate). */
  setStemGain(id: string, gain: number, rampSec: number = 0.02): void {
    this.requireStem(id).volumeCtl.set(Math.max(0, gain), this.ctx.currentTime, rampSec);
  }
  /** The stem volume last set (ramp destination). */
  getStemGain(id: string): number { return this.requireStem(id).volumeCtl.target; }

  setMasterGain(gain: number, rampSec: number = 0.02): void {
    this.masterCtl.set(Math.max(0, gain), this.ctx.currentTime, rampSec);
  }
  /** The master gain last set (ramp destination). */
  getMasterGain(): number { return this.masterCtl.target; }

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

  // ------------------------------------------------------------------ sfx

  /**
   * Feedback SFX routed through this mixer's `sfxBus` (so they share the master gain and the
   * limiter). Prefer this over `new Sfx(ctx)`, which would bypass the master chain and clip.
   * The mixer does not own the returned object: dispose it yourself.
   */
  createSfx(volume?: number, levels?: Partial<SfxLevels>): Sfx {
    return new Sfx(this.ctx, this.sfxBus, volume, levels);
  }

  // ------------------------------------------------------------------ teardown

  /**
   * Unload (fading out if playing), disconnect the master chain and close an owned context.
   * The disconnect/close is deferred past the fade when something was playing; every other
   * pending retire timer is cancelled and its work run immediately, so nothing survives dispose().
   */
  dispose(): void {
    const wasPlaying = this.mixerState === 'playing';
    this.unload();
    this.endedListeners.clear();
    const teardown = () => {
      this.flushRetireTimers();
      this.transport.disconnect();
      this.sfxBus.disconnect();
      this.master.disconnect();
      this.compressor?.disconnect();
      if (this.ownsContext && this.ctx.state !== 'closed') void this.ctx.close().catch(() => undefined);
    };
    if (wasPlaying) {
      // one last timer, past the fade: it flushes the rest (including itself, already removed)
      const timer = setTimeout(() => { this.retireTimers.delete(timer); teardown(); }, STOP_FADE_SEC * 1000 + 20);
      this.retireTimers.set(timer, teardown);
    } else {
      teardown();
    }
  }

  // ------------------------------------------------------------------ internals

  private requireStem(id: string): Stem {
    const stem = this.stems.get(id);
    if (!stem) throw new Error(`StemMixer: unknown stem "${id}"`);
    return stem;
  }

  /** One render quantum in seconds for this context. */
  private quantumSec(): number {
    const sr = this.ctx.sampleRate;
    return 128 / (sr > 0 ? sr : 48000);
  }

  /**
   * Create + start a source per stem at a common start time and verify the audio thread can still
   * honour it; on a main-thread stall the batch is discarded and rescheduled from the new now.
   */
  private scheduleSources(active: Stem[], atCtxTime: number | undefined): number {
    const guard = START_GUARD_QUANTA * this.quantumSec();
    let startAt = 0;
    for (let attempt = 0; ; attempt++) {
      const now = this.ctx.currentTime;
      startAt = Math.max(now + this.startLeadSec, atCtxTime ?? 0);
      for (const stem of active) {
        const src = this.ctx.createBufferSource();
        src.buffer = stem.buffer;
        src.connect(stem.duck);
        src.start(startAt, this.offsetSec);
        stem.source = src;
      }
      // Sources were posted; if the deadline is (nearly) here the audio thread may have missed it.
      if (this.ctx.currentTime + guard < startAt || attempt >= 4) break;
      atCtxTime = undefined; // the caller's time has passed: fall back to now + lead
      for (const stem of active) {
        const src = stem.source!;
        try { src.stop(); } catch { /* not started */ }
        src.disconnect();
        stem.source = null;
      }
    }
    return startAt;
  }

  private transportValueAt(t: number): number { return rampValueAt(this.transportRamp, t); }

  /** Bring the transport gain to 1 at `startAt` (or over RESUME_FADE_SEC after it when `fadeIn`). */
  private rampTransportIn(startAt: number, fadeIn: boolean): void {
    const t0 = fadeIn ? startAt : startAt - RESUME_FADE_SEC;
    const t1 = t0 + RESUME_FADE_SEC;
    const p = this.transport.gain;
    p.cancelScheduledValues(t0);
    p.setValueAtTime(MIN_GAIN, t0);
    p.exponentialRampToValueAtTime(1, t1);
    this.transportRamp = { from: MIN_GAIN, to: 1, t0, t1 };
  }

  /**
   * Fade the transport to MIN_GAIN over STOP_FADE_SEC and stop the sources after the fade.
   * Returns true when sources were actually playing (so callers can defer disconnects).
   */
  private stopSources(): boolean {
    this.playGeneration++; // invalidates pending onended callbacks
    const now = this.ctx.currentTime;
    let any = false;
    for (const stem of this.stems.values()) if (stem.source) { any = true; break; }
    if (!any) return false;
    this.transportRamp = scheduleRamp(this.transport.gain, this.transportValueAt(now), now, MIN_GAIN, STOP_FADE_SEC);
    const stopAt = this.transportRamp.t1;
    for (const stem of this.stems.values()) {
      const src = stem.source;
      if (!src) continue;
      src.onended = null;
      try { src.stop(stopAt); } catch { /* not started yet or already stopped */ }
      stem.source = null;
      this.retire(() => src.disconnect());
    }
    return true;
  }

  /** Run `fn` after the stop fade has completed (nodes stay referenced until then). */
  private retire(fn: () => void): void {
    const timer = setTimeout(() => { this.retireTimers.delete(timer); fn(); }, STOP_FADE_SEC * 1000 + 20);
    this.retireTimers.set(timer, fn);
  }

  /**
   * Cancel every pending retire timer and run its work now. Called from dispose(): letting the
   * timers fire after teardown keeps the mixer (and its buffers) reachable for another ~28 ms
   * each, which is noise under hot-reload and repeated test construction.
   */
  private flushRetireTimers(): void {
    const pending = [...this.retireTimers];
    this.retireTimers.clear();
    for (const [timer, fn] of pending) { clearTimeout(timer); fn(); }
  }

  private clearPreviewTimer(): void {
    if (this.previewTimer !== null) { clearTimeout(this.previewTimer); this.previewTimer = null; }
  }

  private finishPlayback(): void {
    this.offsetSec = this.getDuration();
    this.mixerState = 'ended';
    this.clearPreviewTimer();
    this.clearSources();
    for (const cb of [...this.endedListeners]) cb();
  }

  private clearSources(): void {
    for (const stem of this.stems.values()) {
      if (stem.source) { stem.source.onended = null; stem.source.disconnect(); stem.source = null; }
    }
  }
}
