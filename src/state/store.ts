/**
 * The app store: everything the screens share that is plain data.
 *
 * Live handles (AudioContext, StemMixer, VisionInput, the game loop) deliberately do NOT live here —
 * they are in src/session/runtime.ts. React never re-renders per frame in this app, and a store that
 * held a mixer would tempt exactly that.
 */
import { create } from 'zustand';
import { DIFFICULTIES, clampWindowScale } from '../engine/difficulty.ts';
import type { DifficultyName, Fingertip, LaneSpec, Mode, Movement, Side } from '../engine/types.ts';
import { FINGERTIPS, HAND_MOVEMENTS, LEG_MOVEMENTS } from '../engine/types.ts';
import type { RomCalibration } from '../vision/calibration.ts';
import type { InputMode, SessionConfig, SessionResult } from '../session/types.ts';
import { readJson, writeJson } from './persist.ts';

export type Screen =
  | 'home'
  | 'mode'
  | 'setup'
  | 'camera'
  | 'rom'
  | 'latency'
  | 'play'
  | 'results'
  | 'history';

export interface Settings {
  /** Hit / miss sound cues on top of the music. */
  sfx: boolean;
  /** Rehab-friendly high-contrast lane colors instead of the Guitar Hero palette. */
  highContrast: boolean;
  /** Seconds a note takes to travel the highway (lower = faster scroll). */
  scrollSec: number;
  /** Freeze parallax/shake for vestibular sensitivity. */
  reducedMotion: boolean;
  /** Decorative effect intensity 0..1 (judgment feedback is never removed). */
  effectIntensity: number;
  /** Show a MISS popup (off by default for the rehab audience). */
  showMissPopup: boolean;
  /** Frames are horizontally flipped before detection (changes which limb a lane reads). */
  mirrored: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  sfx: true,
  highContrast: false,
  scrollSec: 1.6,
  reducedMotion: false,
  effectIntensity: 1,
  showMissPopup: false,
  mirrored: false,
};

export const MIN_LANES = 2;
export const MAX_LANES = 4;
export const DEFAULT_SONG_ID = 'demo-groove';

const HISTORY_KEY = 'history';
const SETTINGS_KEY = 'settings';
const LATENCY_KEY = 'latency';
const CONFIG_KEY = 'lastConfig';
const CALIBRATION_KEY = 'calibrations';

/** Default input latency offered when the patient skips latency calibration (seconds). */
export const DEFAULT_LATENCY_SEC = 0.12;

export function defaultLanes(mode: Mode): LaneSpec[] {
  const m: Movement = mode === 'leg' ? 'seated_march' : 'hand_open_close';
  return [
    { index: 0, movement: m, side: 'left' },
    { index: 1, movement: m, side: 'right' },
  ];
}

export function movementsFor(mode: Mode): Movement[] {
  return mode === 'leg' ? [...LEG_MOVEMENTS] : [...HAND_MOVEMENTS];
}

/** Renumber `index` to the array position — every lane-indexed API in the app relies on it. */
export function normalizeLanes(lanes: LaneSpec[]): LaneSpec[] {
  return lanes.map((l, i) => normalizeLaneFingertip(l.index === i ? l : { ...l, index: i }));
}

/** The fingertip a finger_opposition lane opposes when the therapist has not chosen one. */
export const DEFAULT_LANE_FINGERTIP: Fingertip = 'index';

/**
 * The fingertip lane `spec` is actually measured on: the therapist's choice for finger_opposition,
 * and undefined for every other movement (which has no fingertip dimension at all).
 */
export function laneFingertip(spec: Pick<LaneSpec, 'movement' | 'fingertip'>): Fingertip | undefined {
  if (spec.movement !== 'finger_opposition') return undefined;
  return spec.fingertip && FINGERTIPS.includes(spec.fingertip) ? spec.fingertip : DEFAULT_LANE_FINGERTIP;
}

/**
 * Drop a fingertip a movement cannot carry, and give finger_opposition the default when it has none.
 * Applied on every write so a lane switched away from finger_opposition and back does not resurrect
 * the old tip, and so the calibration key of a lane never depends on a stale field.
 */
export function normalizeLaneFingertip(spec: LaneSpec): LaneSpec {
  const tip = laneFingertip(spec);
  if (tip === spec.fingertip) return spec;
  if (tip === undefined) {
    const { fingertip: _drop, ...rest } = spec;
    return rest;
  }
  return { ...spec, fingertip: tip };
}

/**
 * Calibrations are keyed by movement+side (+fingertip, for finger_opposition) so a second session on
 * the same lane can reuse them.
 *
 * The fingertip is part of the key because it selects WHICH QUANTITY was measured: the feature is
 * `1 - tip-to-thumb distance / palm size` for that one tip, and a hand that pinches its index to the
 * thumb reaches ~1.0 while the same hand's pinky peaks well below the index range's max. Keying them
 * together would hand a pinky lane the index range and produce a lane that cannot score all song.
 */
export function calibrationKey(spec: Pick<LaneSpec, 'movement' | 'side' | 'fingertip'>): string {
  const tip = laneFingertip(spec);
  return tip ? `${spec.movement}:${spec.side}:${tip}` : `${spec.movement}:${spec.side}`;
}

function isLaneSpec(v: unknown): v is LaneSpec {
  const l = v as LaneSpec | null;
  if (!(!!l && typeof l.index === 'number' && typeof l.movement === 'string' && (l.side === 'left' || l.side === 'right'))) return false;
  return l.fingertip === undefined || FINGERTIPS.includes(l.fingertip);
}

function validateSettings(raw: unknown): Settings | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<Settings>;
  return {
    sfx: typeof r.sfx === 'boolean' ? r.sfx : DEFAULT_SETTINGS.sfx,
    highContrast: typeof r.highContrast === 'boolean' ? r.highContrast : DEFAULT_SETTINGS.highContrast,
    scrollSec: Number.isFinite(r.scrollSec) ? Math.min(3, Math.max(0.8, r.scrollSec as number)) : DEFAULT_SETTINGS.scrollSec,
    reducedMotion: typeof r.reducedMotion === 'boolean' ? r.reducedMotion : DEFAULT_SETTINGS.reducedMotion,
    effectIntensity: Number.isFinite(r.effectIntensity) ? Math.min(1, Math.max(0, r.effectIntensity as number)) : DEFAULT_SETTINGS.effectIntensity,
    showMissPopup: typeof r.showMissPopup === 'boolean' ? r.showMissPopup : DEFAULT_SETTINGS.showMissPopup,
    mirrored: typeof r.mirrored === 'boolean' ? r.mirrored : DEFAULT_SETTINGS.mirrored,
  };
}

function validateHistory(raw: unknown): SessionResult[] | null {
  if (!Array.isArray(raw)) return null;
  const ok = raw.filter((r) => {
    const v = r as Partial<SessionResult> | null;
    return !!v && typeof v.id === 'string' && typeof v.score === 'number' && Array.isArray(v.lanes);
  }) as SessionResult[];
  return ok;
}

function validateConfig(raw: unknown): Partial<SessionConfig> | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<SessionConfig>;
  const lanes = Array.isArray(r.lanes) ? r.lanes.filter(isLaneSpec) : [];
  return {
    mode: r.mode === 'hand' ? 'hand' : 'leg',
    lanes: lanes.length >= MIN_LANES ? normalizeLanes(lanes.slice(0, MAX_LANES)) : undefined,
    difficulty: r.difficulty === 'easy' || r.difficulty === 'hard' ? r.difficulty : 'medium',
    windowScale: Number.isFinite(r.windowScale) ? clampWindowScale(r.windowScale as number) : 1,
    songId: typeof r.songId === 'string' ? r.songId : DEFAULT_SONG_ID,
  };
}

function validateCalibrations(raw: unknown): Record<string, RomCalibration> | null {
  if (!raw || typeof raw !== 'object') return null;
  const out: Record<string, RomCalibration> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const c = v as Partial<RomCalibration> | null;
    if (c && Number.isFinite(c.min) && Number.isFinite(c.max)) out[k] = c as RomCalibration;
  }
  return out;
}

/** What `applySuggestedLatency` did: the offset before, the offset after, both in milliseconds. */
export interface LatencyChange {
  previousMs: number;
  appliedMs: number;
  deltaMs: number;
}

export interface AppState {
  screen: Screen;
  /** Screen the user came from, so Back on a leaf screen is not a guess. */
  previousScreen: Screen | null;
  inputMode: InputMode;

  mode: Mode;
  lanes: LaneSpec[];
  difficulty: DifficultyName;
  windowScale: number;
  songId: string;
  seed: number;

  /** Per-lane ROM calibration for the CURRENT prescription (same order as `lanes`). */
  calibrations: (RomCalibration | null)[];
  /** Every calibration ever captured, keyed movement:side, so a repeat session can offer it. */
  savedCalibrations: Record<string, RomCalibration>;

  latencyOffsetSec: number;
  latencyMeasured: boolean;
  latencyNote: string;

  settings: Settings;
  history: SessionResult[];
  lastResult: SessionResult | null;
  persistenceFailed: boolean;

  goto: (screen: Screen) => void;
  setInputMode: (m: InputMode) => void;
  setMode: (m: Mode) => void;
  setLanes: (lanes: LaneSpec[]) => void;
  setLane: (index: number, patch: Partial<Pick<LaneSpec, 'movement' | 'side' | 'fingertip'>>) => void;
  addLane: () => void;
  removeLane: (index: number) => void;
  setDifficulty: (d: DifficultyName) => void;
  setWindowScale: (s: number) => void;
  setSong: (id: string) => void;
  setSeed: (seed: number) => void;
  setCalibration: (lane: number, cal: RomCalibration | null) => void;
  clearCalibrations: () => void;
  setLatency: (sec: number, measured: boolean, note?: string) => void;
  /**
   * Adopt the offset a finished run suggests as the one the NEXT session runs with. Returns the
   * before/after pair (ms) so the screen can show the therapist exactly what changed, or null when
   * there was nothing usable to apply.
   */
  applySuggestedLatency: (suggestedMs: number, source?: string) => LatencyChange | null;
  updateSettings: (patch: Partial<Settings>) => void;
  addResult: (r: SessionResult) => void;
  clearHistory: () => void;
  config: () => SessionConfig;
}

const persistedSettings = readJson<Settings>(SETTINGS_KEY, DEFAULT_SETTINGS, validateSettings);
const persistedHistory = readJson<SessionResult[]>(HISTORY_KEY, [], validateHistory);
const persistedLatency = readJson<number>(LATENCY_KEY, 0, (raw) => (Number.isFinite(raw) ? (raw as number) : null));
const persistedConfig = readJson<Partial<SessionConfig>>(CONFIG_KEY, {}, validateConfig);
const persistedCalibrations = readJson<Record<string, RomCalibration>>(CALIBRATION_KEY, {}, validateCalibrations);

const initialMode: Mode = persistedConfig.mode ?? 'leg';
const initialLanes = persistedConfig.lanes ?? defaultLanes(initialMode);

/** Keep at most this many sessions in localStorage (a clinic tablet is shared and quota is small). */
export const MAX_HISTORY = 100;

export const useStore = create<AppState>((set, get) => {
  const persistSettings = (s: Settings): void => {
    if (!writeJson(SETTINGS_KEY, s)) set({ persistenceFailed: true });
  };
  const persistHistory = (h: SessionResult[]): void => {
    if (!writeJson(HISTORY_KEY, h)) set({ persistenceFailed: true });
  };
  const persistConfig = (): void => {
    const s = get();
    writeJson(CONFIG_KEY, { mode: s.mode, lanes: s.lanes, difficulty: s.difficulty, windowScale: s.windowScale, songId: s.songId });
  };

  return {
    screen: 'home',
    previousScreen: null,
    inputMode: 'camera',

    mode: initialMode,
    lanes: initialLanes,
    difficulty: persistedConfig.difficulty ?? 'medium',
    windowScale: persistedConfig.windowScale ?? 1,
    songId: persistedConfig.songId ?? DEFAULT_SONG_ID,
    seed: 1,

    calibrations: initialLanes.map(() => null),
    savedCalibrations: persistedCalibrations,

    latencyOffsetSec: persistedLatency,
    latencyMeasured: false,
    latencyNote: '',

    settings: persistedSettings,
    history: persistedHistory,
    lastResult: null,
    persistenceFailed: false,

    goto: (screen) => set((s) => (s.screen === screen ? s : { screen, previousScreen: s.screen })),
    setInputMode: (inputMode) => set({ inputMode }),

    setMode: (mode) =>
      set((s) => {
        if (s.mode === mode) return s;
        const lanes = defaultLanes(mode);
        return { mode, lanes, calibrations: lanes.map((l) => s.savedCalibrations[calibrationKey(l)] ?? null) };
      }),

    setLanes: (lanes) =>
      set((s) => {
        const next = normalizeLanes(lanes.slice(0, MAX_LANES));
        return { lanes: next, calibrations: next.map((l) => s.savedCalibrations[calibrationKey(l)] ?? null) };
      }),

    setLane: (index, patch) => {
      set((s) => {
        if (index < 0 || index >= s.lanes.length) return s;
        const lanes = s.lanes.map((l, i) => (i === index ? normalizeLaneFingertip({ ...l, ...patch }) : l));
        const calibrations = s.calibrations.slice();
        // A different movement or side is a different quantity: the old range must not carry over.
        calibrations[index] = s.savedCalibrations[calibrationKey(lanes[index])] ?? null;
        return { lanes: normalizeLanes(lanes), calibrations };
      });
      persistConfig();
    },

    addLane: () => {
      set((s) => {
        if (s.lanes.length >= MAX_LANES) return s;
        const options = movementsFor(s.mode);
        const used = new Set(s.lanes.map((l) => calibrationKey(l)));
        let pick: LaneSpec | null = null;
        for (const movement of options) {
          for (const side of ['left', 'right'] as Side[]) {
            const candidate: LaneSpec = normalizeLaneFingertip({ index: s.lanes.length, movement, side });
            if (!used.has(calibrationKey(candidate))) {
              pick = candidate;
              break;
            }
          }
          if (pick) break;
        }
        const lane = normalizeLaneFingertip(pick ?? { index: s.lanes.length, movement: options[0], side: 'left' as Side });
        return { lanes: [...s.lanes, lane], calibrations: [...s.calibrations, s.savedCalibrations[calibrationKey(lane)] ?? null] };
      });
      persistConfig();
    },

    removeLane: (index) => {
      set((s) => {
        if (s.lanes.length <= MIN_LANES) return s;
        const lanes = normalizeLanes(s.lanes.filter((_, i) => i !== index));
        return { lanes, calibrations: s.calibrations.filter((_, i) => i !== index) };
      });
      persistConfig();
    },

    setDifficulty: (difficulty) => {
      set({ difficulty: DIFFICULTIES[difficulty] ? difficulty : 'medium' });
      persistConfig();
    },

    setWindowScale: (windowScale) => {
      set({ windowScale: clampWindowScale(windowScale) });
      persistConfig();
    },

    setSong: (songId) => {
      set({ songId });
      persistConfig();
    },

    setSeed: (seed) => set({ seed }),

    setCalibration: (lane, cal) =>
      set((s) => {
        if (lane < 0 || lane >= s.lanes.length) return s;
        const calibrations = s.calibrations.slice();
        calibrations[lane] = cal;
        const savedCalibrations = { ...s.savedCalibrations };
        if (cal) savedCalibrations[calibrationKey(s.lanes[lane])] = cal;
        writeJson(CALIBRATION_KEY, savedCalibrations);
        return { calibrations, savedCalibrations };
      }),

    clearCalibrations: () => set((s) => ({ calibrations: s.lanes.map(() => null) })),

    setLatency: (sec, measured, note = '') => {
      const latencyOffsetSec = Number.isFinite(sec) ? Math.max(0, Math.min(1, sec)) : 0;
      set({ latencyOffsetSec, latencyMeasured: measured, latencyNote: note });
      writeJson(LATENCY_KEY, latencyOffsetSec);
    },

    applySuggestedLatency: (suggestedMs, source = '') => {
      if (!Number.isFinite(suggestedMs)) return null;
      const previousMs = Math.round(get().latencyOffsetSec * 1000);
      const appliedSec = Math.max(0, Math.min(1, suggestedMs / 1000));
      const appliedMs = Math.round(appliedSec * 1000);
      // `measured` stays true: the value came from a whole run's worth of judged crossings, which is
      // strictly more evidence than the ten taps of the latency screen.
      get().setLatency(appliedSec, true, source ? `${appliedMs} ms measured from ${source}` : `${appliedMs} ms measured from the last run`);
      return { previousMs, appliedMs, deltaMs: appliedMs - previousMs };
    },

    updateSettings: (patch) => {
      const settings = { ...get().settings, ...patch };
      set({ settings });
      persistSettings(settings);
    },

    addResult: (r) => {
      const history = [r, ...get().history].slice(0, MAX_HISTORY);
      set({ history, lastResult: r });
      persistHistory(history);
    },

    clearHistory: () => {
      set({ history: [] });
      persistHistory([]);
    },

    config: () => {
      const s = get();
      return { mode: s.mode, lanes: s.lanes, difficulty: s.difficulty, windowScale: s.windowScale, songId: s.songId, seed: s.seed };
    },
  };
});
