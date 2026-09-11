/**
 * The stem cache may make a session start faster. It may never make one start WRONG, and it may
 * never be the reason one fails to start at all — so every test here is either "the second load is
 * free" or "this failure mode falls through to the network".
 */
import { describe, expect, it, vi } from 'vitest';
import { cachingStemFetch, isCacheableStemUrl, MAX_CACHED_STEMS, STEM_CACHE_NAME } from './stemCache.ts';

/** A Cache Storage stand-in with the ordering guarantee the real one gives (insertion order). */
function fakeStorage(opts: { failPut?: boolean; failOpen?: boolean } = {}) {
  const entries = new Map<string, Response>();
  const cache = {
    async match(url: string) {
      return entries.get(url);
    },
    async put(url: string, res: Response) {
      if (opts.failPut) throw new Error('quota exceeded');
      entries.set(url, res);
    },
    async keys() {
      return [...entries.keys()];
    },
    async delete(url: string) {
      return entries.delete(url);
    },
  };
  const storage = {
    async open(name: string) {
      if (opts.failOpen) throw new Error('no cache storage here');
      expect(name).toBe(STEM_CACHE_NAME);
      return cache as unknown as Cache;
    },
  } as unknown as CacheStorage;
  return { storage, entries };
}

const body = (text: string, init: ResponseInit = {}) => new Response(text, { status: 200, ...init });

describe('the stem cache', () => {
  it('serves the second request for a stem without going to the network', async () => {
    const { storage } = fakeStorage();
    const net = vi.fn(async () => body('PCM'));
    const f = cachingStemFetch({ caches: storage, fetch: net });

    const first = await f('/songs/demo-groove/stems/drums.wav');
    expect(await first.text()).toBe('PCM');
    expect(net).toHaveBeenCalledTimes(1);
    // the put is fire-and-forget; let it land
    await Promise.resolve();
    await Promise.resolve();

    const second = await f('/songs/demo-groove/stems/drums.wav');
    expect(await second.text()).toBe('PCM');
    expect(net).toHaveBeenCalledTimes(1);
  });

  it('never stores a partial or failed response as the whole file', async () => {
    const { storage, entries } = fakeStorage();
    const ranged = vi.fn(async () => body('half a song', { status: 206 }));
    const f = cachingStemFetch({ caches: storage, fetch: ranged });
    await f('/songs/demo-groove/stems/drums.wav');
    await Promise.resolve();
    expect(entries.size).toBe(0);

    const missing = cachingStemFetch({ caches: storage, fetch: async () => body('not found', { status: 404 }) });
    await missing('/songs/demo-groove/stems/bass.wav');
    await Promise.resolve();
    expect(entries.size).toBe(0);
  });

  it('passes a ranged request straight through — that is the audition, not a session load', async () => {
    const { storage, entries } = fakeStorage();
    const net = vi.fn(async () => body('bytes 0-99', { status: 206 }));
    const f = cachingStemFetch({ caches: storage, fetch: net });
    await f('/songs/demo-groove/stems/drums.wav', { headers: { Range: 'bytes=0-99' } });
    expect(net).toHaveBeenCalledTimes(1);
    expect(entries.size).toBe(0);
  });

  it('still loads the song when there is no Cache Storage at all', async () => {
    const net = vi.fn(async () => body('PCM'));
    const f = cachingStemFetch({ caches: null, fetch: net });
    expect(await (await f('/songs/demo-groove/stems/drums.wav')).text()).toBe('PCM');
    expect(net).toHaveBeenCalledTimes(1);
  });

  it('still loads the song when the cache refuses to open or to store', async () => {
    const refusingOpen = fakeStorage({ failOpen: true });
    const net1 = vi.fn(async () => body('PCM'));
    await cachingStemFetch({ caches: refusingOpen.storage, fetch: net1 })('/songs/s/stems/a.wav');
    expect(net1).toHaveBeenCalledTimes(1);

    const refusingPut = fakeStorage({ failPut: true });
    const net2 = vi.fn(async () => body('PCM'));
    const f = cachingStemFetch({ caches: refusingPut.storage, fetch: net2 });
    expect(await (await f('/songs/s/stems/a.wav')).text()).toBe('PCM');
    await Promise.resolve();
    await Promise.resolve();
    // a quota refusal simply means the next load pays for the network again
    expect(await (await f('/songs/s/stems/a.wav')).text()).toBe('PCM');
    expect(net2).toHaveBeenCalledTimes(2);
  });

  it('keeps the store bounded so a clinic does not fill its tablet with old songs', async () => {
    const { storage, entries } = fakeStorage();
    const f = cachingStemFetch({ caches: storage, fetch: async () => body('PCM') });
    for (let i = 0; i < MAX_CACHED_STEMS + 4; i++) {
      await f(`/songs/song${i}/stems/drums.wav`);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    }
    expect(entries.size).toBeLessThanOrEqual(MAX_CACHED_STEMS);
    // the OLDEST went, not the newest
    expect(entries.has(`/songs/song${MAX_CACHED_STEMS + 3}/stems/drums.wav`)).toBe(true);
    expect(entries.has('/songs/song0/stems/drums.wav')).toBe(false);
  });

  it('only claims the files it is for', () => {
    expect(isCacheableStemUrl('/songs/demo-groove/stems/drums.wav')).toBe(true);
    expect(isCacheableStemUrl('/songs/demo-groove/stems/drums.mp3')).toBe(true);
    expect(isCacheableStemUrl('/songs/demo-groove/song.json')).toBe(false);
    expect(isCacheableStemUrl('/models/pose_landmarker_lite.task')).toBe(false);
    expect(isCacheableStemUrl('https://cdn.example.com/songs/x/stems/drums.wav')).toBe(false);
  });
});
