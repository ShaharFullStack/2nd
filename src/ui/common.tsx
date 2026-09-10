/** Small presentational pieces shared by the screens. No store access, no side effects. */
import type { ReactNode } from 'react';

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
