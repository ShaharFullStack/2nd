/**
 * AUDITIONING A SONG MUST NOT DOWNLOAD IT.
 *
 * `previewSong` used to load every stem of a song in full — 34 MB and four decodes for the demo
 * tracks — in order to play twelve seconds. These tests pin the arithmetic that makes the audition
 * cost the seconds it plays, and the refusals that send it back to the full load rather than
 * producing a broken one.
 */
import { describe, expect, it, vi } from 'vitest';
import type { SongManifest } from '../audio/manifest.ts';
import {
  Audition,
  buildWavFile,
  fetchWavWindow,
  parseWavHeader,
  wavByteRange,
  wavBytesPerSecond,
} from './audition.ts';

/** A real (tiny) WAV file: 44-byte header + `seconds` of 16-bit mono at 1000 Hz. */
function wav(seconds: number, opts: { sampleRate?: number; channels?: number; bits?: number; format?: number } = {}): Uint8Array {
  const sampleRate = opts.sampleRate ?? 1000;
  const channels = opts.channels ?? 1;
  const bits = opts.bits ?? 16;
  const blockAlign = (bits / 8) * channels;
  const data = Math.round(seconds * sampleRate) * blockAlign;
  const out = new Uint8Array(44 + data);
  const view = new DataView(out.buffer);
  const ascii = (o: number, t: string) => { for (let i = 0; i < t.length; i++) out[o + i] = t.charCodeAt(i); };
  ascii(0, 'RIFF'); view.setUint32(4, 36 + data, true); ascii(8, 'WAVE');
  ascii(12, 'fmt '); view.setUint32(16, 16, true);
  view.setUint16(20, opts.format ?? 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bits, true);
  ascii(36, 'data'); view.setUint32(40, data, true);
  // A recognisable ramp, so a slice can be checked for being the RIGHT seconds.
  for (let i = 0; i < data; i++) out[44 + i] = i % 251;
  return out;
}

describe('parseWavHeader', () => {
  it('reads the fields a slice needs', () => {
    const info = parseWavHeader(wav(1, { sampleRate: 44100, channels: 2, bits: 16 }))!;
    expect(info).toMatchObject({ format: 1, channels: 2, sampleRate: 44100, bitsPerSample: 16, blockAlign: 4, dataOffset: 44 });
    expect(wavBytesPerSecond(info)).toBe(176400);
  });

  it('refuses what it cannot slice honestly', () => {
    expect(parseWavHeader(new Uint8Array(8))).toBeNull(); // too short to be a header
    expect(parseWavHeader(new Uint8Array(64))).toBeNull(); // not RIFF
    // WAVE_FORMAT_EXTENSIBLE hides its real format in an extension this writer does not reproduce.
    expect(parseWavHeader(wav(1, { format: 0xfffe }))).toBeNull();
    // An mp3 (or anything else) has no RIFF header at all.
    expect(parseWavHeader(new Uint8Array([0xff, 0xfb, 0x90, 0x00, 0, 0, 0, 0]))).toBeNull();
  });

  it('walks past chunks it does not know (LIST/fact) to find data', () => {
    const base = wav(1);
    const extra = new Uint8Array(base.byteLength + 12);
    extra.set(base.subarray(0, 36));
    // a 4-byte 'fact' chunk wedged between fmt and data
    const view = new DataView(extra.buffer);
    for (let i = 0; i < 4; i++) extra[36 + i] = 'fact'.charCodeAt(i);
    view.setUint32(40, 4, true);
    extra.set(base.subarray(36), 48);
    const info = parseWavHeader(extra)!;
    expect(info.dataOffset).toBe(56);
  });
});

describe('wavByteRange', () => {
  const info = parseWavHeader(wav(10, { sampleRate: 1000, channels: 2, bits: 16 }))!; // 4000 B/s

  it('asks for exactly the seconds that will be heard, on a frame boundary', () => {
    const range = wavByteRange(info, 2, 3)!;
    expect(range.start).toBe(44 + 8000);
    expect(range.length).toBe(12000);
    expect((range.start - info.dataOffset) % info.blockAlign).toBe(0);
    expect(range.end).toBe(range.start + range.length - 1);
    // Twelve seconds of a 97-second song is what the audition is FOR: a fraction, not the file.
    expect(range.length).toBeLessThan(info.dataLength);
  });

  it('clamps a window that runs off the end instead of asking for bytes that do not exist', () => {
    const range = wavByteRange(info, 8, 12)!;
    expect(range.start + range.length).toBe(info.dataOffset + info.dataLength);
  });

  it('refuses a start past the end of the audio', () => {
    expect(wavByteRange(info, 30, 12)).toBeNull();
    expect(wavByteRange(info, 0, 0)).toBeNull();
  });
});

describe('buildWavFile', () => {
  it('wraps a slice in a header the browser can decode on its own', () => {
    const info = parseWavHeader(wav(10, { sampleRate: 8000, channels: 1, bits: 16 }))!;
    const samples = new Uint8Array(320);
    const file = new Uint8Array(buildWavFile(info, samples));
    const round = parseWavHeader(file)!;
    expect(round).toMatchObject({ format: 1, channels: 1, sampleRate: 8000, bitsPerSample: 16, dataOffset: 44 });
    expect(round.dataLength).toBe(320);
    expect(file.byteLength).toBe(364);
  });
});

// ------------------------------------------------------------------ the fetch, with a fake server

/** A server that honours Range like a static file server (and can be told not to). */
function server(file: Uint8Array, opts: { ranges?: boolean } = {}) {
  const calls: string[] = [];
  const fetchImpl = async (_url: string, init?: RequestInit): Promise<Response> => {
    const header = (init?.headers as Record<string, string> | undefined)?.Range;
    calls.push(header ?? 'none');
    if (!header || opts.ranges === false) {
      return new Response(file.slice().buffer as ArrayBuffer, { status: 200 });
    }
    const [, a, b] = /bytes=(\d+)-(\d+)/.exec(header)!;
    const start = Number(a);
    const end = Math.min(Number(b), file.byteLength - 1);
    return new Response(file.slice(start, end + 1).buffer as ArrayBuffer, { status: 206 });
  };
  return { fetchImpl, calls, bytes: () => file.byteLength };
}

describe('fetchWavWindow', () => {
  it('downloads the window, not the file', async () => {
    const file = wav(60, { sampleRate: 8000, channels: 1, bits: 16 }); // 960 KB
    const { fetchImpl } = server(file);
    const got = (await fetchWavWindow('/songs/x/stems/drums.wav', 30, 12, fetchImpl))!;
    expect(got).not.toBeNull();
    // 12 s at 16 kB/s = 192 kB, against a 960 kB file: a fifth, and the tail is never touched.
    expect(got.bytes).toBe(12 * 16000);
    expect(got.bytes).toBeLessThan(file.byteLength / 4);
    expect(new Uint8Array(got.file).byteLength).toBe(got.bytes + 44);
  });

  it('brings back the RIGHT seconds (the audition starts where the manifest says)', async () => {
    const file = wav(10, { sampleRate: 1000, channels: 1, bits: 8 }); // 1 B/frame, ramp payload
    const { fetchImpl } = server(file);
    const got = (await fetchWavWindow('/x.wav', 4, 1, fetchImpl))!;
    const samples = new Uint8Array(got.file).subarray(44);
    expect(samples[0]).toBe(file[44 + 4000]);
    expect(samples.byteLength).toBe(1000);
  });

  it('gives up (rather than guessing) when the server ignores the range', async () => {
    const { fetchImpl } = server(wav(10), { ranges: false });
    expect(await fetchWavWindow('/x.wav', 1, 2, fetchImpl)).toBeNull();
  });

  /**
   * THE WHOLE POINT OF THIS MODULE, AND THE ONE LINE THAT USED TO UNDO IT.
   *
   * A 200 to a Range request means the server is sending the ENTIRE stem. Returning null without
   * cancelling leaves that download running to completion in the background — and then the caller
   * falls back and downloads the same song again. On a proxy that strips Range, one press of Listen
   * cost 68 MB: four discarded stems plus four real ones, twice what the full load it replaced cost.
   */
  it('CANCELS the stream when the server ignores the range, instead of letting the whole stem arrive', async () => {
    const cancelled: string[] = [];
    const streaming = (label: string, status: number): Response => {
      const body = new ReadableStream<Uint8Array>({
        pull() {
          /* an endless stem: it only ends when somebody cancels it */
        },
        cancel() {
          cancelled.push(label);
        },
      });
      return new Response(body, { status });
    };
    const fetchImpl = async (): Promise<Response> => streaming('probe', 200);
    expect(await fetchWavWindow('/x.wav', 1, 2, fetchImpl)).toBeNull();
    expect(cancelled).toEqual(['probe']);
  });

  it('cancels the SECOND request too, when only the probe was ranged', async () => {
    const file = wav(10, { sampleRate: 1000, channels: 1, bits: 16 });
    let cancelled = 0;
    let call = 0;
    const fetchImpl = async (_url: string, init?: RequestInit): Promise<Response> => {
      call++;
      if (call === 1) {
        const header = (init?.headers as Record<string, string> | undefined)?.Range ?? '';
        const [, a, b] = /bytes=(\d+)-(\d+)/.exec(header)!;
        return new Response(file.slice(Number(a), Number(b) + 1).buffer as ArrayBuffer, { status: 206 });
      }
      return new Response(
        new ReadableStream<Uint8Array>({
          pull() {},
          cancel() {
            cancelled++;
          },
        }),
        { status: 200 },
      );
    };
    expect(await fetchWavWindow('/x.wav', 1, 2, fetchImpl)).toBeNull();
    expect(cancelled).toBe(1);
  });

  it('gives up on a stem that is not a sliceable WAV', async () => {
    const mp3 = new Uint8Array(4096).fill(0x55);
    const { fetchImpl } = server(mp3);
    expect(await fetchWavWindow('/x.mp3', 1, 2, fetchImpl)).toBeNull();
  });
});

// ------------------------------------------------------------------ playback

class FakeParam {
  value = 1;
  setValueAtTime() { return this; }
  linearRampToValueAtTime() { return this; }
  cancelScheduledValues() { return this; }
}
class FakeNode {
  connected: unknown[] = [];
  connect(n: unknown) { this.connected.push(n); return n as never; }
  disconnect() { this.connected = []; }
}
class FakeGain extends FakeNode { gain = new FakeParam(); }
class FakeSource extends FakeNode {
  buffer: unknown = null;
  started: { when: number; offset: number; duration?: number } | null = null;
  stopped = false;
  start(when: number, offset: number, duration?: number) { this.started = { when, offset, duration }; }
  stop() { this.stopped = true; }
}
class FakeCtx {
  currentTime = 0;
  sources: FakeSource[] = [];
  decoded: number[] = [];
  createGain() { return new FakeGain() as unknown as GainNode; }
  createBufferSource() { const s = new FakeSource(); this.sources.push(s); return s as unknown as AudioBufferSourceNode; }
  async decodeAudioData(data: ArrayBuffer) { this.decoded.push(data.byteLength); return { duration: 12 } as AudioBuffer; }
}

const MANIFEST = {
  id: 'demo', title: 'Demo', artist: 'A', license: 'CC0', bpm: 120, offset: 0, durationSec: 60, previewStart: 30,
  stems: [{ id: 'drums', file: 'stems/drums.wav', label: 'Drums' }, { id: 'bass', file: 'stems/bass.wav', label: 'Bass' }],
  playerStem: 'drums',
} as unknown as SongManifest;

describe('Audition', () => {
  it('plays every stem together, from the manifest previewStart, and reports what it cost', async () => {
    const file = wav(60, { sampleRate: 8000, channels: 1, bits: 16 });
    const { fetchImpl } = server(file);
    const ctx = new FakeCtx();
    const out = new FakeNode() as unknown as AudioNode;
    const progress: number[] = [];
    const audition = new Audition(ctx, out, fetchImpl);

    const ok = await audition.play(MANIFEST, { durationSec: 12, onProgress: (p) => progress.push(p.bytes) });

    expect(ok).toBe(true);
    expect(audition.songId).toBe('demo');
    expect(ctx.sources).toHaveLength(2);
    for (const s of ctx.sources) expect(s.started?.duration).toBe(12);
    // Two stems × 12 s of a 60 s song — not two whole files.
    expect(progress.at(-1)).toBe(2 * 12 * 16000);
    expect(progress.at(-1)! * 2).toBeLessThan(2 * file.byteLength);
    audition.stop();
    expect(audition.songId).toBeNull();
    for (const s of ctx.sources) expect(s.stopped).toBe(true);
  });

  /**
   * RANGE SUPPORT BELONGS TO THE SERVER, NOT TO THE FILE. Probing all four stems of a song in
   * parallel against a proxy that strips Range means four whole-stem downloads started (and
   * cancelled) to learn one fact. The first stem is probed alone, so a refusal costs ONE request.
   */
  it('asks one stem, not all of them, before giving up on a server that does not do ranges', async () => {
    const { fetchImpl, calls } = server(wav(60, { sampleRate: 8000 }), { ranges: false });
    const audition = new Audition(new FakeCtx(), new FakeNode() as unknown as AudioNode, fetchImpl);
    expect(await audition.play(MANIFEST, { durationSec: 12 })).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('reports failure (so the caller can fall back) rather than playing a song with a stem missing', async () => {
    let n = 0;
    const good = wav(60, { sampleRate: 8000 });
    const fetchImpl = async (_u: string, init?: RequestInit): Promise<Response> => {
      // the second stem is an mp3: unsliceable
      const bad = ++n > 2;
      const header = (init?.headers as Record<string, string> | undefined)?.Range;
      const [, a, b] = /bytes=(\d+)-(\d+)/.exec(header!)!;
      const body = bad ? new Uint8Array(4096).fill(0x55) : good;
      return new Response(body.slice(Number(a), Math.min(Number(b), body.byteLength - 1) + 1).buffer as ArrayBuffer, { status: 206 });
    };
    const ctx = new FakeCtx();
    const audition = new Audition(ctx, new FakeNode() as unknown as AudioNode, fetchImpl);
    expect(await audition.play(MANIFEST, { durationSec: 12 })).toBe(false);
    expect(ctx.sources).toHaveLength(0);
    expect(audition.songId).toBeNull();
  });

  it('is cancellable: stopping mid-download aborts the fetches and plays nothing', async () => {
    const file = wav(60, { sampleRate: 8000 });
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => { release = r; });
    const fetchImpl = async (_u: string, init?: RequestInit): Promise<Response> => {
      await gate;
      if (init?.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      const header = (init?.headers as Record<string, string> | undefined)?.Range;
      const [, a, b] = /bytes=(\d+)-(\d+)/.exec(header!)!;
      return new Response(file.slice(Number(a), Math.min(Number(b), file.byteLength - 1) + 1).buffer as ArrayBuffer, { status: 206 });
    };
    const ctx = new FakeCtx();
    const audition = new Audition(ctx, new FakeNode() as unknown as AudioNode, fetchImpl);
    const playing = audition.play(MANIFEST, { durationSec: 12 });
    audition.stop(); // the therapist moves on before a byte has arrived
    release!();
    expect(await playing).toBe(false);
    expect(ctx.sources).toHaveLength(0);
  });

  it('a second audition stops the first', async () => {
    const { fetchImpl } = server(wav(60, { sampleRate: 8000 }));
    const ctx = new FakeCtx();
    const audition = new Audition(ctx, new FakeNode() as unknown as AudioNode, fetchImpl);
    await audition.play(MANIFEST, { durationSec: 12 });
    const first = [...ctx.sources];
    await audition.play({ ...MANIFEST, id: 'other' } as SongManifest, { durationSec: 12 });
    for (const s of first) expect(s.stopped).toBe(true);
    expect(audition.songId).toBe('other');
    audition.stop();
  });

  it('stops itself when the audition window is over', async () => {
    vi.useFakeTimers();
    try {
      const { fetchImpl } = server(wav(60, { sampleRate: 8000 }));
      const ctx = new FakeCtx();
      const audition = new Audition(ctx, new FakeNode() as unknown as AudioNode, fetchImpl);
      await audition.play(MANIFEST, { durationSec: 12 });
      expect(audition.songId).toBe('demo');
      vi.advanceTimersByTime(12_100);
      expect(audition.songId).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
