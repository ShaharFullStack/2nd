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

/** The lane contexts the fake VisionInput reports — derived, never hand-built (calibrationContext). */
const laneCtx = (i: number, mirrored: boolean): CalibrationContext =>
  calibrationContext(LANES[i].movement, { fingertip: LANES[i].fingertip, mirrored });

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
        movement: LANES[lane].movement,
        side: LANES[lane].side,
        reason:
          'the range measured is 0.01 wide, which is below the minimum for finger opposition — re-calibrate this lane',
      },
    ];
    void cal;
    return false;
  }),
};

const vision = {
  createCalibrator: (i: number) => new RomCalibrator(LANES[i].movement, { ...laneCtx(i, fake.mirrored) }),
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
    const line = await screen.findByTestId('rom-instruction');
    expect(line.textContent).toMatch(/little finger/i);
    expect(line.textContent).not.toMatch(/to the fingertip/i);
  });

  it('follows the therapist to another digit', async () => {
    useStore.setState({ lanes: [{ index: 0, movement: 'finger_opposition', side: 'right', fingertip: 'ring' }, LANES[1]] });
    render(<RomCalibrationScreen />);
    expect((await screen.findByTestId('rom-instruction')).textContent).toMatch(/ring finger/i);
  });

  it('leaves a movement with no fingertip dimension on its own wording', async () => {
    useStore.setState({ lanes: [LANES[1], LANES[0]] });
    render(<RomCalibrationScreen />);
    expect((await screen.findByTestId('rom-instruction')).textContent).toMatch(/Open your hand as wide as is comfortable/i);
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
