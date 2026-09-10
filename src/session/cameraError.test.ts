import { describe, expect, it } from 'vitest';
import { classifyCameraError } from './cameraError.ts';

/** A DOMException-shaped error, which is what getUserMedia actually rejects with. */
function domError(name: string, message: string): Error {
  const e = new Error(message);
  e.name = name;
  return e;
}

describe('classifyCameraError', () => {
  it('names a refused permission and offers a retry', () => {
    const f = classifyCameraError(domError('NotAllowedError', 'Permission denied'));
    expect(f.kind).toBe('permission');
    expect(f.retryable).toBe(true);
    expect(f.remedy).toMatch(/address bar|Allow/i);
  });

  it('names a missing device', () => {
    expect(classifyCameraError(domError('NotFoundError', 'Requested device not found')).kind).toBe('no_device');
    expect(classifyCameraError(domError('OverconstrainedError', 'width')).kind).toBe('no_device');
  });

  it('separates a camera another app is holding from one that is missing', () => {
    const f = classifyCameraError(domError('NotReadableError', 'Could not start video source'));
    expect(f.kind).toBe('device_busy');
    expect(f.remedy).toMatch(/close/i);
  });

  it('marks an unsupported context as not retryable — Retry cannot fix an insecure origin', () => {
    const f = classifyCameraError(new Error('Camera not available: getUserMedia unsupported'));
    expect(f.kind).toBe('unsupported');
    expect(f.retryable).toBe(false);
  });

  it('separates a model/runtime failure from a camera failure', () => {
    const f = classifyCameraError(new Error('failed to load /models/pose_landmarker_lite.task'));
    expect(f.kind).toBe('model');
    expect(f.detail).toMatch(/camera is fine/i);
    expect(f.retryable).toBe(true);
  });

  it('reports an unusable lane prescription as a setup problem, not a camera one', () => {
    const f = classifyCameraError(
      new Error('VisionInput: refusing to start on an unusable lane prescription — two movements of one hand'),
    );
    expect(f.kind).toBe('prescription');
    expect(f.retryable).toBe(false);
    expect(f.remedy).toMatch(/Setup/);
  });

  it('always produces something displayable, whatever it was given', () => {
    for (const thrown of [null, undefined, 42, {}, 'boom', new Error('')]) {
      const f = classifyCameraError(thrown);
      expect(f.title.length).toBeGreaterThan(0);
      expect(f.remedy.length).toBeGreaterThan(0);
      expect(f.raw.length).toBeGreaterThan(0);
    }
  });

  it('keeps the raw message for the fine print, never as the headline', () => {
    const f = classifyCameraError(domError('NotAllowedError', 'Permission denied by system'));
    expect(f.raw).toBe('Permission denied by system');
    expect(f.title).not.toContain('NotAllowedError');
  });
});

describe('the browser holding the audio clock', () => {
  it('is its own failure with its own remedy — a tap, not a camera setting', () => {
    // Reached by reloading on the camera screen: Chrome never settles AudioContext.resume() until the
    // page has had a gesture, and camera frames are timestamped against that clock.
    const f = classifyCameraError(new Error('The audio clock could not be started: the browser is waiting for a tap on the page.'));
    expect(f.kind).toBe('audio_gesture');
    expect(f.retryable).toBe(true);
    expect(f.remedy).toMatch(/press retry/i);
    expect(f.detail).toMatch(/nothing is wrong with the camera/i);
  });
});
