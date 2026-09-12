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
 * The cost is stated rather than hidden: leg mode needs a HAND in the picture for the hands-free path,
 * and `POSTURE_INFO.seated_leg` only asks for hips, knees and feet. When no hand is in frame the
 * legend says so and the buttons remain. A confirm nobody made is worse than a confirm nobody can
 * make.
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
 *   - a hold may only accumulate while the target clears every limb's MEASURED habitat, so neither
 *     sitting still, nor relaxing back to rest, nor a limb that simply lives where the circle was
 *     drawn can fill a ring — whatever the framing, the patient's size or the frame aspect;
 *   - a rep cannot fill a target: driven as a REAL rep profile (a 4 s rise, 1.5 s at the top and a 3 s
 *     descent — a hemiparetic pace, slower than anything this app paces), every lane, both sides, with
 *     and without the documented compensations, against every live target;
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
import type { Mode, Side } from '../engine/types.ts';
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
    const blocked: DwellBlock | null = refractory
      ? 'refractory'
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
  if (targets.length === 0) return limbs[0];
  const xScale = opts.xScale ?? 1;
  const continuity = opts.continuityRadius ?? DWELL_CONTINUITY_RADIUS;
  const previous = finitePoint(opts.previous ?? null) ? (opts.previous as DwellPoint) : null;
  const previousKey = opts.previousKey ?? null;

  const scored = limbs.map((limb) => {
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
  const reach = opts.reach ?? 0.6;
  const fits = opts.fits ?? (() => true);
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
    for (const cross of crosses) candidates.push({ d, cross, cost: Math.hypot(d, cross) + (cross === 0 ? 0 : 1e-4) });
  }
  candidates.sort((a, b) => a.cost - b.cost);

  let best: { circle: DwellCircle; clearance: DwellClearance; score: number; moved: number } | null = null;
  for (const { d, cross } of candidates) {
    const circle = at(d, cross);
    if (!fits(circle)) continue;
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
    // Nothing on the axis can even be drawn (a radius that does not fit the frame at all).
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

  /** Back to the authored layout, re-expressed in the frame the camera is delivering. */
  reset(): void {
    this.placed = new Map(this.targets.map((t) => [t.id, retargetForAspect(t.authored, this.opts.xScale ?? 1)]));
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
    if (!crowded) {
      this.crowdedSince = NaN;
      return { occupied, placeable: new Map(this.placeable), moved: false };
    }
    if (!Number.isFinite(this.crowdedSince)) this.crowdedSince = tSec;
    const grace = this.opts.crowdedGraceSec ?? DWELL_CROWDED_GRACE_SEC;
    const interval = this.opts.moveIntervalSec ?? DWELL_MOVE_INTERVAL_SEC;
    if (busy || tSec - this.crowdedSince < grace || tSec - this.movedAt < interval) {
      return { occupied, placeable: new Map(this.placeable), moved: false };
    }

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
      const authored = retargetForAspect(t.authored, this.xScale);
      if (t.enabled === false) {
        // A disabled ring is measured against nothing and can confirm nothing; it keeps the authored
        // spot rather than wandering about the preview while it is doing nothing.
        next.set(t.id, authored);
        continue;
      }
      const placement = placeDwellCircle(authored, summaries, { ...this.opts, taken });
      taken.push(placement.circle);
      next.set(t.id, placement.circle);
      placeable.set(t.id, placement.placeable);
      const was = this.placed.get(t.id) as DwellCircle;
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
