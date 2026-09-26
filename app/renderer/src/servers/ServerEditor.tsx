// Adding and editing a server by hand. The command line is shown exactly as
// it will run, and nothing runs until the user connects (round 3). Stored
// secret values never come back from the backend (D31): an edit keeps them
// unless a new value is typed.
import { useEffect, useState } from 'react';
import type { ServerForm, ServerRow } from '../../../../packages/backend/dist/index.js';
import type { BackendClient } from '../lib/client';
import { commandLine } from '../lib/describe';
import { formatArgs, formatEnv, formatHeaders, parseArgs, parseEnv, parseHeaders } from '../lib/form';

type Transport = ServerForm['transport'];
interface SecretRow { kind: 'env' | 'header'; name: string; value: string; stored: boolean }

export function ServerEditor({ client, encrypted, serverId, onSaved, onCancel }: {
  client: BackendClient; encrypted: boolean; serverId?: string;
  onSaved: (row: ServerRow) => void; onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [transport, setTransport] = useState<Transport>('stdio');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [cwd, setCwd] = useState('');
  const [url, setUrl] = useState('');
  const [env, setEnv] = useState('');
  const [headers, setHeaders] = useState('');
  const [secrets, setSecrets] = useState<SecretRow[]>([]);
  // A client registered with the server's authorization server by hand (phase 11 decision 6).
  const [clientId, setClientId] = useState('');
  const [redirectUri, setRedirectUri] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [clientSecretStored, setClientSecretStored] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(!serverId);

  useEffect(() => {
    if (!serverId) return;
    void client.request('servers.get', { id: serverId }).then((f) => {
      setName(f.name);
      setTransport(f.transport);
      setCommand(f.command ?? '');
      setArgs(formatArgs(f.args));
      setCwd(f.cwd ?? '');
      setUrl(f.url ?? '');
      setEnv(formatEnv(f.env));
      setHeaders(formatHeaders(f.headers));
      setSecrets([
        ...Object.keys(f.secretEnv ?? {}).map((n) => ({ kind: 'env' as const, name: n, value: '', stored: true })),
        ...Object.keys(f.secretHeaders ?? {}).map((n) => ({ kind: 'header' as const, name: n, value: '', stored: true })),
        ...(f.unstoredSecrets?.env ?? []).map((n) => ({ kind: 'env' as const, name: n, value: '', stored: false })),
        ...(f.unstoredSecrets?.headers ?? []).map((n) => ({ kind: 'header' as const, name: n, value: '', stored: false })),
      ]);
      setClientId(f.oauthClient?.clientId ?? '');
      setRedirectUri(f.oauthClient?.redirectUri ?? '');
      setClientSecretStored(f.oauthClient?.clientSecret === null);
      setLoaded(true);
    });
  }, [client, serverId]);

  if (!loaded) return <div className="empty">Loading</div>;

  const stdio = transport === 'stdio';
  const parsedEnv = parseEnv(env);
  const parsedHeaders = parseHeaders(headers);
  const problems = [...parsedEnv.errors.map((e) => `Environment ${e}`), ...(stdio ? [] : parsedHeaders.errors.map((e) => `Headers ${e}`))];
  const secretKind = stdio ? 'env' : 'header';
  const shownSecrets = secrets.filter((s) => (stdio ? s.kind === 'env' : true));

  const save = async () => {
    setError(null);
    const form: ServerForm = { ...(serverId ? { id: serverId } : {}), name: name.trim(), transport };
    if (stdio) {
      form.command = command.trim();
      form.args = parseArgs(args);
      if (cwd.trim()) form.cwd = cwd.trim();
    } else {
      form.url = url.trim();
      if (Object.keys(parsedHeaders.value).length) form.headers = parsedHeaders.value;
      if (clientId.trim()) {
        const secret = clientSecret !== '' ? clientSecret : clientSecretStored ? null : undefined;
        form.oauthClient = { clientId: clientId.trim(), redirectUri: redirectUri.trim(), ...(secret !== undefined ? { clientSecret: secret } : {}) };
      }
    }
    if (Object.keys(parsedEnv.value).length) form.env = parsedEnv.value;
    const named = shownSecrets.filter((s) => s.name.trim() !== '');
    if (encrypted) {
      const pick = (kind: 'env' | 'header') => {
        const rows = named.filter((s) => s.kind === kind);
        return rows.length ? Object.fromEntries(rows.map((s) => [s.name.trim(), s.value === '' && s.stored ? null : s.value])) : undefined;
      };
      form.secretEnv = pick('env');
      form.secretHeaders = pick('header');
    } else {
      const names = (kind: 'env' | 'header') => named.filter((s) => s.kind === kind).map((s) => s.name.trim());
      form.unstoredSecrets = { env: names('env'), headers: names('header') };
    }
    try {
      onSaved(await client.request('servers.save', { server: form }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const update = (i: number, patch: Partial<SecretRow>) => setSecrets((rows) => rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <form className="editor" onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <h2>{serverId ? `Edit ${name}` : 'Add a server'}</h2>
      <label className="field"><span>Name</span><input autoFocus value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label className="field"><span>Transport</span>
        <select value={transport} onChange={(e) => setTransport(e.target.value as Transport)}>
          <option value="stdio">stdio (a local process)</option>
          <option value="streamable-http">Streamable HTTP</option>
          <option value="sse">HTTP+SSE (deprecated, still deployed)</option>
        </select>
      </label>
      {stdio ? (
        <>
          <label className="field"><span>Command</span><input className="mono" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="node" /></label>
          <label className="field"><span>Arguments, one per line</span><textarea className="mono" rows={3} value={args} onChange={(e) => setArgs(e.target.value)} /></label>
          <label className="field"><span>Working directory</span><input className="mono" value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="The app's own" /></label>
          <label className="field"><span>Environment, NAME=value per line</span><textarea className="mono" rows={2} value={env} onChange={(e) => setEnv(e.target.value)} /></label>
          {command.trim() && (
            <div className="will-run">
              <span>Connecting will run</span>
              <code className="mono">{commandLine(command.trim(), parseArgs(args))}</code>
              <small>Nothing runs until you connect.</small>
            </div>
          )}
        </>
      ) : (
        <>
          <label className="field"><span>URL</span><input className="mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/mcp" /></label>
          <label className="field"><span>Headers, Name: value per line</span><textarea className="mono" rows={2} value={headers} onChange={(e) => setHeaders(e.target.value)} /></label>
          <fieldset className="secrets">
            <legend>OAuth client (optional)</legend>
            <p className="hint">Only for a server whose authorization server does not let apps register themselves. Enter the client you registered with it, and the redirect URI you gave it, exactly.</p>
            <label className="field"><span>Client ID</span><input className="mono" value={clientId} onChange={(e) => setClientId(e.target.value)} /></label>
            <label className="field"><span>Redirect URI</span><input className="mono" value={redirectUri} onChange={(e) => setRedirectUri(e.target.value)} placeholder="http://127.0.0.1:43123/callback" /></label>
            {encrypted
              ? <label className="field"><span>Client secret, if it has one</span><input className="mono" type="password" value={clientSecret} placeholder={clientSecretStored ? 'Stored; type to replace' : 'None'} onChange={(e) => setClientSecret(e.target.value)} /></label>
              : <p className="hint">This workspace is not encrypted, so a client secret cannot be kept. A public client (no secret) works.</p>}
          </fieldset>
        </>
      )}
      <fieldset className="secrets">
        <legend>Secrets</legend>
        <p className="hint">
          {encrypted
            ? 'Stored encrypted in this workspace. Never shown again, and never written to the wire log.'
            : 'This workspace is not encrypted, so only the names are saved. You enter the values each session.'}
        </p>
        {shownSecrets.map((s) => {
          const i = secrets.indexOf(s);
          return (
            <div key={i} className="secret-row">
              <select value={s.kind} disabled={stdio} onChange={(e) => update(i, { kind: e.target.value as 'env' | 'header' })}>
                <option value="env">Environment</option>
                <option value="header">Header</option>
              </select>
              <input className="mono" value={s.name} placeholder={s.kind === 'env' ? 'API_KEY' : 'Authorization'} onChange={(e) => update(i, { name: e.target.value })} />
              {encrypted && (
                <input className="mono" type="password" value={s.value} placeholder={s.stored ? 'Stored; type to replace' : 'Value'} onChange={(e) => update(i, { value: e.target.value })} />
              )}
              <button type="button" onClick={() => setSecrets((rows) => rows.filter((_, j) => j !== i))}>Remove</button>
            </div>
          );
        })}
        <button type="button" onClick={() => setSecrets((rows) => [...rows, { kind: secretKind, name: '', value: '', stored: false }])}>Add a secret</button>
      </fieldset>
      {problems.map((p) => <p key={p} className="error">{p}</p>)}
      {error && <p className="error">{error}</p>}
      <div className="actions">
        <button type="button" onClick={onCancel}>Cancel</button>
        <button type="submit" className="primary" disabled={!name.trim() || (stdio ? !command.trim() : !url.trim()) || problems.length > 0}>Save</button>
      </div>
    </form>
  );
}
