/**
 * What the hands-free target DRAWS and WHERE IT PUTS IT — the half of this feature that no amount of
 * dwell maths can get right on its own.
 *
 * Four of these are load-bearing rather than decorative:
 *
 *  - WHERE THE TARGET IS. A circle placed where a limb already rests is not a confirm gesture, it is a
 *    trap: the ROM pair used to sit 0.1804 frame-heights from the seated fixture's resting knee with an
 *    exit radius of 0.2175, so a patient who reached the target and then RELAXED could not stop the
 *    ring filling. "Placement" tests below measure every circle the screens place against the resting
 *    position of every limb `dwellLimbs` can return, in both modes, including the hysteresis band.
 *  - WHAT IT COSTS TO REACH. The app prescribes the posture ("rest your forearm on the table with your
 *    palm facing the camera") and then has to be holdable FROM it, by an affected limb, late in a
 *    fatigued session. The lift a target demands is measured here, against the rest the fixtures
 *    describe, not asserted in a comment.
 *  - THE MIRROR, AND THE CROP. The preview is always CSS-mirrored (that is what a patient expects of a
 *    camera) and the landmarks are not; and `.camera-frame` is a 4:3 box with `object-fit: cover`, so
 *    on the 16:9 sensor most laptops actually hand back, 12.5 % of each side of the frame is not on the
 *    glass at all. A target drawn without accounting for either lands on the opposite side of the
 *    frame, or half a radius from where it is measured — bugs that are invisible to every unit test and
 *    to a symmetric test pattern, and obvious the moment a person sits in the chair.
 *  - "NOT TRACKED" IS A STATE, NOT AN ABSENCE. A ring that has simply stopped filling looks exactly
 *    like one the patient is not holding still enough for. It has to say which, without relying on
 *    colour, because this is drawn for a patient at two metres with the vision they have.
 */
import { describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import {
  DwellLegend,
  DwellTarget,
  PREVIEW_ASPECT,
  dwellCadence,
  pairedDwellTargets,
  previewPlacement,
  singleDwellTarget,
  toneOf,
} from './DwellTarget.tsx';
import type { DwellChoice, DwellSession } from './DwellTarget.tsx';
import { DWELL_DEFAULTS, dwellDistance, dwellLimbs, dwellTargetsOverlap, retargetForAspect } from '../vision/dwell.ts';
import type { DwellCircle, DwellPoint, DwellState } from '../vision/dwell.ts';
import { handPose, reNormalizeAspect, seatedPose, translateLandmarks } from '../vision/fixtures.ts';
import { POSE } from '../vision/landmarks.ts';
import type { Landmark } from '../vision/landmarks.ts';
import type { DetectionResult } from '../vision/mediapipe.ts';
import type { Mode } from '../engine/types.ts';
import { useStore } from '../state/store.ts';

function state(over: Partial<DwellState> = {}): DwellState {
  return {
    progress: 0,
    inside: false,
    withinEntry: false,
    tracked: true,
    holding: false,
    confirmed: false,
    confirmations: 0,
    blocked: null,
    pointer: { x: 0.5, y: 0.5 },
    lostSec: 0,
    remainingSec: DWELL_DEFAULTS.holdSec,
    target: { x: 0.27, y: 0.3, radius: 0.15 },
    xScale: PREVIEW_ASPECT,
    ...over,
  };
}

const CHOICE: DwellChoice = {
  id: 'go',
  target: { x: 0.27, y: 0.3, radius: 0.15 },
  label: 'Continue',
  onConfirm: () => {},
};

function draw(over: Partial<DwellState> | null, choice: DwellChoice = CHOICE, reducedMotion = false) {
  cleanup();
  render(
    <DwellTarget
      choice={choice}
      state={over === null ? undefined : state({ target: choice.target, ...over })}
      reducedMotion={reducedMotion}
      xScale={PREVIEW_ASPECT}
      testId="t"
    />,
  );
  return screen.getByTestId('t');
}

/* ================= where the targets go ================= */

/** Every circle the screens actually place, per mode. */
function placements(mode: Mode): DwellCircle[] {
  return [singleDwellTarget(mode), ...pairedDwellTargets(mode)];
}

/**
 * A RESTING BODY, as this repo describes one, in a frame of aspect `aspect`.
 *
 * The rigs in src/vision/fixtures.ts are the same ones the vision unit tests and the hands-free critic
 * harness drive, and they are read here through `dwellLimbs` — so what is measured is exactly what the
 * tracker would be handed, palm centroid and all, not a landmark picked by this test.
 *
 * The sweeps are the things a clinic varies and the app does not control: where the limb sits across
 * the frame, how big it is in frame (how close the camera is), which of the two prescribed hand
 * postures is in force, and a small vertical framing shift. They are deliberately generous: the cost
 * of a wide envelope is a slightly bigger reach, and the cost of a narrow one is a false confirm.
 */
const FRAMING_SHIFT = 0.05;

function handRests(aspect: number): Array<{ what: string; point: DwellPoint }> {
  const out: Array<{ what: string; point: DwellPoint }> = [];
  for (const centerX of [0.2, 0.35, 0.5, 0.65, 0.72, 0.8]) {
    for (const scale of [0.8, 1, 1.15, 1.3]) {
      // undefined = palm to the camera (the default posture); 0 = hand over the table edge; 0.5 between.
      for (const wristExtension of [undefined, 0, 0.5]) {
        for (const openness of [0, 1]) {
          for (const dy of [-FRAMING_SHIFT, 0, FRAMING_SHIFT]) {
            const raw = translateLandmarks(handPose({ centerX, scale, wristExtension, openness }), 0, dy);
            const hands = [{ landmarks: reNormalizeAspect(raw, PREVIEW_ASPECT, aspect), label: 'Left', score: 0.95 }];
            const result: DetectionResult = { tMs: 0, pose: null, hands };
            for (const limb of dwellLimbs(result, 'hand', false)) {
              out.push({ what: `palm centre (x ${centerX}, scale ${scale}, ext ${String(wristExtension)}, dy ${dy})`, point: limb.point });
            }
          }
        }
      }
    }
  }
  return out;
}

/**
 * The seated figure's knees — and its hands, which `seatedPose` does not model at all: every landmark
 * it does not place sits at the rig's placeholder (0.5, 0.2). That placeholder IS what dwellLimbs gets
 * handed by the fixtures (and by the critic harness), so it is included as-is; on top of it the hands
 * are put where a seated patient's hands actually are — on the lap, the thighs or the chair arms —
 * across the whole band those could occupy. A leg-mode target has to clear all of it.
 */
function legRests(aspect: number): Array<{ what: string; point: DwellPoint }> {
  const out: Array<{ what: string; point: DwellPoint }> = [];
  const push = (what: string, pose: Landmark[]) => {
    const result: DetectionResult = { tMs: 0, pose: reNormalizeAspect(pose, PREVIEW_ASPECT, aspect), hands: [] };
    for (const limb of dwellLimbs(result, 'leg', false)) out.push({ what: `${what} — ${limb.label}`, point: limb.point });
  };
  for (const dx of [-0.06, 0, 0.06]) {
    for (const dy of [-0.06, 0, 0.06]) {
      // A chair scoot or a camera bump: the whole scene moves, the patient does not.
      push(`seated at rest (dx ${dx}, dy ${dy})`, translateLandmarks(seatedPose(), dx, dy));
      // Resting stance: knees a little apart or a little together.
      for (const abduction of [-0.3, 0.3]) {
        push(`seated, knees ${abduction > 0 ? 'apart' : 'together'} (dx ${dx}, dy ${dy})`, translateLandmarks(seatedPose({ abduction, side: 'left' }), dx, dy));
        push(`seated, knees ${abduction > 0 ? 'apart' : 'together'} (dx ${dx}, dy ${dy})`, translateLandmarks(seatedPose({ abduction, side: 'right' }), dx, dy));
      }
    }
  }
  for (const x of [0.25, 0.4, 0.5, 0.6, 0.72, 0.8]) {
    for (const y of [0.5, 0.62, 0.75, 0.9]) {
      const pose = seatedPose();
      pose[POSE.LEFT_WRIST] = { x, y, z: 0, visibility: 0.95 };
      pose[POSE.RIGHT_WRIST] = { x: 1 - x, y, z: 0, visibility: 0.95 };
      push(`hands at rest on the lap or chair arms (${x}, ${y})`, pose);
    }
  }
  return out;
}

const RESTS: Readonly<Record<Mode, (aspect: number) => Array<{ what: string; point: DwellPoint }>>> = {
  hand: handRests,
  leg: legRests,
};

/**
 * How much clear water is demanded between the activation region and a resting limb: 0.03 of a frame
 * height, which on a preview framed on a seated patient is a couple of centimetres. Disjoint is the
 * requirement; the margin is there so that "disjoint" does not mean "by a landmark's worth of noise".
 */
const MARGIN = 0.03;
/** The aspects the app can actually be handed: a square sensor, the 4:3 it asks for, the 16:9 it gets. */
const ASPECTS = [1, 4 / 3, 16 / 9];

describe('placement: no target may overlap where a limb rests', () => {
  for (const mode of ['hand', 'leg'] as const) {
    it(`${mode} mode: every circle, entry radius AND hysteresis band, clears every resting limb`, () => {
      for (const aspect of ASPECTS) {
        const rests = RESTS[mode](aspect);
        expect(rests.length).toBeGreaterThan(20);
        for (const target of placements(mode)) {
          const circle = retargetForAspect(target, aspect);
          const exit = circle.radius * DWELL_DEFAULTS.exitRatio;
          let worst = { d: Infinity, what: '' };
          for (const rest of rests) {
            const d = dwellDistance(rest.point, circle, aspect);
            if (d < worst.d) worst = { d, what: rest.what };
          }
          expect(
            worst.d,
            `${mode} @${aspect.toFixed(2)} target ${JSON.stringify(target)}: nearest rest is ${worst.what} at ${worst.d.toFixed(4)}, exit radius ${exit.toFixed(4)}`,
          ).toBeGreaterThan(exit + MARGIN);
        }
      }
    });
  }

  it('the old placement fails this test — which is why it is here', () => {
    // The ROM pair as it shipped: (0.73, 0.55) r 0.15 with exitRatio 1.45, against the same fixtures.
    const old: DwellCircle = { x: 0.73, y: 0.55, radius: 0.15 };
    const nearest = Math.min(...legRests(PREVIEW_ASPECT).map((r) => dwellDistance(r.point, old, PREVIEW_ASPECT)));
    expect(nearest).toBeLessThan(old.radius * 1.45);
    // …and the single leg target used to be drawn straight on top of both resting knees.
    const oldSingle: DwellCircle = { x: 0.5, y: 0.55, radius: 0.18 };
    expect(dwellDistance({ x: 0.6, y: 0.6 }, oldSingle, PREVIEW_ASPECT)).toBeLessThan(oldSingle.radius);
  });

  it('a limb at rest is not merely outside: it cannot start a hold from there either', () => {
    // Nothing at rest is even inside the drawn circle, so no ring anywhere is filling when the screen
    // opens and nobody has moved.
    for (const mode of ['hand', 'leg'] as const) {
      for (const target of placements(mode)) {
        for (const rest of RESTS[mode](PREVIEW_ASPECT)) {
          expect(dwellDistance(rest.point, target, PREVIEW_ASPECT), `${mode} ${rest.what}`).toBeGreaterThan(target.radius);
        }
      }
    }
  });
});

describe('reach: the hold has to be performable from the posture the app prescribes', () => {
  /** The nearest point of a circle to `p`, and the lift (upward y travel) needed to get there. */
  function approach(p: DwellPoint, c: DwellCircle, aspect: number) {
    const d = dwellDistance(p, c, aspect);
    const edge = { x: c.x + (p.x - c.x) * (c.radius / d), y: c.y + (p.y - c.y) * (c.radius / d) };
    return { travel: d - c.radius, lift: p.y - edge.y };
  }

  it('hand mode: the lift off the table is smaller than it was, and out of the upper third', () => {
    // The prescribed rest: forearm on the table, palm to the camera (fixtures.handPose default).
    const rest = handRests(PREVIEW_ASPECT).find((r) => r.what === 'palm centre (x 0.5, scale 1, ext undefined, dy 0)')!;
    expect(rest.point.y).toBeCloseTo(0.63, 2);

    const now = approach(rest.point, singleDwellTarget('hand'), PREVIEW_ASPECT);
    // What it used to be: the single target at (0.5, 0.3) r 0.18 — straight up, unsupported, in the
    // upper third of the frame; and the pair at (0.73, 0.3) r 0.15, 0.45 frame-heights from the palm.
    const beforePair = approach(rest.point, { x: 0.73, y: 0.3, radius: 0.15 }, PREVIEW_ASPECT);
    expect(dwellDistance(rest.point, { x: 0.73, y: 0.3, radius: 0.15 }, PREVIEW_ASPECT)).toBeCloseTo(0.4505, 3);
    expect(now.travel).toBeLessThan(beforePair.travel);
    expect(now.lift).toBeLessThan(beforePair.lift);
    // No target asks the patient to hold a hand in the upper third of the frame.
    for (const target of placements('hand')) expect(target.y + target.radius).toBeGreaterThan(1 / 3);
    // And the lift is bounded: a raise of about a fifth of the frame height, the rest of the movement
    // being a slide out to the side, which the table carries.
    expect(now.lift).toBeLessThan(0.2);
    expect(now.lift).toBeGreaterThan(0.1); // …and it is a real move, not a twitch
  });

  it('leg mode: a raised hand reaches it easily, and a knee can still get there', () => {
    const target = singleDwellTarget('leg');
    // A hand resting in the lap, raised: no exercise, no holding a limb against gravity in a posture
    // the prescription cares about. This is why leg mode follows hands as well as knees.
    const lap: DwellPoint = { x: 0.6, y: 0.65 };
    expect(approach(lap, target, PREVIEW_ASPECT).travel).toBeLessThan(0.3);

    // The knee path, stated rather than assumed: the smallest seated-march lift (with the knee out to
    // the side) that lands inside the circle. It is a real movement — which is why the hand is offered
    // first — but it is within the range this app already asks a patient to produce three times per
    // lane during calibration.
    let best: { lift: number; abduction: number } | null = null;
    for (let lift = 0; lift <= 1.0001; lift += 0.05) {
      for (let abduction = 0; abduction <= 1.0001; abduction += 0.05) {
        const pose = seatedPose({ kneeLift: lift, abduction, side: 'left' });
        const knee = pose[POSE.LEFT_KNEE];
        if (dwellDistance(knee, target, PREVIEW_ASPECT) <= target.radius && (!best || lift < best.lift)) {
          best = { lift, abduction };
        }
      }
    }
    expect(best).not.toBeNull();
    expect((best as { lift: number }).lift).toBeLessThanOrEqual(0.6);
  });
});

/* ================= drawn is measured ================= */

describe('the circle tested is the circle drawn', () => {
  /** Where the ring lands, in pixels, inside a preview box of `boxW` x `boxH`. */
  function drawnRing(el: HTMLElement, boxW: number, boxH: number) {
    const heightPct = Number.parseFloat(el.style.height);
    const elementH = (heightPct / 100) * boxH;
    return {
      cx: (Number.parseFloat(el.style.left) / 100) * boxW,
      cy: (Number.parseFloat(el.style.top) / 100) * boxH,
      // The SVG viewBox is 176 tall and the ring radius is 46 of it.
      r: (46 / 176) * elementH,
    };
  }

  /**
   * Where a landmark lands on the glass: the <video> is `object-fit: cover` in a 4:3 box, so a 16:9
   * frame is scaled to the box HEIGHT and 12.5 % is cropped off each side.
   */
  function drawnLandmark(p: DwellPoint, aspect: number, boxW: number, boxH: number) {
    const visX = Math.min(1, PREVIEW_ASPECT / aspect);
    const visY = Math.min(1, aspect / PREVIEW_ASPECT);
    return { x: (1 - (p.x - (1 - visX) / 2) / visX) * boxW, y: ((p.y - (1 - visY) / 2) / visY) * boxH };
  }

  const BOX_W = 800;
  const BOX_H = 600;

  for (const aspect of ASPECTS) {
    it(`holds on a ${aspect === 1 ? '1:1' : aspect === 4 / 3 ? '4:3' : '16:9'} sensor: every point the tracker calls inside is drawn inside`, () => {
      const authored = singleDwellTarget('hand');
      const circle = retargetForAspect(authored, aspect);
      cleanup();
      render(<DwellTarget choice={{ ...CHOICE, target: authored }} state={state({ target: circle, xScale: aspect })} testId="t" />);
      const ring = drawnRing(screen.getByTestId('t'), BOX_W, BOX_H);

      // One frame HEIGHT in pixels: on a frame taller than the box, cover scales it up and part of it
      // is off the glass, so this is not the box height.
      const perHeight = BOX_H * previewPlacement(circle, aspect).heightScale;

      // A grid of places a limb could be, tested both ways: what the tracker decides and what the
      // patient can see must never disagree.
      let checked = 0;
      for (let x = 0.15; x <= 0.85; x += 0.025) {
        for (let y = 0.1; y <= 0.9; y += 0.025) {
          const p = { x, y };
          const where = `${x.toFixed(3)},${y.toFixed(3)} @${aspect.toFixed(2)}`;
          const measured = dwellDistance(p, circle, aspect);
          const drawn = drawnLandmark(p, aspect, BOX_W, BOX_H);
          const drawnPx = Math.hypot(drawn.x - ring.cx, drawn.y - ring.cy);
          // The same distance, in the same units, to within a rounding of the inline percentages.
          expect(drawnPx / perHeight, where).toBeCloseTo(measured, 3);
          // …and therefore the same verdict. Points within a pixel of the edge are the rounding of the
          // inline percentages, not a disagreement, so the classification is asserted off the boundary.
          if (Math.abs(measured - circle.radius) < 0.005) continue;
          checked += 1;
          expect(drawnPx <= ring.r, where).toBe(measured <= circle.radius);
        }
      }
      expect(checked).toBeGreaterThan(500);
      // …and the ring is the size the target says, in frame heights.
      expect(ring.r / perHeight).toBeCloseTo(circle.radius, 3);
    });
  }

  it('a 16:9 sensor moves the drawn ring — the old fixed 4:3 was out by half a pair radius', () => {
    // Detector x 0.27 on a 16:9 frame is CSS-left 19.3 % of the box, not 27 %: the crop takes 12.5 %
    // off each side. Drawing it at 27 % (as a hard-coded 4:3 did) puts the ring 0.058 of the frame
    // width from where the tracker is testing — half the radius of a pair target.
    const placed = previewPlacement({ x: 0.27, y: 0.5, radius: 0.12 }, 16 / 9);
    expect(placed.x).toBeCloseTo((0.27 - 0.125) / 0.75, 6);
    expect(Math.abs(placed.x - 0.27)).toBeGreaterThan(0.07);
    expect(placed.heightScale).toBe(1);
  });

  it('a taller-than-4:3 frame is cropped top and bottom instead, and the ring grows with it', () => {
    const placed = previewPlacement({ x: 0.5, y: 0.4, radius: 0.12 }, 1);
    expect(placed.x).toBe(0.5);
    expect(placed.y).toBeCloseTo((0.4 - 0.125) / 0.75, 6);
    expect(placed.heightScale).toBeCloseTo(4 / 3, 6);
  });

  it('falls back to the authored 4:3 frame when there is no camera to ask', () => {
    expect(previewPlacement({ x: 0.72, y: 0.37, radius: 0.115 }, Number.NaN)).toEqual({ x: 0.72, y: 0.37, heightScale: 1 });
  });
});

describe('where the ring is drawn', () => {
  it('flips x, because the preview under it is mirrored and the landmarks are not', () => {
    const el = draw({});
    // Detector x 0.27 → drawn at 73 % across the mirrored preview, where the patient's limb appears.
    expect(el.style.left).toBe('73%');
    expect(el.style.top).toBe('30%');
  });

  it('draws at the detector x when it is told the preview is not mirrored', () => {
    cleanup();
    render(<DwellTarget choice={CHOICE} state={state()} mirrored={false} xScale={PREVIEW_ASPECT} testId="t" />);
    expect(screen.getByTestId('t').style.left).toBe('27%');
  });

  it('is sized so the ring diameter is the target diameter in frame heights', () => {
    // The wrapper is taller than the ring (it carries the caption), so the RING centre — not the box
    // centre — is what sits on the target, and the height accounts for the extra room.
    const el = draw({});
    const heightPct = Number.parseFloat(el.style.height);
    expect(heightPct).toBeGreaterThan(2 * CHOICE.target.radius * 100);
    expect(el.style.transform).toMatch(/translate\(-50%, -29\.5\d*%\)/);
  });

  /**
   * A low target and the preview's own clipping: with the caption always hanging below the ring its
   * second line was cut in half by the bottom edge of the frame at 1024x768 — seen in the running app,
   * not deduced. Below the half-way line the caption goes ABOVE the ring instead.
   */
  it('keeps the whole target inside the frame by flipping the caption above a low ring', () => {
    const low = { ...CHOICE, target: { x: 0.5, y: 0.55, radius: 0.18 } };
    cleanup();
    render(<DwellTarget choice={low} state={state({ target: low.target })} xScale={PREVIEW_ASPECT} testId="t" />);
    const el = screen.getByTestId('t');
    const heightPct = Number.parseFloat(el.style.height);
    const centreOffset = Number.parseFloat(/-([\d.]+)%\)$/.exec(el.style.transform)?.[1] ?? '0');
    const top = 55 - (centreOffset / 100) * heightPct;
    // The caption is above, so the ring centre is near the BOTTOM of the box…
    expect(centreOffset).toBeGreaterThan(50);
    // …and the whole thing fits between the top and bottom edges of the preview.
    expect(top).toBeGreaterThan(0);
    expect(top + heightPct).toBeLessThan(100);
  });

  it('keeps a high ring inside the frame too, with the caption below it', () => {
    const high = { ...CHOICE, target: { x: 0.5, y: 0.3, radius: 0.18 } };
    cleanup();
    render(<DwellTarget choice={high} state={state({ target: high.target })} xScale={PREVIEW_ASPECT} testId="t" />);
    const el = screen.getByTestId('t');
    const heightPct = Number.parseFloat(el.style.height);
    const centreOffset = Number.parseFloat(/-([\d.]+)%\)$/.exec(el.style.transform)?.[1] ?? '0');
    const top = 30 - (centreOffset / 100) * heightPct;
    expect(centreOffset).toBeLessThan(50);
    expect(top).toBeGreaterThan(0);
    expect(top + heightPct).toBeLessThan(100);
  });

  it('every target the screens actually place fits inside the preview, on every sensor', () => {
    for (const aspect of ASPECTS) {
      for (const mode of ['hand', 'leg'] as const) {
        for (const authored of placements(mode)) {
          const target = retargetForAspect(authored, aspect);
          cleanup();
          render(
            <DwellTarget choice={{ ...CHOICE, target: authored }} state={state({ target, xScale: aspect })} testId="t" />,
          );
          const el = screen.getByTestId('t');
          const h = Number.parseFloat(el.style.height);
          const off = Number.parseFloat(/-([\d.]+)%\)$/.exec(el.style.transform)?.[1] ?? '0');
          const where = `${mode} @${aspect.toFixed(2)} ${JSON.stringify(target)}`;
          const top = Number.parseFloat(el.style.top) - (off / 100) * h;
          expect(top, where).toBeGreaterThan(0);
          expect(top + h, where).toBeLessThan(100);
          // …and horizontally, using the box's own aspect against the 4:3 preview.
          const widthPctOfFrameWidth = ((h / 100) * (140 / 176) / PREVIEW_ASPECT) * 100;
          const leftPct = Number.parseFloat(el.style.left) - widthPctOfFrameWidth / 2;
          expect(leftPct, where).toBeGreaterThan(0);
          expect(leftPct + widthPctOfFrameWidth, where).toBeLessThan(100);
        }
      }
    }
  });
});

describe('the layouts the screens ask for', () => {
  it('places the pair apart in both modes, hysteresis bands included, on every sensor', () => {
    for (const mode of ['hand', 'leg'] as const) {
      for (const aspect of ASPECTS) {
        const [a, b] = pairedDwellTargets(mode).map((c) => retargetForAspect(c, aspect)) as [DwellCircle, DwellCircle];
        expect(dwellTargetsOverlap(a, b, DWELL_DEFAULTS.exitRatio, aspect), `${mode} @${aspect}`).toBe(false);
        expect(a.y).toBe(b.y);
      }
    }
  });

  it('puts the forward action in the same place whether it is alone or one of a pair', () => {
    // A patient who learned "the left circle" at the camera check finds it there at every step after.
    for (const mode of ['hand', 'leg'] as const) {
      const single = singleDwellTarget(mode);
      const [go] = pairedDwellTargets(mode);
      expect(single).toEqual(go);
      // Detector x > 0.5 is drawn on the LEFT of the mirrored preview.
      expect(single.x).toBeGreaterThan(0.5);
    }
  });

  it('makes the secondary action a different SIZE, not just a different word', () => {
    for (const mode of ['hand', 'leg'] as const) {
      const [go, back] = pairedDwellTargets(mode);
      expect(back.radius).toBeLessThan(go.radius * 0.85);
    }
  });
});

/* ================= telling the two targets apart ================= */

describe('two targets that mean opposite things', () => {
  const [go, back] = pairedDwellTargets('leg');

  it('renders a different silhouette for each, without being told which is which', () => {
    // Results asks for two targets and names neither: the tone is read off the circle it asked for.
    expect(toneOf({ ...CHOICE, target: go })).toBe('go');
    expect(toneOf({ ...CHOICE, target: back })).toBe('back');
    expect(toneOf({ ...CHOICE, target: go, tone: 'back' })).toBe('back');

    const forward = draw({}, { ...CHOICE, id: 'again', label: 'Play again', target: go });
    expect(forward.dataset.tone).toBe('go');
    expect(forward.querySelector('rect')).toBeNull();
    const backward = draw({}, { ...CHOICE, id: 'new', label: 'New session', target: back });
    expect(backward.dataset.tone).toBe('back');
    // A square backing plate and a second, inner ring: two cues that survive being 1/5 the size.
    expect(backward.querySelector('.dwell-plate')).not.toBeNull();
    expect(backward.querySelector('.dwell-inner')).not.toBeNull();
    expect(forward.querySelector('.dwell-inner')).toBeNull();
  });

  it('draws the secondary visibly smaller', () => {
    const forward = draw({}, { ...CHOICE, target: go });
    const backward = draw({}, { ...CHOICE, target: back });
    expect(Number.parseFloat(backward.style.height)).toBeLessThan(Number.parseFloat(forward.style.height) * 0.85);
  });

  it('says which one it is in the accessible name, not only in the picture', () => {
    draw({}, { ...CHOICE, id: 'new', label: 'New session', target: back });
    expect(screen.getByRole('img').getAttribute('aria-label')).toMatch(/goes back; the smaller circle/);
  });
});

describe('every state says which one it is, and never by colour alone', () => {
  it('nothing tracked: its own glyph, its own dash pattern and words that name the problem', () => {
    const el = draw({ tracked: false, lostSec: 3 });
    expect(el.dataset.phase).toBe('lost');
    expect(el.textContent).toContain('✕');
    expect(el.textContent).toContain('not seeing you');
    expect(el.querySelector('.dwell-track')?.getAttribute('stroke-dasharray')).toBeTruthy();
  });

  it('tracked and waiting: come-in glyph, a solid ring, no arc', () => {
    const el = draw({ tracked: true });
    expect(el.dataset.phase).toBe('enter');
    expect(el.textContent).toContain('hold here');
    expect(el.querySelector('.dwell-track')?.getAttribute('stroke-dasharray')).toBeNull();
    expect(screen.queryByTestId('t-arc')).toBeNull();
  });

  it('holding: the ring carries an arc AND a countdown, so the wait is a number and not a guess', () => {
    const el = draw({ tracked: true, inside: true, withinEntry: true, holding: true, progress: 0.5, remainingSec: 0.9 });
    expect(el.dataset.phase).toBe('holding');
    expect(el.dataset.progress).toBe('0.500');
    expect(el.textContent).toContain('keep holding');
    // Rounded UP: "1" must never sit over a ring that still needs 1.4 s.
    expect(el.textContent).toContain('1');
    const arc = screen.getByTestId('t-arc');
    const circumference = Number(arc.getAttribute('stroke-dasharray'));
    expect(Number(arc.getAttribute('stroke-dashoffset'))).toBeCloseTo(circumference * 0.5, 6);
  });

  it('a limb already parked in the target is told to move out and back, not left with a dead ring', () => {
    const el = draw({ tracked: true, inside: true, withinEntry: true, blocked: 'entry' });
    expect(el.dataset.phase).toBe('reenter');
    expect(el.textContent).toContain('move out, then back');
  });

  it('just confirmed: a tick, and no half-filled ring left over from the answered question', () => {
    const el = draw({ tracked: true, inside: true, blocked: 'refractory', progress: 0 });
    expect(el.dataset.phase).toBe('done');
    expect(el.textContent).toContain('✓');
    expect(screen.queryByTestId('t-arc')).toBeNull();
  });

  it('a target that is not available yet says so instead of pretending to be holdable', () => {
    const el = draw(null, { ...CHOICE, enabled: false, disabledNote: 'Not yet' });
    expect(el.dataset.phase).toBe('off');
    expect(el.textContent).toContain('Not yet');
    expect(el.textContent).toContain('not available yet');
    expect(screen.queryByTestId('t-arc')).toBeNull();
  });

  it('the accessible name carries the action and the state together', () => {
    draw({ tracked: false });
    expect(screen.getByRole('img').getAttribute('aria-label')).toMatch(/^Continue \(.*\): not seeing you$/);
  });

  it('publishes the circle it was MEASURED against for a harness to aim at', () => {
    const authored = singleDwellTarget('leg');
    const circle = retargetForAspect(authored, 16 / 9);
    cleanup();
    render(<DwellTarget choice={{ ...CHOICE, target: authored }} state={state({ target: circle, xScale: 16 / 9 })} testId="t" />);
    const el = screen.getByTestId('t');
    expect(Number(el.dataset.dwellX)).toBeCloseTo(circle.x, 6);
    expect(Number(el.dataset.dwellY)).toBe(circle.y);
    expect(Number(el.dataset.dwellRadius)).toBe(circle.radius);
    expect(Number(el.dataset.dwellXscale)).toBeCloseTo(16 / 9, 6);
  });
});

describe('reducedMotion', () => {
  it('stills the ring without taking away the arc — the arc is the measurement, not decoration', () => {
    const el = draw({ tracked: true, inside: true, holding: true, progress: 0.4 }, CHOICE, true);
    expect(el.className).toContain('still');
    expect(screen.getByTestId('t-arc')).toBeTruthy();
  });

  it('leaves it animated when the setting is off', () => {
    expect(draw({ tracked: true }).className).not.toContain('still');
  });
});

/* ================= the frame rate the device actually has ================= */

describe('dwellCadence', () => {
  it('a 30 fps camera gets exactly the timings that were hard-coded before', () => {
    const c = dwellCadence(1 / 30);
    expect(c.staleSec).toBe(0.2);
    expect(c.graceSec).toBe(0.4);
    expect(c.maxStepSec).toBe(0.25);
  });

  it('a 4 fps camera gets a window wider than its own frame interval', () => {
    // The bug this exists for: at 0.2 s flat, every gap between two working frames was a stall, so the
    // watchdog fed the trackers nothing and the legend announced a camera that had gone.
    const c = dwellCadence(0.25);
    expect(c.staleSec).toBeGreaterThan(0.25);
    expect(c.graceSec).toBeGreaterThan(0.25);
    expect(c.maxStepSec).toBeGreaterThanOrEqual(0.25);
  });

  it('still calls a camera that has really stopped stopped, within a second and a half', () => {
    const c = dwellCadence(10);
    expect(c.staleSec).toBeLessThanOrEqual(1.2);
    expect(c.graceSec).toBeLessThanOrEqual(2);
  });

  it('survives a device that has not said anything yet', () => {
    expect(dwellCadence(0)).toEqual(dwellCadence(1 / 30));
    expect(dwellCadence(Number.NaN)).toEqual(dwellCadence(1 / 30));
  });
});

/* ================= the sentence beside the preview ================= */

function session(over: Partial<DwellSession> = {}): DwellSession {
  // A session with a tracker in it: the legend distinguishes "no frames", "nothing to confirm yet"
  // (no live trackers) and "here is what to hold", and the first two have their own tests below.
  return { states: { go: state() }, limb: null, live: true, xScale: PREVIEW_ASPECT, frameIntervalSec: 1 / 30, ...over };
}

describe('DwellLegend', () => {
  it('names the limb it is following, because a patient cannot otherwise tell which one it is watching', () => {
    cleanup();
    render(
      <DwellLegend
        session={session({ limb: { point: { x: 0.3, y: 0.3 }, side: 'right', label: 'your right knee', key: 'knee:right' } })}
        what="the circle to go on"
      />,
    );
    expect(screen.getByTestId('dwell-legend-limb').textContent).toBe('Following your right knee');
    // The point of accepting either side: the affected limb cannot be asked to hold still for 2 s.
    expect(screen.getByTestId('dwell-legend').textContent).toMatch(/Either side may do this, including the unaffected one/);
  });

  it('says a hand is unidentified rather than guessing which one it is', () => {
    cleanup();
    render(<DwellLegend session={session({ limb: { point: { x: 0.3, y: 0.3 }, side: null, label: 'a hand', key: 'hand:#1' } })} what="x" />);
    expect(screen.getByTestId('dwell-legend-limb').textContent).toBe('Following a hand');
    expect(screen.getByTestId('dwell-legend-unidentified').textContent).toMatch(/cannot be told from the camera/);
  });

  it('with nothing in view it says so, and does not claim a limb', () => {
    cleanup();
    render(<DwellLegend session={session()} what="x" />);
    expect(screen.getByTestId('dwell-legend').dataset.state).toBe('searching');
    expect(screen.getByTestId('dwell-legend-limb').textContent).toMatch(/No hand/);
  });

  it('offers the limbs the mode can actually follow, and no others', () => {
    // In leg mode a hand counts as well as a knee; in hand mode there are no knees to offer.
    useStore.getState().setMode('leg');
    cleanup();
    render(<DwellLegend session={session()} what="x" />);
    expect(screen.getByTestId('dwell-legend').textContent).toMatch(/a hand or a knee/);
    useStore.getState().setMode('hand');
    cleanup();
    render(<DwellLegend session={session()} what="x" />);
    const el = screen.getByTestId('dwell-legend');
    expect(el.textContent).not.toMatch(/knee/);
    expect(el.textContent).toMatch(/a hand/);
    useStore.getState().setMode('leg');
  });

  it('agrees with the rings: when they say "move out, then back", so does it', () => {
    // Two contradictory instructions, one of them in 16 px type, is how the last version read: the big
    // sentence said "put the limb inside the circle and keep it there" beside a ring that could not
    // start until the limb had left.
    cleanup();
    render(<DwellLegend session={session({ states: { go: state({ blocked: 'entry', inside: true, tracked: true }) } })} what="x" />);
    const el = screen.getByTestId('dwell-legend');
    expect(el.dataset.state).toBe('reenter');
    expect(el.textContent).toMatch(/move it out, then back in/);
    expect(el.textContent).not.toMatch(/Move .* into the circle and keep it/);
  });

  it('says a slow camera is slow, rather than letting the ring look broken', () => {
    cleanup();
    render(<DwellLegend session={session({ frameIntervalSec: 0.25 })} what="x" />);
    const slow = screen.getByTestId('dwell-legend-slow').textContent ?? '';
    expect(slow).toMatch(/about 4 frames a second/);
    // At 4 fps the hold still takes the time the ring says, and the legend may say so.
    expect(slow).toMatch(/same time to fill/);
    cleanup();
    render(<DwellLegend session={session({ frameIntervalSec: 1 / 30 })} what="x" />);
    expect(screen.queryByTestId('dwell-legend-slow')).toBeNull();
  });

  it('…and stops promising the countdown once the camera is slower than the ring can count', () => {
    // Below about 1.7 frames a second the step cap bites: the ring fills as the frames arrive, which
    // is slower than the number inside it. Saying "it still takes the same time" there would be a lie.
    cleanup();
    render(<DwellLegend session={session({ frameIntervalSec: 1.0 })} what="x" />);
    const slow = screen.getByTestId('dwell-legend-slow').textContent ?? '';
    expect(slow).toMatch(/about 1 frame a second/);
    expect(slow).not.toMatch(/same time to fill/);
    expect(slow).toMatch(/longer than the countdown/);
  });

  it('with frames arriving but nothing confirmable, it says THAT rather than blaming the camera', () => {
    // The camera-check readiness gate, or a range that has not been measured yet. Saying "no camera
    // frames are arriving" over a preview the patient can plainly see working is a plain untruth.
    cleanup();
    render(<DwellLegend session={session({ states: {} })} what="x" />);
    const el = screen.getByTestId('dwell-legend');
    expect(el.dataset.state).toBe('waiting');
    expect(el.textContent).toMatch(/Nothing to confirm yet/);
    expect(el.textContent).not.toMatch(/No camera frames/);
  });

  it('with no frames arriving it refuses to offer a hands-free path at all', () => {
    // The honest failure: a camera that has stalled cannot be held over, and a ring that sits there
    // implying it can is the promise this app is not allowed to make.
    cleanup();
    render(<DwellLegend session={session({ live: false })} what="x" />);
    const el = screen.getByTestId('dwell-legend');
    expect(el.dataset.state).toBe('offline');
    expect(el.textContent).toMatch(/Hands-free is not available right now/);
    expect(el.textContent).toMatch(/Use the buttons/);
  });
});
