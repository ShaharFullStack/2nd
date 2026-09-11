/**
 * AUDITIONING A SONG WITHOUT DOWNLOADING IT.
 *
 * The Setup screen's "Listen" button used to call `runtime.previewSong`, which loaded the WHOLE song
 * into the mixer — every stem, fetched and decoded in full — in order to play twelve seconds of it.
 * For the demo songs that is 34 MB and four full decodes per press; on a clinic tablet on hospital
 * wi-fi, auditioning three songs downloads a hundred megabytes to hear thirty-six seconds, with a
 * disabled button and no way out while it happens. And none of it is even the song the therapist
 * ends up prescribing.
 *
 * So the audition fetches ONLY THE SECONDS IT PLAYS. Stems are PCM WAV (the pipeline in
 * scripts/fetch-stems.mjs and the demo generator both produce WAV), which is the one format where
 * the byte range of a time range is arithmetic: the fmt chunk gives bytes-per-second, so the bytes
 * for [previewStart, previewStart + 12 s) can be asked for with a `Range` header and wrapped in a
 * fresh 44-byte header to make a standalone, decodable file. That is ~1 MB per stem instead of 8.5,
 * and the tail of the file is never touched.
 *
 * IT DEGRADES, IT DOES NOT FAIL. A server without range support, a stem that is not linear-PCM WAV
 * (an mp3, or WAVE_FORMAT_EXTENSIBLE), a decode the browser refuses: each returns null from this
 * module and the caller falls back to the old full load. The audition is an optimisation of a
 * working path, never a new way for it to break.
 *
 * AND DEGRADING MUST COST NOTHING, which is the part that was wrong and is the reason this file's
 * two hardest rules exist. A `Range` request a server ignores is answered with the WHOLE stem, and
 * a refusal that simply drops the `Response` lets all 8.5 MB of it arrive anyway. Four stems probed
 * in parallel, four discarded full downloads, and then the fallback fetching the same song again:
 * measured behind a Range-stripping proxy, one press of Listen moved 68.4 MB — twice what the full
 * load this replaced cost, on exactly the network it was written for. So:
 *   - every refused response has its body CANCELLED (`discardBody`), never dropped; and
 *   - range support belongs to the SERVER, not to the file, so the first stem is probed ALONE and a
 *     refusal ends the audition before the other three are asked for.
 * A Range-stripping server now costs one cancelled 8 kB probe, and then the honest full load — which
 * the Setup screen states in megabytes and lets the therapist stop.
 *
 * The audition is also deliberately NOT the mixer's transport. It plays on its own sources into the
 * mixer's master bus, so the session's position is not moved, held aside or restored — pressing
 * Start after an audition begins the prescribed session at song time 0 because the transport was
 * never touched at all.
 */
import type { SongManifest } from '../audio/manifest.ts';

/** Default audition length and its fade-out, in seconds. */
export const AUDITION_SEC = 12;
export const AUDITION_FADE_SEC = 1;
/** How much of the head of a stem is read to find the fmt and data chunks. */
export const WAV_PROBE_BYTES = 8192;

export interface WavInfo {
  /** 1 = linear PCM, 3 = IEEE float. Anything else is refused. */
  format: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  /** Bytes per sample frame (all channels). */
  blockAlign: number;
  /** Byte offset of the first sample. */
  dataOffset: number;
  /** Length of the data chunk in bytes, as the header declares it. */
  dataLength: number;
}

/** Bytes of audio per second of sound. */
export function wavBytesPerSecond(info: WavInfo): number {
  return info.sampleRate * info.blockAlign;
}

/**
 * Parse the head of a WAV file. Returns null for anything this module cannot slice safely — a
 * non-RIFF file, a compressed or extensible format, or a header whose chunks did not fit in `head`.
 */
export function parseWavHeader(head: Uint8Array): WavInfo | null {
  if (head.byteLength < 44) return null;
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const tag = (offset: number): string =>
    String.fromCharCode(head[offset], head[offset + 1], head[offset + 2], head[offset + 3]);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;

  let offset = 12;
  let fmt: Omit<WavInfo, 'dataOffset' | 'dataLength'> | null = null;
  while (offset + 8 <= head.byteLength) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ' && body + 16 <= head.byteLength) {
      const format = view.getUint16(body, true);
      // 0xFFFE (WAVE_FORMAT_EXTENSIBLE) carries its real format in an extension chunk this writer
      // does not reproduce, so a slice of it would be mislabelled. Refuse rather than guess.
      if (format !== 1 && format !== 3) return null;
      fmt = {
        format,
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        blockAlign: view.getUint16(body + 12, true),
        bitsPerSample: view.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      if (!fmt || fmt.channels < 1 || fmt.blockAlign < 1 || fmt.sampleRate < 1) return null;
      return { ...fmt, dataOffset: body, dataLength: size };
    }
    // Chunks are word-aligned, and a zero/odd size would loop forever.
    if (size <= 0 && id !== 'data') return null;
    offset = body + size + (size % 2);
  }
  return null;
}

/**
 * The inclusive byte range holding `[startSec, startSec + durationSec)`, aligned to whole sample
 * frames so the slice never begins mid-frame (which would swap the channels for the whole audition).
 * Returns null when the requested window is past the end of the audio.
 */
export function wavByteRange(
  info: WavInfo,
  startSec: number,
  durationSec: number,
): { start: number; end: number; length: number } | null {
  const perSec = wavBytesPerSecond(info);
  if (perSec <= 0 || durationSec <= 0) return null;
  const align = (bytes: number): number => Math.max(0, Math.floor(bytes / info.blockAlign) * info.blockAlign);
  const offset = align(Math.max(0, startSec) * perSec);
  if (offset >= info.dataLength) return null;
  const length = Math.min(align(durationSec * perSec) || info.blockAlign, info.dataLength - offset);
  if (length <= 0) return null;
  const start = info.dataOffset + offset;
  return { start, end: start + length - 1, length };
}

/** Wrap raw sample bytes in a canonical 44-byte WAV header so the browser can decode them alone. */
export function buildWavFile(info: WavInfo, samples: Uint8Array): ArrayBuffer {
  const out = new Uint8Array(44 + samples.byteLength);
  const view = new DataView(out.buffer);
  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) out[offset + i] = text.charCodeAt(i);
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + samples.byteLength, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, info.format, true);
  view.setUint16(22, info.channels, true);
  view.setUint32(24, info.sampleRate, true);
  view.setUint32(28, wavBytesPerSecond(info), true);
  view.setUint16(32, info.blockAlign, true);
  view.setUint16(34, info.bitsPerSample, true);
  ascii(36, 'data');
  view.setUint32(40, samples.byteLength, true);
  out.set(samples, 44);
  return out.buffer;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * THROW A RESPONSE AWAY WITHOUT DOWNLOADING IT.
 *
 * A `Response` this code refuses is not free: the browser has only received the headers, and the
 * body is still arriving. Dropping the object on the floor lets the WHOLE stem stream into the void
 * — which is exactly the case this module exists to prevent, because the one server that answers a
 * Range request with a 200 is the one that sends all 8.5 MB of it. Four stems, four discarded full
 * downloads, and then the fallback loads the same song again: an audition that cost TWICE what the
 * full load it replaced cost, on precisely the slow network the optimisation was for.
 *
 * `body.cancel()` closes the connection instead. `stemExists` in src/audio/manifest.ts has always
 * done this for the same reason; this is the same line.
 */
function discardBody(res: Response): void {
  try {
    void res.body?.cancel?.()?.catch?.(() => undefined);
  } catch {
    /* no body, already consumed, or a Response stand-in without one */
  }
}

export interface WavWindow {
  file: ArrayBuffer;
  bytes: number;
}

/**
 * Fetch just the audition window of one WAV stem, as a standalone file.
 *
 * Returns null — never throws for the expected refusals — when the server ignored the range (any
 * status but 206), when the stem is not a sliceable WAV, or when the window is past its end. An
 * aborted signal rejects, because that is a decision, not a failure.
 */
export async function fetchWavWindow(
  url: string,
  startSec: number,
  durationSec: number,
  fetchImpl: FetchLike,
  signal?: AbortSignal,
): Promise<WavWindow | null> {
  const head = await fetchImpl(url, { headers: { Range: `bytes=0-${WAV_PROBE_BYTES - 1}` }, signal });
  // 206 is the only answer that proves the server honours ranges; a 200 means it is sending the whole
  // file — so cancel it before it arrives, and say that ranges are not on offer here.
  if (head.status !== 206) {
    discardBody(head);
    return null;
  }
  const info = parseWavHeader(new Uint8Array(await head.arrayBuffer()));
  if (!info) return null;
  const range = wavByteRange(info, startSec, durationSec);
  if (!range) return null;
  const body = await fetchImpl(url, { headers: { Range: `bytes=${range.start}-${range.end}` }, signal });
  if (body.status !== 206) {
    discardBody(body);
    return null;
  }
  const samples = new Uint8Array(await body.arrayBuffer());
  if (samples.byteLength === 0) return null;
  return { file: buildWavFile(info, samples), bytes: samples.byteLength };
}

/** Where a stem's file lives (the same layout `StemMixer.loadSong` uses). */
export function stemUrl(baseUrl: string, manifest: SongManifest, file: string): string {
  return `${baseUrl}/${manifest.id}/${file}`;
}

export interface AuditionProgress {
  /** 0..1 over the stems of the audition. */
  fraction: number;
  /** Bytes actually downloaded so far — the number that makes the cost visible. */
  bytes: number;
  stemsReady: number;
  stems: number;
}

export interface AuditionOptions {
  durationSec?: number;
  fadeSec?: number;
  /** Song seconds to start at (defaults to the manifest's previewStart). */
  fromSongTime?: number;
  onProgress?: (p: AuditionProgress) => void;
  signal?: AbortSignal;
  baseUrl?: string;
}

/** The Web Audio surface the audition needs — an AudioContext, or a test's stand-in for one. */
export interface AuditionContext {
  currentTime: number;
  createGain(): GainNode;
  createBufferSource(): AudioBufferSourceNode;
  decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer>;
}

function aborted(): Error {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}

/**
 * A song audition: a handful of seconds of every stem, played together and faded out.
 *
 * One at a time — starting a new one stops the one before it, which is what the Setup screen's
 * "Listen on A, then Listen on B" does. `stop()` is also the cancel: it aborts an audition that is
 * still downloading, so a therapist who moves on is not waiting for audio nobody will hear.
 */
export class Audition {
  private readonly ctx: AuditionContext;
  private readonly destination: AudioNode;
  private readonly fetchImpl: FetchLike;
  private gain: GainNode | null = null;
  private sources: AudioBufferSourceNode[] = [];
  private abort: AbortController | null = null;
  private endTimer: ReturnType<typeof setTimeout> | null = null;
  private playing: string | null = null;
  private generation = 0;

  constructor(ctx: AuditionContext, destination: AudioNode, fetchImpl: FetchLike = (u, i) => fetch(u, i)) {
    this.ctx = ctx;
    this.destination = destination;
    this.fetchImpl = fetchImpl;
  }

  /** The song being auditioned, or null. */
  get songId(): string | null {
    return this.playing;
  }

  /**
   * Play the audition window of `manifest`. Resolves true once it is playing, false when the stems
   * could not be sliced (the caller should fall back to a full load) or the audition was superseded.
   */
  async play(manifest: SongManifest, options: AuditionOptions = {}): Promise<boolean> {
    const durationSec = options.durationSec ?? AUDITION_SEC;
    const fadeSec = options.fadeSec ?? AUDITION_FADE_SEC;
    const from = options.fromSongTime ?? manifest.previewStart ?? 0;
    const baseUrl = options.baseUrl ?? '/songs';
    const stems = manifest.stems;
    if (stems.length === 0) return false;

    this.stop();
    const gen = ++this.generation;
    const abort = new AbortController();
    this.abort = abort;
    const signal = options.signal;
    const onOuterAbort = (): void => abort.abort();
    signal?.addEventListener('abort', onOuterAbort, { once: true });

    let bytes = 0;
    let ready = 0;
    const report = (): void =>
      options.onProgress?.({ fraction: ready / stems.length, bytes, stemsReady: ready, stems: stems.length });
    report();

    try {
      const fetchStem = async (file: string): Promise<WavWindow | null> => {
        const got = await fetchWavWindow(stemUrl(baseUrl, manifest, file), from, durationSec, this.fetchImpl, abort.signal);
        if (got) {
          bytes += got.bytes;
          ready++;
          report();
        }
        return got;
      };

      // ONE STEM DECIDES WHETHER THIS SERVER RANGES AT ALL. Range support belongs to the server (or
      // to the proxy in front of it), not to the file — so the first stem is probed ALONE. If it
      // refuses, the audition falls back having spent one cancelled probe instead of firing three
      // more at a server already known to answer them with the whole 8.5 MB file. The cost of the
      // extra round-trip on the path that works is one 8 kB request; the cost of not paying it, on
      // the path that does not, was the entire song, four times over.
      const first = await fetchStem(stems[0].file);
      if (abort.signal.aborted) throw aborted();
      if (!first) return false;
      const windows = [first, ...(await Promise.all(stems.slice(1).map((stem) => fetchStem(stem.file))))];
      if (abort.signal.aborted) throw aborted();
      // ALL OR NOTHING. A partial audition is a different arrangement of the song — the therapist
      // would be judging a track with its drums missing — so one unsliceable stem sends the whole
      // audition down the full-load path.
      if (windows.some((w) => w === null)) return false;

      const buffers = await Promise.all(windows.map((w) => this.ctx.decodeAudioData(w!.file)));
      if (abort.signal.aborted || gen !== this.generation) throw aborted();

      const gain = this.ctx.createGain();
      gain.gain.value = 1;
      gain.connect(this.destination);
      const startAt = this.ctx.currentTime + 0.05;
      const endAt = startAt + durationSec;
      const fade = Math.min(fadeSec, durationSec / 2);
      gain.gain.setValueAtTime(1, Math.max(startAt, endAt - fade));
      gain.gain.linearRampToValueAtTime(0.0001, endAt);
      for (const buffer of buffers) {
        const src = this.ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(gain);
        src.start(startAt, 0, durationSec);
        this.sources.push(src);
      }
      this.gain = gain;
      this.playing = manifest.id;
      this.endTimer = setTimeout(() => {
        this.endTimer = null;
        if (gen === this.generation) this.stop();
      }, Math.max(0, (endAt - this.ctx.currentTime) * 1000));
      return true;
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return false;
      throw err;
    } finally {
      signal?.removeEventListener('abort', onOuterAbort);
      if (this.abort === abort) this.abort = null;
    }
  }

  /** Stop the audition and cancel one that is still downloading. Safe to call at any time. */
  stop(): void {
    this.generation++;
    if (this.endTimer !== null) {
      clearTimeout(this.endTimer);
      this.endTimer = null;
    }
    if (this.abort) {
      this.abort.abort();
      this.abort = null;
    }
    for (const src of this.sources) {
      try {
        src.stop();
      } catch {
        /* already stopped */
      }
      src.disconnect();
    }
    this.sources = [];
    if (this.gain) {
      this.gain.disconnect();
      this.gain = null;
    }
    this.playing = null;
  }
}
