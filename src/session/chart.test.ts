import { describe, expect, it } from 'vitest';
import type { SongManifest } from '../audio/manifest.ts';
import { SILENT_GRID, buildSessionChart, songGridOf } from './chart.ts';
import type { SessionConfig } from './types.ts';

const MANIFEST: SongManifest = {
  id: 'demo-sunrise',
  title: 'Sunrise Shuffle',
  artist: 'demo',
  license: 'CC0 1.0',
  bpm: 100,
  offset: 0,
  durationSec: 77.8,
  swing: 1 / 3,
  stems: [{ id: 'drums', file: 'stems/drums.wav', label: 'Drums' }],
  playerStem: 'drums',
};

const CONFIG: SessionConfig = {
  mode: 'leg',
  lanes: [
    { index: 0, movement: 'seated_march', side: 'left' },
    { index: 1, movement: 'seated_march', side: 'right' },
    { index: 2, movement: 'knee_extension', side: 'left' },
  ],
  difficulty: 'medium',
  windowScale: 1,
  songId: 'demo-sunrise',
  seed: 7,
};

describe('buildSessionChart', () => {
  it('generates a chart on the song grid with one lane per prescribed movement', () => {
    const { chart } = buildSessionChart(songGridOf(MANIFEST), CONFIG, MANIFEST);
    expect(chart.lanes).toBe(3);
    expect(chart.bpm).toBe(100);
    expect(chart.notes.length).toBeGreaterThan(20);
    expect(chart.notes.every((n) => n.lane >= 0 && n.lane < 3)).toBe(true);
    expect(chart.notes.every((n) => n.time >= 0 && n.time <= MANIFEST.durationSec)).toBe(true);
  });

  it('is deterministic for a seed and changes with it', () => {
    const a = buildSessionChart(songGridOf(MANIFEST), CONFIG, MANIFEST).chart;
    const b = buildSessionChart(songGridOf(MANIFEST), CONFIG, MANIFEST).chart;
    const c = buildSessionChart(songGridOf(MANIFEST), { ...CONFIG, seed: 8 }, MANIFEST).chart;
    expect(a.notes).toEqual(b.notes);
    expect(c.notes).not.toEqual(a.notes);
  });

  it('reports no swing mismatch for a swung song (the generator stays on half beats)', () => {
    const { warnings } = buildSessionChart(songGridOf(MANIFEST), CONFIG, MANIFEST);
    expect(warnings.some((w) => w.includes('swung grid'))).toBe(false);
  });

  it('still produces a playable chart when no song could be loaded', () => {
    const { chart } = buildSessionChart(SILENT_GRID, CONFIG, null);
    expect(chart.notes.length).toBeGreaterThan(10);
    expect(chart.durationSec).toBeGreaterThan(0);
  });

  it('harder difficulties put more notes in the same song', () => {
    const easy = buildSessionChart(songGridOf(MANIFEST), { ...CONFIG, difficulty: 'easy' }, MANIFEST).chart;
    const hard = buildSessionChart(songGridOf(MANIFEST), { ...CONFIG, difficulty: 'hard' }, MANIFEST).chart;
    expect(hard.notes.length).toBeGreaterThan(easy.notes.length);
  });
});
