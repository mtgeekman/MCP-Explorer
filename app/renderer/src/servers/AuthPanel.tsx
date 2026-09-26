// A remote server's sign-in (plan phase 11 decisions 5 and 12): what the app
// holds, never a token value, and one button per step. The browser opens only
// when the user presses Open in browser.
import { useCallback, useEffect, useState } from 'react';
import type { AuthReport, ServerRow } from '../../../../packages/backend/dist/index.js';
import type { BackendClient } from '../lib/client';
import { ACTION_LABEL, authActions, authLines, type AuthAction } from '../lib/auth';

export function AuthPanel({ client, server }: { client: BackendClient; server: ServerRow }) {
  const [report, setReport] = useState<AuthReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());

  const load = useCallback(() => {
    client.request('auth.get', { serverId: server.id }).then((r) => { setReport(r); setNow(Date.now()); }, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [client, server.id]);
  useEffect(() => {
    load();
    return client.on((name, data) => {
      if (name === 'auth.changed' && (data as { serverId: string }).serverId === server.id) load();
    });
  }, [client, server.id, load, server.state.status]);

  if (server.transport === 'stdio' || !report) return null;

  const act = async (a: AuthAction) => {
    setError(null);
    if (a === 'open') {
      const opened = report.pending ? await window.mcpxShell?.openExternal(report.pending.authorizationUrl) : false;
      if (!opened) setError('The page could not be opened. Copy the address below into a browser instead.');
      return;
    }
    setBusy(true);
    try {
      if (a === 'sign-in') await client.request('auth.signIn', { serverId: server.id });
      else if (a === 'register-again') await client.request('auth.signIn', { serverId: server.id, reregister: true });
      else if (a === 'cancel') await client.request('auth.cancel', { serverId: server.id });
      else if (a === 'refresh') await client.request('auth.refresh', { serverId: server.id });
      else if (a === 'sign-out') await client.request('auth.signOut', { serverId: server.id });
      else if (a === 'forget') await client.request('auth.signOut', { serverId: server.id, registrations: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      load();
    }
  };

  return (
    <section className="session auth">
      <div className="surface-head"><h3>Sign-in</h3><span className="muted">OAuth for this server. Token values are never shown.</span></div>
      {authLines(report, now).map((l) => <p key={l}>{l}</p>)}
      {report.pending && (
        <p className="mono selectable">{report.pending.authorizationUrl}</p>
      )}
      {report.lastFailure && !report.pending && <p className="error">{report.lastFailure.message}</p>}
      {report.warnings.length > 0 && (
        <details>
          <summary>{report.warnings.length === 1 ? '1 thing a strict client would refuse' : `${report.warnings.length} things a strict client would refuse`}</summary>
          {report.warnings.map((w) => <p key={w} className="warn">{w}</p>)}
        </details>
      )}
      {report.endpoints && (
        <details>
          <summary>Endpoints</summary>
          <dl className="facts mono">
            <dt>Authorization server</dt><dd>{report.authorizationServer}</dd>
            {report.endpoints.authorization && (<><dt>Authorize</dt><dd>{report.endpoints.authorization}</dd></>)}
            {report.endpoints.token && (<><dt>Token</dt><dd>{report.endpoints.token}</dd></>)}
            {report.endpoints.registration && (<><dt>Register</dt><dd>{report.endpoints.registration}</dd></>)}
          </dl>
        </details>
      )}
      <div className="actions left">
        {authActions(report).map((a) => (
          <button key={a} className={a === 'sign-in' || a === 'open' ? 'primary' : a === 'forget' ? 'danger' : ''} disabled={busy && a !== 'open'} onClick={() => void act(a)}>
            {ACTION_LABEL[a]}
          </button>
        ))}
      </div>
      {error && <p className="error">{error}</p>}
    </section>
  );
}
