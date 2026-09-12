/**
 * DWELL: how a patient who cannot touch the tablet says "yes".
 *
 * The product decision is a HOLD, not an auto-advance and not the exercise movement itself: a target
 * appears on the camera preview, the patient parks a hand (hand mode) or a hand or a knee (leg mode)
 * inside it, a ring fills while they hold, and it confirms when the ring is full. Auto-advance would
 * take the choice away from the patient; dwelling on the prescribed movement would fire by accident on
 * every rep.
 *
 * WHAT THIS GESTURE IS ALLOWED TO CLAIM. Not "impossible by accident" — that sentence used to be here
 * and it was not earned: with the targets placed where they were, a knee RELAXING BACK TO REST landed
 * inside the hysteresis band, the ring kept filling over a limb that was doing nothing, and the app
 * advanced the session by itself. A confirm caused by a limb returning to rest is the worst class of
 * false activation, because the patient did nothing at all. What is claimed now is what is proved,
 * case by case, in dwell.test.ts and DwellTarget.test.tsx:
 *   - the activation region (the drawn circle AND its hysteresis band) is disjoint from where every
 *     limb `dwellLimbs` can report RESTS, in both modes, at every frame aspect the app opens a camera
 *     at — so sitting still cannot fill a ring, and relaxing out of one cannot finish it;
 *   - a rep passing through the target cannot fill it (the hold is longer than any rep this app paces);
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
 * PASS THE REAL ASPECT of the frames the landmarks came from (`VisionInput.getXScale()`): 640x480 is
 * only an `ideal` constraint and most laptop sensors hand back 16:9 whatever was asked for.
 */
import type { Mode, Side } from '../engine/types.ts';
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
    const blocked: DwellBlock | null = refractory ? 'refractory' : requireEntry && !this.seenOutside ? 'entry' : null;
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
 * `poseSideIndices` (features.ts) is the canonical mapping and the knee goes through it below; it does
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
 * HAND mode: the palm centre of each detected hand. The palm rather than a fingertip because the
 * prescribed hand movements (open/close, opposition, spread) move the fingertips by design — a
 * fingertip pointer would drift across the target while the patient does nothing but their exercise.
 *
 * LEG mode: each knee AND each hand that Pose reports, mapped through the mirror convention so the
 * side named on screen is the patient's side, not the image's. The HANDS ARE FREE IN LEG MODE — the
 * patient is exercising their legs — and raising a hand is a gesture an affected, fatigued patient can
 * still make when holding a knee up for two seconds is itself a therapy exercise. The knee stays,
 * because a patient may be framed knees-up with no hand in the picture; whichever is nearest the
 * target is the one followed, and the legend says which.
 */
export function dwellLimbs(result: DetectionResult | null | undefined, mode: Mode, mirrored = false): DwellLimb[] {
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
      });
    }
    return out;
  }
  const pose = result.pose;
  if (!pose) return out;
  for (const side of ['left', 'right'] as Side[]) {
    const knee = pose[poseSideIndices(side, mirrored).knee];
    if (visible(knee) && inFrame(knee)) out.push({ point: { x: knee.x, y: knee.y }, side, label: `your ${side} knee`, key: `knee:${side}` });
  }
  for (const side of ['left', 'right'] as Side[]) {
    const wrist = pose[poseWrist(side, mirrored)];
    if (visible(wrist) && inFrame(wrist)) out.push({ point: { x: wrist.x, y: wrist.y }, side, label: `your ${side} hand`, key: `hand:${side}` });
  }
  return out;
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
