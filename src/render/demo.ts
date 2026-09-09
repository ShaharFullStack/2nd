/**
 * Standalone visual test for the highway renderer — no engine, no audio, no React.
 *
 * Integrator: mount at route `?demo=highway`, e.g. in main.tsx before rendering React:
 *
 *   if (new URLSearchParams(location.search).get('demo') === 'highway') {
 *     const canvas = document.createElement('canvas');
 *     Object.assign(canvas.style, { position: 'fixed', inset: '0', width: '100vw', height: '100vh' });
 *     document.body.appendChild(canvas);
 *     import('./render/demo').then((m) => m.runDemo(canvas));
 *   } else { ...render React... }
 *
 * Drives a synthetic 120 BPM chart with scripted hits/misses and animated lane meters, looping forever.
 */
import type { HitEvent, LaneSpec } from '../engine/types';
import { Highway } from './Highway';
import { makeRng } from './particles';
import type { CanvasLike, HighwayOptions, RenderFrame, RenderLaneState, RenderNote } from './types';

export interface DemoOptions extends Partial<HighwayOptions> {
  bpm?: number;
  laneCount?: 2 | 3 | 4;
  /** Seconds of chart to generate before looping. */
  durationSec?: number;
  /** Probability per note of miss / good (rest are perfects). */
  missRate?: number;
  goodRate?: number;
  seed?: number;
  /** Provide your own clock (seconds) — defaults to performance.now(). */
  now?: () => number;
  /** Provide your own scheduler — defaults to requestAnimationFrame. Returns a cancel function. */
  schedule?: (cb: () => void) => () => void;
}

export interface DemoHandle {
  stop(): void;
  readonly highway: Highway;
  /** Advance and draw one frame at an explicit song time (for tests / screenshots). */
  step(songTime: number): RenderFrame;
}

interface DemoNote extends RenderNote {
  /** Scripted outcome. */
  outcome: 'perfect' | 'good' | 'miss';
  /** Timing error in ms for the scripted outcome. */
  deltaMs: number;
}

const DEMO_LANES: LaneSpec[] = [
  { index: 0, movement: 'seated_march', side: 'left' },
  { index: 1, movement: 'seated_march', side: 'right' },
  { index: 2, movement: 'knee_extension', side: 'left' },
  { index: 3, movement: 'knee_extension', side: 'right' },
];

/** Build the synthetic chart: mostly one note per beat cycling lanes, with occasional doubles and 8ths. */
export function buildDemoChart(bpm: number, durationSec: number, laneCount: number, seed: number, missRate: number, goodRate: number): DemoNote[] {
  const rng = makeRng(seed);
  const beat = 60 / bpm;
  const notes: DemoNote[] = [];
  let id = 1;
  const pick = (): DemoNote['outcome'] => {
    const r = rng();
    if (r < missRate) return 'miss';
    if (r < missRate + goodRate) return 'good';
    return 'perfect';
  };
  const mk = (time: number, lane: number): void => {
    const outcome = pick();
    const deltaMs = outcome === 'perfect' ? (rng() - 0.5) * 60 : outcome === 'good' ? (rng() < 0.5 ? -1 : 1) * (60 + rng() * 70) : 0;
    notes.push({ id: id++, lane, time, state: 'pending', outcome, deltaMs });
  };
  let lane = 0;
  for (let t = 2; t < durationSec; t += beat) {
    const bar = Math.floor((t - 2) / (beat * 4)) % 8;
    const beatInBar = Math.round(((t - 2) / beat) % 4);
    if (bar >= 6 && beatInBar % 2 === 1) {
      // Denser section: 8th notes.
      mk(t, lane % laneCount);
      mk(t + beat / 2, (lane + 1) % laneCount);
      lane += 2;
    } else if (bar >= 3 && beatInBar === 0 && laneCount >= 2) {
      // Chord on the downbeat.
      mk(t, lane % laneCount);
      mk(t, (lane + 2) % laneCount);
      lane += 1;
    } else {
      mk(t, lane % laneCount);
      lane += rng() < 0.7 ? 1 : 2;
    }
  }
  notes.sort((a, b) => a.time - b.time);
  return notes;
}

export function runDemo(canvas: CanvasLike, options: DemoOptions = {}): DemoHandle {
  const bpm = options.bpm ?? 120;
  const laneCount = options.laneCount ?? 4;
  const durationSec = options.durationSec ?? 64;
  const lanes = DEMO_LANES.slice(0, laneCount);
  const chart = buildDemoChart(bpm, durationSec, laneCount, options.seed ?? 42, options.missRate ?? 0.1, options.goodRate ?? 0.22);
  const highway = new Highway(canvas, { showStats: true, ...options });

  const clock = options.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000);
  const schedule =
    options.schedule ??
    ((cb: () => void) => {
      if (typeof requestAnimationFrame === 'function') {
        const id = requestAnimationFrame(cb);
        return () => cancelAnimationFrame(id);
      }
      const id = setTimeout(cb, 16);
      return () => clearTimeout(id);
    });

  const start = clock();
  let loopBase = 0;
  const windowSec = highway.geometry.approachSec + 0.6;
  const visible: DemoNote[] = [];
  const recent: HitEvent[] = [];
  const laneStates: RenderLaneState[] = lanes.map(() => ({ value: 0, armed: true, tracking: true }));
  const judged = new Set<number>();
  let combo = 0;
  let score = 0;
  let health = 0.6;
  const beat = 60 / bpm;

  const resetLoop = (): void => {
    judged.clear();
    recent.length = 0;
    for (const n of chart) n.state = 'pending';
  };

  const buildFrame = (songTime: number): RenderFrame => {
    // Judge notes whose scripted time has passed.
    for (const n of chart) {
      if (judged.has(n.id)) continue;
      const judgeAt = n.time + n.deltaMs / 1000 + (n.outcome === 'miss' ? 0.16 : 0);
      if (songTime >= judgeAt) {
        judged.add(n.id);
        n.state = n.outcome === 'miss' ? 'miss' : 'hit';
        n.judgment = n.outcome;
        recent.push({ noteId: n.id, lane: n.lane, judgment: n.outcome, deltaMs: n.deltaMs, time: judgeAt });
        if (n.outcome === 'miss') {
          combo = 0;
          health = Math.max(0, health - 0.08);
        } else {
          combo++;
          const mult = Math.min(4, 1 + Math.floor(combo / 10));
          score += (n.outcome === 'perfect' ? 100 : 50) * mult;
          health = Math.min(1, health + 0.03);
        }
      }
    }
    while (recent.length && songTime - recent[0].time > 1) recent.shift();

    visible.length = 0;
    for (const n of chart) {
      if (n.time > songTime + windowSec) break;
      if (n.time < songTime - 0.6) continue;
      visible.push(n);
    }

    // Lane meters: a bump that rises toward each upcoming note and falls after; noise while idle.
    for (let l = 0; l < laneCount; l++) {
      let v = 0.08 + 0.04 * Math.sin(songTime * 2.1 + l);
      let armed = true;
      for (const n of visible) {
        if (n.lane !== l) continue;
        const hitAt = n.time + n.deltaMs / 1000;
        const dtn = songTime - hitAt;
        if (n.outcome === 'miss') {
          // Weak attempt that never crosses threshold.
          if (dtn > -0.5 && dtn < 0.4) v = Math.max(v, 0.35 * Math.sin(((dtn + 0.5) / 0.9) * Math.PI));
        } else if (dtn > -0.45 && dtn < 0.5) {
          const shape = dtn < 0 ? 1 + dtn / 0.45 : 1 - dtn / 0.5;
          v = Math.max(v, 0.95 * shape * shape + (dtn >= 0 && dtn < 0.1 ? 0.15 : 0));
          if (dtn >= 0 && dtn < 0.35) armed = false;
        }
      }
      laneStates[l].value = Math.min(1, v);
      laneStates[l].armed = armed;
      laneStates[l].tracking = !(l === laneCount - 1 && songTime % 40 > 34 && songTime % 40 < 38);
    }

    const mult = Math.min(4, 1 + Math.floor(combo / 10));
    return {
      songTime,
      notes: visible,
      lanes,
      laneStates,
      combo,
      multiplier: mult,
      score,
      health,
      recentHits: recent,
      bpm,
      beatPhase: ((songTime / beat) % 1 + 1) % 1,
      songTitle: 'Highway Demo (synthetic)',
      attribution: '120 BPM scripted chart — render module self-test',
      energy: 0.35 + 0.35 * Math.pow(1 - (((songTime / beat) % 1) + 1) % 1, 2),
      thresholdFraction: 0.6,
    };
  };

  const step = (songTime: number): RenderFrame => {
    const f = buildFrame(songTime);
    highway.draw(f);
    return f;
  };

  let cancelFrame: (() => void) | null = null;
  let running = true;
  const tick = (): void => {
    if (!running) return;
    const elapsed = clock() - start;
    let songTime = elapsed - loopBase;
    if (songTime > durationSec) {
      loopBase += durationSec;
      songTime -= durationSec;
      resetLoop();
    }
    step(songTime);
    cancelFrame = schedule(tick);
  };
  let removeResize: (() => void) | null = null;
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    const onResize = (): void => highway.resize();
    window.addEventListener('resize', onResize);
    removeResize = () => window.removeEventListener('resize', onResize);
  }
  tick();
  return {
    highway,
    step,
    stop: () => {
      running = false;
      if (cancelFrame) cancelFrame();
      if (removeResize) removeResize();
    },
  };
}
