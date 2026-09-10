/**
 * The getLaneStates() ALIASING CONTRACT (src/input/types.ts) holds for EVERY InputSource, not just
 * VisionInput. A HUD written against VisionInput's memoized meters — identity bail-outs, a React
 * useSyncExternalStore snapshot, a memo keyed on the object — re-rendered on every poll under
 * `?input=keyboard` and `?autoplay=1`, which are exactly the configurations the dev screenshots and the
 * critic harness run in, so the regression would only ever appear where nobody was looking.
 */
import { describe, expect, it } from 'vitest';
import { KeyboardInput } from './KeyboardInput.ts';
import { ReplayInput } from './ReplayInput.ts';
import { AutoplayInput } from './AutoplayInput.ts';

class FakeClock { currentTime = 0; }

class FakeSongClock {
  private readonly clock: FakeClock;
  constructor(clock: FakeClock) { this.clock = clock; }
  songTime(nowCtx: number = this.clock.currentTime): number { return nowCtx; }
  ctxTimeForSongTime(songTime: number): number { return songTime; }
}

describe('KeyboardInput.getLaneStates honours the aliasing contract', () => {
  it('returns the SAME objects until a lane actually changes', () => {
    const clock = new FakeClock();
    const input = new KeyboardInput({ audioContext: clock, lanes: 4 });
    const a = input.getLaneStates();
    expect(input.getLaneStates()).toBe(a);
    expect(a[0]).toBe(input.getLaneStates()[0]);

    input.press(1, 0);
    const b = input.getLaneStates();
    expect(b).not.toBe(a);
    expect(b[1]).toMatchObject({ lane: 1, value: 1, armed: false });
    expect(input.getLaneStates()).toBe(b);

    input.release(1);
    const c = input.getLaneStates();
    expect(c).not.toBe(b);
    expect(c[1]).toMatchObject({ lane: 1, value: 0, armed: true });
  });

  it('the shared meters are frozen, so a stray write throws instead of corrupting them', () => {
    const input = new KeyboardInput({ audioContext: new FakeClock(), lanes: 2 });
    const states = input.getLaneStates();
    expect(Object.isFrozen(states[0])).toBe(true);
    expect(() => { (states[0] as { value: number }).value = 0.5; }).toThrow();
  });
});

describe('ReplayInput / AutoplayInput.getLaneStates honour the aliasing contract', () => {
  it('returns the same objects while the lit set is unchanged, and new ones when it changes', async () => {
    const clock = new FakeClock();
    const input = new ReplayInput({
      events: [{ lane: 2, songTime: 1, strength: 1 }],
      audioContext: clock, songClock: new FakeSongClock(clock), lanes: 4, holdSec: 0.1, autoTick: false,
    });
    await input.start();
    const idle = input.getLaneStates();
    clock.currentTime = 0.5;
    expect(input.getLaneStates()).toBe(idle); // polled at 60 Hz between events: no churn

    clock.currentTime = 1;
    input.tick();
    const lit = input.getLaneStates();
    expect(lit).not.toBe(idle);
    expect(lit[2]).toMatchObject({ lane: 2, value: 1, armed: false });
    expect(input.getLaneStates()).toBe(lit);

    clock.currentTime = 1.5; // the hold expired
    const after = input.getLaneStates();
    expect(after).not.toBe(lit);
    expect(after[2]).toMatchObject({ value: 0, armed: true });
  });

  it('autoplay (the screenshot path) inherits it', async () => {
    const clock = new FakeClock();
    const input = new AutoplayInput({
      chart: { notes: [{ id: 1, lane: 0, time: 1 }], lanes: 4 },
      audioContext: clock, songClock: new FakeSongClock(clock), autoTick: false,
    });
    await input.start();
    const a = input.getLaneStates();
    for (let i = 0; i < 10; i++) clock.currentTime += 1 / 60;
    expect(input.getLaneStates()).toBe(a);
  });
});
