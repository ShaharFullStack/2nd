# Beat Rehab

A rhythm game you play with your body, built for physiotherapy. The patient performs
therapist-prescribed exercises in time with real music; each exercise is a lane on a
Guitar-Hero-style note highway, and a camera — not a controller — reads the movement.

The music is multitrack, and where the song has the stems for it each lane gets an
instrument of its own: hit that lane's notes and its instrument plays at full level, miss
one and it dips — about 3 dB, a run of misses at most 9 dB, never silence, back the moment
the next note in that lane lands. A weak left leg dims its own instrument and never the
one the right leg is earning. When a song has too few stems for the lane count (both demo
songs have four stems, so a four-lane session shares), every lane ducks one shared
instrument, and then a miss costs one step and no more, however long the run — because
that instrument is the working limb's reward too. The Setup screen states which of the two
is in force, per lane, before the session starts. The body plays the music.

```bash
npm install
npm run dev            # http://localhost:5173
```

No camera to hand? `?input=keyboard` maps lanes to `1`–`4` / `D F J K`, `?input=autoplay`
runs a bot, `?demo=highway` mounts the renderer on its own.

## How a session goes

1. **Mode** — legs or hands. One per session, never both.
2. **Prescription** — the therapist picks 2–4 movements (with side), a difficulty, and a song.
3. **Camera check** — live preview with landmark overlay, frame rate, mirror toggle, and a
   statement of **what this device will and will not support**, made before the patient is in
   the chair: the timing resolution this frame rate gives, which of the prescribed hit windows
   are reachable at it, and how much of the check the landmarks were usable for. Two findings
   gate the way forward rather than letting an appointment be spent discovering them — nothing
   tracked at all, and frames further apart than the widest hit window the prescription grants.
   Both clear by themselves, and both offer the keyboard session (which measures no range of
   motion, and says so) as the way on.
4. **Range-of-motion calibration** — per lane: rest for two seconds, then three comfortable
   reps. The hit threshold is a fraction of *that patient's* range, and the fraction is the
   difficulty knob (easy 0.5, medium 0.65, hard 0.8). The range carries **how well it was
   measured** — see "How well was it measured?" below.
5. **Latency calibration** — a metronome, eight beats, move on each click. Camera pipelines
   run 80–200 ms behind reality; this measures it rather than guessing.
6. **Play.**
7. **Results** — score and stars, but also reps performed, accuracy and timing bias per
   movement, range achieved against the calibrated range, and compensation flags.

Sessions are stored locally, so the History screen shows progress across visits.

## The movements

Each movement is one lane.

**Leg mode** (MediaPipe Pose, patient seated)

| Movement | What the patient does | What the camera measures |
| --- | --- | --- |
| Seated march | Lifts the knee | Hip flexion: knee height above hip, over torso length |
| Knee extension | Straightens the leg | Hip–knee–ankle angle |
| Ankle dorsiflexion | Lifts the toes, heel down | Shin-to-foot angle, with a heel-lift compensation check |
| Hip abduction | Swings the knee outward | Lateral knee displacement from the hip, over torso length |

**Hand mode** (MediaPipe Hands, forearm resting on a table)

| Movement | What the patient does | What the camera measures |
| --- | --- | --- |
| Hand open / close | Opens and closes the fist | Mean fingertip-to-wrist distance over palm size |
| Wrist extension | Lifts the wrist | Wrist rise against the calibrated rest baseline |
| Finger opposition | Taps a fingertip to the thumb | Fingertip-to-thumb distance over palm size |
| Finger spread | Spreads the fingers | Index-to-pinky angle |

Fine-motor movements get timing windows 1.6× wider than gross ones, because they are
smaller signals in a noisier part of the image.

## Music and attribution

Songs live in `public/songs/<id>/` as a `song.json` manifest plus a `stems/` folder. Two
demo multitracks are synthesized in-repo (`npm run gen-demo-stems`, CC0) so the game is
playable immediately.

For real music, `public/songs/ccmixter-README.md` walks through taking a Creative Commons
multitrack from [dig.ccMixter](https://dig.ccmixter.org/) (the free-for-commercial-use
section) or [stems.ccMixter](https://stems.ccmixter.org/), writing its licence and artist
into the manifest, and pulling the audio down with `npm run fetch-stems`. Per-song
attribution is required data, and the game displays it — on the song list, as a lower-third
card when the song starts, and on the results screen.

Songs whose stems have not been fetched are shown as "needs fetch" rather than crashing the
catalogue.

## Layout

```
src/engine/    timing, judgment, scoring, latency maths — pure TS, no DOM
src/charts/    chart generation from a song's beat grid
src/audio/     Web Audio stem mixer (sample-synced stems, per-stem ducking), SFX, latency probe
src/vision/    MediaPipe wrappers, per-movement feature extraction, ROM calibration, triggers
src/input/     InputSource: vision, keyboard, replay, autoplay
src/render/    Canvas note highway and HUD
src/session/   game loop, session config, results
src/ui/        React screens
src/state/     zustand store + local persistence
critic/        Playwright harnesses the build is judged with, plus reference material
docs/          ARCHITECTURE.md — the contract every module follows
```

`docs/ARCHITECTURE.md` is the source of truth for module boundaries, the time base, and the
input and audio contracts.

## Checks

```bash
npm test               # vitest
npm run typecheck
npm run build
npm run critic:smoke   # boots the app in headless Chromium and plays a session end to end
npm run critic:frames  # captures 1080p gameplay frames for visual review
npm run critic:motion  # frame bursts across a hit and a miss, plus frame pacing and clock drift
npm run critic:audio   # proves the per-lane ducking end to end: real Web Audio gains in a browser
npm run critic:uneven  # a seeded shared tablet whose latest session was tracked at 11.8 fps: no
                       # comparison across it may render as a plain gain, at 1024/1280/1920
npm run critic:firstnote  # throttled 8 Mbit/s: bytes after Start and Start → first note
```

Each of these starts and stops its own dev server. `critic:smoke` drives the whole flow and
asserts the engine scored, the clock froze on pause, and the session was saved.
`critic:audio` is the one that checks the game's central promise: it plays a session, stops
feeding the engine, and reads the live Web Audio gains to confirm the missing lane's
instrument dips in proportion, that no other lane's instrument moves with it, and that the
rest of the band keeps going.

### Time to the first note

A rhythm game is judged on how fast you get to play, and a therapist has about ninety seconds
between patients on a shared tablet. The stems are the whole weight of a session and they used to
be fetched after Start, with the patient already in position.

Everything below is the output of **`npm run critic:firstnote`** — production build served by
`vite preview`, throttled to 8 Mbit/s with 40 ms latency, HTTP cache disabled, Home → Leg → Start
with the autoplay bot, timed from the Start click to the bot answering note one. Re-run it; it
prints this table (timings vary by a couple of tenths between runs).

| when Start is pressed | bytes after Start | Start → first note |
| --- | --- | --- |
| first ever load on this tablet, Start pressed on sight | 12.51 MB | 16.4 s |
| the same, after 6 s of writing the prescription | 7.04 MB | 10.6 s |
| the same, after 20 s of writing the prescription | 0.00 MB | 4.0 s |
| second session on the same tablet, stem cache emptied first (how this behaved before) | 12.65 MB | 16.3 s |
| **second session on the same tablet** | **0.00 MB** | **4.4 s** |

(The first row was 34.2 MB and 38.7 s before the stems were re-rendered at 16 kHz. That row is the
one figure here the harness cannot reproduce on demand — rebuild the 44.1 kHz stems with
`npm run gen-demo-stems -- --rate 44100` to see it again.)

**The first run on a device pays for the tracker before any of this.** The table above is the
autoplay path, which needs no camera. A camera session additionally transfers the MediaPipe wasm
runtime and one model, once per device, and they are then cached for a year (`vercel.json`). What
is actually transferred, measured on the real camera path in headless Chromium with a fake webcam
(Home → patient → mode → Start, counting every `/wasm/` and `/models/` response body):

| mode | `/wasm/` runtime | model | first run, total |
| --- | --- | --- | --- |
| leg (Pose) | 12.08 MB (11.52 MiB) | `pose_landmarker_lite.task` 5.78 MB (5.51 MiB) | **17.86 MB (17.03 MiB)** |
| hand (Hands) | 12.08 MB (11.52 MiB) | `hand_landmarker.task` 7.82 MB (7.46 MiB) | **19.90 MB (18.98 MiB)** |

Uncompressed, as this app's own static hosting serves them; a server with gzip or brotli on
`.wasm` transfers less. The runtime is `vision_wasm_internal.wasm` (11.76 MB) plus its 0.32 MB
JS glue — a browser without SIMD loads the 10.96 MB `nosimd` build instead. The camera check says
this figure while it waits, because "about 8 MB" was the model alone and understated the wait by
roughly two times.

**4.0 s is the floor, and it is not loading.** It is the game's own lead-in: a 3 s count-in, two
beats of musical lead before the first note, and that note's travel down the highway. Nothing that
follows can go below it.

Three changes, all measured the same way:

1. **The committed demo stems are rendered at 16 kHz** (`node scripts/gen-demo-stems.mjs --rate
   16000`) instead of 44.1 kHz — 12.4 MB instead of 34.2 MB for demo-groove. What that trades:
   the anti-alias lowpass sits at 6.7 kHz, and the synthesized bass, keys and lead hold
   100.00 %, 100.00 % and 99.97 % of their energy below it, so they are untouched; the drums —
   the only broadband stem — lose the hi-hat air above it, 11 % of that stem's energy (0.9–1.3 dB
   of RMS). The hats still read as hats and the kick/snare are unchanged; what is gone is the
   shimmer. The generator re-matches the stems to each other AFTER resampling
   (`rebalanceAfterResample`), so the mix the mastering chose — player stem 2 dB on top, which is
   what makes the ducking cue audible — is identical at either rate. `--rate 44100` builds the
   full-bandwidth version back.
2. **The song downloads while the prescription is being written** (`runtime.prefetchSong`). It now
   fires immediately for the song the Setup screen opens on — there is nothing to debounce about a
   choice already made, and the old 1.2 s settle delay was 1.2 s of a throttled link doing nothing
   (6 s dwell: 11.8 s → 10.6 s) — and stays debounced for a CHANGE of song, so flicking through the
   catalogue still starts one download. A camera session then has a camera check and two
   calibrations to download inside, and the Play screen's progress bar joins the load already
   running rather than starting a second one.
3. **A tablet pays for a song once** (`src/session/stemCache.ts`). Whole, successful, same-origin
   stem responses are kept in Cache Storage under the app's own key, bounded to the 16 most recent
   files, so a reload, the next patient, or a therapist who pressed Start on sight starts the song
   from disk whatever cache headers the clinic's server sends — 12.65 MB and 16.3 s become 0.00 MB
   and 4.4 s, which is the floor above. Every failure path (no Cache Storage in an insecure context,
   a quota refusal, a ranged audition request, a 206 or a 404) falls through to the plain network
   fetch: this layer may make a session start faster, never wrong and never not at all.

**What is left, and why it was not taken.** The first-ever load on a tablet is bounded by the song
itself: 12.5 MB over 8 Mbit/s is 12.5 s, and the only ways past that are to make the music worse or
to start the session before it has all arrived. Halving the bytes again means 8-bit or µ-law PCM —
quantisation noise in the stem the patient is being rewarded with, on top of the hi-hat air already
traded away, and (for µ-law) a decode this repo can only test in one browser. A compressed container
is not reachable at all: Node ships no Vorbis/Opus/MP3 encoder, no dependency may be added, and the
ranged audition (`src/session/audition.ts`) slices linear-PCM WAV arithmetically, so every "Listen"
press would become a full download. That leaves starting on a partial download — the player stem and
the bed first, the rest spliced in as it arrives — which is real work inside `StemMixer` (lane→stem
assignment is printed on the Setup screen before Start and may not change mid-song) and is the open
item here, not a thing this change pretends to have done.

Measured on this build: 59 fps median with one dropped frame in 118, audio-to-render clock
drift under 4 ms over 3 seconds, and — on a two-lane session on a four-stem song — lane 1
on `drums`, lane 2 on `bass`, `keys` and `lead` playing throughout, and the missing lane's
gain going 1.0 → 0.71 on one miss, bottoming out at 0.35, and back to 1.0 on the next hit
while the other lane's stem never leaves 1.0.

## A note on safety and scope

This is a movement game, not a medical device. Nothing here diagnoses, and the numbers on
the results screen are session telemetry for a clinician to interpret, not clinical
measurements. The engine deliberately never penalises extra movement — a patient with
tremor or spasticity should not lose points for their symptoms — and a song can never be
failed out of.

**And it does not only say so here.** This paragraph used to be the only place the scope was
stated, while the app itself presented joint angles, ranges, timing bias in milliseconds and
six-week trends. The statement now lives with the numbers: one line (`SCOPE_STATEMENT`, in
`src/session/results.ts`, rendered by `src/ui/ScopeNote.tsx`) under the range card on Results,
on the History screen, under the per-movement trend, and on the ROM calibration screen where a
range is first put into degrees — and in **every exported record**, as the first field of the
JSON and a `SCOPE:` line in the readable text. It is never a dialog and there is nothing to
dismiss: a therapist runs several sessions a day, and a modal is read once.

### How well was it measured?

A range measured from a 12 fps stream with the limb half out of frame is not the same number as
one from a clean 30 fps stream, and until recently the record could not tell them apart. Every
camera session now stores the conditions it was measured in (`SessionResult.tracking`, built by
`src/session/tracking.ts` from the input layer's own health report, sampled twice a second while
the song plays):

* median and 10th-percentile processed frame rate, and the median inference time per frame;
* the share of the session in which every prescribed lane had usable landmarks;
* the inference backend (`CPU` means the machine had no graphics acceleration);
* the commonest reason tracking was not OK.

From that the screens state the uncertainty they can actually derive — never an invented error
bar: **timing is resolved no finer than one camera frame** (33 ms at 30 fps, 83 ms at 12 fps),
and **a range is the peak of the frames that arrived**, so it is a lower bound. Results and the
session table grade each session `good` / `fair` / `poor`. A session with no tracking block
(every record written before this existed) reads as *not recorded*, never as a clean stream.

**And the grade travels into every comparison, which is the only reason to record it.** A
per-session block underneath a green "▲ +40 pts" chip changes nothing: comparison is where a
change in the equipment is indistinguishable from a change in the patient, and a therapist with
ninety seconds between patients reads the chip. So `compareTracking` (in `src/session/tracking.ts`)
gates every number this app derives from two sessions:

* a delta is **like-for-like** only when both sessions recorded tracking and both were graded
  good. Different grades, or two degraded ones, is **uneven**; a missing block at either end is
  **unknown** — absent reads as absent;
* on anything but like-for-like the chip **loses the green and carries the reason inside its own
  box** — "▲ +49 pts · measured unevenly" — on the ROM trend, the peak-angle trend, the accuracy
  trend, each lane's gain on Results, the rep delta, and "biggest gain today", which becomes
  "biggest change today";
* the trend **marks the points themselves**: a session measured on a degraded (or unrecorded)
  stream is drawn as a ringed dot and an outlined accuracy column, graded in the session-by-session
  list, and counted in a line on its own card — counted over the sessions on screen, not over the
  patient's whole history;
* the exported record states the rule in words (`COMPARING SESSIONS:` in the text, and the
  `fields.tracking` legend in the JSON), because the file is read with nothing else around it.

`npm run critic:uneven` drives all of that in the real app at 1024x768, 1280x800 and 1920x1080
against a seeded shared tablet whose latest session was tracked at 11.8 fps with the limb usable
for 62 % of the session, and fails if any qualified chip is green or anything clips.

A trend card holds **two** sets of sessions — the ones it plots, and the two ends each change
badge is taken across — and they are not the same set. The card used to print a warning counted
over the first set directly above a green chip computed over the second, in the same words, with
nothing to say they were about different things. The header badge now says which it is: it wears
the delta chips' own phrase (*measured unevenly*) only when a delta chip really is wearing it,
and otherwise reads *uneven between the ends* and names the two dates the change figures span.

**And the denominator itself is measured.** Every ROM figure this app prints, exports and trends
is a percentage of the range set at calibration — and that range was measured on the same webcam,
on the same machine, under conditions that were nowhere in the record. `RomCalibration.measurement`
(`CalibrationMeasurement`, built by `RomCalibrator` from the frames it was actually fed) now
carries them:

* every frame offered to the calibrator, **including the ones with no usable landmarks**, and the
  share that were usable — a hold that was only visible for half its frames is a zero taken from
  half a window, not a clean one;
* the median and 10th-percentile **frame rate** those frames arrived at. `max` is the 90th
  percentile of detected peaks and a peak between two frames is never seen, so a low frame rate
  biases the top of the range *downward* — and every later rep then reads as a larger percentage
  of it than it was. That direction is stated, because it decides whether to re-run;
* the **number of reps** and how far apart they were, in feature units and as a fraction of the
  range. Three reps agreeing to within 8 % of the range is a measurement; three spanning half of
  it is an estimate of where the top is.

`calibrationGrade` (in `src/session/tracking.ts`, beside `trackingGrade`, on the same thresholds,
so "good" means one thing about a camera measurement anywhere in this app) grades it good / fair /
poor. It is shown **while the range is being built** (when the chair and the light can still be
moved), on the range **as it is accepted**, on every lane in the list, and on last session's range
**before it is reused** — reusing a range is adopting its measurement as today's denominator.
A range with no block reads as *quality not recorded*, never as good: it was typed in by hand, or
captured before this device recorded one.
