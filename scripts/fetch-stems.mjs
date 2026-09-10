#!/usr/bin/env node
// Beat Rehab — download Creative-Commons stems listed in each song.json "remoteStems".
//
// usage: node scripts/fetch-stems.mjs [--song <id>] [--force] [--root public/songs] [--retries 3] [--timeout 30]
//
// For every song directory (from index.json plus any directory containing a song.json):
//   * each remoteStems entry {id, url} is downloaded to the path of the matching "stems" entry
//     (falls back to stems/<id>.<ext-from-url>) — existing files are skipped unless --force,
//   * every attempt has a watchdog: no response headers, or no body bytes, for --timeout seconds
//     (default 30) aborts the transfer, and failed/aborted attempts are retried with exponential
//     back-off (--retries, default 3),
//   * placeholder URLs (example.com / "PLACEHOLDER") are skipped with a hint,
//   * the song's attribution line is printed so the licence terms are visible at fetch time.
//
// Pure Node >= 18 (global fetch), no dependencies.

import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { fileURLToPath } from 'node:url';

export const DEFAULT_RETRIES = 3;
export const DEFAULT_TIMEOUT_SEC = 30;

function numberArg(name, raw, { integer = false, min = 0 } = {}) {
  const n = Number(raw);
  if (raw === undefined || raw === '' || !Number.isFinite(n) || n < min || (integer && !Number.isInteger(n))) {
    throw new Error(`${name} expects a ${integer ? 'non-negative integer' : 'number'}${min > 0 ? ` >= ${min}` : ''}, got ${raw === undefined ? 'nothing' : JSON.stringify(raw)}`);
  }
  return n;
}

export function parseArgs(argv) {
  const args = { root: 'public/songs', song: null, force: false, retries: DEFAULT_RETRIES, timeoutSec: DEFAULT_TIMEOUT_SEC };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') args.root = argv[++i];
    else if (a === '--song') args.song = argv[++i];
    else if (a === '--force') args.force = true;
    else if (a === '--retries') args.retries = numberArg('--retries', argv[++i], { integer: true });
    else if (a === '--timeout') args.timeoutSec = numberArg('--timeout', argv[++i], { min: 0.01 });
    else if (a === '--help' || a === '-h') {
      console.log('usage: fetch-stems.mjs [--song id] [--force] [--root dir] [--retries n] [--timeout seconds]');
      process.exit(0);
    } else throw new Error(`unknown argument ${a}`);
  }
  if (!args.root) throw new Error('--root expects a directory');
  // a song id is a directory name under --root, never a path
  if (args.song !== null) assertSafeSongId(args.song);
  return args;
}

/** A song id must be a single directory name (no separators, no "..", not absolute). */
export function assertSafeSongId(id) {
  if (typeof id !== 'string' || id.length === 0) throw new Error('--song expects a song id');
  if (id === '.' || id === '..' || /[\\/]/.test(id) || id.includes('\0') || path.isAbsolute(id)) {
    throw new Error(`--song ${JSON.stringify(id)}: expects a song id (a directory name under --root), not a path`);
  }
  return id;
}

export function isPlaceholderUrl(url) {
  return !url || /example\.(com|org|net)/i.test(url) || /PLACEHOLDER|REPLACE[-_ ]?ME/i.test(url) || !/^https?:\/\//i.test(url);
}

export function discoverSongIds(root) {
  const ids = new Set();
  const indexPath = path.join(root, 'index.json');
  if (fs.existsSync(indexPath)) {
    const idx = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    const list = Array.isArray(idx) ? idx : idx.songs ?? [];
    for (const e of list) ids.add(typeof e === 'string' ? e : e.id);
  }
  if (fs.existsSync(root)) {
    for (const d of fs.readdirSync(root, { withFileTypes: true })) {
      if (d.isDirectory() && fs.existsSync(path.join(root, d.name, 'song.json'))) ids.add(d.name);
    }
  }
  return [...ids];
}

/**
 * Reject anything that would write outside the song's own directory. song.json is data the README
 * invites users to paste in from a third party, so `"file": "../../../.ssh/authorized_keys"` (or a
 * Windows drive/UNC path) must not be honoured.
 */
export function assertSafeRelativePath(rel, what = 'path') {
  if (typeof rel !== 'string' || rel.length === 0) throw new Error(`${what}: must be a non-empty string`);
  if (rel.includes('\0')) throw new Error(`${what} ${JSON.stringify(rel)}: contains a NUL byte`);
  if (path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel) || rel.startsWith('\\\\') || rel.startsWith('/')) {
    throw new Error(`${what} ${JSON.stringify(rel)}: must be relative to the song directory`);
  }
  const segments = rel.split(/[\\/]+/);
  if (segments.some((s) => s === '..')) throw new Error(`${what} ${JSON.stringify(rel)}: must not contain ".." segments`);
  return rel;
}

/** Resolve where a remote stem should be written, using the manifest's "stems" entry with the same id. */
export function targetPathFor(manifest, remote) {
  const local = (manifest.stems ?? []).find((s) => s.id === remote.id);
  if (local?.file) return assertSafeRelativePath(local.file, `stem "${remote.id}" file`);
  let ext = '.wav';
  try { ext = path.extname(new URL(remote.url).pathname) || ext; } catch { /* keep default */ }
  return `stems/${assertSafeRelativePath(String(remote.id), 'stem id')}${ext}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One attempt: GET `url` into `tmp`. A watchdog aborts the attempt when no headers arrive, or no
 * body bytes arrive, within `timeoutMs`; it is re-armed by every chunk so a slow-but-moving
 * transfer never trips it, only a stalled one.
 */
async function downloadOnce(url, tmp, timeoutMs) {
  const ac = new AbortController();
  let timer = null;
  let reason = '';
  const arm = (why) => {
    clearTimeout(timer);
    timer = setTimeout(() => { reason = `${why} after ${timeoutMs} ms`; ac.abort(); }, timeoutMs);
  };
  let bytes = 0;
  try {
    arm('no response');
    const res = await fetch(url, { redirect: 'follow', signal: ac.signal, headers: { 'user-agent': 'beat-rehab-fetch-stems/1.0' } });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const type = res.headers.get('content-type') ?? '';
    if (/text\/html/i.test(type)) throw new Error(`got an HTML page instead of audio (${type}) — check that the URL is a direct file link`);
    fs.mkdirSync(path.dirname(tmp), { recursive: true });
    arm('transfer stalled');
    const watchdog = new Transform({
      transform(chunk, _enc, cb) { bytes += chunk.length; arm('transfer stalled'); cb(null, chunk); },
    });
    await pipeline(Readable.fromWeb(res.body), watchdog, fs.createWriteStream(tmp), { signal: ac.signal });
    const expected = Number(res.headers.get('content-length'));
    if (Number.isInteger(expected) && expected > 0 && bytes !== expected) throw new Error(`short read: ${bytes} of ${expected} bytes`);
    return bytes;
  } catch (err) {
    throw new Error(reason || (err && err.message) || String(err));
  } finally {
    clearTimeout(timer);
  }
}

export async function download(url, dest, { retries = DEFAULT_RETRIES, timeoutMs = DEFAULT_TIMEOUT_SEC * 1000, warn = console.warn } = {}) {
  const tmp = dest + '.part';
  for (let attempt = 1; ; attempt++) {
    try {
      const bytes = await downloadOnce(url, tmp, timeoutMs);
      fs.renameSync(tmp, dest);
      return bytes;
    } catch (err) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
      if (attempt > retries) throw err;
      const wait = 500 * 2 ** (attempt - 1);
      warn(`    attempt ${attempt} failed (${err.message}); retrying in ${wait} ms`);
      await sleep(wait);
    }
  }
}

export async function fetchSong(root, id, { force = false, retries = DEFAULT_RETRIES, timeoutSec = DEFAULT_TIMEOUT_SEC, log = console.log } = {}) {
  assertSafeSongId(id);
  const dir = path.join(root, id);
  const manifestPath = path.join(dir, 'song.json');
  if (!fs.existsSync(manifestPath)) { log(`- ${id}: no song.json, skipping`); return { id, fetched: 0, skipped: 0, failed: 0 }; }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const remotes = manifest.remoteStems ?? [];
  const summary = { id, fetched: 0, skipped: 0, failed: 0 };
  log(`- ${id}: "${manifest.title}" by ${manifest.artist} — ${manifest.license}`);
  if (manifest.attribution) log(`    attribution: ${manifest.attribution}`);
  if (remotes.length === 0) { log('    no remoteStems (stems are local); nothing to fetch'); return summary; }
  for (const remote of remotes) {
    let rel;
    try {
      rel = targetPathFor(manifest, remote);
    } catch (err) {
      log(`    ${remote.id}: REFUSED unsafe target in song.json: ${err.message}`);
      summary.failed++;
      continue;
    }
    const dest = path.join(dir, rel);
    if (isPlaceholderUrl(remote.url)) { log(`    ${remote.id}: placeholder URL (${remote.url || 'empty'}) — edit song.json first, see public/songs/ccmixter-README.md`); summary.skipped++; continue; }
    if (!force && fs.existsSync(dest) && fs.statSync(dest).size > 0) { log(`    ${remote.id}: exists (${rel}), skipping`); summary.skipped++; continue; }
    try {
      const bytes = await download(remote.url, dest, { retries, timeoutMs: timeoutSec * 1000, warn: log });
      log(`    ${remote.id}: downloaded ${(bytes / 1e6).toFixed(1)} MB -> ${rel}`);
      summary.fetched++;
    } catch (err) {
      log(`    ${remote.id}: FAILED ${remote.url}: ${err.message}`);
      summary.failed++;
    }
  }
  return summary;
}

// `import.meta.url` → filesystem path via fileURLToPath so this also works on Windows
// (URL.pathname there is '/C:/…' and never equals path.resolve()).
const isMain = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`fetch-stems: ${err.message}`);
    process.exit(2);
  }
  const ids = args.song ? [args.song] : discoverSongIds(args.root).filter((id) => !id.startsWith('_'));
  if (ids.length === 0) { console.log(`no songs found under ${args.root}`); process.exit(0); }
  let failed = 0;
  for (const id of ids) {
    const s = await fetchSong(args.root, id, { force: args.force, retries: args.retries, timeoutSec: args.timeoutSec });
    failed += s.failed;
  }
  if (failed) { console.error(`\n${failed} stem(s) failed to download.`); process.exit(1); }
  console.log('\nDone. Remember: CC BY tracks must show their attribution in song select and results (the app reads song.json "attribution").');
}
