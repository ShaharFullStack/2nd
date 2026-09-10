/// <reference types="node" />
/**
 * Headroom proof against the *shipped* demo stems and the shipped SFX cues.
 *
 * Worst realistic sum at the destination = (all four stems, sample-wise, with the +2 dB streak
 * boost on the player stem) + (the loudest SFX cue at full slider), times the default master gain,
 * through the limiter model. Everything here is measured from the committed WAVs and from the same
 * `cueTones` specs `Sfx` actually schedules — nothing is estimated.
 *
 * The numbers quoted in StemMixer.ts's module comment are asserted here to two decimals, not just
 * bounded: their whole value is that they are measured claims, so a regeneration of the demo songs
 * that moves them must fail this file rather than silently make the comment wrong.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_MASTER_GAIN, LIMITER_SETTINGS, limiterMakeupGain, limiterOutputPeak } from './StemMixer';
import { DEFAULT_DUCK_OPTIONS, dbToGain } from './ducking';
import { SFX_CUE_PEAKS, cueTones, envelopeSumPeak, sfxBusPeak, type SfxKind } from './sfx';
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

function rmsDb(s: Int16Array): number {
  let acc = 0;
  for (let i = 0; i < s.length; i++) { const v = s[i] / 32768; acc += v * v; }
  return 20 * Math.log10(Math.sqrt(acc / Math.max(s.length, 1)));
}

const ids = (JSON.parse(fs.readFileSync(path.join(songsDir, 'index.json'), 'utf8')) as { songs: string[] }).songs;
const boost = dbToGain(DEFAULT_DUCK_OPTIONS.streakBoostDb);

/** Measured summed peaks quoted in the StemMixer module comment. */
const EXPECTED: Record<string, { summed: number; boosted: number }> = {
  'demo-groove': { summed: 2.05, boosted: 2.28 },
  'demo-sunrise': { summed: 1.99, boosted: 2.23 },
};

/** SFX at the top of the slider: the worst case a viewer can actually produce. */
const SFX_WORST = sfxBusPeak(1);

describe('SFX cue peaks (the specs Sfx schedules)', () => {
  it('envelopeSumPeak sums the partials coherently and never exceeds their sum', () => {
    for (const kind of Object.keys(SFX_CUE_PEAKS) as SfxKind[]) {
      const specs = cueTones(kind, { milestone: 100 });
      const partialSum = specs.reduce((a, s) => a + s.peak, 0);
      const loudest = Math.max(...specs.map((s) => s.peak));
      expect(SFX_CUE_PEAKS[kind]).toBeGreaterThanOrEqual(loudest); // at least the loudest partial
      expect(SFX_CUE_PEAKS[kind]).toBeLessThanOrEqual(partialSum + 1e-9);
      expect(envelopeSumPeak(specs)).toBeCloseTo(SFX_CUE_PEAKS[kind], 6);
    }
  });

  it('the hit tick is the loudest cue; the bus peak scales with the volume', () => {
    expect(SFX_CUE_PEAKS.hit).toBeCloseTo(0.62, 2);
    expect(SFX_WORST).toBeCloseTo(0.62, 2);
    expect(sfxBusPeak(0.5)).toBeCloseTo(SFX_WORST / 2, 9);
    expect(sfxBusPeak(0)).toBe(0);
  });
});

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
    it(`${id}: stems + streak boost + SFX × master never hard-clips`, () => {
      const m = parseManifest(JSON.parse(fs.readFileSync(path.join(songsDir, id, 'song.json'), 'utf8')));
      const stems = new Map<string, Int16Array>();
      for (const s of m.stems) stems.set(s.id, readPcm16(path.join(songsDir, id, s.file)));
      const plain = summedPeak(stems, m.playerStem, 1);
      const boosted = summedPeak(stems, m.playerStem, boost);
      expect(plain).toBeGreaterThan(1); // the stems do sum past full scale: the master gain is load-bearing
      expect(boosted).toBeGreaterThanOrEqual(plain);
      // the exact figures quoted in the StemMixer module comment
      expect(plain).toBeCloseTo(EXPECTED[id].summed, 2);
      expect(boosted).toBeCloseTo(EXPECTED[id].boosted, 2);

      // SFX ride on the same master bus (StemMixer.sfxBus), so they are part of the budget
      const worst = boosted + SFX_WORST;
      // without the limiter: the destination receives worst × master, which must stay below 1.0
      expect(worst * DEFAULT_MASTER_GAIN.none).toBeLessThanOrEqual(0.95);
      // with the limiter: its modelled output (static curve + make-up gain) must stay below 1.0
      expect(limiterOutputPeak(worst * DEFAULT_MASTER_GAIN.limiter)).toBeLessThan(0.95);
      // and the quoted peak into the limiter
      expect(worst * DEFAULT_MASTER_GAIN.limiter).toBeCloseTo(id === 'demo-groove' ? 2.32 : 2.28, 2);
    });

    it(`${id}: the player stem is the loudest element (its ducking is the main feedback cue)`, () => {
      const m = parseManifest(JSON.parse(fs.readFileSync(path.join(songsDir, id, 'song.json'), 'utf8')));
      const loud = m.stems.map((s) => ({ id: s.id, db: rmsDb(readPcm16(path.join(songsDir, id, s.file))) }));
      const player = loud.find((l) => l.id === m.playerStem)!;
      expect(player.db).toBeCloseTo(-13, 1);
      for (const other of loud) {
        if (other.id === m.playerStem) continue;
        // peak-normalised mastering used to leave the drums ~3.5 dB BELOW the bass; RMS matching
        // in gen-demo-stems.mjs puts them on top, where the ducking cue is unmissable.
        expect(player.db).toBeGreaterThan(other.db + 1);
      }
    });
  }
});
