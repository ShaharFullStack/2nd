/**
 * THE SECOND SESSION OF THE DAY MUST NOT PAY FOR THE SONG AGAIN.
 *
 * A song's stems are the whole weight of a session — 12 MB for demo-groove — and on a throttled
 * clinic link that is twelve seconds a patient stands through. Prefetching moves those seconds off
 * the patient and onto the prescription (`runtime.prefetchSong`), but only for the session that is
 * being prescribed: a reloaded tab, the next patient on the same shared tablet, or a therapist who
 * pressed Start on sight still pulls every byte down again.
 *
 * HTTP caching is the obvious answer and is not ours to give: the app is a static bundle, the
 * headers belong to whatever the clinic's IT department serves it from, and `Cache-Control` on
 * `public/songs` is exactly the thing nobody will set. The Cache Storage API is the half of it that
 * the app does own, so the stem files are kept here under the app's own key and served from disk on
 * every later load, whatever the server said.
 *
 * THE RULES, all of which exist so this can never be the reason a session fails to start:
 *  - it is a WRAPPER around fetch, not a replacement. Every failure path — no Cache Storage (an
 *    insecure context, a private window), a quota refusal, a corrupt entry — falls through to the
 *    plain network fetch, and nothing above this layer knows the difference;
 *  - only whole, successful, same-origin STEM responses are stored. A 206 from the audition's ranged
 *    fetches, a redirect, an error page, or anything outside `/songs/` is passed straight through:
 *    storing a partial body under a whole-file URL would hand the mixer a truncated song later;
 *  - the store is bounded (`MAX_CACHED_STEMS`), oldest-first, so a clinic that loads a dozen songs
 *    does not fill the tablet's storage quota with music it played once;
 *  - `Response.clone()` is what is stored, so the caller still reads the body it asked for and the
 *    mixer's byte-progress reporting is unaffected.
 */
import type { FetchLike } from '../audio/manifest.ts';

/** Bumped when the shape of what is stored changes; the old cache is then simply unused. */
export const STEM_CACHE_NAME = 'beat-rehab-stems-v1';

/** How many stem files may be kept. Four stems per song, so this is a handful of songs. */
export const MAX_CACHED_STEMS = 16;

/** Audio files under a song folder — the only thing this cache is for. */
const STEM_PATH = /\/songs\/[^?#]*\.(wav|mp3|ogg|m4a|flac)$/i;

/** Same-origin stem URLs only: a cross-origin CDN response may be opaque, and an opaque body is a
 * body this app cannot check the length of. */
export function isCacheableStemUrl(url: string): boolean {
  try {
    const base = typeof location === 'undefined' ? 'http://localhost/' : location.href;
    const parsed = new URL(url, base);
    if (typeof location !== 'undefined' && parsed.origin !== location.origin) return false;
    return STEM_PATH.test(parsed.pathname);
  } catch {
    return false;
  }
}

/** A ranged request asks for part of a file; what comes back must never be stored as the whole one. */
function isRanged(init?: RequestInit): boolean {
  const h = init?.headers;
  if (!h) return false;
  if (h instanceof Headers) return h.has('range');
  if (Array.isArray(h)) return h.some(([k]) => k.toLowerCase() === 'range');
  return Object.keys(h).some((k) => k.toLowerCase() === 'range');
}

export interface StemCacheOptions {
  /** Injectable for tests; defaults to the browser's CacheStorage when it exists. */
  caches?: CacheStorage | null;
  fetch?: FetchLike;
}

async function openCache(storage: CacheStorage | null | undefined): Promise<Cache | null> {
  const store = storage ?? (typeof caches === 'undefined' ? null : caches);
  if (!store) return null;
  try {
    return await store.open(STEM_CACHE_NAME);
  } catch {
    return null;
  }
}

/** Keep the store bounded, oldest entry first (Cache Storage keeps insertion order). */
async function prune(cache: Cache): Promise<void> {
  try {
    const keys = await cache.keys();
    if (keys.length <= MAX_CACHED_STEMS) return;
    for (const key of keys.slice(0, keys.length - MAX_CACHED_STEMS)) await cache.delete(key);
  } catch {
    /* a cache that will not enumerate is a cache we simply stop pruning */
  }
}

/**
 * A `fetch` that serves a song's stems out of the app's own Cache Storage, and otherwise behaves
 * exactly like the one it wraps.
 */
export function cachingStemFetch(options: StemCacheOptions = {}): FetchLike {
  const base: FetchLike = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  return async (input: string, init?: RequestInit): Promise<Response> => {
    if (!isCacheableStemUrl(input) || isRanged(init)) return base(input, init);
    const cache = await openCache(options.caches);
    if (!cache) return base(input, init);
    try {
      const hit = await cache.match(input);
      // A stored entry with no body length is not trusted: serving a truncated stem would be a
      // silently shorter song, which is worse than downloading it again.
      if (hit && hit.ok) return hit;
    } catch {
      /* fall through to the network */
    }
    const res = await base(input, init);
    // Only a complete 200 is the whole file. 206/3xx/4xx/5xx go back to the caller untouched.
    if (res.ok && res.status === 200) {
      let copy: Response | null = null;
      try {
        copy = res.clone();
      } catch {
        copy = null;
      }
      if (copy) {
        void (async () => {
          try {
            await cache.put(input, copy);
            await prune(cache);
          } catch {
            /* quota, an aborted body, a private window: the network path already worked */
          }
        })();
      }
    }
    return res;
  };
}
