import { resolveDifficulty } from '../engine/difficulty.ts';
import { validateTimingWindows } from '../engine/judge.ts';
import type { Chart, Difficulty, DifficultyName, Note } from '../engine/types.ts';

/** Subset of the song manifest needed to build a beat grid. */
export interface SongGrid {
  id: string;
  bpm: number;
  /** Seconds from audio start to the first beat (= the first bar's downbeat). */
  offset: number;
  durationSec: number;
  beatsPerBar?: number;
}

export interface GenerateOptions {
  /** Guarantee a note on every bar downbeat whenever a pacing-feasible pattern exists (default true). */
  accents?: boolean;
  /** Beats of silence before the first note (default 2). */
  leadInBeats?: number;
  /** Seconds at the end of the song kept free of notes (default 1). */
  tailSec?: number;
  /** Bars per repeating phrase; the last bar of each phrase is a seeded variation (default 4). */
  phraseBars?: number;
  /** Override the per-lane minimum spacing (seconds). */
  minLaneSpacingSec?: number;
  /** Override the minimum gap between any two notes regardless of lane (seconds). */
  minCrossLaneGapSec?: number;
  /**
   * Called once per diagnostic by `generateChart` (which otherwise has nowhere to put them).
   * `generateChartDetailed` returns the same strings in `warnings` and ignores this.
   */
  onWarning?: (warning: string) => void;
}

/** Minimum time between two notes in the same lane (rehab pacing: a rep must return to rest). */
export const MIN_LANE_SPACING_SEC: Readonly<Record<DifficultyName, number>> = Object.freeze({
  easy: 0.9,
  medium: 0.6,
  hard: 0.45,
});

/**
 * Preferred minimum time between two notes in *different* lanes (rehab pacing: on easy a patient
 * should not be asked to fire two limbs 250 ms apart). Unlike `MIN_LANE_SPACING_SEC` this is not in
 * the spec — it is a pacing preference, and it is capped at one beat by
 * `defaultCrossLaneGapSec` (see there).
 */
export const MIN_CROSS_LANE_GAP_SEC: Readonly<Record<DifficultyName, number>> = Object.freeze({
  easy: 0.45,
  medium: 0.25,
  hard: 0.15,
});

/**
 * The cross-lane gap actually used by `generateChart`: the difficulty's preference, capped at ONE
 * BEAT — the beat grid is the pacing unit, and a gap that is not expressible on it costs real reps
 * on a rounding cliff. Without the cap, easy at 134–180 bpm asks for 0.45 s while two on-beat notes
 * a bar apart are 0.448 s apart, so the whole 2-notes-per-bar family becomes infeasible and the
 * chart falls to 0.333 notes/beat against a nominal 0.5 — a third fewer reps than the difficulty
 * promises, from a 0.5 % rounding miss. The per-lane spacing (`MIN_LANE_SPACING_SEC`, the
 * spec's return-to-rest constraint) is never relaxed; only this preference is.
 *
 * Pass `GenerateOptions.minCrossLaneGapSec` to override it exactly (no cap applied).
 */
export function defaultCrossLaneGapSec(difficulty: DifficultyName, bpm: number): number {
  const pref = MIN_CROSS_LANE_GAP_SEC[difficulty] ?? 0;
  const beatSec = Number.isFinite(bpm) && bpm > 0 ? 60 / bpm : 0.5;
  return Math.min(pref, beatSec);
}

/**
 * THE PACING FLOOR A THERAPIST SETS, not a side effect of the difficulty they picked.
 *
 * `MIN_LANE_SPACING_SEC` is keyed on difficulty, so choosing "medium" for the timing windows also
 * chose 0.6 s between reps of the same limb — a number that came from rhythm-game feel, not from
 * physiology, and that moved whenever the therapist changed their mind about the windows. A seated
 * march or a knee extension on an impaired limb needs time to come back to rest before the next rep,
 * and that requirement does not change because the windows got tighter.
 *
 * So the session carries its own floor (`SessionConfig.laneRestSec`), defaulting to this: 1.2 s
 * between two notes in ONE lane, i.e. at most 50 reps per minute per limb. Raise it for a patient
 * who needs longer to return to rest; lower it (down to `MIN_LANE_REST_SEC`) for a fast, mild case.
 */
export const DEFAULT_LANE_REST_SEC = 1.2;
/** Bounds of the therapist's pacing control (seconds between two reps in the same lane). */
export const MIN_LANE_REST_SEC = 0.35;
export const MAX_LANE_REST_SEC = 6;

/** Clamp a therapist pacing floor; a non-finite value falls back to the default. */
export function clampLaneRestSec(sec: number): number {
  if (!Number.isFinite(sec)) return DEFAULT_LANE_REST_SEC;
  return Math.min(MAX_LANE_REST_SEC, Math.max(MIN_LANE_REST_SEC, sec));
}

/** Reps per minute a pacing floor allows in one lane. */
export function repsPerMinuteAt(restSec: number): number {
  const s = clampLaneRestSec(restSec);
  return 60 / s;
}

/**
 * THE THERAPEUTIC DOSE of a generated chart: how many reps of each movement the patient is about to
 * be asked for, and how fast. A therapist prescribing exercise has to see this BEFORE the session —
 * it is the prescription — and until this existed the only way to know was to count the notes on the
 * highway afterwards.
 */
export interface ChartDose {
  notes: number;
  lanes: number;
  /** Notes (= reps asked for) in each lane, indexed by lane. */
  perLane: number[];
  /** Seconds from the first note to the last: the working part of the song. */
  spanSec: number;
  /** Mean reps asked of one lane. */
  repsPerLane: number;
  /** Reps per minute in the busiest lane — the rate ONE limb works at. */
  repsPerMinPerLane: number;
  /** Reps per minute across every lane — the rate the patient works at. */
  totalRepsPerMin: number;
  /** Shortest gap between two notes in the same lane (seconds); Infinity when no lane has two. */
  minLaneGapSec: number;
}

/** Measure the dose of a chart (see `ChartDose`). Pure; safe to call from a render. */
export function chartDose(chart: Pick<Chart, 'notes' | 'lanes'>): ChartDose {
  const lanes = Math.max(1, Math.floor(chart.lanes));
  const perLane = new Array<number>(lanes).fill(0);
  const lastTime = new Array<number>(lanes).fill(Number.NaN);
  let minGap = Infinity;
  let first = Infinity;
  let last = -Infinity;
  const sorted = [...chart.notes].sort((a, b) => a.time - b.time);
  for (const n of sorted) {
    if (!Number.isFinite(n.time)) continue;
    if (n.time < first) first = n.time;
    if (n.time > last) last = n.time;
    if (n.lane < 0 || n.lane >= lanes) continue;
    perLane[n.lane]++;
    const prev = lastTime[n.lane];
    if (Number.isFinite(prev)) minGap = Math.min(minGap, n.time - prev);
    lastTime[n.lane] = n.time;
  }
  const notes = sorted.length;
  const spanSec = Number.isFinite(first) && last > first ? last - first : 0;
  const minutes = spanSec / 60;
  const busiest = perLane.reduce((a, b) => Math.max(a, b), 0);
  return {
    notes,
    lanes,
    perLane,
    spanSec,
    repsPerLane: perLane.reduce((a, b) => a + b, 0) / lanes,
    repsPerMinPerLane: minutes > 0 ? busiest / minutes : 0,
    totalRepsPerMin: minutes > 0 ? notes / minutes : 0,
    minLaneGapSec: minGap,
  };
}

export const CHART_FORMAT_VERSION = 1;

/** Lane share imbalance (max/min) above which a warning is emitted. */
export const LANE_SHARE_WARN_RATIO = 1.15;
/** Off-beat fraction above which an easy chart gets a warning. */
export const EASY_OFFBEAT_WARN_FRACTION = 0.1;
/** Bars longer than this are laid out as repeated 8-beat pattern groups (pattern search is 2^(2*beats)). */
export const MAX_PATTERN_BEATS_PER_BAR = 8;

/** Small fast seeded PRNG (mulberry32); returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SLOTS_PER_BEAT = 2; // half-beat resolution
const EPS = 1e-9;
/** A variation bar may use any pattern scoring within this much of the best pattern of its note count. */
const VARIATION_SCORE_SLACK = 24;
/** A "B" section may swap the base pattern for one scoring within this much of the best. */
const SECTION_SCORE_SLACK = 6;
/** Variation bars pick uniformly among this many top candidates. */
const VARIATION_TOP_K = 4;
/** Phrases per section (A A A A B B B B ...). */
const PHRASES_PER_SECTION = 4;

/* ---------- bar patterns ---------- */

/** One bar's rhythm: which half-beat slots carry a note. */
export interface BarPattern {
  /** Bit s set = note on slot s (slot 0 = downbeat, even slots = beats, odd slots = off-beats). */
  mask: number;
  slots: readonly number[];
  count: number;
  /** Musicality score (higher = more on-beat, downbeat present, evenly spread). */
  score: number;
  downbeat: boolean;
  /** Number of notes on off-beats. */
  offBeats: number;
}

interface PatternTable {
  slotsPerBar: number;
  /** Feasible patterns per note count, best first, at most `PATTERNS_PER_COUNT` of them. */
  byCount: BarPattern[][];
  /** Same, restricted to patterns with every note on a beat (kept separately so truncation cannot hide them). */
  onBeatByCount: BarPattern[][];
  /** Largest note count that has a feasible pattern. */
  maxCount: number;
  /** Largest note count that has a feasible pattern with every note on a beat. */
  maxOnBeatCount: number;
}

/**
 * Patterns retained per note count (and per count for the on-beat-only list). The consumers pick
 * the best pattern, or uniformly among the handful within `VARIATION_SCORE_SLACK` of it, so keeping
 * every one of the (up to 65 536) feasible masks buys nothing and costs both the build time and
 * ~6 MB per cached table. Truncation is a streaming top-K by the same (score, mask) order the
 * consumers see, so the retained patterns — and therefore the generated chart — are exactly those
 * the untruncated table would have offered.
 */
export const PATTERNS_PER_COUNT = 64;

const EMPTY_PATTERN: BarPattern = Object.freeze({ mask: 0, slots: Object.freeze([]) as readonly number[], count: 0, score: 0, downbeat: false, offBeats: 0 });

/**
 * A bar pattern is feasible when, repeated forever, it honours both pacing constraints on the
 * half-beat grid: consecutive notes >= crossGapSlots apart and no window of laneGapSlots
 * consecutive slots holding more than `lanes` notes. The second condition is exactly what makes a
 * round-robin lane assignment valid: notes k and k+lanes are then always >= laneGapSlots apart.
 *
 * The window count is done with rotations + popcount instead of an O(slots x laneGap) walk: with
 * laneGapSlots = q*slotsPerBar + r, a window of laneGapSlots consecutive ring positions covers
 * every note q times plus the notes in the remaining r positions (the same counting-with-repetition
 * the walk did).
 */
function periodicFeasible(mask: number, slots: readonly number[], slotsPerBar: number, lanes: number, laneGapSlots: number, crossGapSlots: number): boolean {
  const n = slots.length;
  if (n === 0) return true;
  for (let i = 0; i < n; i++) {
    const next = i + 1 < n ? slots[i + 1] : slots[0] + slotsPerBar;
    if (next - slots[i] < crossGapSlots) return false;
  }
  if (laneGapSlots <= 1) return true; // a 1-slot window holds at most one note, and lanes >= 1
  const q = Math.floor(laneGapSlots / slotsPerBar);
  const r = laneGapSlots - q * slotsPerBar;
  const base = n * q;
  if (base > lanes) return false;
  if (r === 0) return true;
  const full = slotsPerBar >= 31 ? -1 >>> 0 : (1 << slotsPerBar) - 1;
  const window = (1 << r) - 1;
  for (let s = 0; s < slotsPerBar; s++) {
    const rot = ((mask >>> s) | (mask << (slotsPerBar - s))) & full;
    if (base + popcount(rot & window) > lanes) return false;
  }
  return true;
}

function popcount(x: number): number {
  let v = x - ((x >> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >> 2) & 0x33333333);
  v = (v + (v >> 4)) & 0x0f0f0f0f;
  return (Math.imul(v, 0x01010101) >> 24) & 0x3f;
}

function beatStrength(beat: number, beatsPerBar: number): number {
  if (beat === 0) return 3;
  if (beatsPerBar % 2 === 0 && beat === beatsPerBar / 2) return 2;
  return 1;
}

function scorePattern(mask: number, slots: readonly number[], slotsPerBar: number, beatsPerBar: number, accents: boolean): number {
  let sc = 0;
  for (const s of slots) {
    if (s % SLOTS_PER_BEAT === 0) sc += 10 + 2 * beatStrength(s / SLOTS_PER_BEAT, beatsPerBar);
    else {
      sc -= 10; // off-beat
      if (mask & (1 << (s - 1))) {
        sc += 4; // "1 &" figure: off-beat right after a played beat
        if (beatStrength((s - 1) / SLOTS_PER_BEAT, beatsPerBar) >= 2) sc += 2;
      }
    }
  }
  if (accents && (mask & 1) !== 0) sc += 30;
  if (slots.length >= 2) {
    let maxGap = 0;
    let minGap = Infinity;
    for (let i = 0; i < slots.length; i++) {
      const next = i + 1 < slots.length ? slots[i + 1] : slots[0] + slotsPerBar;
      const g = next - slots[i];
      if (g > maxGap) maxGap = g;
      if (g < minGap) minGap = g;
    }
    sc -= 3 * (maxGap - minGap); // evenly spread beats
  }
  return sc;
}

/**
 * Memo for `buildPatternTableUncached`: the search is O(2^(2*beatsPerBar)) in the worst case and
 * would otherwise be repeated on every generateChart call (tens of ms for an 8-beat bar — a visible
 * stall at session setup). The table is a pure function of the key and is never mutated after
 * construction.
 */
const patternTableCache = new Map<string, PatternTable>();
const PATTERN_TABLE_CACHE_MAX = 64;

function buildPatternTable(beatsPerBar: number, lanes: number, laneGapSlots: number, crossGapSlots: number, accents: boolean): PatternTable {
  const key = `${beatsPerBar}|${lanes}|${laneGapSlots}|${crossGapSlots}|${accents ? 1 : 0}`;
  const hit = patternTableCache.get(key);
  if (hit) return hit;
  const table = buildPatternTableUncached(beatsPerBar, lanes, laneGapSlots, crossGapSlots, accents);
  if (patternTableCache.size >= PATTERN_TABLE_CACHE_MAX) patternTableCache.clear();
  patternTableCache.set(key, table);
  return table;
}

/**
 * Enumerate every bar-periodic feasible pattern, best first per note count.
 *
 * Depth-first over slots in increasing order rather than a scan of all 2^(2*beatsPerBar) masks: the
 * cross-lane gap and the lane window are enforced *while* building a candidate, so infeasible
 * prefixes are never extended. The set of patterns produced is identical to the exhaustive scan's
 * (both conditions are necessary, and the cyclic check still runs on every complete candidate), and
 * only the top `PATTERNS_PER_COUNT` per note count are materialised — a candidate that cannot reach
 * a full list is dropped before its slot array is allocated.
 *
 * Measured on the worst case an 8-beat bar can produce (60 bpm hard, 4 lanes: both gaps round down
 * to one half-beat slot, so nothing prunes and all 2^16 masks are visited): 77.7 ms before, 29 ms
 * cold / 9.4 ms warm now. A 7/8 song at 90 bpm went 19.4 -> 3.5 ms and 4/4 stays under 0.2 ms; a
 * cached table is also ~6 MB smaller in the unconstrained case. The table is cached by key in
 * `buildPatternTable`, so this runs once per configuration, not once per `generateChart`.
 */
function buildPatternTableUncached(beatsPerBar: number, lanes: number, laneGapSlots: number, crossGapSlots: number, accents: boolean): PatternTable {
  const S = beatsPerBar * SLOTS_PER_BEAT;
  const byCount: BarPattern[][] = [];
  const onBeatByCount: BarPattern[][] = [];
  for (let c = 0; c <= S; c++) {
    byCount.push([]);
    onBeatByCount.push([]);
  }
  // Necessary conditions implied by periodicFeasible, used to bound the search depth.
  const maxCountBound = Math.min(S, Math.floor(S / crossGapSlots), Math.floor((S * lanes) / laneGapSlots));
  const slots: number[] = [];
  const byScore = (a: BarPattern, b: BarPattern): number => b.score - a.score || a.mask - b.mask;
  // Score below which a count's list is already full of strictly better patterns; a candidate under
  // it cannot reach the final top-K, so it is dropped before anything is allocated for it.
  const cutoff = new Array<number>(S + 1).fill(Number.NEGATIVE_INFINITY);
  const onBeatCutoff = new Array<number>(S + 1).fill(Number.NEGATIVE_INFINITY);
  /** Streaming top-K: only ever discards patterns that `PATTERNS_PER_COUNT` retained ones beat. */
  const keep = (list: BarPattern[], p: BarPattern, cuts: number[], count: number): void => {
    list.push(p);
    if (list.length >= 4 * PATTERNS_PER_COUNT) {
      list.sort(byScore);
      list.length = PATTERNS_PER_COUNT;
      cuts[count] = list[PATTERNS_PER_COUNT - 1].score;
    }
  };

  const record = (mask: number): void => {
    if (!periodicFeasible(mask, slots, S, lanes, laneGapSlots, crossGapSlots)) return;
    const count = slots.length;
    let offBeats = 0;
    for (const x of slots) if (x % SLOTS_PER_BEAT !== 0) offBeats++;
    const score = scorePattern(mask, slots, S, beatsPerBar, accents);
    const wanted = score >= cutoff[count];
    const wantedOnBeat = offBeats === 0 && score >= onBeatCutoff[count];
    if (!wanted && !wantedOnBeat) return;
    const pattern: BarPattern = { mask, slots: slots.slice(), count, score, downbeat: (mask & 1) !== 0, offBeats };
    if (wanted) keep(byCount[count], pattern, cutoff, count);
    if (wantedOnBeat) keep(onBeatByCount[count], pattern, onBeatCutoff, count);
  };

  /** Extend `slots` (strictly increasing, linear constraints already satisfied) with slots >= from. */
  const extend = (from: number, mask: number): void => {
    record(mask);
    if (slots.length >= maxCountBound) return;
    for (let s = from; s < S; s++) {
      // lane window: at most `lanes` notes in any laneGapSlots consecutive slots (linear form —
      // a relaxation of the cyclic test, so pruning here can never drop a feasible pattern)
      let cnt = 1;
      for (let j = slots.length - 1; j >= 0 && slots[j] > s - laneGapSlots; j--) cnt++;
      if (cnt > lanes) continue;
      slots.push(s);
      extend(s + crossGapSlots, mask | (1 << s));
      slots.pop();
    }
  };

  if (accents) {
    // every non-empty bar starts on the downbeat
    record(0);
    slots.push(0);
    extend(crossGapSlots, 1);
    slots.pop();
  } else {
    extend(0, 0);
  }

  let maxCount = 0;
  let maxOnBeatCount = 0;
  for (let c = 0; c <= S; c++) {
    byCount[c].sort(byScore);
    if (byCount[c].length > PATTERNS_PER_COUNT) byCount[c].length = PATTERNS_PER_COUNT;
    onBeatByCount[c].sort(byScore);
    if (onBeatByCount[c].length > PATTERNS_PER_COUNT) onBeatByCount[c].length = PATTERNS_PER_COUNT;
    if (byCount[c].length > 0) maxCount = c;
    if (onBeatByCount[c].length > 0) maxOnBeatCount = c;
  }
  return { slotsPerBar: S, byCount, onBeatByCount, maxCount, maxOnBeatCount };
}

/** Linear feasibility of `prev` followed by `cur` (only the bar boundary can fail when both are periodic-feasible). */
function compatible(prev: BarPattern | null, cur: BarPattern, slotsPerBar: number, lanes: number, laneGapSlots: number, crossGapSlots: number): boolean {
  if (prev === null || prev.count === 0 || cur.count === 0) return true;
  const seq: number[] = [];
  for (const s of prev.slots) seq.push(s - slotsPerBar);
  for (const s of cur.slots) seq.push(s);
  for (let i = prev.count; i < seq.length; i++) {
    if (seq[i] - seq[i - 1] < crossGapSlots) return false;
    let cnt = 1;
    for (let j = i - 1; j >= 0 && seq[j] > seq[i] - laneGapSlots; j--) cnt++;
    if (cnt > lanes) return false;
  }
  return true;
}

/* ---------- density budget ---------- */

export interface DensityBudget {
  /** Difficulty's nominal notes per beat. */
  targetDensity: number;
  /** Theoretical maximum notes per beat under the lane / cross-lane spacing constraints on the half-beat grid (any rhythm). */
  maxFeasibleDensity: number;
  /**
   * Maximum notes per beat of a bar-periodic pattern that honours the constraints (and carries the
   * downbeat when accents are on), off-beats allowed.
   */
  maxBarDensity: number;
  /** Same, but with every note on a beat. */
  maxOnBeatDensity: number;
  /**
   * Density the generator actually aims for: min(target, maxOnBeatDensity) when the target is at
   * most one note per beat (easy/medium: syncopation is never a substitute for pacing), otherwise
   * min(target, maxBarDensity).
   */
  effectiveTargetDensity: number;
  /** Minimum same-lane gap in half-beat slots. */
  laneGapSlots: number;
  /** Minimum any-lane gap in half-beat slots. */
  crossGapSlots: number;
  /** Same-lane spacing the budget was built for (seconds) — the spec's return-to-rest constraint. */
  minLaneSpacingSec: number;
  /** Cross-lane gap the budget was built for (seconds); see `defaultCrossLaneGapSec` for the cap. */
  minCrossLaneGapSec: number;
  /** Beats per bar the patterns were built for (input clamped to [1, MAX_PATTERN_BEATS_PER_BAR]). */
  beatsPerBar: number;
  /**
   * 0 in the normal case (every bar carries a pattern). Otherwise the pacing constraints make even
   * ONE note per bar infeasible when repeated (e.g. a 2/4 bar at 134 bpm is 0.896 s, just under the
   * 0.9 s easy lane spacing) and the generator falls back to one note every `sparseBarStride` bar
   * downbeats — which is perfectly playable, and far better than the empty chart a bar-pattern-only
   * model produces.
   */
  sparseBarStride: number;
}

function computeBudget(
  bpm: number,
  lanes: number,
  targetDensity: number,
  minLaneSpacingSec: number,
  minCrossLaneGapSec: number,
  beatsPerBar: number,
  accents: boolean,
): { budget: DensityBudget; table: PatternTable } {
  const slotSec = 60 / bpm / SLOTS_PER_BEAT;
  const laneGapSlots = Math.max(1, Math.ceil((minLaneSpacingSec - EPS) / slotSec));
  const crossGapSlots = Math.max(1, Math.ceil((minCrossLaneGapSec - EPS) / slotSec));
  const maxPerSlot = Math.min(1, lanes / laneGapSlots, 1 / crossGapSlots);
  const maxFeasibleDensity = maxPerSlot * SLOTS_PER_BEAT;
  const table = buildPatternTable(beatsPerBar, lanes, laneGapSlots, crossGapSlots, accents);
  const target = Math.max(0, targetDensity);
  const S = beatsPerBar * SLOTS_PER_BEAT;
  let maxBarDensity = table.maxCount / beatsPerBar;
  let maxOnBeatDensity = table.maxOnBeatCount / beatsPerBar;
  let sparseBarStride = 0;
  if (table.maxCount === 0 && target > 0) {
    // No single-bar pattern survives the pacing constraints when repeated. Space notes over several
    // bars instead of giving up: one downbeat every `stride` bars, `stride` chosen so that
    // consecutive notes are >= crossGapSlots apart and same-lane repeats (every `lanes` notes under
    // round-robin) are >= laneGapSlots apart, and never denser than the difficulty asks for.
    const minStride = Math.max(1, Math.ceil(crossGapSlots / S), Math.ceil(laneGapSlots / (lanes * S)));
    const densityStride = Math.max(1, Math.ceil(1 / (target * beatsPerBar) - EPS));
    sparseBarStride = Math.max(minStride, densityStride);
    maxBarDensity = 1 / (sparseBarStride * beatsPerBar);
    maxOnBeatDensity = maxBarDensity;
  }
  const effectiveTargetDensity = Math.min(target, target <= 1 + EPS ? maxOnBeatDensity : maxBarDensity);
  return {
    budget: {
      targetDensity,
      maxFeasibleDensity,
      maxBarDensity,
      maxOnBeatDensity,
      effectiveTargetDensity,
      laneGapSlots,
      crossGapSlots,
      minLaneSpacingSec,
      minCrossLaneGapSec,
      beatsPerBar,
      sparseBarStride,
    },
    table,
  };
}

function clampBeatsPerBar(beatsPerBar: number | undefined): number {
  const b = Math.floor(beatsPerBar ?? 4);
  return Math.min(MAX_PATTERN_BEATS_PER_BAR, Math.max(1, Number.isFinite(b) ? b : 4));
}

/** Compute the spacing-limited density budget for a tempo / lane count / spacing configuration. */
export function densityBudget(
  bpm: number,
  lanes: number,
  targetDensity: number,
  minLaneSpacingSec: number,
  minCrossLaneGapSec: number,
  beatsPerBar = 4,
  accents = true,
): DensityBudget {
  return computeBudget(bpm, Math.max(1, Math.floor(lanes)), targetDensity, minLaneSpacingSec, minCrossLaneGapSec, clampBeatsPerBar(beatsPerBar), accents).budget;
}

/* ---------- generation ---------- */

export interface GenerateResult extends DensityBudget {
  chart: Chart;
  /** notes / usableBeats. */
  achievedDensity: number;
  /** Beats between the first and last slot that may hold a note. */
  usableBeats: number;
  /** Fraction of notes in each lane (sums to 1; all zero for an empty chart). Round-robin: max/min <= 1 + 1/min. */
  laneShares: number[];
  /** Fraction of notes on off-beats (the 'and' of a beat). */
  offBeatFraction: number;
  /** Fraction of bar downbeats inside the playable range that carry a note (1 when there are none). */
  downbeatCoverage: number;
  /** Human-readable notes, e.g. when the density had to be reduced to honour rehab pacing, or lanes are unbalanced. */
  warnings: string[];
}

/** Thrown by `generateChart` when no playable chart could be produced. Carries the diagnostics. */
export class ChartGenerationError extends Error {
  readonly warnings: string[];
  readonly result: GenerateResult;
  constructor(result: GenerateResult) {
    super(`generateChart: produced no notes — ${result.warnings.join('; ') || 'no diagnostics'}`);
    this.name = 'ChartGenerationError';
    this.warnings = result.warnings;
    this.result = result;
  }
}

/**
 * Generate a chart from a song's beat grid. Deterministic for (song, lanes, difficulty, seed).
 *
 * Diagnostics are NOT silently dropped: every warning `generateChartDetailed` produces (density
 * reduced to honour rehab pacing, beatsPerBar clamped, sparse fallback, lane imbalance, missing
 * downbeat accents, a negative song offset) is passed to `opts.onWarning` when supplied, and an
 * empty chart — a highway with nothing on it — throws `ChartGenerationError` instead of being
 * returned as if it were playable. Use `generateChartDetailed` when you want to inspect the budget
 * and decide for yourself; it never throws.
 *
 * @throws ChartGenerationError when the generated chart has no notes.
 */
export function generateChart(
  song: SongGrid,
  lanes: number,
  difficulty: Difficulty | DifficultyName,
  seed: number,
  opts: GenerateOptions = {},
): Chart {
  const result = generateChartDetailed(song, lanes, difficulty, seed, opts);
  if (opts.onWarning) for (const w of result.warnings) opts.onWarning(w);
  if (result.chart.notes.length === 0) throw new ChartGenerationError(result);
  return result.chart;
}

/**
 * Validate the beat grid a chart is generated from. Throws RangeError — a bad manifest must fail at
 * load, not produce an unplayable chart (or notes before the audio starts).
 */
export function validateSongGrid(song: SongGrid): void {
  if (!song || typeof song !== 'object') throw new RangeError('generateChart: song missing');
  if (!Number.isFinite(song.bpm) || song.bpm <= 0) throw new RangeError(`generateChart: bpm must be positive (got ${song.bpm})`);
  if (!Number.isFinite(song.offset)) throw new RangeError(`generateChart: offset must be finite (got ${song.offset})`);
  if (!Number.isFinite(song.durationSec) || song.durationSec <= 0) throw new RangeError(`generateChart: durationSec must be positive (got ${song.durationSec})`);
  if (song.beatsPerBar !== undefined && (!Number.isFinite(song.beatsPerBar) || song.beatsPerBar < 1)) {
    throw new RangeError(`generateChart: beatsPerBar must be >= 1 (got ${song.beatsPerBar})`);
  }
}

/**
 * Generate a chart and report the density budget and balance metrics.
 *
 * Layout (bar grid anchored at `song.offset`, half-beat resolution):
 * - every bar gets a *bar pattern* chosen from an exhaustive, scored table of rhythms that honour
 *   the pacing constraints when repeated (see `periodicFeasible`); the score prefers the downbeat,
 *   beats over off-beats, "1 &" figures over lone off-beats and evenly spread notes — so easy is
 *   on-beat, medium is one note per beat and hard adds off-beats only where the count demands it;
 * - note counts per bar follow difficulty.noteDensity (fractional counts alternate between bars),
 *   reduced to what the pacing allows (`effectiveTargetDensity`, warned);
 * - phrases of `phraseBars` bars are [A A A A']: the same base pattern repeated, the last bar a
 *   seeded variation (different pattern of similar musicality, sometimes ±1 note); every 4 phrases
 *   a new section may swap the base pattern for an equally good one;
 * - lanes are assigned round-robin (0,1,2,…), which is provably spacing-safe for these patterns and
 *   gives every lane an equal share of reps (bilateral rehab: left/right get the same work);
 * - 2-beat lead-in silence measured from the AUDIO START (so a negative `song.offset` shifts the
 *   first note later, never onto t = 0 where it would have no approach time), `tailSec` free at the
 *   end, accent notes on bar downbeats.
 *
 * Lane count: the product sets up 2-4 movements (docs/ARCHITECTURE.md, Session flow) and the rehab
 * density guarantees are stated for that range — across bpm 55-205 in 3/4 and 4/4, 2-4 lanes stay
 * inside the spec's ±20 % density band. `lanes = 1` is accepted (tests, single-limb sessions) but
 * the per-lane return-to-rest spacing is then the binding constraint and the achieved density can
 * fall below the target: every such case emits a `density reduced` warning rather than quietly
 * under-delivering reps, so treat a warning on a 1-lane chart as expected, not exceptional.
 */
export function generateChartDetailed(
  song: SongGrid,
  lanes: number,
  difficulty: Difficulty | DifficultyName,
  seed: number,
  opts: GenerateOptions = {},
): GenerateResult {
  const diff = resolveDifficulty(difficulty);
  validateSongGrid(song);
  const laneCount = Math.max(1, Math.floor(lanes));
  const bpm = song.bpm > 0 && Number.isFinite(song.bpm) ? song.bpm : 120;
  const requestedBpb = Math.floor(song.beatsPerBar ?? 4);
  const beatsPerBar = clampBeatsPerBar(song.beatsPerBar);
  const beatSec = 60 / bpm;
  const slotSec = beatSec / SLOTS_PER_BEAT;
  const accents = opts.accents ?? true;
  const leadInBeats = Math.max(0, opts.leadInBeats ?? 2);
  const tailSec = opts.tailSec ?? 1;
  const phraseBars = Math.max(1, Math.floor(opts.phraseBars ?? 4));
  const minSpacing = opts.minLaneSpacingSec ?? MIN_LANE_SPACING_SEC[diff.name] ?? 0.6;
  const crossGap = opts.minCrossLaneGapSec ?? defaultCrossLaneGapSec(diff.name, bpm);
  const density = Math.max(0, diff.noteDensity);
  const { budget, table } = computeBudget(bpm, laneCount, density, minSpacing, crossGap, beatsPerBar, accents);
  const eff = budget.effectiveTargetDensity;
  const G = budget.laneGapSlots;
  const C = budget.crossGapSlots;
  const S = table.slotsPerBar;
  const warnings: string[] = [];
  if (requestedBpb !== beatsPerBar && Number.isFinite(requestedBpb)) {
    warnings.push(`beatsPerBar ${requestedBpb} clamped to ${beatsPerBar} for pattern layout`);
  }
  const preferOnBeat = density <= 1 + EPS;
  if (eff < density - EPS) {
    warnings.push(
      `note density reduced from ${density} to ${eff.toFixed(3)} notes/beat: at ${bpm} bpm with ${laneCount} lane(s), ` +
        `lane spacing ${minSpacing}s and cross-lane gap ${crossGap}s allow at most ${eff.toFixed(3)} notes/beat ` +
        `on a${preferOnBeat ? 'n on-beat' : ' musical'} bar pattern (${budget.maxFeasibleDensity.toFixed(3)} on the raw grid)`,
    );
  }

  // The chart owns its difficulty: a copy, never the deep-frozen DIFFICULTIES singleton. Aliasing it
  // makes `chart.difficulty.windows.goodMs = x` (a therapist window scale applied downstream) throw
  // a TypeError in strict mode instead of doing what the caller obviously meant.
  const mk = (chartNotes: Note[]): Chart => ({
    songId: song.id,
    lanes: laneCount,
    notes: chartNotes,
    bpm,
    offset: song.offset,
    difficulty: { name: diff.name, thresholdFraction: diff.thresholdFraction, noteDensity: diff.noteDensity, windows: { perfectMs: diff.windows.perfectMs, goodMs: diff.windows.goodMs } },
    durationSec: song.durationSec,
  });
  const empty = (why: string): GenerateResult => ({
    chart: mk([]),
    ...budget,
    achievedDensity: 0,
    usableBeats: 0,
    laneShares: new Array<number>(laneCount).fill(0),
    offBeatFraction: 0,
    downbeatCoverage: 1,
    warnings: [...warnings, why],
  });

  // absolute half-beat slot j is at time offset + j * slotSec; bar b covers slots [b*S, (b+1)*S)
  //
  // The lead-in is measured from AUDIO START (song time 0), not from the beat grid's origin. With a
  // negative song.offset (the first downbeat precedes the audio) the two differ: clamping only to
  // "song time >= 0" let the first note land at exactly t = 0.000 — on the highway that is a note
  // with no approach time at all, i.e. unhittable, and it used to happen with no warning (bpm 240 /
  // offset -0.5, bpm 120 / offset -1.0). So the first usable slot is pushed past BOTH the grid
  // lead-in and the audio start plus the same lead-in. For offset >= 0 this is exactly the old
  // `leadInSlots` (firstPlayableSlot is then <= 0), so non-negative offsets are unaffected.
  const leadInSlots = Math.ceil(leadInBeats * SLOTS_PER_BEAT - EPS);
  const firstPlayableSlot = Math.ceil(-song.offset / slotSec - EPS);
  const firstSlot = Math.max(leadInSlots, firstPlayableSlot + leadInSlots);
  if (firstPlayableSlot > 0) {
    const firstNoteTime = song.offset + firstSlot * slotSec;
    warnings.push(
      `song.offset ${song.offset}s is negative: the first ${firstPlayableSlot} half-beat slot(s) fall before the audio ` +
        `and were skipped, plus ${leadInBeats} beat(s) of lead-in — the earliest note is at song time ${firstNoteTime.toFixed(3)}s`,
    );
  }
  const lastSlot = Math.floor((song.durationSec - tailSec - song.offset) / slotSec + EPS);
  if (!Number.isFinite(lastSlot) || lastSlot < firstSlot) return empty('song too short for any note');
  const usableBeats = (lastSlot - firstSlot + 1) / SLOTS_PER_BEAT;
  const firstBar = Math.floor(firstSlot / S);
  const lastBar = Math.floor(lastSlot / S);

  const rand = mulberry32(seed);
  rand(); // burn one draw: keeps chart output distinct per seed independently of the lane assignment

  const isCompatible = (prev: BarPattern | null, cur: BarPattern): boolean => compatible(prev, cur, S, laneCount, G, C);
  /** Cumulative note count after `bars` full bars (fractional per-bar counts alternate deterministically). */
  const cum = (bars: number): number => Math.round(eff * beatsPerBar * bars + EPS);
  const countFor = (i: number): number => Math.min(table.maxCount, Math.max(0, cum(i + 1) - cum(i)));
  /** Candidate patterns for a count, best first; on-beat patterns only when the target prefers them and any exist. */
  const candidatesFor = (count: number): readonly BarPattern[] => {
    if (preferOnBeat) {
      const onBeat = table.onBeatByCount[count] ?? [];
      if (onBeat.length > 0) return onBeat;
    }
    return table.byCount[count] ?? [];
  };
  const bestScore = (count: number): number => candidatesFor(count)[0]?.score ?? -Infinity;

  const baseCache = new Map<string, BarPattern>();
  /** Base pattern of a section for a note count: the best pattern (A sections) or a seeded near-equivalent (B sections). */
  const basePattern = (section: number, count: number): BarPattern => {
    const key = `${section % 2}:${count}`;
    const cached = baseCache.get(key);
    if (cached) return cached;
    const list = candidatesFor(count);
    let pat = list[0] ?? EMPTY_PATTERN;
    if (section % 2 === 1 && list.length > 1) {
      const cands = list.filter((p) => p.score >= list[0].score - SECTION_SCORE_SLACK);
      pat = cands[Math.floor(rand() * cands.length)];
    }
    baseCache.set(key, pat);
    return pat;
  };
  /** First pattern in `list` (already best-first) compatible with `prev`, or the first one. */
  const firstCompatible = (list: readonly BarPattern[], prev: BarPattern | null): BarPattern => {
    for (const p of list) if (isCompatible(prev, p)) return p;
    return list[0] ?? EMPTY_PATTERN;
  };

  /**
   * Lane assignment + metrics for a finished list of kept slots.
   *
   * Lanes are assigned greedily rather than by a fixed rotation: among the lanes that are still
   * >= laneGapSlots away from their own previous note, the least-used one wins, ties broken from
   * the seeded PRNG. The repair pass guarantees at most `laneCount - 1` notes inside any
   * laneGapSlots window, so at least one lane is always free — the rehab spacing proof holds
   * exactly as it did for the rotation, the per-lane rep counts stay balanced, and the highway is
   * no longer a single predictable cycle the patient memorises within a bar.
   */
  const finish = (slots: readonly number[]): GenerateResult => {
    const notes: Note[] = [];
    const laneCounts = new Array<number>(laneCount).fill(0);
    const lastSlotForLane = new Array<number>(laneCount).fill(Number.NEGATIVE_INFINITY);
    let offBeats = 0;
    for (let k = 0; k < slots.length; k++) {
      const slot = slots[k];
      let lane = -1;
      let bestCount = Infinity;
      let ties = 0;
      for (let l = 0; l < laneCount; l++) {
        if (slot - lastSlotForLane[l] < G) continue;
        if (laneCounts[l] < bestCount) {
          bestCount = laneCounts[l];
          lane = l;
          ties = 1;
        } else if (laneCounts[l] === bestCount) {
          ties++;
          if (rand() < 1 / ties) lane = l; // seeded uniform choice among equally-used lanes
        }
      }
      if (lane < 0) {
        // Unreachable for slots produced by the repair pass (it caps a laneGapSlots window at
        // laneCount - 1 notes); kept as a safety net: use the lane idle longest.
        lane = 0;
        for (let l = 1; l < laneCount; l++) if (lastSlotForLane[l] < lastSlotForLane[lane]) lane = l;
      }
      laneCounts[lane]++;
      lastSlotForLane[lane] = slot;
      if (slot % SLOTS_PER_BEAT !== 0) offBeats++;
      notes.push({ id: k, lane, time: round6(song.offset + slot * slotSec) });
    }

    let downbeatsTotal = 0;
    let downbeatsHit = 0;
    const keptSet = new Set(slots);
    for (let b = firstBar; b <= lastBar; b++) {
      const d = b * S;
      if (d < firstSlot || d > lastSlot) continue;
      downbeatsTotal++;
      if (keptSet.has(d)) downbeatsHit++;
    }
    const total = notes.length;
    const laneShares = laneCounts.map((c) => (total > 0 ? c / total : 0));
    const offBeatFraction = total > 0 ? offBeats / total : 0;
    const expectedDownbeats = budget.sparseBarStride > 0 ? Math.ceil(downbeatsTotal / budget.sparseBarStride) : downbeatsTotal;
    const downbeatCoverage = downbeatsTotal > 0 ? downbeatsHit / downbeatsTotal : 1;

    if (total >= laneCount && laneCount > 1) {
      const max = Math.max(...laneCounts);
      const min = Math.min(...laneCounts);
      if (min === 0) warnings.push(`lane balance: lane(s) ${laneCounts.map((c, l) => (c === 0 ? l : -1)).filter((l) => l >= 0).join(', ')} received no notes`);
      else if (max / min > LANE_SHARE_WARN_RATIO && max - min > 1) {
        warnings.push(`lane balance: reps per lane ${laneCounts.join('/')} (max/min ${(max / min).toFixed(2)} > ${LANE_SHARE_WARN_RATIO})`);
      }
    }
    if (accents && downbeatsHit < expectedDownbeats) {
      warnings.push(`accents: ${downbeatsHit} of ${downbeatsTotal} bar downbeats carry a note (pacing constraints)`);
    }
    if (diff.name === 'easy' && offBeatFraction > EASY_OFFBEAT_WARN_FRACTION) {
      warnings.push(`easy: ${(offBeatFraction * 100).toFixed(0)}% of notes are off-beat`);
    }
    if (total === 0) warnings.push('chart is empty: no note survived the pacing constraints');

    return {
      chart: mk(notes),
      ...budget,
      achievedDensity: usableBeats > 0 ? total / usableBeats : 0,
      usableBeats,
      laneShares,
      offBeatFraction,
      downbeatCoverage,
      warnings,
    };
  };

  const kept: number[] = [];
  const keptDown: boolean[] = [];
  const isDownbeat = (slot: number): boolean => slot % S === 0;

  if (budget.sparseBarStride > 0) {
    // Sparse fallback: no bar pattern is feasible, so notes go on every `stride`-th bar downbeat.
    const stride = budget.sparseBarStride;
    warnings.push(
      `pacing: at ${bpm} bpm with ${beatsPerBar} beat(s) per bar, ${laneCount} lane(s), lane spacing ${minSpacing}s and cross-lane gap ${crossGap}s ` +
        `no bar pattern is playable; falling back to one note every ${stride} bar(s) ` +
        `(${(stride * beatsPerBar * beatSec).toFixed(2)}s apart, ${eff.toFixed(3)} notes/beat)`,
    );
    for (let b = Math.max(firstBar, Math.ceil(firstSlot / S)); b <= lastBar; b += stride) {
      const slot = b * S;
      if (slot < firstSlot || slot > lastSlot) continue;
      kept.push(slot);
      keptDown.push(true);
    }
    return finish(kept);
  }

  const chosen: BarPattern[] = [];
  let prev: BarPattern | null = null;
  for (let b = firstBar; b <= lastBar; b++) {
    const i = b - firstBar;
    const phrase = Math.floor(i / phraseBars);
    const q = i - phrase * phraseBars;
    const section = Math.floor(phrase / PHRASES_PER_SECTION);
    const count = countFor(i);
    const isVariation = phraseBars > 1 && q === phraseBars - 1;
    let pat: BarPattern;
    if (!isVariation) {
      pat = basePattern(section, count);
      if (!isCompatible(prev, pat)) pat = firstCompatible(candidatesFor(count), prev);
    } else {
      const base = basePattern(section, count);
      const baseBest = bestScore(count);
      // ±1 note (15 % each), only when the resulting bar is about as musical as the base
      const r = rand();
      let c = count;
      if (r < 0.15 && count + 1 <= table.maxCount && bestScore(count + 1) >= baseBest - VARIATION_SCORE_SLACK) c = count + 1;
      else if (r >= 0.85 && count >= 2 && bestScore(count - 1) >= baseBest - VARIATION_SCORE_SLACK) c = count - 1;
      const nextSection = Math.floor((phrase + 1) / PHRASES_PER_SECTION);
      const nextBase = b < lastBar ? basePattern(nextSection, countFor(i + 1)) : null;
      // a fill may add at most one off-beat over the base (none at easy: notes stay on the beat)
      const maxOffBeats = base.offBeats + (preferOnBeat && density < 1 - EPS ? 0 : 1);
      const list = table.byCount[c] ?? [];
      let cands = list.filter((p) => p.score >= (list[0]?.score ?? 0) - VARIATION_SCORE_SLACK && p.offBeats <= maxOffBeats);
      if (cands.length > 1) cands = cands.filter((p) => p !== base);
      const fitting = cands.filter((p) => isCompatible(prev, p) && (nextBase === null || isCompatible(p, nextBase)));
      if (fitting.length > 0) cands = fitting;
      if (cands.length === 0) cands = [base];
      const k = Math.min(VARIATION_TOP_K, cands.length);
      pat = cands[Math.floor(rand() * k)];
    }
    chosen.push(pat);
    prev = pat;
  }

  // candidate slots in time order, then a repair pass that enforces both constraints linearly
  // (only bar transitions can conflict; downbeats win over the non-downbeat note before them)
  const fits = (slot: number): boolean => {
    if (kept.length === 0) return true;
    if (slot - kept[kept.length - 1] < C) return false;
    let cnt = 0;
    for (let j = kept.length - 1; j >= 0 && kept[j] > slot - G; j--) cnt++;
    return cnt < laneCount;
  };
  for (let b = firstBar; b <= lastBar; b++) {
    const pat = chosen[b - firstBar];
    for (const s of pat.slots) {
      const slot = b * S + s;
      if (slot < firstSlot || slot > lastSlot) continue;
      for (;;) {
        if (fits(slot)) {
          kept.push(slot);
          keptDown.push(isDownbeat(slot));
          break;
        }
        if (isDownbeat(slot) && kept.length > 0 && !keptDown[keptDown.length - 1]) {
          kept.pop();
          keptDown.pop();
          continue;
        }
        break; // drop this note
      }
    }
  }

  return finish(kept);
}

function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

/* ---------- JSON (de)serialization ---------- */

/** Persisted chart format (version `CHART_FORMAT_VERSION`). */
export interface ChartJson {
  v: number;
  songId: string;
  lanes: number;
  bpm: number;
  offset: number;
  durationSec: number;
  difficulty: Difficulty;
  /** [id, lane, time] triples */
  notes: [number, number, number][];
}

export function chartToJson(chart: Chart): ChartJson {
  return {
    v: CHART_FORMAT_VERSION,
    songId: chart.songId,
    lanes: chart.lanes,
    bpm: chart.bpm,
    offset: chart.offset,
    durationSec: chart.durationSec,
    difficulty: {
      name: chart.difficulty.name,
      thresholdFraction: chart.difficulty.thresholdFraction,
      noteDensity: chart.difficulty.noteDensity,
      windows: { perfectMs: chart.difficulty.windows.perfectMs, goodMs: chart.difficulty.windows.goodMs },
    },
    notes: chart.notes.map((n) => [n.id, n.lane, n.time]),
  };
}

export function serializeChart(chart: Chart): string {
  return JSON.stringify(chartToJson(chart));
}

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** `parseChart` plus what had to be assumed to make the input fit `Chart` (see `parseChartDetailed`). */
export interface ParseChartResult {
  chart: Chart;
  /** Empty when nothing was assumed. Show these in dev tools / the chart editor, not to patients. */
  warnings: string[];
}

/**
 * Parse a chart from a JSON string or already-parsed object (`ChartJson`, or object-form notes).
 * Throws on invalid input: unknown format version, out-of-range lanes, duplicate note ids.
 *
 * Anything that had to be assumed (currently only a missing `durationSec`) is reported by
 * `parseChartDetailed`; this wrapper drops that. Prefer the detailed form wherever the result is
 * shown or stored.
 */
export function parseChart(input: string | unknown): Chart {
  return parseChartDetailed(input).chart;
}

/**
 * `parseChart` that also reports what it had to assume.
 *
 * The only such assumption today: `Chart.durationSec` is required by src/engine/types.ts but absent
 * from the Chart block in docs/ARCHITECTURE.md, so a chart written to the documented shape has to be
 * given one — the last note's time, which describes a song that ends on its final note. That number
 * then drives end-of-song UI, so the caller is told rather than left to trust it.
 */
export function parseChartDetailed(input: string | unknown): ParseChartResult {
  const raw: unknown = typeof input === 'string' ? JSON.parse(input) : input;
  if (!raw || typeof raw !== 'object') throw new Error('chart: not an object');
  const o = raw as Record<string, unknown>;
  if (o.v !== undefined && (!isNum(o.v) || o.v < 1 || o.v > CHART_FORMAT_VERSION)) {
    throw new Error(`chart: unsupported format version ${String(o.v)} (supported: 1..${CHART_FORMAT_VERSION})`);
  }
  if (typeof o.songId !== 'string') throw new Error('chart: songId missing');
  if (!isNum(o.lanes) || o.lanes < 1) throw new Error('chart: lanes invalid');
  if (!isNum(o.bpm) || o.bpm <= 0) throw new Error('chart: bpm invalid');
  if (!isNum(o.offset)) throw new Error('chart: offset invalid');
  // `durationSec` is required by src/engine/types.ts but absent from the Chart block in
  // docs/ARCHITECTURE.md; accept charts written to the documented shape and fill it in from the
  // last note so a hand-written or older chart still loads — and say so in `warnings`.
  // (Contract divergence flagged to the orchestrator; the doc or the field needs amending.)
  if (o.durationSec !== undefined && (!isNum(o.durationSec) || o.durationSec < 0)) throw new Error('chart: durationSec invalid');
  const d = o.difficulty as Record<string, unknown> | undefined;
  if (!d || typeof d !== 'object') throw new Error('chart: difficulty missing');
  const name = d.name;
  if (name !== 'easy' && name !== 'medium' && name !== 'hard') throw new Error('chart: difficulty.name invalid');
  const w = d.windows as Record<string, unknown> | undefined;
  if (!isNum(d.thresholdFraction) || !isNum(d.noteDensity) || !w || !isNum(w.perfectMs) || !isNum(w.goodMs)) {
    throw new Error('chart: difficulty fields invalid');
  }
  // These numbers are handed straight to the vision threshold detector and the Judge. A
  // thresholdFraction above 1 makes every note unhittable (the patient can never cross the ROM
  // threshold) and non-positive windows blow up inside the Judge at Play time; charts come from
  // localStorage, so both are reachable. Fail here, at load, with a message that names the field.
  if (d.thresholdFraction < 0 || d.thresholdFraction > 1) {
    throw new Error(`chart: difficulty.thresholdFraction ${d.thresholdFraction} out of range [0, 1]`);
  }
  if (d.noteDensity < 0) throw new Error(`chart: difficulty.noteDensity ${d.noteDensity} must be >= 0`);
  validateTimingWindows({ perfectMs: w.perfectMs, goodMs: w.goodMs }, 'chart: difficulty.windows');
  if (!Array.isArray(o.notes)) throw new Error('chart: notes missing');
  const lanes = Math.floor(o.lanes);
  const ids = new Set<number>();
  const notes: Note[] = o.notes.map((n: unknown, i: number): Note => {
    let id: unknown, lane: unknown, time: unknown;
    if (Array.isArray(n)) [id, lane, time] = n as unknown[];
    else if (n && typeof n === 'object') ({ id, lane, time } = n as Record<string, unknown>);
    if (!isNum(id) || !isNum(lane) || !isNum(time)) throw new Error(`chart: note ${i} invalid`);
    if (!Number.isInteger(lane) || lane < 0 || lane >= lanes) throw new Error(`chart: note ${i} lane out of range`);
    if (ids.has(id)) throw new Error(`chart: note ${i} duplicate id ${id}`);
    ids.add(id);
    return { id, lane, time };
  });
  notes.sort((a, b) => a.time - b.time || a.id - b.id);
  const warnings: string[] = [];
  let durationSec: number;
  if (isNum(o.durationSec)) {
    durationSec = o.durationSec;
  } else {
    durationSec = notes.length > 0 ? notes[notes.length - 1].time : 0;
    warnings.push(`chart: durationSec missing; assumed ${durationSec.toFixed(2)}s from the last note (the song is treated as ending on its final note)`);
  }
  const chart: Chart = {
    songId: o.songId,
    lanes,
    bpm: o.bpm,
    offset: o.offset,
    durationSec,
    difficulty: { name, thresholdFraction: d.thresholdFraction, noteDensity: d.noteDensity, windows: { perfectMs: w.perfectMs, goodMs: w.goodMs } },
    notes,
  };
  return { chart, warnings };
}
