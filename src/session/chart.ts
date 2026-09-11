/**
 * Chart for a session: the song's beat grid + the therapist's prescription.
 *
 * Kept out of the UI so the Play screen never has to know about swing, lead-in or the generator's
 * warnings — and so a critic can build the same chart headlessly.
 */
import { findOffGridTimes } from '../audio/manifest.ts';
import type { SongManifest } from '../audio/manifest.ts';
import { clampLaneRestSec, generateChartDetailed } from '../charts/generate.ts';
import type { SongGrid } from '../charts/generate.ts';
import type { Chart } from '../engine/types.ts';
import type { SessionConfig } from './types.ts';

export interface BuiltChart {
  chart: Chart;
  /** Generator diagnostics plus any note that missed the song's (possibly swung) grid. */
  warnings: string[];
}

/** Beat grid the chart is generated on. `durationSec` is the audio length, tail included. */
export function songGridOf(manifest: SongManifest): SongGrid {
  return { id: manifest.id, bpm: manifest.bpm, offset: manifest.offset, durationSec: manifest.durationSec };
}

/**
 * The grid used when no song could be loaded (offline clinic, stems not fetched): the session still
 * runs, silently, on a 120 BPM 90 s grid so a prescription is never blocked by a missing download.
 */
export const SILENT_GRID: SongGrid = { id: 'silent', bpm: 120, offset: 0, durationSec: 90 };

export function buildSessionChart(grid: SongGrid, config: SessionConfig, manifest?: SongManifest | null): BuiltChart {
  // The therapist's pacing floor overrides the difficulty's own spacing: a difficulty is a statement
  // about timing windows and ROM threshold, not about how long an impaired limb needs to return to
  // rest (see charts/generate.ts DEFAULT_LANE_REST_SEC).
  const result = generateChartDetailed(grid, config.lanes.length, config.difficulty, config.seed, {
    minLaneSpacingSec: config.laneRestSec === undefined ? undefined : clampLaneRestSec(config.laneRestSec),
  });
  const warnings = [...result.warnings];
  if (manifest && manifest.swing) {
    // The generator works on a half-beat grid, which is swing-invariant — but if that ever changes,
    // a note landing between the drums and where it is drawn must be visible here, not felt.
    const off = findOffGridTimes(manifest, result.chart.notes.map((n) => n.time));
    if (off.length > 0) {
      const worst = off.reduce((a, b) => (Math.abs(b.deltaMs) > Math.abs(a.deltaMs) ? b : a));
      warnings.push(`${off.length} note(s) are off the song's swung grid (worst ${Math.round(worst.deltaMs)} ms) — the chart and the drums disagree.`);
    }
  }
  return { chart: result.chart, warnings };
}
