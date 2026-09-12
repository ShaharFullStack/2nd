/**
 * DWELL: how a patient who cannot touch the tablet says "yes".
 *
 * The product decision is a HOLD, not an auto-advance and not the exercise movement itself: a target
 * appears on the camera preview, the patient parks a limb inside it, a ring fills while they hold, and
 * it confirms when the ring is full. Auto-advance would take the choice away from the patient;
 * dwelling on the prescribed movement would fire by accident on every rep.
 *
 * WHICH LIMB MAY ANSWER, AND WHY A KNEE MAY NOT.
 * ---------------------------------------------
 * A confirm gesture has to be a thing the patient does ON PURPOSE, which means the app must be able to
 * tell it apart from the exercise it has just prescribed. The first version of this file tried to do
 * that by PLACEMENT alone — put the circle where the limb does not go — and that is exactly where it
 * failed in the running app: a seated march performed with hip circumduction (the compensation this
 * app exists to observe and promises never to penalise) carried the knee into the circle and held it
 * there, and the app confirmed. At the camera check it skipped a screen; on the ROM screen it threw
 * the patient off their own measurement; on the pause dialog it ended the session.
 *
 * There is no placement that fixes that, and the reason is worth writing down, because it is a
 * property of the body and not of this code: A SEATED PATIENT PUTS A KNEE SOMEWHERE ONLY BY
 * PERFORMING A PRESCRIBED LEG MOVEMENT. Knee height IS seated_march, lateral knee travel IS
 * hip_abduction, and every point a knee can reach is a point some prescribed rep reaches on the way
 * (`dwell.test.ts`, "a knee cannot be given a target it can reach that a rep does not"). A dwell
 * target a knee can hold is therefore a dwell target the exercise fills. So in LEG mode the knees are
 * not pointers at all: `dwellLimbs` returns the HANDS, which the leg prescription does not move. The
 * two sets are disjoint by construction rather than by measurement, on the first repetition, at any
 * pace, with any compensation.
 *
 * The cost is stated rather than hidden, and it is now also PAID. Leg mode needs a HAND in the picture
 * for the hands-free path, so the framing the app ASKS for is a framing that path survives:
 * `POSTURE_INFO.seated_leg` asks for a hand resting where the camera can see it and not only for hips,
 * knees and feet. An instruction is not evidence that it was followed, so the camera check MEASURES
 * whether a pointer is there — off the same session the rings are driven from — and says so before the
 * patient is left alone (`cameraReadiness`, `PointerObservation`). It warns rather than gates, because
 * the hands-free ways forward and back that a blocked verdict is required to leave ARE these circles,
 * and because the patient fixes it by raising a hand. When no hand is in frame the legend's FIRST line
 * says what to do about it. A confirm nobody made is worse than a confirm nobody can make.
 *
 * AND THEN THE SAME MISTAKE, IN THE HAND. "The leg prescription does not move the hands" was the
 * premise the knees were removed on, and it is false for the support the text used to offer first: A
 * HAND RESTING ON THE THIGH IS CARRIED BY THE THIGH. Hip flexion rotates the thigh about the hip, so a
 * hand at fraction f along the hip->knee segment rises by f x the knee's travel, and hip circumduction
 * carries it laterally at the same time. Driven through these classes with the wrist interpolated along
 * the real hip->knee segment, a left seated march with circumduction and a hand at f = 1.0 CONFIRMED
 * THE PRIMARY CIRCLE AT t = 3.23 s, and a right march the SECONDARY (which on the pause dialog ends the
 * session and writes a truncated record) at 3.30 s — on the first repetition, at 12, 15, 24 and 30 fps,
 * in 4:3 and 16:9, mirrored and not. The 324-case sweep that was supposed to prove otherwise had
 * hard-coded the wrist at the one point on the thigh a hip flexion does not move.
 *
 * So the instruction changed AND the premise became a measurement, because this is the third round lost
 * to trusting one:
 *   - `POSTURE_INFO.seated_leg` now asks for a support the leg cannot move — a chair arm, an armrest, a
 *     table — and says, in the patient's own words, why the thigh is not one;
 *   - `DwellCoupling` FITS each candidate pointer's travel against the travel of the segments the
 *     prescription moves (`dwellReferences`: knee, ankle and foot, hip-relative, each named after the
 *     lane whose feature is measured from it) over a rolling readiness window. A limb the exercise is
 *     carrying is passed over while any other limb is in the picture, and when it is the only limb
 *     there is, the rings stand down (`blocked: 'coupled'`) and the screen says what to do. A patient
 *     who rests a hand on their thigh anyway cannot end their session with it.
 * The fixtures carry a thigh-resting hand with the thigh now (`SEATED_HAND_SUPPORTS`), so the sweep
 * that proves this can fail — and it is run with the gate removed to show that it does.
 *
 * In HAND mode the prescribed limb is the only limb there is, so the separation cannot be by identity
 * and is geometric instead — but along the ONE AXIS the prescription cannot move the palm. The four
 * hand movements are finger and wrist motions about a forearm resting on the table: they carry the
 * palm centroid up to 1.94 PALM LENGTHS along the fingers (measured, `dwell.test.ts`) and essentially
 * nothing across. A hand-mode target is therefore required to clear the hand LATERALLY, by more than
 * the exit band plus the hand's own measured lateral wander; a circle that far to the side cannot
 * contain the palm at ANY height, so the whole vertical envelope — wrist extension, the forearm-lift
 * compensation, a bigger hand, a closer camera — is irrelevant to it by construction.
 *
 * WHERE THE LIMB ACTUALLY IS, MEASURED (`DwellHabitat`).
 * -----------------------------------------------------
 * The header used to claim the activation region was "disjoint from where every limb `dwellLimbs` can
 * report RESTS, in both modes, at every frame aspect". That was proved for ONE synthetic rig's
 * framing assumptions, and a critic rebuilding the envelope found two escapes it could not see (a
 * leg-mode hand resting at (0.70, 0.45), 0.1327 from the primary centre against an exit radius of
 * 0.1438; a hand-mode palm at 1.6× scale framed a tenth of a frame high, 0.0967 from the centre —
 * inside the drawn circle). `handPose` puts a resting palm at y 0.63 BY CONSTRUCTION and nothing in
 * the app enforces, measures or mentions that, so no fixture sweep can be the guarantee.
 *
 * So the app measures instead. `DwellHabitat` keeps, per limb, a 20-second occupancy record and reads
 * off ROBUST statistics: a marginal median for where the limb lives, and a 75th percentile of the
 * deviation from it for how far it wanders. Order statistics are used precisely because a deliberate
 * two-second reach into a target must not move them — that circularity ("moving toward the target
 * counts as leaving rest") is what makes the naive version of this idea unusable. A target may only
 * accumulate a hold while it CLEARS every limb's measured habitat (`blocked: 'occupied'`), and the
 * placement is moved to somewhere that does (`placeDwellCircle`) rather than left sitting on a limb.
 * When nothing on the screen clears, the ring says so instead of pretending to be holdable.
 *
 * WHAT THIS GESTURE IS ALLOWED TO CLAIM. Not "impossible by accident" — that sentence used to be here
 * and it was not earned. What is claimed now is what is proved, case by case, in dwell.test.ts and
 * DwellTarget.test.tsx:
 *   - the limb that confirms is never a limb the prescription moves into the target: in leg mode the
 *     knees cannot point at all, and in hand mode the target clears the palm along the one axis the
 *     prescription does not use;
 *   - and in leg mode that is MEASURED as well as instructed: a hand the prescribed movement is
 *     carrying is refused as a pointer (`DwellCoupling`), which is what makes the separation a property
 *     of this patient's body rather than of the sentence they were shown;
 *   - a hold may only accumulate while the target clears every limb's MEASURED habitat, so neither
 *     sitting still, nor relaxing back to rest, nor a limb that lives just outside the ring (in the
 *     hysteresis band, where the entry gate is open simply because the limb is there) can fill one —
 *     whatever the framing, the patient's size or the frame aspect;
 *   - AND THE ONE CASE THAT IS NOT CLAIMED, because it is not true: a limb that lives INSIDE the drawn
 *     circle can still answer by leaving it and coming back. Every frame of such a limb is part of a
 *     hold or of the reach into one, and excluding those is what stops the reach from teaching the
 *     record that the limb lives on the ring — so the habitat cannot help, and what protects that
 *     patient is the ENTRY GATE (the limb must leave the drawn circle and return: a real excursion,
 *     not a tremor), the 1.8 s hold, and the authored positions, which clear every rest position the
 *     app instructs by more than the whole band. It is measured and stated in DwellTarget.test.tsx,
 *     "THE RESIDUAL, STATED", so that it is a known quantity rather than a surprise;
 *   - a rep cannot fill a target: driven as a REAL rep profile (a 4 s rise, 1.5 s at the top and a 3 s
 *     descent — a hemiparetic pace, slower than anything this app paces, and the critic's own
 *     2 / 2.5 / 2 / 10 s duty cycle), every lane, both sides, with and without the documented
 *     compensations, with a hand on the thigh at every fraction along it, at 12 / 15 / 24 / 30 fps, in
 *     every frame aspect, mirrored and not, with and without a second hand to fall back on — 576 cases
 *     in the test suite and the same 576 through the shipping build in the browser
 *     (`critic/handsfree-thigh.mjs`), with the gate switched off in both to show that they can fail;
 *   - a limb that merely stops being detected cannot arm or complete anything;
 *   - and the hold can only COMPLETE while the pointer is inside the circle the patient can see.
 *
 * THIS FILE IS PURE. No DOM, no React, no timers — it is fed a pointer in normalized video
 * coordinates and a wall-clock time, and it answers with a state a UI can render honestly. Everything
 * here is decided frame by frame in a test (dwell.test.ts).
 *
 * The properties that make it clinical rather than a mouse-over:
 *
 *  1. TREMOR TOLERANCE. The pointer is averaged over a short window (`smoothingSec`) BEFORE
 *     containment is tested. A resting tremor of a few centimetres at 6 Hz moves the raw landmark in
 *     and out of any circle small enough to be reachable; the mean of the last quarter second does
 *     not. Smoothing the pointer is not the same as smoothing the PROGRESS — progress must still
 *     react immediately when the limb genuinely leaves, or the ring would keep filling over a hand
 *     that has gone.
 *  2. HYSTERESIS, WITH A CLOCK ON IT. Leaving takes a bigger circle than entering (`exitRatio`):
 *     without it a hand parked exactly on the boundary — which is where a patient with poor
 *     proprioception parks it — flickers in and out and the hold never completes. But a band that
 *     forgives a WOBBLE must not accommodate a PARK: a pointer that stays outside the drawn circle
 *     for longer than `bandGraceSec` has left, whatever the band says, and the hold stops
 *     accumulating. And the completing frame is tested against the drawn circle itself, never the
 *     band, so a ring can never fill up over a limb sitting outside the ring it is drawn as.
 *  3. FORGIVENESS. A lost landmark does not reset the hold. Progress DECAYS, and decays more slowly
 *     than it fills (`decayRatio` < 1), so a patient whose hand flickers in and out of detection —
 *     the normal case on a clinic webcam at 12 fps — still gets there. Resetting to zero on a dropped
 *     frame is the behaviour that makes a hands-free path unusable for exactly the patients it is for.
 *  4. IT CANNOT CONFIRM TWICE. After a confirm the tracker is inert for `refractorySec` AND will not
 *     start a new hold until it has seen the limb leave the target (the same gate that stops a limb
 *     which happens to be resting inside the target when the screen opens from confirming
 *     immediately — see `requireEntry`). One hold answers one question.
 *  5. ONE LIMB AT A TIME. The smoothing buffer belongs to the limb it was filled from (`limbKey` on
 *     `update`). Two limbs averaged into one pointer produce a point where NEITHER limb is — for a
 *     symmetrically seated patient that mean is the midline, which is exactly where a centred target
 *     would be — so a change of limb throws the buffer away and takes the hysteresis with it: the new
 *     limb has to be inside the DRAWN circle on its own account, not inside a band the other limb
 *     earned. (What a hand-over does NOT do is re-arm the entry gate; see the note in `update`.)
 *
 * THE CLOCK. `update` is given a WALL-CLOCK time in seconds, not song time. A dwell hold is not
 * related to the song's timebase (the AudioContext clock that ARCHITECTURE.md makes canonical for
 * anything measured against the music), and it has to keep counting down when the frame stream
 * stalls — which is when the audio clock keeps running but no frame callback ever arrives. Callers
 * pass `performance.now() / 1000`.
 *
 * COORDINATES. Normalized video coordinates: x 0..1 across the frame, y 0..1 down it, exactly as
 * MediaPipe reports landmarks. Because MediaPipe normalizes x by the frame WIDTH and y by the HEIGHT,
 * one x unit is not one y unit on a non-square frame (see the anisotropy note in landmarks.ts): every
 * distance here multiplies x by `xScale` = frameWidth / frameHeight, so `radius` is in units of frame
 * HEIGHT and the containment region is the circle the patient can actually see drawn. THE CALLER MUST
 * PASS THE REAL ASPECT of the frames the landmarks came from (`VisionInput.getXScale()`), and must
 * not pass its "not known yet" default of 1 as though it were a square sensor: see `liveXScale` in
 * DwellTarget.tsx, which waits for a frame before believing it.
 */
import type { LaneSpec, Mode, Side } from '../engine/types.ts';
import { poseSideIndices } from './features.ts';
import { HAND, MIN_VISIBILITY, POSE } from './landmarks.ts';
import type { Landmark } from './landmarks.ts';
import { labelToPatientSide } from './mediapipe.ts';
import type { DetectionResult } from './mediapipe.ts';

/* ---------------- the target and the pointer ---------------- */

export interface DwellPoint {
  x: number;
  y: number;
}

/** A circular target in normalized video coordinates; `radius` is in units of frame HEIGHT. */
export interface DwellCircle {
  x: number;
  y: number;
  radius: number;
}

export interface DwellOptions {
  /** Seconds the limb must be held inside the target to confirm. */
  holdSec?: number;
  /** Exit radius as a multiple of the entry radius (> 1). The hysteresis band. */
  exitRatio?: number;
  /**
   * How long the pointer may sit in the hysteresis band — outside the DRAWN circle — and still be
   * counted as holding. A wobble, not a park: see property 2 in the header.
   */
  bandGraceSec?: number;
  /** Length of the moving-average window applied to the pointer before containment is tested. */
  smoothingSec?: number;
  /** How long the limb may be missing before the UI stops claiming it is being tracked. */
  graceSec?: number;
  /** Decay rate as a fraction of the fill rate. Must be < 1 so a flickering patient still gets there. */
  decayRatio?: number;
  /** After a confirm, no hold may even begin for this long. */
  refractorySec?: number;
  /** Longest step one update may advance the hold by; a backgrounded tab must not confirm on return. */
  maxStepSec?: number;
  /** frameWidth / frameHeight of the frames the pointer came from (see the coordinates note above). */
  xScale?: number;
  /**
   * Require the pointer to be seen OUTSIDE the target before a hold may start (default true).
   *
   * A knee at rest, or a hand on the table, can already be sitting where the target is drawn the
   * moment the screen opens. Filling from there is not a choice the patient made, it is where their
   * limb happened to be. With this on, the ring only starts to fill once they have moved the limb in.
   * It is a gate on DELIBERATENESS and nothing more: it is not what keeps a resting limb from
   * confirming (placement is — see the header), because a limb resting in the hysteresis band opens
   * this gate and then closes it again by relaxing back.
   */
  requireEntry?: boolean;
}

export const DWELL_DEFAULTS: Required<DwellOptions> = Object.freeze({
  /**
   * 1.8 s. Long enough that a limb swinging past cannot fill it (a rep takes well under a second at
   * the pacings this app prescribes), short enough that a patient holding an arm unsupported against
   * gravity can finish before the arm does. The product brief asked for "about two seconds".
   */
  holdSec: 1.8,
  /**
   * 1.25. Down from 1.45, which put the exit circle nearly TWICE the drawn area and swallowed a
   * resting knee whole (see the header). A quarter of a radius is a real wobble tolerance — several
   * centimetres at the patient — and `bandGraceSec` stops it from being anything more than that.
   */
  exitRatio: 1.25,
  /** 0.35 s in the band. Longer than any wobble, shorter than a decision. */
  bandGraceSec: 0.35,
  /** 0.25 s — six frames at 24 fps. Averages out tremor without making the ring lag the limb visibly. */
  smoothingSec: 0.25,
  /**
   * 0.4 s. Below this the UI keeps saying "tracked": one or two dropped detections is not a lost limb.
   * A SLOW camera is not a lost limb either — callers driving this from a real device must raise this
   * to the device's own frame interval (`setCadence`), or a working 4 fps stream reads as a dead one.
   */
  graceSec: 0.4,
  /**
   * 0.45 — progress is given back at 45 % of the rate it is earned. A patient whose landmark is
   * present for two frames in three still reaches a full ring; one who has taken their limb away
   * loses the hold in about 4 s, which is long enough to be visible and short enough not to lie.
   */
  decayRatio: 0.45,
  /** 1.5 s of inertness after a confirm, on top of the "must leave the target first" gate. */
  refractorySec: 1.5,
  /** 0.25 s. A tab that was backgrounded for a minute resumes with one quarter-second step, not a confirm. */
  maxStepSec: 0.25,
  xScale: 1,
  requireEntry: true,
});

/** Why a hold cannot start right now (null = it can). */
export type DwellBlock =
  /** A confirm just happened; nothing may be confirmed again yet. */
  | 'refractory'
  /**
   * A limb LIVES here: the target does not clear some limb's measured habitat by enough to tell a
   * hold apart from the limb being where it always is (`DwellHabitat`, `dwellClearance`). Set by the
   * caller through `setOccupied`; nothing accumulates while it is true, whatever the pointer does.
   * This is the gate that no fixture sweep can be, and the one the exercise cannot open.
   */
  | 'occupied'
  /**
   * THE LIMB MOVES WITH THE PRESCRIBED EXERCISE, measured over the readiness window
   * (`DwellCoupling`) — a hand resting on the thigh is carried by the thigh, so a hold made with it
   * cannot be told apart from a repetition. Set by the caller through `setCoupled`; nothing
   * accumulates while it is true. The remedy is a support the leg cannot move, and the screen says
   * so: no placement and no amount of holding can fix it.
   */
  | 'coupled'
  /** The limb has not been seen outside the target since the tracker was armed. */
  | 'entry';

export interface DwellState {
  /** 0..1 — how much of the required hold has been accumulated. */
  progress: number;
  /** The smoothed pointer is inside the target (entry radius to get in, exit radius to get out). */
  inside: boolean;
  /**
   * The smoothed pointer is inside the DRAWN circle — the entry radius, not the band. This is the
   * test the hold has to pass to complete, and the one a renderer may describe to the patient.
   */
  withinEntry: boolean;
  /**
   * A limb has been seen within `graceSec`. FALSE IS A REAL STATE and the UI must show it as one: a
   * ring that simply stops filling looks identical to a patient holding still in the wrong place.
   */
  tracked: boolean;
  /** The hold is actually accumulating this instant. */
  holding: boolean;
  /** TRUE ON EXACTLY THE ONE UPDATE the hold completed. Never true twice for one hold. */
  confirmed: boolean;
  /** How many confirms this tracker has produced since it was constructed or reset. */
  confirmations: number;
  /** Why a hold cannot start (null when it can). */
  blocked: DwellBlock | null;
  /** The smoothed pointer, or null when nothing recent enough is in the window. */
  pointer: DwellPoint | null;
  /** Seconds since a pointer was last seen (Infinity before the first one). */
  lostSec: number;
  /** Seconds of holding still needed, at the full fill rate. */
  remainingSec: number;
  /**
   * THE CIRCLE THIS STATE WAS MEASURED AGAINST, and the frame aspect it was measured in — so a
   * renderer draws the circle that was tested instead of the one a screen asked for before the camera
   * said what shape its frames are. See `retargetForAspect`.
   */
  target: DwellCircle;
  xScale: number;
}

interface Sample {
  t: number;
  x: number;
  y: number;
}

function finitePoint(p: DwellPoint | null | undefined): p is DwellPoint {
  return !!p && Number.isFinite(p.x) && Number.isFinite(p.y);
}

/** Distance from `p` to the centre of `c`, in units of frame height (see the coordinates note). */
export function dwellDistance(p: DwellPoint, c: DwellCircle, xScale = 1): number {
  return Math.hypot((p.x - c.x) * xScale, p.y - c.y);
}

/** The frame aspect targets are AUTHORED in: the preview box is 4:3 and so is the camera request. */
export const DWELL_AUTHORED_ASPECT = 4 / 3;

/**
 * The same physical target, expressed in the frame the camera actually delivered.
 *
 * A target is written down as a fraction of the frame — `x: 0.72` — but x is normalized by the frame
 * WIDTH, so the same number is a different PLACE on a 16:9 sensor than on the 4:3 frame the layout was
 * drawn for: further out, and further from the limb that has to reach it. The offset from the centre
 * is therefore re-expressed in units of frame HEIGHT, which is the unit `radius` is already in and the
 * unit the preview box is cropped to. On the glass the circle lands in the same place on every sensor
 * (`previewPlacement` in DwellTarget.tsx does the matching crop), and the reach asked of the patient
 * is the same physical distance.
 */
export function retargetForAspect(c: DwellCircle, xScale: number, authored = DWELL_AUTHORED_ASPECT): DwellCircle {
  if (!Number.isFinite(xScale) || xScale <= 0 || xScale === authored) return c;
  return { x: 0.5 + (c.x - 0.5) * (authored / xScale), y: c.y, radius: c.radius };
}

/**
 * THE SAME TARGET AS THE PREVIEW WILL DRAW IT — position AND size.
 *
 * `retargetForAspect` keeps the offset from the centre a constant physical distance. This adds the
 * other half, which the size requirement made load-bearing: a frame TALLER than the 4:3 preview box is
 * cropped top and bottom, so the surviving strip is magnified onto the glass and `radius` frame
 * heights become `radius / visY` box heights. A ring authored to be 100 px across at 4:3 would be
 * 133 px at 1:1 and would not fit on the screen beside its own caption.
 *
 * So the authored radius is read as a fraction of the PREVIEW BOX — which is the thing a patient's eye
 * has to resolve and aim at, and the only frame in which "26 mm at arm's length" means anything — and
 * converted here into the frame heights everything downstream measures in. On a 4:3 or wider sensor
 * (every sensor a webcam actually delivers) `visY` is 1 and this is exactly `retargetForAspect`.
 */
export function retargetForPreview(c: DwellCircle, xScale: number, authored = DWELL_AUTHORED_ASPECT): DwellCircle {
  const placed = retargetForAspect(c, xScale, authored);
  if (!Number.isFinite(xScale) || xScale <= 0 || xScale >= authored) return placed;
  return { x: placed.x, y: placed.y, radius: c.radius * (xScale / authored) };
}

/**
 * Do two targets share any ground — including their hysteresis bands?
 *
 * Two targets on one screen ("continue" and "redo this lane") are driven by the SAME pointer and each
 * decides containment for itself, which is only sound while no point can be inside both. Exported so
 * the layouts the screens actually use are asserted, not eyeballed.
 */
export function dwellTargetsOverlap(a: DwellCircle, b: DwellCircle, exitRatio = DWELL_DEFAULTS.exitRatio, xScale = 1): boolean {
  const gap = Math.hypot((a.x - b.x) * xScale, a.y - b.y);
  return gap < (a.radius + b.radius) * exitRatio;
}

/**
 * One target's hold, accumulated frame by frame.
 *
 * Several targets on one screen are several trackers fed the same pointer — which is correct exactly
 * as long as the targets are disjoint (`dwellTargetsOverlap`), and keeps every tracker's report of
 * "is the limb being tracked at all" true rather than an artefact of which target won a routing
 * decision.
 */
export class DwellTracker {
  private opts: Required<DwellOptions>;
  private target: DwellCircle;
  private samples: Sample[] = [];
  private lastT = NaN;
  private lastSeen = -Infinity;
  private progress = 0;
  private insideFlag = false;
  private withinEntry = false;
  /** When the pointer left the drawn circle while still counting as inside (NaN = it has not). */
  private bandSince = NaN;
  /** The entry gate: has the limb been seen outside the target since this hold was armed? */
  private seenOutside = false;
  /** Set by `setOccupied`: a limb's measured habitat reaches this target, so no hold may count. */
  private occupied = false;
  /** Set by `setCoupled`: the limb pointing at this target is being moved by the exercise. */
  private coupled = false;
  /** Which limb the samples in the buffer came from (null = the caller does not distinguish). */
  private limbKey: string | null = null;
  private blockedUntil = -Infinity;
  private count = 0;
  private current: DwellState;

  constructor(target: DwellCircle, opts: DwellOptions = {}) {
    this.target = target;
    this.opts = { ...DWELL_DEFAULTS, ...opts };
    this.current = this.empty();
  }

  private empty(): DwellState {
    return Object.freeze({
      progress: 0,
      inside: false,
      withinEntry: false,
      tracked: false,
      holding: false,
      confirmed: false,
      confirmations: this.count,
      blocked: (this.opts.requireEntry ? 'entry' : null) as DwellBlock | null,
      pointer: null,
      lostSec: Infinity,
      remainingSec: this.opts.holdSec,
      target: this.target,
      xScale: this.opts.xScale,
    });
  }

  /**
   * THE TARGET IS ON TOP OF A LIMB — so nothing it does may count.
   *
   * Told by the caller, which is the only party that can see every limb at once and what each of them
   * has been doing for the last twenty seconds (`DwellHabitat` + `dwellClearance`). While this is set,
   * the hold does not accumulate and any progress already earned decays, exactly as if the patient had
   * taken the limb away: a ring may not keep filling while the app has decided it cannot tell this
   * hold apart from the limb simply being where it lives.
   *
   * It is deliberately not a property of the pointer passed to `update`. The question "is this circle
   * clear of the patient" is about where the limb has BEEN, not where it is this frame — the pointer
   * is inside the circle in both the accidental case and the deliberate one.
   */
  setOccupied(occupied: boolean): void {
    this.occupied = occupied === true;
  }

  /**
   * THE LIMB DOING THE POINTING IS BEING CARRIED BY THE EXERCISE — so nothing it does may count.
   *
   * Told by the caller, which is the only party that can see the pointer and the prescribed movement
   * in the same frame (`DwellCoupling` + `dwellReferences`). While it is set the hold does not
   * accumulate and any progress decays, exactly as `occupied` does — but for a reason no placement can
   * cure: it is not that the circle is in the wrong place, it is that this limb is not an independent
   * witness. The screen's remedy is to ask for the hand to be supported by something the leg does not
   * move, which is what `POSTURE_INFO.seated_leg` asks for in the first place.
   */
  setCoupled(coupled: boolean): void {
    this.coupled = coupled === true;
  }

  /** The last state produced. Frozen; a renderer may hold it between updates. */
  get state(): DwellState {
    return this.current;
  }

  get circle(): DwellCircle {
    return this.target;
  }

  /**
   * Move the target, and/or correct the frame aspect it is measured in (a screen that changes what it
   * is asking, or a camera that finally said what shape its frames are). Clears the hold in progress —
   * the geometry a half-filled ring was earned against no longer exists.
   */
  setTarget(target: DwellCircle, xScale: number = this.opts.xScale): void {
    if (
      target.x === this.target.x &&
      target.y === this.target.y &&
      target.radius === this.target.radius &&
      xScale === this.opts.xScale
    ) {
      return;
    }
    this.target = target;
    this.opts = { ...this.opts, xScale };
    this.reset();
  }

  /**
   * Follow the device's real cadence instead of a hard-coded one.
   *
   * At 4 fps a 0.4 s dropout tolerance is ONE frame interval, so a camera that is working — slowly —
   * reads as a camera that has gone, and the step cap meant for a backgrounded tab throttles the fill.
   * Neither is a statement about the patient. Changing these does not disturb a hold in progress.
   */
  setCadence(graceSec: number, maxStepSec: number): void {
    const g = Number.isFinite(graceSec) && graceSec > 0 ? graceSec : this.opts.graceSec;
    const m = Number.isFinite(maxStepSec) && maxStepSec > 0 ? maxStepSec : this.opts.maxStepSec;
    if (g === this.opts.graceSec && m === this.opts.maxStepSec) return;
    this.opts = { ...this.opts, graceSec: g, maxStepSec: m };
  }

  /** Forget everything: no hold, no pointer history, entry gate re-armed. */
  reset(): void {
    this.samples = [];
    this.lastT = NaN;
    this.lastSeen = -Infinity;
    this.progress = 0;
    this.insideFlag = false;
    this.withinEntry = false;
    this.bandSince = NaN;
    this.seenOutside = false;
    this.limbKey = null;
    this.blockedUntil = -Infinity;
    this.current = this.empty();
  }

  /**
   * Advance to `tSec` with the pointer observed at that instant (null = the limb was not found), and
   * optionally WHICH limb it is (`limbKey`): see property 5 in the header. A caller that does not
   * distinguish limbs passes nothing and gets the old single-buffer behaviour.
   *
   * CALL IT ONCE PER OBSERVATION, not once per repaint: `null` means "this observation found no
   * limb", and re-feeding a pointer that arrived two repaints ago would count a hold nobody saw.
   * A caller drives this from the vision module's per-frame callback, plus a watchdog that feeds
   * `null` when frames stop arriving at all — otherwise a wedged camera freezes a half-filled ring.
   *
   * Returns the new state. `confirmed` is an EDGE: it is true on this one call and false on the next,
   * so a caller may act on it directly without tracking its own previous value.
   */
  update(pointer: DwellPoint | null, tSec: number, limbKey?: string | null): DwellState {
    const {
      holdSec,
      exitRatio,
      bandGraceSec,
      smoothingSec,
      graceSec,
      decayRatio,
      refractorySec,
      maxStepSec,
      xScale,
      requireEntry,
    } = this.opts;

    const t = Number.isFinite(tSec) ? tSec : this.lastT;
    // A non-monotonic or absent clock advances nothing rather than stepping backwards through a hold.
    const dt = Number.isFinite(this.lastT) ? Math.min(Math.max(t - this.lastT, 0), maxStepSec) : 0;
    this.lastT = t;

    if (finitePoint(pointer)) {
      const key = limbKey ?? null;
      // A DIFFERENT limb: everything in the buffer describes the other one, and the mean of two limbs
      // is a place neither of them is. Throw it away, and drop the hysteresis with it — the new limb
      // has to satisfy the ENTRY radius on its own rather than inherit a boundary it never crossed.
      //
      // The entry gate is deliberately NOT re-armed here. It records that the pointer has been outside
      // this circle since the tracker was armed, and `pickDwellLimb` only ever hands over to a limb
      // that is INSIDE a target (a limb outside every target cannot take the pick from one inside one),
      // so the gate can only have opened at a moment when no limb was in the circle at all — which is
      // the thing it exists to establish. Re-arming it here instead made the gesture impossible: the
      // hand-over happens exactly as the new limb crosses into the circle, so the gate would be closed
      // by the very movement that was supposed to open it, and the ring sat at "move out, then back"
      // for ever. Seen in the running app before it was fixed.
      if (key !== null && this.limbKey !== null && key !== this.limbKey) {
        this.samples = [];
        this.insideFlag = false;
        this.withinEntry = false;
        this.bandSince = NaN;
      }
      if (key !== null) this.limbKey = key;
      this.samples.push({ t, x: pointer.x, y: pointer.y });
      this.lastSeen = t;
    }
    // The window is the tremor filter: everything older than `smoothingSec` stops voting, so a pointer
    // that has been gone longer than the window leaves nothing to test containment against.
    const cutoff = t - smoothingSec;
    while (this.samples.length > 0 && this.samples[0].t < cutoff) this.samples.shift();

    let smoothed: DwellPoint | null = null;
    if (this.samples.length > 0) {
      let sx = 0;
      let sy = 0;
      for (const s of this.samples) {
        sx += s.x;
        sy += s.y;
      }
      smoothed = { x: sx / this.samples.length, y: sy / this.samples.length };
    }

    const lostSec = Number.isFinite(this.lastSeen) ? Math.max(0, t - this.lastSeen) : Infinity;
    /**
     * WHAT THE SCREEN MAY CLAIM versus WHAT THE HOLD MAY COUNT — deliberately two different tests.
     *
     * `tracked` tolerates `graceSec` of nothing, so the caption does not flash "I cannot see you" at
     * a patient whose landmark dropped for two frames. The HOLD, below, counts only updates that
     * actually carried a landmark: the smoothed pointer survives a dropout by design (that is the
     * tremor filter), and letting it keep filling the ring would credit a hold nobody observed.
     * A dropout decays instead — slowly — which is the forgiving behaviour the ring is allowed to
     * show, because it is the behaviour a later frame can still contradict.
     */
    const tracked = lostSec <= graceSec;
    const fresh = lostSec === 0;

    if (smoothed === null) {
      this.insideFlag = false;
      this.withinEntry = false;
      this.bandSince = NaN;
    } else {
      const d = dwellDistance(smoothed, this.target, xScale);
      this.withinEntry = d <= this.target.radius;
      if (this.withinEntry) {
        // Inside the circle the patient can see: that is the hold, and any earlier excursion is over.
        this.insideFlag = true;
        this.bandSince = NaN;
      } else if (this.insideFlag) {
        if (d > this.target.radius * exitRatio) {
          // Past the band: gone, immediately.
          this.insideFlag = false;
          this.bandSince = NaN;
        } else {
          // In the band. A wobble is forgiven; LIVING here is not — a limb that has come to rest just
          // outside the ring is not holding, whatever the hysteresis would like to say.
          if (!Number.isFinite(this.bandSince)) this.bandSince = t;
          if (t - this.bandSince > bandGraceSec) {
            this.insideFlag = false;
            this.bandSince = NaN;
          }
        }
      }
      // The entry gate opens on a limb genuinely observed outside THE DRAWN CIRCLE — the boundary the
      // patient is looking at — and never on a limb that merely stopped being detected, which is the
      // state a patient cannot tell apart from "it is working".
      if (!this.withinEntry) this.seenOutside = true;
    }

    const refractory = t < this.blockedUntil;
    // COUPLED OUTRANKS OCCUPIED, and both outrank the entry gate: of the three, "this limb is being
    // moved by the exercise" is the one the patient cannot fix by moving the limb or by waiting for
    // the ring to slide somewhere clear, so it is the one the screen has to say.
    const blocked: DwellBlock | null = refractory
      ? 'refractory'
      : this.coupled
        ? 'coupled'
        : this.occupied
          ? 'occupied'
          : requireEntry && !this.seenOutside
            ? 'entry'
            : null;
    const holding = fresh && this.insideFlag && blocked === null;

    let confirmed = false;
    if (refractory) {
      // Nothing accumulates, and nothing is left on screen half-filled from the hold just answered.
      this.progress = 0;
    } else if (holding) {
      this.progress = Math.min(1, this.progress + dt / holdSec);
      // THE COMPLETING FRAME IS TESTED AGAINST THE DRAWN CIRCLE. A ring that filled while the pointer
      // wobbled into the band may not ALSO finish out there: the last thing a confirm asserts is that
      // the limb was inside the ring the patient was looking at.
      if (this.progress >= 1 && this.withinEntry) {
        confirmed = true;
        this.count += 1;
        this.progress = 0;
        this.blockedUntil = t + refractorySec;
        // Re-arm the entry gate as well: the limb must leave and come back for the NEXT question.
        this.seenOutside = false;
      }
    } else {
      this.progress = Math.max(0, this.progress - (dt * decayRatio) / holdSec);
    }

    this.current = Object.freeze({
      progress: this.progress,
      inside: this.insideFlag,
      withinEntry: this.withinEntry,
      tracked,
      holding,
      confirmed,
      confirmations: this.count,
      blocked: confirmed ? 'refractory' : blocked,
      pointer: smoothed,
      lostSec,
      remainingSec: (1 - this.progress) * holdSec,
      target: this.target,
      xScale,
    });
    return this.current;
  }
}

/* ---------------- which limb is doing the pointing ---------------- */

/**
 * A limb that could drive a dwell target, and what it is honest to call it on screen.
 *
 * WHICH LIMB CONFIRMS IS NOT THE LIMB BEING EXERCISED. A hemiparetic patient is prescribed their
 * affected side; asking that side to hold still over a target for two seconds is asking for the one
 * thing it cannot reliably do. Either side is accepted here — the unaffected one explicitly included —
 * and the screen says which one it is currently following, so nobody can believe the confirmation was
 * evidence about the affected limb.
 */
export interface DwellLimb {
  point: DwellPoint;
  /** The patient's side when it can be said with confidence; null when it genuinely cannot. */
  side: Side | null;
  /** What to call it in a sentence: "your left hand", "a hand", "your right knee". */
  label: string;
  /**
   * WHICH limb this is, stably between frames: 'knee:left', 'hand:right', 'hand:#1' for a hand whose
   * handedness the model will not commit to. The dwell tracker keys its smoothing buffer on this so
   * two limbs are never averaged into one pointer (property 5 in the header).
   */
  key: string;
  /**
   * The limb's OWN size in frame heights — hand mode: the palm length (wrist → middle MCP). It is how
   * far this patient's limb moves per unit of movement at this camera distance, so a clearance
   * expressed in it (`DWELL_LATERAL_FLOOR_PALMS`) scales with the patient and the framing instead of
   * assuming either. Null where there is nothing to measure it from.
   */
  scale: number | null;
}

/** Below this handedness score the MediaPipe label does not identify the hand (see mediapipe.ts). */
export const DWELL_MIN_LABEL_SCORE = 0.6;

/** Hand landmarks whose mean is the palm centre — steady while the fingers open, close and oppose. */
const PALM = [HAND.WRIST, HAND.INDEX_MCP, HAND.MIDDLE_MCP, HAND.RING_MCP, HAND.PINKY_MCP] as const;

function visible(l: Landmark | undefined): l is Landmark {
  return !!l && Number.isFinite(l.x) && Number.isFinite(l.y) && (l.visibility === undefined || l.visibility >= MIN_VISIBILITY);
}

/**
 * Is this point in the frame at all?
 *
 * Pose extrapolates landmarks it cannot see off the edge of the image and still labels them visible,
 * and a limb the patient cannot see in the preview must not be able to drive a target they can. The
 * bound is the frame, because the frame is what the coordinates are normalized to.
 */
function inFrame(p: DwellPoint): boolean {
  return p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1;
}

function centre(points: readonly Landmark[]): DwellPoint | null {
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (const p of points) {
    if (!visible(p)) continue;
    sx += p.x;
    sy += p.y;
    n += 1;
  }
  return n === 0 ? null : { x: sx / n, y: sy / n };
}

/**
 * The Pose slot holding the PATIENT's `side` wrist, under the mirror convention in force.
 *
 * `poseSideIndices` (features.ts) is the canonical mapping for the limbs the FEATURES read; it does
 * not carry the wrist, so this repeats the one rule it encodes: on a MIRRORED stream the model labels
 * the apparent anatomy, so the patient's left limb arrives in the RIGHT_* slots.
 */
function poseWrist(side: Side, mirrored: boolean): number {
  const underLeftLabels = mirrored ? side === 'right' : side === 'left';
  return underLeftLabels ? POSE.LEFT_WRIST : POSE.RIGHT_WRIST;
}

/**
 * Every limb in this frame that could park itself on a target.
 *
 * HAND mode: the palm centre of each detected hand, with the palm LENGTH reported alongside it — the
 * palm rather than a fingertip because the prescribed hand movements (open/close, opposition, spread)
 * move the fingertips by design, and the length because every clearance this mode claims is measured
 * in the patient's own hand (see `dwellAxisFor`). The prescribed hand is accepted as a pointer: in
 * hand mode there is no other limb, and the separation that makes a confirm deliberate is geometric
 * (lateral) rather than a matter of which limb it is.
 *
 * LEG mode: the HANDS ONLY, mapped through the mirror convention so the side named on screen is the
 * patient's side, not the image's.
 *
 * THE KNEES USED TO BE HERE AND THEY HAD TO GO. A seated patient puts a knee somewhere only by
 * performing a prescribed leg movement — knee height IS seated_march, lateral knee travel IS
 * hip_abduction — so there is no target a knee can hold that a repetition does not fill. It was not
 * hypothetical: a march with hip circumduction, the compensation this app promises never to penalise,
 * confirmed at the camera check, threw a patient off their own ROM measurement, and ended a session
 * from the pause dialog. The hands are free in leg mode (the patient is exercising their legs) and the
 * prescription never moves them, so they are the pointer and the knees are not.
 *
 * The cost, said out loud because it is real: a knees-up framing with no hands in the picture has no
 * hands-free path. `DwellLegend` says so, and the buttons still work.
 */
export function dwellLimbs(
  result: DetectionResult | null | undefined,
  mode: Mode,
  mirrored = false,
  xScale = 1,
): DwellLimb[] {
  if (!result) return [];
  const out: DwellLimb[] = [];
  if (mode === 'hand') {
    let unlabelled = 0;
    for (const hand of result.hands) {
      const point = centre(PALM.map((i) => hand.landmarks[i]));
      if (!point || !inFrame(point)) continue;
      // An unconfident label is reported as unknown rather than guessed: the caption is read by the
      // patient and "your left hand" pointing at their right one is a small lie in the same family as
      // every other one this app refuses to tell.
      const side = hand.score >= DWELL_MIN_LABEL_SCORE ? labelToPatientSide(hand.label, mirrored) : null;
      unlabelled += side ? 0 : 1;
      out.push({
        point,
        side,
        label: side ? `your ${side} hand` : 'a hand',
        key: side ? `hand:${side}` : `hand:#${unlabelled}`,
        scale: palmLength(hand.landmarks, xScale),
      });
    }
    return out;
  }
  const pose = result.pose;
  if (!pose) return out;
  for (const side of ['left', 'right'] as Side[]) {
    const wrist = pose[poseWrist(side, mirrored)];
    if (visible(wrist) && inFrame(wrist)) {
      out.push({ point: { x: wrist.x, y: wrist.y }, side, label: `your ${side} hand`, key: `hand:${side}`, scale: null });
    }
  }
  return out;
}

/**
 * The patient's own palm length in frame heights (wrist → middle MCP), or null when it cannot be had.
 *
 * This is the unit the hand-mode clearance is quoted in. A number in frame heights would be a
 * statement about the camera; a number in palm lengths is a statement about the hand, and it survives
 * a patient sitting closer, a different sensor and a different pair of hands.
 */
function palmLength(landmarks: readonly Landmark[], xScale: number): number | null {
  const wrist = landmarks[HAND.WRIST];
  const mcp = landmarks[HAND.MIDDLE_MCP];
  if (!visible(wrist) || !visible(mcp)) return null;
  const d = Math.hypot((wrist.x - mcp.x) * xScale, wrist.y - mcp.y);
  return Number.isFinite(d) && d > 0 ? d : null;
}

export interface PickDwellLimbOptions {
  /** Where the limb picked last frame was, so the choice does not flicker between two candidates. */
  previous?: DwellPoint | null;
  /** WHICH limb was picked last frame (`DwellLimb.key`) — identity beats proximity. */
  previousKey?: string | null;
  xScale?: number;
  /** How far the previously-picked limb may have moved and still be recognised as the same one. */
  continuityRadius?: number;
  /**
   * Limbs that may not be followed while any other limb is available (`DwellCoupling.coupledKeys`):
   * a hand the exercise is carrying is not a witness, so the OTHER hand — the one on the chair arm —
   * takes the pick even while the carried one is sitting inside a circle.
   *
   * It is a preference and not a removal, because a limb nobody may follow still has to be NAMED: if
   * every candidate is refused, the pick falls back to the ordinary ranking so the screen can say
   * which hand it is watching and why the ring will not fill (`DwellTracker.setCoupled`). Reporting
   * "no hand in view" for a hand that is plainly in view is the untruth this app keeps refusing.
   */
  avoid?: ReadonlySet<string> | readonly string[];
}

/** Default `continuityRadius`: about a fifth of the frame height between one frame and the next. */
export const DWELL_CONTINUITY_RADIUS = 0.2;

/**
 * The limb the targets are following: whichever is INSIDE a target, else whichever is nearest one.
 *
 * "Whichever enters first" in practice means: a limb inside a target always beats a limb outside every
 * target, and the choice sticks to the limb it was already following while that limb is still there —
 * otherwise two hands equidistant from a target would swap the caption (and the hold) every frame.
 *
 * STICKINESS IS BY IDENTITY FIRST. Matching on position alone cannot tell "the limb I was following"
 * from "the other limb, which happens to be about as far away" — and for a symmetrically seated
 * patient the two knees are further apart than any continuity radius that is also tolerant of a fast
 * move, so position-matching let the pick alternate between them. `previousKey` decides it outright
 * while that limb is still a candidate.
 */
export function pickDwellLimb(
  limbs: readonly DwellLimb[],
  targets: readonly DwellCircle[],
  opts: PickDwellLimbOptions = {},
): DwellLimb | null {
  if (limbs.length === 0) return null;
  const avoid = opts.avoid instanceof Set ? opts.avoid : new Set(opts.avoid ?? []);
  // A limb the exercise is carrying is set aside while any other limb is in the frame; with nothing
  // else to follow, every limb is back in the running and the caller has to say why it cannot count.
  const free = avoid.size > 0 ? limbs.filter((l) => !avoid.has(l.key)) : limbs;
  const pool0: readonly DwellLimb[] = free.length > 0 ? free : limbs;
  if (targets.length === 0) return pool0[0];
  const xScale = opts.xScale ?? 1;
  const continuity = opts.continuityRadius ?? DWELL_CONTINUITY_RADIUS;
  const previous = finitePoint(opts.previous ?? null) ? (opts.previous as DwellPoint) : null;
  const previousKey = opts.previousKey ?? null;

  const scored = pool0.map((limb) => {
    let nearest = Infinity;
    let inside = false;
    for (const target of targets) {
      const d = dwellDistance(limb.point, target, xScale);
      if (d < nearest) nearest = d;
      if (d <= target.radius) inside = true;
    }
    const carried = previous ? Math.hypot((limb.point.x - previous.x) * xScale, limb.point.y - previous.y) : Infinity;
    return { limb, nearest, inside, carried };
  });

  const insiders = scored.filter((s) => s.inside);
  const pool = insiders.length > 0 ? insiders : scored;
  // Identity first: the limb we were following keeps the pick while it is still in the running.
  const same = previousKey ? pool.find((s) => s.limb.key === previousKey) : undefined;
  if (same) return same.limb;
  // Then position, for callers that cannot name their limbs (and for the first frame after a switch).
  const carried = pool.filter((s) => s.carried <= continuity).sort((a, b) => a.carried - b.carried);
  if (carried.length > 0) return carried[0].limb;
  return pool.slice().sort((a, b) => a.nearest - b.nearest)[0].limb;
}

/* ---------------- where a limb actually lives ---------------- */

/** How a target's separation from a limb is measured. See `dwellAxisFor`. */
export type DwellAxis =
  /** Straight-line distance in frame heights: the limb is not prescribed, so any direction counts. */
  | 'radial'
  /** Across-frame distance only: the prescription moves this limb, but never sideways. */
  | 'lateral';

/**
 * WHICH SEPARATION A MODE IS ENTITLED TO CLAIM.
 *
 * LEG mode follows the hands, which the leg prescription does not move at all, so the whole distance
 * counts and a target may sit anywhere a hand does not live.
 *
 * HAND mode follows the prescribed hand itself, so only the component of the separation the
 * prescription cannot consume may be counted. The four hand movements (open/close, wrist extension,
 * opposition, spread) are finger and wrist motions about a forearm resting on the table: measured on
 * the repo's own rig they move the palm centroid by up to 1.94 palm lengths ALONG the fingers and by
 * nothing across, and the forearm-lift compensation is vertical too. A circle whose centre is further
 * to the SIDE than its own exit radius cannot contain the palm at any height whatsoever, so lateral
 * separation is the part of the geometry the exercise cannot eat into — whatever the patient's size,
 * the camera distance or the framing.
 */
export function dwellAxisFor(mode: Mode): DwellAxis {
  return mode === 'hand' ? 'lateral' : 'radial';
}

/** Clear water demanded beyond the hysteresis band, in frame heights (~2 cm on a seated framing). */
export const DWELL_CLEAR_MARGIN = 0.03;
/**
 * Lateral wander allowed for a hand, in the patient's OWN palm lengths, when the measured wander is
 * smaller. The rig's prescribed movements move the palm 0 sideways; a real forearm rolls, deviates and
 * shifts on the table, and a floor measured in palm lengths scales with the patient and the camera
 * distance instead of assuming either. It is a floor, never a cap: a hand that is measured wandering
 * further than this demands the measured amount.
 */
export const DWELL_LATERAL_FLOOR_PALMS = 0.75;
/**
 * Clearance a RELOCATED target aims for beyond the minimum, in frame heights. The minimum is the point
 * at which a hold stops being ambiguous; this is the point at which the reach is also a real gesture —
 * the patient moves the limb somewhere it was not, rather than nudging it a centimetre.
 */
export const DWELL_CLEAR_EXTRA = 0.08;
/**
 * HOW FAR A RING MAY BE MOVED FROM WHERE THE LAYOUT AUTHORED IT, in frame heights. Was 0.6, which is
 * most of the frame and is how a circle walked into a corner: traced in the running app, a primary
 * slid 0.72,0.32 -> 0.72,0.215 -> 0.787,0.14, i.e. into the top of the picture at the far edge, 0.518
 * frame heights from the resting hand that has to reach it. A ring that has run away from the patient
 * is not a remedy for a ring that was standing on them; past this distance the honest answer is
 * `placeable: false` and a screen that says so.
 *
 * This is the weaker of the three bounds and it is about RECOGNITION — the patient has to find the
 * circle they learned. The two that are about the BODY are `dwellPlaceable` (never a ring whose whole
 * area is up in the top third of the picture, i.e. never an unsupported arm held overhead for two
 * seconds) and `DWELL_LIMB_REACH` (never a ring further from the nearest limb than that limb can
 * travel). All three have to hold, and it is the last two that the traced walk into the corner broke:
 * 0.518 frame heights from the hand that had to reach it is not a distance, it is a different screen.
 */
export const DWELL_MAX_REACH = 0.35;
/**
 * The same cap for the LATERAL axis, and it is deliberately looser — it is the old unbounded 0.6, kept.
 * Leg mode's escape axis is vertical and every unit of it is an arm raised further against gravity;
 * hand mode's is a slide ACROSS a table that is carrying the forearm the whole way, which is why that
 * is the axis the mode was given in the first place. A hand-mode ring may therefore travel most of the
 * way across the frame to get clear of a palm the framing put on top of it, and a leg-mode ring may
 * not climb. Measured: capping the lateral axis at 0.45 instead cost the hands-free path on 3 % of the
 * sitting-still sweep's bodies (a palm framed off-centre at 1.6x scale has to be escaped sideways and
 * there is nowhere else to go), and bought nothing — the corner the rings walked into was a VERTICAL
 * climb, and what stops that is `dwellPlaceable` and `DWELL_LIMB_REACH`, not a shorter leash.
 */
export const DWELL_MAX_REACH_LATERAL = 0.6;
/**
 * A RELOCATED RING MAY NOT ASK FOR AN ARM HELD UP IN THE TOP OF THE PICTURE.
 *
 * The same rule the authored positions are chosen by, and DwellTarget.tsx states it in its own words:
 * an unsupported arm held in the upper third of the frame for nearly two seconds is a therapy
 * exercise, not a click. A ring must therefore still reach into the middle third (`y + radius`), and
 * must not be pushed off the bottom either; the drawing constraint (`fits`) is separate and both apply.
 */
export const DWELL_UPPER_THIRD = 1 / 3;
export const DWELL_LOWER_LIMIT = 0.95;

/** Is this a place a seated patient can be asked to hold a limb for `holdSec`? */
export function dwellPlaceable(c: DwellCircle): boolean {
  return c.y + c.radius > DWELL_UPPER_THIRD && c.y - c.radius < DWELL_LOWER_LIMIT;
}

/**
 * HOW FAR A LIMB MAY BE ASKED TO TRAVEL TO A RING, in frame heights, measured from where that limb
 * LIVES to the near edge of the circle.
 *
 * 0.45 is not a new number: it is the bound the reach test in DwellTarget.test.tsx already holds the
 * AUTHORED positions to, from every rest position a seated patient's hands take. A relocated ring is
 * held to the same standard, because the patient who has to reach it is the same patient — and because
 * "the circle moved somewhere clear" stops being a remedy at the point where nobody can get to it.
 */
export const DWELL_LIMB_REACH = 0.45;

/**
 * Can SOME limb in view still get to this circle? True when there is nothing in view to reach with —
 * a screen with no limbs measured yet is not evidence that a placement is unreachable.
 */
export function dwellWithinLimbReach(
  c: DwellCircle,
  summaries: readonly DwellHabitatSummary[],
  xScale = 1,
  limit = DWELL_LIMB_REACH,
): boolean {
  if (summaries.length === 0) return true;
  for (const s of summaries) {
    if (dwellDistance(s.home, c, xScale) - c.radius <= limit) return true;
  }
  return false;
}
/** How long a limb's positions are remembered. Long enough that a 2 s reach is a small minority. */
export const DWELL_HABITAT_WINDOW_SEC = 20;
/** Positions are recorded no faster than this, so a 60 fps camera and a 5 fps one weigh the same. */
export const DWELL_HABITAT_INTERVAL_SEC = 0.1;
/** A limb not seen for this long stops constraining anything: it has left the picture. */
export const DWELL_HABITAT_FORGET_SEC = 5;
/** Below this many samples the limb's CURRENT position is treated as where it lives (conservative). */
export const DWELL_HABITAT_MIN_SAMPLES = 5;

/** What a limb's occupancy record says about it. */
export interface DwellHabitatSummary {
  key: string;
  /** Marginal median of the remembered positions: where this limb lives. */
  home: DwellPoint;
  /** 75th percentile of the distance from `home`, in frame heights: how far it wanders. */
  spread: number;
  /** 75th percentile of |x − home.x| · xScale: how far it wanders ACROSS the frame. */
  lateralSpread: number;
  /** The limb's own scale (hand mode: palm length in frame heights), or null when it has none. */
  scale: number | null;
  samples: number;
  /** Wall-clock of the last position recorded. */
  lastSeen: number;
  /** False while too few samples have arrived to take an order statistic (see MIN_SAMPLES). */
  settled: boolean;
}

interface Track {
  ts: number[];
  xs: number[];
  ys: number[];
  scale: number | null;
  last: number;
  /** Cached summary, invalidated by the sample count and the xScale it was computed in. */
  cache: { n: number; xScale: number; summary: DwellHabitatSummary } | null;
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[i];
}

/**
 * WHERE EACH LIMB HAS BEEN, for the last twenty seconds.
 *
 * This is the measurement that replaced a promise. A target may only be held while it clears where the
 * patient's limbs actually live — not where a synthetic rig puts them, not where the layout assumed
 * they would be — because the framing, the patient's size and the chair are all things the clinic
 * varies and the app does not control.
 *
 * IT IS READ WITH ORDER STATISTICS, AND THAT IS THE WHOLE TRICK. A mean, or a running maximum, is
 * moved by the very reach that the gesture consists of: the patient extends toward the circle, the
 * estimate follows them, the requirement grows, and the ring can never be filled by anybody. A median
 * and a 75th percentile do not move for an excursion that is a small minority of a twenty-second
 * window — which a two-second reach, or even a 1.8 s hold, is — while a movement the patient repeats
 * (their exercise, a tremor, a hand that genuinely lives there) is a majority and moves them at once.
 *
 * Samples are recorded at most every `DWELL_HABITAT_INTERVAL_SEC`, so the record is a measure of TIME
 * SPENT rather than of frames delivered: a 60 fps webcam and a 5 fps one describe the same patient.
 */
export class DwellHabitat {
  private tracks = new Map<string, Track>();
  private windowSec: number;
  private intervalSec: number;
  private forgetSec: number;

  constructor(opts: { windowSec?: number; intervalSec?: number; forgetSec?: number } = {}) {
    this.windowSec = opts.windowSec ?? DWELL_HABITAT_WINDOW_SEC;
    this.intervalSec = opts.intervalSec ?? DWELL_HABITAT_INTERVAL_SEC;
    this.forgetSec = opts.forgetSec ?? DWELL_HABITAT_FORGET_SEC;
  }

  /** Record where one limb is now. Cheap to call every frame; it thins the record itself. */
  noteOne(key: string, point: DwellPoint, tSec: number, scale: number | null = null): void {
    if (!key || !finitePoint(point) || !Number.isFinite(tSec)) return;
    let track = this.tracks.get(key);
    if (!track) {
      track = { ts: [], xs: [], ys: [], scale: null, last: -Infinity, cache: null };
      this.tracks.set(key, track);
    }
    track.last = tSec;
    if (scale !== null && Number.isFinite(scale) && scale > 0) track.scale = scale;
    const n = track.ts.length;
    if (n > 0 && tSec - track.ts[n - 1] < this.intervalSec) return;
    track.ts.push(tSec);
    track.xs.push(point.x);
    track.ys.push(point.y);
    const cutoff = tSec - this.windowSec;
    let drop = 0;
    while (drop < track.ts.length && track.ts[drop] < cutoff) drop += 1;
    if (drop > 0) {
      track.ts.splice(0, drop);
      track.xs.splice(0, drop);
      track.ys.splice(0, drop);
    }
    track.cache = null;
  }

  /** Record every limb in a frame. */
  note(limbs: readonly DwellLimb[], tSec: number): void {
    for (const limb of limbs) this.noteOne(limb.key, limb.point, tSec, limb.scale ?? null);
  }

  /** Everything seen recently enough to still constrain a target. */
  all(tSec: number, xScale = 1): DwellHabitatSummary[] {
    const out: DwellHabitatSummary[] = [];
    for (const [key, track] of this.tracks) {
      if (Number.isFinite(track.last) && tSec - track.last > this.forgetSec) {
        this.tracks.delete(key);
        continue;
      }
      const summary = this.summaryOf(key, track, xScale);
      if (summary) out.push(summary);
    }
    return out;
  }

  /** One limb's record, or null when it has never been seen. */
  get(key: string, xScale = 1): DwellHabitatSummary | null {
    const track = this.tracks.get(key);
    return track ? this.summaryOf(key, track, xScale) : null;
  }

  /** Throw the record away (a new screen, a new patient, a camera that restarted). */
  clear(): void {
    this.tracks.clear();
  }

  private summaryOf(key: string, track: Track, xScale: number): DwellHabitatSummary | null {
    const n = track.ts.length;
    if (n === 0) return null;
    if (track.cache && track.cache.n === n && track.cache.xScale === xScale) return track.cache.summary;
    const settled = n >= DWELL_HABITAT_MIN_SAMPLES;
    let home: DwellPoint;
    let spread = 0;
    let lateralSpread = 0;
    if (!settled) {
      // Too little to take a percentile of: the limb is treated as living exactly where it is, which
      // is the conservative reading — a target on top of it is refused rather than given the benefit
      // of a doubt nobody has measured.
      home = { x: track.xs[n - 1], y: track.ys[n - 1] };
    } else {
      const xs = [...track.xs].sort((a, b) => a - b);
      const ys = [...track.ys].sort((a, b) => a - b);
      home = { x: quantile(xs, 0.5), y: quantile(ys, 0.5) };
      const radial: number[] = [];
      const lateral: number[] = [];
      for (let i = 0; i < n; i++) {
        const dx = (track.xs[i] - home.x) * xScale;
        const dy = track.ys[i] - home.y;
        radial.push(Math.hypot(dx, dy));
        lateral.push(Math.abs(dx));
      }
      radial.sort((a, b) => a - b);
      lateral.sort((a, b) => a - b);
      spread = quantile(radial, 0.75);
      lateralSpread = quantile(lateral, 0.75);
    }
    const summary: DwellHabitatSummary = {
      key,
      home,
      spread,
      lateralSpread,
      scale: track.scale,
      samples: n,
      lastSeen: track.last,
      settled,
    };
    track.cache = { n, xScale, summary };
    return summary;
  }
}

/* ---------------- is this limb INDEPENDENT of the prescribed exercise? ---------------- */

/**
 * WHY AN INSTRUCTION IS NOT A GUARANTEE, AND WHAT IS MEASURED INSTEAD.
 *
 * Leg mode follows the HANDS because the knees cannot answer (see the header). That is only a
 * separation while the hand is held up by something the exercise does not move. A hand resting ON THE
 * THIGH is not: hip flexion rotates the thigh about the hip, so a hand at fraction f along the
 * hip->knee segment rises by f x the knee's travel, and hip circumduction — the compensation this app
 * promises never to penalise — carries it sideways at the same time. Driven through the shipping
 * classes, a seated march with circumduction and a hand on the thigh confirmed the PRIMARY circle at
 * t = 3.23 s on the first repetition, at every frame rate and every frame aspect; on the pause dialog
 * the secondary circle ends the session and writes a truncated record.
 *
 * `POSTURE_INFO.seated_leg` now asks for a support the leg cannot move (a chair arm, an armrest, a
 * table) and says why the thigh is not one. But the last three rounds of this feature were each lost
 * to trusting a premise about the body instead of measuring it, so the instruction is only half:
 *
 *   THE POINTER'S INDEPENDENCE IS MEASURED FROM THE LANDMARKS, over a rolling readiness window, and a
 *   limb that is moving WITH the prescribed movement may not point at anything.
 *
 * The measurement is a least-squares fit of the pointer's FRAME-TO-FRAME TRAVEL onto the travel of one
 * prescribed segment (`dwellReferences`), both taken in the patient's own frame of reference
 * (`dwellOrigin`: hip-relative), with ONE coefficient across BOTH AXES. That shape is not a detail —
 * every part of it is a false positive that was found in the running app and had to be closed:
 *   - INCREMENTS RATHER THAN LEVELS. A hand that is carried tracks the segment on every frame, up AND
 *     down; a hand the patient DELIBERATELY RAISES makes one excursion of its own while the exercise
 *     goes on around it, so over the window its increments are mostly zero where the segment's are
 *     not. Levels would correlate those two equally well, and refusing the second is refusing the
 *     gesture this whole path exists for.
 *   - BOTH SIDES HIP-RELATIVE. Anything that moves the patient as a whole — sliding down in the chair,
 *     a nudged tripod — moves an absolute pointer while the segments stand still.
 *   - ONE COEFFICIENT ACROSS BOTH AXES. This is what makes it a statement about DIRECTION: a hand at
 *     fraction f along the hip->knee segment satisfies (wrist - hip) = f x (knee - hip) in x and y at
 *     once, with the same f. A world-fixed hand under a drift that happens to run alongside a
 *     repetition satisfies it in one axis only, and the pooled fit leaves the rest in the residual.
 *   - AND THE FIT HAS TO REST ON MANY FRAMES (`DWELL_COUPLING_MIN_MOVING`), because a single instant
 *     in which the pointer jumped and the segment jumped correlates perfectly and means nothing.
 *
 * Three numbers decide, and all of them have to be met:
 *   - R2, how much of the pointer's travel the segment ACCOUNTS FOR (a carried hand: 1.00);
 *   - `fraction`, the fitted carry coefficient, which has to be forward and no more than a little past
 *     the end of the segment — a hand rests somewhere between the hip and the knee;
 *   - `explained`, how far the pointer travels BECAUSE of the exercise, in frame heights — so a hand
 *     resting at the hip end of the thigh, which moves a millimetre, is not called coupled on the
 *     strength of a perfect correlation with nothing.
 */

/**
 * One reference for one frame: WHERE A PRESCRIBED SEGMENT IS, in the patient's own frame of reference
 * (hip-relative, frame heights, x already multiplied by `xScale`).
 *
 * It is a POINT and not a scalar, and that is the whole of why this measurement works. A scalar
 * feature ("knee height over torso") tells you the pointer moved in proportion to the exercise; it
 * cannot tell you the pointer moved WITH it. A hand resting on a chair arm while the patient slides
 * down in the seat moves, in the patient's frame, by exactly minus the drift — and if the drift runs
 * alongside a repetition, its y is proportional to the knee's. Refusing that hand is refusing the
 * support the app asks for (seen in the running app: `hand:right follows knee1:x r2=1.00`, and all of
 * that hand's travel was the room moving under it).
 *
 * Fitting a SINGLE coefficient across BOTH axes asks the question the body actually answers: a hand at
 * fraction f along the hip->knee segment satisfies (wrist - hip) = f x (knee - hip) in x and y at once,
 * with the same f and f > 0. A drifting world-fixed hand cannot: its motion has a component the segment
 * does not have, and the pooled fit leaves it in the residual.
 */
export interface DwellReference {
  /** Stable name, so a verdict can say WHICH prescribed movement the limb was following. */
  key: string;
  x: number;
  y: number;
}

/** How long the pointer and the exercise are compared over — the readiness window. */
export const DWELL_COUPLING_WINDOW_SEC = 4;
/** Sampled no faster than this, so a 60 fps camera and a 12 fps one weigh the same. */
export const DWELL_COUPLING_INTERVAL_SEC = 0.08;
/** Below this many samples, or this much time, nothing is claimed either way. */
export const DWELL_COUPLING_MIN_SAMPLES = 12;
export const DWELL_COUPLING_MIN_SPAN_SEC = 1;
/**
 * Share of the pointer's travel the exercise must account for before they are "moving together".
 *
 * 0.8, not 0.5, and the difference is a false positive found in the running app rather than a taste:
 * a patient who RAISES a hand to the ring while their leg is mid-repetition — which is exactly what
 * the ROM screen asks for, reps and then a confirm — produced an overlap of a second or so in which
 * the hand's increments and the knee's were correlated enough to clear 0.5, and the app refused the
 * hand that was answering it. A limb that is genuinely being CARRIED is an affine function of the
 * segment holding it: measured in these classes, at every fraction along the thigh, in every framing
 * and at every frame rate, it comes out at r2 = 1.00. There is a wide gap between the two, and the
 * threshold belongs in the gap.
 */
export const DWELL_COUPLING_MIN_R2 = 0.8;
/**
 * Travel (frame heights) the exercise must explain before it matters. A quarter of a dwell radius: a
 * hand carried this far by a repetition can be carried into a circle by one, and a hand carried less
 * than this cannot reach anything it was not already on.
 */
export const DWELL_COUPLING_MIN_TRAVEL = 0.025;
/** Once coupled, a limb stays refused this long without new evidence — a verdict, not a flicker. */
export const DWELL_COUPLING_HOLD_SEC = 1.5;
/**
 * HOW MANY FRAMES HAVE TO AGREE, and why one is never enough.
 *
 * A correlation over increments is perfect whenever exactly ONE pair of frames moved: a single instant
 * in which the pointer jumped and the prescribed feature jumped gives r2 = 1 and an `explained` as
 * large as the jump. That instant is common and innocent — a detection glitch, the patient shifting in
 * the chair, the therapist changing which lane is being measured — and in the running app it refused a
 * hand resting on a chair arm for thirty seconds (found by critic/handsfree.mjs on the latency screen,
 * where the harness moves the whole scene and the active leg in the same frame). A limb that is
 * genuinely being carried moves with the segment on EVERY frame of the movement, so:
 *   - at least `MIN_MOVING` frame pairs must have both the pointer and the reference moving, and
 *   - no single pair may carry more than `MAX_PAIR_SHARE` of the fit.
 * At 12 fps — the slowest rate the sweeps cover — a two-second rise still supplies about 12 of them.
 */
export const DWELL_COUPLING_MIN_MOVING = 6;
export const DWELL_COUPLING_MAX_PAIR_SHARE = 0.6;
/**
 * The band of carry fractions that means "this segment is holding this limb": forward (a limb dragged
 * the other way is doing something of its own) and no more than a little past the far end of the
 * segment. A hand rests between the hip and the knee, so 0 < f <= 1 covers the body; the headroom
 * above 1 is for a hand further down the shin and for landmark noise on a small segment.
 */
export const DWELL_COUPLING_MIN_FRACTION = 0.05;
export const DWELL_COUPLING_MAX_FRACTION = 1.6;
/** A limb not seen for this long is forgotten entirely. */
export const DWELL_COUPLING_FORGET_SEC = 5;

/** What the window says about one limb's independence from the prescription. */
export interface DwellCouplingVerdict {
  key: string;
  /** TRUE = this limb moves with the prescribed exercise and may not answer for the patient. */
  coupled: boolean;
  /** Frame heights of this limb's travel the exercise accounts for. */
  explained: number;
  /** 0..1 — the share of its travel that is accounted for. */
  r2: number;
  /**
   * How much of the segment's movement this limb inherits: about 1 for a hand at the knee, 0.7 for one
   * mid-thigh, 0 for one on furniture. It is the fitted coefficient, so it is also the thing that says
   * the limb moved WITH the segment rather than merely in proportion to it.
   */
  fraction: number;
  /** Which reference signal it was following (null when none was implicated). */
  reference: string | null;
  samples: number;
  /** False while the window is too short to say anything: NOT a clean bill of health. */
  settled: boolean;
}

interface CouplingTrack {
  ts: number[];
  /** Pointer position in frame-height units (x already multiplied by xScale). */
  xs: number[];
  ys: number[];
  /** Reference positions, per reference key, aligned with the arrays above. */
  refs: Map<string, Array<{ x: number; y: number }>>;
  last: number;
  coupledUntil: number;
  verdict: DwellCouplingVerdict | null;
  /** The last verdict that actually found coupling, so a HELD refusal can say what it was held on. */
  lastCoupled: DwellCouplingVerdict | null;
  dirty: boolean;
}

/**
 * THE REFERENCE SIGNALS a pointer's travel is correlated against — what the exercise is doing.
 *
 * LEG MODE: the knee, the ankle and the foot on both sides, hip-relative, each named after the
 * prescribed lane whose feature is measured FROM it (seated_march and hip_abduction from the knee,
 * knee_extension from the ankle, ankle_dorsiflexion from the foot, through the same
 * `poseSideIndices` mirror convention the features use). The segments no lane names are kept too,
 * because a patient's hand can be carried by a segment the prescription does not measure — a hand on
 * the shin during ankle work, a hand on a thigh that flexes as a compensation for the lane that IS
 * prescribed — and the question is whether this limb is independent of the patient's LEG.
 *
 * HAND MODE: none, and that is not an oversight. There the prescribed hand IS the pointer and always
 * moves with the prescription; what makes a confirm deliberate there is geometric, along the one axis
 * the prescription cannot use (`dwellAxisFor`). Correlating the pointer with the exercise would refuse
 * every limb in the mode, which is not a safety property, it is the end of the feature.
 */
export function dwellReferences(
  result: DetectionResult | null | undefined,
  mode: Mode,
  opts: { lanes?: readonly LaneSpec[]; mirrored?: boolean; xScale?: number } = {},
): DwellReference[] {
  if (mode !== 'leg') return [];
  const pose = result?.pose;
  const origin = dwellOrigin(result);
  if (!pose || !origin) return [];
  const xScale = opts.xScale ?? 1;
  const mirrored = opts.mirrored ?? false;
  /**
   * WHICH SEGMENTS THE PRESCRIPTION MOVES, and what to call them. Every leg lane's feature is computed
   * from these three landmarks (seated_march and hip_abduction from the knee, knee_extension from the
   * ankle, ankle_dorsiflexion from the foot), so a prescribed lane names the segment it is measured
   * from and the verdict can say which movement the limb was following. The segments the prescription
   * does NOT name are kept as well, because a hand can be carried by a segment nobody prescribed — a
   * hand on the shin during ankle work, a thigh that flexes as a compensation for the lane that IS
   * prescribed — and the question here is whether this limb is independent of the patient's LEG, not
   * whether it is independent of the paperwork.
   */
  const named = new Map<string, string>();
  for (const lane of opts.lanes ?? []) {
    const idx = poseSideIndices(lane.side, mirrored);
    const landmark =
      lane.movement === 'knee_extension' ? idx.ankle : lane.movement === 'ankle_dorsiflexion' ? idx.foot : idx.knee;
    if (!named.has(String(landmark))) named.set(String(landmark), `lane:${lane.index}:${lane.movement}:${lane.side}`);
  }
  const out: DwellReference[] = [];
  const segments: Array<[string, number]> = [
    ['knee:left', POSE.LEFT_KNEE],
    ['knee:right', POSE.RIGHT_KNEE],
    ['ankle:left', POSE.LEFT_ANKLE],
    ['ankle:right', POSE.RIGHT_ANKLE],
    ['foot:left', POSE.LEFT_FOOT_INDEX],
    ['foot:right', POSE.RIGHT_FOOT_INDEX],
  ];
  for (const [name, idx] of segments) {
    const p = pose[idx];
    if (!visible(p)) continue;
    out.push({ key: named.get(String(idx)) ?? name, x: (p.x - origin.x) * xScale, y: p.y - origin.y });
  }
  return out;
}

/**
 * THE POINT THE WHOLE MEASUREMENT IS TAKEN FROM: the midpoint of the hips, or null when they are not
 * visible.
 *
 * Every reference signal is already hip-relative, and the POINTER has to be too. Otherwise anything
 * that moves the patient as a whole relative to the frame — sliding down in the chair, a nudged
 * tripod, a harness that aims a limb by translating the scene — moves the pointer while the
 * references stand still, and if that drift happens to run alongside a repetition the two correlate
 * and an innocent hand is refused. Found in the running app: a hand resting on a chair arm was
 * refused for thirty seconds on the latency screen (`hand:right follows knee1:x r2=1.00`), and the
 * whole of its apparent travel was the scene moving under it.
 *
 * Taking both sides from the hips makes the question the only one worth asking: does this limb move
 * WITH THE SEGMENT, in the patient's own frame of reference? A carried hand still answers yes — a hand
 * at fraction f along the thigh satisfies (wrist - hip) = f x (knee - hip) exactly — and a hand on
 * furniture answers no, however the camera and the chair are moving.
 */
export function dwellOrigin(result: DetectionResult | null | undefined): DwellPoint | null {
  const pose = result?.pose;
  if (!pose) return null;
  const hips = [pose[POSE.LEFT_HIP], pose[POSE.RIGHT_HIP]].filter(visible);
  if (hips.length === 0) return null;
  return { x: hips.reduce((a, h) => a + h.x, 0) / hips.length, y: hips.reduce((a, h) => a + h.y, 0) / hips.length };
}

/**
 * WHETHER EACH LIMB IS MOVING WITH THE PRESCRIBED EXERCISE — measured, limb by limb, frame by frame.
 *
 * Fed the same pointer the trackers are fed and the reference signals for the same frame. `verdict`
 * answers for one limb; a coupled limb is refused as a pointer (`pickDwellLimb`, `avoid`) and, when
 * there is no other limb to follow, stands the rings down (`DwellTracker.setCoupled`) so the screen
 * can say what is wrong and what to do about it instead of filling a ring the exercise is driving.
 *
 * It is pure and has no clock of its own: see the header note on the wall clock.
 */
export class DwellCoupling {
  private tracks = new Map<string, CouplingTrack>();
  private windowSec: number;
  private intervalSec: number;
  private forgetSec: number;
  private holdSec: number;
  private minR2: number;
  private minTravel: number;

  constructor(
    opts: {
      windowSec?: number;
      intervalSec?: number;
      forgetSec?: number;
      holdSec?: number;
      minR2?: number;
      minTravel?: number;
    } = {},
  ) {
    this.windowSec = opts.windowSec ?? DWELL_COUPLING_WINDOW_SEC;
    this.intervalSec = opts.intervalSec ?? DWELL_COUPLING_INTERVAL_SEC;
    this.forgetSec = opts.forgetSec ?? DWELL_COUPLING_FORGET_SEC;
    this.holdSec = opts.holdSec ?? DWELL_COUPLING_HOLD_SEC;
    this.minR2 = opts.minR2 ?? DWELL_COUPLING_MIN_R2;
    this.minTravel = opts.minTravel ?? DWELL_COUPLING_MIN_TRAVEL;
  }

  /**
   * Record one limb against this frame's references.
   *
   * The caller leaves out the frames in which the limb is ENGAGED with a target, for the same reason
   * the habitat does: the deliberate hold is the gesture, not evidence about it. What is left is the
   * patient sitting, resting and exercising, which is exactly the window this question is about.
   */
  noteOne(
    key: string,
    point: DwellPoint,
    refs: readonly DwellReference[],
    tSec: number,
    xScale = 1,
    /** The patient's own frame of reference (`dwellOrigin`). Null = take the pointer as it comes. */
    origin: DwellPoint | null = null,
  ): void {
    if (!key || !finitePoint(point) || !Number.isFinite(tSec)) return;
    let track = this.tracks.get(key);
    if (!track) {
      track = { ts: [], xs: [], ys: [], refs: new Map(), last: -Infinity, coupledUntil: -Infinity, verdict: null, lastCoupled: null, dirty: true };
      this.tracks.set(key, track);
    }
    track.last = tSec;
    const n = track.ts.length;
    if (n > 0 && tSec - track.ts[n - 1] < this.intervalSec) return;
    track.ts.push(tSec);
    // Hip-relative, like every reference signal: see `dwellOrigin`.
    const base = finitePoint(origin) ? origin : { x: 0, y: 0 };
    track.xs.push((point.x - base.x) * xScale);
    track.ys.push(point.y - base.y);
    // A reference that was not reported this frame is held at its last value rather than dropped, so
    // every series stays aligned with the pointer's; a NaN placeholder would poison the regression.
    for (const [refKey, series] of track.refs) {
      const found = refs.find((r) => r.key === refKey);
      const last = series.length > 0 ? series[series.length - 1] : { x: 0, y: 0 };
      series.push(found && Number.isFinite(found.x) && Number.isFinite(found.y) ? { x: found.x, y: found.y } : last);
    }
    for (const r of refs) {
      if (track.refs.has(r.key) || !Number.isFinite(r.x) || !Number.isFinite(r.y)) continue;
      // A reference seen for the first time starts here: back-filling it with a constant would invent
      // a stretch of "the exercise was not moving" that nobody observed.
      const series = new Array<{ x: number; y: number }>(track.ts.length - 1).fill({ x: r.x, y: r.y });
      series.push({ x: r.x, y: r.y });
      track.refs.set(r.key, series);
    }
    const cutoff = tSec - this.windowSec;
    let drop = 0;
    while (drop < track.ts.length && track.ts[drop] < cutoff) drop += 1;
    if (drop > 0) {
      track.ts.splice(0, drop);
      track.xs.splice(0, drop);
      track.ys.splice(0, drop);
      for (const series of track.refs.values()) series.splice(0, drop);
    }
    track.dirty = true;
  }

  /** Record every limb in a frame. */
  note(
    limbs: readonly DwellLimb[],
    refs: readonly DwellReference[],
    tSec: number,
    xScale = 1,
    origin: DwellPoint | null = null,
  ): void {
    for (const limb of limbs) this.noteOne(limb.key, limb.point, refs, tSec, xScale, origin);
  }

  /** Throw the record away (a new screen, a new camera, a new framing). */
  clear(): void {
    this.tracks.clear();
  }

  /** What the window says about one limb right now, or null when it has never been seen. */
  verdict(key: string, tSec: number): DwellCouplingVerdict | null {
    const track = this.tracks.get(key);
    if (!track) return null;
    if (Number.isFinite(track.last) && tSec - track.last > this.forgetSec) {
      this.tracks.delete(key);
      return null;
    }
    if (track.dirty || track.verdict === null) {
      track.verdict = this.measure(key, track);
      track.dirty = false;
      if (track.verdict.coupled) {
        track.coupledUntil = track.last + this.holdSec;
        track.lastCoupled = track.verdict;
      }
    }
    const held = tSec < track.coupledUntil;
    // A HELD refusal reports the evidence it was held on, not the window that has since gone quiet:
    // "r2=0.00, explained=0.000" over a refused limb is unreadable, and a screen (or a harness) that
    // has to explain a refusal needs the number that caused it.
    if (held && !track.verdict.coupled) return { ...(track.lastCoupled ?? track.verdict), coupled: true };
    return track.verdict;
  }

  /** Every limb currently refused. */
  coupledKeys(tSec: number): Set<string> {
    const out = new Set<string>();
    for (const key of [...this.tracks.keys()]) {
      if (this.verdict(key, tSec)?.coupled) out.add(key);
    }
    return out;
  }

  private measure(key: string, track: CouplingTrack): DwellCouplingVerdict {
    const n = track.ts.length;
    const span = n > 1 ? track.ts[n - 1] - track.ts[0] : 0;
    const settled = n >= DWELL_COUPLING_MIN_SAMPLES && span >= DWELL_COUPLING_MIN_SPAN_SEC;
    let best: { explained: number; r2: number; reference: string; fraction: number } | null = null;
    if (settled) {
      // Only consecutive samples close enough in time to be one motion contribute an increment; a gap
      // (a lost limb, a stalled camera) is a join between two motions nobody observed.
      const maxGap = this.intervalSec * 3;
      const pairs: number[] = [];
      for (let i = 1; i < n; i++) {
        if (track.ts[i] - track.ts[i - 1] <= maxGap) pairs.push(i);
      }
      if (pairs.length >= DWELL_COUPLING_MIN_SAMPLES - 1) {
        const travel = Math.hypot(
          Math.max(...track.xs) - Math.min(...track.xs),
          Math.max(...track.ys) - Math.min(...track.ys),
        );
        if (travel >= this.minTravel) {
          for (const [refKey, refSeries] of track.refs) {
            /**
             * ONE COEFFICIENT, BOTH AXES — the rigid-carry fit. `f` is how much of the segment's
             * movement this limb inherits: 1 at the knee, 0.7 mid-thigh, 0 on furniture. Fitting x and
             * y together is what makes it a statement about direction and not merely about
             * proportion, which is what keeps a drifting world-fixed hand out of it.
             */
            let sxx = 0;
            let sxy = 0;
            let syy = 0;
            let moving = 0;
            let biggest = 0;
            let total = 0;
            for (const i of pairs) {
              const drx = refSeries[i].x - refSeries[i - 1].x;
              const dry = refSeries[i].y - refSeries[i - 1].y;
              const dax = track.xs[i] - track.xs[i - 1];
              const day = track.ys[i] - track.ys[i - 1];
              sxx += drx * drx + dry * dry;
              sxy += dax * drx + day * dry;
              syy += dax * dax + day * day;
              const together = Math.abs(dax * drx + day * dry);
              if (together > 0) {
                moving += 1;
                total += together;
                if (together > biggest) biggest = together;
              }
            }
            if (!(sxx > 0) || !(syy > 0)) continue;
            // …and how many frames the fit rests on: one coincident jump correlates perfectly (see
            // DWELL_COUPLING_MIN_MOVING), and a limb being carried does not move in one jump.
            if (moving < DWELL_COUPLING_MIN_MOVING) continue;
            if (total > 0 && biggest / total > DWELL_COUPLING_MAX_PAIR_SHARE) continue;
            const fraction = sxy / sxx;
            // A CARRY IS FORWARD AND BOUNDED. A limb the thigh is holding moves the same way the thigh
            // does (f > 0) and by no more than the segment itself (a hand cannot be further out than
            // the knee by much); a limb moving the OTHER way is doing something of its own, and one
            // moving several times as far is not attached to this segment at all.
            if (fraction < DWELL_COUPLING_MIN_FRACTION || fraction > DWELL_COUPLING_MAX_FRACTION) continue;
            const r2 = (sxy * sxy) / (sxx * syy);
            const refTravel = Math.hypot(
              Math.max(...refSeries.map((r) => r.x)) - Math.min(...refSeries.map((r) => r.x)),
              Math.max(...refSeries.map((r) => r.y)) - Math.min(...refSeries.map((r) => r.y)),
            );
            // Never credit the exercise with more of the pointer's travel than the pointer HAS.
            const explained = Math.min(fraction * refTravel, travel);
            if (r2 < this.minR2 || explained < this.minTravel) continue;
            if (!best || explained > best.explained) best = { explained, r2, reference: refKey, fraction };
          }
        }
      }
    }
    return {
      key,
      coupled: best !== null,
      explained: best?.explained ?? 0,
      r2: best?.r2 ?? 0,
      fraction: best?.fraction ?? 0,
      reference: best?.reference ?? null,
      samples: n,
      settled,
    };
  }
}

/**
 * IS THIS LIMB ENGAGING WITH A TARGET, rather than living somewhere?
 *
 * In LEG mode the answer is worth acting on and it is why this exists. The pointer there is a HAND,
 * which the leg prescription does not move and which nothing else brings up and out to where the
 * targets are drawn: a hand inside one of those circles is a hand the patient has put there. Counting
 * those frames as "where this limb lives" would teach the record that the patient lives on the ring
 * they have just answered, and the next screen would move its ring out from under them.
 *
 * In HAND mode the same frames mean the opposite. The prescription anchors the forearm on the table,
 * so where the palm is says nothing about intent — a hand inside a circle is very often just a hand
 * that was framed there (the critic's second escape: a palm at 1.6x scale, framing a tenth of a frame
 * high, sitting 0.0967 from the primary centre at REST). Those frames are exactly the evidence the
 * gate needs, and hand mode counts them. `dwellAxisFor` is what decides which of the two a mode gets.
 */
export function dwellEngaged(
  point: DwellPoint,
  circles: readonly DwellCircle[],
  xScale = 1,
  exitRatio = DWELL_DEFAULTS.exitRatio,
): boolean {
  for (const c of circles) {
    if (dwellDistance(point, c, xScale) <= c.radius * exitRatio) return true;
  }
  return false;
}

/**
 * HOW LONG AFTER AN ANSWER A LIMB IN A TARGET IS STILL PART OF THAT ANSWER.
 *
 * A hold is 1.8 s and the tracker is inert for 1.5 s after it completes, during which the patient's
 * limb is usually still sitting on the ring they have just answered. This covers both with room to
 * spare, and nothing legitimate lasts longer: a gesture that has not completed by then has stopped
 * accumulating anyway.
 */
export const DWELL_GESTURE_SEC = 2.6;

/**
 * IS THIS LIMB ANSWERING, OR DOES IT LIVE HERE? — and the answer is not about WHERE it is.
 *
 * `dwellEngaged` says "this limb is in a target". Leg mode used to read that alone as "this limb was
 * raised here deliberately, so it is not evidence about where the limb lives", and drop the frame.
 * That premise holds only while the rings are too small to contain a resting hand, and they are not:
 * the ring had to grow to be visible at all (DwellTarget.tsx, the radius note). Driven through these
 * classes with the position-only rule, every sample of a hand resting inside the drawn circle was
 * discarded, the habitat concluded the hand lived somewhere else, the gate declared the ring clear —
 * and the hand parked in the ring filled it five times in thirty seconds. Bounding the exclusion by
 * TIME instead still left a window: the hand was excluded for the first 2.6 s of the screen, which is
 * long enough for it to leave once, come back, and confirm.
 *
 * So the exclusion is tied to the thing it exists to protect: AN ANSWER IN FLIGHT. The circularity
 * being avoided is "the reach toward a ring teaches the record that the limb lives on the ring, so the
 * requirement grows by exactly the gesture" — and that can only happen while a hold is accumulating,
 * or in the moment after one, when the limb is still on the target it has just answered. A limb
 * sitting in a ring that is accumulating NOTHING is not making a gesture, whatever else it is doing,
 * and the record must have it: that is the only way the gate can find out and move the ring off.
 */
export class DwellEngagement {
  private answeredAt = -Infinity;
  private graceSec: number;

  constructor(graceSec = DWELL_GESTURE_SEC) {
    this.graceSec = graceSec;
  }

  /**
   * Tell it an answer is in flight: called every frame on which any tracker is accumulating a hold or
   * is inert after one (the caller's `busy`).
   */
  noteAnswering(tSec: number): void {
    if (Number.isFinite(tSec)) this.answeredAt = tSec;
  }

  /**
   * True = this frame is part of an answer, and the habitat must not learn from it.
   *
   * WHICH FRAMES, AND WHY EACH CLAUSE. It took three wrong answers in the running app to get here.
   *
   *  1. INSIDE A DRAWN CIRCLE: never evidence about where a limb lives, because THE ENTRY GATE already
   *     owns that limb. A limb in there cannot start a hold until it has been seen outside the drawn
   *     circle and come back — a movement the patient makes on purpose — so there is nothing for the
   *     habitat to add, and everything for it to break. Two ways of trying to make it add something
   *     both failed in the app: recording those frames after a flat 2.6 s window slid the ring away
   *     from a patient who had just confirmed with that hand and was still holding it there (the
   *     latency screen, with every ring stood down and `placeable` false); and a per-limb budget did
   *     the same thing one confirm later on the pause dialog's second hold, where the same hand
   *     answers the same ring twice. A limb that genuinely lives in the circle is the residual this
   *     gesture cannot close, and it is stated where it is measured, not hidden here.
   *  2. IN THE HYSTERESIS BAND, WHILE AN ANSWER IS IN FLIGHT: the approach and the moment after a
   *     hold. Recording those is the circularity `DwellHabitat`'s header is about — the reach teaches
   *     the record that the limb lives on the ring, and the requirement grows by exactly the gesture.
   *  3. ANYWHERE ELSE — including the BAND when nobody is answering: evidence, always. That is the
   *     region the measured gate exists for (a hand resting just outside the drawn circle opens the
   *     entry gate by simply being there and can then hold without moving: the escape that shipped
   *     once), and the region where standing the ring down and moving it off costs the patient
   *     nothing.
   */
  gesture(
    _key: string,
    point: DwellPoint,
    circles: readonly DwellCircle[],
    tSec: number,
    xScale = 1,
    exitRatio = DWELL_DEFAULTS.exitRatio,
  ): boolean {
    // 1. Inside the ring the patient can see: the entry gate's business, not the habitat's.
    if (dwellEngaged(point, circles, xScale, 1)) return true;
    // 3. Outside the band altogether: evidence.
    if (!dwellEngaged(point, circles, xScale, exitRatio)) return false;
    // 2. In the band: only while an answer is in flight.
    return tSec - this.answeredAt <= this.graceSec;
  }

  clear(): void {
    this.answeredAt = -Infinity;
  }
}

export interface DwellClearanceOptions {
  xScale?: number;
  exitRatio?: number;
  /** Clear water demanded beyond the hysteresis band. */
  margin?: number;
  axis?: DwellAxis;
  /** Floor on a limb's lateral wander, in its own scale units (hand mode). */
  lateralFloorScales?: number;
}

/** How much room a target has, and how much it needs. */
export interface DwellClearance {
  /** The separation the target actually has, in frame heights, measured on the mode's axis. */
  actual: number;
  /** What it must have before a hold may accumulate. */
  required: number;
  clear: boolean;
  /** The limb this describes (null when there is nothing in view to clear). */
  key: string | null;
}

/** The room one target has from one limb's habitat. */
export function dwellClearance(
  circle: DwellCircle,
  summary: DwellHabitatSummary,
  opts: DwellClearanceOptions = {},
): DwellClearance {
  const xScale = opts.xScale ?? 1;
  const exitRatio = opts.exitRatio ?? DWELL_DEFAULTS.exitRatio;
  const margin = opts.margin ?? DWELL_CLEAR_MARGIN;
  const axis = opts.axis ?? 'radial';
  const floors = opts.lateralFloorScales ?? DWELL_LATERAL_FLOOR_PALMS;
  const band = circle.radius * exitRatio + margin;
  if (axis === 'lateral') {
    const wander = Math.max(summary.lateralSpread, (summary.scale ?? 0) * floors);
    const actual = Math.abs(summary.home.x - circle.x) * xScale;
    const required = band + wander;
    return { actual, required, clear: actual >= required, key: summary.key };
  }
  const actual = dwellDistance(summary.home, circle, xScale);
  const required = band + summary.spread;
  return { actual, required, clear: actual >= required, key: summary.key };
}

/**
 * The WORST room this target has, over every limb in view. `clear` false is the gate: a target in that
 * state may not accumulate a hold (`DwellTracker.setOccupied`), because a hold on it cannot be told
 * apart from a limb being where it lives.
 */
export function dwellTargetClear(
  circle: DwellCircle,
  summaries: readonly DwellHabitatSummary[],
  opts: DwellClearanceOptions = {},
): DwellClearance {
  let worst: DwellClearance | null = null;
  for (const summary of summaries) {
    const c = dwellClearance(circle, summary, opts);
    if (!worst || c.actual - c.required < worst.actual - worst.required) worst = c;
  }
  return worst ?? { actual: Infinity, required: 0, clear: true, key: null };
}

export interface DwellPlacementOptions extends DwellClearanceOptions {
  /** Clearance the placement AIMS for, beyond the minimum it must have. */
  extra?: number;
  /** Whether a candidate can be drawn whole on the screen (the renderer owns that maths). */
  fits?: (c: DwellCircle) => boolean;
  /** Circles already placed on this screen: a candidate may not overlap one, band included. */
  taken?: readonly DwellCircle[];
  /** Search step along the escape axis, in frame heights. */
  step?: number;
  /** Furthest the target may be moved from where the layout authored it, in frame heights. */
  reach?: number;
  /** Where a target may be put at all, beyond fitting on the screen (default `dwellPlaceable`). */
  within?: (c: DwellCircle) => boolean;
  /** How far a limb may be asked to travel to reach it (default `DWELL_LIMB_REACH`). */
  limbReach?: number;
}

export interface DwellPlacement {
  circle: DwellCircle;
  clearance: DwellClearance;
  /** False when nothing on the axis clears: the target must stand down and say so. */
  placeable: boolean;
  /** How far it had to be moved from the authored position, in frame heights. */
  moved: number;
}

/**
 * MOVE THE CIRCLE OFF THE PATIENT, rather than leaving it on them and refusing to work.
 *
 * A target that does not clear a limb's habitat is stood down, which is safe and useless. This is the
 * other half: slide it along the mode's escape axis — up and down for leg mode, across for hand mode,
 * the direction the confirm gesture is made in — to the nearest place that clears every limb in view
 * by `extra` more than the minimum, still fits on the screen, and does not overlap the other target.
 *
 * The search is deliberately one-dimensional and anchored on the authored position: a patient who has
 * learned "the left circle" finds it on the left at every step, at worst higher or further out than
 * last time. When nothing on the axis clears, `placeable` is false and the caller must say so — an
 * unreachable circle drawn as though it were holdable is the promise this app is not allowed to make.
 */
export function placeDwellCircle(
  authored: DwellCircle,
  summaries: readonly DwellHabitatSummary[],
  opts: DwellPlacementOptions = {},
): DwellPlacement {
  const xScale = opts.xScale ?? 1;
  const axis = opts.axis ?? 'radial';
  const extra = opts.extra ?? 0;
  const step = opts.step ?? 0.015;
  const reach = opts.reach ?? (axis === 'lateral' ? DWELL_MAX_REACH_LATERAL : DWELL_MAX_REACH);
  const fits = opts.fits ?? (() => true);
  const within = opts.within ?? dwellPlaceable;
  const taken = opts.taken ?? [];
  const exitRatio = opts.exitRatio ?? DWELL_DEFAULTS.exitRatio;
  const moveOn: 'x' | 'y' = axis === 'lateral' ? 'x' : 'y';

  /**
   * `d` is the move along the escape axis — the direction that buys CLEARANCE, and the direction the
   * confirm gesture is made in. `cross` is the other one, which buys nothing against the patient but
   * does buy room: it is how a circle gets out of the way of the other ring, or off the edge of the
   * screen, without giving back the separation it just earned. In lateral (hand) mode a cross move is
   * free by construction — the clearance is measured across the frame only — and in radial (leg) mode
   * it is measured like everything else.
   */
  const at = (d: number, cross: number): DwellCircle =>
    moveOn === 'x'
      ? { x: authored.x + d / xScale, y: authored.y + cross, radius: authored.radius }
      : { x: authored.x + cross / xScale, y: authored.y + d, radius: authored.radius };

  const offsets: number[] = [0];
  for (let d = step; d <= reach + 1e-9; d += step) offsets.push(d, -d);
  const crosses: number[] = [0];
  for (let c = step * 2; c <= reach / 2 + 1e-9; c += step * 2) crosses.push(c, -c);
  // NEAREST FIRST, and the escape axis wins a tie. The patient has to find the circle again: the
  // right answer is the smallest move that clears them, not the first one the loops happen to reach.
  const candidates: Array<{ d: number; cross: number; cost: number }> = [];
  for (const d of offsets) {
    for (const cross of crosses) {
      // `reach` bounds the MOVE, not each axis of it: a step along the escape axis and a step across
      // it both take the ring away from where the patient learned it.
      const moved = Math.hypot(d, cross);
      if (moved > reach + 1e-9) continue;
      candidates.push({ d, cross, cost: moved + (cross === 0 ? 0 : 1e-4) });
    }
  }
  candidates.sort((a, b) => a.cost - b.cost);

  let best: { circle: DwellCircle; clearance: DwellClearance; score: number; moved: number } | null = null;
  for (const { d, cross } of candidates) {
    const circle = at(d, cross);
    if (!fits(circle) || !within(circle)) continue;
    if (!dwellWithinLimbReach(circle, summaries, xScale, opts.limbReach)) continue;
    if (taken.some((other) => dwellTargetsOverlap(circle, other, exitRatio, xScale))) continue;
    const clearance = dwellTargetClear(circle, summaries, opts);
    const score = clearance.actual - clearance.required;
    const moved = Math.hypot(d, cross);
    if (score >= extra) return { circle, clearance, placeable: true, moved };
    if (!best || score > best.score || (score === best.score && moved < best.moved)) {
      best = { circle, clearance, score, moved };
    }
  }
  if (!best) {
    // Nothing within reach can even be drawn (a radius that does not fit the frame at all, or a band
    // with nowhere holdable in it). The authored position stands and says whether it is holdable —
    // a ring the patient cannot be asked to reach is not an improvement on one they cannot hold.
    const clearance = dwellTargetClear(authored, summaries, opts);
    return { circle: authored, clearance, placeable: clearance.clear, moved: 0 };
  }
  return { circle: best.circle, clearance: best.clearance, placeable: best.clearance.clear, moved: best.moved };
}

/* ---------------- the layout, kept honest frame by frame ---------------- */

export interface DwellLayoutTarget {
  id: string;
  /** Where the screen asked for it, in the AUTHORED 4:3 frame. */
  authored: DwellCircle;
  /** A ring that cannot be confirmed is drawn but never measured or moved. Default true. */
  enabled?: boolean;
}

export interface DwellLayoutOptions extends DwellPlacementOptions {
  /** How long a target must sit on a limb before the layout is moved off it. */
  crowdedGraceSec?: number;
  /** And how long it then stays put: a circle that jitters cannot be aimed at. */
  moveIntervalSec?: number;
}

export interface DwellSurvey {
  /** Per target id: true = a limb lives here, nothing may be counted (`DwellTracker.setOccupied`). */
  occupied: Map<string, boolean>;
  /**
   * Per target id: false = there is NOWHERE on the axis that clears this patient and still fits on the
   * screen beside the other ring. Such a target stays stood down, and the screen must say so rather
   * than leave a ring that looks holdable. True until a solve has had to find out.
   */
  placeable: Map<string, boolean>;
  /** True on the survey that MOVED the layout; the caller re-targets its trackers. */
  moved: boolean;
}

/** Default grace before a crowded layout is rearranged, and the quiet period after it is. */
export const DWELL_CROWDED_GRACE_SEC = 0.5;
export const DWELL_MOVE_INTERVAL_SEC = 1.5;

/**
 * WHERE THE RINGS ARE, AND WHETHER THEY MAY BE HELD — decided every frame against the measurement.
 *
 * The screens author a layout (`pairedDwellTargets`) that is right for most bodies in most framings.
 * This class is what happens when the body in front of the camera is not one of those: it asks the
 * habitat where the patient's limbs actually live, tells every target whether it is standing on one,
 * and slides the ones that are along the mode's escape axis until they are not.
 *
 * Two timings, and both exist for the patient rather than for the maths. The GRACE stops the rings
 * being rearranged because a hand passed underneath one — nothing is at risk while it waits, since a
 * crowded target is already accumulating nothing. The INTERVAL stops a circle jittering between two
 * almost-equal placements, which would be impossible to aim at. And a layout is never rearranged in
 * the middle of somebody's hold (`busy`): moving a target throws away the ring they are filling.
 *
 * It lives here, in the pure module, so the test can drive exactly what the app runs.
 */
export class DwellLayout {
  private targets: DwellLayoutTarget[];
  private opts: DwellLayoutOptions;
  private placed = new Map<string, DwellCircle>();
  private placeable = new Map<string, boolean>();
  private crowdedSince = NaN;
  private movedAt = -Infinity;

  constructor(targets: readonly DwellLayoutTarget[], opts: DwellLayoutOptions = {}) {
    this.targets = targets.map((t) => ({ ...t }));
    this.opts = { ...opts };
    this.reset();
  }

  /** Where the screen asked for this target, in the frame the camera is actually delivering. */
  private home(t: DwellLayoutTarget): DwellCircle {
    return retargetForPreview(t.authored, this.opts.xScale ?? 1);
  }

  /**
   * Back to the authored layout, re-expressed in the frame the camera is delivering — EXCEPT where the
   * authored spot cannot be drawn whole in that frame.
   *
   * A target is authored in the 4:3 preview box, which is the frame every camera this app opens either
   * delivers or is cropped to. A sensor TALLER than that loses the top and bottom to the crop, and a
   * ring near the edge of the authored frame then has its caption (or its own arc) off the glass. The
   * layout used to start there anyway and only ever re-place a circle that was standing on a limb, so
   * a ring that was undrawable on that camera stayed undrawable. Solving once here — against no
   * habitat, so it is purely "where can this be drawn" — is the difference between a screen that opens
   * with a ring the patient cannot see whole and one that opens with it nudged into the picture.
   */
  reset(): void {
    const fits = this.opts.fits;
    const placed = new Map<string, DwellCircle>();
    const taken: DwellCircle[] = [];
    for (const t of this.targets) {
      const home = this.home(t);
      const circle = !fits || fits(home) ? home : placeDwellCircle(home, [], { ...this.opts, taken }).circle;
      taken.push(circle);
      placed.set(t.id, circle);
    }
    this.placed = placed;
    this.placeable = new Map(this.targets.map((t) => [t.id, true]));
    this.crowdedSince = NaN;
    this.movedAt = -Infinity;
  }

  /** The camera said what shape its frames are. Returns true when that changed the layout. */
  setXScale(xScale: number): boolean {
    if (!Number.isFinite(xScale) || xScale <= 0 || xScale === this.opts.xScale) return false;
    this.opts = { ...this.opts, xScale };
    this.reset();
    return true;
  }

  get xScale(): number {
    return this.opts.xScale ?? 1;
  }

  circleFor(id: string): DwellCircle | undefined {
    return this.placed.get(id);
  }

  /** Every circle currently in force, in the order the screen offered them. */
  circles(): DwellCircle[] {
    return this.targets.map((t) => this.placed.get(t.id) as DwellCircle);
  }

  /**
   * Measure the layout against where the limbs live. Call it every frame (or every watchdog tick):
   * the answer for THIS instant is `occupied`, and `moved` says the circles have changed.
   */
  survey(summaries: readonly DwellHabitatSummary[], tSec: number, busy = false): DwellSurvey {
    const occupied = new Map<string, boolean>();
    let crowded = false;
    for (const t of this.targets) {
      if (t.enabled === false) continue;
      const circle = this.placed.get(t.id) as DwellCircle;
      const room = dwellTargetClear(circle, summaries, this.opts);
      occupied.set(t.id, !room.clear);
      if (!room.clear) crowded = true;
    }
    const grace = this.opts.crowdedGraceSec ?? DWELL_CROWDED_GRACE_SEC;
    const interval = this.opts.moveIntervalSec ?? DWELL_MOVE_INTERVAL_SEC;
    if (!crowded) {
      this.crowdedSince = NaN;
      /**
       * AND A CIRCLE THAT WAS MOVED HAS TO BE ABLE TO COME BACK.
       *
       * This class used to solve placements ONLY while a target was standing on a limb, so every move
       * was permanent for the life of the screen: a patient who happened to be resting a hand near a
       * ring pushed it away, put their hand back in their lap, and the ring stayed out at the edge of
       * the frame for the rest of the session — which is how the walk into the corner became a
       * one-way trip. The search is anchored on the authored position and ordered nearest-first, so
       * re-solving a displaced layout against a patient who has moved returns it home the moment home
       * is clear again.
       *
       * It only ever moves CLOSER to where the screen authored it (`toward`), so nothing wanders while
       * nothing is wrong, and it waits out the same quiet interval a move does so a ring never
       * jitters between two placements the patient is trying to aim at.
       */
      const displaced = this.targets.some((t) => {
        if (t.enabled === false) return false;
        const was = this.placed.get(t.id) as DwellCircle;
        const home = this.home(t);
        const fits = this.opts.fits;
        // A ring that is only away from home because home cannot be DRAWN on this camera is where it
        // belongs; nothing is gained by re-solving that every interval for the life of the screen.
        if (fits && !fits(home)) return false;
        return Math.abs(was.x - home.x) > 1e-6 || Math.abs(was.y - home.y) > 1e-6;
      });
      if (!displaced || busy || tSec - this.movedAt < interval) {
        return { occupied, placeable: new Map(this.placeable), moved: false };
      }
      return this.solve(summaries, tSec, occupied, true);
    }
    if (!Number.isFinite(this.crowdedSince)) this.crowdedSince = tSec;
    if (busy || tSec - this.crowdedSince < grace || tSec - this.movedAt < interval) {
      return { occupied, placeable: new Map(this.placeable), moved: false };
    }
    return this.solve(summaries, tSec, occupied, false);
  }

  /**
   * Re-place every target against the habitat. `toward` = this is a homecoming rather than an escape,
   * so the result is only adopted where it brings a circle CLOSER to the authored position.
   */
  private solve(
    summaries: readonly DwellHabitatSummary[],
    tSec: number,
    occupied: Map<string, boolean>,
    toward: boolean,
  ): DwellSurvey {
    const taken: DwellCircle[] = [];
    const next = new Map<string, DwellCircle>();
    const placeable = new Map<string, boolean>();
    let changed = false;
    // A CROWDED TARGET CHOOSES FIRST. The circles have to stay disjoint from each other (two trackers
    // fed one pointer is only sound while no point is inside both), so whichever is solved first gets
    // the room. Giving it to the one that is currently sitting on the patient is the difference
    // between moving the ring that has to move and wedging it against one that did not.
    const order = [...this.targets].sort((a, b) => Number(occupied.get(b.id) === true) - Number(occupied.get(a.id) === true));
    for (const t of order) {
      const authored = this.home(t);
      if (t.enabled === false) {
        // A disabled ring is measured against nothing and can confirm nothing; it keeps the authored
        // spot rather than wandering about the preview while it is doing nothing.
        next.set(t.id, authored);
        continue;
      }
      const was = this.placed.get(t.id) as DwellCircle;
      const placement = placeDwellCircle(authored, summaries, { ...this.opts, taken });
      const wasFrom = Math.hypot((was.x - authored.x) * this.xScale, was.y - authored.y);
      // A homecoming that would not actually bring this ring home is not worth moving a ring for.
      if (toward && placement.moved >= wasFrom - 1e-6) {
        taken.push(was);
        next.set(t.id, was);
        placeable.set(t.id, this.placeable.get(t.id) ?? true);
        continue;
      }
      taken.push(placement.circle);
      next.set(t.id, placement.circle);
      placeable.set(t.id, placement.placeable);
      if (Math.abs(was.x - placement.circle.x) > 1e-6 || Math.abs(was.y - placement.circle.y) > 1e-6) changed = true;
    }
    this.placeable = placeable;
    if (!changed) return { occupied, placeable: new Map(placeable), moved: false };
    this.placed = next;
    this.movedAt = tSec;
    this.crowdedSince = NaN;
    // The circles moved, so the verdicts taken against the old ones are stale: re-measure now rather
    // than leave a tracker standing down against a circle that is no longer where it was.
    const after = new Map<string, boolean>();
    for (const t of this.targets) {
      if (t.enabled === false) continue;
      after.set(t.id, !dwellTargetClear(this.placed.get(t.id) as DwellCircle, summaries, this.opts).clear);
    }
    return { occupied: after, placeable: new Map(placeable), moved: true };
  }
}
