import { useStore } from '../state/store.ts';
import { MOVEMENT_INFO } from '../vision/features.ts';
import { HAND_MOVEMENTS, LEG_MOVEMENTS } from '../engine/types.ts';
import type { Mode } from '../engine/types.ts';
import { Screen, TopBar } from './common.tsx';
import './pregame.css';
import GameFrame from './GameFrame.tsx';

const CARDS: { mode: Mode; title: string; blurb: string; posture: string }[] = [
  {
    mode: 'leg',
    title: 'Leg mode',
    blurb: 'Lift, extend and step into the rhythm.',
    posture: 'Patient seated facing the camera, hips to feet in frame.',
  },
  {
    mode: 'hand',
    title: 'Hand mode',
    blurb: 'Open, reach and play with your fingertips.',
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
    <Screen testId="pregame-mode">
      <TopBar eyebrow="Beat Rehab / Choose your mode" title="How will you play?" onBack={() => goto('home')} />
      <p className="muted">Two ways to move with the music. Choose one for this session.</p>
      {/* THE SCREEN WHERE THE HANDS-FREE FLOW STOPS, saying so.
          Every screen from the camera check onwards can be confirmed by holding a limb over a circle
          on the camera preview. This one cannot, and neither can the prescription behind it: there is
          no camera running here (arriving here releases it — `screenNeedsCamera`), and choosing two
          movements, a difficulty, a song and a pace is not a choice a knee held in a circle can make.
          A patient who reaches this screen from the results screen's "Hand back" circle has finished
          their own part of the visit, and is owed a screen that admits it rather than one that simply
          offers nothing. */}
      <div className="mode-roster">
        {CARDS.map((c) => {
          const movements = c.mode === 'leg' ? LEG_MOVEMENTS : HAND_MOVEMENTS;
          return (
            <button
              key={c.mode}
              className="card pick mode-pick"
              aria-pressed={mode === c.mode}
              onClick={() => choose(c.mode)}
              data-testid={`mode-${c.mode}`}
            >
              <GameFrame />
              <div className="row">
                <svg className="mode-emblem" viewBox="0 0 160 160" fill="none" stroke="currentColor" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  {c.mode === 'leg' ? <path d="M60 20L51 62L89 93L74 131H108L119 118M51 62L32 104L45 133H65M68 25L93 62L126 64" /> : <path d="M48 132L29 94Q22 77 34 76L53 94L48 43Q48 29 59 32L70 76L70 23Q72 12 82 23L87 74L95 29Q100 19 107 31L104 83L118 52Q125 44 130 56L117 116L100 138Z" />}
                </svg>
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
      <p className="mode-guidance" data-testid="mode-handsfree-note">
        <b>This step needs a hand.</b> The camera is off. Tap to choose the mode, movements and song.
        The patient takes over again at the camera check with hands-free controls.
      </p>
    </Screen>
  );
}
