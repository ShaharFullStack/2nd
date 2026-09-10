/**
 * The offset in force has to come back from a reload WITH ITS PROVENANCE.
 *
 * A clinic tablet is closed between patients and the app is a fresh page load every session. Before
 * this, the number survived and everything that made it judgeable did not: `latencyMeasured` came
 * back `false` and `latencyNote` came back empty on every load, so the screens that quote the offset
 * could only quote it anonymously — and nothing could distinguish "0 ms is in force" from "nothing
 * has ever been set here", which is the distinction the latency screen's skip path turns on.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { storageKey } from './persist.ts';

async function loadStore() {
  vi.resetModules();
  return (await import('./store.ts')).useStore;
}

beforeEach(() => {
  localStorage.clear();
});

describe('latency across a reload', () => {
  it('brings back the offset, whether it was measured, its note and its date', async () => {
    const first = await loadStore();
    first.getState().applySuggestedLatency(280, 'Demo Groove');

    const reloaded = await loadStore();
    const s = reloaded.getState();
    expect(s.latencyOffsetSec).toBeCloseTo(0.28, 6);
    expect(s.latencyMeasured).toBe(true);
    expect(s.latencyNote).toContain('Demo Groove');
    expect(s.latencySetAt).toBeGreaterThan(0);
  });

  it('reports "nothing set yet" on a device that has never had a latency', async () => {
    const s = (await loadStore()).getState();
    expect(s.latencySetAt).toBeNull();
    expect(s.latencyOffsetSec).toBe(0);
    expect(s.latencyMeasured).toBe(false);
  });

  it('treats a 0 ms offset that WAS set as in force, not as "never set"', async () => {
    const first = await loadStore();
    first.getState().setLatency(0, true, 'measured at 0 ms');
    const s = (await loadStore()).getState();
    expect(s.latencyOffsetSec).toBe(0);
    expect(s.latencySetAt).not.toBeNull();
    expect(s.latencyMeasured).toBe(true);
  });

  it('still honours an offset written by a build that stored no provenance', async () => {
    // Forward migration: the bare number is what every earlier build wrote. It is in force, it is
    // just unlabelled — and it must not be mistaken for "never set" and overwritten with a default.
    localStorage.setItem(storageKey('latency'), '0.28');
    const s = (await loadStore()).getState();
    expect(s.latencyOffsetSec).toBeCloseTo(0.28, 6);
    expect(s.latencySetAt).toBe(0);
    expect(s.latencyMeasured).toBe(false);
  });

  it('keeps the number when the provenance blob is corrupt', async () => {
    localStorage.setItem(storageKey('latency'), '0.28');
    localStorage.setItem(storageKey('latencyMeta'), '{not json');
    const s = (await loadStore()).getState();
    expect(s.latencyOffsetSec).toBeCloseTo(0.28, 6);
    expect(s.latencySetAt).toBe(0);
  });
});
