import { formatDuration, formatMs, formatPercent } from '../session/results.ts';
import { useStore } from '../state/store.ts';
import { Meter, Screen, Stars, Toast, TopBar } from './common.tsx';
import LatencyHandover from './LatencyHandover.tsx';

export default function ResultsScreen() {
  const goto = useStore((s) => s.goto);
  const result = useStore((s) => s.lastResult);
  const setSeed = useStore((s) => s.setSeed);
  const seed = useStore((s) => s.seed);

  if (!result) {
    return (
      <Screen>
        <TopBar title="No session to show" onBack={() => goto('home')} />
        <button className="btn btn-primary btn-lg" onClick={() => goto('home')}>
          Back to start
        </button>
      </Screen>
    );
  }

  return (
    <Screen testId="results-screen">
      <TopBar
        eyebrow={result.completed ? 'Session complete' : 'Session ended early'}
        title={result.songTitle}
        right={
          <>
            <button
              className="btn btn-lg"
              onClick={() => {
                setSeed(seed + 1);
                goto('play');
              }}
              data-testid="play-again"
            >
              Play again
            </button>
            <button className="btn btn-primary btn-lg" onClick={() => goto('mode')}>
              New session
            </button>
          </>
        }
      />

      <div className="card-grid">
        <div className="card stack">
          <div className="eyebrow">Score</div>
          <div className="big-number mono">{result.score.toLocaleString()}</div>
          <Stars value={result.stars} />
          <div className="dim">{formatPercent(result.starAccuracy)} weighted accuracy</div>
        </div>
        <div className="card stack">
          <div className="eyebrow">Movements performed</div>
          <div className="big-number mono">{result.reps}</div>
          <div className="dim">
            {result.hits} scored · {result.misses} missed of {result.totalNotes} notes
          </div>
          <Meter value={result.totalNotes > 0 ? result.hits / result.totalNotes : 0} label="notes hit" />
        </div>
        <div className="card stack">
          <div className="eyebrow">Best combo</div>
          <div className="big-number mono">{result.maxCombo}</div>
          <div className="dim">
            {formatDuration(result.durationSec)} played · {result.difficulty} · windows ×{result.windowScale.toFixed(2)}
          </div>
        </div>
        <div className="card stack">
          <div className="eyebrow">Timing bias</div>
          <div className="big-number mono">{formatMs(result.timingBiasMs)}</div>
          <div className="dim">
            spread ±{result.timingBiasMadMs === null ? '—' : Math.round(result.timingBiasMadMs)} ms · latency offset in force{' '}
            {result.latencyOffsetMs} ms
          </div>
        </div>
      </div>

      <LatencyHandover result={result} />

      {result.reps > 0 && result.hits === 0 && (
        <Toast kind="bad">
          The patient performed {result.reps} movements and none of them scored. That is a calibration or latency fault,
          not a performance — check the ROM ranges and re-run the latency check.
        </Toast>
      )}

      <div className="card stack">
        <h3>Per movement</h3>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Movement</th>
                <th>Accuracy</th>
                <th>Hits</th>
                <th>Missed</th>
                <th>Reps</th>
                <th>ROM achieved</th>
                <th>Best rep</th>
                <th>Timing</th>
                <th>Compensation</th>
              </tr>
            </thead>
            <tbody>
              {result.lanes.map((l) => (
                <tr key={l.lane}>
                  <td>
                    <b>{l.label}</b>
                    <div className="dim">{l.perfects} perfect · {l.goods} good</div>
                  </td>
                  <td>{formatPercent(l.accuracy)}</td>
                  <td>{l.hits}</td>
                  <td>{l.misses}</td>
                  <td>{l.reps}</td>
                  <td>
                    {l.romSamples > 0 ? (
                      <>
                        {formatPercent(l.romMean)}
                        <div className="dim">
                          of calibrated range, {l.romSamples} reps
                          {l.calibratedMin !== null && l.calibratedMax !== null
                            ? ` (${l.calibratedMin.toFixed(2)}→${l.calibratedMax.toFixed(2)}${l.calibrationManual ? ', set by hand' : ''})`
                            : ''}
                        </div>
                      </>
                    ) : (
                      <span className="dim">not measured</span>
                    )}
                  </td>
                  <td>{l.romBest === null ? <span className="dim">—</span> : formatPercent(l.romBest)}</td>
                  <td>
                    {formatMs(l.timingBiasMs)}
                    {l.timingBiasMadMs !== null && <div className="dim">±{Math.round(l.timingBiasMadMs)} ms</div>}
                  </td>
                  <td>
                    {l.compensationKind === null ? (
                      <span className="dim">n/a</span>
                    ) : !l.compensationMonitored ? (
                      <span className="badge badge-warn">not measured</span>
                    ) : l.compensationFlags === 0 ? (
                      <span className="badge badge-ok">clean</span>
                    ) : (
                      <span className="badge badge-bad">
                        {l.compensationFlags} × {l.compensationKind.replace('_', ' ')}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {result.lanes.some((l) => l.romUncertain > 0) && (
          <span className="dim">
            Some reps were measured across dropped camera frames; their range is a lower bound and is marked uncertain in
            the stored record.
          </span>
        )}
      </div>

      <div className="card row">
        <div className="stack" style={{ gap: 4 }}>
          <span className="badge badge-ok">Saved to history</span>
          <span className="attribution">{result.attribution}</span>
        </div>
        <div className="grow" />
        <button className="btn" onClick={() => goto('history')} data-testid="open-history-from-results">
          Session history
        </button>
      </div>
    </Screen>
  );
}
