/**
 * Guitar-Hero style note highway renderer. Canvas 2D, DPR aware, no React.
 *
 * Hot path allocation: nothing per note, per particle or per lane. Sprites, gradients, text sprites
 * and fitted strings are cached; particles are pooled; beat lines, particle colour batches and the
 * lane→state maps are preallocated typed arrays; `projectInto` and `receptorLookInto` fill scratch
 * objects; the combo string is memoized. What *does* allocate on a normal frame, exhaustively: the
 * closure passed to `grad()` on a cache miss (bounded by the key set), `Array#sort`'s internals for
 * the note draw order, and — only when `showStats` is on — the stats line. `getStats()` returns a
 * fresh copy, by design; it is not called by `draw()`.
 *
 * Usage:
 *   const hw = new Highway(canvas);           // canvas: HTMLCanvasElement or OffscreenCanvas
 *   hw.resize();                              // on mount + window resize (reads clientWidth/Height + DPR)
 *   requestAnimationFrame(() => hw.draw(frame));
 *   hw.reset();                               // on song restart / new session (same instance)
 *
 * Sizing rules (`resize()` with no arguments):
 *   - HTMLCanvasElement with CSS size: logical size = clientWidth/clientHeight, backing = × DPR.
 *   - Otherwise (OffscreenCanvas, or a canvas with no CSS sizing) the *attribute* size is taken as
 *     the backing store on first use, logical = attribute / DPR, and later no-arg calls keep the
 *     logical size — the backing store is never re-multiplied by DPR. Call `resize(w, h, dpr)`
 *     to set an explicit logical size.
 *
 * `draw(frame)` is a pure function of the RenderFrame plus a little internal animation state
 * (particles, popups, rolling score). It never mutates the frame. A backward jump of more than
 * `RESTART_JUMP_SEC` in `songTime` is treated as a restart and resets that state automatically.
 *
 * Judgment feedback — two supported integration shapes, and no silent path between them:
 *   - push `HitEvent`s into `frame.recentHits` (the engine's own output), and/or
 *   - flip a note's `state` to 'hit' / 'miss' (and set `judgment`).
 * Whichever the renderer sees first for a given note id produces the burst / flash / tint / popup;
 * the other is de-duped. So an integrator that flips state on the verdict frame and only delivers
 * the event a frame later still gets exactly one set of effects, on the earlier frame — and an
 * integrator that never sends events at all still gets full feedback.
 *
 * Clinical presentation: `highContrast`, `effectIntensity` (0..1) and `reducedMotion` are all
 * runtime-adjustable through `setOptions()`, as is `maxParticles`. Turning the decoration down
 * never removes a judgment cue: at `effectIntensity: 0` a hit still gets a shockwave ring, a lane
 * flash and a popup, and a miss still gets a grey fizzling gem, a puff and a red lane tint.
 *
 * The next target always wins over decoration: judgment popups are small, capped at
 * `POPUP_MAX_RISE_FRAC` of the board above the strike line, and painted *underneath* the gems, so
 * they can never hide an oncoming note. Lane labels are fitted to the lane pitch — staggered onto
 * two rows, and ellipsized only if that is still not enough — so they never collide on a narrow
 * canvas.
 *
 * Degenerate input degrades gracefully. A non-finite `songTime`, `score`, `health`, `combo`,
 * `multiplier`, `beatPhase` or `energy` is treated as a missing value for that frame and cannot
 * reach the smoothed accumulators (receptor glow, effort gauge, rolling score): the renderer keeps
 * drawing at the last good song time and recovers completely on the next healthy frame. "Missing"
 * really means missing — a non-finite `beatPhase` goes *flat* (like reduced motion) rather than
 * landing on phase 0, which is the maximum-pulse value, and a non-finite `multiplier` holds tier 1
 * instead of restarting the badge pop on every frame.
 *
 * Honest biofeedback (the reason this is a rehab game and not a music game):
 *   - the receptor meter is a gauge, not a glow: a dark well painted OVER the receptor's button
 *     face (never under it), a hard-edged liquid level, and a fixed target line at
 *     `RenderFrame.thresholdFraction` — the same number the engine triggers on, warned about once
 *     if it is missing — with overshoot headroom above it, so "half way" reads differently from
 *     "nearly there" from across a clinic room;
 *   - the receptor has four categorically different looks, one per state the input layer can
 *     actually be in — rising, the threshold crossing, locked out by hysteresis
 *     (`RenderLaneState.armed === false`) and tracking lost (`tracking === false`) — and they
 *     differ by WHICH MARKS EXIST, not by hue or brightness, so they survive low acuity and
 *     colour-vision deficits; see `drawReceptors` and receptor.ts. Level line + target gate posts mean
 *     "keep going", a split cap + two solid arrowheads + the additive rim and corona mean "you
 *     reached your target", a desaturated ring with a chevron and a return-to-rest arc means
 *     "lower to reset", and the only ring with gaps in it means "the camera cannot see you". The
 *     crossing is LATCHED (`ReceptorHistory`) because it lasts one camera frame and the trigger has
 *     already disarmed by the time the state is published — without that, the one look the whole
 *     session is for is unreachable and the patient's reward for reaching their range is the ring
 *     going grey;
 *   - NOTHING ON THE BOARD IS PAINTED OVER A RECEPTOR. The receptor row is drawn after the gems and
 *     the particles (see `draw`): a note gem is opaque and almost exactly the size of the meter well
 *     it lands on, so with the conventional order a gem covered 96 % of its own lane's gauge for a
 *     third of every lane's frames — including, worst of all, the gems a patient stalled at end
 *     range is missing, whose fizzle sits over the "lower to reset" instruction that would end the
 *     stall. The gems sink behind the ring instead, and a dying one walks out from under it
 *     (`missCueY`);
 *   - a lane the INPUT LAYER says cannot fire at all — a refused calibration, a pinned lane — is
 *     drawn as "no reading" rather than as a live gauge (`setLaneFaults`), because the one thing the
 *     receptor may never do is promise a rep the input layer will not produce;
 *   - meters and labels are matched to lanes by `LaneState.lane` / `LaneSpec.index` when those are
 *     present, not by array position alone;
 *   - every judgment cue is kept inside the canvas (`missCueY`, `POPUP_MAX_RISE_FRAC`);
 *   - and no clinical control is decorative: `reducedMotion`, `effectIntensity`, `highContrast` and
 *     the HUD's minimum font sizes (including the CC-BY attribution) all hold at any canvas size.
 *
 * Pixel-level verification (fret proportions, strike-line uniformity, projection accuracy, miss and
 * hit feedback, the rolling-score odometer, frame cost) lives in `pixel-check.mjs` next to this
 * file: `node src/render/pixel-check.mjs` renders real frames in headless Chromium and asserts on
 * the framebuffer. It is not part of `vitest run` (it needs a browser binary) — the integrator
 * should wire it up as an npm script, `"check:render": "node src/render/pixel-check.mjs"`, so a
 * regression in the *look* is caught by CI and not only by someone reading this comment.
 */
import type { Judgment, LaneSpec } from '../engine/types';
import {
  BEAT_LINE_BAR,
  BEAT_LINE_BEAT,
  BEAT_LINE_SUB,
  DEFAULT_GEOMETRY_OPTIONS,
  FAR_FADE_FRAC,
  GEM_ASPECT,
  MAX_BEAT_LINES,
  RECEPTOR_WELL_RATIO,
  RECEPTOR_WELL_WIDTH_RATIO,
  clamp,
  depthAtY,
  depthOf,
  fillBeatLines,
  isVisibleDepth,
  laneBoundaryX,
  laneX,
  boardHardwareTop,
  makeGeometry,
  overlayPanelBox,
  projectInto,
  receptorWellSemiHeight,
  roadEdgeX,
  scaleAt,
  yAt,
  type HighwayGeometry,
  type OverlayPanelBox,
  type Projected,
} from './geometry';
import {
  BOARD_LINE_ALPHA,
  JUDGMENT_STYLE,
  UI_COLORS,
  getPalette,
  laneColor,
  mixHex,
  laneLabel,
  multiplierTier,
  withAlpha,
  type LaneColor,
  type LanePalette,
} from './palette';
import { PARTICLE_RING, PARTICLE_SMOKE, PARTICLE_SPARK, PARTICLE_STREAK, ParticlePool, emitHitBurst, makeRng } from './particles';
import { DEFAULT_MAX_GAP_SEC, DEFAULT_REARM_FRACTION, ReceptorHistory, copyReceptorLook, emptyReceptorLook, receptorGoalHolding, receptorMarkSet, type ReceptorLook } from './receptor';
import { SpriteCache, blit } from './sprites';
import { DigitRoller, TextCache, defaultCanvasFactory, fontPx, type Ctx2D, type TextStyle } from './text';
import type { CanvasLike, HighwayOptions, RenderFrame, RenderLaneState, RenderNote, RenderStats } from './types';

export const DEFAULT_HIGHWAY_OPTIONS: HighwayOptions = {
  ...DEFAULT_GEOMETRY_OPTIONS,
  highContrast: false,
  showLabels: true,
  showMissPopup: false,
  showStats: false,
  maxParticles: 600,
  effectIntensity: 1,
  reducedMotion: false,
};

/** Backward songTime jump (s) that is interpreted as a restart (effects/rolling state reset). */
export const RESTART_JUMP_SEC = 2;

/** One figure on the song-end screen: "142" / "movements performed". */
export interface FinaleStat {
  label: string;
  value: string;
}

/**
 * EVERY WORD OF THE ENDING, WRITTEN BY THE CALLER.
 *
 * The renderer animates this and invents nothing. A rehab ending has to be warm to a patient who
 * scored 300 points out of a possible 12 000, and the only place that knows what this particular
 * session is worth saying about is the session — see `GameRunner.finaleSpec`.
 */
export interface FinaleSpec {
  /** The banner: "SONG COMPLETE". */
  title: string;
  /** Usually the song title, so the payoff names what was just played. */
  subtitle?: string;
  /** The final score. The odometer rolls up to it and stops there — LAST, and small. */
  score: number;
  /**
   * Up to `FINALE_MAX_STATS` counts from the session, in reading order.
   *
   * `stats[0]` IS THE CARD'S HERO FIGURE — the biggest thing on the screen after the banner. The
   * caller puts the work there (movements performed); the score is drawn at a quarter of its size,
   * below the sentence, because this screen belongs to a rehab session and not to a scoreboard.
   */
  stats: FinaleStat[];
  /** ONE sentence about what this patient did today. Never a grade, never conditional on scoring. */
  achievement: string;
  /** A quieter second line under it (optional). */
  achievementNote?: string;
  /** "Tap anywhere, or press any key, for the report". */
  hint: string;
}

/**
 * How long the song-end sequence runs before it hands over to the report, and the shape of it.
 *
 * Six seconds is the length of a Guitar Hero / Rock Band end-of-song card, and it is short enough
 * that a therapist who does nothing is not kept waiting: it ends itself. Anyone in a hurry skips it
 * with a tap or any key after `FINALE_SKIP_GUARD_SEC`.
 */
export const FINALE_SEC = 6.6;
export const FINALE_SKIP_GUARD_SEC = 0.6;
/** Most stat columns the row can hold at the narrowest supported canvas (the hero is stats[0]). */
export const FINALE_MAX_STATS = 4;
const FINALE_CURTAIN_SEC = 0.5;
const FINALE_CURTAIN_ALPHA = 0.88;
const FINALE_TITLE_AT = 0.35;
/** The hero figure — movements performed — counts up first, because it is what the session was. */
const FINALE_HERO_AT = 0.95;
const FINALE_HERO_ROLL_SEC = 1.1;
const FINALE_STATS_AT = 1.95;
const FINALE_STAT_STEP_SEC = 0.18;
const FINALE_ACHIEVEMENT_AT = 2.6;
/** The score settles LAST and smallest — seen to arrive, never the thing the card is about. */
const FINALE_SCORE_AT = 3.2;
const FINALE_SCORE_ROLL_SEC = 1.4;
const FINALE_HINT_AT = 3.9;
/** The crowd throws the patient's own lane colours for this long. */
const FINALE_CONFETTI_SEC = 3.2;
/** Pieces per second at full `effectIntensity`. */
const FINALE_CONFETTI_RATE = 42;
/** Hard cap on live confetti, so the ending costs the same on a tablet as on a workstation. */
const FINALE_CONFETTI_MAX = 180;
/** Most the sequence may advance in one call — a backgrounded tab must not skip the payoff. */
const FINALE_MAX_STEP_SEC = 0.25;
const FINALE_PANEL_FILL = 'rgba(9, 12, 22, 0.94)';
const FINALE_PANEL_LINE = 'rgba(143, 180, 255, 0.35)';
const FINALE_RIBBON_FILL = 'rgba(255, 201, 69, 0.14)';
const FINALE_RIBBON_LINE = 'rgba(255, 201, 69, 0.55)';
/** First slot of `hudFit` the finale's strings own (the HUD title/attribution keep 0 and 1). */
const FINALE_FIT_BASE = 8;
/**
 * Lines the achievement's second line may wrap onto before it is cut.
 *
 * IT IS A WRAP, NOT AN ELLIPSIS, AND THAT IS THE WHOLE POINT. This line was drawn through
 * `TextCache.fit`, which truncates and does not shrink, so on the one occasion the game says "Full
 * range reached" the clause that makes the percentage honest — that it is of the range calibrated
 * for THAT movement TODAY, and not of a normal joint — was the part that got cut: measured at
 * 1024x768 it read "… — of the range calibrated fo…", leaving a bare "95 %" beside a limb name.
 * Four lines is more than the longest note this card can be handed (two clinical lane names, their
 * percentages, "and N more" and the qualifier) needs at the narrowest supported canvas, and the
 * panel grows to hold whatever comes back, so the cut below is a backstop and not the normal path.
 */
const FINALE_NOTE_MAX_LINES = 4;

/** "5,100" — the score as the HUD writes it, without pulling in `toLocaleString` per frame. */
function formatThousands(v: number): string {
  const n = Math.max(0, Math.round(v));
  const s = String(n);
  if (s.length <= 3) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += ',';
    out += s[i];
  }
  return out;
}
/** How long a missed gem takes to grey out, shrink and fade after the engine declares the miss. */
export const MISS_FIZZLE_SEC = 0.42;
/** Frame interval above which a frame counts as "long" (dropped at 60 Hz). */
export const LONG_FRAME_MS = 25;
/**
 * How far a note's `state` flip may be from its note time and still be treated as a fresh judgment
 * by the no-event fallback in `processHits` (early / late bounds, seconds). The late bound is well
 * inside the de-dupe map's retention window, so a note that lingers in `frame.notes` can never be
 * forgotten and then re-fire its effects.
 */
export const STATE_JUDGMENT_EARLY_SEC = 0.6;
export const STATE_JUDGMENT_LATE_SEC = 1;
/**
 * Clearance (in UI units) kept between a dying gem / miss puff and the bottom edge of the canvas.
 * The default geometry already puts the whole gem on screen at the latest possible miss verdict
 * (see `gemVisibleTailSec`); this is the backstop for a tuned `strikeY` / `pastLineSpeed` / a very
 * short canvas, so a judgment cue is never half-way off the board.
 */
export const MISS_CUE_MARGIN_U = 6;
/**
 * How far below the receptor's meter well a dying gem is walked over its fizzle, as a fraction of
 * its own half-height — see `missCueY`. 0.55 leaves rather more than half of it clear of the ring
 * that is now painted over it, which is what a low-vision patient at 2 m needs to see a shape at
 * all, without pushing the cue so far down the apron that it collides with the movement labels.
 */
export const MISS_CLEAR_FRAC = 0.55;
/**
 * How long the walk clear of the receptor takes, in seconds — a fraction of `MISS_FIZZLE_SEC`, not
 * the whole of it, because the gem is FADING while it walks (`alpha = (1 - k) * 0.75`): a cue that
 * only finishes arriving where it can be seen at the moment it becomes transparent has not been
 * seen. At 0.15 s the gem is clear while it still has ~two thirds of its opacity.
 */
export const MISS_CLEAR_SEC = 0.15;
/** Duration (s) of the receptor's re-arm pop — the moment a locked-out lane can fire again. */
export const REARM_POP_SEC = 0.28;

const MAX_LANES = 8;
/**
 * Judgment popup slots. Only one is ever *active* (see `spawnPopup`) — a shipped rhythm game shows
 * one judgment label at a time, in one place, and two overlapping "PERFECT!" instances over a
 * receptor read as a duplication bug, which is exactly what three blind critics called ours. The
 * ring is kept so a popup can still be replaced without allocating.
 */
const POPUP_SLOTS = 4;
/** Judgment popup lifetime (s). Short: it is redundant feedback sitting in the approach path. */
const POPUP_SEC = 0.5;

/** Opacity a judgment popup is retired at, rather than fading out into a ghost (see `drawPopups`). */
const POPUP_MIN_ALPHA = 0.38;

/** Song seconds the title / attribution block stays at full strength before it fades out. */
/**
 * Effort-gauge ramp. Deliberately NOT the old rock-meter palette (which started at alarm red): the
 * bottom of this scale means "few movements so far", which is information, not an emergency. Cool
 * blue → amber → green, so a low reading reads as early/quiet rather than as a warning.
 */
const EFFORT_METER_COLORS = { low: '#4aa3ff', mid: '#ffd23a', high: '#41e06a' };

const META_HOLD_SEC = 7;
/** Seconds the title / attribution block takes to fade out once `META_HOLD_SEC` has passed. */
const META_FADE_SEC = 1.6;
/** Popup anchor above the strike line, in receptor radii — clear of the receptor ring's top. */
const POPUP_BASE_R = 1.0;
/** How far a popup (anchor + rise) may sit above the strike line, as a fraction of horizon→strike. */
export const POPUP_MAX_RISE_FRAC = 0.26;
/** Popup float distance over its life, in receptor radii (a third of that under reduced motion). */
const POPUP_RISE_R = 0.35;
/** How far up the board a lane flash reaches, as a fraction of the strike→horizon span. */
const LANE_FLASH_REACH = 0.5;
/** Half-height of the strike line glow band, in UI units. */
const STRIKE_BAND_H = 16;

/**
 * Gem opacity once it has materialised at the far end of the board (see `drawNotes`). A gem is
 * information — the patient is reading the chart from it — so it holds near full opacity for the
 * whole runway, while the road surface under it still dissolves into the backdrop.
 */
const GEM_FAR_ALPHA = 0.85;
/** Fraction of the board's dissolve band over which a gem ramps up from nothing to `GEM_FAR_ALPHA`. */
const GEM_FADE_IN_FRAC = 0.35;
/** Beat-ladder subdivision: 2 = an eighth-note hairline between every pair of beat lines. */
const BEAT_SUBDIVISIONS = 2;
/** Ladder stroke passes, faintest first so heavier rungs land on top. */
const BEAT_LINE_PASSES = [BEAT_LINE_SUB, BEAT_LINE_BEAT, BEAT_LINE_BAR];
/** Fade-gradient cache keys (built once; `grad()` clears them on geometry / palette change). */
const LADDER_KEYS = ['ladderBeat', 'ladderBar', 'ladderSub'];
const RAIL_KEYS = ['rail1', 'rail2', 'rail3', 'rail4', 'railBase'];
const RAIL_GLOW_KEYS = ['railGlow1', 'railGlow2', 'railGlow3', 'railGlow4'];
const LANE_WASH_KEYS = Array.from({ length: MAX_LANES }, (_, i) => `wash${i}`);
/** Lane wash strength: enough for lane identity at 2 m, far too little to compete with a gem. */
const LANE_WASH_ALPHA = 0.075;
/** Alpha bands used to batch fading particle streaks (one path + stroke per non-empty band). */
const STREAK_ALPHA_BANDS = 4;
const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const WHITE_COLOR_INDEX = 250;
const MISS_COLOR_INDEX = 251;
const BEAM_SPRITE_W = 128;
const BEAM_SPRITE_H = 256;
const BEAM_HEX = ['#aab4ff', '#6eff8c', '#78aaff', '#ffd65a'];

/** Where the front row of the crowd stands, as a fraction of canvas height. */
const CROWD_BASE_FRAC = 0.78;
/** Height of the crowd band (head-and-shoulders of both ranks), as a fraction of canvas height. */
const CROWD_H_FRAC = 0.2;
// Static gradient-cache keys (avoid building strings on the hot path).
const BAND_KEYS = ['band1', 'band2', 'band3', 'band4'];
const BADGE_KEYS = ['badge1', 'badge2', 'badge3', 'badge4'];
const FLASH_KEYS = Array.from({ length: MAX_LANES }, (_, i) => `flashHit${i}`);
const METER_KEYS = Array.from({ length: MAX_LANES }, (_, i) => `meter${i}`);
const METER_HOT_KEYS = Array.from({ length: MAX_LANES }, (_, i) => `meterHot${i}`);
/** Locked-out (hysteresis) meter fill — dead grey, never the lane colour. */
const METER_LOCK_KEY = 'meterLocked';
/**
 * "Lower to reset" hint colour (re-arm line, chevron, return-to-rest arc). Violet on purpose: no
 * lane in either palette is violet (GH green/red/yellow/blue, high-contrast cyan/orange/magenta/
 * lime), so a nearly-complete arc around a locked ring can never be mistaken for a lit lane ring —
 * which the previous warm gold `#ffcf5a` was, at 2 m, on the yellow lane (`#f6d431`).
 */
const LOCK_HINT_COLOR = '#c08cff';
/**
 * Ceiling on the liquid column, as a fraction of the well's height — the same in EVERY state,
 * because the column is a position gauge and the patient's position does not change meaning with
 * the lane's arming.
 *
 * It is a drawing constraint, not a semantic one: the well is an ellipse, so a column drawn flush
 * to the very top has almost no width there, and the hard-edged cap bar that rides its top edge
 * (the split white cap in (b), the violet drain cap in (c)) would be clipped to a few pixels
 * exactly when the patient is at their fullest range. At 0.93 the cap is still ~half the well's
 * width. The value that reaches it is full calibrated ROM, so nothing readable is lost below it.
 *
 * THERE USED TO BE A SECOND, LOWER CEILING ON LOCKED LANES ONLY (0.9 of the target height), so a
 * locked column could never reach the height that means "at the trigger point". It cost far more
 * than it bought: combined with a `fill` clamped at 1 it froze the column — and with it the drain
 * cap, the chevron and the return-to-rest arc — for every value between the threshold and full ROM,
 * i.e. for 71 % of the return journey on the default 'easy' difficulty. The patient who has just
 * been told "lower to reset" started lowering and the gauge did not move. What (c) may never wear
 * is the "this counts" MARK SET (target line, posts, level line, hot fill, halo, rim, corona) — and
 * it does not; the height itself is just where the patient is.
 */
const METER_LEVEL_CEIL = 0.93;
/**
 * ROM → height, and the ONLY map from a measurement to a position in the well: a value of `rom`
 * (fraction of calibrated ROM) sits at `rom * METER_LEVEL_CEIL` of the well's height. Full ROM is
 * the ceiling, 0 is the floor, and everything between is proportional — so the target line lands at
 * `thresholdFraction * METER_LEVEL_CEIL`, the re-arm line at `thresholdFraction * rearmFraction *
 * METER_LEVEL_CEIL`, and a given number of millimetres of movement is the same number of pixels
 * wherever in the range the patient makes it.
 *
 * IT USED TO BE TWO SCALES EITHER SIDE OF A FIXED TARGET LINE, and that was a second frozen zone
 * hiding behind the same "one scale" claim this comment used to make. The line sat at a fixed 0.76
 * of the well whatever the threshold was, which left 0.17 of the well for ALL the ROM above it: on
 * the default 'easy' difficulty (thresholdFraction 0.5) half the patient's range was drawn at
 * 4.5x the compression of the other half. Measured on real pixels at 1920x1080, a locked lane
 * lowering from full ROM to the threshold moved the column top 27 px in total — 2 px per 0.05 of
 * ROM, i.e. 0.4 px on a 10" clinic tablet read at 2 m, for the exact span (71 % of the return
 * journey at that difficulty) whose motion is the point of state (c).
 *
 * The line moving with the session's threshold is not a cost, it is the prescription made visible:
 * an easy session's target line is low on the well and a hard one's is near the top, and either way
 * "how much further" is the same distance per millimetre for the rise and for the return.
 */
function meterPos(rom: number): number {
  return clamp(rom, 0, 1) * METER_LEVEL_CEIL;
}
/**
 * Ring scale while the lane is locked out. The 12 % shrink is one of the marks of (c); it is
 * reached by gliding over the tail of the goal latch (`ReceptorLook.goal`) rather than by stepping,
 * so the gauge does not visibly shrink at the exact instant the patient reaches their target.
 */
const LOCK_RING_SCALE = 0.88;
/**
 * Length of one arm of the goal arrowheads that replace the threshold gate posts in state (b), and how
 * far the pair is inset toward the ring, both in receptor radii. They are solid triangles pointing
 * at the target line from outside the ring: a SHAPE change (and a much larger filled area) where
 * (a) has two thin bars, so "you reached it" survives the 1280 → 220 px downscale a low-vision
 * patient at 2 m effectively applies, in either palette, without depending on hue or on the thin
 * additive rings.
 */
const GOAL_WEDGE_R = 0.34;
/**
 * How far outside the ring a mark hung at the TARGET HEIGHT may reach, in receptor radii.
 *
 * The threshold gate posts and the goal arrowheads are anchored flush to the ring's outline at the
 * target line, so how far out they start depends on where that line is: near the ring's vertical
 * centre the outline is at ~1.0 r, near the top or bottom it is much narrower. Now that the target
 * line follows the session's threshold (see `meterPos`) that anchor moves, and at a mid-range
 * threshold it sits at the ring's widest point — where a fixed-length mark would cross into the
 * neighbouring lane. Half a lane is 1.21 r at the board's widest geometry (`GEM_LANE_FRACTION` /
 * `RECEPTOR_GEM_RATIO` in geometry.ts), so two adjacent lanes' marks would have touched and two
 * adjacent arrowheads would have merged into one blob across the gutter — turning a per-lane mark
 * into a shelf joining the receptors, which is the opposite of "which lane is at target".
 *
 * So the marks grow inward from an outer limit instead of outward from a moving inner one: their
 * LENGTH gives way, their reach does not. The limit is the room the lane actually has — half a lane
 * less this margin — rather than a fixed number of radii, so a board whose lanes are wide relative
 * to its receptors (a 2-lane session, or a tall narrow window where the gem's height cap binds
 * first) keeps the full-length marks. Only the horizontal extent is ever clamped: an arrowhead's
 * height has nothing above or below it to collide with, so it keeps its blob-at-2-m area by staying
 * as tall as it ever was.
 */
const TARGET_MARK_MARGIN = 0.06;
/** Ground of the meter well: flat and dark, so the liquid's top edge is a hard step, not a bevel. */
const METER_WELL_COLOR = '#080a12';
/** Threshold (target) line and the white-hot level cap at the trigger point. */
const TARGET_LINE_COLOR = '#ffffff';
/**
 * The target line is drawn as `TARGET_DASH_COUNT` dashes (with equal gaps) spanning
 * `TARGET_DASH_SPAN` of the well's half-width either side of centre — see the drawing site for why
 * it is dashed at all. The span stops short of the well's edge so the outermost dash cannot line up
 * with the gate post just outside the ring at the same height and read as one continuous run.
 */
const TARGET_DASH_COUNT = 5;
const TARGET_DASH_SPAN = 0.72;
/**
 * "No signal" ring colour (tracking lost). Deliberately a *light* neutral grey: the locked-out ring
 * is the palette's dead dark grey, so at 2 m the two never read as the same thing.
 */
const LOST_RING_COLOR = '#a9b0bb';
/**
 * Return-to-rest arc: a CRESCENT UNDER THE RECEPTOR. It starts just below the right-hand end of the
 * strike line, sweeps clockwise through the bottom of the ring and ends just below the left-hand
 * end — 0.88π at most, entirely inside the lower half.
 *
 * IT USED TO SPAN 1.5π, AND THAT IS THE ONE PLACE (c) FAILED ITS OWN "COUNT, NOT BRIGHTNESS" CLAIM.
 * The arc is drawn at `outerMarkRadius` — the SAME radius family as (b)'s goal corona — so a locked
 * lane at `resetProgress >= ~0.85` drew a nearly closed second ring outside its own: at the 220 px
 * downscale a 10" clinic tablet at 2 m is worth, (c) and (b) then both read as TWO CONCENTRIC
 * RINGS, and the only thing left separating them was the arc's open top quarter and a lower alpha —
 * i.e. exactly the brightness cue the four-state model is not allowed to rest on. It is a ≤0.1 s
 * window right before the re-arm, but it is a window in which the display says "you reached your
 * target" to a patient who did not.
 *
 * Bounded to the lower half it cannot become a ring at ANY progress or any blur: the top half of a
 * locked receptor shows one ring where a goal receptor shows two, which is a mark COUNT that
 * survives the downscale, a luminance-only reduction and both palettes. Keeping it clear of the
 * horizontal by 0.06π also keeps its two ends off the board-wide white strike line, which a
 * half-circle sitting exactly on its diameter would have merged with into a closed "D".
 *
 * Exported so the tests measure the shipped shape rather than a copy of the number.
 */
export const RESET_ARC_START = Math.PI * 0.06;
export const RESET_ARC_SWEEP = Math.PI * 0.88;
/**
 * Nominal radius, in receptor radii, of the two marks drawn OUTSIDE the ring: the return-to-rest arc
 * of (c) and the goal corona of (b). Nominal because it is a wish, not a promise — `outerMarkRadius`
 * clamps it to the room the lane actually has.
 */
const OUTER_MARK_R = 1.16;
/**
 * Largest radius a ring-shaped mark centred on a receptor may be drawn at, given its stroke width,
 * so that its OUTER edge still lands inside this lane's half of the board.
 *
 * LANE CONTAINMENT IS PART OF THE CONTRACT, and it was enforced for the target marks and the goal
 * arrowheads (`TARGET_MARK_MARGIN`) and not for these two. At `OUTER_MARK_R` with a stroke of up to
 * `r * 0.12` the arc reaches ~1.22 r, and half a lane is ~1.21 r at the board's widest geometry
 * (`GEM_LANE_FRACTION` / `RECEPTOR_GEM_RATIO`): measured on real pixels the arc overran its lane by
 * 2–4 px at every geometry, so four locked lanes descending together drew four violet arcs that
 * crossed in the gutters and read as ONE scalloped ribbon spanning the board — the receptors joined
 * into a shelf, which is precisely the failure the mark margin exists to prevent. Two adjacent lanes
 * crossing threshold on the same chord did the same, briefly, with their coronas.
 *
 * So the radius gives way instead. `reach` is half a lane less the mark margin; the floor keeps the
 * mark outside the ring it belongs to (it can never bind on a real board — the geometry guarantees
 * half a lane ≥ 1.2 r — but a synthetic geometry must degrade to "touching the ring", never to
 * "inside the neighbour").
 */
function outerMarkRadius(r: number, laneWidthNear: number, lineWidth: number): number {
  const reach = laneWidthNear * 0.5 - Math.max(2, r * TARGET_MARK_MARGIN);
  return Math.max(r, Math.min(r * OUTER_MARK_R, reach - lineWidth * 0.5));
}
/** Arc segments of the broken "no signal" ring, and the gap between them in radians. */
const LOST_RING_SEGMENTS = 4;
const LOST_RING_GAP_RAD = 0.52;
/**
 * Rotation of the broken ring's segments. Without it the four gaps sit at 0, π/2, π and 3π/2, so
 * the left and right ones land exactly where the white strike line crosses the receptor and are
 * visually bridged by it — a broken ring that reads as a solid one is not a distinct state.
 */
const LOST_RING_PHASE = Math.PI / 4;
/** Breathing rate (rad/s) of the "no signal" ring — slow, unrelated to the beat, off under reduced motion. */
const LOST_BREATHE_RATE = 2.4;
/**
 * WHY a receptor is showing "no reading". All three draw the SAME broken ring — the mark set is the
 * patient's remedy and none of these three has one — and differ only in the glyph inside it, which
 * is a mark for whoever is standing at the tablet:
 *   'lost'      "?"  the tracker has no landmarks: get back in frame (the patient's move);
 *   'fault'     "!"  this lane cannot measure at all this session (`setLaneFaults`): the
 *                    therapist's move, and the words are in the play screen's alert panel;
 *   'suspended' ❚❚   the session is not accepting input: nothing counts until it is resumed.
 * See `drawLostReceptor` and `ReceptorLook.suspended`.
 */
type LostReason = 'lost' | 'fault' | 'suspended';

/**
 * How long the SONG clock may stand still, in wall-clock seconds, before the receptor stops timing
 * itself by it.
 *
 * Every other effect in this renderer is keyed to song time on purpose — a pause must freeze the
 * gems, the bursts and the popups where they are. The receptor is the exception, and it is not a
 * style choice: its three timers (`GOAL_HOLD_SEC`, `LOST_HOLD_SEC` and the input layer's
 * `maxGapSec`) are PERCEPTION and EVIDENCE windows measured on the patient, not on the music, and
 * the lane states feeding them keep arriving while the song clock is stopped (`GameRunner.draw`
 * passes `input.getLaneStates()` live on every frame, paused or not).
 *
 * Frozen, those three timers all fail in the same direction — toward a stale claim that cannot
 * expire. A therapist hits pause (or the browser suspends the AudioContext, which is the same thing
 * to this renderer) and: a goal latch lit just before the stop is held at full strength for the
 * whole pause and then finishes its remaining 0.45 s AFTER the resume, long after the rep;
 * `LOST_HOLD_SEC` never elapses, so a patient who leaves frame (or a camera that is unplugged)
 * during the pause leaves a live-looking gauge standing at their last value instead of "I cannot
 * see you"; and the gap rule that expires the crossing evidence — the one thing standing between an
 * occlusion recovery and a full goal celebration for a rep that never fired — cannot fire either,
 * because it measures its window on the same stopped clock.
 *
 * So the receptor runs on `Highway.receptorT`: song time while the song clock is moving, wall time
 * while it is not. The threshold is far above any legitimate audio-clock quantization (128-sample
 * quanta are ~2.7 ms) and far below the window in which a stale cue becomes a lie.
 */
const SONG_CLOCK_STALL_SEC = 0.2;

/**
 * One piece of end-of-song confetti.
 *
 * NOT `ParticlePool`. The pool is drawn with the rest of the board, which the ending's curtain then
 * puts 88 % of black over: measured at 1280x800, the crowd's colours were there in the pixels and
 * invisible on the screen. The celebration has to be ON TOP of the curtain, so it is its own tiny
 * system with its own draw pass — bounded, allocated once, and alive for six seconds a session.
 */
interface ConfettiBit {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  life: number;
  color: string;
  size: number;
  spin: number;
}

interface Popup {
  active: boolean;
  judgment: Judgment;
  t0: number;
  x: number;
  y: number;
  lane: number;
}

function now(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
}

function easeOutCubic(t: number): number {
  const u = 1 - clamp(t, 0, 1);
  return 1 - u * u * u;
}

function roundRectPath(ctx: Ctx2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

const byTimeDesc = (a: RenderNote, b: RenderNote): number => b.time - a.time;

export class Highway {
  readonly canvas: CanvasLike;
  private ctx: Ctx2D | null;
  private opts: HighwayOptions;
  private geom: HighwayGeometry;
  private width = 1;
  private height = 1;
  private dpr = 1;
  /** True once a logical size has been established (see sizing rules in the header). */
  private sized = false;
  /** UI scale unit (1 at 1280x720). */
  private u = 1;
  private palette: LanePalette;

  private readonly factory: (w: number, h: number) => CanvasLike;
  private readonly sprites: SpriteCache;
  private readonly text: TextCache;
  private readonly digits: DigitRoller;
  private readonly particles: ParticlePool;
  private readonly rng = makeRng(0xbeef);

  // Static backdrop (arena: gradient, haze, stage glow, truss, PA stacks) + the crowd silhouette
  // band, which is a separate layer because it bobs on the beat.
  private bgLayer: CanvasLike | null = null;
  private crowdLayer: CanvasLike | null = null;

  /** Locked-lane ring colours, memoized by the live lane colour's base hex (see `lockedColor`). */
  private lockedColors = new Map<string, LaneColor>();

  // Cached CanvasGradient objects (static per geometry / palette); alpha is applied via globalAlpha.
  private grads = new Map<string, CanvasGradient>();

  // Effect state.
  /**
   * noteId → songTime at which this note's judgment feedback was produced. Written by whichever
   * arrives first: a `HitEvent` in `recentHits`, or a note whose `state` the integrator flipped to
   * hit/miss. Purely a de-dupe ledger, so the two paths can never both fire *and* can never both
   * stay silent (the old code shared this map with the miss fizzle clock, which made a state flip
   * one frame ahead of the event swallow the miss burst and lane tint entirely).
   */
  private seenHits = new Map<number, number>();
  /** noteId → songTime the miss fizzle started (separate clock from the de-dupe ledger above). */
  private missT0 = new Map<number, number>();
  /**
   * Song time each lane's flash started. Float64 on purpose: a Float32Array would round the stored
   * song time (e.g. 6.28 → 6.28000020980835) and make `songTime - laneFlashT0[lane]` come out
   * *negative* on the very frame the flash is created — which used to clear it before it ever drew,
   * silently dropping the hit / miss lane tint on roughly half of all judgments.
   */
  private laneFlashT0 = new Float64Array(MAX_LANES).fill(-10);
  private laneFlashKind = new Uint8Array(MAX_LANES); // 0 none, 1 hit, 2 miss
  private laneGlow = new Float32Array(MAX_LANES);
  /** Last frame's `armed` flag per lane (1 = armed), for the re-arm pop. */
  private laneArmed = new Uint8Array(MAX_LANES).fill(1);
  /** Song time each lane last became able to fire again (hysteresis re-arm). */
  private laneRearmT0 = new Float64Array(MAX_LANES).fill(-10);
  /** Scratch receptor state, refilled per lane per frame (see receptor.ts). */
  private readonly look: ReceptorLook = emptyReceptorLook();
  /**
   * The per-lane memory the four-state model needs: the threshold-crossing latch that makes state
   * (b) reachable at all, and the anti-strobe hold before a lane admits it has lost tracking. See
   * receptor.ts — neither can be decided from one frame of `LaneState`.
   */
  private readonly history = new ReceptorHistory();
  /**
   * Effective (post-hold) tracking per lane, as `drawReceptors` resolved it this frame. Read by
   * `drawLabels` so the label under a receptor never disagrees with the receptor above it.
   */
  private laneTracking = new Uint8Array(MAX_LANES).fill(1);
  /**
   * Lanes the INPUT LAYER has reported cannot produce a rep at all this session, whatever the
   * patient does — see `setLaneFaults`. 1 = faulted.
   */
  private laneFault = new Uint8Array(MAX_LANES);
  /**
   * The look each lane was DRAWN FROM this frame, published for the other live meters on screen —
   * see `receptorLookOf`. Allocated once per lane, overwritten in place.
   */
  private readonly laneLooks: ReceptorLook[] = [];
  /** How many entries of `laneLooks` this frame actually resolved (lane count can change). */
  private laneLooksCount = 0;
  /** lane → index into frame.laneStates / frame.lanes for this frame (see `resolveLaneMaps`). */
  private stateIdx = new Int8Array(MAX_LANES);
  private specIdx = new Int8Array(MAX_LANES);
  private warnedLaneMap = false;
  /** Scratch projection, refilled per note per frame (no object per note). */
  private readonly proj: Projected = { x: 0, y: 0, scale: 1, radius: 0 };
  private popups: Popup[] = [];
  private lastCombo = 0;
  /** Scratch for the allocation-free de-dupe/fizzle map pruning (see `prune*` below). */
  private pruneNow = 0;
  private pruneKeep = 3;
  private lastComboShown = 0;
  /** Cached `String(combo)` so the per-frame combo draw does not allocate a string. */
  private comboStr = '0';
  private comboStrN = -1;
  private comboBounceT0 = -10;
  private comboBreakT0 = -10;
  private lastMultiplier = 1;
  private multiplierPopT0 = -10;
  private displayScore = 0;
  private healthSmooth = 1;
  /** The song-end sequence, once the chart has run out. Null for the whole rest of the song. */
  private finale: FinaleSpec | null = null;
  /** Seconds it has been on screen, on the renderer's WALL clock: the song's may have stopped. */
  private finaleT = 0;
  /** Confetti emission accumulator (pieces are spawned at a rate, not per frame). */
  private finaleConfettiT = 0;
  /** Seconds the last `advanceFinale` moved it, so the confetti runs on the same clock as the beats. */
  private finaleStep = 0;
  /** The crowd. Grown to `FINALE_CONFETTI_MAX` once and then recycled in place. */
  private finaleBits: ConfettiBit[] = [];
  /** Lane colours as hex, resolved once when the ending starts. */
  private finaleColors: string[] = [];
  /** `wrapFinaleNote`'s cache: the note changes once a session, the wrap costs a measure per word. */
  private finaleNoteKey = '';
  private finaleNoteLines: string[] = [];
  private lastSongTime: number | null = null;
  /**
   * Sanitized song time for the frame being drawn. Every internal draw step reads this instead of
   * `frame.songTime`, so one non-finite value out of the audio clock (`ctx.currentTime -
   * songStartCtxTime` before the start time is armed) cannot reach any smoothed accumulator.
   */
  private stNow = 0;
  /**
   * The receptor's clock (seconds, monotone): song time while the song clock advances, wall time
   * while it is stopped. See `SONG_CLOCK_STALL_SEC` — the receptor's timers are perception windows
   * measured on the patient, and the patient does not pause with the song.
   */
  private receptorT = 0;
  /** Wall seconds the song clock has stood still for (0 while it is advancing). */
  private songStillSec = 0;
  private warnedThreshold = false;
  private lastDrawWall = -1;
  private sortBuf: RenderNote[] = [];
  private beatTimes = new Float64Array(MAX_BEAT_LINES);
  private beatBars = new Uint8Array(MAX_BEAT_LINES);
  private colorBatch = new Uint16Array(64);

  private stats: RenderStats = {
    drawMs: 0,
    avgDrawMs: 0,
    maxDrawMs: 0,
    frameMs: 0,
    avgFrameMs: 0,
    fps: 0,
    longFrames: 0,
    frames: 0,
    notesDrawn: 0,
    particles: 0,
    sprites: 0,
  };

  constructor(canvas: CanvasLike, options: Partial<HighwayOptions> = {}) {
    this.canvas = canvas;
    this.opts = { ...DEFAULT_HIGHWAY_OPTIONS, ...options };
    this.factory = this.opts.createCanvas ?? defaultCanvasFactory;
    this.ctx = canvas.getContext('2d', { alpha: false }) ?? canvas.getContext('2d');
    this.sprites = new SpriteCache(this.factory);
    this.text = new TextCache(this.factory, 320);
    this.digits = new DigitRoller(this.factory);
    this.particles = new ParticlePool(this.opts.maxParticles);
    this.palette = getPalette(this.opts.highContrast);
    this.geom = makeGeometry(1, 1, 4, this.opts);
    for (let i = 0; i < POPUP_SLOTS; i++) this.popups.push({ active: false, judgment: 'good', t0: 0, x: 0, y: 0, lane: 0 });
    this.resize();
  }

  /** Decorative effect scale 0..1 (`effectIntensity`, clamped). */
  private get eff(): number {
    return clamp(this.opts.effectIntensity, 0, 1);
  }

  /**
   * Alpha scale for *judgment feedback* (lane flash, miss tint, popups). Follows `effectIntensity`
   * but never drops below 0.55 — a calmer presentation must still be an unmistakable one.
   */
  private get coreEff(): number {
    return 0.55 + 0.45 * this.eff;
  }

  /**
   * The `ReceptorLook` lane `lane` was DRAWN FROM on the last frame — the one thing every other
   * live meter in the patient's field of view has to agree with.
   *
   * ONE VOICE, AND WHY AGREEING IS NOT ENOUGH. The play screen's picture-in-picture lane meters
   * (src/ui/Play.tsx) sit ~300 px from the receptor row and show the same four states. They used to
   * run their own `ReceptorHistory` on `performance.now()`, which is the same MODEL but not the
   * same CLOCK: this renderer times the receptor on `receptorT`, which stands still for up to
   * `SONG_CLOCK_STALL_SEC` whenever the song clock stalls. So the goal latch, the `LOST_HOLD_SEC`
   * hold and the gap rule could be up to 0.2 s out of step between two meters whose entire contract
   * is that they cannot contradict each other — a patient could be shown "you reached it" on one
   * and "lower to reset" on the other, at the instant that matters most. Reading the drawn look
   * removes the class of failure rather than narrowing it: there is one model, one clock, one set
   * of numbers, and the second meter is at worst one animation frame behind the first.
   *
   * Returns undefined before the first draw, or for a lane outside the current lane count. The
   * object is owned by the renderer and reused every frame — read it, never keep or mutate it.
   */
  receptorLookOf(lane: number): Readonly<ReceptorLook> | undefined {
    if (!Number.isInteger(lane) || lane < 0 || lane >= this.laneLooksCount) return undefined;
    return this.laneLooks[lane];
  }

  /**
   * Lanes that STRUCTURALLY CANNOT FIRE — the input layer knows it, and until now the receptor had
   * no vocabulary for it.
   *
   * `LaneState` reports what the patient is doing; it does not report whether the machinery under it
   * works. A lane whose calibration `VisionInput` REFUSED publishes `{ value: 0, armed: true,
   * triggerState: 'armed', tracking: true }` for the whole session — which is a perfectly formed
   * state (a): "rising, armed, ready", at an empty meter, for a lane that will emit nothing for
   * three minutes. A lane the pinned-lane watchdog has given up on is the same class of thing from
   * the other end: it publishes a locked lane, so the receptor says "lower to reset" — an order the
   * patient carries out and the meter does not answer, for as long as they keep trying.
   * `VisionInput.getStatus()` names both (`invalidCalibrationLanes`, `pinnedLanes`) in
   * plain language, and nothing on the play screen used to read it.
   *
   * THE HONEST DRAWING FOR THEM IS (d), NOT A FIFTH STATE. The four mark sets are the patient's four
   * remedies, and a faulted lane has no patient-side remedy at all: there is no measurement worth
   * gauging from, which is exactly what (d) says and exactly why (d) draws nothing value-derived. So
   * a faulted lane is handed to the receptor's state model as a lane with NO `LaneState` — it reads
   * as (d) through the same path, the same anti-strobe hold and the same classifier, so the
   * picture-in-picture meters agree with it for free (`receptorLookOf`). What changes is the glyph
   * inside the broken ring: "!" rather than "?", because "get back in frame" is the wrong remedy and
   * the therapist is the one who has to act. At the 220 px acuity proxy the two are the same mark set
   * — which is correct, they are the same instruction to the patient — and the WORDS belong on the
   * play screen, from `getStatus().warnings`, where a therapist reads them.
   *
   * NOT `unreachableLanes`: that lane is measuring the patient correctly and simply falling short,
   * which is what (a) is for — a graded "how much further" readout is the honest answer and the one
   * the therapist needs to see. It is a warning to read, not a fault to draw.
   *
   * Pass an empty array (or null) to clear. Out-of-range entries are ignored.
   */
  setLaneFaults(lanes: readonly number[] | null | undefined): void {
    this.laneFault.fill(0);
    if (!lanes) return;
    for (const raw of lanes) {
      if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
      const lane = Math.round(raw);
      if (lane >= 0 && lane < MAX_LANES) this.laneFault[lane] = 1;
    }
  }

  /** Current geometry (rebuilt on resize / lane-count change). */
  get geometry(): HighwayGeometry {
    return this.geom;
  }

  get options(): Readonly<HighwayOptions> {
    return this.opts;
  }

  /** Logical (CSS px) size and DPR currently in use. */
  get size(): { width: number; height: number; dpr: number } {
    return { width: this.width, height: this.height, dpr: this.dpr };
  }

  /**
   * Update tunables at runtime (palette, approach speed, effect intensity, particle budget, ...).
   * Every option in `HighwayOptions` takes effect on the next `draw()`, and each is rebuilt at its
   * own cost: only a palette change drops the sprite cache, only a geometry change re-bakes the
   * background, and only `maxParticles` reallocates the pool. Everything else (effectIntensity,
   * reducedMotion, showLabels, showMissPopup, showStats) is free, so it is safe to drive from a
   * therapist-facing slider at pointer-move rate. `createCanvas` is fixed at construction and is
   * ignored here.
   */
  setOptions(patch: Partial<HighwayOptions>): void {
    const prev = this.opts;
    const next = { ...prev, ...patch };
    this.opts = next;
    // Only rebuild what actually changed. `effectIntensity`, `reducedMotion`, `showLabels`,
    // `showMissPopup` and `showStats` are therapist-facing *runtime* controls — a slider bound to
    // effectIntensity fires this on every pointer move, and the old unconditional rebuild
    // allocated ~12 scratch canvases per call (full-screen background + two star tiles + re-baked
    // sprites and text) and threw away every cache the frame was about to use.
    const paletteChanged = next.highContrast !== prev.highContrast;
    const geomChanged =
      next.approachSec !== prev.approachSec ||
      next.horizonY !== prev.horizonY ||
      next.strikeY !== prev.strikeY ||
      next.farScale !== prev.farScale ||
      next.roadWidth !== prev.roadWidth ||
      next.pastLineSpeed !== prev.pastLineSpeed;
    if (paletteChanged) {
      this.palette = getPalette(next.highContrast);
      this.sprites.clear();
      // Text sprites are keyed by colour, so they need no flush; the *style* objects and the fitted
      // lane labels are per-palette and do.
      this.styleCache.clear();
      this.labelKeyPalette = '';
      this.labelText.length = 0;
    }
    if (paletteChanged || geomChanged) this.grads.clear();
    if (next.maxParticles !== prev.maxParticles) this.particles.setCapacity(next.maxParticles);
    if (geomChanged) {
      this.rebuildGeometry(this.geom.laneCount);
      // The background layer bakes in the horizon position and the canvas size, so any change to
      // horizonY / strikeY / farScale / roadWidth leaves a stale haze blob floating in the sky.
      this.buildBackground();
    }
  }

  getStats(): RenderStats {
    return { ...this.stats };
  }

  resetStats(): void {
    this.stats.avgDrawMs = 0;
    this.stats.maxDrawMs = 0;
    this.stats.longFrames = 0;
    this.stats.avgFrameMs = 0;
    this.stats.fps = 0;
    this.lastDrawWall = -1;
  }

  /**
   * Clear all transient animation state: seen hit ids, particles, popups, lane flashes / glow,
   * rolling score, smoothed health, combo & multiplier pop timers. Call when a song (re)starts
   * with the same Highway instance. Draw stats and caches are kept.
   */
  reset(): void {
    this.seenHits.clear();
    this.missT0.clear();
    this.particles.clear();
    for (const p of this.popups) p.active = false;
    this.laneFlashT0.fill(-10);
    this.laneFlashKind.fill(0);
    this.laneGlow.fill(0);
    this.laneArmed.fill(1);
    this.laneRearmT0.fill(-10);
    this.laneTracking.fill(1);
    // The published looks are a record of what was DRAWN; nothing has been drawn since the reset,
    // so no other meter may go on reading them (see `receptorLookOf`).
    this.laneLooksCount = 0;
    this.history.reset();
    // `receptorT` is deliberately NOT rewound: it is a monotone perception clock, and every timer
    // read off it (`laneRearmT0`, the history's own stamps) is cleared here instead.
    this.songStillSec = 0;
    this.lastCombo = 0;
    this.lastComboShown = 0;
    this.comboBounceT0 = -10;
    this.comboBreakT0 = -10;
    this.lastMultiplier = 1;
    this.multiplierPopT0 = -10;
    this.displayScore = 0;
    this.healthSmooth = 1;
    this.lastSongTime = null;
    // A restart on the same instance is a NEW run, so last run's ending must not still be playing
    // over it (a `?seed=` re-run from the results screen reuses this Highway).
    this.finale = null;
    this.finaleT = 0;
    this.finaleConfettiT = 0;
    this.finaleStep = 0;
    for (const b of this.finaleBits) b.age = b.life;
    this.stats.particles = 0;
    this.stats.notesDrawn = 0;
  }

  /**
   * Resize the backing store. See the sizing rules in the file header. Idempotent *and cheap*:
   * when the logical size, DPR and backing store are all unchanged the call returns before
   * re-baking the background (a full-screen canvas plus two star tiles, ~130 radial gradients) and
   * before dropping the text cache — window-drag resize storms are free after the first event.
   */
  resize(width?: number, height?: number, dpr?: number): void {
    const c = this.canvas as CanvasLike & { clientWidth?: number; clientHeight?: number };
    const ratio = clamp(dpr ?? (typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 1), 0.5, 4);
    let w = width;
    let h = height;
    if (w === undefined || h === undefined) {
      if (typeof c.clientWidth === 'number' && c.clientWidth > 0 && typeof c.clientHeight === 'number' && c.clientHeight > 0) {
        w = c.clientWidth;
        h = c.clientHeight;
      } else if (this.sized) {
        // No CSS size: keep the established logical size, never re-derive it from the attributes.
        w = this.width;
        h = this.height;
      } else {
        // First sizing of an un-styled / offscreen canvas: its attribute size *is* the backing store.
        w = Math.max(1, c.width / ratio);
        h = Math.max(1, c.height / ratio);
      }
    }
    const lw = Math.max(1, Math.floor(w));
    const lh = Math.max(1, Math.floor(h));
    const bw = Math.round(lw * ratio);
    const bh = Math.round(lh * ratio);
    if (this.sized && lw === this.width && lh === this.height && ratio === this.dpr && c.width === bw && c.height === bh) {
      return; // Nothing changed — don't reallocate the background layers or wipe the text cache.
    }
    this.width = lw;
    this.height = lh;
    this.dpr = ratio;
    this.sized = true;
    if (c.width !== bw) c.width = bw;
    if (c.height !== bh) c.height = bh;
    this.u = clamp(Math.min(this.width / 1280, this.height / 720), 0.35, 2.5);
    this.text.dpr = this.dpr;
    this.text.clear();
    this.rebuildGeometry(this.geom.laneCount);
    this.buildBackground();
  }

  private rebuildGeometry(laneCount: number): void {
    this.geom = makeGeometry(this.width, this.height, laneCount, this.opts);
    const g = this.geom;
    this.sprites.setRadiusRange(g.gemRadiusNear * this.opts.farScale * 0.9, g.gemRadiusNear * 1.4, this.dpr);
    this.grads.clear();
  }

  /**
   * Bake the backdrop.
   *
   * What is off the road matters as much as what is on it. This used to be a blue gradient with two
   * parallax starfields and three light cones: ~35 % of the frame, static, saying nothing — the
   * single most common tell of an unfinished rhythm-game frame, and the thing three blind critics
   * named independently. It is now a venue seen from the player's seat: a lit back wall, a lighting
   * truss across the top the beams actually hang from, a PA stack in each outer corner (exactly
   * where the road's taper leaves the most empty pixels) and a crowd silhouette line in front of
   * the glow.
   *
   * Every value here is deliberately low: the brightest thing in the venue is dimmer than the
   * dimmest thing on the road. A patient with low vision reads the board, and the room is texture
   * that must never compete with a gem, a receptor ring or a lane label for attention.
   */
  private buildBackground(): void {
    const W = this.width;
    const H = this.height;
    const bg = this.factory(W * this.dpr, H * this.dpr);
    const bctx = bg.getContext('2d');
    if (bctx) {
      bctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      const grad = bctx.createLinearGradient(0, 0, 0, H);
      grad.addColorStop(0, UI_COLORS.background0);
      grad.addColorStop(0.45, UI_COLORS.background1);
      grad.addColorStop(1, UI_COLORS.background0);
      bctx.fillStyle = grad;
      bctx.fillRect(0, 0, W, H);
      // Horizon haze
      const haze = bctx.createRadialGradient(W / 2, this.geom.horizonY, 0, W / 2, this.geom.horizonY, W * 0.6);
      haze.addColorStop(0, 'rgba(120,140,255,0.22)');
      haze.addColorStop(0.5, 'rgba(80,90,200,0.06)');
      haze.addColorStop(1, 'rgba(0,0,0,0)');
      bctx.fillStyle = haze;
      bctx.fillRect(0, 0, W, H);
      // Stage wash behind the crowd line: a wide, very dim ellipse of warm light that gives the
      // silhouettes something to be silhouettes *against*.
      const wash = bctx.createRadialGradient(W / 2, CROWD_BASE_FRAC * H, 0, W / 2, CROWD_BASE_FRAC * H, W * 0.62);
      wash.addColorStop(0, 'rgba(104,126,224,0.30)');
      wash.addColorStop(0.55, 'rgba(64,78,160,0.11)');
      wash.addColorStop(1, 'rgba(0,0,0,0)');
      bctx.fillStyle = wash;
      bctx.fillRect(0, H * 0.25, W, H * 0.75);
      // Floor / pit: the crowd band ends at `CROWD_BASE_FRAC`, and without this the silhouette mass
      // stopped on a hard horizontal line across the gutters. Below the front row the room is dark.
      const floor = bctx.createLinearGradient(0, (CROWD_BASE_FRAC - 0.04) * H, 0, H);
      floor.addColorStop(0, 'rgba(3,4,9,0)');
      floor.addColorStop(0.3, 'rgba(3,4,9,0.8)');
      floor.addColorStop(1, 'rgba(2,3,7,0.95)');
      bctx.fillStyle = floor;
      bctx.fillRect(0, (CROWD_BASE_FRAC - 0.04) * H, W, H * (1.04 - CROWD_BASE_FRAC));
      this.drawTruss(bctx, W, H);
      this.drawStacks(bctx, W, H);
      this.bgLayer = bg;
    } else {
      this.bgLayer = null;
    }
    this.crowdLayer = this.makeCrowdTile(W, H * CROWD_H_FRAC);
  }

  /** Lighting truss across the top of the frame, with the cans the stage beams hang from. */
  private drawTruss(ctx: Ctx2D, W: number, H: number): void {
    const top = H * 0.012;
    const h = H * 0.052;
    ctx.strokeStyle = 'rgba(150,168,215,0.20)';
    ctx.lineWidth = Math.max(1, 2 * this.u);
    ctx.beginPath();
    ctx.moveTo(0, top);
    ctx.lineTo(W, top);
    ctx.moveTo(0, top + h);
    ctx.lineTo(W, top + h);
    ctx.stroke();
    // Lattice.
    ctx.strokeStyle = 'rgba(150,168,215,0.11)';
    ctx.lineWidth = Math.max(1, 1.4 * this.u);
    ctx.beginPath();
    const step = h * 1.15;
    for (let x = -h; x < W + h; x += step) {
      ctx.moveTo(x, top + h);
      ctx.lineTo(x + step * 0.5, top);
      ctx.moveTo(x + step * 0.5, top);
      ctx.lineTo(x + step, top + h);
    }
    ctx.stroke();
    // Hanging cans, aligned with the beam origins in drawBackground.
    const cans = 6;
    for (let i = 0; i < cans; i++) {
      const x = (W * (i + 0.5)) / cans;
      ctx.fillStyle = 'rgba(120,136,180,0.22)';
      ctx.fillRect(x - h * 0.16, top + h, h * 0.32, h * 0.42);
      ctx.fillStyle = 'rgba(200,220,255,0.14)';
      ctx.beginPath();
      ctx.ellipse(x, top + h * 1.42, h * 0.2, h * 0.09, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /** PA stacks in the two outer corners — the emptiest pixels in the frame once the road tapers. */
  private drawStacks(ctx: Ctx2D, W: number, H: number): void {
    const w = Math.min(W * 0.105, H * 0.19);
    const top = H * 0.42;
    const bottom = H * 0.99;
    for (let side = 0; side < 2; side++) {
      const x = side === 0 ? W * 0.012 : W - W * 0.012 - w;
      const inner = side === 0 ? x + w : x; // edge facing the road, catches the rim light
      const boxes = 4;
      const bh = (bottom - top) / boxes;
      for (let i = 0; i < boxes; i++) {
        const y = top + i * bh;
        const face = ctx.createLinearGradient(x, y, x + w, y);
        face.addColorStop(0, side === 0 ? 'rgba(8,10,18,0.98)' : 'rgba(26,32,52,0.98)');
        face.addColorStop(1, side === 0 ? 'rgba(26,32,52,0.98)' : 'rgba(8,10,18,0.98)');
        ctx.fillStyle = face;
        ctx.fillRect(x, y, w, bh - 2 * this.u);
        // Lit top edge — the cabinets are under the truss, so the light comes from above.
        ctx.fillStyle = 'rgba(150,172,230,0.20)';
        ctx.fillRect(x, y, w, Math.max(1, 2 * this.u));
        ctx.strokeStyle = 'rgba(120,140,200,0.16)';
        ctx.lineWidth = Math.max(1, 1.2 * this.u);
        ctx.strokeRect(x + 0.5, y + 0.5, w, bh - 2 * this.u);
        // Driver.
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.beginPath();
        ctx.ellipse(x + w / 2, y + bh * 0.45, w * 0.3, bh * 0.26, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(130,150,210,0.20)';
        ctx.beginPath();
        ctx.ellipse(x + w / 2, y + bh * 0.45, w * 0.3, bh * 0.26, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      // Rim light down the road-facing edge.
      ctx.strokeStyle = 'rgba(150,180,255,0.16)';
      ctx.lineWidth = Math.max(1, 2 * this.u);
      ctx.beginPath();
      ctx.moveTo(inner, top);
      ctx.lineTo(inner, bottom);
      ctx.stroke();
    }
  }

  /**
   * The crowd: one baked band of overlapping head-and-shoulders silhouettes, darker than the wash
   * behind them, with a thin cool rim on top (stage light from behind). Drawn per frame with a
   * beat-driven bob, which is the whole animation — a crowd that slides sideways reads as a
   * parallax layer, a crowd that lifts on the beat reads as a crowd.
   */
  private makeCrowdTile(w: number, h: number): CanvasLike | null {
    const tile = this.factory(Math.max(1, w * this.dpr), Math.max(1, h * this.dpr));
    const ctx = tile.getContext('2d');
    if (!ctx) return null;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const rng = makeRng(1972);
    // Two ranks: the back one smaller, dimmer and higher up, the front one bigger and blacker.
    for (const rank of [0, 1]) {
      const headR = h * (rank === 0 ? 0.1 : 0.15);
      const baseY = h * (rank === 0 ? 0.62 : 1.0);
      const count = Math.max(6, Math.round(w / (headR * (rank === 0 ? 2.1 : 2.8))));
      ctx.fillStyle = rank === 0 ? 'rgba(6,8,16,0.72)' : 'rgba(3,4,9,0.94)';
      for (let i = 0; i < count; i++) {
        const x = ((i + 0.5) / count) * w + (rng() - 0.5) * headR * 1.5;
        const r = headR * (0.78 + rng() * 0.5);
        const y = baseY - r * (1.7 + rng() * 0.5);
        ctx.beginPath();
        ctx.ellipse(x, y, r, r * 1.08, 0, 0, Math.PI * 2);
        ctx.fill();
        // Shoulders.
        ctx.beginPath();
        ctx.ellipse(x, y + r * 2.5, r * 2.0, r * 2.1, 0, 0, Math.PI * 2);
        ctx.fill();
        // A few raised arms.
        if (rank === 1 && rng() < 0.22) {
          const ax = x + (rng() < 0.5 ? -1 : 1) * r * 1.1;
          ctx.save();
          ctx.lineCap = 'round';
          ctx.strokeStyle = 'rgba(3,4,9,0.94)';
          ctx.lineWidth = r * 0.44;
          ctx.beginPath();
          ctx.moveTo(ax, y + r * 1.9);
          ctx.lineTo(ax + (rng() - 0.5) * r, y - r * 1.6);
          ctx.stroke();
          ctx.restore();
        }
      }
      // Cool rim along the top of the rank.
      ctx.globalCompositeOperation = 'source-atop';
      const rim = ctx.createLinearGradient(0, baseY - headR * 3.2, 0, baseY - headR * 1.2);
      rim.addColorStop(0, 'rgba(150,180,255,0.26)');
      rim.addColorStop(1, 'rgba(150,180,255,0)');
      ctx.fillStyle = rim;
      ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = 'source-over';
    }
    return tile;
  }

  /** Cached gradient by key; `make` runs once per key until the next geometry / palette change. */
  private grad(key: string, make: () => CanvasGradient): CanvasGradient {
    let g = this.grads.get(key);
    if (!g) {
      g = make();
      this.grads.set(key, g);
    }
    return g;
  }

  // ---------------------------------------------------------------------------------------------
  // Frame
  // ---------------------------------------------------------------------------------------------

  draw(frame: RenderFrame): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const t0 = now();
    const laneCount = clamp(frame.lanes.length || 4, 1, MAX_LANES);
    if (laneCount !== this.geom.laneCount) this.rebuildGeometry(laneCount);

    // Degenerate input from a live pipeline must degrade gracefully: a non-finite song time is
    // treated as "no time passed" (the frame still draws, at the last good time) rather than
    // flowing into dt and from there into every smoothed accumulator, permanently.
    const st = Number.isFinite(frame.songTime) ? frame.songTime : (this.lastSongTime ?? 0);
    this.stNow = st;
    if (this.lastSongTime !== null && st < this.lastSongTime - RESTART_JUMP_SEC) this.reset();
    const dt = this.lastSongTime === null ? 0 : clamp(st - this.lastSongTime, 0, 0.1);
    // A SONG CLOCK THAT WENT BACKWARDS is a restart or a seek, and nothing observed before it is
    // evidence about the rep the patient is making now. `ReceptorHistory` used to notice that for
    // itself, because it was handed `songTime` directly; the perception clock below is monotone by
    // construction (that is the whole point of it), so the renderer has to say it out loud. A jump
    // bigger than `RESTART_JUMP_SEC` is already handled by the full `reset()` above; this catches
    // the smaller ones, which are exactly the ones a short seek makes.
    const back = this.lastSongTime !== null && st < this.lastSongTime;
    // How far the song clock moved, UNCLAMPED unlike `dt`. That clamp protects the smoothed
    // accumulators (glow, rolling score, health) from one long frame; the receptor's timers are the
    // opposite case — they are EVIDENCE windows, and under-reporting how long a hitch lasted is
    // what keeps a stale arming alive across it and lets the recovery frame be read as a crossing.
    // A long frame really did last that long.
    const songDelta = this.lastSongTime === null ? 0 : Math.max(0, st - this.lastSongTime);
    this.lastSongTime = st;
    if (back) this.history.reset();
    // The receptor's perception clock (see `SONG_CLOCK_STALL_SEC`): song time while the song clock
    // is moving — so every existing timing, and every frame this renderer has ever been driven
    // through, is unchanged — and wall time once it has been stopped for longer than any audio-clock
    // quantization can explain. `wallDt` IS capped, because that is the leg where the renderer is
    // guessing: a backgrounded tab returning after a minute expires the receptor's evidence once
    // rather than sixty times over.
    const wallDt = this.lastDrawWall >= 0 ? clamp((t0 - this.lastDrawWall) / 1000, 0, 0.25) : 0;
    if (songDelta > 0) this.songStillSec = 0;
    else this.songStillSec += wallDt;
    const rdt = songDelta > 0 ? songDelta : this.songStillSec >= SONG_CLOCK_STALL_SEC ? wallDt : 0;
    this.receptorT += rdt;
    const energy = clamp(frame.energy ?? 0, 0, 1);
    const mult = clamp(frame.multiplier, 1, 8);
    // A non-finite beat phase is a *missing* value, not beat zero. `clamp` maps NaN to its low
    // bound, and the low bound here is exactly the on-beat value — so an unarmed beat clock used to
    // pin rails, strike band, side panels, receptors and the multiplier badge at maximum pulse on
    // every single frame. Missing phase now goes flat, the same way reduced motion does.
    const beatOk = Number.isFinite(frame.beatPhase);
    const beat = beatOk ? clamp(frame.beatPhase, 0, 1) : 0;
    // 1 on the beat, decays quickly. Reduced motion holds it at a steady mid value so every
    // beat-driven glow / size pulse in the frame goes flat in one place instead of ten.
    const beatPulse = this.opts.reducedMotion || !beatOk ? 0.3 : Math.pow(1 - beat, 3);
    this.resolveLaneMaps(frame);

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

    this.processHits(frame);
    this.drawBackground(ctx, energy, mult, beatPulse);
    this.drawRoad(ctx, frame, mult, beatPulse, energy, beat);
    this.drawLaneFlashes(ctx, st);
    this.drawStrikeLine(ctx, frame, beatPulse);
    this.stats.notesDrawn = this.drawNotes(ctx, frame);
    this.particles.update(dt);
    this.drawParticles(ctx);
    // THE RECEPTOR ROW IS THE LAST BOARD LAYER, AND THAT IS A CLINICAL RULE, NOT A STYLE CHOICE.
    //
    // It used to be drawn BEFORE the gems, the way a fret board is drawn under its notes — which is
    // right for Guitar Hero, where the fret carries no information, and wrong here, where the ring
    // IS the biofeedback. The numbers: a gem at the strike line is `gemRadiusNear * GEM_ASPECT`
    // (63.1 px at 1280x800) against a meter well of `receptorRadius * GEM_ASPECT *
    // RECEPTOR_WELL_RATIO` (63.6 px), it is opaque, and it is centred on the same point — so a gem
    // sitting on its receptor covers 96 % of that lane's well. Measured on a real 'medium' session
    // at 1280x800: a gem covered the receptor's centre on 1252 of 3600 lane-frames (34.8 %) and
    // touched the well on 45.5 %. A capture of lane 3 in state (c) showed NOTHING of it — no ring,
    // no drain cap, no re-arm dashes, no chevron — only a bright, fully lit hit gem where "you
    // cannot score until you lower" was the whole message.
    //
    // AND THE WORST CASE IS THE CLINICALLY CENTRAL ONE. A patient stalled at end range is in (c) and
    // therefore misses every note in that lane; each missed gem then decelerates and fizzles over
    // the strike line for `MISS_FIZZLE_SEC`, so the instruction that would end the stall was hidden
    // precisely by the evidence of the stall. (`missCueY` now also walks a dying gem clear of the
    // well, so the fizzle is still SEEN — see there.)
    //
    // WHAT THE GEM LOSES, AND WHY THAT IS THE RIGHT TRADE. The gem is now occluded by the ring
    // exactly while it is inside it: its top cap shrinks away behind the well's upper rim and it is
    // fully swallowed at the instant its centre reaches the strike line, then re-emerges below. That
    // is not a cost, it is a crisper timing cue than "the centre is level with a line" — the gem
    // drops into the ring like a coin into a slot, and the whole 4 s approach, which is where the
    // read-ahead lives, is untouched. What the ring loses if the order is the other way round is the
    // only 2 m-legible statement the patient has about what their next rep will do.
    //
    // Particles go under it for the same reason: the hit burst is emitted AT the receptor, and an
    // additive spray over the ring is the same occlusion argument at lower alpha. It now blooms from
    // behind the ring, which is also how a struck fret reads.
    this.drawReceptors(ctx, frame, rdt, beatPulse);
    // Popups go LAST, over the burst they belong to. They used to be drawn under the gems and under
    // the particle layer, on the theory that judgment text is redundant feedback and the next target
    // is not — but the burst is emitted at the same point the word is anchored to, so in practice
    // every PERFECT! was struck through by its own spark streaks and read as a rendering bug. A
    // judgment word that cannot be read is not redundant feedback, it is noise. The rise cap
    // (`POPUP_MAX_RISE_FRAC`) keeps it in the receptor's own band rather than up the approach path,
    // and it is gone in half a second.
    this.drawPopups(ctx, st);
    /*
      THE ENDING REPLACES THE GAME CHROME. IT DOES NOT SIT ON TOP OF IT.

      The curtain is 0.88, not 1: drawn under it, the live readouts were dimmed and perfectly
      readable, and they stayed for the whole 6.6 s. Observed at 1024x768 and 1280x800 — the COMBO
      block ("27"), its "x3" multiplier badge, the ANSWERED gauge and the rolling six-digit score all
      still on screen beside the card that was counting the same session out properly. Every one of
      them is a live readout of a song that has finished: the combo cannot change, the gauge cannot
      move, and the score is the number the card itself is rolling up. Two score readouts on one
      screen, one settling and one frozen, is the game contradicting itself in the last thing the
      patient sees.

      So while the sequence is playing, the chrome is simply not drawn. The board behind it (lanes,
      receptors, the last gem's effect) is, because that is the thing the curtain is fading.
      Its clock is the runner's (`advanceFinale`), not song time: the mixer has stopped by now.
    */
    if (this.finale) {
      this.drawFinale(ctx, this.finaleStep);
    } else {
      this.drawHud(ctx, frame, dt, beatPulse);
      this.drawCombo(ctx, frame, st);
      if (this.opts.showLabels) this.drawLabels(ctx, frame);
    }
    if (this.opts.showStats) this.drawStats(ctx);

    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

    const t1 = now();
    const ms = t1 - t0;
    const s = this.stats;
    s.drawMs = ms;
    s.avgDrawMs = s.frames === 0 ? ms : s.avgDrawMs + (ms - s.avgDrawMs) * 0.05;
    if (ms > s.maxDrawMs) s.maxDrawMs = ms;
    if (this.lastDrawWall >= 0) {
      const fm = t0 - this.lastDrawWall;
      s.frameMs = fm;
      s.avgFrameMs = s.avgFrameMs === 0 ? fm : s.avgFrameMs + (fm - s.avgFrameMs) * 0.05;
      s.fps = s.avgFrameMs > 0 ? 1000 / s.avgFrameMs : 0;
      if (fm > LONG_FRAME_MS) s.longFrames++;
    }
    this.lastDrawWall = t0;
    s.frames++;
    s.particles = this.particles.count;
    s.sprites = this.sprites.size + this.text.size;
  }

  // ---------------------------------------------------------------------------------------------
  // Background: gradient, parallax stars, stage lights, side panels
  // ---------------------------------------------------------------------------------------------

  private drawBackground(ctx: Ctx2D, energy: number, mult: number, beatPulse: number): void {
    const W = this.width;
    const H = this.height;
    if (this.bgLayer) {
      ctx.drawImage(this.bgLayer as unknown as CanvasImageSource, 0, 0, W, H);
    } else {
      ctx.fillStyle = UI_COLORS.background0;
      ctx.fillRect(0, 0, W, H);
    }
    const eff = this.eff;
    const still = this.opts.reducedMotion;
    const t = this.stNow;

    // Stage light cones, hung from the truss and slowly sweeping: soft pre-rendered sprites rotated
    // about their apex (no per-frame gradients, no hard edges). They are drawn *behind* the crowd,
    // so the silhouettes cut into them the way a real house rig looks from the floor.
    const tierIdx = clamp(Math.floor(mult) - 1, 0, 3);
    const beamSprite = eff > 0.02 ? this.sprites.beam(BEAM_HEX[tierIdx], BEAM_SPRITE_W, BEAM_SPRITE_H) : null;
    if (beamSprite) {
      const beams = mult >= 3 ? 6 : 3;
      const baseAlpha = clamp((0.16 + (mult - 1) * 0.05 + energy * 0.22) * (0.75 + beatPulse * 0.45) * eff, 0, 0.7);
      const len = H * 0.95;
      const wide = W * 0.22 * (1 + energy * 0.5);
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < beams; i++) {
        const ox = (W * (i + 0.5)) / beams;
        const sweep = still ? 0 : Math.sin(t * 0.5 + i * 1.7) * 0.42;
        const angle = sweep - ((ox - W / 2) / W) * 0.5;
        ctx.save();
        ctx.translate(ox, H * 0.062);
        ctx.rotate(angle);
        ctx.globalAlpha = baseAlpha;
        ctx.drawImage(beamSprite.canvas as unknown as CanvasImageSource, -wide / 2, 0, wide, len);
        ctx.restore();
      }
      ctx.globalAlpha = 1;
    }
    ctx.globalCompositeOperation = 'source-over';


    // Side panels: dark slabs filling the space outside the road, with a beat-pulsing glow band
    // hugging each road edge.
    const g = this.geom;
    const panelTop = g.horizonY + (g.strikeY - g.horizonY) * 0.3;
    const dTop = depthAtY(g, panelTop);
    const yBottom = yAt(g, g.minDepth);
    const glowA = (0.1 + beatPulse * 0.18 + energy * 0.12) * eff;
    const tier = multiplierTier(mult);
    const bandW = 26 * this.u;
    // Scrim, not a slab. It used to run to 0.92 alpha, which was correct when the only thing behind
    // it was a starfield and wrong now that there is a room back there: at 0.55 the road still wins
    // the contrast fight (its own asphalt is opaque) and the venue survives.
    const panelGrad = this.grad('panel', () => {
      const lp = ctx.createLinearGradient(0, panelTop, 0, H);
      lp.addColorStop(0, withAlpha(UI_COLORS.panel, 0));
      lp.addColorStop(0.35, withAlpha(UI_COLORS.panel, 0.38));
      lp.addColorStop(1, withAlpha(UI_COLORS.panel, 0.55));
      return lp;
    });
    const bandGrad = this.grad(BAND_KEYS[tierIdx], () => {
      const sg = ctx.createLinearGradient(0, panelTop, 0, H);
      sg.addColorStop(0, withAlpha(tier.glow, 0));
      sg.addColorStop(0.55, tier.color);
      sg.addColorStop(1, withAlpha(tier.color, 0.5));
      return sg;
    });
    for (let side = -1; side <= 1; side += 2) {
      const sd = side as -1 | 1;
      const outerX = sd < 0 ? 0 : W;
      const eTop = roadEdgeX(g, sd, dTop);
      const eBot = roadEdgeX(g, sd, g.minDepth);
      if (Math.abs(outerX - eBot) < 6) continue;
      ctx.fillStyle = panelGrad;
      ctx.beginPath();
      ctx.moveTo(outerX, panelTop);
      ctx.lineTo(eTop, panelTop);
      ctx.lineTo(eBot, yBottom);
      ctx.lineTo(outerX, yBottom);
      ctx.closePath();
      ctx.fill();
      // Glow band just outside the road edge.
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = glowA;
      ctx.fillStyle = bandGrad;
      ctx.beginPath();
      ctx.moveTo(eTop, panelTop);
      ctx.lineTo(eTop + sd * bandW, panelTop);
      ctx.lineTo(eBot + sd * bandW, yBottom);
      ctx.lineTo(eBot, yBottom);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }

    // Crowd, LAST in the backdrop: one full-width baked band of silhouettes, lifted on the beat.
    // It goes over the side scrim rather than under it — the scrim exists to keep the gutters from
    // competing with the road, and a crowd it has dimmed to nothing is back to being a gradient.
    // The road itself is drawn after all of this and covers the middle, so only the outer thirds
    // (the ones three reviewers called dead space) ever show it. Reduced motion holds the bob;
    // it does not remove the crowd.
    if (this.crowdLayer) {
      const bob = still ? 0 : beatPulse * H * 0.007 * (0.6 + energy * 0.8);
      const ch = H * CROWD_H_FRAC;
      const cy = CROWD_BASE_FRAC * H - ch - bob;
      ctx.globalAlpha = clamp(0.9 + energy * 0.1, 0, 1);
      ctx.drawImage(this.crowdLayer as unknown as CanvasImageSource, 0, cy, W, ch);
      ctx.globalAlpha = 1;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Road
  // ---------------------------------------------------------------------------------------------

  private roadPath(ctx: Ctx2D): void {
    const g = this.geom;
    const dNear = g.minDepth;
    ctx.beginPath();
    ctx.moveTo(roadEdgeX(g, -1, dNear), yAt(g, dNear));
    ctx.lineTo(roadEdgeX(g, 1, dNear), yAt(g, dNear));
    ctx.lineTo(roadEdgeX(g, 1, 1), g.horizonY);
    ctx.lineTo(roadEdgeX(g, -1, 1), g.horizonY);
    ctx.closePath();
  }

  private drawRoad(ctx: Ctx2D, frame: RenderFrame, mult: number, beatPulse: number, energy: number, beatPhase: number): void {
    const g = this.geom;
    const H = this.height;
    // Asphalt
    const fadeStop = clamp((this.farFadeY - g.horizonY) / Math.max(1, H - g.horizonY), 0.02, 0.6);
    ctx.fillStyle = this.grad('asphalt', () => {
      const asphalt = ctx.createLinearGradient(0, g.horizonY, 0, H);
      // Fully transparent at the far edge: the board does not *end*, it stops being there. Every
      // other paint on the road (ladder, dividers, rails, lane washes) runs through the same ramp,
      // and the gems fade over the same stretch in drawNotes.
      asphalt.addColorStop(0, 'rgba(42,47,68,0)');
      asphalt.addColorStop(fadeStop, '#2a2f44');
      asphalt.addColorStop(fadeStop + 0.12, UI_COLORS.asphalt0);
      asphalt.addColorStop(1, UI_COLORS.asphalt1);
      return asphalt;
    });
    this.roadPath(ctx);
    ctx.fill();

    // Lane washes: a few percent of each lane's own colour down its column. Lane identity is what
    // the movement labels spell out in words; this says the same thing without words, and it is
    // what stops a four-lane board from reading as one undifferentiated black ramp.
    for (let lane = 0; lane < g.laneCount; lane++) {
      ctx.fillStyle = this.fadeStyle(ctx, LANE_WASH_KEYS[lane], laneColor(this.palette, lane).base, LANE_WASH_ALPHA);
      ctx.beginPath();
      ctx.moveTo(laneBoundaryX(g, lane, g.minDepth), yAt(g, g.minDepth));
      ctx.lineTo(laneBoundaryX(g, lane + 1, g.minDepth), yAt(g, g.minDepth));
      ctx.lineTo(laneBoundaryX(g, lane + 1, 1), g.horizonY);
      ctx.lineTo(laneBoundaryX(g, lane, 1), g.horizonY);
      ctx.closePath();
      ctx.fill();
    }

    // Beat ladder. Three weights — eighth-note hairline, quarter-note beat, bar — because a board
    // this long with only quarter lines shows 5 rungs at 120 BPM, and a rhythm game the patient
    // cannot count against is just objects floating in a void. Bars read at 2 m; the hairlines are
    // texture that says "the spacing is regular" without competing with the gems.
    const nLines = fillBeatLines(g, this.stNow, frame.bpm, beatPhase, this.beatTimes, this.beatBars, 4, frame.beatIndex, BEAT_SUBDIVISIONS);
    ctx.lineCap = 'butt';
    for (const kind of BEAT_LINE_PASSES) {
      ctx.beginPath();
      let any = false;
      for (let i = 0; i < nLines; i++) {
        if (this.beatBars[i] !== kind) continue;
        const d = depthOf(g, this.beatTimes[i], this.stNow);
        // The ladder is the fret board, and the fret board ends at the strike line. Below it is the
        // apron: receptor hardware, hit bloom and the movement labels — the one band on the screen
        // a low-vision patient has to read words in. Rungs used to keep scrolling through it (and
        // linger there, since the tail speed is deliberately slow), striking the labels through.
        if (d < 0) continue;
        const y = yAt(g, d);
        ctx.moveTo(roadEdgeX(g, -1, d), y);
        ctx.lineTo(roadEdgeX(g, 1, d), y);
        any = true;
      }
      if (!any) continue;
      const lineColor = kind === BEAT_LINE_BAR ? UI_COLORS.barLine : kind === BEAT_LINE_BEAT ? UI_COLORS.beatLine : UI_COLORS.subBeatLine;
      const lineAlpha = kind === BEAT_LINE_BAR ? BOARD_LINE_ALPHA.barLine : kind === BEAT_LINE_BEAT ? BOARD_LINE_ALPHA.beatLine : BOARD_LINE_ALPHA.subBeatLine;
      ctx.strokeStyle = this.fadeStyle(ctx, LADDER_KEYS[kind], lineColor, lineAlpha);
      ctx.lineWidth = (kind === BEAT_LINE_BAR ? 3.2 : kind === BEAT_LINE_BEAT ? 1.6 : 1) * this.u;
      ctx.stroke();
    }

    // Lane dividers
    ctx.beginPath();
    for (let b = 1; b < g.laneCount; b++) {
      ctx.moveTo(laneBoundaryX(g, b, g.minDepth), yAt(g, g.minDepth));
      ctx.lineTo(laneBoundaryX(g, b, 1), g.horizonY);
    }
    ctx.strokeStyle = this.fadeStyle(ctx, 'divider', UI_COLORS.laneDivider, BOARD_LINE_ALPHA.laneDivider);
    ctx.lineWidth = 1.5 * this.u;
    ctx.stroke();

    // Edge rails: wide soft glow + thin bright line, colour by multiplier tier, pulse on beat.
    const tier = multiplierTier(mult);
    const tierIdx = clamp(Math.floor(mult) - 1, 0, 3);
    const railA = (0.35 + beatPulse * 0.4 + energy * 0.3) * this.eff;
    for (let side = -1; side <= 1; side += 2) {
      const s = side as -1 | 1;
      ctx.beginPath();
      ctx.moveTo(roadEdgeX(g, s, g.minDepth), yAt(g, g.minDepth));
      ctx.lineTo(roadEdgeX(g, s, 1), g.horizonY);
      const railColor = mult >= 2 ? tier.color : UI_COLORS.rail;
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = clamp(railA * 0.45, 0, 1);
      ctx.strokeStyle = this.fadeStyle(ctx, RAIL_GLOW_KEYS[tierIdx], tier.glow);
      ctx.lineWidth = 9 * this.u;
      ctx.stroke();
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = clamp(0.5 + railA * 0.5, 0, 1);
      ctx.strokeStyle = this.fadeStyle(ctx, RAIL_KEYS[mult >= 2 ? tierIdx : 4], railColor);
      ctx.lineWidth = 2.2 * this.u;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
  }

  /**
   * Vertical gradient that ramps `color` from fully transparent at the far edge of the board up to
   * `alpha` below the dissolve band — the single mechanism that makes the far end of the highway
   * dissolve instead of ending on a hard horizontal cut with a bright rail lip across it. Every
   * paint that belongs to the road surface uses it, so they all fade out together.
   */
  private fadeStyle(ctx: Ctx2D, key: string, color: string, alpha = 1): CanvasGradient {
    return this.grad(key, () => {
      const g = this.geom;
      const lg = ctx.createLinearGradient(0, g.horizonY, 0, this.farFadeY);
      lg.addColorStop(0, withAlpha(color, 0));
      lg.addColorStop(0.55, withAlpha(color, alpha * 0.45));
      lg.addColorStop(1, withAlpha(color, alpha));
      return lg;
    });
  }

  /** Y at which the far-end dissolve has finished (the board is fully opaque below this). */
  private get farFadeY(): number {
    const g = this.geom;
    return g.horizonY + (g.strikeY - g.horizonY) * FAR_FADE_FRAC;
  }

  // Coloured lane flash on hit (lane colour) / miss (soft red tint), fading over ~0.3–0.45 s.
  private drawLaneFlashes(ctx: Ctx2D, st: number): void {
    const g = this.geom;
    for (let lane = 0; lane < g.laneCount; lane++) {
      const kind = this.laneFlashKind[lane];
      if (!kind) continue;
      const age = st - this.laneFlashT0[lane];
      const dur = kind === 1 ? 0.28 : 0.45;
      // A tiny negative age is clock jitter on the frame the flash was created — draw it anyway.
      // Only a real backward jump (or an expired flash) clears the slot.
      if (age > dur || age < -0.05) {
        this.laneFlashKind[lane] = 0;
        continue;
      }
      // Judgment feedback: scaled by coreEff (never below 0.55) rather than by effectIntensity, so
      // "calmer effects" softens the tint without ever making a miss look like nothing happened.
      const k = (1 - clamp(age, 0, dur) / dur) * this.coreEff;
      const grad = this.grad(kind === 1 ? FLASH_KEYS[lane] : 'flashMiss', () => {
        const color = kind === 1 ? laneColor(this.palette, lane).glow : '#ff3030';
        // Bounded: the wash dies out half way up the board rather than flooding it to the horizon.
        // On a board this long a full-length column swamped the road and hid the very receptor the
        // patient had just hit.
        const lg = ctx.createLinearGradient(0, g.strikeY, 0, g.strikeY + (g.horizonY - g.strikeY) * LANE_FLASH_REACH);
        lg.addColorStop(0, withAlpha(color, kind === 1 ? 0.4 : 0.24));
        lg.addColorStop(0.55, withAlpha(color, 0.1));
        lg.addColorStop(1, withAlpha(color, 0));
        return lg;
      });
      ctx.fillStyle = grad;
      ctx.globalAlpha = k;
      ctx.globalCompositeOperation = kind === 1 ? 'lighter' : 'source-over';
      ctx.beginPath();
      ctx.moveTo(laneBoundaryX(g, lane, g.minDepth), yAt(g, g.minDepth));
      ctx.lineTo(laneBoundaryX(g, lane + 1, g.minDepth), yAt(g, g.minDepth));
      ctx.lineTo(laneBoundaryX(g, lane + 1, 1), g.horizonY);
      ctx.lineTo(laneBoundaryX(g, lane, 1), g.horizonY);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Strike line + receptors
  // ---------------------------------------------------------------------------------------------

  private drawStrikeLine(ctx: Ctx2D, frame: RenderFrame, beatPulse: number): void {
    const g = this.geom;
    const y = g.strikeY;
    const x0 = roadEdgeX(g, -1, 0);
    const x1 = roadEdgeX(g, 1, 0);
    const energy = clamp(frame.energy ?? 0, 0, 1);
    // Soft glow band. A cached *vertical* gradient filled across the road: uniform left-to-right
    // like a Clone Hero fret board, so the outer lanes' receptors sit in exactly as much light as
    // the middle ones. (Stretching one radial glow sprite across the road made an ellipse — bright
    // at road centre, visibly dimmer at the outermost receptors.)
    const bandH = STRIKE_BAND_H * this.u;
    const band = this.grad('strikeBand', () => {
      const bg = ctx.createLinearGradient(0, y - bandH, 0, y + bandH);
      bg.addColorStop(0, 'rgba(220,230,255,0)');
      bg.addColorStop(0.34, 'rgba(220,230,255,0.30)');
      bg.addColorStop(0.5, 'rgba(230,240,255,0.85)');
      bg.addColorStop(0.66, 'rgba(220,230,255,0.30)');
      bg.addColorStop(1, 'rgba(220,230,255,0)');
      return bg;
    });
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = clamp((0.42 + beatPulse * 0.26 + energy * 0.18) * this.coreEff, 0, 1);
    ctx.fillStyle = band;
    ctx.fillRect(x0, y - bandH, x1 - x0, bandH * 2);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    // Crisp line — flat white across the whole board, like a fret line: the outer lanes' receptors
    // must sit on exactly as bright a line as the middle ones.
    ctx.strokeStyle = 'rgba(255,255,255,0.95)';
    ctx.lineWidth = 3 * this.u;
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(x1, y);
    ctx.stroke();
  }

  /**
   * Resolve lane index → position in `frame.laneStates` / `frame.lanes` for this frame.
   *
   * `LaneState.lane` and `LaneSpec.index` are the lane's identity in the engine's own types; the
   * renderer reads them when they are usable and falls back to array position otherwise. Silently
   * trusting array order meant that an integrator passing `inputSource.getLaneStates()` in any
   * other order — or a therapist config whose `LaneSpec.index` values were not 0..n-1 — attached
   * every meter and every movement label to the wrong lane, with no warning at all. That is a
   * clinical error (the patient watches a meter driven by their *other* leg), so a mapping that
   * does not cover the lanes exactly once warns, once, and then uses array position.
   */
  private resolveLaneMaps(frame: RenderFrame): void {
    const n = this.geom.laneCount;
    let bad = false;
    bad = this.fillLaneMap(this.stateIdx, n, frame.laneStates, 'lane') || bad;
    bad = this.fillLaneMap(this.specIdx, n, frame.lanes, 'index') || bad;
    if (bad && !this.warnedLaneMap) {
      this.warnedLaneMap = true;
      if (typeof console !== 'undefined' && typeof console.warn === 'function') {
        console.warn(
          '[Highway] RenderFrame.laneStates[].lane / lanes[].index do not cover lanes 0..n-1 exactly once; ' +
            'falling back to array position. Meters and labels may belong to the wrong lane — pass the engine values through unchanged.',
        );
      }
    }
  }

  /**
   * Fill `map` (lane → array position) from an array whose entries may carry their own lane id.
   * Returns true when the ids were present but unusable (out of range / duplicated / partial).
   */
  private fillLaneMap(map: Int8Array, laneCount: number, arr: readonly unknown[] | undefined, field: 'lane' | 'index'): boolean {
    for (let i = 0; i < laneCount; i++) map[i] = i;
    if (!arr || arr.length === 0) return false;
    let tagged = 0;
    let usable = 0;
    for (let i = 0; i < laneCount; i++) map[i] = -1;
    for (let i = 0; i < arr.length; i++) {
      const raw = (arr[i] as Record<string, unknown> | undefined)?.[field];
      if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
      tagged++;
      const lane = Math.round(raw);
      if (lane < 0 || lane >= laneCount || map[lane] >= 0) continue;
      map[lane] = i;
      usable++;
    }
    // All lanes covered by explicit ids: use them.
    if (usable === laneCount) return tagged !== usable;
    // Otherwise fall back to array position — and only complain if ids were actually offered.
    for (let i = 0; i < laneCount; i++) map[i] = i;
    return tagged > 0;
  }

  /**
   * Lane colour as it looks while the lane is locked out: pulled most of the way toward the dead
   * grey but keeping the lane's hue, and matte (no specular) so it cannot be mistaken for live.
   * Memoized by base hex — it feeds `SpriteCache.receptor`, which caches by that key.
   */
  private lockedColor(color: LaneColor, lock: LaneColor): LaneColor {
    let c = this.lockedColors.get(color.base);
    if (!c) {
      c = {
        name: `${color.name}-locked`,
        base: mixHex(color.base, lock.base, 0.62),
        bright: mixHex(color.bright, lock.bright, 0.62),
        dark: mixHex(color.dark, lock.dark, 0.5),
        glow: mixHex(color.glow, lock.glow, 0.62),
        matte: true,
      };
      this.lockedColors.set(color.base, c);
    }
    return c;
  }

  /** The lane meter for a lane index, honouring `RenderLaneState.lane` (see `resolveLaneMaps`). */
  private laneState(frame: RenderFrame, lane: number): RenderLaneState | undefined {
    const i = this.stateIdx[lane];
    return i >= 0 ? frame.laneStates[i] : undefined;
  }

  /** The lane definition for a lane index, honouring `LaneSpec.index` (see `resolveLaneMaps`). */
  private laneSpec(frame: RenderFrame, lane: number): LaneSpec | undefined {
    const i = this.specIdx[lane];
    return i >= 0 ? frame.lanes[i] : undefined;
  }

  /**
   * Receptors. The meter is the renderer's biofeedback claim, so it is drawn from the pure state
   * model in receptor.ts, and the FOUR states a lane can be in are drawn as four different things —
   * different MARKS (shape and topology), not different hue or brightness of one look, because a
   * patient reads this from ~2 m mid-exercise and may have low vision or a colour-vision deficit.
   *
   * Everything value-derived is painted ON TOP of the receptor sprite. The sprite's button face is
   * a translucent dark disc across the whole ellipse; a meter drawn underneath it is a scrimmed
   * warm-up glow with no resolvable level, which is exactly what a rising meter must not be.
   *
   * The meter is a GAUGE: a flat dark well, a liquid column with a hard-edged top, a target line at
   * the session's `thresholdFraction` with the rest of the patient's calibrated ROM as headroom
   * above it, and two upright gate posts marking that same threshold outside the ring where no
   * liquid can cover them. The target line is fixed for the session, and where it sits IS the prescription: low on
   * the well for an easy session, near the top for a hard one.
   *
   * THE COLUMN IS ONE LINEAR SCALE IN ALL FOUR STATES, and it is a POSITION, not a verdict. Every
   * height in the well is `meterPos` of a ROM value — full ROM at the ceiling, the target line at
   * `thresholdFraction` of it, the re-arm line at `thresholdFraction * rearmFraction` — so the same
   * height always means the same millimetres of movement, and the same movement covers the same
   * distance on screen wherever in the range the patient makes it. It cannot saturate anywhere
   * inside the reachable range, so it moves with the patient throughout the concentric rise AND the
   * eccentric return — the return is a therapeutic target in its own right, and a gauge that
   * flatlines (or crawls at a fifth speed) while the patient performs the movement it just asked
   * for reads as broken. What that position MEANS for the next rep is carried entirely by which
   * marks surround it, below.
   *
   *   (a) rising, armed        → lane-coloured ring with the beat pulse; liquid rising in the well;
   *                              a lane-coloured LEVEL LINE at the patient's current value; the
   *                              white TARGET LINE + its two gate posts; halo growing with fill².
   *                              "Keep going — this much further." The fixed target line is what
   *                              makes half way distinguishable from nearly there.
   *   (b) the threshold
   *       CROSSING (`goal`)    → the frame the lane actually fired on (see receptor.ts: the crossing
   *                              is one frame and the trigger has already disarmed by the time
   *                              `LaneState` is published, so this is a latch, not a level test).
   *                              Two additive rings appear that exist in no other state — an inner
   *                              rim and a corona, so the receptor reads as TWO concentric rings
   *                              where every other state reads as one, which is the separation that
   *                              survives the 220 px downscale, desaturation to luminance and both
   *                              dichromatic simulations — and the two threshold gate posts are
   *                              replaced by two solid ARROWHEADS pointing at the target line (a
   *                              change in shape at the same height). "You reached it."
   *                              WHILE THE REP IS STILL IN HAND (`locked`) it also says where the
   *                              patient is: the liquid stands white-hot in the overshoot headroom
   *                              above the target line — here, and only here, that height is read as
   *                              "this rep cleared the target by this much", the ROM-achieved number
   *                              a therapist is after — and the level line SPLITS into two white-hot
   *                              segments with a gap in the middle.
   *                              BOUNDED AT BOTH ENDS. The latch ends at the RE-ARM, not on a fixed
   *                              0.6 s timer: the moment the patient drops below the re-arm level
   *                              the lane is armed, at rest and ready, and the honest message is "go
   *                              again". At the chart generator's own note spacing (0.45 s on hard)
   *                              a brisk rep re-arms ~0.1 s after crossing, so a fixed latch meant a
   *                              ready lane wore the full goal costume for the whole inter-rep
   *                              interval and (a) was never drawn for a lane keeping up at all.
   *                              `GOAL_MIN_SEC` (0.15 s) is the floor that keeps KR catchable at
   *                              all; through that short overrun the KR marks stay (the rep really
   *                              did reach target) and every position mark reverts to its (a) form
   *                              at the patient's true height (they really are back at rest).
   *                              If instead they keep HOLDING, the latch runs its full
   *                              `GOAL_HOLD_SEC` and then glides — ring scale and ring alpha both
   *                              ramp — into (c), rather than stepping down 12 % at the instant of
   *                              success. The column itself does not move at either handover: it is
   *                              the same gauge on the same scale before and after.
   *                              GUARDED: an armed → not-armed edge is not always a crossing (a
   *                              stream break longer than `maxGapSec` and a mid-song threshold
   *                              change both disarm a lane at whatever value it has, and publish
   *                              the identical frame while emitting nothing), so the latch expires
   *                              its evidence exactly the way `LaneTrigger` expires its own — see
   *                              receptor.ts. A patient whose limb left frame for half a second
   *                              mid-rep gets (c), not a celebration for a rep that scored nothing.
   *   (c) at/over threshold,
   *       NOT armed (`locked`) → the lane has already fired (or has never been seen below the
   *                              re-arm level) and CANNOT fire again until the value falls below
   *                              `thresholdFraction * rearmFraction`. Dead grey ring shrunk 12 %,
   *                              grey liquid at the patient's true height (which is where they
   *                              really are — it may start above the target height and travels down
   *                              through it), NO level line, NO target line or posts, NO halo —
   *                              and instead the four return-to-rest marks that exist only here: a
   *                              violet drain cap on top of the column, a dashed re-arm line at the
   *                              level to come back down to, a downward chevron half way between
   *                              the two that lands on the line as the cap does, and an arc outside
   *                              the ring that grows with the fraction of the return journey
   *                              actually travelled (`ReceptorLook.resetProgress`, measured from
   *                              the observed peak) and completes exactly when the lane re-arms.
   *                              ALL FOUR MOVE FROM THE FIRST MILLIMETRE OF THE DESCENT — that is
   *                              the state's whole job, and the reason none of them is derived from
   *                              a value clamped at the threshold. A patient holding at end range sees the light go
   *                              out and a target to return to — never a lit receptor that is
   *                              quietly scoring nothing. The two marks that give an ORDER (the
   *                              violet drain cap and the chevron) are keyed to `needsLower`, not
   *                              to `locked`: a lane can be locked while already BELOW the re-arm
   *                              line ('unconfirmed' describes what has been observed, not the
   *                              current value), and pointing a patient down at a line they are
   *                              under is an order they cannot obey. Plus a dark keyline between
   *                              the column and the ring, so the ring survives the high-contrast
   *                              palette (where ring and column share one desaturated hue) at a
   *                              220 px-board downscale.
   *   (d) tracking lost        → there is no measurement at all, so NOTHING that encodes a value is
   *                              drawn: no well, no liquid, no level line, no halo, no lock cues,
   *                              no beat pulse (a dead signal must not dance with the music). Just
   *                              a broken, slowly breathing light-grey ring — the only ring on the
   *                              board with gaps in it — with a big "?" in it. "I cannot see you",
   *                              which is a different instruction from "lower to reset".
   *                              DEBOUNCED: `tracking` comes off a per-frame visibility gate that
   *                              nothing else in the chain smooths, so one marginal frame must not
   *                              flip the row to "?" and back at frame rate. `ReceptorHistory`
   *                              holds the last tracked look for `LOST_HOLD_SEC` (0.2 s) first — but
   *                              a lane that was never tracked, including one with no `LaneState`
   *                              at all, shows (d) immediately.
   *                              (d) IS ALSO WHAT A STOPPED SESSION READS AS, on every lane and at
   *                              every value (`RenderFrame.inputSuspended`): the camera does not
   *                              stop for a therapist pause, but the engine discards every event
   *                              stamped inside one, so "how much further" and "you reached it" are
   *                              both lies while it is set and the only true statement left is the
   *                              one (d) makes. Same mark set, same anti-strobe path, same
   *                              classifier — only the glyph changes, to the pause bars. See
   *                              `LostReason` and receptor.ts.
   *
   * A lane is in exactly one of these every frame, and every one of them is reachable from the
   * input layer as it actually runs — `Highway.test.ts` drives a real `VisionInput` over a real rep
   * and asserts all four are produced, because a state only the tests can build is not a state.
   */
  private drawReceptors(ctx: Ctx2D, frame: RenderFrame, dt: number, beatPulse: number): void {
    const g = this.geom;
    // The receptor meter is biofeedback: it must fill against the same threshold the engine fires
    // on (Difficulty.thresholdFraction, per session, from calibration). Falling back to 0.5 without
    // saying so would show a full ring at a threshold that does not trigger — so say so, once.
    if (!Number.isFinite(frame.thresholdFraction as number)) {
      if (!this.warnedThreshold) {
        this.warnedThreshold = true;
        if (typeof console !== 'undefined' && typeof console.warn === 'function') {
          console.warn(
            '[Highway] RenderFrame.thresholdFraction is missing: receptor meters are filling against the default 0.5, ' +
              "not this session's calibrated Difficulty.thresholdFraction. Pass it on every frame.",
          );
        }
      }
    }
    const threshold = clamp(frame.thresholdFraction ?? 0.5, 0.05, 1);
    const rearm = clamp(frame.rearmFraction ?? DEFAULT_REARM_FRACTION, 0.05, 0.99);
    // How long the input layer's stream may be silent before it throws a lane's arming away. The
    // receptor's "you reached your target" latch expires on the same clock, because the disarming a
    // break causes is published as exactly the frame a real crossing is. See RenderFrame.maxGapSec.
    const maxGap = Number.isFinite(frame.maxGapSec as number) && (frame.maxGapSec as number) > 0 ? (frame.maxGapSec as number) : DEFAULT_MAX_GAP_SEC;
    // The input layer's REFRACTORY window, if this source has one (the scripted sources do not — see
    // `RenderFrame.minIntervalSec`). 0 means "no such window": every crossing this lane publishes was
    // emitted, and the latch may fire for all of them.
    const minInterval = Number.isFinite(frame.minIntervalSec as number) && (frame.minIntervalSec as number) > 0 ? (frame.minIntervalSec as number) : 0;
    // IS THE SESSION EVEN LISTENING? (`RenderFrame.inputSuspended`.) The lane states keep arriving
    // through a therapist pause — the camera does not stop — and the engine throws every event
    // stamped inside it away, so a gauge that keeps gauging is claiming a rep will count when it
    // will not. Handed to the state model, which blanks every lane to "no reading" and refuses to
    // latch or credit any crossing inside the stop. See receptor.ts.
    const suspended = frame.inputSuspended === true;
    // NOT `this.stNow`: the receptor's latches are perception windows, and they have to keep
    // running when the song clock stops (see `SONG_CLOCK_STALL_SEC`). Everything else in the frame
    // is still keyed to song time, so a pause still freezes the gems, the bursts and the popups.
    const rt = this.receptorT;
    this.laneLooksCount = g.laneCount;
    const still = this.opts.reducedMotion;
    const r = g.receptorRadius;
    const ry = r * GEM_ASPECT;
    const look = this.look;
    for (let lane = 0; lane < g.laneCount; lane++) {
      // The two things one frame cannot decide — that the threshold was just crossed, and whether a
      // `tracking: false` is a dropout or one noisy frame — come from `ReceptorHistory`.
      // A FAULTED LANE HAS NO MEASUREMENT WORTH GAUGING FROM — see `setLaneFaults`. It is handed to
      // the state model as a lane with no `LaneState` at all, which is the model's existing (and
      // correct) reading of "there is nothing here": (d), through the same anti-strobe hold and the
      // same classifier every other meter on screen uses. It is NOT special-cased downstream, so
      // there is no path on which a faulted lane can still be drawn "armed and ready".
      const faulted = this.laneFault[lane] === 1;
      this.history.update(look, lane, faulted ? undefined : this.laneState(frame, lane), threshold, rearm, rt, maxGap, minInterval, suspended);
      // State (b) is LATCHED, not a level test: no input source in this repo ever publishes
      // `armed && value >= threshold` (the trigger disarms on the crossing sample, before
      // getLaneStates reads it), so "you reached your target" is drawn from the crossing EDGE and
      // held ~0.45 s. `goal` is 1 for the hold and then ramps to 0. See receptor.ts.
      const goal = look.goal ?? 0;
      // ONE VOICE: the same classifier every other live meter on screen uses (`receptorMarkSet`),
      // so the picture-in-picture lane meters next to the camera preview cannot be in a different
      // state from the receptor at the same instant.
      const marks = receptorMarkSet(look);
      // (b) makes TWO claims, and they expire at different moments — see `receptorGoalHolding`.
      //
      // `scored` is "this rep reached your target", a fact about a rep that happened. It owns the KR
      // marks: the additive inner rim + corona (the second concentric ring, which is what actually
      // separates (b) from (a) at a 220 px downscale) and the two solid arrowheads at the target
      // line. True for the whole latch.
      //
      // `hot` is "…and you are still up there holding it", a fact about the patient RIGHT NOW. It
      // owns the marks that encode a POSITION: the white-hot liquid material and the split white-hot
      // level cap. Without this split, the `GOAL_MIN_SEC` overrun paints a split white-hot cap at
      // the FLOOR of the well on a lane standing at rest.
      //
      // IT IS `receptorGoalHolding`, WHICH TESTS THE LEVEL AND NOT ONLY THE LOCKOUT — the same
      // predicate, on the same numbers, that the picture-in-picture meter uses on the same frame.
      // It used to be `scored && look.locked`, and the lockout does not end at the target line: it
      // ends at the RE-ARM line, `thresholdFraction * rearmFraction` of ROM. Measured on a real
      // VisionInput rep (0.8 s, threshold 0.65, re-arm 0.6) the difference was ~0.13 s during which
      // the column wore the hot material and the split white-hot cap while standing visibly BELOW
      // the dashed target line on the same gauge — the position marks contradicting the position.
      // The KR marks below are keyed to `scored` and are unaffected: that rep did reach the target.
      const scored = marks === 'goal';
      const hot = receptorGoalHolding(look);
      // The return-to-rest marks belong to (c) alone. For most of the latch the lane is both locked
      // and freshly scored, and the patient is told the second thing first; when the latch ends the
      // ring has already glided into the lockout look and the "lower to reset" instruction appears.
      // (If instead the patient lowers past the re-arm line first, the latch ends THERE and there is
      // no (c) to hand over to — the lane is armed and the next rep counts. That is the common case
      // at the chart generator's own note spacing.)
      const showLock = marks === 'locked';
      // ...and, inside (c), whether the patient has anywhere left to lower TO. A lane can be locked
      // while already below the re-arm line ('unconfirmed' is a statement about what has been
      // observed, not about the current value). Pointing a "lower to reset" chevron at a line the
      // patient is already under is an order they cannot obey, so the two ORDER marks — the violet
      // drain cap read as "bring this down" and the chevron — are keyed to this, not to `locked`.
      // Everything else about (c) stays: the lane still cannot score and still says so.
      //
      // IT IS A NARROW STATE, AND IT IS WORTH KNOWING HOW NARROW. Driven against the real input
      // layer the only thing that reaches it is `LaneTrigger.reset()` — a calibration replaced
      // mid-session — and then only for the render frames before the next camera frame re-arms the
      // lane. A retune leaves the lane AT OR ABOVE the new re-arm level by construction, and a
      // stream break re-arms a patient who returns at rest inside the same push. See
      // `ReceptorLook.needsLower`, which documents the measurement.
      const showLower = showLock && look.needsLower !== false;
      // What the label under this receptor must agree with (post-hold, not the raw flag).
      this.laneTracking[lane] = look.tracking ? 1 : 0;
      // ONE VOICE, LITERALLY: the play screen's picture-in-picture meters are drawn from THIS
      // object, not from a second history on a second clock. See `receptorLookOf`.
      if (!this.laneLooks[lane]) this.laneLooks[lane] = emptyReceptorLook(rearm);
      copyReceptorLook(this.laneLooks[lane], look);
      const color = laneColor(this.palette, lane);
      const lockColor = this.palette.miss;
      const x = laneX(g, lane, 0);
      const y = g.strikeY;

      // Re-arm edge: the instant the lane can fire again gets a visible pop, because that is the
      // instant the patient's next rep starts counting. It is also the instant the goal latch is cut
      // (see `receptorGoalHolding`), so the pop never springs a full-size, full-alpha ring back into
      // view still wearing the hot column and split cap of (b) — "ready for the next rep" and "you
      // are still up at your target" drawn on the same ring on the same frame.
      const armedNow = !look.locked && look.tracking ? 1 : 0;
      if (armedNow && !this.laneArmed[lane]) this.laneRearmT0[lane] = rt;
      this.laneArmed[lane] = armedNow;
      const popAge = rt - this.laneRearmT0[lane];
      const popK = popAge >= 0 && popAge < REARM_POP_SEC ? Math.pow(1 - popAge / REARM_POP_SEC, 2) : 0;

      // Smoothed halo. `glowTarget` is 0 whenever the lane cannot fire, so the halo drains away
      // over ~0.2 s when the lane locks out — the light going out is the cue.
      const prevGlow = Number.isFinite(this.laneGlow[lane]) ? this.laneGlow[lane] : 0;
      this.laneGlow[lane] = prevGlow + (look.glowTarget - prevGlow) * clamp(dt * 14, 0, 1);
      const glowLevel = this.laneGlow[lane];

      // (d) No signal. Drawn on its own and nothing else: every remaining mark below encodes a
      // measured value, and there is no measurement — including the halo, which is why this returns
      // *before* any halo blit. The accumulator above is still stepped (its target is 0 while
      // untracked), so the light is already back at zero when tracking returns and the recovering
      // lane fades up from its true value rather than from a stale one.
      if (!look.tracking) {
        // GLYPH PRECEDENCE: fault > stop > dropout, and it is ordered by what the person reading it
        // can do about it. A FAULT survives a pause because it is a session-long condition with a
        // therapist-side remedy, and a therapist pausing to work out why a lane is dead is exactly
        // who is looking; the stop is already stated in words across the whole screen, so spending
        // the lane's one glyph on it there would cost the diagnosis and buy nothing. A DROPOUT does
        // not survive it, because "get back in frame" is an instruction to a patient whose reps
        // cannot count yet anyway — and patients routinely leave frame during a stop, so "?" on a
        // paused row would be noise. (The camera's own health still has words: the input layer's
        // warnings are printed at full width in the pause overlay itself.)
        this.drawLostReceptor(ctx, x, y, r, ry, rt, still, faulted ? 'fault' : look.suspended ? 'suspended' : 'lost');
        continue;
      }

      // Ring scale: a real (≈9 %) beat pulse while the lane is live, a 12 % shrink while it is
      // locked out, plus the re-arm pop. The old 3.5 % wobble was sub-pixel and was not tied to
      // arming at all.
      //
      // `lockK` is 0 for a live lane and 1 for a locked one, and glides between the two over the
      // tail of the goal latch. Stepping it instead meant the ring shrank 12 % and dimmed on the
      // very frame the patient reached their target range — the gauge shrinking away from success.
      const lockK = look.locked ? 1 - goal : 0;
      let pulse = 1 - (1 - LOCK_RING_SCALE) * lockK + (still ? 0 : 0.09 * beatPulse * (1 - lockK));
      if (!still) pulse += 0.22 * popK;

      // Halo behind the receptor grows with the meter (live lanes only).
      if (glowLevel > 0.02) {
        const laneGlowSprite = this.sprites.glow(color.glow, 64);
        if (laneGlowSprite) {
          ctx.globalCompositeOperation = 'lighter';
          // Bounded to roughly a lane width: this halo is the "this will fire" biofeedback cue, and
          // a cue that erases the ring it is about (and the two receptors either side of it) has
          // stopped being a cue. It stacks additively with the hit burst, so both are capped.
          ctx.globalAlpha = clamp(glowLevel * 0.6 + popK * 0.3, 0, 1);
          blit(ctx, laneGlowSprite, x, y, (r * (1.8 + glowLevel * 0.9)) / 64);
          ctx.globalAlpha = 1;
          ctx.globalCompositeOperation = 'source-over';
        }
      }

      // Ring sprite FIRST — everything the patient actually has to read is painted ON TOP of it.
      // The sprite's button face is a translucent dark disc across the whole ellipse, so a meter
      // painted underneath it (which is what this used to do) is seen through a scrim: measured on
      // real pixels, empty→full moved the ring's mean luminance 38→79 as a diffuse warm-up with no
      // resolvable level line, and the meniscus was +19/255 over 2 px. At 2 m that is a binary
      // "not yet / there" — the entire effortful phase of every rep, the one thing the ring exists
      // to coach, was invisible.
      //
      // A locked ring is *desaturated toward* the dead grey, not replaced by it (`lockedColor`).
      // Replacing it meant the lane lost its colour identity for the whole lockout — which starts
      // on the frame the note is struck, so the receptor went grey-white at the exact instant the
      // patient looked at it, and blind reviewers read the struck fret as a stray sprite rather
      // than as "that lane, resetting". Lockout is still unmistakable: the ring shrinks 12 %, drops
      // to 60 % alpha, loses its halo, loses its target posts and gains the violet chevron and the
      // return-to-rest arc — five marks, none of which is hue.
      const ringColor = showLock ? this.lockedColor(color, lockColor) : color;
      const spr = this.sprites.receptor(ringColor, r);
      ctx.globalAlpha = clamp(1 - 0.4 * lockK + popK * 0.4, 0, 1);
      if (spr) blit(ctx, spr, x, y, pulse);
      else {
        ctx.strokeStyle = ringColor.base;
        ctx.lineWidth = Math.max(2, r * 0.16);
        ctx.beginPath();
        ctx.ellipse(x, y, r * pulse, ry * pulse, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      // ---- the meter well ------------------------------------------------------------------
      // A gauge, not a glow: flat dark ground, a liquid column whose top edge is a hard luminance
      // step, and a target line at the trigger threshold — fixed for the session — with the rest of
      // the patient's ROM as headroom above it.
      // The fixed mark is what makes "half way" different from "nearly there" at 2 m — a level with
      // nothing to read it against is only comparable to itself.
      const wr = r * RECEPTOR_WELL_WIDTH_RATIO * pulse;
      const wry = ry * RECEPTOR_WELL_RATIO * pulse;
      const yBot = y + wry;
      const span = wry * 2;
      // Every height in the well is `meterPos` of a ROM value and nothing else — one linear scale,
      // in all four states, for the target line, the column, and the re-arm line. The column is
      // therefore a POSITION: the same height means the same millimetres of movement whatever the
      // lane's arming is doing, and the same movement means the same distance on screen whether the
      // patient makes it below the target line or above it. What that position MEANS for the next
      // rep is carried by the mark set around it: (a)/(b) draw the target line, its outer marks and a
      // level line; (c) draws none of those and instead draws the drain cap, the dashed re-arm
      // line, the chevron and the return-to-rest arc.
      //
      // IT USED TO BE CLAMPED, TWICE, and both clamps were frozen zones. A locked column was capped
      // at `min(fill, 0.9)` of the target height and `fill` saturates at the threshold, so a
      // patient holding at end range and then lowering saw the column — and the drain cap, the
      // chevron and the arc that hang off it — sit perfectly still for the whole span from their
      // real peak down to the threshold: 71 % of the return journey on the default 'easy'
      // difficulty. Removing that left a second, quieter one: the target line was pinned at a fixed
      // 0.76 of the well, so the whole of the ROM above the threshold had to share the remaining
      // 0.17 and moved at a fifth of the speed of the rise. The eccentric phase is a therapeutic
      // target in its own right, and concurrent feedback that crawls through it reads as broken
      // just as surely as one that stops.
      const yTarget = yBot - meterPos(threshold) * span;
      const rom = clamp(look.rom ?? look.fill * threshold, 0, 1);
      const yLevel = yBot - meterPos(rom) * span;
      const yRearm = yBot - meterPos(threshold * look.resetLevel) * span;
      ctx.save();
      ctx.beginPath();
      ctx.ellipse(x, y, wr, wry, 0, 0, Math.PI * 2);
      ctx.clip();
      ctx.fillStyle = METER_WELL_COLOR;
      ctx.globalAlpha = 0.82;
      ctx.fillRect(x - wr, y - wry, wr * 2, span);
      ctx.globalAlpha = 1;
      // Liquid. The *material* is what changes between locked and live; the height is the patient's
      // real value in both, on the same scale (see `levelFrac`), so the descent of a locked column
      // is drawn to scale from wherever the patient actually is. The locked grey is deliberately
      // not a whisper: measured on real pixels
      // the old 0.55/0.75-alpha column came out at ~42/255 against a ~14/255 well, which at 2 m on a
      // clinic tablet is one uniform dark disc — the column that is supposed to be the thing the
      // patient lowers was not visible while they lowered it.
      if (yLevel < yBot - 0.5) {
        ctx.fillStyle = showLock
          ? // Desaturated toward the dead grey but still the lane's hue (`lockedColor`, the same
            // treatment the locked ring gets), and cached per lane. A neutral grey column filling a
            // ring whose colour had also been replaced left the struck fret with no lane identity
            // at all for the whole lockout — which begins on the frame the note is hit, and is the
            // frame blind reviewers kept reading as a stray sprite. Dull, not anonymous.
            this.grad(METER_LOCK_KEY + lane, () => {
              const dull = this.lockedColor(color, lockColor);
              const grad = ctx.createLinearGradient(0, y - ry, 0, y + ry);
              grad.addColorStop(0, withAlpha(dull.bright, 0.92));
              grad.addColorStop(1, withAlpha(dull.dark, 0.92));
              return grad;
            })
          : this.grad(hot ? METER_HOT_KEYS[lane] : METER_KEYS[lane], () => {
              const grad = ctx.createLinearGradient(0, y - ry, 0, y + ry);
              grad.addColorStop(0, withAlpha(hot ? color.bright : color.base, hot ? 0.98 : 0.92));
              grad.addColorStop(1, withAlpha(color.dark, 0.9));
              return grad;
            });
        ctx.fillRect(x - wr, yLevel, wr * 2, yBot - yLevel);
      }
      if (!showLock) {
        // Level line: "here is your current level, and it counts" — the one thing a locked lane
        // must never say.
        //
        // (a) rising: ONE continuous full-width bar in the lane's bright tint.
        // (b) firing: the bar SPLITS into two segments with a gap in the middle, white-hot and
        //     twice as thick. The split is the point: in the high-contrast palette a lane's bright
        //     tint is already near-white (#e6fbff on cyan), so "goes white and gets thicker" is a
        //     ~4 px vs ~2 px difference between two near-white bars — at or below acuity at 2 m for
        //     the very patients that palette exists for. A change in the NUMBER of marks is not.
        if (look.fill > 0.005) {
          ctx.fillStyle = hot ? TARGET_LINE_COLOR : color.bright;
          ctx.globalAlpha = hot ? 0.98 : 0.95;
          const th = hot ? Math.max(4, 6 * this.u) : Math.max(3, 3.4 * this.u);
          if (hot) {
            // The two segments SIT ON the liquid rather than straddling it, so the gap between them
            // is pure dark well. Straddling put the lower half of the gap inside the liquid, and in
            // the high-contrast palette the hot liquid's top is itself near-white (#e6fbff) — the
            // gap would have been filled in by the very thing it is meant to interrupt.
            const seg = wr * 0.62;
            ctx.fillRect(x - wr, yLevel - th, seg, th);
            ctx.fillRect(x + wr - seg, yLevel - th, seg, th);
          } else {
            ctx.fillRect(x - wr, yLevel - th * 0.5, wr * 2, th);
          }
          ctx.globalAlpha = 1;
        }
        // Target line: the threshold, at a fixed height, always drawn on top of the liquid — the
        // fixed reference that makes "half way" different from "nearly there".
        //
        // DASHED, AND NOT FULL WIDTH, because of where it lands. Its height is the session's
        // threshold on the ROM axis (see `meterPos`), and on the DEFAULT difficulty ('easy',
        // thresholdFraction 0.5) that is 0.465 of the well — within a few pixels of the receptor's
        // vertical centre, which is exactly where the board-wide strike line and its glow cross
        // every ring. A solid white rule there is confounded with a decorative element at 2 m, and
        // at 'medium' (0.65) the two read as a pair of near-parallel white rules. A dashed mark is
        // a different KIND of mark from the continuous strike line at any size, and it cannot be
        // confused with the split white-hot cap of (b) either (two long segments, twice as thick).
        // The violet dashes of (c) share the dash idea but never share a frame with it, are a
        // different colour, and there are three of them at a different height.
        //
        // The two solid GATE POSTS flush against the ring outline (below, outside the well) stand
        // ACROSS this height as unbroken marks, so the reference is never dashes alone — and being
        // at right angles to the strike line, they are the one part of it that cannot be absorbed
        // into it at a 220 px downscale.
        {
          const th = Math.max(2, 2.2 * this.u);
          const unit = (wr * TARGET_DASH_SPAN * 2) / (TARGET_DASH_COUNT * 2 - 1);
          ctx.fillStyle = TARGET_LINE_COLOR;
          ctx.globalAlpha = 0.85;
          for (let k = 0; k < TARGET_DASH_COUNT; k++) {
            ctx.fillRect(x - wr * TARGET_DASH_SPAN + k * unit * 2, yTarget - th * 0.5, unit, th);
          }
          ctx.globalAlpha = 1;
        }
      } else {
        // Drain cap: a hard bar in the lock hint colour riding the top of the grey column. It is not
        // a level line — it says nothing about scoring, it is the thing the patient has to bring
        // down onto the dashed line below it, and it is drawn in the same violet as that line and
        // the chevron so the pair reads as one instruction ("this, down to there"). It also gives
        // the dim grey column the hard top edge it needs to be resolvable at 2 m at all.
        if (yLevel < yBot - 0.5) {
          const th = Math.max(3, 3.4 * this.u);
          // Violet ONLY while it is an instruction. Below the re-arm line the same bar would say
          // "bring this down to there" about a column that is already under "there" — so it reverts
          // to a plain hard top edge in the column's own dulled tint, which is all the dim grey
          // liquid needs to stay resolvable at 2 m, and carries no order.
          ctx.fillStyle = showLower ? LOCK_HINT_COLOR : this.lockedColor(color, lockColor).bright;
          ctx.globalAlpha = 0.95;
          ctx.fillRect(x - wr, yLevel - th * 0.5, wr * 2, th);
          ctx.globalAlpha = 1;
        }
        // Re-arm line: where the value has to come back down to before the next rep can register.
        // Dashed, in the hint colour, and at the same height the input layer really re-arms at
        // (thresholdFraction * rearmFraction — LaneTrigger.rearmLevel).
        const dashW = (wr * 1.7) / 5;
        ctx.fillStyle = LOCK_HINT_COLOR;
        ctx.globalAlpha = clamp(0.72 + 0.28 * look.resetProgress, 0, 1);
        for (let k = 0; k < 3; k++) {
          ctx.fillRect(x - wr * 0.85 + k * dashW * 2, yRearm - Math.max(1, this.u), dashW, Math.max(2, 2.4 * this.u));
        }
        // KEYLINE. A dark rim between the locked column and the ring outline, drawn last and
        // clipped to the well so only its inner half shows. In the high-contrast palette the locked
        // ring and the locked column are the SAME desaturated hue (both come from `lockedColor`),
        // and at a 220 px-board acuity downscale on the magenta lane they merged into one filled
        // blob — (c) lost its ring cue entirely and was carried by the violet marks alone, which is
        // one shape cue for a patient with a blue-violet deficit. A dark separator is palette- and
        // hue-independent, so the ring stays a ring in every palette and at every scale.
        ctx.strokeStyle = METER_WELL_COLOR;
        ctx.globalAlpha = 0.95;
        ctx.lineWidth = Math.max(2, r * 0.14);
        ctx.beginPath();
        ctx.ellipse(x, y, wr, wry, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
      ctx.restore();

      if (!showLock) {
        // ...and the same target line marked OUTSIDE the ring, where no liquid can ever cover it
        // and no acuity loss can merge it with the level line. Two upright posts flush against the ring's
        // outline at exactly the threshold height.
        const dy = clamp((yTarget - y) / (ry * pulse), -1, 1);
        const edge = r * pulse * Math.sqrt(Math.max(0, 1 - dy * dy));
        // How far from this receptor's centre a mark may reach before it is in the next lane's
        // half: half a lane, less a margin (see TARGET_MARK_MARGIN). `edge` is where the ring's
        // outline is at the target height, and it is at its widest — ~1.0 r, more while the re-arm
        // pop is scaling the ring up — exactly when the target line is near the ring's middle.
        //
        // A HARD CAP, NOT A PREFERENCE. It used to be `max(edge + minLength, laneLimit)`, so the
        // minimum length a mark needs to read as a mark could push its outer end past the lane
        // boundary: measured at 1280x800 with four lanes, the goal arrowheads of a chord ended
        // 1.0 px short of the lane edge — two adjacent lanes' pairs separated by 2 px, which at the
        // 220 px downscale a low-vision patient at 2 m effectively applies is one blob spanning the
        // gutter. The mark keeps its length by moving its INNER end inward (onto the ring, which has
        // nothing to collide with) instead of its outer end outward.
        const markLimit = g.laneWidthNear * 0.5 - Math.max(2, r * TARGET_MARK_MARGIN);
        if (scored) {
          // GOAL REACHED. The two gate posts become two SOLID ARROWHEADS pointing at the target
          // line from outside the ring — the same two marks, changed in shape and roughly ten times
          // the filled area, so (a) and (b) are told apart out here by SHAPE and not only by the
          // rings inside.
          //
          // THEY ARE NOT WHAT CARRIES (b) AT 220 px, and the claim that they were is worth
          // correcting because it is the rationale a future change would be defended with. Measured:
          // a 1280x800 board downscaled to 220 px wide, max-luminance profile across the strike
          // band — (a)'s gate posts peak at 237/254 over 2 px and (b)'s arrowheads peak at 251/241
          // over 2 px, at the same height on the same strike line. Numerically and visually the same
          // white nub; the ~10x filled area does not survive the downscale as area. What DOES carry,
          // in the GH palette, the high-contrast palette, pure luminance and simulated
          // deuteranopia/tritanopia alike, is the additive inner rim below: (b) reads as two
          // concentric rings where (a) reads as one. Mark COUNT, at the one scale that matters.
          // The arrowheads earn their place at full size and in the mid range, and they cost
          // nothing — but if the rim ever has to go, (b) loses its downscale separation with it.
          // Grown inward from the lane's outer limit (see TARGET_MARK_MARGIN), never past it, and
          // never shorter than a mark that reads as a triangle rather than as a dot — so when the
          // ring is wide at this height (a mid-range threshold, or the re-arm pop mid-scale) it is
          // the TIP that moves in, onto the ring outline, rather than the base that moves out.
          const wl = clamp(markLimit - (edge + Math.max(1, this.u)), Math.max(4, r * 0.12), Math.max(5, r * GOAL_WEDGE_R));
          const tip0 = Math.min(edge + Math.max(1, this.u), markLimit - wl);
          const wh = Math.max(4, r * GOAL_WEDGE_R * 0.9);
          ctx.fillStyle = TARGET_LINE_COLOR;
          ctx.globalAlpha = clamp(0.95 * goal, 0, 1);
          for (const dir of [1, -1]) {
            const tip = x + dir * tip0;
            ctx.beginPath();
            ctx.moveTo(tip, yTarget);
            ctx.lineTo(tip + dir * wl, yTarget - wh * 0.5);
            ctx.lineTo(tip + dir * wl, yTarget + wh * 0.5);
            ctx.closePath();
            ctx.fill();
          }
          ctx.globalAlpha = 1;
        } else {
          // Two GATE POSTS flush against the ring's outline, centred on exactly the threshold
          // height: short bars standing ACROSS the target line, not along it.
          //
          // THEY USED TO LIE ALONG IT, AND AT 2 m THAT MADE THEM SOMETHING ELSE. They were thin
          // horizontal white ticks, and the threshold height on the default difficulty ('easy',
          // 0.5) is 0.465 of the well — a few pixels from the board-wide WHITE STRIKE LINE that
          // crosses every ring. Downscaled to the 220 px board (the acuity proxy for a 10" tablet
          // at 2 m) a white horizontal hairline a few pixels from a white horizontal rule is the
          // rule; and two neighbouring lanes' ticks, pointing at each other across a ~9 px gutter,
          // blur into one bar spanning it. The claimed second, unbroken reference did not survive
          // to the distance the whole design is specified at, so it was carrying nothing.
          //
          // A bar at right angles to the strike line cannot be absorbed into it at any scale, and
          // two posts either side of a gutter stay two marks because neither reaches across it.
          // The height is the post's MIDPOINT (it is centred on `yTarget`), which is what survives
          // a blur: a short vertical smudge keeps its centre. It is also a different SHAPE from the
          // solid arrowheads of (b) — which are horizontal, and ~5x the filled area — so the pair
          // (a)/(b) is still told apart by shape out here, not only by the rings inside.
          const pw = Math.max(3, r * 0.11);
          const ph = Math.max(6, r * 0.42);
          // Same rule as the arrowheads: the outer end is the lane's (see TARGET_MARK_MARGIN), and
          // the inner end gives way — the post moves onto the ring outline rather than into the
          // neighbouring lane.
          const postX = Math.min(edge + Math.max(1, this.u), markLimit - pw);
          ctx.fillStyle = TARGET_LINE_COLOR;
          ctx.globalAlpha = 0.92;
          ctx.fillRect(x + postX, yTarget - ph * 0.5, pw, ph);
          ctx.fillRect(x - postX - pw, yTarget - ph * 0.5, pw, ph);
          ctx.globalAlpha = 1;
        }
      } else {
        // "Lower to reset" chevron, pointing down, settling onto the re-arm line as the value
        // drains toward it. The only chevron on the board.
        // Sized to be read, not to dominate: at 0.34 r / 0.13 r stroke it was the single biggest
        // mark inside the ring, and on the frame of a hit (lockout starts there) two blind
        // reviewers read the receptor as "a stray, wrongly-scaled sprite" because of it. The
        // chevron is an instruction attached to the ring, so the ring has to win.
        ctx.lineCap = 'round';
        if (showLower) {
          const chev = r * 0.26;
          // IT SITS IN THE GAP IT IS ASKING THE PATIENT TO CLOSE: half way between the drain cap
          // (where they are) and the dashed re-arm line (where they have to get to). So it descends
          // monotonically for the WHOLE return, from any starting height, and lands ON the line at
          // the instant the lane re-arms — it cannot leave the ring and it cannot stall.
          //
          // It used to be a fixed height nudged down by `resetProgress`, which meant it could not
          // move at all through the part of the descent where `resetProgress` could not: the entire
          // span from the patient's real peak down to the threshold.
          const cy = yLevel + (yRearm - yLevel) * 0.5;
          ctx.globalAlpha = clamp(1 - 0.45 * look.resetProgress, 0, 1);
          const lw = Math.max(2, r * 0.1);
          const stroke = (): void => {
            ctx.beginPath();
            ctx.moveTo(x - chev, cy - chev * 0.5);
            ctx.lineTo(x, cy + chev * 0.5);
            ctx.lineTo(x + chev, cy - chev * 0.5);
            ctx.stroke();
          };
          // ADDITIVE, because this is (c)'s only POSITIVE mark and it is drawn on top of the one
          // thing whose luminance it cannot choose: the locked column, which the patient is lowering
          // THROUGH it. Measured on 220 px downscales (the acuity proxy for a 10" tablet at 2 m)
          // through the chevron apex, the flat violet peaked at 159/255 against a column at 130-137
          // (GH palette) and 158 against 122-133 (high contrast) — 19-22 % Weber, and under a tritan
          // simulation the violet collapses toward the olive of the column. (c) was therefore leaning
          // mainly on the ABSENCE of (a)'s target line and gate posts: subtractive evidence, the only
          // state in the set carried that way.
          //
          // Compositing the same stroke additively makes it STRICTLY brighter than whatever it sits
          // on, by construction, in every palette and at every fill height — re-measured on the same
          // 220 px downscales, the apex goes to 190-224/255 at 1.3-12.6 Weber against its
          // neighbours. It does drift toward white over a bright column, and that is the trade taken
          // deliberately: the mark's job is to be a SHAPE that survives luminance-only vision and
          // both dichromatic simulations (the four states are told apart by mark count and shape,
          // never by hue), and the violet identity of the "lower to reset" instruction is still
          // carried at full saturation by the drain cap, the dashed re-arm line and the return
          // crescent, which sit on dark ground and have contrast to spare.
          //
          // A DARK CASING WAS TRIED FIRST AND IS THE WRONG TOOL HERE. The map-label halo works when
          // the mark is thick relative to the blur; this stroke is ~2 px once the board is at 220 px,
          // so the box filter averaged the trench INTO the chevron and took its peak DOWN from 145
          // to 123 — worse at exactly the scale the requirement is written for.
          ctx.globalCompositeOperation = 'lighter';
          ctx.strokeStyle = LOCK_HINT_COLOR;
          ctx.lineWidth = lw;
          stroke();
          ctx.globalCompositeOperation = 'source-over';
        }
        ctx.strokeStyle = LOCK_HINT_COLOR;
        // Return-to-rest progress: a crescent outside the ring, under it, that grows as the value
        // drains back toward the re-arm level and is complete the instant the lane can fire again.
        // The chevron says what to do; this says how much further, which is the part a patient
        // holding at end range cannot otherwise know. It is confined to the ring's LOWER HALF
        // (`RESET_ARC_SWEEP`) so that it can never become a second concentric ring the way (b)'s
        // corona — drawn at the same radius — is one, and it is drawn in a hue no lane palette
        // contains, so it cannot be read as a lit lane ring on the yellow / orange lane at 2 m.
        //
        // ...and it stays in its own lane. At the nominal 1.16 r with this stroke it reached past
        // half a lane, so four locked lanes coming down together joined into one scalloped ribbon
        // across the board (see `outerMarkRadius`). The radius, not the containment, gives way.
        if (look.resetProgress > 0.001) {
          const lw = Math.max(2, r * 0.12);
          const arcR = outerMarkRadius(r, g.laneWidthNear, lw);
          ctx.globalAlpha = 0.95;
          ctx.lineWidth = lw;
          ctx.beginPath();
          ctx.ellipse(x, y, arcR, ry * (arcR / r), 0, RESET_ARC_START, RESET_ARC_START + RESET_ARC_SWEEP * look.resetProgress);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }

      // "THAT REP REACHED YOUR TARGET" — the KR mark, and the one thing that separates (b) from (a)
      // once the board is downscaled to the ~220 px a 10" tablet at 2 m is worth: an additive inner
      // rim in the lane colour, so the receptor reads as TWO concentric rings where every other
      // state reads as one. Mark count, not brightness and not hue — it survives desaturation to
      // luminance and both dichromatic simulations, which "white and brighter" does not (in the
      // high-contrast palette the rising cap is already near-white).
      //
      // Keyed to `scored`, not to `hot`: this is a claim about the rep just made, and it stays true
      // for the whole latch including the `GOAL_MIN_SEC` overrun after the lane has re-armed. The
      // marks that claim the patient is still AT the target are keyed to `hot` and have already gone
      // by then.
      if (scored) {
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = clamp((0.5 + 0.35 * (still ? 0.4 : beatPulse)) * goal, 0, 1);
        ctx.strokeStyle = color.bright;
        ctx.lineWidth = Math.max(2, r * 0.13);
        ctx.beginPath();
        ctx.ellipse(x, y, r * 0.68 * pulse, ry * 0.68 * pulse, 0, 0, Math.PI * 2);
        ctx.stroke();
        // ...and a corona just outside the ring. The inner rim can be swallowed by the fill it sits
        // on at a bright lane colour; the corona sits on the dark road, so "this rep is scoring"
        // survives being read across a clinic room. Contained to its own lane like the return arc
        // (see `outerMarkRadius`): a chord — two adjacent lanes crossing threshold on the same beat,
        // which the chart generator writes deliberately — merged the two coronas across the gutter.
        {
          const lw = Math.max(2, r * 0.1);
          const coronaR = Math.min(outerMarkRadius(r, g.laneWidthNear, lw), r * OUTER_MARK_R * pulse);
          ctx.globalAlpha = clamp((0.34 + 0.3 * (still ? 0.4 : beatPulse)) * goal, 0, 1);
          ctx.lineWidth = lw;
          ctx.beginPath();
          ctx.ellipse(x, y, coronaR, ry * (coronaR / r), 0, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
      }
    }
  }

  /**
   * (d) "I cannot see you": the tracker has no landmarks for this lane, so the receptor has no
   * value to report and must not pretend otherwise.
   *
   * VisionInput reports `value: 0, tracking: false` for a dead stream (see its `getLaneStates`), and
   * a lane-level dropout leaves the last sample behind — either way the number is not a measurement,
   * so nothing here is derived from it: no fill, no meniscus, no halo, no re-arm cues, no beat
   * pulse. What is drawn instead is the only BROKEN ring on the board — four light-grey arcs with
   * gaps, breathing slowly at a rate that has nothing to do with the music — with a large "?" in the
   * middle. Grey-but-solid means "lower to reset" (c); grey-and-broken means "the camera has lost
   * you", and the fix is to move back into frame, not to move differently.
   *
   * `why` picks the glyph only — see `LostReason`. The ring is identical for all three because the
   * ring is what is read at 2 m and at 2 m they are one statement: there is no reading here, and
   * nothing you do with this limb changes that. The glyph is read at arm's length, by whoever can
   * act: "?" the patient, "!" and ❚❚ the therapist.
   */
  private drawLostReceptor(ctx: Ctx2D, x: number, y: number, r: number, ry: number, st: number, still: boolean, why: LostReason = 'lost'): void {
    const breathe = still ? 0.8 : 0.6 + 0.4 * (0.5 - 0.5 * Math.cos(st * LOST_BREATHE_RATE));
    const arc = (Math.PI * 2) / LOST_RING_SEGMENTS;
    ctx.strokeStyle = LOST_RING_COLOR;
    // Fat arcs and wide gaps, because at a 220 px-board acuity downscale (~2 m on a clinic tablet)
    // the "?" blurs down to a smudge and the BROKEN RING is what is left carrying the state on its
    // own. A gap pattern survives that blur in proportion to how much of the ring it removes, so
    // this is deliberately coarse: four thick arcs and four unmistakable holes, not a dotted line.
    ctx.lineWidth = Math.max(3, r * 0.2);
    ctx.lineCap = 'butt';
    ctx.globalAlpha = clamp(breathe, 0, 1);
    for (let k = 0; k < LOST_RING_SEGMENTS; k++) {
      const a0 = LOST_RING_PHASE + k * arc + LOST_RING_GAP_RAD * 0.5;
      ctx.beginPath();
      ctx.ellipse(x, y, r, ry, 0, a0, a0 + arc - LOST_RING_GAP_RAD);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    // ❚❚ — the session is stopped; nothing the patient does counts until it is resumed. DRAWN, not
    // typed: it is the same two bars as the pause button that produced it (and as the one on the
    // play screen's own control), it needs no font to contain the glyph, and two solid bars survive
    // the 220 px acuity downscale that turns a "?" into a smudge — so at 2 m this is four arcs plus
    // TWO marks where the other two readings are four arcs plus one.
    if (why === 'suspended') {
      const bw = Math.max(2, r * 0.17);
      const bh = Math.max(bw * 2, ry * 0.62);
      const gap = bw * 0.85;
      ctx.fillStyle = LOST_RING_COLOR;
      ctx.globalAlpha = clamp(0.65 + 0.35 * breathe, 0, 1);
      ctx.fillRect(x - gap * 0.5 - bw, y - bh * 0.5, bw, bh);
      ctx.fillRect(x + gap * 0.5, y - bh * 0.5, bw, bh);
      ctx.globalAlpha = 1;
      return;
    }
    // "?" — the tracker cannot see you, move back into frame. "!" — this lane is not measuring you
    // at all and no movement will change that (`setLaneFaults`); the remedy is the therapist's, and
    // the words for it are on the play screen. Same broken ring, so the MARK SET (and therefore what
    // it tells a patient at 2 m) is unchanged: only the glyph, which is read at arm's length, says
    // which of the two it is.
    this.text.draw(ctx, why === 'fault' ? '!' : '?', x, y, this.style('receptorQ'), 1.5, clamp(0.65 + 0.35 * breathe, 0, 1));
  }

  // ---------------------------------------------------------------------------------------------
  // Notes
  // ---------------------------------------------------------------------------------------------

  private drawNotes(ctx: Ctx2D, frame: RenderFrame): number {
    const g = this.geom;
    const st = this.stNow;
    const buf = this.sortBuf;
    buf.length = 0;
    for (let i = 0; i < frame.notes.length; i++) {
      const n = frame.notes[i];
      if (n.state === 'hit') continue;
      if (n.lane < 0 || n.lane >= g.laneCount) continue;
      const d = depthOf(g, n.time, st);
      if (n.state === 'miss') {
        // Missed gems are culled by fizzle time, not by live depth (they decelerate while dying,
        // see below) — but a fizzle is only *started* for a gem that is still on the board. A
        // missed note left in `frame.notes` forever used to re-register every time the de-dupe
        // ledger pruned it (~3 s) and redraw five frames of a cue far below the canvas: invisible,
        // but a repeating no-op that inflated `stats.notesDrawn` for the rest of the song.
        if (d > g.maxDepth) continue;
        let seenAt = this.missT0.get(n.id);
        if (seenAt === undefined) {
          if (d < g.minDepth) continue;
          // Defensive: processHits registers the fizzle clock for every miss it sees, so this only
          // fires for a miss handed to us long after its note time (outside the judgment window).
          seenAt = st;
          this.missT0.set(n.id, st);
        }
        if (st - seenAt >= MISS_FIZZLE_SEC) continue;
      } else if (!isVisibleDepth(g, d)) continue;
      buf.push(n);
    }
    // Far notes first so nearer gems overlap them.
    buf.sort(byTimeDesc);
    let drawn = 0;
    for (let i = 0; i < buf.length; i++) {
      const n = buf[i];
      const d = depthOf(g, n.time, st);
      const p = projectInto(g, n.lane, d, this.proj);
      const missed = n.state === 'miss';
      const color = missed ? this.palette.miss : laneColor(this.palette, n.lane);
      let alpha = 1;
      let radius = p.radius;
      let y = p.y;
      if (missed) {
        // Fizzle driven by time since the engine declared the miss (first frame we saw the event),
        // not by depth — the verdict can arrive up to ~280 ms after the note time. The gem greys,
        // shrinks, fades and decelerates (it only keeps 35% of its scroll motion) so the whole
        // fizzle happens in view instead of below the canvas edge.
        const seenAt = this.missT0.get(n.id) ?? st;
        const k = clamp((st - seenAt) / MISS_FIZZLE_SEC, 0, 1);
        const dSeen = depthOf(g, n.time, seenAt);
        const ySeen = yAt(g, dSeen);
        y = ySeen + (p.y - ySeen) * 0.35 + k * g.gemRadiusNear * 0.4;
        alpha = (1 - k) * 0.75;
        // ...and never below the bottom edge: the whole point of the fizzle is that the patient
        // sees the note die. See `missCueY`.

        // Shrink from the size it had when the miss was declared. Below the strike line the
        // perspective tail *magnifies* gems, so scaling the live radius made a dying gem the
        // biggest thing on the board — the opposite of a fizzle.
        const rSeen = g.gemRadiusNear * scaleAt(g, dSeen);
        radius = (rSeen + (p.radius - rSeen) * 0.35) * (1 - k * 0.5);
        y = this.missCueY(y, radius, k);
      } else if (d < 0) {
        // Pending gem past the line: keep full colour (a late hit may still land) but dim gently
        // toward the bottom so it reads as "getting away".
        alpha = 1 - 0.3 * clamp(d / g.minDepth, 0, 1);
        // ...and stop growing. Below the line the perspective tail magnifies, so an un-hit gem used
        // to swell past the receptor ring it was sitting on and the two of them merged into one
        // same-coloured blob at the single most important pixel event on the board. A gem is never
        // bigger than it was at the moment it was judged.
        radius = Math.min(radius, g.gemRadiusNear);
      }
      // Fade in over the *top third* of the stretch the board itself dissolves over (see drawRoad),
      // then hold at `GEM_FAR_ALPHA`. The road may dissolve; the notes on it may not. Fading gems
      // over the full band cost the far half of the runway: the board genuinely carried eight
      // notes and showed three, because the rest were 15 %-alpha ghosts.
      const fadeSpan = this.farFadeY - g.horizonY;
      if (fadeSpan > 0 && y < this.farFadeY) {
        const t = clamp((y - g.horizonY) / fadeSpan, 0, 1);
        alpha *= clamp(t / GEM_FADE_IN_FRAC, 0, 1) * (GEM_FAR_ALPHA + (1 - GEM_FAR_ALPHA) * t);
      }
      if (alpha <= 0.01) continue;
      // `gemSprite` + `bucketedRadius` rather than `gem()`: no result object per note per frame.
      const gem = this.sprites.gemSprite(color, radius);
      ctx.globalAlpha = alpha;
      if (gem) {
        blit(ctx, gem, p.x, y, radius / this.sprites.bucketedRadius(radius));
      } else {
        ctx.fillStyle = color.base;
        ctx.beginPath();
        ctx.ellipse(p.x, y, radius, radius * GEM_ASPECT, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      drawn++;
    }
    ctx.globalAlpha = 1;
    return drawn;
  }

  /**
   * Where a miss cue (dying gem, puff) is allowed to be, between two edges it may not cross.
   *
   * BELOW: the bottom of the canvas. The engine declares a miss at `note.time + goodMs + grace` —
   * up to 280 ms past the line — and with the default geometry a gem of that age is still entirely
   * on screen (`gemVisibleTailSec` ≥ 300 ms at every tested resolution, asserted in
   * geometry.test.ts). This clamp is the backstop for tuned options and short canvases: a cue drawn
   * half below the bottom edge is not a cue, and "it was issued" is not the same as "the patient
   * saw it".
   *
   * ABOVE: the receptor's meter well, which is now painted OVER the gems (see `draw`). That fixed
   * the occlusion, and it would have cost the miss cue if nothing else changed: the verdict lands
   * while the dying gem's centre is only ~40 px past the line at 1280x800, i.e. still well inside a
   * ±63.6 px well, and the fizzle only drifts ~35 px further over its whole life. The gem would have
   * greyed, shrunk and faded out entirely behind the ring.
   *
   * So the fizzle is also a walk clear of the ring: over `MISS_CLEAR_SEC` — a third of the fizzle,
   * because the gem is fading the whole time and has to be clear while it still has opacity to be
   * seen with — the gem eases (`easeOutCubic`) down to `MISS_CLEAR_FRAC` of its own half-height
   * below the bottom rim of the well. It is never yanked: the walk starts at zero on the verdict
   * frame, where the gem is still at full size and its lower third is already below the ring.
   * That is the ONE mechanism carrying the miss on the board itself, and it keeps the two
   * statements spatially separate the way they are logically separate: the ring says what the
   * patient's limb is doing now, the gem sliding out from under it says the note they did not reach
   * is gone. The bottom clamp still wins if a short canvas leaves no room for both — the red lane
   * tint and the judgment popup are the miss cues that do not need apron space.
   */
  private missCueY(y: number, radius: number, fizzle = 1): number {
    const clear = this.geom.strikeY + receptorWellSemiHeight(this.geom) + radius * GEM_ASPECT * MISS_CLEAR_FRAC;
    const walk = easeOutCubic(clamp((fizzle * MISS_FIZZLE_SEC) / MISS_CLEAR_SEC, 0, 1));
    const walked = clear > y ? y + (clear - y) * walk : y;
    return Math.min(walked, this.height - radius * GEM_ASPECT - MISS_CUE_MARGIN_U * this.u);
  }

  // ---------------------------------------------------------------------------------------------
  // Hit processing → particles, flashes, popups
  // ---------------------------------------------------------------------------------------------

  /**
   * Turn one judgment into feedback: lane flash / red tint, particles, judgment popup, fizzle clock.
   * Called at most once per note id (see `seenHits`), from either of the two paths in `processHits`.
   */
  private applyJudgment(noteId: number, lane: number, judgment: Judgment, noteTime: number, st: number): void {
    const g = this.geom;
    this.seenHits.set(noteId, st);
    if (judgment === 'miss' && !this.missT0.has(noteId)) this.missT0.set(noteId, st);
    if (lane < 0 || lane >= g.laneCount) return;
    const x = laneX(g, lane, 0);
    const y = g.strikeY;
    const eff = this.eff;
    this.laneFlashT0[lane] = st;
    if (judgment === 'miss') {
      this.laneFlashKind[lane] = 2;
      // Grey smoke where the gem is, so the fizzle is attached to the gem rather than to the
      // receptor — clamped on screen like the gem itself. Count scales with effectIntensity but
      // never to zero: the puff, the red lane tint and the greying gem are the three miss cues and
      // none of them may go missing.
      //
      // PARTICLE_SMOKE, not PARTICLE_SPARK: sparks are drawn additively, and additive grey is
      // white — six overlapping `lighter` glows at the gem position produced a bright ~150 px
      // smudge clipped by the bottom edge, which reads as a rendering fault rather than a note
      // dying. Smoke composites normally over the asphalt and *darkens* as it spreads.
      const d = depthOf(g, noteTime, st);
      const p = projectInto(g, lane, clamp(d, g.minDepth, 1), this.proj);
      const py = this.missCueY(p.y, p.radius);
      const puffs = Math.max(2, Math.round(4 * eff));
      for (let k = 0; k < puffs; k++) {
        const ang = -Math.PI / 2 + (this.rng() - 0.5) * 1.8;
        const speed = p.radius * (0.5 + this.rng() * 0.9);
        this.particles.emit({
          x: p.x + (this.rng() - 0.5) * p.radius * 0.8,
          y: py,
          vx: Math.cos(ang) * speed,
          vy: Math.sin(ang) * speed,
          life: 0.3 + this.rng() * 0.18,
          size: p.radius * 0.5,
          endSize: p.radius * 0.78,
          color: MISS_COLOR_INDEX,
          alpha: 0.5,
          drag: 3,
          gravity: p.radius * 1.6,
          kind: PARTICLE_SMOKE,
        });
      }
      if (!this.opts.showMissPopup) return;
    } else {
      this.laneFlashKind[lane] = 1;
      const intensity = (judgment === 'perfect' ? 1.25 : 0.8) * eff;
      if (intensity > 0.02) {
        emitHitBurst(this.particles, this.rng, x, y, g.gemRadiusNear, lane, intensity);
      } else {
        // Calmest setting: the shockwave ring alone (still an unmistakable "you hit it").
        this.particles.emit({ x, y, life: 0.32, size: g.gemRadiusNear * 0.8, endSize: g.gemRadiusNear * 2.6, color: lane, alpha: 0.9, kind: PARTICLE_RING });
      }
      if (judgment === 'perfect' && eff > 0.02) {
        // Brief white core flash for perfects. Capped hard: the receptor ring, its lane colour and
        // its meter have to stay readable THROUGH the flash — that is the frame the patient looks
        // at, and a lane they cannot identify at the moment they hit it is worse than no flash.
        this.particles.emit({ x, y, life: 0.1, size: g.gemRadiusNear * 0.34, endSize: g.gemRadiusNear * 0.14, color: WHITE_COLOR_INDEX, kind: PARTICLE_SPARK, alpha: 0.26 });
      }
    }
    this.spawnPopup(judgment, lane, x, y, st);
  }

  /**
   * Claim a popup slot. Slots are a shared ring rather than one per lane, so a second hit on the
   * same lane inside the 0.75 s popup lifetime (8th notes at 120 BPM are 250 ms apart) no longer
   * cancels the first popup mid-flight; overlapping popups in one lane are stacked upward instead.
   *
   * The stack — and the rise applied in `drawPopups` — are capped at `POPUP_MAX_RISE_FRAC` of the
   * board height above the strike line, which at every resolution is well under a quarter second of
   * approach time. Clone Hero keeps its judgment text small and near the fret; a popup that flies
   * half way up the board in 50 px italics is decoration sitting on the one thing a rehab patient
   * has to see, and popups are drawn beneath the gems for the same reason.
   */
  private spawnPopup(judgment: Judgment, lane: number, x: number, y: number, st: number): void {
    const g = this.geom;
    // One judgment label on screen, always: a new verdict retires the previous one instead of
    // stacking beside it. Two labels are never worth more than one — the combo counter, the lane
    // flash and the burst already carry the "how many" — and two overlapping ones cost the patient
    // the receptor underneath them.
    let slot = 0;
    for (let i = 0; i < this.popups.length; i++) {
      if (this.popups[i].active) this.popups[i].active = false;
      else slot = i;
    }
    const p = this.popups[slot];
    p.active = true;
    p.judgment = judgment;
    p.t0 = st;
    p.lane = lane;
    p.x = x;
    const R = g.receptorRadius;
    const cap = (g.strikeY - g.horizonY) * POPUP_MAX_RISE_FRAC;
    p.y = y - Math.min(R * POPUP_BASE_R, cap);
  }

  private processHits(frame: RenderFrame): void {
    const g = this.geom;
    const st = this.stNow;
    // 1. Judgment events from the engine. `time` is the judgment time and `deltaMs` the timing
    //    error, so the note's own time is time - deltaMs/1000 (matches src/engine/judge.ts).
    const hits = frame.recentHits;
    for (let i = 0; i < hits.length; i++) {
      const e = hits[i];
      if (this.seenHits.has(e.noteId)) continue;
      this.applyJudgment(e.noteId, e.lane, e.judgment, e.time - e.deltaMs / 1000, st);
    }
    // 2. Fallback for the (documented, and common) integration shape where a note's `state` is
    //    flipped to hit/miss on the frame the verdict lands and the matching HitEvent only shows up
    //    in `recentHits` on a later frame — or never, for integrators that drive the renderer from
    //    note state alone. Whichever path gets there first produces the feedback; the other is
    //    de-duped by `seenHits`, so every judgment is drawn exactly once and none is dropped.
    const notes = frame.notes;
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      if (n.state === 'pending') continue;
      if (this.seenHits.has(n.id)) continue;
      const age = st - n.time;
      // Only a *fresh* verdict counts: a stale hit/miss note left in the frame long after its time
      // must not re-fire effects once its de-dupe entry has been pruned.
      if (age < -STATE_JUDGMENT_EARLY_SEC || age > STATE_JUDGMENT_LATE_SEC) continue;
      const judgment: Judgment = n.state === 'miss' ? 'miss' : n.judgment === 'perfect' ? 'perfect' : 'good';
      this.applyJudgment(n.id, n.lane, judgment, n.time, st);
    }
    // Prune both maps every frame: entries older than the visible window (so a note can never be
    // culled, forgotten and then resurrected while still on screen) or from the future (restart).
    // `forEach` over the map does not allocate an entry array per element the way `for..of` does.
    this.pruneNow = st;
    this.pruneKeep = Math.max(3, g.approachSec + 1);
    this.seenHits.forEach(this.pruneSeen);
    this.missT0.forEach(this.pruneMiss);
  }

  private readonly pruneSeen = (t: number, id: number): void => {
    if (this.pruneNow - t > this.pruneKeep || t > this.pruneNow + 1) this.seenHits.delete(id);
  };

  private readonly pruneMiss = (t: number, id: number): void => {
    if (this.pruneNow - t > this.pruneKeep || t > this.pruneNow + 1) this.missT0.delete(id);
  };

  /**
   * Colours for a particle colour index. Fills (and returns) a scratch object rather than a fresh
   * one — it is called once per colour batch per frame and the result is consumed immediately.
   */
  private readonly pcolor = { base: '#ffffff', glow: '#ffffff' };

  private particleColor(index: number): { base: string; glow: string } {
    const out = this.pcolor;
    if (index === WHITE_COLOR_INDEX) {
      out.base = '#ffffff';
      out.glow = '#ffffff';
    } else if (index === MISS_COLOR_INDEX) {
      out.base = this.palette.miss.base;
      out.glow = this.palette.miss.glow;
    } else {
      const c = laneColor(this.palette, index);
      out.base = c.bright;
      out.glow = c.glow;
    }
    return out;
  }

  private drawParticles(ctx: Ctx2D): void {
    const pool = this.particles;
    const n = pool.count;
    if (n === 0) return;
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    // Batch by colour index so strokes/fills share style (preallocated scratch, no per-frame array).
    const seen = this.colorBatch;
    let seenN = 0;
    for (let i = 0; i < n && seenN < seen.length; i++) {
      const c = pool.color[i];
      let found = false;
      for (let j = 0; j < seenN; j++) {
        if (seen[j] === c) {
          found = true;
          break;
        }
      }
      if (!found) seen[seenN++] = c;
    }
    for (let ci = 0; ci < seenN; ci++) {
      const cidx = seen[ci];
      const col = this.particleColor(cidx);
      const glowSprite = this.sprites.glow(col.glow, 32);
      // Sparks (sprite blits)
      for (let i = 0; i < n; i++) {
        if (pool.color[i] !== cidx || pool.kind[i] !== PARTICLE_SPARK) continue;
        const size = pool.sizeAt(i);
        if (size <= 0.2) continue;
        ctx.globalAlpha = pool.alphaAt(i);
        if (glowSprite) blit(ctx, glowSprite, pool.x[i], pool.y[i], (size * 2.6) / 32);
        else {
          ctx.fillStyle = col.base;
          ctx.beginPath();
          ctx.arc(pool.x[i], pool.y[i], size, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      // Streaks. Grouped into a few alpha bands: each band is one path + one stroke, so streaks
      // actually fade out over their life (a single fixed-alpha batch made them burn at constant
      // brightness and then pop out of existence, which reads as a glitch next to the fading
      // sparks and rings) while the draw count stays bounded by the band count, not the particle count.
      ctx.strokeStyle = col.base;
      ctx.lineWidth = Math.max(1, this.geom.gemRadiusNear * 0.09);
      for (let band = STREAK_ALPHA_BANDS; band >= 1; band--) {
        const lo = (band - 1) / STREAK_ALPHA_BANDS;
        const hi = band / STREAK_ALPHA_BANDS;
        let anyStreak = false;
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
          if (pool.color[i] !== cidx || pool.kind[i] !== PARTICLE_STREAK) continue;
          const a = pool.alphaAt(i);
          if (a <= 0.02 || a <= lo || a > hi) continue;
          const len = 0.035;
          ctx.moveTo(pool.x[i], pool.y[i]);
          ctx.lineTo(pool.x[i] - pool.vx[i] * len, pool.y[i] - pool.vy[i] * len);
          anyStreak = true;
        }
        if (anyStreak) {
          ctx.globalAlpha = hi * 0.85;
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
      // Rings (shockwaves)
      for (let i = 0; i < n; i++) {
        if (pool.color[i] !== cidx || pool.kind[i] !== PARTICLE_RING) continue;
        const t = pool.progress(i);
        const size = pool.sizeAt(i);
        ctx.globalAlpha = pool.alpha[i] * (1 - t);
        ctx.strokeStyle = col.base;
        ctx.lineWidth = Math.max(1, size * 0.18 * (1 - t) + 1);
        ctx.beginPath();
        ctx.ellipse(pool.x[i], pool.y[i], size, size * GEM_ASPECT, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    // Smoke last, and *not* additively (see PARTICLE_SMOKE): a dying note has to look like it is
    // going out, which additive compositing cannot express — the more smoke, the brighter it got.
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    for (let ci = 0; ci < seenN; ci++) {
      const cidx = seen[ci];
      let any = false;
      for (let i = 0; i < n; i++) {
        if (pool.color[i] === cidx && pool.kind[i] === PARTICLE_SMOKE) {
          any = true;
          break;
        }
      }
      if (!any) continue;
      const col = this.particleColor(cidx);
      const smokeSprite = this.sprites.glow(col.base, 32);
      for (let i = 0; i < n; i++) {
        if (pool.color[i] !== cidx || pool.kind[i] !== PARTICLE_SMOKE) continue;
        const size = pool.sizeAt(i);
        if (size <= 0.2) continue;
        ctx.globalAlpha = pool.alphaAt(i) * 0.8;
        if (smokeSprite) blit(ctx, smokeSprite, pool.x[i], pool.y[i], (size * 2.2) / 32);
        else {
          ctx.fillStyle = col.base;
          ctx.beginPath();
          ctx.arc(pool.x[i], pool.y[i], size, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  private drawPopups(ctx: Ctx2D, st: number): void {
    const dur = POPUP_SEC;
    const still = this.opts.reducedMotion;
    const g = this.geom;
    const cap = (g.strikeY - g.horizonY) * POPUP_MAX_RISE_FRAC;
    for (let i = 0; i < this.popups.length; i++) {
      const p = this.popups[i];
      if (!p.active) continue;
      const age = st - p.t0;
      // A tiny negative age is clock jitter on the frame the popup was created (see laneFlashT0).
      if (age < -0.05 || age > dur) {
        p.active = false;
        continue;
      }
      const t = clamp(age, 0, dur) / dur;
      const rise = easeOutCubic(t) * g.receptorRadius * POPUP_RISE_R * (still ? 0.35 : 1);
      // Hard cap on anchor + rise together: a popup never climbs further than POPUP_MAX_RISE_FRAC of
      // the board above the strike line, at any resolution, however many are stacked.
      const above = Math.min(g.strikeY - p.y + rise, cap);
      // Pop: overshoot then settle.
      const pop = still ? 1 : age < 0.12 ? 0.7 + (age / 0.12) * 0.5 : age < 0.22 ? 1.2 - ((age - 0.12) / 0.1) * 0.2 : 1;
      // Full strength for most of its life, then off. A long linear tail left a ~25 %-alpha word
      // hanging in empty lane space with no burst under it any more — which is exactly what a still
      // frame catches, and it reads as leftover garbage rather than as feedback. It is retired at
      // `POPUP_MIN_ALPHA` instead of fading to nothing: a judgment word is either legible or gone.
      const alpha = t < 0.74 ? 1 : 1 - (t - 0.74) / 0.26;
      if (alpha < POPUP_MIN_ALPHA) {
        p.active = false;
        continue;
      }
      const style = this.style(p.judgment === 'perfect' ? 'popupPerfect' : p.judgment === 'good' ? 'popupGood' : 'popupMiss');
      this.text.draw(ctx, JUDGMENT_STYLE[p.judgment].text, p.x, g.strikeY - above, style, pop, alpha);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // HUD
  // ---------------------------------------------------------------------------------------------

  private styleCache = new Map<string, TextStyle>();
  private styleU = -1;
  private styleLaneW = -1;
  /** Fitted HUD strings (0 = title, 1 = attribution) — refitted only when the text or room changes. */
  private hudSrc: string[] = ['', ''];
  private hudFit: string[] = ['', ''];
  private hudRoom: number[] = [-1, -1];
  /** Finale strings share the same cold-path fit cache, from `FINALE_FIT_BASE` up. */

  /**
   * Ellipsize a HUD string to `room` px, caching the result: `TextCache.fit` measures, so it is a
   * cold path and must not run every frame for a title that never changes.
   */
  private fitHud(slot: number, text: string, style: TextStyle, room: number): string {
    if (this.hudSrc[slot] !== text || this.hudRoom[slot] !== room) {
      this.hudSrc[slot] = text;
      this.hudRoom[slot] = room;
      this.hudFit[slot] = this.text.fit(text, style, room);
    }
    return this.hudFit[slot];
  }

  private style(name: string): TextStyle {
    if (this.styleU !== this.u || this.styleLaneW !== this.geom.laneWidthNear) {
      this.styleCache.clear();
      this.styleU = this.u;
      this.styleLaneW = this.geom.laneWidthNear;
    }
    let s = this.styleCache.get(name);
    if (s) return s;
    const u = this.u;
    // Every HUD size has a floor. `u` bottoms out at 0.35, so an unfloored `Math.round(12 * u)`
    // rendered the attribution at 4 px and 'SCORE' / 'ANSWERED' / 'COMBO' at 5 px on a 400x800 canvas.
    // Attribution is a CC-BY licence obligation (docs/ARCHITECTURE.md), not decoration, and a gauge
    // nobody can read tells the patient nothing about the work they are doing.
    const px = (n: number, min = 11) => Math.max(min, Math.round(n * u));
    switch (name) {
      // Popup text is deliberately small (Clone Hero scale, not a splash screen): it sits just
      // above the fret, inside the note approach path, so it must not be a billboard.
      case 'popupPerfect':
        s = { font: `italic 900 ${px(22, 14)}px ${FONT}`, color: JUDGMENT_STYLE.perfect.color, stroke: JUDGMENT_STYLE.perfect.stroke, strokeWidth: px(2, 1), glow: JUDGMENT_STYLE.perfect.glow, glowBlur: px(9, 3) };
        break;
      case 'popupGood':
        s = { font: `italic 900 ${px(22, 14)}px ${FONT}`, color: JUDGMENT_STYLE.good.color, stroke: JUDGMENT_STYLE.good.stroke, strokeWidth: px(2, 1), glow: JUDGMENT_STYLE.good.glow, glowBlur: px(9, 3) };
        break;
      case 'popupMiss':
        s = { font: `italic 700 ${px(17, 12)}px ${FONT}`, color: JUDGMENT_STYLE.miss.color, stroke: JUDGMENT_STYLE.miss.stroke, strokeWidth: px(2, 1), glow: JUDGMENT_STYLE.miss.glow, glowBlur: px(5, 2) };
        break;
      case 'combo':
        s = { font: `italic 900 ${px(56, 26)}px ${FONT}`, color: '#ffffff', stroke: 'rgba(0,0,0,0.6)', strokeWidth: px(3, 1), glow: '#8fb4ff', glowBlur: px(16, 5) };
        break;
      case 'comboLabel':
        s = { font: `700 ${px(15, 11)}px ${FONT}`, color: UI_COLORS.textDim, stroke: 'rgba(0,0,0,0.5)', strokeWidth: px(2, 1) };
        break;
      case 'hudLabel':
        s = { font: `700 ${px(14, 11)}px ${FONT}`, color: UI_COLORS.textDim };
        break;
      case 'score':
        s = { font: `800 ${px(36, 22)}px ${FONT}`, color: UI_COLORS.text, glow: '#7fa0ff', glowBlur: px(10, 4) };
        break;
      case 'title':
        s = { font: `700 ${px(20, 13)}px ${FONT}`, color: UI_COLORS.text };
        break;
      case 'attribution':
        // CC-BY attribution: never smaller than 11 px, whatever the canvas.
        s = { font: `400 ${px(12, 11)}px ${FONT}`, color: UI_COLORS.textDim };
        break;
      case 'mult':
        s = { font: `italic 900 ${px(30, 16)}px ${FONT}`, color: '#ffffff', stroke: 'rgba(0,0,0,0.5)', strokeWidth: px(2, 1) };
        break;
      case 'receptorQ':
        s = { font: `900 ${px(20, 13)}px ${FONT}`, color: '#ffffff', stroke: '#000000', strokeWidth: px(2, 1) };
        break;
      // The song-end sequence. Bigger than the HUD on purpose — it is read from across a room, by a
      // patient who has just stopped moving, and it is the last thing this screen says to them.
      case 'finaleTitle':
        s = { font: `italic 900 ${px(46, 24)}px ${FONT}`, color: '#ffffff', stroke: 'rgba(0,0,0,0.55)', strokeWidth: px(3, 1), glow: '#8fb4ff', glowBlur: px(18, 6) };
        break;
      case 'finaleSub':
        s = { font: `600 ${px(17, 12)}px ${FONT}`, color: UI_COLORS.textDim };
        break;
      // THE TYPE SCALE IS THE ORDERING. Results and History were both corrected to lead with the
      // work and fold the grade away; this card contradicted them, drawing a 58 px glowing gold
      // score over a 19 px sentence — so on a worst-case session the biggest thing on the screen
      // after the banner was a gold "0". The hero is now the count of movements performed, the warm
      // sentence is second, and the score is a quarter of the hero's size at the bottom of the card.
      case 'finaleHero':
        s = { font: `900 ${px(62, 32)}px ${FONT}`, color: '#ffffff', stroke: 'rgba(0,0,0,0.5)', strokeWidth: px(3, 1), glow: '#8fb4ff', glowBlur: px(18, 6) };
        break;
      case 'finaleHeroLabel':
        s = { font: `800 ${px(15, 11)}px ${FONT}`, color: UI_COLORS.text };
        break;
      case 'finaleScore':
        s = { font: `800 ${px(24, 15)}px ${FONT}`, color: '#ffd84a' };
        break;
      case 'finaleStat':
        s = { font: `800 ${px(28, 17)}px ${FONT}`, color: UI_COLORS.text, stroke: 'rgba(0,0,0,0.5)', strokeWidth: px(2, 1) };
        break;
      case 'finaleStatLabel':
        s = { font: `700 ${px(12, 11)}px ${FONT}`, color: UI_COLORS.textDim };
        break;
      case 'finaleAchievement':
        s = { font: `800 ${px(27, 15)}px ${FONT}`, color: '#ffd84a' };
        break;
      // THE QUALIFIER, NOT A CAPTION. This line is what makes the figure above it honest — "of the
      // range calibrated for THAT movement today", which is the difference between 95 % of a
      // patient's own calibrated range and 95 % of a normal joint. At `px(14, 11)` in 55 %-alpha
      // grey it was the smallest, faintest text on a card meant to be read from two metres, and it
      // was also the one string the layout truncated. It is now floored at 13 px, drawn at nearly
      // full contrast, and WRAPPED rather than cut (see `wrapFinaleNote`).
      case 'finaleNote':
        s = { font: `500 ${px(15, 13)}px ${FONT}`, color: 'rgba(242,244,255,0.86)' };
        break;
      case 'finaleHint':
        s = { font: `700 ${px(15, 11)}px ${FONT}`, color: UI_COLORS.text };
        break;
      case 'stats':
        s = { font: `${px(12, 10)}px ui-monospace, Menlo, Consolas, monospace`, color: '#9cffb0' };
        break;
      default: {
        // laneLabel:<hex>
        const color = name.startsWith('laneLabel:') ? name.slice('laneLabel:'.length) : UI_COLORS.text;
        // Movement labels are a clinical requirement (the four lanes are prescribed exercises and
        // the patient has to know which limb lane 3 is), so they stay — but they are a legend, not
        // the loudest object in the bottom third. Smaller than the receptor they name, lane-coloured
        // rather than white, and with a thinner outline, they sit under the fret hardware instead of
        // out-shouting the gems.
        const lw = this.geom.laneWidthNear;
        const fs = clamp(Math.round(lw * 0.105), 11, Math.round(20 * Math.max(1, u)));
        s = { font: `600 ${fs}px ${FONT}`, color, stroke: 'rgba(0,0,0,0.6)', strokeWidth: Math.max(1, Math.round(fs * 0.1)) };
      }
    }
    this.styleCache.set(name, s);
    return s;
  }

  /**
   * Combo counter. Lives in the right side panel (opposite the effort gauge), off the note path so
   * judgment popups never draw through it. When the side panel is too narrow (portrait / 4 lanes
   * on a narrow canvas) it moves to the top centre above the horizon.
   */
  /** `String(combo)` without a per-frame allocation (the value only changes on a hit). */
  private comboString(combo: number): string {
    if (combo !== this.comboStrN) {
      this.comboStrN = combo;
      this.comboStr = String(combo);
    }
    return this.comboStr;
  }

  /**
   * Where the combo block lives: the right side panel when it fits, else above the board. The
   * multiplier badge is anchored off this too, so the two halves of the streak readout stay one
   * group with a reserved slot instead of the badge sharing a corner with the song caption.
   */
  private comboAnchor(): { x: number; y: number; panel: boolean } {
    const g = this.geom;
    const u = this.u;
    const rightEdge = roadEdgeX(g, 1, 0);
    const panelW = this.width - rightEdge;
    if (panelW >= 110 * u) return { x: rightEdge + panelW / 2, y: g.strikeY - g.receptorRadius * 2.2, panel: true };
    return { x: g.vpX, y: Math.max(52 * u, g.horizonY - 40 * u), panel: false };
  }

  private drawCombo(ctx: Ctx2D, frame: RenderFrame, st: number): void {
    const u = this.u;
    const combo = Number.isFinite(frame.combo) ? Math.max(0, Math.floor(frame.combo)) : 0;
    if (combo > this.lastCombo) this.comboBounceT0 = st;
    if (combo === 0 && this.lastCombo > 0) this.comboBreakT0 = st;
    this.lastCombo = combo;
    const { x, y } = this.comboAnchor();
    const heat = clamp(combo / 50, 0, 1);
    const labelDy = 34 * u * (1 + heat * 0.2);
    const still = this.opts.reducedMotion;
    if (combo >= 2) {
      const age = st - this.comboBounceT0;
      const bounce = !still && age >= 0 && age < 0.25 ? Math.pow(1 - age / 0.25, 2) : 0;
      const scale = (1 + bounce * 0.35) * (1 + heat * 0.2);
      // Per-character sprites: the combo value changes constantly, so a whole-string sprite would
      // rasterize (and cache) a new ~350 KB canvas on every increment.
      this.text.drawChars(ctx, this.comboString(combo), x, y, this.style('combo'), scale, 0.95);
      this.text.draw(ctx, 'COMBO', x, y + labelDy, this.style('comboLabel'), 1, 0.9);
    } else {
      const age = st - this.comboBreakT0;
      if (age >= 0 && age < 0.5) {
        // Combo break: brief shake-out.
        const k = 1 - age / 0.5;
        const dx = still ? 0 : Math.sin(age * 60) * 6 * u * k;
        this.text.drawChars(ctx, this.comboString(this.lastComboShown), x + dx, y, this.style('combo'), 1, k * 0.5);
      }
    }
    if (combo >= 2) this.lastComboShown = combo;
  }

  /**
   * Effort gauge placement (centre + radius, CSS px): the one piece of HUD furniture that lives in the
   * board's LEFT GUTTER, which is also the only place an app can put an overlay panel. Extracted
   * from `drawHud` so `overlayPanel` reads the same numbers the gauge is drawn from rather than a
   * copy that can drift out of step with it.
   */
  private effortGaugeBox(): { x: number; y: number; r: number } {
    const g = this.geom;
    const pad = 16 * this.u;
    const leftPanelW = Math.max(0, roadEdgeX(g, -1, 0));
    const r = clamp(Math.min(leftPanelW * 0.3, this.height * 0.1, 90 * this.u), 18, 140);
    return { x: Math.max(r * 1.25 + pad, leftPanelW * 0.45), y: g.strikeY - r * 1.1, r };
  }

  /**
   * Where the APP may put a DOM overlay panel over this board — the play screen's camera
   * picture-in-picture and its lane meters (src/ui/Play.tsx).
   *
   * THE RENDERER HAS TO ANSWER THIS BECAUSE ONLY THE RENDERER KNOWS. The board is drawn in canvas
   * coordinates from the canvas size and the lane count: the strike line, the receptor radius, the
   * width of the gutter beside the road and the effort gauge standing in it all move with both. A
   * panel pinned in CSS to `left: 18px; bottom: 18px` therefore has no way to know that at
   * 1280x800 it is sitting exactly on lane 0's receptor and on the label that names the limb — and
   * it was: the default bilateral prescription read "knee lift" against a fully legible
   * "R knee lift" next door, so the one mark distinguishing the two lanes of the prescription was
   * behind the panel and a therapist had to say out loud which leg the receptor belonged to.
   *
   * `boardHardwareTop` is the hard constraint (nothing over the receptor row or its labels); the
   * gutter width at the panel's own bottom edge sets how wide it may be; the gauge keeps it from
   * landing on the effort gauge. See `overlayPanelBox` for the rules and for what gives way first.
   * Call it after `resize()` and whenever the lane count changes.
   */
  overlayPanel(req: { margin?: number; minWidth?: number; maxWidth?: number } = {}): OverlayPanelBox {
    const gauge = this.effortGaugeBox();
    return overlayPanelBox(this.geom, {
      floorY: Math.min(boardHardwareTop(this.geom), gauge.y - gauge.r),
      margin: req.margin ?? Math.max(10, Math.round(16 * this.u)),
      minWidth: req.minWidth ?? 150,
      maxWidth: req.maxWidth ?? 280,
    });
  }

  private drawHud(ctx: Ctx2D, frame: RenderFrame, dt: number, beatPulse: number): void {
    const W = this.width;
    const u = this.u;
    const pad = 16 * u;

    // Score (top-right, rolling digits). A non-finite score (or a display value that somehow went
    // non-finite) snaps rather than sticking there for the rest of the song.
    const target = Number.isFinite(frame.score) ? Math.max(0, frame.score) : 0;
    if (!Number.isFinite(this.displayScore)) this.displayScore = target;
    if (Math.abs(target - this.displayScore) < 0.5) this.displayScore = target;
    else this.displayScore += (target - this.displayScore) * clamp(dt * 9, 0, 1);
    const scoreStyle = this.style('score');
    const labelStyle = this.style('hudLabel');
    // Lay the top HUD out from the *actual* font sizes, not from `u`: the minimum legible sizes
    // (see `style()`) bind on a small canvas, and a layout scaled by `u` alone then ran the score
    // digits straight through the 'SCORE' label.
    const labelPx = fontPx(labelStyle.font);
    const scorePx = fontPx(scoreStyle.font);
    this.text.draw(ctx, 'SCORE', W - pad, pad + labelPx * 0.5, labelStyle, 1, 1, 'right');
    // Integer, never the fractional catch-up value: the odometer roll draws two glyph sets inside
    // one digit cell, and with a score that ticks on every hit it was mid-roll in almost every
    // frame. All three blind critics read the result as corrupted text. The value still eases
    // toward the target — it just lands on whole numbers, in fixed-advance tabular digits.
    this.digits.draw(ctx, Math.round(this.displayScore), W - pad, pad + labelPx + scorePx * 0.7, scoreStyle, 6, this.dpr);

    // Song title / attribution (top-left), fitted to the space left of the score readout so a long
    // CC-BY attribution string is ellipsized instead of running underneath the score.
    // 6 digits at ~0.62 em each, plus half an em of gutter so a fitted attribution never abuts the
    // score block.
    // ...and never wider than a corner block: a full CC-BY sentence run across the top of the frame
    // is the loudest "hobby build" tell there is. It stays legible and present (a licence
    // obligation), ellipsized into the corner it belongs in.
    const textRoom = Math.min(Math.max(60 * u, W - pad * 2 - scorePx * 4.9), W * 0.3);
    const titleStyle = this.style('title');
    const titlePx = fontPx(titleStyle.font);
    const titleY = pad + titlePx * 0.62;
    // ...and it does not stay all song. A shipped title shows the song block over the intro bars and
    // then gets out of the way; ours is also the only HUD element that is prose, so it is the one
    // most worth spending only the intro on. It is still on screen for `META_HOLD_SEC` — long
    // enough to read, and the attribution is repeated in song select and in the results screen, so
    // the licence obligation does not depend on this fade.
    const metaAge = this.stNow - META_HOLD_SEC;
    const metaAlpha = metaAge <= 0 ? 1 : clamp(1 - metaAge / META_FADE_SEC, 0, 1);
    if (metaAlpha > 0.01) {
      if (frame.songTitle) {
        this.text.draw(ctx, this.fitHud(0, frame.songTitle, titleStyle, textRoom), pad, titleY, titleStyle, 1, metaAlpha, 'left');
      }
      if (frame.attribution) {
        const aStyle = this.style('attribution');
        this.text.draw(ctx, this.fitHud(1, frame.attribution, aStyle, textRoom), pad, titleY + titlePx * 0.62 + fontPx(aStyle.font) * 0.72, aStyle, 1, metaAlpha, 'left');
      }
    }

    // Notes-answered gauge (left, arc gauge) — NOT a rock meter, and NOT a participation trophy.
    //
    // It used to be a rock meter: health started at 0.5, a miss took 0.03, and below 0.3 this gauge
    // pulsed red at ~1.6 Hz. In a game that can never be failed (see engine/rhythm.ts and the README)
    // that pulse was a failure alarm wired to nothing — a patient four weeks post-stroke was told,
    // urgently, that they were failing at a thing that has no failure. Its replacement (movements per
    // note offered, clamped to 1) went wrong the other way: a tremor session with 280 movements and
    // 12 hits pinned it full green. `frame.health` is now NOTES ANSWERED per note judged
    // (engine/scoring.ts `answerRateOf`) — bounded by the notes that were offered, so it can neither
    // alarm nor saturate for a patient who is flailing. No danger pulse, no alarm colour at the
    // bottom of the scale, and the gauge says what it counts.
    const health = clamp(frame.health, 0, 1);
    if (!Number.isFinite(this.healthSmooth)) this.healthSmooth = health;
    this.healthSmooth += (health - this.healthSmooth) * clamp(dt * 6, 0, 1);
    const hv = this.healthSmooth;
    // Size and place the gauge from the free space left of the road at the strike line (see
    // `effortGaugeBox` — `overlayPanel` reads the same numbers, so a DOM panel cannot land on it).
    const gauge = this.effortGaugeBox();
    const gaugeR = gauge.r;
    const gx = gauge.x;
    const gy = gauge.y;
    const a0 = Math.PI * 0.75;
    const a1 = Math.PI * 2.25;
    ctx.lineCap = 'round';
    ctx.lineWidth = gaugeR * 0.22;
    ctx.strokeStyle = 'rgba(255,255,255,0.10)';
    ctx.beginPath();
    ctx.arc(gx, gy, gaugeR, a0, a1);
    ctx.stroke();
    const hcol = hv < 0.5 ? mixHex(EFFORT_METER_COLORS.low, EFFORT_METER_COLORS.mid, hv * 2) : mixHex(EFFORT_METER_COLORS.mid, EFFORT_METER_COLORS.high, (hv - 0.5) * 2);
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = clamp(0.25 + beatPulse * 0.2, 0, 1);
    ctx.strokeStyle = hcol;
    ctx.lineWidth = gaugeR * 0.34;
    ctx.beginPath();
    ctx.arc(gx, gy, gaugeR, a0, a0 + (a1 - a0) * hv);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = hcol;
    ctx.lineWidth = gaugeR * 0.2;
    ctx.beginPath();
    ctx.arc(gx, gy, gaugeR, a0, a0 + (a1 - a0) * Math.max(0.001, hv));
    ctx.stroke();
    // Needle: pivots at the hub and sweeps *inside* the arc like a real gauge.
    const na = a0 + (a1 - a0) * hv;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = Math.max(2, gaugeR * 0.07);
    ctx.beginPath();
    ctx.moveTo(gx, gy);
    ctx.lineTo(gx + Math.cos(na) * gaugeR * 0.82, gy + Math.sin(na) * gaugeR * 0.82);
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(gx, gy, gaugeR * 0.12, 0, Math.PI * 2);
    ctx.fill();
    // Label in the arc's bottom gap. It names what the needle counts — notes answered with a
    // movement — because a dial nobody can name is how the rock meter got away with meaning nothing.
    // (A live percentage would be a fresh text sprite per value; the Results screen carries the
    // number.)
    this.text.draw(ctx, 'ANSWERED', gx, gy + gaugeR * 0.95, this.style('hudLabel'), 1, 0.9);

    // Multiplier badge under the gauge. A non-finite multiplier is a *missing* value: without the
    // guard `Math.floor(NaN)` made `mult !== lastMultiplier` true on every frame (the pop timer
    // restarted forever, freezing the badge at its 1.4x overshoot) and indexed BADGE_KEYS with
    // `undefined`, which then became a gradient-cache key.
    const mult = Number.isFinite(frame.multiplier) ? clamp(Math.floor(frame.multiplier), 1, 99) : 1;
    if (mult !== this.lastMultiplier) {
      this.multiplierPopT0 = this.stNow;
      this.lastMultiplier = mult;
    }
    const tier = multiplierTier(mult);
    const popAge = this.stNow - this.multiplierPopT0;
    const pop = !this.opts.reducedMotion && popAge >= 0 && popAge < 0.3 ? 1 + 0.4 * Math.pow(1 - popAge / 0.3, 2) : 1;
    // Under the COMBO readout on the opposite flank, in a slot of its own. It used to sit under the
    // rock gauge in the bottom-left corner, where the song caption landed on top of it.
    const anchor = this.comboAnchor();
    const badgeW = clamp(gaugeR * 1.5, 60 * u, this.width * 0.14);
    const bw = badgeW * pop;
    const bh = badgeW * 0.5 * pop;
    const bx = anchor.x - bw / 2;
    const by = anchor.y + (anchor.panel ? 58 * u : 46 * u);
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = clamp(0.25 + beatPulse * 0.25 * (mult - 1), 0, 1);
    ctx.fillStyle = tier.glow;
    roundRectPath(ctx, bx - 6 * u, by - 6 * u, bw + 12 * u, bh + 12 * u, bh * 0.5);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = this.grad(BADGE_KEYS[clamp(mult, 1, 4) - 1], () => {
      const bg = ctx.createLinearGradient(0, by, 0, by + badgeW * 0.5);
      bg.addColorStop(0, tier.color);
      bg.addColorStop(1, mixHex(tier.color, '#000000', 0.45));
      return bg;
    });
    roundRectPath(ctx, bx, by, bw, bh, bh * 0.35);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth = Math.max(1, 2 * u);
    ctx.stroke();
    this.text.draw(ctx, tier.label, anchor.x, by + bh / 2, this.style('mult'), (bh / (40 * u)) * 1.0, 1);
  }

  /**
   * Style-cache keys for the lane labels, built once per palette instead of interpolated every
   * frame (four template strings per frame is the kind of steady garbage this renderer avoids).
   * Index 0 = tracking (lane colour), index 1 = lost tracking (grey).
   */
  private labelKeys: string[][] = [];
  private labelKeyPalette = '';

  private laneLabelKey(lane: number, tracking: boolean): string {
    if (this.labelKeyPalette !== this.palette.name) {
      this.labelKeys.length = 0;
      for (let i = 0; i < MAX_LANES; i++) this.labelKeys.push([`laneLabel:${laneColor(this.palette, i).bright}`, 'laneLabel:#9a9aa0']);
      this.labelKeyPalette = this.palette.name;
    }
    return this.labelKeys[lane][tracking ? 0 : 1];
  }

  /**
   * Fitted lane labels. Recomputed only when the lanes or the layout change (never per frame): a
   * label is measured against the lane pitch and, when the labels are too wide for it, the rows are
   * staggered (odd lanes drop one line) so each label gets nearly two lane widths before anything
   * is ellipsized. Without this, four lanes on a 400 px-wide portrait canvas give a 46 px lane and
   * an 11 px font floor, i.e. "L knee lift" running straight through both neighbours.
   */
  private labelText: string[] = [];
  private labelMovement: string[] = [];
  private labelSide: string[] = [];
  /** Part of the cache key: two lanes can share movement+side and differ only by the opposed tip. */
  private labelFingertip: string[] = [];
  private labelStagger = false;
  private labelRowH = 0;
  private labelU = -1;
  private labelLaneW = -1;

  private ensureLabels(frame: RenderFrame): void {
    const g = this.geom;
    let ok = this.labelText.length === g.laneCount && this.labelU === this.u && this.labelLaneW === g.laneWidthNear;
    if (ok) {
      for (let lane = 0; lane < g.laneCount; lane++) {
        const spec = this.laneSpec(frame, lane);
        if (
          !spec ||
          this.labelMovement[lane] !== spec.movement ||
          this.labelSide[lane] !== spec.side ||
          this.labelFingertip[lane] !== (spec.fingertip ?? '')
        ) {
          ok = false;
          break;
        }
      }
    }
    if (ok) return;
    const style = this.style(this.laneLabelKey(0, true));
    const pitch = g.laneWidthNear;
    this.labelText.length = 0;
    this.labelMovement.length = 0;
    this.labelSide.length = 0;
    this.labelFingertip.length = 0;
    let widest = 0;
    for (let lane = 0; lane < g.laneCount; lane++) {
      const spec = this.laneSpec(frame, lane);
      const raw = spec ? laneLabel(spec) : '';
      this.labelText.push(raw);
      this.labelMovement.push(spec ? spec.movement : '');
      this.labelSide.push(spec ? spec.side : '');
      this.labelFingertip.push(spec ? (spec.fingertip ?? '') : '');
      widest = Math.max(widest, this.text.measure(raw, style));
    }
    // One row while everything fits inside its lane; two staggered rows otherwise (labels on the
    // same row are then two lanes apart, so they may be up to ~1.9 lane widths wide).
    this.labelStagger = widest > pitch * 0.96 && g.laneCount > 1;
    const allowed = this.labelStagger ? pitch * 1.9 : pitch * 0.96;
    for (let lane = 0; lane < g.laneCount; lane++) {
      this.labelText[lane] = this.text.fit(this.labelText[lane], style, allowed);
    }
    this.labelRowH = fontPx(style.font) * 1.15;
    this.labelU = this.u;
    this.labelLaneW = g.laneWidthNear;
  }

  private drawLabels(ctx: Ctx2D, frame: RenderFrame): void {
    const g = this.geom;
    this.ensureLabels(frame);
    const y = g.strikeY + g.receptorRadius * GEM_ASPECT + 22 * this.u;
    const rowH = this.labelRowH;
    for (let lane = 0; lane < g.laneCount; lane++) {
      const label = this.labelText[lane];
      if (!label) continue;
      // Post-hold tracking as `drawReceptors` resolved it this frame (it runs earlier in the
      // frame — see `draw`, where the receptor row is the last BOARD layer), not the raw
      // per-frame flag: a label that greys out on a single noisy frame while the receptor above it
      // stays live is the same two-meters-disagreeing failure the receptor contract exists to stop.
      const tracking = this.laneTracking[lane] === 1;
      const x = laneX(g, lane, -0.02);
      const row = this.labelStagger ? lane % 2 : 0;
      this.text.draw(ctx, label, x, y + row * rowH, this.style(this.laneLabelKey(lane, tracking)), 1, tracking ? 0.85 : 0.5);
    }
  }

  private drawStats(ctx: Ctx2D): void {
    const s = this.stats;
    const txt = `draw ${s.drawMs.toFixed(2)}ms avg ${s.avgDrawMs.toFixed(2)} max ${s.maxDrawMs.toFixed(1)} | frame ${s.avgFrameMs.toFixed(1)}ms (${s.fps.toFixed(0)} fps, ${s.longFrames} long) | notes ${s.notesDrawn} | particles ${s.particles} | sprites ${s.sprites} | ${this.width}x${this.height}@${this.dpr}`;
    const st = this.style('stats');
    ctx.save();
    ctx.font = st.font;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    const w = txt.length * 7.2 * this.u + 16;
    ctx.fillRect(this.width - w - 8, this.height - 26 * this.u, w, 22 * this.u);
    ctx.fillStyle = st.color;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(txt, this.width - 16, this.height - 15 * this.u);
    ctx.restore();
  }

  // ---------------------------------------------------------------------------------------------
  // The song-end sequence
  // ---------------------------------------------------------------------------------------------

  /**
   * Begin the song-end sequence. `GameRunner` calls this the moment the chart runs out and polls
   * `finaleDone()` for the hand-over to the report. Calling it twice is a no-op — the second chart
   * end (the mixer's `ended` event arriving after the clock's) must not restart the payoff.
   */
  startFinale(spec: FinaleSpec): void {
    if (this.finale) return;
    this.finale = spec;
    this.finaleT = 0;
    this.finaleConfettiT = 0;
    this.finaleStep = 0;
    for (const b of this.finaleBits) b.age = b.life;
    this.finaleColors = [];
    for (let i = 0; i < this.geom.laneCount; i++) this.finaleColors.push(laneColor(this.palette, i).bright);
    if (this.finaleColors.length === 0) this.finaleColors.push('#ffffff');
  }

  /**
   * Replace the WORDS AND FIGURES of a sequence already on screen, without touching its clock.
   *
   * The ending keeps counting: a camera session does not stop seeing the patient when the music
   * stops, and the movements they make over the payoff are counted into the same session (see
   * `GameRunner.onInput`). A card built once at the chart's end would therefore have gone stale
   * while it was being read — it would say 126 movements and the report would say 131 — so the
   * runner hands the card back whenever a count changes. `startFinale` still owns the timeline,
   * the confetti and the skip guard; this only swaps what is written on it. Ignored when no
   * sequence is playing, so it can never start one by the back door.
   */
  updateFinale(spec: FinaleSpec): void {
    if (!this.finale) return;
    this.finale = spec;
  }

  /** Live confetti pieces — the crowd, for a test that has to know whether it showed up. */
  finaleConfettiCount(): number {
    let n = 0;
    for (const b of this.finaleBits) if (b.age < b.life) n++;
    return n;
  }

  /** True between `startFinale` and `clearFinale` — the board is playing the ending. */
  isFinaleActive(): boolean {
    return this.finale !== null;
  }

  /**
   * Move the sequence on by `dtSec`.
   *
   * THE DRIVER IS THE RUNNER, NOT THIS CLASS, and that is deliberate: by the time the ending is on
   * screen the mixer has stopped, so there is no song clock to animate against, and a renderer that
   * reached for `performance.now()` of its own accord would be the one animation in this file that
   * no test and no critic harness could step. `GameRunner` already owns an injectable wall clock
   * (`nowMs`) for exactly this kind of thing, so it hands the seconds over. Clamped per call so one
   * long frame — a tab that was backgrounded over the celebration — cannot jump the whole sequence.
   */
  advanceFinale(dtSec: number): void {
    if (!this.finale || !Number.isFinite(dtSec) || dtSec <= 0) return;
    this.finaleStep = Math.min(dtSec, FINALE_MAX_STEP_SEC);
    this.finaleT += this.finaleStep;
  }

  /** Seconds the sequence has been on screen (its own wall clock; the song's may have stopped). */
  finaleElapsed(): number {
    return this.finale ? this.finaleT : 0;
  }

  /** True once the whole sequence has played (or been skipped). */
  finaleDone(): boolean {
    return this.finale !== null && this.finaleT >= FINALE_SEC;
  }

  /**
   * True once the ending has been on screen long enough to be skipped deliberately.
   *
   * THE GUARD IS NOT A DELAY FOR ITS OWN SAKE. The skip is "anything at all" — a tap anywhere, any
   * key — because the patient's hands may be the thing being measured and there is no controller.
   * That means the last rep's own key-up, a palm resting on a tablet, or a therapist's finger still
   * on the pause button would eat the entire payoff in the first frame. Half a second of the last
   * note landing is the whole reason the sequence exists.
   */
  finaleSkippable(): boolean {
    return this.finale !== null && this.finaleT >= FINALE_SKIP_GUARD_SEC;
  }

  /** Jump to the end of the sequence (therapist in a hurry). Ignored inside the skip guard. */
  skipFinale(): boolean {
    if (!this.finaleSkippable()) return false;
    this.finaleT = FINALE_SEC;
    return true;
  }

  /** Forget the sequence entirely (a new run on the same instance). */
  clearFinale(): void {
    this.finale = null;
    this.finaleT = 0;
    for (const b of this.finaleBits) b.age = b.life;
  }

  /**
   * THE ENDING THE SONG EARNS.
   *
   * A patient watched a score odometer climb for 97 seconds and a combo counter beside it, and then
   * the chart simply ran out: 1.5 s of empty highway and a cut to a results grid. Every shipped
   * rhythm game pays the player off at the end of a song, and this one has more reason to than most
   * — the run IS the therapy session, and the last thing the patient sees of it was nothing at all.
   *
   * The beats, in the order a player expects them — and in the order a REHAB session ranks them:
   *   0.0 s  the board dims behind a curtain while the last gem finishes falling, and the lanes
   *          throw their own colours up over the strike line (the crowd).
   *   0.35 s the title lands.
   *   0.95 s the HERO figure counts up — `stats[0]`, which the caller fills with movements
   *          performed. This is the odometer the patient watches settle, and it is the count of
   *          what they did rather than the grade they got for it.
   *   1.95 s the session's other counts arrive one at a time along a row.
   *   2.6 s  the one warm sentence about today lands on its ribbon, second-largest on the card.
   *   3.2 s  the SCORE rolls up, last and a bit over a third the hero's size, and settles at 4.6 s
   *          with two full seconds of the card still on screen.
   *   3.9 s  the hint that anything at all moves on.
   *
   * AND IT HAS TO BE WARM TO SOMEBODY WHO SCORED BADLY. Nothing here is a grade: there is no
   * pass/fail, no rank, no "you needed 40 % for a star". The score is stated because the patient
   * watched it all song and is owed the end of that animation — but it used to be 58 px of glowing
   * gold over a 19 px sentence, so on a session with six notes answered the biggest thing on the
   * card after the banner was a gold "0". Results and History were both corrected to lead with the
   * work and fold the grade away; this screen now agrees with them. `FinaleSpec.achievement` is
   * written by the caller — the renderer never invents praise it cannot support.
   */
  private drawFinale(ctx: Ctx2D, dt: number): void {
    const spec = this.finale;
    if (!spec) return;
    const t = this.finaleT;
    const W = this.width;
    const H = this.height;
    const u = this.u;
    const cx = W / 2;
    const calm = this.opts.reducedMotion;

    // The crowd: the patient's own lane colours thrown up over the strike line. Decorative, so it
    // follows `effectIntensity` and stops entirely under reduced motion.
    this.stepConfetti(dt, calm ? 0 : this.eff);

    // The curtain, over EVERYTHING including the HUD. The live score readout, the answered gauge and
    // the multiplier badge are all about a song that has finished, and at a gentler alpha they went
    // on competing with the ending for the eye — measured at 1280x800, the six-digit "000000" in the
    // top right was the brightest text on the screen while the card was reading out the real one.
    const curtain = clamp(t / FINALE_CURTAIN_SEC, 0, 1) * FINALE_CURTAIN_ALPHA;
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = withAlpha(UI_COLORS.background0, curtain);
    ctx.fillRect(0, 0, W, H);

    const appear = (at: number, dur = 0.28): number => (t <= at ? 0 : clamp((t - at) / dur, 0, 1));

    /**
     * ONE PANEL, AND EVERY LINE POSITIONED OFF IT.
     *
     * Laid out as fractions of the canvas, the ending's lower half landed on the receptor row and
     * the lane labels — the achievement ribbon sat across the strike line at 1280x800, which is the
     * one part of the board still drawing hardware. A panel is also what makes the card read as a
     * card at 1024x768, where the gems behind it are proportionally larger.
     */
    const stats = spec.stats.slice(0, FINALE_MAX_STATS);
    /** `stats[0]` is the hero; the rest share one row under it. */
    const hero = stats.length > 0 ? stats[0] : null;
    const rowStats = stats.slice(1);
    const hasRow = rowStats.length > 0;
    const hasAchievement = spec.achievement.length > 0;
    const hasNote = hasAchievement && !!spec.achievementNote;
    const panelW = Math.min(W - 40 * u, 700 * u);
    // THE NOTE IS MEASURED BEFORE THE PANEL IS SIZED, because it is the one block whose height the
    // canvas decides: it wraps to as many lines as the qualifier needs at this width, and the panel
    // is then built tall enough to hold them. The old fixed `22 * u` allowance is what forced the
    // line through an ellipsis in the first place.
    const noteStyle = this.style('finaleNote');
    const noteRoom = panelW - 40 * u;
    const noteLines = hasNote ? this.wrapFinaleNote(spec.achievementNote as string, noteStyle, noteRoom) : [];
    const noteLineH = Math.max(16 * u, fontPx(noteStyle.font) * 1.32);
    const noteGap = 8 * u;
    const noteBlockH = noteLines.length > 0 ? noteGap + noteLines.length * noteLineH : 0;
    // Every block's height, in the same numbers the cursor below advances by, so the panel is
    // exactly as tall as what is drawn in it at any canvas size.
    const panelH = Math.min(
      H - 40 * u,
      (134 + (hero ? 86 : 0) + (hasRow ? 84 : 0) + (hasAchievement ? 76 : 0) + 74) * u + noteBlockH,
    );
    const top = Math.max(20 * u, (H - panelH) / 2 - 10 * u);
    const panelIn = clamp(t / FINALE_CURTAIN_SEC, 0, 1);
    ctx.globalAlpha = panelIn * 0.94;
    ctx.fillStyle = FINALE_PANEL_FILL;
    roundRectPath(ctx, cx - panelW / 2, top, panelW, panelH, 20 * u);
    ctx.fill();
    ctx.globalAlpha = panelIn * 0.8;
    ctx.strokeStyle = FINALE_PANEL_LINE;
    ctx.lineWidth = Math.max(1, 1.5 * u);
    ctx.stroke();
    ctx.globalAlpha = 1;

    // OVER THE CURTAIN AND OVER THE CARD, UNDER THE WORDS. This is the beat where the room reacts,
    // and under the curtain it was not a beat at all — the colours were in the pixels at 12 % and
    // read as dust. Over the card and under the text it is a celebration that never costs a word
    // its legibility.
    this.drawConfetti(ctx);

    let y = top + 46 * u;

    // Title.
    const titleIn = appear(FINALE_TITLE_AT, 0.3);
    if (titleIn > 0) {
      const pop = calm ? 1 : 1 + 0.12 * (1 - easeOutCubic(titleIn));
      this.text.draw(ctx, spec.title, cx, y, this.style('finaleTitle'), pop, titleIn);
      if (spec.subtitle) {
        this.text.draw(
          ctx,
          this.fitFinale(0, spec.subtitle, this.style('finaleSub'), panelW - 48 * u),
          cx,
          y + 32 * u,
          this.style('finaleSub'),
          1,
          titleIn * 0.9,
        );
      }
    }
    // 88, not 78: at 1280 the subtitle's descenders sat 5 px above the hero figure's cap height.
    y += 88 * u;

    // THE HERO: what the patient DID. It counts up the way the score used to, because a count of
    // movements is the number this session is about — and on the run that matters most here (six
    // notes answered out of a hundred and eighty-nine) it is the only large figure on the card that
    // is worth anything at all.
    if (hero) {
      const heroIn = appear(FINALE_HERO_AT, 0.22);
      if (heroIn > 0) {
        const n = Number(hero.value);
        const roll =
          calm || !Number.isFinite(n)
            ? 1
            : easeOutCubic(clamp((t - FINALE_HERO_AT) / FINALE_HERO_ROLL_SEC, 0, 1));
        const shown = Number.isFinite(n) ? formatThousands(Math.round(n * roll)) : hero.value;
        this.text.drawChars(ctx, shown, cx, y, this.style('finaleHero'), 1, heroIn);
        this.text.draw(
          ctx,
          this.fitFinale(1, hero.label, this.style('finaleHeroLabel'), panelW - 48 * u),
          cx,
          y + 32 * u,
          this.style('finaleHeroLabel'),
          1,
          heroIn * 0.95,
        );
      }
      y += 86 * u;
    }

    // The session's other counts, arriving one at a time along one row under the hero.
    if (hasRow) {
      const colW = Math.min((panelW - 24 * u) / rowStats.length, 200 * u);
      y += 26 * u;
      for (let i = 0; i < rowStats.length; i++) {
        const a = appear(FINALE_STATS_AT + i * FINALE_STAT_STEP_SEC, 0.22);
        if (a <= 0) continue;
        const x = cx + (i - (rowStats.length - 1) / 2) * colW;
        this.text.drawChars(ctx, rowStats[i].value, x, y, this.style('finaleStat'), 1, a);
        this.text.draw(
          ctx,
          this.fitFinale(2 + i, rowStats[i].label, this.style('finaleStatLabel'), colW - 10 * u),
          x,
          y + 24 * u,
          this.style('finaleStatLabel'),
          1,
          a * 0.85,
        );
      }
      y += 58 * u;
    }

    // The one sentence about what this patient did today, on its own ribbon so it reads as the
    // point of the screen rather than as a caption under the score.
    if (hasAchievement) {
      const achIn = appear(FINALE_ACHIEVEMENT_AT, 0.32);
      y += 24 * u;
      if (achIn > 0) {
        const style = this.style('finaleAchievement');
        const room = panelW - 40 * u;
        const label = this.fitFinale(1 + FINALE_MAX_STATS, spec.achievement, style, room - 44 * u);
        const h = 50 * u;
        const wRibbon = Math.min(room, this.text.measure(label, style) + 44 * u);
        ctx.globalAlpha = achIn * 0.9;
        ctx.fillStyle = FINALE_RIBBON_FILL;
        roundRectPath(ctx, cx - wRibbon / 2, y - h / 2, wRibbon, h, h / 2);
        ctx.fill();
        ctx.globalAlpha = achIn;
        ctx.strokeStyle = FINALE_RIBBON_LINE;
        ctx.lineWidth = Math.max(1, 1.5 * u);
        ctx.stroke();
        ctx.globalAlpha = 1;
        this.text.draw(ctx, label, cx, y, style, 1, achIn);
        // The qualifier, on as many lines as it takes. Drawn at nearly the ribbon's own opacity:
        // it is the sentence that decides what the percentage above it means, not a footnote.
        let ny = y + h / 2 + noteGap + noteLineH / 2;
        for (const line of noteLines) {
          this.text.draw(ctx, line, cx, ny, noteStyle, 1, achIn * 0.95);
          ny += noteLineH;
        }
      }
      y += 52 * u + noteBlockH;
    }

    // THE SCORE, LAST AND SMALL — but still SEEN TO SETTLE. The patient watched this odometer climb
    // for ninety-seven seconds and is owed the end of that animation; what they are not owed is a
    // grade three times the size of the sentence about their own work. It rolls up after the
    // sentence has landed and finishes with well over a second of the card still on screen.
    const scoreIn = appear(FINALE_SCORE_AT, 0.2);
    if (scoreIn > 0) {
      const roll = calm ? 1 : easeOutCubic(clamp((t - FINALE_SCORE_AT) / FINALE_SCORE_ROLL_SEC, 0, 1));
      this.text.draw(ctx, 'POINTS THIS SESSION', cx, y + 26 * u, this.style('finaleStatLabel'), 1, scoreIn * 0.85);
      this.text.drawChars(ctx, formatThousands(Math.round(spec.score * roll)), cx, y + 48 * u, this.style('finaleScore'), 1, scoreIn);
    }
    y += 74 * u;

    // "Anything at all moves on." Only once the skip really works, so the screen never invites a
    // tap it is about to ignore.
    const hintIn = appear(FINALE_HINT_AT, 0.4);
    if (hintIn > 0 && spec.hint) {
      const breathe = calm ? 1 : 0.72 + 0.28 * Math.sin(t * 2.6);
      // FIT IT. The hint sits outside the panel and is the one finale string that was drawn raw, so
      // at 1024x768 a sentence that also tells the patient they can stop moving ran off both edges.
      const style = this.style('finaleHint');
      this.text.draw(
        ctx,
        this.fitFinale(3 + FINALE_MAX_STATS, spec.hint, style, W - 32 * u),
        cx,
        Math.min(H - 24 * u, top + panelH + 30 * u),
        style,
        1,
        hintIn * breathe,
      );
    }

    ctx.globalAlpha = 1;
  }

  /** Spawn and move the ending's confetti. `intensity` is 0 under reduced motion — no pieces at all. */
  private stepConfetti(dt: number, intensity: number): void {
    const g = this.geom;
    const u = this.u;
    if (intensity > 0 && this.finaleT < FINALE_CONFETTI_SEC) {
      this.finaleConfettiT += dt;
      const per = 1 / (FINALE_CONFETTI_RATE * intensity);
      const left = roadEdgeX(g, -1, 0);
      const span = Math.max(1, roadEdgeX(g, 1, 0) - left);
      while (this.finaleConfettiT >= per) {
        this.finaleConfettiT -= per;
        const bit = this.freeBit();
        if (!bit) break;
        bit.x = left + this.rng() * span;
        bit.y = g.strikeY + 8 * u;
        bit.vx = (this.rng() - 0.5) * 150 * u;
        bit.vy = -(320 + this.rng() * 360) * u;
        bit.age = 0;
        bit.life = 1.3 + this.rng() * 1.1;
        bit.color = this.finaleColors[Math.floor(this.rng() * this.finaleColors.length)] ?? '#ffffff';
        bit.size = (4.5 + this.rng() * 4.5) * u;
        bit.spin = 4 + this.rng() * 7;
      }
    }
    for (const b of this.finaleBits) {
      if (b.age >= b.life) continue;
      b.age += dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.vy += 300 * u * dt;
      b.vx *= 1 - Math.min(1, 0.6 * dt);
    }
  }

  private freeBit(): ConfettiBit | null {
    for (const b of this.finaleBits) if (b.age >= b.life) return b;
    if (this.finaleBits.length >= FINALE_CONFETTI_MAX) return null;
    const b: ConfettiBit = { x: 0, y: 0, vx: 0, vy: 0, age: 0, life: 0, color: '#ffffff', size: 1, spin: 1 };
    this.finaleBits.push(b);
    return b;
  }

  private drawConfetti(ctx: Ctx2D): void {
    let any = false;
    for (const b of this.finaleBits) if (b.age < b.life) { any = true; break; }
    if (!any) return;
    ctx.globalCompositeOperation = 'lighter';
    for (const b of this.finaleBits) {
      if (b.age >= b.life) continue;
      const k = b.age / b.life;
      // Full strength for most of its fall, then out — a long linear fade leaves a haze of
      // near-invisible specks over the card for seconds.
      ctx.globalAlpha = clamp(k > 0.7 ? (1 - k) / 0.3 : 1, 0, 1) * 0.95;
      ctx.fillStyle = b.color;
      // Tumbling, without a transform per piece: the width breathes while the height stays put.
      // Never edge-on: a piece drawn at 0.6 px wide is a hairline, not a flake, and a field of them
      // reads as interference on the panel rather than as a celebration.
      const w = Math.max(b.size * 0.4, b.size * Math.abs(Math.cos(b.age * b.spin)));
      ctx.fillRect(b.x - w / 2, b.y - b.size / 2, w, b.size * 1.6);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  /**
   * The achievement's second line, broken across lines at word boundaries so NOTHING IS CUT.
   *
   * `TextCache.fit` — what every other string on this card goes through — truncates with an
   * ellipsis, which is right for a lane label that has a neighbour to collide with and wrong for
   * the one line on the screen whose job is to qualify a number. Greedy wrap, one `measure` per
   * word on a cold path (the note changes once a session), cached on the font and the room so a
   * resize re-wraps and a frame does not.
   *
   * The backstop at `FINALE_NOTE_MAX_LINES` exists for input this card is not supposed to be handed
   * (a single unbreakable word wider than the panel, a note ten lines long); real notes come back
   * in two or three lines at 1024x768 and the panel is sized from the count either way.
   */
  private wrapFinaleNote(text: string, style: TextStyle, room: number): string[] {
    const key = `${style.font}|${Math.round(room)}|${text}`;
    if (this.finaleNoteKey === key) return this.finaleNoteLines;
    const lines: string[] = [];
    let line = '';
    for (const word of text.split(/\s+/)) {
      if (word === '') continue;
      const next = line === '' ? word : `${line} ${word}`;
      if (line !== '' && this.text.measure(next, style) > room) {
        lines.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    if (line !== '') lines.push(line);
    if (lines.length > FINALE_NOTE_MAX_LINES) lines.length = FINALE_NOTE_MAX_LINES;
    // A word longer than the panel is the only thing left that can overflow; it is ellipsised
    // rather than allowed to run off both edges.
    for (let i = 0; i < lines.length; i++) {
      if (this.text.measure(lines[i], style) > room) lines[i] = this.text.fit(lines[i], style, room);
    }
    this.finaleNoteKey = key;
    this.finaleNoteLines = lines;
    return lines;
  }

  /** `fitHud`'s cold-path cache, for the finale's strings (they change once per session). */
  private fitFinale(slot: number, text: string, style: TextStyle, room: number): string {
    const i = FINALE_FIT_BASE + slot;
    if (this.hudSrc[i] !== text || this.hudRoom[i] !== room) {
      this.hudSrc[i] = text;
      this.hudRoom[i] = room;
      this.hudFit[i] = this.text.fit(text, style, room);
    }
    return this.hudFit[i];
  }
}

/** Convenience: build a RenderFrame with sensible defaults (useful for tests and demos). */
export function makeFrame(partial: Partial<RenderFrame> & Pick<RenderFrame, 'lanes'>): RenderFrame {
  const lanes = partial.lanes;
  return {
    songTime: 0,
    notes: [],
    laneStates: lanes.map(() => ({ value: 0, armed: true, tracking: true })),
    combo: 0,
    multiplier: 1,
    score: 0,
    health: 0.5,
    recentHits: [],
    bpm: 120,
    beatPhase: 0,
    ...partial,
  };
}
