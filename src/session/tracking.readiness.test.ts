/**
 * WHAT THIS DEVICE WILL SUPPORT, SAID BEFORE THE APPOINTMENT IS SPENT.
 *
 * The camera check was the only screen in the flow with neither a gate nor a forward-looking
 * statement: driven with a real webcam at 1–2 fps, 878 ms of inference per frame and "No person
 * detected", it let the therapist walk a patient on to a calibration that cannot be measured.
 *
 * These tests pin both halves of the fix. The GATE fires only on a positive finding — nothing
 * tracked at all, or frames further apart than the widest hit window the prescription grants — never
 * on absence of evidence, and never on a stream that is merely coarse. The STATEMENT is in the
 * prescription's own numbers, so a therapist can act on it before the patient is in the chair.
 */
import { describe, expect, it } from 'vitest';
import { READINESS_SAMPLES, cameraReadiness } from './tracking.ts';
import type { ReadinessWindows } from './tracking.ts';
import type { TrackingQuality } from './types.ts';

/** Medium difficulty, gross-motor lanes: ±70 ms perfect, ±140 ms good. */
const MEDIUM: ReadinessWindows = { perfectMs: 70, goodMs: 140, difficulty: 'medium' };

function q(patch: Partial<TrackingQuality> = {}): TrackingQuality {
  return {
    samples: 20, fpsMedian: 30, fpsLow: 28, inferenceMsMedian: 12,
    trackedFraction: 0.99, lowFpsFraction: 0, delegate: 'GPU', worstReason: null,
    ...patch,
  };
}

describe('cameraReadiness', () => {
  it('claims nothing before any health report has arrived, and gates nothing', () => {
    const r = cameraReadiness(null, MEDIUM);
    expect(r.kind).toBe('measuring');
    expect(r.gate).toBe(false);
    expect(r.will).toEqual([]);
    expect(r.wont).toEqual([]);
  });

  it('holds the way forward while it is still collecting readings, so nobody clicks through the gap', () => {
    const r = cameraReadiness(q({ samples: 2 }), MEDIUM);
    expect(r.kind).toBe('measuring');
    expect(r.gate).toBe(true);
    expect(r.headline).toContain(`of ${READINESS_SAMPLES}`);
  });

  it('a healthy device is ready and says what it supports in the prescription’s own numbers', () => {
    const r = cameraReadiness(q(), MEDIUM);
    expect(r.kind).toBe('ready');
    expect(r.gate).toBe(false);
    expect(r.will.join(' ')).toContain('33 ms');
    expect(r.will.join(' ')).toContain('perfect ±70 ms');
    expect(r.will.join(' ')).toContain('lower bound');
    expect(r.wont).toEqual([]);
  });

  it('GATES when nothing has been tracked at all, and says why the next screen cannot work', () => {
    const r = cameraReadiness(q({ trackedFraction: 0, samples: READINESS_SAMPLES }), MEDIUM);
    expect(r.kind).toBe('blocked');
    expect(r.gate).toBe(true);
    expect(r.wont.join(' ')).toMatch(/cannot be calibrated/);
    expect(r.wont.join(' ')).toMatch(/score nothing/);
    // A gate that cannot clear is a trap; this one says how it clears.
    expect(r.action).toMatch(/clears by itself/);
  });

  it('GATES the reported case: 1.5 fps with 878 ms inference on the CPU', () => {
    const r = cameraReadiness(
      q({ fpsMedian: 1.5, fpsLow: 1, inferenceMsMedian: 878, trackedFraction: 0.1, delegate: 'CPU', lowFpsFraction: 1 }),
      MEDIUM,
    );
    expect(r.kind).toBe('blocked');
    expect(r.gate).toBe(true);
    expect(r.headline).toContain('2 frames per second');
    expect(r.wont.join(' ')).toContain('±140 ms');
    expect(r.action).toContain('878 ms');
    // The escape hatch is named where the gate is stated.
    expect(r.action).toMatch(/keyboard/i);
  });

  it('does NOT gate a merely coarse stream — a slow session is still a session', () => {
    // 13 fps: one frame every 77 ms, inside the ±140 ms good window but outside the ±70 ms perfect one.
    const r = cameraReadiness(q({ fpsMedian: 13, fpsLow: 12, lowFpsFraction: 1 }), MEDIUM);
    expect(r.kind).toBe('degraded');
    expect(r.gate).toBe(false);
    expect(r.wont.join(' ')).toContain('±70 ms perfect window');
    expect(r.wont.join(' ')).toContain('±140 ms good window is reachable');
  });

  it('a coarse stream never reads "with limits" over an empty list of limits', () => {
    // 20 fps reaches both windows, but it is still below the rate the figures assume.
    const r = cameraReadiness(q({ fpsMedian: 20, fpsLow: 18 }), MEDIUM);
    expect(r.kind).toBe('degraded');
    expect(r.gate).toBe(false);
    expect(r.wont.length).toBeGreaterThan(0);
    expect(r.wont.join(' ')).toMatch(/peak between two frames/);
  });

  it('the gate is on the windows ACTUALLY IN FORCE, not on a constant', () => {
    const slow = q({ fpsMedian: 8, fpsLow: 6, trackedFraction: 0.9 });
    // 8 fps is one frame every 125 ms. Hard (±110 ms good) cannot place a rep; easy (±180 ms) can.
    expect(cameraReadiness(slow, { perfectMs: 50, goodMs: 110, difficulty: 'hard' }).gate).toBe(true);
    expect(cameraReadiness(slow, { perfectMs: 90, goodMs: 180, difficulty: 'easy' }).gate).toBe(false);
  });

  it('reports intermittent landmarks as unmeasured time, not as stillness', () => {
    const r = cameraReadiness(q({ trackedFraction: 0.62 }), MEDIUM);
    expect(r.kind).toBe('degraded');
    expect(r.gate).toBe(false);
    expect(r.wont.join(' ')).toContain('62 %');
    expect(r.wont.join(' ')).toMatch(/not measured/);
  });

  it('names the CPU delegate and its cost when there is no graphics acceleration', () => {
    const r = cameraReadiness(q({ delegate: 'CPU', inferenceMsMedian: 46, fpsMedian: 20, fpsLow: 18 }), MEDIUM);
    expect(r.will.join(' ')).toContain('46 ms a frame');
    expect(r.will.join(' ')).toMatch(/no graphics acceleration/);
  });

  it('a dipping frame rate is stated even when the median is fine', () => {
    const r = cameraReadiness(q({ fpsMedian: 30, fpsLow: 9 }), MEDIUM);
    expect(r.kind).toBe('degraded');
    expect(r.wont.join(' ')).toContain('dips to 9 fps');
  });
});

/**
 * TWO THINGS THIS SCREEN USED TO SAY THAT WERE NOT TRUE.
 *
 * Both were found by driving the real app rather than by reading the code, and both are the same
 * class of bug: a number that cannot be produced being reported as a condition of a working session.
 */
describe('cameraReadiness tells the truth about what it measured', () => {
  it('a DEAD frame rate is blocked, not "the session will run, with limits: 0 fps"', () => {
    // `frameIntervalMs` returns null at a median of 0, so the timing branch used to be SKIPPED and
    // the verdict fell through to `degraded` — printing "This device will run the session, with
    // limits: 0 fps, landmarks usable for 84 % of the session" next to a badge reading "0 fps".
    const r = cameraReadiness(q({ fpsMedian: 0, fpsLow: 0, trackedFraction: 0.84, inferenceMsMedian: 5806 }), MEDIUM);
    expect(r.kind).toBe('blocked');
    expect(r.gate).toBe(true);
    expect(r.headline).toMatch(/No frames are being processed/);
    expect(r.headline).not.toMatch(/will run the session/);
    expect(r.wont.join(' ')).toMatch(/nothing is being timed/);
    // It is a gate that clears by itself, like every other one here.
    expect(r.action).toMatch(/clears by itself/);
  });

  it('"nothing is being tracked" is not said over a preview that is tracking something', () => {
    // `trackedFraction` is EVERY prescribed lane at once (VisionStatus.tracking), so one hand of a
    // bilateral prescription drifting out of frame takes it to zero while the other is drawn, live,
    // on the preview the patient is looking at.
    const partial = cameraReadiness(
      q({ trackedFraction: 0, samples: READINESS_SAMPLES }),
      MEDIUM,
      { anyLandmarksFraction: 0.9 },
    );
    expect(partial.gate).toBe(true);
    expect(partial.headline).toBe('Part of this prescription is out of frame.');
    expect(partial.headline).not.toMatch(/Nothing is being tracked/);
    expect(partial.wont.join(' ')).toMatch(/90 % of these readings/);
    expect(partial.action).toMatch(/every prescribed limb/);

    // And when there genuinely is nothing, the old sentence is still the right one.
    const nothing = cameraReadiness(
      q({ trackedFraction: 0, samples: READINESS_SAMPLES }),
      MEDIUM,
      { anyLandmarksFraction: 0 },
    );
    expect(nothing.headline).toBe('Nothing is being tracked on this camera yet.');
  });

  it('claims neither when nothing could say which it is', () => {
    const r = cameraReadiness(q({ trackedFraction: 0, samples: READINESS_SAMPLES }), MEDIUM);
    expect(r.headline).toBe('Not every prescribed limb is being tracked yet.');
  });

  it('a blocked device is told it can be restarted AND gone on from — the two hands-free choices', () => {
    const r = cameraReadiness(q({ fpsMedian: 5, fpsLow: 4, inferenceMsMedian: 190 }), MEDIUM);
    expect(r.kind).toBe('blocked');
    expect(r.action).toMatch(/Restarting the camera/);
    expect(r.action).toMatch(/going on anyway/i);
    expect(r.action).toMatch(/keyboard/i);
  });
});

/**
 * IS THERE A HAND IN THE PICTURE TO ANSWER WITH?
 *
 * The verdict used to be about the DEVICE and the prescribed lanes only, so a camera check could pass a
 * stream as READY, hand a patient a hands-free session and leave them holding a limb at a ring that
 * cannot fill: in leg mode the dwell pointer is a HAND (a knee cannot answer — vision/dwell.ts) and the
 * app's own framing instruction asked only for hips, knees and feet. A patient who followed it had no
 * pointer at all, and found out alone.
 */
describe('cameraReadiness: whether anything can answer the screen', () => {
  const pointer = (fraction: number, mode: 'leg' | 'hand' = 'leg') => ({ pointer: { fraction, mode } });

  it('says nothing either way when the screen did not say', () => {
    // A caller with no hands-free targets on it makes no claim, and neither does this.
    const r = cameraReadiness(q(), MEDIUM);
    expect(r.kind).toBe('ready');
    expect(r.will.join(' ')).not.toMatch(/hand/i);
    expect(r.wont).toEqual([]);
  });

  it('a hand in the picture is stated as something this device WILL support', () => {
    // With the coupling share measured, it may say the exercise is not moving that hand…
    const measured = cameraReadiness(q(), MEDIUM, { pointer: { fraction: 1, mode: 'leg', carriedFraction: 0 } });
    expect(measured.kind).toBe('ready');
    expect(measured.gate).toBe(false);
    expect(measured.will.join(' ')).toMatch(/A hand is in the picture and the exercise is not moving it/);
    expect(measured.will.join(' ')).toMatch(/no one has to press anything/);
    expect(measured.wont).toEqual([]);
    // …and without it, it may NOT: a hand the prescription carries is refused by the rings, so "the
    // patient can answer every step" would promise a measurement the app itself declines.
    const r = cameraReadiness(q(), MEDIUM, pointer(1));
    expect(r.kind).toBe('ready');
    expect(r.will.join(' ')).toMatch(/A hand is in the picture for the circles to follow/);
    expect(r.will.join(' ')).toMatch(/resting on something their leg does not move/);
    expect(r.will.join(' ')).not.toMatch(/answer every step/);
  });

  it('NO hand in the picture costs the ready badge, names the knee rule, and says what to do', () => {
    const r = cameraReadiness(q(), MEDIUM, pointer(0));
    // The device is fine; the session is not answerable. "Ready" over that would be the worst promise
    // this screen can make, so it cannot read ready.
    expect(r.kind).toBe('degraded');
    expect(r.headline).not.toMatch(/support the whole prescription/);
    expect(r.headline).toMatch(/nobody in the picture can answer it/);
    expect(r.wont.join(' ')).toMatch(/Nothing on this screen or after it can be confirmed without touching it/);
    expect(r.wont.join(' ')).toMatch(/a knee held in a circle cannot be told apart from a repetition/);
    expect(r.action).toMatch(/Bring one hand into the picture/);
    // IT NAMES A SUPPORT THE LEG CANNOT MOVE. "resting on the thigh or the arm of the chair is enough"
    // was this file's own sentence, and the thigh half of it is what filled the primary circle in
    // 3.23 s on the first repetition of a seated march (vision/dwell.ts).
    expect(r.action).toMatch(/arm of the chair|armrest|table/);
    expect(r.action).toMatch(/NOT on the thigh/);
    expect(r.action).toMatch(/somebody has to press the buttons/);
    expect(r.action).toMatch(/clears by itself/);
  });

  it('DOES NOT GATE on it — the hands-free escapes a gate must leave ARE these circles', () => {
    /**
     * A blocked verdict on this screen is required to leave a hands-free way forward and a hands-free
     * way back, and on the camera check those two ways are the dwell pair. A gate raised because there
     * is no pointer would be a gate whose own mandatory escapes cannot be used — the dead end the whole
     * gesture exists to prevent. It is also a thing the patient fixes by moving a hand, unlike a device
     * processing one frame every five seconds, and nothing downstream is unmeasurable without it: every
     * lane still calibrates and still scores while both hands are out of the picture.
     */
    expect(cameraReadiness(q(), MEDIUM, pointer(0)).gate).toBe(false);
    expect(cameraReadiness(q({ fpsMedian: 12, fpsLow: 9 }), MEDIUM, pointer(0)).gate).toBe(false);
    // …and on a device that IS blocked, the pointer changes nothing about the gate either way.
    const slow = cameraReadiness(q({ fpsMedian: 5, fpsLow: 4, inferenceMsMedian: 190 }), MEDIUM, pointer(0));
    expect(slow.kind).toBe('blocked');
    expect(slow.gate).toBe(true);
    // But the therapist is told, HERE, that the "go on anyway" circle cannot be held: that offer and
    // this absence are the same sentence's two halves.
    expect(slow.wont.join(' ')).toMatch(/Nothing on this screen or after it can be confirmed without touching it/);
    expect(slow.action).toMatch(/Bring one hand into the picture/);
  });

  it('a hand that keeps leaving the frame is a different sentence from one that was never there', () => {
    const r = cameraReadiness(q(), MEDIUM, pointer(0.5));
    expect(r.kind).toBe('degraded');
    expect(r.wont.join(' ')).toMatch(/only 50 % of this check/);
    expect(r.wont.join(' ')).toMatch(/fits and starts/);
    expect(r.wont.join(' ')).not.toMatch(/never in the picture/);
    expect(r.action).toMatch(/Move the camera or the chair/);
    // A hand present for nearly the whole window is not worth a caveat.
    expect(cameraReadiness(q(), MEDIUM, pointer(0.95)).kind).toBe('ready');
  });

  it('in hand mode it does not lecture about knees', () => {
    const r = cameraReadiness(q(), MEDIUM, pointer(0, 'hand'));
    expect(r.wont.join(' ')).not.toMatch(/knee/);
    expect(r.wont.join(' ')).toMatch(/the hand was never in the picture/);
  });

  it('A HAND THE EXERCISE IS CARRYING IS NOT AN ANSWER, and the ready badge says so', () => {
    /**
     * The patient has a hand in the picture for the whole check — resting on their thigh, where the old
     * framing instruction put it. `fraction` is 1, so this screen used to promise "the patient can
     * answer every step by holding a circle"; the rings, measuring the same session, refuse that hand
     * the moment the leg starts working (`DwellCoupling`). The screen may not promise what the app will
     * decline, and the remedy is a thing the therapist can fix in the room, now.
     */
    const r = cameraReadiness(q(), MEDIUM, { pointer: { fraction: 1, mode: 'leg', carriedFraction: 0.8 } });
    expect(r.kind).toBe('degraded');
    expect(r.will.join(' ')).not.toMatch(/can answer every step/);
    expect(r.headline).toMatch(/moving with the exercise/);
    expect(r.wont.join(' ')).toMatch(/travelled with the prescribed movement/);
    expect(r.wont.join(' ')).toMatch(/carried by the thigh/);
    expect(r.action).toMatch(/arm of the chair|armrest|table/);
    expect(r.action).toMatch(/other hand/);
    // It is a warning, not a gate: the hands-free escapes a gate must leave are these same circles.
    expect(r.gate).toBe(false);
    // A hand that was carried for a moment (a knee passing under it, one noisy window) is not this.
    expect(cameraReadiness(q(), MEDIUM, { pointer: { fraction: 1, mode: 'leg', carriedFraction: 0.05 } }).kind).toBe('ready');
    // And a caller that cannot say claims nothing either way — the old behaviour, unchanged.
    const silent = cameraReadiness(q(), MEDIUM, pointer(1));
    expect(silent.kind).toBe('ready');
    expect(silent.will.join(' ')).toMatch(/A hand is in the picture for the circles to follow/);
  });

  it('claims nothing while it is still measuring the device', () => {
    const r = cameraReadiness(q({ samples: 2 }), MEDIUM, pointer(0));
    expect(r.kind).toBe('measuring');
    expect(r.wont).toEqual([]);
    expect(r.will).toEqual([]);
  });
});
