/**
 * ReplayInput: plays a scripted list of lane events at song times (critics / tests).
 * Events are emitted when the song clock passes their time; ctxTime is the exact ctx time of the
 * song time (via songClock.ctxTimeForSongTime), so judgment is independent of polling jitter.
 *
 * THE "EXACT CTX TIME" GUARANTEE AND ITS ONE PRECONDITION. `ctxTime` is always the exact ctx time of the
 * scripted song time, whenever it is emitted — but for the ENGINE to judge it as scripted, the event has
 * to be delivered while that time is still inside the judgment window. tick() flushes every event whose
 * song time has already passed, so if the replay starts mid-song, or one tick is delayed by a GC pause
 * or a slow frame, several events can arrive at once carrying ctxTimes in the past.
 * Two ways to keep the guarantee, both explicit rather than hoped for:
 *   - `dropStaleSec`: events already older than this when the tick runs are SKIPPED instead of dumped
 *     late (they surface in `skipped()`), so a stall cannot silently rewrite the scripted timing;
 *   - `seek(songTime)`: advance the cursor past everything before a point WITHOUT emitting it, which is
 *     what a critic starting mid-song wants.
 * The default is unchanged (flush everything, drop nothing) so existing replays behave identically.
 */
import type { CtxClock, InputSource, LaneInputEvent, LaneState, SongTimeSource } from './types.ts';
import { LaneStateCache } from './laneStates.ts';

export interface ReplayEvent {
  lane: number;
  /** Song time (seconds) at which the movement crossed the threshold. */
  songTime: number;
  strength?: number;
}

export interface ReplayInputConfig {
  events: ReplayEvent[];
  audioContext: CtxClock;
  songClock: SongTimeSource;
  lanes?: number;
  /** Poll automatically with setInterval (default true). false = call tick() yourself. */
  autoTick?: boolean;
  /** Poll interval in ms (default 4; browsers clamp timers to >= 4 ms, so this is the finest practical rate). */
  tickMs?: number;
  /** How long a lane reads "value 1" after an event, seconds (default 0.12). */
  holdSec?: number;
  /**
   * Skip events already more than this many SONG seconds old when a tick finds them (default Infinity =
   * never skip, the historical behaviour). Set it to the difficulty's good window to make a stalled or
   * late-started replay drop its backlog instead of emitting a burst of events dated in the past.
   */
  dropStaleSec?: number;
}

export class ReplayInput implements InputSource {
  private readonly events: ReplayEvent[];
  private readonly clock: CtxClock;
  private readonly songClock: SongTimeSource;
  private readonly laneCount: number;
  private readonly stateCache = new LaneStateCache();
  private readonly autoTick: boolean;
  private readonly tickMs: number;
  private readonly holdSec: number;
  private listeners = new Set<(e: LaneInputEvent) => void>();
  private cursor = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastHit: number[];
  private running = false;
  private readonly dropStaleSec: number;
  private skippedCount = 0;

  constructor(config: ReplayInputConfig) {
    this.events = config.events.slice().sort((a, b) => a.songTime - b.songTime);
    this.clock = config.audioContext;
    this.songClock = config.songClock;
    this.laneCount = config.lanes ?? Math.max(4, ...this.events.map((e) => e.lane + 1));
    this.autoTick = config.autoTick ?? true;
    this.tickMs = config.tickMs ?? 4;
    this.holdSec = config.holdSec ?? 0.12;
    this.dropStaleSec = config.dropStaleSec ?? Infinity;
    this.lastHit = new Array(this.laneCount).fill(-Infinity);
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    if (this.autoTick) this.timer = setInterval(() => this.tick(), this.tickMs);
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** Rewind to the beginning (events will replay). */
  reset(): void {
    this.cursor = 0;
    this.skippedCount = 0;
    this.lastHit.fill(-Infinity);
  }

  /**
   * Drop every scripted event before `songTime` WITHOUT emitting it, and return how many were dropped.
   * A critic that starts the song at 60 s calls this instead of letting the first tick dump a minute of
   * events dated in the past. Not counted as `skipped()` — this is a deliberate seek, not a lost event.
   */
  seek(songTime: number): number {
    let dropped = 0;
    while (this.cursor < this.events.length && this.events[this.cursor].songTime < songTime) {
      this.cursor++;
      dropped++;
    }
    return dropped;
  }

  /** Events skipped for being too old when their tick ran (see `dropStaleSec`). */
  skipped(): number {
    return this.skippedCount;
  }

  onEvent(cb: (e: LaneInputEvent) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /**
   * Live meters. MEMOIZED and frozen, honouring the aliasing contract in src/input/types.ts: the same
   * objects come back for as long as the set of lit lanes is unchanged, so a HUD that bails out on
   * identity does not re-render on every poll under `?autoplay=1`. See src/input/laneStates.ts.
   */
  getLaneStates(): LaneState[] {
    const now = this.clock.currentTime;
    return this.stateCache.get(this.laneCount, (lane) => now - this.lastHit[lane] < this.holdSec);
  }

  /** Remaining (not yet emitted) events. */
  pending(): number {
    return this.events.length - this.cursor;
  }

  /** Emit every event whose song time has been reached. Returns the emitted events. */
  tick(nowCtx: number = this.clock.currentTime): LaneInputEvent[] {
    if (!this.running) return [];
    const songNow = this.songClock.songTime(nowCtx);
    const out: LaneInputEvent[] = [];
    while (this.cursor < this.events.length && this.events[this.cursor].songTime <= songNow) {
      const ev = this.events[this.cursor++];
      // Too late to be the event that was scripted: emitting it now would hand the engine a ctxTime from
      // the past and call the result a replay of this script. Count it and move on.
      if (songNow - ev.songTime > this.dropStaleSec) {
        this.skippedCount++;
        continue;
      }
      const e: LaneInputEvent = { lane: ev.lane, ctxTime: this.songClock.ctxTimeForSongTime(ev.songTime), strength: ev.strength ?? 1 };
      if (ev.lane >= 0 && ev.lane < this.laneCount) this.lastHit[ev.lane] = e.ctxTime;
      out.push(e);
      for (const cb of this.listeners) cb(e);
    }
    return out;
  }
}
