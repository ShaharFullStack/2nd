/**
 * AN AUDITION THE THERAPIST CAN BACK OUT OF, AND WHOSE COST IS ON SCREEN.
 *
 * The cheap audition fetches only the twelve seconds it plays (~4 MB, a quarter of a second). But
 * when the server — or a proxy in front of it — refuses `Range`, it falls back to loading the whole
 * song: 34 MB for the demo tracks, a minute on clinic wi-fi. Before this, that minute looked like
 * "… loading" on a button that had gone dead, with every other Listen dead too, no byte count and no
 * way out. The therapist has ninety seconds between patients; an uncancellable button burns them.
 *
 * These tests hold the three things that fixes:
 *   1. the button that started it stays live and IS the stop,
 *   2. the bytes are on screen while they arrive,
 *   3. the fallback says out loud that it is loading the whole song, not twelve seconds.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { SongEntry, SongManifest } from '../audio/manifest.ts';
import type { LoadProgress } from '../audio/StemMixer.ts';
import type { AuditionProgress } from '../session/audition.ts';
import { DEFAULT_SETTINGS, defaultLanes, useStore } from '../state/store.ts';

const manifest = (id: string, title: string): SongManifest => ({
  id, title, artist: 'Artist', license: 'CC BY 4.0', bpm: 120, offset: 0, durationSec: 180, previewStart: 30,
  stems: [{ id: 'drums', file: 'stems/drums.wav', label: 'Drums' }], playerStem: 'drums',
});

const CATALOG: SongEntry[] = [
  { id: 'demo-groove', status: 'ready', manifest: manifest('demo-groove', 'Demo Groove'), missingStems: [] },
  { id: 'demo-sunrise', status: 'ready', manifest: manifest('demo-sunrise', 'Demo Sunrise'), missingStems: [] },
];

interface PreviewOptionsLike {
  onProgress?: (p: AuditionProgress) => void;
  onLoadProgress?: (p: LoadProgress) => void;
  signal?: AbortSignal;
}

/** A runtime whose audition never finishes on its own — the therapist has to be able to end it. */
const pending = {
  options: null as PreviewOptionsLike | null,
  resolve: null as ((m: SongManifest | null) => void) | null,
};

const fake = {
  previewing: null as string | null,
  songCatalog: vi.fn(async () => CATALOG),
  ensureAudio: vi.fn(async () => ({})),
  previewSong: vi.fn((id: string, _sec?: number, options: PreviewOptionsLike = {}) => {
    pending.options = options;
    return new Promise<SongManifest | null>((resolve) => {
      pending.resolve = resolve;
      options.signal?.addEventListener('abort', () => resolve(null), { once: true });
    }).then((m) => {
      if (m) fake.previewing = id;
      return m;
    });
  }),
  stopPreview: vi.fn(() => {
    fake.previewing = null;
  }),
  previewingSongId: vi.fn(() => fake.previewing),
};

vi.mock('../session/runtime.ts', () => ({ runtime: fake }));

const { default: TherapistSetup } = await import('./TherapistSetup.tsx');

beforeEach(() => {
  pending.options = null;
  pending.resolve = null;
  fake.previewing = null;
  fake.previewSong.mockClear();
  fake.stopPreview.mockClear();
  localStorage.clear();
  useStore.setState({
    screen: 'setup',
    patients: [{ id: 'p-test', name: 'Test Patient', createdAt: 1, lastUsedAt: 1 }],
    activePatientId: 'p-test',
    mode: 'hand',
    lanes: defaultLanes('hand'),
    calibrations: [null, null],
    savedCalibrations: {},
    difficulty: 'medium',
    windowScale: 1,
    songId: 'demo-groove',
    inputMode: 'camera',
    settings: { ...DEFAULT_SETTINGS },
  });
});

afterEach(cleanup);

async function startAudition(): Promise<HTMLElement> {
  render(<TherapistSetup />);
  const button = await screen.findByTestId('preview-demo-sunrise');
  await act(async () => {
    fireEvent.click(button);
  });
  return button;
}

describe('an audition can be backed out of', () => {
  it('leaves the pressed button live, as its own Stop', async () => {
    const button = await startAudition();
    expect(button.hasAttribute('disabled')).toBe(false);
    expect(button.textContent).toContain('Stop');
    expect(button.getAttribute('aria-label')).toContain('Stop loading Demo Sunrise');
  });

  it('holds the OTHER Listen buttons while one press is in flight', async () => {
    await startAudition();
    expect((screen.getByTestId('preview-demo-groove') as HTMLButtonElement).disabled).toBe(true);
  });

  it('pressing it again aborts the fetches in flight', async () => {
    const button = await startAudition();
    const signal = pending.options?.signal;
    expect(signal?.aborted).toBe(false);
    await act(async () => {
      fireEvent.click(button);
    });
    expect(signal?.aborted).toBe(true);
    expect(fake.stopPreview).toHaveBeenCalled();
    // …and the screen returns to offering the audition, with no error shouted at the therapist.
    await waitFor(() => expect(screen.getByTestId('preview-demo-sunrise').textContent).toContain('Listen'));
  });
});

describe('an audition says what it is costing', () => {
  it('counts the bytes of the cheap, ranged path', async () => {
    await startAudition();
    await act(async () => {
      pending.options?.onProgress?.({ fraction: 0.5, bytes: 2_100_000, stemsReady: 1, stems: 2 });
    });
    const status = screen.getByTestId('preview-status-demo-sunrise');
    expect(status.textContent).toContain('Loading 12 s');
    expect(status.textContent).toContain('2.1 MB');
  });

  it('says out loud when it has fallen back to downloading the WHOLE song', async () => {
    await startAudition();
    await act(async () => {
      pending.options?.onLoadProgress?.({
        fraction: 0.36,
        bytesLoaded: 12_400_000,
        bytesTotal: 34_000_000,
        bytesTotalKnown: true,
        stemsDecoded: 0,
        stemCount: 4,
        stemId: 'drums',
        phase: 'downloading',
      });
    });
    const status = screen.getByTestId('preview-status-demo-sunrise');
    expect(status.textContent).toContain('Whole song');
    expect(status.textContent).toContain('12.4 MB of 34.0 MB');
    expect(status.textContent).toContain('will not send just the preview');
  });
});
