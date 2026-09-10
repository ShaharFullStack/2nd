/**
 * The Setup screen's "listen, then start" flow, end to end on the transport.
 *
 * THE BUG THIS GUARDS. A song-select preview starts the mixer at `manifest.previewStart` (30 s into
 * the song). The Play screen then starts the session with an IMPLICIT `mixer.play(atCtxTime)` — it
 * gives a start time but no position, because the position is supposed to be the top of the song —
 * and drives the engine clock from `mixer.getSongStartCtxTime()`. If the preview were allowed to
 * leave the transport parked where it was auditioned, that whole session would play the chart from
 * bar 1 against audio 30 s in: every note judged against the wrong part of the song, for a patient
 * whose hit windows are ±70 ms.
 *
 * StemMixer holds the pre-preview position aside and restores it on EVERY path out of a preview.
 * These tests exercise all four paths the UI can produce — the audition still running, the audition
 * expired on its own timer, the therapist pressing Stop, and auditioning a second song first — and
 * assert the same thing each time: the session starts at song time 0, and every stem source is
 * started at buffer offset 0.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_START_LEAD_SEC, StemMixer } from '../audio/StemMixer.ts';
import { parseManifest } from '../audio/manifest.ts';
import type { FetchLike } from '../audio/manifest.ts';

// ---------------------------------------------------------------- minimal fake Web Audio

class FakeParam {
  value: number;
  constructor(v: number) { this.value = v; }
  cancelScheduledValues() { return this; }
  setValueAtTime(v: number) { this.value = v; return this; }
  linearRampToValueAtTime(v: number) { this.value = v; return this; }
  exponentialRampToValueAtTime(v: number) { this.value = v; return this; }
}
class FakeNode {
  connections: FakeNode[] = [];
  connect(n: FakeNode) { this.connections.push(n); return n; }
  disconnect() { this.connections = []; }
}
class FakeGain extends FakeNode { gain = new FakeParam(1); }
class FakeCompressor extends FakeNode {
  threshold = new FakeParam(-24); knee = new FakeParam(30); ratio = new FakeParam(12);
  attack = new FakeParam(0.003); release = new FakeParam(0.25);
}
class FakeBuffer { duration: number; constructor(d: number) { this.duration = d; } }
class FakeSource extends FakeNode {
  buffer: FakeBuffer | null = null;
  started: { when: number; offset: number } | null = null;
  stopped = false;
  onended: (() => void) | null = null;
  start(when: number, offset: number) { this.started = { when, offset }; }
  stop() { this.stopped = true; }
}
class FakeContext {
  currentTime = 0;
  sampleRate = 48000;
  state: 'suspended' | 'running' | 'closed' = 'suspended';
  destination = new FakeNode();
  sources: FakeSource[] = [];
  createGain() { return new FakeGain(); }
  createDynamicsCompressor() { return new FakeCompressor(); }
  createBufferSource() { const s = new FakeSource(); this.sources.push(s); return s; }
  async decodeAudioData() { return new FakeBuffer(120) as unknown as AudioBuffer; }
  async resume() { this.state = 'running'; }
  async close() { this.state = 'closed'; }
}

const MANIFEST = parseManifest({
  id: 'demo-groove', title: 'Demo Groove', artist: 'A', license: 'CC0 1.0',
  bpm: 120, offset: 0, durationSec: 120, previewStart: 30,
  stems: [{ id: 'drums', file: 'stems/drums.wav' }, { id: 'bass', file: 'stems/bass.wav' }],
  playerStem: 'drums',
});

async function setup() {
  const ctx = new FakeContext();
  const fetch: FetchLike = (url) => Promise.resolve(new Response(url, { status: 200 }));
  const mixer = new StemMixer({ ctx: ctx as unknown as AudioContext, fetch, startLeadSec: DEFAULT_START_LEAD_SEC });
  await mixer.loadSong(MANIFEST, '/songs');
  return { ctx, mixer };
}

/** Exactly what GameRunner.start() does: an implicit play at a lead, then the engine reads song 0. */
function startSession(ctx: FakeContext, mixer: StemMixer): { startCtx: number; songStartCtx: number } {
  const startCtx = mixer.play(ctx.currentTime + DEFAULT_START_LEAD_SEC);
  return { startCtx, songStartCtx: mixer.getSongStartCtxTime() };
}

/** Every stem source created by the LAST play() call, in creation order. */
function newestSources(ctx: FakeContext, count: number): FakeSource[] {
  return ctx.sources.slice(-count);
}

afterEach(() => { vi.useRealTimers(); });

describe('song audition → start session', () => {
  it('auditions from the manifest previewStart, not from the top', async () => {
    const { ctx, mixer } = await setup();
    mixer.playPreview(12, 1);
    expect(mixer.isPreviewing).toBe(true);
    // The sources for the audition are cued 30 s into the buffers.
    for (const s of newestSources(ctx, 2)) expect(s.started?.offset).toBeCloseTo(30, 6);
  });

  it('starts the session at song time 0 while an audition is still playing', async () => {
    const { ctx, mixer } = await setup();
    mixer.playPreview(12, 1);
    ctx.currentTime += 3; // the therapist listens for three seconds and presses Start

    const { startCtx, songStartCtx } = startSession(ctx, mixer);

    expect(mixer.isPreviewing).toBe(false);
    // song time 0 happens exactly when the audio starts — the engine clock and the audio agree.
    expect(songStartCtx).toBeCloseTo(startCtx, 9);
    expect(mixer.songTime(startCtx)).toBeCloseTo(0, 9);
    for (const s of newestSources(ctx, 2)) expect(s.started?.offset).toBeCloseTo(0, 9);
  });

  it('starts the session at song time 0 after the audition has expired on its own timer', async () => {
    vi.useFakeTimers();
    const ctx = new FakeContext();
    const fetch: FetchLike = (url) => Promise.resolve(new Response(url, { status: 200 }));
    const mixer = new StemMixer({ ctx: ctx as unknown as AudioContext, fetch, startLeadSec: DEFAULT_START_LEAD_SEC });
    await mixer.loadSong(MANIFEST, '/songs');

    mixer.playPreview(2, 0.5);
    ctx.currentTime += 5; // the audition's window has passed on the audio clock…
    vi.advanceTimersByTime(6000); // …and its auto-stop timer fires
    expect(mixer.isPreviewing).toBe(false);
    expect(mixer.songTime()).toBeCloseTo(0, 9); // parked back at the top, not at 30 s

    const { startCtx, songStartCtx } = startSession(ctx, mixer);
    expect(songStartCtx).toBeCloseTo(startCtx, 9);
    expect(mixer.songTime(startCtx)).toBeCloseTo(0, 9);
    for (const s of newestSources(ctx, 2)) expect(s.started?.offset).toBeCloseTo(0, 9);
  });

  it('starts the session at song time 0 after the therapist stops the audition by hand', async () => {
    const { ctx, mixer } = await setup();
    mixer.playPreview(12, 1);
    ctx.currentTime += 2;
    expect(mixer.pause()).toBeNull(); // pause() ENDS an audition rather than parking inside it
    expect(mixer.isPreviewing).toBe(false);
    expect(mixer.songTime()).toBeCloseTo(0, 9);

    const { startCtx, songStartCtx } = startSession(ctx, mixer);
    expect(songStartCtx).toBeCloseTo(startCtx, 9);
    expect(mixer.songTime(startCtx)).toBeCloseTo(0, 9);
  });

  it('starts at song time 0 after auditioning two spots in a row', async () => {
    const { ctx, mixer } = await setup();
    mixer.playPreview(12, 1);          // previewStart
    ctx.currentTime += 1;
    mixer.playPreview(12, 1, 75);      // the therapist skips to the chorus
    ctx.currentTime += 1;
    expect(mixer.isPreviewing).toBe(true);

    const { startCtx, songStartCtx } = startSession(ctx, mixer);
    expect(songStartCtx).toBeCloseTo(startCtx, 9);
    expect(mixer.songTime(startCtx)).toBeCloseTo(0, 9);
    for (const s of newestSources(ctx, 2)) expect(s.started?.offset).toBeCloseTo(0, 9);
  });

  it('an audition that runs into the end of the song does not end the SESSION', async () => {
    vi.useFakeTimers();
    const ctx = new FakeContext();
    const fetch: FetchLike = (url) => Promise.resolve(new Response(url, { status: 200 }));
    const mixer = new StemMixer({ ctx: ctx as unknown as AudioContext, fetch, startLeadSec: DEFAULT_START_LEAD_SEC });
    await mixer.loadSong(MANIFEST, '/songs');
    const ended = vi.fn();
    mixer.onEnded(ended);

    mixer.playPreview(12, 1, 119); // one second of song left
    ctx.currentTime += 4;
    vi.advanceTimersByTime(5000);

    // The Results screen must NOT open because a song preview reached the end of the stems.
    expect(ended).not.toHaveBeenCalled();
    expect(mixer.isPreviewing).toBe(false);
    expect(mixer.songTime()).toBeCloseTo(0, 9);
  });
});
