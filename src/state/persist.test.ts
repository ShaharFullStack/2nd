import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createListSync,
  createMapSync,
  isPersistenceAvailable,
  onExternalChange,
  readJson,
  reconcileList,
  removeKey,
  storageKey,
  writeJson,
} from './persist.ts';

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
});

// ------------------------------------------------------------------ two tabs on one tablet

interface Rec { id: string; n: number }
const recs = (raw: unknown): Rec[] | null => (Array.isArray(raw) ? (raw as Rec[]) : null);
const listSync = () => createListSync<Rec>('recs', { idOf: (r) => r.id, validate: recs });

describe('reconcileList', () => {
  it('keeps a record only the other tab has', () => {
    const merged = reconcileList([{ id: 'a', n: 1 }], [{ id: 'b', n: 2 }], (r) => r.id, new Set());
    expect(merged.map((r) => r.id).sort()).toEqual(['a', 'b']);
  });

  it('does NOT resurrect a record this tab deliberately deleted', () => {
    // 'b' is known here — this tab had it and dropped it. The merge must respect the deletion.
    const merged = reconcileList([{ id: 'a', n: 1 }], [{ id: 'a', n: 1 }, { id: 'b', n: 2 }], (r) => r.id, new Set(['a', 'b']));
    expect(merged.map((r) => r.id)).toEqual(['a']);
  });

  it('lets this tab win for a record both hold (it is the one just edited)', () => {
    const merged = reconcileList([{ id: 'a', n: 9 }], [{ id: 'a', n: 1 }], (r) => r.id, new Set(['a']));
    expect(merged).toEqual([{ id: 'a', n: 9 }]);
  });

  it('returns the caller\'s own array when nothing had to be merged', () => {
    const mine = [{ id: 'a', n: 1 }];
    expect(reconcileList(mine, [], (r) => r.id, new Set())).toBe(mine);
  });

  it('applies the caller\'s order only when a merge actually happened', () => {
    const order = (a: Rec, b: Rec) => b.n - a.n;
    const mine = [{ id: 'a', n: 1 }, { id: 'b', n: 5 }];
    expect(reconcileList(mine, [], (r) => r.id, new Set(), order)).toBe(mine);
    expect(reconcileList(mine, [{ id: 'c', n: 3 }], (r) => r.id, new Set(), order).map((r) => r.n)).toEqual([5, 3, 1]);
  });
});

describe('createListSync (the write path two tabs share)', () => {
  beforeEach(() => localStorage.clear());
  it('carries the other tab\'s records into this tab\'s write instead of overwriting them', () => {
    const tabA = listSync();
    const tabB = listSync();
    // Both tabs loaded when the key was empty; each then records its own session.
    tabA.write([{ id: 'a', n: 1 }]);
    const { merged } = tabB.write([{ id: 'b', n: 2 }]);
    expect(merged.map((r) => r.id).sort()).toEqual(['a', 'b']);
    expect(readJson<Rec[]>('recs', []).map((r) => r.id).sort()).toEqual(['a', 'b']);
  });

  it('a deletion in this tab survives the reconciliation', () => {
    const tab = listSync();
    tab.write([{ id: 'a', n: 1 }, { id: 'b', n: 2 }]);
    tab.write([{ id: 'a', n: 1 }]); // therapist deleted 'b'
    expect(readJson<Rec[]>('recs', []).map((r) => r.id)).toEqual(['a']);
  });

  it('read() adopts what is on disk AND remembers it, so the next write does not undo a foreign delete', () => {
    const tabA = listSync();
    const tabB = listSync();
    tabA.write([{ id: 'a', n: 1 }, { id: 'b', n: 2 }]);
    expect(tabB.read().map((r) => r.id)).toEqual(['a', 'b']); // B adopts A's records
    tabA.write([{ id: 'a', n: 1 }]); // A deletes 'b'
    tabB.read(); // …and B is told
    tabB.write([{ id: 'a', n: 1 }]);
    expect(readJson<Rec[]>('recs', []).map((r) => r.id)).toEqual(['a']);
  });

  it('reports a refused write without losing the merged value', () => {
    const tab = listSync();
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceeded');
    });
    const res = tab.write([{ id: 'a', n: 1 }]);
    spy.mockRestore();
    expect(res.ok).toBe(false);
    expect(res.merged).toEqual([{ id: 'a', n: 1 }]);
  });
});

describe('createMapSync', () => {
  beforeEach(() => localStorage.clear());
  const sync = () =>
    createMapSync<number>('counts', {
      validate: (raw) => (raw && typeof raw === 'object' ? (raw as Record<string, number>) : null),
      mergeValue: (mine, theirs) => Math.max(mine, theirs),
    });

  it('keeps a key only the other tab has and reconciles a shared one', () => {
    const tabA = sync();
    const tabB = sync();
    tabA.write({ p1: 3, p2: 1 });
    const { merged } = tabB.write({ p1: 2, p3: 7 });
    expect(merged).toEqual({ p1: 3, p2: 1, p3: 7 });
  });

  it('does not bring back a key this tab removed', () => {
    const tab = sync();
    tab.write({ p1: 1, p2: 2 });
    tab.write({ p1: 1 });
    expect(readJson<Record<string, number>>('counts', {})).toEqual({ p1: 1 });
  });
});

/**
 * TWO TABS WRITING AT THE SAME INSTANT.
 *
 * `localStorage` read-modify-write is not atomic across tabs, so reconcile-on-write cannot help when
 * both tabs read the same key, merge, and write within the same tick: the second write lands whole
 * and the first tab's record is gone from disk with no error and no undo. Measured on a real tablet
 * with two tabs recording sessions at once, that destroyed a session in 3 trials out of 3.
 *
 * The repair each write schedules is what closes it. These tests interleave the two tabs by hand —
 * both reading before either writes, which is exactly the race — and then let the repairs run.
 */
describe('two tabs writing at the same instant', () => {
  beforeEach(() => localStorage.clear());

  /**
   * THE RACE, REPRODUCED. Both tabs must have READ the key before either of them writes — that is
   * the interleaving `localStorage` gives no way to prevent, and the one reconcile-on-write cannot
   * see. Freezing `getItem` at the pre-write value for the duration of both writes is exactly that.
   */
  function bothReadBeforeEitherWrites(run: () => void): void {
    const frozen = localStorage.getItem(storageKey('recs'));
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockReturnValue(frozen);
    try {
      run();
    } finally {
      spy.mockRestore();
    }
  }

  it('never destroys the other tab\'s record: both survive on disk', async () => {
    const tabA = listSync();
    const tabB = listSync();
    let a!: ReturnType<typeof tabA.write>;
    let b!: ReturnType<typeof tabB.write>;
    bothReadBeforeEitherWrites(() => {
      a = tabA.write([{ id: 'A1', n: 1 }]);
      b = tabB.write([{ id: 'B1', n: 2 }]);
    });
    // The raw damage this repair exists for: B's write landed whole and A1 is gone from disk.
    expect(readJson<Rec[]>('recs', []).map((r) => r.id)).toEqual(['B1']);
    expect(a.merged.map((r) => r.id)).toEqual(['A1']);
    expect(b.merged.map((r) => r.id)).toEqual(['B1']);

    await tabA.settled();
    await tabB.settled();

    expect(readJson<Rec[]>('recs', []).map((r) => r.id).sort()).toEqual(['A1', 'B1']);
  });

  it('hands the restored list back so the tab in memory matches the disk', async () => {
    const adopted: string[][] = [];
    const tabA = createListSync<Rec>('recs', {
      idOf: (r) => r.id,
      validate: recs,
      onRepaired: (list) => adopted.push(list.map((r) => r.id)),
    });
    const tabB = listSync();
    bothReadBeforeEitherWrites(() => {
      tabA.write([{ id: 'A1', n: 1 }]);
      tabB.write([{ id: 'B1', n: 2 }]);
    });
    await tabA.settled();
    expect(adopted.at(-1)!.sort()).toEqual(['A1', 'B1']);
  });

  it('restores a clobbered record but NEVER resurrects a deleted one', async () => {
    const tabA = listSync();
    tabA.write([{ id: 's1', n: 1 }]);
    await tabA.settled();
    // A deletes s1 and, in the same tick, records s2.
    tabA.write([{ id: 's2', n: 2 }]);
    await tabA.settled();
    expect(readJson<Rec[]>('recs', []).map((r) => r.id)).toEqual(['s2']);
  });

  it('does not put back a record this tab deleted a moment after saving it', async () => {
    // A mis-started run: saved, then deleted before the repair for the save has run.
    const tab = listSync();
    tab.write([{ id: 'keep', n: 0 }, { id: 'oops', n: 1 }]);
    tab.write([{ id: 'keep', n: 0 }]);
    await tab.settled();
    expect(readJson<Rec[]>('recs', []).map((r) => r.id)).toEqual(['keep']);
  });

  it('does the same for a per-key map (the calibrated ranges)', async () => {
    const map = () =>
      createMapSync<number>('counts', {
        validate: (raw) => (raw && typeof raw === 'object' ? (raw as Record<string, number>) : null),
        mergeValue: (mine, theirs) => Math.max(mine, theirs),
      });
    const tabA = map();
    const tabB = map();
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockReturnValue(null);
    tabA.write({ p1: 3 });
    tabB.write({ p2: 7 });
    spy.mockRestore();
    expect(readJson<Record<string, number>>('counts', {})).toEqual({ p2: 7 });
    await tabA.settled();
    await tabB.settled();
    expect(readJson<Record<string, number>>('counts', {})).toEqual({ p1: 3, p2: 7 });
  });
});

describe('onExternalChange', () => {
  it('fires for a watched key, ignores others, and reports a cleared storage', () => {
    const seen: string[] = [];
    const stop = onExternalChange(['history', 'patients'], (n) => seen.push(n));
    window.dispatchEvent(new StorageEvent('storage', { key: storageKey('history'), storageArea: localStorage }));
    window.dispatchEvent(new StorageEvent('storage', { key: storageKey('settings'), storageArea: localStorage }));
    window.dispatchEvent(new StorageEvent('storage', { key: null, storageArea: localStorage }));
    stop();
    window.dispatchEvent(new StorageEvent('storage', { key: storageKey('history'), storageArea: localStorage }));
    expect(seen).toEqual(['history', 'history', 'patients']);
  });
});
