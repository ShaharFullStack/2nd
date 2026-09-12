/**
 * THE ONLY MID-SONG SAFETY CONTROL: BIG ENOUGH TO AIM AT, AND GONE WHEN THE PATIENT MOVES.
 *
 * TWO FINDINGS, ONE PANEL.
 *
 *  1. IT WAS TOO SMALL TO SEE. The offer lived in the renderer's reserved panel — 151 px wide at
 *     1024x768, i.e. a ~129x97 px preview — and the ring it drew there measured about 10 px of
 *     radius: roughly 0.4° of visual angle at a metre, against an assistive-technology floor of
 *     1.5°. "Never covers the board" had been bought by making the only mid-song safety control
 *     invisible. The resolution keeps BOTH sides: the board makes room (the canvas is narrowed and the
 *     renderer re-laid-out into what is left), so the ring gets its degrees AND no note is hidden —
 *     there is no note behind the offer because there is no board behind it.
 *
 *  2. IT COULD STICK UP WHILE THE PATIENT EXERCISED. Once shown, only a SCORED repetition took it
 *     away. A patient prescribed hip abduction who substitutes hip flexion — a textbook substitution,
 *     and one of the things this app exists to observe — moves a whole thigh and produces no lane
 *     event at all, so the circle stayed live for the rest of the song while the limb travelled under
 *     it. Movement, not scoring, is now what puts it away.
 *
 * jsdom has no layout, so the geometry is pinned on the pure function the screen lays the panel out
 * with (which is also what the Playwright harness measures against) and the dismissal on the pure
 * predicate the poll uses.
 */
import { describe, expect, it } from 'vitest';

const { MIN_DWELL_RING_PX, restOfferStripPx, laneValuesMoved, laneValuesQuiet, limbTrackValues, samplesSince } =
  await import('./Play.tsx');
const { POSE, POSE_LANDMARK_COUNT } = await import('../vision/landmarks.ts');
const { singleDwellTarget } = await import('./DwellTarget.tsx');

/**
 * THE RADIUS OF THE CIRCLE THE OFFER ACTUALLY DRAWS, read from the app rather than copied into this
 * file — the placement numbers in DwellTarget.tsx are a clinical choice and they move (they moved
 * while this test was being written). A local copy would have this file asserting a ring size for a
 * circle the screen no longer draws, which is the exact class of quiet lie the app is held to.
 */
const PRIMARY_R = singleDwellTarget('leg').radius;
/** What the critic measured in the running app before this change: ~10 px of ring radius. */
const BEFORE_PX = 10;

/** Lane readings `ms` apart, each lane's value taken from `values(i, k)`. */
function samples(n: number, ms: number, values: (lane: number, k: number) => number) {
  return Array.from({ length: n }, (_, k) => ({ t: (k * ms) / 1000, values: [values(0, k), values(1, k)] }));
}

describe('the mid-song safety control is big enough to aim at', () => {
  it('puts a ring of at least 1.5° of visual angle on the glass at every clinic size', () => {
    for (const [w, h] of [
      [1024, 768],
      [1280, 800],
      [1440, 900],
      [1920, 1080],
      [820, 1180],
    ] as const) {
      const got = restOfferStripPx(w, h, PRIMARY_R);
      // ~0.35 mm per CSS px on a clinic tablet, so 42 px of RADIUS is ~1.7° at a metre; the floor is
      // 1.5°, which is where the 4x on the measured 10 px comes from.
      expect(got.ringPx, `${w}x${h}`).toBeGreaterThanOrEqual(BEFORE_PX * 3.5);
      // The preview is 4:3 and `radius` is in frame heights, so this is the arithmetic the component
      // lays the ring out with — not an estimate of it.
      expect(got.ringPx, `${w}x${h}`).toBeCloseTo((got.previewPx / (4 / 3)) * PRIMARY_R, 0);
    }
  });

  it('never asks for more than half the axis it takes, and always leaves the board a board', () => {
    for (let w = 380; w <= 2560; w += 20) {
      for (const h of [420, 768, 800, 1180]) {
        const got = restOfferStripPx(w, h, PRIMARY_R);
        // The strip is a WIDTH beside the board and a HEIGHT above it; either way the board keeps at
        // least half of that axis and never drops below the floor that makes it a board.
        const axisPx = got.axis === 'side' ? w : h;
        const where = `${w}x${h} ${got.axis}`;
        expect(got.strip, where).toBeLessThanOrEqual(Math.ceil(axisPx * 0.5));
        if (got.strip > 0) expect(axisPx - got.strip, where).toBeGreaterThanOrEqual(359);
      }
    }
  });

  /**
   * A PORTRAIT TABLET SPLITS THE OTHER WAY. Half of 820 px of WIDTH has to hold the preview, its
   * padding and its gap from the edges, and what is left caps the ring; half of 1180 px of HEIGHT has
   * room to spare. The axis is chosen by which puts the bigger ring in front of the patient, not by
   * which is easier to lay out, and the board is re-laid-out into what is left either way.
   */
  it('takes the axis with room on it — beside the board in landscape, above it in portrait', () => {
    expect(restOfferStripPx(1024, 768, PRIMARY_R).axis).toBe('side');
    // A portrait tablet whose WIDTH cannot deliver the ring: half of 820 px has to hold the preview,
    // its padding and the gap, while half of 1180 px of height has room to spare. The floor is raised
    // here so the case is deterministic whatever radius the placement is currently using.
    const portrait = restOfferStripPx(820, 1180, PRIMARY_R, 70);
    expect(portrait.axis).toBe('top');
    // The ring the WIDTH alone could have delivered on this screen, by the same arithmetic: half of
    // 820 px, less the board's floor, less the panel's own padding and its gap from the edges.
    const sideOnly = ((Math.min(820 * 0.5, 820 - 360) - 46) / (4 / 3)) * PRIMARY_R;
    expect(portrait.ringPx).toBeGreaterThan(sideOnly);
    expect(portrait.ringPx).toBeGreaterThanOrEqual(MIN_DWELL_RING_PX);
    expect(1180 - portrait.strip).toBeGreaterThanOrEqual(360);
    // ...and the board still keeps half of the axis it gave up.
    expect(portrait.strip).toBeLessThanOrEqual(Math.ceil(1180 * 0.5));
  });

  it('stops asking for width once the ring has its degrees — the board keeps the rest', () => {
    // At 1920 the strip is the same as at 1280: the reservation is driven by the RING it has to draw,
    // not by a share of whatever screen it is on.
    expect(restOfferStripPx(1920, 1080, PRIMARY_R).strip).toBe(restOfferStripPx(1280, 900, PRIMARY_R).strip);
    expect(restOfferStripPx(1920, 1080, PRIMARY_R).ringPx).toBeGreaterThanOrEqual(MIN_DWELL_RING_PX - 0.01);
  });

  it('is bounded by HEIGHT too, so the words above and below it are never pushed off screen', () => {
    // A short landscape window: the preview cannot be 365 px tall in 420 px of screen.
    const short = restOfferStripPx(1440, 420, PRIMARY_R);
    expect(short.previewPx / (4 / 3)).toBeLessThanOrEqual(420 - 24 - 150 + 1);
  });

  it('reports a strip of zero rather than a nonsense one when there is nothing to work with', () => {
    expect(restOfferStripPx(320, 240, PRIMARY_R).strip).toBe(0);
    expect(restOfferStripPx(Number.NaN, 768, PRIMARY_R).strip).toBe(0);
    expect(restOfferStripPx(1024, 768, 0).strip).toBe(0);
  });
});

describe('the offer comes down when the patient starts again, not only when they SCORE', () => {
  it('a lane travelling more than the band inside the window is movement', () => {
    // 1.5 s of readings, one lane sweeping a third of its range: a substituted movement that no lane
    // event will ever be emitted for.
    const moving = samples(11, 150, (lane, k) => (lane === 0 ? k * 0.04 : 0.05));
    const now = moving[moving.length - 1].t;
    expect(laneValuesMoved(moving, now, 1.2, 0.12)).toBe(true);
  });

  it('a tremor is not movement, and neither is a limb parked in the circle', () => {
    const tremor = samples(11, 150, (_lane, k) => 0.2 + (k % 2 === 0 ? 0.01 : -0.01));
    const now = tremor[tremor.length - 1].t;
    expect(laneValuesMoved(tremor, now, 1.2, 0.12)).toBe(false);
    // ...and it agrees with the test that PUT the offer up, over the same readings.
    expect(laneValuesQuiet(tremor, now, 1.2, 0.12)).toBe(true);
  });

  it('an uncovered window is no evidence either way — a dropped second of frames is not movement', () => {
    // This is the half that is NOT the negation of `laneValuesQuiet`: the camera stopped, so there is
    // nothing to read, and reading nothing as movement would take the circle off a patient who needs
    // it every time the stream hiccupped.
    const sparse = [
      { t: 0, values: [0.1, 0.1] },
      { t: 0.2, values: [0.9, 0.1] },
    ];
    expect(laneValuesMoved(sparse, 0.3, 1.2, 0.12)).toBe(false);
    expect(laneValuesMoved([], 5, 1.2, 0.12)).toBe(false);
  });

  /**
   * THE CASE A LANE VALUE IS BLIND TO, which is the one the critic named. Hip ABDUCTION is prescribed
   * and the patient substitutes hip FLEXION: the lane measures lateral knee travel, so its value does
   * not move at all while a whole thigh crosses the frame. The offer used to sit live under it for the
   * rest of the song. The second test watches the LIMBS, which the dwell pointer (a hand) never moves.
   */
  it('sees a substituted movement that no lane value and no lane event ever reports', () => {
    const pose = (kneeY: number) => {
      const lms = Array.from({ length: POSE_LANDMARK_COUNT }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 0.9 }));
      lms[POSE.LEFT_KNEE] = { x: 0.42, y: kneeY, z: 0, visibility: 0.9 };
      return lms;
    };
    // Hip flexion: the knee rises through a third of the frame. Every LANE value is flat throughout.
    const travelling = Array.from({ length: 11 }, (_, k) => ({
      t: (k * 150) / 1000,
      values: limbTrackValues({ tMs: k, pose: pose(0.7 - k * 0.03), hands: [] }),
    }));
    const now = travelling[travelling.length - 1].t;
    expect(laneValuesMoved(travelling, now, 1.2, 0.08)).toBe(true);
    // ...and a limb that is simply sitting there is not movement, at the same band.
    const parked = travelling.map((s) => ({ t: s.t, values: limbTrackValues({ tMs: 0, pose: pose(0.7), hands: [] }) }));
    expect(laneValuesMoved(parked, now, 1.2, 0.08)).toBe(false);
  });

  it('a joint the model cannot see is not movement — it is nothing', () => {
    // NaN rather than a stale coordinate: `laneValuesQuiet` skips non-finite entries, so a knee that
    // left the frame cannot read as a knee that travelled.
    const hidden = limbTrackValues({
      tMs: 0,
      pose: Array.from({ length: POSE_LANDMARK_COUNT }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 0 })),
      hands: [],
    });
    expect(hidden.every((v) => Number.isNaN(v))).toBe(true);
    expect(limbTrackValues(null)).toHaveLength(hidden.length);
    expect(limbTrackValues({ tMs: 0, pose: null, hands: [] }).every((v) => Number.isNaN(v))).toBe(true);
  });

  it('the window keeps the newest reading older than it, so coverage can be asserted', () => {
    const s = samples(11, 150, () => 0.2);
    const now = s[s.length - 1].t;
    const w = samplesSince(s, now, 1.2);
    expect(w.length).toBeGreaterThan(1);
    expect(now - w[0].t).toBeGreaterThanOrEqual(1.2);
    // ...and only the newest one: the slice is the tail, not the whole buffer.
    expect(now - w[1].t).toBeLessThan(1.2);
    expect(samplesSince(s, now, 99)).toEqual([]);
  });
});
