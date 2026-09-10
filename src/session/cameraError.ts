/**
 * Turn whatever `VisionInput.start()` threw into something a therapist can act on.
 *
 * The camera is the product; losing it is the single most likely thing to go wrong in a clinic, and
 * "No camera: NotAllowedError" is not a sentence anyone can do anything with. Every failure below has
 * a DIFFERENT remedy — clicking the browser's camera icon, plugging a webcam in, closing the video
 * call that already owns it, reloading so the model downloads again — so the screen has to name the
 * cause rather than offer one generic Retry.
 *
 * Everything here is pure and string-based: `VisionInput` rethrows the browser's own DOMException
 * untouched, so `name` is authoritative when it is present and the message is the fallback.
 */

export type CameraFailureKind =
  /** The patient or the browser refused the permission prompt (or the site is blocked). */
  | 'permission'
  /** No camera is attached at all, or none matching the requested constraints. */
  | 'no_device'
  /** A camera exists but another application (a video call, another tab) holds it. */
  | 'device_busy'
  /** This browser/context cannot give a camera at all (no getUserMedia — usually an insecure origin). */
  | 'unsupported'
  /** The camera is fine; the MediaPipe model or its wasm runtime failed to load or build. */
  | 'model'
  /** The lane prescription itself is unusable, so VisionInput refused to start. Not a camera fault. */
  | 'prescription'
  | 'unknown';

export interface CameraFailure {
  kind: CameraFailureKind;
  /** Headline, in the therapist's words. */
  title: string;
  /** What actually happened. */
  detail: string;
  /** The one thing to do about it before pressing Retry. */
  remedy: string;
  /** True when pressing Retry can plausibly succeed without leaving the page. */
  retryable: boolean;
  /** The original message, kept for the fine print (never the headline). */
  raw: string;
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object' && 'message' in err) return String((err as { message: unknown }).message);
  return String(err);
}

function nameOf(err: unknown): string {
  if (err && typeof err === 'object' && 'name' in err) return String((err as { name: unknown }).name);
  return '';
}

/** Classify a camera-start failure. Never throws, and always returns something displayable. */
export function classifyCameraError(err: unknown): CameraFailure {
  const raw = messageOf(err) || 'Unknown error';
  const name = nameOf(err);
  const hay = `${name} ${raw}`.toLowerCase();

  // The prescription check runs BEFORE the camera is ever opened, so it must not be reported as a
  // camera fault — Retry cannot fix it and the therapist has to change the lanes.
  if (/unusable lane prescription/.test(hay)) {
    return {
      kind: 'prescription',
      title: 'These lanes cannot be tracked together',
      detail: raw,
      remedy: 'Go back to Setup and change one of the lanes — two movements of the same limb cannot be told apart.',
      retryable: false,
      raw,
    };
  }

  if (/notallowederror|permissiondenied|permission denied|security ?error/.test(hay)) {
    return {
      kind: 'permission',
      title: 'The camera permission was refused',
      detail: 'The browser blocked access to the camera for this page.',
      remedy: 'Click the camera icon in the address bar, choose Allow, then press Retry. On a shared tablet the choice may have been remembered from a previous patient.',
      retryable: true,
      raw,
    };
  }

  if (/notfounderror|devicesnotfound|overconstrained|no camera|no such device|requested device not found/.test(hay)) {
    return {
      kind: 'no_device',
      title: 'No camera was found',
      detail: 'This device reports no camera the browser is allowed to use.',
      remedy: 'Plug the webcam in (or check the privacy shutter / hardware switch), then press Retry.',
      retryable: true,
      raw,
    };
  }

  if (/notreadableerror|trackstarterror|could not start video source|device in use|aborterror/.test(hay)) {
    return {
      kind: 'device_busy',
      title: 'Another app is using the camera',
      detail: 'The camera exists but a video call, another browser tab or a recording app already holds it.',
      remedy: 'Close whatever else is using the camera, then press Retry.',
      retryable: true,
      raw,
    };
  }

  if (/getusermedia unsupported|mediadevices|not available|insecure|typeerror: .*getusermedia/.test(hay)) {
    return {
      kind: 'unsupported',
      title: 'This browser cannot open a camera here',
      detail: 'The camera API is unavailable — usually because the page is not being served over https or localhost.',
      remedy: 'Open the app over https (or on localhost). Until then the keyboard fallback below is the only way to run a session.',
      retryable: false,
      raw,
    };
  }

  if (/wasm|model|landmarker|fileset|task|\.task\b|fetch|network|failed to load|404|import/.test(hay)) {
    return {
      kind: 'model',
      title: 'The movement-tracking model failed to load',
      detail: 'The camera is fine — the MediaPipe model or its runtime could not be loaded or started.',
      remedy: 'Check the connection to the app server and press Retry. If it keeps failing, reload the page: the model files are served with the app.',
      retryable: true,
      raw,
    };
  }

  return {
    kind: 'unknown',
    title: 'The camera could not be started',
    detail: raw,
    remedy: 'Press Retry. If it fails again, reload the page — or run this session on the keyboard.',
    retryable: true,
    raw,
  };
}
