/**
 * public/wasm MUST be a byte-for-byte copy of the INSTALLED @mediapipe/tasks-vision runtime.
 *
 * `FilesetResolver.forVisionTasks('/wasm')` (mediapipe.ts DEFAULT_WASM_PATH) loads the glue JS and the
 * .wasm binaries from public/wasm, while the bundler links `import('@mediapipe/tasks-vision')` against
 * whatever is in node_modules. Those are two independent copies of one runtime, and nothing but this
 * test ties them together: the dependency is a caret range, so a routine `npm update` / a fresh
 * `npm install` on a new machine can bump the bundled JS while the hand-copied wasm glue stays behind.
 * The result is a version-mismatched runtime that fails ONLY in a real browser, on a real patient's
 * camera check — never in the suite, never in typecheck, never in the build.
 *
 * This test is the guard. When it fails, re-copy the assets:
 *   cp node_modules/@mediapipe/tasks-vision/wasm/* public/wasm/
 * (and, ideally, add that as a `postinstall`/`sync-wasm` script in package.json — this module is not
 * allowed to edit package.json, so the check lives here instead. See the integrator note.)
 */
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_WASM_PATH } from './mediapipe.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PUBLIC_WASM = join(ROOT, 'public', 'wasm');
const PKG_WASM = join(ROOT, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

describe('bundled MediaPipe wasm runtime', () => {
  it('serves the assets from the path the loader asks for', () => {
    expect(DEFAULT_WASM_PATH).toBe('/wasm');
    expect(existsSync(PUBLIC_WASM)).toBe(true);
  });

  it('is byte-identical to the installed @mediapipe/tasks-vision package', () => {
    if (!existsSync(PKG_WASM)) {
      // No node_modules (a lint-only CI job): there is nothing to compare against, and asserting
      // would fail for a reason that has nothing to do with drift.
      expect(existsSync(PUBLIC_WASM)).toBe(true);
      return;
    }
    const shipped = readdirSync(PUBLIC_WASM).filter((f) => f.endsWith('.js') || f.endsWith('.wasm')).sort();
    const installed = readdirSync(PKG_WASM).filter((f) => f.endsWith('.js') || f.endsWith('.wasm')).sort();
    expect(shipped.length).toBeGreaterThan(0);
    // Every file the package ships must be served, or the resolver picks a variant we do not have
    // (the nosimd build is chosen at runtime from the browser's capabilities, not at copy time).
    expect(shipped).toEqual(installed);
    for (const f of installed) {
      const a = join(PUBLIC_WASM, f);
      const b = join(PKG_WASM, f);
      expect(statSync(a).size, `public/wasm/${f} differs in SIZE from node_modules — re-copy it`).toBe(statSync(b).size);
      expect(sha256(a), `public/wasm/${f} differs in CONTENT from node_modules — re-copy it`).toBe(sha256(b));
    }
  });
});
