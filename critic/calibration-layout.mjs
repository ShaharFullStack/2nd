/** Run against a dev server: node critic/calibration-layout.mjs [--url http://localhost:5173]. */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { chromiumExecutable } from './browser-path.mjs';

const args = process.argv.slice(2);
const base = args.includes('--url') ? args[args.indexOf('--url') + 1] : 'http://localhost:5173';
const browser = await chromium.launch({ executablePath: chromiumExecutable, headless: true });
try {
  const page = await browser.newPage();
  await page.goto(`${base}/?screen=rom`);
  await page.getByTestId('rom-stage').waitFor();
  // CSS viewport sizes account for laptop display scaling and browser zoom, not physical inches.
  for (const [width, height] of [[640,400],[854,480],[960,540],[1024,640],[1366,768],[1920,1080],[390,844]]) {
    await page.setViewportSize({ width, height });
    const boxes = await page.evaluate(() => {
      const box = selector => {
        const r = document.querySelector(selector).getBoundingClientRect();
        return { x:r.x, y:r.y, right:r.right, bottom:r.bottom };
      };
      return { camera:box('.rom-camera'), image:box('.rom-camera-frame'), guide:box('.rom-coach'), header:box('.rom-header'), footer:box('.rom-footer') };
    });
    const context = `${width}x${height}: ${JSON.stringify(boxes)}`;
    // An obsolete media query squeezed the image into a 360px grid column on laptops.
    for (const edge of ['x','y','right','bottom']) assert.ok(Math.abs(boxes.camera[edge] - boxes.image[edge]) <= 1, `Camera squeezed at ${context}`);
    assert.ok(boxes.guide.y >= boxes.header.bottom && boxes.guide.bottom <= boxes.footer.y, `Controls overlap at ${context}`);
    assert.ok(boxes.guide.x >= 0 && boxes.guide.right <= width, `Guide leaves viewport at ${context}`);
    console.log(`Calibration fits ${width}x${height}`);
  }
} finally {
  await browser.close();
}
