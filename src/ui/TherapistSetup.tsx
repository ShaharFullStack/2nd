import { useEffect, useMemo, useState } from 'react';
import { attributionText } from '../audio/manifest.ts';
import type { SongEntry } from '../audio/manifest.ts';
import { DIFFICULTIES, DIFFICULTY_NAMES, windowsFor } from '../engine/difficulty.ts';
import type { DifficultyName, LaneSpec, Side } from '../engine/types.ts';
import { runtime } from '../session/runtime.ts';
import { MAX_LANES, MIN_LANES, movementsFor, useStore } from '../state/store.ts';
import { MOVEMENT_INFO, laneConflicts } from '../vision/features.ts';
import { Screen, Toast, TopBar } from './common.tsx';

const DIFFICULTY_BLURB: Record<DifficultyName, string> = {
  easy: 'Half the range counts as a hit, one note every other beat. Start here.',
  medium: 'Two thirds of range, roughly one note per beat.',
  hard: 'Near-full range, one and a half notes per beat.',
};

function laneLabel(l: LaneSpec): string {
  return `${l.side === 'left' ? 'Left' : 'Right'} · ${MOVEMENT_INFO[l.movement].label}`;
}

export default function TherapistSetup() {
  const goto = useStore((s) => s.goto);
  const mode = useStore((s) => s.mode);
  const lanes = useStore((s) => s.lanes);
  const setLane = useStore((s) => s.setLane);
  const addLane = useStore((s) => s.addLane);
  const removeLane = useStore((s) => s.removeLane);
  const difficulty = useStore((s) => s.difficulty);
  const setDifficulty = useStore((s) => s.setDifficulty);
  const windowScale = useStore((s) => s.windowScale);
  const setWindowScale = useStore((s) => s.setWindowScale);
  const songId = useStore((s) => s.songId);
  const setSong = useStore((s) => s.setSong);
  const inputMode = useStore((s) => s.inputMode);

  const [catalog, setCatalog] = useState<SongEntry[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    runtime
      .songCatalog()
      .then((entries) => {
        if (!alive) return;
        setCatalog(entries);
        if (entries.length > 0 && !entries.some((e) => e.id === songId)) setSong(entries[0].id);
      })
      .catch((err: unknown) => alive && setCatalogError(String(err)));
    return () => {
      alive = false;
    };
  }, [songId, setSong]);

  const conflicts = useMemo(() => laneConflicts(lanes), [lanes]);
  const blocking = conflicts.filter((c) => c.severity === 'error');
  const movements = movementsFor(mode);

  const start = () => {
    void runtime.ensureAudio().catch(() => undefined);
    goto(inputMode === 'camera' ? 'camera' : 'play');
  };

  return (
    <Screen>
      <TopBar
        eyebrow="Step 2 of 3"
        title={mode === 'leg' ? 'Prescribe the leg session' : 'Prescribe the hand session'}
        onBack={() => goto('mode')}
        right={
          <button className="btn btn-primary btn-lg" disabled={blocking.length > 0} onClick={start} data-testid="setup-start">
            {inputMode === 'camera' ? 'Set up camera →' : 'Start session →'}
          </button>
        }
      />

      <div className="card stack">
        <div className="row">
          <h3>Lanes ({lanes.length})</h3>
          <span className="dim">2–4 movements, one lane each. Notes arrive in the lane's colour.</span>
          <div className="grow" />
          <button className="btn" onClick={addLane} disabled={lanes.length >= MAX_LANES} data-testid="add-lane">
            + Add lane
          </button>
        </div>

        <ul className="list-reset">
          {lanes.map((lane, i) => (
            <li className="lane-row" key={i}>
              <div className="stack" style={{ gap: 6 }}>
                <div className="row" style={{ gap: 10 }}>
                  <span className="badge">Lane {i + 1}</span>
                  <b>{laneLabel(lane)}</b>
                </div>
                <span className="dim">{MOVEMENT_INFO[lane.movement].instructions}</span>
              </div>

              <select
                className="control"
                value={lane.movement}
                aria-label={`Lane ${i + 1} movement`}
                onChange={(e) => setLane(i, { movement: e.target.value as LaneSpec['movement'] })}
              >
                {movements.map((m) => (
                  <option key={m} value={m}>
                    {MOVEMENT_INFO[m].label}
                  </option>
                ))}
              </select>

              <div className="seg" role="group" aria-label={`Lane ${i + 1} side`}>
                {(['left', 'right'] as Side[]).map((side) => (
                  <button key={side} aria-pressed={lane.side === side} onClick={() => setLane(i, { side })}>
                    {side === 'left' ? 'L' : 'R'}
                  </button>
                ))}
              </div>

              <button
                className="btn btn-ghost btn-danger"
                onClick={() => removeLane(i)}
                disabled={lanes.length <= MIN_LANES}
                aria-label={`Remove lane ${i + 1}`}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>

        {conflicts.map((c, i) => (
          <Toast key={i} kind={c.severity === 'error' ? 'bad' : 'warn'}>
            <b>Lanes {c.lanes[0] + 1} &amp; {c.lanes[1] + 1}:</b> {c.message}
          </Toast>
        ))}
      </div>

      <div className="stack">
        <h3>Difficulty</h3>
        <div className="card-grid">
          {DIFFICULTY_NAMES.map((name) => {
            const d = DIFFICULTIES[name];
            return (
              <button
                key={name}
                className="card pick"
                aria-pressed={difficulty === name}
                onClick={() => setDifficulty(name)}
                data-testid={`difficulty-${name}`}
              >
                <div className="pick-title" style={{ textTransform: 'capitalize' }}>
                  {name}
                </div>
                <div className="pick-sub">{DIFFICULTY_BLURB[name]}</div>
                <div className="row" style={{ gap: 8 }}>
                  <span className="badge">Hit at {Math.round(d.thresholdFraction * 100)}% of ROM</span>
                  <span className="badge">{d.noteDensity} notes/beat</span>
                  <span className="badge">
                    ±{d.windows.perfectMs}/{d.windows.goodMs} ms
                  </span>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      <div className="card stack">
        <div className="row">
          <h3>Timing window</h3>
          <span className="badge">×{windowScale.toFixed(2)}</span>
          <div className="grow" />
          <span className="dim">
            {lanes.map((l, i) => {
              const w = windowsFor(l.movement, difficulty, undefined, windowScale);
              return (
                <span key={i} style={{ marginLeft: 12 }}>
                  L{i + 1} ±{Math.round(w.perfectMs)}/{Math.round(w.goodMs)} ms
                </span>
              );
            })}
          </span>
        </div>
        <input
          type="range"
          min={0.5}
          max={3}
          step={0.05}
          value={windowScale}
          aria-label="Timing window scale"
          onChange={(e) => setWindowScale(Number(e.target.value))}
        />
        <span className="dim">
          Widen the windows for patients whose movement is slow to initiate — fine-motor lanes already get ×1.6 on top of this.
        </span>
      </div>

      <div className="stack">
        <h3>Song</h3>
        {catalogError && <Toast kind="bad">Could not read the song list: {catalogError}</Toast>}
        {!catalog && !catalogError && <p className="muted">Loading songs…</p>}
        <div className="card-grid">
          {catalog?.map((entry) => {
            const m = entry.manifest;
            const ready = entry.status === 'ready';
            return (
              <button
                key={entry.id}
                className="card pick"
                aria-pressed={songId === entry.id}
                onClick={() => setSong(entry.id)}
                disabled={!m}
                data-testid={`song-${entry.id}`}
              >
                <div className="row">
                  <span
                    className="art"
                    aria-hidden="true"
                    style={{ background: ready ? 'linear-gradient(140deg,#ff3d7f,#35d6ff)' : '#1d2438' }}
                  >
                    {ready ? '♫' : '↓'}
                  </span>
                  <div className="stack" style={{ gap: 2 }}>
                    <div className="pick-title">{m?.title ?? entry.id}</div>
                    <div className="pick-sub">
                      {m ? `${m.artist} · ${m.bpm} BPM · ${Math.round(m.durationSec)} s` : (entry.error ?? 'Unreadable manifest')}
                    </div>
                  </div>
                </div>
                {!ready && m && (
                  <span className="badge badge-warn">
                    Needs fetch — {entry.missingStems.length} stem{entry.missingStems.length === 1 ? '' : 's'} missing (npm run fetch-stems)
                  </span>
                )}
                {m && <div className="attribution">{attributionText(m)}</div>}
              </button>
            );
          })}
        </div>
        {catalog?.some((e) => e.id === songId && e.status !== 'ready') && (
          <Toast>
            This song's stems are not downloaded. The session will still run — the chart plays silently
            against the same clock — but the patient hears nothing.
          </Toast>
        )}
      </div>

      <div className="row" style={{ paddingBottom: 24 }}>
        <button className="btn btn-primary btn-lg grow" disabled={blocking.length > 0} onClick={start}>
          {inputMode === 'camera' ? 'Set up camera →' : 'Start session →'}
        </button>
      </div>
    </Screen>
  );
}
