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
