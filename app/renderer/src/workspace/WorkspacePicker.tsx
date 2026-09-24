// Launch with no workspace open: pick one, or create another.
import type { OpenedWorkspace, WorkspaceListing } from '../../../../packages/backend/dist/index.js';
import type { BackendClient } from '../lib/client';
import { useUnlock } from './Unlock';

const PROTECTION: Record<WorkspaceListing['custody'], string> = { keychain: 'Keychain', passphrase: 'Passphrase', none: 'Not encrypted' };

export function WorkspacePicker({ client, workspaces, onOpened, onCreate }: {
  client: BackendClient; workspaces: WorkspaceListing[]; onOpened: (w: OpenedWorkspace) => void; onCreate: () => void;
}) {
  const unlock = useUnlock(client, onOpened);
  return (
    <div className="center-screen form-screen">
      <h1>Open a workspace</h1>
      <ul className="picker">
        {workspaces.map((w) => (
          <li key={w.id}>
            <button className="picker-row" onClick={() => unlock.open(w)}>
              <span>{w.label}</span>
              <small>{PROTECTION[w.custody]}</small>
            </button>
          </li>
        ))}
      </ul>
      {unlock.error && <p className="error">{unlock.error}</p>}
      <div className="actions left"><button onClick={onCreate}>New workspace</button></div>
      {unlock.dialog}
    </div>
  );
}
