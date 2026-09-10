/**
 * Setup screen: the song audition and the therapist's fingertip choice.
 *
 * The runtime is mocked (a real one would open an AudioContext and pull in MediaPipe); everything
 * else — the store, the lane conflict rules, the catalog shape — is the real thing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { SongEntry, SongManifest } from '../audio/manifest.ts';
import { DEFAULT_SETTINGS, defaultLanes, useStore } from '../state/store.ts';

const manifest = (id: string, title: string, previewStart: number): SongManifest => ({
  id, title, artist: 'Artist', license: 'CC BY 4.0', bpm: 120, offset: 0, durationSec: 180, previewStart,
  stems: [{ id: 'drums', file: 'stems/drums.wav', label: 'Drums' }], playerStem: 'drums',
});

const CATALOG: SongEntry[] = [
  { id: 'demo-groove', status: 'ready', manifest: manifest('demo-groove', 'Demo Groove', 30), missingStems: [] },
  { id: 'demo-sunrise', status: 'ready', manifest: manifest('demo-sunrise', 'Demo Sunrise', 45), missingStems: [] },
  { id: 'no-stems', status: 'needs-fetch', manifest: manifest('no-stems', 'Unfetched', 0), missingStems: ['drums'] },
];

const fake = {
  previewing: null as string | null,
  songCatalog: vi.fn(async () => CATALOG),
  ensureAudio: vi.fn(async () => ({})),
  previewSong: vi.fn(async (id: string) => {
    const entry = CATALOG.find((e) => e.id === id);
    if (!entry || entry.status !== 'ready') return null;
    fake.previewing = id;
    return entry.manifest ?? null;
  }),
  stopPreview: vi.fn(() => {
    fake.previewing = null;
  }),
  previewingSongId: vi.fn(() => fake.previewing),
};

vi.mock('../session/runtime.ts', () => ({ runtime: fake }));

const { default: TherapistSetup } = await import('./TherapistSetup.tsx');

beforeEach(() => {
  fake.previewing = null;
  fake.previewSong.mockClear();
  fake.stopPreview.mockClear();
  localStorage.clear();
  useStore.setState({
    screen: 'setup',
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

describe('song audition', () => {
  it('offers a Listen button per playable song and says where it plays from', async () => {
    render(<TherapistSetup />);
    const button = await screen.findByTestId('preview-demo-sunrise');
    expect(button.textContent).toContain('Listen');
    // demo-sunrise previews from 45 s.
    expect(screen.getByText('12 s from 0:45')).toBeTruthy();
  });

  it('auditions the song that was clicked — not the prescribed one', async () => {
    render(<TherapistSetup />);
    const button = await screen.findByTestId('preview-demo-sunrise');
    await act(async () => {
      fireEvent.click(button);
    });
    expect(fake.previewSong).toHaveBeenCalledWith('demo-sunrise');
    // Auditioning does not change the prescription.
    expect(useStore.getState().songId).toBe('demo-groove');
    await waitFor(() => expect(screen.getByTestId('preview-demo-sunrise').textContent).toContain('Stop'));
  });

  it('the same button stops the audition', async () => {
    render(<TherapistSetup />);
    const button = await screen.findByTestId('preview-demo-groove');
    await act(async () => {
      fireEvent.click(button);
    });
    await waitFor(() => expect(screen.getByTestId('preview-demo-groove').textContent).toContain('Stop'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('preview-demo-groove'));
    });
    expect(fake.stopPreview).toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId('preview-demo-groove').textContent).toContain('Listen'));
  });

  it('cannot audition a song whose stems are not downloaded', async () => {
    render(<TherapistSetup />);
    const button = await screen.findByTestId('preview-no-stems');
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it('stops the audition before the session starts, so it cannot bleed into the count-in', async () => {
    render(<TherapistSetup />);
    const button = await screen.findByTestId('preview-demo-groove');
    await act(async () => {
      fireEvent.click(button);
    });
    fake.stopPreview.mockClear();
    await act(async () => {
      fireEvent.click(screen.getByTestId('setup-start'));
    });
    expect(fake.stopPreview).toHaveBeenCalled();
    expect(useStore.getState().screen).toBe('camera');
  });

  it('stops the audition when the screen goes away', async () => {
    const view = render(<TherapistSetup />);
    await screen.findByTestId('preview-demo-groove');
    fake.stopPreview.mockClear();
    view.unmount();
    expect(fake.stopPreview).toHaveBeenCalled();
  });

  it('tells the therapist an audition never moves the session start', async () => {
    render(<TherapistSetup />);
    await screen.findByTestId('preview-demo-groove');
    expect(screen.getByText(/begins\s*the prescribed chart at the top of the song/i)).toBeTruthy();
  });
});

describe('fingertip choice', () => {
  it('is hidden for movements that have no fingertip', async () => {
    render(<TherapistSetup />);
    await screen.findByTestId('preview-demo-groove');
    expect(screen.queryByTestId('lane-0-tip-pinky')).toBeNull();
  });

  it('appears for finger_opposition and writes the therapist choice into the lane', async () => {
    useStore.getState().setLane(0, { movement: 'finger_opposition' });
    render(<TherapistSetup />);
    await screen.findByTestId('preview-demo-groove');

    const index = screen.getByTestId('lane-0-tip-index');
    expect(index.getAttribute('aria-pressed')).toBe('true'); // the default

    fireEvent.click(screen.getByTestId('lane-0-tip-pinky'));
    expect(useStore.getState().lanes[0].fingertip).toBe('pinky');
    expect(screen.getByTestId('lane-0-tip-pinky').getAttribute('aria-pressed')).toBe('true');
  });

  it('names the fingertip in the lane heading so the prescription is unambiguous', async () => {
    useStore.getState().setLane(0, { movement: 'finger_opposition', fingertip: 'ring' });
    render(<TherapistSetup />);
    await screen.findByTestId('preview-demo-groove');
    expect(screen.getByText(/ring finger/i)).toBeTruthy();
  });

  it('disappears again when the lane moves to another movement', async () => {
    useStore.getState().setLane(0, { movement: 'finger_opposition', fingertip: 'ring' });
    render(<TherapistSetup />);
    await screen.findByTestId('preview-demo-groove');
    expect(screen.getByTestId('lane-0-tip-ring')).toBeTruthy();

    act(() => {
      useStore.getState().setLane(0, { movement: 'hand_open_close' });
    });
    await waitFor(() => expect(screen.queryByTestId('lane-0-tip-ring')).toBeNull());
    expect(useStore.getState().lanes[0].fingertip).toBeUndefined();
  });
});
