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
| `durationSec`, `previewStart` | length of the stems; where the preview snippet starts |
| `stems` | one entry per file, `file` is relative to the song folder |
| `playerStem` | id of the stem the patient controls |
| `remoteStems` | `{id, url}` pairs with the **direct file URLs** from ccMixter (right-click → copy link on each stem; zip archives are not unpacked) |

Then add the id to `public/songs/index.json`.

## 3. Download

```
npm run fetch-stems              # all songs
npm run fetch-stems -- --song my-song --force
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
* Stems must all start at the same time (sample 0 = same moment). Most ccMixter packs do;
  if one stem is shorter it simply ends early.
* Set `offset` carefully: notes are generated on the beat grid starting at `offset`.
