// First run and "New workspace" (board 2C): name, protection, and for a
// keychain workspace the recovery key, copied, never saved to a file, with
// the user's attestation that it is stored elsewhere (round 2, D28).
import { useState } from 'react';
import type { OpenedWorkspace } from '../../../../packages/backend/dist/index.js';
import type { BackendClient } from '../lib/client';

type Kind = 'keychain' | 'passphrase' | 'none';

const CHOICES: { kind: Kind; title: string; detail: string }[] = [
  { kind: 'keychain', title: 'Encrypted, key in the system keychain', detail: 'Opens without a prompt. You get a recovery key to keep somewhere other than this computer.' },
  { kind: 'passphrase', title: 'Encrypted with a passphrase', detail: 'You type it every time you open the workspace. Its name stays hidden until then. Nothing can recover a forgotten passphrase.' },
  { kind: 'none', title: 'Not encrypted', detail: 'The file is readable by anyone who can read your files. Server secrets cannot be saved; you enter them each session.' },
];

export function CreateWorkspace({ client, first, onCreated, onCancel }: {
  client: BackendClient;
  first: boolean;
  onCreated: (w: OpenedWorkspace) => void;
  onCancel?: () => void;
}) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<Kind>('keychain');
  const [passphrase, setPassphrase] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<OpenedWorkspace | null>(null);

  const mismatch = kind === 'passphrase' && confirm !== '' && passphrase !== confirm;
  const ready = name.trim() !== '' && (kind !== 'passphrase' || (passphrase !== '' && passphrase === confirm));

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const protection = kind === 'passphrase' ? { kind, passphrase } : { kind };
      const w = await client.request('workspaces.create', { name: name.trim(), protection });
      if (w.recoveryKey) setCreated(w);
      else onCreated(w);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (created?.recoveryKey) return <RecoveryKey workspace={created} onDone={() => onCreated(created)} />;

  return (
    <div className="center-screen form-screen">
      <h1>{first ? 'Create your first workspace' : 'New workspace'}</h1>
      <p className="lede">A workspace holds a set of servers, everything they sent and received, and their secrets.</p>
      <label className="field">
        <span>Name</span>
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Work" />
      </label>
      <fieldset className="choices">
        <legend>Protection</legend>
        {CHOICES.map((c) => (
          <label key={c.kind} className={`choice ${kind === c.kind ? 'chosen' : ''}`}>
            <input type="radio" name="protection" checked={kind === c.kind} onChange={() => setKind(c.kind)} />
            <span><strong>{c.title}</strong><br /><small>{c.detail}</small></span>
          </label>
        ))}
      </fieldset>
      {kind === 'passphrase' && (
        <div className="row">
          <label className="field"><span>Passphrase</span><input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} /></label>
          <label className="field"><span>Again</span><input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} /></label>
        </div>
      )}
      {mismatch && <p className="error">The passphrases differ.</p>}
      {error && <p className="error">{error}</p>}
      <div className="actions">
        {onCancel && <button onClick={onCancel}>Cancel</button>}
        <button className="primary" disabled={!ready || busy} onClick={create}>Create workspace</button>
      </div>
    </div>
  );
}

function RecoveryKey({ workspace, onDone }: { workspace: OpenedWorkspace; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const [stored, setStored] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(workspace.recoveryKey!);
    setCopied(true);
  };
  return (
    <div className="center-screen form-screen">
      <h1>Recovery key for {workspace.name}</h1>
      <p className="lede">
        If the keychain entry for this workspace is ever lost (a reinstalled system, a new machine), this key is the
        only way to open it. It is shown once. Store it somewhere other than this computer, such as a password manager.
      </p>
      <pre className="recovery-key mono">{workspace.recoveryKey}</pre>
      <div className="actions left">
        <button onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
      </div>
      <label className="attest">
        <input type="checkbox" checked={stored} onChange={(e) => setStored(e.target.checked)} />
        <span>I have stored this key somewhere other than this computer</span>
      </label>
      <div className="actions">
        <button className="primary" disabled={!stored} onClick={onDone}>Continue</button>
      </div>
    </div>
  );
}
