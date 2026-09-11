# Working on Beat Rehab

A camera-controlled rhythm game for physiotherapy. Read `docs/ARCHITECTURE.md` before
changing anything: it is the contract every module follows, not a description written after
the fact. `README.md` explains what the game is.

## Ground rules

- **The patient is not a controller.** Lanes are prescribed exercises, not colours. The
  engine never penalises extra movement (tremor and spasticity are symptoms, not mistakes),
  a song can never be failed out of, and nothing on screen may read as a clinical
  measurement it is not.
- **Never let a number lie.** If the code cannot produce a state, do not document it; if a
  measurement is uncertain, say so where it is shown. Several rounds of review here were
  spent on exactly this class of bug — a caption promising a cue the renderer could not
  draw, a dose figure computed per lane and labelled per limb, a calibration accepted for
  the wrong limb.
- **Verify in the running app.** Unit tests cover the maths; the harnesses in `critic/`
  cover the claim. If you change something visual or behavioural, drive it and look at the
  screenshots.

## Commands

```bash
npm run dev                  # localhost:5173
npm test                     # vitest
npm run typecheck            # tsc -b
npm run build
npm run critic:smoke         # plays a whole session in headless Chromium and asserts on it
npm run critic:frames        # 1080p gameplay frames
npm run critic:motion        # frame bursts across a hit and a miss, plus pacing and clock drift
npm run critic:audio         # proves the player's stem follows the patient
```

Playwright's Chromium is pre-installed at `/opt/pw-browsers/chromium`; pass it as
`executablePath` rather than downloading a browser.

## Conventions

- TypeScript is strict, with `noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax`
  and `erasableSyntaxOnly` — so no enums and no parameter properties.
- Canonical types live in `src/engine/types.ts`, `src/input/types.ts` and
  `src/session/types.ts`. Add exports; do not quietly change existing ones.
- `src/engine/` and `src/charts/` are pure TypeScript with no DOM. Keep them that way: they
  are the only parts that can be reasoned about frame by frame in a test.
- `AudioContext.currentTime` is the one clock. Anything that needs song time asks the mixer.
- No new npm dependencies without a reason that survives being written down.

## Testing without a camera

`?input=keyboard` maps lanes to `1`–`4` / `D F J K`, `?input=autoplay` runs a bot, and
`?demo=highway` mounts the renderer alone. `window.__beatRehab` exposes the store, runtime
and score for harnesses. Sessions run on these inputs are marked as device tests and are
kept out of any patient's record and trend — do not weaken that.
