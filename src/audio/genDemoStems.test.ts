/// <reference types="node" />
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseManifest } from './manifest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const script = path.join(repoRoot, 'scripts', 'gen-demo-stems.mjs');
const SR = 44100;

interface WavInfo { format: number; channels: number; sampleRate: number; bits: number; dataBytes: number; samples: Int16Array }

function readWav(file: string): WavInfo {
  const b = fs.readFileSync(file);
  expect(b.toString('ascii', 0, 4)).toBe('RIFF');
  expect(b.readUInt32LE(4)).toBe(b.length - 8);
  expect(b.toString('ascii', 8, 12)).toBe('WAVE');
  expect(b.toString('ascii', 12, 16)).toBe('fmt ');
  expect(b.readUInt32LE(16)).toBe(16);
  const format = b.readUInt16LE(20);
  const channels = b.readUInt16LE(22);
  const sampleRate = b.readUInt32LE(24);
  const bits = b.readUInt16LE(34);
  expect(b.readUInt32LE(28)).toBe(sampleRate * channels * (bits / 8));
  expect(b.readUInt16LE(32)).toBe(channels * (bits / 8));
  expect(b.toString('ascii', 36, 40)).toBe('data');
  const dataBytes = b.readUInt32LE(40);
  expect(dataBytes).toBe(b.length - 44);
  const samples = new Int16Array(dataBytes / 2);
  for (let i = 0; i < samples.length; i++) samples[i] = b.readInt16LE(44 + i * 2);
  return { format, channels, sampleRate, bits, dataBytes, samples };
}

const rms = (s: Int16Array, from = 0, to = s.length) => {
  let sq = 0;
  for (let i = from; i < to; i++) sq += (s[i] / 32768) ** 2;
  return Math.sqrt(sq / Math.max(1, to - from));
};

describe('scripts/gen-demo-stems.mjs', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'beat-rehab-stems-'));
  const bars = 2;
  const stdout = execFileSync(process.execPath, [script, '--out', out, '--song', 'demo-groove', '--bars', String(bars)], { encoding: 'utf8', timeout: 120_000 });
  const dir = path.join(out, 'demo-groove');
  const manifestJson: unknown = JSON.parse(fs.readFileSync(path.join(dir, 'song.json'), 'utf8'));
  const manifest = parseManifest(manifestJson);
  const expectedSec = bars * 4 * (60 / 120) + 1.0; // bars + 1 s tail

  it('writes a song.json that satisfies the manifest schema', () => {
    expect(stdout).toContain('demo-groove');
    expect(manifest.id).toBe('demo-groove');
    expect(manifest.bpm).toBe(120);
    expect(manifest.offset).toBe(0);
    expect(manifest.license).toBe('CC0 1.0');
    expect(manifest.artist).toBe('Beat Rehab demo (synthesized)');
    expect(manifest.attribution).toMatch(/synthesized in-repo/);
    expect(manifest.playerStem).toBe('drums');
    expect(manifest.stems.map((s) => s.id)).toEqual(['drums', 'bass', 'keys', 'lead']);
    expect(manifest.durationSec).toBeCloseTo(expectedSec, 3);
    expect(manifest.remoteStems).toEqual([]);
  });

  it('renders every stem as a valid 16-bit 44.1 kHz mono RIFF/WAVE of the manifest length', () => {
    for (const stem of manifest.stems) {
      const info = readWav(path.join(dir, stem.file));
      expect(info.format).toBe(1);
      expect(info.channels).toBe(1);
      expect(info.sampleRate).toBe(SR);
      expect(info.bits).toBe(16);
      expect(info.samples.length).toBe(Math.round(expectedSec * SR));
      expect(info.dataBytes).toBe(Math.round(manifest.durationSec * SR) * 2);
    }
  });

  it('produces real signal: non-silent, not clipped, and drums hit on the beat grid', () => {
    const drums = readWav(path.join(dir, 'stems/drums.wav')).samples;
    const bass = readWav(path.join(dir, 'stems/bass.wav')).samples;
    expect(rms(drums)).toBeGreaterThan(0.02);
    expect(rms(bass)).toBeGreaterThan(0.02);
    let peak = 0;
    for (let i = 0; i < drums.length; i++) peak = Math.max(peak, Math.abs(drums[i]));
    expect(peak).toBeLessThan(32767);
    expect(peak).toBeGreaterThan(32767 * 0.5);
    // energy in the 30 ms after each downbeat must beat the energy just before it (transient on the grid)
    const beat = 60 / 120;
    for (let b = 0; b < bars * 4; b++) {
      const i0 = Math.round(b * beat * SR);
      const on = rms(drums, i0, i0 + Math.round(0.03 * SR));
      const before = rms(drums, Math.max(0, i0 - Math.round(0.03 * SR)), i0);
      expect(on).toBeGreaterThan(before);
    }
    // the tail after the last bar fades to silence
    expect(rms(drums, drums.length - 200, drums.length)).toBeLessThan(0.01);
  });

  it('is deterministic', () => {
    const out2 = fs.mkdtempSync(path.join(os.tmpdir(), 'beat-rehab-stems2-'));
    execFileSync(process.execPath, [script, '--out', out2, '--song', 'demo-groove', '--bars', String(bars)], { timeout: 120_000 });
    const a = fs.readFileSync(path.join(dir, 'stems/lead.wav'));
    const b = fs.readFileSync(path.join(out2, 'demo-groove/stems/lead.wav'));
    expect(a.equals(b)).toBe(true);
  });
});

describe('committed demo songs', () => {
  it('index.json lists both demo songs and their manifests + stems exist', () => {
    const songsDir = path.join(repoRoot, 'public', 'songs');
    const idx = JSON.parse(fs.readFileSync(path.join(songsDir, 'index.json'), 'utf8')) as { songs: string[] };
    expect(idx.songs).toEqual(['demo-groove', 'demo-sunrise']);
    for (const id of idx.songs) {
      const m = parseManifest(JSON.parse(fs.readFileSync(path.join(songsDir, id, 'song.json'), 'utf8')));
      expect(m.id).toBe(id);
      for (const s of m.stems) {
        const file = path.join(songsDir, id, s.file);
        expect(fs.existsSync(file), `${id}/${s.file} missing — run npm run gen-demo-stems`).toBe(true);
        const bytes = fs.statSync(file).size;
        expect(bytes).toBe(44 + Math.round(m.durationSec * SR) * 2);
      }
    }
    // the two demos must actually be different songs
    const a = parseManifest(JSON.parse(fs.readFileSync(path.join(songsDir, 'demo-groove/song.json'), 'utf8')));
    const b = parseManifest(JSON.parse(fs.readFileSync(path.join(songsDir, 'demo-sunrise/song.json'), 'utf8')));
    expect(a.bpm).not.toBe(b.bpm);
    expect(a.title).not.toBe(b.title);
  });

  it('the template manifest parses and uses placeholder remote URLs', () => {
    const t = parseManifest(JSON.parse(fs.readFileSync(path.join(repoRoot, 'public/songs/_template/song.json'), 'utf8')));
    expect(t.remoteStems?.length).toBeGreaterThan(0);
    for (const r of t.remoteStems ?? []) expect(r.url).toMatch(/PLACEHOLDER/);
  });
});
