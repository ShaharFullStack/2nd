import { useId } from 'react';
import type { LaneSpec } from '../engine/types.ts';
import type { CalibrationStatus } from '../vision/calibration.ts';
import { MOVEMENT_INFO, movementCalibrationInstruction } from '../vision/features.ts';
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

export function CalibrationGuide({ lane, status, tracking, accepted, refused, reducedMotion, retry }: {
  lane: LaneSpec; status: CalibrationStatus | null; tracking: boolean; accepted: boolean;
  refused: boolean; reducedMotion: boolean; retry: () => void;
}) {
  const info = MOVEMENT_INFO[lane.movement];
  const failed = refused || !!status?.error;
  const resting = !status || status.phase === 'rest';
  const title = accepted ? 'Movement captured' : failed ? 'Let’s try again' : resting ? 'Hold your starting position' : 'Move, then return';
  const instruction = accepted ? 'Ready for the next movement.' : failed
    ? status?.error === 'not_tracked' ? 'Keep the whole limb in the camera frame.' : 'Reset your resting position and try the movement again.'
    : resting ? info.restInstruction : movementCalibrationInstruction(lane.movement, lane.fingertip);
  return <section className={`rom-coach ${reducedMotion ? 'rom-reduced-motion' : ''}`} data-testid="rom-visual-guide">
    <div className="rom-coach-heading" aria-live="polite" aria-atomic="true">
      <span className="rom-side">Your {lane.side} {info.mode === 'hand' ? 'hand' : 'leg'} · {tracking ? 'in view' : 'move into the frame'}</span>
      <h1>{title}</h1><p data-testid="rom-instruction">{instruction}</p>
    </div>
    <div className="rom-coach-demonstration">
      {accepted ? <div className="rom-success" aria-label="Range accepted">✓</div> : <MovementIllustration lane={lane} resting={resting || failed || !tracking} />}
      <span>{accepted ? 'Range saved' : 'Movement example · stay within your comfort'}</span>
    </div>
    <div className="rom-coach-progress">
      {resting && !failed ? <><ProgressRing value={status?.restProgress ?? 0} label={tracking ? 'Hold' : '…'} size={72} /><span>{tracking ? 'Keep still while the ring fills' : 'Waiting for a clear view'}</span></>
        : failed ? <button className="btn btn-primary btn-lg" onClick={retry} data-testid="rom-guide-retry">Try again</button>
        : <><div className="rom-rep-dots" aria-label={`${status?.repsDetected ?? 0} of ${status?.repsRequired ?? 3} repetitions detected`}>
          {Array.from({ length: status?.repsRequired ?? 3 }, (_, i) => <span key={i} className={accepted || i < (status?.repsDetected ?? 0) ? 'is-complete' : ''}>{accepted || i < (status?.repsDetected ?? 0) ? '✓' : i + 1}</span>)}
        </div><span>{accepted ? 'You’re ready to continue' : (status?.repsDetected ?? 0) >= (status?.repsRequired ?? 3) ? 'Keep going · still measuring your range' : 'Return to rest after each movement'}</span></>}
    </div>
  </section>;
}
