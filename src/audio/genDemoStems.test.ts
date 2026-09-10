/// <reference types="node" />
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseManifest, stepTimeSec } from './manifest';

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

/**
 * Onset times (seconds) of a percussive mono stem: peaks of the short-time energy envelope that
 * rise sharply over the previous frame. Crude but ample for "is this transient on the grid?".
 */
function onsetTimes(s: Int16Array, sampleRate: number, hop = 128, win = 512): number[] {
  const env: number[] = [];
  for (let i = 0; i + win < s.length; i += hop) {
    let e = 0;
    for (let j = 0; j < win; j++) { const v = s[i + j] / 32768; e += v * v; }
    env.push(Math.sqrt(e / win));
  }
  const out: number[] = [];
  for (let i = 1; i < env.length - 1; i++) {
    if (env[i] - env[i - 1] > 0.02 && env[i] >= env[i + 1] && env[i] > 0.05) {
      const t = (i * hop) / sampleRate;
      if (out.length === 0 || t - out[out.length - 1] > 0.05) out.push(t); // one onset per 50 ms
    }
  }
  return out;
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
    // no '' / relative-path link fields: the UI would render them as broken anchors
    expect(manifestJson as Record<string, unknown>).not.toHaveProperty('artistUrl');
    expect(manifestJson as Record<string, unknown>).not.toHaveProperty('sourceUrl');
    expect(manifest.artistUrl).toBeUndefined();
    expect(manifest.sourceUrl).toBeUndefined();
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

  it('masters stems to matched loudness with the player stem on top, under each peak ceiling', () => {
    // Peak normalisation alone left the transient-heavy drums ~3.5 dB below the bass in RMS —
    // and the drums are the stem whose ducking is the game's main feedback cue.
    const loud = manifest.stems.map((s) => {
      const w = readWav(path.join(dir, s.file));
      let peak = 0;
      for (const v of w.samples) peak = Math.max(peak, Math.abs(v) / 32768);
      return { id: s.id, db: 20 * Math.log10(rms(w.samples)), peak };
    });
    const player = loud.find((l) => l.id === manifest.playerStem)!;
    expect(player.db).toBeCloseTo(-13, 0);
    for (const l of loud) {
      expect(l.peak, l.id).toBeLessThanOrEqual(0.951); // never clips the 16-bit container
      if (l.id !== manifest.playerStem) expect(player.db, l.id).toBeGreaterThan(l.db + 1);
    }
  });

  /**
   * `--rate` is what public/songs/ccmixter-README.md tells a clinic on slow Wi-Fi to run, so it is
   * held to the same standard as the committed 44.1 kHz build: real music, same balance, no clipping.
   *
   * These assertions are deliberately about *content*, not just the header. A previous
   * anti-alias filter (the voice-synthesis Chamberlin SVF, unstable at the cutoff a downsample
   * needs) diverged to float32 overflow and then NaN, which `Buffer.writeInt16LE` coerces to 0:
   * every low-rate stem was 203 full-scale clicks followed by minutes of digital silence. A bare
   * `rms(samples) > 0.02` passes on exactly that file — the clicks alone carry that much energy —
   * so the checks below compare against the full-rate render instead.
   */
  it('--rate writes a smaller low-bandwidth build: same music, same balance, no clipping', () => {
    const out3 = fs.mkdtempSync(path.join(os.tmpdir(), 'beat-rehab-stems3-'));
    execFileSync(process.execPath, [script, '--out', out3, '--song', 'demo-groove', '--bars', String(bars), '--rate', '22050'], { timeout: 120_000 });
    for (const stem of ['drums', 'bass', 'keys', 'lead']) {
      const w = readWav(path.join(out3, `demo-groove/stems/${stem}.wav`));
      const full = readWav(path.join(dir, `stems/${stem}.wav`));
      expect(w.sampleRate, stem).toBe(22050);
      expect(w.channels, stem).toBe(1);
      expect(w.bits, stem).toBe(16);
      expect(w.samples.length, stem).toBe(Math.round(expectedSec * 22050));
      // half the bytes, same music: the only size lever available without an encoder dependency
      expect(w.dataBytes, stem).toBeLessThan(full.dataBytes * 0.55);

      // no clipping: the downsampler must not push a mastered stem through full scale
      let clipped = 0;
      let peak = 0;
      for (let i = 0; i < w.samples.length; i++) {
        const a = Math.abs(w.samples[i]);
        if (a >= 32767) clipped++;
        if (a > peak) peak = a;
      }
      expect(clipped, `${stem} clipped samples`).toBe(0);
      // the peak of the source survives: never raised (that is what clips) and never collapsed
      let fullPeak = 0;
      for (let i = 0; i < full.samples.length; i++) fullPeak = Math.max(fullPeak, Math.abs(full.samples[i]));
      expect(peak, `${stem} peak`).toBeLessThanOrEqual(fullPeak + 1);
      expect(peak, `${stem} peak`).toBeGreaterThan(fullPeak * 0.7);

      // the *music* survives: overall loudness within 2 dB of the full-rate stem (the lowpass
      // takes the band above 9.3 kHz, which costs the drums ~1.3 dB of hi-hat), and the energy is
      // spread over the whole file rather than concentrated in a transient at the start
      const db = 20 * Math.log10(rms(w.samples));
      const fullDb = 20 * Math.log10(rms(full.samples));
      expect(db, `${stem} dBRMS vs ${fullDb.toFixed(2)}`).toBeGreaterThan(fullDb - 2);
      expect(db, `${stem} dBRMS vs ${fullDb.toFixed(2)}`).toBeLessThan(fullDb + 2);
      const half = w.samples.length >> 1;
      const tailDb = 20 * Math.log10(rms(w.samples, half));
      expect(tailDb, `${stem} second-half dBRMS`).toBeGreaterThan(db - 6);
    }
    const raw = JSON.parse(fs.readFileSync(path.join(out3, 'demo-groove/song.json'), 'utf8')) as { generated: { sampleRate: number } };
    expect(parseManifest(raw).durationSec).toBeCloseTo(expectedSec, 3);
    // the manifest records the rate actually written, so a low-bandwidth deployment is self-describing
    expect(raw.generated.sampleRate).toBe(22050);
  });

  /**
   * The filter has to stay stable at every rate the CLI accepts, not only at the 22050 the README
   * suggests — a downsample cutoff is a high fraction of the source Nyquist and that is exactly
   * where a state-variable filter blows up. Driven through a child process because the generator
   * is untyped ESM.
   */
  it('resample() stays finite and never raises the peak, at every accepted rate', () => {
    const code = `
      import { resample, peakOf } from ${JSON.stringify(script)};
      const n = 44100;
      const src = new Float32Array(n);
      // full-band torture signal: a swept sine plus an impulse train (worst case for ringing)
      for (let i = 0; i < n; i++) {
        const t = i / 44100;
        src[i] = 0.7 * Math.sin(2 * Math.PI * (200 + 20000 * t) * t) + (i % 4410 === 0 ? 0.25 : 0);
      }
      const inPeak = peakOf(src);
      const out = [];
      for (const rate of [8000, 11025, 16000, 22050, 32000, 44100]) {
        const r = resample(src, 44100, rate);
        let finite = true;
        for (let i = 0; i < r.length; i++) if (!Number.isFinite(r[i])) { finite = false; break; }
        out.push({ rate, len: r.length, finite, peak: peakOf(r), inPeak, rms: Math.sqrt(r.reduce((a, v) => a + v * v, 0) / r.length) });
      }
      console.log(JSON.stringify(out));
    `;
    const stdoutJson = execFileSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 60_000 });
    const rows = JSON.parse(stdoutJson.trim().split('\n').pop()!) as { rate: number; len: number; finite: boolean; peak: number; inPeak: number; rms: number }[];
    expect(rows).toHaveLength(6);
    for (const r of rows) {
      expect(r.finite, `rate ${r.rate}: every sample finite`).toBe(true);
      expect(r.len, `rate ${r.rate}: length`).toBe(r.rate === 44100 ? 44100 : Math.round(r.rate));
      expect(r.peak, `rate ${r.rate}: peak never raised`).toBeLessThanOrEqual(r.inPeak + 1e-6);
      // and not collapsed to silence either: a band-limited copy keeps most of its energy
      expect(r.rms, `rate ${r.rate}: rms`).toBeGreaterThan(0.1);
    }
  });

  /**
   * The keys chords are struck as several `synthNote` voices at once, all starting at phase 0, so
   * two voices on the SAME pitch sum coherently and that note comes out ~6 dB above the chord.
   * The octave fold that keeps voicings compact used to produce exactly that on C major.
   */
  it('every keys voicing is made of distinct pitches (no phase-coherent unison in a chord)', () => {
    const code = `
      import { SONGS, voiceChord, KEYS_VOICING_CEILING } from ${JSON.stringify(script)};
      const rows = [];
      for (const song of Object.values(SONGS)) {
        for (const chord of song.progression) {
          rows.push({ song: song.id, chord: chord.name, tones: voiceChord(chord), ceiling: KEYS_VOICING_CEILING });
        }
      }
      console.log(JSON.stringify(rows));
    `;
    const rows = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 60_000 }).trim()) as
      { song: string; chord: string; tones: number[]; ceiling: number }[];
    expect(rows.length).toBeGreaterThanOrEqual(8);
    for (const r of rows) {
      expect(new Set(r.tones).size, `${r.song} ${r.chord}: ${r.tones.join()}`).toBe(r.tones.length);
      // still compact: nothing folded lands below the register, and only an octave doubling of a
      // tone that is already there is allowed above the ceiling
      for (const m of r.tones) expect(m).toBeGreaterThan(r.ceiling - 24);
      for (const m of r.tones) if (m > r.ceiling) expect(r.tones).toContain(m - 12);
    }
    // the regression itself: C major over root 36 keeps its octave instead of doubling the root
    const c = rows.find((r) => r.chord === 'C')!;
    expect(c.tones).toEqual([60, 64, 67, 72]);
  });

  it('the reverb send is a finite, decaying tail (and the dry stems stay dry)', () => {
    const code = `
      import { reverbWet, peakOf, rmsOf } from ${JSON.stringify(script)};
      const n = 44100 * 3;
      const x = new Float32Array(n);
      x[0] = 1; // impulse response of the send
      const wet = reverbWet(x, { rt60: 1.5, preDelaySec: 0.02, damp: 0.35 });
      let finite = true;
      for (let i = 0; i < n; i++) if (!Number.isFinite(wet[i])) { finite = false; break; }
      const win = (a, b) => rmsOf(wet.subarray(Math.round(a * 44100), Math.round(b * 44100)));
      console.log(JSON.stringify({
        finite, peak: peakOf(wet), preDelaySilent: peakOf(wet.subarray(0, Math.round(0.019 * 44100))),
        early: win(0.05, 0.15), mid: win(0.7, 0.8), late: win(1.9, 2.0),
        all: rmsOf(wet), same: rmsOf(reverbWet(x, { rt60: 1.5, preDelaySec: 0.02, damp: 0.35 })),
      }));
    `;
    const r = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 60_000 }).trim()) as
      { finite: boolean; peak: number; preDelaySilent: number; early: number; mid: number; late: number; all: number; same: number };
    expect(r.finite).toBe(true);
    expect(r.preDelaySilent).toBe(0);        // nothing before the pre-delay
    expect(r.peak).toBeLessThanOrEqual(1);   // a send, not a resonator running away
    expect(r.early).toBeGreaterThan(0);
    expect(r.mid).toBeLessThan(r.early);     // monotone decay …
    expect(r.late).toBeLessThan(r.mid);
    expect(r.late).toBeGreaterThan(0);       // … but still audible ~2 s in (RT60 1.5 s)
    expect(r.same).toBe(r.all);              // deterministic: no RNG anywhere in the tail
  });

  it('encodeWav16 refuses a non-finite sample instead of writing it out as silence', () => {
    const code = `
      import { encodeWav16 } from ${JSON.stringify(script)};
      let threw = 0;
      for (const bad of [NaN, Infinity, -Infinity]) {
        try { encodeWav16(Float32Array.from([0.1, bad, 0.2])); } catch { threw++; }
      }
      console.log(JSON.stringify({ threw, ok: encodeWav16(Float32Array.from([0.1, 0.2])).length }));
    `;
    const res = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 60_000 }).trim()) as { threw: number; ok: number };
    expect(res.threw).toBe(3);
    expect(res.ok).toBe(44 + 4);
  });

  it('rejects a --rate outside the supported range', () => {
    for (const rate of ['0', '48000', 'abc']) {
      expect(() => execFileSync(process.execPath, [script, '--out', out, '--rate', rate], { timeout: 30_000, stdio: 'pipe' })).toThrow();
    }
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

  it('the published `swing` describes the audio: drum onsets sit on the manifest grid, not near it', () => {
    // A chart generator places notes with `stepTimeSec(manifest, step)`. If the manifest did not
    // publish the feel (or published the wrong one) every odd-16th note of a swung song would ask
    // the patient to move `swing × a 16th` away from the drum they can hear — 50 ms here, which is
    // most of a 'perfect' window on hard.
    const songsDir = path.join(repoRoot, 'public', 'songs');
    const expected: Record<string, number> = { 'demo-groove': 0, 'demo-sunrise': 1 / 3 };
    for (const [id, swing] of Object.entries(expected)) {
      const m = parseManifest(JSON.parse(fs.readFileSync(path.join(songsDir, id, 'song.json'), 'utf8')));
      expect(m.swing ?? 0, id).toBeCloseTo(swing, 6);
      const drums = readWav(path.join(songsDir, id, 'stems/drums.wav'));
      const onsets = onsetTimes(drums.samples, drums.sampleRate);
      expect(onsets.length, id).toBeGreaterThan(50);
      const stepSec = 60 / m.bpm / 4;
      const errs: number[] = [];
      const oddErrs: number[] = [];
      for (const t of onsets) {
        const k = Math.round((t - m.offset) / stepSec);
        const e = (t - stepTimeSec(m, k)) * 1000;
        if (Math.abs(e) > 60) continue; // fill hits sit on 32nds; the detector also has jitter
        errs.push(Math.abs(e));
        if (Math.abs(k % 2) === 1) oddErrs.push(e);
      }
      errs.sort((a, b) => a - b);
      expect(errs.length, id).toBeGreaterThan(40);
      expect(errs[Math.floor(errs.length / 2)], `${id} median |onset − grid|`).toBeLessThan(6);
      if (swing > 0) {
        // and the swung steps are genuinely late against the STRAIGHT grid (the feel is real)
        expect(oddErrs.length, id).toBeGreaterThan(5);
        const straight = oddErrs.map((e) => e + swing * stepSec * 1000).sort((a, b) => a - b);
        expect(straight[Math.floor(straight.length / 2)]).toBeCloseTo(swing * stepSec * 1000, 0);
      }
    }
  });

  it('the template manifest parses and uses placeholder remote URLs', () => {
    const t = parseManifest(JSON.parse(fs.readFileSync(path.join(repoRoot, 'public/songs/_template/song.json'), 'utf8')));
    expect(t.remoteStems?.length).toBeGreaterThan(0);
    for (const r of t.remoteStems ?? []) expect(r.url).toMatch(/PLACEHOLDER/);
  });
});
