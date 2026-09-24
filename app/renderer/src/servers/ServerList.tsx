// The server list (round 1): each server's name, transport, pinned era and
// connection state at a glance.
import type { ServerRow } from '../../../../packages/backend/dist/index.js';

const STATUS: Record<ServerRow['state']['status'], string> = {
  idle: 'Not connected', 'needs-secrets': 'Needs secrets', connecting: 'Connecting', connected: 'Connected',
  failed: 'Failed', closing: 'Closing', ended: 'Stopped',
};

export function ServerList({ servers, selectedId, onSelect, onAdd }: {
  servers: ServerRow[]; selectedId?: string; onSelect: (id: string) => void; onAdd: () => void;
}) {
  return (
    <nav className="server-list">
      <div className="server-list-head">
        <span>Servers</span>
        <button onClick={onAdd}>Add</button>
      </div>
      <ul>
        {servers.map((s) => (
          <li key={s.id}>
            <button className={`server-row ${s.id === selectedId ? 'selected' : ''}`} onClick={() => onSelect(s.id)}>
              <span className="server-name">{s.name}</span>
              <span className="server-meta">
                <span className={`dot ${s.state.status}`} aria-hidden />
                {STATUS[s.state.status]}
                <span className="sep">{s.transport}</span>
                {s.era && <span className="sep">{s.era.era}{s.era.revision ? ` ${s.era.revision}` : ''}</span>}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
