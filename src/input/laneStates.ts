/**
 * Shared LaneState memoization for the SCRIPTED input sources (keyboard, replay, autoplay).
 *
 * WHY THIS EXISTS. `InputSource.getLaneStates()` (src/input/types.ts) documents an aliasing contract:
 * the array and its LaneState objects are owned by the source and may be the SAME objects on every call,
 * so a HUD polling at 60 Hz on a 30 fps input does not re-render on unchanged data. VisionInput has
 * always honoured it. KeyboardInput and ReplayInput used to allocate a fresh array of fresh objects on
 * every call, so a HUD written against VisionInput's behaviour (`prev === next` bail-outs, React
 * `useSyncExternalStore`, a memo keyed on the object identity) re-rendered on EVERY poll under
 * `?input=keyboard` and `?autoplay=1` — precisely the two configurations the dev screenshots and the
 * critic harness run in, so the regression would show up only where nobody was looking for it.
 *
 * The lanes of a scripted source are binary (held / not held), so the whole state is one bitmask: when
 * the mask is unchanged the previous frozen array is returned unchanged, and identity comparison works.
 */
import type { LaneState } from './types.ts';

/** Lane count above which the bitmask no longer fits a 32-bit int and the cache rebuilds every call. */
const MAX_MASKABLE_LANES = 30;

export class LaneStateCache {
  private states: LaneState[] | null = null;
  private mask = -1;
  private count = -1;

  /**
   * The lanes' states, reusing the previous objects when nothing changed.
   * `active(lane)` reports whether that lane is currently held/hit (value 1, not armed).
   */
  get(laneCount: number, active: (lane: number) => boolean): LaneState[] {
    if (laneCount > MAX_MASKABLE_LANES) return build(laneCount, active);
    let mask = 0;
    for (let i = 0; i < laneCount; i++) if (active(i)) mask |= 1 << i;
    if (this.states && this.mask === mask && this.count === laneCount) return this.states;
    this.states = build(laneCount, (lane) => (mask & (1 << lane)) !== 0);
    this.mask = mask;
    this.count = laneCount;
    return this.states;
  }
}

function build(laneCount: number, active: (lane: number) => boolean): LaneState[] {
  const out: LaneState[] = new Array(laneCount);
  for (let lane = 0; lane < laneCount; lane++) {
    const on = active(lane);
    // Frozen like VisionInput's: a consumer that mutates a shared meter must throw, not corrupt it.
    out[lane] = Object.freeze({ lane, value: on ? 1 : 0, armed: !on, tracking: true }) as LaneState;
  }
  return Object.freeze(out) as LaneState[];
}
