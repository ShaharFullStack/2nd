// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { DIFFICULTIES, DIFFICULTY_NAMES } from '../engine/difficulty.ts';
import { Judge } from '../engine/judge.ts';
import type { Chart, DifficultyName } from '../engine/types.ts';
import {
  CHART_FORMAT_VERSION,
  ChartGenerationError,
  EASY_OFFBEAT_WARN_FRACTION,
  LANE_SHARE_WARN_RATIO,
  MIN_CROSS_LANE_GAP_SEC,
  MIN_LANE_SPACING_SEC,
  chartToJson,
  defaultCrossLaneGapSec,
  densityBudget,
  generateChart,
  generateChartDetailed,
  mulberry32,
  parseChart,
  parseChartDetailed,
  serializeChart,
} from './generate.ts';
import type { ChartJson, GenerateResult } from './generate.ts';

const song = { id: 'demo', bpm: 120, offset: 0.25, durationSec: 60 };

/** Note times are quantised to 1 µs (`round6`), so a gap may fall that far short of its nominal value. */
const GRID_EPS = 1e-6;

function spacingViolations(chart: Chart, laneMin: number, crossMin: number): string[] {
  const out: string[] = [];
  const last: number[] = [];
  let anyLast = -Infinity;
  for (const n of chart.notes) {
    if (last[n.lane] !== undefined && n.time - last[n.lane] < laneMin - GRID_EPS) out.push(`lane ${n.lane} gap ${(n.time - last[n.lane]).toFixed(6)} at ${n.time}`);
    if (n.time - anyLast < crossMin - GRID_EPS) out.push(`cross gap ${(n.time - anyLast).toFixed(6)} at ${n.time}`);
    last[n.lane] = n.time;
    anyLast = n.time;
  }
  return out;
}

function laneCounts(chart: Chart): number[] {
  const counts = new Array<number>(chart.lanes).fill(0);
  for (const n of chart.notes) counts[n.lane]++;
  return counts;
}

/** Mean slot-set similarity between consecutive full phrases (bar grid anchored at the song offset). */
function phraseRepetition(res: GenerateResult, offset: number, beatsPerBar: number, phraseBars = 4): { mean: number; distinct: number } {
  const slotSec = 30 / res.chart.bpm;
  const phraseSlots = phraseBars * beatsPerBar * 2;
  const phrases = new Map<number, Set<number>>();
  for (const n of res.chart.notes) {
    const s = Math.round((n.time - offset) / slotSec);
    const p = Math.floor(s / phraseSlots);
    if (!phrases.has(p)) phrases.set(p, new Set());
    phrases.get(p)!.add(s - p * phraseSlots);
  }
  const keys = [...phrases.keys()].sort((a, b) => a - b);
  let sum = 0;
  let count = 0;
  let distinct = 0;
  for (let k = 1; k < keys.length - 1; k++) {
    const a = phrases.get(keys[k])!;
    const b = phrases.get(keys[k + 1])!;
    let common = 0;
    for (const s of a) if (b.has(s)) common++;
    sum += common / Math.max(1, a.size);
    count++;
    if (common !== a.size || a.size !== b.size) distinct++;
  }
  return { mean: count ? sum / count : 1, distinct };
}

describe('generateChart', () => {
  it('is deterministic for a seed and differs between seeds', () => {
    const a = generateChart(song, 3, 'medium', 7);
    const b = generateChart(song, 3, 'medium', 7);
    const c = generateChart(song, 3, 'medium', 8);
    expect(a).toEqual(b);
    expect(a.notes.length).toBeGreaterThan(10);
    expect(a.notes.map((n) => `${n.lane}@${n.time}`)).not.toEqual(c.notes.map((n) => `${n.lane}@${n.time}`));
    expect(a.difficulty).toEqual(DIFFICULTIES.medium);
    // ...but the chart OWNS its difficulty: aliasing the deep-frozen preset makes a downstream
    // therapist window scale (chart.difficulty.windows.goodMs = x) throw in strict mode
    expect(a.difficulty).not.toBe(DIFFICULTIES.medium);
    expect(a.difficulty.windows).not.toBe(DIFFICULTIES.medium.windows);
    expect(Object.isFrozen(a.difficulty)).toBe(false);
    a.difficulty.windows.goodMs = 999;
    expect(a.difficulty.windows.goodMs).toBe(999);
    expect(DIFFICULTIES.medium.windows.goodMs).toBe(140);
    expect(a.lanes).toBe(3);
    expect(a.songId).toBe('demo');
    expect(a.durationSec).toBe(60);
    // spacing-limited regime is deterministic too
    const l1 = generateChart({ id: 'l', bpm: 160, offset: 0, durationSec: 90 }, 2, 'hard', 3);
    expect(generateChart({ id: 'l', bpm: 160, offset: 0, durationSec: 90 }, 2, 'hard', 3)).toEqual(l1);
    expect(generateChart({ id: 'l', bpm: 160, offset: 0, durationSec: 90 }, 2, 'hard', 4)).not.toEqual(l1);
    // easy 2 lanes as well (bilateral leg session)
    const e1 = generateChart(song, 2, 'easy', 1);
    expect(generateChart(song, 2, 'easy', 2)).not.toEqual(e1);
  });

  it('has a 2-beat lead-in, ends before the song does, notes sorted with sequential ids', () => {
    const ch = generateChart(song, 2, 'hard', 1);
    const beatSec = 60 / song.bpm;
    expect(ch.notes[0].time).toBeGreaterThanOrEqual(song.offset + 2 * beatSec - 1e-9);
    expect(ch.notes[ch.notes.length - 1].time).toBeLessThanOrEqual(song.durationSec - 1 + 1e-9);
    ch.notes.forEach((n, i) => {
      expect(n.id).toBe(i);
      if (i > 0) expect(n.time).toBeGreaterThanOrEqual(ch.notes[i - 1].time);
      expect(n.lane).toBeGreaterThanOrEqual(0);
      expect(n.lane).toBeLessThan(2);
    });
    expect(() => new Judge(ch, { perfectMs: 50, goodMs: 110 })).not.toThrow();
    const lead = generateChart(song, 2, 'medium', 1, { leadInBeats: 4 });
    expect(lead.notes[0].time).toBeGreaterThanOrEqual(song.offset + 4 * beatSec - 1e-9);
  });

  it('lands notes on the half-beat grid', () => {
    for (const [bpm, name, lanes] of [[120, 'hard', 4], [160, 'hard', 2], [140, 'medium', 3]] as const) {
      const s = { ...song, bpm };
      const ch = generateChart(s, lanes, name, 3);
      const halfBeat = 30 / bpm;
      for (const n of ch.notes) {
        const k = (n.time - s.offset) / halfBeat;
        expect(Math.abs(k - Math.round(k))).toBeLessThan(1e-5); // times are rounded to 1 µs
      }
    }
  });

  const BPMS = [60, 70, 80, 90, 100, 110, 120, 128, 140, 150, 160, 170, 180, 200];
  const configs: { bpm: number; lanes: number; dur: number; bpb: number }[] = [];
  for (const bpm of BPMS) for (const lanes of [1, 2, 3, 4]) for (const [dur, bpb] of [[120, 4], [45, 3]] as const) configs.push({ bpm, lanes, dur, bpb });

  for (const name of DIFFICULTY_NAMES as DifficultyName[]) {
    it(`${name}: pacing, density ±20%, lane balance, downbeats, phrase repetition for bpm 60–200, 1–4 lanes, 3/4 and 4/4`, () => {
      const target = DIFFICULTIES[name].noteDensity;
      for (const { bpm, lanes, dur, bpb } of configs) {
        for (let seed = 1; seed <= 3; seed++) {
          const offset = 0.1;
          const res = generateChartDetailed({ id: 'x', bpm, offset, durationSec: dur, beatsPerBar: bpb }, lanes, name, seed);
          const tag = `${name} bpm=${bpm} lanes=${lanes} dur=${dur} bpb=${bpb} seed=${seed}`;
          expect(spacingViolations(res.chart, MIN_LANE_SPACING_SEC[name], defaultCrossLaneGapSec(name, bpm)), tag).toEqual([]);
          expect(res.minLaneSpacingSec, tag).toBe(MIN_LANE_SPACING_SEC[name]);
          expect(res.minCrossLaneGapSec, tag).toBe(defaultCrossLaneGapSec(name, bpm));
          expect(res.targetDensity).toBe(target);
          expect(res.effectiveTargetDensity).toBeLessThanOrEqual(res.maxBarDensity + 1e-9);
          expect(res.maxBarDensity).toBeLessThanOrEqual(res.maxFeasibleDensity + 1e-9);
          const ratio = res.achievedDensity / res.effectiveTargetDensity;
          expect(ratio, `${tag} achieved=${res.achievedDensity.toFixed(3)} eff=${res.effectiveTargetDensity.toFixed(3)}`).toBeGreaterThanOrEqual(0.8);
          expect(ratio, tag).toBeLessThanOrEqual(1.2);
          const reduced = res.effectiveTargetDensity < target - 1e-9;
          const densityWarnings = res.warnings.filter((w) => /density reduced/.test(w));
          expect(densityWarnings.length, tag).toBe(reduced ? 1 : 0);
          if (!reduced) {
            // spec band relative to the nominal target whenever it is feasible
            expect(res.achievedDensity / target, tag).toBeGreaterThanOrEqual(0.8);
            expect(res.achievedDensity / target, tag).toBeLessThanOrEqual(1.2);
          }
          // realistic sessions (2-4 lanes): easy/medium are feasible at full density in 3/4 AND 4/4
          // (they were not while the cross-lane gap was a fixed 0.45 s), hard is at least 80 %
          if (lanes >= 2) {
            if (name !== 'hard') expect(reduced, tag).toBe(false);
            expect(res.achievedDensity / target, tag).toBeGreaterThanOrEqual(0.8);
          }
          // the only configs that miss the nominal ±20 % band are single-lane ones, where the spec's
          // own per-lane spacing is the binding constraint (0.9 s apart is 1.5 notes/beat only above
          // 90 bpm) — and every one of them says so in a warning rather than quietly under-delivering
          if (res.achievedDensity / target < 0.8) {
            expect(lanes, tag).toBe(1);
            expect(densityWarnings.length + res.warnings.filter((w) => /no bar pattern is playable/.test(w)).length, tag).toBeGreaterThan(0);
          }
          // no warnings other than the density reduction: balance, accents and off-beats are all in order
          expect(res.warnings.filter((w) => !/density reduced/.test(w)), tag).toEqual([]);

          // lane balance: bilateral rehab needs equal reps per side
          const counts = laneCounts(res.chart);
          const max = Math.max(...counts);
          const min = Math.min(...counts);
          expect(min, tag).toBeGreaterThan(0);
          expect(max - min, tag).toBeLessThanOrEqual(1);
          if (min >= 8) expect(max / min, tag).toBeLessThanOrEqual(LANE_SHARE_WARN_RATIO);
          expect(res.laneShares.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
          expect(res.laneShares[0]).toBeCloseTo(counts[0] / res.chart.notes.length, 9);

          // musicality
          if (name === 'easy') expect(res.offBeatFraction, tag).toBeLessThan(EASY_OFFBEAT_WARN_FRACTION);
          if (name === 'medium') expect(res.offBeatFraction, tag).toBeLessThan(0.15);
          expect(res.downbeatCoverage, tag).toBe(1);
          const rep = phraseRepetition(res, offset, bpb);
          expect(rep.mean, `${tag} phrase repetition ${rep.mean.toFixed(2)}`).toBeGreaterThanOrEqual(0.6);
        }
      }
    });
  }

  it('measures downbeat coverage and off-beat fraction (bilateral 2-lane sessions at common tempos)', () => {
    for (const bpm of [100, 110, 120, 128, 140]) {
      const easy = generateChartDetailed({ id: 'e', bpm, offset: 0, durationSec: 120 }, 2, 'easy', 1);
      expect(easy.offBeatFraction).toBe(0);
      expect(easy.downbeatCoverage).toBe(1);
      const medium = generateChartDetailed({ id: 'm', bpm, offset: 0, durationSec: 120 }, 2, 'medium', 1);
      expect(medium.offBeatFraction).toBeLessThan(0.1);
      expect(medium.downbeatCoverage).toBe(1);
      expect(medium.warnings).toEqual([]);
      const hard = generateChartDetailed({ id: 'h', bpm, offset: 0, durationSec: 120 }, 2, 'hard', 1);
      expect(hard.downbeatCoverage).toBe(1);
      const counts = laneCounts(hard.chart);
      expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
    }
  });

  it('reports the spacing-limited budget (hard, 2 lanes, 160 bpm)', () => {
    const b = densityBudget(160, 2, 1.5, 0.45, 0.15);
    expect(b.laneGapSlots).toBe(3); // 0.45 s / 0.1875 s
    expect(b.crossGapSlots).toBe(1);
    expect(b.maxFeasibleDensity).toBeCloseTo(4 / 3);
    expect(b.maxBarDensity).toBeCloseTo(1.25); // 5 notes per 4/4 bar is the densest bar-periodic pattern
    expect(b.maxOnBeatDensity).toBeCloseTo(1);
    expect(b.effectiveTargetDensity).toBeCloseTo(1.25);
    expect(b.beatsPerBar).toBe(4);
    const res = generateChartDetailed({ id: 'x', bpm: 160, offset: 0, durationSec: 90 }, 2, 'hard', 2);
    expect(res.warnings[0]).toMatch(/reduced from 1.5 to 1.250/);
    expect(res.achievedDensity).toBeGreaterThan(1.15);
    // easy at 120 bpm with 3 lanes has plenty of room: no warning
    const easy = densityBudget(120, 3, 0.5, 0.9, 0.45);
    expect(easy.effectiveTargetDensity).toBe(0.5);
    expect(generateChartDetailed(song, 3, 'easy', 1).warnings).toEqual([]);
    // targets of at most one note per beat never trade on-beat notes for syncopation: with an
    // explicit 0.45 s cross-lane gap, fast 3/4 easy caps at one note per bar...
    const waltz = densityBudget(150, 2, 0.5, 0.9, 0.45, 3);
    expect(waltz.maxBarDensity).toBeCloseTo(2 / 3);
    expect(waltz.maxOnBeatDensity).toBeCloseTo(1 / 3);
    expect(waltz.effectiveTargetDensity).toBeCloseTo(1 / 3);
    const forced = generateChartDetailed({ id: 'w', bpm: 150, offset: 0, durationSec: 60, beatsPerBar: 3 }, 2, 'easy', 1, { minCrossLaneGapSec: 0.45 });
    expect(forced.offBeatFraction).toBe(0);
    expect(forced.warnings[0]).toMatch(/on-beat bar pattern/);
    // ...but the default gap is derived from the beat grid (0.4 s at 150 bpm), so the same waltz
    // reaches the full easy density instead of losing a third of the patient's reps to a 0.002 s
    // rounding miss (0.4478 s between two on-beat notes vs a 0.45 s gate)
    const w = generateChartDetailed({ id: 'w', bpm: 150, offset: 0, durationSec: 60, beatsPerBar: 3 }, 2, 'easy', 1);
    expect(w.minCrossLaneGapSec).toBeCloseTo(0.4, 9);
    expect(w.effectiveTargetDensity).toBe(0.5);
    expect(w.achievedDensity).toBeGreaterThan(0.45);
    expect(w.offBeatFraction).toBe(0);
    expect(w.warnings).toEqual([]);
  });

  it('reaches the difficulty density in 3/4 at the tempos the fixed 0.45 s gate used to cut by a third', () => {
    for (const bpm of [134, 140, 150, 160, 170, 180]) {
      for (const lanes of [2, 3, 4]) {
        for (const name of ['easy', 'medium'] as const) {
          const tag = `${name} ${bpm} bpm 3/4 x${lanes}`;
          const r = generateChartDetailed({ id: 'x', bpm, offset: 0, durationSec: 120, beatsPerBar: 3 }, lanes, name, 2);
          expect(r.effectiveTargetDensity, tag).toBe(DIFFICULTIES[name].noteDensity);
          expect(r.achievedDensity / DIFFICULTIES[name].noteDensity, tag).toBeGreaterThanOrEqual(0.8);
          expect(r.achievedDensity / DIFFICULTIES[name].noteDensity, tag).toBeLessThanOrEqual(1.2);
          expect(spacingViolations(r.chart, MIN_LANE_SPACING_SEC[name], defaultCrossLaneGapSec(name, bpm)), tag).toEqual([]);
          expect(r.warnings, tag).toEqual([]);
        }
      }
    }
  });

  it('easy never asks for two movements closer than the cross-lane gap (capped at one beat)', () => {
    for (const bpm of [100, 120, 140]) {
      for (const lanes of [2, 4]) {
        const ch = generateChart({ id: 'e', bpm, offset: 0, durationSec: 60 }, lanes, 'easy', 11);
        let minGap = Infinity;
        for (let i = 1; i < ch.notes.length; i++) minGap = Math.min(minGap, ch.notes[i].time - ch.notes[i - 1].time);
        expect(minGap).toBeGreaterThanOrEqual(defaultCrossLaneGapSec('easy', bpm) - GRID_EPS);
      }
    }
    // the cap is the beat, and it only ever binds above 133 bpm on easy
    expect(defaultCrossLaneGapSec('easy', 120)).toBe(MIN_CROSS_LANE_GAP_SEC.easy);
    expect(defaultCrossLaneGapSec('easy', 180)).toBeCloseTo(1 / 3, 9);
    expect(defaultCrossLaneGapSec('hard', 200)).toBe(MIN_CROSS_LANE_GAP_SEC.hard);
    const custom = generateChart(song, 4, 'easy', 11, { minCrossLaneGapSec: 0.1, minLaneSpacingSec: 0.5 });
    expect(spacingViolations(custom, 0.5, 0.1)).toEqual([]);
  });

  it('gives every lane an equal share of reps without being one predictable rotation', () => {
    const ch = generateChart(song, 4, 'easy', 11);
    const counts = laneCounts(ch);
    expect(counts.every((c) => c > 0)).toBe(true);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
    const dense = generateChart({ id: 'l', bpm: 180, offset: 0, durationSec: 60 }, 3, 'medium', 1);
    const dc = laneCounts(dense);
    expect(Math.max(...dc) - Math.min(...dc)).toBeLessThanOrEqual(1);
    // spacing is still guaranteed note by note (this is what the rotation used to prove)
    expect(spacingViolations(dense, MIN_LANE_SPACING_SEC.medium, MIN_CROSS_LANE_GAP_SEC.medium)).toEqual([]);
    // ...but the lane order is not a single fixed cycle a patient memorises within a bar
    let cyclic = 0;
    for (let i = 1; i < dense.notes.length; i++) if (dense.notes[i].lane === (dense.notes[i - 1].lane + 1) % 3) cyclic++;
    expect(cyclic).toBeLessThan(dense.notes.length - 1);
    // a different seed gives a different lane sequence, and the same seed reproduces it exactly
    const other = generateChart({ id: 'l', bpm: 180, offset: 0, durationSec: 60 }, 3, 'medium', 2);
    expect(other.notes.map((n) => n.lane)).not.toEqual(dense.notes.map((n) => n.lane));
    expect(generateChart({ id: 'l', bpm: 180, offset: 0, durationSec: 60 }, 3, 'medium', 1).notes).toEqual(dense.notes);
  });

  it('places accent notes on every bar downbeat (bar grid anchored at the song offset)', () => {
    const ch = generateChart(song, 3, 'medium', 5);
    const beatSec = 60 / song.bpm;
    const times = new Set(ch.notes.map((n) => Math.round(n.time * 1e4)));
    let hits = 0;
    let bars = 0;
    for (let bar = 1; bar < 29; bar++) {
      const t = song.offset + bar * 4 * beatSec;
      bars++;
      if (times.has(Math.round(t * 1e4))) hits++;
    }
    expect(hits).toBe(bars);
    const noAccent = generateChartDetailed(song, 3, 'medium', 5, { accents: false });
    expect(noAccent.chart.notes.length).toBeGreaterThan(0);
    expect(noAccent.warnings).toEqual([]);
  });

  it('honours beatsPerBar=3 downbeats and clamps absurd meters', () => {
    const s = { id: 'w', bpm: 120, offset: 0, durationSec: 60, beatsPerBar: 3 };
    const ch = generateChart(s, 3, 'medium', 5);
    const beatSec = 0.5;
    const times = new Set(ch.notes.map((n) => Math.round(n.time * 1e4)));
    let hits = 0;
    for (let bar = 1; bar < 38; bar++) if (times.has(Math.round(bar * 3 * beatSec * 1e4))) hits++;
    expect(hits).toBe(37);
    const wide = generateChartDetailed({ ...s, beatsPerBar: 12 }, 2, 'medium', 1);
    expect(wide.beatsPerBar).toBe(8);
    expect(wide.warnings.join()).toMatch(/clamped/);
    expect(spacingViolations(wide.chart, MIN_LANE_SPACING_SEC.medium, MIN_CROSS_LANE_GAP_SEC.medium)).toEqual([]);
  });

  it('repeats a 4-bar phrase [A A A A\'] with a seeded variation bar', () => {
    const res = generateChartDetailed({ id: 'p', bpm: 120, offset: 0, durationSec: 80 }, 3, 'medium', 21);
    const rep = phraseRepetition(res, 0, 4);
    expect(rep.mean).toBeGreaterThan(0.6);
    expect(rep.distinct).toBeGreaterThan(0); // variation actually happens
    // bars 1-3 of a phrase share the base pattern
    const slotSec = 0.25;
    const barSlots = (bar: number) => res.chart.notes.filter((n) => n.time >= bar * 2 && n.time < (bar + 1) * 2).map((n) => Math.round((n.time - bar * 2) / slotSec));
    expect(barSlots(4)).toEqual(barSlots(5));
    expect(barSlots(5)).toEqual(barSlots(6));
    expect(barSlots(4)).toEqual([0, 2, 4, 6]); // medium at 120 bpm: one note per beat
    // easy bilateral: strictly on the beat, alternating legs
    const easy = generateChartDetailed({ id: 'e', bpm: 120, offset: 0, durationSec: 80 }, 2, 'easy', 21);
    expect(easy.offBeatFraction).toBe(0);
    // bilateral: both legs get the same number of reps, never closer than the easy lane spacing
    const ec = laneCounts(easy.chart);
    expect(Math.abs(ec[0] - ec[1])).toBeLessThanOrEqual(1);
    expect(spacingViolations(easy.chart, MIN_LANE_SPACING_SEC.easy, MIN_CROSS_LANE_GAP_SEC.easy)).toEqual([]);
    expect(phraseRepetition(easy, 0, 4).mean).toBeGreaterThan(0.6);
  });

  it('handles degenerate songs', () => {
    const short = generateChartDetailed({ id: 'short', bpm: 120, offset: 0, durationSec: 1 }, 2, 'easy', 1);
    expect(short.chart.notes).toEqual([]);
    expect(short.warnings.join()).toMatch(/too short/);
    expect(short.laneShares).toEqual([0, 0]);
    // generateChart refuses to hand back an empty highway as if it were playable
    expect(() => generateChart({ id: 'short', bpm: 120, offset: 0, durationSec: 1 }, 2, 'easy', 1)).toThrow(ChartGenerationError);
    expect(() => generateChart({ id: 'short', bpm: 120, offset: 0, durationSec: 1 }, 2, 'easy', 1)).toThrow(/too short/);
    // a bad beat grid fails at generation, not silently as 120 bpm
    expect(() => generateChart({ id: 'z', bpm: 0, offset: 0, durationSec: 10 }, 1, 'easy', 1)).toThrow(/bpm must be positive/);
    expect(() => generateChart({ id: 'z', bpm: 120, offset: Number.NaN, durationSec: 10 }, 1, 'easy', 1)).toThrow(/offset must be finite/);
    expect(() => generateChart({ id: 'z', bpm: 120, offset: 0, durationSec: 0 }, 1, 'easy', 1)).toThrow(/durationSec must be positive/);
    const one = generateChart(song, 1, 'hard', 2);
    expect(spacingViolations(one, MIN_LANE_SPACING_SEC.hard, MIN_CROSS_LANE_GAP_SEC.hard)).toEqual([]);
    expect(generateChart(song, 2, 'easy', 1, { phraseBars: 1 }).notes.length).toBeGreaterThan(10);
  });
});

describe('mulberry32', () => {
  it('is deterministic and in [0,1)', () => {
    const a = mulberry32(123);
    const b = mulberry32(123);
    for (let i = 0; i < 100; i++) {
      const x = a();
      expect(x).toBe(b());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
});

describe('serialize / parse', () => {
  it('round-trips', () => {
    const ch = generateChart(song, 3, 'easy', 9);
    const json = serializeChart(ch);
    const back = parseChart(json);
    expect(back).toEqual(ch);
    expect(parseChart(JSON.parse(json))).toEqual(ch);
    const cj: ChartJson = chartToJson(ch);
    expect(cj.v).toBe(CHART_FORMAT_VERSION);
    expect(cj.notes[0]).toEqual([ch.notes[0].id, ch.notes[0].lane, ch.notes[0].time]);
  });
  it('accepts object notes and sorts them', () => {
    const c = parseChart({ ...chartToJson(generateChart(song, 2, 'easy', 1)), notes: [{ id: 1, lane: 0, time: 5 }, { id: 0, lane: 1, time: 3 }] });
    expect(c.notes.map((n) => n.id)).toEqual([0, 1]);
  });
  it('rejects invalid input', () => {
    const base = chartToJson(generateChart(song, 2, 'easy', 1));
    expect(() => parseChart('null')).toThrow();
    expect(() => parseChart({ ...base, songId: 1 })).toThrow(/songId/);
    expect(() => parseChart({ ...base, bpm: -1 })).toThrow(/bpm/);
    expect(() => parseChart({ ...base, difficulty: { ...base.difficulty, name: 'brutal' } })).toThrow(/difficulty/);
    expect(() => parseChart({ ...base, notes: [[0, 5, 1]] })).toThrow(/lane out of range/);
    expect(() => parseChart({ ...base, notes: [[0, 0.5, 1]] })).toThrow(/lane out of range/);
    expect(() => parseChart({ ...base, notes: [[0, 0, 'x']] })).toThrow(/note 0/);
    expect(() => parseChart({ ...base, notes: 'nope' })).toThrow(/notes/);
  });
  it('rejects duplicate note ids and unknown format versions', () => {
    const base = chartToJson(generateChart(song, 2, 'easy', 1));
    expect(() => parseChart({ ...base, notes: [[0, 0, 1], [0, 1, 2]] })).toThrow(/duplicate id 0/);
    expect(() => parseChart({ ...base, v: 2 })).toThrow(/unsupported format version 2/);
    expect(() => parseChart({ ...base, v: 'x' })).toThrow(/format version/);
    const { v: _v, ...noVersion } = base;
    expect(parseChart(noVersion).notes.length).toBe(base.notes.length); // v missing = v1
  });
});

describe('generateChart: configurations that used to produce a silent empty highway', () => {
  it('falls back to multi-bar spacing instead of an empty chart (fast waltzes and marches)', () => {
    const empties: string[] = [];
    let sparse = 0;
    for (let bpm = 120; bpm <= 260; bpm += 2) {
      for (const beatsPerBar of [2, 3, 4]) {
        for (const d of DIFFICULTY_NAMES) {
          for (const lanes of [1, 2]) {
            const r = generateChartDetailed({ id: 'f', bpm, offset: 0, durationSec: 180, beatsPerBar }, lanes, d, 1);
            if (r.chart.notes.length === 0) empties.push(`${bpm}/${beatsPerBar}/${d}/${lanes}`);
            if (r.sparseBarStride > 0) sparse++;
            expect(spacingViolations(r.chart, MIN_LANE_SPACING_SEC[d], defaultCrossLaneGapSec(d, bpm))).toEqual([]);
          }
        }
      }
    }
    expect(empties).toEqual([]);
    expect(sparse).toBeGreaterThan(0); // the fallback really is exercised by this range
  });

  it('the reported 2/4-at-134-bpm easy case is playable, spaced and warned about', () => {
    const r = generateChartDetailed({ id: 'm', bpm: 134, offset: 0, durationSec: 180, beatsPerBar: 2 }, 1, 'easy', 1);
    expect(r.sparseBarStride).toBe(2);
    expect(r.chart.notes.length).toBeGreaterThan(50);
    const gaps: number[] = [];
    for (let i = 1; i < r.chart.notes.length; i++) gaps.push(r.chart.notes[i].time - r.chart.notes[i - 1].time);
    expect(Math.min(...gaps)).toBeGreaterThan(MIN_LANE_SPACING_SEC.easy);
    expect(Math.min(...gaps)).toBeCloseTo((4 * 60) / 134, 5); // two 2/4 bars apart
    expect(r.warnings.join()).toMatch(/no bar pattern is playable/);
    expect(r.achievedDensity).toBeCloseTo(r.effectiveTargetDensity, 1);
    // every note is on a bar downbeat, and the chart is still deterministic
    expect(generateChart({ id: 'm', bpm: 134, offset: 0, durationSec: 180, beatsPerBar: 2 }, 1, 'easy', 1).notes).toEqual(r.chart.notes);
  });

  it('generateChart surfaces the warnings its detailed form computes', () => {
    const seen: string[] = [];
    const song2 = { id: 'w', bpm: 160, offset: 0, durationSec: 90 };
    const detailed = generateChartDetailed(song2, 2, 'hard', 1);
    generateChart(song2, 2, 'hard', 1, { onWarning: (x) => seen.push(x) });
    expect(seen).toEqual(detailed.warnings);
    expect(seen.length).toBeGreaterThan(0);
  });

  it('never places a note before the audio starts, even with a negative song offset', () => {
    for (const offset of [-0.4, -1.7, -0.05]) {
      for (const leadInBeats of [0, 2]) {
        for (const d of DIFFICULTY_NAMES) {
          const r = generateChartDetailed({ id: 'n', bpm: 120, offset, durationSec: 60 }, 2, d, 3, { leadInBeats });
          expect(r.chart.notes.length).toBeGreaterThan(0);
          expect(Math.min(...r.chart.notes.map((n) => n.time))).toBeGreaterThanOrEqual(0);
        }
      }
    }
    const warned = generateChartDetailed({ id: 'n', bpm: 120, offset: -0.4, durationSec: 60 }, 2, 'easy', 3, { leadInBeats: 0 });
    expect(warned.warnings.join()).toMatch(/negative/);
  });
});

describe('parseChart validates the difficulty numbers it hands to vision and the Judge', () => {
  const base = () => chartToJson(generateChart(song, 2, 'medium', 1));

  it('rejects a thresholdFraction outside [0, 1] (an unwinnable session, silently)', () => {
    const j = base();
    expect(() => parseChart({ ...j, difficulty: { ...j.difficulty, thresholdFraction: 5 } })).toThrow(/thresholdFraction 5 out of range/);
    expect(() => parseChart({ ...j, difficulty: { ...j.difficulty, thresholdFraction: -0.1 } })).toThrow(/out of range/);
    expect(parseChart({ ...j, difficulty: { ...j.difficulty, thresholdFraction: 1 } }).difficulty.thresholdFraction).toBe(1);
    expect(parseChart({ ...j, difficulty: { ...j.difficulty, thresholdFraction: 0 } }).difficulty.thresholdFraction).toBe(0);
  });
  it('rejects a negative noteDensity and non-positive or inverted windows', () => {
    const j = base();
    expect(() => parseChart({ ...j, difficulty: { ...j.difficulty, noteDensity: -3 } })).toThrow(/noteDensity -3/);
    expect(() => parseChart({ ...j, difficulty: { ...j.difficulty, windows: { perfectMs: -10, goodMs: 0 } } })).toThrow(/positive/);
    expect(() => parseChart({ ...j, difficulty: { ...j.difficulty, windows: { perfectMs: 200, goodMs: 100 } } })).toThrow(/exceeds goodMs/);
    // and the error names the field, at load, instead of throwing later inside the Judge
    expect(() => parseChart({ ...j, difficulty: { ...j.difficulty, windows: { perfectMs: -10, goodMs: 0 } } })).toThrow(/difficulty.windows/);
  });
  it('accepts a chart written to the documented shape (no durationSec) and fills it in', () => {
    const j = { ...base() } as unknown as Record<string, unknown>;
    delete j.durationSec;
    const c = parseChart(j);
    expect(c.durationSec).toBeCloseTo(c.notes[c.notes.length - 1].time, 9);
    expect(c.notes.length).toBeGreaterThan(0);
  });
  it('says so when it had to invent durationSec, instead of passing off an assumption as data', () => {
    const j = { ...base() } as unknown as Record<string, unknown>;
    delete j.durationSec;
    const r = parseChartDetailed(j);
    expect(r.chart.durationSec).toBeCloseTo(r.chart.notes[r.chart.notes.length - 1].time, 9);
    expect(r.warnings.join()).toMatch(/durationSec missing/);
    // nothing is assumed for a complete chart
    expect(parseChartDetailed(base()).warnings).toEqual([]);
    expect(parseChartDetailed(base()).chart).toEqual(parseChart(base()));
  });
});

describe('generateChart: the lead-in is measured from the audio start, not from the beat grid', () => {
  // Regression: the clamp guaranteed notes >= 0 but not >= the lead-in measured from t = 0, so a
  // negative offset could put the first note at exactly 0.000 with no approach time on the highway
  // (unhittable) and NO warning — the warning only fired when the skipped slots exceeded the lead-in.
  it('never places the first note inside the lead-in, and warns whenever the clamp binds', () => {
    const probes = [
      { bpm: 240, offset: -0.5 },
      { bpm: 120, offset: -1.0 },
      { bpm: 174, offset: -2 },
      { bpm: 90, offset: -0.13 },
      { bpm: 60, offset: -3.25 },
    ];
    for (const { bpm, offset } of probes) {
      for (const d of DIFFICULTY_NAMES) {
        const leadInBeats = 2;
        const r = generateChartDetailed({ id: 'lead', bpm, offset, durationSec: 90 }, 2, d, 5, { leadInBeats });
        const tag = `bpm=${bpm} offset=${offset} ${d}`;
        expect(r.chart.notes.length, tag).toBeGreaterThan(0);
        const first = Math.min(...r.chart.notes.map((n) => n.time));
        expect(first, tag).toBeGreaterThanOrEqual((leadInBeats * 60) / bpm - 1e-9);
        expect(r.warnings.filter((w) => /negative/.test(w)).length, tag).toBe(1);
      }
    }
  });
  it('leaves non-negative offsets exactly as they were', () => {
    for (const offset of [0, 0.1, 1.7]) {
      for (const d of DIFFICULTY_NAMES) {
        const r = generateChartDetailed({ id: 'p', bpm: 128, offset, durationSec: 90 }, 3, d, 7);
        expect(r.warnings.filter((w) => /negative/.test(w))).toEqual([]);
        expect(Math.min(...r.chart.notes.map((n) => n.time))).toBeGreaterThanOrEqual(offset + (2 * 60) / 128 - 1e-9);
      }
    }
  });
  it('a zero lead-in still keeps every note at or after the audio start', () => {
    const r = generateChartDetailed({ id: 'z', bpm: 240, offset: -0.5, durationSec: 60 }, 2, 'easy', 1, { leadInBeats: 0 });
    expect(Math.min(...r.chart.notes.map((n) => n.time))).toBeGreaterThanOrEqual(0);
    expect(r.warnings.join()).toMatch(/negative/);
  });
});
