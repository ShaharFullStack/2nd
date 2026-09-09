/**
 * Song manifest types + loaders (public/songs/<id>/song.json, public/songs/index.json).
 *
 * URL conventions: `baseUrl` is the songs root (default '/songs'); a song lives at
 * `${baseUrl}/${id}/song.json` and its stems at `${baseUrl}/${id}/${stem.file}`.
 */

export interface StemSpec { id: string; file: string; label: string; }
export interface RemoteStemSpec { id: string; url: string; }

export interface SongManifest {
  id: string;
  title: string;
  artist: string;
  artistUrl?: string;
  sourceUrl?: string;
  license: string;
  licenseUrl?: string;
  attribution?: string;
  description?: string;
  bpm: number;
  /** Seconds from stem start to the first downbeat. */
  offset: number;
  durationSec: number;
  previewStart?: number;
  stems: StemSpec[];
  playerStem: string;
  remoteStems?: RemoteStemSpec[];
}

export type SongStatus = 'ready' | 'needs-fetch' | 'error';

export interface SongEntry {
  id: string;
  status: SongStatus;
  manifest?: SongManifest;
  /** Stem ids whose files are not served (status 'needs-fetch'). */
  missingStems: string[];
  error?: string;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export interface LoaderOptions { fetch?: FetchLike; }

export const DEFAULT_SONGS_BASE = '/songs';

const joinUrl = (...parts: string[]): string =>
  parts.filter((p) => p.length > 0).map((p, i) => (i === 0 ? p.replace(/\/+$/, '') : p.replace(/^\/+|\/+$/g, ''))).join('/');

export const songDirUrl = (baseUrl: string, id: string): string => joinUrl(baseUrl, id);
export const manifestUrl = (baseUrl: string, id: string): string => joinUrl(baseUrl, id, 'song.json');
export const stemUrl = (baseUrl: string, manifest: SongManifest, stem: StemSpec): string => joinUrl(baseUrl, manifest.id, stem.file);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

/** Optional free-text field: blank strings become `undefined` (never hand the UI an empty value). */
const optStr = (v: unknown): string | undefined => (isNonEmptyString(v) ? v.trim() : undefined);

/** True for absolute http(s) URLs only. */
export function isHttpUrl(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Optional link field: anything that is not an absolute http(s) URL (blank, relative path, other scheme) is dropped. */
const optUrl = (v: unknown): string | undefined => (isHttpUrl(v) ? v.trim() : undefined);

/** Validate a decoded song.json; throws a descriptive Error when it is not usable. */
export function parseManifest(json: unknown): SongManifest {
  if (!isRecord(json)) throw new Error('manifest must be an object');
  const problems: string[] = [];
  for (const key of ['id', 'title', 'artist', 'license', 'playerStem'] as const) {
    if (!isNonEmptyString(json[key])) problems.push(`missing string "${key}"`);
  }
  for (const key of ['bpm', 'offset', 'durationSec'] as const) {
    if (!isFiniteNumber(json[key])) problems.push(`missing number "${key}"`);
  }
  if (isFiniteNumber(json.bpm) && json.bpm <= 0) problems.push('"bpm" must be > 0');
  const stemsRaw = json.stems;
  const stems: StemSpec[] = [];
  if (!Array.isArray(stemsRaw) || stemsRaw.length === 0) problems.push('"stems" must be a non-empty array');
  else {
    stemsRaw.forEach((s: unknown, i: number) => {
      if (!isRecord(s) || !isNonEmptyString(s.id) || !isNonEmptyString(s.file)) problems.push(`stems[${i}] needs "id" and "file"`);
      else stems.push({ id: s.id, file: s.file, label: isNonEmptyString(s.label) ? s.label : s.id });
    });
    const ids = new Set(stems.map((s) => s.id));
    if (ids.size !== stems.length) problems.push('stem ids must be unique');
    if (isNonEmptyString(json.playerStem) && !ids.has(json.playerStem)) problems.push(`playerStem "${json.playerStem}" is not one of the stems`);
  }
  const remoteStems: RemoteStemSpec[] = [];
  if (json.remoteStems !== undefined) {
    if (!Array.isArray(json.remoteStems)) problems.push('"remoteStems" must be an array');
    else json.remoteStems.forEach((r: unknown, i: number) => {
      if (!isRecord(r) || !isNonEmptyString(r.id) || typeof r.url !== 'string') problems.push(`remoteStems[${i}] needs "id" and "url"`);
      else remoteStems.push({ id: r.id, url: r.url });
    });
  }
  if (problems.length > 0) throw new Error(`invalid song manifest${isNonEmptyString(json.id) ? ` "${json.id}"` : ''}: ${problems.join('; ')}`);

  return {
    id: json.id as string,
    title: json.title as string,
    artist: json.artist as string,
    artistUrl: optUrl(json.artistUrl),
    sourceUrl: optUrl(json.sourceUrl),
    license: json.license as string,
    licenseUrl: optUrl(json.licenseUrl),
    attribution: optStr(json.attribution),
    description: optStr(json.description),
    bpm: json.bpm as number,
    offset: json.offset as number,
    durationSec: json.durationSec as number,
    previewStart: isFiniteNumber(json.previewStart) ? json.previewStart : undefined,
    stems,
    playerStem: json.playerStem as string,
    remoteStems,
  };
}

/** Human-readable attribution line (CC BY requires title, author, source and licence). */
export function attributionText(m: SongManifest): string {
  if (m.attribution && m.attribution.trim().length > 0) return m.attribution.trim();
  let source = '';
  if (m.sourceUrl) {
    try { source = ` (${new URL(m.sourceUrl).hostname.replace(/^www\./, '')})`; } catch { source = ''; }
  }
  return `"${m.title}" by ${m.artist}${source} is licensed under ${m.license}`;
}

/** Same as attributionText but with the licence + source as clickable pieces (for React UIs). */
export function attributionParts(m: SongManifest): { text: string; title: string; artist: string; artistUrl?: string; sourceUrl?: string; license: string; licenseUrl?: string } {
  return { text: attributionText(m), title: m.title, artist: m.artist, artistUrl: m.artistUrl, sourceUrl: m.sourceUrl, license: m.license, licenseUrl: m.licenseUrl };
}

const getFetch = (opts?: LoaderOptions): FetchLike => {
  if (opts?.fetch) return opts.fetch;
  if (typeof globalThis.fetch !== 'function') throw new Error('fetch is not available in this environment');
  return (input, init) => globalThis.fetch(input, init);
};

/** index.json may be `["id", …]` or `{ "songs": ["id", …] }` (also accepts `{id}` objects). */
export async function loadSongIndex(baseUrl: string = DEFAULT_SONGS_BASE, opts?: LoaderOptions): Promise<string[]> {
  const res = await getFetch(opts)(joinUrl(baseUrl, 'index.json'));
  if (!res.ok) throw new Error(`failed to load song index (${res.status})`);
  const json: unknown = await res.json();
  const list = Array.isArray(json) ? json : isRecord(json) && Array.isArray(json.songs) ? json.songs : null;
  if (!list) throw new Error('song index must be an array or { songs: [] }');
  const ids: string[] = [];
  for (const e of list) {
    if (typeof e === 'string' && e.length > 0) ids.push(e);
    else if (isRecord(e) && isNonEmptyString(e.id)) ids.push(e.id);
  }
  return ids;
}

/** Fetch + validate one manifest. Throws on network or validation errors. */
export async function loadManifest(id: string, baseUrl: string = DEFAULT_SONGS_BASE, opts?: LoaderOptions): Promise<SongManifest> {
  const res = await getFetch(opts)(manifestUrl(baseUrl, id));
  if (!res.ok) throw new Error(`song "${id}": manifest not found (${res.status})`);
  const manifest = parseManifest(await res.json());
  if (manifest.id !== id) throw new Error(`song "${id}": manifest id is "${manifest.id}"`);
  return manifest;
}

/** HEAD-probe a stem URL. Dev servers answer missing files with 404 (or an HTML fallback page). */
export async function stemExists(url: string, opts?: LoaderOptions): Promise<boolean> {
  const f = getFetch(opts);
  try {
    let res = await f(url, { method: 'HEAD' });
    if (res.status === 405 || res.status === 501) res = await f(url, { method: 'GET', headers: { Range: 'bytes=0-0' } });
    if (!res.ok) return false;
    const type = res.headers.get('content-type') ?? '';
    return !/text\/html/i.test(type);
  } catch {
    return false;
  }
}

/** Manifest + stem availability, never throws: bad manifests → 'error', absent stems → 'needs-fetch'. */
export async function loadSongEntry(id: string, baseUrl: string = DEFAULT_SONGS_BASE, opts?: LoaderOptions): Promise<SongEntry> {
  let manifest: SongManifest;
  try {
    manifest = await loadManifest(id, baseUrl, opts);
  } catch (err) {
    return { id, status: 'error', missingStems: [], error: err instanceof Error ? err.message : String(err) };
  }
  const present = await Promise.all(manifest.stems.map((s) => stemExists(stemUrl(baseUrl, manifest, s), opts)));
  const missingStems = manifest.stems.filter((_, i) => !present[i]).map((s) => s.id);
  return { id, manifest, missingStems, status: missingStems.length === 0 ? 'ready' : 'needs-fetch' };
}

/** Everything song select needs: every id from index.json with its status (parallel, order preserved). */
export async function loadSongCatalog(baseUrl: string = DEFAULT_SONGS_BASE, opts?: LoaderOptions): Promise<SongEntry[]> {
  const ids = await loadSongIndex(baseUrl, opts);
  return Promise.all(ids.map((id) => loadSongEntry(id, baseUrl, opts)));
}
