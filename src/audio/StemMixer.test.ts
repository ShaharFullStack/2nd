import { describe, expect, it } from 'vitest';
import { DEFAULT_MASTER_GAIN, LIMITER_SETTINGS, StemMixer, aggregateProgress, readBodyWithProgress, type LoadProgress } from './StemMixer';
import { parseManifest, type FetchLike } from './manifest';

// ---------------------------------------------------------------- fake Web Audio

class FakeParam {
  value: number;
  log: string[] = [];
  constructor(v: number) { this.value = v; }
  cancelScheduledValues(t: number) { this.log.push(`cancel@${t}`); return this; }
  setValueAtTime(v: number, t: number) { this.log.push(`set ${v}@${t}`); this.value = v; return this; }
  linearRampToValueAtTime(v: number, t: number) { this.log.push(`lin ${v}@${t}`); this.value = v; return this; }
  exponentialRampToValueAtTime(v: number, t: number) { this.log.push(`exp ${v}@${t}`); this.value = v; return this; }
}

class FakeNode {
  connections: FakeNode[] = [];
  connect(n: FakeNode) { this.connections.push(n); return n; }
  disconnect() { this.connections = []; }
}

class FakeGain extends FakeNode { gain = new FakeParam(1); }
class FakeCompressor extends FakeNode {
  threshold = new FakeParam(-24); knee = new FakeParam(30); ratio = new FakeParam(12); attack = new FakeParam(0.003); release = new FakeParam(0.25);
}
class FakeBuffer { duration: number; constructor(duration: number) { this.duration = duration; } }
class FakeSource extends FakeNode {
  buffer: FakeBuffer | null = null;
  started: { when: number; offset: number } | null = null;
  stopped = false;
  onended: (() => void) | null = null;
  start(when: number, offset: number) { this.started = { when, offset }; }
  stop() { if (!this.started) throw new Error('InvalidStateError'); this.stopped = true; }
}

class FakeContext {
  currentTime = 0;
  state: 'suspended' | 'running' | 'closed' = 'suspended';
  destination = new FakeNode();
  sources: FakeSource[] = [];
  gains: FakeGain[] = [];
  decodeDurations: Record<string, number> = {};
  createGain() { const g = new FakeGain(); this.gains.push(g); return g; }
  createDynamicsCompressor() { return new FakeCompressor(); }
  createBufferSource() { const s = new FakeSource(); this.sources.push(s); return s; }
  async decodeAudioData(data: ArrayBuffer) { const key = new TextDecoder().decode(data); return new FakeBuffer(this.decodeDurations[key] ?? 10); }
  async resume() { this.state = 'running'; }
  async close() { this.state = 'closed'; }
}

const manifest = parseManifest({
  id: 'song', title: 'T', artist: 'A', license: 'CC0 1.0', bpm: 120, offset: 0, durationSec: 10,
  stems: [{ id: 'drums', file: 'stems/drums.wav' }, { id: 'bass', file: 'stems/bass.wav' }, { id: 'keys', file: 'stems/keys.wav' }],
  playerStem: 'drums',
});

function setup(opts: { durations?: Record<string, number>; compressor?: boolean } = {}) {
  const ctx = new FakeContext();
  ctx.decodeDurations = opts.durations ?? { drums: 10, bass: 10, keys: 8 };
  const fetched: string[] = [];
  const fetch: FetchLike = async (url) => {
    fetched.push(url);
    const id = /stems\/(\w+)\.wav$/.exec(url)?.[1] ?? '';
    if (id === 'missing') return new Response('', { status: 404 });
    return new Response(id, { status: 200 });
  };
  const mixer = new StemMixer({ ctx: ctx as unknown as AudioContext, fetch, compressor: opts.compressor, startLeadSec: 0.03 });
  return { ctx, mixer, fetched };
}

// ---------------------------------------------------------------- tests

describe('StemMixer', () => {
  it('builds master → compressor → destination and can skip the compressor', () => {
    const a = setup();
    expect(a.mixer.compressor).not.toBeNull();
    expect((a.mixer.master as unknown as FakeGain).connections[0]).toBe(a.mixer.compressor);
    expect((a.mixer.compressor as unknown as FakeCompressor).connections[0]).toBe(a.ctx.destination);
    const b = setup({ compressor: false });
    expect(b.mixer.compressor).toBeNull();
    expect((b.mixer.master as unknown as FakeGain).connections[0]).toBe(b.ctx.destination);
  });

  it('loads all stems in parallel with progress and sets the player stem', async () => {
    const { mixer, fetched } = setup();
    const events: LoadProgress[] = [];
    await mixer.loadSong(manifest, '/songs', (p) => events.push(p));
    expect(fetched).toEqual(['/songs/song/stems/drums.wav', '/songs/song/stems/bass.wav', '/songs/song/stems/keys.wav']);
    const phases = events.filter((p) => p.phase !== 'downloading').map((p) => `${p.stemId}:${p.phase}`);
    expect(phases).toHaveLength(6); // fetched + decoded per stem
    expect(phases.filter((x) => x.endsWith(':decoded'))).toEqual(expect.arrayContaining(['drums:decoded', 'bass:decoded', 'keys:decoded']));
    expect(events[0].phase).toBe('downloading');
    for (let i = 1; i < events.length; i++) expect(events[i].fraction).toBeGreaterThanOrEqual(events[i - 1].fraction);
    const last = events[events.length - 1];
    expect(last).toMatchObject({ fraction: 1, stemsDecoded: 3, stemCount: 3, bytesTotalKnown: true, phase: 'decoded' });
    expect(last.bytesLoaded).toBe('drums'.length + 'bass'.length + 'keys'.length);
    expect(last.bytesTotal).toBe(last.bytesLoaded);
    expect(mixer.state).toBe('ready');
    expect(mixer.stemIds).toEqual(['drums', 'bass', 'keys']);
    expect(mixer.playerStem).toBe('drums');
    expect(mixer.getDuration()).toBe(10);
  });

  it('rejects when a stem is missing and returns to idle', async () => {
    const { mixer } = setup();
    const bad = { ...manifest, stems: [...manifest.stems, { id: 'missing', file: 'stems/missing.wav', label: 'x' }] };
    await expect(mixer.loadSong(bad, '/songs')).rejects.toThrow(/missing/);
    expect(mixer.state).toBe('idle');
    expect(mixer.isLoaded).toBe(false);
  });

  it('play starts every stem at the same ctx time from the same offset', async () => {
    const { ctx, mixer } = setup();
    await mixer.loadSong(manifest, '/songs');
    ctx.currentTime = 1;
    const startAt = mixer.play(1.5);
    expect(startAt).toBe(1.5);
    expect(ctx.sources).toHaveLength(3);
    for (const s of ctx.sources) expect(s.started).toEqual({ when: 1.5, offset: 0 });
    expect(mixer.state).toBe('playing');
    // song time counts from the scheduled start (negative before it)
    ctx.currentTime = 1.4;
    expect(mixer.getSongTime()).toBeCloseTo(-0.1, 9);
    ctx.currentTime = 4.5;
    expect(mixer.getSongTime()).toBeCloseTo(3, 9);
    expect(mixer.getSongStartCtxTime()).toBe(1.5);
    expect(mixer.songTimeToCtxTime(2)).toBe(3.5);
    expect(mixer.ctxTimeToSongTime(3.5)).toBe(2);
  });

  it('never schedules in the past: play() without a time uses now + lead', async () => {
    const { ctx, mixer } = setup();
    await mixer.loadSong(manifest, '/songs');
    ctx.currentTime = 7;
    expect(mixer.play()).toBeCloseTo(7.03, 9);
    expect(mixer.play(2)).toBeCloseTo(7.03, 9);
  });

  it('pause / resume / seek / stop keep song time consistent', async () => {
    const { ctx, mixer } = setup();
    await mixer.loadSong(manifest, '/songs');
    ctx.currentTime = 0;
    mixer.play(0.1);
    ctx.currentTime = 2.1;
    mixer.pause();
    expect(mixer.state).toBe('paused');
    expect(mixer.getSongTime()).toBeCloseTo(2, 9);
    expect(ctx.sources.every((s) => s.stopped)).toBe(true);
    ctx.currentTime = 5;
    expect(mixer.getSongTime()).toBeCloseTo(2, 9); // frozen while paused

    await mixer.resume();
    expect(ctx.state).toBe('running');
    expect(mixer.state).toBe('playing');
    const resumed = ctx.sources.slice(3);
    expect(resumed).toHaveLength(3);
    for (const s of resumed) expect(s.started).toEqual({ when: 5.03, offset: 2 });
    ctx.currentTime = 6.03;
    expect(mixer.getSongTime()).toBeCloseTo(3, 9);

    mixer.seek(8.5);
    const afterSeek = ctx.sources.slice(6);
    expect(afterSeek).toHaveLength(2); // keys (8 s) is already over at 8.5 → only drums + bass start
    for (const s of afterSeek) { expect(s.started?.when).toBeCloseTo(6.06, 9); expect(s.started?.offset).toBe(8.5); }
    expect(mixer.state).toBe('playing');
    ctx.currentTime = 6.06 + 0.5;
    expect(mixer.getSongTime()).toBeCloseTo(9, 9);

    mixer.stop();
    expect(mixer.state).toBe('ready');
    expect(mixer.getSongTime()).toBe(0);
    mixer.seek(4);
    expect(mixer.getSongTime()).toBe(4);
    expect(mixer.state).toBe('ready');
  });

  it('reports ended via the longest stem and clamps song time to the duration', async () => {
    const { ctx, mixer } = setup();
    await mixer.loadSong(manifest, '/songs');
    let ended = 0;
    const off = mixer.onEnded(() => ended++);
    mixer.play(0.03);
    const drums = ctx.sources.find((s) => (s.buffer as FakeBuffer).duration === 10)!;
    const keys = ctx.sources.find((s) => (s.buffer as FakeBuffer).duration === 8)!;
    expect(keys.onended).toBeNull();
    expect(drums.onended).not.toBeNull();
    ctx.currentTime = 10.03;
    drums.onended!();
    expect(ended).toBe(1);
    expect(mixer.state).toBe('ended');
    expect(mixer.getSongTime()).toBe(10);
    // play again after ending restarts from 0
    mixer.play(11);
    expect(ctx.sources[ctx.sources.length - 1].started?.offset).toBe(0);
    off();
    // a stale onended from a stopped source must not end the new playback
    drums.onended?.();
    expect(mixer.state).toBe('playing');
    expect(ended).toBe(1);
  });

  it('ducks and restores the player stem, with the streak boost, and rebinds on setPlayerStem', async () => {
    const { ctx, mixer } = setup();
    await mixer.loadSong(manifest, '/songs');
    ctx.currentTime = 1;
    mixer.play();
    const drumSource = ctx.sources[0];
    const drumDuck = drumSource.connections[0] as FakeGain;
    drumDuck.gain.log = [];
    ctx.currentTime = 2;
    mixer.onMiss();
    expect(mixer.isDucked).toBe(true);
    expect(drumDuck.gain.log).toEqual(['cancel@2', 'set 1@2', 'exp 0.05@2.04']);
    ctx.currentTime = 3;
    mixer.onHit(8);
    expect(mixer.isDucked).toBe(false);
    expect(drumDuck.gain.log.slice(-1)[0]).toMatch(/^exp 1\.2589\d*@3\.06$/);

    // move the player stem to bass: drums restored instantly, bass now ducks
    const bassDuck = ctx.sources[1].connections[0] as FakeGain;
    ctx.currentTime = 4;
    mixer.setPlayerStem('bass');
    expect(mixer.playerStem).toBe('bass');
    expect(drumDuck.gain.value).toBe(1);
    mixer.onMiss();
    expect(bassDuck.gain.log.slice(-1)[0]).toBe('exp 0.05@4.04');
    expect(() => mixer.setPlayerStem('nope')).toThrow(/unknown stem/);
  });

  it('per-stem and master gains ramp linearly', async () => {
    const { ctx, mixer } = setup();
    await mixer.loadSong(manifest, '/songs');
    ctx.currentTime = 1;
    mixer.setStemGain('keys', 0.5);
    expect(mixer.getStemGain('keys')).toBe(0.5);
    mixer.setMasterGain(0.25, 0.1);
    expect(mixer.getMasterGain()).toBe(0.25);
    expect((mixer.master as unknown as FakeGain).gain.log.slice(-1)[0]).toBe('lin 0.25@1.1');
    expect(() => mixer.getStemGain('nope')).toThrow();
  });

  it('a newer loadSong supersedes an older one; dispose unloads and leaves a foreign context open', async () => {
    const { ctx, mixer } = setup();
    const first = mixer.loadSong(manifest, '/songs');
    const second = mixer.loadSong({ ...manifest, id: 'song2', stems: manifest.stems.slice(0, 1) }, '/songs');
    await Promise.all([first, second]);
    expect(mixer.manifest?.id).toBe('song2');
    expect(mixer.stemIds).toEqual(['drums']);
    mixer.play();
    mixer.dispose();
    expect(mixer.state).toBe('idle');
    expect(mixer.isLoaded).toBe(false);
    expect(ctx.state).not.toBe('closed');
    expect(() => mixer.play()).toThrow(/no song loaded/);
  });

  it('master stage: limiter settings when on; 0.6 headroom and direct wiring when off', async () => {
    const on = setup();
    const c = on.mixer.compressor as unknown as FakeCompressor;
    expect(on.mixer.getMasterGain()).toBe(DEFAULT_MASTER_GAIN.limiter);
    expect({ threshold: c.threshold.value, knee: c.knee.value, ratio: c.ratio.value, attack: c.attack.value, release: c.release.value }).toEqual(LIMITER_SETTINGS);
    expect(c.ratio.value).toBeGreaterThanOrEqual(10); // limiter, not a program compressor
    expect(c.release.value).toBeLessThanOrEqual(0.05);
    expect(on.mixer.output).toBe(on.mixer.compressor);

    const off = setup({ compressor: false });
    expect(off.mixer.getMasterGain()).toBe(DEFAULT_MASTER_GAIN.none);
    expect(off.mixer.output).toBe(off.mixer.master);
    await off.mixer.loadSong(manifest, '/songs');
    off.mixer.play();
    // every stem: source → duck → volume → master → destination (nothing else in the path)
    expect(off.ctx.sources).toHaveLength(3);
    for (const src of off.ctx.sources) {
      const duck = src.connections[0] as FakeGain;
      const volume = duck.connections[0] as FakeGain;
      expect(src.connections).toHaveLength(1);
      expect(duck.connections).toEqual([volume]);
      expect(volume.connections).toEqual([off.mixer.master]);
    }
    expect((off.mixer.master as unknown as FakeGain).connections).toEqual([off.ctx.destination]);
    expect(new StemMixer({ ctx: off.ctx as unknown as AudioContext, compressor: false, masterGain: 0.9 }).getMasterGain()).toBe(0.9);
  });

  it('reports byte progress from a streamed body with Content-Length', async () => {
    const body = new Uint8Array(1000).fill(7);
    const chunks = [body.subarray(0, 300), body.subarray(300, 650), body.subarray(650)];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { for (const c of chunks) controller.enqueue(c); controller.close(); },
    });
    const res = new Response(stream, { status: 200, headers: { 'content-length': '1000' } });
    const seen: [number, number | null][] = [];
    const data = await readBodyWithProgress(res, (r, t) => seen.push([r, t]));
    expect(data.byteLength).toBe(1000);
    expect(new Uint8Array(data)[999]).toBe(7);
    expect(seen).toEqual([[0, 1000], [300, 1000], [650, 1000], [1000, 1000]]);

    // no body reader → arrayBuffer fallback, one final report
    const plain = { body: null, arrayBuffer: async () => new ArrayBuffer(12), headers: new Headers() } as unknown as Response;
    const seen2: [number, number | null][] = [];
    expect((await readBodyWithProgress(plain, (r, t) => seen2.push([r, t]))).byteLength).toBe(12);
    expect(seen2).toEqual([[12, 12]]);
  });

  it('aggregateProgress weights download 0.85 and decode 0.15 per stem and tracks byte totals', () => {
    const p = aggregateProgress([
      { received: 500, total: 1000, fetched: false, decoded: false },
      { received: 2000, total: 2000, fetched: true, decoded: true },
      { received: 10, total: null, fetched: false, decoded: false },
    ], 'bass', 'downloading');
    expect(p.fraction).toBeCloseTo((0.85 * 0.5 + 1 + 0) / 3, 9);
    expect(p).toMatchObject({ bytesLoaded: 2510, bytesTotal: 3000, bytesTotalKnown: false, stemsDecoded: 1, stemCount: 3, stemId: 'bass', phase: 'downloading' });
    expect(aggregateProgress([], 'x', 'decoded').fraction).toBe(1);
    // a stem whose Content-Length under-reports never pushes the fraction past 1
    expect(aggregateProgress([{ received: 5000, total: 1000, fetched: false, decoded: false }], 'x', 'downloading').fraction).toBeCloseTo(0.85, 9);
  });

  it('play() at or past the end of every stem ends immediately instead of playing forever', async () => {
    const { ctx, mixer } = setup();
    await mixer.loadSong(manifest, '/songs');
    let ended = 0;
    mixer.onEnded(() => ended++);
    ctx.currentTime = 1;
    mixer.play(1.5);
    mixer.seek(mixer.getDuration()); // seek to the very end while playing
    expect(mixer.state).toBe('ended');
    expect(ended).toBe(1);
    expect(mixer.getSongTime()).toBe(10);
    ctx.currentTime = 50;
    expect(mixer.getSongTime()).toBe(10); // does not run past the duration
    expect(ctx.sources.filter((s) => s.started && !s.stopped)).toHaveLength(0);
    // explicit offset beyond the end behaves the same
    mixer.play(undefined, 999);
    expect(mixer.state).toBe('ended');
    expect(ended).toBe(2);
    // and playing again after 'ended' restarts from 0
    mixer.play();
    expect(mixer.state).toBe('playing');
    expect(ctx.sources[ctx.sources.length - 1].started?.offset).toBe(0);
  });

  it('pause() before the scheduled start clamps song time to 0', async () => {
    const { ctx, mixer } = setup();
    await mixer.loadSong(manifest, '/songs');
    ctx.currentTime = 1;
    mixer.play(3);
    ctx.currentTime = 2;
    expect(mixer.getSongTime()).toBeCloseTo(-1, 9);
    mixer.pause();
    expect(mixer.state).toBe('paused');
    expect(mixer.getSongTime()).toBe(0);
    ctx.currentTime = 4;
    mixer.play();
    expect(ctx.sources[ctx.sources.length - 1].started).toEqual({ when: 4.03, offset: 0 });
  });
});
