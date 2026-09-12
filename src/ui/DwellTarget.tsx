/**
 * THE HANDS-FREE CONFIRM, on screen.
 *
 * A target is drawn over the camera preview; the patient parks a hand (hand mode) or a knee (leg
 * mode) inside it; a ring fills while they hold; it confirms when the ring is full. The maths is in
 * `src/vision/dwell.ts` and is decided frame by frame in a test — this file only renders it and wires
 * it to the vision module.
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
 *  - `reducedMotion`. The idle breathing of the ring is the only animation, and that setting removes
 *    it. The arc still fills — that is not decoration, it is the measurement.
 *
 * COORDINATES. Targets are given in the DETECTOR's normalized frame. The preview is always shown
 * CSS-mirrored (that is what a patient expects of a camera), so x is flipped here, exactly once, and
 * the caption is not mirrored with it. `radius` is in units of frame HEIGHT, and the containment test
 * uses `PREVIEW_ASPECT` as its `xScale`, so the circle the tracker tests is the circle on the glass.
 */
import { useEffect, useRef, useState } from 'react';
import type { Mode } from '../engine/types.ts';
import { runtime } from '../session/runtime.ts';
import { useStore } from '../state/store.ts';
import { DwellTracker, dwellLimbs, pickDwellLimb } from '../vision/dwell.ts';
import type { DwellCircle, DwellLimb, DwellPoint, DwellState } from '../vision/dwell.ts';
import type { VisionInput } from '../input/VisionInput.ts';

/**
 * Aspect ratio of the box the preview is drawn in (`.camera-frame` is 4/3, and the camera is asked
 * for 4:3 frames). It is the `xScale` every dwell distance is measured with, so what is tested and
 * what is drawn are the same circle.
 */
export const PREVIEW_ASPECT = 4 / 3;

/* ---------------- where the targets go ---------------- */

/**
 * WHERE A TARGET IS PLACED IS A CLINICAL CHOICE, not a layout one.
 *
 * It has to be somewhere the limb does not already live (or the patient would confirm by sitting
 * still) and somewhere the limb can actually get to (or a hemiparetic patient could not confirm at
 * all). In HAND mode the forearms are on the table and the hands sit low and central, so the targets
 * are up and out to the side — a short, deliberate lift. In LEG mode the patient is seated and the
 * knees are the pointer: a knee cannot be raised to the top of the frame by everyone who needs this,
 * so the targets sit at knee height and out to the side, which a small lift or an outward slide
 * reaches. `requireEntry` in the tracker covers what remains: a limb already parked on a target must
 * leave it and come back before anything is confirmed.
 */
const TARGET_Y: Readonly<Record<Mode, number>> = Object.freeze({ hand: 0.3, leg: 0.55 });
/** One target: dead centre horizontally, so either limb is the same distance from it. */
const SINGLE_X = 0.5;
/**
 * Two targets, far enough apart that no point is inside both, hysteresis bands included.
 *
 * Given in DETECTOR x, and deliberately right-then-left: the preview is mirrored, so a target at
 * detector x 0.73 is DRAWN on the left of the screen. The primary action is therefore the left-hand
 * circle, in the same order as the buttons above it and as the sentence beside it — which is the only
 * order that lets the legend say "the left circle" and be telling the truth.
 */
const PAIR_X: readonly [number, number] = [0.73, 0.27];
const SINGLE_R = 0.18;
const PAIR_R = 0.15;

export function singleDwellTarget(mode: Mode): DwellCircle {
  return { x: SINGLE_X, y: TARGET_Y[mode], radius: SINGLE_R };
}

/** `[primary, secondary]` — drawn with the forward action on the LEFT of the mirrored preview. */
export function pairedDwellTargets(mode: Mode): [DwellCircle, DwellCircle] {
  const y = TARGET_Y[mode];
  return [
    { x: PAIR_X[0], y, radius: PAIR_R },
    { x: PAIR_X[1], y, radius: PAIR_R },
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
  tone?: 'go' | 'back';
}

export interface DwellSession {
  /** Per choice id. Absent for a choice that is not enabled. */
  states: Record<string, DwellState>;
  /** The limb the targets are following right now, and what to call it. */
  limb: DwellLimb | null;
  /** Frames are arriving from the camera. False = there is nothing hands-free to offer. */
  live: boolean;
}

const IDLE: DwellSession = Object.freeze({ states: {}, limb: null, live: false });

/** No frame for this long and the watchdog starts feeding the trackers nothing (a wedged camera). */
const STALE_SEC = 0.2;
const WATCHDOG_MS = 80;

function nowSec(): number {
  return (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
}

function sameState(a: DwellState | undefined, b: DwellState): boolean {
  if (!a) return false;
  return (
    Math.round(a.progress * 200) === Math.round(b.progress * 200) &&
    a.inside === b.inside &&
    a.tracked === b.tracked &&
    a.holding === b.holding &&
    a.blocked === b.blocked &&
    a.confirmations === b.confirmations
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
    // Trackers only for what may actually be confirmed — but the camera is watched whenever a target
    // is DRAWN, enabled or not. Otherwise a screen whose gate has not opened yet would report "no
    // frames are arriving" over a preview that is plainly working, which is the opposite of honest.
    const trackers = new Map<string, DwellTracker>();
    for (const c of offered) {
      if (c.enabled !== false) trackers.set(c.id, new DwellTracker(c.target, { xScale: PREVIEW_ASPECT }));
    }
    const circles = offered.map((c) => c.target);

    let attached: VisionInput | null = null;
    let off: (() => void) | null = null;
    let lastFrame = -Infinity;
    let limb: DwellLimb | null = null;
    let previous: DwellPoint | null = null;
    let published: Record<string, DwellState> = {};
    let publishedLimb: string | null = null;
    let publishedLive = false;
    let cancelled = false;

    const feed = (point: DwellPoint | null, t: number) => {
      for (const [id, tracker] of trackers) {
        const state = tracker.update(point, t);
        if (!state.confirmed) continue;
        // A confirm is the patient choosing, so it is also the evidence that they are working alone:
        // the flag keeps the camera alive on the results screen, where the therapist's buttons would
        // otherwise be the only way off the last screen of the session.
        setHandsFree(true);
        latest.current.find((c) => c.id === id)?.onConfirm();
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
        lastFrame = t;
        limb = pickDwellLimb(dwellLimbs(result, mode, mirrored), circles, {
          xScale: PREVIEW_ASPECT,
          previous,
        });
        previous = limb?.point ?? null;
        feed(limb?.point ?? null, t);
      });
    };

    attach();
    const watchdog = setInterval(() => {
      attach();
      const t = nowSec();
      if (t - lastFrame > STALE_SEC) {
        limb = null;
        previous = null;
        feed(null, t);
      }
    }, WATCHDOG_MS);

    let raf = 0;
    const publish = () => {
      raf = requestAnimationFrame(publish);
      const live = nowSec() - lastFrame <= STALE_SEC;
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
      setSession({ states: next, limb, live });
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
 * One fixed viewBox for the ring AND its caption, so every part of the target scales with the
 * preview together. The ring is centred at (CX, CY) with radius R; the caption lives below it inside
 * the same box. The wrapper is sized so that 2·R of viewBox equals the target's diameter in frame
 * heights — see `wrapperStyle`.
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
  testId?: string;
}

/**
 * The ring itself. Renders absolutely INSIDE a `.camera-frame`, on top of the video and the landmark
 * overlay.
 */
export function DwellTarget({ choice, state, mirrored = true, reducedMotion = false, testId }: DwellTargetProps) {
  const enabled = choice.enabled !== false;
  const phase = phaseOf(state, enabled);
  const style = PHASE_STYLE[phase];
  const progress = enabled && state ? Math.max(0, Math.min(1, state.progress)) : 0;
  const { x, y, radius } = choice.target;

  // 2·R viewBox units must cover `2 · radius` of FRAME HEIGHT; the box is then as tall as the whole
  // viewBox, which is where the caption gets its room from.
  const heightPct = 2 * radius * (VB_H / (2 * R)) * 100;
  const caption = enabled ? choice.label : (choice.disabledNote ?? choice.label);
  /**
   * THE CAPTION GOES WHEREVER THERE IS FRAME LEFT.
   *
   * The preview clips its own bounds (it has to: it has rounded corners over a live video), and a
   * leg-mode target sits at knee height — 55 % down the frame — where two lines of type under a ring
   * this size fall off the bottom edge. Seen in the running app at 1024x768: the second line was cut
   * in half. So a target in the lower half of the frame wears its caption above it instead.
   */
  const below = y <= 0.5;
  const cy = below ? CY : VB_H - CY;
  const capY = below ? cy + R + 30 : cy - R - 46;
  const subY = below ? cy + R + 56 : cy - R - 20;

  return (
    <div
      className={`dwell-target${reducedMotion ? ' still' : ''}${enabled ? '' : ' off'}`}
      data-testid={testId}
      data-phase={phase}
      data-progress={progress.toFixed(3)}
      /* The target's centre in the SAME normalized video coordinates the landmarks arrive in, so a
         harness driving a synthetic patient can aim a limb at it without reverse-engineering the
         mirror flip out of the inline `left`. */
      data-dwell-x={x}
      data-dwell-y={y}
      data-dwell-radius={radius}
      style={{
        left: `${(mirrored ? 1 - x : x) * 100}%`,
        top: `${y * 100}%`,
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
        aria-label={`${caption}: ${describe(phase, state)}`}
      >
        {/* A dark disc and a dark halo so the ring reads over a bright window, a white wall or a
            patterned shirt — the three backgrounds a clinic actually provides. */}
        <circle cx={CX} cy={cy} r={R - 6} fill="rgba(5, 7, 13, 0.62)" />
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
  if (Object.keys(session.states).length === 0) {
    return (
      <div className="dwell-legend" data-testid={testId} data-state="waiting">
        <strong>Nothing to confirm yet.</strong>
        <span className="dim">The circle will fill in as soon as this step can be held through.</span>
      </div>
    );
  }
  const limb = session.limb;
  return (
    <div className="dwell-legend" data-testid={testId} data-state={limb ? 'tracking' : 'searching'}>
      <strong>
        Hold {what} — no need to touch the screen. Put {limb ? 'the limb below' : 'a hand or a knee'} inside the circle
        and keep it there while the ring fills.
      </strong>
      <span className={limb ? 'badge badge-ok' : 'badge badge-warn'} data-testid={`${testId}-limb`}>
        {limb ? `Following ${limb.label}` : 'No hand or knee in view'}
      </span>
      {limb && limb.side === null && (
        <span className="dim" data-testid={`${testId}-unidentified`}>
          Which hand this is cannot be told from the camera at the moment — it is followed as a pointer only, and nothing
          about it is recorded.
        </span>
      )}
      <span className="dim">Either side may do this, including the unaffected one. The buttons still work too.</span>
    </div>
  );
}
