import { resolveDifficulty } from '../engine/difficulty.ts';
import type { Chart, Difficulty, DifficultyName, Note } from '../engine/types.ts';

/** Subset of the song manifest needed to build a beat grid. */
export interface SongGrid {
  id: string;
  bpm: number;
  /** Seconds from audio start to the first beat. */
  offset: number;
  durationSec: number;
  beatsPerBar?: number;
}

export interface GenerateOptions {
  /** Guarantee a note on every bar downbeat when a lane is free (default true). */
  accents?: boolean;
  /** Beats of silence before the first note (default 2). */
  leadInBeats?: number;
  /** Seconds at the end of the song kept free of notes (default 1). */
  tailSec?: number;
  /** Bars per repeating phrase (default 4). */
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
/**
 * When the target is at least this fraction of the spacing-limited maximum, notes are laid on a
 * regular lattice (the only way to reach the maximum) and thinned to the target; below it the
 * musical weighted sampler is used.
 */
const LATTICE_THRESHOLD = 0.7;

export interface DensityBudget {
  /** Difficulty's nominal notes per beat. */
  targetDensity: number;
  /** Theoretical maximum notes per beat under the lane / cross-lane spacing constraints on the half-beat grid. */
  maxFeasibleDensity: number;
  /** Density the generator actually aims for: min(target, maxFeasible). */
  effectiveTargetDensity: number;
  /** Minimum same-lane gap in half-beat slots. */
  laneGapSlots: number;
  /** Minimum any-lane gap in half-beat slots. */
  crossGapSlots: number;
  /** True when the regular lattice placement is used (target close to the maximum). */
  lattice: boolean;
}

/** Compute the spacing-limited density budget for a tempo / lane count / spacing configuration. */
export function densityBudget(bpm: number, lanes: number, targetDensity: number, minLaneSpacingSec: number, minCrossLaneGapSec: number): DensityBudget {
  const slotSec = 60 / bpm / SLOTS_PER_BEAT;
  const laneGapSlots = Math.max(1, Math.ceil((minLaneSpacingSec - EPS) / slotSec));
  const crossGapSlots = Math.max(1, Math.ceil((minCrossLaneGapSec - EPS) / slotSec));
  const maxPerSlot = Math.min(1, lanes / laneGapSlots, 1 / crossGapSlots);
  const maxFeasibleDensity = maxPerSlot * SLOTS_PER_BEAT;
  const effectiveTargetDensity = Math.min(targetDensity, maxFeasibleDensity);
  const lattice = maxFeasibleDensity > 0 && effectiveTargetDensity >= LATTICE_THRESHOLD * maxFeasibleDensity - EPS;
  return { targetDensity, maxFeasibleDensity, effectiveTargetDensity, laneGapSlots, crossGapSlots, lattice };
}

/**
 * Lane that fires at global slot `J` on the maximum-density lattice, or -1.
 * Two regimes: cross-gap bound (a note every crossGapSlots, lanes cycling) or lane-spacing bound
 * (each lane fires every laneGapSlots with evenly spread phases). Both honour both constraints.
 */
function latticeLane(J: number, lanes: number, laneGapSlots: number, crossGapSlots: number): number {
  if (1 / crossGapSlots <= lanes / laneGapSlots) {
    return J % crossGapSlots === 0 ? (J / crossGapSlots) % lanes : -1;
  }
  const phase = J % laneGapSlots;
  for (let l = 0; l < lanes; l++) if (Math.floor((l * laneGapSlots) / lanes) === phase) return l;
  return -1;
}

export interface GenerateResult extends DensityBudget {
  chart: Chart;
  /** notes / usableBeats. */
  achievedDensity: number;
  /** Beats between the first and last slot that may hold a note. */
  usableBeats: number;
  /** Human-readable notes, e.g. when the density had to be reduced to honour rehab pacing. */
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
 * Generate a chart and report the density budget.
 * - notes on beats / half-beats according to difficulty.noteDensity (notes per beat), reduced to
 *   what the pacing constraints allow (warnings say so)
 * - phrase structure: the first phrase's rhythm becomes a template that later phrases follow with
 *   variation (every 4th phrase varies more, every 8th starts a new "section" template)
 * - lanes cycle; the same lane is never hit twice within MIN_LANE_SPACING_SEC[difficulty] and
 *   any two notes are at least MIN_CROSS_LANE_GAP_SEC[difficulty] apart
 * - 2-beat lead-in silence, optional accent notes on bar downbeats
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
  const beatsPerBar = Math.max(1, Math.floor(song.beatsPerBar ?? 4));
  const beatSec = 60 / bpm;
  const accents = opts.accents ?? true;
  const leadInBeats = opts.leadInBeats ?? 2;
  const tailSec = opts.tailSec ?? 1;
  const phraseBars = Math.max(1, opts.phraseBars ?? 4);
  const minSpacing = opts.minLaneSpacingSec ?? MIN_LANE_SPACING_SEC[diff.name] ?? 0.6;
  const crossGap = opts.minCrossLaneGapSec ?? MIN_CROSS_LANE_GAP_SEC[diff.name] ?? 0;
  const density = Math.max(0, diff.noteDensity);
  const budget = densityBudget(bpm, laneCount, density, minSpacing, crossGap);
  const effDensity = budget.effectiveTargetDensity;
  const warnings: string[] = [];
  if (effDensity < density - EPS) {
    warnings.push(
      `note density reduced from ${density} to ${effDensity.toFixed(3)} notes/beat: at ${bpm} bpm with ${laneCount} lane(s), ` +
        `lane spacing ${minSpacing}s and cross-lane gap ${crossGap}s allow at most ${budget.maxFeasibleDensity.toFixed(3)} notes/beat`,
    );
  }
  const rand = mulberry32(seed);

  const notes: Note[] = [];
  const mk = (chartNotes: Note[]): Chart => ({ songId: song.id, lanes: laneCount, notes: chartNotes, bpm, offset: song.offset, difficulty: diff, durationSec: song.durationSec });

  const phraseBeats = phraseBars * beatsPerBar;
  const phraseSlots = phraseBeats * SLOTS_PER_BEAT;
  const slotSec = beatSec / SLOTS_PER_BEAT;
  const firstNoteTime = song.offset + leadInBeats * beatSec;
  const lastNoteTime = song.durationSec - tailSec;
  if (lastNoteTime < firstNoteTime) {
    return { chart: mk(notes), ...budget, achievedDensity: 0, usableBeats: 0, warnings: [...warnings, 'song too short for any note'] };
  }
  const totalSlots = Math.floor((lastNoteTime - firstNoteTime) / slotSec + EPS) + 1;
  const usableBeats = totalSlots / SLOTS_PER_BEAT;

  // last note time per lane / any lane from *previous* phrases (notes of the current phrase are scanned directly)
  const prevLast: number[] = new Array<number>(laneCount).fill(-Infinity);
  let prevAny = -Infinity;
  let prevLastLane = laneCount - 1;
  let phraseStart = 0;
  const eligible: number[] = [];

  /** Lanes that may take a note at time `t` given every note placed so far (both temporal neighbours). */
  const eligibleLanes = (t: number): number[] => {
    eligible.length = 0;
    if (t - prevAny < crossGap - EPS) return eligible;
    for (let k = phraseStart; k < notes.length; k++) if (Math.abs(notes[k].time - t) < crossGap - EPS) return eligible;
    for (let l = 0; l < laneCount; l++) {
      if (t - prevLast[l] < minSpacing - EPS) continue;
      let ok = true;
      for (let k = phraseStart; k < notes.length; k++) {
        const n = notes[k];
        if (n.lane === l && Math.abs(n.time - t) < minSpacing - EPS) {
          ok = false;
          break;
        }
      }
      if (ok) eligible.push(l);
    }
    return eligible;
  };

  /** Lane of the latest note strictly before `t` (for cyclic lane order). */
  const laneBefore = (t: number): number => {
    let bestT = prevAny;
    let lane = prevLastLane;
    for (let k = phraseStart; k < notes.length; k++) {
      const n = notes[k];
      if (n.time < t && n.time > bestT) {
        bestT = n.time;
        lane = n.lane;
      }
    }
    return lane;
  };

  const halfWeight = effDensity > 1 ? 0.8 : 0.15;
  const baseWeight = (j: number): number => {
    if (j % (beatsPerBar * SLOTS_PER_BEAT) === 0) return accents ? 3 : 2;
    if (j % SLOTS_PER_BEAT === 0) return 1.2;
    return halfWeight;
  };

  let template: boolean[] | null = null;
  const weights = new Array<number>(phraseSlots).fill(0);
  const order: number[] = [];

  for (let phrase = 0, slot0 = 0; slot0 < totalSlots; phrase++, slot0 += phraseSlots) {
    const slotsHere = Math.min(phraseSlots, totalSlots - slot0);
    const beatsHere = slotsHere / SLOTS_PER_BEAT;
    const isVariation = template !== null && phrase % 4 === 3;
    const isNewSection = template !== null && phrase % 8 === 4; // re-roll template for a "B" section
    phraseStart = notes.length;

    let target = Math.round(effDensity * beatsHere);
    if (template !== null && slotsHere === phraseSlots) {
      const r = rand();
      if (r < 0.15) target += 1;
      else if (r < 0.3) target -= 1;
      target = Math.max(0, target);
    }

    const useTemplate = template !== null && !isNewSection;
    const placed: boolean[] = new Array<boolean>(phraseSlots).fill(false);

    let remW = 0;
    for (let j = 0; j < slotsHere; j++) {
      let w = baseWeight(j);
      if (useTemplate) {
        const on = template![j];
        if (isVariation) w *= on ? 1.5 : 0.8;
        else w *= on ? 4 : 0.35;
      }
      weights[j] = w;
      remW += w;
    }

    const place = (j: number, t: number, lanesOk: number[]): void => {
      const lane = pickLane(lanesOk, laneBefore(t), laneCount, rand);
      notes.push({ id: 0, lane, time: round6(t) });
      placed[j] = true;
    };

    let remaining = target;
    if (budget.lattice) {
      // regular lattice at the spacing-limited maximum, thinned to the target (keep high-weight slots)
      order.length = 0;
      for (let j = 0; j < slotsHere; j++) if (latticeLane(slot0 + j, laneCount, budget.laneGapSlots, budget.crossGapSlots) >= 0) order.push(j);
      const keys = order.map((j) => weights[j] * (0.5 + rand()));
      const idx = order.map((_, k) => k).sort((a, b) => keys[b] - keys[a] || order[a] - order[b]);
      for (let k = 0; k < idx.length && remaining > 0; k++) {
        const j = order[idx[k]];
        const t = firstNoteTime + (slot0 + j) * slotSec;
        notes.push({ id: 0, lane: latticeLane(slot0 + j, laneCount, budget.laneGapSlots, budget.crossGapSlots), time: round6(t) });
        placed[j] = true;
        remaining--;
      }
      remaining = 0;
    }

    // pass 1: probabilistic, in time order (rhythm follows the weights)
    for (let j = 0; j < slotsHere && remaining > 0; j++) {
      const w = weights[j];
      const t = firstNoteTime + (slot0 + j) * slotSec;
      const lanesOk = eligibleLanes(t);
      if (lanesOk.length > 0) {
        const downbeat = j % (beatsPerBar * SLOTS_PER_BEAT) === 0;
        const p = accents && downbeat ? 1 : remW > 0 ? (remaining * w) / remW : 0;
        if (p >= 1 || rand() < p) {
          place(j, t, lanesOk);
          remaining--;
        }
      }
      remW -= w;
    }

    // pass 2: fill the shortfall in weight order (beats before half-beats), honouring both neighbours
    if (remaining > 0) {
      order.length = 0;
      for (let j = 0; j < slotsHere; j++) if (!placed[j]) order.push(j);
      // beats before half-beats, each in time order (earliest-first packs best under spacing constraints)
      order.sort((a, b) => Number(b % SLOTS_PER_BEAT === 0) - Number(a % SLOTS_PER_BEAT === 0) || a - b);
      for (let k = 0; k < order.length && remaining > 0; k++) {
        const j = order[k];
        const t = firstNoteTime + (slot0 + j) * slotSec;
        const lanesOk = eligibleLanes(t);
        if (lanesOk.length > 0) {
          place(j, t, lanesOk);
          remaining--;
        }
      }
    }

    // finalize phrase: time order, update carry-over state
    const phraseNotes = notes.slice(phraseStart).sort((a, b) => a.time - b.time || a.lane - b.lane);
    for (let k = 0; k < phraseNotes.length; k++) notes[phraseStart + k] = phraseNotes[k];
    for (const n of phraseNotes) {
      prevLast[n.lane] = n.time;
      if (n.time > prevAny) {
        prevAny = n.time;
        prevLastLane = n.lane;
      }
    }

    if (template === null || isNewSection) template = placed;
  }

  for (let i = 0; i < notes.length; i++) notes[i].id = i;
  return { chart: mk(notes), ...budget, achievedDensity: usableBeats > 0 ? notes.length / usableBeats : 0, usableBeats, warnings };
}

function pickLane(eligible: number[], lastLane: number, laneCount: number, rand: () => number): number {
  if (eligible.length === 1) return eligible[0];
  if (rand() < 0.7) {
    // next eligible lane in cyclic order after lastLane
    for (let k = 1; k <= laneCount; k++) {
      const cand = (lastLane + k) % laneCount;
      if (eligible.includes(cand)) return cand;
    }
  }
  return eligible[Math.floor(rand() * eligible.length)];
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
