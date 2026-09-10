import { describe, expect, it } from 'vitest';
import {
  attributionText, attributionParts, loadManifest, loadSongCatalog, loadSongEntry, loadSongIndex,
  manifestUrl, parseManifest, stemExists, stemUrl, stepTimeSec, type SongManifest, type FetchLike,
} from './manifest';

const valid = {
  id: 'demo-groove', title: 'Groove Circuit', artist: 'Beat Rehab demo (synthesized)',
  license: 'CC0 1.0', licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
  bpm: 120, offset: 0, durationSec: 97, previewStart: 16,
  stems: [{ id: 'drums', file: 'stems/drums.wav', label: 'Drums' }, { id: 'bass', file: 'stems/bass.wav' }],
  playerStem: 'drums',
};

function fakeFetch(routes: Record<string, { status?: number; json?: unknown; type?: string }>): FetchLike & { calls: { url: string; method: string }[] } {
  const calls: { url: string; method: string }[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET' });
    const r = routes[url];
    if (!r) return new Response('<html>not found</html>', { status: 404, headers: { 'content-type': 'text/html' } });
    const status = r.status ?? 200;
    const body = r.json !== undefined ? JSON.stringify(r.json) : '';
    return new Response(body, { status, headers: { 'content-type': r.type ?? (r.json !== undefined ? 'application/json' : 'audio/wav') } });
  }) as FetchLike & { calls: { url: string; method: string }[] };
  f.calls = calls;
  return f;
}

describe('parseManifest', () => {
  it('accepts a valid manifest and normalises optional fields', () => {
    const m = parseManifest(valid);
    expect(m.id).toBe('demo-groove');
    expect(m.stems[1].label).toBe('bass');
    expect(m.remoteStems).toEqual([]);
    expect(m.previewStart).toBe(16);
    expect(m.artistUrl).toBeUndefined();
  });
  it('rejects non-objects and missing fields with a descriptive message', () => {
    expect(() => parseManifest(null)).toThrow(/object/);
    expect(() => parseManifest({ ...valid, bpm: undefined })).toThrow(/"bpm"/);
    expect(() => parseManifest({ ...valid, title: '' })).toThrow(/"title"/);
    expect(() => parseManifest({ ...valid, stems: [] })).toThrow(/stems/);
  });
  it('requires playerStem to reference a stem and unique stem ids', () => {
    expect(() => parseManifest({ ...valid, playerStem: 'vocals' })).toThrow(/playerStem "vocals"/);
    expect(() => parseManifest({ ...valid, stems: [valid.stems[0], valid.stems[0]] })).toThrow(/unique/);
  });
  it('validates remoteStems entries', () => {
    expect(() => parseManifest({ ...valid, remoteStems: [{ id: 'drums' }] })).toThrow(/remoteStems\[0\]/);
    expect(parseManifest({ ...valid, remoteStems: [{ id: 'drums', url: 'https://x/y.wav' }] }).remoteStems).toHaveLength(1);
  });
});

describe('swing / grid', () => {
  it('parses swing, drops 0/absent and clamps out-of-range values', () => {
    expect(parseManifest(valid).swing).toBeUndefined();
    expect(parseManifest({ ...valid, swing: 0 }).swing).toBeUndefined();
    expect(parseManifest({ ...valid, swing: 1 / 3 }).swing).toBeCloseTo(1 / 3, 12);
    expect(parseManifest({ ...valid, swing: 5 }).swing).toBe(0.9);
    expect(parseManifest({ ...valid, swing: -1 }).swing).toBe(0);
    expect(parseManifest({ ...valid, swing: 'a lot' }).swing).toBeUndefined();
  });

  it('stepTimeSec places notes on the audio grid, swinging odd 16ths only', () => {
    const straight = parseManifest({ ...valid, bpm: 120, offset: 0.25 });
    expect(stepTimeSec(straight, 0)).toBe(0.25);
    expect(stepTimeSec(straight, 3)).toBeCloseTo(0.25 + 3 * 0.125, 12); // 16ths at 120 BPM
    expect(stepTimeSec(straight, 2, 2)).toBeCloseTo(0.25 + 0.5, 12); // 8ths: step 2 = one beat

    // demo-sunrise's feel: 100 BPM, triplet shuffle (odd 16ths a third of a 16th = 50 ms late)
    const swung = parseManifest({ ...valid, bpm: 100, offset: 0, swing: 1 / 3 });
    const sixteenth = 60 / 100 / 4;
    expect(stepTimeSec(swung, 0)).toBe(0);
    expect(stepTimeSec(swung, 2)).toBeCloseTo(2 * sixteenth, 12); // straight 8th: untouched
    expect(stepTimeSec(swung, 1)).toBeCloseTo(sixteenth + sixteenth / 3, 12);
    expect(stepTimeSec(swung, 1) - stepTimeSec(swung, 0)).toBeCloseTo(0.2, 12); // long
    expect(stepTimeSec(swung, 2) - stepTimeSec(swung, 1)).toBeCloseTo(0.1, 12); // short → 2:1
    // straight-8th charts (stepsPerBeat 2) never hit an odd 16th, so swing cannot affect them
    for (const s of [0, 1, 2, 3]) expect(stepTimeSec(swung, s, 2)).toBeCloseTo((s * 60) / 100 / 2, 12);
    // a step that is not on a 16th boundary (triplets) is left alone
    expect(stepTimeSec(swung, 1, 3)).toBeCloseTo(60 / 100 / 3, 12);
  });
});

describe('attribution helpers', () => {
  it('uses the manifest attribution verbatim when present', () => {
    const m = parseManifest({ ...valid, attribution: '  custom line  ' });
    expect(attributionText(m)).toBe('custom line');
  });
  it('builds a CC BY style line from title/artist/source/licence', () => {
    const m: SongManifest = { ...parseManifest(valid), artist: 'Some Artist', title: 'Song', license: 'CC BY 4.0', sourceUrl: 'https://www.ccmixter.org/files/a/1' };
    expect(attributionText(m)).toBe('"Song" by Some Artist (ccmixter.org) is licensed under CC BY 4.0');
    const noSource = { ...m, sourceUrl: undefined };
    expect(attributionText(noSource)).toBe('"Song" by Some Artist is licensed under CC BY 4.0');
    expect(attributionText({ ...m, sourceUrl: 'not a url' })).toBe('"Song" by Some Artist is licensed under CC BY 4.0');
  });
  it('exposes parts for link rendering', () => {
    const p = attributionParts(parseManifest({ ...valid, licenseUrl: 'https://l', sourceUrl: 'https://s' }));
    expect(p.licenseUrl).toBe('https://l');
    expect(p.sourceUrl).toBe('https://s');
    expect(p.text).toContain('Groove Circuit');
  });
});

describe('url helpers', () => {
  it('joins base, id and file without duplicate slashes', () => {
    const m = parseManifest(valid);
    expect(manifestUrl('/songs/', 'demo-groove')).toBe('/songs/demo-groove/song.json');
    expect(stemUrl('/songs', m, m.stems[0])).toBe('/songs/demo-groove/stems/drums.wav');
    expect(stemUrl('https://cdn.example/x/', m, m.stems[0])).toBe('https://cdn.example/x/demo-groove/stems/drums.wav');
  });
});

describe('loaders', () => {
  it('loadSongIndex accepts array and { songs } forms', async () => {
    const a = fakeFetch({ '/songs/index.json': { json: ['a', 'b'] } });
    expect(await loadSongIndex('/songs', { fetch: a })).toEqual(['a', 'b']);
    const b = fakeFetch({ '/songs/index.json': { json: { songs: ['x', { id: 'y' }, 42] } } });
    expect(await loadSongIndex('/songs', { fetch: b })).toEqual(['x', 'y']);
    const bad = fakeFetch({ '/songs/index.json': { json: { nope: 1 } } });
    await expect(loadSongIndex('/songs', { fetch: bad })).rejects.toThrow(/array/);
    await expect(loadSongIndex('/songs', { fetch: fakeFetch({}) })).rejects.toThrow(/404/);
  });

  it('loadManifest fetches, validates and checks the id', async () => {
    const f = fakeFetch({ '/songs/demo-groove/song.json': { json: valid }, '/songs/other/song.json': { json: valid } });
    const m = await loadManifest('demo-groove', '/songs', { fetch: f });
    expect(m.title).toBe('Groove Circuit');
    await expect(loadManifest('other', '/songs', { fetch: f })).rejects.toThrow(/manifest id/);
    await expect(loadManifest('missing', '/songs', { fetch: f })).rejects.toThrow(/not found/);
  });

  it('loadSongEntry marks songs with missing stems as needs-fetch (HEAD probe)', async () => {
    const f = fakeFetch({
      '/songs/demo-groove/song.json': { json: valid },
      '/songs/demo-groove/stems/drums.wav': {},
      // bass.wav absent → 404 html
    });
    const e = await loadSongEntry('demo-groove', '/songs', { fetch: f });
    expect(e.status).toBe('needs-fetch');
    expect(e.missingStems).toEqual(['bass']);
    expect(f.calls.filter((c) => c.method === 'HEAD').map((c) => c.url)).toEqual(['/songs/demo-groove/stems/drums.wav', '/songs/demo-groove/stems/bass.wav']);
  });

  it('treats an HTML fallback page as a missing stem', async () => {
    const f = fakeFetch({
      '/songs/demo-groove/song.json': { json: valid },
      '/songs/demo-groove/stems/drums.wav': { type: 'text/html' },
      '/songs/demo-groove/stems/bass.wav': {},
    });
    const e = await loadSongEntry('demo-groove', '/songs', { fetch: f });
    expect(e.missingStems).toEqual(['drums']);
  });

  it('stemExists retries a HEAD rejection with a ranged GET (CDNs and object stores answer 403/404 to HEAD)', async () => {
    // A present file behind a host that refuses HEAD must never be reported "needs fetch".
    const calls: { url: string; method: string; range?: string }[] = [];
    const hostile = (headStatus: number, getStatus: number, getType = 'audio/wav'): FetchLike => async (url, init) => {
      const method = init?.method ?? 'GET';
      calls.push({ url, method, range: (init?.headers as Record<string, string> | undefined)?.Range });
      if (method === 'HEAD') return new Response('', { status: headStatus });
      return new Response(getStatus === 206 ? 'R' : '<html>nope</html>', { status: getStatus, headers: { 'content-type': getType } });
    };
    for (const status of [403, 404, 405, 500]) {
      calls.length = 0;
      expect(await stemExists('/songs/s/stems/d.wav', { fetch: hostile(status, 206) })).toBe(true);
      expect(calls.map((c) => c.method)).toEqual(['HEAD', 'GET']);
      expect(calls[1].range).toBe('bytes=0-0');
    }
    // both refuse → genuinely absent; an HTML fallback page on the GET is absent too
    expect(await stemExists('/x.wav', { fetch: hostile(404, 404) })).toBe(false);
    expect(await stemExists('/x.wav', { fetch: hostile(404, 200, 'text/html') })).toBe(false);
    // a HEAD that answers 2xx costs exactly one request
    calls.length = 0;
    expect(await stemExists('/x.wav', { fetch: hostile(200, 500) })).toBe(true);
    expect(calls).toHaveLength(1);
    expect(await stemExists('/x.wav', { fetch: () => Promise.reject(new Error('offline')) })).toBe(false);
  });

  it('loadSongCatalog never throws per song: ready / needs-fetch / error side by side', async () => {
    const f = fakeFetch({
      '/songs/index.json': { json: ['demo-groove', 'broken', 'gone', 'remote'] },
      '/songs/demo-groove/song.json': { json: valid },
      '/songs/demo-groove/stems/drums.wav': {},
      '/songs/demo-groove/stems/bass.wav': {},
      '/songs/broken/song.json': { json: { id: 'broken' } },
      '/songs/remote/song.json': { json: { ...valid, id: 'remote', remoteStems: [{ id: 'drums', url: 'https://PLACEHOLDER.example.com/d.wav' }] } },
    });
    const cat = await loadSongCatalog('/songs', { fetch: f });
    expect(cat.map((e) => [e.id, e.status])).toEqual([
      ['demo-groove', 'ready'], ['broken', 'error'], ['gone', 'error'], ['remote', 'needs-fetch'],
    ]);
    expect(cat[1].error).toMatch(/invalid song manifest "broken"/);
    expect(cat[3].missingStems).toEqual(['drums', 'bass']);
    expect(cat[0].manifest?.playerStem).toBe('drums');
  });
});
