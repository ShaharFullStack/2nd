import { existsSync } from 'node:fs';

// Keep the optional preinstalled browser usable in the critic environment. On CI,
// leave this unset so Playwright uses the browser installed by its own CLI.
const preinstalled = '/opt/pw-browsers/chromium';
export const chromiumExecutable = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ||
  (existsSync(preinstalled) ? preinstalled : undefined);
