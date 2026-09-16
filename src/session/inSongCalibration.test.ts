/**
 * CALIBRATING INSIDE THE MUSIC — the safety properties, driven through a real VisionInput.
 *
 * Nothing here is mocked below the session layer: a real `VisionInput` in hand mode is fed real
 * fixture landmarks through `processDetection` (the same entry point the detect loop calls), so the
 * feature extraction, the unit-free filter, the lane trigger and the calibration vetting are all the
 * shipping code. What is asserted is what the patient would feel: the value in the movement's own
 * units that their hand has to reach for a note to score.
 */
import { describe, expect, it } from 'vitest';
import type { LaneSpec } from '../engine/types.ts';
import { VisionInput } from '../input/VisionInput.ts';
import { extractFeature } from '../vision/features.ts';
import { handPose } from '../vision/fixtures.ts';
import { calibrationMethodOf, operativeThreshold } from '../vision/calibration.ts';
import type { RomCalibration } from '../vision/calibration.ts';
import { InSongCalibration, WARMUP_SEC, calibrationModeOf, foldsInLatencyStep, seedCalibrations } from './inSongCalibration.ts';

class FakeClock {
  currentTime = 0;
}

const LANES: LaneSpec[] = [{ index: 0, movement: 'hand_open_close', side: 'right' }];
const THRESHOLD = 0.65;
const PATIENT = 'p-in-song';

/** The `hand_open_close` feature at a given openness — the quantity the whole session is scaled by. */
const featureAt = (openness: number): number =>
  extractFeature('hand_open_close', handPose({ openness }), 'right', { mirrored: false })!;

function frame(openness: number) {
  return { tMs: 0, pose: null, hands: [{ landmarks: handPose({ openness }), label: 'Left', score: 0.99 }] };
}

interface Rig {
  vision: VisionInput;
  cal: InSongCalibration;
  /** Song time the calibrator reads. Move it to cross the warm-up boundary. */
  songTime: { value: number };
  /** Feed one frame at `openness`, advancing the clock by one 30 fps tick. */
  push(openness: number): void;
  /** Hold `openness` for `seconds` of frames. */
  hold(openness: number, seconds: number): void;
  /** One open-close repetition to `peak` openness. */
  rep(peak: number): void;
  /** The feature value the lane must reach to score, right now. */
  threshold(): number | null;
}

function rig(saved: (RomCalibration | null)[] = [null], lanes: LaneSpec[] = LANES): Rig {
  const clock = new FakeClock();
  const vision = new VisionInput({
    mode: 'hand',
    lanes,
    // Deliberately empty: on this path the seeds go in through InSongCalibration, which vets them
    // first (see `seedCalibrations`).
    calibrations: lanes.map(() => null),
    thresholdFraction: THRESHOLD,
    audioContext: clock,
    driveLoop: false,
  });
  const songTime = { value: -3 };
  const cal = new InSongCalibration({
    vision,
    lanes,
    seeds: seedCalibrations(lanes, saved, (i) => ({ ...(vision.getCalibrationContext(i) ?? {}), patient: PATIENT })),
    thresholdFraction: THRESHOLD,
    songTime: () => songTime.value,
    patientId: PATIENT,
    sessionId: 'sess-1',
    now: () => 1_700_000_000_000,
  });
  cal.attach();
  const push = (openness: number): void => {
    clock.currentTime += 1 / 30;
    vision.processDetection(frame(openness), clock.currentTime);
  };
  const hold = (openness: number, seconds: number): void => {
    for (let i = 0; i < Math.round(seconds * 30); i++) push(openness);
  };
  const rep = (peak: number): void => {
    hold(0, 0.2);
    for (let i = 1; i <= 6; i++) push((peak * i) / 6);
    hold(peak, 0.15);
    for (let i = 5; i >= 0; i--) push((peak * i) / 6);
    hold(0, 0.2);
  };
  const threshold = (): number | null => {
    const c = vision.getLaneDebug()[0].calibration;
    return c ? operativeThreshold(c, THRESHOLD) : null;
  };
  return { vision, cal, songTime, push, hold, rep, threshold };
}

describe('the song starts on a range the patient can reach', () => {
  it('installs a provisional range within half a second of the first frames, before the first note', () => {
    const r = rig();
    expect(r.threshold()).toBeNull();
    // Half a second of a hand simply resting in front of the camera — less than the 3-2-1 count-in.
    r.hold(0, 0.5);
    const t = r.threshold();
    expect(t).not.toBeNull();
    // Anchored on THIS patient's observed rest, not on a population figure.
    expect(t!).toBeGreaterThan(featureAt(0));
  });

  /**
   * THE CASE THE WHOLE SEED RULE EXISTS FOR.
   *
   * A hand that can only open a fraction of the way must be able to score in the opening bars, or
   * the in-song path has simply moved the wall from before the music to inside it. The provisional
   * range is the movement's own minimum usable ROM above the patient's rest — the smallest range
   * that is still a calibration — so the target is the lowest one that can be defended.
   */
  it('lets a patient with a tiny range score in the opening bars', () => {
    const r = rig();
    const events: number[] = [];
    r.vision.onEvent((e) => events.push(e.ctxTime));
    // The count-in: the patient is simply sitting with their hand at rest, which IS a still hold.
    r.hold(0, 1.2);
    // A hand that opens a quarter of the fixture's full excursion — under the movement's own nominal
    // minimum range, the case the deliberate path's small-ROM relaxation exists for.
    r.rep(0.25);
    r.rep(0.25);
    expect(events.length).toBeGreaterThanOrEqual(2);
    // And the threshold it crossed really is below what that hand reached.
    expect(r.threshold()!).toBeLessThan(featureAt(0.25));
  });

  /**
   * ...AND ONLY BECAUSE THE PATIENT WAS ACTUALLY STILL. The relaxed floor is earned by an observed
   * still window, exactly as it is on the calibration screen. A patient whose hand never settles
   * gets the full floor, and the app does not pretend to have measured a hold it did not see.
   */
  it('does not claim a still zero for a patient who never settles', () => {
    const r = rig();
    for (let i = 0; i < 90; i++) r.push(0.5 + 0.4 * Math.sin(i / 2));
    const cal = r.vision.getLaneDebug()[0].calibration!;
    expect(cal.rest?.still).toBe(false);
  });

  it('starts on this patient’s own saved range when there is a valid one', () => {
    const saved: RomCalibration = {
      min: featureAt(0),
      max: featureAt(1),
      samples: 300,
      movement: 'hand_open_close',
      mirrored: false,
      patient: PATIENT,
      measurement: {
        method: 'rom_screen', frames: 300, tracked: 300, trackedFraction: 1,
        fpsMedian: 30, fpsLow: 29, durationSec: 10, reps: 3, repSpread: 0.01, repSpreadFraction: 0.02,
      },
    };
    const r = rig([saved]);
    // In force from the first frame: there is nothing to wait for.
    expect(r.threshold()).toBeCloseTo(operativeThreshold(saved, THRESHOLD), 6);
    expect(calibrationMethodOf(r.vision.getLaneDebug()[0].calibration)).toBe('rom_screen');
  });
});

describe('a saved range whose context does not match is still refused', () => {
  /**
   * The refusals are the app's existing ones (`calibrationMismatch`), and the in-song path must not
   * quietly become a way around them: a range measured on another patient's body normalizes this
   * patient's movement by somebody else's, which makes every percentage in the record wrong.
   */
  const other: RomCalibration = {
    min: featureAt(0),
    max: featureAt(1),
    samples: 300,
    movement: 'hand_open_close',
    mirrored: false,
    patient: 'somebody-else',
  };

  it('never puts another patient’s range into the lane, and says why', () => {
    const r = rig([other]);
    // Nothing installed from the stored range; the lane waits for its own provisional one.
    expect(r.threshold()).toBeNull();
    const refusals = r.cal.refusals();
    expect(refusals).toHaveLength(1);
    expect(refusals[0].reason).toMatch(/different patient/i);

    r.hold(0, 0.6);
    const installed = r.vision.getLaneDebug()[0].calibration!;
    expect(installed.patient).toBe(PATIENT);
    expect(installed.max).not.toBeCloseTo(other.max, 6);
    expect(calibrationMethodOf(installed)).toBe('in_song');
  });

  it('refuses a range measured under the other mirror convention — that is the other hand', () => {
    const r = rig([{ ...other, patient: PATIENT, mirrored: true }]);
    expect(r.cal.refusals()[0].reason).toMatch(/mirror|un-mirrored|OTHER limb/i);
    expect(r.threshold()).toBeNull();
  });

  it('refuses a range measured for another movement', () => {
    const r = rig([{ ...other, patient: PATIENT, movement: 'finger_spread' }]);
    expect(r.cal.refusals()[0].reason).toMatch(/finger spread/i);
  });

  it('refuses a range too narrow to be a calibration rather than making a hit generator of it', () => {
    const tiny: RomCalibration = { min: featureAt(0), max: featureAt(0) + 0.001, samples: 10, movement: 'hand_open_close', mirrored: false, patient: PATIENT };
    const r = rig([tiny]);
    expect(r.cal.refusals()[0].reason).toMatch(/below the .* minimum/i);
  });
});

describe('the operative threshold may never rise once the warm-up has closed', () => {
  /**
   * THE SAFETY PROPERTY THIS WHOLE FEATURE TURNS ON.
   *
   * The patient warms up small and then — as patients do once the music has them — moves much
   * further. If the learner kept raising the range, the bar would rise with it and somebody who was
   * scoring would start missing for having achieved more. The range is adopted exactly once, at the
   * end of the warm-up, and is frozen from then on.
   */
  it('freezes at the warm-up boundary and never moves again, however much bigger the patient goes', () => {
    const r = rig();
    r.songTime.value = 0;
    r.hold(0, 0.6);
    r.rep(0.3);
    r.rep(0.3);
    const duringWarmup = r.threshold()!;

    // The boundary: one adoption, from the reps actually performed.
    r.songTime.value = WARMUP_SEC + 0.1;
    r.push(0);
    const frozen = r.threshold()!;
    expect(frozen).toBeGreaterThan(0);

    // Now the patient opens their hand the whole way, over and over, for the rest of the song.
    for (let i = 0; i < 12; i++) r.rep(1);
    r.songTime.value = WARMUP_SEC + 60;
    r.push(0);
    expect(r.threshold()!).toBeCloseTo(frozen, 9);
    expect(r.cal.isFrozen()).toBe(true);
    // And it never rose ABOVE what the warm-up left, at any point after the one adoption.
    expect(r.threshold()!).toBeLessThanOrEqual(Math.max(duringWarmup, frozen) + 1e-9);
  });

  it('samples the threshold on every frame of a whole run and finds no increase after the boundary', () => {
    const r = rig();
    r.songTime.value = 0;
    r.hold(0, 0.6);
    r.rep(0.25);
    r.rep(0.3);
    r.songTime.value = WARMUP_SEC + 0.1;
    r.push(0);
    const afterBoundary = r.threshold()!;
    let worst = -Infinity;
    for (let i = 0; i < 20; i++) {
      r.rep(0.4 + i * 0.03);
      r.songTime.value += 2;
      const t = r.threshold()!;
      worst = Math.max(worst, t);
    }
    expect(worst).toBeLessThanOrEqual(afterBoundary + 1e-9);
  });

  /**
   * The other half of the direction rule: a range the therapist MEASURED is better evidence than one
   * gathered while chasing notes, so it is replaced only when doing so makes the target easier.
   */
  it('lowers a deliberately measured range when the patient cannot reach it today, and never raises one', () => {
    const measured = (max: number): RomCalibration => ({
      min: featureAt(0),
      max,
      samples: 300,
      movement: 'hand_open_close',
      mirrored: false,
      patient: PATIENT,
      measurement: {
        method: 'rom_screen', frames: 300, tracked: 300, trackedFraction: 1,
        fpsMedian: 30, fpsLow: 29, durationSec: 10, reps: 3, repSpread: 0.01, repSpreadFraction: 0.02,
      },
    });

    // (a) A bad day: the saved range is the whole hand, today the patient reaches half of it.
    const worse = rig([measured(featureAt(1))]);
    const before = worse.threshold()!;
    worse.songTime.value = 0;
    worse.hold(0, 0.6);
    worse.rep(0.5);
    worse.rep(0.5);
    worse.songTime.value = WARMUP_SEC + 0.1;
    worse.push(0);
    expect(worse.threshold()!).toBeLessThan(before);

    // (b) A good day: the saved range is modest, today the patient goes well past it. The target
    // stays where the therapist measured it — the record keeps a denominator they can defend, and
    // the extra range is still measured (rawStrength is unclamped) rather than moving the goalposts.
    const better = rig([measured(featureAt(0.5))]);
    const kept = better.threshold()!;
    better.songTime.value = 0;
    better.hold(0, 0.6);
    better.rep(1);
    better.rep(1);
    better.songTime.value = WARMUP_SEC + 0.1;
    better.push(0);
    expect(better.threshold()!).toBeCloseTo(kept, 9);
  });

  it('gives a lane the camera never saw its first range even after the boundary — it had none to raise', () => {
    const r = rig();
    r.songTime.value = WARMUP_SEC + 5;
    r.push(0);
    expect(r.threshold()).toBeNull();
    // The limb finally comes into frame.
    r.hold(0, 0.6);
    r.rep(0.4);
    expect(r.threshold()).not.toBeNull();
  });
});

describe('what the record is handed', () => {
  it('stamps every in-song range with the method, the patient, the lane’s mirror convention and the session', () => {
    const r = rig();
    r.songTime.value = 0;
    r.hold(0, 0.6);
    r.rep(0.5);
    r.rep(0.55);
    r.songTime.value = WARMUP_SEC + 0.1;
    r.push(0);
    const [cal] = r.cal.ranges();
    expect(cal).not.toBeNull();
    expect(cal!.measurement?.method).toBe('in_song');
    expect(cal!.patient).toBe(PATIENT);
    expect(cal!.mirrored).toBe(false);
    expect(cal!.sessionId).toBe('sess-1');
    expect(cal!.movement).toBe('hand_open_close');
    // The top is never above a value this patient actually produced.
    expect(cal!.max).toBeLessThanOrEqual(featureAt(0.55) + 1e-9);
  });

  it('hands back the range that was IN FORCE, which is what the percentages are of', () => {
    const r = rig();
    r.songTime.value = 0;
    r.hold(0, 0.6);
    r.rep(0.4);
    r.rep(0.4);
    r.songTime.value = WARMUP_SEC + 0.1;
    r.push(0);
    const inForce = r.vision.getLaneDebug()[0].calibration!;
    expect(r.cal.ranges()[0]).toEqual(inForce);
  });

  it('reports the lane state a screen would print', () => {
    const r = rig();
    r.hold(0, 0.6);
    const [state] = r.cal.states();
    expect(state.source).toBe('provisional');
    expect(state.frozen).toBe(false);
    expect(state.refused).toBeNull();
  });
});

describe('the prescription says which path it is on', () => {
  it('reads a prescription with no choice recorded as the measured one — that is what it ran', () => {
    expect(calibrationModeOf({})).toBe('measured');
    expect(calibrationModeOf({ calibrationMode: 'in_song' })).toBe('in_song');
  });

  it('folds the latency metronome in on the in-song path only', () => {
    expect(foldsInLatencyStep('in_song')).toBe(true);
    expect(foldsInLatencyStep('measured')).toBe(false);
  });
});
