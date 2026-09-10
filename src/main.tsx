import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';
import { mountDemoIfRequested } from './render/demo.ts';
import { applyUrlParams, installDebugHandle } from './session/bootstrap.ts';

const root = document.getElementById('root');
if (!root) throw new Error('#root missing');

// ?demo=highway mounts the renderer's own driver instead of the app — no store, no audio, no camera.
if (!mountDemoIfRequested(document.body)) {
  applyUrlParams(location.search);
  installDebugHandle();
  // No <StrictMode>: its deliberate double-mount would start two game loops (and two songs) on the
  // Play screen in development. The screens are effect-heavy by nature — a camera, an audio graph and
  // an animation loop — so the double-invoke check costs more than it catches here.
  createRoot(root).render(<App />);
}
