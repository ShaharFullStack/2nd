/**
 * ReplayInput: plays a scripted list of lane events at song times (critics / tests).
 * Events are emitted when the song clock passes their time; ctxTime is the exact ctx time of the
 * song time (via songClock.ctxTimeForSongTime), so judgment is independent of polling jitter.
 */
import type { CtxClock, InputSource, LaneInputEvent, LaneState, SongTimeSource } from './types.ts';

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
}

export class ReplayInput implements InputSource {
  private readonly events: ReplayEvent[];
  private readonly clock: CtxClock;
  private readonly songClock: SongTimeSource;
  private readonly laneCount: number;
  private readonly autoTick: boolean;
  private readonly tickMs: number;
  private readonly holdSec: number;
  private listeners = new Set<(e: LaneInputEvent) => void>();
  private cursor = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastHit: number[];
  private running = false;

  constructor(config: ReplayInputConfig) {
    this.events = config.events.slice().sort((a, b) => a.songTime - b.songTime);
    this.clock = config.audioContext;
    this.songClock = config.songClock;
    this.laneCount = config.lanes ?? Math.max(4, ...this.events.map((e) => e.lane + 1));
    this.autoTick = config.autoTick ?? true;
    this.tickMs = config.tickMs ?? 4;
    this.holdSec = config.holdSec ?? 0.12;
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
    this.lastHit.fill(-Infinity);
  }

  onEvent(cb: (e: LaneInputEvent) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  getLaneStates(): LaneState[] {
    const now = this.clock.currentTime;
    return this.lastHit.map((t, lane) => {
      const active = now - t < this.holdSec;
      return { lane, value: active ? 1 : 0, armed: !active, tracking: true };
    });
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
      const e: LaneInputEvent = { lane: ev.lane, ctxTime: this.songClock.ctxTimeForSongTime(ev.songTime), strength: ev.strength ?? 1 };
      if (ev.lane >= 0 && ev.lane < this.laneCount) this.lastHit[ev.lane] = e.ctxTime;
      out.push(e);
      for (const cb of this.listeners) cb(e);
    }
    return out;
  }
}
