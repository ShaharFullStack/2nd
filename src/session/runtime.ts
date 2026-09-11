/**
 * Live, non-serializable handles shared by the screens: the AudioContext, the mixer, the SFX bus and
 * the camera input. Deliberately NOT in the zustand store — React must never re-render because a
 * GainNode changed.
 *
 * The AudioContext is created on the first user gesture (`ensureAudio`, called from a click handler)
 * and then reused for the whole visit: the camera timestamps, the song clock and the judgment windows
 * all live on that one clock, so a second context would silently desynchronise the session.
 */
import { loadSongCatalog, loadSongEntry } from '../audio/manifest.ts';
import { cachingStemFetch } from './stemCache.ts';
import type { SongEntry, SongManifest } from '../audio/manifest.ts';
import { Sfx } from '../audio/sfx.ts';
import { StemMixer } from '../audio/StemMixer.ts';
import type { LoadProgress } from '../audio/StemMixer.ts';
import { DIFFICULTIES } from '../engine/difficulty.ts';
import type { DifficultyName, Fingertip, LaneSpec, Mode } from '../engine/types.ts';
import { VisionInput } from '../input/VisionInput.ts';
import type { RomCalibration } from '../vision/calibration.ts';
import { laneFingertip, useStore } from '../state/store.ts';
import type { Screen } from '../state/store.ts';
import type { GameRunner } from './GameRunner.ts';
import { AUDITION_SEC, Audition } from './audition.ts';
import type { AuditionProgress } from './audition.ts';

/** How long to wait for the audio clock before calling it a missing-gesture failure. */
const AUDIO_CLOCK_TIMEOUT_MS = 4000;

/**
 * Resolve the audio handles, or reject with a message `classifyCameraError` turns into the
 * "the browser is waiting for a tap" screen. Never leaves the caller waiting forever.
 */
async function withAudioClockTimeout<T>(p: Promise<T>, ms = AUDIO_CLOCK_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('The audio clock could not be started: the browser is waiting for a tap on the page.')),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export interface AudioHandles {
  ctx: AudioContext;
  mixer: StemMixer;
  sfx: Sfx;
}

export interface VisionRequest {
  mode: Mode;
  lanes: LaneSpec[];
  calibrations: (RomCalibration | null)[];
  difficulty: DifficultyName;
  mirrored: boolean;
}

/**
 * Identity of the vision pipeline a request needs. The FINGERTIP is part of it: a finger_opposition
 * lane measures `1 - tip-to-thumb distance / palm size` for one specific tip, so re-pointing a live
 * index pipeline at the pinky would keep normalizing the new movement by the old tip's range (and
 * VisionInput refuses the pairing outright). Changing it must rebuild, exactly like changing the side.
 */
export function visionLaneKey(req: Pick<VisionRequest, 'mode' | 'mirrored' | 'lanes'>): string {
  const lane = (l: LaneSpec): string => `${l.movement}:${l.side}${laneFingertip(l) ? `:${laneFingertip(l)}` : ''}`;
  return `${req.mode}|${req.mirrored}|${req.lanes.map(lane).join(',')}`;
}

/** Per-lane feature options for a prescription — today, the therapist's fingertip choice. */
export function laneFeatureOptions(lanes: readonly LaneSpec[]): ({ fingertip?: Fingertip } | undefined)[] {
  return lanes.map((l) => {
    const fingertip = laneFingertip(l);
    return fingertip ? { fingertip } : undefined;
  });
}

/**
 * THE SCREENS THAT ARE ALLOWED TO HOLD THE CAMERA OPEN, and nothing else is.
 *
 * A camera session used to keep the device streaming for the rest of the visit: the runner was built
 * with `stopInputOnDispose: inputMode !== 'camera'` ("camera sessions keep the camera open for the
 * next song"), and nothing on the way out of play ever closed it. So after the last song the camera
 * light stayed on, MediaPipe kept inferring on every frame, and the tablet kept burning battery in a
 * room the patient had already left — with a recording indicator lit over a clinical session that had
 * ended. On a shared device that is both a privacy problem and a flat battery by the afternoon.
 *
 * The fast path it was bought for is real but narrow: these four screens hand over to each other
 * inside a single prescription (camera check → ROM → latency → play, and back for a re-calibration),
 * and re-opening the device between them costs seconds and throws away the smoothing filters' warm
 * state mid-session. THOSE are the screens that need frames within seconds of arriving. Every other
 * destination — results, history, setup, the patient list, home — means the session is over or has
 * not been prescribed yet, and the camera is released.
 *
 * "Play again" from the results screen re-opens it, which is the right trade: a second song starts
 * with a song load and a 3-2-1 count-in anyway, and the alternative is the light staying on through
 * every gap between patients.
 */
const CAMERA_SCREENS: ReadonlySet<Screen> = new Set<Screen>(['camera', 'rom', 'latency', 'play']);

/** True when `screen` consumes camera frames within seconds of being shown. */
export function screenNeedsCamera(screen: Screen): boolean {
  return CAMERA_SCREENS.has(screen);
}

/**
 * Call `onScreen` with every screen the app navigates TO. Exported (rather than inlined in the
 * runtime) so the release rule can be exercised without a camera: the rule is "release on arriving
 * anywhere that does not need frames", and the arrival is the half that a unit test can reach.
 */
export function watchScreenChanges(onScreen: (screen: Screen) => void): () => void {
  return useStore.subscribe((state, prev) => {
    if (state.screen !== prev.screen) onScreen(state.screen);
  });
}

/** What an audition may report and how it is cancelled. */
export interface PreviewOptions {
  /** Bytes and stems of the cheap audition, so a screen can show what it is costing. */
  onProgress?: (p: AuditionProgress) => void;
  /** Byte progress of the FALLBACK full load (the expensive path). */
  onLoadProgress?: (p: LoadProgress) => void;
  /** Cancel: aborts the fetches in flight. `stopPreview()` does the same thing. */
  signal?: AbortSignal;
}

class SessionRuntime {
  private audio: AudioHandles | null = null;
  private vision: VisionInput | null = null;
  private visionKey = '';
  private catalog: Promise<SongEntry[]> | null = null;
  private screenWatch: (() => void) | null = null;
  private audition: Audition | null = null;
  private loadedSongId: string | null = null;
  private loading: Promise<SongManifest | null> | null = null;
  private loadingId: string | null = null;
  /** Cancels the audition in flight — its ranged fetches AND its whole-song fallback. */
  private previewAbort: AbortController | null = null;
  /** True when the load `this.loading` refers to was cancelled and will resolve to nothing. */
  private loadCancelled = false;
  /**
   * True only while the load in flight was STARTED BY the audition's fallback.
   *
   * Cancelling an audition cancels the download it started — but since `prefetchSong` there may be a
   * load in flight that the audition merely joined, and that one belongs to the session the therapist
   * is about to start. Unloading it (or marking it cancelled) because they stopped listening would
   * throw away the download the Start button is waiting for, and start it again from zero.
   */
  private previewOwnsLoad = false;
  /** The song `prefetchSong` has a load running for, or null. */
  private prefetchId: string | null = null;
  /**
   * Progress sinks for the ONE load in flight, and the last event it produced.
   *
   * A load is shared (`loadSongNow` hands the in-flight promise to a second caller for the same song),
   * and only the first caller's `onProgress` used to be wired to the mixer. Once the download starts
   * before Start is pressed — a prefetch with no progress bar to feed — the Play screen would join it
   * and show a bar frozen at 0 % for the whole download. Listeners are per-caller and the latest event
   * is replayed to a late joiner, so the bar is the load's progress whoever started it.
   */
  private loadProgress = new Set<(p: LoadProgress) => void>();
  private lastLoadProgress: LoadProgress | null = null;

  /** The runner for the session in progress (exposed on window.__beatRehab for critics). */
  runner: GameRunner | null = null;

  /** Create (or return) the one AudioContext. MUST be called from a user gesture handler. */
  async ensureAudio(): Promise<AudioHandles> {
    if (!this.audio) {
      // THE MIXER FETCHES THROUGH THE APP'S OWN STEM CACHE (session/stemCache.ts). The first session
      // on a tablet pays for the song; a reload, the next patient, or a therapist who pressed Start
      // on sight does not — whatever cache headers the clinic's server happens to send. It degrades
      // to a plain fetch wherever Cache Storage is unavailable.
      const mixer = new StemMixer({ fetch: cachingStemFetch() });
      this.audio = { ctx: mixer.ctx, mixer, sfx: mixer.createSfx() };
    }
    await this.audio.mixer.resumeContext();
    return this.audio;
  }

  /** The audio handles if they already exist (never creates a context outside a gesture). */
  peekAudio(): AudioHandles | null {
    return this.audio;
  }

  songCatalog(force = false): Promise<SongEntry[]> {
    if (force || !this.catalog) this.catalog = loadSongCatalog();
    return this.catalog;
  }

  /**
   * Load a song into the mixer (idempotent per song id). Returns null when the song has no playable
   * stems — the session then runs silently rather than refusing to start.
   */
  async loadSong(songId: string, onProgress?: (p: LoadProgress) => void): Promise<SongManifest | null> {
    await this.ensureAudio();
    // A song-select audition must never survive into the load of another song (its fade-out timer and
    // its held-aside position both belong to the song being replaced).
    this.stopPreview();
    return this.loadSongNow(songId, onProgress);
  }

  /**
   * The load itself, WITHOUT stopping the audition first.
   *
   * `previewSong`'s fallback path is a load that belongs to an audition rather than replacing one:
   * routing it through the public `loadSong` would have the load cancel the very request that
   * started it (`stopPreview` aborts the in-flight preview), so the therapist's press would abort
   * itself the moment it fell back.
   */
  private async loadSongNow(songId: string, onProgress?: (p: LoadProgress) => void): Promise<SongManifest | null> {
    const { mixer } = await this.ensureAudio();
    if (this.loadedSongId === songId && mixer.isLoaded) return mixer.manifest;
    // Share a load already running for this song — UNLESS it has been cancelled. A cancelled load is
    // a promise that will resolve to nothing, and handing it to the Start button (a therapist who
    // stopped an audition of the song they then prescribed) would start the session in silence.
    if (this.loading && this.loadingId === songId && !this.loadCancelled) {
      return this.withProgress(onProgress, this.loading);
    }
    this.loadCancelled = false;
    const load = (async () => {
      const entry = await loadSongEntry(songId);
      if (entry.status !== 'ready' || !entry.manifest) {
        this.loadedSongId = null;
        return null;
      }
      this.lastLoadProgress = null;
      await mixer.loadSong(entry.manifest, '/songs', (p) => {
        this.lastLoadProgress = p;
        for (const cb of [...this.loadProgress]) {
          try {
            cb(p);
          } catch (err) {
            console.warn('[runtime] a load-progress listener threw', err);
          }
        }
      });
      // A load that was cancelled (`mixer.unload()` from a cancelled audition, or a newer load)
      // resolves QUIETLY with nothing in the mixer. Claiming the song is loaded would make the next
      // `loadSong` for it a no-op and start a session against an empty mixer.
      this.loadedSongId = mixer.isLoaded ? songId : null;
      return mixer.isLoaded ? entry.manifest : null;
    })();
    this.loading = load;
    this.loadingId = songId;
    try {
      return await this.withProgress(onProgress, load);
    } finally {
      // Identity-guarded: a cancelled load that settles late must not clear the bookkeeping of the
      // load that replaced it.
      if (this.loading === load) {
        this.loading = null;
        this.loadingId = null;
        this.loadCancelled = false;
      }
    }
  }

  /** Run `p` with `onProgress` subscribed to the load in flight (and caught up to where it is). */
  private async withProgress<T>(onProgress: ((p: LoadProgress) => void) | undefined, p: Promise<T>): Promise<T> {
    if (!onProgress) return p;
    this.loadProgress.add(onProgress);
    if (this.lastLoadProgress) onProgress(this.lastLoadProgress);
    try {
      return await p;
    } finally {
      this.loadProgress.delete(onProgress);
    }
  }

  /**
   * START THE DOWNLOAD WHEN THE SONG IS CHOSEN, NOT WHEN THE PATIENT IS SITTING IN FRONT OF THE
   * CAMERA WAITING FOR IT.
   *
   * Every byte of the song used to be fetched after Start: measured against the production build
   * over a throttled 8 Mbit/s link, 34 MB and 38.7 s from pressing Start to the first note, with a
   * progress bar and a patient already in position for all of it. The stems are half of that fix
   * (public/songs ships a 16 kHz build now, 12 MB); THIS is the other half — between the therapist
   * choosing the song and the first note there is a camera check and two calibrations, minutes of
   * work that need no audio at all, and the download fits inside them.
   *
   * Fire-and-forget, and deliberately unable to hurt anything:
   *  - it never throws (a failed prefetch is a slower Start, not an error the therapist sees);
   *  - it does nothing while an audition is in flight — the therapist is listening to a song they
   *    have not chosen yet, and the audition's own ranged fetches are the cheap path;
   *  - `loadSongNow` is idempotent per song, so pressing Start joins this download rather than
   *    starting a second one, and the Play screen's progress bar joins with it (`withProgress`).
   * Choosing a different song simply prefetches that one; `mixer.loadSong` unloads the previous.
   */
  prefetchSong(songId: string): void {
    if (!songId) return;
    const mixer = this.audio?.mixer;
    if (this.loadedSongId === songId && mixer?.isLoaded) return;
    if (this.prefetchId === songId) return;
    // An audition owns the network (and the mixer) while it runs; its own load is the fallback path.
    if (this.previewAbort) return;
    this.prefetchId = songId;
    void (async () => {
      try {
        await withAudioClockTimeout(this.ensureAudio());
        await this.loadSongNow(songId);
      } catch (err) {
        console.warn('[runtime] prefetching the song failed; the session will load it at Start', err);
      } finally {
        if (this.prefetchId === songId) this.prefetchId = null;
      }
    })();
  }

  getMixerManifest(): SongManifest | null {
    return this.audio?.mixer.manifest ?? null;
  }

  // ------------------------------------------------------------------ song audition (Setup screen)

  /**
   * Audition `songId` from its manifest `previewStart` for `durationSec`, fading out at the end and
   * stopping itself. MUST be called from a user gesture (it creates/resumes the AudioContext).
   *
   * Returns the manifest that is playing, or null when the song has no playable stems (the therapist
   * is told; the session would run silently too).
   *
   * A preview is a TEMPORARY segment: the mixer holds the transport's real position aside and puts it
   * back when the preview ends, so pressing Start straight after an audition begins the prescribed
   * session at song time 0 — not 30 s in. See StemMixer.playPreview and previewFlow.test.ts.
   */
  async previewSong(songId: string, durationSec?: number, options: PreviewOptions = {}): Promise<SongManifest | null> {
    const { mixer, ctx } = await this.ensureAudio();
    const seconds = durationSec ?? AUDITION_SEC;

    // ALREADY IN MEMORY: the song this session is about to play is loaded whole, so auditioning it
    // from the mixer's own buffers costs nothing and keeps the well-worn transport path (which holds
    // the session position aside and restores it — see previewFlow.test.ts).
    if (this.loadedSongId === songId && mixer.isLoaded) {
      this.stopPreview();
      mixer.playPreview(seconds);
      return mixer.manifest;
    }

    const entry = await loadSongEntry(songId);
    if (options.signal?.aborted) return null;
    if (entry.status !== 'ready' || !entry.manifest) return null;
    const manifest = entry.manifest;

    // ONE CANCEL FOR THE WHOLE PRESS. Everything the audition may do — ranged stem windows, and the
    // whole-song fallback underneath them — hangs off this controller, so `stopPreview()` and the
    // caller's own signal are the same escape hatch, whichever half of the work is in flight.
    this.stopPreview();
    const abort = new AbortController();
    this.previewAbort = abort;
    const onOuterAbort = (): void => abort.abort();
    options.signal?.addEventListener('abort', onOuterAbort, { once: true });

    try {
      // THE CHEAP PATH: fetch only the seconds that will be heard (src/session/audition.ts). It plays
      // on its own sources into the master bus, so the session transport is never moved at all.
      if (!this.audition) this.audition = new Audition(ctx, mixer.master);
      const played = await this.audition.play(manifest, {
        durationSec: seconds,
        onProgress: options.onProgress,
        signal: abort.signal,
      });
      if (played) return manifest;
      if (abort.signal.aborted) return null;

      // THE FALLBACK, for a stem that cannot be sliced (not linear-PCM WAV) or a server that ignores
      // range requests: load the song whole, exactly as before. Slower, never broken — and the load is
      // not wasted if this is the song the therapist prescribes.
      //
      // THIS is the expensive path, so this is the one that must be stoppable: `mixer.unload()`
      // aborts the in-flight stem downloads, which is what a cancel during a 34 MB load has to mean.
      // 90 seconds between patients is not enough to sit through a download nobody wants any more.
      //
      // UNLESS THE DOWNLOAD IS NOT THIS AUDITION'S TO CANCEL. `prefetchSong` may already have a load
      // running for this song — the one the Start button is waiting for — and this fallback would
      // simply join it. Stopping the audition then has to stop LISTENING, not throw away a download
      // that was started for the session.
      const joined = this.loading !== null && this.loadingId === songId && !this.loadCancelled;
      this.previewOwnsLoad = !joined;
      const onAbortLoad = (): void => {
        if (joined) return;
        try {
          mixer.unload();
        } catch (err) {
          console.warn('[runtime] cancelling the song load failed', err);
        }
      };
      abort.signal.addEventListener('abort', onAbortLoad, { once: true });
      try {
        // Raced against the cancel, because a JOINED load does not stop when the audition does: the
        // caller (the Setup screen's Listen button) has to be released the moment the therapist
        // presses stop, not when the session's download finishes minutes later.
        const loaded = await Promise.race([
          this.loadSongNow(songId, options.onLoadProgress),
          new Promise<null>((resolve) => {
            if (abort.signal.aborted) resolve(null);
            else abort.signal.addEventListener('abort', () => resolve(null), { once: true });
          }),
        ]);
        if (abort.signal.aborted || !loaded || !mixer.isLoaded) return null;
        mixer.playPreview(seconds);
        return loaded;
      } finally {
        abort.signal.removeEventListener('abort', onAbortLoad);
        this.previewOwnsLoad = false;
      }
    } finally {
      options.signal?.removeEventListener('abort', onOuterAbort);
      if (this.previewAbort === abort) this.previewAbort = null;
    }
  }

  /**
   * Stop a running audition — including cancelling one that is still downloading, whether that is the
   * ranged windows or the whole-song fallback underneath them (no-op when nothing is in flight).
   */
  stopPreview(): void {
    if (this.previewAbort) {
      // Whatever this abort takes down may include a whole-song load in flight; the next caller that
      // wants that song must start its own rather than await this one's corpse. Only when the load is
      // the AUDITION'S OWN, though — a prefetched session load it merely joined survives the cancel
      // (see `previewOwnsLoad`), because nothing about it was cancelled.
      if (this.previewOwnsLoad) this.loadCancelled = true;
      this.previewAbort.abort();
    }
    this.previewAbort = null;
    this.audition?.stop();
    const mixer = this.audio?.mixer;
    if (mixer?.isPreviewing) mixer.pause();
  }

  /** The song currently being auditioned, or null when nothing is. */
  previewingSongId(): string | null {
    if (this.audition?.songId) return this.audition.songId;
    const mixer = this.audio?.mixer;
    return mixer?.isPreviewing ? (mixer.manifest?.id ?? this.loadedSongId) : null;
  }

  /**
   * The camera input for this prescription, created once and kept alive from the camera check through
   * calibration into play (re-opening the camera between screens costs seconds and loses the filter
   * state). Changing the lanes / mirror convention rebuilds it.
   */
  async ensureVision(req: VisionRequest): Promise<VisionInput> {
    this.watchScreens();
    const key = visionLaneKey(req);
    if (this.vision && this.visionKey === key) {
      // Hand EVERY lane's calibration over, including a null one. `visionLaneKey` deliberately does not
      // include the ranges, so a reused VisionInput is the only record of them: skipping the nulls left
      // a cleared or removed calibration LIVE inside the pipeline, still scoring, with the store
      // believing the lane was uncalibrated.
      //
      // The boolean is the vetting verdict (a range measured on another fingertip, or under the other
      // mirror convention, is refused here) and it is not thrown away: the refused lane keeps its
      // reason in `getInvalidCalibrations()`, which the camera-check, ROM and play screens read and
      // show. Collected so this boundary can say out loud what it refused, rather than only the module.
      const refused: number[] = [];
      req.calibrations.forEach((cal, i) => {
        const laneIndex = req.lanes[i]?.index ?? i;
        if (this.vision?.setCalibration(laneIndex, cal ?? null) === false) refused.push(laneIndex + 1);
      });
      if (refused.length > 0) {
        console.error(
          `[runtime] lane${refused.length > 1 ? 's' : ''} ${refused.join(', ')}: the stored calibration was refused and will not score. See VisionInput.getInvalidCalibrations() — the camera check, calibration and play screens show the reason.`,
        );
      }
      this.vision.setThresholdFraction(DIFFICULTIES[req.difficulty].thresholdFraction);
      if (!this.vision.isRunning()) await this.vision.start();
      return this.vision;
    }
    this.disposeVision();
    // BOUNDED, because an unbounded wait here is an unexplained spinner. Chrome leaves
    // `AudioContext.resume()` PENDING FOREVER when the page has had no user gesture (a reload on the
    // camera screen, or a deep link into it), and camera frames are timestamped against that clock —
    // so the camera check used to sit on "Starting the camera…" indefinitely with nothing thrown and
    // nothing to show. Time it out into a classified failure whose remedy is a single tap; pressing
    // Retry on the fallback screen IS that tap, so the next attempt succeeds.
    const { ctx } = await withAudioClockTimeout(this.ensureAudio());
    const vision = new VisionInput({
      mode: req.mode,
      lanes: req.lanes,
      calibrations: req.calibrations,
      thresholdFraction: DIFFICULTIES[req.difficulty].thresholdFraction,
      audioContext: ctx,
      mirrored: req.mirrored,
      featureOptions: laneFeatureOptions(req.lanes),
    });
    this.vision = vision;
    this.visionKey = key;
    await vision.start();
    return vision;
  }

  peekVision(): VisionInput | null {
    return this.vision;
  }

  /**
   * Release the camera unless `screen` is one that needs it within seconds (`screenNeedsCamera`).
   * Returns true when the device was actually released. The rule in one function so every caller —
   * and every test — is arguing with the same statement of it.
   */
  releaseVisionUnless(screen: Screen): boolean {
    if (screenNeedsCamera(screen)) return false;
    if (!this.vision) return false;
    this.disposeVision();
    return true;
  }

  /**
   * Arm the rule for the whole visit, from the moment a camera first exists. Installed here rather
   * than in a screen because the screen that OPENS the camera is never the one that is standing
   * there when it should be closed — a fatal error, a Back button on the ROM screen and a deep link
   * home all leave play without unmounting anything that knows about the device.
   */
  private watchScreens(): void {
    if (this.screenWatch) return;
    this.screenWatch = watchScreenChanges((screen) => this.releaseVisionUnless(screen));
  }

  disposeVision(): void {
    if (!this.vision) return;
    try {
      this.vision.stop();
    } catch (err) {
      console.warn('[runtime] vision stop failed', err);
    }
    this.vision = null;
    this.visionKey = '';
  }

  /**
   * Release everything (leaving the app / a fatal error).
   *
   * Called by the app's error boundary (src/App.tsx): a render that throws does not change `screen`,
   * so neither the screen watch nor the Play screen's effect cleanup fires — and without this the
   * camera light would stay on above a crashed page for as long as the tab is open.
   */
  dispose(): void {
    this.stopPreview();
    this.prefetchId = null;
    this.loadProgress.clear();
    this.lastLoadProgress = null;
    // The load in flight is disowned here, not just cancelled: `mixer.dispose()` below aborts its
    // downloads, and the next caller must start a fresh load rather than await a promise that
    // belongs to a mixer this runtime no longer has. (The load's own `finally` is identity-guarded,
    // so it cannot clear the bookkeeping of whatever replaces it.)
    this.loading = null;
    this.loadingId = null;
    this.loadCancelled = false;
    this.audition = null;
    this.runner?.dispose();
    this.runner = null;
    this.screenWatch?.();
    this.screenWatch = null;
    this.disposeVision();
    if (this.audio) {
      try {
        this.audio.mixer.dispose();
      } catch (err) {
        console.warn('[runtime] mixer dispose failed', err);
      }
      this.audio = null;
    }
    this.loadedSongId = null;
  }
}

export const runtime = new SessionRuntime();
