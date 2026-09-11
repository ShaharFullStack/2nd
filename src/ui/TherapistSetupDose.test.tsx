/**
 * The Setup screen must state the DOSE and let the therapist set the PACING.
 *
 * A therapist prescribing exercise is prescribing repetitions at a rate. Before this, "medium,
 * 2 lanes" silently meant ~95 reps per limb at ~58 reps/min, and the number moved whenever the
 * difficulty, the lane count or the song changed for unrelated reasons.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { SongEntry, SongManifest } from '../audio/manifest.ts';
import { DEFAULT_LANE_REST_SEC } from '../charts/generate.ts';
import { DEFAULT_SETTINGS, defaultLanes, useStore } from '../state/store.ts';

const manifest = (stems: string[]): SongManifest => ({
  id: 'demo-groove', title: 'Demo Groove', artist: 'Artist', license: 'CC BY 4.0',
  bpm: 120, offset: 0, durationSec: 97, previewStart: 30,
  stems: stems.map((id) => ({ id, file: `stems/${id}.wav`, label: id })),
  playerStem: stems[0],
});

let catalog: SongEntry[] = [];

const fake = {
  songCatalog: vi.fn(async () => catalog),
  ensureAudio: vi.fn(async () => ({})),
  previewSong: vi.fn(async () => null),
  stopPreview: vi.fn(() => undefined),
  previewingSongId: vi.fn(() => null),
};
vi.mock('../session/runtime.ts', () => ({ runtime: fake }));

const { default: TherapistSetup } = await import('./TherapistSetup.tsx');

const setCatalog = (stems: string[]): void => {
  catalog = [{ id: 'demo-groove', status: 'ready', manifest: manifest(stems), missingStems: [] }];
};

beforeEach(() => {
  localStorage.clear();
  setCatalog(['drums', 'bass', 'keys', 'gtr']);
  useStore.setState({
    screen: 'setup',
    patients: [{ id: 'p-test', name: 'Test Patient', createdAt: 1, lastUsedAt: 1 }],
    activePatientId: 'p-test',
    mode: 'leg',
    lanes: defaultLanes('leg'),
    calibrations: [null, null],
    savedCalibrations: {},
    difficulty: 'medium',
    windowScale: 1,
    laneRestSec: DEFAULT_LANE_REST_SEC,
    songId: 'demo-groove',
    seed: 1,
    inputMode: 'camera',
    settings: { ...DEFAULT_SETTINGS },
  });
});
afterEach(cleanup);

describe('the prescription states its dose', () => {
  it('shows reps per lane and reps per minute for the song that is actually prescribed', async () => {
    render(<TherapistSetup />);
    const card = await screen.findByTestId('setup-dose');
    const perLane = Number(screen.getByTestId('dose-reps-per-lane').textContent);
    const perMin = Number(screen.getByTestId('dose-reps-per-min').textContent);
    expect(perLane).toBeGreaterThan(10);
    expect(perMin).toBeGreaterThan(5);
    // the pacing floor is honoured, so the per-limb rate cannot exceed 60 / rest
    expect(perMin).toBeLessThanOrEqual(60 / DEFAULT_LANE_REST_SEC + 1);
    expect(card.textContent).toContain('Reps per lane');
    // and it is broken down by the movement each lane actually asks for
    expect(screen.getByTestId('dose-lane-0').textContent).toMatch(/\d+ × (Left|Right)/);
  });

  it('moves the dose when the therapist changes the pacing, with the difficulty untouched', async () => {
    render(<TherapistSetup />);
    await screen.findByTestId('setup-dose');
    const before = Number(screen.getByTestId('dose-reps-per-min').textContent);
    fireEvent.change(screen.getByTestId('pacing-slider'), { target: { value: '3' } });
    await waitFor(() => expect(screen.getByTestId('pacing-value').textContent).toContain('3.0 s'));
    const after = Number(screen.getByTestId('dose-reps-per-min').textContent);
    expect(after).toBeLessThan(before);
    expect(after).toBeLessThanOrEqual(21); // 60 / 3 s, plus rounding
    expect(useStore.getState().laneRestSec).toBe(3);
    expect(useStore.getState().difficulty).toBe('medium'); // pacing is not a difficulty
    // and it survives into the prescription the session is built from
    expect(useStore.getState().config().laneRestSec).toBe(3);
  });

  it('states the pacing in the units a therapist prescribes in, and separates the ceiling from the dose', async () => {
    render(<TherapistSetup />);
    const card = await screen.findByTestId('setup-dose');
    expect(card.textContent).toContain('SAME limb');
    // TWO reps-per-minute figures used to sit side by side as bare numbers — the ceiling the pacing
    // allows and the dose this chart delivers — which invites reading the ceiling as the
    // prescription. They are now one sentence that says which is which.
    const pacing = screen.getByTestId('pacing-explainer').textContent ?? '';
    expect(pacing).toContain('no limb can be asked for more than 50 reps/min');
    expect(pacing).toContain('actually deliver');
    expect(pacing).toContain('which is the dose above');
  });

  it('lets a therapist set the pacing exactly, without landing a drag', async () => {
    render(<TherapistSetup />);
    await screen.findByTestId('setup-dose');
    // Typed
    fireEvent.change(screen.getByTestId('pacing-number'), { target: { value: '1.5' } });
    await waitFor(() => expect(useStore.getState().laneRestSec).toBe(1.5));
    // Stepped
    fireEvent.click(screen.getByTestId('pacing-up'));
    await waitFor(() => expect(useStore.getState().laneRestSec).toBeCloseTo(1.6, 6));
    fireEvent.click(screen.getByTestId('pacing-down'));
    await waitFor(() => expect(useStore.getState().laneRestSec).toBeCloseTo(1.5, 6));
    // Out of range is clamped, never accepted
    fireEvent.change(screen.getByTestId('pacing-number'), { target: { value: '99' } });
    await waitFor(() => expect(useStore.getState().laneRestSec).toBe(6));
    fireEvent.change(screen.getByTestId('pacing-number'), { target: { value: '0' } });
    await waitFor(() => expect(useStore.getState().laneRestSec).toBeCloseTo(0.35, 6));
  });
});

describe('the prescription says what drives the mix', () => {
  it('names WHICH limb has WHICH instrument, not just the set of instruments', async () => {
    render(<TherapistSetup />);
    const card = await screen.findByTestId('setup-mix');
    // "drums, bass" cannot answer the one question a hemiparesis session asks of the mix.
    expect(screen.getByTestId('mix-lane-0').textContent).toMatch(/→ drums/);
    expect(screen.getByTestId('mix-lane-1').textContent).toMatch(/→ bass/);
    expect(card.textContent).toContain('Left · Seated march');
  });

  it('names the per-lane instruments when the song has enough stems', async () => {
    render(<TherapistSetup />);
    const mix = await screen.findByTestId('setup-mix');
    expect(screen.getByTestId('mix-summary').textContent).toContain('own instrument');
    expect(mix.textContent).toContain('never silenced');
    expect(mix.textContent).toMatch(/lowers that lane's instrument by about \d+ dB/);
    expect(mix.textContent).toContain('never touches another lane');
  });

  it('says so when the song has too few stems to give every lane its own', async () => {
    setCatalog(['drums', 'bass']);
    render(<TherapistSetup />);
    await screen.findByTestId('setup-mix');
    expect(screen.getByTestId('mix-summary').textContent).toContain('too few');
  });
});
