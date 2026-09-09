# Beat Rehab — Architecture Contract

React + Vite + TypeScript rhythm rehab game. Camera-only control via MediaPipe
(Pose for LEG mode, Hands for HAND mode; one mode per session). This file is
the contract every module and every subagent must follow. Change it only via
the orchestrator.

## Directory layout

```
src/
  engine/     pure TS, no DOM: chart types, timing/judgment, scoring, note scheduler
  audio/      Web Audio: StemMixer (multi-stem sync playback, per-stem ducking), clock, latency probe
  vision/     MediaPipe wrappers + movement feature extractors + calibration + trigger detection
  input/      InputSource abstraction: VisionInput (camera), KeyboardInput (dev), ReplayInput (tests)
  render/     Canvas 2D/WebGL note highway + HUD juice (pure draw functions given a RenderFrame)
  ui/         React screens: Home, Setup, Calibration (ROM + latency), Play, Results
  session/    session config, therapist prescription, results/metrics, localStorage persistence
  state/      zustand store(s)
  charts/     chart generation from song beat grid + difficulty
public/
  models/     MediaPipe .task models (pose_landmarker_lite, hand_landmarker)
  wasm/       MediaPipe tasks-vision wasm runtime (served locally, no CDN)
  songs/<id>/song.json + stems/*.{wav,mp3}
scripts/      fetch-stems.mjs (downloads ccmixter stems from manifests), gen-demo-stems.mjs
critic/       critic harness: playwright screenshot/replay scripts + reports
progress/     live HTML progress page (index.html) + log.json
```

## Core types (src/engine/types.ts — canonical, do not fork)

```ts
export type Mode = 'leg' | 'hand';
export type LegMovement = 'seated_march' | 'knee_extension' | 'ankle_dorsiflexion' | 'hip_abduction';
export type HandMovement = 'hand_open_close' | 'wrist_extension' | 'finger_opposition' | 'finger_spread';
export type Movement = LegMovement | HandMovement;
export type Side = 'left' | 'right';

export interface LaneSpec { index: number; movement: Movement; side: Side; }

export interface Note { id: number; lane: number; time: number /* seconds, song time */; }
export interface Chart { songId: string; lanes: number; notes: Note[]; bpm: number; offset: number; difficulty: Difficulty; }

export type Judgment = 'perfect' | 'good' | 'miss';
export interface HitEvent { noteId: number; lane: number; judgment: Judgment; deltaMs: number; time: number; }

export interface TimingWindows { perfectMs: number; goodMs: number; }   // ± around note time
export interface Difficulty { name: 'easy' | 'medium' | 'hard'; thresholdFraction: number /* 0..1 of ROM */; noteDensity: number; windows: TimingWindows; }
```

## Time base
- `AudioContext.currentTime` is the single clock. Song time = ctx.currentTime - songStartCtxTime + latencyOffsetSec.
- `latencyOffsetSec` (from latency calibration, per session) shifts when an input is considered to have happened: an input observed at ctx time t is judged against song time (t - inputLatencySec). Camera pipeline latency is typically 80–200 ms; the calibration screen measures it.
- Judgment windows are per-movement: fine motor (finger_opposition, finger_spread) get ×1.6 multiplier on base windows; base windows are Difficulty.windows (easy: perfect 90 / good 180 ms; medium 70/140; hard 50/110).

## Input contract (src/input/types.ts)
```ts
export interface LaneInputEvent { lane: number; ctxTime: number /* AudioContext time when movement crossed threshold */; strength: number /* 0..1 fraction of ROM reached */; }
export interface LaneState { lane: number; value: number /* normalized 0..1 of calibrated ROM */; armed: boolean; }
export interface InputSource {
  start(): Promise<void>; stop(): void;
  onEvent(cb: (e: LaneInputEvent) => void): () => void;
  getLaneStates(): LaneState[];   // for live UI meters
}
```
Vision emits an event when a lane's normalized value crosses `thresholdFraction` upward (rising edge) with hysteresis (must fall below thresholdFraction*0.6 to re-arm). Keyboard input maps keys 1–4 (or D F J K) to lanes for development.

## Movement feature extraction (normalized raw feature → ROM calibration → 0..1)
LEG (Pose landmarks, seated, camera facing patient, full body or knees-up visible):
- seated_march: hip flexion ⇒ knee height relative to hip: feature = (hip.y - knee.y)/torsoLen (higher knee ⇒ larger)
- knee_extension: knee angle hip-knee-ankle in degrees (straighter ⇒ larger); feature = angle
- ankle_dorsiflexion: angle between shin (knee→ankle) and foot (ankle→foot_index); feature = 180 - angle (toe lift ⇒ larger). Heel stays down: heel.y must not rise > small tolerance (else the rep is flagged as compensation, still counted per difficulty setting)
- hip_abduction: lateral knee displacement from hip in x, normalized by torsoLen; feature = |knee.x - hip.x|/torsoLen
HAND (Hands landmarks, forearm on table, palm facing camera):
- hand_open_close: mean fingertip-to-wrist distance / palm size (open ⇒ larger)
- wrist_extension: angle of wrist→middle_mcp vector relative to forearm direction (use Pose-less estimate: vertical rise of wrist landmark relative to calibrated rest baseline, normalized by palm size)
- finger_opposition: 1 - (min fingertip-to-thumb-tip distance / palm size), fingertip = index by default (therapist can choose)
- finger_spread: angle between index and pinky MCP→tip vectors (spread ⇒ larger)

ROM calibration: patient holds rest for 2 s (min), then does 3 reps at comfortable max (max). Normalized value = clamp((feature - min)/(max - min), 0, 1). Smoothing: one-euro filter or EMA (alpha ~0.5 at 30 fps). All extractors expose `feature(landmarks): number | null` (null when landmarks missing/low visibility).

## Audio contract (src/audio/StemMixer.ts)
- Load all stems of a song as AudioBuffers; start all sources at the same ctx time (sample-accurate).
- Each stem has a GainNode. The "player stem" (song.playerStem) is ducked to `missGain` (default 0.05 with a 40 ms ramp) on miss and restored (60 ms ramp) on hit; ducking persists until next hit (so a run of misses = silence for the player's instrument). Other stems always play.
- Optional per-lane hit SFX layer (short, quiet) for extra feedback, toggleable.

## Song manifest (public/songs/<id>/song.json)
```json
{
  "id": "…", "title": "…", "artist": "…", "artistUrl": "…", "sourceUrl": "https://ccmixter.org/files/…",
  "license": "CC BY 4.0", "licenseUrl": "https://creativecommons.org/licenses/by/4.0/",
  "attribution": "\"Title\" by Artist (ccmixter.org) is licensed under CC BY 4.0",
  "bpm": 120, "offset": 0.0, "durationSec": 180, "previewStart": 30,
  "stems": [{"id":"drums","file":"stems/drums.wav","label":"Drums"}, …],
  "playerStem": "drums",
  "remoteStems": [{"id":"drums","url":"https://…"}]   // for scripts/fetch-stems.mjs
}
```
`public/songs/index.json` lists song ids. Attribution must be shown in song select and results.

## Session flow
Home → Mode (leg/hand) → Therapist Setup (pick 2–4 movements+sides, difficulty, song) → Camera check → ROM calibration per lane → Latency calibration → Play → Results (score, accuracy per lane, reps, ROM achieved, compensation flags) → persisted to localStorage (history).

## Dev/test affordances (mandatory)
- `?input=keyboard` URL param bypasses camera; `?autoplay=1` bot hits every note (for screenshots); `?seed=`.
- `window.__beatRehab` debug handle exposes store + engine for playwright critics.
- Vitest unit tests for engine/, audio scheduling math, vision feature extractors (with fixture landmarks).
