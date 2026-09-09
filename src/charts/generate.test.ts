import { describe, expect, it } from 'vitest';
import { DIFFICULTIES, DIFFICULTY_NAMES } from '../engine/difficulty.ts';
import type { Chart, DifficultyName } from '../engine/types.ts';
import { MIN_LANE_SPACING_SEC, chartToJson, generateChart, mulberry32, parseChart, serializeChart } from './generate.ts';

const song = { id: 'demo', bpm: 120, offset: 0.25, durationSec: 60 };

function laneSpacingOk(chart: Chart, minSec: number): boolean {
  const last: number[] = [];
  for (const n of chart.notes) {
    if (last[n.lane] !== undefined && n.time - last[n.lane] < minSec - 1e-9) return false;
    last[n.lane] = n.time;
  }
  return true;
}

function density(chart: Chart): number {
  const beatSec = 60 / chart.bpm;
  const first = chart.offset + 2 * beatSec;
  const span = chart.durationSec - 1 - first; // seconds usable for notes (lead-in + 1 s tail)
  return chart.notes.length / (span / beatSec);
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
    expect(a.lanes).toBe(3);
    expect(a.songId).toBe('demo');
    expect(a.durationSec).toBe(60);
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
  });

  it('lands notes on the half-beat grid', () => {
    const ch = generateChart(song, 4, 'hard', 3);
    const halfBeat = 30 / song.bpm;
    for (const n of ch.notes) {
      const k = (n.time - song.offset) / halfBeat;
      expect(Math.abs(k - Math.round(k))).toBeLessThan(1e-6);
    }
  });

  const configs: { bpm: number; lanes: number }[] = [];
  for (const bpm of [90, 110, 128]) for (const lanes of [2, 3, 4]) configs.push({ bpm, lanes });

  for (const name of DIFFICULTY_NAMES as DifficultyName[]) {
    it(`${name}: respects per-lane spacing and density within ±20% across bpm/lane configs`, () => {
      for (const { bpm, lanes } of configs) {
        for (let seed = 1; seed <= 5; seed++) {
          const ch = generateChart({ id: 'x', bpm, offset: 0.1, durationSec: 120 }, lanes, name, seed);
          expect(laneSpacingOk(ch, MIN_LANE_SPACING_SEC[name])).toBe(true);
          const d = density(ch);
          const target = DIFFICULTIES[name].noteDensity;
          expect(d, `density ${name} bpm=${bpm} lanes=${lanes} seed=${seed}`).toBeGreaterThanOrEqual(target * 0.8);
          expect(d, `density ${name} bpm=${bpm} lanes=${lanes} seed=${seed}`).toBeLessThanOrEqual(target * 1.2);
        }
      }
    });
  }

  it('uses all lanes', () => {
    const ch = generateChart(song, 4, 'easy', 11);
    expect(new Set(ch.notes.map((n) => n.lane)).size).toBe(4);
  });

  it('places accent notes on bar downbeats when possible', () => {
    const ch = generateChart(song, 3, 'medium', 5);
    const beatSec = 60 / song.bpm;
    const times = new Set(ch.notes.map((n) => Math.round(n.time * 1e4)));
    let hits = 0;
    let bars = 0;
    for (let bar = 1; bar < 12; bar++) {
      const t = song.offset + (2 + bar * 4) * beatSec;
      bars++;
      if (times.has(Math.round(t * 1e4))) hits++;
    }
    expect(hits).toBe(bars);
    const noAccent = generateChart(song, 3, 'medium', 5, { accents: false });
    expect(noAccent.notes.length).toBeGreaterThan(0);
  });

  it('repeats a 4-bar phrase with variation', () => {
    const ch = generateChart({ id: 'p', bpm: 120, offset: 0, durationSec: 80 }, 3, 'medium', 21);
    const beatSec = 0.5;
    const phraseSec = 16 * beatSec;
    const slots = (from: number, to: number) => new Set(ch.notes.filter((n) => n.time >= from && n.time < to).map((n) => Math.round((n.time - from) / (beatSec / 2))));
    const p0 = slots(2 * beatSec, 2 * beatSec + phraseSec);
    const p1 = slots(2 * beatSec + phraseSec, 2 * beatSec + 2 * phraseSec);
    let common = 0;
    for (const s of p0) if (p1.has(s)) common++;
    expect(common / Math.max(1, p0.size)).toBeGreaterThan(0.6);
  });

  it('handles degenerate songs', () => {
    expect(generateChart({ id: 'short', bpm: 120, offset: 0, durationSec: 1 }, 2, 'easy', 1).notes).toEqual([]);
    expect(generateChart({ id: 'z', bpm: 0, offset: 0, durationSec: 10 }, 1, 'easy', 1).bpm).toBe(120);
    const one = generateChart(song, 1, 'hard', 2);
    expect(laneSpacingOk(one, MIN_LANE_SPACING_SEC.hard)).toBe(true);
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
    expect(chartToJson(ch).notes[0]).toEqual([ch.notes[0].id, ch.notes[0].lane, ch.notes[0].time]);
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
    expect(() => parseChart({ ...base, notes: [[0, 0, 'x']] })).toThrow(/note 0/);
    expect(() => parseChart({ ...base, notes: 'nope' })).toThrow(/notes/);
  });
});
