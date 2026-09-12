import { describe, expect, it } from 'vitest';
const out: string[] = [];
const log = (...a: unknown[]) => out.push(a.map(String).join(' '));
import {
  DWELL_CLEAR_EXTRA, DWELL_DEFAULTS, DwellCoupling, DwellHabitat, DwellLayout, DwellTracker,
  dwellAxisFor, dwellEngaged, dwellLimbs, dwellReferences, dwellTargetClear, pickDwellLimb,
} from '../vision/dwell.ts';
import type { DwellCircle } from '../vision/dwell.ts';
import { dwellCircleFits, pairedDwellTargets, PREVIEW_ASPECT } from '../ui/DwellTarget.tsx';
import { seatedPose } from '../vision/fixtures.ts';
import type { DetectionResult } from '../vision/mediapipe.ts';

describe('dbg', () => {
  it('escape 1 trace', () => {
    const aspect = PREVIEW_ASPECT;
    const authored = pairedDwellTargets('leg');
    const ids = ['t0', 't1'];
    const habitat = new DwellHabitat();
    const coupling = new DwellCoupling();
    const clearOpts = { xScale: aspect, axis: dwellAxisFor('leg'), exitRatio: DWELL_DEFAULTS.exitRatio, extra: DWELL_CLEAR_EXTRA, fits: (c: DwellCircle) => dwellCircleFits(c, aspect) };
    const layout = new DwellLayout(authored.map((c, i) => ({ id: ids[i], authored: c })), clearOpts);
    const trackers = new Map(ids.map((id) => [id, new DwellTracker(layout.circleFor(id) as DwellCircle, { xScale: aspect })]));
    let previous = null as any; let previousKey: string | null = null; let lastSurvey = -Infinity;
    let occupied = new Map<string, boolean>();
    const fps = 30;
    for (let i = 0; i <= 30 * fps; i++) {
      const t = i / fps;
      const away = t % 5.5 >= 4;
      const left = away ? { x: 0.55, y: 0.72 } : { x: 0.7, y: 0.45 };
      const det: DetectionResult = { tMs: 0, pose: seatedPose({ side: 'left', kneeLift: 0, hands: 'chair_arms', handAt: { side: 'left', ...left } }), hands: [] };
      const limbs = dwellLimbs(det, 'leg', false, aspect);
      const refs = dwellReferences(det, 'leg', { xScale: aspect });
      let busy = false;
      for (const tr of trackers.values()) { const st = tr.state; if (st.progress > 0 || st.blocked === 'refractory') busy = true; }
      if (!busy) for (const l of limbs) {
        if (dwellEngaged(l.point, layout.circles(), aspect, DWELL_DEFAULTS.exitRatio)) continue;
        habitat.noteOne(l.key, l.point, t, l.scale ?? null); coupling.noteOne(l.key, l.point, refs, t, aspect);
      }
      const summaries = habitat.all(t, aspect);
      if (t - lastSurvey >= 0.08 - 1e-9) { lastSurvey = t; const s = layout.survey(summaries, t, busy); occupied = s.occupied;
        if (s.moved) { for (const [id, tr] of trackers) tr.setTarget(layout.circleFor(id) as DwellCircle, aspect); log(t.toFixed(2), 'MOVED', JSON.stringify(layout.circles())); } }
      for (const [id, tr] of trackers) tr.setOccupied(occupied.get(id) === true);
      const carried = coupling.coupledKeys(t);
      const limb = pickDwellLimb(limbs, layout.circles(), { xScale: aspect, previous, previousKey, avoid: carried });
      for (const tr of trackers.values()) tr.setCoupled(limb ? carried.has(limb.key) : false);
      previous = limb?.point ?? null; previousKey = limb?.key ?? null;
      for (const [id, tr] of trackers) {
        const st = tr.update(limb?.point ?? null, t, limb?.key ?? null);
        if (i % 60 === 0 && id === 't0') log(t.toFixed(2), 'p', st.progress.toFixed(2), 'blk', st.blocked, 'in', st.withinEntry, 'limb', limb?.key, JSON.stringify(limb?.point), 'circle', JSON.stringify(tr.circle), 'summ', summaries.length);
        if (st.confirmed) log(t.toFixed(2), 'CONFIRM', id, JSON.stringify(tr.circle), 'limb', limb?.key, JSON.stringify(limb?.point), 'summaries', JSON.stringify(summaries.map((s) => [s.key, s.home, s.spread.toFixed(3)])), 'clear', JSON.stringify(dwellTargetClear(tr.circle, summaries, clearOpts)));
      }
    }
    process.stdout.write(out.join('\n') + '\n');
    expect(1).toBe(1);
  });
});
