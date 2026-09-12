/**
 * What the hands-free target DRAWS — the half of this feature that no amount of dwell maths can get
 * right on its own.
 *
 * Two of these are load-bearing rather than decorative:
 *
 *  - THE MIRROR. The preview is always CSS-mirrored (that is what a patient expects of a camera) and
 *    the landmarks are not. A target drawn at the detector's x lands on the opposite side of the
 *    frame from the limb it is asking for, and the patient reaches the wrong way — a bug that is
 *    invisible to every unit test and to a symmetric test pattern, and obvious the moment a person
 *    sits in the chair.
 *  - "NOT TRACKED" IS A STATE, NOT AN ABSENCE. A ring that has simply stopped filling looks exactly
 *    like one the patient is not holding still enough for. It has to say which, without relying on
 *    colour, because this is drawn for a patient at two metres with the vision they have.
 */
import { describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { DwellLegend, DwellTarget, PREVIEW_ASPECT, pairedDwellTargets, singleDwellTarget } from './DwellTarget.tsx';
import type { DwellChoice, DwellSession } from './DwellTarget.tsx';
import { DWELL_DEFAULTS, dwellTargetsOverlap } from '../vision/dwell.ts';
import type { DwellState } from '../vision/dwell.ts';

function state(over: Partial<DwellState> = {}): DwellState {
  return {
    progress: 0,
    inside: false,
    tracked: true,
    holding: false,
    confirmed: false,
    confirmations: 0,
    blocked: null,
    pointer: { x: 0.5, y: 0.5 },
    lostSec: 0,
    remainingSec: DWELL_DEFAULTS.holdSec,
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
    <DwellTarget choice={choice} state={over === null ? undefined : state(over)} reducedMotion={reducedMotion} testId="t" />,
  );
  return screen.getByTestId('t');
}

describe('where the ring is drawn', () => {
  it('flips x, because the preview under it is mirrored and the landmarks are not', () => {
    const el = draw({});
    // Detector x 0.27 → drawn at 73 % across the mirrored preview, where the patient's limb appears.
    expect(el.style.left).toBe('73%');
    expect(el.style.top).toBe('30%');
  });

  it('draws at the detector x when it is told the preview is not mirrored', () => {
    cleanup();
    render(<DwellTarget choice={CHOICE} state={state()} mirrored={false} testId="t" />);
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
   * A leg-mode target sits at knee height, 55 % down the frame, and the preview clips its own bounds.
   * With the caption always hanging below the ring its second line was cut in half by the bottom edge
   * of the frame at 1024x768 — seen in the running app, not deduced. Below the half-way line the
   * caption goes ABOVE the ring instead.
   */
  it('keeps the whole target inside the frame by flipping the caption above a low ring', () => {
    const low = { ...CHOICE, target: { x: 0.5, y: 0.55, radius: 0.18 } };
    cleanup();
    render(<DwellTarget choice={low} state={state()} testId="t" />);
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
    render(<DwellTarget choice={high} state={state()} testId="t" />);
    const el = screen.getByTestId('t');
    const heightPct = Number.parseFloat(el.style.height);
    const centreOffset = Number.parseFloat(/-([\d.]+)%\)$/.exec(el.style.transform)?.[1] ?? '0');
    const top = 30 - (centreOffset / 100) * heightPct;
    expect(centreOffset).toBeLessThan(50);
    expect(top).toBeGreaterThan(0);
    expect(top + heightPct).toBeLessThan(100);
  });

  it('every target the screens actually place fits inside the preview', () => {
    const boxes = [
      ...(['hand', 'leg'] as const).map((m) => singleDwellTarget(m)),
      ...(['hand', 'leg'] as const).flatMap((m) => pairedDwellTargets(m)),
    ];
    for (const target of boxes) {
      cleanup();
      render(<DwellTarget choice={{ ...CHOICE, target }} state={state()} testId="t" />);
      const el = screen.getByTestId('t');
      const h = Number.parseFloat(el.style.height);
      const off = Number.parseFloat(/-([\d.]+)%\)$/.exec(el.style.transform)?.[1] ?? '0');
      const top = target.y * 100 - (off / 100) * h;
      expect(top, JSON.stringify(target)).toBeGreaterThan(0);
      expect(top + h, JSON.stringify(target)).toBeLessThan(100);
      // …and horizontally, using the box's own aspect against the 4:3 preview.
      const widthPctOfFrameWidth = ((h / 100) * (140 / 176) / PREVIEW_ASPECT) * 100;
      const leftPct = (1 - target.x) * 100 - widthPctOfFrameWidth / 2;
      expect(leftPct, JSON.stringify(target)).toBeGreaterThan(0);
      expect(leftPct + widthPctOfFrameWidth, JSON.stringify(target)).toBeLessThan(100);
    }
  });
});

describe('the layouts the screens ask for', () => {
  it('places the pair apart in both modes, hysteresis bands included', () => {
    for (const mode of ['hand', 'leg'] as const) {
      const [a, b] = pairedDwellTargets(mode);
      expect(dwellTargetsOverlap(a, b, DWELL_DEFAULTS.exitRatio, PREVIEW_ASPECT), mode).toBe(false);
      expect(a.y).toBe(b.y);
    }
  });

  it('puts a knee target at knee height and a hand target higher — a knee cannot be raised to the top of the frame', () => {
    expect(singleDwellTarget('leg').y).toBeGreaterThan(singleDwellTarget('hand').y);
    // …and both stay inside the frame with their whole radius.
    for (const mode of ['hand', 'leg'] as const) {
      const t = singleDwellTarget(mode);
      expect(t.y - t.radius).toBeGreaterThan(0);
      expect(t.y + t.radius).toBeLessThan(1);
    }
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
    const el = draw({ tracked: true, inside: true, holding: true, progress: 0.5, remainingSec: 0.9 });
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
    const el = draw({ tracked: true, inside: true, blocked: 'entry' });
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
    expect(screen.getByRole('img').getAttribute('aria-label')).toBe('Continue: not seeing you');
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

/* ---------------- the sentence beside the preview ---------------- */

function session(over: Partial<DwellSession> = {}): DwellSession {
  // A session with a tracker in it: the legend distinguishes "no frames", "nothing to confirm yet"
  // (no live trackers) and "here is what to hold", and the first two have their own tests below.
  return { states: { go: state() }, limb: null, live: true, ...over };
}

describe('DwellLegend', () => {
  it('names the limb it is following, because a patient cannot otherwise tell which one it is watching', () => {
    cleanup();
    render(
      <DwellLegend
        session={session({ limb: { point: { x: 0.3, y: 0.3 }, side: 'right', label: 'your right knee' } })}
        what="the circle to go on"
      />,
    );
    expect(screen.getByTestId('dwell-legend-limb').textContent).toBe('Following your right knee');
    // The point of accepting either side: the affected limb cannot be asked to hold still for 2 s.
    expect(screen.getByTestId('dwell-legend').textContent).toMatch(/Either side may do this, including the unaffected one/);
  });

  it('says a hand is unidentified rather than guessing which one it is', () => {
    cleanup();
    render(<DwellLegend session={session({ limb: { point: { x: 0.3, y: 0.3 }, side: null, label: 'a hand' } })} what="x" />);
    expect(screen.getByTestId('dwell-legend-limb').textContent).toBe('Following a hand');
    expect(screen.getByTestId('dwell-legend-unidentified').textContent).toMatch(/cannot be told from the camera/);
  });

  it('with nothing in view it says so, and does not claim a limb', () => {
    cleanup();
    render(<DwellLegend session={session()} what="x" />);
    expect(screen.getByTestId('dwell-legend').dataset.state).toBe('searching');
    expect(screen.getByTestId('dwell-legend-limb').textContent).toBe('No hand or knee in view');
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
