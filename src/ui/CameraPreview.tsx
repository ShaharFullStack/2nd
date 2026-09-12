import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { runtime } from '../session/runtime.ts';
import { drawDetection } from './overlay.ts';
import type { DetectionResult } from '../vision/mediapipe.ts';

/**
 * The live camera, shown wherever the patient needs to see themselves.
 *
 * There is exactly ONE <video> in the app — the element the vision module is running detection on —
 * so this MOVES it into place and puts it back when the screen unmounts. Cloning it would mean a
 * second decode of the same stream for no benefit.
 */
export function CameraPreview({
  overlay = false,
  className = 'camera-frame mirror',
  children,
}: {
  overlay?: boolean;
  className?: string;
  /** Drawn INSIDE the frame, over the video and the landmark overlay (the hands-free dwell targets). */
  children?: ReactNode;
}) {
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const latest = useRef<DetectionResult | null>(null);

  useEffect(() => {
    const vision = runtime.peekVision();
    const video = vision?.getVideoElement();
    const el = host.current;
    if (!video || !el) return;
    video.setAttribute('playsinline', '');
    video.muted = true;
    el.prepend(video);

    let raf = 0;
    let off: (() => void) | null = null;
    if (overlay && vision) {
      off = vision.onFrame((_s, _t, result) => {
        latest.current = result;
      });
      const paint = () => {
        const c = canvas.current;
        const ctx = c?.getContext('2d');
        if (c && ctx) {
          const w = c.clientWidth || 320;
          const h = c.clientHeight || 240;
          if (c.width !== w || c.height !== h) {
            c.width = w;
            c.height = h;
          }
          drawDetection(ctx, latest.current, c.width, c.height);
        }
        raf = requestAnimationFrame(paint);
      };
      raf = requestAnimationFrame(paint);
    }

    return () => {
      off?.();
      if (raf) cancelAnimationFrame(raf);
      if (video.parentElement === el) el.removeChild(video);
    };
  }, [overlay]);

  return (
    <div className={className} ref={host}>
      {overlay && <canvas ref={canvas} />}
      {children}
    </div>
  );
}
