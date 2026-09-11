/**
 * ONE VOICE: the picture-in-picture lane meters must say what the receptor row says, at the same
 * instant, in the same four mark sets.
 *
 * These are the second live meter in the patient's field of view, 300 px from the first. The round-5
 * critic found them driven from a single-frame `receptorLookInto` with no `ReceptorHistory`, so on
 * the frame the patient reached their target the bar went straight to the grey "lower to reset"
 * look while the receptor threw the full 0.45 s goal celebration. This file drives the component
 * the way the input layer really publishes and asserts the four states on the DOM it produces.
 *
 * AND THE PREMISE OF ITS FIRST DRAFT WAS WRONG, WHICH IS WHY IT PASSED OVER A BROKEN PRODUCT.
 * `VisionShapedSource` below was commented "the shape EVERY source in this repo publishes" and every
 * crossing in the suite happened within ~17 ms of the previous state change. The scripted sources —
 * keyboard, replay, autoplay — do the opposite: `LaneStateCache` returns the SAME frozen objects for
 * as long as the held bitmask is unchanged (src/input/laneStates.ts), which for a patient at rest is
 * the whole gap between two reps, and the receptor's crossing latch used to expire its evidence on
 * exactly that silence. So the goal cue was unreachable after 0.5 s of rest on the very path
 * `CameraFallback` hands a patient when the camera fails — while this suite was green. Two source
 * shapes are therefore driven here, and the scripted one is the REAL `KeyboardInput`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { KeyboardInput } from '../input/KeyboardInput.ts';
import type { InputSource, LaneInputEvent, LaneState, VisionStatus } from '../input/types.ts';
import { DEFAULT_REARM_FRACTION, emptyReceptorLook, type ReceptorLook } from '../render/receptor.ts';
import { getPalette, laneColor, laneLabel } from '../render/palette.ts';
import type { LaneSpec } from '../engine/types.ts';
import { LaneMeters, faultedLanes } from './Play.tsx';

const THRESHOLD = 0.6;

/**
 * The VISION shape: fresh frozen objects per processed frame, memoized between polls. NOT the shape
 * the scripted sources publish — see the file header, and the KeyboardInput tests below.
 */
class VisionShapedSource implements InputSource {
  private states: LaneState[];
  constructor(lanes: number[]) {
    this.states = lanes.map((lane) => Object.freeze({ lane, value: 0, armed: true, triggerState: 'armed' as const, tracking: true }));
  }
  set(states: Array<Partial<LaneState>>): void {
    this.states = this.states.map((s, i) => Object.freeze({ ...s, ...states[i] }));
  }
  async start(): Promise<void> {}
  stop(): void {}
  onEvent(_cb: (e: LaneInputEvent) => void): () => void {
    return () => {};
  }
  getLaneStates(): LaneState[] {
    return this.states;
  }
}

/** A hand-driven rAF loop on a hand-driven wall clock, so latch windows are exact. */
function rig(
  source: InputSource,
  lookAt?: (lane: number) => Readonly<ReceptorLook> | undefined,
  prescription?: { lanes: LaneSpec[]; highContrast?: boolean },
): {
  frame: (ms?: number) => void;
  state: (bar: number) => string;
  bar: (i: number) => HTMLElement;
  column: (i: number) => HTMLElement;
  /** Stop / restart the session the way `Play` does when the therapist pauses (`inputSuspended`). */
  suspend: (v: boolean) => void;
} {
  let wall = 5_000;
  let cb: FrameRequestCallback | null = null;
  vi.spyOn(performance, 'now').mockImplementation(() => wall);
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => {
    cb = fn;
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  const meters = (suspended: boolean): React.ReactElement => (
    <LaneMeters
      source={source}
      threshold={THRESHOLD}
      rearmFraction={DEFAULT_REARM_FRACTION}
      lookAt={lookAt}
      suspended={suspended}
      lanes={prescription?.lanes}
      highContrast={prescription?.highContrast}
    />
  );
  const view = render(meters(false));
  const bar = (i: number): HTMLElement => view.container.querySelectorAll('.vbar')[i] as HTMLElement;
  const column = (i: number): HTMLElement => view.container.querySelectorAll('.pip-lane')[i] as HTMLElement;
  return {
    frame: (ms = 1000 / 60) => {
      wall += ms;
      act(() => {
        cb?.(wall);
      });
    },
    state: (i: number) => bar(i).dataset.state ?? 'none',
    bar,
    column,
    // The prop changes; the rAF loop and the fallback history it owns must NOT be torn down with it
    // (the effect does not depend on it — it is read through a ref), or a pause would reset the very
    // record that stops the resume from being read as a crossing.
    suspend: (v: boolean) => view.rerender(meters(v)),
  };
}

/** Run `sec` seconds of frames at 60 fps. */
function run(frame: (ms?: number) => void, sec: number): void {
  for (let i = 0; i < Math.round(sec * 60); i++) frame();
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the picture-in-picture meters wear the receptor\'s four mark sets', () => {
  it('latches the crossing the input layer really publishes, and holds it long enough to be caught', () => {
    const source = new VisionShapedSource([0]);
    const { frame, state, bar } = rig(source);

    // (a) rising, armed and tracked: the column alone, and it is graded — the bar answers "how much
    // further", not "not yet".
    source.set([{ value: 0.3, armed: true, tracking: true }]);
    frame();
    expect(state(0)).toBe('rising');
    const column = (bar(0).firstElementChild as HTMLElement).style.height;
    source.set([{ value: 0.45, armed: true, tracking: true }]);
    frame();
    expect(parseFloat((bar(0).firstElementChild as HTMLElement).style.height)).toBeGreaterThan(parseFloat(column));
    expect((bar(0).firstElementChild as HTMLElement).style.borderTop).toBe('');
    expect(bar(0).style.boxShadow).toBe('');

    // (b) THE CROSSING, as it is actually published: already disarmed on the frame it fires
    // ('triggered'). This is the frame the old code showed the grey lockout look on.
    source.set([{ value: 1, armed: false, triggerState: 'triggered', tracking: true }]);
    frame();
    expect(state(0)).toBe('goal');
    const fill = bar(0).firstElementChild as HTMLElement;
    expect(fill.style.borderTop).toContain('rgb(255, 255, 255)'); // white cap: one added mark
    expect(bar(0).style.boxShadow).not.toBe(''); // white ring: a second added mark
    expect(bar(0).style.outline).toBe('');

    // KNOWLEDGE OF RESULTS IS THE THERAPEUTIC INGREDIENT, so it is latched: >= 150 ms on screen,
    // starting on the frame the input layer fired, for a crossing that lasts one camera frame.
    run(frame, 0.15);
    expect(state(0)).toBe('goal');

    // (c) and then, still held at end range, the lockout: a different cap, no ring.
    run(frame, 0.6);
    expect(state(0)).toBe('locked');
    expect((bar(0).firstElementChild as HTMLElement).style.borderTop).toContain('rgb(192, 140, 255)');
    expect(bar(0).style.boxShadow).toBe('');
    expect(bar(0).style.outline).toBe('');

    // ...and the re-arm returns it to (a).
    source.set([{ value: 0.2, armed: true, triggerState: 'armed', tracking: true }]);
    frame();
    expect(state(0)).toBe('rising');

    // (d) no measurement: no column at all plus a dashed outline. Nothing derived from a value.
    source.set([{ value: 0.2, armed: true, triggerState: 'armed', tracking: false }]);
    run(frame, 0.4);
    expect(state(0)).toBe('lost');
    expect(bar(0).style.outline).toContain('dashed');
    expect((bar(0).firstElementChild as HTMLElement).style.height).toBe('0%');
  });

  it('never celebrates a disarm that produced no rep (the occlusion recovery)', () => {
    // `LaneTrigger.breakContinuity` disarms a lane AT WHATEVER VALUE IT HAS once the stream has been
    // silent longer than maxGapSec, so the recovery frame is `{ value: 0.95, armed: false }` — byte
    // for byte the shape of a crossing, with no LaneInputEvent and no rep behind it.
    const source = new VisionShapedSource([0]);
    const { frame, state } = rig(source);
    source.set([{ value: 0.4, armed: true, tracking: true }]);
    run(frame, 0.3);
    expect(state(0)).toBe('rising');

    source.set([{ value: 0.4, armed: true, tracking: false }]);
    run(frame, 1);
    expect(state(0)).toBe('lost');

    // ...and comes back at end range, 'unconfirmed' — which is what `LaneTrigger.breakContinuity`
    // leaves the lane in, and what VisionInput now publishes. Never 'triggered': no rep fired.
    source.set([{ value: 0.95, armed: false, triggerState: 'unconfirmed', tracking: true }]);
    const seen: string[] = [];
    for (let i = 0; i < 30; i++) {
      frame();
      seen.push(state(0));
    }
    expect(seen).not.toContain('goal');
    expect(seen).not.toContain('rising');
    // From the first recovered frame it says the true, actionable thing instead: locked out, lower
    // to reset. The recovered frame carries a measurement, so "I cannot see you" stops being true on
    // it — and the KR latch is what a dropout kills, not the gauge (`LOST_HOLD_SEC`).
    expect(seen.every((k) => k === 'locked')).toBe(true);
  });

  it('celebrates a REAL KeyboardInput rep after any length of rest — the patient-facing fallback path', () => {
    // THE REGRESSION, on the component a patient actually looks at. `?input=keyboard` is what
    // CameraFallback offers when the camera fails; its LaneStates are the memoized ones, so at rest
    // the meter sees the same frozen objects for as long as the patient is still. Measured in the
    // real app before the fix: `data-state` was `locked` at t+90/390/790 ms, never `goal`.
    for (const restSec of [0.2, 0.6, 5]) {
      const target = new EventTarget();
      const kb = new KeyboardInput({ lanes: 1, audioContext: { currentTime: 0 }, target, blurTargets: [] });
      void kb.start();
      const { frame, state, bar } = rig(kb);
      run(frame, restSec);
      expect(state(0), `rest ${restSec}s at rest`).toBe('rising');

      target.dispatchEvent(new KeyboardEvent('keydown', { key: 'd' }));
      frame();
      expect(state(0), `rest ${restSec}s on the firing frame`).toBe('goal');
      expect((bar(0).firstElementChild as HTMLElement).style.borderTop).toContain('rgb(255, 255, 255)');
      // Latched well past the 150 ms a patient mid-rep can catch...
      run(frame, 0.15);
      expect(state(0), `rest ${restSec}s latched`).toBe('goal');
      // ...then the lockout, for as long as the key is held (holding at end range is the default).
      run(frame, 0.5);
      expect(state(0), `rest ${restSec}s after the latch`).toBe('locked');
      target.dispatchEvent(new KeyboardEvent('keyup', { key: 'd' }));
      frame();
      expect(state(0), `rest ${restSec}s after release`).toBe('rising');
      kb.stop();
      cleanup();
    }
  });

  it('prefers the receptor row\'s own look when the renderer hands it one', () => {
    // ONE VOICE is not "two models that agree", it is one set of numbers: `Highway.receptorLookOf`
    // gives this meter the object the receptor was drawn from, so a divergence is not expressible.
    const source = new VisionShapedSource([0]);
    const drawn = emptyReceptorLook();
    const { frame, state } = rig(source, () => drawn);
    // The source says "rising, nearly at target"; the renderer says the crossing latched. The bar
    // must follow the renderer — the alternative is the patient being shown two answers at once.
    source.set([{ value: 0.55, armed: true, triggerState: 'armed', tracking: true }]);
    drawn.goal = 1;
    drawn.locked = true;
    drawn.rom = 1;
    frame();
    expect(state(0)).toBe('goal');
    drawn.goal = 0;
    frame();
    expect(state(0)).toBe('locked');
    drawn.tracking = false;
    frame();
    expect(state(0)).toBe('lost');
  });

  it('drops the white cap the moment the lane re-arms, and keeps the ring for the KR floor', () => {
    // THE ROUND-2 DEFECT, on the meter a patient reads at 2 m. At the chart generator's own pacing a
    // rep re-arms ~0.1 s after the crossing, and the cue used to run a flat 0.6 s regardless — so
    // this bar sat at 5 % height with a WHITE CAP on it, under a legend reading "white cap = target
    // reached", for the whole inter-rep interval.
    //
    // The cap is a mark ON the column, i.e. a claim about where the patient is now, and it goes with
    // the lockout. The ring is a claim about the rep, and it stays for the KR floor.
    const source = new VisionShapedSource([0]);
    const { frame, state, bar } = rig(source);
    const fill = (): HTMLElement => bar(0).firstElementChild as HTMLElement;

    source.set([{ value: 0.4, armed: true, triggerState: 'armed', tracking: true }]);
    run(frame, 0.3);
    expect(state(0)).toBe('rising');

    source.set([{ value: 1, armed: false, triggerState: 'triggered', tracking: true }]);
    frame();
    expect(state(0)).toBe('goal');
    expect(fill().style.borderTop).toContain('rgb(255, 255, 255)');
    expect(bar(0).style.boxShadow).not.toBe('');

    // ...and straight back down past the re-arm line, which is what a rep at pace does.
    source.set([{ value: 0.05, armed: true, triggerState: 'armed', tracking: true }]);
    frame();
    expect(state(0), 'the rep is still being reported').toBe('goal');
    expect(bar(0).style.boxShadow, 'the KR ring stays').not.toBe('');
    expect(fill().style.borderTop, 'the white cap goes with the lockout').toBe('');
    expect(fill().style.height, 'the column tells the truth: back at rest').toBe('5%');

    // The floor buys at most GOAL_MIN_SEC. Past it the bar is plain (a): no ring, no cap.
    run(frame, 0.15);
    expect(state(0)).toBe('rising');
    expect(bar(0).style.boxShadow).toBe('');
    expect(fill().style.borderTop).toBe('');
  });

  it('keeps its fallback history stepped while the renderer is driving the display', () => {
    // The fallback `ReceptorHistory` used to be advanced ONLY on frames where `lookAt` returned
    // nothing, so its per-lane `prevTrigger` froze for as long as a renderer was up. If `lookAt` then
    // stopped resolving mid-session — runner disposed, or a lane-count change pushing the index past
    // `Highway.laneLooksCount` — the first fallback frame compared a minutes-old trigger state
    // against the current one and could latch a crossing for a lockout that began long before.
    const source = new VisionShapedSource([0]);
    let drawn: ReceptorLook | undefined = undefined;
    const { frame, state } = rig(source, () => drawn);

    // One fallback frame seeds the history while the lane is armed and at rest.
    source.set([{ value: 0.1, armed: true, triggerState: 'armed', tracking: true }]);
    frame();
    expect(state(0)).toBe('rising');

    // The renderer comes up and drives the display for two seconds, during which the patient fires a
    // rep and holds it. The bar follows the renderer — but the history must not stop watching.
    drawn = emptyReceptorLook();
    drawn.rom = 0.9;
    drawn.locked = true;
    source.set([{ value: 0.9, armed: false, triggerState: 'triggered', tracking: true }]);
    run(frame, 2);
    expect(state(0)).toBe('locked');

    // The renderer goes away. The lockout began two seconds ago; nothing has fired since.
    drawn = undefined;
    const seen: string[] = [];
    for (let i = 0; i < 20; i++) {
      frame();
      seen.push(state(0));
    }
    expect(seen).not.toContain('goal');
    expect(seen.every((k) => k === 'locked')).toBe(true);
  });

  it('gives the column a fixed reference to be read against, and swaps it at the lockout', () => {
    // Requirement (a) is that the rising state answer "how much further", which a bare `height: rom%`
    // column cannot do: it is a quantity with no scale printed beside it. The receptor row answers it
    // with a dashed target line and two gate posts; this meter — the one that sits next to the camera
    // preview for the WHOLE session — had no reference mark of any kind, and its legend named goal,
    // locked and lost but never the rising state or where the target was.
    const source = new VisionShapedSource([0]);
    const { frame, state, bar } = rig(source);
    const target = (i: number): HTMLElement => bar(i).querySelector('[data-testid="pip-target-0"]') as HTMLElement;
    const rearm = (i: number): HTMLElement => bar(i).querySelector('[data-testid="pip-rearm-0"]') as HTMLElement;

    // The two lines sit on the same linear ROM axis the receptor draws on: the target at
    // `thresholdFraction` of the bar, the re-arm line at `thresholdFraction * rearmFraction`.
    expect(parseFloat(target(0).style.bottom)).toBeCloseTo(THRESHOLD * 100, 6);
    expect(parseFloat(rearm(0).style.bottom)).toBeCloseTo(THRESHOLD * DEFAULT_REARM_FRACTION * 100, 6);
    expect(parseFloat(rearm(0).style.bottom)).toBeLessThan(parseFloat(target(0).style.bottom));

    // (a) rising: the target is the thing to aim at, so it is the reference that is shown.
    source.set([{ value: 0.3, armed: true, tracking: true }]);
    frame();
    expect(state(0)).toBe('rising');
    expect(target(0).hidden).toBe(false);
    expect(rearm(0).hidden).toBe(true);

    // (b) the crossing: still the target — the column has just reached it, and the ring says so.
    source.set([{ value: 1, armed: false, triggerState: 'triggered', tracking: true }]);
    frame();
    expect(state(0)).toBe('goal');
    expect(target(0).hidden).toBe(false);

    // (c) locked out: the target above is no longer the thing to aim at. The reference becomes the
    // re-arm line the patient has to bring the column back down to — the same swap the receptor row
    // makes when it drops the target line and draws its dashed re-arm line instead.
    run(frame, 0.7);
    expect(state(0)).toBe('locked');
    expect(target(0).hidden).toBe(true);
    expect(rearm(0).hidden).toBe(false);

    // (d) no measurement, so no reference either: a target line over an empty bar invites the patient
    // to read a height off a gauge that has none.
    source.set([{ value: 0.2, armed: true, triggerState: 'armed', tracking: false }]);
    run(frame, 0.5);
    expect(state(0)).toBe('lost');
    expect(target(0).hidden).toBe(true);
    expect(rearm(0).hidden).toBe(true);
  });

  it('puts lane 0 in the first bar however the input source orders its array', () => {
    // The input contract says `getLaneStates()` may arrive in any order, and the receptor row
    // resolves it by `LaneState.lane`. If this meter read it by array position the two rows would
    // run in opposite directions — the same contradiction as two meters in different states.
    const source = new VisionShapedSource([1, 0]);
    const { frame, bar } = rig(source);
    source.set([
      { value: 0.9, armed: true, tracking: true },
      { value: 0.1, armed: true, tracking: true },
    ]);
    frame();
    const height = (i: number): number => parseFloat((bar(i).firstElementChild as HTMLElement).style.height);
    expect(height(0)).toBeCloseTo(10, 5); // lane 0 — published second
    expect(height(1)).toBeCloseTo(90, 5); // lane 1 — published first
  });
});

// -------------------------------------------------------------------------------------------------
// LANE IDENTITY. Agreeing with the receptor row about the STATE is only half of "one voice": a bar
// the patient cannot match to a receptor cannot agree with it about anything. The round-5 critic
// found every bar painted in the app accent gradient (cyan → pink — the colour of no lane in either
// palette) with no label of any kind, so the only thing tying a 14 px bar to a green, red, yellow or
// blue ring 300 px away was its position in a row of four identical columns.
// -------------------------------------------------------------------------------------------------

describe('a picture-in-picture bar is identifiably the same lane as its receptor', () => {
  const PRESCRIPTION: LaneSpec[] = [
    { index: 0, movement: 'seated_march', side: 'left' },
    { index: 1, movement: 'seated_march', side: 'right' },
    { index: 2, movement: 'knee_extension', side: 'left' },
  ];

  for (const highContrast of [false, true]) {
    it(`paints each column in its own lane colour (${highContrast ? 'high-contrast' : 'guitar-hero'} palette)`, () => {
      const source = new VisionShapedSource([0, 1, 2]);
      const { column } = rig(source, undefined, { lanes: PRESCRIPTION, highContrast });
      const palette = getPalette(highContrast);
      for (let i = 0; i < PRESCRIPTION.length; i++) {
        // The SAME colour object the renderer draws receptor i from (`laneColor`), not a second
        // copy of "roughly the right hue".
        expect(column(i).style.getPropertyValue('--lane')).toBe(laneColor(palette, i).base);
        expect(column(i).style.getPropertyValue('--lane-dark')).toBe(laneColor(palette, i).dark);
      }
    });
  }

  it('names the limb under each bar, and the whole lane where a therapist can read it', () => {
    // Colour alone is not identity: it fails a colour-vision deficit, and on the default bilateral
    // prescription the two lanes that matter most to tell apart are the SAME movement on two limbs.
    const source = new VisionShapedSource([0, 1, 2]);
    const { column } = rig(source, undefined, { lanes: PRESCRIPTION });
    expect(column(0).querySelector('.pip-lane-name')?.textContent).toBe('L');
    expect(column(1).querySelector('.pip-lane-name')?.textContent).toBe('R');
    expect(column(2).querySelector('.pip-lane-name')?.textContent).toBe('L');
    // ...and the full name, the same string the receptor row prints under its ring.
    for (let i = 0; i < PRESCRIPTION.length; i++) {
      expect(column(i).title).toBe(laneLabel(PRESCRIPTION[i]));
      expect(column(i).querySelector('.vbar')?.getAttribute('aria-label')).toBe(laneLabel(PRESCRIPTION[i]));
    }
  });

  it('keeps the lane colour for (a) and (b) and surrenders it only to the lockout tint', () => {
    // (c) is the one state the receptor row does NOT draw in the lane colour either — it desaturates
    // to the lock tint — so the bar following it there is the two meters agreeing, not diverging.
    const source = new VisionShapedSource([0]);
    const { frame, bar, state } = rig(source, undefined, { lanes: [PRESCRIPTION[0]] });
    const fill = (): HTMLElement => bar(0).firstElementChild as HTMLElement;
    source.set([{ value: 0.3, armed: true, triggerState: 'armed', tracking: true }]);
    frame();
    expect(state(0)).toBe('rising');
    expect(fill().style.background).toBe(''); // the column's own `--lane` gradient
    source.set([{ value: 0.9, armed: false, triggerState: 'triggered', tracking: true }]);
    frame();
    expect(state(0)).toBe('goal');
    expect(fill().style.background).toBe('');
    run(frame, 0.7);
    expect(state(0)).toBe('locked');
    expect(fill().style.background).not.toBe('');
  });

  it('names each bar from the spec whose `index` is that lane, not from array position', () => {
    // The renderer resolves the label under receptor 0 by `LaneSpec.index` (`Highway.laneSpec`), and
    // this meter already resolves the STATE by `LaneState.lane`. Reading the NAME by array position
    // instead would print "R" under a bar the receptor row calls "L knee lift" on a prescription
    // that arrived out of order.
    const source = new VisionShapedSource([0, 1]);
    const shuffled: LaneSpec[] = [
      { index: 1, movement: 'seated_march', side: 'right' },
      { index: 0, movement: 'seated_march', side: 'left' },
    ];
    const { column } = rig(source, undefined, { lanes: shuffled });
    expect(column(0).title).toBe('L knee lift');
    expect(column(1).title).toBe('R knee lift');
  });

  it('falls back to the palette colour and no letter when it has no prescription', () => {
    // The component is rendered without one in harnesses and in these tests; it must still be a
    // gauge, and it must not invent a limb.
    const source = new VisionShapedSource([0, 1]);
    const { column } = rig(source);
    expect(column(0).style.getPropertyValue('--lane')).toBe(laneColor(getPalette(false), 0).base);
    expect(column(0).querySelector('.pip-lane-name')?.textContent).toBe('');
    expect(column(0).title).toBe('Lane 1');
  });
});

/**
 * WHICH INPUT-LAYER FAULTS BLANK A GAUGE, AND WHICH ONLY SPEAK TO THE THERAPIST.
 *
 * `VisionStatus` names several ways a lane can be publishing a well-formed `LaneState` while the
 * session is not working, and they do NOT all mean the same thing to the patient. Two of them make
 * the lane's meter a lie (it cannot fire at all, so "rising, armed, ready" and "lower to reset" are
 * both false promises); one of them does not (the lane is measuring correctly and the patient is
 * falling short, which is the one thing state (a) exists to show). Getting that split wrong in
 * either direction costs the display its credibility — blanking a working gauge, or leaving a dead
 * one lit.
 */
describe('faultedLanes: what blanks a receptor and what does not', () => {
  const status = (over: Partial<VisionStatus>): VisionStatus => ({
    tracking: true,
    reason: 'ok',
    message: '',
    fps: 30,
    inferenceMs: 12,
    delegate: 'GPU',
    untrackedLanes: [],
    warnings: [],
    ...over,
  });

  it('faults a refused calibration and a pinned lane', () => {
    expect(faultedLanes(status({ invalidCalibrationLanes: [2] }))).toEqual([2]);
    expect(faultedLanes(status({ pinnedLanes: [1] }))).toEqual([1]);
    // Both at once, deduplicated and in lane order — a lane can be either, and both.
    expect(faultedLanes(status({ invalidCalibrationLanes: [3, 0], pinnedLanes: [0, 1] }))).toEqual([0, 1, 3]);
  });

  it('does NOT fault a lane that is simply not reaching its threshold', () => {
    // The patient is working, the meter is measuring them, and they are short of the target. That is
    // a graded "how much further" readout doing its job — and a sentence for the therapist about the
    // difficulty, not a reason to take the patient's gauge away.
    expect(faultedLanes(status({ unreachableLanes: [0, 1] }))).toEqual([]);
    expect(faultedLanes(status({ unmonitoredCompensationLanes: [0], unlabelledHandLanes: [1], subjectChanged: true, lowFps: true }))).toEqual([]);
  });

  it('faults nothing on a healthy session', () => {
    expect(faultedLanes(status({}))).toEqual([]);
  });
});

/**
 * THE ROUND-7 BLOCKER, on this meter. `Play` holds the pause flag and used not to give it to either
 * meter, so with the song clock frozen a held lane lit this bar's knowledge-of-results ring for
 * eleven consecutive frames while score/reps/hits stayed 0/0/0 — the engine drops every event
 * stamped inside a pause. The bars are fed from `source.getLaneStates()`, which is live through a
 * pause because the camera is.
 */
describe('a paused session is not scoring, and the bars say so', () => {
  it('blanks to "no reading" for the whole stop, at every value and in every state', () => {
    const source = new VisionShapedSource([0]);
    const { frame, state, bar, suspend } = rig(source);
    source.set([{ value: 0.4, armed: true, triggerState: 'armed', tracking: true }]);
    frame();
    expect(state(0)).toBe('rising');

    suspend(true);
    // The patient keeps moving — a therapist pauses in order to reposition them — and crosses.
    source.set([{ value: 1, armed: false, triggerState: 'triggered', tracking: true }]);
    const seen: string[] = [];
    for (let i = 0; i < 12; i++) {
      frame();
      seen.push(state(0));
      expect(bar(0).style.boxShadow).toBe(''); // no KR ring, on any frame of the stop
    }
    expect(seen.every((k) => k === 'lost')).toBe(true);
    expect(bar(0).style.outline).toContain('dashed');
    expect((bar(0).firstElementChild as HTMLElement).style.height).toBe('0%');

    // Resumed while still held: nothing crossed since the resume, so nothing is acknowledged — the
    // rep that fired into the stopped engine may not be celebrated a moment late either.
    suspend(false);
    frame();
    expect(state(0)).toBe('locked');
    expect(bar(0).style.boxShadow).toBe('');

    // ...and the first real rep after the resume is acknowledged in full.
    source.set([{ value: 0.2, armed: true, triggerState: 'armed', tracking: true }]);
    frame();
    expect(state(0)).toBe('rising');
    source.set([{ value: 1, armed: false, triggerState: 'triggered', tracking: true }]);
    frame();
    expect(state(0)).toBe('goal');
    expect(bar(0).style.boxShadow).not.toBe('');
  });

  it('drops a cue that was lit when the stop arrived instead of holding it over the pause', () => {
    const source = new VisionShapedSource([0]);
    const { frame, state, suspend } = rig(source);
    source.set([{ value: 0.4, armed: true, triggerState: 'armed', tracking: true }]);
    frame();
    source.set([{ value: 1, armed: false, triggerState: 'triggered', tracking: true }]);
    frame();
    expect(state(0)).toBe('goal');
    suspend(true);
    frame();
    expect(state(0)).toBe('lost');
    // Resumed inside what would have been the rest of the latch: knowledge of results delivered into
    // the next repetition is non-contingent feedback, so it is gone for good, not merely hidden.
    suspend(false);
    frame();
    expect(state(0)).toBe('locked');
  });

  it('says what the receptor row says: ONE VOICE survives the stop', () => {
    // The renderer's look wins for display, and it already carries the stop (it is drawn from the
    // same flag). Here the row is stopped and this meter is not yet told — the two must still agree,
    // which is exactly why `lookAt` is the source of truth and `suspended` only feeds the fallback.
    const source = new VisionShapedSource([0]);
    const drawn = emptyReceptorLook(DEFAULT_REARM_FRACTION);
    const { frame, state, bar } = rig(source, () => drawn);
    source.set([{ value: 1, armed: false, triggerState: 'triggered', tracking: true }]);
    drawn.tracking = false;
    drawn.suspended = true;
    drawn.rom = 1;
    frame();
    expect(state(0)).toBe('lost');
    expect(bar(0).style.boxShadow).toBe('');
    expect((bar(0).firstElementChild as HTMLElement).style.height).toBe('0%');
  });
});
