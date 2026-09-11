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
3. **Camera check** — live preview with landmark overlay, frame rate, mirror toggle.
4. **Range-of-motion calibration** — per lane: rest for two seconds, then three comfortable
   reps. The hit threshold is a fraction of *that patient's* range, and the fraction is the
   difficulty knob (easy 0.5, medium 0.65, hard 0.8).
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
```

Each of these starts and stops its own dev server. `critic:smoke` drives the whole flow and
asserts the engine scored, the clock froze on pause, and the session was saved.
`critic:audio` is the one that checks the game's central promise: it plays a session, stops
feeding the engine, and reads the live Web Audio gains to confirm the missing lane's
instrument dips in proportion, that no other lane's instrument moves with it, and that the
rest of the band keeps going.

### Time to the first note

The stems are the whole weight of a session, and they used to be fetched after the therapist
pressed Start, with the patient already in position. Measured against the production build over
a throttled 8 Mbit/s link with 40 ms latency (Home → Leg → Start, autoplay, cold cache):

| | bytes after Start | Start → first note |
| --- | --- | --- |
| before | 34.2 MB | 38.7 s |
| after — stems at 16 kHz | 12.4 MB | 17.0 s |
| after — and the song prefetched while the prescription is written (20 s on Setup) | 0 MB | 4.1 s |

Two changes, both measured the same way:

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
2. **The song downloads while the prescription is being written** (`runtime.prefetchSong`, called
   from the Setup screen once the choice settles and again when Start is pressed). A camera
   session then has a camera check and two calibrations to download inside, and the Play screen's
   progress bar joins the load already running rather than starting a second one.

The remaining lever is a compressed format, which this repo cannot reach: Node ships no
Vorbis/Opus/MP3 encoder, no dependency may be added, and the ranged audition
(`src/session/audition.ts`) slices linear-PCM WAV arithmetically — a compressed container would
send every "Listen" press back to a full download.

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
session table grade each session `good` / `fair` / `poor`; the trend says how many of the
sessions behind its lines were measured on a degraded stream, because a difference between two
sessions measured differently is partly the equipment. A session with no tracking block (every
record written before this existed) reads as *not recorded*, never as a clean stream.
