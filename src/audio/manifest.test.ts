import { describe, expect, it } from 'vitest';
import {
  attributionText, attributionParts, loadManifest, loadSongCatalog, loadSongEntry, loadSongIndex,
  manifestUrl, parseManifest, stemUrl, type SongManifest, type FetchLike,
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
