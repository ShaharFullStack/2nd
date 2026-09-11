/** Small presentational pieces shared by the screens. No store access, no side effects. */
import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { LaneSpec } from '../engine/types.ts';
import { FINGERTIP_NAME, MOVEMENT_INFO } from '../vision/features.ts';
import './therapist.css';

/**
 * The full, therapist-facing name of a lane — side, movement, AND the prescribed digit.
 *
 * Every message a therapist acts on ("lane 2 will not score", "lane 2 is not calibrated") identifies
 * its lane by this string. Two `finger_opposition` lanes on one hand are the prescription this app
 * exists to support, and without the digit both of those messages name "Left Finger opposition" and
 * the therapist cannot tell which lane to go and fix.
 */
export function laneName(spec: Pick<LaneSpec, 'movement' | 'side' | 'fingertip'>): string {
  const side = spec.side === 'left' ? 'Left' : 'Right';
  const tip = spec.movement === 'finger_opposition' ? ` (${FINGERTIP_NAME[spec.fingertip ?? 'index']})` : '';
  return `${side} ${MOVEMENT_INFO[spec.movement].label}${tip}`;
}

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

export interface SparkAxis {
  lo: number;
  hi: number;
}

/**
 * The vertical axis a series needs: its own range, padded, widened to `minSpan`, clamped into the
 * caller's outer bounds (never downward at the top — a ROM above 100 % of the calibrated range is a
 * real and good result).
 *
 * Exported because two stacked plots in one card have to be able to SHARE one axis. Autoscaling each
 * of them independently makes their slopes incomparable while they sit 8 px apart and aligned, and
 * the eye compares shapes before it reads the bounds.
 */
export function sparkAxis(
  values: (number | null)[],
  { min = 0, max = 1, minSpan = 0.25 }: { min?: number; max?: number; minSpan?: number } = {},
): SparkAxis {
  const finite = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (finite.length === 0) return { lo: Number.isFinite(min) ? min : 0, hi: Number.isFinite(max) ? max : 1 };
  const dataLo = Math.min(...finite);
  const dataHi = Math.max(...finite);
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
  return { lo, hi };
}

/** "12 Mar" — the shortest form that still says which session a point is. */
export function shortDate(ts: number): string {
  try {
    return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  } catch {
    return new Date(ts).toISOString().slice(0, 10);
  }
}


/**
 * THE ONE HORIZONTAL SCALE EVERY SESSION SERIES IN A CARD IS DRAWN ON.
 *
 * `Sparkline` and `SessionBars` are stacked inside a single trend card, share the same width and the
 * same gutters, and print the same first/last dates under them. They therefore have to put session
 * `i` at the same x — and they did not: the line positioned points by real timestamp while the
 * columns positioned them by even index slot. Four sessions in one week followed by a three-month gap
 * and two more bunched the ROM points into the leftmost fifty pixels while accuracy stayed six evenly
 * spaced columns, so the accuracy column above a ROM point belonged to a different session. Two marks
 * in one card that share an axis must be POSITIONED BY THE SAME FUNCTION, not merely captioned as if
 * they were.
 *
 * `step` is the smallest distance between adjacent marks, which is how wide a column may be drawn
 * without overlapping its neighbour — on a bunched series the columns get thin, which is the honest
 * picture of sessions that really were three days apart.
 */
export const AXIS_PAD_L = 52;
export const AXIS_PAD_R = 14;
/** Half of this may overhang the plot area into the gutters, so it may not exceed 2 × AXIS_PAD_R. */
const MAX_BAR_W = 24;

export interface SessionAxis {
  x: (i: number) => number;
  /** True when the marks are positioned by real date rather than by even index. */
  timed: boolean;
  /** Smallest gap between adjacent marks, in user units. */
  step: number;
}

export function sessionAxis(n: number, at: number[] | undefined, w: number): SessionAxis {
  const inner = w - AXIS_PAD_L - AXIS_PAD_R;
  const stamps = at !== undefined && at.length === n ? at : undefined;
  const t0 = stamps ? Math.min(...stamps) : 0;
  const t1 = stamps ? Math.max(...stamps) : 0;
  const timed = stamps !== undefined && t1 > t0;
  const x = (i: number) => {
    if (n <= 1) return AXIS_PAD_L + inner / 2;
    const frac = timed ? ((stamps as number[])[i] - t0) / (t1 - t0) : i / (n - 1);
    return AXIS_PAD_L + frac * inner;
  };
  let step = inner;
  for (let i = 1; i < n; i++) step = Math.min(step, Math.abs(x(i) - x(i - 1)));
  return { x, timed, step: n <= 1 ? inner : step };
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
 *  - IT IS FOR SERIES WHOSE SHAPE IS THE POINT AND WHOSE ZERO IS NOT. A quantity with a meaningful
 *    zero and a fixed ceiling (accuracy) is drawn by `SessionBars` instead: an autoscaled line beside
 *    another autoscaled line invites a comparison of slopes that the two scales do not license, and
 *    the fix for that is a different MARK, not a caption under it.
 *  - THE END SESSIONS ARE DATED ON THE AXIS. A clinic tablet has no hover, so a dip has to be
 *    locatable in time from the plot itself, not only from a caption or a table.
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
  height = 140,
  color = '#35d6ff',
  label,
  band,
  flagged,
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
  /**
   * POINTS THAT WERE NOT MEASURED UNDER THE SAME CONDITIONS AS THE REST — ringed, not hidden.
   *
   * A trend is the one view where a change in the equipment and a change in the patient look
   * identical, so a session measured on a degraded camera stream may not be drawn as the same kind
   * of dot as one measured on a clean one. Same length as `values`; omitted = nothing to flag.
   */
  flagged?: readonly boolean[];
  format?: (v: number) => string;
}) {
  const isFlagged = (i: number) => flagged !== undefined && flagged.length === values.length && flagged[i] === true;
  const host = useRef<HTMLDivElement>(null);
  // Per-INSTANCE, not derived from `label`: two cards with the same series name used to emit the same
  // SVG id, and both areas then painted from whichever gradient the document defined first.
  const gradientId = `sg${useId().replace(/[^a-z0-9]/gi, '')}`;
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

  const padL = AXIS_PAD_L;
  const padR = AXIS_PAD_R;
  const padT = 12;
  const padB = 34;

  const { lo, hi } = sparkAxis(values, { min, max, minSpan });
  const span = hi - lo || 1;

  const n = values.length;
  const { x, timed } = sessionAxis(n, at, w);
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
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.28} />
            <stop offset="100%" stopColor={color} stopOpacity={0.02} />
          </linearGradient>
        </defs>

        {/* Axis bounds, drawn AND labelled — an autoscaled plot has to say what it spans. */}
        <line x1={padL} x2={w - padR} y1={padT} y2={padT} stroke="#26314c" strokeWidth={1} />
        <line x1={padL} x2={w - padR} y1={height - padB} y2={height - padB} stroke="#26314c" strokeWidth={1} />
        <text x={padL - 16} y={padT + 5} textAnchor="end" className="spark-axis">
          {format(hi)}
        </text>
        <text x={padL - 16} y={height - padB + 5} textAnchor="end" className="spark-axis">
          {format(lo)}
        </text>

        {band !== undefined && band > lo && band < hi && (
          <line x1={padL} x2={w - padR} y1={y(band)} y2={y(band)} stroke="#ffc945" strokeWidth={1.5} strokeDasharray="3 4" opacity={0.6} />
        )}

        {/* Where the patient STARTED. The gap between this line and the end marker is the change. */}
        {firstValue !== null && lastIndex !== firstIndex && (
          <line x1={padL} x2={w - padR} y1={y(firstValue)} y2={y(firstValue)} stroke="#8b97b5" strokeWidth={1.5} strokeDasharray="5 5" opacity={0.75} />
        )}

        {area && <path d={area} fill={`url(#${gradientId})`} stroke="none" />}

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

        {/* Every session gets a tick on the baseline, at its real date. A session measured on a
            degraded (or unrecorded) camera stream gets a TALLER AMBER tick, so it is locatable in
            time even when its own value was never measured and no point was drawn for it. */}
        {values.map((_, i) => (
          <line
            key={i}
            x1={x(i)}
            x2={x(i)}
            y1={height - padB}
            y2={height - padB + (isFlagged(i) ? 9 : 4)}
            stroke={isFlagged(i) ? '#ffb020' : '#3a465f'}
            strokeWidth={isFlagged(i) ? 2.5 : 1.5}
            data-flagged={isFlagged(i) ? 'true' : undefined}
          />
        ))}

        {/* First and last session DATED on the axis. On a tablet there is no hover, so without this a
            therapist who sees a dip has to cross-read a table to find out which session it was. */}
        {timed && (
          <>
            <text x={padL} y={height - padB + 17} textAnchor="start" className="spark-axis">
              {shortDate((at as number[])[0])}
            </text>
            <text x={w - padR} y={height - padB + 17} textAnchor="end" className="spark-axis">
              {shortDate((at as number[])[n - 1])}
            </text>
          </>
        )}

        {runs.flatMap((r) => r).map((p) => (
          <circle key={p.i} cx={x(p.i)} cy={y(p.v)} r={3} fill={color} opacity={0.85} />
        ))}
        {lastIndex >= 0 && <circle cx={x(lastIndex)} cy={y(values[lastIndex] as number)} r={6} fill={color} stroke="#0d1220" strokeWidth={2.5} />}

        {/* THE RING THAT SAYS "THIS POINT WAS MEASURED DIFFERENTLY". Drawn over the marker so it
            survives the big end-of-series dot, in the same amber as the tick below it. */}
        {runs.flatMap((r) => r).filter((p) => isFlagged(p.i)).map((p) => (
          <circle
            key={`flag-${p.i}`}
            cx={x(p.i)}
            cy={y(p.v)}
            r={8}
            fill="none"
            stroke="#ffb020"
            strokeWidth={2.5}
            data-testid={`spark-flag-${p.i}`}
          />
        ))}

        {/* Per-point readout for the pointer devices that have one; the dated table under the card is
            the version a tablet can use. */}
        {runs.flatMap((r) => r).map((p) => (
          <circle key={`hit-${p.i}`} cx={x(p.i)} cy={y(p.v)} r={12} fill="transparent">
            <title>{`${at && at.length === n ? `${shortDate(at[p.i])} · ` : ''}${format(p.v)}${isFlagged(p.i) ? ' · degraded or unrecorded camera stream' : ''}`}</title>
          </circle>
        ))}
      </svg>
    </div>
  );
}

/**
 * A proportion, per session, as columns from a true zero on a fixed 0..100 % axis.
 *
 * Accuracy is drawn this way and range of motion is not, and the difference is deliberate. Two
 * autoscaled lines stacked and aligned in one card read as comparable slopes even when their axes
 * span 49–81 % and 39–85 %; the eye compares shapes long before it reads the bounds, and no caption
 * undoes that. Accuracy is the series that can afford the fixed axis — it is a proportion of judged
 * notes, it has a real zero and a real ceiling, and a clinically interesting change in it is tens of
 * points. Giving it a different mark on an absolute scale removes the false comparison at its root
 * rather than annotating it.
 */
export function SessionBars({
  values,
  at,
  width = 320,
  height = 120,
  color = '#35d6ff',
  label,
  format = (v: number) => `${Math.round(v * 100)}%`,
}: {
  values: (number | null)[];
  at?: number[];
  width?: number;
  height?: number;
  color?: string;
  label: string;
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

  const padL = AXIS_PAD_L;
  const padR = AXIS_PAD_R;
  const padT = 12;
  const padB = 34;
  const base = height - padB;
  const n = Math.max(1, values.length);
  // SAME x AS THE PLOTS ABOVE IT (see `sessionAxis`): column i and point i are the same session, so
  // they sit at the same place. The column WIDTH follows from the tightest gap, so bunched sessions
  // draw thin columns rather than sliding apart into even slots that lie about when they happened.
  const { x, timed, step } = sessionAxis(n, at, w);
  const barW = Math.max(5, Math.min(MAX_BAR_W, step * 0.62));
  const y = (v: number) => padT + (1 - Math.max(0, Math.min(1, v))) * (base - padT);
  const lastIndex = values.reduce<number>((acc, v, i) => (v !== null && Number.isFinite(v) ? i : acc), -1);

  return (
    <div className="spark-wrap" ref={host}>
      <svg className="spark" width="100%" height={height} viewBox={`0 0 ${w} ${height}`} role="img" aria-label={label}>
        <line x1={padL} x2={w - padR} y1={padT} y2={padT} stroke="#26314c" strokeWidth={1} />
        <line x1={padL} x2={w - padR} y1={base} y2={base} stroke="#3a465f" strokeWidth={1.5} />
        <line x1={padL} x2={w - padR} y1={y(0.5)} y2={y(0.5)} stroke="#26314c" strokeWidth={1} strokeDasharray="4 6" />
        <text x={padL - 16} y={padT + 5} textAnchor="end" className="spark-axis">
          {format(1)}
        </text>
        <text x={padL - 16} y={y(0.5) + 4} textAnchor="end" className="spark-axis">
          {format(0.5)}
        </text>
        <text x={padL - 16} y={base + 4} textAnchor="end" className="spark-axis">
          {format(0)}
        </text>

        {/* One tick per session on the baseline, at the same x as the plots above — the marks that
            make the shared time axis visible rather than merely claimed. */}
        {values.map((_, i) => (
          <line key={`t${i}`} x1={x(i)} x2={x(i)} y1={base} y2={base + 4} stroke="#3a465f" strokeWidth={1.5} />
        ))}

        {values.map((v, i) => {
          const cx = x(i);
          if (v === null || !Number.isFinite(v)) {
            // Not measured is not zero: no column at all, and the gap is labelled by its tick.
            return <line key={i} x1={cx} x2={cx} y1={base} y2={base + 4} stroke="#3a465f" strokeWidth={1.5} />;
          }
          return (
            <rect
              key={i}
              x={cx - barW / 2}
              y={y(v)}
              width={barW}
              height={Math.max(1.5, base - y(v))}
              rx={3}
              fill={color}
              opacity={i === lastIndex ? 1 : 0.62}
            >
              <title>{`${at && at.length === values.length ? `${shortDate(at[i])} · ` : ''}${format(v)}`}</title>
            </rect>
          );
        })}

        {/* Dated only when the marks really are placed by date — the same condition the plots above
            use, so the two never disagree about whether the axis is a timeline. */}
        {timed && at && (
          <>
            <text x={padL} y={height - padB + 17} textAnchor="start" className="spark-axis">
              {shortDate(at[0])}
            </text>
            <text x={w - padR} y={height - padB + 17} textAnchor="end" className="spark-axis">
              {shortDate(at[values.length - 1])}
            </text>
          </>
        )}
      </svg>
    </div>
  );
}

/**
 * "+12 pts" / "−4°" / "—" delta chip, green when up, red when down.
 *
 * `scale`/`digits`/`unit` exist because a card can carry two deltas of DIFFERENT quantities — a
 * percentage-point change in ROM and a change in degrees at the joint — and a chip that silently
 * rendered both as "pts" would be the same collision the titles are careful to avoid.
 */
export function DeltaBadge({
  value,
  unit = 'pts',
  goodWhenUp = true,
  scale = 100,
  digits = 0,
}: {
  value: number | null;
  unit?: string;
  goodWhenUp?: boolean;
  /** Multiplier from `value`'s units to the displayed number (100 = fraction → percentage points). */
  scale?: number;
  digits?: number;
}) {
  if (value === null || !Number.isFinite(value)) return <span className="badge">no trend yet</span>;
  const n = value * scale;
  const shown = Math.abs(n).toFixed(digits);
  if (Number(shown) === 0) return <span className="badge">no change</span>;
  const up = n > 0;
  const good = up === goodWhenUp;
  // A degree sign hugs its number; a word does not.
  const gap = unit === '\u00b0' ? '' : ' ';
  return (
    <span className={good ? 'badge badge-ok' : 'badge badge-bad'}>
      {up ? '▲' : '▼'} {up ? '+' : '−'}
      {shown}
      {gap}
      {unit}
    </span>
  );
}
