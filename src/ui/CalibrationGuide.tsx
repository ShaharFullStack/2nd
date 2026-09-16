import { useId } from 'react';
import type { ReactNode } from 'react';
import type { LaneSpec } from '../engine/types.ts';
import type { CalibrationStatus } from '../vision/calibration.ts';
import { MOVEMENT_INFO, POSTURE_INFO, movementCalibrationInstruction } from '../vision/features.ts';
import type { MovementPosture } from '../vision/features.ts';
import { ProgressRing } from './common.tsx';
import './calibration-guide.css';

/** Illustrations are examples of the action, never targets for a patient's maximum range. */
export function MovementIllustration({ lane, resting }: { lane: LaneSpec; resting: boolean }) {
  const arrow = useId().replace(/:/g, '');
  const hand = MOVEMENT_INFO[lane.movement].mode === 'hand';
  const knee = lane.movement === 'knee_extension';
  const ankle = lane.movement === 'ankle_dorsiflexion';
  const hip = lane.movement === 'hip_abduction';
  const wrist = lane.movement === 'wrist_extension';
  const pinch = lane.movement === 'finger_opposition';
  const spread = lane.movement === 'finger_spread';
  const tip = { index: '116 51', middle: '134 44', ring: '152 61', pinky: '180 89' }[lane.fingertip ?? 'index'];
  return (
    <svg className={`rom-demo ${resting ? 'is-resting' : 'is-moving'}`} viewBox="0 0 240 200" role="img"
      aria-label={`${lane.side} ${MOVEMENT_INFO[lane.movement].label}: ${resting ? 'resting position' : 'movement example'}`}>
      <defs><marker id={arrow} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M1 1 9 5 1 9" fill="none" stroke="currentColor" strokeWidth="2" /></marker></defs>
      <g fill="none" strokeLinecap="round" strokeLinejoin="round" strokeWidth="7">
        {hand ? wrist ? <>
          <path className="rom-demo-support" d="M20 145H140V182" />
          <path className="rom-demo-body" d="M25 125H140" />
          <g className="rom-demo-wrist"><path className="rom-demo-active" d="M140 125 195 140 219 130M185 137 207 124" /></g>
          {!resting && <path className="rom-demo-arrow" markerEnd={`url(#${arrow})`} d="M207 111Q217 83 192 68" />}
        </> : <>
          <path className="rom-demo-body" d="M91 184V157Q64 138 57 111Q55 101 65 103L87 119V83Q87 72 96 75L105 110M105 110V58Q106 46 116 51L122 106M122 106V44Q126 34 134 44L139 108M139 108V61Q145 49 152 61L153 117M153 117L165 87Q174 78 180 89L171 137Q167 151 149 161V184" />
          <g className="rom-demo-fingers">
            <path className="rom-demo-active" d={pinch ? `M65 103Q110 62 ${tip}` : spread ? 'M96 75 80 48M116 51 108 28M134 44 140 20M152 61 168 36M180 89 202 66' : 'M96 75 96 49M116 51 116 27M134 44 134 20M152 61 156 37M180 89 191 68'} />
          </g>
          {!resting && <path className="rom-demo-arrow" markerEnd={`url(#${arrow})`} d={pinch ? 'M59 66Q78 35 101 44' : spread ? 'M159 22Q193 25 211 48' : 'M50 129Q27 90 54 62'} />}
        </> : hip ? <>
          <circle className="rom-demo-body" cx="120" cy="30" r="17" />
          <path className="rom-demo-body" d="M120 50V101M87 68H153M91 102H149M99 105 98 144 98 178M98 178H79" />
          <path className="rom-demo-support" d="M77 115H163M79 115V180M161 115V180" />
          <g className="rom-demo-hip"><path className="rom-demo-active" d="M141 103 159 140 161 177H180" /></g>
          {!resting && <path className="rom-demo-arrow" markerEnd={`url(#${arrow})`} d="M166 113H211" />}
        </> : <>
          <path className="rom-demo-support" d="M63 78V120H132M70 121V180M125 121V180M38 184H212" />
          <circle className="rom-demo-body" cx="96" cy="28" r="17" />
          <path className="rom-demo-body" d="M94 49 89 104M92 65 119 94 143 98" />
          <g className={!knee && !ankle ? 'rom-demo-march' : undefined}>
            <path className="rom-demo-active" d="M89 104 145 113" />
            <g className={knee ? 'rom-demo-knee' : undefined}>
              <path className="rom-demo-active" d="M145 113 147 176" />
              <path className={`rom-demo-active ${ankle ? 'rom-demo-ankle' : ''}`} d="M147 176H180" />
            </g>
          </g>
          {!resting && <path className="rom-demo-arrow" markerEnd={`url(#${arrow})`} d={knee ? 'M177 158Q203 136 195 113' : ankle ? 'M192 173Q207 158 191 149' : 'M167 105V66'} />}
        </>}
      </g>
    </svg>
  );
}

/**
 * ONE SETUP, DRAWN — the support included, because the support is the thing that has to move.
 *
 * Same primitives (and the same two stroke classes) as `MovementIllustration`: `hand_over_edge` is the
 * figure its wrist branch already draws, and `palm_to_camera` is the hand branch's figure with the
 * table it rests on. The transform only fits each drawing into the shared 240x200 box.
 */
const POSTURE_FIGURE: Readonly<Record<MovementPosture, { transform?: string; body: ReactNode }>> = {
  seated_leg: {
    body: (
      <>
        <path className="rom-demo-support" d="M63 78V120H132M70 121V180M125 121V180M38 184H212" />
        <circle className="rom-demo-body" cx="96" cy="28" r="17" />
        <path className="rom-demo-body" d="M94 49 89 104M92 65 119 94 143 98M89 104 145 113M145 113 147 176M147 176H180" />
      </>
    ),
  },
  palm_to_camera: {
    body: (
      <>
        <path className="rom-demo-support" d="M28 190H212" />
        <path className="rom-demo-body" d="M91 184V157Q64 138 57 111Q55 101 65 103L87 119V83Q87 72 96 75L105 110M105 110V58Q106 46 116 51L122 106M122 106V44Q126 34 134 44L139 108M139 108V61Q145 49 152 61L153 117M153 117L165 87Q174 78 180 89L171 137Q167 151 149 161V184" />
        <path className="rom-demo-active" d="M96 75 96 49M116 51 116 27M134 44 134 20M152 61 156 37M180 89 191 68" />
      </>
    ),
  },
  hand_over_edge: {
    // A hand over a table edge is a wide, flat drawing where a palm-to-camera hand is a tall one, so
    // this one is scaled up and re-centred; without it the two figures in a change read as a big hand
    // and a small smudge rather than as two setups of the same arm.
    transform: 'translate(-24 -98) scale(1.3)',
    body: (
      <>
        <path className="rom-demo-support" d="M20 145H140V182" />
        <path className="rom-demo-body" d="M25 125H140" />
        <path className="rom-demo-active" d="M140 125 195 140 219 130M185 137 207 124" />
      </>
    ),
  },
};

/**
 * THE SETUP CHANGE ITSELF: what you are in now, faded, and what to move to, lit, with the arrow
 * between them. Drawn rather than described because the two hand setups are ninety degrees apart
 * about the wrist and the difference between the two sentences that describe them is four words.
 */
export function PostureIllustration({ from, to }: { from: MovementPosture; to: MovementPosture }) {
  const arrow = useId().replace(/:/g, '');
  return (
    <svg className="rom-demo rom-demo-posture" viewBox="0 0 565 200" role="img"
      aria-label={`Move from ${POSTURE_INFO[from].label.toLowerCase()} to ${POSTURE_INFO[to].label.toLowerCase()}`}>
      <defs><marker id={arrow} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M1 1 9 5 1 9" fill="none" stroke="currentColor" strokeWidth="2" /></marker></defs>
      <g fill="none" strokeLinecap="round" strokeLinejoin="round" strokeWidth="7">
        <g className="rom-posture-from" transform={`translate(-35 0) ${POSTURE_FIGURE[from].transform ?? ''}`} data-posture={from}>{POSTURE_FIGURE[from].body}</g>
        <path className="rom-demo-arrow" markerEnd={`url(#${arrow})`} d="M192 100H250" />
        <g className="rom-posture-to" transform={`translate(300 0) ${POSTURE_FIGURE[to].transform ?? ''}`} data-posture={to}>{POSTURE_FIGURE[to].body}</g>
      </g>
    </svg>
  );
}

/** Which beat of a lane the screen is on. Only 'measure' asks the patient to do anything. */
export type CalibrationBeat = 'posture' | 'reuse' | 'measure';

/** The setup the patient is in, the one the next movement needs, and the way out of this beat. */
export interface PostureChange {
  from: MovementPosture;
  to: MovementPosture;
  onReady: () => void;
}

/** Last session's range for THIS lane, already vetted by the screen, with both answers to it. */
export interface ReuseOffer {
  /** "0.10 → 0.50", in the movement's own units. */
  rangeText: string;
  /** When it was measured, in words ("measured on 3 September"). */
  when: string;
  /** The quality chip for that measurement — built by the screen, so one component grades every range. */
  quality: ReactNode;
  /** How well it was measured, as a sentence. */
  note: string;
  onUse: () => void;
  onMeasure: () => void;
}

function limbWord(lane: LaneSpec): string {
  return MOVEMENT_INFO[lane.movement].mode === 'hand' ? 'hand' : 'leg';
}

/**
 * THE SETUP CHANGE, ASKED FOR ONCE, AS ITS OWN BEAT.
 *
 * A mixed hand prescription is measured in two physically different setups (palm to the camera, and
 * the hand over the table edge). Walking from one lane to the next used to change one sentence in the
 * instruction line and nothing else: the patient — often the one with the weak hand — had to work out
 * from a reworded instruction that the forearm, the support and the whole arm had to move. Here it is
 * the only thing on the screen, it is drawn, and no repetition is asked for until it is confirmed.
 */
function PostureBeat({ lane, change, reducedMotion, handsFree }: { lane: LaneSpec; change: PostureChange; reducedMotion: boolean; handsFree?: ReactNode }) {
  const info = MOVEMENT_INFO[lane.movement];
  return (
    <section className={`rom-coach is-posture ${reducedMotion ? 'rom-reduced-motion' : ''}`} data-testid="rom-visual-guide" data-beat="posture">
      <div className="rom-coach-heading" aria-live="polite" aria-atomic="true">
        <span className="rom-side">Set-up change · your {lane.side} {limbWord(lane)}</span>
        <h1>Move your arm before the next movement</h1>
        <p data-testid="rom-posture-instruction">{POSTURE_INFO[change.to].change}</p>
        <p className="rom-posture-why" data-testid="rom-posture-why">
          {info.label} is measured with your {POSTURE_INFO[change.to].label.toLowerCase()}, not{' '}
          {POSTURE_INFO[change.from].label.toLowerCase()}. Nothing is measured until you say you have moved.
        </p>
      </div>
      <div className="rom-coach-demonstration">
        <PostureIllustration from={change.from} to={change.to} />
        <span>
          {POSTURE_INFO[change.from].label} → {POSTURE_INFO[change.to].label}
        </span>
      </div>
      <div className="rom-coach-progress">
        <button className="btn btn-primary btn-lg" onClick={change.onReady} data-testid="rom-posture-ready">
          I have moved
        </button>
        <span>Or hold the left circle.</span>
      </div>
      {handsFree}
    </section>
  );
}

/**
 * THE RANGE THIS PATIENT ALREADY HAS, OFFERED AS A CHOICE AND NOT AS A DEFAULT.
 *
 * On a return visit this is what removes the whole wall of repetitions, so it is a beat of its own
 * rather than a control inside a disclosure widget. It states what it would adopt — the range, in the
 * movement's units, when it was measured and how well — because reusing a range makes that
 * measurement today's denominator too, and that is a clinical judgement. Both answers are equally
 * reachable, by button and hands-free, and neither of them advances the session on its own.
 */
function ReuseBeat({ lane, offer, reducedMotion, handsFree }: { lane: LaneSpec; offer: ReuseOffer; reducedMotion: boolean; handsFree?: ReactNode }) {
  const info = MOVEMENT_INFO[lane.movement];
  return (
    <section className={`rom-coach is-reuse ${reducedMotion ? 'rom-reduced-motion' : ''}`} data-testid="rom-visual-guide" data-beat="reuse">
      <div className="rom-coach-heading" aria-live="polite" aria-atomic="true">
        <span className="rom-side">
          Your {lane.side} {limbWord(lane)} · {info.label.toLowerCase()}
        </span>
        <h1>Use last time&rsquo;s range?</h1>
        <p data-testid="rom-reuse-offer">
          This movement was already measured for this patient, so the three practice repetitions can be skipped.
        </p>
        <p className="rom-reuse-facts" data-testid="rom-reuse-facts">
          <span className="mono">{offer.rangeText}</span> <span>{offer.when}</span> {offer.quality}
        </p>
        {/* How well it was measured, in words. The chip above carries the same verdict and its
            conditions, and the details panel repeats the sentence, so the tightest viewports drop
            this line rather than the grade. */}
        <p className="rom-posture-why rom-reuse-quality" data-testid="rom-reuse-quality-sentence">{offer.note}</p>
      </div>
      <div className="rom-coach-demonstration">
        <MovementIllustration lane={lane} resting />
        <span>Last time&rsquo;s movement</span>
      </div>
      <div className="rom-coach-progress rom-reuse-actions">
        <button className="btn btn-primary btn-lg" onClick={offer.onUse} data-testid="rom-reuse-use">
          Use this range
        </button>
        <button className="btn" onClick={offer.onMeasure} data-testid="rom-reuse-measure">
          Measure it again
        </button>
        <span>Reusing it makes last time&rsquo;s measurement today&rsquo;s scale. You can still measure it again after.</span>
      </div>
      {handsFree}
    </section>
  );
}

export function CalibrationGuide({
  lane, status, tracking, accepted, refused, reducedMotion, retry, beat = 'measure', postureChange, reuse, reused = false, handsFree,
}: {
  lane: LaneSpec; status: CalibrationStatus | null; tracking: boolean; accepted: boolean;
  refused: boolean; reducedMotion: boolean; retry: () => void;
  /** Which beat of this lane the screen is on (default: measure — rest hold, then three reps). */
  beat?: CalibrationBeat;
  /** Required when `beat` is 'posture'. */
  postureChange?: PostureChange | null;
  /** Required when `beat` is 'reuse'. */
  reuse?: ReuseOffer | null;
  /** The accepted range came from a previous session rather than from reps measured just now. */
  reused?: boolean;
  /**
   * THE HANDS-FREE LEGEND, ON THE PATIENT'S SIDE OF THE SCREEN.
   *
   * It says which limb the circles are following and what to do when they are following none — the two
   * facts a ring cannot carry, and the ones a patient working alone is stranded without. It used to be
   * rendered inside this screen's collapsed "Adjustments & details" disclosure, where it was laid out
   * two thousand pixels below the fold and could not be opened without a hand on the glass. It belongs
   * in the panel the patient is already reading, in every beat, because the circles are live in all of
   * them.
   */
  handsFree?: ReactNode;
}) {
  if (beat === 'posture' && postureChange) return <PostureBeat lane={lane} change={postureChange} reducedMotion={reducedMotion} handsFree={handsFree} />;
  if (beat === 'reuse' && reuse) return <ReuseBeat lane={lane} offer={reuse} reducedMotion={reducedMotion} handsFree={handsFree} />;
  const info = MOVEMENT_INFO[lane.movement];
  const failed = refused || !!status?.error;
  const resting = !status || status.phase === 'rest';
  const title = accepted
    ? reused ? 'Last time’s range in use' : 'Movement captured'
    : failed ? 'Let’s try again' : resting ? 'Hold your starting position' : 'Move, then return';
  const instruction = accepted
    ? reused ? 'Nothing was measured just now — this range is the one from last time. Ready for the next movement.' : 'Ready for the next movement.'
    : failed
    ? status?.error === 'not_tracked' ? 'Keep the whole limb in the camera frame.' : 'Reset your resting position and try the movement again.'
    : resting ? info.restInstruction : movementCalibrationInstruction(lane.movement, lane.fingertip);
  return <section className={`rom-coach ${reducedMotion ? 'rom-reduced-motion' : ''}`} data-testid="rom-visual-guide" data-beat="measure">
    <div className="rom-coach-heading" aria-live="polite" aria-atomic="true">
      <span className="rom-side">Your {lane.side} {info.mode === 'hand' ? 'hand' : 'leg'} · {tracking ? 'in view' : 'move into the frame'}</span>
      <h1>{title}</h1><p data-testid="rom-instruction">{instruction}</p>
    </div>
    <div className="rom-coach-demonstration">
      {accepted ? <div className="rom-success" aria-label="Range accepted">✓</div> : <MovementIllustration lane={lane} resting={resting || failed || !tracking} />}
      <span>{accepted ? (reused ? 'Reused from last session' : 'Range saved') : 'Movement example · stay within your comfort'}</span>
    </div>
    <div className="rom-coach-progress">
      {/* A REUSED RANGE HAS NO REPETITIONS TO SHOW. It never ran a calibrator, so the rest ring would
          sit at zero ("keep still while the ring fills") and the rep dots would tick three reps that
          nobody performed today — the same claim in two different graphics. It says so instead. */}
      {accepted && reused ? <span data-testid="rom-reused-progress">No repetitions were measured today.</span>
        : resting && !failed ? <><ProgressRing value={status?.restProgress ?? 0} label={tracking ? 'Hold' : '…'} size={72} /><span>{tracking ? 'Keep still while the ring fills' : 'Waiting for a clear view'}</span></>
        : failed ? <button className="btn btn-primary btn-lg" onClick={retry} data-testid="rom-guide-retry">Try again</button>
        : <><div className="rom-rep-dots" aria-label={`${status?.repsDetected ?? 0} of ${status?.repsRequired ?? 3} repetitions detected`}>
          {Array.from({ length: status?.repsRequired ?? 3 }, (_, i) => <span key={i} className={accepted || i < (status?.repsDetected ?? 0) ? 'is-complete' : ''}>{accepted || i < (status?.repsDetected ?? 0) ? '✓' : i + 1}</span>)}
        </div><span>{accepted ? 'You’re ready to continue' : (status?.repsDetected ?? 0) >= (status?.repsRequired ?? 3) ? 'Keep going · still measuring your range' : 'Return to rest after each movement'}</span></>}
    </div>
    {handsFree}
  </section>;
}
