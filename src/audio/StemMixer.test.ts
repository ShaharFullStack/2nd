import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MASTER_GAIN, DEFAULT_START_LEAD_SEC, LIMITER_SETTINGS, RESUME_FADE_SEC, START_GUARD_QUANTA, STOP_FADE_SEC, StemMixer,
  aggregateProgress, readBodyWithProgress, type LoadProgress,
} from './StemMixer';
import { MIN_GAIN } from './ducking';
import { parseManifest, type FetchLike, type SongManifest } from './manifest';
import { SongClock } from '../engine/scheduler';

// ---------------------------------------------------------------- fake Web Audio

type Ev = ['cancel' | 'set' | 'lin' | 'exp', number, number];

class FakeParam {
  value: number;
  log: string[] = [];
  events: Ev[] = [];
  constructor(v: number) { this.value = v; }
  cancelScheduledValues(t: number) { this.log.push(`cancel@${t}`); this.events.push(['cancel', 0, t]); return this; }
  setValueAtTime(v: number, t: number) { this.log.push(`set ${v}@${t}`); this.events.push(['set', v, t]); this.value = v; return this; }
  linearRampToValueAtTime(v: number, t: number) { this.log.push(`lin ${v}@${t}`); this.events.push(['lin', v, t]); this.value = v; return this; }
  exponentialRampToValueAtTime(v: number, t: number) { this.log.push(`exp ${v}@${t}`); this.events.push(['exp', v, t]); this.value = v; return this; }
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
  stopAt: number | null = null;
  onended: (() => void) | null = null;
  readonly ctx: FakeContext;
  constructor(ctx: FakeContext) { super(); this.ctx = ctx; }
  start(when: number, offset: number) {
    this.started = { when, offset };
    // simulate a main thread that stalls (MediaPipe inference) right after posting the first start
    if (this.ctx.stallOnNextStart > 0) { this.ctx.currentTime += this.ctx.stallOnNextStart; this.ctx.stallOnNextStart = 0; }
  }
  stop(when?: number) { if (!this.started) throw new Error('InvalidStateError'); this.stopped = true; this.stopAt = when ?? this.ctx.currentTime; }
}

class FakeContext {
  currentTime = 0;
  sampleRate = 44100;
  state: 'suspended' | 'running' | 'closed' = 'suspended';
  destination = new FakeNode();
  sources: FakeSource[] = [];
  gains: FakeGain[] = [];
  decodeDurations: Record<string, number> = {};
  stallOnNextStart = 0;
  /** Seconds the fake ctx.resume() takes (currentTime advances by this much). */
  resumeLatency = 0;
  createGain() { const g = new FakeGain(); this.gains.push(g); return g; }
  createDynamicsCompressor() { return new FakeCompressor(); }
  createBufferSource() { const s = new FakeSource(this); this.sources.push(s); return s; }
  async decodeAudioData(data: ArrayBuffer) {
    if (this.state === 'closed') throw new Error('decodeAudioData on a closed context');
    const key = new TextDecoder().decode(data);
    return new FakeBuffer(this.decodeDurations[key] ?? 10);
  }
  async resume() { this.currentTime += this.resumeLatency; this.state = 'running'; }
  async close() { this.state = 'closed'; }
}

const manifest = parseManifest({
  id: 'song', title: 'T', artist: 'A', license: 'CC0 1.0', bpm: 120, offset: 0, durationSec: 10, previewStart: 3,
  stems: [{ id: 'drums', file: 'stems/drums.wav' }, { id: 'bass', file: 'stems/bass.wav' }, { id: 'keys', file: 'stems/keys.wav' }],
  playerStem: 'drums',
});

interface Pending { url: string; signal: AbortSignal | undefined; resolve: (r: Response) => void }

function setup(opts: { durations?: Record<string, number>; compressor?: boolean; startLeadSec?: number | null } = {}) {
  const ctx = new FakeContext();
  ctx.decodeDurations = opts.durations ?? { drums: 10, bass: 10, keys: 8 };
  const fetched: string[] = [];
  const signals: AbortSignal[] = [];
  const pending: Pending[] = [];
  const fetch: FetchLike = (url, init) => {
    fetched.push(url);
    if (init?.signal) signals.push(init.signal);
    const id = /stems\/(\w+)\.wav$/.exec(url)?.[1] ?? '';
    if (id === 'missing') return Promise.resolve(new Response('', { status: 404 }));
    if (id === 'slow') {
      // resolves only when the test says so; rejects like a real fetch when its signal aborts
      return new Promise<Response>((resolve, reject) => {
        pending.push({ url, signal: init?.signal ?? undefined, resolve });
        init?.signal?.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
      });
    }
    return Promise.resolve(new Response(id, { status: 200 }));
  };
  const mixer = new StemMixer({
    ctx: ctx as unknown as AudioContext, fetch, compressor: opts.compressor,
    startLeadSec: opts.startLeadSec === null ? undefined : (opts.startLeadSec ?? 0.03),
  });
  return { ctx, mixer, fetched, signals, pending };
}

const transportEvents = (m: StemMixer): Ev[] => (m.transport as unknown as FakeGain).gain.events;
const lastEvents = (evs: Ev[], n: number): Ev[] => evs.slice(-n);

afterEach(() => { vi.useRealTimers(); });

// ---------------------------------------------------------------- tests

describe('StemMixer', () => {
  it('builds stems → transport → master → compressor → destination and can skip the compressor', () => {
    const a = setup();
    expect(a.mixer.compressor).not.toBeNull();
    expect((a.mixer.transport as unknown as FakeGain).connections[0]).toBe(a.mixer.master);
    expect((a.mixer.master as unknown as FakeGain).connections[0]).toBe(a.mixer.compressor);
    expect((a.mixer.compressor as unknown as FakeCompressor).connections[0]).toBe(a.ctx.destination);
    const b = setup({ compressor: false });
    expect(b.mixer.compressor).toBeNull();
    expect((b.mixer.master as unknown as FakeGain).connections[0]).toBe(b.ctx.destination);
  });

  it('loads all stems in parallel with progress and sets the player stem', async () => {
    const { mixer, fetched, signals } = setup();
    const events: LoadProgress[] = [];
    await mixer.loadSong(manifest, '/songs', (p) => events.push(p));
    expect(fetched).toEqual(['/songs/song/stems/drums.wav', '/songs/song/stems/bass.wav', '/songs/song/stems/keys.wav']);
    expect(signals).toHaveLength(3); // every fetch gets the load's AbortSignal
    expect(signals.every((s) => !s.aborted)).toBe(true);
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

  it('rejects when a stem is missing, aborts the sibling downloads and returns to idle (recoverable)', async () => {
    const { mixer, signals, pending } = setup();
    const bad = { ...manifest, stems: [...manifest.stems, { id: 'missing', file: 'stems/missing.wav', label: 'x' }, { id: 'slow', file: 'stems/slow.wav', label: 's' }] };
    await expect(mixer.loadSong(bad, '/songs')).rejects.toThrow(/missing/);
    expect(mixer.state).toBe('idle');
    expect(mixer.isLoaded).toBe(false);
    expect(pending).toHaveLength(1);
    expect(signals.every((s) => s.aborted)).toBe(true); // the still-running "slow" download was cancelled
    // the mixer is usable again
    await mixer.loadSong(manifest, '/songs');
    expect(mixer.state).toBe('ready');
    expect(mixer.stemIds).toEqual(['drums', 'bass', 'keys']);
  });

  it('unload()/dispose() during a load abort the downloads and the load resolves quietly', async () => {
    const { mixer, signals, pending, ctx } = setup();
    const slow = { ...manifest, stems: [manifest.stems[0], { id: 'slow', file: 'stems/slow.wav', label: 's' }] };
    let settled: 'resolved' | 'rejected' | null = null;
    const load = mixer.loadSong(slow, '/songs').then(() => { settled = 'resolved'; }, () => { settled = 'rejected'; });
    await Promise.resolve();
    expect(mixer.state).toBe('loading');
    expect(pending).toHaveLength(1);
    mixer.unload();
    await load;
    expect(settled).toBe('resolved'); // no unhandled rejection for fire-and-forget callers
    expect(signals.every((s) => s.aborted)).toBe(true);
    expect(mixer.state).toBe('idle');
    expect(mixer.manifest).toBeNull();
    // dispose mid-load behaves the same, even though decodeAudioData would now reject
    const { mixer: m2, pending: p2, signals: s2, ctx: c2 } = setup();
    const load2 = m2.loadSong(slow, '/songs');
    await Promise.resolve();
    m2.dispose();
    c2.state = 'closed';
    p2[0].resolve(new Response('slow', { status: 200 }));
    await expect(load2).resolves.toBeUndefined();
    expect(s2.every((s) => s.aborted)).toBe(true);
    expect(ctx.state).not.toBe('closed'); // foreign context untouched
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

  it('never schedules in the past: play() without a time uses now + lead (default 100 ms)', async () => {
    const { ctx, mixer } = setup();
    await mixer.loadSong(manifest, '/songs');
    ctx.currentTime = 7;
    expect(mixer.play()).toBeCloseTo(7.03, 9);
    expect(mixer.play(2)).toBeCloseTo(7.03, 9);
    expect(DEFAULT_START_LEAD_SEC).toBe(0.1);
    const d = setup({ startLeadSec: null });
    await d.mixer.loadSong(manifest, '/songs');
    d.ctx.currentTime = 7;
    expect(d.mixer.play()).toBeCloseTo(7.1, 9);
  });

  it('verifies the start against the audio thread: a main-thread stall after scheduling reschedules from the new now', async () => {
    const { ctx, mixer } = setup();
    await mixer.loadSong(manifest, '/songs');
    ctx.currentTime = 1;
    ctx.stallOnNextStart = 0.2; // the first src.start() is followed by a 200 ms stall: 1.03 is already in the past
    const startAt = mixer.play();
    expect(startAt).toBeCloseTo(1.23, 9);
    const live = ctx.sources.filter((s) => !s.stopped);
    const discarded = ctx.sources.filter((s) => s.stopped);
    expect(live).toHaveLength(3);
    expect(discarded).toHaveLength(3);
    for (const s of live) expect(s.started).toEqual({ when: startAt, offset: 0 });
    expect(discarded.every((s) => s.connections.length === 0)).toBe(true);
    expect(mixer.songTime(startAt)).toBeCloseTo(0, 9);
    expect(mixer.state).toBe('playing');
    // a stall that leaves more than the guard before the deadline keeps the original schedule
    ctx.currentTime = 2;
    ctx.stallOnNextStart = 0.01;
    const guard = START_GUARD_QUANTA * 128 / ctx.sampleRate;
    expect(mixer.play(2.03 + guard + 0.01)).toBeCloseTo(2.03 + guard + 0.01, 9);
    expect(ctx.sources.filter((s) => !s.stopped)).toHaveLength(3);
    // a far-future explicit time is never rescheduled
    ctx.currentTime = 3;
    ctx.stallOnNextStart = 0.5;
    expect(mixer.play(6)).toBe(6);
  });

  it('is a SongTimeSource that stays in lockstep with the engine SongClock across play/pause/resume/seek', async () => {
    const { ctx, mixer } = setup();
    await mixer.loadSong(manifest, '/songs');
    const clock = new SongClock(ctx);
    /**
     * The song↔ctx mapping must be identical to the engine's and invertible in EVERY transport
     * state — `ReplayInput`/`AutoplayInput` stamp events with `ctxTimeForSongTime()` and may well
     * tick while the therapist has the session paused; a mapping that is only right while playing
     * hands the engine stamps seconds in the past, which `songTimeOf()` nulls out or, worse,
     * pins on the wrong note.
     */
    const mappingAgrees = () => {
      for (const s of [0, 0.75, 1.97, 5, 12.5]) {
        expect(mixer.ctxTimeForSongTime(s)).toBeCloseTo(clock.ctxTimeForSongTime(s), 12);
        expect(mixer.ctxTimeToSongTime(mixer.ctxTimeForSongTime(s))).toBeCloseTo(s, 12); // invertible
      }
    };
    const agree = (t: number) => {
      expect(mixer.songTime(t)).toBeCloseTo(clock.songTime(t), 12);
      expect(mixer.ctxTimeForSongTime(mixer.songTime(t))).toBeCloseTo(t, 12);
      expect(clock.ctxTimeForSongTime(clock.songTime(t))).toBeCloseTo(t, 12);
      mappingAgrees();
    };
    ctx.currentTime = 1;
    const start = mixer.play();
    clock.start(start, 0);
    expect(start).toBeCloseTo(1.03, 9);
    agree(1.01); agree(1.5); agree(3);

    ctx.currentTime = 3;
    const p = mixer.pause();
    expect(p).toBe(3);
    clock.pause(p!);
    ctx.currentTime = 4;
    expect(mixer.songTime()).toBeCloseTo(1.97, 9);
    expect(clock.songTime()).toBeCloseTo(1.97, 9);
    // …and the mapping survives the pause: the pause point still maps to the ctx time of the
    // pause, both here and in the engine clock (this is where the mixer used to be off by the
    // whole elapsed playback time, 1.97 s, because it derived song-0 from the moved offset).
    mappingAgrees();
    expect(mixer.ctxTimeForSongTime(1.97)).toBeCloseTo(3, 12);
    expect(mixer.ctxTimeForSongTime(mixer.songTime())).toBeCloseTo(3, 12);
    expect(mixer.ctxTimeForSongTime(1)).toBeCloseTo(2.03, 12); // a stamp from before the pause

    // resume: ctx.resume() takes 200 ms; the restart is scheduled only afterwards, and the
    // resolved time is exactly when the sources start
    ctx.state = 'suspended';
    ctx.resumeLatency = 0.2;
    ctx.currentTime = 5;
    const r = await mixer.resume();
    expect(ctx.state).toBe('running');
    expect(r).toBeCloseTo(5.23, 9);
    const resumed = ctx.sources.filter((s) => !s.stopped);
    expect(resumed).toHaveLength(3);
    for (const s of resumed) { expect(s.started!.when).toBe(r); expect(s.started!.offset).toBeCloseTo(1.97, 9); }
    clock.resume(r!);
    agree(5.3); agree(6); agree(9);
    expect(mixer.songTime(6)).toBeCloseTo(1.97 + (6 - 5.23), 9);

    // seek while playing re-bases both clocks
    ctx.currentTime = 6;
    const s = mixer.seek(0.5);
    expect(s).toBeCloseTo(6.03, 9);
    clock.start(s!, 0.5);
    agree(6.03); agree(7);
    expect(mixer.songTime(7)).toBeCloseTo(1.47, 9);
    // resume() when nothing is paused only resumes the context
    expect(await mixer.resume()).toBeNull();
    expect(mixer.state).toBe('playing');
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

    expect(await mixer.resume()).toBeCloseTo(5.03, 9);
    expect(ctx.state).toBe('running');
    expect(mixer.state).toBe('playing');
    const resumed = ctx.sources.slice(3);
    expect(resumed).toHaveLength(3);
    for (const s of resumed) { expect(s.started!.when).toBeCloseTo(5.03, 9); expect(s.started!.offset).toBeCloseTo(2, 9); }
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
    expect(mixer.seek(4)).toBeNull();
    expect(mixer.getSongTime()).toBe(4);
    expect(mixer.state).toBe('ready');
    expect(mixer.pause()).toBeNull();
  });

  it('stops are click-free: transport fades to MIN_GAIN before the sources stop, and play() ramps it back in', async () => {
    const { ctx, mixer } = setup();
    await mixer.loadSong(manifest, '/songs');
    ctx.currentTime = 0;
    const start = mixer.play();
    // start from 0: the ramp-in completes exactly at the start time (no attenuation of the first transient)
    expect(lastEvents(transportEvents(mixer), 3)).toEqual([['cancel', 0, expect.closeTo(start - RESUME_FADE_SEC, 12)], ['set', MIN_GAIN, expect.closeTo(start - RESUME_FADE_SEC, 12)], ['exp', 1, expect.closeTo(start, 12)]]);

    ctx.currentTime = 2;
    mixer.pause();
    const fade = lastEvents(transportEvents(mixer), 3);
    expect(fade[0]).toEqual(['cancel', 0, 2]);
    expect(fade[1]).toEqual(['set', 1, 2]); // anchored on the analytic transport level (1 after the ramp-in)
    expect(fade[2]).toEqual(['exp', MIN_GAIN, expect.closeTo(2 + STOP_FADE_SEC, 12)]);
    for (const s of ctx.sources) { expect(s.stopped).toBe(true); expect(s.stopAt).toBeCloseTo(2 + STOP_FADE_SEC, 12); }
    expect(ctx.sources.every((s) => s.connections.length === 1)).toBe(true); // still connected during the fade

    // resume mid-waveform: fade in over RESUME_FADE_SEC *after* the start (hard onsets would click)
    ctx.currentTime = 3;
    const r = await mixer.resume();
    expect(lastEvents(transportEvents(mixer), 3)).toEqual([['cancel', 0, expect.closeTo(r!, 12)], ['set', MIN_GAIN, expect.closeTo(r!, 12)], ['exp', 1, expect.closeTo(r! + RESUME_FADE_SEC, 12)]]);
    expect(r! - 3).toBeGreaterThan(STOP_FADE_SEC); // the ramp-in never overlaps the previous fade-out

    // seek while playing and stop() fade as well; a fade interrupted mid-way anchors mid-ramp
    ctx.currentTime = 4;
    mixer.seek(1);
    expect(transportEvents(mixer).some((e) => e[0] === 'exp' && e[1] === MIN_GAIN && Math.abs(e[2] - (4 + STOP_FADE_SEC)) < 1e-9)).toBe(true);
    ctx.currentTime = 4 + STOP_FADE_SEC / 2; // stop() during the seek fade-out... (transport at MIN already)
    mixer.stop();
    const stopFade = lastEvents(transportEvents(mixer), 3);
    expect(stopFade[1][0]).toBe('set');
    expect(stopFade[1][1]).toBeCloseTo(MIN_GAIN, 12); // the new sources had not ramped in yet
    expect(mixer.state).toBe('ready');
  });

  it('play() while a fade-in is in flight anchors the fade-out on the analytic mid-ramp value', async () => {
    const { ctx, mixer } = setup();
    await mixer.loadSong(manifest, '/songs');
    ctx.currentTime = 1;
    mixer.play(undefined, 2); // resume-style start → fade-in over [1.03, 1.035]
    ctx.currentTime = 1.03 + RESUME_FADE_SEC / 2;
    mixer.pause();
    const ev = lastEvents(transportEvents(mixer), 3);
    expect(ev[1][0]).toBe('set');
    expect(ev[1][1]).toBeCloseTo(Math.sqrt(MIN_GAIN * 1), 9); // geometric midpoint of the exponential fade-in
  });

  it('dispose() while playing defers the teardown past the fade; otherwise it is immediate', async () => {
    vi.useFakeTimers();
    const { ctx, mixer } = setup();
    await mixer.loadSong(manifest, '/songs');
    mixer.play();
    const drumDuck = ctx.sources[0].connections[0] as FakeGain;
    mixer.dispose();
    expect(mixer.state).toBe('idle');
    expect((mixer.master as unknown as FakeGain).connections).toHaveLength(1); // still wired during the fade
    expect(drumDuck.connections).toHaveLength(1);
    vi.advanceTimersByTime(STOP_FADE_SEC * 1000 + 25);
    expect((mixer.master as unknown as FakeGain).connections).toHaveLength(0);
    expect(drumDuck.connections).toHaveLength(0);
    expect(ctx.sources.every((s) => s.connections.length === 0)).toBe(true);
    const idle = setup();
    idle.mixer.dispose();
    expect((idle.mixer.master as unknown as FakeGain).connections).toHaveLength(0);
  });

  it('dispose() leaves no pending retire timers behind', async () => {
    vi.useFakeTimers();
    const { ctx, mixer } = setup();
    await mixer.loadSong(manifest, '/songs');
    mixer.play();
    mixer.seek(2); // a seek while playing queues one retire timer per source
    mixer.pause();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    mixer.dispose();
    // dispose while paused runs the teardown immediately AND flushes everything still queued:
    // those timers would otherwise fire after teardown and keep the mixer + buffers reachable
    expect(vi.getTimerCount()).toBe(0);
    expect((mixer.master as unknown as FakeGain).connections).toHaveLength(0);
    expect((mixer.sfxBus as unknown as FakeGain).connections).toHaveLength(0);
    expect(ctx.sources.every((s) => s.connections.length === 0)).toBe(true);
    vi.advanceTimersByTime(1000); // nothing left to fire
    expect(vi.getTimerCount()).toBe(0);
  });

  it('createSfx() routes the cues through the master chain, not straight to the destination', () => {
    const { ctx, mixer } = setup();
    const sfx = mixer.createSfx(0.4);
    expect(sfx.volume).toBe(0.4);
    // the Sfx output bus is the newest gain node; it must land on sfxBus → master, never destination
    const out = ctx.gains[ctx.gains.length - 1];
    expect(out.connections).toEqual([mixer.sfxBus]);
    expect((mixer.sfxBus as unknown as FakeGain).connections).toEqual([mixer.master]);
    expect(ctx.destination.connections).toHaveLength(0);
    sfx.dispose();
    mixer.dispose();
  });

  it('exposes the output latency so a renderer can draw what is being heard, not what is queued', async () => {
    const { ctx, mixer } = setup();
    await mixer.loadSong(manifest, '/songs');
    const withLatency = ctx as unknown as { outputLatency?: number; baseLatency?: number };
    expect(mixer.outputLatencySec).toBe(0); // absent in this fake, as in older browsers
    withLatency.baseLatency = 0.01;
    expect(mixer.outputLatencySec).toBeCloseTo(0.01, 9); // falls back to baseLatency
    withLatency.outputLatency = 0.14; // e.g. Bluetooth headphones
    expect(mixer.outputLatencySec).toBeCloseTo(0.14, 9);
    withLatency.outputLatency = Number.NaN;
    expect(mixer.outputLatencySec).toBeCloseTo(0.01, 9); // ignores a garbage value
    withLatency.outputLatency = 0.14;
    ctx.currentTime = 5;
    const startAt = mixer.play(5.5, 2);
    expect(mixer.songTime(startAt + 1)).toBeCloseTo(3, 9); // what the graph produces (judgment uses this)
    expect(mixer.displaySongTime(startAt + 1)).toBeCloseTo(2.86, 9); // what the listener hears (draw this)
    mixer.dispose();
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

  it('seek/stop/replay while ducked restore the player stem with a ramp, never a step (click-free)', async () => {
    const { ctx, mixer } = setup();
    await mixer.loadSong(manifest, '/songs');
    ctx.currentTime = 1;
    mixer.play();
    const drumDuck = ctx.sources[0].connections[0] as FakeGain;
    ctx.currentTime = 2;
    mixer.onMiss();
    ctx.currentTime = 2.1; // the miss ramp has landed: the stem is at 0.05 and audible
    drumDuck.gain.log = [];

    mixer.seek(4); // sources fade out over STOP_FADE_SEC — restoring in one sample would click here
    expect(drumDuck.gain.log).toEqual(['cancel@2.1', 'set 0.05@2.1', `exp 1@${2.1 + STOP_FADE_SEC}`]);
    expect(mixer.getPlayerStemGain()).toBeCloseTo(0.05, 12); // anchored on the ducked value
    ctx.currentTime = 2.1 + STOP_FADE_SEC;
    expect(mixer.getPlayerStemGain()).toBe(1);

    // same on stop() and on a re-play() while ducked
    ctx.currentTime = 3;
    mixer.onMiss();
    ctx.currentTime = 3.05;
    drumDuck.gain.log = [];
    mixer.stop();
    expect(drumDuck.gain.log.slice(-1)[0]).toBe(`exp 1@${3.05 + STOP_FADE_SEC}`);
    expect(drumDuck.gain.log.some((e) => e === 'set 1@3.05')).toBe(false); // no step to 1

    // nothing audible (stopped): the hard write is fine and stays
    ctx.currentTime = 4;
    drumDuck.gain.log = [];
    mixer.play();
    expect(drumDuck.gain.log).toEqual(['cancel@4', 'set 1@4']);
  });

  it('the song↔ctx mapping stays exact and invertible after stop and after a seek while paused', async () => {
    const { ctx, mixer } = setup();
    await mixer.loadSong(manifest, '/songs');
    ctx.currentTime = 1;
    mixer.play();
    ctx.currentTime = 3;
    mixer.pause();
    ctx.currentTime = 4;
    mixer.seek(6); // seek while paused: the new position is "now"
    expect(mixer.songTime()).toBe(6);
    expect(mixer.ctxTimeForSongTime(6)).toBeCloseTo(4, 12);
    expect(mixer.ctxTimeToSongTime(4)).toBeCloseTo(6, 12);
    ctx.currentTime = 5;
    mixer.stop();
    expect(mixer.songTime()).toBe(0);
    expect(mixer.ctxTimeForSongTime(0)).toBeCloseTo(5, 12);
    expect(mixer.ctxTimeToSongTime(5.5)).toBeCloseTo(0.5, 12);
    // and after the restart the mapping is the new segment's
    ctx.currentTime = 6;
    const start = mixer.play();
    expect(mixer.ctxTimeForSongTime(0)).toBeCloseTo(start, 12);
    expect(mixer.ctxTimeForSongTime(mixer.songTime(7))).toBeCloseTo(7, 12);
  });

  it('per-stem and master gains ramp linearly and anchor on the analytic value, not param.value', async () => {
    const { ctx, mixer } = setup();
    await mixer.loadSong(manifest, '/songs');
    ctx.currentTime = 1;
    mixer.setStemGain('keys', 0.5);
    expect(mixer.getStemGain('keys')).toBe(0.5);
    mixer.setMasterGain(0.25, 0.1);
    expect(mixer.getMasterGain()).toBe(0.25);
    const master = (mixer.master as unknown as FakeGain).gain;
    expect(master.log.slice(-1)[0]).toBe('lin 0.25@1.1');
    expect(() => mixer.getStemGain('nope')).toThrow();
    // a slider drags: halfway through the 0.8 → 0.25 ramp the next ramp starts from 0.525 even
    // though the fake param already reports the ramp target (a lagging/leading `.value`)
    ctx.currentTime = 1.05;
    expect(master.value).toBe(0.25);
    mixer.setMasterGain(0.9, 0.1);
    expect(lastEvents(master.events, 3)).toEqual([['cancel', 0, 1.05], ['set', expect.closeTo(0.525, 12), 1.05], ['lin', 0.9, expect.closeTo(1.15, 12)]]);
    expect(mixer.getMasterGain()).toBe(0.9);
  });

  it('a newer loadSong supersedes an older one (aborting its downloads); dispose unloads and leaves a foreign context open', async () => {
    const { ctx, mixer, signals } = setup();
    const first = mixer.loadSong(manifest, '/songs');
    const second = mixer.loadSong({ ...manifest, id: 'song2', stems: manifest.stems.slice(0, 1) }, '/songs');
    await Promise.all([first, second]);
    expect(signals.slice(0, 3).every((s) => s.aborted)).toBe(true);
    expect(signals[3].aborted).toBe(false);
    expect(mixer.manifest?.id).toBe('song2');
    expect(mixer.stemIds).toEqual(['drums']);
    mixer.play();
    mixer.dispose();
    expect(mixer.state).toBe('idle');
    expect(mixer.isLoaded).toBe(false);
    expect(ctx.state).not.toBe('closed');
    expect(() => mixer.play()).toThrow(/no song loaded/);
  });

  it('master stage: limiter settings when on; 0.32 headroom and direct wiring when off', async () => {
    const on = setup();
    const c = on.mixer.compressor as unknown as FakeCompressor;
    expect(on.mixer.getMasterGain()).toBe(DEFAULT_MASTER_GAIN.limiter);
    expect({ threshold: c.threshold.value, knee: c.knee.value, ratio: c.ratio.value, attack: c.attack.value, release: c.release.value }).toEqual(LIMITER_SETTINGS);
    expect(c.ratio.value).toBeGreaterThanOrEqual(10); // limiter, not a program compressor
    expect(c.release.value).toBeLessThanOrEqual(0.05);
    expect(on.mixer.output).toBe(on.mixer.compressor);

    const off = setup({ compressor: false });
    expect(off.mixer.getMasterGain()).toBe(DEFAULT_MASTER_GAIN.none);
    // headroom for stems (2.28 with the streak boost) + the loudest SFX cue at full slider (0.62)
    expect(DEFAULT_MASTER_GAIN.none).toBe(0.32);
    expect(off.mixer.output).toBe(off.mixer.master);
    await off.mixer.loadSong(manifest, '/songs');
    off.mixer.play();
    // every stem: source → duck → volume → transport → master → destination (nothing else in the path)
    expect(off.ctx.sources).toHaveLength(3);
    for (const src of off.ctx.sources) {
      const duck = src.connections[0] as FakeGain;
      const volume = duck.connections[0] as FakeGain;
      expect(src.connections).toHaveLength(1);
      expect(duck.connections).toEqual([volume]);
      expect(volume.connections).toEqual([off.mixer.transport]);
    }
    expect((off.mixer.transport as unknown as FakeGain).connections).toEqual([off.mixer.master]);
    // the SFX bus joins the master AFTER the transport (cues are not faded by pause/seek) and
    // BEFORE the master gain/limiter (so they share the song's headroom instead of clipping past it)
    expect((off.mixer.sfxBus as unknown as FakeGain).connections).toEqual([off.mixer.master]);
    expect((off.mixer.master as unknown as FakeGain).connections).toEqual([off.ctx.destination]);
    expect(new StemMixer({ ctx: off.ctx as unknown as AudioContext, compressor: false, masterGain: 0.9 }).getMasterGain()).toBe(0.9);
  });

  it('playPreview starts at previewStart, fades out over the last second and stops itself', async () => {
    const { ctx, mixer } = setup();
    await mixer.loadSong(manifest, '/songs');
    vi.useFakeTimers();
    ctx.currentTime = 0;
    const start = mixer.playPreview(2, 0.5);
    expect(start).toBeCloseTo(0.03, 9);
    expect(mixer.state).toBe('playing');
    for (const s of ctx.sources) expect(s.started).toEqual({ when: start, offset: 3 });
    const ev = transportEvents(mixer);
    expect(ev.slice(-2)).toEqual([['set', 1, expect.closeTo(start + 1.5, 9)], ['exp', MIN_GAIN, expect.closeTo(start + 2, 9)]]);
    vi.advanceTimersByTime(2100);
    expect(mixer.state).toBe('ready');
    expect(ctx.sources.every((s) => s.stopped)).toBe(true);
    // an explicit start/length is honoured and a transport call cancels the timer
    ctx.currentTime = 5;
    mixer.playPreview(4, 1, 6);
    expect(ctx.sources[ctx.sources.length - 1].started?.offset).toBe(6);
    mixer.pause();
    vi.advanceTimersByTime(5000);
    expect(mixer.state).toBe('paused');
  });

  it('reports byte progress from a streamed body with Content-Length and honours an abort', async () => {
    const body = new Uint8Array(1000).fill(7);
    const chunks = [body.subarray(0, 300), body.subarray(300, 650), body.subarray(650)];
    const mkStream = () => new ReadableStream<Uint8Array>({
      start(controller) { for (const c of chunks) controller.enqueue(c); controller.close(); },
    });
    const res = new Response(mkStream(), { status: 200, headers: { 'content-length': '1000' } });
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

    // aborting mid-stream rejects with an AbortError
    const ac = new AbortController();
    const res2 = new Response(mkStream(), { status: 200, headers: { 'content-length': '1000' } });
    const p = readBodyWithProgress(res2, (r) => { if (r >= 300) ac.abort(); }, ac.signal);
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('readBodyWithProgress fills one preallocated buffer, and still copes when Content-Length lies', async () => {
    const chunksOf = (n: number, cut: number[]) => {
      const body = new Uint8Array(n);
      for (let i = 0; i < n; i++) body[i] = i % 251;
      return [0, ...cut].map((s, i) => body.subarray(s, cut[i] ?? n));
    };
    const stream = (cs: Uint8Array[]) => new ReadableStream<Uint8Array>({
      start(c) { for (const x of cs) c.enqueue(x); c.close(); },
    });
    const check = (data: ArrayBuffer, n: number) => {
      const v = new Uint8Array(data);
      expect(v.byteLength).toBe(n);
      for (let i = 0; i < n; i++) expect(v[i]).toBe(i % 251);
    };
    // exact Content-Length: the common case, written straight into the final buffer
    check(await readBodyWithProgress(new Response(stream(chunksOf(1000, [300, 650])), { headers: { 'content-length': '1000' } }), () => {}), 1000);
    // body SHORTER than announced (truncated response): the result is trimmed to what arrived
    check(await readBodyWithProgress(new Response(stream(chunksOf(400, [150])), { headers: { 'content-length': '1000' } }), () => {}), 400);
    // body LONGER than announced (e.g. a proxy rewriting the header): falls back to joining chunks
    check(await readBodyWithProgress(new Response(stream(chunksOf(1500, [300, 900])), { headers: { 'content-length': '1000' } }), () => {}), 1500);
    // no Content-Length at all: chunk list, as before
    check(await readBodyWithProgress(new Response(stream(chunksOf(700, [200]))), () => {}), 700);
  });

  it('readBodyWithProgress releases the stream on abort and on a mid-stream failure', async () => {
    // The reader holds the socket; loadSong aborts its SIBLING downloads on a failure but nothing
    // else releases the stream that threw, so it must cancel itself.
    const mkBody = (fail: boolean) => {
      let cancelled = 0;
      const body = {
        getReader() {
          let n = 0;
          return {
            async read() {
              if (fail && n === 2) throw new Error('network reset');
              return n++ < 4 ? { done: false, value: new Uint8Array(100) } : { done: true, value: undefined };
            },
            async cancel() { cancelled++; },
          };
        },
      };
      const res = { body, headers: new Headers({ 'content-length': '400' }) } as unknown as Response;
      return { res, cancelled: () => cancelled };
    };

    const failing = mkBody(true);
    await expect(readBodyWithProgress(failing.res, () => {})).rejects.toThrow(/network reset/);
    expect(failing.cancelled()).toBe(1);

    const aborting = mkBody(false);
    const ac = new AbortController();
    await expect(readBodyWithProgress(aborting.res, (r) => { if (r >= 200) ac.abort(); }, ac.signal))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(aborting.cancelled()).toBeGreaterThanOrEqual(1);

    // a body that completes normally is NOT cancelled (that would be a spurious stream error)
    const ok = mkBody(false);
    expect((await readBodyWithProgress(ok.res, () => {})).byteLength).toBe(400);
    expect(ok.cancelled()).toBe(0);
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

  it('play() never starts a silent song: the end is reached by seek(), and an explicit past-the-end offset throws', async () => {
    const { ctx, mixer } = setup();
    await mixer.loadSong(manifest, '/songs');
    let ended = 0;
    mixer.onEnded(() => ended++);
    ctx.currentTime = 1;
    mixer.play(1.5);
    expect(mixer.seek(mixer.getDuration())).toBeNull(); // seek to the very end while playing: no restart
    expect(mixer.state).toBe('ended');
    expect(ended).toBe(1);
    expect(mixer.getSongTime()).toBe(10);
    ctx.currentTime = 50;
    expect(mixer.getSongTime()).toBe(10); // does not run past the duration
    expect(ctx.sources.filter((s) => s.started && !s.stopped)).toHaveLength(0);

    // An explicit offset past the end is a programming error, NOT a silent start: the engine
    // clock must never be started on a song that never sounds (`engine.start(mixer.play())`).
    expect(() => mixer.play(undefined, 999)).toThrow(/at\/after the end/);
    expect(() => mixer.play(undefined, Number.NaN)).toThrow(/finite/);
    expect(ended).toBe(1);
    expect(mixer.state).toBe('ended'); // the failed call changed nothing

    // playing again after 'ended' restarts from 0 (and so does a position parked at the end)
    mixer.play();
    expect(mixer.state).toBe('playing');
    expect(ctx.sources[ctx.sources.length - 1].started?.offset).toBe(0);
    mixer.stop();
    mixer.seek(999); // clamped to the duration while stopped
    expect(mixer.getSongTime()).toBe(10);
    mixer.play();
    expect(mixer.state).toBe('playing');
    expect(ctx.sources[ctx.sources.length - 1].started?.offset).toBe(0);
  });

  it('loadSong rejects a manifest whose playerStem is not a stem before touching the mixer', async () => {
    const { mixer } = setup();
    await mixer.loadSong(manifest, '/songs');
    await expect(mixer.loadSong({ ...manifest, playerStem: 'vocals' }, '/songs')).rejects.toThrow(/playerStem "vocals" is not one of the stems/);
    // the previously loaded song is untouched: no half-loaded 'ready' mixer with a dead
    // duck controller (onHit/onMiss silently doing nothing for the rest of the session)
    expect(mixer.state).toBe('ready');
    expect(mixer.playerStem).toBe('drums');
    expect(mixer.stemIds).toEqual(['drums', 'bass', 'keys']);
    mixer.onMiss();
    expect(mixer.isDucked).toBe(true);
    await expect(mixer.loadSong({ ...manifest, stems: [] }, '/songs')).rejects.toThrow(/no stems/);
    await expect(mixer.loadSong({ ...manifest, stems: [manifest.stems[0], manifest.stems[0]] }, '/songs')).rejects.toThrow(/unique/);
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

  it('accepts a manifest whose previewStart is absent (preview from 0)', async () => {
    const { ctx, mixer } = setup();
    const m: SongManifest = { ...manifest, previewStart: undefined };
    await mixer.loadSong(m, '/songs');
    vi.useFakeTimers();
    mixer.playPreview(1, 0.2);
    expect(ctx.sources[0].started?.offset).toBe(0);
  });
});
