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
 * // 3. load + play
 * await mixer.loadSong(manifest, '/songs', (p) => setProgress(p.fraction));
 * const startCtxTime = mixer.play();             // the ctx time the audio thread actually honoured
 * engine.start(startCtxTime);                    // drive the engine SongClock with this exact value
 * // …and on the therapist's pause button:
 * engine.pause(mixer.pause()!);  engine.resume((await mixer.resume())!);
 *
 * // 4. per judgment
 * mixer.onHit(combo);  sfx.play('perfect', undefined, { lane });
 * mixer.onMiss();      sfx.play('miss');
 *
 * // 5. clocks
 * mixer.songTime()        // what the graph is producing — judge against this
 * mixer.displaySongTime() // what the listener hears (songTime − outputLatencySec) — DRAW this
 * ```
 *
 * Four things that are easy to get wrong:
 *  - **Charting a swung song.** Take note times from `stepTimeSec(manifest, step)`, not from
 *    `offset + step × beat/4`: `demo-sunrise` publishes `swing: 1/3`, so its odd 16ths are 50 ms
 *    late. Notes on downbeats and straight 8ths are unaffected either way.
 *  - **SFX routing.** Build them with `mixer.createSfx()`, never `new Sfx(ctx)`. A bare Sfx
 *    connects to `ctx.destination` and bypasses the master limiter, and the music already runs at
 *    a ~0.9 ceiling — the cues would clip on exactly the moments the patient is being rewarded.
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
