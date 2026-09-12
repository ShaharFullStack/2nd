import { useStore } from '../state/store.ts';
import { MOVEMENT_INFO } from '../vision/features.ts';
import { HAND_MOVEMENTS, LEG_MOVEMENTS } from '../engine/types.ts';
import type { Mode } from '../engine/types.ts';
import { Screen, TopBar } from './common.tsx';

const CARDS: { mode: Mode; title: string; icon: string; blurb: string; posture: string }[] = [
  {
    mode: 'leg',
    title: 'Leg mode',
    icon: '🦵',
    blurb: 'Seated lower-limb work tracked with full-body pose.',
    posture: 'Patient seated facing the camera, hips to feet in frame.',
  },
  {
    mode: 'hand',
    title: 'Hand mode',
    icon: '✋',
    blurb: 'Fine and gross hand work tracked with hand landmarks.',
    posture: 'Forearm on the table, hand toward the camera.',
  },
];

export default function ModeSelect() {
  const goto = useStore((s) => s.goto);
  const mode = useStore((s) => s.mode);
  const setMode = useStore((s) => s.setMode);

  const choose = (m: Mode) => {
    setMode(m);
    goto('setup');
  };

  return (
    <Screen>
      <TopBar eyebrow="Step 1 of 3" title="Which limb is this session for?" onBack={() => goto('home')} />
      <p className="muted">One mode per session — pose and hand tracking cannot run on the same frames without halving the frame rate.</p>
      {/* THE SCREEN WHERE THE HANDS-FREE FLOW STOPS, saying so.
          Every screen from the camera check onwards can be confirmed by holding a limb over a circle
          on the camera preview. This one cannot, and neither can the prescription behind it: there is
          no camera running here (arriving here releases it — `screenNeedsCamera`), and choosing two
          movements, a difficulty, a song and a pace is not a choice a knee held in a circle can make.
          A patient who reaches this screen from the results screen's "Hand back" circle has finished
          their own part of the visit, and is owed a screen that admits it rather than one that simply
          offers nothing. */}
      <p className="muted" data-testid="mode-handsfree-note" style={{ maxWidth: 720 }}>
        <b>This step needs a hand.</b> The camera is off, so nothing on this screen can be confirmed by holding a limb
        over a circle — this screen and the prescription after it are set up by whoever is in the room. The patient takes
        over again at the camera check, and from there to the end of the session every step can be confirmed hands-free.
      </p>

      <div className="card-grid">
        {CARDS.map((c) => {
          const movements = c.mode === 'leg' ? LEG_MOVEMENTS : HAND_MOVEMENTS;
          return (
            <button
              key={c.mode}
              className="card pick"
              aria-pressed={mode === c.mode}
              onClick={() => choose(c.mode)}
              data-testid={`mode-${c.mode}`}
            >
              <div className="row">
                <span className="art" aria-hidden="true">
                  {c.icon}
                </span>
                <div>
                  <div className="pick-title">{c.title}</div>
                  <div className="pick-sub">{c.blurb}</div>
                </div>
              </div>
              <div className="dim">{c.posture}</div>
              <div className="row" style={{ gap: 6 }}>
                {movements.map((m) => (
                  <span key={m} className="badge">
                    {MOVEMENT_INFO[m].label}
                  </span>
                ))}
              </div>
            </button>
          );
        })}
      </div>
    </Screen>
  );
}
