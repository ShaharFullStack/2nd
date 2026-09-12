/**
 * THE GATE ON THE MID-SONG STOP: "the prescribed exercise is not happening right now".
 *
 * A dwell target live on the play screen for the whole song is a target the exercise itself can
 * press — a seated march with hip drift parks a knee in a circle, and three minutes of repetitions is
 * three minutes of chances at ending somebody's session. So the offer exists only across stretches in
 * which no repetition fired AND no lane's value moved by as much as a fraction of that patient's own
 * calibrated range. This is the test that decides that, frame by frame, with no screen around it.
 */
import { describe, expect, it } from 'vitest';
import { laneValuesQuiet } from './Play.tsx';
import type { LaneValueSample } from './Play.tsx';

const STILL = 7;
const BAND = 0.12;

/** A window of samples at 150 ms, each lane driven by `f(lane, seconds)`. */
function window(seconds: number, f: (lane: number, t: number) => number, lanes = 2): LaneValueSample[] {
  const out: LaneValueSample[] = [];
  for (let t = 0; t <= seconds + 1e-9; t += 0.15) {
    out.push({ t, values: Array.from({ length: lanes }, (_, l) => f(l, t)) });
  }
  return out;
}
const endOf = (s: LaneValueSample[]) => s[s.length - 1].t;

describe('what counts as "not doing the exercise"', () => {
  it('a limb at rest for the whole window is quiet', () => {
    const s = window(8, () => 0.04);
    expect(laneValuesQuiet(s, endOf(s), STILL, BAND)).toBe(true);
  });

  it('a tremor is not a repetition — a limb that will not be still is still not exercising', () => {
    // ±0.04 of the range at 4 Hz: never still, never a rep. A patient with a tremor is exactly the
    // patient who cannot be told "hold still to be offered a way out".
    const s = window(8, (_l, t) => 0.1 + 0.04 * Math.sin(t * 8 * Math.PI));
    expect(laneValuesQuiet(s, endOf(s), STILL, BAND)).toBe(true);
  });

  it('a repetition on ANY lane is not quiet — one working limb is a patient who is working', () => {
    const s = window(8, (l, t) => (l === 1 ? 0.03 : 0.5 * (1 + Math.sin(t * 1.2))));
    expect(laneValuesQuiet(s, endOf(s), STILL, BAND)).toBe(false);
  });

  it('a slow reach that crosses the band counts as movement even without a rep', () => {
    const s = window(8, (_l, t) => 0.02 + t * 0.05);
    expect(laneValuesQuiet(s, endOf(s), STILL, BAND)).toBe(false);
  });

  it('a window that is not yet covered is NOT evidence of stillness', () => {
    const s = window(4, () => 0.02);
    expect(laneValuesQuiet(s, endOf(s), STILL, BAND)).toBe(false);
    // ...and neither is a single reading, however still it looks.
    expect(laneValuesQuiet([{ t: 0, values: [0, 0] }], 30, STILL, BAND)).toBe(false);
  });

  it('one reading can never cover a window, however long ago it was taken', () => {
    // The shape of an argument this must not accept: "nothing has changed since the last sample, and
    // the last sample was a minute ago, so the patient has been still for a minute". A single reading
    // is not a window; a camera that stopped delivering is not a patient holding still. (In the app
    // the second guard is the tracking check — a limb that is not in frame is not a still limb.)
    expect(laneValuesQuiet([{ t: 0, values: [0.02, 0.02] }], 60, STILL, BAND)).toBe(false);
  });

  it('a lane the camera is not reporting does not vote either way', () => {
    const s = window(8, (l, t) => (l === 1 ? Number.NaN : 0.03 + 0.01 * Math.sin(t)));
    expect(laneValuesQuiet(s, endOf(s), STILL, BAND)).toBe(true);
  });

  it('the band is exclusive at the edge: a movement of exactly the band is movement', () => {
    const s = window(8, (_l, t) => (t < 4 ? 0 : BAND));
    expect(laneValuesQuiet(s, endOf(s), STILL, BAND)).toBe(false);
    const under = window(8, (_l, t) => (t < 4 ? 0 : BAND * 0.9));
    expect(laneValuesQuiet(under, endOf(under), STILL, BAND)).toBe(true);
  });
});
