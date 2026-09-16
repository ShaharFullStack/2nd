/**
 * The ROM calibration screen is where a refused calibration has to become VISIBLE.
 *
 * VisionInput vets every range it is handed against the lane's own CalibrationContext (which fingertip
 * the lane opposes, which mirror convention its frames are in) and refuses one that measures a
 * different quantity or the other limb. That verdict used to reach nobody: `setCalibration`'s boolean
 * was discarded here, so the screen painted a green ✓, a min→max readout and an enabled "Next lane →"
 * over a lane the engine had just killed, and the only trace was console.error. These tests pin the
 * therapist-facing half: the refusal is on screen, in the therapist's words, ending in the action to
 * take — and no green tick sits over a dead lane.
 *
 * The runtime is mocked (a real one opens an AudioContext and pulls in MediaPipe); the store, the
 * calibration vetting rules and the screen itself are the real thing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { LaneSpec } from '../engine/types.ts';
import { DEFAULT_SETTINGS, calibrationKey, useStore } from '../state/store.ts';
import { RomCalibrator, calibrationContext } from '../vision/calibration.ts';
import type { CalibrationContext, RomCalibration } from '../vision/calibration.ts';
import type { InvalidCalibration } from '../input/VisionInput.ts';

const LANES: LaneSpec[] = [
  { index: 0, movement: 'finger_opposition', side: 'right', fingertip: 'pinky' },
  { index: 1, movement: 'hand_open_close', side: 'right' },
];

/** The lane the fake is being asked about — whatever the store currently holds, not a fixed list. */
const laneAt = (i: number): LaneSpec => useStore.getState().lanes[i] ?? LANES[i];

/** The lane contexts the fake VisionInput reports — derived, never hand-built (calibrationContext). */
const laneCtx = (i: number, mirrored: boolean): CalibrationContext =>
  calibrationContext(laneAt(i).movement, { fingertip: laneAt(i).fingertip, mirrored });

/** A finished pinch range stamped with what it measured, exactly as `createCalibrator` would stamp it. */
function pinchCal(fingertip: 'index' | 'pinky', mirrored: boolean): RomCalibration {
  return { min: 0.05, max: 0.85, samples: 120, movement: 'finger_opposition', fingertip, mirrored, capturedAt: Date.now() };
}

/** The mocked runtime: one fake VisionInput whose verdicts each test sets up front. */
const fake = {
  /** What `setCalibration` answers — false = refused. */
  accept: true,
  /** What `getInvalidCalibrations()` reports (the refusal the screen must poll and show). */
  refusals: [] as InvalidCalibration[],
  /** The session's mirror convention, i.e. what the lanes' contexts say. */
  mirrored: false,
  setCalibration: vi.fn((lane: number, cal: RomCalibration | null): boolean => {
    if (fake.accept) return true;
    fake.refusals = [
      {
        lane,
        movement: laneAt(lane).movement,
        side: laneAt(lane).side,
        reason:
          'the range measured is 0.01 wide, which is below the minimum for finger opposition — re-calibrate this lane',
      },
    ];
    void cal;
    return false;
  }),
};

const vision = {
  createCalibrator: (i: number) => new RomCalibrator(laneAt(i).movement, { ...laneCtx(i, fake.mirrored) }),
  getCalibrationContext: (i: number) => laneCtx(i, fake.mirrored),
  getPipeline: () => null,
  onFrame: () => () => {},
  getInvalidCalibrations: () => fake.refusals,
  /** CameraPreview asks for this; there is no camera in jsdom. */
  getVideoElement: () => null,
  setCalibration: (lane: number, cal: RomCalibration | null) => fake.setCalibration(lane, cal),
};

vi.mock('../session/runtime.ts', () => ({ runtime: { peekVision: () => vision } }));

const { default: RomCalibrationScreen } = await import('./RomCalibration.tsx');

beforeEach(() => {
  fake.accept = true;
  fake.refusals = [];
  fake.mirrored = false;
  fake.setCalibration.mockClear();
  localStorage.clear();
  useStore.setState({
    screen: 'rom',
    mode: 'hand',
    lanes: LANES,
    calibrations: [null, null],
    savedCalibrations: {},
    difficulty: 'medium',
    windowScale: 1,
    inputMode: 'camera',
    activePatientId: null,
    persistenceFailed: false,
    settings: { ...DEFAULT_SETTINGS },
  });
});

afterEach(cleanup);

/** Put a range in the store's saved map, the way a previous session left it there. */
function saveRange(cal: RomCalibration): void {
  useStore.setState({ savedCalibrations: { [calibrationKey(LANES[0])]: cal } });
}

describe('a saved range is only offered when it describes what this lane measures now', () => {
  it('offers it when the context matches, and the accepted range shows as done', async () => {
    fake.mirrored = true;
    saveRange(pinchCal('pinky', true));
    render(<RomCalibrationScreen />);

    const reuse = (await screen.findByTestId('rom-reuse')) as HTMLButtonElement;
    expect(reuse.disabled).toBe(false);
    expect(screen.queryByTestId('rom-reuse-problem')).toBeNull();

    fireEvent.click(reuse);

    expect(fake.setCalibration).toHaveBeenCalledWith(0, expect.objectContaining({ fingertip: 'pinky', mirrored: true }));
    await waitFor(() => expect(screen.getByTestId('rom-lane-badge-0').textContent).toBe('✓'));
    expect((screen.getByTestId('rom-next') as HTMLButtonElement).disabled).toBe(false);
    // Only an ACCEPTED range reaches the store, so next week's session is offered a range that works.
    expect(useStore.getState().calibrations[0]).not.toBeNull();
  });

  it('refuses to offer a range measured under the other mirror convention, and says what to do', async () => {
    // The store's key is movement:side:fingertip — it does NOT carry the mirror convention, and the
    // convention selects WHICH LIMB the lane reads. This is the one live path that can hand a lane a
    // genuinely inapplicable saved range, so the screen has to catch it before the runtime does.
    fake.mirrored = true;
    saveRange(pinchCal('pinky', false));
    render(<RomCalibrationScreen />);

    const problem = await screen.findByTestId('rom-reuse-problem');
    const toast = problem.closest('.toast') as HTMLElement;
    expect(toast.className).toContain('toast-bad');
    expect(toast.textContent).toMatch(/other limb/i);
    // Therapist-facing, and it ENDS in the action to take.
    expect(toast.textContent).toMatch(/Re-calibrate this lane, or set the mirror option back/i);

    expect((screen.getByTestId('rom-reuse') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('rom-reuse'));
    expect(fake.setCalibration).not.toHaveBeenCalled();
    expect(screen.getByTestId('rom-lane-badge-0').textContent).toBe('●');
    expect((screen.getByTestId('rom-next') as HTMLButtonElement).disabled).toBe(true);
  });

  it('refuses to offer a range measured on another fingertip', async () => {
    fake.mirrored = false;
    // Filed under this lane's key but stamped with the other tip (a migrated or hand-edited blob).
    saveRange(pinchCal('index', false));
    render(<RomCalibrationScreen />);

    const problem = await screen.findByTestId('rom-reuse-problem');
    expect((problem.closest('.toast') as HTMLElement).textContent).toMatch(
      /measured opposing the index finger.*re-calibrate this lane on the pinky finger/i,
    );
  });
});

describe('a refused hand-over is visible on the screen that can fix it', () => {
  it('shows the runtime\'s reason, keeps the lane not-done and never writes the range to the store', async () => {
    fake.mirrored = true;
    fake.accept = false;
    saveRange(pinchCal('pinky', true));
    render(<RomCalibrationScreen />);

    fireEvent.click(await screen.findByTestId('rom-reuse'));

    const rejected = await screen.findByTestId('rom-rejected');
    const toast = rejected.closest('.toast') as HTMLElement;
    expect(toast.className).toContain('toast-bad');
    expect(toast.textContent).toMatch(/below the minimum for finger opposition — re-calibrate this lane/i);

    // The three states that used to proceed as if the range had been accepted.
    expect(screen.getByTestId('rom-lane-badge-0').textContent).toBe('✕');
    expect((screen.getByTestId('rom-next') as HTMLButtonElement).disabled).toBe(true);
    expect(useStore.getState().calibrations[0]).toBeNull();
    expect(screen.queryByText(/0\.05→0\.85/)).toBeNull();
  });

  it('polls the runtime, so a lane refused elsewhere (a flipped mirror switch) surfaces here too', async () => {
    fake.refusals = [
      {
        lane: 1,
        movement: 'hand_open_close',
        side: 'right',
        reason:
          'it was measured on a raw (un-mirrored) camera image and this session runs on a mirrored (selfie-flipped) camera image — ' +
          'the two conventions swap which side the landmarks belong to, so this range describes the OTHER limb. ' +
          'Re-calibrate this lane, or set the mirror option back to the one it was measured with',
      },
    ];
    render(<RomCalibrationScreen />);

    const refusal = await screen.findByTestId('rom-refusal-1');
    expect(refusal.textContent).toMatch(/Lane 2 \(.*\) will not score/i);
    expect((refusal.closest('.toast') as HTMLElement).textContent).toMatch(/Re-calibrate this lane/i);
    await waitFor(() => expect(screen.getByTestId('rom-lane-badge-1').textContent).toBe('✕'));
  });
});

describe('storage that is not storing is said out loud', () => {
  it('warns the therapist when the tablet refused to persist a calibration', async () => {
    useStore.setState({ persistenceFailed: true });
    render(<RomCalibrationScreen />);
    expect(await screen.findByText(/not saving calibrations/i)).toBeTruthy();
  });
});

/**
 * THE SENTENCE THE PATIENT IS READ WHILE BEING MEASURED.
 *
 * The header names the tip, so the THERAPIST knows which lane they are on. The patient performing the
 * rep cannot see the header — they are looking at the camera — and the one string they are read aloud
 * was `MOVEMENT_INFO.calibrationInstruction`: "Touch your thumb to the fingertip", which is wrong for
 * three of the four digits a therapist can now prescribe. Measuring the wrong finger's range and
 * filing it under this one is worse than measuring nothing.
 */
describe('the screen that first puts a range into degrees says what kind of number it is', () => {
  it('carries the scope statement beside the calibrated ranges', async () => {
    render(<RomCalibrationScreen />);
    const note = await screen.findByTestId('rom-scope');
    expect(note.textContent).toMatch(/movement game/i);
    expect(note.textContent).toMatch(/not a measuring instrument/i);
  });
});

describe('the instruction names the prescribed digit', () => {
  it('reads out the little finger for a pinky lane, not "the fingertip"', async () => {
    render(<RomCalibrationScreen />);
    const line = await screen.findByTestId('rom-detailed-instruction');
    expect(line.textContent).toMatch(/little finger/i);
    expect(line.textContent).not.toMatch(/to the fingertip/i);
  });

  it('follows the therapist to another digit', async () => {
    useStore.setState({ lanes: [{ index: 0, movement: 'finger_opposition', side: 'right', fingertip: 'ring' }, LANES[1]] });
    render(<RomCalibrationScreen />);
    expect((await screen.findByTestId('rom-detailed-instruction')).textContent).toMatch(/ring finger/i);
  });

  it('leaves a movement with no fingertip dimension on its own wording', async () => {
    useStore.setState({ lanes: [LANES[1], LANES[0]] });
    render(<RomCalibrationScreen />);
    expect((await screen.findByTestId('rom-detailed-instruction')).textContent).toMatch(/Open your hand as wide as is comfortable/i);
  });
});


/**
 * THE BUTTONS A THERAPIST ACTUALLY PRESSES.
 *
 * The proportional nudge API existed, was tested, and reached nobody: the screen still rendered
 * "Easier (−5% top)" / "Harder (+5% top)" over `cal.nudge(0, ±0.05)` — an ABSOLUTE feature-unit step
 * that moves a hemiparetic seated march by a sixth of the patient's whole range and a knee extension
 * by a twentieth of a degree, under one label claiming 5 %. These tests pin the wiring, so the API
 * cannot drift back out of the UI silently.
 */
describe('Easier / Harder say what they will do, in the movement’s own units', () => {
  const reuseMeasuredRange = async (over: Partial<RomCalibration> = {}) => {
    useStore.setState({
      savedCalibrations: {
        [calibrationKey(LANES[0])]: {
          min: 0.1,
          max: 0.5,
          samples: 120,
          movement: 'finger_opposition',
          fingertip: 'pinky',
          mirrored: false,
          peaks: [0.48, 0.5, 0.52],
          capturedAt: Date.now(),
          ...over,
        } as RomCalibration,
      },
    });
    render(<RomCalibrationScreen />);
    fireEvent.click(await screen.findByTestId('rom-reuse'));
    await waitFor(() => expect(screen.getByTestId('rom-lane-badge-0').textContent).toBe('✓'));
  };

  it('labels each button with the target it will set, not with a percentage of nothing', async () => {
    await reuseMeasuredRange();
    const easier = screen.getByTestId('rom-nudge-easier');
    const harder = screen.getByTestId('rom-nudge-harder');
    // 5 % of the MEASURED range (0.5 − 0.1 = 0.4) is 0.02 — the label states both ends of the move.
    expect(easier.textContent).toContain('0.50 → 0.48');
    expect(easier.textContent).toContain('of the measured range');
    expect(harder.textContent).toContain('0.50 → 0.52');
  });

  it('applies exactly what the label promised, and records the range as therapist-adjusted', async () => {
    await reuseMeasuredRange();
    fireEvent.click(screen.getByTestId('rom-nudge-easier'));
    await waitFor(() => {
      const cal = useStore.getState().calibrations[0];
      expect(cal?.max).toBeCloseTo(0.48, 6);
      expect(cal?.manual).toBe(true);
    });
    // The label re-reads the new range rather than repeating the old promise.
    await waitFor(() => expect(screen.getByTestId('rom-nudge-easier').textContent).toContain('0.48 → 0.46'));
  });

  it('refuses to set a target above the best rep this patient produced, and says why', async () => {
    await reuseMeasuredRange({ max: 0.52 }); // already at the best peak on record
    const harder = screen.getByTestId('rom-nudge-harder') as HTMLButtonElement;
    expect(harder.disabled).toBe(true);
    expect(harder.textContent).toMatch(/already at this patient's best/);
    expect(screen.getByTestId('rom-nudge-note').textContent).toMatch(/never been produced/);
    // and nothing above it can be reached by pressing repeatedly
    fireEvent.click(harder);
    expect(useStore.getState().calibrations[0]?.max).toBeCloseTo(0.52, 6);
  });
});

/**
 * THE HANDS-FREE PAIR — and in particular the state a patient working alone can most easily be
 * trapped in.
 *
 * Everything on this screen except "go on" and "back" is a therapist's decision about the
 * DENOMINATOR of the whole record (easier, harder, reuse last session's range), and none of those is
 * put behind a dwell target. Redo is not in that class: it is the patient's own account of their own
 * attempt, it destroys nothing that was not measured thirty seconds ago — and when the attempt
 * produced nothing usable it is the ONLY thing that can move a patient alone at all, because the
 * forward target is correctly dead and the calibrator will not measure again until somebody asks.
 *
 * THE BACK CIRCLE EXISTS IN EVERY STATE, which is what these tests are really about. A confirm LANDS
 * on a lane in its rest hold, where nothing has been measured — and that used to be the one state
 * with no dwell targets at all, so an accidental advance locked the previous lane's range in as the
 * denominator of the session with no patient-reachable way back to it.
 */
describe('the hands-free pair on the ROM screen', () => {
  it('still offers a way BACK while the range is being measured — the forward circle alone is dead', () => {
    render(<RomCalibrationScreen />);
    // Nothing measured yet, so going on is (correctly) impossible…
    expect(screen.getByTestId('rom-dwell-next').dataset.phase).toBe('off');
    // …but the patient is not stranded in the state a confirm lands in.
    expect(screen.getByTestId('rom-handsfree')).toBeTruthy();
    expect(screen.getByTestId('rom-dwell-redo').dataset.phase).not.toBe('off');
    // On the FIRST lane, back means the screen before this one.
    expect(screen.getByTestId('rom-dwell-redo').textContent).toContain('Camera check');
  });

  it('on a later lane the back circle goes back a MOVEMENT — the undo of the confirm that landed there', async () => {
    fake.mirrored = true;
    saveRange(pinchCal('pinky', true));
    render(<RomCalibrationScreen />);
    // Lane 1 gets a range and hands over to lane 2, exactly as the forward circle would.
    fireEvent.click(await screen.findByTestId('rom-reuse'));
    await waitFor(() => expect((screen.getByTestId('rom-next') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId('rom-next'));
    await waitFor(() => expect(screen.getByTestId('rom-lane-badge-1').textContent).toBe('●'));

    // Lane 2 is in its rest hold with nothing measured: the back circle is the way back to lane 1.
    expect(screen.getByTestId('rom-dwell-next').dataset.phase).toBe('off');
    expect(screen.getByTestId('rom-dwell-redo').textContent).toContain('Back a movement');
    expect(screen.getByTestId('rom-handsfree-note').textContent).toContain('the movement before this one');
  });

  it('offers both circles once the runtime holds a range for the lane', async () => {
    fake.mirrored = true;
    saveRange(pinchCal('pinky', true));
    render(<RomCalibrationScreen />);
    fireEvent.click(await screen.findByTestId('rom-reuse'));

    await waitFor(() => expect(screen.getByTestId('rom-handsfree')).toBeTruthy());
    expect(screen.getByTestId('rom-dwell-next').dataset.phase).not.toBe('off');
    expect(screen.getByTestId('rom-dwell-redo').dataset.phase).not.toBe('off');
    // …and the buttons they duplicate are still there and still work.
    expect((screen.getByTestId('rom-next') as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByTestId('rom-redo')).toBeTruthy();
  });

  it('a REFUSED range still leaves a redo to hold — the forward circle is dead, not the screen', async () => {
    fake.accept = false;
    fake.mirrored = true;
    saveRange(pinchCal('pinky', true));
    render(<RomCalibrationScreen />);
    fireEvent.click(await screen.findByTestId('rom-reuse'));

    // The refusal is on screen…
    await waitFor(() => expect(screen.getByTestId('rom-rejected')).toBeTruthy());
    expect(screen.getByTestId('rom-lane-badge-0').textContent).toBe('✕');
    // …the way FORWARD is shut, hands-free exactly as it is on the button…
    await waitFor(() => expect(screen.getByTestId('rom-dwell-next').dataset.phase).toBe('off'));
    expect((screen.getByTestId('rom-next') as HTMLButtonElement).disabled).toBe(true);
    // …and the patient can still ask for the movement to be measured again without touching anything.
    expect(screen.getByTestId('rom-dwell-redo').dataset.phase).not.toBe('off');
    // (What the legend beside it says about the limb it is following needs live frames; that is
    // covered in DwellTarget.test.tsx. Here there is no camera, and it says so.)
    expect(screen.getByTestId('rom-dwell-legend').dataset.state).toBe('offline');
  });
});

/**
 * THE SET-UP CHANGE IS A BEAT, NOT A REWORDED SENTENCE.
 *
 * `MOVEMENT_INFO.posture` has always known that wrist_extension is measured with the hand over the
 * table edge while the other three hand movements are measured palm-to-camera — ninety degrees apart
 * about the wrist, which is the wrist_extension axis itself. The screen never mentioned it: walking
 * from one lane to the next changed the instruction line and asked for three repetitions against a
 * support that had not moved. The change is now asked for once, on its own, before anything measures.
 */
const MIXED: LaneSpec[] = [
  { index: 0, movement: 'hand_open_close', side: 'left' },
  { index: 1, movement: 'wrist_extension', side: 'right' },
  { index: 2, movement: 'finger_spread', side: 'left' },
];

/** Put a usable range in the store for every lane of `lanes`, as a return visit would have. */
function saveAll(lanes: LaneSpec[]): void {
  const saved: Record<string, RomCalibration> = {};
  for (const l of lanes) {
    saved[calibrationKey(l)] = {
      min: 0.1, max: 0.6, samples: 120, movement: l.movement, mirrored: false,
      ...(l.fingertip ? { fingertip: l.fingertip } : {}), capturedAt: Date.now(),
    } as RomCalibration;
  }
  useStore.setState({ savedCalibrations: saved });
}

describe('a set-up change is asked for once, as its own beat', () => {
  beforeEach(() => {
    useStore.setState({ lanes: MIXED, calibrations: MIXED.map(() => null) });
    saveAll(MIXED);
  });

  it('does not interrupt a prescription measured in a single set-up', async () => {
    useStore.setState({ lanes: LANES, calibrations: [null, null] });
    saveAll([...LANES]);
    render(<RomCalibrationScreen />);
    // Both LANES movements are palm-to-camera: the first thing on screen is the lane itself.
    expect((await screen.findByTestId('rom-visual-guide')).dataset.beat).not.toBe('posture');
  });

  it('stops the patient before the movement that needs the other set-up, and measures nothing until they say they have moved', async () => {
    render(<RomCalibrationScreen />);
    // Lane 1 (palm to the camera) is taken from last session, and lane 3 with it — both share that
    // set-up, so the screen measures them back to back before asking for anything to move.
    fireEvent.click(await screen.findByTestId('rom-reuse-use'));
    await waitFor(() => expect(screen.getByTestId('rom-lane-badge-0').textContent).toBe('✓'));
    fireEvent.click(screen.getByTestId('rom-next'));
    fireEvent.click(await screen.findByTestId('rom-reuse-use'));
    await waitFor(() => expect(screen.getByTestId('rom-lane-badge-2').textContent).toBe('✓'));
    fireEvent.click(screen.getByTestId('rom-next'));

    // The wrist lane is next and it is measured in the OTHER set-up. Decline the stored range so it
    // has to be measured — and the screen asks for the arm to move before it measures anything.
    fireEvent.click(await screen.findByTestId('rom-reuse-measure'));
    const guide = await screen.findByTestId('rom-visual-guide');
    await waitFor(() => expect(guide.dataset.beat).toBe('posture'));
    expect(screen.getByTestId('rom-posture-instruction').textContent).toMatch(/past the edge of the table/i);
    expect(screen.getByTestId('rom-posture-why').textContent).toMatch(/Wrist extension is measured with your hand over the table edge/i);
    // Nothing is being asked of the patient yet: no rest ring, no repetition count, no way forward
    // that skips the change — and the hands-free pair is the confirm and the way back, not "next".
    expect(screen.queryByTestId('rom-instruction')).toBeNull();
    expect(screen.getByTestId('rom-dwell-posture-ready').textContent).toContain('I have moved');
    expect(screen.getByTestId('rom-dwell-posture-back').textContent).toContain('Back a movement');
    expect(screen.queryByTestId('rom-dwell-next')).toBeNull();

    fireEvent.click(screen.getByTestId('rom-posture-ready'));
    await waitFor(() => expect(screen.getByTestId('rom-visual-guide').dataset.beat).toBe('measure'));
    expect(screen.getByTestId('rom-instruction').textContent).toMatch(/hand over the edge/i);
    // …and it is asked ONCE: the beat does not come back on the lane it was confirmed for.
    expect(screen.queryByTestId('rom-posture-instruction')).toBeNull();
  });

  it('measures the lanes that share a set-up together, and keeps the prescribed order on screen', async () => {
    render(<RomCalibrationScreen />);
    await screen.findByTestId('rom-visual-guide');
    // Prescribed: palm, edge, palm. Measured: palm, palm, edge — one change of set-up instead of two.
    expect(screen.getByText(/prescribed lane 1/)).toBeTruthy();
    fireEvent.click(await screen.findByTestId('rom-reuse-use'));
    await waitFor(() => expect(screen.getByTestId('rom-lane-badge-0').textContent).toBe('✓'));
    fireEvent.click(screen.getByTestId('rom-next'));
    // Second is the OTHER palm-to-camera lane, which is prescribed third.
    expect(await screen.findByText(/2 of 3 · prescribed lane 3/)).toBeTruthy();
    // The therapist's order is never renumbered away: the lane list is in it, each row says where it
    // falls in the walk and which set-up it needs, and the note spells the walk out.
    expect(screen.getByTestId('rom-lane-order-1').textContent).toMatch(/measured 3rd \(hand over the table edge\)/);
    expect(screen.getByTestId('rom-lane-order-2').textContent).toMatch(/measured 2nd \(palm to the camera\)/);
    expect(screen.getByTestId('rom-order-note').textContent).toMatch(/PRESCRIBED order/);
    expect(screen.getByTestId('rom-order-note').textContent).toMatch(/lane 1, lane 3, lane 2/);
  });
});

/**
 * THE CONTROL THAT SKIPS THE ORDEAL, IN FRONT OF THE PATIENT INSTEAD OF INSIDE A DISCLOSURE.
 *
 * "Reuse last session's range" lived in the collapsed "Adjustments & details" block — the one control
 * that removes the whole wall of repetitions on the visit most patients are on, behind a widget that
 * needs a click, on a screen whose entire point is that the patient may not be able to click. It is
 * now a beat of the lane, with both answers on a dwell target, and every guard it always had.
 */
describe('last session’s range is offered as a first-class choice', () => {
  it('opens on the offer, states what it would adopt, and adopting does not carry the session forward', async () => {
    fake.mirrored = true;
    saveRange(pinchCal('pinky', true));
    render(<RomCalibrationScreen />);

    const guide = await screen.findByTestId('rom-visual-guide');
    await waitFor(() => expect(guide.dataset.beat).toBe('reuse'));
    // What it would adopt: the range in the movement's units, when it was measured, and how well.
    expect(screen.getByTestId('rom-reuse-facts').textContent).toMatch(/0\.05 → 0\.85/);
    expect(screen.getByTestId('rom-reuse-offer-quality')).toBeTruthy();
    // Both answers are one hold away, and neither is the forward hold that ends the lane.
    expect(screen.getByTestId('rom-dwell-reuse-use').textContent).toContain('Use last range');
    expect(screen.getByTestId('rom-dwell-reuse-measure').textContent).toContain('Measure it now');

    fireEvent.click(screen.getByTestId('rom-reuse-use'));
    await waitFor(() => expect(screen.getByTestId('rom-lane-badge-0').textContent).toBe('✓'));
    // It is THIS lane that is done — the session has not moved on, so going on is a separate act.
    expect(screen.getByText(/lane 1 of 2/)).toBeTruthy();
    expect((screen.getByTestId('rom-next') as HTMLButtonElement).disabled).toBe(false);
    // And it is legible as a reused range, not as a measurement made today.
    expect(screen.getByTestId('rom-accepted-reused').textContent).toMatch(/Reused from a previous session/i);
    expect(screen.getByTestId('rom-lane-reused-0')).toBeTruthy();
    expect(screen.getByTestId('rom-accepted-quality-chip')).toBeTruthy();
  });

  it('stays refusable: one hold of the back circle measures the movement instead', async () => {
    fake.mirrored = true;
    saveRange(pinchCal('pinky', true));
    render(<RomCalibrationScreen />);
    fireEvent.click(await screen.findByTestId('rom-reuse-use'));
    await waitFor(() => expect(screen.getByTestId('rom-lane-badge-0').textContent).toBe('✓'));

    expect(screen.getByTestId('rom-dwell-redo').textContent).toContain('Do it again');
    fireEvent.click(screen.getByTestId('rom-redo'));
    await waitFor(() => expect(screen.getByTestId('rom-lane-badge-0').textContent).toBe('●'));
    // The offer does not spring back and re-adopt itself: the lane is being measured now.
    await waitFor(() => expect(screen.getByTestId('rom-visual-guide').dataset.beat).toBe('measure'));
    expect(screen.queryByTestId('rom-lane-reused-0')).toBeNull();
  });

  it('keeps every guard: a range measured under the other mirror convention is never offered', async () => {
    fake.mirrored = true;
    saveRange(pinchCal('pinky', false));
    render(<RomCalibrationScreen />);

    const problem = await screen.findByTestId('rom-reuse-problem');
    expect(problem.closest('.toast')?.textContent).toMatch(/other limb/i);
    // No offer beat, no hands-free way to take it, and the disclosed button is still disabled.
    expect(screen.getByTestId('rom-visual-guide').dataset.beat).toBe('measure');
    expect(screen.queryByTestId('rom-dwell-reuse-use')).toBeNull();
    expect((screen.getByTestId('rom-reuse') as HTMLButtonElement).disabled).toBe(true);
    expect(fake.setCalibration).not.toHaveBeenCalled();
  });

  it('never offers one measured on somebody else, however well it matches the lane', async () => {
    // WHOSE BODY. `movement:side:fingertip` says what was measured and not on whom; the patient is
    // attached to the lane's context by this screen (`withPatient`) and is checked before anything
    // else, because a range measured on another person is not a degraded measurement of this one.
    fake.mirrored = true;
    useStore.setState({ activePatientId: 'alice' });
    saveRange({ ...pinchCal('pinky', true), patient: 'bob' } as RomCalibration);
    render(<RomCalibrationScreen />);

    expect((await screen.findByTestId('rom-reuse-problem')).closest('.toast')?.textContent).toMatch(/different patient/i);
    expect(screen.getByTestId('rom-visual-guide').dataset.beat).toBe('measure');
    expect(screen.queryByTestId('rom-dwell-reuse-use')).toBeNull();
    expect(fake.setCalibration).not.toHaveBeenCalled();
  });
});

/**
 * THE LEGEND THAT SAYS WHICH LIMB IS BEING FOLLOWED IS ON THE PATIENT'S SIDE OF THE SCREEN.
 *
 * It lived inside the collapsed "Adjustments & details" disclosure. Measured in the running app at
 * 1024x768 (critic/handsfree-dead-ends.mjs, and identically against a clean worktree of main), its
 * badge sat at y=2002 on a 768 px screen — laid out, never painted, and unreachable for the one person
 * this screen is designed for, because opening a <details> takes a hand on the glass. The circles are
 * live in every beat, so the legend is too.
 */
describe('the hands-free legend is where the patient can read it', () => {
  it('is inside the coach panel, not inside the collapsed details block', async () => {
    render(<RomCalibrationScreen />);
    const legend = await screen.findByTestId('rom-dwell-legend');
    const coach = document.querySelector('[data-testid="rom-visual-guide"]');
    const details = document.querySelector('details.rom-details');
    expect(coach?.contains(legend)).toBe(true);
    expect(details?.contains(legend)).toBe(false);
    // The therapist's explanation of the two circles stays in the disclosure with the rest of the
    // adjustments — it is prose about the design, not the live state of the camera.
    expect(details?.contains(screen.getByTestId('rom-handsfree-note'))).toBe(true);
  });

  it('follows the screen through the beats that are not a measurement', async () => {
    useStore.setState({ lanes: MIXED, calibrations: MIXED.map(() => null) });
    saveAll(MIXED);
    render(<RomCalibrationScreen />);
    // The reuse offer is a beat with live circles, so the legend is on it…
    const guide = await screen.findByTestId('rom-visual-guide');
    await waitFor(() => expect(guide.dataset.beat).toBe('reuse'));
    expect(guide.contains(screen.getByTestId('rom-dwell-legend'))).toBe(true);
    // …and so is the set-up change.
    fireEvent.click(screen.getByTestId('rom-reuse-measure'));
    await waitFor(() => expect(screen.getByTestId('rom-visual-guide').dataset.beat).toBe('measure'));
    expect(screen.getByTestId('rom-visual-guide').contains(screen.getByTestId('rom-dwell-legend'))).toBe(true);
  });
});
