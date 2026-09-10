import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isPersistenceAvailable, makePersister, readJson, removeKey, storageKey, writeJson } from './persist.ts';

describe('persist', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useRealTimers();
  });

  it('round-trips a value under the app prefix', () => {
    expect(writeJson('thing', { a: 1 })).toBe(true);
    expect(localStorage.getItem(storageKey('thing'))).toBe('{"a":1}');
    expect(readJson('thing', { a: 0 })).toEqual({ a: 1 });
  });

  it('falls back when nothing is stored', () => {
    expect(readJson('missing', 'default')).toBe('default');
  });

  it('falls back on corrupt JSON instead of throwing', () => {
    localStorage.setItem(storageKey('broken'), '{not json');
    expect(readJson('broken', 7)).toBe(7);
  });

  it('lets the validator repair or refuse a stored value', () => {
    writeJson('n', 'twelve');
    const validated = readJson<number>('n', 0, (raw) => (typeof raw === 'number' ? raw : null));
    expect(validated).toBe(0);
    writeJson('n', 12);
    expect(readJson<number>('n', 0, (raw) => (typeof raw === 'number' ? raw : null))).toBe(12);
  });

  it('survives a storage that throws on every access', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceeded');
    });
    expect(writeJson('x', 1)).toBe(false);
    expect(isPersistenceAvailable()).toBe(false);
    spy.mockRestore();
  });

  it('removeKey deletes only the prefixed key', () => {
    writeJson('gone', 1);
    localStorage.setItem('gone', 'untouched');
    removeKey('gone');
    expect(localStorage.getItem(storageKey('gone'))).toBeNull();
    expect(localStorage.getItem('gone')).toBe('untouched');
  });

  it('makePersister coalesces bursts into one write', async () => {
    const persist = makePersister<{ n: number }, number>('coalesced', (s) => s.n, 5);
    persist({ n: 1 });
    persist({ n: 2 });
    persist({ n: 3 });
    await new Promise((r) => setTimeout(r, 25));
    expect(readJson('coalesced', -1)).toBe(3);
  });
});
