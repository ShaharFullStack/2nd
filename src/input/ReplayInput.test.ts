import { describe, expect, it } from 'vitest';
import { SongClock } from '../engine/scheduler.ts';
import { ReplayInput } from './ReplayInput.ts';
import { AutoplayInput, autoplayEvents } from './AutoplayInput.ts';
import type { LaneInputEvent } from './types.ts';
import type { Note } from '../engine/types.ts';

describe('ReplayInput', () => {
  it('emits scripted events when the song clock passes them, with exact ctx times', async () => {
    const clock = { currentTime: 5 };
    const song = new SongClock(clock);
    song.start(5); // song time 0 at ctx 5
    const input = new ReplayInput({
      events: [{ lane: 2, songTime: 1.0 }, { lane: 0, songTime: 0.5, strength: 0.7 }, { lane: 1, songTime: 2.0 }],
      audioContext: clock, songClock: song, autoTick: false,
    });
    const events: LaneInputEvent[] = [];
    input.onEvent((e) => events.push(e));
    expect(input.tick()).toEqual([]); // not started
    await input.start();
    expect(input.tick()).toEqual([]);
    clock.currentTime = 5.4;
    expect(input.tick()).toEqual([]);
    clock.currentTime = 6.013;
    const out = input.tick();
    expect(out).toEqual([{ lane: 0, ctxTime: 5.5, strength: 0.7 }, { lane: 2, ctxTime: 6.0, strength: 1 }]);
    expect(input.pending()).toBe(1);
    expect(input.getLaneStates()[2].value).toBe(1);
    expect(input.getLaneStates()[1].value).toBe(0);
    clock.currentTime = 9;
    input.tick();
    expect(events.map((e) => e.lane)).toEqual([0, 2, 1]);
    expect(input.pending()).toBe(0);
    input.reset();
    expect(input.pending()).toBe(3);
    input.stop();
  });

  it('auto-ticks with setInterval when started', async () => {
    const clock = { currentTime: 0 };
    const song = new SongClock(clock);
    song.start(0);
    const input = new ReplayInput({ events: [{ lane: 0, songTime: 0.01 }], audioContext: clock, songClock: song, tickMs: 1 });
    const events: LaneInputEvent[] = [];
    input.onEvent((e) => events.push(e));
    await input.start();
    clock.currentTime = 0.05;
    await new Promise((r) => setTimeout(r, 30));
    input.stop();
    expect(events).toHaveLength(1);
  });
});

describe('AutoplayInput', () => {
  const notes: Note[] = Array.from({ length: 20 }, (_, i) => ({ id: i, lane: i % 4, time: 1 + i * 0.5 }));

  it('hits every note exactly on time by default', async () => {
    const clock = { currentTime: 10 };
    const song = new SongClock(clock);
    song.start(10);
    const input = new AutoplayInput({ chart: { notes, lanes: 4 }, audioContext: clock, songClock: song, autoTick: false });
    const events: LaneInputEvent[] = [];
    input.onEvent((e) => events.push(e));
    await input.start();
    clock.currentTime = 100;
    input.tick();
    expect(events).toHaveLength(20);
    events.forEach((e, i) => {
      expect(e.lane).toBe(notes[i].lane);
      expect(e.ctxTime).toBeCloseTo(10 + notes[i].time, 9);
    });
  });

  it('jitter and hitFraction are deterministic per seed', () => {
    const a = autoplayEvents(notes, { jitterMs: 40, hitFraction: 0.7, seed: 42 });
    const b = autoplayEvents(notes, { jitterMs: 40, hitFraction: 0.7, seed: 42 });
    const c = autoplayEvents(notes, { jitterMs: 40, hitFraction: 0.7, seed: 43 });
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
    expect(a.length).toBeLessThan(20);
    expect(a.length).toBeGreaterThan(5);
    const noteTimes = new Set(notes.map((n) => n.time));
    for (const e of a) {
      const nearest = [...noteTimes].reduce((best, t) => (Math.abs(t - e.songTime) < Math.abs(best - e.songTime) ? t : best));
      expect(Math.abs(e.songTime - nearest)).toBeLessThanOrEqual(0.04 + 1e-9);
    }
    const shifted = autoplayEvents(notes, { offsetSec: 0.1 });
    expect(shifted[0].songTime).toBeCloseTo(1.1);
  });

});

describe('ReplayInput timing guarantee', () => {
  it('can seek past a backlog instead of dumping it, and can drop stale events', async () => {
    const clock = { currentTime: 100.03 };
    const song = new SongClock(clock);
    song.start(40); // song time 0 at ctx 40, so the song is already 60 s in
    const events = [0.5, 1, 30, 60.02, 61].map((songTime, i) => ({ lane: i % 4, songTime }));

    // (1) A critic starting mid-song seeks: the past events are dropped WITHOUT being emitted.
    const seeker = new ReplayInput({ events, audioContext: clock, songClock: song, autoTick: false });
    const got: LaneInputEvent[] = [];
    seeker.onEvent((e) => got.push(e));
    await seeker.start();
    expect(seeker.seek(60)).toBe(3);
    expect(seeker.tick()).toHaveLength(1); // only the 60.02 event, which is genuinely due
    expect(got[0].ctxTime).toBeCloseTo(100.02, 9);

    // (2) Without a seek, a late first tick flushes the whole backlog with ctxTimes in the past...
    const naive = new ReplayInput({ events, audioContext: clock, songClock: song, autoTick: false });
    await naive.start();
    const burst = naive.tick();
    expect(burst).toHaveLength(4);
    expect(burst[0].ctxTime).toBeLessThan(clock.currentTime - 1); // dated a minute ago

    // (3) ...unless dropStaleSec is set, which is the documented way to keep the timing guarantee.
    const strict = new ReplayInput({ events, audioContext: clock, songClock: song, autoTick: false, dropStaleSec: 0.2 });
    await strict.start();
    const kept = strict.tick();
    expect(kept.map((e) => e.lane)).toEqual([3]); // only the 60.02 s event is still fresh
    expect(strict.skipped()).toBe(3);
  });
});
