/** Decorative title-screen track. No live notes or performance data. */
export default function StageArtwork() {
  return (
    <svg className="stage-art" viewBox="0 0 900 900" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="track-floor" x1="450" y1="190" x2="450" y2="870" gradientUnits="userSpaceOnUse">
          <stop stopColor="#7666d8" stopOpacity="0" />
          <stop offset="1" stopColor="#7666d8" stopOpacity=".22" />
        </linearGradient>
        <linearGradient id="track-line" x1="450" y1="200" x2="450" y2="880" gradientUnits="userSpaceOnUse">
          <stop stopColor="#a599ff" stopOpacity="0" />
          <stop offset="1" stopColor="#a599ff" stopOpacity=".8" />
        </linearGradient>
        <filter id="note-glow" x="-80%" y="-180%" width="260%" height="460%">
          <feGaussianBlur stdDeviation="10" />
        </filter>
      </defs>
      <circle cx="470" cy="350" r="210" stroke="#a599ff" strokeOpacity=".12" strokeWidth="2" />
      <circle cx="470" cy="350" r="240" stroke="#a599ff" strokeOpacity=".06" strokeWidth="28" />
      <path d="M390 240H550L880 900H50Z" fill="url(#track-floor)" />
      {[50, 257, 465, 672, 880].map((x, i) => (
        <path key={x} d={`M${390 + i * 40} 240L${x} 900`} stroke="url(#track-line)" strokeWidth={i === 0 || i === 4 ? 3 : 1.5} />
      ))}
      {[420, 500, 600, 725, 870].map((y) => (
        <path key={y} d={`M${390 - (y - 240) * .515} ${y}H${550 + (y - 240) * .5}`} stroke="#a599ff" strokeOpacity=".13" />
      ))}
      {[
        { x: 448, y: 373, w: 49, c: '#ffc77b' },
        { x: 370, y: 453, w: 66, c: '#8fe4e8' },
        { x: 563, y: 543, w: 87, c: '#b6a1ff' },
        { x: 234, y: 647, w: 110, c: '#8fe4e8' },
        { x: 439, y: 766, w: 140, c: '#ffc77b' },
      ].map((n) => (
        <g key={n.y}>
          <rect x={n.x} y={n.y} width={n.w} height="13" rx="4" fill={n.c} filter="url(#note-glow)" />
          <rect x={n.x} y={n.y} width={n.w} height="9" rx="3" fill={n.c} />
          <rect x={n.x + 3} y={n.y} width={n.w - 6} height="2" rx="1" fill="white" />
        </g>
      ))}
      <path d="M92 834H844" stroke="#b6a1ff" strokeWidth="3" />
    </svg>
  );
}
