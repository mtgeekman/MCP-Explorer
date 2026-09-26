// One server's connection (round 3): every state, every failure leading with
// what the process did, and the two offers D20 allows. Starting a server
// again is always a button the user presses (P2).
import { useEffect, useState } from 'react';
import type { CallView, ServerForm, ServerRow } from '../../../../packages/backend/dist/index.js';
import { CallHistory } from '../calls/CallHistory';
import type { BackendClient } from '../lib/client';
import { commandLine, describeState } from '../lib/describe';
import { SurfacePanel, type SelectedItem } from '../surface/SurfacePanel';

export function ServerDetail({ client, server, onEdit, onDeleted, onChanged, selectedItem, onSelectItem, onReadCall }: {
  client: BackendClient; server: ServerRow; onEdit: () => void; onDeleted: () => void; onChanged: () => void;
  selectedItem: SelectedItem | null; onSelectItem: (item: SelectedItem | null) => void; onReadCall: (view: CallView) => void;
}) {
  const [form, setForm] = useState<ServerForm | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    void client.request('servers.get', { id: server.id }).then(setForm);
  }, [client, server.id]);

  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const call = (method: 'connections.connect' | 'connections.startAgain' | 'connections.redetect' | 'connections.disconnect') =>
    run(() => client.request(method, { serverId: server.id }));

  const state = server.state;
  const view = describeState(state, {
    transport: server.transport,
    commandLine: form?.command ? commandLine(form.command, form.args) : undefined,
    url: form?.url,
    platform: navigator.userAgent.includes('Windows') ? 'win32' : undefined,
  });
  const live = state.status === 'connected';
  const moving = state.status === 'connecting' || state.status === 'closing';

  return (
    <section className="detail">
      <header className="detail-head">
        <div>
          <h2>{server.name}</h2>
          <p className="sub mono">{form?.command ? commandLine(form.command, form.args) : form?.url}</p>
        </div>
        <div className="actions">
          {!live && !moving && <button className="primary" disabled={busy} onClick={() => call('connections.connect')}>Connect</button>}
          {live && <button disabled={busy} onClick={() => call('connections.disconnect')}>Disconnect</button>}
          {live && (
            <button disabled={busy} title={server.transport === 'stdio' ? 'Restarts the server and probes its era again' : 'Probes the era again'} onClick={() => call('connections.redetect')}>
              Re-detect era
            </button>
          )}
          <button disabled={busy || live || moving} onClick={onEdit}>Edit</button>
          {!confirmDelete && <button disabled={busy || moving} onClick={() => setConfirmDelete(true)}>Delete</button>}
        </div>
      </header>
      {confirmDelete && (
        <div className="confirm-bar">
          <span>Delete {server.name} and its whole history: every connection, call and logged byte?</span>
          <button onClick={() => setConfirmDelete(false)}>Keep it</button>
          <button className="danger" disabled={busy} onClick={() => run(async () => { await client.request('servers.delete', { id: server.id }); onDeleted(); })}>Delete</button>
        </div>
      )}

      <div className={`state-card ${view.tone}`}>
        <h3>{view.headline}</h3>
        {view.facts.map((f) => <p key={f}>{f}</p>)}
        {state.status === 'connecting' && <Steps step={state.step} stdio={server.transport === 'stdio'} />}
        {view.stderr && (<><h4>What it printed to stderr</h4><pre className="stderr mono">{view.stderr}</pre></>)}
        {view.protocolMessage && (<><h4>Protocol message</h4><p className="mono">{view.protocolMessage}</p></>)}
        {view.offers.length > 0 && (
          <div className="actions left">
            {view.offers.map((o) => (
              <button key={o.action} className={o.action === 'start-again' ? 'primary' : ''} disabled={busy}
                onClick={() => (o.action === 'start-again' ? call('connections.startAgain') : call('connections.disconnect'))}>
                {o.label}
              </button>
            ))}
          </div>
        )}
        {state.status === 'needs-secrets' && (
          <SecretsForm missing={state.missing} busy={busy}
            onSubmit={(secrets) => run(() => client.request('connections.connect', { serverId: server.id, secrets }))} />
        )}
      </div>
      {error && <p className="error">{error}</p>}
      <SurfacePanel client={client} server={server} selected={selectedItem} onSelect={onSelectItem} onReadCall={onReadCall} />
      <CallHistory client={client} serverId={server.id} onRead={onReadCall} />
    </section>
  );
}

function Steps({ step, stdio }: { step: 'starting' | 'negotiating'; stdio: boolean }) {
  const steps = stdio ? ['Start the process', 'Negotiate the protocol era'] : ['Negotiate the protocol era'];
  const at = stdio && step === 'starting' ? 0 : steps.length - 1;
  return (
    <ol className="steps">
      {steps.map((s, i) => <li key={s} className={i < at ? 'done' : i === at ? 'now' : ''}>{s}</li>)}
    </ol>
  );
}

function SecretsForm({ missing, busy, onSubmit }: {
  missing: { env?: string[]; headers?: string[] }; busy: boolean;
  onSubmit: (s: { env?: Record<string, string>; headers?: Record<string, string> }) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const fields = [...(missing.env ?? []).map((n) => ['env', n] as const), ...(missing.headers ?? []).map((n) => ['header', n] as const)];
  const key = (kind: string, name: string) => `${kind}:${name}`;
  const complete = fields.every(([k, n]) => values[key(k, n)]);
  const submit = () => {
    const pick = (kind: 'env' | 'header') => Object.fromEntries(fields.filter(([k]) => k === kind).map(([k, n]) => [n, values[key(k, n)]]));
    onSubmit({ env: pick('env'), headers: pick('header') });
  };
  return (
    <form className="secrets-form" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      {fields.map(([kind, name]) => (
        <label key={key(kind, name)} className="field">
          <span>{kind === 'env' ? 'Environment variable' : 'Header'} <code className="mono">{name}</code></span>
          <input type="password" className="mono" value={values[key(kind, name)] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [key(kind, name)]: e.target.value }))} />
        </label>
      ))}
      <div className="actions left"><button type="submit" className="primary" disabled={!complete || busy}>Connect</button></div>
    </form>
  );
}
