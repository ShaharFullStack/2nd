/**
 * The receptor's honest state model — pure, no DOM, unit-testable.
 *
 * This is the renderer's core biofeedback claim, so it lives apart from the drawing code and is
 * tested on its own: **the receptor must mean exactly what the input engine means.**
 *
 * The engine (docs/ARCHITECTURE.md, "Input contract"; src/vision/trigger.ts) fires a lane when its
 * normalized value crosses `Difficulty.thresholdFraction` on a *rising edge*, with hysteresis:
 * after firing, the lane cannot fire again until the value falls back below
 * `thresholdFraction * REARM_FRACTION` (`LaneTrigger.rearmLevel`). `LaneState.armed` is that flag.
 *
 * `armed === false` covers BOTH of the trigger's non-firing states, and the receptor deliberately
 * draws them the same way because the patient's remedy is the same for both:
 *   - 'triggered'   — the rep fired and has not been given back yet;
 *   - 'unconfirmed' — the lane has never been observed below the re-arm level since the last reset
 *                     or dropout (a patient who starts the song already at end range, a lane
 *                     recovering from an occlusion, a calibration replaced mid-rep).
 * In both, and *at any value*, nothing the patient does scores until they get below the re-arm
 * level. So `locked` is not conditioned on a full meter: an unconfirmed lane at 40 % of threshold
 * is just as unable to fire, and says "lower to reset" just as loudly.
 *
 * So there are four states, and they must not look like brightness steps of one look:
 *
 *   tracking + armed + below threshold  →  (a) rising. The effortful, coachable phase: the meter
 *                                          has to answer "how much further", not "not yet".
 *   the threshold crossing              →  (b) the rep just reached the target ROM — the frame the
 *                                          input engine emitted its `LaneInputEvent` on. See
 *                                          "THE CROSSING IS ONE FRAME" below: this is a LATCHED
 *                                          state, not a level test — and a latch bounded at BOTH
 *                                          ends, by the crossing and by the re-arm that gives the
 *                                          rep back.
 *   tracking + !armed                   →  (c) the lane *cannot* fire, no matter how hard the
 *                                          patient pushes, until they lower past the re-arm line.
 *                                          This is the single most common thing a rehab patient
 *                                          does (holding at end range), and showing them a lit,
 *                                          "ready" receptor for the whole hold is a lie that
 *                                          teaches the wrong movement.
 *   !tracking                           →  (d) there is no measurement. Outranks (c): "lower to
 *                                          reset" is advice a patient who is out of frame cannot
 *                                          act on, so `locked` is false while untracked and every
 *                                          value-derived output (`fill`, `over`, `resetProgress`,
 *                                          `glowTarget`) is meaningless — `Highway.drawReceptors`
 *                                          draws none of them.
 *
 * THE CROSSING IS ONE FRAME, AND IT IS ALREADY DISARMED. This is the whole reason `ReceptorHistory`
 * exists. `LaneTrigger.push()` moves the lane to 'triggered' on the very sample that crosses
 * (src/vision/trigger.ts), and `VisionInput` pushes the trigger BEFORE `getLaneStates()` reads
 * `trigger.armed` (src/input/VisionInput.ts) — so the crossing frame is published as
 * `{ value: >= threshold, armed: false }` and NO frame from ANY input source in this repo ever
 * satisfies `armed && value >= threshold`. (The scripted sources are the same by construction:
 * src/input/laneStates.ts publishes a held lane as `{ value: 1, armed: false }`.) There is
 * therefore NO single-frame test for state (b), and this file deliberately does not offer one: a
 * look built by `receptorLookInto` alone always reads `goal: 0`, so a consumer cannot accidentally
 * ship a meter whose "this counts" cue is unreachable. (`ReceptorLook.willFire` used to be exactly
 * such an offer. It was false on every frame of every source, the play screen's picture-in-picture
 * meters were built on it, and the result was a meter that went from the rising look straight to
 * the grey lockout look at the instant of success. Removed.)
 *
 * So state (b) is a LATCH, set on the frame the lane ENTERS 'triggered'. `ReceptorHistory.update`
 * sets `ReceptorLook.goal` from it, and `goal > 0` is what the renderer draws state (b) from.
 * Without a latch the gauge also *steps down* at the instant of success: the last armed frame paints
 * a nearly full column, the next frame is capped by the lockout ceiling.
 *
 * AND THE LATCH ENDS WHEN THE LOCKOUT DOES, WHICH IS THE OTHER HALF OF THE SAME HONESTY. (b) is an
 * overlay on (c): it describes a rep the patient is still holding. The instant the value drops below
 * the re-arm level the lane is armed again and the true message is "go again", so the latch is cut
 * there — floored at `GOAL_MIN_SEC` (0.15 s) so knowledge of results is catchable at all, and capped
 * at `GOAL_HOLD_SEC + GOAL_FADE_SEC` for a patient who keeps holding. It used to be that fixed
 * 0.6 s with no reference to the arming, and at the game's own pacing that was not an edge case but
 * the steady state: a brisk rep re-arms ~0.1 s after crossing and same-lane notes are 0.45 s apart
 * on 'hard', so a lane sitting AT REST AND READY wore the full "you reached your target" costume for
 * the entire inter-rep interval — (a)'s "how much further" readout was never drawn for a lane keeping
 * up at all, and the cue spilled into the next repetition's concentric phase, which is precisely when
 * augmented feedback stops being contingent.
 *
 * DURING THE `GOAL_MIN_SEC` OVERRUN THE TWO CLAIMS OF (b) COME APART, and `receptorGoalHolding` is
 * how every meter tells them apart: "that rep reached your target" is still true (KR marks stay),
 * "and you are still up there" is not (the position marks revert to their (a) form at the patient's
 * true height).
 *
 * SO A FLUID REP READS (a) → (b) → (a), AND (c) IS THE STALL STATE. That is a design claim and it is
 * worth stating, because it decides what a therapist sees most of the time. `GOAL_HOLD_SEC` (0.45 s)
 * is longer than the whole lockout of a rep performed at the chart generator's own pacing (0.22 s on
 * hard, 0.29 s on medium, 0.43 s on easy, crossing to re-arm), so a patient who is keeping up goes
 * from the goal cue straight back to the rising gauge. (c) appears when the lockout OUTLASTS the
 * cue — i.e. when the patient reaches target and stops, which is the single most common thing a
 * rehab patient does, or has slow eccentric control, or is 'unconfirmed' for one of the reasons
 * below. That is the moment "lower to reset" is information: a patient already descending at pace is
 * obeying an order they do not need to be given (the same reasoning `needsLower` applies inside (c)),
 * and cycling the receptor through three costumes inside a 0.45 s rep would cost more legibility at
 * 2 m than the instruction could buy back. What does NOT change is the honesty of the gauge: the
 * column is the same position on the same linear ROM axis in (b) as in (c), so the descent is drawn
 * to scale either way.
 *
 * THE CROSSING IS PUBLISHED, NOT GUESSED. Every source in this repo now ships
 * `LaneState.triggerState` — `VisionInput` from `LaneTrigger.state`, the scripted sources from
 * their held/free bit (src/input/laneStates.ts) — and `LaneTrigger` enters 'triggered' from one
 * place only: a rising edge past the threshold, from 'armed' (trigger.ts `push`). So "the lane
 * entered 'triggered'" IS "the input layer fired this lane", and the latch reads it directly.
 * The inference below is the fallback for a hand-built state that omits the field.
 *
 * AN ARMED → NOT-ARMED EDGE IS NOT ALWAYS A CROSSING, AND THAT IS WHY THE INFERENCE IS A FALLBACK
 * RATHER THAN THE RULE. `LaneTrigger`
 * disarms a lane for three different reasons, and only one of them is a rep:
 *   1. it crossed the threshold ('triggered') — the rep the latch exists for;
 *   2. `breakContinuity` — the sample stream was silent for longer than `maxGapSec`, so the lane
 *      goes to 'unconfirmed' AT WHATEVER VALUE IT HAS. VisionInput pushes a null sample for every
 *      untracked frame, so half a second of a lost knee landmark (hemiparesis, tremor, a therapist
 *      stepping past the tablet, a limb leaving frame) does exactly this — and the recovery frame is
 *      then published as `{ value: 0.95, armed: false }`, byte for byte the shape of a crossing,
 *      with NO `LaneInputEvent` and no `CompletedRep` behind it. Celebrating it is the precise lie
 *      this file was written to remove;
 *   3. `setThreshold` — a therapist making the song easier mid-song re-checks every lane's arming
 *      against the new re-arm level and disarms the ones that are not already below it.
 * When a source publishes `triggerState` none of that arises: cases 2 and 3 both land in
 * 'unconfirmed', the crossing is the 'triggered' entry, and neither an occlusion recovery nor a
 * retune can counterfeit it. For a state that omits the field the renderer refuses the edge unless
 * its evidence is still good, applying the trigger's own rule to itself ("an unobserved window is
 * not evidence"): the arming is forgotten when the last DISTINCT tracked sample is more than
 * `maxGapSec` old (case 2 — `RenderFrame.maxGapSec`, defaulting to `DEFAULT_MAX_GAP_SEC`, the same
 * 0.5 s VisionInput passes its triggers), and whenever the threshold or re-arm fraction changes
 * between frames (case 3).
 *
 * THOSE TWO RULES DO NOT TOUCH `prevTrigger`, AND THAT IS THE POINT. They expire an INFERENCE the
 * renderer made from timing; the published trigger state is the input layer's own continuity-
 * checked state machine, and a window this renderer did not watch does not make a later 'triggered'
 * less of a crossing (a break moves the lane to 'unconfirmed', so the transition it produces is
 * never a crossing anyway). Tying the two together is what broke state (b) on every scripted path:
 * `LaneStateCache` returns the SAME frozen objects while the held bitmask is unchanged, so a
 * patient at rest for longer than `maxGapSec` looked silent, the arming was forgotten, and no rep
 * that followed more than half a second of rest could ever produce a goal cue — on the very path
 * `CameraFallback` puts a patient on when the camera fails.
 *
 * THE REFRACTORY WINDOW IS RECONSTRUCTED, NOT IGNORED. `LaneTrigger` swallows a crossing that lands
 * within `minIntervalSec` (0.3 s) of the last EMITTED one: the lane still enters 'triggered', so the
 * latch used to fire for it, and a patient with clonus, a tremor or a bounce at end range got TWO
 * full acknowledgements against ONE step of the score (driven live: two crossings 0.2 s apart,
 * events=1, reps=2, two 0.15 s goal cues). The window is not published in `LaneState`, so the
 * renderer keeps the same ledger the trigger does — the time of the last crossing it credited — and
 * applies the same test — between INTERPOLATED crossing times, as the trigger does (`crossingTime`),
 * widened by one render step so it only ever refuses a crossing it is sure was swallowed. See
 * `REFRACTORY_GUARD_MIN_SEC` for what the residual band still lets through, and why that is the
 * right direction to leave it in.
 *
 * (The other residual this file used to carry — an UNREPORTED CAMERA STALL letting the gap rule
 * under-measure the trigger's silence — is closed by `triggerState`: a lane recovering from a stall
 * is 'unconfirmed', whatever the renderer believes about how long it has been since it last saw a
 * distinct sample.)
 *
 * The fallback guard errs the other way, deliberately: for a state with no `triggerState`, a RENDER
 * hitch longer than `maxGapSec` (a long GC pause, a backgrounded tab) also expires the arming, so a
 * crossing across it loses its acknowledgement even though it scored. That is the correct direction
 * to be wrong in — a missing cue costs one moment of knowledge-of-results on a frame the patient
 * could not see anyway, while a false one teaches the wrong movement and costs the display its
 * credibility.
 *
 * NOISE, AND WHY (d) IS DEBOUNCED. `tracking` comes straight off a per-frame hard visibility gate
 * (src/vision/landmarks.ts, MIN_VISIBILITY) via src/vision/pipeline.ts, and nothing in the chain
 * debounces it. A landmark chattering across that gate — marginal framing, motion blur at peak rep
 * velocity, exactly the conditions of a real clinic — would strobe the whole receptor row between a
 * full gauge and "?" at frame rate. During Play the receptor is the patient's only out-of-frame
 * signal, so it has to be stable. So (d) is entered by the CURRENT UNINTERRUPTED DARK RUN reaching
 * `LOST_HOLD_SEC`, and left by the first tracked frame. `ReceptorLook.stale` reports the hold while
 * the last tracked look is being replayed. A lane that has NEVER been tracked (including one with no
 * `LaneState` at all) skips the hold and reads (d) immediately — for an absent measurement the
 * honest default is "I cannot see you", not a live, at-rest gauge.
 *
 * AND WHY THE DEBOUNCE IS A TIMEOUT AND NOT A DUTY CYCLE. This file used to spend a DARKNESS BUDGET
 * instead — untracked time debited, tracked time forgiven at a rate set by a 50 % `LOST_DUTY_FLOOR`,
 * (d) latched with a Schmitt trigger — on the theory that "a tracker that is mostly dead must not be
 * able to suppress (d) with one lucky frame per cycle, because the reps performed inside its dark
 * windows score nothing". THE SECOND HALF OF THAT SENTENCE IS FALSE, and it was never checked
 * against the input layer. `LaneTrigger` keeps a lane's arming across ANY break up to `maxGapSec`
 * (0.5 s) and interpolates the crossing across it (src/vision/trigger.ts `breakContinuity`,
 * `push`), so a rep performed half in the dark still fires, still emits its `LaneInputEvent` and
 * still scores. Driven end to end (real `LaneTrigger`, 1.2 s reps, 30 fps camera, 60 Hz render,
 * 20 s) the duty floor read:
 *
 *     duty 1.00 → 17 events, 17 goal cues,  0 % of frames "lost"
 *     duty 0.52 → 16 events,  5 goal cues, 47 %
 *     duty 0.48 → 15 events,  5 goal cues, 51 %
 *     duty 0.42 → 17 events,  0 goal cues, 97 %
 *     duty 0.33 → 17 events,  1 goal cue,  97 %
 *
 * i.e. a session in which the score odometer, the hit bursts and the judgment popups all fire for
 * every rep while the receptor row says "I cannot see you" on 97 % of frames and the patient loses
 * knowledge of results — the one therapeutic ingredient this file exists to protect — for sixteen
 * reps out of seventeen. A 4 % change in tracking duty flipped the display between a flawless gauge
 * and a session-long "?". The receptor's contract is that it means exactly what the input engine
 * means, and a duty cycle is not a quantity the engine has any opinion about: what the engine cares
 * about is the LENGTH OF THE CURRENT GAP, which is what the rule now measures.
 *
 * WHAT THAT COSTS, AND WHY IT IS THE RIGHT DIRECTION. A stream whose gaps are longer than
 * `LOST_HOLD_SEC` now shows (d) during each gap and the live gauge in between — 1-in-15 tracked
 * frames at 30 fps (0.47 s gaps) reads "lost" about half the time, which is an honest report of a
 * half-dark stream, and the flicker is bounded below by the hold so visibility-gate chatter (gaps of
 * one to five frames) never produces it at all. A frame on which the receptor says (d) is a frame on
 * which `LaneState.tracking` is false and the input layer HAS NO MEASUREMENT EITHER: what
 * `VisionInput` pushes for it is a NULL sample, which cannot cross anything, so no `LaneInputEvent`
 * can be emitted on it. (d) therefore never
 * contradicts a rep that scored, and the frame the engine DOES fire on — the first tracked frame
 * after the gap, crossing interpolated back across it — is a frame on which the hold has already
 * been released, so its KR cue is drawn. That agreement is pinned end to end in `receptor.test.ts`
 * ("the receptor may not call a lane lost while the engine is scoring it").
 *
 * AND WHILE THE SESSION IS NOT ACCEPTING INPUT, THE HONEST READING IS "NO READING" — for every
 * lane, at every value. A therapist pause is the most-used control on the play screen and it is the
 * "mid-song stop" case: `GameRunner` keeps drawing every animation frame and keeps handing this
 * model LIVE `getLaneStates()` (the camera never stops for a pause), while `RhythmEngine` drops any
 * event stamped inside the pause — not judged, not scored, not even recorded. Nothing in this file
 * used to know a pause existed, so a patient repositioned by their therapist mid-pause produced the
 * full knowledge-of-results costume for an input the engine discarded: measured on the real app,
 * eleven consecutive frames of `goal === 1` with score/reps/hits flat at 0/0/0. That is the one hard
 * fail of a concurrent-feedback display — a celebration for a rep that scored nothing — and it came
 * with the other half of the same lie, because for the rest of the pause the same gauge read (a)
 * "armed, rising, ready" when the true answer to "what will the input layer do with your next rep"
 * was "nothing".
 *
 * So `RenderFrame.inputSuspended` (built from the runner's own phase, which is the only thing that
 * knows) reaches `update` as `suspended`, and while it is set the look is the SAME "no reading" look
 * a dead tracker produces — `tracking: false`, nothing value-derived, `receptorMarkSet` 'lost' —
 * plus `ReceptorLook.suspended`, which changes only the GLYPH inside the broken ring (see
 * `Highway.drawLostReceptor`). Same mark set on purpose: at 2 m the statement is the same statement,
 * the patient's remedy is the same (none — it is the therapist's move), and the words that separate
 * the two are already on the same screen, in the pause overlay the stop came from. It is the reading
 * `Highway.setLaneFaults` already chose for a lane the input layer has refused, for the same reason.
 *
 * THE EVIDENCE KEEPS BEING GATHERED THROUGH IT, AND THAT IS WHAT MAKES THE RESUME HONEST. Exactly
 * three things change while suspended: no crossing is CREDITED (so no latch — and, the expensive
 * half, the refractory ledger `emittedT` is not written), any latch already lit is dropped instead
 * of being held over the stop, and the output is the "no reading" one. The per-lane record
 * underneath — `prevTrigger`, the arming, the observed peak, the dark run — keeps being fed from the
 * live states, so a rep performed DURING the pause moves the state machine exactly as it really did
 * and cannot be re-read as a crossing on the first frame after the resume. Freezing the record
 * instead would be worse than the bug it fixed: a patient still holding at end range when the
 * therapist resumes would arrive as an 'armed' → 'triggered' edge across the stop and be celebrated
 * for a rep that fired into a paused engine.
 *
 * AND THE LEDGER IS WHY THE CREDIT HAS TO BE WITHHELD AND NOT MERELY HIDDEN. `emittedT` is the
 * refractory reconstruction's base (see `REFRACTORY_GUARD_MIN_SEC`): a phantom crossing stamped into
 * it during a pause would suppress the acknowledgement of the first REAL rep performed within
 * `minIntervalSec` of it after the resume — under-celebrating a rep that scored, the one error
 * direction this file argues must never happen.
 *
 * WHAT IT COSTS is one frame at the boundary, in the safe direction. A crossing the input layer
 * processed in the few milliseconds between `pause()` and the next draw is still judged (the engine
 * judges an event STAMPED before the pause point — a camera crossing captured just before the stop
 * and delivered ~100 ms later must not lose its rep) and will not be acknowledged here. A missing
 * cue on the frame the patient is being told the session has stopped costs one moment of knowledge
 * of results; a false one teaches the wrong movement.
 *
 * `receptorLookInto` collapses one `RenderLaneState` into what the receptor should read;
 * `ReceptorHistory.update` adds the two things a single frame cannot know (the crossing latch and
 * the tracking hold). The renderer positions every mark on ONE LINEAR ROM AXIS (`Highway.meterPos`:
 * full ROM at the top of the well, the target line at `thresholdFraction` of it, the re-arm line at
 * `thresholdFraction * rearmFraction`), so a given movement is the same distance on screen wherever
 * in the range it is made — during the rise and during the return alike. What differs between the
 * states is not the scale but the SET OF MARKS (see `Highway.drawReceptors`):
 * (a) one continuous level line + the target line and its two upright gate posts, (b) those
 * plus liquid above the target line, a level cap SPLIT into two white-hot segments, two additive
 * rings, and the posts replaced by two solid arrowheads, (c) a desaturated ring whose column stands
 * at the patient's true height and travels down through the target height as they lower, with a
 * violet drain cap on it, a dashed re-arm line, a "lower to reset" chevron and a return-to-rest
 * crescent UNDER the ring (`Highway.RESET_ARC_SWEEP` bounds it to the ring's lower half, so that a
 * nearly re-armed lane cannot read as the two concentric rings that carry (b))
 * — all four of which move for the WHOLE descent, from the patient's real peak down to the re-arm
 * line — and no level line, target line or halo at all, and
 * (d) the only ring on the board with gaps in it, plus a "?", and nothing else. (The chevron and the
 * violet drain cap are keyed to `needsLower`, not to `locked`: a locked lane that is ALREADY below
 * the re-arm line keeps the rest of (c) but stops ordering the patient down.)
 */
import { clamp } from './geometry';

/**
 * Default hysteresis re-arm fraction: the lane re-arms once its value falls below
 * `thresholdFraction * REARM_FRACTION`. Matches the vision trigger detector in the architecture
 * contract (`src/vision/trigger.ts` exports the same default); override per frame with
 * `RenderFrame.rearmFraction` if a session tunes it.
 */
export const DEFAULT_REARM_FRACTION = 0.6;

/**
 * Default break-in-the-stream window, mirroring `DEFAULT_MAX_GAP_SEC` in src/vision/trigger.ts (and
 * `VisionInput.staleFrameSec`, which is what VisionInput actually passes its triggers). A sample
 * arriving more than this long after the previous OBSERVED one is a break: `LaneTrigger` throws its
 * arming away, because a whole rep could have started and finished inside a window nobody watched.
 *
 * The receptor has to apply the same rule to its own evidence — see `ReceptorHistory.update`. It is
 * a renderer-side mirror of a number the input layer owns, so `RenderFrame.maxGapSec` overrides it
 * for a session that tunes `staleFrameSec`; `receptor.test.ts` asserts the two defaults agree.
 */
export const DEFAULT_MAX_GAP_SEC = 0.5;

/**
 * MINIMUM span for the overshoot READOUT (`ReceptorLook.over`), as a fraction of the threshold —
 * the floor that keeps `over` from dividing by a vanishing range when the threshold is set at or
 * near full ROM. See `meterOverSpan`.
 */
export const METER_OVER_RANGE = 0.5;

/**
 * The ROM distance `ReceptorLook.over` is measured over: from the threshold to full ROM
 * (`1 - thresholdFraction`), floored at `thresholdFraction * METER_OVER_RANGE` so a near-full-ROM
 * threshold cannot collapse it to zero.
 *
 * THIS IS A READOUT, NOT THE RENDERER'S SCALE. `Highway.drawReceptors` positions every mark in the
 * well with `meterPos`, one linear map from ROM to height (full ROM at the ceiling, the target line
 * at `thresholdFraction` of it), so nothing on screen depends on this span. It used to: the well was
 * two bands either side of a target line pinned at a fixed height, and the band above it had to be
 * wide enough not to saturate before full ROM — which stopped the column pinning but still drew the
 * whole of the ROM above the threshold at up to 4.5x the compression of the ROM below it, on the
 * default 'easy' difficulty. `over` survives as what it always described: how far past their target
 * the patient got, as a fraction of the range they had left.
 */
export function meterOverSpan(thresholdFraction: number): number {
  const threshold = clamp(thresholdFraction, 0.05, 1);
  return Math.max(1 - threshold, threshold * METER_OVER_RANGE);
}

/**
 * CEILING on the goal-attainment look (b): how long it is held at full strength after the threshold
 * crossing *if the lane is still locked out the whole time*. Knowledge of results is the therapeutic
 * ingredient here, and the crossing itself lasts one 33 ms camera frame — far below the ~100 ms a
 * patient mid-rep can be expected to catch, and far below the hit burst it has to stand alongside.
 * 0.45 s sits between the judgment popup (0.5 s) and the re-arm pop (0.28 s), so the three cues read
 * as one sequence rather than as a flicker.
 *
 * IT IS A CEILING, NOT THE DURATION. The latch is cut short by the RE-ARM — see `GOAL_MIN_SEC` and
 * `ReceptorHistory.update`. This number only governs a patient who is still holding at end range.
 */
export const GOAL_HOLD_SEC = 0.45;
/**
 * Ramp at the end of the hold. The marks of (b) stay until `goal` reaches 0; the ramp is what the
 * renderer glides the ring scale, the ring alpha and the liquid column down with, so the gauge
 * settles into the lockout look (c) instead of stepping down 12 % at the moment of success.
 *
 * It only ever runs for a lane that is STILL LOCKED at `GOAL_HOLD_SEC` — i.e. one being held at end
 * range, where (b) really does hand over to (c). A lane that re-arms first ends the latch on the
 * re-arm edge instead (see `GOAL_MIN_SEC`), and there is nothing to glide into: the ring is already
 * at live size and the re-arm pop fires on that very frame.
 */
export const GOAL_FADE_SEC = 0.15;
/**
 * FLOOR on the goal-attainment look (b), and the one place two requirements pull against each other.
 *
 * (1) KR must be perceptible. The crossing lasts one 33 ms camera frame; the motor-learning value of
 *     concurrent feedback is nil if the patient cannot catch it mid-rep, so the cue has to be on
 *     screen for at least ~150 ms.
 * (2) KR must not outlive what it reports. The moment the lane RE-ARMS, the true statement about the
 *     lane changes from "that rep reached your target" to "go again"; a cue that keeps claiming the
 *     first through the next repetition's concentric phase is non-contingent feedback, which is the
 *     failure mode this whole file exists to avoid.
 *
 * On a brisk rep these collide: driven through a real `VisionInput` + `LaneTrigger` at the chart
 * generator's own pacing (0.4 s rep, threshold 0.5, re-arm 0.6), the crossing-to-re-arm interval is
 * ~0.10-0.13 s — shorter than (1) needs. So the latch ends at the re-arm, **but never before
 * `GOAL_MIN_SEC` has elapsed since the crossing**, and the overrun that buys is bounded by this
 * number: at most 0.15 s, typically one or two frames.
 *
 * WHAT THE OVERRUN MAY AND MAY NOT DRAW. During it the lane is armed and (usually) back near rest,
 * and every mark that encodes a POSITION — the liquid's material, the level cap — reverts to its
 * (a) form and stands at the patient's true height. What stays is the KR itself: the additive inner
 * rim and corona (the second concentric ring, which is what actually separates (b) from (a) at a
 * 220 px downscale) and the two solid arrowheads at the target line. Those are claims about the rep
 * just made, which is still true; a white-hot split cap at the floor of the well is a claim about
 * where the patient is, which is not. See `Highway.drawReceptors` and `receptorGoalHolding`.
 *
 * 0.15 s also sits an order of magnitude inside the tightest inter-rep interval the game asks for
 * (0.45 s same-lane spacing on 'hard', src/charts/generate.ts), so the cue cannot reach the next
 * repetition's concentric phase even in the worst case.
 */
export const GOAL_MIN_SEC = 0.15;

/**
 * THE LENGTH OF DARKNESS (d) IS ENTERED ON: how long the last tracked look is held before the
 * receptor admits it cannot see the patient. Long enough to swallow the visibility-gate chatter
 * described above (a few frames at 30 fps), short enough that a patient who has actually left frame
 * is told so within a fifth of a second.
 *
 * It is measured on the CURRENT UNINTERRUPTED DARK RUN — "how long since the last frame that carried
 * a measurement" — and a tracked frame resets it to zero. That is the same quantity `LaneTrigger`
 * measures its own continuity on (`maxGapSec`), one notch more cautious: the trigger keeps a lane
 * scorable across a gap of up to 0.5 s, while the receptor stops claiming to see the patient after
 * 0.2 s of it. Under-claiming in that window costs nothing the patient can act on (there is no
 * measurement to gauge from either way) and never contradicts a score, because no event can be
 * emitted on a frame with no sample. See the file header for the duty-cycle rule this replaced and
 * the measurements that condemned it.
 */
export const LOST_HOLD_SEC = 0.2;


/**
 * THE INPUT LAYER'S REFRACTORY WINDOW, mirrored here the way `DEFAULT_MAX_GAP_SEC` mirrors the
 * trigger's continuity window: the minimum interval between two EMITTED `LaneInputEvent`s
 * (`src/vision/trigger.ts`, `DEFAULT_MIN_INTERVAL_SEC`). A crossing that lands inside it still
 * enters 'triggered' — the lane really does lock out, and `VisionInput` really does report the rep,
 * with `LaneRepEvent.emitted: false` — but no event is sent and nothing scores.
 *
 * IT IS OPT-IN, AND THAT IS NOT A DEFAULT-OFF SAFETY VALVE BUT A FACT ABOUT THE SOURCES. Only
 * `LaneTrigger` has this window: `KeyboardInput`, `ReplayInput` and `AutoplayInput` emit every
 * crossing they are given, however close together, so reconstructing a refractory window on those
 * paths would refuse an acknowledgement for a rep that really did score. The receptor therefore
 * applies it only when the frame carries the number (`RenderFrame.minIntervalSec`, which
 * `GameRunner` forwards from `VisionInput.minIntervalSec` on the camera path and leaves undefined on
 * the scripted ones) — exactly the shape `maxGapSec` already has.
 */
export const DEFAULT_MIN_INTERVAL_SEC = 0.3;

/**
 * FLOOR on the slack the renderer allows itself when reconstructing the refractory window — the
 * margin by which a measured inter-crossing interval may fall short of `minIntervalSec` and still be
 * celebrated. Suppressing knowledge of results for a rep that really scored is the expensive error
 * (it is the therapeutic ingredient), so the renderer never refuses a crossing it is not sure the
 * trigger swallowed, and the margin is how sure it insists on being.
 *
 * THE MARGIN IS THE RENDERER'S OWN STEP — see `refractoryGuard`. This is only the floor under it,
 * for a renderer whose step is reported as zero (a repeated timestamp, a synthetic clock), which
 * would otherwise demand the interval be exact and refuse a crossing on a rounding error. Half a
 * 60 Hz frame.
 *
 * THE MARGIN USED TO BE A FLAT 0.05 s, SIZED FOR A COARSER RECONSTRUCTION THAN THE ONE THIS FILE NOW
 * DOES. The renderer used to time a crossing by the render frame on which it first saw the lane
 * enter 'triggered', while `LaneTrigger` times it by INTERPOLATION between the two samples that
 * bracket the threshold — so the two clocks differed by up to a camera frame plus a render frame at
 * each end, and the guard had to cover all of it. Swept on a real trigger at `minIntervalSec` 0.3
 * (30 fps camera, 60 Hz render, two crossings `sep` apart), that left a measured 0.27-0.30 s band in
 * which the receptor threw a full KR cue for a crossing the input layer had swallowed: one step of
 * the score, two celebrations — and 3.3-3.7 Hz is exactly where a clonus beat or an end-range bounce
 * lives.
 *
 * `crossingTime` now runs the trigger's own interpolation on the renderer's own timestamps, which
 * takes the camera quantisation out of the estimate, and the margin is the render step. Re-swept on
 * the same rig: separations up to 0.28 s give one event and ONE cue, 0.305 s and up give two events
 * and two cues, and the residual band is ~0.285-0.30 s — one render step wide where it was three.
 *
 * IT IS DELIBERATELY NOT NARROWER THAN THE RENDERER'S OWN CLOCK. Swept again with the render loop at
 * 10 Hz, no crossing the trigger emitted loses its acknowledgement; a FIXED 0.05 s margin did
 * suppress one there (two crossings 0.34 s apart), which is the expensive direction. A margin that
 * tracks the step is right at both ends.
 */
export const REFRACTORY_GUARD_MIN_SEC = 0.008;

/**
 * The margin to allow for a render step of `step` seconds — see `REFRACTORY_GUARD_MIN_SEC`.
 *
 * `crossingTime` reconstructs a crossing as `t0 + f * (t1 - t0)` from the render timestamps of the
 * two samples that bracket the threshold, using the same fraction `f` the trigger uses. Each of
 * those timestamps is the camera frame's time plus the wait until the render poll that first saw it,
 * which is in `[0, step)`, so for a true crossing at `c` the reconstruction lands in `[c, c + step)`
 * and the difference of two of them is in `(-step, step)`. One step is therefore exactly the
 * uncertainty, and demanding any more accuracy than that is claiming an accuracy the renderer does
 * not have.
 */
export function refractoryGuard(step: number): number {
  const s = Number.isFinite(step) && step > 0 ? step : 0;
  return Math.max(REFRACTORY_GUARD_MIN_SEC, s);
}

/** What the receptor should read for one lane this frame. */
export interface ReceptorLook {
  /** Meter fill 0..1 against the trigger threshold (1 = at or past `thresholdFraction`). */
  fill: number;
  /**
   * Overshoot 0..1: how far *past* the threshold the value is, over `meterOverSpan(threshold)` of
   * ROM (the threshold → full ROM). 0 whenever `fill < 1`, and it does not saturate anywhere inside
   * the reachable range, so `fill + over` together are a strictly monotone read-out of the
   * patient's position over the whole of `[0, 1]` ROM.
   *
   * A READOUT FOR CONSUMERS, NOT A DRAWING INPUT — say, "cleared the target by this much", the
   * ROM-achieved number a therapist is after. The receptor draws every height from `rom` through
   * `Highway.meterPos`, one linear ROM axis with the target line at `thresholdFraction` of it, so a
   * given movement covers the same distance on screen wherever in the range it is made; `fill` and
   * `over` are the same position expressed against the threshold instead.
   */
  over: number;
  /**
   * Goal-attainment strength 0..1 — the LATCHED form of "this rep reached the target". 1 on and
   * just after the threshold crossing. `goal > 0` is state (b) and is the only thing that earns the
   * "this counts" marks.
   *
   * IT ENDS WHEN THE LANE RE-ARMS (floored at `GOAL_MIN_SEC` so the cue is catchable at all, capped
   * at `GOAL_HOLD_SEC + GOAL_FADE_SEC` for a patient who keeps holding at end range). The re-arm is
   * the moment the true statement about the lane changes from "that rep reached your target" to "go
   * again", and at the game's own pacing it arrives ~0.1 s after the crossing, not 0.6 s — a fixed
   * 0.6 s latch left a lane sitting AT REST AND READY wearing the full goal costume for the whole
   * inter-rep interval, which on 'hard' (0.45 s same-lane spacing) is every frame of every rep.
   *
   * DURING THE `GOAL_MIN_SEC` OVERRUN `locked` IS ALREADY FALSE, and consumers must honour it: see
   * `receptorGoalHolding`. The KR marks (the second ring, the arrowheads) are true then; the marks
   * that encode where the patient IS are not, and must be drawn in their (a) form.
   *
   * ONLY `ReceptorHistory.update` EVER SETS IT NON-ZERO, because only it can see the crossing: the
   * crossing frame is published already disarmed (see the file header), so there is no single-frame
   * test for it and this file offers none. `receptorLookInto` on its own always writes 0 — a
   * consumer that skips the history therefore gets a meter with no "this counts" cue at all, which
   * is a visible hole rather than a cue that silently never fires.
   *
   * Optional only so that a hand-built look literal written against the older shape still
   * type-checks; every function here writes it, so read it as `look.goal ?? 0`.
   */
  goal?: number;
  /**
   * True when the lane is locked out by hysteresis: it has fired (or has never been confirmed below
   * the re-arm level), so nothing the patient does can score until the value falls below
   * `thresholdFraction * rearmFraction`. Independent of `fill` — an unconfirmed lane below the
   * threshold is just as unable to fire. False while `tracking` is false: (d) outranks (c).
   *
   * `locked` and `goal > 0` overlap for MOST of the latch, and that is not a contradiction: the lane
   * really has fired and really cannot fire again. The renderer resolves it by drawing (b) for the
   * latch and (c) after it — first "you got there", then "now come back down".
   *
   * THEY COME APART AT THE RE-ARM, AND THIS FLAG IS THE ONE THAT IS LIVE. The latch is cut short by
   * the re-arm (see `goal`), but not below `GOAL_MIN_SEC`, so for up to 0.15 s a look can carry
   * `goal > 0` with `locked === false`: the rep just scored AND the lane is ready again. Both are
   * true. A consumer that reads `goal > 0` alone and paints the whole "at/above target, held" look
   * off it will draw a full gauge for a lane standing at rest — exactly the defect the re-arm bound
   * exists to remove. Use `receptorGoalHolding` for anything that claims a position.
   */
  locked: boolean;
  /**
   * How much of the RETURN JOURNEY the patient has actually given back, 0..1, while locked
   * (1 = at or below the re-arm level, i.e. the next rep is about to start counting). 0 when
   * unlocked.
   *
   * MEASURED FROM WHERE THEY REALLY STARTED, which is `peakRom`: the journey is
   * `peakRom → thresholdFraction * rearmFraction` of ROM, and this is the fraction of it travelled.
   * It used to be measured in *clamped fill* units — `(1 - fill) / (1 - resetLevel)` — which
   * reported 0 for EVERY value at or above the threshold, so a patient who had genuinely lowered
   * from full ROM to the threshold (71 % of the descent on the default 'easy' difficulty) was told
   * they had given back nothing, and every mark driven by this number sat motionless for the first
   * and largest part of the descent. A gauge that flatlines while the patient performs the movement
   * it is asking for is worse than no gauge.
   *
   * A single frame cannot know `peakRom`, so `receptorLookInto` falls back to
   * `max(value, thresholdFraction)` — which reproduces the old reading exactly below the threshold
   * and reads 0 above it. `ReceptorHistory.update` supplies the real observed peak; it is what the
   * renderer draws from.
   */
  resetProgress: number;
  /**
   * The lane's value as a fraction of calibrated ROM — `LaneState.value`, clamped to the range the
   * calibration can produce (`[0, 1]`, with headroom to 1.5 for a synthetic/out-of-contract state).
   * `fill` and `over` are this same number expressed against the threshold; this is the raw units
   * the return journey and `peakRom` are measured in. Meaningless when `tracking` is false.
   *
   * Optional for the same reason as `goal`; always written by the functions here.
   */
  rom?: number;
  /**
   * The highest `rom` observed since this lockout began — the top of the return journey, and the
   * denominator of `resetProgress`. Equal to `rom` whenever the lane is not locked (there is no
   * journey in progress), and never below `thresholdFraction` while locked, because a lane locks
   * out by crossing the threshold and a lane that has never been confirmed is treated as having
   * come from there rather than from wherever it happens to be sitting.
   *
   * ONLY EVER RAISED, never decayed. A spurious landmark spike sets a peak the patient never
   * reached, which makes the gauge UNDER-report their progress for that descent; decaying the peak
   * back toward the current value would instead make the arc creep forward while the patient holds
   * perfectly still, which is a lie in the one state whose whole message is "you have not given
   * anything back yet". Under-reporting is the correct direction to be wrong in, and the arc still
   * completes exactly on the re-arm line either way.
   *
   * Optional for the same reason as `goal`; always written by the functions here.
   */
  peakRom?: number;
  /**
   * True while the lane is locked AND not yet below the re-arm level — i.e. the patient really does
   * have somewhere to lower to. (At the line exactly it is still true: `LaneTrigger` re-arms on
   * `value < rearmLevel`, strictly, so "on the line" is one notch short.) The "lower to reset" instruction (the drain cap read as a thing to
   * bring down, and the chevron) is drawn from THIS, not from `locked`.
   *
   * A locked lane can sit BELOW the re-arm line: 'unconfirmed' is a statement about what has been
   * observed, not about the current value. Telling that patient to lower further is an instruction
   * they cannot carry out — they are already past the line they are being pointed at. The lane still
   * cannot score, so it is still (c) and still says so; it just stops giving an order that is
   * already obeyed, and its return-to-rest crescent is complete.
   *
   * THE ONE CAUSE THAT REALLY PRODUCES IT IS `LaneTrigger.reset()`, i.e. a calibration replaced
   * mid-session (`VisionInput.setCalibration`), and then only until the next camera frame. This used
   * to name three causes and driven against the real trigger the other two are impossible — pinned
   * in `receptor.test.ts` ("names the ONE cause that really produces a locked lane below the re-arm
   * line"):
   *   - `setThreshold` disarms only the lanes NOT already below the NEW re-arm level
   *     (src/vision/trigger.ts), so the value it leaves 'unconfirmed' at is at or above that level
   *     and `needsLower` is TRUE;
   *   - a stream break does leave the lane 'unconfirmed' at whatever value it had, but the push that
   *     ends the break re-arms it in the same call when the recovered value is below the re-arm
   *     level, before `VisionInput` reads `trigger.state` — so a patient who comes back at rest is
   *     published 'armed', never locked.
   * It is kept for the reset case and for the scripted and hand-built states that can reach it: it
   * costs two `if`s and removing it would put an unobeyable order on screen.
   *
   * Optional for the same reason as `goal`; always written by the functions here.
   */
  needsLower?: boolean;
  /** Height of the re-arm line inside the ring, as a fraction of the meter (0..1). */
  resetLevel: number;
  /** Halo / glow target 0..1. Zero whenever the lane cannot fire, except during the goal latch. */
  glowTarget: number;
  /**
   * False when the tracker has lost the limb / hand *and* the `LOST_HOLD_SEC` hold has expired (or
   * this lane was never tracked at all). Every other field is then meaningless and the renderer
   * draws nothing derived from a value: a broken, slowly breathing ring and a "?", and no fill,
   * level line, target line, halo, lock cue or beat pulse. See `Highway.drawLostReceptor`.
   */
  tracking: boolean;
  /**
   * True while the look is the LAST TRACKED one, replayed during the `LOST_HOLD_SEC` anti-strobe
   * hold: `tracking` is still true and the gauge still draws, but the numbers are up to
   * `LOST_HOLD_SEC` old. Nothing in the renderer needs to treat it specially — it exists so a
   * consumer that logs or scores off a look can tell a measurement from a held one.
   *
   * Optional for the same reason as `goal`; always written by the functions here.
   */
  stale?: boolean;
  /**
   * True when this look says "no reading" because THE SESSION IS NOT ACCEPTING INPUT — a therapist
   * pause, a mid-song stop — rather than because the tracker lost the patient. See the file header.
   *
   * `tracking` is false either way and `receptorMarkSet` reads 'lost' either way, and that is
   * deliberate: the mark set is the patient's REMEDY, and neither state has one. This flag exists
   * for the one mark that is read at arm's length rather than at 2 m — the glyph inside the broken
   * ring — so a therapist can tell "the camera cannot see this lane" from "I stopped the session".
   *
   * Optional for the same reason as `goal`; always written by the functions here.
   */
  suspended?: boolean;
}

/**
 * Which of the four MARK SETS a look wears. The four states differ by the number and shape of the
 * marks drawn, not by brightness or hue (see `Highway.drawReceptors`), so this is the one place that
 * decides which set a look is in — and it is exported because it is the answer EVERY live meter on
 * screen has to give at the same instant.
 *
 * ONE VOICE. The receptor row is not the only movement meter in the patient's field of view: the
 * play screen's picture-in-picture lane meters sit next to the camera preview for the whole session
 * (src/ui/Play.tsx). They used to be drawn from their own single-frame reading, which had no
 * crossing latch at all, so on the frame the patient reached their target the receptor threw the
 * full goal look and the meter 300 px away went straight to the grey "lower to reset" costume. Two
 * meters disagreeing at the one moment that matters is worse than either being wrong on its own.
 * They are now drawn from THE SAME LOOK OBJECTS the receptor row resolved on that frame
 * (`Highway.receptorLookOf`), classified here — not from a second history on a second clock, which
 * left them up to `SONG_CLOCK_STALL_SEC` out of step during an audio-clock stall.
 *
 * The order is the precedence order and it is not arbitrary: no measurement outranks everything
 * (nothing derived from a value may be drawn), the crossing outranks the lockout it causes (the
 * patient is told "you got there" before "now come back down"), and a locked lane outranks its own
 * level (a lane that cannot fire may wear no part of the "this counts" costume at any value).
 */
export type ReceptorMarkSet = 'lost' | 'goal' | 'locked' | 'rising';

/** Classify a look into its mark set — see `ReceptorMarkSet`. */
export function receptorMarkSet(look: ReceptorLook): ReceptorMarkSet {
  // 'lost' also covers the two states that have no PATIENT-side remedy and therefore no mark set of
  // their own: a lane the input layer has refused (`Highway.setLaneFaults`) and a session that is
  // not accepting input at all (`ReceptorLook.suspended`). Both are "there is no reading here",
  // which is what this set means and what it draws; only the glyph inside the ring tells them apart.
  if (!look.tracking) return 'lost';
  if ((look.goal ?? 0) > 0) return 'goal';
  if (look.locked) return 'locked';
  return 'rising';
}

/**
 * Within mark set 'goal', is the lane STILL HOLDING the rep it is being congratulated for?
 *
 * The (b) costume makes two different claims, and they expire at different moments:
 *   - "this rep reached your target" — a fact about a rep that happened, still true for the whole
 *     latch. Carried by the KR marks: the additive inner rim + corona (one more concentric ring than
 *     any other state has, which is what separates (b) from (a) at a 220 px downscale) and the two
 *     solid arrowheads at the target line.
 *   - "…and you are still up there, holding it" — a fact about the patient RIGHT NOW, which stops
 *     being true the instant the patient comes down off the target. Carried by the position marks:
 *     the hot liquid material and the split white-hot level cap, plus the forced halo.
 * The latch is cut at the re-arm, but never before `GOAL_MIN_SEC`, so the second claim can outlive
 * its truth by up to 0.15 s unless somebody checks. This is that check, and it is exported for the
 * same reason `receptorMarkSet` is: EVERY live meter in the patient's field of view has to resolve
 * it the same way, from the same numbers, on the same frame.
 *
 * IT TESTS THE LEVEL, NOT ONLY THE LOCKOUT, and the difference is most of a second of the eccentric
 * phase. `locked` runs from the crossing to the RE-ARM line (`thresholdFraction * rearmFraction`),
 * which is well below the target: on the default session (threshold 0.65, re-arm 0.6) a rep is
 * locked all the way down to 0.39 of ROM. Keying "you are still up there" to the lockout alone
 * therefore drew the hot column and the split white-hot cap while the patient's level was visibly
 * BELOW the dashed target line on the same gauge — measured on a real `VisionInput` rep, ~0.13 s of
 * it — which is the gauge contradicting itself. The rep is still in hand (the KR marks stay, keyed
 * to `receptorMarkSet(look) === 'goal'`); the patient is simply not up there any more.
 */
export function receptorGoalHolding(look: ReceptorLook): boolean {
  return (look.goal ?? 0) > 0 && look.locked && look.fill >= 1;
}

/** Shape of the per-lane state this reads (structurally `RenderLaneState`). */
export interface LaneStateLike {
  value: number;
  armed: boolean;
  tracking?: boolean;
  /**
   * The input layer's OWN trigger state. `armed` collapses 'unconfirmed' and 'triggered' into one
   * flag, and the difference between them is exactly the difference between "this rep fired" and
   * "this lane has never been confirmed", which is what the crossing latch has to guess at
   * otherwise (see `ReceptorHistory.update`). When it is present the receptor reads it instead of
   * guessing, and `armed` is derived from it so the two can never disagree.
   *
   * Published by every source in this repo: `VisionInput` from `LaneTrigger.state`, the scripted
   * sources from their held bit (src/input/laneStates.ts). For a hand-built state that omits it,
   * the latch falls back to the edge rule and the gap rule below.
   */
  triggerState?: 'unconfirmed' | 'armed' | 'triggered';
}

/** A zeroed look, for callers that need one to pass to `receptorLookInto` / `ReceptorHistory`. */
export function emptyReceptorLook(rearmFraction: number = DEFAULT_REARM_FRACTION): ReceptorLook {
  return {
    fill: 0, over: 0, goal: 0, locked: false, needsLower: false,
    resetProgress: 0, rom: 0, peakRom: 0, resetLevel: rearmFraction, glowTarget: 0, tracking: true, stale: false,
    suspended: false,
  };
}

/**
 * Copy a look into an existing one (allocation-free). Exported because `Highway` publishes the
 * looks it drew this frame to the play screen's picture-in-picture meters — see `ReceptorMarkSet`,
 * "ONE VOICE": the two meters must not merely agree, they must be the same numbers.
 */
export function copyReceptorLook(out: ReceptorLook, src: ReceptorLook): ReceptorLook {
  return copyLook(out, src);
}

function copyLook(out: ReceptorLook, src: ReceptorLook): ReceptorLook {
  out.fill = src.fill;
  out.over = src.over;
  out.goal = src.goal ?? 0;
  out.locked = src.locked;
  out.needsLower = src.needsLower ?? false;
  out.resetProgress = src.resetProgress;
  out.rom = src.rom ?? 0;
  out.peakRom = src.peakRom ?? src.rom ?? 0;
  out.resetLevel = src.resetLevel;
  out.glowTarget = src.glowTarget;
  out.tracking = src.tracking;
  out.stale = src.stale ?? false;
  out.suspended = src.suspended ?? false;
  return out;
}

/**
 * Fill an existing `ReceptorLook` (allocation-free; the renderer calls this once per lane per
 * frame). SINGLE-FRAME ONLY: `goal` is always 0 (the crossing cannot be seen in one frame) and
 * tracking is not debounced — go through `ReceptorHistory.update` for the state the receptor is
 * actually drawn from, or the meter you build will have no state (b) at all.
 *
 * `state` may be undefined, and that is NOT an idle lane: a lane with no meter has no measurement,
 * so it reads as (d) tracking lost. (`GameRunner`'s first frame ships `laneStates: []`; drawing
 * four live, at-rest gauges for it would be the same lie as a meter pinned under a dead camera.)
 *
 * `peakRom` is the one number a single frame cannot supply: the top of the return journey
 * `resetProgress` is measured from (see `ReceptorLook.peakRom`). Omit it and the journey is
 * measured from `max(value, thresholdFraction)`, i.e. from wherever the patient is right now, which
 * reads 0 for the whole of the descent above the threshold. `ReceptorHistory.update` passes the
 * observed peak, and that is the form the renderer uses.
 */
export function receptorLookInto(
  out: ReceptorLook,
  state: LaneStateLike | undefined,
  thresholdFraction: number,
  rearmFraction: number,
  peakRom?: number,
): ReceptorLook {
  const threshold = clamp(thresholdFraction, 0.05, 1);
  const rearm = clamp(rearmFraction, 0.05, 0.99);
  const value = state ? clamp(state.value, 0, 1.5) : 0;
  // The input layer's own trigger state wins when it publishes one: `armed` is a two-way collapse of
  // a three-way fact, and everything hard about the crossing latch comes from that collapse.
  const trig = state ? state.triggerState : undefined;
  const armed = trig ? trig === 'armed' : state ? state.armed !== false : true;
  const tracking = state ? state.tracking !== false : false;
  const ratio = value / threshold;
  const fill = clamp(ratio, 0, 1);
  // The re-arm point, expressed in the meter's own units (fraction of threshold) — that is exactly
  // where the re-arm line is drawn inside the ring.
  const resetLevel = rearm;
  const locked = !armed && tracking;
  // The top of the return journey, in ROM. Floored at the threshold because that is where a lockout
  // begins: a lane goes to 'triggered' by crossing the threshold, and one that is 'unconfirmed' at
  // some lower value has to be given SOME journey to travel or the arc would be complete before the
  // patient had moved. Raised to the observed peak by `ReceptorHistory`, which is what turns the
  // whole descent from full ROM into drawn-to-scale motion instead of a frozen `fill: 1`.
  const peak = Math.max(Number.isFinite(peakRom as number) ? (peakRom as number) : value, value, threshold);
  // Where the lane re-arms, in the same ROM units (`LaneTrigger.rearmLevel`).
  const rearmRom = threshold * rearm;
  out.fill = fill;
  // Measured over the threshold → full ROM span (see `meterOverSpan`), so it never saturates before
  // full ROM: `fill + over` is a strictly monotone position read-out over the whole range.
  out.over = clamp((value - threshold) / meterOverSpan(threshold), 0, 1);
  out.rom = value;
  out.peakRom = locked ? peak : value;
  out.tracking = tracking;
  out.stale = false;
  // A single frame knows nothing about whether the SESSION is accepting input: that is a fact about
  // the runner's phase, and only `ReceptorHistory.update` is told it.
  out.suspended = false;
  out.locked = locked;
  // NOT a level test. No source publishes the crossing as armed (the trigger disarms on the sample
  // that crosses), so `armed && fill >= 1` is unreachable and a look built here has no state (b):
  // `ReceptorHistory.update` latches it from the lane ENTERING 'triggered'.
  out.goal = 0;
  // 0 at the top of the journey, 1 once the value has dropped to the re-arm line — measured over
  // the REAL distance `peak - rearmRom`, so every millimetre of the descent moves it. A lane locked
  // below the line already ('unconfirmed' after a reset, a stream break or a threshold change) has
  // no journey left: its return is complete by definition.
  out.resetProgress = locked ? (peak > rearmRom ? clamp((peak - value) / (peak - rearmRom), 0, 1) : 1) : 0;
  out.resetLevel = resetLevel;
  // ...but only ORDER the patient down while there is somewhere to go. A locked lane below the
  // re-arm line (see `needsLower`) is still locked and still says so; it just stops pointing at a
  // line the patient is already under.
  out.needsLower = locked && fill >= resetLevel;
  // A lane that cannot fire gets no halo at all — the light going out *is* the "you must lower" cue.
  out.glowTarget = armed && tracking ? fill * fill : 0;
  return out;
}

/** Allocating convenience form of `receptorLookInto` (tests, one-off inspection). */
export function receptorLook(
  state: LaneStateLike | undefined,
  thresholdFraction: number,
  rearmFraction: number = DEFAULT_REARM_FRACTION,
): ReceptorLook {
  return receptorLookInto(emptyReceptorLook(rearmFraction), state, thresholdFraction, rearmFraction);
}

/**
 * Strength of the goal-attainment look `age` seconds after the threshold crossing: 1 for
 * `GOAL_HOLD_SEC`, then a linear ramp to 0 over `GOAL_FADE_SEC`.
 */
export function goalStrength(age: number): number {
  if (!(age >= 0)) return 0;
  if (age < GOAL_HOLD_SEC) return 1;
  const v = 1 - (age - GOAL_HOLD_SEC) / GOAL_FADE_SEC;
  // Snapped to 0 at the end: `goal > 0` is what switches the whole (b) mark set on, so a float
  // residue of 2e-16 would hold the "you reached it" costume for one extra frame.
  return v <= 1e-6 ? 0 : v;
}

interface LaneHistory {
  /** A tracked frame has been folded in, so `prevArmed` means something. */
  seen: boolean;
  /** Was the previous TRACKED frame able to fire? The left half of the crossing edge. */
  prevArmed: boolean;
  /** The previous TRACKED frame's published trigger state, when the source publishes one. */
  prevTrigger: 'unconfirmed' | 'armed' | 'triggered' | undefined;
  /** Time of the most recent threshold crossing (-Infinity = never). */
  goalT0: number;
  /**
   * Time the lane first became able to fire again AFTER that crossing — the moment the rep it
   * reports was handed back (+Infinity while the lane is still locked out). The goal latch ends
   * here, floored at `goalT0 + GOAL_MIN_SEC`. See `GOAL_MIN_SEC`.
   */
  goalReleaseT: number;
  /**
   * Time of the last crossing this renderer CREDITED as an emitted `LaneInputEvent` — the base the
   * refractory reconstruction measures the next one from, mirroring `LaneTrigger.lastEventTime`.
   * Interpolated the way `LaneTrigger` interpolates its own — see `crossingTime` and
   * `REFRACTORY_GUARD_MIN_SEC`.
   */
  emittedT: number;
  everTracked: boolean;
  /**
   * Length of the CURRENT uninterrupted dark run in seconds — time since the last frame that
   * carried a measurement, zeroed by every tracked frame. See `LOST_HOLD_SEC`.
   */
  dark: number;
  /** The latch this renderer draws (d) from: the dark run has passed `LOST_HOLD_SEC`. */
  lost: boolean;
  /**
   * Time of the last DISTINCT tracked sample — the renderer's estimate of the input layer's
   * `lastObservedTime`. See `ReceptorHistory.update`: `now - observedAt` is the gap `LaneTrigger`
   * measures its own continuity break against, so it is what the arming evidence expires on.
   */
  observedAt: number;
  /** The last state fed in, by reference and by value, so a repeated sample can be told from a new one. */
  srcRef: LaneStateLike | undefined;
  srcValue: number;
  srcArmed: boolean;
  srcTracking: boolean;
  srcTrigger: 'unconfirmed' | 'armed' | 'triggered' | undefined;
  /** The threshold / re-arm fraction the arming evidence was gathered under. */
  threshold: number;
  rearm: number;
  /**
   * Highest value observed since this lockout began — the top of the return journey (see
   * `ReceptorLook.peakRom`). NaN = no journey being watched, so the next locked frame starts one
   * from wherever the patient is. Reset when the lane re-arms, when the stream breaks (an
   * unobserved window is not evidence about how high they got), and when the threshold is retuned.
   */
  peak: number;
  /** Last tracked look, replayed during the anti-strobe hold. */
  last: ReceptorLook;
  /** Last update time, to notice a clock that went backwards (song restart / seek). */
  t: number;
}

function newLaneHistory(): LaneHistory {
  return {
    seen: false, prevArmed: false, prevTrigger: undefined, goalT0: -Infinity, goalReleaseT: Infinity,
    emittedT: -Infinity, everTracked: false,
    // A lane with no tracked frame behind it is (d) from its first frame: for an absent measurement
    // the honest default is "I cannot see you", not a live, at-rest gauge.
    dark: 0, lost: true, observedAt: -Infinity,
    srcRef: undefined, srcValue: NaN, srcArmed: false, srcTracking: false, srcTrigger: undefined,
    threshold: NaN, rearm: NaN, peak: NaN,
    last: emptyReceptorLook(), t: -Infinity,
  };
}

/**
 * Drop the INFERRED crossing evidence: whatever happens next, it is not a rising edge this renderer
 * watched. `prevTrigger` is deliberately untouched — see the file header ("THOSE TWO RULES DO NOT
 * TOUCH `prevTrigger`"). It is not this renderer's inference, it is the input layer's own state
 * machine, which does its own continuity checking and answers a break with 'unconfirmed'.
 */
function forgetArming(h: LaneHistory): void {
  h.seen = false;
  h.prevArmed = false;
}

/**
 * WHEN the crossing this frame reports actually happened, on the renderer's own clock — the number
 * the refractory reconstruction measures its intervals between (see `REFRACTORY_GUARD_MIN_SEC`).
 *
 * It is `LaneTrigger`'s own interpolation (src/vision/trigger.ts `push`: the crossing is placed
 * between the last sample below the threshold and the one at or above it, at the fraction of the way
 * the threshold sits between their VALUES), evaluated on the two render timestamps the renderer has
 * for those same two samples. Running the same formula on the same pair of values is what removes
 * the camera-frame quantisation from the renderer's estimate: both endpoints are then wrong only by
 * the wait between a camera frame and the render poll that first saw it, which is less than one
 * render step and in the SAME direction for both.
 *
 * Falls back to `now` — the frame the crossing was noticed on, which is what this used to be — when
 * there is nothing to interpolate from: no previous observation, a previous observation that was not
 * below the threshold (so this is not the bracketing pair the trigger used), or a non-increasing
 * pair.
 */
function crossingTime(h: LaneHistory, rom: number, threshold: number, now: number): number {
  const t0 = h.observedAt;
  const v0 = h.last.rom ?? NaN;
  if (!Number.isFinite(t0) || !(t0 < now) || !(v0 < threshold) || !(rom > v0)) return now;
  const f = clamp((threshold - v0) / (rom - v0), 0, 1);
  return t0 + f * (now - t0);
}

/**
 * The two things one frame of `LaneState` cannot tell you: that the threshold was just crossed
 * (state (b) — see the file header) and whether a `tracking: false` is a real dropout or one noisy
 * frame. Keeps a few numbers per lane, allocates nothing per frame, and is the model both the
 * receptor row and any other live meter should be drawn from, so the patient never has two meters
 * in front of them saying different things.
 */
export class ReceptorHistory {
  private lanes: LaneHistory[] = [];

  /** Drop all history (song restart, lane count change, input source swap). */
  reset(): void {
    for (const h of this.lanes) Object.assign(h, newLaneHistory());
  }

  /**
   * Fill `out` with the look lane `lane` should be drawn from at time `now` (seconds).
   *
   * `now` MUST BE A PERCEPTION CLOCK, not the song clock. All three windows this class owns — the
   * goal latch, the tracking hold and the gap rule that expires the crossing evidence — are
   * measured on the PATIENT, and the lane states keep arriving while a session is stopped (a
   * therapist pause, a suspended AudioContext). On a clock that stops with the song, all three fail
   * in the same direction: a latched goal is held at full strength for the whole stop and then
   * finishes after the resume, the tracking hold never expires so a dead camera leaves a live-
   * looking gauge, and the gap rule cannot throw away a stale arming — which is the one thing
   * standing between an occlusion recovery and a full celebration for a rep that never fired.
   * `Highway` passes `Highway.receptorT` (song time while the song clock runs, wall time while it
   * does not) and the play screen's picture-in-picture meters pass `performance.now()`; both keep
   * running. The clock must be monotone and in seconds; a step backwards is read as a new song and
   * drops this lane's history.
   *
   * `suspended` is "the session is not accepting input right now" — `RenderFrame.inputSuspended`,
   * which `GameRunner` builds from its own phase (a therapist pause, a run that has not started or
   * has ended). It is not a property of the lane and not something any `LaneState` can carry: the
   * camera keeps publishing, the patient keeps moving, and the engine throws the events away. While
   * it is set nothing is celebrated, nothing is credited to the refractory ledger, and the look is
   * the "no reading" one. See the file header for why the per-lane record keeps being fed anyway.
   */
  update(
    out: ReceptorLook,
    lane: number,
    state: LaneStateLike | undefined,
    thresholdFraction: number,
    rearmFraction: number,
    now: number,
    maxGapSec: number = DEFAULT_MAX_GAP_SEC,
    minIntervalSec: number = 0,
    suspended: boolean = false,
  ): ReceptorLook {
    let h = this.lanes[lane];
    if (!h) {
      h = newLaneHistory();
      this.lanes[lane] = h;
    }
    // A clock that jumped backwards is a new song / a seek, not a rep: nothing before it is
    // evidence about what the patient is doing now.
    if (Number.isFinite(now) && now < h.t) Object.assign(h, newLaneHistory());
    const prevT = h.t;
    h.t = now;

    // ---- what counts as a NEW observation ------------------------------------------------------
    // The renderer runs faster than the camera, so most frames re-present the sample the previous
    // one already showed (`VisionInput.getLaneStates` deliberately returns the SAME frozen objects
    // until it processes a new detection). A repeat is not an observation, and the whole gap rule
    // below is about how long it has been since the input layer last observed anything.
    //
    // TWO DIFFERENT QUANTITIES, AND THE DIFFERENCE IS BOUNDED. `LaneTrigger` measures its own
    // continuity on `push()` calls — one per processed camera frame, whatever the sample says —
    // while the renderer can only measure what it can SEE in `LaneState`, which is object identity
    // and four field values. The two agree for `VisionInput`, and by construction rather than by
    // luck: it rebuilds a fresh frozen `LaneState` per processed frame (memoized on `frameSeq`), so
    // `state !== h.srcRef` is true on exactly the frames it pushed and false on the extra polls of a
    // 60 Hz renderer. `receptor.test.ts` pins that path ("a repeated value in a NEW object is still
    // an observation") so a future memoization that reuses the object across frames cannot silently
    // turn a still patient into a stream break.
    //
    // Where they diverge is a source that returns the SAME object for many processed frames. The
    // scripted sources do exactly that (`src/input/laneStates.ts` caches on a held/not-held
    // bitmask), and there a patient AT REST for longer than `maxGapSec` looks silent from here —
    // which used to destroy state (b) outright on those paths, not merely blunt it. The reasoning
    // that let it ship was written down in this very comment: "a rising rep re-seeds `seen` several
    // frames before it crosses, so a real crossing survives". That is false for a scripted lane,
    // which is BINARY — `{value: 0, armed: true}` → `{value: 1, armed: false}` in one step, with
    // every preceding frame the same cached object. There is no rising ramp to re-seed anything, so
    // the inferred edge could not fire for any rep following more than half a second of rest, i.e.
    // essentially every rep of a real chart, on the path `CameraFallback` hands a patient when the
    // camera fails. Measured in the real app: 36 goal frames after 0.10/0.30/0.45 s of rest, ZERO
    // after 0.55/1.0/5.0 s.
    //
    // The fix is the one this file kept naming: `LaneState.triggerState` is now published by every
    // source, so the crossing is read off the input layer's own state machine and the gap rule —
    // which still governs the inferred edge and the peak — cannot suppress it. What a frozen object
    // still costs is the RETURN JOURNEY's peak (restarted from the patient's current height, which
    // under-reports their progress) and never a false crossing: still the safe direction.
    const fresh =
      state !== h.srcRef ||
      !(state === undefined || (state.value === h.srcValue && state.armed === h.srcArmed && (state.tracking !== false) === h.srcTracking && state.triggerState === h.srcTrigger));
    h.srcRef = state;
    h.srcValue = state ? state.value : NaN;
    h.srcArmed = state ? state.armed : false;
    h.srcTracking = state ? state.tracking !== false : false;
    h.srcTrigger = state ? state.triggerState : undefined;

    // ---- AN UNOBSERVED WINDOW IS NOT EVIDENCE --------------------------------------------------
    // `LaneTrigger.breakContinuity` throws an armed lane's arming away as soon as the stream has
    // been silent for longer than `maxGapSec` — a whole rep could have started and finished in
    // there. When it does, the lane goes to 'unconfirmed' AT ITS CURRENT VALUE, which is published
    // as exactly the same `{ value >= threshold, armed: false }` frame a real crossing is. Without
    // this rule the receptor read a lane recovering from a half-second occlusion as a rep that had
    // just scored and threw the full "you reached it" celebration for a rep that fired NOTHING (no
    // LaneInputEvent and, because breakContinuity closes the rep, no CompletedRep either).
    //
    // So the renderer applies the trigger's own rule to its own evidence, measured off the same
    // quantity: the time since the last DISTINCT tracked sample. Past that, the previous arming is
    // not something this renderer watched any more, and no edge may be latched from it.
    const gap = Number.isFinite(maxGapSec) && maxGapSec > 0 ? maxGapSec : DEFAULT_MAX_GAP_SEC;
    if (h.everTracked && now - h.observedAt > gap) forgetArming(h);
    // `LaneTrigger.setThreshold` also re-checks the arming (a therapist making the song easier
    // mid-song disarms every lane that is not already below the NEW re-arm level) — likewise not a
    // crossing. The renderer cannot see the re-check, but it can see the number change.
    const tuned =
      (Number.isFinite(h.threshold) && Number.isFinite(thresholdFraction) && thresholdFraction !== h.threshold) ||
      (Number.isFinite(h.rearm) && Number.isFinite(rearmFraction) && rearmFraction !== h.rearm);
    if (h.seen && tuned) forgetArming(h);
    // The peak the return journey is measured from is evidence too, and it expires on exactly the
    // same two rules. A lane recovering from half a second of lost landmarks is 'unconfirmed' at
    // whatever value it has, and the renderer did not watch how high it got; a retuned threshold
    // moves the finish line the journey is measured to. Either way the honest thing is to start the
    // journey again from where the patient is now, which under-reports their progress rather than
    // inventing a descent they may not have made.
    if (h.everTracked && now - h.observedAt > gap) h.peak = NaN;
    if (tuned) h.peak = NaN;
    h.threshold = thresholdFraction;
    h.rearm = rearmFraction;

    receptorLookInto(out, state, thresholdFraction, rearmFraction, h.peak);

    // ---- IS THERE A MEASUREMENT RIGHT NOW? (the (d) hold) --------------------------------------
    // `out.tracking` here is the RAW per-frame flag; what the receptor draws is the latch below,
    // which is that flag debounced by the length of the CURRENT DARK RUN (see `LOST_HOLD_SEC`).
    //
    // ENTERING COSTS `LOST_HOLD_SEC` OF UNINTERRUPTED DARKNESS; LEAVING COSTS ONE TRACKED FRAME, and
    // the asymmetry is the whole agreement with the input layer. A tracked frame is a sample
    // `LaneTrigger` was pushed and may have fired on — it is, for a rep that crossed inside the gap,
    // exactly the frame the crossing is interpolated back across and the event emitted on
    // (src/vision/trigger.ts `push`). Making the recovery cost contiguous stream (as a duty-cycle
    // rule must) is therefore the same thing as refusing knowledge of results for reps the engine
    // scored; see the file header for what that measured.
    //
    // The step is clamped to `gap` so one enormous frame (a GC pause, a resumed tab) cannot spend an
    // unbounded amount of darkness on evidence nobody gathered, and to >= 0 so a repeated timestamp
    // is inert.
    const step = Number.isFinite(prevT) ? clamp(now - prevT, 0, gap) : 0;
    const tracked = out.tracking;
    if (tracked) {
      h.everTracked = true;
      h.dark = 0;
      h.lost = false;
    } else {
      // Capped at the hold: once it is spent the lane is in (d) and staying there until a tracked
      // frame arrives, so an hour with the camera unplugged does not accumulate an hour of float.
      h.dark = Math.min(LOST_HOLD_SEC, h.dark + step);
      if (h.dark >= LOST_HOLD_SEC) h.lost = true;
    }
    // A lane with no tracked frame behind it at all is (d) from its first frame, whatever the run
    // length says: for an absent measurement the honest default is "I cannot see you".
    if (!h.everTracked) h.lost = true;
    // A latch that has been entered describes a window this renderer did not watch, so it expires
    // the goal latch the way a stream break expires the arming: whatever crossed in there must not
    // be celebrated when the picture comes back, ~0.2 s after the fact and no longer contingent.
    //
    // A SUSPENDED SESSION EXPIRES IT TOO, and for the harder-nosed version of the same reason: a
    // stop does not merely interrupt the view of the rep, it ENDS the window in which that rep meant
    // anything. Knowledge of results that is held across a pause and finishes its 0.45 s after the
    // resume is feedback delivered into the next repetition's concentric phase, which is exactly the
    // non-contingency this whole file exists to avoid — and it would also flicker back on for a stop
    // shorter than the latch. Cut here, once, and there is nothing left to resurrect.
    if (h.lost || suspended) {
      h.goalT0 = -Infinity;
      h.goalReleaseT = Infinity;
    }

    if (tracked) {
      // THE CROSSING — the one moment this whole file exists to find. It is never
      // `armed && fill >= 1` (no source emits that frame); it is the lane passing into the
      // trigger's 'triggered' state, which it does only by rising through the threshold.
      const cross = h.srcTrigger !== undefined
        // PUBLISHED. `LaneTrigger` enters 'triggered' from exactly one place — a rising edge past
        // the threshold, from 'armed' — so ENTERING it is the fire, whatever the renderer saw (or
        // failed to see) in between. Written as "was not 'triggered', is now" rather than
        // "'armed' → 'triggered'" because a renderer polling slower than the source can miss the
        // 'armed' frame in between two reps; it cannot miss the fact that a new lockout began.
        // `prevTrigger` must be known: a lane whose FIRST observed state is 'triggered' may have
        // been mid-hold when this renderer started, and that is not a rep it watched.
        ? h.prevTrigger !== undefined && h.srcTrigger === 'triggered' && h.prevTrigger !== 'triggered'
        // INFERRED, for a state that omits the field: an armed → locked edge at or past threshold,
        // but only while the evidence for the arming is still good (see the gap and tune rules).
        : h.seen && h.prevArmed && out.locked && out.fill >= 1;
      // THE REFRACTORY WINDOW — the one way a crossing reaches 'triggered' with NO
      // `LaneInputEvent` behind it. `LaneTrigger` swallows a crossing that lands within
      // `minIntervalSec` of the last EMITTED one: the lane still locks out, `VisionInput` still
      // reports the rep (`LaneRepEvent.emitted: false`), and nothing scores. Driven live, two
      // crossings 0.2 s apart produced events=1, reps=2 and TWO full goal cues against ONE score
      // step — a clonus beat, a tremor peak or a bounce at end range, i.e. the population this is
      // built for, and a contradiction on screen a therapist has to explain away.
      //
      // So the renderer keeps the trigger's own ledger — the time of the last crossing it credited,
      // interpolated exactly the way the trigger interpolates its own (`crossingTime`) — and applies
      // the same `>= minIntervalSec` test to it, widened by one render step (`refractoryGuard`) so a
      // crossing it is not SURE was swallowed is still celebrated. It is deliberately not exact: a
      // crossing inside the guard band updates this ledger where the trigger's did not, which can
      // only ever cost one later suppression, i.e. one more celebration. Over-celebrating is what
      // this already did; under-celebrating a rep that scored would cost the patient their
      // knowledge of results.
      const interval = Number.isFinite(minIntervalSec) && minIntervalSec > 0 ? minIntervalSec : 0;
      // Both ends of the comparison are INTERPOLATED crossing times, the same quantity
      // `LaneTrigger.lastEventTime` holds — not the frames they were noticed on. See `crossingTime`.
      const crossT = cross ? crossingTime(h, out.rom as number, clamp(thresholdFraction, 0.05, 1), now) : now;
      const emitted =
        interval <= 0 || !(h.emittedT > -Infinity) || crossT - h.emittedT >= interval - refractoryGuard(step);
      // ...and NOT WHILE THE SESSION IS SUSPENDED. The state machine below still follows this
      // crossing (`prevTrigger` is updated, so the resume cannot re-read it as a fresh edge), but
      // the engine discarded the event, so it earns no latch — and, just as importantly, it must not
      // be written into `h.emittedT`, or the first real rep performed within `minIntervalSec` of it
      // after the resume would lose ITS acknowledgement to a crossing that never scored.
      if (cross && !h.lost && !suspended && emitted) {
        h.emittedT = crossT;
        h.goalT0 = now;
        // A fresh rep is in hand again, so the previous release stops governing this latch.
        h.goalReleaseT = Infinity;
      }
      // THE OTHER END OF THE LATCH. A lockout ends when the patient drops back below the re-arm
      // level, and at that instant the honest message stops being "you reached your target" and
      // becomes "go again": the lane is armed, at rest, and the next rep counts. Recorded here (not
      // derived from a timer) because the only thing that knows when the rep was handed back is the
      // input layer's own arming, which is exactly what `out.locked` is.
      if (!out.locked && h.goalT0 > -Infinity && h.goalReleaseT === Infinity) h.goalReleaseT = now;
      h.seen = true;
      h.prevArmed = !out.locked;
      h.prevTrigger = h.srcTrigger;
      // THE TOP OF THE RETURN JOURNEY. While the lane is locked this only ever rises (see
      // `ReceptorLook.peakRom`); the moment it re-arms the journey is over and the next one starts
      // from wherever the patient is when they next lock out.
      h.peak = out.locked ? (out.peakRom as number) : NaN;
      if (fresh) h.observedAt = now;
      copyLook(h.last, out);
    }

    if (h.lost) {
      // (d). Nothing derived from a value may survive this. `receptorMarkSet` ranks 'lost' first
      // precisely so that no other state can be read out of the leftovers; every field below is
      // documented as meaningless while `tracking` is false, and they are zeroed anyway so a
      // consumer that forgets cannot paint a lockout or a halo out of them. This branch is only
      // ever reached on an UNTRACKED frame now (a tracked one clears the latch above), so it can no
      // longer overrule a live measurement.
      out.tracking = false;
      out.stale = false;
      out.locked = false;
      out.needsLower = false;
      out.goal = 0;
      out.glowTarget = 0;
      out.resetProgress = 0;
      out.peakRom = out.rom;
    } else if (!tracked) {
      // Anti-strobe hold: replay the last real measurement rather than flipping the whole row to
      // "?" on one frame that failed the visibility gate. Bounded by the dark run above, so a
      // dropout that outlasts `LOST_HOLD_SEC` ends up in (d) instead of replaying forever.
      copyLook(out, h.last);
      out.stale = true;
    }

    let goal = out.tracking ? goalStrength(now - h.goalT0) : 0;
    // BOUNDED BY THE LOCKOUT IT OVERLAYS. `goalStrength` is the ceiling — the shape for a patient
    // who is still holding at end range. A patient who has already lowered past the re-arm level has
    // given the rep back, and the cue has to go with it; `GOAL_MIN_SEC` is the only thing that keeps
    // it on screen past that point, and only long enough to be seen at all. See `GOAL_MIN_SEC`.
    if (goal > 0 && h.goalReleaseT !== Infinity && now >= Math.max(h.goalReleaseT, h.goalT0 + GOAL_MIN_SEC)) {
      goal = 0;
    }
    out.goal = goal;
    // The halo is forced to the latch's strength ONLY while the rep is still in hand — which means
    // locked AND still at or above the target, exactly as `receptorGoalHolding` defines it. In the
    // `GOAL_MIN_SEC` overrun the lane is armed and usually back at rest, and for the eccentric phase
    // between the target line and the re-arm line it is locked but coming down; in both,
    // `glowTarget` is already the honest `fill * fill`, and forcing a full halo paints "this will
    // fire, hard" onto a gauge the patient has visibly lowered.
    if (receptorGoalHolding(out)) out.glowTarget = Math.max(out.glowTarget, goal);
    // ---- AND IS THE SESSION EVEN LISTENING? ----------------------------------------------------
    // Last, and over everything above, because it outranks everything above: while the session is
    // not accepting input, the answer to "what will the input layer do with your next rep" is
    // "nothing", at every value and in every one of the other three states. The look is therefore
    // byte-for-byte the one a lane with no measurement produces — the same fields blanked, in the
    // same order, so 'lost' and 'suspended' cannot drift apart — plus the flag that picks the glyph.
    if (suspended) {
      out.tracking = false;
      out.stale = false;
      out.locked = false;
      out.needsLower = false;
      out.goal = 0;
      out.glowTarget = 0;
      out.resetProgress = 0;
      out.peakRom = out.rom;
      out.suspended = true;
    }
    return out;
  }
}
