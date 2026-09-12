/**
 * THE HANDS-FREE CONFIRM, on screen.
 *
 * A target is drawn over the camera preview; the patient parks a HAND inside it; a ring fills while
 * they hold; it confirms when the ring is full. The maths is in `src/vision/dwell.ts` and is decided
 * frame by frame in a test — this file places the targets, renders them, and wires them to the vision
 * module.
 *
 * A hand in both modes, and in leg mode that is a change: the knees used to count and they cannot, for
 * the reason set out at the top of `dwell.ts` — a seated patient only puts a knee anywhere by doing a
 * prescribed leg movement, so a circle a knee can hold is a circle the exercise fills. It did, three
 * times, in the running app.
 *
 * AND A HAND IS ONLY A POINTER WHILE SOMETHING THE EXERCISE CANNOT MOVE IS HOLDING IT UP. A hand
 * resting on the thigh is carried by the thigh; driven through these classes it filled the primary
 * circle in 3.23 s on the first repetition of a seated march. So this file asks the vision module
 * whether the limb it is following is independent of the prescription (`dwellReferences`,
 * `DwellCoupling`), follows the other hand when it is not, and stands the rings down and says so when
 * there is no other hand — see the `coupled` phase and `DwellLegend`'s carried sentence.
 *
 * WHAT THE DRAWING HAS TO SURVIVE
 * -------------------------------
 *  - A CLINIC TABLET AT 2 m. Everything is one SVG on a fixed viewBox sized as a fraction of the
 *    camera frame, so the ring, the glyph and the caption all scale together with the preview instead
 *    of a 13 px label sitting under a 150 px ring. Text is painted with a dark stroke under the fill
 *    (`paint-order`), which is the only thing that keeps white type legible over a live video of an
 *    unknown room.
 *  - LOW VISION, AND COLOUR VISION THAT IS NOT THE DESIGNER'S. No state is signalled by hue alone.
 *    Each one has its own GLYPH (✕ nothing tracked, ◎ come in, ↻ move out and back, ⊘ a limb lives
 *    here, ⊗ the exercise is carrying this limb, a COUNTDOWN while holding, ✓ confirmed) and its own
 *    ring pattern (dashed when nothing is tracked, solid when the limb is there, a filling arc while
 *    holding). Colour is the fourth cue.
 *  - BEING BIG ENOUGH TO AIM AT. The ring used to be 58 px across on the 1024x768 tablet this is built
 *    for — about 0.6 degrees of visual angle at a metre, against assistive-technology guidance of 1.5
 *    degrees for a dwell-activated control. It is now as large as the clearance gate can place (see
 *    the radius note below), and the thing that says WHICH of two rings is which survives being
 *    rastered at a fifth of the size, because that is what a patient across a room sees.
 *  - TWO TARGETS THAT MEAN OPPOSITE THINGS, at 1/5 scale. "Next movement" and "Do it again" — or
 *    "Play again" and "New session" — used to render identically: same size, same white ring, same
 *    glyph, same caption size, distinguishable only by reading two words from two metres. The
 *    secondary action is now SMALLER (a smaller `radius`, which is a smaller circle to hold as well as
 *    a smaller ring to look at) and has a different SILHOUETTE (a square backing plate and a doubled
 *    ring, against the primary's disc and single ring), AND a tone mark inside the ring — a double
 *    chevron onward, a back-pointing chevron with a tail — because size tells the two apart without
 *    saying which is which, and at a fifth of the size the caption is not readable at all. Shape and
 *    size first, words fourth.
 *  - `reducedMotion`. The idle breathing of the ring is the only animation, and that setting removes
 *    it. The arc still fills — that is not decoration, it is the measurement.
 *
 * COORDINATES, AND THE CAMERA THE APP ACTUALLY OPENS. Targets are AUTHORED in the detector's
 * normalized frame at 4:3 — the shape `.camera-frame` is and the shape the camera is asked for. The
 * camera is under no obligation to agree: 640x480 is an `ideal` constraint and most laptop sensors
 * hand back 16:9 (VisionInput.ts, `syncCameraAspect`). Two things therefore happen here, both from the
 * live `VisionInput.getXScale()` and never from an assumption:
 *   - the target is re-expressed in the delivered frame (`retargetForAspect`), so its offset from the
 *     centre stays the same physical distance instead of growing with the sensor's width;
 *   - it is placed on the glass through the same `object-fit: cover` crop the <video> gets
 *     (`previewPlacement`), so the circle the tracker tests IS the circle the patient can see.
 * The preview is always CSS-mirrored (that is what a patient expects of a camera), so x is flipped
 * here, exactly once, and the caption is not mirrored with it.
 */
import { useEffect, useRef, useState } from 'react';
import type { Mode } from '../engine/types.ts';
import { runtime } from '../session/runtime.ts';
import { useStore } from '../state/store.ts';
import {
  DWELL_AUTHORED_ASPECT,
  DWELL_CLEAR_EXTRA,
  DWELL_DEFAULTS,
  DwellCoupling,
  DwellEngagement,
  DwellHabitat,
  DwellLayout,
  DwellTracker,
  dwellAxisFor,
  dwellLimbs,
  dwellOrigin,
  dwellReferences,
  dwellTargetClear,
  pickDwellLimb,
  retargetForPreview,
} from '../vision/dwell.ts';
import type { DwellCircle, DwellClearance, DwellCouplingVerdict, DwellLimb, DwellPoint, DwellState } from '../vision/dwell.ts';
import type { VisionInput } from '../input/VisionInput.ts';

/**
 * Aspect ratio of the BOX the preview is drawn in (`.camera-frame` is 4/3), which is also the frame
 * the targets below are authored in. It is not an assumption about the camera — see the header.
 */
export const PREVIEW_ASPECT = DWELL_AUTHORED_ASPECT;

/* ---------------- where the targets go ---------------- */

/**
 * WHERE A TARGET STARTS. It is a clinical choice, not a layout one — and since the critic's report it
 * is only ever a STARTING POINT: `useDwellTargets` measures where this patient's limbs actually live
 * (`DwellHabitat`) and moves the circle off them when these numbers turn out to be wrong for the body
 * in front of the camera. What is below is the position the app opens at, chosen so that it is right
 * for most framings and so that a patient finds the same circle in the same place from screen to
 * screen; what makes it SAFE is the measurement, not the number.
 *
 * That distinction is the whole lesson of the last two rounds of review. The numbers here used to be
 * defended by a sweep over this repo's synthetic rigs, and a critic who rebuilt the envelope with
 * different framing assumptions walked straight through it: a leg-mode hand resting at (0.70, 0.45)
 * sits 0.1327 from the primary centre against an exit radius of 0.1438, and a hand-mode palm at 1.6×
 * scale framed a tenth of a frame high sits 0.0967 from it — inside the drawn circle. `handPose` puts
 * a resting palm at y 0.63 BY CONSTRUCTION, and nothing in the app enforces, measures or mentions
 * that. The sweep in `DwellTarget.test.tsx` is now wide enough to contain both of those escapes, and
 * where the OPENING position does not clear a body, the test asserts that the gate stands the ring
 * down and the placement moves it — rather than asserting the escape away.
 *
 * The two things the opening position still has to get right:
 *
 *  1. SOMEWHERE A LIMB USUALLY IS NOT. Not just the centre of the circle: the whole activation region,
 *     the hysteresis band included.
 *  2. SOMEWHERE THE PATIENT CAN ACTUALLY HOLD FOR 1.8 s. The app prescribes the posture itself
 *     (features.ts, POSTURE_INFO): in HAND mode "rest your forearm on the table with your palm facing
 *     the camera", which puts the palm centre low and central — the original target at y 0.3, x 0.5
 *     was 0.45 frame-heights away and straight up, i.e. an unsupported arm held in the upper third of
 *     the frame for nearly two seconds, at the camera check AND the latency check, by an affected limb
 *     late in a fatigued session. That is a therapy exercise, not a click. The targets are OUT TO THE
 *     SIDE and only modestly up: a slide along the table with the elbow still on it. Hand mode moves
 *     the circle SIDEWAYS when it has to move it, for the same reason — the table carries the arm, and
 *     sideways is the one direction the prescription never takes the palm.
 *     In LEG mode the patient is seated and their HANDS ARE FREE (they are exercising their legs), so
 *     the targets sit up and out where a raised hand reaches easily, and leg mode moves the circle UP
 *     when a hand lives too close to it.
 */
const TARGET_Y: Readonly<Record<Mode, number>> = Object.freeze({ hand: 0.37, leg: 0.23 });
/**
 * The forward action always sits in the SAME place for a given mode — detector x > 0.5, which the
 * mirrored preview draws on the LEFT of the screen — whether it is the only target on the screen or
 * the left half of a pair. A patient who has learned "hold on the left circle" at the camera check
 * finds the same circle in the same place at every step after it, and the legend beside it can say
 * "the left circle" and be telling the truth.
 *
 * BOTH MODES MOVED OUT WHEN THE RINGS GREW, and they had to. A ring only earns its size where it
 * CLEARS the support the app asks the patient to use, by its own exit band plus a margin (the gate,
 * `dwellClearance`) — otherwise every screen opens standing on the patient's hand, says "a limb rests
 * here", and slides itself somewhere else while they watch. Measured against the rest positions the
 * sweeps drive:
 *   - LEG mode's binding case is a hand on a HIGH CHAIR ARM at (0.70, 0.45) — the support
 *     `POSTURE_INFO.seated_leg` now names, so the common case and not an exotic one. The old
 *     (0.72, 0.32) ring did not clear it at any size (it was 0.041 inside the band even at r 0.115,
 *     which is why the layout always had to move it); (0.78, 0.23) at r 0.15 clears it by 0.027 and
 *     clears every other rest position by more than 0.15.
 *   - HAND mode's is the prescribed posture itself: the clearance there is lateral only
 *     (`dwellAxisFor`) and is measured against the palm's own wander with a floor of 0.75 PALM
 *     LENGTHS, so a ring big enough to aim at does not clear a palm resting on the table until it is
 *     about a quarter of the frame width off the midline.
 * The reach both of them ask for is still bounded and still measured: leg mode is a raised hand from
 * any rest position, hand mode a slide along the table, and both are held to `DWELL_LIMB_REACH` in
 * "reach: the hold has to be performable from the posture the app prescribes".
 */
const PRIMARY_X: Readonly<Record<Mode, number>> = Object.freeze({ hand: 0.75, leg: 0.78 });
/** The secondary action, far enough away that no point is inside both, hysteresis bands included. */
const SECONDARY_X: Readonly<Record<Mode, number>> = Object.freeze({ hand: 0.25, leg: 0.22 });
/**
 * RADIUS IN PREVIEW-BOX HEIGHTS — and the number is a target the patient has to SEE and AIM AT, not a
 * decoration whose size fell out of the layout.
 *
 * What it was: 0.115, which on the 1024x768 clinic tablet this app is built for is a 337x253 preview
 * (index.css caps it at 33vh so the legend fits) and therefore a 29 px radius — 58 px across, about
 * 0.6 degrees of visual angle at a metre. Assistive-technology guidance for a dwell-activated control
 * is 1.5 degrees and up (~26 mm, ~100 px on a 10-inch tablet): the ring the whole hands-free path
 * depends on was less than half the smallest size a low-vision patient is expected to acquire.
 *
 * What bounds it from above is not the layout but the GATE: a hold may only accumulate where the
 * circle clears every limb's measured habitat by its own exit band (radius x 1.25) plus a margin, so
 * every unit of radius costs 1.25 units of clear water in a frame that already contains two hands, two
 * knees and a chair. Measured against the rest positions the sweeps use, 0.15 is the largest LEG ring
 * that still CLEARS a hand on a high chair arm from the position above — 76 px across at 1024x768,
 * 88 px on a 38vh preview, roughly 1.1-1.3 degrees at a metre, against 58 px and 0.6 before.
 *
 * HAND MODE CANNOT HAVE EVEN THAT, and the reason is its clearance rule rather than its layout: there
 * the separation is lateral only and is measured against the palm's own wander with a floor of 0.75
 * palm lengths, so a 0.16 ring has nowhere to stand at all for a palm framed off-centre at 1.6x scale
 * (36 % of the sitting-still bodies lost the hands-free path outright when it was tried). 0.13 keeps
 * every one of them and is still 66 px across, up from 58.
 *
 * FULL AT SIZE NEEDS A BIGGER PREVIEW, NOT A BIGGER FRACTION OF THE FRAME, and that is a CSS decision
 * on the screens rather than a number here: index.css caps `--preview-max-h` at 33vh on a short
 * viewport so the legend fits under it. At 40vh the same 0.16 is 98 px across — the AT figure — with no
 * change to any of the geometry above. Said out loud because it is the one part of this the module
 * cannot fix for itself.
 */
const PRIMARY_R: Readonly<Record<Mode, number>> = Object.freeze({ hand: 0.13, leg: 0.15 });
/**
 * The secondary is the same in both modes and it is a third smaller than the leg primary, because size
 * is the FIRST thing that tells the two rings apart — and it is still a circle a patient has to hold a
 * limb inside, so it is 53 px across at 1024x768 rather than the 46 px it was.
 */
const SECONDARY_R = 0.105;
/**
 * The largest radius any secondary has, and the smallest any primary has: `toneOf` reads the tone off
 * the size for screens that do not say which is which, so the two sets must not overlap. Asserted in
 * "the layouts the screens ask for" rather than left as a comment.
 */
const TONE_SPLIT_R = (SECONDARY_R + Math.min(PRIMARY_R.hand, PRIMARY_R.leg)) / 2;

export function singleDwellTarget(mode: Mode): DwellCircle {
  return { x: PRIMARY_X[mode], y: TARGET_Y[mode], radius: PRIMARY_R[mode] };
}

/** `[primary, secondary]` — drawn with the forward action on the LEFT of the mirrored preview. */
export function pairedDwellTargets(mode: Mode): [DwellCircle, DwellCircle] {
  const y = TARGET_Y[mode];
  return [
    { x: PRIMARY_X[mode], y, radius: PRIMARY_R[mode] },
    { x: SECONDARY_X[mode], y, radius: SECONDARY_R },
  ];
}

/* ---------------- driving the trackers from the camera ---------------- */

export interface DwellChoice {
  /** Stable id; changing it rebuilds the tracker (and throws away the hold in progress). */
  id: string;
  target: DwellCircle;
  /** Two or three words for the ring: "Continue", "Redo", "Play again". */
  label: string;
  /** What happens when the hold completes. */
  onConfirm: () => void;
  /** False = drawn as unavailable and unable to confirm. Default true. */
  enabled?: boolean;
  /** Why it is unavailable, in the patient's words. Shown in place of the label. */
  disabledNote?: string;
  /**
   * Which of the two actions this is: 'go' carries the session forward, 'back' repeats or restarts.
   * It changes the SILHOUETTE and the size, not just a colour or a word. A screen that does not say is
   * read off the circle it asked for, since `pairedDwellTargets` already makes the secondary smaller.
   */
  tone?: 'go' | 'back';
}

export type DwellTone = 'go' | 'back';

/** The tone a choice renders as: explicit if the screen said, otherwise from the size it asked for. */
export function toneOf(choice: DwellChoice): DwellTone {
  return choice.tone ?? (choice.target.radius < TONE_SPLIT_R ? 'back' : 'go');
}

export interface DwellSession {
  /** Per choice id. Absent for a choice that is not enabled. */
  states: Record<string, DwellState>;
  /** The limb the targets are following right now, and what to call it. */
  limb: DwellLimb | null;
  /**
   * WHY THE LIMB BEING FOLLOWED CANNOT ANSWER, when it cannot: it is being carried by the prescribed
   * movement (a hand resting on the thigh, measured — `DwellCoupling`). Null when the limb is an
   * independent witness, or when there is not enough of a window to say either way.
   */
  coupled: DwellCouplingVerdict | null;
  /**
   * HOW MUCH ROOM EACH RING HAS, per choice id — the measurement the `occupied` gate actually decided
   * on (`dwellTargetClear`). It is published for the same reason `blocked` is drawn: a ring that is not
   * filling looks identical whether it is standing on a limb, following a limb the exercise is
   * carrying, or waiting for one that is not there, and those have three different remedies. The
   * critic harnesses read it off the legend (`data-rooms`); nothing in the UI depends on it.
   */
  rooms: Record<string, DwellClearance>;
  /** Frames are arriving from the camera. False = there is nothing hands-free to offer. */
  live: boolean;
  /** The frame aspect (width/height) the camera is actually delivering, as the trackers measured in. */
  xScale: number;
  /** Seconds between frames, as observed. 0 before enough frames have arrived to say. */
  frameIntervalSec: number;
}

const IDLE: DwellSession = Object.freeze({
  states: {},
  limb: null,
  coupled: null,
  rooms: {},
  live: false,
  xScale: PREVIEW_ASPECT,
  frameIntervalSec: 0,
});

/**
 * HOW LONG A GAP IN THE FRAMES IS A PROBLEM — measured, not assumed.
 *
 * This used to be a flat 0.2 s, which is a 5 fps floor nothing else in the app enforces: the camera
 * check's own readiness gate admits an `easy` prescription down to 5.6 fps, and below that the
 * watchdog fed the trackers `null` between every pair of real frames (so a 1.8 s hold took ~30 s at
 * 4 fps) while the legend announced "no camera frames are arriving" over a preview the patient could
 * see working. Both of those are untruths about a slow but functioning camera. The window now follows
 * the device's own cadence, with floors so a fast camera behaves exactly as before and ceilings so a
 * camera that has genuinely stopped is still called stopped within about a second.
 */
const MIN_STALE_SEC = 0.2;
/**
 * How long a target must have been sitting on a limb before the layout is moved off it.
 *
 * Nothing is at risk while it waits — a target that does not clear the patient accumulates nothing
 * from the moment it is measured (`DwellTracker.setOccupied`) — so this is purely about not shuffling
 * the rings around the preview because a hand passed underneath one on its way somewhere else.
 */
const CROWDED_GRACE_SEC = 0.5;
/** And once moved, it stays put for at least this long: a circle that jitters cannot be aimed at. */
const MOVE_INTERVAL_SEC = 1.5;
const MAX_STALE_SEC = 1.2;
/** Gaps are counted over this many frames, and the 80th percentile of them is "the frame interval". */
const CADENCE_WINDOW = 12;
const WATCHDOG_MS = 80;
/** Below this many frames a second the legend says so, rather than letting the ring look broken. */
const SLOW_FPS = 8;
/**
 * The slowest cadence at which a hold still takes the time it promises: while `maxStepSec` is at least
 * one frame interval, every frame credits the whole gap since the last one, so the ring keeps real
 * time. `dwellCadence` caps that step at 0.6 s, so below about 1.7 frames a second it stops being true
 * and the legend says the other thing.
 */
const REALTIME_INTERVAL_SEC = 0.6;

export interface DwellCadence {
  /** No frame for this long and the watchdog starts feeding the trackers nothing (a wedged camera). */
  staleSec: number;
  /** How long a tracker may see no landmark before it stops claiming the limb is being tracked. */
  graceSec: number;
  /** The biggest step one update may advance a hold by. */
  maxStepSec: number;
}

/**
 * The three timeouts, derived from the camera's observed frame interval.
 *
 * A 30 fps camera lands on exactly the numbers that were hard-coded before; a 4 fps one gets a window
 * wide enough that its frames are not treated as a stalled stream. The ceilings mean a camera that has
 * really stopped is still called stopped inside about a second and a half.
 */
export function dwellCadence(intervalSec: number): DwellCadence {
  const measured = Number.isFinite(intervalSec) && intervalSec > 0 ? intervalSec : 1 / 30;
  return {
    staleSec: clamp(measured * 2.5, MIN_STALE_SEC, MAX_STALE_SEC),
    graceSec: clamp(measured * 4, 0.4, 2),
    maxStepSec: clamp(measured * 2, 0.25, 0.6),
  };
}

function nowSec(): number {
  return (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * The frame aspect the camera is really delivering — or the authored 4:3 while it has not said.
 *
 * `VisionInput.getXScale()` is the value the movement features are already corrected by, so reading it
 * here is what makes "the circle tested is the circle drawn" true on a sensor that is not 4:3.
 *
 * IT HAS A "NOT YET" VALUE AND IT LOOKS EXACTLY LIKE A SQUARE SENSOR. `getXScale()` answers 1 until the
 * <video> element reports a size (VisionInput.ts: `this.lanes[0]?.pipeline.getXScale() ?? 1`, and
 * `syncCameraAspect` cannot act until `videoWidth` is non-zero), and 1 is finite and positive, so the
 * old test here accepted it: the first frames were re-aspected as if for a square sensor — detector x
 * 0.72 became 0.793, a quarter of a radius out — and then jumped when the real aspect arrived, taking
 * any hold in progress with them. That source cannot be changed from here, so the ambiguity is resolved
 * on this side: the camera is not believed about its shape until it has actually delivered a frame,
 * and until then the authored 4:3 (which is also the shape of the preview box) stands.
 */
function liveXScale(): number {
  const vision = runtime.peekVision();
  // Defensively: a replay or a stubbed input source need not implement either method, and a target
  // that cannot find out what shape the frames are falls back to the frame it was authored in.
  if (!vision) return PREVIEW_ASPECT;
  const frames = typeof vision.getStats === 'function' ? vision.getStats().frames : undefined;
  if (frames !== undefined && !(frames > 0)) return PREVIEW_ASPECT;
  const s = typeof vision.getXScale === 'function' ? vision.getXScale() : undefined;
  // A sensor outside this band is a number nobody should be re-aspecting a circle by.
  return typeof s === 'number' && Number.isFinite(s) && s >= 0.5 && s <= 4 ? s : PREVIEW_ASPECT;
}

function sameState(a: DwellState | undefined, b: DwellState): boolean {
  if (!a) return false;
  return (
    Math.round(a.progress * 200) === Math.round(b.progress * 200) &&
    a.inside === b.inside &&
    a.tracked === b.tracked &&
    a.holding === b.holding &&
    a.blocked === b.blocked &&
    a.confirmations === b.confirmations &&
    a.target === b.target
  );
}

/**
 * Run a set of dwell targets against the live camera.
 *
 * Updates are driven by the vision module's per-frame callback — one observation, one update — with a
 * watchdog that feeds `null` when frames stop, so a wedged camera decays the ring instead of freezing
 * it half full. The render is a separate rAF loop that only publishes when something visibly changed.
 */
export function useDwellTargets(choices: readonly DwellChoice[]): DwellSession {
  const mode = useStore((s) => s.mode);
  const mirrored = useStore((s) => s.settings.mirrored);
  /**
   * THE PRESCRIPTION ITSELF, because the pointer's independence from it is measured rather than
   * assumed (`dwellReferences`). Only the movements and sides are read, and only to build the
   * reference signals a candidate pointer's travel is correlated against — nothing here changes what
   * is scored, and a screen with no prescription yet still gets the raw-segment references.
   */
  const lanes = useStore((s) => s.lanes);
  const setHandsFree = useStore((s) => s.setHandsFree);
  const [session, setSession] = useState<DwellSession>(IDLE);

  // The live list, so a re-render with new callbacks does not rebuild the trackers (and lose the hold).
  const latest = useRef(choices);
  latest.current = choices;

  // Rebuild only when the SHAPE of the offer changes: which targets exist, where, and whether they
  // may be confirmed. Callback identity is deliberately not part of this.
  const shape = choices
    .map((c) => `${c.id}@${c.target.x},${c.target.y},${c.target.radius}${c.enabled === false ? ':off' : ''}`)
    .join('|');

  useEffect(() => {
    const offered = latest.current;
    if (offered.length === 0) {
      setSession(IDLE);
      return;
    }
    let xScale = liveXScale();
    /**
     * WHERE THE PATIENT'S LIMBS ACTUALLY LIVE, and what that is allowed to change.
     *
     * `DwellHabitat` (vision/dwell.ts) records every limb's position for twenty seconds and reports
     * robust statistics about it. Two things are driven from it, every watchdog tick:
     *   - THE GATE. A tracker whose circle does not clear every limb's habitat is told so
     *     (`setOccupied`) and accumulates nothing. This is the guarantee, and it holds whatever the
     *     framing, the patient's size or the sensor: nothing is assumed about where a limb rests.
     *   - THE REMEDY. A circle that does not clear is MOVED — along the axis the confirm gesture is
     *     made in for this mode — to the nearest place that does. A stood-down ring is safe and
     *     useless; this is what keeps the hands-free path usable for the patient it lands on.
     * Placement only ever moves off a limb, never back for cosmetic reasons: a circle that has been
     * moved stays where the patient learned it for as long as this screen offers it.
     */
    const habitat = new DwellHabitat();
    /**
     * WHETHER THE LIMB THAT IS POINTING IS AN INDEPENDENT WITNESS — measured, not instructed.
     *
     * Leg mode follows the hands because a knee cannot answer, and that only separates the gesture
     * from the exercise while the hand is held up by something the exercise does not move. A hand
     * resting ON THE THIGH is carried by the thigh: hip flexion lifts it, circumduction swings it, and
     * driven through these very classes it confirmed the primary ring at 3.23 s on the first
     * repetition. `POSTURE_INFO.seated_leg` now asks for a chair arm or a table and says why not the
     * thigh — and this is the half that does not depend on the patient having been told, or having
     * heard, or having a chair with arms. A limb moving with the prescribed movement is not followed
     * while another limb is available, and when it is the only limb there is, the rings stand down and
     * say what to do (`DwellTracker.setCoupled`, phase 'coupled').
     */
    const coupling = new DwellCoupling();
    /**
     * …and WHICH FRAMES ARE EVIDENCE ABOUT WHERE A LIMB LIVES. A limb inside a ring for less than a
     * gesture's worth of time is answering; one that is still there after that lives there, whatever
     * the app would prefer to believe (`DwellEngagement`). The position-only version of this rule is
     * what let a hand resting inside the (now bigger) drawn circle be recorded as living elsewhere.
     */
    const engagement = new DwellEngagement();
    // The clearance rule, in one place: the gate, the placement solver and the published `rooms` have
    // to be measuring the same thing or the screen would be explaining a decision nobody made.
    const clearanceOpts = {
      xScale,
      axis: dwellAxisFor(mode),
      exitRatio: DWELL_DEFAULTS.exitRatio,
      extra: DWELL_CLEAR_EXTRA,
    };
    const layout = new DwellLayout(
      offered.map((c) => ({ id: c.id, authored: c.target, enabled: c.enabled !== false })),
      {
        ...clearanceOpts,
        crowdedGraceSec: CROWDED_GRACE_SEC,
        moveIntervalSec: MOVE_INTERVAL_SEC,
        // The layout re-expresses its circles in the delivered frame; `xScale` here follows it.
        fits: (circle: DwellCircle) => dwellCircleFits(circle, xScale),
      },
    );
    // Trackers only for what may actually be confirmed — but the camera is watched whenever a target
    // is DRAWN, enabled or not. Otherwise a screen whose gate has not opened yet would report "no
    // frames are arriving" over a preview that is plainly working, which is the opposite of honest.
    const trackers = new Map<string, DwellTracker>();
    for (const c of offered) {
      if (c.enabled !== false) trackers.set(c.id, new DwellTracker(layout.circleFor(c.id) as DwellCircle, { xScale }));
    }
    let circles = layout.circles();

    let attached: VisionInput | null = null;
    let off: (() => void) | null = null;
    let lastFrame = -Infinity;
    let limb: DwellLimb | null = null;
    let coupledVerdict: DwellCouplingVerdict | null = null;
    let previous: DwellPoint | null = null;
    let previousKey: string | null = null;
    let rooms: Record<string, DwellClearance> = {};
    let published: Record<string, DwellState> = {};
    let publishedLimb: string | null = null;
    let publishedCoupled: string | null = null;
    let publishedLive = false;
    let cancelled = false;

    // The device's own cadence (see the note on MIN_STALE_SEC).
    const gaps: number[] = [];
    let interval = 0;
    let staleSec = MIN_STALE_SEC;
    const cadence = () => {
      const next = dwellCadence(interval);
      staleSec = next.staleSec;
      for (const tracker of trackers.values()) tracker.setCadence(next.graceSec, next.maxStepSec);
    };
    const noteFrame = (t: number) => {
      const gap = t - lastFrame;
      if (Number.isFinite(gap) && gap > 0 && gap < 3) {
        gaps.push(gap);
        if (gaps.length > CADENCE_WINDOW) gaps.shift();
        if (gaps.length >= 3) {
          const sorted = [...gaps].sort((a, b) => a - b);
          interval = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.8))];
        }
      }
      lastFrame = t;
      cadence();
    };
    cadence();

    const feed = (point: DwellPoint | null, t: number, key: string | null) => {
      for (const [id, tracker] of trackers) {
        const state = tracker.update(point, t, key);
        if (!state.confirmed) continue;
        // A confirm is the patient choosing, so it is also the evidence that they are working alone:
        // the flag keeps the camera alive on the results screen, where the therapist's buttons would
        // otherwise be the only way off the last screen of the session.
        setHandsFree(true);
        latest.current.find((c) => c.id === id)?.onConfirm();
      }
    };

    /**
     * THE DELIBERATE HOLD IS NOT EVIDENCE ABOUT WHERE THE LIMB LIVES.
     *
     * The exercise is, a tremor is, a hand that genuinely sits where a circle was drawn is. But the
     * hold the patient is making right now, and the moment after it while the limb is still on the
     * answered target, would teach the record that the limb LIVES on the target — and the requirement
     * would then grow by exactly the reach the gesture consists of, until no ring could ever be
     * filled. Order statistics absorb one such excursion; a ROM screen where the patient confirms four
     * lanes in twenty seconds is another matter, so the gesture itself is excluded outright.
     *
     * In leg mode the exclusion goes one step further — see `dwellEngaged`: a HAND inside one of these
     * circles is a hand the patient raised, because nothing in a leg prescription puts one there. Left
     * counted, a patient who confirmed and then simply left their hand where it was would find the
     * next screen's ring moving out from under them. (Hand mode counts those frames, because there the
     * palm is anchored on the table by the prescription and being inside a circle says nothing at all
     * about intent — which is the critic's second escape, a resting palm INSIDE the drawn circle.)
     */
    const busy = () => {
      for (const tracker of trackers.values()) {
        const s = tracker.state;
        if (s.progress > 0 || s.blocked === 'refractory') return true;
      }
      return false;
    };

    /** Re-measure the layout against where the limbs live, and act on the verdict. */
    const survey = (t: number) => {
      const summaries = habitat.all(t, xScale);
      const { occupied, moved } = layout.survey(summaries, t, busy());
      if (moved) {
        circles = layout.circles();
        for (const [id, tracker] of trackers) tracker.setTarget(layout.circleFor(id) as DwellCircle, xScale);
      }
      for (const [id, tracker] of trackers) tracker.setOccupied(occupied.get(id) === true);
      const next: Record<string, DwellClearance> = {};
      for (const [id] of trackers) {
        next[id] = dwellTargetClear(layout.circleFor(id) as DwellCircle, summaries, clearanceOpts);
      }
      rooms = next;
    };

    /** The camera finally said what shape its frames are (or changed it mid-stream). */
    const syncAspect = () => {
      const next = liveXScale();
      if (next === xScale) return;
      xScale = next;
      layout.setXScale(next);
      circles = layout.circles();
      for (const [id, tracker] of trackers) tracker.setTarget(layout.circleFor(id) as DwellCircle, xScale);
      // The record was taken in the old frame; the statistics it holds are in the old units.
      habitat.clear();
      coupling.clear();
      engagement.clear();
    };

    const attach = () => {
      const vision = runtime.peekVision();
      if (vision === attached) return;
      off?.();
      off = null;
      // A different camera is a different framing: nothing the old one taught about where this
      // patient's limbs live is evidence about the new one.
      if (attached) {
        habitat.clear();
        coupling.clear();
        engagement.clear();
      }
      attached = vision;
      if (!vision) return;
      off = vision.onFrame((_samples, _ctxTime, result) => {
        if (cancelled) return;
        const t = nowSec();
        noteFrame(t);
        const limbs = dwellLimbs(result, mode, mirrored, xScale);
        const references = dwellReferences(result, mode, { lanes, mirrored, xScale });
        // The patient's own frame of reference, so that a chair scoot or a nudged camera is not read
        // as a limb travelling with the exercise (`dwellOrigin`).
        const origin = dwellOrigin(result);
        /**
         * THE COUPLING RECORD TAKES EVERY FRAME, and that is a deliberate difference from the habitat.
         *
         * The habitat has to leave out the frames in which a limb is answering, or the reach teaches it
         * that the limb lives on the ring and the requirement grows by exactly the gesture. The
         * coupling question has no such circularity — it asks whether this limb's travel is EXPLAINED
         * by the exercise, and it is measured on frame-to-frame increments, so a limb parked in a ring
         * contributes nothing either way and a one-off reach is a minority of a window whose majority
         * is the limb not moving while the exercise does.
         *
         * Leaving those frames out was tried first and it starved the measurement of the only frames
         * that matter: a hand carried up the thigh ENTERS the ring on the way (that is the defect), so
         * the exclusion switched the record off for the whole rise and the verdict never arrived before
         * the ring filled. Measured in the running classes: the window stalled at 9 samples and the
         * primary confirmed at 2.90 s.
         */
        for (const l of limbs) coupling.noteOne(l.key, l.point, references, t, xScale, origin);
        // An answer in flight (or just finished) is what the habitat has to be kept away from; see
        // `DwellEngagement`. Everything else about a limb inside a ring is evidence.
        if (busy()) engagement.noteAnswering(t);
        const carried = coupling.coupledKeys(t);
        {
          /**
           * WHICH LIMB IS ANSWERING IS A PER-LIMB QUESTION. This block used to be skipped entirely
           * whenever ANY hold was accumulating (`if (!busy())`), which silenced the record for every
           * limb in the frame — including the hand resting in the patient's lap, which is exactly the
           * limb the gate needs to know about. Worse, on a body whose hand rests INSIDE a drawn circle
           * the hold starts the instant the hand returns, so the blanket guard threw away every frame
           * that could ever have taught the habitat where that hand lives: it filled the ring five
           * times in thirty seconds, measured. `DwellEngagement` answers the same question properly —
           * per limb, from where it is and what the rings are doing — so the blanket guard is gone.
           */
          const engagedCounts = dwellAxisFor(mode) === 'radial';
          for (const l of limbs) {
            /**
             * A LIMB THE EXERCISE IS CARRYING IS NOT LIVING ANYWHERE, so its travel is not evidence
             * about where it lives. Recording it is what turned a hand on the thigh into a limb that
             * "wanders" over a third of the frame — and `dwellClearance` demands the band PLUS the
             * measured wander, so every ring on the screen became unplaceable for the whole
             * twenty-second window, including for the patient's OTHER hand. Measured in the running
             * app: required clearance 0.634 against a frame that is 1.0 high. The remedy the screen
             * offers ("rest it on the arm of the chair") then could not be acted on, which is the
             * worst version of this: an instruction the app itself has made impossible to follow.
             * Its RESTING position still counts — the frames before the movement starts, and every
             * frame after the verdict lapses — which is what the gate actually needs.
             */
            if (carried.has(l.key)) continue;
            if (engagedCounts && engagement.gesture(l.key, l.point, circles, t, xScale, DWELL_DEFAULTS.exitRatio)) continue;
            habitat.noteOne(l.key, l.point, t, l.scale ?? null);
          }
        }
        limb = pickDwellLimb(limbs, circles, {
          xScale,
          previous,
          previousKey,
          avoid: carried,
        });
        previous = limb?.point ?? null;
        previousKey = limb?.key ?? null;
        coupledVerdict = limb && carried.has(limb.key) ? coupling.verdict(limb.key, t) : null;
        for (const tracker of trackers.values()) tracker.setCoupled(coupledVerdict !== null);
        feed(limb?.point ?? null, t, limb?.key ?? null);
      });
    };

    attach();
    const watchdog = setInterval(() => {
      attach();
      syncAspect();
      const t = nowSec();
      survey(t);
      if (t - lastFrame > staleSec) {
        limb = null;
        previous = null;
        previousKey = null;
        // Nothing is being followed, so nothing is being carried: a stale stream must not leave the
        // rings blaming a limb that is no longer in the picture.
        coupledVerdict = null;
        for (const tracker of trackers.values()) tracker.setCoupled(false);
        feed(null, t, null);
      }
    }, WATCHDOG_MS);

    let raf = 0;
    const publish = () => {
      raf = requestAnimationFrame(publish);
      const live = nowSec() - lastFrame <= staleSec;
      const limbLabel = limb?.label ?? null;
      const carriedKey = coupledVerdict?.key ?? null;
      let changed = live !== publishedLive || limbLabel !== publishedLimb || carriedKey !== publishedCoupled;
      const next: Record<string, DwellState> = {};
      for (const [id, tracker] of trackers) {
        next[id] = tracker.state;
        if (!sameState(published[id], tracker.state)) changed = true;
      }
      if (!changed) return;
      published = next;
      publishedLimb = limbLabel;
      publishedLive = live;
      publishedCoupled = carriedKey;
      setSession({ states: next, limb, coupled: coupledVerdict, rooms, live, xScale, frameIntervalSec: interval });
    };
    raf = requestAnimationFrame(publish);

    return () => {
      cancelled = true;
      clearInterval(watchdog);
      cancelAnimationFrame(raf);
      off?.();
    };
  }, [shape, mode, mirrored, lanes, setHandsFree]);

  return session;
}

/* ---------------- the drawing ---------------- */

/**
 * WHERE A CIRCLE IN THE DETECTOR'S FRAME LANDS ON THE GLASS.
 *
 * `.camera-frame` is a 4:3 box and the <video> inside it is `object-fit: cover`, so a frame that is
 * not 4:3 is cropped to fill it: a 16:9 sensor loses 12.5 % off each side, and a taller-than-4:3 frame
 * loses the top and bottom instead. Without this, a target drawn at CSS-left 27 % of a 16:9 preview is
 * really at detector x 0.328 while the tracker tests 0.27 — half the pair radius out, in the direction
 * nobody would notice until a patient reached for it.
 *
 * Returns fractions of the BOX: where the ring centre goes, and how many box-heights one frame-height
 * is (which is what sizes the ring, since `radius` is in frame heights).
 */
export function previewPlacement(
  circle: DwellCircle,
  xScale: number,
  boxAspect = PREVIEW_ASPECT,
): { x: number; y: number; heightScale: number } {
  const src = Number.isFinite(xScale) && xScale > 0 ? xScale : boxAspect;
  // Fraction of the source frame that survives the cover crop, per axis.
  const visX = Math.min(1, boxAspect / src);
  const visY = Math.min(1, src / boxAspect);
  return {
    x: (circle.x - (1 - visX) / 2) / visX,
    y: (circle.y - (1 - visY) / 2) / visY,
    heightScale: 1 / visY,
  };
}

/**
 * One fixed viewBox for the ring AND its caption, so every part of the target scales with the
 * preview together. The ring is centred at (CX, CY) with radius R; the caption lives below it inside
 * the same box. The wrapper is sized so that 2·R of viewBox equals the target's diameter in frame
 * heights — see the inline style.
 */
const VB_W = 140;
const VB_H = 176;
const CX = 70;
/** Ring centre when the caption hangs BELOW the ring; mirrored to VB_H - CY when it sits above. */
const CY = 52;
const R = 46;
const CIRC = 2 * Math.PI * R;

/**
 * CAN THIS CIRCLE BE DRAWN WHOLE, ring and caption, inside the preview?
 *
 * The placement solver has to ask, because a target moved off a patient's limbs is no use where the
 * ring or its two lines of type fall off the edge of the frame (seen in the running app at 1024x768
 * before the caption learned to flip above a low ring). This is the SAME arithmetic the component
 * below lays the target out with — box fractions, the caption's side chosen by `place.y <= 0.5` — so
 * the answer is about the target that will actually be drawn rather than about an idealised disc.
 */
export function dwellCircleFits(circle: DwellCircle, xScale: number, boxAspect = PREVIEW_ASPECT): boolean {
  const place = previewPlacement(circle, xScale, boxAspect);
  if (!Number.isFinite(place.x) || !Number.isFinite(place.y)) return false;
  const h = 2 * circle.radius * place.heightScale * (VB_H / (2 * R));
  const cy = place.y <= 0.5 ? CY : VB_H - CY;
  const top = place.y - (cy / VB_H) * h;
  const w = (h * (VB_W / VB_H)) / boxAspect;
  const left = place.x - w / 2;
  return top > 0 && top + h < 1 && left > 0 && left + w < 1;
}

type Phase = 'lost' | 'enter' | 'reenter' | 'holding' | 'done' | 'off' | 'occupied' | 'coupled';

function phaseOf(state: DwellState | undefined, enabled: boolean): Phase {
  if (!enabled) return 'off';
  // Enabled but nothing observed yet (the first frames have not arrived, or the camera is gone): that
  // is "I cannot see you", not "this is unavailable". The two have different remedies and the patient
  // is the one who has to tell them apart.
  if (!state) return 'lost';
  if (state.blocked === 'refractory') return 'done';
  if (!state.tracked) return 'lost';
  // A ring standing on top of a limb that lives there. It is ahead of the hold states deliberately:
  // this ring is not filling and will not fill, and a patient holding harder is the one thing that
  // cannot help. It is behind "not seeing you" just as deliberately — a target cannot be said to be
  // sitting on a limb the camera is not currently reporting.
  // The limb being followed is being carried by the prescribed movement. It is AHEAD of 'occupied'
  // because it is the one state neither holding harder nor waiting for the ring to slide somewhere
  // clear can fix: the remedy is to put the hand on something the exercise does not move.
  if (state.blocked === 'coupled') return 'coupled';
  if (state.blocked === 'occupied') return 'occupied';
  if (state.holding || state.progress > 0) return 'holding';
  if (state.blocked === 'entry') return 'reenter';
  return 'enter';
}

/** Glyph, ring colour and dash pattern per phase. Never colour alone — see the header. */
const PHASE_STYLE: Readonly<Record<Phase, { glyph: string; colour: string; dash: string | undefined }>> = Object.freeze({
  lost: { glyph: '✕', colour: '#ffb020', dash: '10 9' },
  enter: { glyph: '◎', colour: '#ffffff', dash: undefined },
  reenter: { glyph: '↻', colour: '#ffb020', dash: '18 7' },
  holding: { glyph: '', colour: '#35d6ff', dash: undefined },
  done: { glyph: '✓', colour: '#57e08a', dash: undefined },
  off: { glyph: '–', colour: '#9fabc7', dash: '4 10' },
  occupied: { glyph: '⊘', colour: '#ffb020', dash: '3 7' },
  // Its own glyph and its own pattern, like every other state: a hand the exercise is moving is not
  // the same thing as a ring standing on a hand that is still.
  coupled: { glyph: '⊗', colour: '#ffb020', dash: '14 6 3 6' },
});

/** The sentence in the middle of the ring — a countdown while holding, a glyph otherwise. */
function ringGlyph(phase: Phase, state: DwellState | undefined): string {
  if (phase !== 'holding' || !state) return PHASE_STYLE[phase].glyph;
  // Seconds still to hold, rounded UP: "1" must never appear over a ring that needs 1.4 s more.
  return String(Math.max(1, Math.ceil(state.remainingSec)));
}

export interface DwellTargetProps {
  choice: DwellChoice;
  state: DwellState | undefined;
  /** The preview under it is CSS-mirrored (it always is in this app). Default true. */
  mirrored?: boolean;
  reducedMotion?: boolean;
  /**
   * Frame aspect of the camera, for a target that has no state yet to carry it (a disabled one, or
   * the frames before the first). Tests pass it explicitly; screens do not have to.
   */
  xScale?: number;
  testId?: string;
}

/**
 * The ring itself. Renders absolutely INSIDE a `.camera-frame`, on top of the video and the landmark
 * overlay.
 */
export function DwellTarget({ choice, state, mirrored = true, reducedMotion = false, xScale, testId }: DwellTargetProps) {
  const enabled = choice.enabled !== false;
  const phase = phaseOf(state, enabled);
  const tone = toneOf(choice);
  const style = PHASE_STYLE[phase];
  const progress = enabled && state ? Math.max(0, Math.min(1, state.progress)) : 0;
  /**
   * THE CIRCLE THAT WAS TESTED, not the one the screen asked for. They differ on any camera that is
   * not 4:3, and drawing the second while testing the first is how a target ends up half a radius away
   * from where the patient is told to put their hand.
   */
  const fallbackScale = xScale ?? liveXScale();
  const circle = state?.target ?? retargetForPreview(choice.target, fallbackScale);
  const frameScale = state?.xScale ?? fallbackScale;
  const place = previewPlacement(circle, frameScale);
  const { radius } = circle;

  // 2·R viewBox units must cover `2 · radius` of FRAME HEIGHT (as cropped into the box); the box is
  // then as tall as the whole viewBox, which is where the caption gets its room from.
  const heightPct = 2 * radius * place.heightScale * (VB_H / (2 * R)) * 100;
  const caption = enabled ? choice.label : (choice.disabledNote ?? choice.label);
  /**
   * THE CAPTION GOES WHEREVER THERE IS FRAME LEFT.
   *
   * The preview clips its own bounds (it has to: it has rounded corners over a live video), and a
   * leg-mode target sits at knee height — 55 % down the frame — where two lines of type under a ring
   * this size fall off the bottom edge. Seen in the running app at 1024x768: the second line was cut
   * in half. So a target in the lower half of the frame wears its caption above it instead.
   */
  const below = place.y <= 0.5;
  const cy = below ? CY : VB_H - CY;
  const capY = below ? cy + R + 30 : cy - R - 46;
  const subY = below ? cy + R + 56 : cy - R - 20;
  // The secondary action's backing plate: a rounded square inscribed in the ring, so the silhouette
  // differs at a glance without anything being drawn outside the circle that is actually tested.
  const plate = (R - 6) * 0.72;

  return (
    <div
      className={`dwell-target${reducedMotion ? ' still' : ''}${enabled ? '' : ' off'}`}
      data-testid={testId}
      data-phase={phase}
      data-tone={tone}
      data-progress={progress.toFixed(3)}
      /* The target's centre in the SAME normalized video coordinates the landmarks arrive in, so a
         harness driving a synthetic patient can aim a limb at it without reverse-engineering the
         mirror flip out of the inline `left`. These are the re-aspected numbers the tracker tests. */
      data-dwell-x={circle.x}
      data-dwell-y={circle.y}
      data-dwell-radius={radius}
      data-dwell-xscale={frameScale}
      /* WHY IT IS NOT FILLING, in one word, for a harness and for a bug report: the same `blocked`
         the ring is drawing. A harness that can only see "the ring reached 0 %" cannot tell a target
         that is standing on a limb from one whose limb the exercise is carrying from one nobody is
         holding — and those three have three different remedies. */
      data-dwell-block={state?.blocked ?? ''}
      style={{
        left: `${(mirrored ? 1 - place.x : place.x) * 100}%`,
        top: `${place.y * 100}%`,
        height: `${heightPct}%`,
        aspectRatio: `${VB_W} / ${VB_H}`,
        // The RING centre is what sits on (x, y), not the middle of the box that also holds a caption.
        transform: `translate(-50%, -${(cy / VB_H) * 100}%)`,
      }}
    >
      {/* `overflow: visible` so a two-word caption is never TRIMMED to fit the ring's own box: seen in
          the running app as "ext moveme" under a 190 px target at 1024x768. The preview still clips at
          the frame edge, and the targets are placed far enough in that the spill has somewhere to go. */}
      <svg
        viewBox={`0 0 ${VB_W} ${VB_H}`}
        width="100%"
        height="100%"
        overflow="visible"
        role="img"
        aria-label={`${caption} (${tone === 'go' ? 'carries on' : 'goes back; the smaller circle, with a square behind it'}): ${describe(phase, state)}`}
      >
        {/* A dark plate and a dark halo so the ring reads over a bright window, a white wall or a
            patterned shirt — the three backgrounds a clinic actually provides. Disc for the forward
            action, rounded square for the one that goes back. */}
        {tone === 'go' ? (
          <circle cx={CX} cy={cy} r={R - 6} fill="rgba(5, 7, 13, 0.62)" />
        ) : (
          <rect
            className="dwell-plate"
            x={CX - plate}
            y={cy - plate}
            width={plate * 2}
            height={plate * 2}
            rx={12}
            fill="rgba(5, 7, 13, 0.72)"
            stroke={style.colour}
            /* A BRIGHT SQUARE, not a faint one. At a fifth of the raster the mark inside the ring is a
               few pixels and the caption is gone, so what tells the two rings apart there is size,
               which side of the preview they are on, and the SILHOUETTE — a square against a disc. A
               50 %-opacity 3-unit outline did not survive the downscale; this does. */
            strokeOpacity={0.85}
            strokeWidth={4}
          />
        )}
        <circle cx={CX} cy={cy} r={R} fill="none" stroke="rgba(5, 7, 13, 0.85)" strokeWidth={16} />
        <circle
          className="dwell-track"
          cx={CX}
          cy={cy}
          r={R}
          fill="none"
          stroke={style.colour}
          strokeOpacity={phase === 'holding' ? 0.32 : 0.85}
          strokeWidth={9}
          strokeDasharray={style.dash}
        />
        {/* The second ring of the pair: the secondary action reads as a double ring even where the
            square plate is lost to a bright background. */}
        {tone === 'back' && (
          <circle className="dwell-inner" cx={CX} cy={cy} r={R - 13} fill="none" stroke={style.colour} strokeOpacity={0.7} strokeWidth={4} />
        )}
        {progress > 0 && (
          <circle
            cx={CX}
            cy={cy}
            r={R}
            fill="none"
            stroke={style.colour}
            strokeWidth={13}
            strokeLinecap="round"
            strokeDasharray={CIRC}
            strokeDashoffset={CIRC * (1 - progress)}
            transform={`rotate(-90 ${CX} ${cy})`}
            data-testid={testId ? `${testId}-arc` : undefined}
          />
        )}
        {/* WHICH OF THE TWO THIS IS, AT A FIFTH OF THE SIZE — and that constraint is what dictates
            every number in here.
            At 1/5 the primary ring is about 16 px across and the secondary 12 px, so anything the eye
            has to resolve INSIDE the ring gets a handful of pixels: the previous mark (a 22-unit wide,
            4-unit stroke chevron pair) came out under 4 px and the two rings became two grey dots
            differing only in diameter — which tells a patient that they are different and not which of
            them ends the session. So the mark is now FILLED rather than stroked (a solid shape survives
            a bilinear downscale where a thin line disappears into the background), it spans 44 of the
            92-unit ring diameter, and it is the only thing in the lower half of the ring. A solid
            triangle pointing the way the action goes is the player-transport convention, it is a SHAPE
            rather than a hue or a word, and the bar on the back one changes the silhouette as well as
            the direction. It stays in every phase: it is what the ring IS, not what it is doing. */}
        <g
          className="dwell-mark"
          data-testid={testId ? `${testId}-mark` : undefined}
          data-mark={tone}
          transform={`translate(${CX} ${cy + 22})`}
          fill="#ffffff"
          fillOpacity={0.95}
          stroke="#05070d"
          strokeOpacity={0.75}
          strokeWidth={2.5}
          strokeLinejoin="round"
        >
          {tone === 'go' ? (
            <>
              <path d="M -22 -13 L -4 0 L -22 13 Z" />
              <path d="M 0 -13 L 18 0 L 0 13 Z" />
            </>
          ) : (
            <>
              <path d="M 6 -14 L -18 0 L 6 14 Z" />
              <rect x={10} y={-14} width={9} height={28} rx={2} />
            </>
          )}
        </g>
        <text
          className="dwell-glyph"
          x={CX}
          y={cy - 13}
          textAnchor="middle"
          dominantBaseline="central"
          fill="#ffffff"
          stroke="#05070d"
          strokeWidth={4}
          paintOrder="stroke"
          fontSize={phase === 'holding' ? 44 : 34}
        >
          {ringGlyph(phase, state)}
        </text>
        <text
          className="dwell-caption"
          x={CX}
          y={capY}
          textAnchor="middle"
          fill="#ffffff"
          stroke="#05070d"
          strokeWidth={6}
          paintOrder="stroke"
          fontSize={21}
          fontWeight={800}
        >
          {caption}
        </text>
        <text
          className="dwell-sub"
          x={CX}
          y={subY}
          textAnchor="middle"
          fill="#dfe6f5"
          stroke="#05070d"
          strokeWidth={5}
          paintOrder="stroke"
          fontSize={16}
          fontWeight={700}
        >
          {describe(phase, state)}
        </text>
      </svg>
    </div>
  );
}

/** The one-line state under each ring. It never says "holding" when nothing is being tracked. */
function describe(phase: Phase, state: DwellState | undefined): string {
  switch (phase) {
    case 'lost':
      return 'not seeing you';
    case 'enter':
      return 'hold here';
    case 'reenter':
      return 'move out, then back';
    case 'holding':
      return state && state.holding ? 'keep holding' : 'hold here';
    case 'done':
      return 'got it';
    case 'occupied':
      // Not "hold harder" and not "the camera is broken": the circle is where a limb already lives, so
      // holding there would be indistinguishable from sitting still. It moves itself off in a moment.
      return 'a limb rests here';
    case 'coupled':
      /**
       * Measured, not guessed (`DwellCoupling`): this hand is travelling with the exercise, so a hold
       * made with it could not be told from a repetition. It is kept to the length of the other
       * sub-captions on purpose — "that hand moves with your exercise" was 33 characters and the
       * preview clipped the end of it off the left edge of the frame (seen at 1024x768). The whole
       * explanation, and the remedy, are in the legend beside the preview, which has room for them.
       */
      return 'your leg moves it';
    default:
      return 'not available yet';
  }
}

/**
 * The sentence beside the preview: what the hold does, and WHICH LIMB it is following.
 *
 * Naming the limb is not decoration. Either side may confirm — the unaffected one explicitly
 * included, because asking an affected limb to hold still over a target for two seconds is asking for
 * the one thing it cannot do — and a patient who cannot see which limb the app has latched onto
 * cannot tell "hold longer" from "it is watching the other hand". When the handedness cannot be
 * established it says so rather than guessing.
 *
 * IT ALSO HAS TO AGREE WITH THE RINGS. A legend reading "put the limb inside the circle and keep it
 * there" beside a ring reading "move out, then back" is two contradictory instructions, and the one in
 * 16 px type was the correct one. When every ring that can be confirmed is waiting for the limb to
 * leave first, this says THAT instead.
 */
/**
 * WHETHER THE SCREEN'S OWN BUTTON IS ACTUALLY AVAILABLE, as the screen knows it.
 *
 * 'on'  — there is an enabled control that does this step (the default: most screens have one).
 * 'off' — the touch control for this step is DISABLED right now, so the circles are the only way on.
 * A screen that does not say gets the honest general sentence, which promises no particular button.
 */
export type DwellTouchState = 'on' | 'off';

export function DwellLegend({
  session,
  what,
  touch,
  testId = 'dwell-legend',
}: {
  session: DwellSession;
  /** What the hold achieves, in one clause: "to go on to the range check". */
  what: string;
  /**
   * Whether this screen's own forward button can be pressed. Pass 'off' where it is disabled — the
   * camera check disables `camera-continue` on a blocked device (`disabled={readiness.gate}`), which is
   * EXACTLY the state in which this legend used to say "the buttons still work". It was not true, and
   * it was not true in the one state where a stranded patient reads it.
   */
  touch?: DwellTouchState;
  testId?: string;
}) {
  const mode = useStore((s) => s.mode);
  /**
   * THE SENTENCE ABOUT TOUCH, AND WHY IT NO LONGER PROMISES A BUTTON.
   *
   * "If your hands are out of the picture, use the buttons" / "the buttons still work" was written for
   * a therapist standing beside the tablet. It is read by a patient sitting alone in front of it, and
   * on a device the camera check has BLOCKED the forward button is switched off — so the one state
   * where the sentence matters most is the state where it is false. What is true everywhere: a button
   * needs a hand on the glass, which is the thing this whole path exists because the patient may not
   * have; and a screen may have switched its own button off.
   */
  const touchNote =
    touch === 'off'
      ? 'The button for this step is switched off at the moment, so the circles are the only way on.'
      : touch === 'on'
        ? 'A button on this screen does the same thing, for anyone who can reach the glass.'
        : 'Anything else needs a hand on the glass, and a screen can have its own button switched off.';
  if (!session.live) {
    return (
      <div className="dwell-legend" data-testid={testId} data-state="offline">
        <strong>Hands-free is not available right now.</strong>
        <span className="dim" data-testid={`${testId}-touch`}>
          No camera frames are arriving, so nothing can be held. Restarting the camera is what brings
          the circles back. {touchNote}
        </span>
      </div>
    );
  }
  // Frames ARE arriving, but this step has nothing to confirm yet (the camera check's readiness gate,
  // a range that has not been measured). Saying "no frames" here would be a plain untruth about a
  // preview the patient can see working.
  const states = Object.values(session.states);
  if (states.length === 0) {
    return (
      <div className="dwell-legend" data-testid={testId} data-state="waiting">
        <strong>Nothing to confirm yet.</strong>
        <span className="dim">The circle will fill in as soon as this step can be held through.</span>
      </div>
    );
  }
  const limb = session.limb;
  /**
   * NOTHING IS BEING FOLLOWED — the rings' "not seeing you", said as something the patient can DO.
   *
   * This is the state the leg-mode gap lands a patient in: they sat down framed on their hips, knees
   * and feet, exactly as the app asked them to, and there is no hand in the picture for the circles to
   * follow. The legend used to answer that with "Move a hand into the circle and keep it there", which
   * is an instruction about the circle when the problem is the PICTURE — and the one sentence that said
   * so ("If your hands are out of the picture, use the buttons") sat in the small print at the bottom
   * of the block, below the fold on a 768 px tablet. So the remedy moves into the first line, beside
   * the badge that says no hand is in view, where the patient is already looking.
   *
   * The test is the RINGS' OWN: `phaseOf` draws "not seeing you" when a target has not seen its limb
   * inside `graceSec`, so this says what they say, and it is ahead of every other state for the same
   * reason `lost` is ahead of `occupied` there — a target cannot be said to be sitting on a limb, or
   * waiting for one to leave, while the camera is not reporting one at all. (`session.limb` going
   * momentarily null is NOT this state: one dropped detection is not a lost hand, which is the whole
   * point of the grace window, and the badge below already names the limb or its absence.)
   */
  const unseen = states.every((s) => !s.tracked);
  // Anything that can be held is waiting for the limb to leave the ring first — say what the rings say.
  const mustLeave = states.every((s) => s.blocked === 'entry' && s.tracked);
  // …or every ring is standing on a limb that lives there, which is a different sentence again: the
  // patient cannot fix it by holding, and telling them to hold would be telling them to do a thing
  // that cannot work. The rings move themselves off; this says so rather than leaving a dead circle.
  const crowded = states.length > 0 && states.every((s) => s.blocked === 'occupied');
  /**
   * …or the hand it is following is being CARRIED BY THE EXERCISE, which is a different sentence again
   * and the only one of these the patient fixes by moving the hand somewhere else. Measured, not
   * guessed: `DwellCoupling` correlates this limb's travel against the prescribed movement over the
   * readiness window. The remedy is named (a chair arm, an armrest, a table — not the thigh) because
   * "that hand moves with your exercise" on its own is a diagnosis, not an instruction.
   */
  const carried = states.length > 0 && states.every((s) => s.blocked === 'coupled');
  const anything = 'a hand';
  const fps = session.frameIntervalSec > 0 ? 1 / session.frameIntervalSec : 0;
  return (
    <div
      className="dwell-legend"
      data-testid={testId}
      /* The measured verdict, for a harness and a bug report: WHICH limb was refused, what it was
         moving with, and by how much. A ring that will not fill is otherwise indistinguishable from
         a patient not holding still enough, which is the confusion this whole round is about. */
      /* And how much room each ring has, from the same measurement the gate decided on. */
      data-rooms={Object.entries(session.rooms)
        .map(([id, r]) => `${id} ${r.actual.toFixed(3)}${r.clear ? '>=' : '<'}${r.required.toFixed(3)} ${r.key ?? 'nothing'}`)
        .join(' | ')}
      data-coupled={
        session.coupled
          ? `${session.coupled.key} follows ${session.coupled.reference} r2=${session.coupled.r2.toFixed(2)} f=${session.coupled.fraction.toFixed(2)} explained=${session.coupled.explained.toFixed(3)}`
          : ''
      }
      data-state={
        unseen ? 'searching' : carried ? 'coupled' : crowded ? 'occupied' : mustLeave ? 'reenter' : limb ? 'tracking' : 'searching'
      }
    >
      <strong>
        {unseen ? (
          <span data-testid={`${testId}-bring-hand`}>
            {mode === 'leg'
              ? `Bring a hand into the picture — nothing can be held while the camera cannot see one. Rest it on the arm of the chair or a table, NOT on your thigh (your leg carries your thigh, so a hand there cannot be told apart from a repetition), then hold ${what}. Your knees cannot do this either: they are doing the exercise.`
              : `Bring your hand back into the picture — nothing can be held while the camera cannot see it. Then hold ${what}, without touching the screen.`}
          </span>
        ) : carried ? (
          <span data-testid={`${testId}-carried`}>
            {limb ? `${limb.label[0].toUpperCase()}${limb.label.slice(1)} is` : 'The hand below is'} moving with your
            exercise — on your thigh it is carried by your leg, so a hold with it cannot be told apart from a repetition.
            Rest it on the arm of the chair, an armrest or a table instead, then hold {what}. Your other hand will do
            just as well.
          </span>
        ) : crowded ? (
          <>
            Hold {what} — no need to touch the screen. The circle is on top of{' '}
            {limb ? 'the limb below' : 'a limb that is already there'}, so holding it would mean nothing: it is moving
            itself somewhere clear. If it cannot find room, the buttons still work.
          </>
        ) : mustLeave ? (
          <>
            Hold {what} — no need to touch the screen. {limb ? 'The limb below is' : `${anything[0].toUpperCase()}${anything.slice(1)} is`}{' '}
            already inside the circle: move it out, then back in, and keep it there while the ring fills.
          </>
        ) : (
          <>
            Hold {what} — no need to touch the screen. Move {limb ? 'the limb below' : anything} into the circle and keep it
            there while the ring fills.
          </>
        )}
      </strong>
      <span className={limb ? 'badge badge-ok' : 'badge badge-warn'} data-testid={`${testId}-limb`}>
        {limb ? `Following ${limb.label}` : 'No hand in view'}
      </span>
      {limb && limb.side === null && (
        <span className="dim" data-testid={`${testId}-unidentified`}>
          Which hand this is cannot be told from the camera at the moment — it is followed as a pointer only, and nothing
          about it is recorded.
        </span>
      )}
      {/* A slow camera is a slow ring, not a broken one, and the patient is owed the difference — but
          only down to the rate at which the ring can still keep real time (see `dwellCadence`: below
          about 1.7 frames a second the step cap bites and the hold takes longer than it says). */}
      {fps > 0 && fps < SLOW_FPS && (
        <span className="dim" data-testid={`${testId}-slow`}>
          The camera is sending about {fps < 1 ? fps.toFixed(1) : fps.toFixed(0)} frame{fps >= 1.5 ? 's' : ''} a second,
          {session.frameIntervalSec <= REALTIME_INTERVAL_SEC
            ? ' so the ring fills in visible steps. It still takes the same time to fill.'
            : ' which is slower than the ring can count: it fills as the frames arrive, so the hold takes longer than the countdown inside it says.'}
        </span>
      )}
      {/* The small print, and it STAYS SMALL PRINT: in the not-seeing-you state the first line above
          already carries the whole explanation, and repeating it here pushed the block 46 px past the
          bottom of a 768 px tablet — so the one thing that is not said above (either limb will do, and
          the buttons are still there) is all that is left here. Measured in the running app. */}
      {/* THE SMALL PRINT, AND IT HAS TO FIT. Every sentence here is a fact the patient cannot get
          anywhere else — either side will do, the support has to be furniture rather than the thigh,
          the knees cannot answer, and what touch is worth on this screen — and the block is read on a
          768 px tablet by somebody who cannot scroll it. So it is trimmed to those four facts and no
          explanation: `critic:deadends` measures the whole block against the fold. */}
      <span className="dim" data-testid={`${testId}-limbs`}>
        Either side will do, the unaffected one included.{' '}
        {unseen
          ? `If no hand can come into the picture, this step has to be done on the screen. ${touchNote}`
          : mode === 'leg'
            ? `The hand goes on the arm of the chair, an armrest or a table — not your thigh, which your leg carries, and not a knee: a knee in the circle cannot be told from a repetition. ${touchNote}`
            : touchNote}
      </span>
    </div>
  );
}
