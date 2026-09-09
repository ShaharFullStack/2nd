/** Emitted when a lane's normalized movement value crosses the hit threshold (rising edge). */
export interface LaneInputEvent {
  lane: number;
  /** AudioContext.currentTime (seconds) at which the crossing was observed. */
  ctxTime: number;
  /** Fraction of calibrated ROM reached (0..1+). */
  strength: number;
}
export interface LaneState { lane: number; value: number; armed: boolean; tracking: boolean; }
export interface InputSource {
  start(): Promise<void>;
  stop(): void;
  onEvent(cb: (e: LaneInputEvent) => void): () => void;
  getLaneStates(): LaneState[];
}
