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
- Each stem has a GainNode. **Ducking is per lane and proportionate** (`src/audio/ducking.ts`), which replaces the original flat 5 % player-stem duck: that rule let one missed note from a hemiparetic patient's weak side silence the instrument they were earning with every rep of the strong side, and the weak side IS the therapy.
  - `assignLaneStems(stems, playerStem, lanes)` maps lane → stem, always leaving at least one stem out of the assignment as the bed (the song itself never stops). With `lanes <= stems - 1` the mode is `per-lane`: every lane ducks its own instrument. Otherwise the mode is `shared`: every lane ducks the player stem.
  - A miss steps that lane's stem DOWN by `missStepDb` (−3 dB) per consecutive miss on that stem, with a 40 ms ramp, bottoming out at `missGain` (0.35, −9 dB) — audibly quieter, never silent. A hit restores 1.0 over 60 ms and resets the run; at `streakThreshold` (8) combo the restore is `streakBoostDb` (+2 dB).
  - In `shared` mode the floor is raised to ONE step (`duckOptionsFor`): a shared instrument is the reward for every limb at once, so a run of misses cannot take it below −3 dB.
  - Ramps are anchored on the analytic position of the ramp in flight (`RampState`/`rampValueAt`, `cancelAndHoldAtTime` where available), so a hit mid-duck does not click.
  - The Setup screen prints the assignment in force (`LaneStemAssignment.rule` + the lane→instrument list) — every sentence there must be conditional on `mode`.
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

**The committed demo stems are 16-bit mono WAV at 16 kHz** (`node scripts/gen-demo-stems.mjs
--rate 16000`), not at the generator's 44.1 kHz default: 12.4 MB instead of 34.2 MB for
demo-groove, which is 38.7 s → 17.0 s from Start to the first note on a throttled 8 Mbit/s link
(README, "Time to the first note"). `generated.sampleRate` in `song.json` records what was
written, and every consumer reads the rate from the file — stems of different songs (or of a
re-rendered song) may differ, and `decodeAudioData` resamples each to the context rate anyway.
A `--rate` build re-matches the stems to each other after resampling (`rebalanceAfterResample`):
the lowpass only takes energy out of the broadband stem, so without it the mastered balance —
player stem 2 dB on top — would be undone by the delivery format.

**Loading is not allowed to happen while the patient waits.** `runtime.prefetchSong(songId)` is
called from the Setup screen (immediately for the song that screen opens on — there is nothing to
debounce about a choice already made — then debounced ~1.2 s on any CHANGE, and again on Start); it
is fire-and-forget, idempotent per song, declines while an audition is in flight, and shares its
load with `loadSong` — including its byte progress, so the Play screen's bar joins a download it
did not start. Cancelling an audition must never cancel a prefetched session load
(`previewOwnsLoad`).

**And a tablet pays for a song once.** The mixer fetches through `cachingStemFetch`
(`src/session/stemCache.ts`, passed to `new StemMixer({ fetch })` in runtime): whole, successful,
same-origin stem responses are kept in Cache Storage under `beat-rehab-stems-v1`, bounded to
`MAX_CACHED_STEMS` oldest-first, so a reload or the next patient starts the song from disk whatever
cache headers the clinic's server sends. Every failure path — no Cache Storage, a quota refusal, a
ranged (audition) request, a 206/404 — falls through to the plain network fetch: this layer may make
a session start faster, never wrong and never not at all. `npm run critic:firstnote` measures the
result the way the README's table is measured: production build, `vite preview`, 8 Mbit/s with 40 ms
latency and the HTTP cache disabled, timed from the Start click to the bot answering note one.

## Session flow
Home → Patient → Mode (leg/hand) → Therapist Setup (pick 2–4 movements+sides, difficulty, song, **pacing**) → Camera check → ROM calibration per lane → Latency calibration → Play → Results → persisted to localStorage (history, patient-scoped).

### The prescription, and what is shown when
- **Dose before Start.** Setup measures the chart it will actually play (`generateChartDetailed` with the prescribed seed and pacing) and states reps per lane, reps/min per limb and reps/min for the whole body (`chartDose`). Nothing on that screen may claim a dose it has not measured.
- **Pacing is physiology, not difficulty.** `SessionConfig.laneRestSec` (default 1.2 s, bounds `MIN_LANE_REST_SEC`=0.4 … `MAX_LANE_REST_SEC`=6, on a `LANE_REST_STEP_SEC`=0.1 grid) is the minimum rest between two reps of the SAME lane, set by the therapist and stored with the session. It is NOT keyed off `Difficulty`; changing the timing windows must not move it. `clampLaneRestSec` quantises onto the grid so the value displayed is always the value in force.
- **Nothing in the patient's view may alarm about a state that has no failure.** A song can never be failed, so there is no rock meter: `RenderFrame.health` is NOTES ANSWERED (`answerRateOf` — movements made ÷ notes judged, with a `ANSWER_WARMUP_NOTES`=6 opening warm-up on the live gauge only), the gauge is labelled with what it counts, and it never pulses or turns red.
- **Results leads with work, not with a grade.** Movements performed, range achieved, today vs THIS patient's last camera session (`patientSessions`/`isPatientDriven`), notes answered; score, stars, weighted accuracy and the per-lane clinical table are kept in full but folded away for the therapist.
- **A ROM nudge is bounded by the patient's own evidence.** Easier/Harder step by a FRACTION of the measured range (`ROM_NUDGE_FRACTION`), never an absolute feature delta, refuse to exceed the best rep on record (`calibrationPatientBest`), refuse to shrink below the minimum usable range, and label themselves with the target they will set in the movement's units (`previewRomNudge` → `RomNudgePreview.label`).

### Scope, and the conditions a measurement was taken in
- **The scope statement travels with the numbers.** `SCOPE_STATEMENT` (src/session/results.ts) is
  the single source, rendered by `src/ui/ScopeNote.tsx` on every screen that presents a
  measurement — Results (under the range card), History, the ROM trend, ROM calibration — and
  written into every export (first field of the JSON, a `SCOPE:` line in the text). It is never a
  dialog and never dismissible: a therapist runs several sessions a day, and anything that has to
  be clicked away is trained away by the third one.
- **Every camera session records how well it was tracked.** `SessionResult.tracking`
  (`TrackingQuality`) is built by `src/session/tracking.ts` from `VisionInput.getStatus()`,
  sampled every `TRACKING_SAMPLE_MS` while the runner's phase is `playing`: median/10th-percentile
  processed fps, median inference ms, the share of samples with usable landmarks, the low-fps
  share, the delegate and the commonest non-ok reason. Absent means NOT RECORDED (a keyboard or
  autoplay run, or a record written before this existed) and must never render as a clean stream.
- **Only uncertainty that was observed may be stated.** No landmark-error estimate is invented.
  What the screens say is what follows from the sampling: timing is resolved no finer than one
  frame interval (`timingResolutionMs`), and a ROM figure is the peak of the frames that arrived,
  so it is a lower bound. `trackingGrade` (good/fair/poor) is keyed off `MIN_USABLE_DETECT_FPS`
  and the tracked share, and the trend states how many of the sessions behind its lines were
  measured on a degraded stream.
- **THE QUALIFIER RIDES ON THE COMPARISON, NOT UNDER IT.** Recording tracking quality changes no
  decision until it reaches the place where one number is subtracted from another — a trend delta, a
  gain chip, "biggest gain today" — because comparison is where equipment noise masquerades as
  patient change. `compareTracking(from, to)` (session/tracking.ts) is the single gate: `like-for-like`
  only when BOTH sessions recorded tracking and both were graded good; `uneven` when the grades
  differ or both are degraded; `unrecorded` when either end has no block (absent reads as absent,
  never as a clean stream). Every surface that spans two sessions passes its two ENDPOINTS through it:
  - `TrendPoint` carries `tracking` and `trackingGrade`, so the ROM, peak and accuracy plots ring
    (`Sparkline.flagged`) or outline (`SessionBars.flagged`) the points that were not measured like
    the rest, and the session-by-session list grades every row;
  - `DeltaBadge` takes `qualified` and, when set, LOSES THE GREEN and prints the reason inside its own
    box ("▲ +49 pts · measured unevenly"). A grey sentence under a green chip is not a qualifier — a
    therapist with ninety seconds reads the chip;
  - Results qualifies each lane's gain chip, "biggest gain today" (which becomes "biggest change
    today"), the rep delta and the card header from the same verdict;
  - counts of degraded sessions are taken over the sessions ON SCREEN (`trackingMixOfGrades` on the
    plotted window), never over the patient's whole stored history;
  - the export states the rule in words (`COMPARING SESSIONS:` in the text, and the `fields.tracking`
    legend in the JSON), because the file is read with no app around it.
  `critic/measured-unevenly.mjs` drives the whole thing in the real app at 1024x768, 1280x800 and
  1920x1080 against a seeded shared tablet whose latest session was tracked at 11.8 fps.

## Dev/test affordances (mandatory)
- `?input=keyboard` URL param bypasses camera; `?autoplay=1` bot hits every note (for screenshots); `?seed=`.
- `window.__beatRehab` debug handle exposes store + engine for playwright critics.
- Vitest unit tests for engine/, audio scheduling math, vision feature extractors (with fixture landmarks).
