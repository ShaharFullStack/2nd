import { useCallback, useEffect, useRef, useState } from 'react';
import type { SongManifest } from '../audio/manifest.ts';
import { DIFFICULTIES, windowsForLanes } from '../engine/difficulty.ts';
import { AutoplayInput } from '../input/AutoplayInput.ts';
import { KeyboardInput } from '../input/KeyboardInput.ts';
import type { InputSource, LaneState, VisionStatus } from '../input/types.ts';
import type { InvalidCalibration } from '../input/VisionInput.ts';
import { GameRunner } from '../session/GameRunner.ts';
import type { HudSnapshot } from '../session/GameRunner.ts';
import { SILENT_GRID, buildSessionChart, songGridOf } from '../session/chart.ts';
import { buildSessionResult } from '../session/results.ts';
import { runtime } from '../session/runtime.ts';
import { useStore } from '../state/store.ts';
import {
  DEFAULT_REARM_FRACTION,
  ReceptorHistory,
  emptyReceptorLook,
  receptorGoalHolding,
  receptorMarkSet,
  type ReceptorLook,
} from '../render/receptor.ts';
import type { OverlayPanelBox } from '../render/geometry.ts';
import { getPalette, laneColor, laneLabel, withAlpha } from '../render/palette.ts';
import type { LaneSpec } from '../engine/types.ts';
import CameraFallback from './CameraFallback.tsx';
import { CameraPreview } from './CameraPreview.tsx';
import { Meter, Toast, laneName } from './common.tsx';

/**
 * The credit line drawn in the corner of the play screen.
 *
 * NOT `attributionText()`: that is the full licence sentence (a paragraph — "…is an original demo
 * track synthesized in-repo by scripts/gen-demo-stems.mjs…"), which has to be ellipsized to fit a
 * corner block and then reads as a truncated dev string sitting on live gameplay. The full text is
 * still shown in full where the licence asks for it — song select and the results screen. What a
 * clinic screen needs mid-song is who made it and under what licence.
 */
function playCredit(m: SongManifest): string {
  return `${m.artist} · ${m.license}`;
}

/**
 * The picture-in-picture lane meters' marks, in CSS — the same four mark sets the receptor row
 * draws (`receptorMarkSet`), told apart by the NUMBER and SHAPE of their marks rather than by
 * brightness, because a 14 px bar read at 2 m has no brightness to spare:
 *   rising → the lane column against the white TARGET LINE (the receptor's dashed target line and
 *            gate posts, in miniature);
 *   goal   → a white ring around the whole bar, plus — while the rep is still in hand — a white cap
 *            ON the column (the receptor's corona and its split white-hot level cap, in miniature);
 *   locked → a grey column with a violet cap, and the target line replaced by the violet RE-ARM LINE
 *            the patient has to bring it down to (the receptor's drain cap and dashed re-arm line);
 *   lost   → no column, no reference line, and a dashed grey outline (the receptor's broken ring).
 *
 * THE REFERENCE LINES ARE WHAT MAKE THE COLUMN A READOUT. Requirement (a) of the receptor contract is
 * that the rising state answer "how much further", which a bare `height: rom%` column cannot do: it
 * is a quantity with no scale printed next to it. The receptor answers it with a dashed target line
 * and two gate posts; this meter — the one that sits beside the camera preview for the WHOLE session
 * — had no reference mark of any kind, and its legend named goal, locked and lost but never the
 * rising state or where the target was. The lines are drawn on the same linear ROM axis the receptor
 * uses (`Highway.meterPos`): full ROM at the top of the bar, the target at `thresholdFraction` of it,
 * the re-arm line at `thresholdFraction * rearmFraction`. Each is cased in near-black so it survives
 * being crossed by the column at any height, in any palette, in pure luminance.
 *
 * THE RING AND THE CAP EXPIRE AT DIFFERENT MOMENTS, exactly as they do on the receptor row, and for
 * the same reason (`receptorGoalHolding`). The ring says "that rep reached your target" — a fact
 * about a rep that happened, true for the whole latch. The cap is a mark ON the column, i.e. a claim
 * about where the patient is NOW, and the column is a live position gauge: once the lane re-arms the
 * patient is back at rest, so a white cap would sit at 5 % height under a legend reading "white cap
 * = target reached". It is keyed to the holding half of (b), so it goes when the rep does.
 */
/**
 * LANE IDENTITY, WHICH THESE BARS USED NOT TO CARRY AT ALL. Every bar was painted in the app's own
 * accent gradient (`--accent-2` → `--accent`, cyan → pink), which is the colour of no lane in either
 * palette, and none of them was named. The receptor row 300 px away is green / red / yellow / blue
 * (or cyan / orange / magenta / lime) with the movement and the limb written under each ring — so
 * the ONLY thing tying a 14 px bar to the receptor it is supposed to agree with was its position in
 * a row of four identical columns, which is exactly the cue a patient reading it at 2 m cannot
 * resolve. A meter whose whole contract is "it must not contradict the receptor" has to be
 * identifiably the same lane as the receptor first.
 *
 * So the column is drawn in ITS OWN LANE'S COLOUR, from the session's palette, through `--lane` /
 * `--lane-dark` on the column (see `.vbar > i` in src/index.css), and the SIDE letter is printed
 * under it in the same colour. Colour alone would fail the colour-vision requirement the receptor
 * states are held to; the letter is the non-colour mark, and it is the one bit of lane identity
 * position cannot supply on the default bilateral prescription (two lanes, one movement, two limbs),
 * where mixing up L and R is the whole error. The full lane name goes on `title` / `aria-label` for
 * the therapist — at this width it would have to be ellipsized to fit, and half a movement name
 * under a gauge is worse than none (the same reason the panel is kept off the receptors' labels).
 */
const PIP_LOCK_FILL = 'linear-gradient(0deg, #3a3b42, #8b8d96)';
const PIP_LOCK_CAP = '#c08cff';
const PIP_GOAL_CAP = '#ffffff';
const PIP_GOAL_RING = '0 0 0 2px #ffffff';
/** The receptor's broken-ring grey, as a dashed outline (outline, so nothing reflows when it appears). */
const PIP_LOST_OUTLINE = '2px dashed #a9b0bb';
/** The fixed target reference — the receptor's target line, on the same linear ROM axis. */
const PIP_TARGET_LINE = '#ffffff';
/** ...and where a locked lane has to come back down to (`thresholdFraction * rearmFraction`). */
const PIP_REARM_LINE = PIP_LOCK_CAP;
/**
 * A near-black casing on both reference lines. The column crosses them, so their contrast cannot be
 * left to whatever the lane colour happens to be at that height — the same reason the receptor's
 * "lower to reset" chevron is cased.
 */
const PIP_LINE_CASING = '0 0 0 1px rgba(3, 6, 14, 0.88)';

/**
 * Bar slot → index into `getLaneStates()`, resolved by `LaneState.lane` exactly the way the receptor
 * row resolves it (`Highway.fillLaneMap`): the input contract says the array may arrive in any
 * order, and a meter that reads it by array position puts lane 2's column where the patient is
 * looking for lane 0's. Falls back to array position when the ids do not cover 0..n-1 exactly once,
 * which is what the renderer does with the same input. Fills `order` in place — this runs every
 * frame.
 */
function laneOrder(order: number[], states: readonly LaneState[]): void {
  const n = states.length;
  order.length = n;
  for (let i = 0; i < n; i++) order[i] = -1;
  let usable = 0;
  for (let i = 0; i < n; i++) {
    const raw = states[i]?.lane;
    if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
    const lane = Math.round(raw);
    if (lane < 0 || lane >= n || order[lane] >= 0) continue;
    order[lane] = i;
    usable++;
  }
  if (usable !== n) for (let i = 0; i < n; i++) order[i] = i;
}

/** A source that can report on its own health — `VisionInput` does; the scripted sources do not. */
interface SelfReporting {
  getStatus(): VisionStatus;
}

function selfReporting(source: InputSource | null): SelfReporting | null {
  const s = source as Partial<SelfReporting> | null;
  return s && typeof s.getStatus === 'function' ? (s as SelfReporting) : null;
}

/**
 * Lanes the input layer says CANNOT PRODUCE A REP, whatever the patient does — the set the receptor
 * row is told to draw as "no reading" rather than as a live gauge (`Highway.setLaneFaults`).
 *
 * `invalidCalibrationLanes` — a lane whose calibration `VisionInput` refused reads 0 and never
 * triggers, while still publishing `{ armed: true, triggerState: 'armed', tracking: true }`: a
 * textbook state (a), "rising, armed, ready", on a lane that will emit nothing all song. The boot
 * path already refuses to START such a session (see `getInvalidCalibrations` below), so this is the
 * cover for the ways a lane can go bad AFTER the count-in — a calibration replaced mid-session.
 *
 * `pinnedLanes` — the watchdog has seen the lane held above its re-arm level for longer than
 * `pinnedLaneSec`. The receptor is drawing (c), "lower to reset", which is honest about the trigger
 * and useless as an instruction: the patient has been obeying it for seconds and the meter has not
 * answered. Once the input layer has concluded the lane is stuck, "no reading" is the true statement
 * and the words go to the therapist.
 *
 * NOT `unreachableLanes`. That lane is measuring the patient correctly and they are falling short of
 * the threshold — which is precisely what (a) exists to show, graded, over the whole ROM axis. It is
 * a sentence for the therapist (the difficulty is wrong), never a reason to blank the patient's
 * gauge.
 */
export function faultedLanes(status: VisionStatus): number[] {
  const set = new Set<number>();
  for (const l of status.invalidCalibrationLanes ?? []) set.add(l);
  for (const l of status.pinnedLanes ?? []) set.add(l);
  return [...set].sort((a, b) => a - b);
}

/**
 * The picture-in-picture lane meters, shown next to the camera preview for the whole session.
 *
 * ONE VOICE: these are the only other movement meters in the patient's field of view, so they must
 * say what the receptors say, at the same instant. They used to brighten on `value >= threshold`
 * with no reference to `armed`, under the caption "gold = hit level" — so at the exact moment a
 * receptor correctly went grey and said "lower to reset", the meter 300 px away lit up and said
 * "hit level reached". That is the same biofeedback lie the receptor contract exists to remove.
 *
 * TWO FIXES DEEP, AND THE SECOND ONE IS THE POINT. Reading `receptorLookInto` per frame with no
 * `ReceptorHistory` gave this meter no crossing latch at all, so on the frame the patient reached
 * their target it went straight to the grey lockout look while the receptor 300 px away showed the
 * full 0.45 s acknowledgement. Giving it its own `ReceptorHistory` made the two AGREE — but on two
 * different clocks: this one on `performance.now()`, the receptor row on `Highway.receptorT`, which
 * stands still for up to `SONG_CLOCK_STALL_SEC` whenever the song clock stalls. Two meters whose
 * whole contract is that they cannot contradict each other must not be two models to keep in step.
 *
 * So when the renderer is up, `lookAt` hands this the SAME `ReceptorLook` OBJECT the receptor row
 * was drawn from on the last frame (`Highway.receptorLookOf`), and both are classified by the
 * receptor's own `receptorMarkSet` (and, within (b), by `receptorGoalHolding`). There is one model,
 * one clock and one set of numbers; the worst this meter can be is one animation frame behind, which
 * is two orders of magnitude inside the shortest latched state. The local history is the fallback for
 * the frames before the first draw (and for rendering this component on its own), so the meter is
 * never blank or lying meanwhile.
 *
 * THE FALLBACK IS ALWAYS STEPPED, NEVER ONLY WHEN IT IS DISPLAYED. It is an ongoing per-lane record
 * (previous trigger state, previous arming, the return journey's peak), not a per-frame computation,
 * and advancing it only on the frames `lookAt` returned nothing froze it for as long as a renderer
 * was up. The first frame after `lookAt` ever stopped resolving would then compare a minutes-old
 * trigger state against the current one — the same class of false latch the crossing guards exist to
 * stop. Stepping it every frame costs a handful of numbers; `drawn` still wins for display.
 */
export function LaneMeters({
  source,
  threshold,
  rearmFraction,
  lookAt,
  suspended = false,
  lanes,
  highContrast = false,
}: {
  source: InputSource;
  threshold: number;
  /**
   * The session's hysteresis re-arm fraction — THE SAME NUMBER THE RUNNER GAVE THE RENDERER, not a
   * second copy of the default. It only feeds the fallback history (the renderer's look wins
   * whenever there is one), but the fallback is what draws the frames before the first draw and
   * whenever `lookAt` stops resolving, and a fallback that classifies (c) against a different
   * re-arm line than the receptor row is the two-meters-disagreeing failure this component exists
   * to remove — just narrowed to the frames nobody was looking at the clock on.
   */
  rearmFraction: number;
  /** The receptor row's own look for a lane, when a renderer is up. See `Highway.receptorLookOf`. */
  lookAt?: (lane: number) => Readonly<ReceptorLook> | undefined;
  /**
   * True while the session is NOT ACCEPTING INPUT (a therapist pause) — `RenderFrame.inputSuspended`
   * as the runner's phase reports it. These bars are fed from `source.getLaneStates()`, which is
   * live through a pause because the camera is, and the engine discards every event stamped inside
   * one: the round-7 critic caught this meter's knowledge-of-results ring lit for eleven frames of a
   * pause with the score flat at zero. The renderer's look already carries the stop (it is drawn
   * from the same flag), so this only reaches the FALLBACK history — but the fallback is what draws
   * the frames before the first `draw()` and after a runner is disposed, and a fallback that
   * celebrates a stop the receptor row is blanking for is the two-meters-disagreeing failure this
   * component exists to remove.
   */
  suspended?: boolean;
  /**
   * The prescription, for LANE IDENTITY — the colour each bar is painted in and the limb printed
   * under it (see the constants above). The same specs the receptor row names its rings from
   * (`Highway.drawLabels` → `laneLabel`), so the two meters cannot disagree about which lane is
   * which any more than they can disagree about what state it is in. Missing entries fall back to
   * the lane's palette colour with no letter, which is what a component rendered without a
   * prescription (the meter tests, a bare harness) gets.
   */
  lanes?: readonly LaneSpec[];
  /** The session's palette choice — the one the renderer draws the receptor row with. */
  highContrast?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  // Read through a ref so a caller passing an inline arrow does not tear down the rAF loop (and the
  // fallback history with it) on every React render.
  const lookAtRef = useRef(lookAt);
  lookAtRef.current = lookAt;
  // Read through a ref for the same reason: a pause must reach the running rAF loop without tearing
  // it (and the fallback history with it) down and rebuilding it on the frame the session stops.
  const suspendedRef = useRef(suspended);
  suspendedRef.current = suspended;
  useEffect(() => {
    let raf = 0;
    const look: ReceptorLook = emptyReceptorLook(rearmFraction);
    /** Bar slot → index into `getLaneStates()`; see `laneOrder`. Rebuilt in place, never reallocated. */
    const order: number[] = [];
    // FALLBACK ONLY (see the header): the crossing latch and the anti-strobe tracking hold are
    // per-lane history, not per-frame state, and this meter must still show all four states in the
    // frames before the renderer has drawn one. Its clock must be monotone, in seconds, and STILL
    // RUNNING when the session is not (see `ReceptorHistory.update`) — nothing here is judged, it is
    // drawn, and what it draws are windows measured on the patient.
    const history = new ReceptorHistory();
    const tick = () => {
      const el = host.current;
      if (el) {
        const states = source.getLaneStates();
        const columns = el.children;
        const now = performance.now() / 1000;
        laneOrder(order, states);
        for (let i = 0; i < columns.length && i < order.length; i++) {
          // Each slot is a COLUMN: the bar, then the lane's name under it (see the constants above).
          const bar = columns[i].firstElementChild as HTMLElement | null;
          const fill = bar?.firstElementChild as HTMLElement | null;
          if (!bar || !fill) continue;
          // The two fixed reference marks. Their HEIGHTS are set once in the JSX (they are session
          // constants); what changes per frame is which one is shown, and it is the same swap the
          // receptor row makes: while the lane can still fire, the reference is the TARGET it is
          // reaching for; once it is locked out, the reference is the RE-ARM line it has to come back
          // down to, and the target above is no longer the thing to aim at.
          const targetMark = bar.children[1] as HTMLElement | undefined;
          const rearmMark = bar.children[2] as HTMLElement | undefined;
          // Bar i is LANE i, not the i-th entry of the array: `getLaneStates()` may arrive in any
          // order, and the receptor row 300 px away resolves it by `LaneState.lane`
          // (`Highway.fillLaneMap`). Two meters reading the same states into a different left-to-
          // right order is the same contradiction as two meters in different states.
          // ALWAYS STEPPED, even while the renderer is driving the display. This history's per-lane
          // `prevTrigger` / `prevArmed` / peak are an ONGOING record, not a per-frame computation:
          // advancing it only on the frames `lookAt` returned nothing froze it for as long as a
          // renderer was up, so the first frame after `lookAt` ever stopped resolving (runner
          // disposed mid-session, or a lane-count change pushing the index past
          // `Highway.laneLooksCount`) would compare a minutes-old `prevTrigger` against the current
          // one and could latch a crossing for a lockout that began long before. Stepping it every
          // frame costs a handful of numbers and makes the fallback correct whenever it is reached.
          history.update(look, i, states[order[i]], threshold, rearmFraction, now, undefined, undefined, suspendedRef.current);
          // ...but the RENDERER's look still wins for display when there is one: one model, one
          // clock, one set of numbers (see the header).
          const shown = lookAtRef.current?.(i) ?? look;
          const marks = receptorMarkSet(shown);
          // Within (b): is the rep still in hand, or has the lane already re-armed? Same rule, same
          // frame, same numbers as the receptor row 300 px away.
          const holding = receptorGoalHolding(shown);
          // No measurement ⇒ nothing derived from one: the bar empties rather than leaving a stale
          // column standing at 80 % while the camera cannot see the patient at all.
          const rom = marks === 'lost' ? 0 : Math.max(0, Math.min(1, shown.rom ?? 0));
          fill.style.height = `${rom * 100}%`;
          fill.style.opacity = marks === 'lost' ? '0.25' : '1';
          // '' falls back to the column's own `--lane` gradient — this lane's colour, the colour of
          // the receptor ring it must agree with. Only the lockout overrides it, because (c) is
          // drawn in the desaturated lock tint on the receptor row too.
          fill.style.background = marks === 'locked' ? PIP_LOCK_FILL : '';
          // The cap is a MARK ON THE COLUMN, so it may only claim things about where the patient is
          // now: white = at/above target with the rep still in hand, violet = locked out, lower to
          // reset, none = still rising (or already re-armed). "That rep reached your target" is the
          // BAR's mark — the white ring below — which outlives the cap by up to `GOAL_MIN_SEC`.
          fill.style.borderTop =
            holding ? `3px solid ${PIP_GOAL_CAP}` : marks === 'locked' ? `3px solid ${PIP_LOCK_CAP}` : '';
          // The KR ring: on for the whole latch, cap or no cap.
          bar.style.boxShadow = marks === 'goal' ? PIP_GOAL_RING : '';
          bar.style.outline = marks === 'lost' ? PIP_LOST_OUTLINE : '';
          // No measurement ⇒ no reference either: a target line over an empty bar invites the patient
          // to read a height off a gauge that has none.
          if (targetMark) targetMark.hidden = marks === 'lost' || marks === 'locked';
          if (rearmMark) rearmMark.hidden = marks !== 'locked';
          bar.dataset.state = marks;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [source, threshold, rearmFraction]);

  const count = source.getLaneStates().length;
  const palette = getPalette(highContrast);
  /**
   * Bar slot → prescription entry, resolved by `LaneSpec.index` exactly the way the renderer
   * resolves it for the label under each receptor (`Highway.laneSpec`) and the way `laneOrder`
   * resolves the meter states — not by array position. A meter that named bar 0 from `lanes[0]`
   * while the receptor named ring 0 from the spec whose `index` is 0 would be two meters printing
   * two different limbs for the same lane, which is the identity version of the contradiction this
   * component exists to remove.
   */
  const specOf = (lane: number): LaneSpec | undefined =>
    lanes?.find((l) => Math.round(l.index) === lane) ?? lanes?.[lane];
  /** Shared geometry for both reference lines — see the header: one linear ROM axis, as the receptor. */
  const lineStyle = {
    position: 'absolute' as const,
    left: 0,
    right: 0,
    height: 2,
    marginBottom: -1,
    boxShadow: PIP_LINE_CASING,
    pointerEvents: 'none' as const,
  };
  return (
    <div className="pip-meters" ref={host}>
      {Array.from({ length: count }, (_, i) => {
        const spec = specOf(i);
        const color = laneColor(palette, i);
        const name = spec ? laneLabel(spec) : `Lane ${i + 1}`;
        return (
          <div
            className="pip-lane"
            key={i}
            style={
              {
                ['--lane']: color.base,
                ['--lane-dark']: color.dark,
                // The empty part of the track, tinted, so the lane is identifiable AT REST — when the
                // column is a sliver and the only lane-coloured thing on the bar would be the letter.
                ['--lane-track']: withAlpha(color.base, 0.18),
              } as React.CSSProperties
            }
            title={name}
          >
            <div className="vbar" style={{ position: 'relative' }} aria-label={name}>
              <i style={{ height: '0%' }} />
              <b
                data-testid={`pip-target-${i}`}
                style={{ ...lineStyle, bottom: `${Math.min(100, Math.max(0, threshold * 100))}%`, background: PIP_TARGET_LINE }}
              />
              <b
                data-testid={`pip-rearm-${i}`}
                hidden
                style={{
                  ...lineStyle,
                  bottom: `${Math.min(100, Math.max(0, threshold * rearmFraction * 100))}%`,
                  background: PIP_REARM_LINE,
                }}
              />
            </div>
            <span className="pip-lane-name" data-testid={`pip-name-${i}`} aria-hidden>
              {spec ? (spec.side === 'left' ? 'L' : 'R') : ''}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export default function PlayScreen() {
  const goto = useStore((s) => s.goto);
  const inputMode = useStore((s) => s.inputMode);
  /** The prescription, for naming a lane in the messages a therapist has to act on. */
  const lanes = useStore((s) => s.lanes);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pipRef = useRef<HTMLDivElement>(null);
  const runnerRef = useRef<GameRunner | null>(null);

  const [hud, setHud] = useState<HudSnapshot | null>(null);
  const [phase, setPhase] = useState<'loading' | 'running' | 'error' | 'blocked' | 'camera'>('loading');
  /**
   * The thrown value from `ensureVision`, kept raw so CameraFallback can classify it.
   *
   * The camera can fail HERE and not only on the camera-check screen: unplugged between the check and
   * the count-in, permission revoked mid-visit, or a deep link straight to `?screen=play`. That used
   * to land on a bare "Could not start the session" with the exception text and one Back button — no
   * cause, no remedy, no retry, and no labelled keyboard fallback. It is the same failure the fallback
   * screen was built for, so it gets the same screen.
   */
  const [cameraError, setCameraError] = useState<unknown>(null);
  /** Bumped by Retry so the boot effect re-runs and re-requests the device for real. */
  const [attempt, setAttempt] = useState(0);
  /** The in-flight vision attempt, so Retry can await the REAL request rather than a fixed delay. */
  const visionAttempt = useRef<Promise<unknown> | null>(null);
  /** Lanes the camera input refuses to score — the session is not started at all while this is set. */
  const [blocked, setBlocked] = useState<InvalidCalibration[]>([]);
  const [progress, setProgress] = useState(0);
  const [loadNote, setLoadNote] = useState('Preparing session');
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [paused, setPaused] = useState(false);
  const [input, setInput] = useState<InputSource | null>(null);

  const threshold = DIFFICULTIES[useStore.getState().difficulty].thresholdFraction;
  /**
   * The session's hysteresis re-arm fraction. ONE binding, read by the runner (which forwards it to
   * the renderer as `RenderFrame.rearmFraction`) and by the picture-in-picture meters' fallback
   * history, so the two meters cannot be classifying (c) against two different re-arm lines.
   */
  const rearmFraction = DEFAULT_REARM_FRACTION;
  /**
   * The palette the RENDERER draws the receptor row with, read from the same setting, so the
   * picture-in-picture bars are the same four colours as the rings they must agree with.
   */
  const highContrast = useStore((s) => s.settings.highContrast);

  /**
   * Where the picture-in-picture panel is allowed to sit, asked of the renderer that draws the
   * board (`Highway.overlayPanel`).
   *
   * IT USED TO BE `left: 18px; bottom: 18px` IN CSS, AND AT CLINIC-TABLET WIDTHS THAT IS ON TOP OF
   * LANE 0's LABEL. Measured: at 1280x800 lane 0's "L knee lift" rendered as "knee lift" and at
   * 1024x768 as "nee lift", beside a fully legible "R knee lift" on lane 1 — so on the DEFAULT
   * bilateral prescription the one mark that says which limb a lane belongs to was behind this
   * panel, and a hemiparetic patient was being told "lower to reset" on a lane nobody had named.
   * `Highway.drawLabels` exists precisely so the label under a receptor never disagrees with the
   * receptor above it; covering it is the same failure with extra steps, and it is the 90-second
   * therapist test failing outright. Camera mode was worse, not better: the panel grew upward from
   * a fixed bottom, so the overlapping edge never moved and the legend line was longer.
   *
   * Null until the renderer has been sized — the panel is not mounted before then either (it needs
   * `input`, which is set after `runner.start()`), so there is no frame in which the CSS fallback
   * is what the patient sees.
   */
  const [pipBox, setPipBox] = useState<OverlayPanelBox | null>(null);
  const syncPipBox = useCallback(() => {
    const hw = runnerRef.current?.highway;
    setPipBox(hw ? hw.overlayPanel() : null);
  }, []);

  /**
   * ONE VOICE (see `LaneMeters`): the picture-in-picture bars are drawn from the very looks the
   * receptor row was drawn from, so the two meters cannot be in different states — not even for the
   * up-to-`SONG_CLOCK_STALL_SEC` a second `ReceptorHistory` on `performance.now()` could drift by
   * while the audio clock is stalled. Undefined before the first frame, where `LaneMeters` falls
   * back to its own history.
   */
  const receptorLookOf = useCallback(
    (lane: number) => runnerRef.current?.highway.receptorLookOf(lane),
    [],
  );

  /**
   * THE INPUT LAYER'S OWN HEALTH REPORT, WHICH THIS SCREEN USED NOT TO READ AT ALL.
   *
   * `VisionInput.getStatus()` knows, in plain language, every way a lane can be publishing a
   * perfectly well-formed `LaneState` while being unable to score: a refused calibration, a pinned
   * lane, a threshold the patient cannot reach, a subject swap, a camera the machine cannot keep up
   * with. The camera-check and calibration screens read it; the play screen — the only screen where
   * the patient is being asked to trust the meters — did not, on any of them. The receptor's own
   * contract is "tell the truth about what the input layer will do with the next rep", and for a
   * refused lane it was saying "ready" for three minutes.
   *
   * Two consumers, and they are deliberately different:
   *   - the RECEPTOR ROW gets the lanes that structurally cannot fire (`faultedLanes`) and draws
   *     them as "no reading" — the patient must not be shown a gauge that is not measuring them.
   *     Pushed straight at the renderer rather than through React state, so a remount or an
   *     unchanged-list render can never leave a stale fault set on the board.
   *   - the THERAPIST gets the sentences, which is where the remedy lives. Set as state (and
   *     deduplicated) so a 90-second changeover reads them off the panel instead of a console.
   *
   * Polled rather than pushed: `getStatus()` is memoized per processed frame inside `VisionInput`,
   * so this is a key comparison at 2 Hz, and the watchdogs it reports on are measured in seconds.
   */
  const [liveWarnings, setLiveWarnings] = useState<string[]>([]);
  useEffect(() => {
    const src = selfReporting(input);
    if (!src) {
      // A scripted source reports nothing about itself, so there is nothing to say and nothing to
      // fault. (`setLiveWarnings` is only called when the list actually changes — an unconditional
      // reset here would re-render every mount for a session that never had a warning.)
      setLiveWarnings((prev) => (prev.length === 0 ? prev : []));
      runnerRef.current?.highway.setLaneFaults(null);
      return;
    }
    let lastKey = '';
    const poll = (): void => {
      const status = src.getStatus();
      const faults = faultedLanes(status);
      runnerRef.current?.highway.setLaneFaults(faults);
      const words = status.warnings ?? [];
      const key = `${faults.join(',')}${words.join(' ')}`;
      if (key === lastKey) return;
      lastKey = key;
      setLiveWarnings(words.slice());
    };
    poll();
    const id = setInterval(poll, 500);
    return () => {
      clearInterval(id);
      runnerRef.current?.highway.setLaneFaults(null);
    };
  }, [input]);

  useEffect(() => {
    let alive = true;
    let ownedInput: InputSource | null = null;

    const boot = async () => {
      const st = useStore.getState();
      const config = st.config();
      const settings = st.settings;

      setLoadNote('Starting audio');
      const { ctx, mixer, sfx } = await runtime.ensureAudio();
      sfx.enabled = settings.sfx;

      setLoadNote('Loading song');
      let songManifest: SongManifest | null = null;
      try {
        songManifest = await runtime.loadSong(config.songId, (p) => setProgress(p.fraction));
      } catch (err) {
        console.warn('[play] song load failed, running silently', err);
      }
      if (!alive) return;

      const grid = songManifest ? songGridOf(songManifest) : SILENT_GRID;
      const built = buildSessionChart(grid, config, songManifest);
      if (!alive) return;
      setWarnings(built.warnings);

      setLoadNote('Preparing input');
      let source: InputSource | ((clock: { songTime(n?: number): number; ctxTimeForSongTime(t: number): number }) => InputSource);
      /**
       * The camera's break-in-the-stream window, taken from the input source that owns it rather
       * than re-declared here. It becomes `RenderFrame.maxGapSec`, which is the clock the receptor
       * expires its own crossing evidence on — see `GameRunnerOptions.maxGapSec`. Undefined for the
       * scripted sources, which have no such window (the renderer then keeps its own default).
       */
      let maxGapSec: number | undefined;
      /**
       * The camera's REFRACTORY window, taken from the same place and for the same reason: a
       * crossing the trigger swallows inside it locks the lane out and reports a rep but emits no
       * `LaneInputEvent`, so a receptor that does not know the number throws the full "you reached
       * your target" cue for a rep the score never saw. Undefined for the scripted sources, which
       * emit every crossing (see `RenderFrame.minIntervalSec`).
       */
      let minIntervalSec: number | undefined;
      if (inputMode === 'keyboard') {
        const kb = new KeyboardInput({ lanes: config.lanes.length, audioContext: ctx });
        ownedInput = kb;
        source = kb;
      } else if (inputMode === 'autoplay') {
        source = (songClock) => {
          const bot = new AutoplayInput({
            chart: built.chart,
            audioContext: ctx,
            songClock,
            jitterMs: 26,
            hitFraction: 0.94,
            seed: config.seed,
          });
          ownedInput = bot;
          return bot;
        };
      } else {
        let vision;
        try {
          const attempting = runtime.ensureVision({
            mode: config.mode,
            lanes: config.lanes,
            calibrations: st.calibrations,
            difficulty: config.difficulty,
            mirrored: settings.mirrored,
          });
          visionAttempt.current = attempting;
          vision = await attempting;
        } catch (err) {
          if (!alive) return;
          setCameraError(err);
          setPhase('camera');
          return;
        }
        if (!alive) return;
        // A LANE THAT PROVABLY CANNOT SCORE IS A HARD STOP, NOT A WARNING TO READ AFTERWARDS.
        // VisionInput refuses a range that measures a different quantity (another fingertip) or the
        // other limb (the other mirror convention), and a refused lane reads 0 and never triggers: the
        // patient would work through a whole song on a flat lane and meet the verdict as a 0% row on
        // the results screen. The app knows this BEFORE a note is scheduled, so it says so here — with
        // the reason and the way back to the screen that can fix it.
        const refused = vision.getInvalidCalibrations();
        if (refused.length > 0) {
          setBlocked(refused);
          setPhase('blocked');
          return;
        }
        source = vision;
        maxGapSec = vision.staleFrameSec;
        minIntervalSec = vision.minIntervalSec;
      }
      if (!alive) return;

      const canvas = canvasRef.current;
      if (!canvas) throw new Error('canvas missing');

      const runner = new GameRunner({
        canvas,
        chart: built.chart,
        lanes: config.lanes,
        windows: windowsForLanes(config.lanes, config.difficulty, config.windowScale),
        clock: ctx,
        input: source,
        mixer: songManifest ? mixer : null,
        sfx,
        inputLatencySec: inputMode === 'camera' ? st.latencyOffsetSec : 0,
        missGraceMs: inputMode === 'camera' ? undefined : 0,
        thresholdFraction: DIFFICULTIES[config.difficulty].thresholdFraction,
        rearmFraction,
        maxGapSec,
        minIntervalSec,
        songTitle: songManifest?.title,
        attribution: songManifest ? playCredit(songManifest) : undefined,
        highwayOptions: {
          approachSec: settings.scrollSec,
          highContrast: settings.highContrast,
          reducedMotion: settings.reducedMotion,
          effectIntensity: settings.effectIntensity,
          showMissPopup: settings.showMissPopup,
        },
        // Camera sessions keep the camera open for the next song; dev inputs are ours to stop.
        stopInputOnDispose: inputMode !== 'camera',
        hudIntervalMs: 200,
        onHud: (h) => {
          setHud(h);
          setPaused(h.phase === 'paused');
        },
        onEnd: (summary) => {
          const store = useStore.getState();
          const result = buildSessionResult({
            summary,
            config,
            manifest: songManifest,
            inputMode: store.inputMode,
            latencyOffsetSec: inputMode === 'camera' ? store.latencyOffsetSec : 0,
            calibrations: store.calibrations,
          });
          store.addResult(result);
          store.goto('results');
        },
      });

      runnerRef.current = runner;
      runtime.runner = runner;
      setInput(runner.input);
      runner.resize();
      syncPipBox();
      await runner.start();
      if (!alive) return;
      setPhase('running');
    };

    setCameraError(null);
    boot().catch((err: unknown) => {
      console.error('[play] failed to start', err);
      if (!alive) return;
      setError(err instanceof Error ? err.message : String(err));
      setPhase('error');
    });

    const onResize = () => {
      runnerRef.current?.resize();
      // The board's hardware band, its gutter and the rock gauge all move with the canvas size, so
      // the panel that has to stay clear of them is re-placed on the same event, not pinned in CSS.
      syncPipBox();
    };
    window.addEventListener('resize', onResize);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        const runner = runnerRef.current;
        if (!runner) return;
        if (runner.getPhase() === 'paused') void runner.resume();
        else runner.pause();
      }
    };
    window.addEventListener('keydown', onKey);

    return () => {
      alive = false;
      window.removeEventListener('resize', onResize);
      window.removeEventListener('keydown', onKey);
      runnerRef.current?.dispose();
      runnerRef.current = null;
      runtime.runner = null;
      ownedInput?.stop();
    };
  }, [inputMode, attempt, rearmFraction, syncPipBox]);

  /**
   * Retry = re-request. The dead VisionInput is disposed so `ensureVision` cannot hand it back, the
   * boot effect re-runs, and this awaits the NEW attempt's own promise — so the button stays in its
   * "asking…" state for as long as the request actually takes.
   */
  const retryCamera = useCallback(async () => {
    const before = visionAttempt.current;
    runtime.disposeVision();
    setCameraError(null);
    setPhase('loading');
    setAttempt((n) => n + 1);
    for (let i = 0; i < 60 && visionAttempt.current === before; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    await visionAttempt.current?.catch(() => undefined);
  }, []);

  if (phase === 'camera') return <CameraFallback error={cameraError} onRetry={retryCamera} retries={attempt} />;

  const countdown = hud?.countdown ?? 0;
  /**
   * The panel's box, from the renderer (see `pipBox`). `maxHeight` is the room between its bottom
   * edge and the top of the canvas: `.pip` is a column flex box whose video is the only item
   * allowed to shrink, so on a short landscape canvas the camera thumbnail loses a few rows rather
   * than the lane meters or their legend being clipped — the legend is the mark that stops a violet
   * cap needing a verbal gloss.
   */
  const pipStyle = pipBox
    ? {
        left: Math.round(pipBox.left),
        bottom: Math.round(pipBox.bottom),
        width: Math.round(pipBox.width),
        maxHeight: Math.round(pipBox.maxHeight),
      }
    : undefined;

  return (
    <div className="play-root">
      <canvas className="play-canvas" ref={canvasRef} data-testid="play-canvas" />

      <div className="play-chrome">
        {phase === 'running' && countdown > 0 && (
          <div className="countdown">
            {countdown}
            <small>get ready</small>
          </div>
        )}

        <button
          className="pause-btn"
          onClick={() => {
            const runner = runnerRef.current;
            if (!runner) return;
            if (runner.getPhase() === 'paused') void runner.resume();
            else runner.pause();
          }}
          aria-label={paused ? 'Resume' : 'Pause'}
          // Nothing to pause during the count-in: the song has not started and the mixer's transport
          // is already scheduled. Disabled rather than silently inert.
          disabled={hud?.phase === 'countdown'}
          title={hud?.phase === 'countdown' ? 'Starting…' : paused ? 'Resume (Esc)' : 'Pause (Esc)'}
        >
          {paused ? '▶' : '❚❚'}
        </button>

        {inputMode === 'camera' && input && (
          <div className="pip" ref={pipRef} style={pipStyle} data-testid="play-pip">
            {/* THE WORDS FOR WHAT THE RINGS CANNOT SAY. A faulted lane's receptor goes to "no
                reading" with a "!" in it (see the status poll above); that is the honest thing to
                show a patient, and it is not a remedy. The remedy is a sentence, it is addressed to
                the therapist, and it goes at the TOP of the one panel a therapist is already
                looking at — above the thumbnail, because the thumbnail is the only thing here worth
                less than a reason the session is not scoring. */}
            {liveWarnings.length > 0 && (
              <div className="pip-alerts" data-testid="play-alerts" role="status">
                {liveWarnings.map((w, i) => (
                  <p key={w} data-testid={`play-alert-${i}`}>
                    {w}
                  </p>
                ))}
              </div>
            )}
            <CameraPreview className="pip-video" />
            <LaneMeters
              source={input}
              threshold={threshold}
              rearmFraction={rearmFraction}
              lookAt={receptorLookOf}
              suspended={paused}
              lanes={lanes}
              highContrast={highContrast}
            />
            {/* "violet DASHES", not "violet line": on the receptor ring the violet marks are the
                drain cap and the dashed re-arm line, while the "lower to reset" chevron between
                them is composited additively (it has to be strictly brighter than the column it
                sits on — see Highway.drawReceptors) and therefore reads white on a bright column.
                A therapist reading this legend aloud must not be pointing at a mark the ring does
                not draw in that colour. And "no reading" rather than "out of frame": the dashed
                outline now also covers a lane the input layer has given up on (see the status
                poll), which is not the patient's to fix. */}
            <div className="pip-note">
              bar colours match the receptors · white line = your target · white ring = target reached ·
              violet dashes = lower to here · dashed outline = no reading from this lane (out of frame,
              faulted, or the session is paused — nothing counts while it is)
            </div>
          </div>
        )}

        {/* NOT ONLY A DEV AFFORDANCE. `CameraFallback` offers keyboard control to a PATIENT when the
            camera fails, so these bars are biofeedback on that path and carry the same legend the
            camera path gets — a violet cap with nothing on screen to explain it is a mark the
            therapist has to talk the patient through, which is exactly what the 90-second test
            forbids. The "out of frame" line is dropped here because there is no tracker to lose a
            patient: the scripted sources publish `tracking: true` always, and a legend for a state
            this path cannot reach is a dead promise. The keys stay, because the bot does not need
            them but a person does. */}
        {inputMode === 'keyboard' && input && (
          <div className="pip" style={pipStyle} data-testid="play-pip">
            <LaneMeters
              source={input}
              threshold={threshold}
              rearmFraction={rearmFraction}
              lookAt={receptorLookOf}
              suspended={paused}
              lanes={lanes}
              highContrast={highContrast}
            />
            <div className="pip-note">
              keys 1–4 / D F J K · bar colours match the receptors · white line = your target · white ring =
              target reached · violet dashes = lower to here · dashed outline = paused, nothing counts
            </div>
          </div>
        )}

        {phase === 'loading' && (
          <div className="overlay">
            <div className="card stack">
              <h2>{loadNote}…</h2>
              <div className="loading-bar">
                <Meter value={progress} label="loading" />
              </div>
              <p className="muted">Stems are loaded whole so every instrument stays sample-locked to the chart.</p>
            </div>
          </div>
        )}

        {phase === 'blocked' && (
          <div className="overlay" data-testid="play-blocked">
            <div className="card stack">
              <h2>{blocked.length > 1 ? `${blocked.length} lanes are not calibrated` : 'A lane is not calibrated'}</h2>
              <p className="muted">
                The session was not started: {blocked.length > 1 ? 'these lanes' : 'this lane'} would score nothing all
                song, and the patient would have no way to tell.
              </p>
              {blocked.map((b) => (
                <Toast kind="bad" key={b.lane}>
                  <strong data-testid={`play-blocked-${b.lane}`}>
                    Lane {b.lane + 1} ({laneName(lanes[b.lane] ?? b)}):
                  </strong>{' '}
                  {b.reason}.
                </Toast>
              ))}
              <div className="row">
                <button
                  className="btn btn-primary btn-lg grow"
                  onClick={() => goto('rom')}
                  data-testid="play-recalibrate"
                >
                  Re-calibrate {blocked.length > 1 ? 'these lanes' : 'this lane'} →
                </button>
                <button className="btn btn-lg" onClick={() => goto('setup')}>
                  Back to setup
                </button>
              </div>
            </div>
          </div>
        )}

        {phase === 'error' && (
          <div className="overlay">
            <div className="card stack">
              <h2>Could not start the session</h2>
              <p className="muted">{error}</p>
              <button className="btn btn-primary btn-lg" onClick={() => goto('setup')}>
                Back to setup
              </button>
            </div>
          </div>
        )}

        {paused && (
          <div className="overlay" data-testid="pause-overlay">
            <div className="card stack">
              <h2>Paused</h2>
              <p className="muted">The song and the chart restart together — the patient will not lose their place.</p>
              {/* THE WORDS FOR THE MARK THE PAUSE PUTS ON EVERY METER. While the session is stopped the
                  camera keeps running and the patient keeps moving, but the engine discards every input
                  — so both live meters blank to "no reading" (a broken ring with ❚❚ in it, and a dashed
                  bar outline) rather than gauge a rep that cannot count. A therapist between patients
                  must be able to read that off this screen instead of being taught it. */}
              <p className="muted">
                Movement is not being scored while paused, so every receptor and every bar shows{' '}
                <strong>no reading</strong> (❚❚) — including any rep the patient makes now. Resume first.
              </p>
              {warnings.map((w, i) => (
                <Toast key={i}>{w}</Toast>
              ))}
              {/* The live input-layer warnings again, at full width: a therapist who pauses to work
                  out why a lane is not scoring should not have to read them out of a 200 px panel. */}
              {liveWarnings.map((w) => (
                <Toast kind="bad" key={w}>
                  {w}
                </Toast>
              ))}
              <div className="row">
                <button className="btn btn-primary btn-lg grow" onClick={() => void runnerRef.current?.resume()}>
                  Resume
                </button>
                <button className="btn btn-lg" onClick={() => runnerRef.current?.quit()} data-testid="end-session">
                  End &amp; see results
                </button>
              </div>
              {hud && (
                <div className="row dim mono">
                  <span>{hud.score.toLocaleString()} pts</span>
                  <span>{hud.reps} reps</span>
                  <span>{hud.hits} hits</span>
                  <span>{hud.misses} misses</span>
                </div>
              )}
            </div>
          </div>
        )}

        {hud?.clockStalled && (
          <div className="overlay">
            <div className="card stack">
              <h2>Audio clock stopped</h2>
              <p className="muted">
                The browser suspended the audio context, which is the clock this game runs on. Tap to resume.
              </p>
              <button className="btn btn-primary btn-lg" onClick={() => void runtime.ensureAudio()}>
                Resume audio
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
