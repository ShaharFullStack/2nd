import { resolveDifficulty } from '../engine/difficulty.ts';
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
}

/** Minimum time between two notes in the same lane (rehab pacing: a rep must return to rest). */
export const MIN_LANE_SPACING_SEC: Readonly<Record<DifficultyName, number>> = Object.freeze({
  easy: 0.9,
  medium: 0.6,
  hard: 0.45,
});

/**
 * Minimum time between two notes in *different* lanes (rehab pacing: on easy a patient should not
 * be asked to fire two limbs 250 ms apart). Hard is unconstrained beyond the half-beat grid.
 */
export const MIN_CROSS_LANE_GAP_SEC: Readonly<Record<DifficultyName, number>> = Object.freeze({
  easy: 0.45,
  medium: 0.25,
  hard: 0.15,
});

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
  /** Feasible patterns per note count, best first. */
  byCount: BarPattern[][];
  /** Largest note count that has a feasible pattern. */
  maxCount: number;
  /** Largest note count that has a feasible pattern with every note on a beat. */
  maxOnBeatCount: number;
}

const EMPTY_PATTERN: BarPattern = Object.freeze({ mask: 0, slots: Object.freeze([]) as readonly number[], count: 0, score: 0, downbeat: false, offBeats: 0 });

/**
 * A bar pattern is feasible when, repeated forever, it honours both pacing constraints on the
 * half-beat grid: consecutive notes >= crossGapSlots apart and no window of laneGapSlots
 * consecutive slots holding more than `lanes` notes. The second condition is exactly what makes a
 * round-robin lane assignment valid: notes k and k+lanes are then always >= laneGapSlots apart.
 */
function periodicFeasible(mask: number, slots: readonly number[], slotsPerBar: number, lanes: number, laneGapSlots: number, crossGapSlots: number): boolean {
  const n = slots.length;
  if (n === 0) return true;
  for (let i = 0; i < n; i++) {
    const next = i + 1 < n ? slots[i + 1] : slots[0] + slotsPerBar;
    if (next - slots[i] < crossGapSlots) return false;
  }
  for (let s = 0; s < slotsPerBar; s++) {
    let cnt = 0;
    for (let k = 0; k < laneGapSlots; k++) if (mask & (1 << (s + k) % slotsPerBar)) cnt++;
    if (cnt > lanes) return false;
  }
  return true;
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

function buildPatternTable(beatsPerBar: number, lanes: number, laneGapSlots: number, crossGapSlots: number, accents: boolean): PatternTable {
  const S = beatsPerBar * SLOTS_PER_BEAT;
  const byCount: BarPattern[][] = [];
  for (let c = 0; c <= S; c++) byCount.push([]);
  const slots: number[] = [];
  const total = 1 << S;
  for (let mask = 0; mask < total; mask++) {
    if (accents && mask !== 0 && (mask & 1) === 0) continue; // accents: every non-empty bar starts on the downbeat
    slots.length = 0;
    for (let s = 0; s < S; s++) if (mask & (1 << s)) slots.push(s);
    if (!periodicFeasible(mask, slots, S, lanes, laneGapSlots, crossGapSlots)) continue;
    let offBeats = 0;
    for (const x of slots) if (x % SLOTS_PER_BEAT !== 0) offBeats++;
    byCount[slots.length].push({
      mask,
      slots: Object.freeze(slots.slice()),
      count: slots.length,
      score: scorePattern(mask, slots, S, beatsPerBar, accents),
      downbeat: (mask & 1) !== 0,
      offBeats,
    });
  }
  let maxCount = 0;
  let maxOnBeatCount = 0;
  for (let c = 0; c <= S; c++) {
    byCount[c].sort((a, b) => b.score - a.score || a.mask - b.mask);
    if (byCount[c].length > 0) maxCount = c;
    if (byCount[c].some((p) => p.offBeats === 0)) maxOnBeatCount = c;
  }
  return { slotsPerBar: S, byCount, maxCount, maxOnBeatCount };
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
  /** Beats per bar the patterns were built for (input clamped to [1, MAX_PATTERN_BEATS_PER_BAR]). */
  beatsPerBar: number;
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
  const maxBarDensity = table.maxCount / beatsPerBar;
  const maxOnBeatDensity = table.maxOnBeatCount / beatsPerBar;
  const target = Math.max(0, targetDensity);
  const effectiveTargetDensity = Math.min(target, target <= 1 + EPS ? maxOnBeatDensity : maxBarDensity);
  return {
    budget: { targetDensity, maxFeasibleDensity, maxBarDensity, maxOnBeatDensity, effectiveTargetDensity, laneGapSlots, crossGapSlots, beatsPerBar },
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

/**
 * Generate a chart from a song's beat grid. Deterministic for (song, lanes, difficulty, seed).
 * See `generateChartDetailed` for the density budget actually used.
 */
export function generateChart(
  song: SongGrid,
  lanes: number,
  difficulty: Difficulty | DifficultyName,
  seed: number,
  opts: GenerateOptions = {},
): Chart {
  return generateChartDetailed(song, lanes, difficulty, seed, opts).chart;
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
 * - 2-beat lead-in silence, `tailSec` free at the end, accent notes on bar downbeats.
 */
export function generateChartDetailed(
  song: SongGrid,
  lanes: number,
  difficulty: Difficulty | DifficultyName,
  seed: number,
  opts: GenerateOptions = {},
): GenerateResult {
  const diff = resolveDifficulty(difficulty);
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
  const crossGap = opts.minCrossLaneGapSec ?? MIN_CROSS_LANE_GAP_SEC[diff.name] ?? 0;
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

  const mk = (chartNotes: Note[]): Chart => ({ songId: song.id, lanes: laneCount, notes: chartNotes, bpm, offset: song.offset, difficulty: diff, durationSec: song.durationSec });
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
  const firstSlot = Math.ceil(leadInBeats * SLOTS_PER_BEAT - EPS);
  const lastSlot = Math.floor((song.durationSec - tailSec - song.offset) / slotSec + EPS);
  if (!Number.isFinite(lastSlot) || lastSlot < firstSlot) return empty('song too short for any note');
  const usableBeats = (lastSlot - firstSlot + 1) / SLOTS_PER_BEAT;
  const firstBar = Math.floor(firstSlot / S);
  const lastBar = Math.floor(lastSlot / S);

  const rand = mulberry32(seed);
  const startLane = Math.floor(rand() * laneCount);

  const isCompatible = (prev: BarPattern | null, cur: BarPattern): boolean => compatible(prev, cur, S, laneCount, G, C);
  /** Cumulative note count after `bars` full bars (fractional per-bar counts alternate deterministically). */
  const cum = (bars: number): number => Math.round(eff * beatsPerBar * bars + EPS);
  const countFor = (i: number): number => Math.min(table.maxCount, Math.max(0, cum(i + 1) - cum(i)));
  /** Candidate patterns for a count, best first; on-beat patterns only when the target prefers them and any exist. */
  const candidatesFor = (count: number): readonly BarPattern[] => {
    const list = table.byCount[count] ?? [];
    if (!preferOnBeat) return list;
    const onBeat = list.filter((p) => p.offBeats === 0);
    return onBeat.length > 0 ? onBeat : list;
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
  const kept: number[] = [];
  const keptDown: boolean[] = [];
  const isDownbeat = (slot: number): boolean => slot % S === 0;
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

  const notes: Note[] = [];
  const laneCounts = new Array<number>(laneCount).fill(0);
  let offBeats = 0;
  for (let k = 0; k < kept.length; k++) {
    const lane = (startLane + k) % laneCount;
    laneCounts[lane]++;
    if (kept[k] % SLOTS_PER_BEAT !== 0) offBeats++;
    notes.push({ id: k, lane, time: round6(song.offset + kept[k] * slotSec) });
  }

  // metrics
  let downbeatsTotal = 0;
  let downbeatsHit = 0;
  const keptSet = new Set(kept);
  for (let b = firstBar; b <= lastBar; b++) {
    const d = b * S;
    if (d < firstSlot || d > lastSlot) continue;
    downbeatsTotal++;
    if (keptSet.has(d)) downbeatsHit++;
  }
  const total = notes.length;
  const laneShares = laneCounts.map((c) => (total > 0 ? c / total : 0));
  const offBeatFraction = total > 0 ? offBeats / total : 0;
  const downbeatCoverage = downbeatsTotal > 0 ? downbeatsHit / downbeatsTotal : 1;

  if (total >= laneCount && laneCount > 1) {
    const max = Math.max(...laneCounts);
    const min = Math.min(...laneCounts);
    if (min === 0) warnings.push(`lane balance: lane(s) ${laneCounts.map((c, l) => (c === 0 ? l : -1)).filter((l) => l >= 0).join(', ')} received no notes`);
    else if (max / min > LANE_SHARE_WARN_RATIO && max - min > 1) {
      warnings.push(`lane balance: reps per lane ${laneCounts.join('/')} (max/min ${(max / min).toFixed(2)} > ${LANE_SHARE_WARN_RATIO})`);
    }
  }
  if (accents && downbeatCoverage < 1 - EPS) {
    warnings.push(`accents: ${downbeatsHit} of ${downbeatsTotal} bar downbeats carry a note (pacing constraints)`);
  }
  if (diff.name === 'easy' && offBeatFraction > EASY_OFFBEAT_WARN_FRACTION) {
    warnings.push(`easy: ${(offBeatFraction * 100).toFixed(0)}% of notes are off-beat`);
  }

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

/**
 * Parse a chart from a JSON string or already-parsed object (`ChartJson`, or object-form notes).
 * Throws on invalid input: unknown format version, out-of-range lanes, duplicate note ids.
 */
export function parseChart(input: string | unknown): Chart {
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
  if (!isNum(o.durationSec) || o.durationSec < 0) throw new Error('chart: durationSec invalid');
  const d = o.difficulty as Record<string, unknown> | undefined;
  if (!d || typeof d !== 'object') throw new Error('chart: difficulty missing');
  const name = d.name;
  if (name !== 'easy' && name !== 'medium' && name !== 'hard') throw new Error('chart: difficulty.name invalid');
  const w = d.windows as Record<string, unknown> | undefined;
  if (!isNum(d.thresholdFraction) || !isNum(d.noteDensity) || !w || !isNum(w.perfectMs) || !isNum(w.goodMs)) {
    throw new Error('chart: difficulty fields invalid');
  }
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
  return {
    songId: o.songId,
    lanes,
    bpm: o.bpm,
    offset: o.offset,
    durationSec: o.durationSec,
    difficulty: { name, thresholdFraction: d.thresholdFraction, noteDensity: d.noteDensity, windows: { perfectMs: w.perfectMs, goodMs: w.goodMs } },
    notes,
  };
}
