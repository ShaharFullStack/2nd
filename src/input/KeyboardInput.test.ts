import { describe, expect, it } from 'vitest';
import { KeyboardInput } from './KeyboardInput.ts';
import type { LaneInputEvent } from './types.ts';

describe('KeyboardInput', () => {
  it('maps 1-4 and D F J K to lanes with ctxTime from the clock, ignoring repeats', async () => {
    const clock = { currentTime: 3.25 };
    const target = new EventTarget();
    const input = new KeyboardInput({ audioContext: clock, target });
    const events: LaneInputEvent[] = [];
    input.onEvent((e) => events.push(e));
    target.dispatchEvent(new KeyboardEvent('keydown', { key: '1' })); // not started yet
    await input.start();
    for (const key of ['1', 'f', 'J', '4']) target.dispatchEvent(new KeyboardEvent('keydown', { key }));
    expect(events.map((e) => e.lane)).toEqual([0, 1, 2, 3]);
    expect(events.every((e) => e.ctxTime === 3.25 && e.strength === 1)).toBe(true);
    expect(input.getLaneStates().map((s) => s.value)).toEqual([1, 1, 1, 1]);
    target.dispatchEvent(new KeyboardEvent('keydown', { key: '1', repeat: true }));
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'd' })); // still held
    expect(events).toHaveLength(4);
    target.dispatchEvent(new KeyboardEvent('keyup', { key: 'd' }));
    expect(input.getLaneStates()[0]).toEqual({ lane: 0, value: 0, armed: true, tracking: true });
    clock.currentTime = 4;
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'd' }));
    expect(events[4]).toEqual({ lane: 0, ctxTime: 4, strength: 1 });
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'x' }));
    expect(events).toHaveLength(5);
    input.stop();
    target.dispatchEvent(new KeyboardEvent('keydown', { key: '2' }));
    expect(events).toHaveLength(5);
  });

  it('respects the lane count and supports programmatic presses', async () => {
    const input = new KeyboardInput({ audioContext: { currentTime: 1 }, lanes: 2, target: new EventTarget() });
    const events: LaneInputEvent[] = [];
    input.onEvent((e) => events.push(e));
    await input.start();
    expect(input.laneForKey('3')).toBeUndefined();
    input.press(1, 7.5, 0.8);
    input.press(2);
    expect(events).toEqual([{ lane: 1, ctxTime: 7.5, strength: 0.8 }]);
    expect(input.getLaneStates()).toHaveLength(2);
  });
});
