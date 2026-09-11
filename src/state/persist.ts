/**
 * Tiny localStorage helper.
 *
 * Every access is wrapped: a clinic tablet in private mode, a full quota, or a browser with site data
 * blocked throws on `localStorage` itself, and losing the settings is never a reason to lose the
 * session in progress. Reads validate with a caller-supplied guard, so a half-written or
 * schema-drifted value degrades to the default instead of crashing the Home screen.
 */

export const STORAGE_PREFIX = 'beatRehab:';

export function storageKey(name: string): string {
  return `${STORAGE_PREFIX}${name}`;
}

function storage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

/** True when persistence is actually available (used by the UI to warn that history will not be kept). */
export function isPersistenceAvailable(): boolean {
  const s = storage();
  if (!s) return false;
  try {
    const probe = storageKey('__probe');
    s.setItem(probe, '1');
    s.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read and validate a persisted value. `validate` returns the value to use (it may repair/migrate) or
 * null to fall back.
 */
export function readJson<T>(name: string, fallback: T, validate?: (raw: unknown) => T | null): T {
  const s = storage();
  if (!s) return fallback;
  let text: string | null = null;
  try {
    text = s.getItem(storageKey(name));
  } catch {
    return fallback;
  }
  if (text === null) return fallback;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fallback;
  }
  if (!validate) return parsed as T;
  const ok = validate(parsed);
  return ok === null ? fallback : ok;
}

/** Write a value. Returns false when persistence is unavailable or the quota refused it. */
export function writeJson(name: string, value: unknown): boolean {
  const s = storage();
  if (!s) return false;
  try {
    s.setItem(storageKey(name), JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function removeKey(name: string): void {
  const s = storage();
  if (!s) return;
  try {
    s.removeItem(storageKey(name));
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------- two tabs, one tablet

/**
 * TWO TABS ON ONE CLINIC TABLET USED TO EAT EACH OTHER'S SESSIONS.
 *
 * Every screen reads its records out of the store, and the store's copy is a SNAPSHOT taken once at
 * module load. A write replays that whole snapshot over the key, so the last tab to record a session
 * overwrote everything the other tab had recorded since it loaded — silently, with no error and no
 * way back. On a device where the therapist opens a second tab to look at history while a session
 * runs (or just never closes yesterday's tab), that is patient work being deleted.
 *
 * The mechanism here is deliberately NOT a schema change: the stored shapes are exactly what they
 * were. Three rules are added around every write of a shared collection.
 *
 *  1. RECONCILE ON WRITE. The value on disk is re-read at the moment of writing and anything in it
 *     this tab has never seen — another tab's sessions, another tab's patients — is carried into the
 *     write. "Never seen" is the load-bearing part: a record this tab knows about and no longer has
 *     was DELETED here, and a deletion must not be undone by the merge.
 *  2. ADOPT ON `storage`. When another tab writes, the browser tells this one. The other tab's write
 *     already merged in everything of ours it could see, so what is on disk is the union — this tab
 *     adopts it wholesale, which is also what propagates a deletion made in the other tab.
 *  3. RESTORE WHAT A CLOBBER TOOK, UNDER A LOCK. Rules 1 and 2 fix the realistic case — the tabs take
 *     turns — but `localStorage` read-modify-write is NOT atomic across tabs, and reconcile-on-write
 *     cannot close that: two tabs that read the empty key, merge, and write in the same instant both
 *     produce a list containing only their own record, and the second one lands. Measured on a real
 *     tablet with two tabs recording at once: 3 trials out of 3 destroyed a session outright, gone
 *     from disk AND from the recording tab's own memory once it adopted the winner.
 *
 *     So every write ALSO schedules a check, run inside `navigator.locks` (the one primitive that
 *     serializes across tabs, with a same-tab promise chain as the fallback): re-read the key, and if
 *     a record THIS WRITE PUT THERE is no longer on disk, put it back — appended to whatever is on
 *     disk now, so the other tab's records are kept too and both tabs converge on the union.
 *
 *     It restores ONLY the records that write created. That is the line that keeps a restore from
 *     becoming a resurrection: a record another tab DELETED was never created by this write, so it is
 *     never put back, and deletion still propagates exactly as before.
 */

/**
 * Run `job` with nothing else on this device inside the same named lock.
 *
 * `navigator.locks` is the only cross-tab mutex a browser offers, and a read-modify-write of a
 * shared record list is exactly what it is for. Where it is missing (older Safari, a jsdom test) the
 * promise chain still serializes this tab's own repairs, which is what makes the behaviour testable;
 * the cross-tab guarantee simply degrades to the reconcile-on-write that was there before.
 */
type LockManagerLike = { request: (name: string, cb: () => Promise<void> | void) => Promise<unknown> };

const lockChains = new Map<string, Promise<void>>();

export function withRecordLock(name: string, job: () => void): Promise<void> {
  const run = (): void => {
    try {
      job();
    } catch (err) {
      console.warn('[persist] reconciling a shared record list failed', err);
    }
  };
  let locks: LockManagerLike | undefined;
  try {
    locks = (globalThis.navigator as unknown as { locks?: LockManagerLike } | undefined)?.locks;
  } catch {
    locks = undefined;
  }
  const step = (): Promise<void> =>
    locks && typeof locks.request === 'function'
      ? Promise.resolve(locks.request(storageKey(name), () => void run())).then(
          () => undefined,
          // A refused/aborted lock must never mean the record is left lost: do the work unguarded.
          () => void run(),
        )
      : Promise.resolve().then(run);
  const next = (lockChains.get(name) ?? Promise.resolve()).then(step, step);
  lockChains.set(name, next);
  return next;
}

/** Resolves once every repair scheduled so far for `name` has run. Used by tests. */
export function recordLockSettled(name: string): Promise<void> {
  return lockChains.get(name) ?? Promise.resolve();
}

/** The outcome of a reconciled write: what actually went to disk, and whether it differs from ours. */
export interface MergeResult<T> {
  /** False when persistence refused the write (quota / blocked site data). */
  ok: boolean;
  /** The reconciled value — what is now on disk, and what the caller should hold in memory. */
  merged: T;
  /** True when the reconciliation added something this tab did not have. */
  changed: boolean;
}

/**
 * Merge `mine` with the list `disk` currently holds. Items on disk this tab has never seen are
 * appended (another tab wrote them); items this tab has seen and dropped stay dropped (a deletion);
 * for anything in both, this tab's version wins (it is the one the therapist just edited).
 *
 * Returns `mine` itself when nothing had to be added, so callers can detect "no reconciliation
 * needed" by identity.
 */
export function reconcileList<T>(
  mine: readonly T[],
  disk: readonly T[],
  idOf: (item: T) => string,
  known: ReadonlySet<string>,
  order?: (a: T, b: T) => number,
): T[] {
  const ours = new Set<string>();
  for (const item of mine) ours.add(idOf(item));
  const extra = disk.filter((d) => {
    const id = idOf(d);
    return !ours.has(id) && !known.has(id);
  });
  if (extra.length === 0) return mine as T[];
  const merged = [...mine, ...extra];
  return order ? merged.sort(order) : merged;
}

/** A list of identified records shared by every tab on the device (sessions, patients). */
export interface ListSync<T> {
  /** Record that this tab has seen these ids (the initial load, or a list adopted from another tab). */
  know(items: readonly T[]): void;
  /** Reconcile with disk and write. */
  write(mine: readonly T[]): MergeResult<T[]>;
  /** What is on disk right now, validated (used when another tab announces a write). */
  read(): T[];
  /** Resolves once every locked repair scheduled so far has run. Tests await this. */
  settled(): Promise<void>;
}

export function createListSync<T>(
  name: string,
  options: {
    idOf: (item: T) => string;
    validate: (raw: unknown) => T[] | null;
    order?: (a: T, b: T) => number;
    /**
     * A repair put records back on disk (or brought another tab's in). The list handed over is what
     * is on disk NOW, and the store must adopt it — otherwise the in-memory copy is the stale one
     * and the next write would drop the other tab's records all over again.
     */
    onRepaired?: (merged: T[]) => void;
  },
): ListSync<T> {
  const known = new Set<string>();
  const know = (items: readonly T[]): void => {
    for (const item of items) known.add(options.idOf(item));
  };
  const read = (): T[] => readJson<T[]>(name, [], options.validate);

  /** What this tab last put on disk. A repair may only restore records this is still holding. */
  let lastWritten: readonly T[] = [];

  /**
   * `created` are the records this write PUT on disk. If a concurrent tab's write landed on top and
   * took them away, append them to whatever is there now. Building the result from DISK (not from
   * our own list) is what keeps the other tab's records and keeps its deletions deleted.
   *
   * A repair runs a tick after the write it belongs to, and in that tick THIS tab may have deleted
   * the very record it is about to put back — a mis-started run deleted straight after it was saved
   * is the everyday case. So the restore is filtered against what this tab last wrote: a record it
   * no longer holds is a record it meant to remove, and no repair may undo that.
   */
  const repair = (created: readonly T[]): Promise<void> =>
    withRecordLock(name, () => {
      const wanted = new Set(lastWritten.map(options.idOf));
      const still = created.filter((item) => wanted.has(options.idOf(item)));
      if (still.length === 0) return;
      const disk = read();
      const present = new Set(disk.map(options.idOf));
      const lost = still.filter((item) => !present.has(options.idOf(item)));
      if (lost.length === 0) return;
      const restored = options.order ? [...disk, ...lost].sort(options.order) : [...disk, ...lost];
      know(restored);
      lastWritten = restored;
      if (writeJson(name, restored)) options.onRepaired?.(restored);
    });

  return {
    know,
    settled: () => recordLockSettled(name),
    read: () => {
      const disk = read();
      know(disk);
      return disk;
    },
    write: (mine) => {
      const disk = read();
      const onDisk = new Set(disk.map(options.idOf));
      const merged = reconcileList(mine, disk, options.idOf, known, options.order);
      know(merged);
      const ok = writeJson(name, merged);
      lastWritten = merged;
      const created = merged.filter((item) => !onDisk.has(options.idOf(item)));
      if (ok && created.length > 0) void repair(created);
      return { ok, merged, changed: merged !== mine };
    },
  };
}

/** A per-key map shared by every tab (ranges per patient, deletion counters per patient). */
export interface MapSync<V> {
  know(map: Readonly<Record<string, V>>): void;
  write(mine: Readonly<Record<string, V>>): MergeResult<Record<string, V>>;
  read(): Record<string, V>;
  /** Resolves once every locked repair scheduled so far has run. Tests await this. */
  settled(): Promise<void>;
}

/**
 * `mergeValue` decides what happens to a key BOTH tabs hold — the only genuinely ambiguous case.
 * (A key only this tab has is kept; a key only disk has is adopted unless this tab has seen and
 * dropped it.)
 */
export function createMapSync<V>(
  name: string,
  options: {
    validate: (raw: unknown) => Record<string, V> | null;
    mergeValue: (mine: V, theirs: V) => V;
    /** A repair put keys back on disk; the store must adopt what is on disk now. See `createListSync`. */
    onRepaired?: (merged: Record<string, V>) => void;
  },
): MapSync<V> {
  const known = new Set<string>();
  const know = (map: Readonly<Record<string, V>>): void => {
    for (const k of Object.keys(map)) known.add(k);
  };
  const read = (): Record<string, V> => readJson<Record<string, V>>(name, {}, options.validate);

  /** What this tab last put on disk; a repair may only restore keys it is still holding. */
  let lastWritten: Readonly<Record<string, V>> = {};

  /** The same clobber repair as `createListSync`, keyed on the entries this write put on disk. */
  const repair = (created: Readonly<Record<string, V>>): Promise<void> =>
    withRecordLock(name, () => {
      const still = Object.keys(created).filter((k) => k in lastWritten);
      if (still.length === 0) return;
      const disk = read();
      const lost = still.filter((k) => !(k in disk));
      if (lost.length === 0) return;
      const restored: Record<string, V> = { ...disk };
      for (const k of lost) restored[k] = created[k];
      know(restored);
      lastWritten = restored;
      if (writeJson(name, restored)) options.onRepaired?.(restored);
    });

  return {
    know,
    settled: () => recordLockSettled(name),
    read: () => {
      const disk = read();
      know(disk);
      return disk;
    },
    write: (mine) => {
      const disk = read();
      let changed = false;
      const merged: Record<string, V> = { ...mine };
      for (const [k, theirs] of Object.entries(disk)) {
        if (k in mine) {
          const value = options.mergeValue(mine[k], theirs);
          if (value !== mine[k]) {
            merged[k] = value;
            changed = true;
          }
        } else if (!known.has(k)) {
          merged[k] = theirs;
          changed = true;
        }
      }
      know(merged);
      const out = changed ? merged : (mine as Record<string, V>);
      const ok = writeJson(name, out);
      lastWritten = out;
      const created: Record<string, V> = {};
      let any = false;
      for (const k of Object.keys(out)) {
        if (!(k in disk)) {
          created[k] = out[k];
          any = true;
        }
      }
      if (ok && any) void repair(created);
      return { ok, merged: out, changed };
    },
  };
}

/**
 * Call `cb` when ANOTHER tab writes one of `names`. The `storage` event never fires in the tab that
 * made the write, so this is exactly "somebody else changed the records under us". A cleared storage
 * (`key === null`) reports every name.
 */
export function onExternalChange(names: readonly string[], cb: (name: string) => void): () => void {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return () => undefined;
  const byKey = new Map<string, string>(names.map((n) => [storageKey(n), n]));
  const handler = (e: StorageEvent): void => {
    // Another Storage area (sessionStorage) is not ours.
    try {
      if (e.storageArea && typeof localStorage !== 'undefined' && e.storageArea !== localStorage) return;
    } catch {
      /* accessing localStorage can throw with site data blocked; take the event at face value */
    }
    if (e.key === null) {
      for (const n of byKey.values()) cb(n);
      return;
    }
    const name = byKey.get(e.key);
    if (name !== undefined) cb(name);
  };
  window.addEventListener('storage', handler);
  return () => window.removeEventListener('storage', handler);
}
