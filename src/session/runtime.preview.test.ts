/**
 * AN AUDITION MUST BE STOPPABLE — INCLUDING THE EXPENSIVE HALF OF IT.
 *
 * The cheap audition fetches the twelve seconds it plays. When the server refuses `Range` it falls
 * back to loading the WHOLE song (34 MB for the demo tracks), and that is the minute a therapist
 * with ninety seconds between patients has to be able to take back. `stopPreview()` — and the
 * caller's own signal — has to reach the fallback's downloads, not just the ranged ones.
 *
 * And the cancel must not poison what comes next: a therapist who stops an audition of the song they
 * then prescribe must get a real load when they press Start, not the corpse of the one they cancelled.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SongManifest } from '../audio/manifest.ts';

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

  constructor() {
    FakeMixer.live = this;
  }
  async resumeContext(): Promise<void> {}
  createSfx(): unknown {
    return {};
  }
  async loadSong(manifest: SongManifest): Promise<void> {
    this.loads++;
    await new Promise<void>((resolve) => {
      this.finish = resolve;
    });
    // A cancelled load resolves quietly with nothing in the mixer — exactly what StemMixer does.
    if (this.isLoaded) this.manifest = manifest;
  }
  /** Let the load in flight complete successfully. */
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
  dispose(): void {}
}

vi.mock('../audio/StemMixer.ts', () => ({ StemMixer: FakeMixer }));
vi.mock('../audio/manifest.ts', () => ({
  loadSongCatalog: vi.fn(async () => []),
  loadSongEntry: vi.fn(async () => ({ id: 'demo', status: 'ready', manifest: MANIFEST, missingStems: [] })),
  attributionText: () => '',
}));
// The ranged audition always refuses here: this file is about the FALLBACK, which is the expensive
// path and the one that had no way out.
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

/** Let promise callbacks run without advancing to any load completing. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('cancelling an audition that has fallen back to the whole song', () => {
  it('aborts the download in flight and reports nothing playing', async () => {
    const preview = runtime.previewSong('demo');
    await tick();
    const mixer = FakeMixer.live;
    expect(mixer.loads).toBe(1);

    runtime.stopPreview();
    expect(mixer.unloads).toBeGreaterThan(0);
    expect(await preview).toBeNull();
    // Nothing was played to a therapist who had already moved on.
    expect(mixer.previews).toBe(0);
  });

  it('is cancellable through the caller\'s own signal, not only through stopPreview()', async () => {
    const abort = new AbortController();
    const preview = runtime.previewSong('demo', undefined, { signal: abort.signal });
    await tick();
    const mixer = FakeMixer.live;
    abort.abort();
    expect(mixer.unloads).toBeGreaterThan(0);
    expect(await preview).toBeNull();
  });

  it('does not hand the cancelled load to the Start button', async () => {
    const preview = runtime.previewSong('demo');
    await tick();
    const mixer = FakeMixer.live;
    runtime.stopPreview();
    await preview;

    // The therapist prescribes the song they had just been auditioning.
    const started = runtime.loadSong('demo');
    await tick();
    expect(mixer.loads).toBe(2); // a NEW load, not the corpse of the cancelled one
    mixer.completeLoad();
    expect(await started).toBe(MANIFEST);
  });

  it('plays the audition when the fallback is allowed to finish', async () => {
    const preview = runtime.previewSong('demo');
    await tick();
    const mixer = FakeMixer.live;
    mixer.completeLoad();
    expect(await preview).toBe(MANIFEST);
    expect(mixer.previews).toBe(1);
  });
});
