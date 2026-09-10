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
import type { DifficultyName, LaneSpec, Mode } from '../engine/types.ts';
import { VisionInput } from '../input/VisionInput.ts';
import type { RomCalibration } from '../vision/calibration.ts';
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

function laneKey(req: VisionRequest): string {
  return `${req.mode}|${req.mirrored}|${req.lanes.map((l) => `${l.movement}:${l.side}`).join(',')}`;
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

  /**
   * The camera input for this prescription, created once and kept alive from the camera check through
   * calibration into play (re-opening the camera between screens costs seconds and loses the filter
   * state). Changing the lanes / mirror convention rebuilds it.
   */
  async ensureVision(req: VisionRequest): Promise<VisionInput> {
    const key = laneKey(req);
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
