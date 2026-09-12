import { describe, expect, it } from 'vitest';
import {
  DWELL_CLEAR_EXTRA, DWELL_DEFAULTS, DwellCoupling, DwellEngagement, DwellHabitat, DwellLayout, DwellTracker,
  dwellAxisFor, dwellLimbs, dwellReferences, dwellTargetClear, pickDwellLimb,
} from '../vision/dwell.ts';
import type { DwellCircle } from '../vision/dwell.ts';
import { dwellCircleFits, pairedDwellTargets, PREVIEW_ASPECT } from '../ui/DwellTarget.tsx';
import { seatedPose } from '../vision/fixtures.ts';
import type { DetectionResult } from '../vision/mediapipe.ts';

const lines: string[] = [];
const log = (...a: unknown[]) => lines.push(a.map(String).join(' '));
const CRITIC = { riseSec: 2, holdSec: 2.5, fallSec: 2, restSec: 10 };
function amountAt(t: number) {
  const span = CRITIC.riseSec + CRITIC.holdSec + CRITIC.fallSec;
  const cycle = ((t % (span + CRITIC.restSec)) + span + CRITIC.restSec) % (span + CRITIC.restSec);
  if (cycle < CRITIC.riseSec) return 0.5 * (1 - Math.cos(Math.PI * (cycle / CRITIC.riseSec)));
  if (cycle < CRITIC.riseSec + CRITIC.holdSec) return 1;
  const fall = cycle - CRITIC.riseSec - CRITIC.holdSec;
  if (fall >= CRITIC.fallSec) return 0;
  return 0.5 * (1 + Math.cos(Math.PI * (fall / CRITIC.fallSec)));
}

describe('attack', () => {
  it('trace', () => {
    const aspect = PREVIEW_ASPECT; const fps = 30; const f = 1;
    const authored = pairedDwellTargets('leg'); const ids = ['t0', 't1'];
    const habitat = new DwellHabitat(); const coupling = new DwellCoupling(); const engagement = new DwellEngagement();
    const clearOpts = { xScale: aspect, axis: dwellAxisFor('leg'), exitRatio: DWELL_DEFAULTS.exitRatio, extra: DWELL_CLEAR_EXTRA, fits: (c: DwellCircle) => dwellCircleFits(c, aspect) };
    const layout = new DwellLayout(authored.map((c, i) => ({ id: ids[i], authored: c })), clearOpts);
    const trackers = new Map(ids.map((id) => [id, new DwellTracker(layout.circleFor(id) as DwellCircle, { xScale: aspect })]));
    let previous: any = null; let previousKey: string | null = null; let lastSurvey = -Infinity; let occupied = new Map<string, boolean>();
    for (let i = 0; i <= 20 * fps; i++) {
      const t = i / fps; const amount = amountAt(t);
      const det: DetectionResult = { tMs: 0, hands: [], pose: seatedPose({ side: 'left', kneeLift: amount, abduction: amount, hands: 'thighs', handThighFraction: f }) };
      const limbs = dwellLimbs(det, 'leg', false, aspect);
      const refs = dwellReferences(det, 'leg', { lanes: [{ index: 0, movement: 'seated_march', side: 'left' }], xScale: aspect });
      let busy = false;
      for (const tr of trackers.values()) { const st = tr.state; if (st.progress > 0 || st.blocked === 'refractory') busy = true; }
      for (const l of limbs) coupling.noteOne(l.key, l.point, refs, t, aspect);
      if (!busy) for (const l of limbs) {
        if (engagement.gesture(l.key, l.point, layout.circles(), t, aspect, DWELL_DEFAULTS.exitRatio)) continue;
        habitat.noteOne(l.key, l.point, t, l.scale ?? null);
      }
      const summaries = habitat.all(t, aspect);
      if (t - lastSurvey >= 0.08 - 1e-9) { lastSurvey = t; const s = layout.survey(summaries, t, busy); occupied = s.occupied;
        if (s.moved) { for (const [id, tr] of trackers) tr.setTarget(layout.circleFor(id) as DwellCircle, aspect); log(t.toFixed(2), 'MOVED', JSON.stringify(layout.circles().map(c=>[c.x.toFixed(3),c.y.toFixed(3)]))); } }
      for (const [id, tr] of trackers) tr.setOccupied(occupied.get(id) === true);
      const carried = coupling.coupledKeys(t);
      const limb = pickDwellLimb(limbs, layout.circles(), { xScale: aspect, previous, previousKey, avoid: carried });
      for (const tr of trackers.values()) tr.setCoupled(limb ? carried.has(limb.key) : false);
      previous = limb?.point ?? null; previousKey = limb?.key ?? null;
      const v = limb ? coupling.verdict(limb.key, t) : null;
      if (i % 6 === 0) log(t.toFixed(2), 'amt', amount.toFixed(2), 'limb', limb?.key, JSON.stringify(limb?.point && {x:+limb.point.x.toFixed(3),y:+limb.point.y.toFixed(3)}), 'cpl', v ? `${v.coupled} r2=${v.r2.toFixed(2)} exp=${v.explained.toFixed(3)} n=${v.samples} ref=${v.reference}` : 'none', 'blk', trackers.get('t0')!.state.blocked, 'p', trackers.get('t0')!.state.progress.toFixed(2));
      for (const [id, tr] of trackers) { const st = tr.update(limb?.point ?? null, t, limb?.key ?? null); if (st.confirmed) log(t.toFixed(2), '*** CONFIRM', id, JSON.stringify(tr.circle)); }
    }
    process.stdout.write(lines.join('\n') + '\n');
    expect(1).toBe(1);
  });
});
