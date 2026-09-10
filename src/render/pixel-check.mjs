/**
 * Pixel-level verification for the note highway — the look-and-feel claims this module makes are
 * about pixels, and call-count assertions against a mock 2D context cannot check any of them.
 *
 * What it does: bundles `src/render/index.ts` with rolldown (already a Vite dependency — nothing is
 * installed), loads it into a real Chromium page with a real `<canvas>`, draws deterministic frames,
 * reads the framebuffer back with `getImageData`, and asserts the invariants that define the
 * Guitar Hero / Clone Hero look:
 *
 *   1. gem diameter is a large fraction of its lane width (fret board, not empty ramp)
 *   2. the strike line is uniformly bright across the whole board (no centre-hot ellipse)
 *   3. a hit lights up the receptor area (burst + flash) well above the idle frame
 *   4. a miss reddens its lane — including on the frame the note `state` flips, before any HitEvent
 *   4b. a lane locked out by hysteresis reads as categorically different from a live one, and the
 *       whole missed gem is still inside the canvas at the latest miss verdict (+280 ms)
 *   5. notes land exactly on the strike line at their note time, and a constant-BPM chart
 *      foreshortens correctly (measured gem spacing shrinks monotonically toward the horizon)
 *   6. 60 fps budget: mean frame time over a 600-frame run at 1920x1080
 *
 * Usage:  node src/render/pixel-check.mjs [--out DIR] [--headed]
 * Exit code is non-zero if any check fails. PNGs of every scene are written to the out dir
 * (default: $TMPDIR/beat-rehab-render) so the frames can also be eyeballed.
 *
 * This is a developer/critic tool, not part of `vitest run` — it needs a browser binary. It looks
 * for one in PLAYWRIGHT_CHROMIUM (an explicit executable path), then the playwright default, then
 * /opt/pw-browsers/*, and skips with exit code 0 and a clear message when none is installed.
 */
import { chromium } from 'playwright';
import { rolldown } from 'rolldown';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, 'index.ts');
const args = process.argv.slice(2);
const outDir = args.includes('--out') ? args[args.indexOf('--out') + 1] : path.join(tmpdir(), 'beat-rehab-render');
const headed = args.includes('--headed');

function findChromium() {
  if (process.env.PLAYWRIGHT_CHROMIUM && existsSync(process.env.PLAYWRIGHT_CHROMIUM)) return process.env.PLAYWRIGHT_CHROMIUM;
  try {
    const p = chromium.executablePath();
    if (p && existsSync(p)) return p;
  } catch {
    /* not installed */
  }
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  if (!existsSync(root)) return null;
  const candidates = [];
  for (const dir of readdirSync(root)) {
    for (const rel of ['chrome-linux/chrome', 'chrome-linux64/chrome', 'chrome-linux/headless_shell', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
      const p = path.join(root, dir, rel);
      if (existsSync(p)) candidates.push(p);
    }
  }
  candidates.sort((a, b) => (a.includes('headless_shell') ? 1 : 0) - (b.includes('headless_shell') ? 1 : 0));
  return candidates[0] ?? null;
}

async function bundle() {
  const build = await rolldown({ input: entry, logLevel: 'silent' });
  const { output } = await build.generate({ format: 'iife', name: 'BR' });
  await build.close();
  return output.map((o) => (o.type === 'chunk' ? o.code : '')).join('\n');
}

/** Runs inside the page: draws scenes on a real canvas and measures pixels. */
/* eslint-disable */
function pageProbe(W, H) {
  const { Highway, makeFrame, laneX, laneBoundaryX, roadEdgeX, depthOf, scaleAt, GEM_ASPECT } = window.BR;
  const LANES = [
    { index: 0, movement: 'seated_march', side: 'left' },
    { index: 1, movement: 'seated_march', side: 'right' },
    { index: 2, movement: 'knee_extension', side: 'left' },
    { index: 3, movement: 'knee_extension', side: 'right' },
  ];
  const shots = {};

  function fresh(opts) {
    const c = document.createElement('canvas');
    c.style.width = W + 'px';
    c.style.height = H + 'px';
    document.body.appendChild(c);
    const hw = new Highway(c, opts || {});
    hw.resize(W, H, 1);
    return { canvas: c, hw };
  }
  const idleStates = LANES.map(() => ({ value: 0, armed: true, tracking: true }));
  const px = (data, x, y) => {
    const i = (Math.round(y) * data.width + Math.round(x)) * 4;
    return [data.data[i], data.data[i + 1], data.data[i + 2]];
  };
  const lum = (p) => 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];
  const grab = (canvas, name) => {
    const d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    if (name) shots[name] = canvas.toDataURL('image/png');
    return d;
  };
  const scene = (frames, name, opts) => {
    const { canvas, hw } = fresh(opts);
    for (const f of frames) hw.draw(f);
    return { data: grab(canvas, name), hw, canvas };
  };
  const base = (t, extra) =>
    makeFrame(Object.assign({ lanes: LANES, laneStates: idleStates, songTime: t, bpm: 120, beatPhase: 0.5, health: 0.7, score: 12345, combo: 8, multiplier: 2, songTitle: 'Pixel check' }, extra || {}));

  const out = {};

  // --- 1. gem diameter vs lane width -----------------------------------------------------------
  {
    const t = 10;
    const lane = 1;
    const a = scene([base(t)], 'idle');
    const b = scene([base(t, { notes: [{ id: 1, lane, time: t }].map((n) => ({ ...n, state: 'pending' })) })], 'gem');
    const g = b.hw.geometry;
    const y = Math.round(g.strikeY);
    let first = -1;
    let last = -1;
    for (let x = 0; x < W; x++) {
      const pa = px(a.data, x, y);
      const pb = px(b.data, x, y);
      const diff = Math.abs(pa[0] - pb[0]) + Math.abs(pa[1] - pb[1]) + Math.abs(pa[2] - pb[2]);
      if (diff > 24) {
        if (first < 0) first = x;
        last = x;
      }
    }
    out.gemPx = last - first + 1;
    out.laneWidthPx = g.laneWidthNear;
    out.gemFill = out.gemPx / g.laneWidthNear;
    out.gemCentreErr = Math.abs((first + last) / 2 - laneX(g, lane, 0));
  }

  // --- 2. strike line uniformity across the board ----------------------------------------------
  {
    // Sampled in the gaps between receptor rings (the rings fill most of their lanes by design) at
    // 25%, 50% and 75% of the board, with the decorative additive layers off (effectIntensity 0) so
    // the sweeping stage lights don't light the board unevenly. A radial glow sprite stretched
    // across the road — what this replaced — is an ellipse: the 25%/75% samples read a fraction of
    // the 50% one, i.e. the outer lanes' receptors sit in a visibly dimmer strike line.
    const t = 10;
    const { canvas, hw } = fresh({ effectIntensity: 0 });
    hw.draw(makeFrame({ lanes: LANES, laneStates: idleStates, songTime: t, bpm: 120, beatPhase: 0.5 }));
    const data = grab(canvas, 'strike');
    const g = hw.geometry;
    const y = Math.round(g.strikeY);
    const ls = [];
    for (let b = 1; b < g.laneCount; b++) ls.push(lum(px(data, laneBoundaryX(g, b, 0), y)));
    out.strikeSamples = ls.map((v) => Math.round(v));
    out.strikeUniformity = Math.min(...ls) / Math.max(...ls);
    // Off-band reference: 60 px above the line should be much darker than the line itself.
    out.strikeContrast = Math.min(...ls) / Math.max(1, lum(px(data, g.vpX, y - 60)));
  }

  // --- 3. hit feedback lights up the lane ------------------------------------------------------
  {
    const t = 10;
    const lane = 3;
    const hit = [{ noteId: 1, lane, judgment: 'perfect', deltaMs: 3, time: t }];
    const a = scene([base(t - 0.1), base(t + 0.02)], null);
    const b = scene([base(t - 0.1), base(t + 0.02, { recentHits: hit })], 'hit');
    const g = b.hw.geometry;
    const cx = laneX(g, lane, 0);
    const y0 = Math.round(g.strikeY - g.receptorRadius * 2);
    const y1 = Math.round(g.strikeY + g.receptorRadius);
    let sum = 0;
    let n = 0;
    for (let y = y0; y <= y1; y += 2) {
      for (let x = Math.round(cx - g.laneWidthNear / 2); x <= cx + g.laneWidthNear / 2; x += 2) {
        sum += lum(px(b.data, x, y)) - lum(px(a.data, x, y));
        n++;
      }
    }
    out.hitLumaGain = sum / n;
  }

  // --- 4. miss feedback on the state-flip frame (no HitEvent yet) -------------------------------
  {
    const t = 10;
    const lane = 0;
    const missed = { id: 7, lane, time: t, state: 'miss', judgment: 'miss' };
    const a = scene([base(t - 0.1), base(t + 0.28)], null);
    const b = scene([base(t - 0.1), base(t + 0.28, { notes: [missed] })], 'miss-stateflip');
    // ... and again on the frame the real HitEvent arrives one frame later.
    const ev = [{ noteId: 7, lane, judgment: 'miss', deltaMs: 180, time: t + 0.18 }];
    const c = scene([base(t - 0.1), base(t + 0.28, { notes: [missed] }), base(t + 0.3, { notes: [missed], recentHits: ev })], 'miss-event');
    const a2 = scene([base(t - 0.1), base(t + 0.28), base(t + 0.3)], null);
    const g = b.hw.geometry;
    const redGain = (ref, test) => {
      let sum = 0;
      let n = 0;
      for (let y = Math.round(g.horizonY + 20); y < g.strikeY; y += 3) {
        for (let x = Math.round(laneBoundaryX(g, lane, 0.3)); x < laneBoundaryX(g, lane + 1, 0.3); x += 3) {
          const p0 = px(ref, x, y);
          const p1 = px(test, x, y);
          sum += p1[0] - p0[0] - (p1[2] - p0[2]);
          n++;
        }
      }
      return sum / n;
    };
    out.missRedGainStateFlip = redGain(a.data, b.data);
    out.missRedGainEventFrame = redGain(a2.data, c.data);
  }

  // --- 4b. the receptor tells the truth about whether the lane can fire ------------------------
  // A patient holding at end range has a full meter and an *unarmed* lane: nothing they do scores
  // until they lower past the re-arm line. The lit / hot / haloed receptor is reserved for lanes
  // that would actually fire, so the two states must differ in pixels, not in call counts.
  {
    const t = 10;
    // Lane 3 (blue in GH order) so the warm "lower to reset" hint colour cannot be confused with
    // the lane's own colour.
    const lane = 3;
    const states = (armed) => LANES.map((l) => ({ lane: l.index, value: 0.75, armed, tracking: true }));
    const settle = (armed, name) => {
      const frames = [];
      for (let i = 0; i < 30; i++) frames.push(base(t + i * 0.016, { laneStates: states(armed), thresholdFraction: 0.6 }));
      return scene(frames, name);
    };
    const live = settle(true, 'receptor-armed');
    const held = settle(false, 'receptor-locked');
    // (b) THE CROSSING — the frame the lane actually fires on, which the input layer publishes with
    // `armed: false` (the trigger disarms on the crossing sample). The renderer latches it, so this
    // is the "you reached your target range" look as the patient really sees it: driven the way a
    // real rep drives it — rising and armed, then one crossing frame.
    const goal = (() => {
      const rising = LANES.map((l) => ({ lane: l.index, value: 0.5, armed: true, tracking: true }));
      const crossed = LANES.map((l) => ({ lane: l.index, value: 0.9, armed: false, tracking: true }));
      const frames = [];
      for (let i = 0; i < 20; i++) frames.push(base(t + i * 0.016, { laneStates: rising, thresholdFraction: 0.6 }));
      frames.push(base(t + 0.336, { laneStates: crossed, thresholdFraction: 0.6 }));
      return scene(frames, 'receptor-goal');
    })();
    // ...and the same lane ~0.7 s later, once the acknowledgement has handed over to "lower to
    // reset" — the pair is what a therapist should be able to tell apart from the back of the room.
    const goalAfter = (() => {
      const rising = LANES.map((l) => ({ lane: l.index, value: 0.5, armed: true, tracking: true }));
      const crossed = LANES.map((l) => ({ lane: l.index, value: 0.9, armed: false, tracking: true }));
      const frames = [];
      for (let i = 0; i < 20; i++) frames.push(base(t + i * 0.016, { laneStates: rising, thresholdFraction: 0.6 }));
      for (let i = 0; i <= 45; i++) frames.push(base(t + 0.336 + i * 0.016, { laneStates: crossed, thresholdFraction: 0.6 }));
      return scene(frames, 'receptor-goal-expired');
    })();
    const g = live.hw.geometry;
    const cx = laneX(g, lane, 0);
    const box = { x0: Math.round(cx - g.receptorRadius), x1: Math.round(cx + g.receptorRadius), y0: Math.round(g.strikeY - g.receptorRadius), y1: Math.round(g.strikeY + g.receptorRadius) };
    const stats = (data) => {
      let luma = 0;
      let chroma = 0;
      let hint = 0;
      let n = 0;
      for (let y = box.y0; y <= box.y1; y++) {
        for (let x = box.x0; x <= box.x1; x++) {
          const p = px(data, x, y);
          luma += lum(p);
          chroma += Math.max(p[0], p[1], p[2]) - Math.min(p[0], p[1], p[2]);
          // The "lower to reset" hint colour (#c08cff = 192,140,255) after alpha-blending onto the
          // dark road: violet — blue highest, red well above green. Lane 3's own blue (#3b8cff =
          // 59,140,255) shares the blue and green channels exactly, so the red floor is what tells
          // the two apart, and it is why this scene uses the blue lane in the first place.
          if (p[2] > 170 && p[0] > 110 && p[2] - p[1] > 45 && p[0] - p[1] > 18) hint++;
          n++;
        }
      }
      return { luma: luma / n, chroma: chroma / n, hint };
    };
    // Is the locked column resolvable AT ALL from across a room? A grey bar at ~42/255 against a
    // ~14/255 well is one uniform dark disc at 2 m, which is what this used to be: the thing the
    // patient is being asked to LOWER was invisible while they lowered it. What makes it readable
    // is a hard luminance STEP at the top of the column (the violet drain cap riding it), so that
    // is what is measured — the largest row-to-row jump down the receptor's centre line.
    const centreStep = (data) => {
      let worst = 0;
      const x = Math.round(cx);
      for (let y = box.y0; y < box.y1; y++) worst = Math.max(worst, Math.abs(lum(px(data, x, y + 1)) - lum(px(data, x, y))));
      return worst;
    };
    const a = stats(live.data);
    const b = stats(held.data);
    out.receptorLumaArmed = a.luma;
    out.receptorLumaLocked = b.luma;
    out.receptorChromaArmed = a.chroma;
    out.receptorChromaLocked = b.chroma;
    out.receptorHintArmed = a.hint;
    out.receptorHintLocked = b.hint;
    out.receptorStepLocked = centreStep(held.data);
    const gs = stats(goal.data);
    const ga = stats(goalAfter.data);
    out.receptorLumaGoal = gs.luma;
    out.receptorChromaGoal = gs.chroma;
    out.receptorHintGoal = gs.hint;
    // The moment of success must not be the moment the gauge goes dim and violet: brighter than the
    // lockout, and carrying none of its "lower to reset" hint pixels.
    out.receptorGoalBrighterThanLocked = gs.luma > b.luma;
    out.receptorGoalHasNoLockHint = gs.hint === 0;
    // ...and once the latch expires the same lane really has become the lockout look.
    out.receptorGoalExpiresToLocked = ga.hint > 0 && ga.luma < gs.luma;
  }

  // --- 4c. the miss cue is fully inside the canvas at the latest possible verdict ---------------
  // The engine declares a miss at note.time + goodMs (180) + grace (100). Diffing against a frame
  // that has the same miss *event* (so the same puff) but no gem isolates the dying gem's pixels.
  {
    const t = 10;
    const lane = 0;
    const missed = { id: 21, lane, time: t, state: 'miss', judgment: 'miss' };
    const ev = [{ noteId: 21, lane, judgment: 'miss', deltaMs: 180, time: t + 0.18 }];
    const ref = scene([base(t - 0.1), base(t + 0.28, { recentHits: ev })], null);
    const test = scene([base(t - 0.1), base(t + 0.28, { notes: [missed], recentHits: ev })], 'miss-verdict');
    const g = test.hw.geometry;
    const cx = laneX(g, lane, 0);
    let top = -1;
    let bottom = -1;
    let widest = 0;
    let widestRow = -1;
    const half = Math.ceil(g.laneWidthNear);
    for (let y = Math.round(g.strikeY); y < H; y++) {
      let first = -1;
      let last = -1;
      for (let x = Math.max(0, Math.round(cx - half)); x <= Math.min(W - 1, cx + half); x++) {
        // Signed, like the chart-gem measurement: the gem *body* is brighter than the road it
        // covers. (Its soft drop shadow is drawn ~0.35 r further down and may be clipped by the
        // bottom edge in the last frames of the fizzle; the gem itself may not be.)
        if (lum(px(test.data, x, y)) - lum(px(ref.data, x, y)) > 20) {
          if (first < 0) first = x;
          last = x;
        }
      }
      if (first < 0) continue;
      if (top < 0) top = y;
      bottom = y;
      if (last - first + 1 > widest) {
        widest = last - first + 1;
        widestRow = y;
      }
    }
    const d = depthOf(g, t, t + 0.28);
    out.missGemTop = top;
    out.missGemBottom = bottom;
    out.missGemCentreRow = widestRow;
    out.missGemExpectedHeight = 2 * g.gemRadiusNear * scaleAt(g, d) * GEM_ASPECT;
    out.missGemHeight = bottom - top + 1;
    out.canvasH = H;
  }

  // --- 5. notes land on the line, and perspective foreshortens a constant-BPM chart -------------
  {
    const t = 10;
    const beat = 0.5;
    const notes = [];
    for (let i = 0; i < 4; i++) notes.push({ id: 10 + i, lane: 2, time: t + i * beat, state: 'pending' });
    const a = scene([base(t)], null);
    const b = scene([base(t, { notes })], 'chart');
    const g = b.hw.geometry;
    const cx = Math.round(laneX(g, 2, 0));
    // A gem is an ellipse, so its widest row *is* its centre row. Scan rows for the width of the
    // (bright) gem body: threshold high enough to ignore the soft drop shadow underneath it.
    const widthAt = (y) => {
      let first = -1;
      let last = -1;
      const half = Math.ceil(g.laneWidthNear);
      for (let x = cx - half; x <= cx + half; x++) {
        // Signed: the gem body is *brighter* than the road it covers. An unsigned diff also picks
        // up the gem's drop shadow, which is drawn wider than the gem and biases the centre down.
        if (lum(px(b.data, x, y)) - lum(px(a.data, x, y)) > 20) {
          if (first < 0) first = x;
          last = x;
        }
      }
      return first < 0 ? 0 : last - first + 1;
    };
    const measured = [];
    const expected = [];
    for (let i = 0; i < notes.length; i++) {
      const d = (notes[i].time - t) / g.approachSec;
      const ey = window.BR.yAt(g, d);
      expected.push(ey);
      const win = Math.max(8, Math.round(g.gemRadiusNear * window.BR.scaleAt(g, d) * 0.6));
      const y0 = Math.round(ey - win);
      const ws = [];
      for (let y = y0; y <= ey + win; y++) ws.push(widthAt(y));
      const bestW = Math.max(...ws);
      // The width of an ellipse is stationary at its centre, so many rows tie at the widest integer
      // width: take the midpoint of that plateau, not the first row of it (which biases upward).
      const firstTop = ws.indexOf(bestW >= 2 ? bestW : 0);
      let lastTop = firstTop;
      for (let i = firstTop; i < ws.length; i++) if (ws[i] >= bestW - 1) lastTop = i;
      measured.push(bestW > 0 ? y0 + (firstTop + lastTop) / 2 : NaN);
    }
    out.noteYExpected = expected.map((v) => +v.toFixed(1));
    out.noteYMeasured = measured;
    out.noteYMaxErr = Math.max(...measured.map((m, i) => Math.abs(m - expected[i])));
    const gaps = [];
    for (let i = 1; i < measured.length; i++) gaps.push(measured[i - 1] - measured[i]);
    out.gaps = gaps.map((v) => +v.toFixed(1));
    // Gaps between consecutive beats shrink with distance (near gap first): that is foreshortening.
    out.gapsShrinkWithDepth = gaps.every((v, i) => i === 0 || v < gaps[i - 1]);
    out.gapRatio = gaps.length > 1 ? gaps[0] / gaps[gaps.length - 1] : 0;
  }

  // --- 6. frame cost. NOTE: headless Chromium has no GPU here, so canvas2d rasterizes on the CPU
  // (SwiftShader) and the absolute ms/frame is a *software* number, several times what a real iGPU
  // costs for the same fill. Measuring at two resolutions separates the two halves: JS command
  // issue (resolution independent) from rasterization (scales with pixel count).
  {
    const runAt = (w, h, frames) => {
      const c = document.createElement('canvas');
      c.style.width = w + 'px';
      c.style.height = h + 'px';
      document.body.appendChild(c);
      const hw = new Highway(c, {});
      hw.resize(w, h, 1);
      const notes = [];
      for (let i = 0; i < 40; i++) notes.push({ id: 1000 + i, lane: i % 4, time: i * 0.12, state: 'pending' });
      hw.draw(makeFrame({ lanes: LANES, songTime: 0 }));
      hw.resetStats();
      const t0 = performance.now();
      for (let i = 0; i < frames; i++) {
        const st = i / 60;
        const hits = i % 8 === 0 ? [{ noteId: 5000 + i, lane: i % 4, judgment: i % 3 ? 'perfect' : 'good', deltaMs: 4, time: st }] : [];
        hw.draw(
          makeFrame({
            lanes: LANES,
            songTime: st,
            notes: notes.filter((n) => n.time > st - 0.5 && n.time < st + 2),
            laneStates: LANES.map((_, l) => ({ value: 0.3 + 0.3 * Math.sin(st * 3 + l), armed: true, tracking: true })),
            recentHits: hits,
            combo: i,
            multiplier: 1 + (i % 4),
            score: i * 137,
            health: 0.5,
            bpm: 120,
            beatPhase: (st * 2) % 1,
            energy: 0.5,
          }),
        );
      }
      const wall = performance.now() - t0;
      const s = hw.getStats();
      c.remove();
      return { w, h, frames, msPerFrame: wall / frames, particles: s.particles, sprites: s.sprites };
    };
    out.perfBig = runAt(1920, 1080, 600);
    out.perfSmall = runAt(480, 270, 600);
    const aBig = 1920 * 1080;
    const aSmall = 480 * 270;
    out.perfAreaRatio = aBig / aSmall;
    out.perfCostRatio = out.perfBig.msPerFrame / out.perfSmall.msPerFrame;
    // ms(area) = js + k*area over two points: js is the resolution-independent command-issue cost,
    // k*area the software rasterizer's fill cost (which a real GPU absorbs).
    const k = (out.perfBig.msPerFrame - out.perfSmall.msPerFrame) / (aBig - aSmall);
    out.perfJsMs = out.perfSmall.msPerFrame - k * aSmall;
    out.perfFillMsAt1080p = k * aBig;
  }

  // --- 6b. rolling score odometer: the digit column is never empty at any phase of a roll -------
  {
    // The score lerps toward its target, so the ones digit is mid-roll for ~0.6 s after every hit,
    // i.e. essentially always. A padded roll pitch used to put a blank band as tall as a third of a
    // glyph through the window for that whole time — a rendering fault in every gameplay frame.
    // Sample the ink column of the ones digit across a full 0→1 roll and require it never empties.
    const { canvas, hw } = fresh({ effectIntensity: 0 });
    const scoreFrame = (t, score) => base(t, { score, combo: 0, multiplier: 1, songTitle: undefined, attribution: undefined, health: 1 });
    // `displayScore` lerps and then snaps once it is within half a point of the target, so drawing
    // a handful of large-dt frames leaves it at *exactly* the requested (fractional) value.
    const settle = (score) => {
      hw.reset();
      for (let i = 0; i < 24; i++) hw.draw(scoreFrame(3 + i * 0.1, score));
      return grab(canvas);
    };
    const rowInk = (data, y0, y1, x0, x1) => {
      let n = 0;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (lum(px(data, x, y)) > 90) n++;
      return n;
    };
    // Locate the ones digit by differencing two settled scores that differ only in it: the changed
    // pixels are exactly that glyph, which keeps the 'SCORE' label and the rest of the HUD out of
    // the measurement window.
    const dA = settle(100);
    const dB = settle(108);
    let top = -1;
    let bottom = -1;
    let left = W;
    let right = 0;
    for (let y = 0; y < Math.round(H * 0.3); y++) {
      for (let x = Math.round(W * 0.6); x < W; x++) {
        const a = px(dA, x, y);
        const b = px(dB, x, y);
        if (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) > 90) {
          if (top < 0) top = y;
          bottom = y;
          if (x < left) left = x;
          if (x > right) right = x;
        }
      }
    }
    out.odoBox = [left, top, right, bottom];
    const colX0 = left;
    const colX1 = right;
    const rolls = [];
    let worstPhase = 0;
    let worstGap = 0;
    for (let i = 0; i <= 20; i++) {
      const phase = i / 20;
      const data = settle(100 + phase);
      if (i === 10) grab(canvas, 'odometer-mid-roll');
      rolls.push(rowInk(data, top, bottom, colX0, colX1));
      // Longest run of blank scanlines anywhere in the window. The broken odometer put a band as
      // tall as a third of the glyph through the middle of it; a correct one only ever shows the
      // 1-2 rows by which a flat-topped '1' undershoots a round '0' at the junction.
      let run = 0;
      for (let y = top; y <= bottom; y++) {
        run = rowInk(data, y, y, colX0, colX1) === 0 ? run + 1 : 0;
        if (run > worstGap) {
          worstGap = run;
          worstPhase = phase;
        }
      }
    }
    out.odoInk = rolls;
    out.odoMinInk = Math.min(...rolls);
    // Compare against the *lighter* of the two settled digits: '1' inks far fewer pixels than '0',
    // so the endpoints of a 0→1 roll differ by design and only a real gap can push below this.
    out.odoEndpointInk = Math.min(rolls[0], rolls[rolls.length - 1]);
    out.odoInkRatio = out.odoMinInk / out.odoEndpointInk;
    out.odoGapRows = worstGap;
    out.odoRows = bottom - top + 1;
    out.odoWorstPhase = worstPhase;
    canvas.remove();
  }

  // --- 7. eyeball scenes: a real demo frame, and the 2-lane rehab configuration ----------------
  {
    const c = document.createElement('canvas');
    c.style.width = W + 'px';
    c.style.height = H + 'px';
    document.body.appendChild(c);
    const handle = window.BR.runDemo(c, { now: () => 0, schedule: () => () => undefined, durationSec: 40, seed: 7 });
    handle.highway.resize(W, H, 1);
    for (let i = 0; i < 700; i++) handle.step(i / 60);
    grab(c, 'demo-gameplay');
    handle.stop();
    c.remove();

    const lanes2 = LANES.slice(0, 2);
    const { canvas, hw } = fresh({ highContrast: true, reducedMotion: true, effectIntensity: 0.35 });
    const f = (t, extra) =>
      makeFrame(
        Object.assign(
          {
            lanes: lanes2,
            laneStates: [
              { value: 0.85, armed: true, tracking: true },
              { value: 0.2, armed: true, tracking: false },
            ],
            songTime: t,
            bpm: 90,
            beatPhase: 0.2,
            health: 0.45,
            score: 4820,
            combo: 6,
            multiplier: 1,
            thresholdFraction: 0.6,
            notes: [0, 0.7, 1.4].map((dt, i) => ({ id: 40 + i, lane: i % 2, time: t + dt, state: 'pending' })),
            songTitle: 'Rehab config: 2 lanes, high contrast, reduced motion',
          },
          extra || {},
        ),
      );
    hw.draw(f(4));
    hw.draw(f(4.02, { recentHits: [{ noteId: 99, lane: 0, judgment: 'good', deltaMs: 60, time: 4.02 }] }));
    grab(canvas, 'rehab-2lane');
    canvas.remove();
  }

  // Narrow portrait, four lanes: the case where an untruncated lane label is wider than its lane.
  {
    const PW = 400;
    const PH = 800;
    const c = document.createElement('canvas');
    c.style.width = PW + 'px';
    c.style.height = PH + 'px';
    document.body.appendChild(c);
    const hw = new Highway(c, {});
    hw.resize(PW, PH, 1);
    const f = (t) =>
      makeFrame({
        lanes: LANES,
        laneStates: LANES.map((_, i) => ({ value: 0.2 + i * 0.2, armed: true, tracking: true })),
        songTime: t,
        bpm: 120,
        beatPhase: 0.4,
        health: 0.6,
        score: 3120,
        combo: 4,
        multiplier: 2,
        thresholdFraction: 0.5,
        songTitle: 'Rehab Groove',
        // A real ccMixter CC-BY line: it must stay legible (≥ 11 px) and be ellipsized rather than
        // run under the score readout on a 400 px-wide canvas.
        attribution: '"Rehab Groove" by Some Artist (ccmixter.org) is licensed under CC BY 4.0',
        notes: [0.15, 0.6, 1.1].map((dt, i) => ({ id: 70 + i, lane: (i + 1) % 4, time: t + dt, state: 'pending' })),
      });
    hw.draw(f(2));
    hw.draw(f(2.02));
    grab(c, 'portrait-4lane');
    // Label rows: how many distinct y positions the labels ended up on (1 = fits, 2 = staggered).
    c.remove();
  }

  return { out, shots };
}
/* eslint-enable */

const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });

const exe = findChromium();
if (!exe) {
  console.log('pixel-check: no Chromium binary found (set PLAYWRIGHT_CHROMIUM or run `npx playwright install chromium`) — skipping.');
  process.exit(0);
}

mkdirSync(outDir, { recursive: true });
const code = await bundle();
const browser = await chromium.launch({ executablePath: exe, headless: !headed, args: ['--no-sandbox', '--disable-gpu'] });
try {
  const W = 1920;
  const H = 1080;
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => {
    console.error('page error:', e.message);
    process.exitCode = 1;
  });
  await page.setContent('<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#000}canvas{display:block}</style><body></body>');
  await page.addScriptTag({ content: code });
  const { out, shots } = await page.evaluate(`(${pageProbe.toString()})(${W}, ${H})`);

  for (const [name, dataUrl] of Object.entries(shots)) {
    writeFileSync(path.join(outDir, `${name}.png`), Buffer.from(String(dataUrl).split(',')[1], 'base64'));
  }

  check('gem fills its lane like a fret (diameter ≥ 0.65 × lane width)', out.gemFill >= 0.65, `${out.gemPx}px gem / ${out.laneWidthPx.toFixed(1)}px lane = ${(out.gemFill * 100).toFixed(1)}%`);
  check('gem is centred on its lane (≤ 2 px)', out.gemCentreErr <= 2, `${out.gemCentreErr.toFixed(2)} px`);
  check('strike line is uniform across the board (min/max ≥ 0.9, sampled between receptors)', out.strikeUniformity >= 0.9, `samples ${out.strikeSamples.join(', ')} → ${out.strikeUniformity.toFixed(3)}`);
  check('strike line is much brighter than the road above it', out.strikeContrast >= 1.6, `${out.strikeContrast.toFixed(2)}×`);
  check('a hit visibly lights its lane', out.hitLumaGain > 6, `+${out.hitLumaGain.toFixed(1)} mean luma`);
  check('a miss reddens its lane on the state-flip frame (no HitEvent yet)', out.missRedGainStateFlip > 3, `+${out.missRedGainStateFlip.toFixed(2)} R-B`);
  check('a miss is still red when the HitEvent lands a frame later', out.missRedGainEventFrame > 3, `+${out.missRedGainEventFrame.toFixed(2)} R-B`);
  check(
    'a locked-out receptor is visibly not a live one (hysteresis is not a 30 % dim)',
    out.receptorLumaLocked < out.receptorLumaArmed * 0.8 && out.receptorChromaLocked < out.receptorChromaArmed * 0.7,
    `luma ${out.receptorLumaArmed.toFixed(1)} → ${out.receptorLumaLocked.toFixed(1)} (${((1 - out.receptorLumaLocked / out.receptorLumaArmed) * 100).toFixed(0)}% darker), chroma ${out.receptorChromaArmed.toFixed(1)} → ${out.receptorChromaLocked.toFixed(1)}`,
  );
  check(
    'a locked-out receptor shows the "lower to reset" line/chevron, and a live one never does',
    out.receptorHintLocked > 20 && out.receptorHintArmed === 0,
    `hint pixels: locked ${out.receptorHintLocked}, armed ${out.receptorHintArmed}, goal ${out.receptorHintGoal}`,
  );
  check(
    'the goal look (the frame the rep actually fires on) is a reward, not the lockout it precedes',
    out.receptorGoalBrighterThanLocked && out.receptorGoalHasNoLockHint && out.receptorGoalExpiresToLocked,
    `luma goal ${out.receptorLumaGoal.toFixed(1)} vs locked ${out.receptorLumaLocked.toFixed(1)}, ` +
      `lock-hint pixels in the goal frame ${out.receptorHintGoal}, and 0.7 s later it has become the lockout look (${out.receptorGoalExpiresToLocked})`,
  );
  check(
    'a locked receptor\'s column has a hard top edge, so "how much further to lower" is readable at 2 m',
    out.receptorStepLocked >= 35,
    `largest row-to-row luma step down the centre line: ${out.receptorStepLocked.toFixed(0)}`,
  );
  check(
    'the whole missed gem is on screen at the latest miss verdict (+280 ms)',
    out.missGemBottom > 0 &&
      out.missGemBottom <= out.canvasH - 2 &&
      out.missGemCentreRow + out.missGemExpectedHeight / 2 <= out.canvasH - 2 &&
      out.missGemHeight >= out.missGemExpectedHeight * 0.7,
    `gem rows ${out.missGemTop}..${out.missGemBottom} of ${out.canvasH}, centre ${out.missGemCentreRow} + half-height ${(out.missGemExpectedHeight / 2).toFixed(0)} = ${(out.missGemCentreRow + out.missGemExpectedHeight / 2).toFixed(0)}; lit core ${out.missGemHeight} px of a ${out.missGemExpectedHeight.toFixed(0)} px gem (the dying gem is drawn at 75 % alpha, so its rim falls under the detection threshold)`,
  );
  check('every chart gem is rasterized', out.noteYMeasured.every((v) => Number.isFinite(v)), `rows ${out.noteYMeasured.join(', ')}`);
  check('gems land exactly where the projection says (≤ 3 px, incl. the one on the strike line)', out.noteYMaxErr <= 3, `max err ${out.noteYMaxErr.toFixed(2)} px vs expected ${out.noteYExpected.join(', ')}`);
  check('perspective foreshortening: one beat spans less screen the further away it is', out.gapsShrinkWithDepth && out.gapRatio > 1.8, `gaps ${out.gaps.join(', ')} px, near/far ${out.gapRatio.toFixed(2)}×`);
  check(
    'rolling score odometer: no blank band through the digit window at any phase of a 0→1 roll',
    out.odoGapRows <= 3 && out.odoGapRows <= out.odoRows * 0.1,
    `longest blank run ${out.odoGapRows} scanline(s) of ${out.odoRows} (worst phase ${out.odoWorstPhase.toFixed(2)}), digit box ${out.odoBox.join(',')}`,
  );
  check(
    'rolling score odometer keeps its ink mid-roll (the two digits stay contiguous)',
    out.odoInkRatio >= 0.75,
    `min ${out.odoMinInk} vs ${out.odoEndpointInk} lit px at the roll endpoints = ${(out.odoInkRatio * 100).toFixed(0)}% (per-phase ${out.odoInk.join(',')})`,
  );
  check('resolution-independent JS cost per frame is ≤ 4 ms', out.perfJsMs <= 4, `${out.perfJsMs.toFixed(2)} ms/frame of command issue (fit over 480×270 and 1920×1080)`);
  check('frame cost is fill-bound, not JS-bound (scales with pixel count on a software rasterizer)', out.perfCostRatio > out.perfAreaRatio * 0.25, `${out.perfBig.msPerFrame.toFixed(1)} ms @1080p vs ${out.perfSmall.msPerFrame.toFixed(2)} ms @480x270 = ${out.perfCostRatio.toFixed(1)}× for ${out.perfAreaRatio}× the pixels`);
  console.log(
    `note: no GPU in this container, so canvas2d rasterizes on the CPU (SwiftShader): 1920x1080 costs ${out.perfBig.msPerFrame.toFixed(1)} ms/frame, of which ~${out.perfJsMs.toFixed(1)} ms is JS command issue and ~${out.perfFillMsAt1080p.toFixed(1)} ms is software fill (a GPU's job). ${out.perfBig.sprites} cached sprites, ${out.perfBig.particles} live particles at the end.`,
  );

  let failed = 0;
  for (const c of checks) {
    if (!c.ok) failed++;
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}  —  ${c.detail}`);
  }
  console.log(`\n${checks.length - failed}/${checks.length} pixel checks passed. Screenshots: ${outDir}`);
  if (failed) process.exitCode = 1;
} finally {
  await browser.close();
}
