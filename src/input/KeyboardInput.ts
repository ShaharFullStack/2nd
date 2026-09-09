/**
 * KeyboardInput: development input. Keys 1-4 and D F J K map to lanes 0-3.
 * A key press is a rising edge (event with ctxTime = audioContext.currentTime, strength 1);
 * the lane reads value 1 / armed false while held.
 */
import type { CtxClock, InputSource, LaneInputEvent, LaneState } from './types.ts';

export interface KeyboardInputConfig {
  /** Number of lanes (default 4). */
  lanes?: number;
  audioContext: CtxClock;
  /** Where to listen for key events (default window). */
  target?: EventTarget;
  /** Extra/override key → lane mapping (KeyboardEvent.key, case-insensitive). */
  keyMap?: Record<string, number>;
}

export const DEFAULT_KEY_MAP: Readonly<Record<string, number>> = Object.freeze({
  '1': 0, '2': 1, '3': 2, '4': 3,
  d: 0, f: 1, j: 2, k: 3,
});

export class KeyboardInput implements InputSource {
  private readonly laneCount: number;
  private readonly clock: CtxClock;
  private readonly target: EventTarget | null;
  private readonly keyMap: Record<string, number>;
  private listeners = new Set<(e: LaneInputEvent) => void>();
  private held: boolean[];
  private running = false;
  private onDown = (ev: Event) => this.handleKey(ev as KeyboardEvent, true);
  private onUp = (ev: Event) => this.handleKey(ev as KeyboardEvent, false);

  constructor(config: KeyboardInputConfig) {
    this.laneCount = config.lanes ?? 4;
    this.clock = config.audioContext;
    this.target = config.target ?? (typeof window !== 'undefined' ? window : null);
    this.keyMap = { ...DEFAULT_KEY_MAP, ...(config.keyMap ?? {}) };
    this.held = new Array(this.laneCount).fill(false);
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.target?.addEventListener('keydown', this.onDown);
    this.target?.addEventListener('keyup', this.onUp);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.target?.removeEventListener('keydown', this.onDown);
    this.target?.removeEventListener('keyup', this.onUp);
    this.held.fill(false);
  }

  onEvent(cb: (e: LaneInputEvent) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  getLaneStates(): LaneState[] {
    return this.held.map((h, lane) => ({ lane, value: h ? 1 : 0, armed: !h, tracking: true }));
  }

  laneForKey(key: string): number | undefined {
    const lane = this.keyMap[key.length === 1 ? key.toLowerCase() : key];
    return lane !== undefined && lane < this.laneCount ? lane : undefined;
  }

  /** Programmatic press (critics / tests). Emits immediately at the given ctx time (default now). */
  press(lane: number, ctxTime: number = this.clock.currentTime, strength = 1): void {
    if (lane < 0 || lane >= this.laneCount) return;
    this.held[lane] = true;
    const e: LaneInputEvent = { lane, ctxTime, strength };
    for (const cb of this.listeners) cb(e);
  }

  release(lane: number): void {
    if (lane >= 0 && lane < this.laneCount) this.held[lane] = false;
  }

  private handleKey(ev: KeyboardEvent, down: boolean): void {
    if (!this.running) return;
    const lane = this.laneForKey(ev.key ?? '');
    if (lane === undefined) return;
    if (down) {
      if (ev.repeat || this.held[lane]) return;
      ev.preventDefault?.();
      this.press(lane);
    } else this.release(lane);
  }
}
