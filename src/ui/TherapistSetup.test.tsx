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
  prefetchSong: vi.fn(() => undefined),
};

vi.mock('../session/runtime.ts', () => ({ runtime: fake }));

const { default: TherapistSetup } = await import('./TherapistSetup.tsx');

beforeEach(() => {
  fake.previewing = null;
  fake.previewSong.mockClear();
  fake.stopPreview.mockClear();
  fake.prefetchSong.mockClear();
  localStorage.clear();
  useStore.setState({
    screen: 'setup',
    // A session is prescribed FOR somebody: with no patient selected the start button is (correctly)
    // disabled, so every test here runs with the one the therapist would have chosen.
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

describe('the song downloads before the patient is waiting for it', () => {
  it('prefetches the prescribed song when the prescription is committed', async () => {
    // Every byte of the song used to be fetched after Start, with the patient in position: 34 MB and
    // 38.7 s to the first note on a throttled clinic link. A camera session goes camera check → ROM →
    // latency first, which is minutes of work the download can happen inside.
    render(<TherapistSetup />);
    await screen.findByTestId('setup-start');
    await act(async () => {
      fireEvent.click(screen.getByTestId('setup-start'));
    });
    expect(fake.prefetchSong).toHaveBeenCalledWith('demo-groove');
  });

  it('starts on the song that is ALREADY selected the moment the screen opens', async () => {
    // There is nothing to debounce about the song this screen opens on: it is the default or the
    // therapist's own last choice, and on a throttled link a 1.2 s wait before starting is 1.2 s of
    // the patient's session spent on nothing.
    vi.useFakeTimers();
    try {
      render(<TherapistSetup />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0); // the catalog resolves
      });
      expect(fake.prefetchSong).toHaveBeenCalledWith('demo-groove');
      expect(fake.prefetchSong).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('debounces a CHANGE of song, so flicking through the catalogue starts one download', async () => {
    vi.useFakeTimers();
    try {
      render(<TherapistSetup />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      fake.prefetchSong.mockClear();
      await act(async () => {
        fireEvent.click(screen.getByTestId('song-demo-sunrise'));
        await vi.advanceTimersByTimeAsync(300);
      });
      expect(fake.prefetchSong).not.toHaveBeenCalled(); // still choosing
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1500);
      });
      expect(fake.prefetchSong).toHaveBeenCalledWith('demo-sunrise');
    } finally {
      vi.useRealTimers();
    }
  });
});

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
    // The options carry the cost report and the cancel signal (see "an audition can be backed out of").
    expect(fake.previewSong).toHaveBeenCalledWith('demo-sunrise', undefined, expect.objectContaining({ signal: expect.anything() }));
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
  fake.prefetchSong.mockClear();
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
  fake.prefetchSong.mockClear();
    view.unmount();
    expect(fake.stopPreview).toHaveBeenCalled();
  });

  it('tells the therapist an audition never moves the session start', async () => {
    render(<TherapistSetup />);
    await screen.findByTestId('preview-demo-groove');
    expect(screen.getByText(/begins\s*the prescribed chart at the top of the song/i)).toBeTruthy();
  });
});

describe('one audition at a time', () => {
  it('holds the other Listen buttons while a song is still loading', async () => {
    let land: (() => void) | null = null;
    fake.previewSong.mockImplementationOnce(
      (id: string) =>
        new Promise((resolve) => {
          land = () => {
            fake.previewing = id;
            resolve(CATALOG[0].manifest ?? null);
          };
        }),
    );
    render(<TherapistSetup />);
    await screen.findByTestId('preview-demo-groove');

    fireEvent.click(screen.getByTestId('preview-demo-groove'));
    // Clicking Listen on a second song while the first is in flight is what let A's playPreview land
    // after B had been loaded — auditioning B while the UI marked A as playing.
    expect((screen.getByTestId('preview-demo-sunrise') as HTMLButtonElement).disabled).toBe(true);
    expect(fake.previewSong).toHaveBeenCalledTimes(1);

    await act(async () => {
      land?.();
    });
    await waitFor(() => expect(screen.getByTestId('preview-demo-groove').textContent).toMatch(/Stop/));
    expect((screen.getByTestId('preview-demo-sunrise') as HTMLButtonElement).disabled).toBe(false);
  });

  it('silences an audition that finishes loading after the therapist has left the screen', async () => {
    let land: (() => void) | null = null;
    fake.previewSong.mockImplementationOnce(
      (id: string) =>
        new Promise((resolve) => {
          land = () => {
            fake.previewing = id;
            resolve(CATALOG[0].manifest ?? null);
          };
        }),
    );
    const view = render(<TherapistSetup />);
    await screen.findByTestId('preview-demo-groove');
    fireEvent.click(screen.getByTestId('preview-demo-groove'));

    view.unmount();
    await act(async () => {
      land?.();
    });
    // The stems arrived after we were gone: the mixer must not be left playing on a dead screen.
    expect(fake.previewing).toBeNull();
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
    expect(screen.getAllByText(/ring finger/i).length).toBeGreaterThan(0);
  });

  it('reads the prescribed DIGIT out in the patient instruction, not "your fingertip"', async () => {
    useStore.getState().setLane(0, { movement: 'finger_opposition', fingertip: 'pinky' });
    render(<TherapistSetup />);
    await screen.findByTestId('preview-demo-groove');
    // The one string a patient is actually read from. "Touch your thumb to your fingertip" is wrong
    // for three of the four tips a therapist can prescribe.
    expect(screen.getByTestId('lane-0-instructions').textContent).toBe('Touch your thumb to your little finger, then open again.');

    act(() => {
      useStore.getState().setLane(0, { fingertip: 'middle' });
    });
    expect(screen.getByTestId('lane-0-instructions').textContent).toContain('middle finger');
  });

  it('lets a therapist prescribe two DIFFERENT fingertips on one hand — the whole point of the choice', async () => {
    // Thumb-to-index and thumb-to-little on the left hand: different feature, different calibration
    // key, different trend line. The duplicate rule used to hard-block it with a message that was not
    // true of anything downstream.
    act(() => {
      useStore.setState({
        lanes: [
          { index: 0, movement: 'finger_opposition', side: 'left', fingertip: 'index' },
          { index: 1, movement: 'finger_opposition', side: 'left', fingertip: 'pinky' },
        ],
        calibrations: [null, null],
      });
    });
    render(<TherapistSetup />);
    await screen.findByTestId('preview-demo-groove');

    expect(screen.getByTestId('setup-start').hasAttribute('disabled')).toBe(false);
    // It is still worth a WARNING: a patient who cannot isolate the digits may trigger both.
    expect(screen.getByText(/oppose the thumb to different fingers/i)).toBeTruthy();
  });

  it('still blocks the same fingertip prescribed twice on one hand', async () => {
    act(() => {
      useStore.setState({
        lanes: [
          { index: 0, movement: 'finger_opposition', side: 'left', fingertip: 'index' },
          { index: 1, movement: 'finger_opposition', side: 'left', fingertip: 'index' },
        ],
        calibrations: [null, null],
      });
    });
    render(<TherapistSetup />);
    await screen.findByTestId('preview-demo-groove');
    expect(screen.getByTestId('setup-start').hasAttribute('disabled')).toBe(true);
    expect(screen.getByText(/one movement would hit both lanes/i)).toBeTruthy();
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

/**
 * A CAMERA SESSION MEASURES A BODY, so it needs a person to be about.
 *
 * The built-in device-test record is where keyboard and autoplay runs go. Left selected after a demo
 * it used to accept a full camera session, dropping a real patient's measured ROM into a bucket every
 * future demo also writes to — a pooled trend across everybody who has ever been demoed on the tablet.
 */
describe('the device-test record is not a patient', () => {
  it('refuses to start a camera session against it, with the way out on screen', () => {
    useStore.setState({
      patients: [{ id: 'device-test', name: 'Device test (not a patient)', createdAt: 1, lastUsedAt: 1, deviceTest: true }],
      activePatientId: 'device-test',
      inputMode: 'camera',
    });
    render(<TherapistSetup />);
    expect(screen.getByTestId('setup-start').hasAttribute('disabled')).toBe(true);
    expect(screen.getByTestId('setup-device-test-block').textContent).toContain('not a patient');
    expect(screen.getByTestId('setup-choose-patient')).toBeTruthy();
  });

  it('still allows the dev-input run it exists for', () => {
    useStore.setState({
      patients: [{ id: 'device-test', name: 'Device test (not a patient)', createdAt: 1, lastUsedAt: 1, deviceTest: true }],
      activePatientId: 'device-test',
      inputMode: 'autoplay',
    });
    render(<TherapistSetup />);
    expect(screen.getByTestId('setup-start').hasAttribute('disabled')).toBe(false);
    expect(screen.queryByTestId('setup-device-test-block')).toBeNull();
  });
});

/**
 * IDENTITY FAILS CLOSED ON THIS SCREEN, because it is the last one before a recording exists.
 *
 * Driven as two real tabs in one browser: tab 2 deleted the patient tab 1 had in the chair. Tab 1
 * then showed "No patient selected" in red — and an ENABLED "Set up camera →", because the guard read
 * `activePatientId === null` and the id was still there, just naming nobody. A camera session started
 * from that button was filed under the dead id: invisible in the patient picker, unreachable from
 * History (which offered no route to it), impossible to move. A warning banner beside an enabled
 * Start is not failing closed; the question the button has to answer is whether there is a record to
 * file this session against, and that is a lookup, not a null check.
 */
describe('a patient id that names nobody is no patient at all', () => {
  const dangling = () =>
    useStore.setState({
      patients: [{ id: 'someone-else', name: 'Someone Else', createdAt: 1, lastUsedAt: 1 }],
      activePatientId: 'p-deleted-in-another-tab',
      activePatientNotice: 'Ann Reyes was deleted in another tab. Choose who this session is for before recording it.',
      inputMode: 'camera',
    });

  it('disables the primary button whenever the app is saying "No patient selected"', () => {
    dangling();
    render(<TherapistSetup />);
    // The two halves of the contradiction the review found, now agreeing.
    expect(screen.getByTestId('patient-banner-none')).toBeTruthy();
    expect(screen.getByTestId('setup-start').hasAttribute('disabled')).toBe(true);
  });

  it('disables the bottom Start too — both buttons read the one guard', () => {
    dangling();
    render(<TherapistSetup />);
    const starts = screen.getAllByRole('button', { name: /set up camera/i });
    expect(starts).toHaveLength(2);
    for (const b of starts) expect(b.hasAttribute('disabled')).toBe(true);
  });

  it('does not offer to confirm a patient who is not there — only to choose one', () => {
    dangling();
    render(<TherapistSetup />);
    expect(screen.getByTestId('active-patient-notice').textContent).toMatch(/deleted in another tab/i);
    expect(screen.queryByTestId('active-patient-ack')).toBeNull();
    expect(screen.getByTestId('active-patient-change')).toBeTruthy();
  });

  it('still offers "It is the right patient" when there IS one — a rename next door', () => {
    useStore.setState({
      patients: [{ id: 'p-test', name: 'Ann R. Reyes', createdAt: 1, lastUsedAt: 1 }],
      activePatientId: 'p-test',
      activePatientNotice: 'Ann Reyes was renamed to Ann R. Reyes in another tab.',
      inputMode: 'camera',
    });
    render(<TherapistSetup />);
    expect(screen.getByTestId('active-patient-ack')).toBeTruthy();
    expect(screen.getByTestId('setup-start').hasAttribute('disabled')).toBe(false);
  });
});
