import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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

/**
 * THE SET-UP CHANGE, AS ITS OWN BEAT.
 *
 * Three hand movements are measured with the palm to the camera and wrist_extension with the hand over
 * the table edge — ninety degrees apart about the wrist, which is the wrist_extension axis itself. The
 * guide used to carry that difference in one reworded instruction sentence, which is how a patient
 * ends up doing three repetitions against a support that has not moved.
 */
it('asks for the set-up change in its own words, drawn, with nothing being measured', () => {
  const ready = vi.fn();
  render(<CalibrationGuide lane={{ index: 1, movement: 'wrist_extension', side: 'right' }} status={null}
    tracking accepted={false} refused={false} reducedMotion retry={() => {}}
    beat="posture" postureChange={{ from: 'palm_to_camera', to: 'hand_over_edge', onReady: ready }} />);

  expect(screen.getByTestId('rom-visual-guide').dataset.beat).toBe('posture');
  // The move itself, not a description of the destination…
  expect(screen.getByTestId('rom-posture-instruction').textContent).toMatch(/past the edge of the table/i);
  // …and why, naming the movement that needs it.
  expect(screen.getByTestId('rom-posture-why').textContent).toMatch(/Wrist extension is measured with your hand over the table edge/i);
  expect(screen.getByTestId('rom-posture-why').textContent).toMatch(/Nothing is measured until you say you have moved/i);
  // Both setups are DRAWN, so the change does not depend on reading.
  const figures = document.querySelectorAll('.rom-demo-posture [data-posture]');
  expect([...figures].map((f) => f.getAttribute('data-posture'))).toEqual(['palm_to_camera', 'hand_over_edge']);
  // No rest hold, no rep dots, no instruction to perform anything.
  expect(screen.queryByTestId('rom-instruction')).toBeNull();
  expect(document.querySelector('.rom-rep-dots')).toBeNull();

  fireEvent.click(screen.getByTestId('rom-posture-ready'));
  expect(ready).toHaveBeenCalledTimes(1);
});

/** The offer states what it would adopt — and the grade of the measurement it would adopt with it. */
it('offers last session’s range with its range, its date and its quality, and both answers', () => {
  const onUse = vi.fn();
  const onMeasure = vi.fn();
  render(<CalibrationGuide lane={{ index: 0, movement: 'hand_open_close', side: 'left' }} status={null}
    tracking accepted={false} refused={false} reducedMotion retry={() => {}}
    beat="reuse" reuse={{
      rangeText: '0.10 → 0.62', when: 'measured 3 September', note: 'This range was measured at 29 fps.',
      quality: <span data-testid="chip">measured good</span>, onUse, onMeasure,
    }} />);

  expect(screen.getByTestId('rom-visual-guide').dataset.beat).toBe('reuse');
  const facts = screen.getByTestId('rom-reuse-facts');
  expect(facts.textContent).toMatch(/0\.10 → 0\.62/);
  expect(facts.textContent).toMatch(/measured 3 September/);
  expect(screen.getByTestId('chip')).toBeTruthy();
  expect(screen.getByTestId('rom-reuse-quality-sentence').textContent).toMatch(/29 fps/);

  fireEvent.click(screen.getByTestId('rom-reuse-measure'));
  expect(onMeasure).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByTestId('rom-reuse-use'));
  expect(onUse).toHaveBeenCalledTimes(1);
});

/**
 * A REUSED RANGE IS NOT A MEASUREMENT MADE TODAY, and the accepted state may not draw one.
 *
 * Nothing ran a calibrator on this lane: the rest ring would sit at zero under "keep still while the
 * ring fills" and the rep dots would tick three repetitions nobody performed.
 */
it('says a reused range was not measured today, and shows no repetitions for it', () => {
  render(<CalibrationGuide lane={{ index: 0, movement: 'hand_open_close', side: 'left' }} status={null}
    tracking accepted refused={false} reducedMotion retry={() => {}} reused />);
  expect(screen.getByRole('heading').textContent).toMatch(/Last time’s range in use/);
  expect(screen.getByTestId('rom-instruction').textContent).toMatch(/Nothing was measured just now/);
  expect(screen.getByTestId('rom-reused-progress').textContent).toMatch(/No repetitions were measured today/);
  expect(document.querySelector('.rom-rep-dots')).toBeNull();
  expect(document.querySelector('.ring-label')).toBeNull();
});
