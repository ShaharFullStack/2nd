/** Scalable cut-corner shell shared by the start control and mode selection panels. */
export default function GameFrame({ button = false }: { button?: boolean }) {
  return (
    <svg className={button ? 'game-frame game-frame-button' : 'game-frame'} viewBox="0 0 400 200" preserveAspectRatio="none" aria-hidden="true">
      <path className="game-frame-body" d="M1 1H376L399 24V199H24L1 176Z" vectorEffect="non-scaling-stroke" />
      <path className="game-frame-edge" d="M1 48V1H100M300 199H399V152" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
