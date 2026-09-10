/** Small presentational pieces shared by the screens. No store access, no side effects. */
import { useEffect, useRef, useState } from 'react';
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
 * The trend chart, sized and scaled for a therapist glancing at a clinic tablet from ~2 m.
 *
 * The rules here are the ones that decide whether the chart SHOWS THE CHANGE or merely decorates the
 * number beside it. The first version of this drew a fixed 0..1 axis into 40 px of drawable height,
 * where a genuine +31 percentage-point gain in range of motion and two-point week-to-week noise were
 * the same near-flat line. So:
 *
 *  - THE AXIS FOLLOWS THE DATA. `min`/`max` are the widest the axis may need to be, not what it must
 *    be: the plot zooms to the values present (padded, and never narrower than `minSpan` so noise is
 *    not magnified into a mountain). Both bounds are LABELLED — an autoscaled axis that does not say
 *    what it spans is worse than a fixed one.
 *  - TIME IS THE X AXIS. Points sit at their real date, so eight sessions over two weeks and eight
 *    over six months do not draw the same slope. Rate of change is part of the clinical read.
 *  - THE STARTING LEVEL IS DRAWN. A dashed line at the first measured value turns "is this up or
 *    down?" into a yes/no the eye answers without reading a single number.
 *  - `values` may contain nulls (a session where ROM was never measured). A null BREAKS the line
 *    instead of being drawn as zero: an unmeasured session must never look like a collapse in range.
 *  - A single point is drawn as a dot, not an invisible zero-length line.
 *
 * The SVG measures its own container so it can fill the card's width; in a non-DOM test environment
 * it falls back to `width` and still renders every element.
 */
export function Sparkline({
  values,
  at,
  min = 0,
  max = 1,
  minSpan = 0.25,
  width = 320,
  height = 132,
  color = '#35d6ff',
  label,
  band,
  format = (v: number) => `${Math.round(v * 100)}%`,
}: {
  values: (number | null)[];
  /** Timestamps for each value (ms). Same length as `values`; omitted = evenly spaced. */
  at?: number[];
  min?: number;
  max?: number;
  /** Smallest axis span allowed, in `values` units. Stops ±1 pt of noise filling the plot. */
  minSpan?: number;
  width?: number;
  height?: number;
  color?: string;
  label: string;
  /** Optional dotted reference level (e.g. 100 % of the calibrated range), in `values` units. */
  band?: number;
  format?: (v: number) => string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState(0);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const read = () => setMeasured(el.clientWidth || 0);
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const w = Math.max(220, measured || width);

  const padL = 44;
  const padR = 12;
  const padT = 12;
  const padB = 20;
  const finite = values.filter((v): v is number => v !== null && Number.isFinite(v));

  // Axis: the data's own range, padded by a tenth, widened to `minSpan`, then clamped inside the
  // caller's outer bounds — except upward, because ROM above 100 % of the calibrated range is a real
  // (and good) result and must never be clipped off the top.
  const dataLo = finite.length > 0 ? Math.min(...finite) : min;
  const dataHi = finite.length > 0 ? Math.max(...finite) : max;
  const centre = (dataLo + dataHi) / 2;
  const needed = Math.max(minSpan, (dataHi - dataLo) * 1.25);
  let lo = Math.min(dataLo - (dataHi - dataLo) * 0.12, centre - needed / 2);
  let hi = Math.max(dataHi + (dataHi - dataLo) * 0.12, centre + needed / 2);
  if (lo < min) {
    hi += min - lo;
    lo = min;
  }
  if (hi > Math.max(max, dataHi) && lo > min) {
    const over = hi - Math.max(max, dataHi);
    lo = Math.max(min, lo - over);
    hi -= over;
  }
  const span = hi - lo || 1;

  const n = values.length;
  const t0 = at && at.length === n ? Math.min(...at) : 0;
  const t1 = at && at.length === n ? Math.max(...at) : 0;
  const timed = at !== undefined && at.length === n && t1 > t0;
  const x = (i: number) => {
    if (n <= 1) return padL + (w - padL - padR) / 2;
    const frac = timed ? ((at as number[])[i] - t0) / (t1 - t0) : i / (n - 1);
    return padL + frac * (w - padL - padR);
  };
  const y = (v: number) => padT + (1 - (v - lo) / span) * (height - padT - padB);

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

  const firstIndex = values.findIndex((v) => v !== null && Number.isFinite(v));
  const lastIndex = values.reduce<number>((acc, v, i) => (v !== null && Number.isFinite(v) ? i : acc), -1);
  const firstValue = firstIndex >= 0 ? (values[firstIndex] as number) : null;
  const area =
    runs.length > 0
      ? runs
          .map((r) => `M ${x(r[0].i)} ${height - padB} ` + r.map((p) => `L ${x(p.i)} ${y(p.v)}`).join(' ') + ` L ${x(r[r.length - 1].i)} ${height - padB} Z`)
          .join(' ')
      : '';

  return (
    <div className="spark-wrap" ref={host}>
      <svg className="spark" width="100%" height={height} viewBox={`0 0 ${w} ${height}`} role="img" aria-label={label}>
        <defs>
          <linearGradient id={`sg-${label.replace(/[^a-z0-9]/gi, '')}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.28} />
            <stop offset="100%" stopColor={color} stopOpacity={0.02} />
          </linearGradient>
        </defs>

        {/* Axis bounds, drawn AND labelled — an autoscaled plot has to say what it spans. */}
        <line x1={padL} x2={w - padR} y1={padT} y2={padT} stroke="#26314c" strokeWidth={1} />
        <line x1={padL} x2={w - padR} y1={height - padB} y2={height - padB} stroke="#26314c" strokeWidth={1} />
        <text x={padL - 8} y={padT + 5} textAnchor="end" className="spark-axis">
          {format(hi)}
        </text>
        <text x={padL - 8} y={height - padB + 5} textAnchor="end" className="spark-axis">
          {format(lo)}
        </text>

        {band !== undefined && band > lo && band < hi && (
          <line x1={padL} x2={w - padR} y1={y(band)} y2={y(band)} stroke="#ffc945" strokeWidth={1.5} strokeDasharray="3 4" opacity={0.6} />
        )}

        {/* Where the patient STARTED. The gap between this line and the end marker is the change. */}
        {firstValue !== null && lastIndex !== firstIndex && (
          <line x1={padL} x2={w - padR} y1={y(firstValue)} y2={y(firstValue)} stroke="#8b97b5" strokeWidth={1.5} strokeDasharray="5 5" opacity={0.75} />
        )}

        {area && <path d={area} fill={`url(#sg-${label.replace(/[^a-z0-9]/gi, '')})`} stroke="none" />}

        {runs.map((r, k) =>
          r.length === 1 ? (
            <circle key={k} cx={x(r[0].i)} cy={y(r[0].v)} r={4.5} fill={color} />
          ) : (
            <polyline
              key={k}
              points={r.map((p) => `${x(p.i)},${y(p.v)}`).join(' ')}
              fill="none"
              stroke={color}
              strokeWidth={3.5}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          ),
        )}

        {/* Every session gets a tick on the baseline, at its real date. */}
        {values.map((_, i) => (
          <line key={i} x1={x(i)} x2={x(i)} y1={height - padB} y2={height - padB + 4} stroke="#3a465f" strokeWidth={1.5} />
        ))}

        {runs.flatMap((r) => r).map((p) => (
          <circle key={p.i} cx={x(p.i)} cy={y(p.v)} r={3} fill={color} opacity={0.85} />
        ))}
        {lastIndex >= 0 && <circle cx={x(lastIndex)} cy={y(values[lastIndex] as number)} r={6} fill={color} stroke="#0d1220" strokeWidth={2.5} />}
      </svg>
    </div>
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
