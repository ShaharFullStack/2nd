/**
 * KeyboardInput: development input (the documented `?input=keyboard` affordance, so it is used by real
 * people on a real page, not only by tests). Keys 1-4 and D F J K map to lanes 0-3. A key press is a
 * rising edge (event with ctxTime = audioContext.currentTime, strength 1); the lane reads value 1 /
 * armed false while held.
 *
 * THREE THINGS A WINDOW-LEVEL KEY LISTENER MUST GET RIGHT, all of which used to be wrong here:
 *  - A LOST KEYUP. Alt-tab, a focus change, a browser dialog or a screen lock while a key is down means
 *    the keyup never arrives. `held[lane]` then stays true forever and `if (ev.repeat || held[lane])
 *    return;` makes that lane PERMANENTLY DEAD for the rest of the session — every note in it misses and
 *    nothing on screen says why. `blur` and `visibilitychange` therefore release everything: the browser
 *    itself tells us the keyboard is no longer ours.
 *  - TYPING IS NOT PLAYING. The Setup screen has text fields; typing a patient's name containing "d" or
 *    "f" used to fire lanes AND swallow the character with preventDefault(). Key events whose target is
 *    an editable element are ignored.
 *  - MODIFIERS ARE SHORTCUTS. Ctrl+F, Cmd+1 (switch tab) and friends belong to the browser and to the
 *    user, not to lane 1. A keydown carrying Ctrl/Meta/Alt is ignored.
 * KEYUP IS ALWAYS PROCESSED even when those guards would reject it — a release must never be lost, or
 * the stuck-lane bug comes back through the guard that was meant to prevent it.
 */
import type { CtxClock, InputSource, LaneInputEvent, LaneState } from './types.ts';
import { LaneStateCache } from './laneStates.ts';

export interface KeyboardInputConfig {
  /** Number of lanes (default 4). */
  lanes?: number;
  audioContext: CtxClock;
  /** Where to listen for key events (default window). */
  target?: EventTarget;
  /**
   * Where to listen for focus/visibility loss so held keys are released (default: the target's window
   * and document when they exist). Pass explicitly in tests.
   */
  blurTargets?: EventTarget[];
  /** Extra/override key → lane mapping (KeyboardEvent.key, case-insensitive). */
  keyMap?: Record<string, number>;
  /**
   * Ignore key events coming from text fields / contenteditable (default true). The game screen has no
   * inputs, but the Setup screen does and the listener is on window.
   */
  ignoreEditableTargets?: boolean;
}

/** How long a programmatic `press()` holds the lane before releasing itself (seconds, ~a real tap). */
export const DEFAULT_PROGRAMMATIC_HOLD_SEC = 0.08;

export const DEFAULT_KEY_MAP: Readonly<Record<string, number>> = Object.freeze({
  '1': 0, '2': 1, '3': 2, '4': 3,
  d: 0, f: 1, j: 2, k: 3,
});

/** True when a key event came from somewhere the user is typing (so it is text, not gameplay). */
export function isEditableTarget(target: unknown): boolean {
  const el = target as { tagName?: unknown; isContentEditable?: unknown; getAttribute?: (n: string) => string | null } | null;
  if (!el || typeof el.tagName !== 'string') return false;
  if (el.isContentEditable === true) return true;
  const tag = el.tagName.toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  // A custom widget that says it takes text (a combobox, a rich editor) is typing too.
  const role = typeof el.getAttribute === 'function' ? el.getAttribute('role') : null;
  return role === 'textbox' || role === 'searchbox' || role === 'combobox';
}

export class KeyboardInput implements InputSource {
  private readonly laneCount: number;
  private readonly stateCache = new LaneStateCache();
  private readonly clock: CtxClock;
  private readonly target: EventTarget | null;
  private readonly blurTargets: EventTarget[];
  private readonly keyMap: Record<string, number>;
  private readonly ignoreEditable: boolean;
  private listeners = new Set<(e: LaneInputEvent) => void>();
  private held: boolean[];
  /** Pending auto-release timer per lane (see press()); null when the lane has none. */
  private autoRelease: (number | null)[];
  private running = false;
  private onDown = (ev: Event) => this.handleKey(ev as KeyboardEvent, true);
  private onUp = (ev: Event) => this.handleKey(ev as KeyboardEvent, false);
  /** Focus/visibility loss: the keyup for anything held will never arrive, so release it all now. */
  private onLostFocus = () => this.releaseAll();

  constructor(config: KeyboardInputConfig) {
    this.laneCount = config.lanes ?? 4;
    this.clock = config.audioContext;
    this.target = config.target ?? (typeof window !== 'undefined' ? window : null);
    this.keyMap = { ...DEFAULT_KEY_MAP, ...(config.keyMap ?? {}) };
    this.ignoreEditable = config.ignoreEditableTargets ?? true;
    this.held = new Array(this.laneCount).fill(false);
    this.autoRelease = new Array(this.laneCount).fill(null);
    this.blurTargets = config.blurTargets ?? defaultBlurTargets();
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.target?.addEventListener('keydown', this.onDown);
    this.target?.addEventListener('keyup', this.onUp);
    for (const t of this.blurTargets) {
      t.addEventListener('blur', this.onLostFocus);
      t.addEventListener('visibilitychange', this.onLostFocus);
      t.addEventListener('pagehide', this.onLostFocus);
    }
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.target?.removeEventListener('keydown', this.onDown);
    this.target?.removeEventListener('keyup', this.onUp);
    for (const t of this.blurTargets) {
      t.removeEventListener('blur', this.onLostFocus);
      t.removeEventListener('visibilitychange', this.onLostFocus);
      t.removeEventListener('pagehide', this.onLostFocus);
    }
    this.releaseAll();
  }

  onEvent(cb: (e: LaneInputEvent) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /**
   * Live meters. MEMOIZED and frozen, honouring the aliasing contract in src/input/types.ts: the same
   * objects come back until a key actually changes state, so a HUD that bails out on identity does not
   * re-render 60 times a second under `?input=keyboard`. See src/input/laneStates.ts.
   */
  getLaneStates(): LaneState[] {
    return this.stateCache.get(this.laneCount, (lane) => this.held[lane]);
  }

  laneForKey(key: string): number | undefined {
    const lane = this.keyMap[key.length === 1 ? key.toLowerCase() : key];
    return lane !== undefined && lane < this.laneCount ? lane : undefined;
  }

  /**
   * Programmatic press (critics, dev tools, autoplay scripts). Emits immediately at the given ctx time
   * (default now) and AUTO-RELEASES after `holdSec` (default 80 ms, about a real tap).
   *
   * WHY IT AUTO-RELEASES. A press marks the lane held, and `handleKey` rejects every later keydown for a
   * held lane — the very guard this file's header exists to keep from stranding a lane. A caller who
   * pressed without a matching `release()` therefore killed the lane permanently: `getLaneStates()`
   * reported `value: 1, armed: false` forever and every note in it missed in silence. Nothing but a
   * physical keyup used to undo that, and a script has no keyup to give. The timer is cancelled by an
   * explicit `release()` / `releaseAll()` / `stop()`, so pairing press+release still behaves exactly as
   * before; pass `holdSec: 0` for an instantaneous tap that never leaves the lane held at all.
   */
  press(lane: number, ctxTime: number = this.clock.currentTime, strength = 1, opts: { holdSec?: number } = {}): void {
    if (lane < 0 || lane >= this.laneCount) return;
    const hold = opts.holdSec ?? DEFAULT_PROGRAMMATIC_HOLD_SEC;
    this.held[lane] = true;
    this.emit(lane, ctxTime, strength);
    if (!(hold > 0)) {
      this.release(lane);
      return;
    }
    this.clearAutoRelease(lane);
    this.autoRelease[lane] = setTimeout(() => {
      this.autoRelease[lane] = null;
      this.held[lane] = false;
    }, hold * 1000) as unknown as number;
  }

  private emit(lane: number, ctxTime: number, strength: number): void {
    const e: LaneInputEvent = { lane, ctxTime, strength };
    for (const cb of this.listeners) cb(e);
  }

  release(lane: number): void {
    if (lane < 0 || lane >= this.laneCount) return;
    this.clearAutoRelease(lane);
    this.held[lane] = false;
  }

  /** Release every held lane (focus loss, tab hidden, or a caller resetting the session). */
  releaseAll(): void {
    for (let i = 0; i < this.laneCount; i++) this.clearAutoRelease(i);
    this.held.fill(false);
  }

  private clearAutoRelease(lane: number): void {
    const h = this.autoRelease[lane];
    if (h !== null && h !== undefined) clearTimeout(h);
    this.autoRelease[lane] = null;
  }

  /** True while the lane is held down (a lane stuck true would be unable to fire again). */
  isHeld(lane: number): boolean {
    return this.held[lane] === true;
  }

  private handleKey(ev: KeyboardEvent, down: boolean): void {
    if (!this.running) return;
    const lane = this.laneForKey(ev.key ?? '');
    if (lane === undefined) return;
    if (!down) {
      // A RELEASE IS NEVER FILTERED. If a guard below rejected the matching keydown the lane is not held
      // and this is a no-op; if it did not, dropping the keyup would strand the lane forever.
      this.release(lane);
      return;
    }
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return; // Ctrl+F / Cmd+1 belong to the browser
    if (this.ignoreEditable && isEditableTarget(ev.target)) return; // the patient is typing, not playing
    if (ev.repeat || this.held[lane]) return;
    ev.preventDefault?.();
    // No auto-release on a REAL key: the matching keyup (or the blur/visibility fallback) is what ends
    // it, and a timer would report the lane free while the finger is still down.
    this.clearAutoRelease(lane);
    this.held[lane] = true;
    this.emit(lane, this.clock.currentTime, 1);
  }
}

function defaultBlurTargets(): EventTarget[] {
  const out: EventTarget[] = [];
  if (typeof window !== 'undefined') out.push(window);
  if (typeof document !== 'undefined') out.push(document);
  return out;
}
