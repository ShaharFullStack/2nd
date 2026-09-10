/**
 * URL affordances and the `window.__beatRehab` debug handle.
 *
 *   ?input=keyboard   keys 1-4 / D F J K drive the lanes; camera screens are skipped
 *   ?input=autoplay   a bot plays the chart (screenshots, critics); camera screens are skipped
 *   ?autoplay=1       alias of the above (docs/ARCHITECTURE.md)
 *   ?demo=highway     mounts the standalone renderer demo instead of the app
 *   ?song=<id> ?difficulty=easy|medium|hard ?mode=leg|hand ?seed=<n> ?scale=<n>
 *   ?lanes=seated_march:left,knee_extension:right
 *   ?lanes=finger_opposition:left:pinky   (third segment = fingertip, finger_opposition only)
 */
import { DIFFICULTIES } from '../engine/difficulty.ts';
import type { DifficultyName, Fingertip, LaneSpec, Mode, Movement, Side } from '../engine/types.ts';
import { FINGERTIPS, HAND_MOVEMENTS, LEG_MOVEMENTS } from '../engine/types.ts';
import { movementMode } from '../vision/features.ts';
import { normalizeLanes, useStore } from '../state/store.ts';
import type { Screen } from '../state/store.ts';
import type { InputMode } from './types.ts';
import { runtime } from './runtime.ts';

function parseLanes(value: string): LaneSpec[] {
  const specs: LaneSpec[] = [];
  for (const part of value.split(',')) {
    const [movementRaw, sideRaw, tipRaw] = part.split(':');
    const movement = movementRaw?.trim() as Movement;
    if (!movement) continue;
    const known = [...LEG_MOVEMENTS, ...HAND_MOVEMENTS] as Movement[];
    if (!known.includes(movement)) continue;
    const side: Side = sideRaw?.trim() === 'right' ? 'right' : 'left';
    const tip = tipRaw?.trim() as Fingertip | undefined;
    // `normalizeLanes` drops a fingertip the movement cannot carry and defaults the one it can.
    specs.push({ index: specs.length, movement, side, ...(tip && FINGERTIPS.includes(tip) ? { fingertip: tip } : {}) });
  }
  return normalizeLanes(specs.slice(0, 4));
}

/** Apply URL parameters to the store. Returns the input mode actually in force. */
export function applyUrlParams(search: string): InputMode {
  const params = new URLSearchParams(search);
  const store = useStore.getState();

  const inputParam = params.get('input');
  let inputMode: InputMode = 'camera';
  if (inputParam === 'keyboard' || inputParam === 'autoplay') inputMode = inputParam;
  else if (params.get('autoplay') === '1') inputMode = 'autoplay';
  store.setInputMode(inputMode);

  const modeParam = params.get('mode');
  if (modeParam === 'leg' || modeParam === 'hand') store.setMode(modeParam as Mode);

  const lanesParam = params.get('lanes');
  if (lanesParam) {
    const lanes = parseLanes(lanesParam);
    if (lanes.length >= 2) {
      // A lane list also decides the mode — a hand movement cannot run in a leg session.
      store.setMode(movementMode(lanes[0].movement));
      store.setLanes(normalizeLanes(lanes));
    }
  }

  const difficulty = params.get('difficulty');
  if (difficulty && Object.prototype.hasOwnProperty.call(DIFFICULTIES, difficulty)) {
    store.setDifficulty(difficulty as DifficultyName);
  }

  const song = params.get('song');
  if (song) store.setSong(song);

  const seed = Number(params.get('seed'));
  if (Number.isFinite(seed) && seed > 0) store.setSeed(Math.floor(seed));

  const scale = Number(params.get('scale'));
  if (Number.isFinite(scale) && scale > 0) store.setWindowScale(scale);

  const screen = params.get('screen');
  if (screen) store.goto(screen as Screen);

  return inputMode;
}

export interface StartPlayOptions {
  mode?: Mode;
  lanes?: LaneSpec[];
  difficulty?: DifficultyName;
  songId?: string;
  seed?: number;
  windowScale?: number;
  inputMode?: InputMode;
}

/** Jump straight into a session with the given prescription (critics / dev console). */
export function startPlayNow(opts: StartPlayOptions = {}): void {
  const store = useStore.getState();
  if (opts.inputMode) store.setInputMode(opts.inputMode);
  if (opts.mode) store.setMode(opts.mode);
  if (opts.lanes && opts.lanes.length >= 2) store.setLanes(normalizeLanes(opts.lanes));
  if (opts.difficulty) store.setDifficulty(opts.difficulty);
  if (opts.songId) store.setSong(opts.songId);
  if (opts.seed !== undefined) store.setSeed(opts.seed);
  if (opts.windowScale !== undefined) store.setWindowScale(opts.windowScale);
  store.goto('play');
}

export interface BeatRehabHandle {
  version: string;
  store: typeof useStore;
  runtime: typeof runtime;
  gotoScreen: (screen: Screen) => void;
  startPlayNow: (opts?: StartPlayOptions) => void;
  /** The live game loop while a session is running (null otherwise). */
  getRunner: () => typeof runtime.runner;
  /** Score snapshot without reaching into the engine. */
  getScore: () => ReturnType<NonNullable<typeof runtime.runner>['hud']> | null;
  getState: () => ReturnType<typeof useStore.getState>;
}

/** Install the debug handle used by the playwright critics. Safe to call more than once. */
export function installDebugHandle(): BeatRehabHandle {
  const handle: BeatRehabHandle = {
    version: '1.0.0',
    store: useStore,
    runtime,
    gotoScreen: (screen) => useStore.getState().goto(screen),
    startPlayNow,
    getRunner: () => runtime.runner,
    getScore: () => runtime.runner?.hud() ?? null,
    getState: () => useStore.getState(),
  };
  (globalThis as unknown as { __beatRehab?: BeatRehabHandle }).__beatRehab = handle;
  return handle;
}
