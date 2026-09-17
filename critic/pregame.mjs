import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import { chromiumExecutable } from './browser-path.mjs';

const browser = await chromium.launch({ executablePath: chromiumExecutable, headless: true });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
mkdirSync('critic/screenshots', { recursive: true });
try {
  for (const [width, height] of [[1440, 900], [1024, 768], [390, 844]]) {
    await page.setViewportSize({ width, height });
    await page.goto('http://localhost:5173/?input=keyboard');
    await page.getByTestId('start-session').waitFor();
    await page.screenshot({ path: `critic/screenshots/pregame-${width}.png`, fullPage: true });
    assert(await page.evaluate(() => document.querySelector('.screen').scrollWidth <= innerWidth), 'home must fit width');
    await page.getByText('Display & sound', { exact: true }).first().click();
    await page.getByLabel('High-contrast lanes').check();
    assert(await page.getByLabel('High-contrast lanes').isChecked());
    await page.getByText('Display & sound', { exact: true }).first().click();
    await page.evaluate(() => {
      window.menuTransitions = 0;
      const original = document.startViewTransition.bind(document);
      document.startViewTransition = (...args) => { window.menuTransitions++; return original(...args); };
    });
    await page.getByTestId('start-session').click();
    await page.getByTestId('mode-leg').waitFor();
    await page.waitForFunction(() => !document.getAnimations().some(a => a.playState === 'running'));
    assert.equal(await page.evaluate(() => window.menuTransitions), 1);
    await page.screenshot({ path: `critic/screenshots/modes-${width}.png`, fullPage: true });
    assert(await page.evaluate(() => document.querySelector('.screen').scrollWidth <= innerWidth), 'modes must fit width');
    await page.getByTestId('mode-hand').click();
    await page.getByTestId('pregame-mode').waitFor({ state: 'detached' });
  }
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('http://localhost:5173/?input=keyboard');
  await page.getByTestId('start-session').waitFor();
  await page.evaluate(() => {
    document.startViewTransition = () => { throw new Error('Reduced motion must bypass transitions'); };
  });
  await page.getByTestId('start-session').click();
  await page.getByTestId('mode-leg').waitFor();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('http://localhost:5173/');
  await page.getByTestId('start-session').waitFor();
  await page.screenshot({ path: 'critic/screenshots/pregame-camera-mobile.png' });
  await page.getByTestId('start-session').click();
  await page.getByTestId('pregame-home').waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => window.__beatRehab.store.getState().screen), 'patients');
  assert.deepEqual(errors, []);
  console.log('Pregame verified at desktop, tablet and mobile sizes; settings, navigation and reduced motion passed.');
} finally {
  await browser.close();
}
