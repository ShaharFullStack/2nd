import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_PROGRAMMATIC_HOLD_SEC, KeyboardInput, isEditableTarget } from './KeyboardInput.ts';

class FakeClock {
  currentTime = 0;
}
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
    expect(input.getLaneStates()[0]).toEqual({ lane: 0, value: 0, armed: true, triggerState: 'armed', tracking: true });
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

  it('releases held lanes on blur / visibilitychange, so a lost keyup cannot kill a lane', async () => {
    // Alt-tab (or a browser dialog, or a screen lock) while D is down: the keyup never arrives, and the
    // `held[lane]` guard used to make lane 0 dead for the rest of the session.
    const target = new EventTarget();
    const blur = new EventTarget();
    const input = new KeyboardInput({ audioContext: { currentTime: 1 }, target, blurTargets: [blur] });
    const events: LaneInputEvent[] = [];
    input.onEvent((e) => events.push(e));
    await input.start();
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'd' }));
    expect(input.isHeld(0)).toBe(true);
    blur.dispatchEvent(new Event('blur')); // focus lost; the keyup for 'd' will never come
    expect(input.isHeld(0)).toBe(false);
    expect(input.getLaneStates()[0]).toMatchObject({ value: 0, armed: true });
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'd' }));
    expect(events).toHaveLength(2); // the lane still works
    blur.dispatchEvent(new Event('visibilitychange'));
    expect(input.isHeld(0)).toBe(false);
    input.stop();
    // Listeners are removed on stop: a later blur cannot touch a restarted session's state.
    blur.dispatchEvent(new Event('blur'));
  });

  it('ignores keys typed into a text field, and modifier shortcuts', async () => {
    const target = new EventTarget();
    const input = new KeyboardInput({ audioContext: { currentTime: 1 }, target });
    const events: LaneInputEvent[] = [];
    input.onEvent((e) => events.push(e));
    await input.start();
    const field = document.createElement('input');
    let prevented = 0;
    const typed = new KeyboardEvent('keydown', { key: 'd', cancelable: true });
    Object.defineProperty(typed, 'target', { value: field });
    Object.defineProperty(typed, 'preventDefault', { value: () => { prevented++; } });
    target.dispatchEvent(typed);
    expect(events).toHaveLength(0);
    expect(prevented).toBe(0); // the character reaches the field
    expect(input.isHeld(0)).toBe(false);

    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true })); // Ctrl+F = find
    target.dispatchEvent(new KeyboardEvent('keydown', { key: '1', metaKey: true })); // Cmd+1 = tab 1
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', altKey: true }));
    expect(events).toHaveLength(0);
    // ... and the plain key still plays.
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'f' }));
    expect(events.map((e) => e.lane)).toEqual([1]);
  });

  it('always processes keyup, even one a keydown guard would have rejected', async () => {
    const target = new EventTarget();
    const input = new KeyboardInput({ audioContext: { currentTime: 1 }, target });
    await input.start();
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'j' }));
    expect(input.isHeld(2)).toBe(true);
    // The user grabs Ctrl before letting go: the keyup carries the modifier. Dropping it would strand
    // the lane exactly the way the missing blur handler did.
    target.dispatchEvent(new KeyboardEvent('keyup', { key: 'j', ctrlKey: true }));
    expect(input.isHeld(2)).toBe(false);
  });

  it('isEditableTarget recognises inputs, contenteditable and textbox roles', () => {
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget(document.createElement('div'))).toBe(false);
    expect(isEditableTarget(document.createElement('input'))).toBe(true);
    expect(isEditableTarget(document.createElement('textarea'))).toBe(true);
    const div = document.createElement('div');
    div.setAttribute('role', 'textbox');
    expect(isEditableTarget(div)).toBe(true);
  });
});

describe('KeyboardInput.press() cannot strand a lane', () => {
  it('auto-releases so a later keydown in the same lane still fires', async () => {
    vi.useFakeTimers();
    try {
      const target = new EventTarget();
      const input = new KeyboardInput({ audioContext: new FakeClock(), target, blurTargets: [] });
      const events: LaneInputEvent[] = [];
      input.onEvent((e) => events.push(e));
      await input.start();
      // A critic taps a lane and never calls release() — this used to kill the lane for the session.
      input.press(1);
      expect(input.isHeld(1)).toBe(true);
      expect(input.getLaneStates()[1]).toMatchObject({ value: 1, armed: false });
      vi.advanceTimersByTime(DEFAULT_PROGRAMMATIC_HOLD_SEC * 1000 + 1);
      expect(input.isHeld(1)).toBe(false);
      expect(input.getLaneStates()[1]).toMatchObject({ value: 0, armed: true });
      // …and the lane is alive: a real key press is accepted again.
      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'f' }));
      expect(events.filter((e) => e.lane === 1)).toHaveLength(2);
      input.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('holdSec 0 never leaves the lane held at all', async () => {
    const target = new EventTarget();
    const input = new KeyboardInput({ audioContext: new FakeClock(), target, blurTargets: [] });
    const events: LaneInputEvent[] = [];
    input.onEvent((e) => events.push(e));
    await input.start();
    input.press(0, 4, 1, { holdSec: 0 });
    expect(events).toHaveLength(1);
    expect(input.isHeld(0)).toBe(false);
    input.stop();
  });

  it('an explicit release still wins over the pending timer', async () => {
    vi.useFakeTimers();
    try {
      const target = new EventTarget();
      const input = new KeyboardInput({ audioContext: new FakeClock(), target, blurTargets: [] });
      await input.start();
      input.press(2, 0, 1, { holdSec: 5 });
      input.release(2);
      expect(input.isHeld(2)).toBe(false);
      vi.advanceTimersByTime(6000);
      // The lane was pressed again in the meantime: the stale timer must not release the new press.
      input.press(2, 0, 1, { holdSec: 5 });
      expect(input.isHeld(2)).toBe(true);
      input.stop();
      expect(input.isHeld(2)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
