import { useEffect } from 'react';
import CameraCheck from './ui/CameraCheck.tsx';
import ErrorBoundary from './ui/ErrorBoundary.tsx';
import HistoryScreen from './ui/History.tsx';
import Home from './ui/Home.tsx';
import LatencyCalibrationScreen from './ui/LatencyCalibration.tsx';
import ModeSelect from './ui/ModeSelect.tsx';
import PatientPicker from './ui/PatientPicker.tsx';
import PlayScreen from './ui/Play.tsx';
import ResultsScreen from './ui/Results.tsx';
import RomCalibrationScreen from './ui/RomCalibration.tsx';
import TherapistSetup from './ui/TherapistSetup.tsx';
import { useStore } from './state/store.ts';

/** Screens that only exist for a camera session. */
const CAMERA_ONLY = new Set(['camera', 'rom', 'latency']);

/**
 * The screen router, under an error boundary.
 *
 * The boundary is not defensive decoration: it is the only thing that releases the camera when a
 * screen throws mid-session (a crash changes no `screen`, so nothing else fires). See
 * src/ui/ErrorBoundary.tsx.
 */
export default function App() {
  return (
    <ErrorBoundary>
      <Screens />
    </ErrorBoundary>
  );
}

function Screens() {
  const screen = useStore((s) => s.screen);
  const inputMode = useStore((s) => s.inputMode);
  const goto = useStore((s) => s.goto);

  // A dev input source has no camera, no ROM and no pipeline latency: those screens would hang.
  useEffect(() => {
    if (inputMode !== 'camera' && CAMERA_ONLY.has(screen)) goto('play');
  }, [inputMode, screen, goto]);

  switch (screen) {
    case 'patients':
      return <PatientPicker />;
    case 'mode':
      return <ModeSelect />;
    case 'setup':
      return <TherapistSetup />;
    case 'camera':
      return <CameraCheck />;
    case 'rom':
      return <RomCalibrationScreen />;
    case 'latency':
      return <LatencyCalibrationScreen />;
    case 'play':
      return <PlayScreen />;
    case 'results':
      return <ResultsScreen />;
    case 'history':
      return <HistoryScreen />;
    case 'home':
    default:
      return <Home />;
  }
}
