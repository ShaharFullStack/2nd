import { formatDate, formatDuration, formatMs, formatPercent } from '../session/results.ts';
import { useStore } from '../state/store.ts';
import { Screen, Stars, TopBar } from './common.tsx';

export default function HistoryScreen() {
  const goto = useStore((s) => s.goto);
  const history = useStore((s) => s.history);
  const clearHistory = useStore((s) => s.clearHistory);

  return (
    <Screen testId="history-screen">
      <TopBar
        eyebrow={`${history.length} session${history.length === 1 ? '' : 's'} on this device`}
        title="Session history"
        onBack={() => goto('home')}
        right={
          history.length > 0 ? (
            <button
              className="btn btn-danger"
              onClick={() => {
                if (confirm('Delete every stored session on this device?')) clearHistory();
              }}
            >
              Clear history
            </button>
          ) : undefined
        }
      />

      {history.length === 0 ? (
        <div className="card stack">
          <h3>Nothing recorded yet</h3>
          <p className="muted">Sessions are stored in this browser only — nothing leaves the device.</p>
          <button className="btn btn-primary btn-lg" onClick={() => goto('mode')}>
            Start a session
          </button>
        </div>
      ) : (
        <div className="card table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>When</th>
                <th>Session</th>
                <th>Score</th>
                <th>Stars</th>
                <th>Accuracy</th>
                <th>Reps</th>
                <th>Combo</th>
                <th>Timing</th>
                <th>Length</th>
                <th>Movements</th>
              </tr>
            </thead>
            <tbody>
              {history.map((r) => (
                <tr key={r.id}>
                  <td>
                    {formatDate(r.startedAt)}
                    {!r.completed && <div className="dim">ended early</div>}
                  </td>
                  <td>
                    <b>{r.songTitle}</b>
                    <div className="dim">
                      {r.mode === 'leg' ? 'Leg' : 'Hand'} · {r.difficulty}
                      {r.inputMode !== 'camera' ? ` · ${r.inputMode}` : ''}
                    </div>
                  </td>
                  <td className="mono">{r.score.toLocaleString()}</td>
                  <td>
                    <Stars value={r.stars} />
                  </td>
                  <td className="mono">{formatPercent(r.accuracy)}</td>
                  <td className="mono">{r.reps}</td>
                  <td className="mono">{r.maxCombo}</td>
                  <td className="mono">{formatMs(r.timingBiasMs)}</td>
                  <td className="mono">{formatDuration(r.durationSec)}</td>
                  <td>
                    {r.lanes.map((l) => (
                      <div key={l.lane} className="dim">
                        {l.label}: {l.reps} reps
                        {l.romMean !== null ? ` · ${formatPercent(l.romMean)} ROM` : ''}
                        {l.compensationMonitored && l.compensationFlags > 0 ? ` · ${l.compensationFlags} flagged` : ''}
                      </div>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Screen>
  );
}
