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

/**
 * Persist a slice of a store, coalesced to one write per animation frame's worth of changes.
 * `select` picks what to save; the returned function performs a write for the current state.
 */
export function makePersister<S, P>(name: string, select: (state: S) => P, delayMs = 250): (state: S) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: P | null = null;
  return (state: S) => {
    pending = select(state);
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      const value = pending;
      pending = null;
      if (value !== null) writeJson(name, value);
    }, delayMs);
  };
}
