/**
 * Standalone visual test for the highway renderer — no engine, no audio, no React.
 *
 * Integrator: this is one line in main.tsx, before React mounts —
 *
 *   import { mountDemoIfRequested } from './render/demo';
 *   if (!mountDemoIfRequested()) { ...render React as usual... }
 *
 * `mountDemoIfRequested()` returns true (and takes over the page with a full-viewport canvas) when
 * the URL carries `?demo=highway`, and false otherwise, so the guard is the whole integration.
 *
 * (`node src/render/pixel-check.mjs` renders this demo in headless Chromium and saves a screenshot
 * of it as `demo-gameplay.png`, alongside its pixel assertions.)
 *
 * Drives a synthetic 120 BPM chart with scripted hits/misses and animated lane meters, looping forever.
 * Judgment timing mimics the real engine: hits land at note time + deltaMs, misses are declared at
 * note time + goodMs (180) + miss grace (100) = 280 ms, with the miss event's `time` = note time +
 * goodMs exactly as src/engine/judge.ts emits it — so the grey fizzle path is exercised for real.
 * Each loop calls `highway.reset()` like a song restart would.
 */
import type { HitEvent, LaneSpec } from '../engine/types';
import { Highway } from './Highway';
import { makeRng } from './particles';
import { DEFAULT_REARM_FRACTION } from './receptor';
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

/** Engine-equivalent miss timing (easy difficulty: goodMs 180 + DEFAULT_MISS_GRACE_MS 100). */
const DEMO_GOOD_MS = 180;
const DEMO_MISS_GRACE_MS = 100;
/** Trigger threshold the demo's synthetic movement is judged against (a plausible easy setting). */
const DEMO_THRESHOLD = 0.6;
/** URL query that mounts the demo: `?demo=highway`. */
export const DEMO_QUERY = 'highway';

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
  // `lane` is set on purpose: the renderer matches meters to lanes by it, and the demo is the
  // reference for how a frame should be built.
  const laneStates: RenderLaneState[] = lanes.map((l) => ({ lane: l.index, value: 0, armed: true, tracking: true }));
  const judged = new Set<number>();
  /**
   * Events held back by one frame. Every third note is judged the way many integrators actually
   * wire it up — the note's `state` flips on the verdict frame and the `HitEvent` only reaches
   * `recentHits` on the next one — so the demo exercises both feedback paths for real.
   */
  const deferred: HitEvent[] = [];
  let combo = 0;
  let score = 0;
  let health = 0.6;
  const beat = 60 / bpm;

  const resetLoop = (): void => {
    judged.clear();
    recent.length = 0;
    deferred.length = 0;
    for (const n of chart) n.state = 'pending';
    for (const ls of laneStates) ls.armed = true;
    combo = 0;
    score = 0;
    health = 0.6;
    highway.reset();
  };

  const buildFrame = (songTime: number): RenderFrame => {
    // Events whose note state flipped on the previous frame arrive now.
    while (deferred.length) recent.push(deferred.shift() as HitEvent);
    // Judge notes whose scripted time has passed.
    for (const n of chart) {
      if (judged.has(n.id)) continue;
      const miss = n.outcome === 'miss';
      const judgeAt = miss ? n.time + (DEMO_GOOD_MS + DEMO_MISS_GRACE_MS) / 1000 : n.time + n.deltaMs / 1000;
      if (songTime >= judgeAt) {
        judged.add(n.id);
        n.state = miss ? 'miss' : 'hit';
        n.judgment = n.outcome;
        const ev: HitEvent = {
          noteId: n.id,
          lane: n.lane,
          judgment: n.outcome,
          deltaMs: miss ? DEMO_GOOD_MS : n.deltaMs,
          time: miss ? n.time + DEMO_GOOD_MS / 1000 : judgeAt,
        };
        if (n.id % 3 === 0) deferred.push(ev);
        else recent.push(ev);
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
      if (n.time < songTime - 1) continue;
      visible.push(n);
    }

    // Lane meters: a bump that rises toward each upcoming note and falls after; noise while idle.
    for (let l = 0; l < laneCount; l++) {
      let v = 0.08 + 0.04 * Math.sin(songTime * 2.1 + l);
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
        }
      }
      // Every 12 s, lane 0's "patient" reaches end range and *holds it there* for ~2 s — the single
      // most common thing a real patient does, and the case the receptor has to be honest about:
      // the lane fires once on the way up and then cannot fire again until the value comes back
      // down past the re-arm line, so the receptor must stop reading "ready" for the whole hold.
      if (l === 0) {
        const h = songTime % 12;
        if (h > 6 && h < 9.2) {
          const up = Math.min(1, (h - 6) / 0.45);
          const down = h > 8.6 ? Math.max(0, 1 - (h - 8.6) / 0.6) : 1;
          v = Math.max(v, 0.1 + 0.88 * up * down);
        }
      }
      const value = Math.min(1, v);
      // Hysteresis exactly as the vision trigger detector does it (docs/ARCHITECTURE.md): fire on
      // the rising edge above threshold, re-arm only below threshold * rearmFraction.
      if (laneStates[l].armed && value >= DEMO_THRESHOLD) laneStates[l].armed = false;
      else if (!laneStates[l].armed && value < DEMO_THRESHOLD * DEFAULT_REARM_FRACTION) laneStates[l].armed = true;
      laneStates[l].value = value;
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
      thresholdFraction: DEMO_THRESHOLD,
      rearmFraction: DEFAULT_REARM_FRACTION,
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
    // Coalesce resize storms (a window drag fires dozens of events a second) into one resize per
    // animation frame; Highway.resize() itself is a no-op when nothing actually changed.
    let pending = 0;
    const onResize = (): void => {
      if (pending) return;
      pending = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(() => { pending = 0; highway.resize(); }) : (setTimeout(() => { pending = 0; highway.resize(); }, 80) as unknown as number);
    };
    window.addEventListener('resize', onResize);
    removeResize = () => {
      window.removeEventListener('resize', onResize);
      if (pending && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(pending);
    };
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

/**
 * Mount the demo when the page URL asks for it (`?demo=highway`). Returns true when it took over
 * the page, so `main.tsx` needs exactly one guard:
 *
 *   if (!mountDemoIfRequested()) { ...render React... }
 *
 * A full-viewport canvas is appended to `document.body` (or `parent`, if given) and `runDemo`
 * drives it. Safe to call in a non-browser environment: it returns false.
 */
export function mountDemoIfRequested(parent?: HTMLElement, options: DemoOptions = {}): boolean {
  if (typeof document === 'undefined' || typeof location === 'undefined') return false;
  let requested = false;
  try {
    requested = new URLSearchParams(location.search).get('demo') === DEMO_QUERY;
  } catch {
    requested = false;
  }
  if (!requested) return false;
  const host = parent ?? document.body;
  const canvas = document.createElement('canvas');
  Object.assign(canvas.style, { position: 'fixed', inset: '0', width: '100vw', height: '100vh', display: 'block' });
  document.documentElement.style.background = '#05060c';
  host.appendChild(canvas);
  runDemo(canvas, options);
  return true;
}
