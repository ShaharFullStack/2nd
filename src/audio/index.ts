/**
 * Beat Rehab audio module. Everything below is the whole integration surface — you should not
 * need to read the implementations.
 *
 * ```ts
 * // 1. after a user gesture (button click), create ONE AudioContext for the app
 * const mixer = new StemMixer({ ctx });          // or omit ctx and let it make one
 * await mixer.resumeContext();
 *
 * // 2. song select
 * const catalog = await loadSongCatalog('/songs'); // SongEntry[]: a song whose stems are not
 * //   downloaded yet comes back status 'needs-fetch' with `missingStems`, it never throws
 * const manifest = catalog[0].manifest!;
 * showAttribution(attributionText(manifest));    // required in song select AND results
 *
 * // 3. load (song select can already audition it: playPreview() never moves the transport)
 * await mixer.loadSong(manifest, '/songs', (p) => setProgress(p.fraction));
 * mixer.playPreview();                           // …and mixer.isPreviewing while it runs
 *
 * // 4. play
 * mixer.play();                                  // starts at song time 0, preview or not
 * engine.start(mixer.getSongStartCtxTime());     // ctx time of song time 0 — right after ANY
 * //                                                transport call (play/seek/preview/stop)
 * // …and on the therapist's pause button:
 * engine.pause(mixer.pause()!);  engine.resume((await mixer.resume())!);
 *
 * // 5. lanes → stems (once, after loadSong), then per judgment
 * mixer.setLaneCount(chart.lanes);               // each lane ducks its own stem where it can
 * mixer.onLaneHit(lane, combo);  sfx.play('perfect', undefined, { lane });
 * mixer.onLaneMiss(lane);        sfx.play('miss');   // dips THAT lane one step, never mutes it
 *
 * // 6. clocks
 * mixer.songTime()        // what the graph is producing — judge against this
 * mixer.displaySongTime() // what the listener hears (songTime − outputLatencySec) — DRAW this
 * ```
 *
 * Five things that are easy to get wrong:
 *  - **Charting a swung song.** Take note times from `stepTimeSec(manifest, step)`, not from
 *    `offset + step × beat/4`: `demo-sunrise` publishes `swing: 1/3`, so its odd 16ths are 50 ms
 *    late. Notes on downbeats and straight 8ths are unaffected either way. Nothing downstream can
 *    notice the mistake on its own (`Note` carries no swing), so assert it once where the chart is
 *    built: `assertChartOnGrid(manifest, chart.notes)` throws with the worst offender, and
 *    `findOffGridTimes()` returns them all.
 *  - **Transport order.** `play()` never inherits a position it was not given: it is a no-op while
 *    already playing, and a preview is unwound when it ends, so "select → preview → Start" begins
 *    the session at song time 0. Only `play(_, t)` / `seek(t)` move the position. Drive the engine
 *    clock from `getSongStartCtxTime()` rather than the return value and every order is safe.
 *  - **SFX and metronome routing.** Build them with `mixer.createSfx()` / `mixer.createLatencyProbe()`,
 *    never `new Sfx(ctx)` / `new LatencyProbe(ctx)`. Both bare constructors connect to
 *    `ctx.destination` and bypass the master limiter: the cues would clip on exactly the moments
 *    the patient is being rewarded (the music already runs at a ~0.91 ceiling), and the calibration
 *    metronome would be audibly louder than the game the patient walks into next.
 *  - **Rendering vs judging.** Draw `displaySongTime()`, judge `songTime()`. See
 *    `StemMixer.outputLatencySec`. `ctxTimeForSongTime()` is exact and invertible in every
 *    transport state (playing, paused, stopped) and agrees with the engine SongClock, so an
 *    input source may stamp events from it while the session is paused.
 *  - **Calibration.** `LatencyProbe` runs at 60 BPM, not the 100 BPM in the original spec (a
 *    deliberate deviation, documented at the top of latencyProbe.ts). Feed
 *    `LatencyProbeResult.offsetSec` to the engine when `accepted`; when `warning` is set also show
 *    `message` (the patient is slow but was measured correctly); when `!accepted`, `message` and
 *    `suggestedBpm` are the remedy to offer — never a bare "try again".
 */
export * from './manifest';
export * from './ducking';
export * from './StemMixer';
export * from './sfx';
export * from './latencyProbe';
