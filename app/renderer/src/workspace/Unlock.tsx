// Opening a workspace: nothing to type for keychain or unencrypted ones, a
// passphrase for protected ones, and the recovery key when a keychain entry
// cannot be read (D28).
import { useState } from 'react';
import type { OpenedWorkspace, WorkspaceListing } from '../../../../packages/backend/dist/index.js';
import { BackendError, type BackendClient } from '../lib/client';

type Ask = 'passphrase' | 'recovery' | null;

export function useUnlock(client: BackendClient, onOpened: (w: OpenedWorkspace) => void) {
  const [target, setTarget] = useState<WorkspaceListing | null>(null);
  const [ask, setAsk] = useState<Ask>(null);
  const [error, setError] = useState<string | null>(null);

  const attempt = async (w: WorkspaceListing, secret?: string, as?: Ask) => {
    setError(null);
    const unlock = as === 'passphrase' ? { kind: 'passphrase' as const, passphrase: secret! }
      : as === 'recovery' ? { kind: 'recovery' as const, recoveryKey: secret! }
      : w.custody === 'keychain' ? { kind: 'keychain' as const } : { kind: 'none' as const };
    try {
      const opened = await client.request('workspaces.open', { id: w.id, unlock });
      setTarget(null);
      setAsk(null);
      onOpened(opened);
    } catch (e) {
      if (e instanceof BackendError && e.errorName === 'NeedsRecoveryKeyError') {
        setTarget(w);
        setAsk('recovery');
        setError('The keychain has no key for this workspace. If the credential store is full, freeing space may bring it back; otherwise, open it with its recovery key.');
      } else if (e instanceof BackendError && e.errorName === 'WrongKeyError') {
        setError(as === 'recovery' ? 'That recovery key does not open this workspace.' : 'That passphrase does not open this workspace.');
      } else {
        setError(e instanceof Error ? e.message : String(e));
      }
    }
  };

  const open = (w: WorkspaceListing) => {
    if (w.custody === 'passphrase') {
      setTarget(w);
      setAsk('passphrase');
      setError(null);
    } else {
      void attempt(w);
    }
  };

  const dialog = target && ask ? (
    <UnlockDialog key={`${target.id}-${ask}`} workspace={target} ask={ask} error={error}
      onSubmit={(secret) => attempt(target, secret, ask)} onCancel={() => { setTarget(null); setAsk(null); setError(null); }} />
  ) : null;

  return { open, dialog, error: target ? null : error };
}

function UnlockDialog({ workspace, ask, error, onSubmit, onCancel }: {
  workspace: WorkspaceListing; ask: Exclude<Ask, null>; error: string | null;
  onSubmit: (secret: string) => void; onCancel: () => void;
}) {
  const [value, setValue] = useState('');
  return (
    <div className="dialog-backdrop">
      <form className="dialog" onSubmit={(e) => { e.preventDefault(); onSubmit(value); }}>
        <h2>Open {workspace.label}</h2>
        <label className="field">
          <span>{ask === 'passphrase' ? 'Passphrase' : 'Recovery key'}</span>
          <input autoFocus type={ask === 'passphrase' ? 'password' : 'text'} className={ask === 'recovery' ? 'mono' : ''}
            value={value} onChange={(e) => setValue(e.target.value)} placeholder={ask === 'recovery' ? 'MCPX1-...' : ''} />
        </label>
        {error && <p className="error">{error}</p>}
        <div className="actions">
          <button type="button" onClick={onCancel}>Cancel</button>
          <button type="submit" className="primary" disabled={!value}>Open</button>
        </div>
      </form>
    </div>
  );
}
