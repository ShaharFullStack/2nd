#!/usr/bin/env node
// Beat Rehab — download Creative-Commons stems listed in each song.json "remoteStems".
//
// usage: node scripts/fetch-stems.mjs [--song <id>] [--force] [--root public/songs] [--retries 3]
//
// For every song directory (from index.json plus any directory containing a song.json):
//   * each remoteStems entry {id, url} is downloaded to the path of the matching "stems" entry
//     (falls back to stems/<id>.<ext-from-url>) — existing files are skipped unless --force,
//   * failed downloads are retried with exponential back-off,
//   * placeholder URLs (example.com / "PLACEHOLDER") are skipped with a hint,
//   * the song's attribution line is printed so the licence terms are visible at fetch time.
//
// Pure Node >= 18 (global fetch), no dependencies.

import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

function parseArgs(argv) {
  const args = { root: 'public/songs', song: null, force: false, retries: 3 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') args.root = argv[++i];
    else if (a === '--song') args.song = argv[++i];
    else if (a === '--force') args.force = true;
    else if (a === '--retries') args.retries = Number(argv[++i]);
    else if (a === '--help' || a === '-h') { console.log('usage: fetch-stems.mjs [--song id] [--force] [--root dir] [--retries n]'); process.exit(0); }
    else throw new Error(`unknown argument ${a}`);
  }
  return args;
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

/** Resolve where a remote stem should be written, using the manifest's "stems" entry with the same id. */
export function targetPathFor(manifest, remote) {
  const local = (manifest.stems ?? []).find((s) => s.id === remote.id);
  if (local?.file) return local.file;
  let ext = '.wav';
  try { ext = path.extname(new URL(remote.url).pathname) || ext; } catch { /* keep default */ }
  return `stems/${remote.id}${ext}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function download(url, dest, retries) {
  let attempt = 0;
  for (;;) {
    attempt++;
    const tmp = dest + '.part';
    try {
      const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'beat-rehab-fetch-stems/1.0' } });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      const type = res.headers.get('content-type') ?? '';
      if (/text\/html/i.test(type)) throw new Error(`got an HTML page instead of audio (${type}) — check that the URL is a direct file link`);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
      fs.renameSync(tmp, dest);
      return fs.statSync(dest).size;
    } catch (err) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
      if (attempt > retries) throw err;
      const wait = 500 * 2 ** (attempt - 1);
      console.warn(`    attempt ${attempt} failed (${err.message}); retrying in ${wait} ms`);
      await sleep(wait);
    }
  }
}

export async function fetchSong(root, id, { force = false, retries = 3, log = console.log } = {}) {
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
    const rel = targetPathFor(manifest, remote);
    const dest = path.join(dir, rel);
    if (isPlaceholderUrl(remote.url)) { log(`    ${remote.id}: placeholder URL (${remote.url || 'empty'}) — edit song.json first, see public/songs/ccmixter-README.md`); summary.skipped++; continue; }
    if (!force && fs.existsSync(dest) && fs.statSync(dest).size > 0) { log(`    ${remote.id}: exists (${rel}), skipping`); summary.skipped++; continue; }
    try {
      const bytes = await download(remote.url, dest, retries);
      log(`    ${remote.id}: downloaded ${(bytes / 1e6).toFixed(1)} MB -> ${rel}`);
      summary.fetched++;
    } catch (err) {
      log(`    ${remote.id}: FAILED ${remote.url}: ${err.message}`);
      summary.failed++;
    }
  }
  return summary;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname;
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const ids = args.song ? [args.song] : discoverSongIds(args.root).filter((id) => !id.startsWith('_'));
  if (ids.length === 0) { console.log(`no songs found under ${args.root}`); process.exit(0); }
  let failed = 0;
  for (const id of ids) {
    const s = await fetchSong(args.root, id, { force: args.force, retries: args.retries });
    failed += s.failed;
  }
  if (failed) { console.error(`\n${failed} stem(s) failed to download.`); process.exit(1); }
  console.log('\nDone. Remember: CC BY tracks must show their attribution in song select and results (the app reads song.json "attribution").');
}
