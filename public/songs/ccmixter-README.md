# Adding a ccMixter multitrack to Beat Rehab

The two `demo-*` songs in this folder are synthesized in-repo (`npm run gen-demo-stems`,
CC0). For real music, ccMixter publishes thousands of Creative-Commons songs, and many
artists also upload the individual **stems** (drums, bass, vocals, …) that Beat Rehab needs
for per-instrument ducking.

Only use tracks whose licence permits your use. For a rehab product that may be used
commercially, stick to the **free for commercial use** section (CC BY / CC BY-SA / CC0) —
avoid CC BY-NC.

## 1. Find a stem pack

* https://dig.ccmixter.org/ → "Free for commercial use" (filter: *CC BY* / *CC0*),
  or https://stems.ccmixter.org/ (a cappella + stems / "sample packs").
* On the song page look for a *Stems* / *Multitrack* / *Sample pack* download (zip or
  individual files). You need at least 2 stems; the "player stem" is the one the patient
  drives (drums or another rhythmically obvious part works best).
* Note the tempo (BPM) — it is usually in the description or the file names. If not, find it
  with any DAW / tap-tempo tool; the chart generator relies on it.

## 2. Create the song folder

```
public/songs/<song-id>/
  song.json          <- copy public/songs/_template/song.json and edit
  stems/             <- filled by `npm run fetch-stems` (git-ignored, see .gitignore)
```

Edit `song.json`:

| field | what to put |
| --- | --- |
| `id` | must equal the folder name |
| `title`, `artist`, `artistUrl` | as shown on ccMixter |
| `sourceUrl` | the ccMixter song page (`https://ccmixter.org/files/<artist>/<id>`) |
| `license`, `licenseUrl` | copy **exactly** from the song page, e.g. `CC BY 4.0` + `https://creativecommons.org/licenses/by/4.0/` |
| `attribution` | `"Title" by Artist (ccmixter.org) is licensed under CC BY 4.0` — this string is shown in song select and on the results screen, which is what CC BY requires |
| `bpm`, `offset` | tempo, and the time (seconds) of the first downbeat in the stems |
| `swing` | rhythmic feel: the fraction of a 16th by which the **odd** 16ths are played late. `0` (or absent) for a straight track; `0.333` for a triplet shuffle (long:short = 2:1); measure it if the drummer swings, otherwise every off-16th note in the chart lands `swing × 15/bpm` seconds off the audio. `stepTimeSec()` in `src/audio/manifest.ts` applies it. |
| `durationSec`, `previewStart` | length of the stems; where the preview snippet starts |
| `stems` | one entry per file, `file` is relative to the song folder |
| `playerStem` | id of the stem the patient controls |
| `remoteStems` | `{id, url}` pairs with the **direct file URLs** from ccMixter (right-click → copy link on each stem; zip archives are not unpacked) |

Then add the id to `public/songs/index.json`.

## 3. Download

```
npm run fetch-stems              # all songs
npm run fetch-stems -- --song my-song --force
npm run fetch-stems -- --retries 5 --timeout 60   # more patience on a slow link (defaults: 3 retries, 30 s watchdog)
```

The script skips files that already exist, retries failed transfers and prints the
attribution for every song. Until the stems are downloaded, the app lists the song as
**"needs fetch"** instead of crashing (`loadSongCatalog` in `src/audio/manifest.ts`
probes each stem with a HEAD request).

Stem files are large, so they are git-ignored (`public/songs/*/stems/*.wav`) — every
developer/deployment runs `npm run fetch-stems` once. Only the synthesized `demo-*`
stems are committed.

## Tips

* If stems come as MP3, keep them: `AudioContext.decodeAudioData` handles MP3/OGG/WAV.
* Bandwidth: **the committed demo stems are 16-bit mono WAV at 16 kHz** — 12.4 MB for
  demo-groove and 10.0 MB for demo-sunrise, written by
  `node scripts/gen-demo-stems.mjs --rate 16000`, with `song.json`'s `generated.sampleRate`
  recording what was written. They used to be 44.1 kHz (34 MB / 27 MB), which measured 38.7 s
  from pressing Start to the first note over a throttled 8 Mbit/s clinic link; at 16 kHz that
  is 17.0 s, and with the Setup screen's prefetch running during the prescription it is the
  count-in and nothing else (README, "Time to the first note").

  **What the rate costs, measured per stem** (share of each stem's energy below the
  anti-alias cutoff of 0.42 × the target rate): the synthesized bass, keys and lead are
  band-limited by their own synthesis — 100.00 %, 100.00 % and 99.97 % of their energy is
  below 6.7 kHz, so they are effectively untouched. The drums are the only broadband stem and
  lose the hi-hat band above it: 11 % of that stem's energy, 0.9–1.3 dB of RMS. The attack
  and the kick/snare body are unaffected, so the 16th-note hat grid the patient plays against
  is still there — what is gone is the shimmer above 6.7 kHz. Decoding is identical either
  way and the sample-accurate start is unaffected: the mixer schedules decoded buffers, not
  files, and `decodeAudioData` resamples every stem to the context rate regardless.

  **The balance is re-matched after the resample** (`rebalanceAfterResample` in the
  generator). Because the lowpass only takes energy out of the drums, a naive low-rate build
  shipped demo-sunrise with the player stem just 0.67 dB above the bass — the mastering's
  decision undone by the delivery format. Every stem is scaled by `worstLoss / ownLoss`, so
  the RMS ratios are exactly those of the 44.1 kHz build and the whole song sits ~1 dB
  quieter (which only adds master headroom).

  Other options:
  1. **A different rate, no new tools.** Any rate from 8000 Hz to 44100 Hz works
     (`--rate 44100` restores the full-bandwidth build); the generator applies a 4th-order
     Butterworth lowpass at 0.42 × the target rate before decimating, and trims the result so
     the mastered peak is never pushed through full scale.
  2. **With ffmpeg** (smallest, ≈1.5 MB per stem): transcode once and point `stems[].file`
     at the `.ogg` files:
     `for s in drums bass keys lead; do ffmpeg -i stems/$s.wav -c:a libvorbis -q:a 5 stems/$s.ogg; done`
     Note what this costs in-app: the ranged audition (`src/session/audition.ts`) can slice a
     time range out of linear-PCM WAV arithmetically, and refuses anything else — so every
     "Listen" press falls back to downloading the whole song. That is a good trade for a
     deployment whose songs are all fetched ahead of time, and a bad one for a therapist
     auditioning three songs between patients.

  **Why not a compressed format in-repo:** Node has no built-in Vorbis/Opus/MP3 encoder and
  this repo may not add a dependency, so no compressed variant can be produced here and stay
  byte-reproducible. Bandwidth reduction is the only size lever the pipeline itself has.
* Memory, not just bandwidth: `StemMixer.loadSong` downloads the stems in parallel, so the
  raw bodies peak together (≈12.4 MB for the shipped 16 kHz demo-groove; ≈34 MB at 44.1 kHz), and `decodeAudioData` detaches each
  ArrayBuffer as it decodes it — but the decoded set stays resident: 4 stems × 97 s ×
  Float32 **at the AudioContext's rate** (decode always resamples to it) ≈ **74 MB** on a
  48 kHz context. Budget ~110 MB peak for a 4-stem 97 s song, on top of the MediaPipe wasm
  runtime and the pose model. The shipped 16 kHz build does **not** reduce this — it cuts the
  download (34 MB → 12.4 MB) only. Fewer or shorter stems is the only lever that moves the decoded
  figure, so prefer 2–4 stems and songs under ~2 minutes for tablet deployments.
* Safety: `song.json` is data, and this file invites you to paste manifests from third
  parties. `fetch-stems` refuses any `stems[].file` that is absolute or contains a `..`
  segment (it prints `REFUSED unsafe target` and counts it as a failure), and `--song`
  must be a plain song id, not a path.
* Stems must all start at the same time (sample 0 = same moment). Most ccMixter packs do;
  if one stem is shorter it simply ends early.
* Set `offset` carefully: notes are generated on the beat grid starting at `offset`.
* Set `swing` carefully too, for the same reason: `demo-sunrise` shuffles (`swing: 0.333`,
  a 50 ms push at 100 BPM), `demo-groove` is straight. A chart that ignores it asks the
  patient to move where the drum is not.
