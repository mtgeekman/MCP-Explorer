// The header's workspace switcher (round 1). Switching closes the open
// workspace's connections first; the backend does that.
import { useState } from 'react';
import type { OpenedWorkspace, WorkspaceListing } from '../../../../packages/backend/dist/index.js';
import type { BackendClient } from '../lib/client';
import { useUnlock } from './Unlock';

export function WorkspaceSwitcher({ client, current, workspaces, onOpened, onCreate, onClosed }: {
  client: BackendClient; current: OpenedWorkspace; workspaces: WorkspaceListing[];
  onOpened: (w: OpenedWorkspace) => void; onCreate: () => void; onClosed: () => void;
}) {
  const [open, setOpen] = useState(false);
  const unlock = useUnlock(client, (w) => { setOpen(false); onOpened(w); });
  const others = workspaces.filter((w) => w.id !== current.id);
  return (
    <div className="switcher">
      <button className="switcher-button" onClick={() => setOpen(!open)} aria-expanded={open}>
        {current.name}{current.encrypted ? '' : ' (not encrypted)'}
      </button>
      {open && (
        <div className="menu" role="menu">
          {others.map((w) => (
            <button key={w.id} role="menuitem" onClick={() => unlock.open(w)}>{w.label}</button>
          ))}
          {others.length > 0 && <hr />}
          <button role="menuitem" onClick={() => { setOpen(false); onCreate(); }}>New workspace</button>
          <button role="menuitem" onClick={async () => { setOpen(false); await client.request('workspaces.close', {}); onClosed(); }}>Close workspace</button>
          {unlock.error && <p className="error">{unlock.error}</p>}
        </div>
      )}
      {unlock.dialog}
    </div>
  );
}
