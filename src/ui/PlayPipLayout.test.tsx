/**
 * THE WARNING AND THE BIOFEEDBACK HAVE TO COEXIST.
 *
 * The PIP panel is a clipped column: input-layer warnings, then the camera thumbnail, then the lane
 * meters, then the legend that names their marks. The warnings block was `flex: 0 0 auto` with
 * `max-height: 46%` — and a percentage height resolved against a parent whose own height is only a
 * `max-height` is no cap at all, so an unshrinkable block took whatever it wanted. Driven in the real
 * app with a stale-range prescription (five watchdog sentences), the block measured 752 px inside a
 * 653 px panel and pushed the thumbnail, the METERS and the legend out of the clipped panel at
 * 1024×768, 1280×800 and 1920×1080: for as long as a warning stood the patient had no gauge to steer
 * by, which is the one thing in that panel that is theirs.
 *
 * jsdom has no layout, so this pins the two things that made the difference and that a refactor can
 * silently undo: the cap is a PIXEL number computed from the panel's measured box and handed to the
 * element, and the stylesheet's own rules let that block shrink and scroll instead of pushing.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { LaneSpec } from '../engine/types.ts';
import { DEFAULT_SETTINGS, useStore } from '../state/store.ts';

const LANES: LaneSpec[] = [
  { index: 0, movement: 'seated_march', side: 'left' },
  { index: 1, movement: 'seated_march', side: 'right' },
];

/** Six sentences is an ordinary pile-up: two stale ranges, two unmonitored compensations, two lanes. */
const WARNINGS = [
  'Lane 1 (Seated march): This range was measured 3 days ago (seated, facing the camera). If the camera or the chair has moved since, re-run the calibration.',
  'Lane 2 (Seated march): This range was measured 3 days ago (seated, facing the camera). If the camera or the chair has moved since, re-run the calibration.',
  'Lane 1 (Seated march): trunk lean is NOT being monitored — the calibration carries no resting baseline for it.',
  'Lane 2 (Seated march): trunk lean is NOT being monitored — the calibration carries no resting baseline for it.',
  'Lane 1 has not reached its hit threshold for over 20s (best attempt 41% of the 66% needed).',
  'The camera is only managing 11 frames per second (15 needed for accurate timing).',
];

const vision = {
  getInvalidCalibrations: () => [],
  getLaneStates: () => LANES.map((l) => ({ lane: l.index, value: 0.2, armed: true })),
  getVideoElement: () => null,
  getStatus: () => ({ warnings: WARNINGS, lanes: [] }),
  onEvent: () => () => {},
  start: async () => {},
  stop: () => {},
};

vi.mock('../session/runtime.ts', () => ({
  runtime: {
    ensureAudio: async () => ({
      ctx: { currentTime: 0, sampleRate: 48000, state: 'running' },
      mixer: {},
      sfx: { enabled: true },
    }),
    loadSong: async () => null,
    ensureVision: async () => vision,
    peekVision: () => vision,
    disposeVision: () => undefined,
    releaseVisionUnless: () => undefined,
    runner: null,
  },
}));

const { default: PlayScreen, pipPanelBudget } = await import('./Play.tsx');

/** `.pip-meters` height, the one item in the panel that never gives way (index.css + Play.tsx). */
const PIP_METERS_HEIGHT = 62;

const CSS = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');

/** The declarations of one rule in the app stylesheet, as text. */
function ruleBody(selector: string): string {
  const i = CSS.indexOf(`\n${selector} {`);
  expect(i).toBeGreaterThan(-1);
  return CSS.slice(i, CSS.indexOf('}', i));
}

beforeEach(() => {
  cleanup();
  useStore.setState({
    screen: 'play',
    mode: 'leg',
    lanes: LANES,
    calibrations: [null, null],
    savedCalibrations: {},
    difficulty: 'medium',
    windowScale: 1,
    songId: 'demo-groove',
    inputMode: 'camera',
    settings: { ...DEFAULT_SETTINGS },
  });
});

describe('the PIP panel while an input-layer warning is up', () => {
  it('keeps the lane meters and their legend in the panel, under a bounded warning block', async () => {
    render(<PlayScreen />);
    const alerts = await screen.findByTestId('play-alerts', {}, { timeout: 5000 });
    const pip = screen.getByTestId('play-pip');

    // Every warning is present…
    await waitFor(() => expect(screen.getAllByTestId(/^play-alert-\d+$/)).toHaveLength(WARNINGS.length));
    // …and so are the things the patient steers by, in the same panel, AFTER the warnings.
    const meters = pip.querySelector('.pip-meters');
    const legend = pip.querySelector('.pip-note');
    expect(meters).not.toBeNull();
    expect(legend).not.toBeNull();
    expect(alerts.compareDocumentPosition(meters as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // One meter column per lane, still.
    expect(pip.querySelectorAll('.pip-lane')).toHaveLength(LANES.length);

    // The cap is a real number of pixels, not a percentage of a parent with no height — and it never
    // promises more than the panel it is measured from can hold (jsdom lays nothing out, so the box
    // the mocked renderer reports here is the degenerate one: 62 px, exactly the meters).
    const cap = (alerts as HTMLElement).style.maxHeight;
    expect(cap).toMatch(/^\d+px$/);
    const panel = Number.parseInt((pip as HTMLElement).style.maxHeight, 10);
    const floor = Number.parseInt((pip as HTMLElement).style.getPropertyValue('--pip-video-min'), 10);
    const noteFloor = Number.parseInt((pip as HTMLElement).style.getPropertyValue('--pip-note-min'), 10);
    expect(Number.parseInt(cap, 10) + floor + noteFloor + PIP_METERS_HEIGHT).toBeLessThanOrEqual(panel);
    // And the thumbnail's floor is handed to the stylesheet as pixels, from the same budget.
    expect((pip as HTMLElement).style.getPropertyValue('--pip-video-min')).toMatch(/^\d+px$/);

    // And a bounded block says how many sentences are in it, so a scrolled-out one is known about.
    expect(screen.getByTestId('play-alerts-count').textContent).toContain(String(WARNINGS.length));
  });

  it('gives the warning block rules that shrink and scroll rather than push', () => {
    const alerts = ruleBody('.pip-alerts');
    // The bug in one line: a percentage max-height against a max-height-only parent caps nothing.
    expect(alerts).not.toMatch(/max-height:\s*\d+%/);
    expect(alerts).toMatch(/flex:\s*0 1 auto/); // shrinkable
    expect(alerts).toMatch(/overflow-y:\s*auto/); // and scrolls inside what it gets
    expect(alerts).toMatch(/min-height:/); // with a floor, so the warning cannot vanish either

    // The meters are the one item that never gives way…
    expect(ruleBody('.pip-meters')).toMatch(/flex:\s*none/);
    // …and of the other three, the one that gives way FIRST is the static legend, not the live camera
    // thumbnail. Shrink 200 against the thumbnail's 1: with six warnings up, the panel used to spend
    // 240 px on a legend it then cut off mid-sentence while the thumbnail measured 0 px at 1024x768
    // and 1280x800 — and the warnings are mostly about framing, which the thumbnail is the only way
    // to fix mid-song.
    expect(ruleBody('.pip-note')).toMatch(/flex:\s*0 200 auto/);
    expect(ruleBody('.pip-note')).toMatch(/overflow-y:\s*auto/);
    // …and it never becomes a strip of padding with no words in it: two lines, out of what is left.
    expect(ruleBody('.pip-note')).toMatch(/min-height:\s*var\(--pip-note-min/);
    // The thumbnail shrinks like everyone else but holds a PIXEL floor handed down from Play.tsx.
    expect(ruleBody('.pip-video')).toMatch(/flex:\s*1 1 auto/);
    expect(ruleBody('.pip-video')).toMatch(/min-height:\s*var\(--pip-video-min/);
  });
});

/**
 * WHAT THE PANEL SPENDS ITS HEIGHT ON, AT THE SIZES A CLINIC RUNS.
 *
 * Driven in Chromium with six real warnings up, the panel used to measure: alerts 199, video 0,
 * meters 62, legend 242 at 1024x768; alerts 199, video 0, meters 62, legend 240 at 1280x800. The
 * camera thumbnail — the only way to fix framing mid-song, and framing is what most of those warnings
 * are about — was gone for as long as a warning stood, while 240 px went to static legend text the
 * panel then cut off mid-sentence. jsdom cannot lay that out, so the split is a pure function of the
 * panel's measured height and this pins it at the real heights.
 */
describe('the panel spends its height on the live gauges before the static legend', () => {
  // The panel heights the renderer reported at 1024x600, 1024x768, 1280x800 and 1920x1080.
  for (const panel of [371, 505, 558, 742]) {
    it(`reserves the thumbnail and never over-promises in a ${panel} px panel`, () => {
      const { alertsMaxHeight, videoMinPx, noteMinPx } = pipPanelBudget(panel);
      // The thumbnail gets a real floor…
      expect(videoMinPx).toBe(96);
      // …the warning still gets a usable block…
      expect(alertsMaxHeight).toBeGreaterThan(100);
      // …the legend keeps two lines to scroll in, rather than a strip of padding with no words…
      expect(noteMinPx).toBe(44);
      // …and the reservations always fit, so the meters cannot be clipped out of the bottom.
      expect(alertsMaxHeight + videoMinPx + noteMinPx + PIP_METERS_HEIGHT).toBeLessThanOrEqual(panel);
    });
  }

  it('never reserves more than a panel holds, at any height', () => {
    for (let panel = 63; panel <= 1200; panel++) {
      const { alertsMaxHeight, videoMinPx, noteMinPx } = pipPanelBudget(panel);
      expect(alertsMaxHeight + videoMinPx + noteMinPx + PIP_METERS_HEIGHT).toBeLessThanOrEqual(panel);
      expect(videoMinPx).toBeGreaterThanOrEqual(0);
      expect(noteMinPx).toBeGreaterThanOrEqual(0);
      expect(alertsMaxHeight).toBeGreaterThanOrEqual(0);
    }
  });

  it('falls back to a sane split when no box has been measured yet', () => {
    expect(pipPanelBudget(null)).toEqual({ alertsMaxHeight: 180, videoMinPx: 96, noteMinPx: 44 });
  });
});
