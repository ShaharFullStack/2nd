export type Mode = 'leg' | 'hand';
export type LegMovement = 'seated_march' | 'knee_extension' | 'ankle_dorsiflexion' | 'hip_abduction';
export type HandMovement = 'hand_open_close' | 'wrist_extension' | 'finger_opposition' | 'finger_spread';
export type Movement = LegMovement | HandMovement;
export type Side = 'left' | 'right';

export const LEG_MOVEMENTS: LegMovement[] = ['seated_march', 'knee_extension', 'ankle_dorsiflexion', 'hip_abduction'];
export const HAND_MOVEMENTS: HandMovement[] = ['hand_open_close', 'wrist_extension', 'finger_opposition', 'finger_spread'];
export const FINE_MOTOR: Movement[] = ['finger_opposition', 'finger_spread'];

export interface LaneSpec { index: number; movement: Movement; side: Side; }

/** A single note. `time` is song time in seconds (audio timeline, offset already applied). */
export interface Note { id: number; lane: number; time: number; }

export type Judgment = 'perfect' | 'good' | 'miss';
export interface TimingWindows { perfectMs: number; goodMs: number; }
export type DifficultyName = 'easy' | 'medium' | 'hard';
export interface Difficulty {
  name: DifficultyName;
  /** Fraction of calibrated ROM that counts as a hit (0..1). */
  thresholdFraction: number;
  /** Notes per beat on average (e.g. 0.5 = every other beat). */
  noteDensity: number;
  windows: TimingWindows;
}

export interface Chart { songId: string; lanes: number; notes: Note[]; bpm: number; offset: number; difficulty: Difficulty; durationSec: number; }

export interface HitEvent { noteId: number; lane: number; judgment: Judgment; deltaMs: number; time: number; }
