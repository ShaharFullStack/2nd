/**
 * A FATAL ERROR MUST RECORD THE SESSION AND THEN TURN THE CAMERA OFF — IN THAT ORDER.
 *
 * `runtime.dispose()` is what the app's error boundary calls when a screen throws (src/ui/
 * ErrorBoundary.tsx), and it is the only release path a crash reaches: a render error changes no
 * `screen`, so the store watch never fires, and React tells the boundary BEFORE it runs the Play
 * screen's effect cleanup — so the boundary cannot rely on the screen having saved anything.
 *
 * That makes the order inside `dispose()` load-bearing. Finishing the runner is what writes the reps
 * the patient actually performed to disk; releasing the camera is what makes the recording indicator
 * go out. If those ever swapped, a crash mid-session would take the hardware away from a run that had
 * not been recorded yet — and the reps would be gone with no error and no undo.
 */
import { describe, expect, it, vi } from 'vitest';
import type { SongManifest } from '../audio/manifest.ts';

const order: string[] = [];

class FakeMixer {
  ctx = { currentTime: 0 } as unknown as AudioContext;
  master = {} as AudioNode;
  manifest: SongManifest | null = null;
  isLoaded = false;
  isPreviewing = false;
  async resumeContext(): Promise<void> {}
  createSfx(): unknown {
    return {};
  }
  async loadSong(): Promise<void> {}
  unload(): void {}
  pause(): void {}
  dispose(): void {
    order.push('audio released');
  }
}

class FakeVision {
  isRunning(): boolean {
    return true;
  }
  async start(): Promise<void> {}
  setCalibration(): boolean {
    return true;
  }
  setThresholdFraction(): void {}
  stop(): void {
    order.push('camera released');
  }
}

vi.mock('../audio/StemMixer.ts', () => ({ StemMixer: FakeMixer }));
vi.mock('../audio/manifest.ts', () => ({
  loadSongCatalog: vi.fn(async () => []),
  loadSongEntry: vi.fn(async () => ({ id: 'demo', status: 'error', missingStems: [] })),
  attributionText: () => '',
}));
vi.mock('../input/VisionInput.ts', () => ({ VisionInput: FakeVision }));

const { runtime } = await import('./runtime.ts');

describe('runtime.dispose', () => {
  it('records the run in progress BEFORE it releases the camera and the audio', async () => {
    order.length = 0;
    await runtime.ensureVision({
      mode: 'leg',
      lanes: [{ index: 0, movement: 'seated_march', side: 'left' }],
      calibrations: [null],
      difficulty: 'medium',
      mirrored: true,
    });
    expect(runtime.peekVision()).not.toBeNull();

    // The run in progress. Its dispose is what writes the interrupted session to localStorage
    // (GameRunner.dispose finishes an unfinished run as 'abandoned').
    let recorded = false;
    runtime.runner = {
      dispose: () => {
        order.push('session recorded');
        recorded = true;
      },
    } as unknown as typeof runtime.runner;

    runtime.dispose();

    expect(recorded).toBe(true);
    expect(order).toEqual(['session recorded', 'camera released', 'audio released']);
    // …and the device really is gone, not merely told to stop.
    expect(runtime.peekVision()).toBeNull();
    expect(runtime.peekAudio()).toBeNull();
    expect(runtime.runner).toBeNull();
  });
});
