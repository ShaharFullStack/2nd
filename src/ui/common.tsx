/** Small presentational pieces shared by the screens. No store access, no side effects. */
import type { ReactNode } from 'react';
import './therapist.css';

export function Screen({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <div className="screen" data-testid={testId}>
      <div className="screen-inner">{children}</div>
    </div>
  );
}

export function Stars({ value, max = 5 }: { value: number; max?: number }) {
  const full = Math.max(0, Math.min(max, Math.round(value)));
  return (
    <span className="stars" role="img" aria-label={`${full} of ${max} stars`}>
      {Array.from({ length: max }, (_, i) => (
        <span key={i} className={i < full ? 'on' : 'off'} aria-hidden="true">
          ★
        </span>
      ))}
    </span>
  );
}

export function Meter({ value, threshold, big = false, label }: { value: number; threshold?: number; big?: boolean; label?: string }) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div
      className={big ? 'meter meter-xl' : 'meter'}
      role="meter"
      aria-valuenow={Math.round(pct)}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label ?? 'movement'}
    >
      <i style={{ width: `${pct}%` }} />
      {threshold !== undefined && <span className="threshold" style={{ left: `${Math.max(0, Math.min(1, threshold)) * 100}%` }} />}
    </div>
  );
}

export function ProgressRing({ value, label, size = 132 }: { value: number; label: string; size?: number }) {
  const r = size / 2 - 10;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(1, value));
  return (
    <div className="ring-wrap" style={{ width: size, height: size }}>
      <svg width={size} height={size} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#26314c" strokeWidth={12} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="#ff3d7f"
          strokeWidth={12}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - v)}
        />
      </svg>
      <div className="ring-label">{label}</div>
    </div>
  );
}

export function Toast({ kind = 'warn', children }: { kind?: 'warn' | 'bad'; children: ReactNode }) {
  return <div className={kind === 'bad' ? 'toast toast-bad' : 'toast'}>{children}</div>;
}

export function TopBar({ title, eyebrow, onBack, right }: { title: string; eyebrow?: string; onBack?: () => void; right?: ReactNode }) {
  return (
    <div className="topbar">
      <div className="row">
        {onBack && (
          <button className="btn btn-ghost" onClick={onBack}>
            ← Back
          </button>
        )}
        <div>
          {eyebrow && <div className="eyebrow">{eyebrow}</div>}
          <h2>{title}</h2>
        </div>
      </div>
      {right && <div className="row row-end">{right}</div>}
    </div>
  );
}

/**
 * A small line chart of one series, sized for a clinic tablet: no axes, no gridlines, one line, the
 * last point marked, and the value spelled out next to it by the caller. Legibility rules that are
 * NOT optional here — the reader is a therapist glancing at it from arm's length:
 *
 *  - `values` may contain nulls (a session where ROM was never measured). A null BREAKS the line
 *    instead of being drawn as zero: an unmeasured session must never look like a collapse in range.
 *  - The y-axis spans `min`..`max` (default 0..1, i.e. a percentage of the calibrated range) so two
 *    movements' sparklines can be compared. A series that runs past `max` (ROM above 100 % of the
 *    calibrated range is a real and good outcome) expands the axis rather than clipping the line.
 *  - A single point is drawn as a dot, not an invisible zero-length line.
 */
export function Sparkline({
  values,
  min = 0,
  max = 1,
  width = 200,
  height = 52,
  color = '#35d6ff',
  label,
  band,
}: {
  values: (number | null)[];
  min?: number;
  max?: number;
  width?: number;
  height?: number;
  color?: string;
  label: string;
  /** Optional shaded reference level (e.g. the hit threshold), in the same units as `values`. */
  band?: number;
}) {
  const pad = 6;
  const finite = values.filter((v): v is number => v !== null && Number.isFinite(v));
  const hi = Math.max(max, ...finite);
  const lo = Math.min(min, ...finite);
  const span = hi - lo || 1;
  const n = values.length;
  const x = (i: number) => (n <= 1 ? width / 2 : pad + (i * (width - pad * 2)) / (n - 1));
  const y = (v: number) => height - pad - ((v - lo) / span) * (height - pad * 2);

  // Split into runs of consecutive measured points so gaps stay gaps.
  const runs: { i: number; v: number }[][] = [];
  let run: { i: number; v: number }[] = [];
  values.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) {
      if (run.length > 0) runs.push(run);
      run = [];
    } else run.push({ i, v: v as number });
  });
  if (run.length > 0) runs.push(run);

  // The last MEASURED point, which gets the marker. A NaN counts as unmeasured, exactly like a null,
  // so the marker is never drawn at NaN coordinates (an invisible dot and a console-free mystery).
  const lastIndex = values.reduce<number>((acc, v, i) => (v !== null && Number.isFinite(v) ? i : acc), -1);

  return (
    <svg className="spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label}>
      {band !== undefined && band >= lo && band <= hi && (
        <line x1={pad} x2={width - pad} y1={y(band)} y2={y(band)} stroke="#ffc945" strokeWidth={1} strokeDasharray="3 4" opacity={0.55} />
      )}
      {runs.map((r, k) =>
        r.length === 1 ? (
          <circle key={k} cx={x(r[0].i)} cy={y(r[0].v)} r={3.5} fill={color} />
        ) : (
          <polyline
            key={k}
            points={r.map((p) => `${x(p.i)},${y(p.v)}`).join(' ')}
            fill="none"
            stroke={color}
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ),
      )}
      {lastIndex >= 0 && <circle cx={x(lastIndex)} cy={y(values[lastIndex] as number)} r={4.5} fill={color} stroke="#0d1220" strokeWidth={2} />}
    </svg>
  );
}

/** "+12 pts" / "−4 pts" / "—" delta chip, green when up, red when down. Percentage-point units. */
export function DeltaBadge({ value, unit = 'pts', goodWhenUp = true }: { value: number | null; unit?: string; goodWhenUp?: boolean }) {
  if (value === null || !Number.isFinite(value)) return <span className="badge">no trend yet</span>;
  const pts = Math.round(value * 100);
  if (pts === 0) return <span className="badge">no change</span>;
  const up = pts > 0;
  const good = up === goodWhenUp;
  return (
    <span className={good ? 'badge badge-ok' : 'badge badge-bad'}>
      {up ? '▲' : '▼'} {up ? '+' : '−'}
      {Math.abs(pts)} {unit}
    </span>
  );
}
