import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { CameraPreview } from './CameraPreview.tsx';

const camera = vi.hoisted(() => ({ video: null as HTMLVideoElement | null }));
vi.mock('../session/runtime.ts', () => ({ runtime: { peekVision: () => ({ getVideoElement: () => camera.video }) } }));
afterEach(cleanup);

it('reports the actual camera aspect on arrival and when the video dimensions change', () => {
  const video = document.createElement('video');
  camera.video = video;
  Object.defineProperties(video, { videoWidth: { value:1280, writable:true }, videoHeight: { value:720, writable:true } });
  const aspect = vi.fn();
  const view = render(<CameraPreview onAspectRatioChange={aspect} />);
  expect(aspect).toHaveBeenLastCalledWith(16 / 9);
  Object.defineProperties(video, { videoWidth: { value:640 }, videoHeight: { value:480 } });
  video.dispatchEvent(new Event('resize'));
  expect(aspect).toHaveBeenLastCalledWith(4 / 3);
  view.unmount();
  aspect.mockClear();
  video.dispatchEvent(new Event('resize'));
  expect(aspect).not.toHaveBeenCalled();
});
