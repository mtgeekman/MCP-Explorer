// What the user can set on a live session (phase 10): the log level, ping,
// the modern listen stream, and the health check. Each control sends exactly
// one thing when pressed, and nothing on its own (P2).
import { useCallback, useEffect, useState } from 'react';
import type { HealthReport, ServerRow, SessionInfo, UtilityOutcome } from '../../../../packages/backend/dist/index.js';
import type { BackendClient } from '../lib/client';
import { healthLines, levelLabel, listenText, logLevelControl, type LogLevel } from '../lib/session';

const FLAGS = [
  ['toolsListChanged', 'Tool list changes'],
  ['promptsListChanged', 'Prompt list changes'],
  ['resourcesListChanged', 'Resource list changes'],
] as const;

export function SessionPanel({ client, server }: { client: BackendClient; server: ServerRow }) {
  const [info, setInfo] = useState<SessionInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ping, setPing] = useState<string | null>(null);
  const [flags, setFlags] = useState<Record<string, boolean>>({ toolsListChanged: true, promptsListChanged: true, resourcesListChanged: true });
  const live = server.state.status === 'connected';

  const load = useCallback(() => {
    client.request('session.get', { serverId: server.id }).then(setInfo, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [client, server.id]);
  useEffect(() => {
    load();
    return client.on((name, data) => {
      if (name === 'session.changed' && (data as { serverId: string }).serverId === server.id) load();
    });
  }, [client, server.id, load, live]);

  const act = (work: () => Promise<unknown>) => { setError(null); work().catch((e: unknown) => setError(e instanceof Error ? e.message : String(e))); };
  const outcomeText = (o: UtilityOutcome) => (o.kind === 'result' ? `answered in ${Math.round(o.elapsedMs)} ms` : o.kind === 'error' ? `error ${String(o.error.code)}: ${String(o.error.message)}` : o.kind === 'failed' ? o.message : 'cancelled');

  if (!live || !info?.connected) return null;
  const control = logLevelControl(info);
  const listen = info.listen;
  const listenOpen = listen?.status === 'open';
  return (
    <section className="session">
      <div className="surface-head"><h3>Session</h3><span className="muted">Settings for this connection only; they end with it.</span></div>
      <div className="session-grid">
        <label className="field">
          <span>Log level</span>
          <select value={info.logLevel ?? ''} onChange={(e) => act(async () => {
            const level = (e.target.value || null) as LogLevel | null;
            const outcome = await client.request('session.setLogLevel', { serverId: server.id, level });
            if (outcome && outcome.kind !== 'result') setError(`logging/setLevel: ${outcomeText(outcome)}`);
          })}>
            {control.options.map((l) => <option key={l ?? ''} value={l ?? ''}>{levelLabel(l)}</option>)}
          </select>
          <small className="muted">{control.note} Messages appear under Notifications.</small>
        </label>
        <div className="field">
          <span>Ping</span>
          {info.era === 'legacy'
            ? <div className="actions left"><button onClick={() => act(async () => setPing(outcomeText(await client.request('session.request', { serverId: server.id, method: 'ping' }))))}>Ping</button>{ping && <span className="muted">{ping}</span>}</div>
            : <small className="muted">Unavailable on {info.revision}: the revision removed ping, and gives a connection no liveness check of its own.</small>}
        </div>
      </div>
      {info.era === 'modern' && (
        <div className="listen">
          <h4>Listen for notices</h4>
          <p className="muted">{listenText(listen)}</p>
          <div className="actions left">
            {FLAGS.map(([key, label]) => (
              <label key={key} className="check"><input type="checkbox" checked={flags[key]} onChange={(e) => setFlags((f) => ({ ...f, [key]: e.target.checked }))} /> {label}</label>
            ))}
          </div>
          <div className="actions left">
            <button className="primary" onClick={() => act(() => client.request('session.listen', {
              serverId: server.id,
              filter: { ...Object.fromEntries(FLAGS.filter(([k]) => flags[k]).map(([k]) => [k, true])), ...(info.subscribed.length ? { resourceSubscriptions: info.subscribed } : {}) },
            }))}>{listenOpen ? 'Open again with these' : 'Open listen'}</button>
            {listenOpen && <button onClick={() => act(() => client.request('session.listen', { serverId: server.id, filter: null }))}>Close listen</button>}
          </div>
          <small className="muted">One stream per connection: changing what it asks for closes it and opens another. Resource subscriptions ride on it.</small>
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  );
}

/** The health check's report: shown, never stored (decision 12). */
export function HealthView({ report, onClose }: { report: HealthReport; onClose: () => void }) {
  const view = healthLines(report);
  return (
    <div className={`state-card health ${view.tone}`}>
      <div className="actions left">
        <h3>{view.headline}</h3>
        <span className="header-spacer" />
        <span className="muted">{new Date(report.at).toLocaleTimeString()}</span>
        <button onClick={onClose}>Close</button>
      </div>
      {view.sections.map((s) => (
        <div key={s.title}>
          <h4>{s.title}</h4>
          <ul className="mono health-lines">{s.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>
        </div>
      ))}
    </div>
  );
}
