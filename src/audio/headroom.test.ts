/// <reference types="node" />
/**
 * Headroom proof against the *shipped* demo stems: the sample-wise sum of the four committed
 * WAVs (with the +2 dB streak boost applied to the player stem) times the default master gain
 * must stay below full scale without the limiter, and below the limiter's modelled ceiling with
 * it. This is what makes the module comment in StemMixer.ts a measured claim, not an estimate.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_MASTER_GAIN, LIMITER_SETTINGS, limiterMakeupGain, limiterOutputPeak } from './StemMixer';
import { DEFAULT_DUCK_OPTIONS, dbToGain } from './ducking';
import { parseManifest } from './manifest';

const songsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'songs');

function readPcm16(file: string): Int16Array {
  const b = fs.readFileSync(file);
  expect(b.toString('ascii', 0, 4)).toBe('RIFF');
  expect(b.readUInt16LE(22)).toBe(1); // mono
  expect(b.readUInt16LE(34)).toBe(16);
  const n = b.readUInt32LE(40) / 2;
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = b.readInt16LE(44 + i * 2);
  return out;
}

/** Sample-wise peak of the stem sum with `boost` applied to `playerStem`. */
function summedPeak(stems: Map<string, Int16Array>, playerStem: string, boost: number): number {
  let n = 0;
  for (const s of stems.values()) n = Math.max(n, s.length);
  let peak = 0;
  const entries = [...stems.entries()].map(([id, s]) => ({ s, g: id === playerStem ? boost : 1 }));
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (const { s, g } of entries) if (i < s.length) sum += (s[i] / 32768) * g;
    const a = Math.abs(sum);
    if (a > peak) peak = a;
  }
  return peak;
}

const ids = (JSON.parse(fs.readFileSync(path.join(songsDir, 'index.json'), 'utf8')) as { songs: string[] }).songs;
const boost = dbToGain(DEFAULT_DUCK_OPTIONS.streakBoostDb);

describe('master headroom against the shipped demo stems', () => {
  it('limiter model reproduces the kernel make-up gain (+1.7 dB for threshold −3 dB, ratio 20)', () => {
    expect(20 * Math.log10(limiterMakeupGain())).toBeCloseTo(1.71, 1);
    // below the threshold the curve is unity: output = input × make-up
    expect(limiterOutputPeak(0.5)).toBeCloseTo(0.5 * limiterMakeupGain(), 12);
    // at the threshold the two branches meet
    const th = Math.pow(10, LIMITER_SETTINGS.threshold / 20);
    expect(limiterOutputPeak(th)).toBeCloseTo(th * limiterMakeupGain(), 12);
    // the limiter only reaches 0 dBFS for inputs ≥ +20 dBFS with these settings
    expect(limiterOutputPeak(Math.pow(10, 20 / 20))).toBeLessThan(1);
    expect(limiterOutputPeak(Math.pow(10, 30 / 20))).toBeGreaterThan(1);
  });

  for (const id of ids) {
    it(`${id}: sum of stems (+2 dB on the player stem) × master never hard-clips`, () => {
      const m = parseManifest(JSON.parse(fs.readFileSync(path.join(songsDir, id, 'song.json'), 'utf8')));
      const stems = new Map<string, Int16Array>();
      for (const s of m.stems) stems.set(s.id, readPcm16(path.join(songsDir, id, s.file)));
      const plain = summedPeak(stems, m.playerStem, 1);
      const boosted = summedPeak(stems, m.playerStem, boost);
      expect(plain).toBeGreaterThan(1); // the stems do sum past full scale: the master gain is load-bearing
      expect(boosted).toBeGreaterThanOrEqual(plain);
      // without the limiter: the destination receives sum × master, which must stay below 1.0
      expect(boosted * DEFAULT_MASTER_GAIN.none).toBeLessThanOrEqual(0.95);
      // with the limiter: its modelled output (static curve + make-up gain) must stay below 1.0
      expect(limiterOutputPeak(boosted * DEFAULT_MASTER_GAIN.limiter)).toBeLessThan(0.95);
    });
  }
});
