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
import type { SongEntry, SongManifest } from '../audio/manifest.ts';
import { Sfx } from '../audio/sfx.ts';
import { StemMixer } from '../audio/StemMixer.ts';
import type { LoadProgress } from '../audio/StemMixer.ts';
import { DIFFICULTIES } from '../engine/difficulty.ts';
import type { DifficultyName, Fingertip, LaneSpec, Mode } from '../engine/types.ts';
import { VisionInput } from '../input/VisionInput.ts';
import type { RomCalibration } from '../vision/calibration.ts';
import { laneFingertip } from '../state/store.ts';
import type { GameRunner } from './GameRunner.ts';

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

class SessionRuntime {
  private audio: AudioHandles | null = null;
  private vision: VisionInput | null = null;
  private visionKey = '';
  private catalog: Promise<SongEntry[]> | null = null;
  private loadedSongId: string | null = null;
  private loading: Promise<SongManifest | null> | null = null;
  private loadingId: string | null = null;

  /** The runner for the session in progress (exposed on window.__beatRehab for critics). */
  runner: GameRunner | null = null;

  /** Create (or return) the one AudioContext. MUST be called from a user gesture handler. */
  async ensureAudio(): Promise<AudioHandles> {
    if (!this.audio) {
      const mixer = new StemMixer();
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
    const { mixer } = await this.ensureAudio();
    // A song-select audition must never survive into the load of another song (its fade-out timer and
    // its held-aside position both belong to the song being replaced).
    this.stopPreview();
    if (this.loadedSongId === songId && mixer.isLoaded) return mixer.manifest;
    if (this.loading && this.loadingId === songId) return this.loading;
    this.loadingId = songId;
    this.loading = (async () => {
      const entry = await loadSongEntry(songId);
      if (entry.status !== 'ready' || !entry.manifest) {
        this.loadedSongId = null;
        return null;
      }
      await mixer.loadSong(entry.manifest, '/songs', onProgress);
      this.loadedSongId = songId;
      return entry.manifest;
    })();
    try {
      return await this.loading;
    } finally {
      this.loading = null;
      this.loadingId = null;
    }
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
  async previewSong(songId: string, durationSec?: number): Promise<SongManifest | null> {
    const { mixer } = await this.ensureAudio();
    const manifest = await this.loadSong(songId);
    if (!manifest || !mixer.isLoaded) return null;
    mixer.playPreview(durationSec);
    return manifest;
  }

  /** Stop a running audition and put the transport back where it was (no-op otherwise). */
  stopPreview(): void {
    const mixer = this.audio?.mixer;
    if (mixer?.isPreviewing) mixer.pause();
  }

  /** The song currently being auditioned, or null when nothing is. */
  previewingSongId(): string | null {
    const mixer = this.audio?.mixer;
    return mixer?.isPreviewing ? (mixer.manifest?.id ?? this.loadedSongId) : null;
  }

  /**
   * The camera input for this prescription, created once and kept alive from the camera check through
   * calibration into play (re-opening the camera between screens costs seconds and loses the filter
   * state). Changing the lanes / mirror convention rebuilds it.
   */
  async ensureVision(req: VisionRequest): Promise<VisionInput> {
    const key = visionLaneKey(req);
    if (this.vision && this.visionKey === key) {
      req.calibrations.forEach((cal, i) => {
        if (cal) this.vision?.setCalibration(i, cal);
      });
      this.vision.setThresholdFraction(DIFFICULTIES[req.difficulty].thresholdFraction);
      if (!this.vision.isRunning()) await this.vision.start();
      return this.vision;
    }
    this.disposeVision();
    const { ctx } = await this.ensureAudio();
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

  /** Release everything (leaving the app / a fatal error). */
  dispose(): void {
    this.runner?.dispose();
    this.runner = null;
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
