import { describe, expect, it } from 'vitest';
import {
  DWELL_CLEAR_EXTRA, DWELL_DEFAULTS, DwellCoupling, DwellEngagement, DwellHabitat, DwellLayout, DwellTracker,
  dwellAxisFor, dwellLimbs, dwellReferences, dwellTargetClear, pickDwellLimb,
} from '../vision/dwell.ts';
import type { DwellCircle } from '../vision/dwell.ts';
import { dwellCircleFits, PREVIEW_ASPECT } from '../ui/DwellTarget.tsx';
import { SEATED_HAND_RESTS, handPose, reNormalizeAspect, seatedPose, translateLandmarks } from '../vision/fixtures.ts';
import type { SeatedHandRest } from '../vision/fixtures.ts';
import type { DetectionResult } from '../vision/mediapipe.ts';
import type { Mode } from '../engine/types.ts';

const out: string[] = [];
const log = (...a: unknown[]) => out.push(a.map(String).join(' '));

function drive(o: { mode: Mode; aspect: number; authored: DwellCircle[]; seconds: number; frame: (t: number) => DetectionResult; fps?: number; reach?: number }) {
  const fps = o.fps ?? 30;
  const ids = o.authored.map((_, i) => `t${i}`);
  const habitat = new DwellHabitat(); const coupling = new DwellCoupling(); const engagement = new DwellEngagement();
  const clearOpts = { xScale: o.aspect, axis: dwellAxisFor(o.mode), exitRatio: DWELL_DEFAULTS.exitRatio, extra: DWELL_CLEAR_EXTRA, reach: o.reach, fits: (c: DwellCircle) => dwellCircleFits(c, o.aspect) };
  const layout = new DwellLayout(o.authored.map((c, i) => ({ id: ids[i], authored: c })), clearOpts);
  const trackers = new Map(ids.map((id) => [id, new DwellTracker(layout.circleFor(id) as DwellCircle, { xScale: o.aspect })]));
  let previous: any = null; let previousKey: string | null = null; let lastSurvey = -Infinity;
  let occupied = new Map<string, boolean>(); let confirms = 0; let unplaceable = false;
  let summaries = habitat.all(0, o.aspect);
  for (let i = 0; i <= Math.round(o.seconds * fps); i++) {
    const t = i / fps; const det = o.frame(t);
    const limbs = dwellLimbs(det, o.mode, false, o.aspect);
    const refs = dwellReferences(det, o.mode, { xScale: o.aspect });
    let busy = false;
    for (const tr of trackers.values()) { const st = tr.state; if (st.progress > 0 || st.blocked === 'refractory') busy = true; }
    if (!busy) for (const l of limbs) {
      if (dwellAxisFor(o.mode) === 'radial' && engagement.gesture(l.key, l.point, layout.circles(), t, o.aspect, DWELL_DEFAULTS.exitRatio)) continue;
      habitat.noteOne(l.key, l.point, t, l.scale ?? null); coupling.noteOne(l.key, l.point, refs, t, o.aspect);
    }
    summaries = habitat.all(t, o.aspect);
    if (t - lastSurvey >= 0.08 - 1e-9) { lastSurvey = t; const s = layout.survey(summaries, t, busy); occupied = s.occupied;
      unplaceable = [...s.placeable.values()].some((ok) => !ok);
      if (s.moved) for (const [id, tr] of trackers) tr.setTarget(layout.circleFor(id) as DwellCircle, o.aspect); }
    for (const [id, tr] of trackers) tr.setOccupied(occupied.get(id) === true);
    const carried = coupling.coupledKeys(t);
    const limb = pickDwellLimb(limbs, layout.circles(), { xScale: o.aspect, previous, previousKey, avoid: carried });
    for (const tr of trackers.values()) tr.setCoupled(limb ? carried.has(limb.key) : false);
    previous = limb?.point ?? null; previousKey = limb?.key ?? null;
    for (const tr of trackers.values()) { const st = tr.update(limb?.point ?? null, t, limb?.key ?? null); if (st.confirmed) confirms++; }
  }
  const finalClear = layout.circles().map((c) => dwellTargetClear(c, summaries, clearOpts).clear);
  return { confirms, finalClear, unplaceable, circles: layout.circles() };
}

const legFrame = (rest: SeatedHandRest, aspect: number, dx = 0, dy = 0): DetectionResult => ({
  tMs: 0, hands: [],
  pose: reNormalizeAspect(translateLandmarks(seatedPose({ side: 'left', kneeLift: 0, hands: rest }), dx, dy), PREVIEW_ASPECT, aspect),
});
const handFrame = (centerX: number, scale: number, dy: number, aspect: number): DetectionResult => ({
  tMs: 0, pose: null,
  hands: [{ landmarks: reNormalizeAspect(translateLandmarks(handPose({ openness: 1, centerX, scale }), 0, dy), PREVIEW_ASPECT, aspect), label: 'Left', score: 0.95 }],
});

describe('size', () => {
  it('sweeps', () => {
    for (const [pr, sr, legX, handX, hpr, hsr, reach, legY] of [
      [0.15, 0.105, 0.78, 0.75, 0.13, 0.105, 0.6, 0.23],
      [0.16, 0.105, 0.78, 0.75, 0.13, 0.105, 0.6, 0.22],
    ] as number[][]) {
      let usable = 0; let cases = 0; let confirms = 0; const bad: string[] = [];
      for (const aspect of [1, 4 / 3, 16 / 9]) {
        for (const rest of ['lap', 'thighs', 'chair_arms', 'folded'] as SeatedHandRest[]) {
          for (const dx of [-0.06, 0, 0.06]) for (const dy of [-0.06, 0, 0.06]) {
            const r = drive({ mode: 'leg', aspect, seconds: 8, authored: [{ x: legX, y: legY, radius: pr }, { x: 1 - legX + 0.0, y: legY, radius: sr }], frame: () => legFrame(rest, aspect, dx, dy), reach });
            cases++; confirms += r.confirms;
            if (r.finalClear.every(Boolean)) usable++; else bad.push(`leg a${aspect.toFixed(2)} ${rest} (${dx},${dy}) clear=${r.finalClear} unplaceable=${r.unplaceable} ${JSON.stringify(r.circles.map((c) => [c.x.toFixed(2), c.y.toFixed(2)]))}`);
          }
        }
        for (const scale of [0.8, 1, 1.3, 1.6]) for (const centerX of [0.35, 0.5, 0.65, 0.72]) for (const dy of [-0.15, -0.1, 0, 0.1]) {
          const r = drive({ mode: 'hand', aspect, seconds: 8, authored: [{ x: handX, y: 0.37, radius: hpr }, { x: 1 - handX, y: 0.37, radius: hsr }], frame: () => handFrame(centerX, scale, dy, aspect), reach });
          cases++; confirms += r.confirms;
          if (r.finalClear.every(Boolean)) usable++; else bad.push(`hand a${aspect.toFixed(2)} s${scale} x${centerX} dy${dy} clear=${r.finalClear} unplaceable=${r.unplaceable}`);
        }
      }
      log(`leg ${pr}/${sr} @${legX},${legY} hand ${hpr}/${hsr} @${handX} reach ${reach}: usable ${(usable / cases * 100).toFixed(0)}% (${usable}/${cases}) confirms ${confirms}`);
      for (const b of bad.slice(0, 6)) log('   ', b);
    }
    process.stdout.write(out.join('\n') + '\n');
    expect(1).toBe(1);
  }, 240_000);
});
