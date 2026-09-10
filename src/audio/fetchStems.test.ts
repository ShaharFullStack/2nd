/// <reference types="node" />
/**
 * Drives scripts/fetch-stems.mjs as a child process (so the CLI entry — `isMain` — is exercised)
 * against a local HTTP server that serves a good stem, a flaky one, a stalled one and an HTML page.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const script = path.join(repoRoot, 'scripts', 'fetch-stems.mjs');

const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(2000, 1)]);

/**
 * Run the CLI asynchronously: the HTTP server lives in this process, so a synchronous spawn would
 * block the event loop and every request would time out.
 */
function run(args: string[]): Promise<{ status: number; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.setEncoding('utf8').on('data', (d: string) => { out += d; });
    child.stderr.setEncoding('utf8').on('data', (d: string) => { out += d; });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`fetch-stems timed out\n${out}`)); }, 60_000);
    child.on('error', reject);
    child.on('close', (status) => { clearTimeout(timer); resolve({ status: status ?? -1, out }); });
  });
}

describe('scripts/fetch-stems.mjs against a local HTTP server', () => {
  let server: http.Server;
  let base = '';
  let flakyHits = 0;
  const stalled: http.ServerResponse[] = [];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'beat-rehab-fetch-'));

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = req.url ?? '';
      if (url === '/ok.wav') { res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': String(WAV.length) }); res.end(WAV); return; }
      if (url === '/flaky.wav') {
        flakyHits++;
        if (flakyHits === 1) { res.writeHead(503); res.end('busy'); return; }
        res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': String(WAV.length) });
        // stream in two chunks with a 100 ms gap (10× below the 1 s watchdog): slow-but-moving must not trip it
        res.write(WAV.subarray(0, 1000));
        setTimeout(() => res.end(WAV.subarray(1000)), 100);
        return;
      }
      if (url === '/stall.wav') { res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': '999999' }); res.write('R'); stalled.push(res); return; }
      if (url === '/page.wav') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<html>login</html>'); return; }
      res.writeHead(404); res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    fs.mkdirSync(path.join(root, 'cc-song', 'stems'), { recursive: true });
    fs.mkdirSync(path.join(root, '_template'), { recursive: true });
    fs.writeFileSync(path.join(root, 'index.json'), JSON.stringify({ songs: ['cc-song'] }));
    fs.writeFileSync(path.join(root, '_template', 'song.json'), JSON.stringify({ id: '_template', title: 't', artist: 'a', license: 'CC BY 4.0', remoteStems: [{ id: 'drums', url: `${base}/ok.wav` }] }));
    fs.writeFileSync(path.join(root, 'cc-song', 'stems', 'have.wav'), 'already here');
    fs.writeFileSync(path.join(root, 'cc-song', 'song.json'), JSON.stringify({
      id: 'cc-song', title: 'Song', artist: 'Someone', license: 'CC BY 4.0',
      attribution: '"Song" by Someone (ccmixter.org) is licensed under CC BY 4.0',
      bpm: 100, offset: 0, durationSec: 1, playerStem: 'ok',
      stems: [{ id: 'ok', file: 'stems/ok.wav' }, { id: 'flaky', file: 'stems/flaky.wav' }, { id: 'have', file: 'stems/have.wav' }, { id: 'stall', file: 'stems/stall.wav' }],
      remoteStems: [
        { id: 'ok', url: `${base}/ok.wav` },
        { id: 'flaky', url: `${base}/flaky.wav` },
        { id: 'have', url: `${base}/ok.wav` },
        { id: 'stall', url: `${base}/stall.wav` },
        { id: 'page', url: `${base}/page.wav` },
        { id: 'todo', url: 'https://example.com/PLACEHOLDER.wav' },
      ],
    }));
  });

  afterAll(async () => {
    for (const r of stalled) r.destroy();
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('downloads, skips existing + placeholders, retries a failed attempt, aborts a stalled one, rejects HTML', async () => {
    const { status, out } = await run(['--root', root, '--retries', '1', '--timeout', '1']);
    expect(status).toBe(1); // stall + page failed
    expect(out).toContain('"Song" by Someone (ccmixter.org) is licensed under CC BY 4.0');
    expect(out).toMatch(/ok: downloaded .* -> stems\/ok\.wav/);
    expect(out).toMatch(/attempt 1 failed \(HTTP 503/);
    expect(out).toMatch(/flaky: downloaded .* -> stems\/flaky\.wav/);
    expect(out).toContain('have: exists (stems/have.wav), skipping');
    expect(out).toMatch(/attempt 1 failed \(transfer stalled after 1000 ms\)/);
    expect(out).toMatch(/stall: FAILED .*transfer stalled after 1000 ms/);
    expect(out).toMatch(/page: FAILED .*HTML page/);
    expect(out).toContain('todo: placeholder URL');
    expect(out).toContain('2 stem(s) failed to download.');
    expect(out).not.toContain('_template'); // template directory is never fetched
    expect(flakyHits).toBe(2);

    const stems = path.join(root, 'cc-song', 'stems');
    expect(fs.readFileSync(path.join(stems, 'ok.wav')).equals(WAV)).toBe(true);
    expect(fs.readFileSync(path.join(stems, 'flaky.wav')).equals(WAV)).toBe(true);
    expect(fs.readFileSync(path.join(stems, 'have.wav'), 'utf8')).toBe('already here');
    expect(fs.existsSync(path.join(stems, 'stall.wav'))).toBe(false);
    expect(fs.existsSync(path.join(stems, 'stall.wav.part'))).toBe(false); // partial file cleaned up
    expect(fs.existsSync(path.join(stems, 'page.wav'))).toBe(false);
  }, 30_000);

  it('second run skips what it already has; --force re-downloads', async () => {
    const before = fs.statSync(path.join(root, 'cc-song', 'stems', 'ok.wav')).mtimeMs;
    const again = await run(['--root', root, '--song', 'cc-song', '--retries', '0', '--timeout', '1']);
    expect(again.out).toContain('ok: exists (stems/ok.wav), skipping');
    expect(again.out).toContain('flaky: exists (stems/flaky.wav), skipping');
    expect(fs.statSync(path.join(root, 'cc-song', 'stems', 'ok.wav')).mtimeMs).toBe(before);
    const forced = await run(['--root', root, '--song', 'cc-song', '--force', '--retries', '0', '--timeout', '1']);
    expect(forced.out).toMatch(/ok: downloaded/);
    expect(forced.out).toMatch(/have: downloaded/); // --force overwrites the placeholder file with the real stem
    expect(fs.readFileSync(path.join(root, 'cc-song', 'stems', 'have.wav')).equals(WAV)).toBe(true);
  }, 30_000);

  it('rejects a missing or non-numeric --retries / --timeout instead of looping forever', async () => {
    const missing = await run(['--root', root, '--retries']);
    expect(missing.status).toBe(2);
    expect(missing.out).toMatch(/--retries expects a non-negative integer, got nothing/);
    expect((await run(['--root', root, '--retries', 'lots'])).out).toMatch(/--retries expects/);
    expect((await run(['--root', root, '--retries', '1.5'])).out).toMatch(/--retries expects/);
    expect((await run(['--root', root, '--timeout', '0'])).out).toMatch(/--timeout expects/);
    expect((await run(['--root', root, '--bogus'])).out).toMatch(/unknown argument --bogus/);
  });

  it('reports "no songs" cleanly for an empty root', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'beat-rehab-empty-'));
    expect(await run(['--root', empty])).toEqual({ status: 0, out: `no songs found under ${empty}\n` });
    fs.rmSync(empty, { recursive: true, force: true });
  });
});
