/**
 * THE HANDS-FREE CONFIRM, on screen.
 *
 * A target is drawn over the camera preview; the patient parks a hand (hand mode) or a hand or a knee
 * (leg mode) inside it; a ring fills while they hold; it confirms when the ring is full. The maths is
 * in `src/vision/dwell.ts` and is decided frame by frame in a test — this file places the targets,
 * renders them, and wires them to the vision module.
 *
 * WHAT THE DRAWING HAS TO SURVIVE
 * -------------------------------
 *  - A CLINIC TABLET AT 2 m. Everything is one SVG on a fixed viewBox sized as a fraction of the
 *    camera frame, so the ring, the glyph and the caption all scale together with the preview instead
 *    of a 13 px label sitting under a 150 px ring. Text is painted with a dark stroke under the fill
 *    (`paint-order`), which is the only thing that keeps white type legible over a live video of an
 *    unknown room.
 *  - LOW VISION, AND COLOUR VISION THAT IS NOT THE DESIGNER'S. No state is signalled by hue alone.
 *    Each one has its own GLYPH (✕ nothing tracked, ◎ come in, ↻ move out and back, a COUNTDOWN while
 *    holding, ✓ confirmed) and its own ring pattern (dashed when nothing is tracked, solid when the
 *    limb is there, a filling arc while holding). The colours are the fourth cue, not the first.
 *  - TWO TARGETS THAT MEAN OPPOSITE THINGS, at 1/5 scale. "Next movement" and "Do it again" — or
 *    "Play again" and "New session" — used to render identically: same size, same white ring, same
 *    glyph, same caption size, distinguishable only by reading two words from two metres. The
 *    secondary action is now SMALLER (a smaller `radius`, which is a smaller circle to hold as well as
 *    a smaller ring to look at) and has a different SILHOUETTE (a square backing plate and a doubled
 *    ring, against the primary's disc and single ring). Shape and size first, words fourth.
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
import { DWELL_AUTHORED_ASPECT, DwellTracker, dwellLimbs, pickDwellLimb, retargetForAspect } from '../vision/dwell.ts';
import type { DwellCircle, DwellLimb, DwellPoint, DwellState } from '../vision/dwell.ts';
import type { VisionInput } from '../input/VisionInput.ts';

/**
 * Aspect ratio of the BOX the preview is drawn in (`.camera-frame` is 4/3), which is also the frame
 * the targets below are authored in. It is not an assumption about the camera — see the header.
 */
export const PREVIEW_ASPECT = DWELL_AUTHORED_ASPECT;

/* ---------------- where the targets go ---------------- */

/**
 * WHERE A TARGET IS PLACED IS A CLINICAL CHOICE, not a layout one — and the two halves of that choice
 * pull against each other:
 *
 *  1. NOWHERE A LIMB ALREADY IS. Not just the centre of the circle: the whole activation region, the
 *     hysteresis band included. The first version of this file failed exactly there — the ROM pair sat
 *     0.1804 frame-heights from a resting knee with an exit radius of 0.2175, so a patient who entered
 *     the target and then RELAXED THE KNEE BACK TO REST kept filling the ring and the session advanced
 *     itself. `DwellTarget.test.tsx` now measures every placement against the resting position of
 *     every limb `dwellLimbs` can return, in both modes, entry radius and exit band, at 1:1, 4:3 and
 *     16:9 — and the margins are asserted, not eyeballed.
 *  2. SOMEWHERE THE PATIENT CAN ACTUALLY HOLD FOR 1.8 s. The app prescribes the posture itself
 *     (features.ts, POSTURE_INFO): in HAND mode "rest your forearm on the table with your palm facing
 *     the camera", which puts the palm centre low and central — the previous target at y 0.3, x 0.5
 *     was 0.45 frame-heights away and straight up, i.e. an unsupported arm held in the upper third of
 *     the frame for nearly two seconds, at the camera check AND the latency check, by an affected limb
 *     late in a fatigued session. That is a therapy exercise, not a click. The targets are now OUT TO
 *     THE SIDE and only modestly up: a slide along the table with the elbow still on it.
 *     In LEG mode the patient is seated and their HANDS ARE FREE (they are exercising their legs), so
 *     the targets sit up and out where a raised hand reaches easily — `dwellLimbs` follows either a
 *     hand or a knee in leg mode, whichever is nearest — and well clear of both resting knees.
 */
const TARGET_Y: Readonly<Record<Mode, number>> = Object.freeze({ hand: 0.37, leg: 0.32 });
/**
 * The forward action always sits in the SAME place — detector x 0.72, which the mirrored preview draws
 * on the LEFT of the screen — whether it is the only target on the screen or the left half of a pair.
 * A patient who has learned "hold on the left circle" at the camera check finds the same circle in the
 * same place at every step after it, and the legend beside it can say "the left circle" and be telling
 * the truth.
 */
const PRIMARY_X = 0.72;
/** The secondary action, far enough away that no point is inside both, hysteresis bands included. */
const SECONDARY_X = 0.28;
/** Radius in frame HEIGHTS. The secondary is visibly smaller — see the silhouette note in the header. */
const PRIMARY_R = 0.115;
const SECONDARY_R = 0.09;

export function singleDwellTarget(mode: Mode): DwellCircle {
  return { x: PRIMARY_X, y: TARGET_Y[mode], radius: PRIMARY_R };
}

/** `[primary, secondary]` — drawn with the forward action on the LEFT of the mirrored preview. */
export function pairedDwellTargets(mode: Mode): [DwellCircle, DwellCircle] {
  const y = TARGET_Y[mode];
  return [
    { x: PRIMARY_X, y, radius: PRIMARY_R },
    { x: SECONDARY_X, y, radius: SECONDARY_R },
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
  return choice.tone ?? (choice.target.radius < PRIMARY_R ? 'back' : 'go');
}

export interface DwellSession {
  /** Per choice id. Absent for a choice that is not enabled. */
  states: Record<string, DwellState>;
  /** The limb the targets are following right now, and what to call it. */
  limb: DwellLimb | null;
  /** Frames are arriving from the camera. False = there is nothing hands-free to offer. */
  live: boolean;
  /** The frame aspect (width/height) the camera is actually delivering, as the trackers measured in. */
  xScale: number;
  /** Seconds between frames, as observed. 0 before enough frames have arrived to say. */
  frameIntervalSec: number;
}

const IDLE: DwellSession = Object.freeze({ states: {}, limb: null, live: false, xScale: PREVIEW_ASPECT, frameIntervalSec: 0 });

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
 * The frame aspect the camera is really delivering.
 *
 * `VisionInput.getXScale()` is the value the movement features are already corrected by — the one the
 * camera session measured from `videoWidth/videoHeight` — so reading it here is what makes "the circle
 * tested is the circle drawn" true on a sensor that is not 4:3. When there is no camera (or it has not
 * reported a size yet) the authored 4:3 is used, which is also what the layout falls back to.
 */
function liveXScale(): number {
  const vision = runtime.peekVision();
  // Defensively: a replay or a stubbed input source need not implement it, and a target that cannot
  // find out what shape the frames are falls back to the frame it was authored in rather than failing.
  const s = typeof vision?.getXScale === 'function' ? vision.getXScale() : undefined;
  return typeof s === 'number' && Number.isFinite(s) && s > 0 ? s : PREVIEW_ASPECT;
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
    // Trackers only for what may actually be confirmed — but the camera is watched whenever a target
    // is DRAWN, enabled or not. Otherwise a screen whose gate has not opened yet would report "no
    // frames are arriving" over a preview that is plainly working, which is the opposite of honest.
    const trackers = new Map<string, DwellTracker>();
    for (const c of offered) {
      if (c.enabled !== false) trackers.set(c.id, new DwellTracker(retargetForAspect(c.target, xScale), { xScale }));
    }
    let circles = offered.map((c) => retargetForAspect(c.target, xScale));

    let attached: VisionInput | null = null;
    let off: (() => void) | null = null;
    let lastFrame = -Infinity;
    let limb: DwellLimb | null = null;
    let previous: DwellPoint | null = null;
    let previousKey: string | null = null;
    let published: Record<string, DwellState> = {};
    let publishedLimb: string | null = null;
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

    /** The camera finally said what shape its frames are (or changed it mid-stream). */
    const syncAspect = () => {
      const next = liveXScale();
      if (next === xScale) return;
      xScale = next;
      circles = offered.map((c) => retargetForAspect(c.target, xScale));
      for (const [id, tracker] of trackers) {
        const c = offered.find((o) => o.id === id);
        if (c) tracker.setTarget(retargetForAspect(c.target, xScale), xScale);
      }
    };

    const attach = () => {
      const vision = runtime.peekVision();
      if (vision === attached) return;
      off?.();
      off = null;
      attached = vision;
      if (!vision) return;
      off = vision.onFrame((_samples, _ctxTime, result) => {
        if (cancelled) return;
        const t = nowSec();
        noteFrame(t);
        limb = pickDwellLimb(dwellLimbs(result, mode, mirrored), circles, {
          xScale,
          previous,
          previousKey,
        });
        previous = limb?.point ?? null;
        previousKey = limb?.key ?? null;
        feed(limb?.point ?? null, t, limb?.key ?? null);
      });
    };

    attach();
    const watchdog = setInterval(() => {
      attach();
      syncAspect();
      const t = nowSec();
      if (t - lastFrame > staleSec) {
        limb = null;
        previous = null;
        previousKey = null;
        feed(null, t, null);
      }
    }, WATCHDOG_MS);

    let raf = 0;
    const publish = () => {
      raf = requestAnimationFrame(publish);
      const live = nowSec() - lastFrame <= staleSec;
      const limbLabel = limb?.label ?? null;
      let changed = live !== publishedLive || limbLabel !== publishedLimb;
      const next: Record<string, DwellState> = {};
      for (const [id, tracker] of trackers) {
        next[id] = tracker.state;
        if (!sameState(published[id], tracker.state)) changed = true;
      }
      if (!changed) return;
      published = next;
      publishedLimb = limbLabel;
      publishedLive = live;
      setSession({ states: next, limb, live, xScale, frameIntervalSec: interval });
    };
    raf = requestAnimationFrame(publish);

    return () => {
      cancelled = true;
      clearInterval(watchdog);
      cancelAnimationFrame(raf);
      off?.();
    };
  }, [shape, mode, mirrored, setHandsFree]);

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

type Phase = 'lost' | 'enter' | 'reenter' | 'holding' | 'done' | 'off';

function phaseOf(state: DwellState | undefined, enabled: boolean): Phase {
  if (!enabled) return 'off';
  // Enabled but nothing observed yet (the first frames have not arrived, or the camera is gone): that
  // is "I cannot see you", not "this is unavailable". The two have different remedies and the patient
  // is the one who has to tell them apart.
  if (!state) return 'lost';
  if (state.blocked === 'refractory') return 'done';
  if (!state.tracked) return 'lost';
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
  const circle = state?.target ?? retargetForAspect(choice.target, fallbackScale);
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
            rx={14}
            fill="rgba(5, 7, 13, 0.72)"
            stroke={style.colour}
            strokeOpacity={0.5}
            strokeWidth={3}
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
        <text
          className="dwell-glyph"
          x={CX}
          y={cy}
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
export function DwellLegend({
  session,
  what,
  testId = 'dwell-legend',
}: {
  session: DwellSession;
  /** What the hold achieves, in one clause: "to go on to the range check". */
  what: string;
  testId?: string;
}) {
  const mode = useStore((s) => s.mode);
  if (!session.live) {
    return (
      <div className="dwell-legend" data-testid={testId} data-state="offline">
        <strong>Hands-free is not available right now.</strong>
        <span className="dim">
          No camera frames are arriving, so nothing can be held. Use the buttons, or restart the camera.
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
  // Anything that can be held is waiting for the limb to leave the ring first — say what the rings say.
  const mustLeave = states.every((s) => s.blocked === 'entry' && s.tracked);
  const anything = mode === 'leg' ? 'a hand or a knee' : 'a hand';
  const fps = session.frameIntervalSec > 0 ? 1 / session.frameIntervalSec : 0;
  return (
    <div className="dwell-legend" data-testid={testId} data-state={mustLeave ? 'reenter' : limb ? 'tracking' : 'searching'}>
      <strong>
        {mustLeave ? (
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
        {limb ? `Following ${limb.label}` : mode === 'leg' ? 'No hand or knee in view' : 'No hand in view'}
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
      <span className="dim">
        Either side may do this, including the unaffected one
        {mode === 'leg' ? ', and a hand counts as well as a knee' : ''}. The buttons still work too.
      </span>
    </div>
  );
}
