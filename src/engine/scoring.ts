import type { HitEvent, Judgment } from './types.ts';

export const PERFECT_SCORE = 100;
export const GOOD_SCORE = 50;
/** Combo counts at which the multiplier steps to 1x, 2x, 3x, 4x. */
export const COMBO_THRESHOLDS: readonly number[] = [0, 10, 20, 30];
export const MAX_MULTIPLIER = COMBO_THRESHOLDS.length;

export const HEALTH_START = 0.5;
export const HEALTH_PER_HIT = 0.02;
export const HEALTH_PER_MISS = -0.03;

/** Guitar-Hero style: multiplier = number of thresholds reached by the current combo. */
export function multiplierForCombo(combo: number): number {
  let m = 0;
  for (const th of COMBO_THRESHOLDS) if (combo >= th) m++;
  return Math.max(1, m);
}

/** Weight of a 'good' hit relative to a 'perfect' in the star rating (a run of goods is 3 stars, not 5). */
export const GOOD_STAR_WEIGHT = 0.75;

/**
 * Accuracy used for the star rating: (perfects + GOOD_STAR_WEIGHT * goods) / judged. Sits between
 * plain accuracy (hits / judged) and `weightedAccuracy` (goods count half) so timing quality shows
 * in the stars without making a consistently-'good' rehab session look like a failure.
 */
export function starAccuracyOf(perfects: number, goods: number, judged: number): number {
  return judged > 0 ? (perfects + GOOD_STAR_WEIGHT * goods) / judged : 0;
}

/** Star rating 0..5 from an accuracy in 0..1 (feed it `starAccuracy`, see `starAccuracyOf`). */
export function starsForAccuracy(accuracy: number): number {
  if (!Number.isFinite(accuracy)) return 0;
  if (accuracy >= 0.95) return 5;
  if (accuracy >= 0.85) return 4;
  if (accuracy >= 0.7) return 3;
  if (accuracy >= 0.5) return 2;
  if (accuracy >= 0.25) return 1;
  return 0;
}

/**
 * Nearest-note delta samples kept per lane (and in the total pool) for the robust timing bias.
 * The pool is a RING buffer: once the cap is reached the OLDEST sample is dropped, so a long
 * session's bias reflects the reps the patient is doing now rather than being frozen at the
 * session's opening. A 4-minute session produces a few hundred inputs per lane, so the cap only
 * bounds pathological input storms.
 */
export const MAX_DELTA_SAMPLES = 4000;

/** Initial pool capacity; grows by doubling up to `MAX_DELTA_SAMPLES` (no per-sample allocation). */
const INITIAL_POOL_CAPACITY = 128;

export interface LaneStats {
  lane: number;
  hits: number;
  perfects: number;
  goods: number;
  misses: number;
  /** hits + misses */
  judged: number;
  /** hits / judged (0 when nothing judged) */
  accuracy: number;
  /** (perfects + 0.5*goods) / judged */
  weightedAccuracy: number;
  /**
   * Mean of deltaMs over hits (timing bias: positive = late) on the CURRENT latency timeline.
   * 0 when no hits. Rebased by `Scoring.setLatencyOffsetMs`, exactly like `timingBiasMs`: the
   * samples are stored offset-free, so applying a mid-session calibration shifts this number with
   * them instead of leaving it a mixture of the "before" and "after" timelines.
   *
   * Sensitive to outliers by construction (it is a mean over a window-censored sample); prefer
   * `LaneResults.timingBiasMs` / `timingBiasMadMs` for anything a therapist acts on.
   */
  meanDeltaMs: number;
  /**
   * Population std-dev of deltaMs over hits — timing *variability*, not bias. Invariant under a
   * latency change (a rebase shifts every sample equally), so a calibrated patient with a steady
   * rhythm reads 0 here whatever offset was in force while they played.
   */
  stdDeltaMs: number;
  /**
   * Inputs that matched no note (never penalised). Includes both involuntary/extra movements and
   * correct reps that a mis-calibrated latency offset pushed outside the good window.
   */
  unmatched: number;
  /**
   * Movements the patient actually performed in this lane: hits + unmatched. This — not `hits` —
   * is the rep count the Results screen should show.
   */
  reps: number;
}

/**
 * Robust timing bias over every input that had a nearest note (matched or not), so it is not
 * truncated by the good window. Computed on demand by `Scoring.getTimingBias()` /
 * `Scoring.getResults()` — deliberately NOT part of the per-frame `ScoreState`, because it costs
 * two sorts of the sample pool and the Play HUD reads the state every frame.
 */
export interface TimingBias {
  /**
   * Median signed distance in ms (positive = late) on the CURRENT latency timeline. Null when no
   * input had a nearest note. A value near a whole ±100 ms with a small `timingBiasMadMs` is a
   * latency-calibration error, not a patient problem — feed `getNearestDeltaSamplesMs(lane)` to
   * `estimateLatencyFromDeltas` (or call `RhythmEngine.suggestedInputLatency()`).
   */
  timingBiasMs: number | null;
  /** Median absolute deviation (ms) of the samples behind `timingBiasMs`. Null when no input. */
  timingBiasMadMs: number | null;
  /** Number of samples behind `timingBiasMs` (capped at `MAX_DELTA_SAMPLES`, most recent kept). */
  timingBiasSamples: number;
}

export interface ScoreState {
  score: number;
  combo: number;
  maxCombo: number;
  /** Multiplier that the *next* hit will receive. */
  multiplier: number;
  /** Rock meter 0..1 (never fails the song). */
  health: number;
  totalNotes: number;
  hits: number;
  perfects: number;
  goods: number;
  misses: number;
  judged: number;
  accuracy: number;
  weightedAccuracy: number;
  /** (perfects + 0.75*goods) / judged — the input of `stars`. */
  starAccuracy: number;
  /** 0..5 from `starAccuracy` (100 % perfect = 5, 100 % good = 3). */
  stars: number;
  /** Mean deltaMs over hits on the current latency timeline (see `LaneStats.meanDeltaMs`). */
  meanDeltaMs: number;
  /** Population std-dev of deltaMs over hits (see `LaneStats.stdDeltaMs`). */
  stdDeltaMs: number;
  /** Inputs across all lanes that matched no note (never penalised). */
  unmatched: number;
  /**
   * Movements delivered on a lane index the chart does not have (a mis-wired keyboard map or an
   * off-by-one `LaneSpec.index`). They are counted here rather than dropped — the rehab rule is
   * that a rep performed is never lost — but they cannot be attributed to a lane, so they are NOT
   * in `reps` (which stays equal to the sum of `lanes[].reps`) and never affect score or health.
   * Anything above 0 is a wiring bug: surface it in dev tools / the Results screen.
   */
  outOfRange: number;
  /**
   * Movements actually performed and attributable to a lane: hits + unmatched, summed over lanes.
   * The honest rep count for the Results screen. See `outOfRange` for the unattributable rest.
   */
  reps: number;
  lanes: LaneStats[];
}

/** `LaneStats` plus the lane's robust timing bias (Results screen; see `Scoring.getResults`). */
export interface LaneResults extends LaneStats, TimingBias {}

/** `ScoreState` plus the robust timing bias, overall and per lane. Built on demand, never per frame. */
export interface ScoreResults extends ScoreState, TimingBias {
  lanes: LaneResults[];
}

export interface ScoreDelta {
  points: number;
  multiplier: number;
  combo: number;
  health: number;
  judgment: Judgment;
}

/* ---------- sample pool (ring buffer over a Float64Array, allocation-free per sample) ---------- */

class NearestPool {
  private buf: Float64Array | null = null;
  /** number of valid samples (<= MAX_DELTA_SAMPLES) */
  private len = 0;
  /** index of the oldest sample once the ring is full (0 while filling) */
  private head = 0;

  get size(): number {
    return this.len;
  }

  push(x: number): void {
    if (!Number.isFinite(x)) return;
    if (this.len < MAX_DELTA_SAMPLES) {
      let buf = this.buf;
      if (buf === null) {
        buf = new Float64Array(INITIAL_POOL_CAPACITY);
        this.buf = buf;
      } else if (this.len === buf.length) {
        const grown = new Float64Array(Math.min(MAX_DELTA_SAMPLES, buf.length * 2));
        grown.set(buf);
        buf = grown;
        this.buf = grown;
      }
      buf[this.len++] = x;
    } else {
      // full: overwrite the oldest sample so the bias tracks the reps being done now
      this.buf![this.head] = x;
      this.head = this.head + 1 === MAX_DELTA_SAMPLES ? 0 : this.head + 1;
    }
  }

  clear(): void {
    this.len = 0;
    this.head = 0;
  }

  /** Copy the samples in chronological order into `out` (which must hold at least `size` values). */
  copyInto(out: Float64Array): void {
    const b = this.buf;
    const n = this.len;
    if (b === null || n === 0) return;
    const h = this.head;
    if (h === 0) {
      for (let i = 0; i < n; i++) out[i] = b[i];
      return;
    }
    let k = 0;
    for (let i = h; i < n; i++) out[k++] = b[i];
    for (let i = 0; i < h; i++) out[k++] = b[i];
  }
}

/** Shared sort scratch: median + MAD are computed without allocating (see `poolStats`). */
let sortScratch: Float64Array | null = null;
function scratchFor(n: number): Float64Array {
  if (sortScratch === null || sortScratch.length < n) sortScratch = new Float64Array(Math.max(n, INITIAL_POOL_CAPACITY));
  return sortScratch;
}

function medianOfSorted(v: Float64Array, n: number): number {
  const mid = n >> 1;
  return n % 2 === 1 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/**
 * Median and MAD of a pool, in two in-place sorts of a shared scratch buffer and no garbage.
 * (The median is computed once and reused as the MAD's centre — `mad(values)` would recompute it.)
 */
function poolStats(p: NearestPool): { median: number; mad: number } | null {
  const n = p.size;
  if (n === 0) return null;
  const s = scratchFor(n);
  p.copyInto(s);
  const view = s.subarray(0, n);
  view.sort();
  const med = medianOfSorted(view, n);
  for (let i = 0; i < n; i++) view[i] = Math.abs(view[i] - med);
  view.sort();
  return { median: med, mad: medianOfSorted(view, n) };
}

interface Acc {
  hits: number;
  perfects: number;
  goods: number;
  misses: number;
  /**
   * Welford accumulator over the hit deltas. Like `nearest`, the values fed in are RAW (the latency
   * offset in force at the time is added back), so `mean` is on the offset-free timeline and the
   * reported mean subtracts whatever offset is in force NOW. Without that, a mid-session
   * recalibration leaves `meanDeltaMs` / `stdDeltaMs` describing a bimodal mixture of two timelines
   * — a patient corrected from +150 ms to 0 would read back as 75 ms mean and 75 ms std, i.e.
   * fabricated timing variability produced by the module's own recommended action.
   */
  n: number; // delta samples
  mean: number;
  m2: number;
  /** inputs that matched no note */
  unmatched: number;
  /** RAW signed distance (ms) to the nearest note — latency-offset free, see `Scoring` */
  nearest: NearestPool;
}

function newAcc(): Acc {
  return { hits: 0, perfects: 0, goods: 0, misses: 0, n: 0, mean: 0, m2: 0, unmatched: 0, nearest: new NearestPool() };
}

function resetAcc(a: Acc): void {
  a.hits = 0;
  a.perfects = 0;
  a.goods = 0;
  a.misses = 0;
  a.n = 0;
  a.mean = 0;
  a.m2 = 0;
  a.unmatched = 0;
  a.nearest.clear();
}

function pushDelta(a: Acc, x: number): void {
  a.n++;
  const d = x - a.mean;
  a.mean += d / a.n;
  a.m2 += d * (x - a.mean);
}

function std(a: Acc): number {
  return a.n > 0 ? Math.sqrt(a.m2 / a.n) : 0;
}

/** Welford mean rebased onto the timeline of `offsetMs` (samples are stored offset-free). */
function meanOn(a: Acc, offsetMs: number): number {
  return a.n > 0 ? a.mean - offsetMs : 0;
}

const NO_BIAS: TimingBias = Object.freeze({ timingBiasMs: null, timingBiasMadMs: null, timingBiasSamples: 0 });

/**
 * Score/combo/health/statistics accumulator. Feed it every HitEvent (hits and misses) via `apply`,
 * and every input that matched no note via `recordUnmatchedInput`.
 *
 * Why the second call matters: a rehab session must report the reps the patient actually performed
 * and an honest timing bias. If only hits are sampled, both numbers are censored by the good window
 * — a patient whose latency offset is 180 ms out performs every rep and reads back as 0 reps,
 * 0 % accuracy and 0.0 ms bias, which blames the patient for a calibration error. Unmatched inputs
 * add no penalty (rehab rule) but do count as reps and do carry timing.
 *
 * Latency timeline: the deltas handed in are measured on the latency-shifted timeline in force at
 * the time (`Judge`'s offset). They are stored RAW (the offset is added back), and EVERY reported
 * timing number subtracts whatever offset is in force NOW — the robust bias (`timingBiasMs`), the
 * raw sample list, and the `meanDeltaMs` / `stdDeltaMs` pair alike. So applying a mid-session
 * calibration (`setLatencyOffsetMs`, which `RhythmEngine.setInputLatency` does for you) rebases
 * everything instead of leaving it bimodal: a patient who was 150 ms out for 20 reps and then plays
 * 20 dead-on reps after the correction reads back as 0 ms mean and 0 ms std, not 75/75. That 75/75
 * would be a fabricated clinical readout — invented timing variability, caused by the module's own
 * recommended action — so mean/std and median/MAD are kept on one timeline by construction.
 *
 * Cost: `getState()` is the per-frame HUD snapshot — cached behind a dirty flag, so a frame with no
 * scoring change allocates nothing and returns the identical (frozen) object. The robust timing
 * bias is NOT in it: it lives in `getTimingBias()` / `getResults()`, which the Results screen calls
 * once.
 */
export class Scoring {
  private score = 0;
  private combo = 0;
  private maxCombo = 0;
  private health = HEALTH_START;
  private readonly total: Acc = newAcc();
  private readonly lanes: Acc[] = [];
  private readonly totalNotes: number;
  private outOfRange = 0;
  private lastOutOfRangeLane: number | null = null;
  private latencyOffsetMs = 0;
  private stateCache: ScoreState | null = null;
  /** index 0 = total, index l+1 = lane l */
  private biasCache: TimingBias[] | null = null;

  constructor(lanes: number, totalNotes = 0) {
    for (let i = 0; i < Math.max(1, lanes); i++) this.lanes.push(newAcc());
    this.totalNotes = totalNotes;
  }

  /** Multiplier the next hit will receive. */
  getMultiplier(): number {
    return multiplierForCombo(this.combo);
  }

  getCombo(): number {
    return this.combo;
  }

  getScore(): number {
    return this.score;
  }

  getHealth(): number {
    return this.health;
  }

  getLaneCount(): number {
    return this.lanes.length;
  }

  /**
   * Tell the accumulator which input-latency offset (ms) the deltas handed to `apply` /
   * `recordUnmatchedInput` are measured against — the same value as `Judge.getLatencyOffset()`.
   * Changing it rebases the already-collected samples instead of mixing two timelines.
   * `RhythmEngine.setInputLatency` keeps this in sync; call it yourself only when driving a bare
   * `Judge` + `Scoring` pair.
   */
  setLatencyOffsetMs(ms: number): void {
    const v = Number.isFinite(ms) ? ms : 0;
    if (v === this.latencyOffsetMs) return;
    this.latencyOffsetMs = v;
    // Both the robust bias (median/MAD) and the mean/std pair are derived from offset-free samples,
    // so BOTH caches must go: leaving `stateCache` alone would keep serving the old timeline's
    // meanDeltaMs to the HUD and the Results screen.
    this.biasCache = null;
    this.stateCache = null;
  }

  getLatencyOffsetMs(): number {
    return this.latencyOffsetMs;
  }

  /**
   * Apply a judgment. Returns the points awarded and the resulting combo/multiplier/health.
   * @throws RangeError when `e.lane` is not in [0, laneCount) — per-lane rehab metrics must never be silently misattributed.
   */
  apply(e: HitEvent): ScoreDelta {
    const laneAcc = this.lanes[e.lane];
    if (laneAcc === undefined) throw new RangeError(`Scoring: lane ${e.lane} out of range [0, ${this.lanes.length})`);
    let points = 0;
    if (e.judgment === 'miss') {
      this.combo = 0;
      this.health = clamp01(this.health + HEALTH_PER_MISS);
      this.total.misses++;
      laneAcc.misses++;
    } else {
      const mult = multiplierForCombo(this.combo);
      points = (e.judgment === 'perfect' ? PERFECT_SCORE : GOOD_SCORE) * mult;
      this.score += points;
      this.combo++;
      if (this.combo > this.maxCombo) this.maxCombo = this.combo;
      this.health = clamp01(this.health + HEALTH_PER_HIT);
      this.total.hits++;
      laneAcc.hits++;
      if (e.judgment === 'perfect') {
        this.total.perfects++;
        laneAcc.perfects++;
      } else {
        this.total.goods++;
        laneAcc.goods++;
      }
      if (Number.isFinite(e.deltaMs)) {
        // stored RAW (offset-free) so a later `setLatencyOffsetMs` rebases mean/std with the pool
        const raw = e.deltaMs + this.latencyOffsetMs;
        pushDelta(this.total, raw);
        pushDelta(laneAcc, raw);
        this.pushNearestRaw(laneAcc, raw);
      }
    }
    this.stateCache = null;
    return { points, multiplier: multiplierForCombo(this.combo), combo: this.combo, health: this.health, judgment: e.judgment };
  }

  /**
   * Record an input that matched no note. Scoring is untouched — no penalty, ever (rehab rule) —
   * but the rep is counted and, when the input had a nearest note, its signed distance feeds the
   * uncensored timing bias. Feed this from `Judge.onInputDetailed` / `RhythmEngine.handleInput` for
   * every `hit === null` input.
   *
   * @param nearestDeltaMs `InputResult.nearestDeltaMs` (positive = late, measured on the latency
   *        timeline currently set via `setLatencyOffsetMs`), or null when the lane holds no notes —
   *        the rep still counts, it just carries no timing information.
   * @throws RangeError when `lane` is out of range (per-lane rehab metrics must not be misattributed).
   */
  recordUnmatchedInput(lane: number, nearestDeltaMs: number | null): void {
    const laneAcc = this.lanes[lane];
    if (laneAcc === undefined) throw new RangeError(`Scoring: lane ${lane} out of range [0, ${this.lanes.length})`);
    this.total.unmatched++;
    laneAcc.unmatched++;
    if (nearestDeltaMs !== null) this.pushNearest(laneAcc, nearestDeltaMs);
    this.stateCache = null;
  }

  /**
   * Record a movement delivered on a lane index this chart does not have. It cannot be attributed
   * to a lane (so it is not a rep of any movement) and it never scores, but it is COUNTED: the one
   * path that used to lose a rep silently was a mis-wired lane index, which is exactly the bug this
   * counter exists to make visible. `RhythmEngine.handleInputDetailed` calls it for you.
   */
  recordOutOfRangeInput(lane: number): void {
    this.outOfRange++;
    this.lastOutOfRangeLane = lane;
    this.stateCache = null;
  }

  /** Movements delivered on a lane the chart does not have (see `ScoreState.outOfRange`). */
  getOutOfRangeCount(): number {
    return this.outOfRange;
  }

  /** The most recent offending lane index, or null — names the wiring bug for dev tools. */
  getLastOutOfRangeLane(): number | null {
    return this.lastOutOfRangeLane;
  }

  /** Inputs that matched no note, in a lane or overall. */
  getUnmatchedCount(lane?: number): number {
    if (lane === undefined) return this.total.unmatched;
    return this.lanes[lane]?.unmatched ?? 0;
  }

  /** Movements actually performed (hits + unmatched), in a lane or overall. */
  getReps(lane?: number): number {
    const a = lane === undefined ? this.total : this.lanes[lane];
    return a ? a.hits + a.unmatched : 0;
  }

  /**
   * Copy of the signed nearest-note distances (ms, positive = late) collected for a lane, or for
   * every lane pooled, on the latency timeline currently in force. Uncensored by the good window —
   * feed it to `estimateLatencyFromDeltas` to re-estimate the input latency mid-session.
   */
  getNearestDeltaSamplesMs(lane?: number): number[] {
    const a = lane === undefined ? this.total : this.lanes[lane];
    if (!a) return [];
    const n = a.nearest.size;
    if (n === 0) return [];
    const s = scratchFor(n);
    a.nearest.copyInto(s);
    const out = new Array<number>(n);
    const off = this.latencyOffsetMs;
    for (let i = 0; i < n; i++) out[i] = s[i] - off;
    return out;
  }

  /**
   * Robust timing bias for a lane (or every lane pooled). Costs two sorts of the sample pool, so it
   * is computed on demand and cached until the next sample or latency change — the Results screen
   * calls it, the per-frame HUD reads `getState()` instead.
   */
  getTimingBias(lane?: number): TimingBias {
    const cache = this.ensureBias();
    if (lane === undefined) return cache[0];
    return cache[lane + 1] ?? NO_BIAS;
  }

  /**
   * Plain-object snapshot for the HUD (safe to store / serialize). Frozen and CACHED: the same
   * object is returned until the next scoring change, so binding to it per frame costs nothing and
   * a React consumer can compare by reference. Robust timing bias is not included — see
   * `getTimingBias()` / `getResults()`.
   */
  getState(): ScoreState {
    const cached = this.stateCache;
    if (cached !== null) return cached;
    const t = this.total;
    const judged = t.hits + t.misses;
    const accuracy = judged > 0 ? t.hits / judged : 0;
    const starAccuracy = starAccuracyOf(t.perfects, t.goods, judged);
    const off = this.latencyOffsetMs;
    const lanes: LaneStats[] = new Array<LaneStats>(this.lanes.length);
    for (let lane = 0; lane < this.lanes.length; lane++) {
      const a = this.lanes[lane];
      const j = a.hits + a.misses;
      lanes[lane] = Object.freeze({
        lane,
        hits: a.hits,
        perfects: a.perfects,
        goods: a.goods,
        misses: a.misses,
        judged: j,
        accuracy: j > 0 ? a.hits / j : 0,
        weightedAccuracy: j > 0 ? (a.perfects + 0.5 * a.goods) / j : 0,
        meanDeltaMs: meanOn(a, off),
        stdDeltaMs: std(a),
        unmatched: a.unmatched,
        reps: a.hits + a.unmatched,
      });
    }
    const state: ScoreState = Object.freeze({
      score: this.score,
      combo: this.combo,
      maxCombo: this.maxCombo,
      multiplier: multiplierForCombo(this.combo),
      health: this.health,
      totalNotes: this.totalNotes,
      hits: t.hits,
      perfects: t.perfects,
      goods: t.goods,
      misses: t.misses,
      judged,
      accuracy,
      weightedAccuracy: judged > 0 ? (t.perfects + 0.5 * t.goods) / judged : 0,
      starAccuracy,
      stars: starsForAccuracy(starAccuracy),
      meanDeltaMs: meanOn(t, off),
      stdDeltaMs: std(t),
      unmatched: t.unmatched,
      outOfRange: this.outOfRange,
      reps: t.hits + t.unmatched,
      lanes: Object.freeze(lanes) as LaneStats[],
    });
    this.stateCache = state;
    return state;
  }

  /**
   * `getState()` plus the robust timing bias, overall and per lane: the Results-screen snapshot.
   * Allocates and sorts the sample pools — call it once when the song ends, not per frame.
   */
  getResults(): ScoreResults {
    const state = this.getState();
    const bias = this.ensureBias();
    const lanes: LaneResults[] = state.lanes.map((l) => ({ ...l, ...(bias[l.lane + 1] ?? NO_BIAS) }));
    return { ...state, ...bias[0], lanes };
  }

  reset(): void {
    this.score = 0;
    this.combo = 0;
    this.maxCombo = 0;
    this.health = HEALTH_START;
    resetAcc(this.total);
    for (const a of this.lanes) resetAcc(a);
    this.outOfRange = 0;
    this.lastOutOfRangeLane = null;
    this.stateCache = null;
    this.biasCache = null;
  }

  /** Convert a delta on the current timeline to a raw (offset-free) sample and pool it. */
  private pushNearest(laneAcc: Acc, deltaMs: number): void {
    if (!Number.isFinite(deltaMs)) return;
    this.pushNearestRaw(laneAcc, deltaMs + this.latencyOffsetMs);
  }

  /** Store an already-raw (offset-free) distance in both the lane pool and the total pool. */
  private pushNearestRaw(laneAcc: Acc, raw: number): void {
    this.total.nearest.push(raw);
    laneAcc.nearest.push(raw);
    this.biasCache = null;
  }

  private ensureBias(): TimingBias[] {
    const cached = this.biasCache;
    if (cached !== null) return cached;
    const off = this.latencyOffsetMs;
    const out: TimingBias[] = new Array<TimingBias>(this.lanes.length + 1);
    out[0] = biasOf(this.total, off);
    for (let l = 0; l < this.lanes.length; l++) out[l + 1] = biasOf(this.lanes[l], off);
    this.biasCache = out;
    return out;
  }
}

function biasOf(a: Acc, offsetMs: number): TimingBias {
  const s = poolStats(a.nearest);
  if (s === null) return NO_BIAS;
  return Object.freeze({ timingBiasMs: s.median - offsetMs, timingBiasMadMs: s.mad, timingBiasSamples: a.nearest.size });
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
