/**
 * The calibration screen fits, without scrolling, on every viewport a clinic tablet can present —
 * because a patient who cannot touch the glass cannot scroll either.
 *
 * Three states are driven, not one: the MEASUREMENT (rest hold and three reps), the SET-UP CHANGE
 * that a mixed hand prescription has to ask for before the movement that needs the other posture, and
 * the REUSE OFFER a return visit opens on. The last two are laid out differently (a wide two-figure
 * illustration; two answers side by side) and neither is reachable from a cold `?screen=rom`, so a
 * check of the default state alone would say nothing about them.
 *
 * Run against a dev server: node critic/calibration-layout.mjs [--url http://localhost:5173].
 */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { chromiumExecutable } from './browser-path.mjs';

const args = process.argv.slice(2);
const base = args.includes('--url') ? args[args.indexOf('--url') + 1] : 'http://localhost:5173';
// CSS viewport sizes account for laptop display scaling and browser zoom, not physical inches.
const VIEWPORTS = [[640, 400], [854, 480], [960, 540], [1024, 640], [1366, 768], [1920, 1080], [390, 844]];

/** A hand prescription measured in BOTH hand setups, with last session's ranges already on file. */
const LANES = [
  { index: 0, movement: 'hand_open_close', side: 'left' },
  { index: 1, movement: 'wrist_extension', side: 'right' },
  { index: 2, movement: 'finger_spread', side: 'left' },
];
const SAVED = Object.fromEntries(
  LANES.map((l) => [
    `${l.movement}:${l.side}`,
    {
      min: l.movement === 'finger_spread' ? 12 : 0.1,
      max: l.movement === 'finger_spread' ? 46 : 0.62,
      samples: 140, movement: l.movement, mirrored: false, peaks: [0.58, 0.61, 0.62],
      capturedAt: Date.parse('2026-09-03T10:12:00Z'),
      measurement: { frames: 300, tracked: 291, trackedFraction: 0.97, fpsMedian: 29.4, fpsLow: 25.1, durationSec: 10.2, reps: 3, repSpread: 0.04, repSpreadFraction: 0.077 },
    },
  ]),
);

const browser = await chromium.launch({ executablePath: chromiumExecutable, headless: true });
try {
  const page = await browser.newPage();
  await page.goto(`${base}/?screen=rom`);
  await page.getByTestId('rom-stage').waitFor();

  const fits = async (label) => {
    for (const [width, height] of VIEWPORTS) {
      await page.setViewportSize({ width, height });
      const boxes = await page.evaluate(() => {
        const box = selector => {
          const r = document.querySelector(selector).getBoundingClientRect();
          return { x:r.x, y:r.y, right:r.right, bottom:r.bottom };
        };
        const coach = document.querySelector('.rom-coach').getBoundingClientRect();
        const spills = [];
        for (const el of document.querySelectorAll('.rom-coach *')) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) continue;
          if (r.right > coach.right + 1 || r.left < coach.left - 1 || r.bottom > coach.bottom + 1 || r.top < coach.top - 1) {
            spills.push(`${el.getAttribute('data-testid') || el.className || el.tagName}`);
          }
        }
        return { camera:box('.rom-camera'), image:box('.rom-camera-frame'), guide:box('.rom-coach'), header:box('.rom-header'), footer:box('.rom-footer'),
          spills, scroll: document.documentElement.scrollHeight - window.innerHeight };
      });
      const context = `${label} at ${width}x${height}: ${JSON.stringify(boxes)}`;
      // An obsolete media query squeezed the image into a 360px grid column on laptops.
      for (const edge of ['x','y','right','bottom']) assert.ok(Math.abs(boxes.camera[edge] - boxes.image[edge]) <= 1, `Camera squeezed at ${context}`);
      assert.ok(boxes.guide.y >= boxes.header.bottom && boxes.guide.bottom <= boxes.footer.y, `Controls overlap at ${context}`);
      assert.ok(boxes.guide.x >= 0 && boxes.guide.right <= width, `Guide leaves viewport at ${context}`);
      // A control pushed outside its own panel is off the screen for a patient two metres away even
      // when the panel itself still fits: at 390 px the two answers to the reuse offer did exactly that.
      assert.equal(boxes.spills.join(', '), '', `Content spills out of the coach panel at ${context}`);
      assert.ok(boxes.scroll <= 1, `Page scrolls at ${context}`);
      console.log(`${label} fits ${width}x${height}`);
    }
  };

  const beat = () => page.getByTestId('rom-visual-guide').getAttribute('data-beat');
  await fits('Calibration');

  // Seed a return visit on a prescription that needs both hand setups.
  await page.evaluate(([lanes, savedCalibrations]) => {
    window.__beatRehab.store.setState({ mode: 'hand', lanes, calibrations: lanes.map(() => null), savedCalibrations, screen: 'rom' });
  }, [LANES, SAVED]);
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.getByTestId('rom-reuse-use').waitFor();
  assert.equal(await beat(), 'reuse', 'a return visit opens on the offer of last session’s range');
  await fits('Reuse offer');

  // Take it for the two palm-to-camera lanes, then decline it on the lane measured over the table
  // edge: that is the state the set-up change is asked in.
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.getByTestId('rom-reuse-use').click();
  await page.getByTestId('rom-next').click();
  await page.getByTestId('rom-reuse-use').click();
  await page.getByTestId('rom-next').click();
  await page.getByTestId('rom-reuse-measure').click();
  await page.getByTestId('rom-posture-ready').waitFor();
  assert.equal(await beat(), 'posture', 'the set-up change is asked for before the movement that needs it');
  await fits('Set-up change');
} finally {
  await browser.close();
}
