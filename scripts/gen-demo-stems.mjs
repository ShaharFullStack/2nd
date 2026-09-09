#!/usr/bin/env node
// Beat Rehab — demo multitrack generator (pure Node, zero dependencies).
//
// Renders two original, fully synthesized songs as 4-stem 16-bit / 44.1 kHz mono WAV
// multitracks plus a song.json manifest each:
//
//   public/songs/demo-groove/   120 BPM funk-rock, A minor  (i–VI–III–VII)
//   public/songs/demo-sunrise/  100 BPM laid-back groove, D major (I–V–vi–IV)
//
// usage: node scripts/gen-demo-stems.mjs [--out public/songs] [--song demo-groove|demo-sunrise|all] [--bars N]
//   --bars N  overrides the song length (used by the unit tests to render a short excerpt)
//
// Everything here is deterministic (seeded PRNG) so re-running produces identical files.

import fs from 'node:fs';
import path from 'node:path';

export const SAMPLE_RATE = 44100;
const SR = SAMPLE_RATE;
const TAIL_SEC = 1.0; // decay tail rendered after the last bar

// ---------------------------------------------------------------------------
// tiny DSP toolkit
// ---------------------------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const midiToHz = (m) => 440 * Math.pow(2, (m - 69) / 12);

/** Chamberlin state-variable filter; cheap and cutoff can move every sample. */
class SVF {
  constructor() { this.low = 0; this.band = 0; this.high = 0; }
  run(x, fc, damp) {
    const f = 2 * Math.sin((Math.PI * Math.min(fc, 9000)) / SR);
    this.low += f * this.band;
    this.high = x - this.low - damp * this.band;
    this.band += f * this.high;
    return this.low;
  }
}

function polyblep(t, dt) {
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
}
const sawOsc = (t, dt) => 2 * t - 1 - polyblep(t, dt);
const squareOsc = (t, dt) => (t < 0.5 ? 1 : -1) + polyblep(t, dt) - polyblep((t + 0.5) % 1, dt);
const pulseOsc = (t, dt, width) => {
  const a = sawOsc(t, dt);
  const b = sawOsc((t + width) % 1, dt);
  return a - b;
};

/** ADSR in seconds; returns amplitude at time t for a note of length dur (release starts at dur). */
function adsr(t, dur, a, d, s, r) {
  if (t < 0) return 0;
  let env;
  if (t < a) env = t / a;
  else if (t < a + d) env = 1 - (1 - s) * ((t - a) / d);
  else env = s;
  if (t > dur) {
    const rel = (t - dur) / r;
    if (rel >= 1) return 0;
    env *= 1 - rel;
  }
  return env;
}

const softClip = (x, drive = 1.4) => Math.tanh(x * drive) / Math.tanh(drive);

// ---------------------------------------------------------------------------
// instruments (each writes additively into a Float32Array at sample index i0)
// ---------------------------------------------------------------------------

function kick(buf, t0, vel, rnd, { pitch = 1, decay = 9 } = {}) {
  const i0 = Math.round(t0 * SR);
  const n = Math.floor(0.4 * SR);
  let phase = 0;
  for (let k = 0; k < n && i0 + k < buf.length; k++) {
    const t = k / SR;
    const f = (48 + 120 * Math.exp(-t * 32)) * pitch;
    phase += (2 * Math.PI * f) / SR;
    const body = Math.tanh(1.8 * Math.sin(phase)) * Math.exp(-t * decay);
    const click = k < 40 ? (1 - k / 40) * 0.35 * (rnd() * 2 - 1) : 0;
    buf[i0 + k] += vel * (body + click);
  }
}

function tom(buf, t0, vel, rnd, semis) {
  kick(buf, t0, vel * 0.8, rnd, { pitch: Math.pow(2, semis / 12), decay: 7 });
}

function snare(buf, t0, vel, rnd, { tone = 185, rim = false } = {}) {
  const i0 = Math.round(t0 * SR);
  const n = Math.floor((rim ? 0.12 : 0.25) * SR);
  const hp = new SVF();
  const bp = new SVF();
  let p1 = 0, p2 = 0;
  for (let k = 0; k < n && i0 + k < buf.length; k++) {
    const t = k / SR;
    const white = rnd() * 2 - 1;
    hp.run(white, 1800, 0.9);
    bp.run(white, 4500, 0.6);
    const noise = (hp.high * 0.7 + bp.band * 0.5) * Math.exp(-t * (rim ? 45 : 22));
    p1 += (2 * Math.PI * tone) / SR;
    p2 += (2 * Math.PI * tone * 1.62) / SR;
    const body = (Math.sin(p1) * 0.7 + Math.sin(p2) * 0.3) * Math.exp(-t * (rim ? 60 : 35));
    buf[i0 + k] += vel * (rim ? noise * 0.6 + body * 0.7 : noise * 0.9 + body * 0.6);
  }
}

function hat(buf, t0, vel, rnd, { open = false, decay } = {}) {
  const i0 = Math.round(t0 * SR);
  const dur = open ? 0.35 : 0.07;
  const n = Math.floor(dur * SR);
  const hp = new SVF();
  const rate = decay ?? (open ? 9 : 75);
  // a few inharmonic square partials give the noise a metallic edge
  const partials = [3140, 4370, 5810, 7230];
  const ph = [0, 0, 0, 0];
  for (let k = 0; k < n && i0 + k < buf.length; k++) {
    const t = k / SR;
    let metal = 0;
    for (let p = 0; p < partials.length; p++) {
      ph[p] = (ph[p] + partials[p] / SR) % 1;
      metal += ph[p] < 0.5 ? 1 : -1;
    }
    const x = (rnd() * 2 - 1) * 0.8 + metal * 0.08;
    hp.run(x, 6800, 0.8);
    buf[i0 + k] += vel * hp.high * Math.exp(-t * rate) * 0.55;
  }
}

/**
 * Generic subtractive synth voice.
 * osc: (phase01, dt) => sample.  env: {a,d,s,r}. filter: {base, env, damp}.
 */
function synthNote(buf, t0, dur, hz, { osc, env, filter, gain = 1, vibrato = null, detune = [0], drive = 0 }) {
  const i0 = Math.round(t0 * SR);
  const total = Math.floor((dur + env.r) * SR);
  const svf = new SVF();
  const phases = detune.map(() => 0);
  const fenvRate = filter.rate ?? 8;
  for (let k = 0; k < total && i0 + k < buf.length; k++) {
    const t = k / SR;
    let f = hz;
    if (vibrato && t > vibrato.delay) {
      const depth = Math.min(1, (t - vibrato.delay) / 0.15) * vibrato.depth; // depth in semitones
      f *= Math.pow(2, (Math.sin(2 * Math.PI * vibrato.rate * t) * depth) / 12);
    }
    let x = 0;
    for (let v = 0; v < detune.length; v++) {
      const fv = f * Math.pow(2, detune[v] / 1200);
      const dt = fv / SR;
      phases[v] = (phases[v] + dt) % 1;
      x += osc(phases[v], dt);
    }
    x /= detune.length;
    const fc = filter.base + filter.env * Math.exp(-t * fenvRate);
    let y = svf.run(x, fc, filter.damp);
    if (drive > 0) y = Math.tanh(y * (1 + drive)) / Math.tanh(1 + drive);
    buf[i0 + k] += gain * y * adsr(t, dur, env.a, env.d, env.s, env.r);
  }
}

/** Electric-piano-ish FM-free voice: sine + harmonics with a fast-decaying bright partial. */
function epNote(buf, t0, dur, hz, gain = 1) {
  const i0 = Math.round(t0 * SR);
  const rel = 0.25;
  const total = Math.floor((dur + rel) * SR);
  let p = 0;
  for (let k = 0; k < total && i0 + k < buf.length; k++) {
    const t = k / SR;
    p += (2 * Math.PI * hz) / SR;
    const bright = Math.exp(-t * 6);
    const x = Math.sin(p) + 0.35 * bright * Math.sin(2 * p) + 0.12 * bright * Math.sin(3 * p) + 0.06 * Math.exp(-t * 25) * Math.sin(7 * p);
    const trem = 1 - 0.12 * (0.5 + 0.5 * Math.sin(2 * Math.PI * 4.2 * t));
    buf[i0 + k] += gain * x * trem * adsr(t, dur, 0.004, 0.6, 0.55, rel) * Math.exp(-t * 0.6);
  }
}

// ---------------------------------------------------------------------------
// song definitions
// ---------------------------------------------------------------------------

// chord = { root: midi (bass register), tones: [semitone offsets for the keys voicing] }
const Am = { name: 'Am7', root: 33, tones: [0, 3, 7, 10] };
const Fmaj = { name: 'Fmaj7', root: 29, tones: [0, 4, 7, 11] };
const Cmaj = { name: 'C', root: 36, tones: [0, 4, 7, 12] };
const Gmaj = { name: 'G', root: 31, tones: [0, 4, 7, 10] };

const Dmaj7 = { name: 'Dmaj7', root: 38, tones: [0, 4, 7, 11] };
const Aadd9 = { name: 'Aadd9', root: 33, tones: [0, 4, 7, 14] };
const Bm7 = { name: 'Bm7', root: 35, tones: [0, 3, 7, 10] };
const Gmaj7 = { name: 'Gmaj7', root: 31, tones: [0, 4, 7, 11] };

/** step-sequenced patterns use 16 steps per bar: [step, lengthSteps, value, velocity?] */
export const SONGS = {
  'demo-groove': {
    id: 'demo-groove',
    title: 'Groove Circuit',
    bpm: 120,
    bars: 48,
    seed: 20240601,
    key: 'A minor',
    progression: [Am, Fmaj, Cmaj, Gmaj],
    style: 'funk',
    mix: { keys: 1.25 },
    description: 'Upbeat 120 BPM funk-rock: driving kick/snare with fills every four bars, syncopated square bass, detuned saw chords and a call/response lead hook.',
    previewStart: 16,
  },
  'demo-sunrise': {
    id: 'demo-sunrise',
    title: 'Sunrise Shuffle',
    bpm: 100,
    bars: 32,
    seed: 7301,
    key: 'D major',
    progression: [Dmaj7, Aadd9, Bm7, Gmaj7],
    style: 'laidback',
    mix: { bass: 0.7, keys: 1.3, lead: 0.9 },
    description: 'Laid-back 100 BPM groove with swung hats, rimshot backbeat, warm round bass, electric-piano chords and a gentle pentatonic lead.',
    previewStart: 19,
  },
};

// ---------------------------------------------------------------------------
// arrangement
// ---------------------------------------------------------------------------

function renderDrums(song, ctx) {
  const { buf, rnd, stepSec, bars, barSec, swing } = ctx;
  const funk = song.style === 'funk';
  const at = (bar, step) => bar * barSec + step * stepSec + (swing && step % 2 === 1 ? stepSec * swing : 0);

  for (let bar = 0; bar < bars; bar++) {
    const fillBar = bar % 4 === 3;
    const lastBar = bar === bars - 1;
    // --- kick
    const kicks = funk
      ? (bar % 2 === 0 ? [[0, 1], [6, 0.85], [8, 0.95], [11, 0.8]] : [[0, 1], [6, 0.85], [8, 0.95], [10, 0.7], [14, 0.6]])
      : (bar % 2 === 0 ? [[0, 1], [10, 0.8]] : [[0, 1], [7, 0.7], [10, 0.8]]);
    for (const [s, v] of kicks) if (!(fillBar && s >= 12)) kick(buf, at(bar, s), v, rnd);
    // --- snare / rimshot
    const snares = funk ? [[4, 1], [12, 1]] : [[8, 0.95]];
    for (const [s, v] of snares) if (!(fillBar && s >= 12)) snare(buf, at(bar, s), v, rnd, funk ? {} : { rim: true, tone: 420 });
    if (funk && bar % 2 === 1) { snare(buf, at(bar, 7), 0.3, rnd); snare(buf, at(bar, 15 - (fillBar ? 8 : 0)), 0.25, rnd); }
    if (!funk && bar % 4 === 1) snare(buf, at(bar, 15), 0.3, rnd, { rim: true, tone: 420 });
    // --- hats
    if (funk) {
      for (let s = 0; s < 16; s += 2) {
        if (fillBar && s >= 12) break;
        const open = s === 14 && bar % 2 === 1;
        hat(buf, at(bar, s), s % 4 === 0 ? 0.9 : 0.6, rnd, { open });
      }
      if (bar % 4 >= 2) { hat(buf, at(bar, 9), 0.35, rnd); hat(buf, at(bar, 13), fillBar ? 0 : 0.35, rnd); }
    } else {
      for (let s = 0; s < 16; s++) {
        if (fillBar && s >= 14) break;
        const isEighth = s % 2 === 0;
        const v = isEighth ? (s % 4 === 0 ? 0.75 : 0.5) : 0.18; // 16th "shaker" ghosts
        hat(buf, at(bar, s), v, rnd, { open: s === 6 && bar % 2 === 1, decay: isEighth ? undefined : 110 });
      }
    }
    // --- fills
    if (fillBar) {
      if (funk) {
        const seq = [[12, 0.7, 'sn'], [13, 0.8, 'sn'], [14, 0.9, 'tomH'], [15, 1.0, 'tomL']];
        if (bar % 8 === 7) { seq.splice(0, 4, [12, 0.6, 'sn'], [12.5, 0.65, 'sn'], [13, 0.75, 'sn'], [13.5, 0.8, 'sn'], [14, 0.9, 'tomH'], [15, 1.0, 'tomL']); }
        for (const [s, v, kind] of seq) {
          const t = at(bar, s);
          if (kind === 'sn') snare(buf, t, v, rnd);
          else tom(buf, t, v, rnd, kind === 'tomH' ? 9 : 4);
        }
      } else {
        for (const [s, v] of [[14, 0.6], [14.5, 0.5], [15, 0.8], [15.5, 0.6]]) snare(buf, at(bar, s), v, rnd, { rim: true, tone: 420 });
        tom(buf, at(bar, 15), 0.6, rnd, 5);
      }
    }
    // crash-ish accent at phrase starts and after fills
    if (bar % 8 === 0 && bar > 0) hat(buf, at(bar, 0), 1.1, rnd, { open: true, decay: 5 });
    if (lastBar) {
      // final hit lands on the downbeat after the last bar (inside the tail)
      kick(buf, bars * barSec, 1, rnd);
      hat(buf, bars * barSec, 1.2, rnd, { open: true, decay: 3.5 });
      if (funk) snare(buf, bars * barSec, 0.9, rnd);
    }
  }
}

function renderBass(song, ctx) {
  const { buf, stepSec, bars, barSec, swing, progression } = ctx;
  const funk = song.style === 'funk';
  const at = (bar, step) => bar * barSec + step * stepSec + (swing && step % 2 === 1 ? stepSec * swing : 0);
  const voice = funk
    ? { osc: (t, dt) => 0.55 * sawOsc(t, dt) + 0.45 * squareOsc(t, dt), env: { a: 0.004, d: 0.12, s: 0.6, r: 0.04 }, filter: { base: 140, env: 1500, damp: 0.7, rate: 12 }, drive: 0.6 }
    : { osc: (t, dt) => 0.7 * squareOsc(t, dt) + 0.3 * sawOsc(t, dt), env: { a: 0.01, d: 0.3, s: 0.75, r: 0.08 }, filter: { base: 110, env: 500, damp: 0.9, rate: 6 }, drive: 0.25 };
  // [step, len, interval]
  const patA = funk
    ? [[0, 2, 0], [3, 1, 0], [6, 2, 12], [8, 1, 0], [10, 1, 7], [11, 1, 10], [14, 2, 12]]
    : [[0, 5, 0], [6, 2, 7], [8, 6, 0], [14, 2, 12]];
  const patB = funk
    ? [[0, 2, 0], [3, 1, 12], [4, 1, 0], [6, 1, 7], [7, 1, 10], [8, 2, 0], [11, 1, 0], [12, 1, 7], [14, 1, 10], [15, 1, 12]]
    : [[0, 6, 0], [6, 2, 7], [8, 4, 0], [12, 2, 12], [14, 2, -2]];
  for (let bar = 0; bar < bars; bar++) {
    const chord = progression[bar % progression.length];
    const next = progression[(bar + 1) % progression.length];
    const pat = bar % 2 === 0 ? patA : patB;
    for (const [s, len, iv] of pat) {
      // "-2" is an approach note leading to the next chord's root
      const midi = iv === -2 ? next.root - 1 : chord.root + iv;
      const dur = len * stepSec * (funk ? 0.85 : 0.95);
      synthNote(buf, at(bar, s), dur, midiToHz(midi), voice);
    }
  }
}

function renderKeys(song, ctx) {
  const { buf, stepSec, bars, barSec, swing, progression } = ctx;
  const funk = song.style === 'funk';
  const at = (bar, step) => bar * barSec + step * stepSec + (swing && step % 2 === 1 ? stepSec * swing : 0);
  for (let bar = 0; bar < bars; bar++) {
    const chord = progression[bar % progression.length];
    const voicingRoot = chord.root + 24; // two octaves above the bass register
    // keep voicings compact around C4: drop tones above ~G4 down an octave
    const tones = chord.tones.map((iv) => { let m = voicingRoot + iv; while (m > 67) m -= 12; return m; });
    if (funk) {
      const hits = bar % 2 === 0 ? [[0, 6], [7, 1.5], [10, 2], [14, 2]] : [[0, 3], [3, 1], [6, 2], [10, 1.5], [12, 4]];
      for (const [s, len] of hits) {
        for (const m of tones) {
          synthNote(buf, at(bar, s), len * stepSec * 0.9, midiToHz(m), {
            osc: sawOsc, env: { a: 0.06, d: 0.2, s: 0.7, r: 0.08 },
            filter: { base: 700, env: 900, damp: 0.9, rate: 6 }, gain: 0.45, detune: [-8, 0, 8],
          });
        }
      }
    } else {
      // electric piano: whole-bar chord, re-struck on the "and of 2" and a top-note lick at the end of odd bars
      const strikes = bar % 2 === 0 ? [[0, 16]] : [[0, 6], [6, 10]];
      for (const [s, len] of strikes) {
        tones.forEach((m, idx) => epNote(buf, at(bar, s) + idx * 0.012, len * stepSec, midiToHz(m), 0.5));
      }
      if (bar % 2 === 1) epNote(buf, at(bar, 14), 2 * stepSec, midiToHz(tones[tones.length - 1] + 12), 0.35);
    }
  }
}

function renderLead(song, ctx) {
  const { buf, stepSec, bars, barSec, swing } = ctx;
  const funk = song.style === 'funk';
  const at = (bar, step) => bar * barSec + step * stepSec + (swing && step % 2 === 1 ? stepSec * swing : 0);
  const voice = funk
    ? { osc: (t, dt) => 0.6 * pulseOsc(t, dt, 0.3) + 0.4 * sawOsc(t, dt), env: { a: 0.01, d: 0.2, s: 0.7, r: 0.08 }, filter: { base: 1400, env: 2200, damp: 0.8, rate: 7 }, vibrato: { rate: 5.5, depth: 0.35, delay: 0.12 }, gain: 0.9 }
    : { osc: (t, dt) => 0.3 * sawOsc(t, dt) + 0.7 * Math.sin(2 * Math.PI * t), env: { a: 0.03, d: 0.3, s: 0.8, r: 0.15 }, filter: { base: 900, env: 1200, damp: 1.0, rate: 4 }, vibrato: { rate: 4.6, depth: 0.25, delay: 0.2 }, gain: 0.9 };
  // phrases are 2 bars = 32 steps: [step, len, midi]
  // A minor pentatonic: A4=69 C5=72 D5=74 E5=76 G5=79 ; D major pentatonic: D5=74 E5=76 F#5=78 A5=81 B5=83
  const phrases = funk
    ? {
      call: [[0, 2, 69], [2, 2, 72], [4, 4, 74], [10, 2, 76], [12, 2, 74], [14, 4, 72], [20, 3, 69], [24, 1, 67], [25, 3, 69]],
      response: [[0, 2, 76], [2, 2, 79], [4, 3, 76], [8, 2, 74], [10, 2, 72], [12, 6, 74], [20, 2, 69], [22, 2, 67], [24, 6, 69]],
      call2: [[0, 1, 72], [1, 1, 74], [2, 4, 76], [8, 2, 79], [10, 2, 76], [12, 4, 74], [18, 2, 72], [20, 2, 74], [22, 6, 69]],
      response2: [[0, 2, 79], [2, 2, 81], [4, 4, 79], [10, 2, 76], [12, 2, 74], [14, 2, 76], [16, 8, 72], [26, 2, 67], [28, 4, 69]],
    }
    : {
      call: [[0, 6, 78], [6, 2, 76], [8, 8, 74], [18, 4, 76], [22, 8, 78]],
      response: [[0, 4, 81], [4, 4, 78], [8, 6, 76], [16, 4, 74], [20, 10, 76]],
      call2: [[0, 2, 74], [2, 2, 76], [4, 8, 78], [14, 2, 81], [16, 12, 83]],
      response2: [[0, 4, 81], [4, 4, 78], [8, 4, 76], [12, 4, 78], [16, 14, 74]],
    };
  const intro = Math.min(4, Math.max(0, bars - 4)); // lead sits out the intro (bars) when the song is long enough
  for (let bar = 0; bar < bars; bar += 2) {
    if (bar < intro) continue;
    const phraseIdx = Math.floor((bar - intro) / 2);
    const section = Math.floor(phraseIdx / 4) % 2; // alternate hook variants every 8 bars
    const isCall = phraseIdx % 2 === 0;
    const notes = section === 0 ? (isCall ? phrases.call : phrases.response) : (isCall ? phrases.call2 : phrases.response2);
    for (const [s, len, midi] of notes) {
      const b = bar + Math.floor(s / 16);
      if (b >= bars) continue;
      synthNote(buf, at(b, s % 16), len * stepSec * (funk ? 0.85 : 0.95), midiToHz(midi), voice);
    }
  }
}

// ---------------------------------------------------------------------------
// mastering + WAV
// ---------------------------------------------------------------------------

function master(buf, targetPeak, drive) {
  let peak = 1e-9;
  for (let i = 0; i < buf.length; i++) peak = Math.max(peak, Math.abs(buf[i]));
  const g = targetPeak / peak;
  const fadeN = Math.floor(0.1 * SR);
  for (let i = 0; i < buf.length; i++) {
    let x = softClip(buf[i] * g * 1.15, drive) * targetPeak;
    if (i > buf.length - fadeN) x *= (buf.length - i) / fadeN;
    buf[i] = x;
  }
}

export function encodeWav16(samples, sampleRate = SR) {
  const n = samples.length;
  const out = Buffer.alloc(44 + n * 2);
  out.write('RIFF', 0);
  out.writeUInt32LE(36 + n * 2, 4);
  out.write('WAVE', 8);
  out.write('fmt ', 12);
  out.writeUInt32LE(16, 16);        // PCM chunk size
  out.writeUInt16LE(1, 20);         // PCM
  out.writeUInt16LE(1, 22);         // mono
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * 2, 28); // byte rate
  out.writeUInt16LE(2, 32);         // block align
  out.writeUInt16LE(16, 34);        // bits per sample
  out.write('data', 36);
  out.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    out.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }
  return out;
}

// ---------------------------------------------------------------------------
// driver
// ---------------------------------------------------------------------------

const STEM_MIX = {
  drums: { label: 'Drums', peak: 0.92, drive: 1.6 },
  bass: { label: 'Bass', peak: 0.7, drive: 1.5 },
  keys: { label: 'Keys', peak: 0.5, drive: 1.2 },
  lead: { label: 'Lead', peak: 0.6, drive: 1.3 },
};
const RENDERERS = { drums: renderDrums, bass: renderBass, keys: renderKeys, lead: renderLead };

export function renderSong(songId, { bars: barsOverride } = {}) {
  const song = SONGS[songId];
  if (!song) throw new Error(`unknown song ${songId}`);
  const bars = barsOverride ?? song.bars;
  const beatSec = 60 / song.bpm;
  const barSec = beatSec * 4;
  const stepSec = beatSec / 4;
  const durationSec = bars * barSec + TAIL_SEC;
  const totalSamples = Math.round(durationSec * SR);
  const swing = song.style === 'laidback' ? 0.55 : 0; // fraction of a 16th the off-16ths are pushed late
  const stems = {};
  for (const stemId of Object.keys(STEM_MIX)) {
    const buf = new Float32Array(totalSamples);
    const rnd = mulberry32(song.seed ^ stemId.length * 7919);
    RENDERERS[stemId](song, { buf, rnd, stepSec, bars, barSec, swing, progression: song.progression });
    master(buf, STEM_MIX[stemId].peak * (song.mix?.[stemId] ?? 1), STEM_MIX[stemId].drive);
    stems[stemId] = buf;
  }
  const manifest = {
    id: song.id,
    title: song.title,
    artist: 'Beat Rehab demo (synthesized)',
    artistUrl: '',
    sourceUrl: 'scripts/gen-demo-stems.mjs',
    license: 'CC0 1.0',
    licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
    attribution: `"${song.title}" is an original demo track synthesized in-repo by scripts/gen-demo-stems.mjs (Beat Rehab). Released under CC0 1.0 — no rights reserved.`,
    description: song.description,
    bpm: song.bpm,
    offset: 0,
    durationSec: Number(durationSec.toFixed(4)),
    previewStart: Math.min(song.previewStart, Math.max(0, durationSec - 8)),
    bars,
    key: song.key,
    stems: Object.keys(STEM_MIX).map((id) => ({ id, file: `stems/${id}.wav`, label: STEM_MIX[id].label })),
    playerStem: 'drums',
    remoteStems: [],
    generated: { script: 'scripts/gen-demo-stems.mjs', seed: song.seed, sampleRate: SR, channels: 1, bitDepth: 16 },
  };
  return { manifest, stems, sampleRate: SR };
}

export function writeSong(outRoot, songId, opts = {}) {
  const { manifest, stems } = renderSong(songId, opts);
  const dir = path.join(outRoot, songId);
  fs.mkdirSync(path.join(dir, 'stems'), { recursive: true });
  const written = [];
  for (const [id, buf] of Object.entries(stems)) {
    const file = path.join(dir, 'stems', `${id}.wav`);
    fs.writeFileSync(file, encodeWav16(buf));
    written.push(file);
  }
  const manifestPath = path.join(dir, 'song.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  written.push(manifestPath);
  return { manifest, written };
}

function parseArgs(argv) {
  const args = { out: 'public/songs', song: 'all', bars: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') args.out = argv[++i];
    else if (a === '--song') args.song = argv[++i];
    else if (a === '--bars') args.bars = Number(argv[++i]);
    else if (a === '--help' || a === '-h') { console.log('usage: gen-demo-stems.mjs [--out dir] [--song id|all] [--bars N]'); process.exit(0); }
    else throw new Error(`unknown argument ${a}`);
  }
  return args;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname;
if (isMain) {
  const args = parseArgs(process.argv.slice(2));
  const ids = args.song === 'all' ? Object.keys(SONGS) : [args.song];
  for (const id of ids) {
    const t0 = Date.now();
    const { manifest, written } = writeSong(args.out, id, { bars: args.bars });
    const bytes = written.reduce((n, f) => n + fs.statSync(f).size, 0);
    console.log(`${id}: ${manifest.bpm} BPM, ${manifest.bars} bars, ${manifest.durationSec}s, ${(bytes / 1e6).toFixed(1)} MB in ${Date.now() - t0} ms`);
    for (const f of written) console.log('  ' + path.relative(process.cwd(), f));
  }
}
