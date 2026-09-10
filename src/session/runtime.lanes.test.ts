/**
 * How the prescription reaches the camera pipeline: the therapist's fingertip choice must become the
 * lane's featureOptions, and must be part of the pipeline's identity so changing it REBUILDS rather
 * than re-points a live pipeline.
 *
 * Re-pointing is not a cosmetic bug: VisionInput refuses a pipeline whose fingertip disagrees with
 * the session's, and a range measured on the index normalises a pinky pinch to a number that never
 * reaches the hit threshold — a lane that misses every note all song with nothing to explain it.
 */
import { describe, expect, it } from 'vitest';
import type { LaneSpec } from '../engine/types.ts';
import { laneFeatureOptions, visionLaneKey } from './runtime.ts';

const pinch = (side: LaneSpec['side'], fingertip?: LaneSpec['fingertip']): LaneSpec => ({
  index: 0, movement: 'finger_opposition', side, fingertip,
});

describe('laneFeatureOptions', () => {
  it('passes the fingertip through for finger_opposition, and nothing for anything else', () => {
    const lanes: LaneSpec[] = [
      { index: 0, movement: 'hand_open_close', side: 'left' },
      { ...pinch('right', 'pinky'), index: 1 },
    ];
    expect(laneFeatureOptions(lanes)).toEqual([undefined, { fingertip: 'pinky' }]);
  });

  it('supplies the default tip when the lane carries none, so the extractor is never guessing', () => {
    expect(laneFeatureOptions([pinch('left')])).toEqual([{ fingertip: 'index' }]);
  });
});

describe('visionLaneKey', () => {
  const req = (lanes: LaneSpec[]) => ({ mode: 'hand' as const, mirrored: false, lanes });

  it('changes when the fingertip changes — the pipeline must be rebuilt, not re-pointed', () => {
    expect(visionLaneKey(req([pinch('left', 'index')]))).not.toBe(visionLaneKey(req([pinch('left', 'pinky')])));
  });

  it('treats an absent tip as the default, so a re-render does not churn the camera', () => {
    expect(visionLaneKey(req([pinch('left')]))).toBe(visionLaneKey(req([pinch('left', 'index')])));
  });

  it('still separates side, movement and mirror convention', () => {
    const a = visionLaneKey(req([pinch('left', 'index')]));
    expect(a).not.toBe(visionLaneKey(req([pinch('right', 'index')])));
    expect(a).not.toBe(visionLaneKey({ mode: 'hand', mirrored: true, lanes: [pinch('left', 'index')] }));
  });

  it('carries no fingertip segment for movements that have none', () => {
    expect(visionLaneKey({ mode: 'leg', mirrored: false, lanes: [{ index: 0, movement: 'seated_march', side: 'left' }] })).toBe(
      'leg|false|seated_march:left',
    );
  });
});
