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
