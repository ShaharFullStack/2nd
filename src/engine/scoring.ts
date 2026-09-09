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

/** Star rating 0..5 from hit accuracy (0..1). */
export function starsForAccuracy(accuracy: number): number {
  if (!Number.isFinite(accuracy)) return 0;
  if (accuracy >= 0.95) return 5;
  if (accuracy >= 0.85) return 4;
  if (accuracy >= 0.7) return 3;
  if (accuracy >= 0.5) return 2;
  if (accuracy >= 0.25) return 1;
  return 0;
}

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
  /** Mean of deltaMs over hits (timing bias: positive = late). 0 when no hits. */
  meanDeltaMs: number;
  /** Population std-dev of deltaMs over hits. */
  stdDeltaMs: number;
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
  stars: number;
  meanDeltaMs: number;
  stdDeltaMs: number;
  lanes: LaneStats[];
}

export interface ScoreDelta {
  points: number;
  multiplier: number;
  combo: number;
  health: number;
  judgment: Judgment;
}

interface Acc {
  hits: number;
  perfects: number;
  goods: number;
  misses: number;
  n: number; // delta samples
  mean: number;
  m2: number;
}

function newAcc(): Acc {
  return { hits: 0, perfects: 0, goods: 0, misses: 0, n: 0, mean: 0, m2: 0 };
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

/**
 * Score/combo/health/statistics accumulator. Feed it every HitEvent (hits and misses).
 */
export class Scoring {
  private score = 0;
  private combo = 0;
  private maxCombo = 0;
  private health = HEALTH_START;
  private readonly total: Acc = newAcc();
  private readonly lanes: Acc[] = [];
  private readonly totalNotes: number;

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

  /** Apply a judgment. Returns the points awarded and the resulting combo/multiplier/health. */
  apply(e: HitEvent): ScoreDelta {
    const laneAcc = this.lanes[e.lane] ?? this.lanes[this.lanes.length - 1];
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
        pushDelta(this.total, e.deltaMs);
        pushDelta(laneAcc, e.deltaMs);
      }
    }
    return { points, multiplier: multiplierForCombo(this.combo), combo: this.combo, health: this.health, judgment: e.judgment };
  }

  /** Plain-object snapshot (safe to store / serialize). */
  getState(): ScoreState {
    const t = this.total;
    const judged = t.hits + t.misses;
    const accuracy = judged > 0 ? t.hits / judged : 0;
    return {
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
      stars: starsForAccuracy(accuracy),
      meanDeltaMs: t.mean,
      stdDeltaMs: std(t),
      lanes: this.lanes.map((a, lane) => {
        const j = a.hits + a.misses;
        return {
          lane,
          hits: a.hits,
          perfects: a.perfects,
          goods: a.goods,
          misses: a.misses,
          judged: j,
          accuracy: j > 0 ? a.hits / j : 0,
          weightedAccuracy: j > 0 ? (a.perfects + 0.5 * a.goods) / j : 0,
          meanDeltaMs: a.mean,
          stdDeltaMs: std(a),
        };
      }),
    };
  }

  reset(): void {
    this.score = 0;
    this.combo = 0;
    this.maxCombo = 0;
    this.health = HEALTH_START;
    Object.assign(this.total, newAcc());
    for (const a of this.lanes) Object.assign(a, newAcc());
  }
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
