import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { CalibrationGuide } from './CalibrationGuide.tsx';
import { RomCalibrator } from '../vision/calibration.ts';

afterEach(cleanup);

it('shows the resting posture while the baseline is measured, not the next exercise', () => {
  render(<CalibrationGuide lane={{index:0,movement:'seated_march',side:'left'}} status={new RomCalibrator('seated_march').getStatus()}
    tracking accepted={false} refused={false} reducedMotion retry={() => {}} />);
  expect(screen.getByTestId('rom-instruction').textContent).toMatch(/Sit upright with both feet flat/);
  expect(screen.getByTestId('rom-instruction').textContent).not.toMatch(/Lift your knee/);
});

it('names the prescribed finger when it is time to move', () => {
  const cal = new RomCalibrator('finger_opposition', {autoAdvance:false});
  cal.push(0,0);
  cal.beginMove();
  render(<CalibrationGuide lane={{index:0,movement:'finger_opposition',side:'right',fingertip:'pinky'}} status={cal.getStatus()}
    tracking accepted={false} refused={false} reducedMotion retry={() => {}} />);
  expect(screen.getByTestId('rom-instruction').textContent).toMatch(/little finger/);
  expect(screen.getByText(/Your right hand/)).toBeTruthy();
});
