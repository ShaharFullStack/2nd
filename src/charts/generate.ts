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
}

/** Minimum time between two notes in the same lane (rehab pacing: a rep must return to rest). */
export const MIN_LANE_SPACING_SEC: Readonly<Record<DifficultyName, number>> = Object.freeze({
  easy: 0.9,
  medium: 0.6,
  hard: 0.45,
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

/**
 * Generate a chart from a song's beat grid. Deterministic for (song, lanes, difficulty, seed).
 * - notes on beats / half-beats according to difficulty.noteDensity (notes per beat)
 * - phrase structure: the first phrase's rhythm becomes a template that later phrases follow with
 *   variation (every 4th phrase varies more)
 * - lanes cycle; the same lane is never hit twice within MIN_LANE_SPACING_SEC[difficulty]
 * - 2-beat lead-in silence, optional accent notes on bar downbeats
 */
export function generateChart(
  song: SongGrid,
  lanes: number,
  difficulty: Difficulty | DifficultyName,
  seed: number,
  opts: GenerateOptions = {},
): Chart {
  const diff = resolveDifficulty(difficulty);
  const laneCount = Math.max(1, Math.floor(lanes));
  const bpm = song.bpm > 0 ? song.bpm : 120;
  const beatsPerBar = Math.max(1, Math.floor(song.beatsPerBar ?? 4));
  const beatSec = 60 / bpm;
  const accents = opts.accents ?? true;
  const leadInBeats = opts.leadInBeats ?? 2;
  const tailSec = opts.tailSec ?? 1;
  const phraseBars = Math.max(1, opts.phraseBars ?? 4);
  const minSpacing = opts.minLaneSpacingSec ?? MIN_LANE_SPACING_SEC[diff.name] ?? 0.6;
  const density = Math.max(0, diff.noteDensity);
  const rand = mulberry32(seed);

  const notes: Note[] = [];
  const lastTime: number[] = new Array<number>(laneCount).fill(-Infinity);
  const eligible: number[] = [];
  let lastLane = laneCount - 1;

  const phraseBeats = phraseBars * beatsPerBar;
  const phraseSlots = phraseBeats * SLOTS_PER_BEAT;
  const slotSec = beatSec / SLOTS_PER_BEAT;
  const firstNoteTime = song.offset + leadInBeats * beatSec;
  const lastNoteTime = song.durationSec - tailSec;
  if (lastNoteTime < firstNoteTime) {
    return { songId: song.id, lanes: laneCount, notes, bpm, offset: song.offset, difficulty: diff, durationSec: song.durationSec };
  }
  const totalSlots = Math.floor((lastNoteTime - firstNoteTime) / slotSec + 1e-9) + 1;

  const halfWeight = density > 1 ? 0.8 : 0.15;
  const baseWeight = (j: number): number => {
    if (j % (beatsPerBar * SLOTS_PER_BEAT) === 0) return accents ? 3 : 2;
    if (j % SLOTS_PER_BEAT === 0) return 1.2;
    return halfWeight;
  };

  let template: boolean[] | null = null;
  const weights = new Array<number>(phraseSlots).fill(0);

  for (let phrase = 0, slot0 = 0; slot0 < totalSlots; phrase++, slot0 += phraseSlots) {
    const slotsHere = Math.min(phraseSlots, totalSlots - slot0);
    const beatsHere = slotsHere / SLOTS_PER_BEAT;
    const isVariation = template !== null && phrase % 4 === 3;
    const isNewSection = template !== null && phrase % 8 === 4; // re-roll template for a "B" section

    let target = Math.round(density * beatsHere);
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

    let remaining = target;
    for (let j = 0; j < slotsHere; j++) {
      const w = weights[j];
      const t = firstNoteTime + (slot0 + j) * slotSec;
      if (remaining > 0) {
        eligible.length = 0;
        for (let l = 0; l < laneCount; l++) if (t - lastTime[l] >= minSpacing - 1e-9) eligible.push(l);
        if (eligible.length > 0) {
          const downbeat = j % (beatsPerBar * SLOTS_PER_BEAT) === 0;
          const p = accents && downbeat ? 1 : remW > 0 ? (remaining * w) / remW : 0;
          if (p >= 1 || rand() < p) {
            const lane = pickLane(eligible, lastLane, laneCount, rand);
            notes.push({ id: notes.length, lane, time: round6(t) });
            lastTime[lane] = t;
            lastLane = lane;
            remaining--;
            placed[j] = true;
          }
        }
      }
      remW -= w;
    }

    if (template === null || isNewSection) template = placed;
  }

  return { songId: song.id, lanes: laneCount, notes, bpm, offset: song.offset, difficulty: diff, durationSec: song.durationSec };
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

interface ChartJson {
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

/** Parse a chart from a JSON string or already-parsed object. Throws on invalid input. */
export function parseChart(input: string | unknown): Chart {
  const raw: unknown = typeof input === 'string' ? JSON.parse(input) : input;
  if (!raw || typeof raw !== 'object') throw new Error('chart: not an object');
  const o = raw as Record<string, unknown>;
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
  const notes: Note[] = o.notes.map((n: unknown, i: number): Note => {
    let id: unknown, lane: unknown, time: unknown;
    if (Array.isArray(n)) [id, lane, time] = n as unknown[];
    else if (n && typeof n === 'object') ({ id, lane, time } = n as Record<string, unknown>);
    if (!isNum(id) || !isNum(lane) || !isNum(time)) throw new Error(`chart: note ${i} invalid`);
    if (lane < 0 || lane >= lanes) throw new Error(`chart: note ${i} lane out of range`);
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
