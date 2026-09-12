/**
 * DWELL: how a patient who cannot touch the tablet says "yes".
 *
 * The product decision is a HOLD, not an auto-advance and not the exercise movement itself: a target
 * appears on the camera preview, the patient parks a hand (hand mode) or a knee (leg mode) inside it,
 * a ring fills while they hold, and it confirms when the ring is full. Auto-advance would take the
 * choice away from the patient; dwelling on the prescribed movement would fire by accident on every
 * rep. A deliberate park somewhere the limb does not otherwise go is the one gesture that is both
 * possible for a hemiparetic patient and impossible to make by accident.
 *
 * THIS FILE IS PURE. No DOM, no React, no timers — it is fed a pointer in normalized video
 * coordinates and a wall-clock time, and it answers with a state a UI can render honestly. Everything
 * here is decided frame by frame in a test (dwell.test.ts).
 *
 * The four properties that make it clinical rather than a mouse-over:
 *
 *  1. TREMOR TOLERANCE. The pointer is averaged over a short window (`smoothingSec`) BEFORE
 *     containment is tested. A resting tremor of a few centimetres at 6 Hz moves the raw landmark in
 *     and out of any circle small enough to be reachable; the mean of the last quarter second does
 *     not. Smoothing the pointer is not the same as smoothing the PROGRESS — progress must still
 *     react immediately when the limb genuinely leaves, or the ring would keep filling over a hand
 *     that has gone.
 *  2. HYSTERESIS. Leaving takes a bigger circle than entering (`exitRatio`). Without it, a hand
 *     parked exactly on the boundary — which is where a patient with poor proprioception parks it —
 *     flickers in and out and the hold never completes.
 *  3. FORGIVENESS. A lost landmark does not reset the hold. Progress DECAYS, and decays more slowly
 *     than it fills (`decayRatio` < 1), so a patient whose hand flickers in and out of detection —
 *     the normal case on a clinic webcam at 12 fps — still gets there. Resetting to zero on a dropped
 *     frame is the behaviour that makes a hands-free path unusable for exactly the patients it is for.
 *  4. IT CANNOT CONFIRM TWICE. After a confirm the tracker is inert for `refractorySec` AND will not
 *     start a new hold until it has seen the limb leave the target (the same gate that stops a limb
 *     which happens to be resting inside the target when the screen opens from confirming
 *     immediately — see `requireEntry`). One hold answers one question.
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
 * HEIGHT and the containment region is the circle the patient can actually see drawn.
 */
import type { Mode, Side } from '../engine/types.ts';
import { poseSideIndices } from './features.ts';
import { HAND, MIN_VISIBILITY } from './landmarks.ts';
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
   * 1.45. The exit circle is roughly twice the area of the entry circle: a wobble of half a radius
   * does not end the hold, a genuine withdrawal does.
   */
  exitRatio: 1.45,
  /** 0.25 s — six frames at 24 fps. Averages out tremor without making the ring lag the limb visibly. */
  smoothingSec: 0.25,
  /** 0.4 s. Below this the UI keeps saying "tracked": one or two dropped detections is not a lost limb. */
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
}

const EMPTY_STATE: DwellState = Object.freeze({
  progress: 0,
  inside: false,
  tracked: false,
  holding: false,
  confirmed: false,
  confirmations: 0,
  blocked: 'entry' as DwellBlock | null,
  pointer: null,
  lostSec: Infinity,
  remainingSec: DWELL_DEFAULTS.holdSec,
});

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
  /** The entry gate: has the limb been seen outside the target since this hold was armed? */
  private seenOutside = false;
  private blockedUntil = -Infinity;
  private count = 0;
  private current: DwellState = EMPTY_STATE;

  constructor(target: DwellCircle, opts: DwellOptions = {}) {
    this.target = target;
    this.opts = { ...DWELL_DEFAULTS, ...opts };
    this.current = { ...EMPTY_STATE, remainingSec: this.opts.holdSec, blocked: this.opts.requireEntry ? 'entry' : null };
  }

  /** The last state produced. Frozen; a renderer may hold it between updates. */
  get state(): DwellState {
    return this.current;
  }

  get circle(): DwellCircle {
    return this.target;
  }

  /** Move the target (a screen that changes what it is asking). Clears the hold in progress. */
  setTarget(target: DwellCircle): void {
    if (target.x === this.target.x && target.y === this.target.y && target.radius === this.target.radius) return;
    this.target = target;
    this.reset();
  }

  /** Forget everything: no hold, no pointer history, entry gate re-armed. */
  reset(): void {
    this.samples = [];
    this.lastT = NaN;
    this.lastSeen = -Infinity;
    this.progress = 0;
    this.insideFlag = false;
    this.seenOutside = false;
    this.blockedUntil = -Infinity;
    this.current = {
      ...EMPTY_STATE,
      confirmations: this.count,
      remainingSec: this.opts.holdSec,
      blocked: this.opts.requireEntry ? 'entry' : null,
    };
  }

  /**
   * Advance to `tSec` with the pointer observed at that instant (null = the limb was not found).
   *
   * CALL IT ONCE PER OBSERVATION, not once per repaint: `null` means "this observation found no
   * limb", and re-feeding a pointer that arrived two repaints ago would count a hold nobody saw.
   * A caller drives this from the vision module's per-frame callback, plus a watchdog that feeds
   * `null` when frames stop arriving at all — otherwise a wedged camera freezes a half-filled ring.
   *
   * Returns the new state. `confirmed` is an EDGE: it is true on this one call and false on the next,
   * so a caller may act on it directly without tracking its own previous value.
   */
  update(pointer: DwellPoint | null, tSec: number): DwellState {
    const { holdSec, exitRatio, smoothingSec, graceSec, decayRatio, refractorySec, maxStepSec, xScale, requireEntry } =
      this.opts;

    const t = Number.isFinite(tSec) ? tSec : this.lastT;
    // A non-monotonic or absent clock advances nothing rather than stepping backwards through a hold.
    const dt = Number.isFinite(this.lastT) ? Math.min(Math.max(t - this.lastT, 0), maxStepSec) : 0;
    this.lastT = t;

    if (finitePoint(pointer)) {
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
    } else {
      const d = dwellDistance(smoothed, this.target, xScale);
      // Hysteresis: getting in needs the entry radius, getting out needs the bigger exit radius.
      this.insideFlag = this.insideFlag ? d <= this.target.radius * exitRatio : d <= this.target.radius;
      // The entry gate only opens on a limb genuinely observed OUTSIDE — never on a limb that merely
      // stopped being detected, which is the state a patient cannot tell apart from "it is working".
      if (!this.insideFlag) this.seenOutside = true;
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
      if (this.progress >= 1) {
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
      tracked,
      holding,
      confirmed,
      confirmations: this.count,
      blocked: confirmed ? 'refractory' : blocked,
      pointer: smoothed,
      lostSec,
      remainingSec: (1 - this.progress) * holdSec,
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
}

/** Below this handedness score the MediaPipe label does not identify the hand (see mediapipe.ts). */
export const DWELL_MIN_LABEL_SCORE = 0.6;

/** Hand landmarks whose mean is the palm centre — steady while the fingers open, close and oppose. */
const PALM = [HAND.WRIST, HAND.INDEX_MCP, HAND.MIDDLE_MCP, HAND.RING_MCP, HAND.PINKY_MCP] as const;

function visible(l: Landmark | undefined): l is Landmark {
  return !!l && Number.isFinite(l.x) && Number.isFinite(l.y) && (l.visibility === undefined || l.visibility >= MIN_VISIBILITY);
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
 * Every limb in this frame that could park itself on a target.
 *
 * HAND mode: the palm centre of each detected hand. The palm rather than a fingertip because the
 * prescribed hand movements (open/close, opposition, spread) move the fingertips by design — a
 * fingertip pointer would drift across the target while the patient does nothing but their exercise.
 * LEG mode: each knee that Pose reports as visible, mapped through `poseSideIndices` so the side named
 * on screen is the patient's side under the mirror convention in force, not the image's.
 */
export function dwellLimbs(result: DetectionResult | null | undefined, mode: Mode, mirrored = false): DwellLimb[] {
  if (!result) return [];
  const out: DwellLimb[] = [];
  if (mode === 'hand') {
    for (const hand of result.hands) {
      const point = centre(PALM.map((i) => hand.landmarks[i]));
      if (!point) continue;
      // An unconfident label is reported as unknown rather than guessed: the caption is read by the
      // patient and "your left hand" pointing at their right one is a small lie in the same family as
      // every other one this app refuses to tell.
      const side = hand.score >= DWELL_MIN_LABEL_SCORE ? labelToPatientSide(hand.label, mirrored) : null;
      out.push({ point, side, label: side ? `your ${side} hand` : 'a hand' });
    }
    return out;
  }
  const pose = result.pose;
  if (!pose) return out;
  for (const side of ['left', 'right'] as Side[]) {
    const knee = pose[poseSideIndices(side, mirrored).knee];
    if (!visible(knee)) continue;
    out.push({ point: { x: knee.x, y: knee.y }, side, label: `your ${side} knee` });
  }
  return out;
}

export interface PickDwellLimbOptions {
  /** Where the limb picked last frame was, so the choice does not flicker between two candidates. */
  previous?: DwellPoint | null;
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
  // Stickiness first, and only among the limbs that are in the running: the limb we were following
  // keeps the caption while it is still the kind of candidate that would win anyway.
  const carried = pool.filter((s) => s.carried <= continuity).sort((a, b) => a.carried - b.carried);
  if (carried.length > 0) return carried[0].limb;
  return pool.slice().sort((a, b) => a.nearest - b.nearest)[0].limb;
}
