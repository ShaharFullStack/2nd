/**
 * THE SONG DOWNLOADS WHILE THE PRESCRIPTION IS BEING WRITTEN, NOT WHILE THE PATIENT WAITS.
 *
 * Measured against the production build over a throttled 8 Mbit/s link: 34 MB and 38.7 s from
 * pressing Start to the first note, every byte of it fetched after the click. Half the fix is the
 * stems themselves (public/songs ships a 16 kHz build, 12 MB); this is the other half — and the
 * things it must not break are what this file pins:
 *  - one download, however many times the prefetch is asked for, and Start JOINS it rather than
 *    starting a second copy;
 *  - the Play screen's progress bar shows that shared load's progress even though it did not start it;
 *  - stopping an audition cancels the audition, not the session's download.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SongManifest } from '../audio/manifest.ts';
import type { LoadProgress } from '../audio/StemMixer.ts';

const MANIFEST = {
  id: 'demo', title: 'Demo', artist: 'A', license: 'CC0', bpm: 120, offset: 0, durationSec: 60, previewStart: 30,
  stems: [{ id: 'drums', file: 'stems/drums.wav', label: 'Drums' }],
  playerStem: 'drums',
} as unknown as SongManifest;

/** A mixer whose `loadSong` hangs until the test lets it finish — or until `unload()` cancels it. */
class FakeMixer {
  static live: FakeMixer;
  ctx = { currentTime: 0 } as unknown as AudioContext;
  master = {} as AudioNode;
  manifest: SongManifest | null = null;
  isLoaded = false;
  isPreviewing = false;
  loads = 0;
  unloads = 0;
  previews = 0;
  private finish: (() => void) | null = null;
  private report: ((p: LoadProgress) => void) | null = null;

  constructor() {
    FakeMixer.live = this;
  }
  async resumeContext(): Promise<void> {}
  createSfx(): unknown {
    return {};
  }
  async loadSong(manifest: SongManifest, _base?: string, onProgress?: (p: LoadProgress) => void): Promise<void> {
    this.loads++;
    this.report = onProgress ?? null;
    await new Promise<void>((resolve) => {
      this.finish = resolve;
    });
    if (this.isLoaded) this.manifest = manifest;
  }
  /** Emit one byte-progress event from inside the load in flight. */
  progress(fraction: number): void {
    this.report?.({
      fraction, bytesLoaded: fraction * 100, bytesTotal: 100, bytesTotalKnown: true,
      stemsDecoded: 0, stemCount: 1, stemId: 'drums', phase: 'downloading',
    });
  }
  completeLoad(): void {
    this.isLoaded = true;
    this.finish?.();
    this.finish = null;
  }
  unload(): void {
    this.unloads++;
    this.isLoaded = false;
    this.manifest = null;
    this.finish?.();
    this.finish = null;
  }
  playPreview(): void {
    this.previews++;
    this.isPreviewing = true;
  }
  pause(): void {
    this.isPreviewing = false;
  }
  /** StemMixer.dispose() unloads (and so aborts a load in flight); the fake has to as well. */
  dispose(): void {
    this.unload();
  }
}

vi.mock('../audio/StemMixer.ts', () => ({ StemMixer: FakeMixer }));
vi.mock('../audio/manifest.ts', () => ({
  loadSongCatalog: vi.fn(async () => []),
  loadSongEntry: vi.fn(async () => ({ id: 'demo', status: 'ready', manifest: MANIFEST, missingStems: [] })),
  attributionText: () => '',
}));
// The ranged audition always refuses here, so every audition falls back to a whole-song load — the
// path that can collide with a prefetch.
vi.mock('./audition.ts', async (orig) => ({
  ...(await orig<typeof import('./audition.ts')>()),
  Audition: class {
    songId: string | null = null;
    async play(): Promise<boolean> {
      return false;
    }
    stop(): void {}
  },
}));

const { runtime } = await import('./runtime.ts');

beforeEach(() => {
  runtime.dispose();
});

/**
 * Let everything in flight settle. A prefetch is deliberately fire-and-forget — nothing hands the
 * caller a promise to await — so the test drains the microtask/timer queue a few times instead.
 */
const tick = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

describe('prefetching the prescribed song', () => {
  it('downloads it once, however many times it is asked for', async () => {
    runtime.prefetchSong('demo');
    runtime.prefetchSong('demo');
    await tick();
    const mixer = FakeMixer.live;
    expect(mixer.loads).toBe(1);
    runtime.prefetchSong('demo');
    await tick();
    expect(mixer.loads).toBe(1);
  });

  it('is what Start waits on: the session joins the download rather than starting a second one', async () => {
    runtime.prefetchSong('demo');
    await tick();
    const mixer = FakeMixer.live;
    expect(mixer.loads).toBe(1);

    const started = runtime.loadSong('demo');
    await tick();
    expect(mixer.loads).toBe(1); // joined
    mixer.completeLoad();
    expect(await started).toBe(MANIFEST);
  });

  it('feeds the Play screen\'s progress bar from a load it did not start', async () => {
    runtime.prefetchSong('demo');
    await tick();
    const mixer = FakeMixer.live;
    mixer.progress(0.4); // happened before the play screen existed

    const seen: number[] = [];
    const started = runtime.loadSong('demo', (p) => seen.push(p.fraction));
    await tick();
    // the bar starts where the download actually is, not at zero…
    expect(seen[0]).toBe(0.4);
    mixer.progress(0.8); // …and keeps moving
    expect(seen).toEqual([0.4, 0.8]);
    mixer.completeLoad();
    await started;
  });

  it('does nothing while an audition is in flight', async () => {
    const preview = runtime.previewSong('demo');
    await tick();
    const mixer = FakeMixer.live;
    expect(mixer.loads).toBe(1); // the audition's own fallback load

    runtime.prefetchSong('demo');
    await tick();
    expect(mixer.loads).toBe(1);
    mixer.completeLoad();
    await preview;
  });

  it('survives a cancelled audition that merely joined it', async () => {
    // The therapist prefetches by choosing the song, then presses Listen, then changes their mind.
    runtime.prefetchSong('demo');
    await tick();
    const mixer = FakeMixer.live;
    const preview = runtime.previewSong('demo');
    await tick();
    expect(mixer.loads).toBe(1); // the audition joined the prefetch

    runtime.stopPreview();
    expect(await preview).toBeNull();
    // THE DOWNLOAD IS STILL RUNNING: it was started for the session, not for the audition.
    expect(mixer.unloads).toBe(0);

    const started = runtime.loadSong('demo');
    await tick();
    expect(mixer.loads).toBe(1); // still the same one — not restarted from zero
    mixer.completeLoad();
    expect(await started).toBe(MANIFEST);
  });

  it('still cancels a download the audition itself started', async () => {
    const preview = runtime.previewSong('demo');
    await tick();
    const mixer = FakeMixer.live;
    runtime.stopPreview();
    expect(await preview).toBeNull();
    expect(mixer.unloads).toBeGreaterThan(0);
  });

  it('does not re-download a song that is already loaded', async () => {
    runtime.prefetchSong('demo');
    await tick();
    const mixer = FakeMixer.live;
    mixer.completeLoad();
    await tick();
    runtime.prefetchSong('demo');
    await tick();
    expect(mixer.loads).toBe(1);
  });
});
