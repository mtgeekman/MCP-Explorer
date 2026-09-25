// The app frame (board 1A): the workspace switcher in the header, servers on
// the left, the selected server in the main area. First run is workspace
// first (board 2C, spec D3 revised 2026-09-24).
import { useCallback, useEffect, useState } from 'react';
import type { LogUnit, OpenedWorkspace, ServerRow, WorkspaceListing, WorkspaceNotice } from '../../../packages/backend/dist/index.js';
import type { BackendClient } from './lib/client';
import { CreateWorkspace } from './workspace/CreateWorkspace';
import { WorkspacePicker } from './workspace/WorkspacePicker';
import { WorkspaceSwitcher } from './workspace/WorkspaceSwitcher';
import { ServerList } from './servers/ServerList';
import { ServerDetail } from './servers/ServerDetail';
import { ServerEditor } from './servers/ServerEditor';
import { Notices } from './Notices';
import { WireLog } from './log/WireLog';
import { ReadablePane } from './log/ReadablePane';

type Main = { kind: 'server'; id: string } | { kind: 'add' } | { kind: 'edit'; id: string } | { kind: 'none' };

export function App({ client }: { client: BackendClient }) {
  const [workspace, setWorkspace] = useState<OpenedWorkspace | null | undefined>(undefined);
  const [workspaces, setWorkspaces] = useState<WorkspaceListing[]>([]);
  const [servers, setServers] = useState<ServerRow[]>([]);
  const [main, setMain] = useState<Main>({ kind: 'none' });
  const [notices, setNotices] = useState<WorkspaceNotice[]>([]);
  const [backendDown, setBackendDown] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [selectedUnit, setSelectedUnit] = useState<LogUnit | null>(null);
  const [poppedOut, setPoppedOut] = useState(false);

  const selectUnit = useCallback((u: LogUnit | null) => {
    setSelectedUnit(u);
    window.mcpxShell?.selectReadable(u ? { id: u.id, reserialized: Boolean(u.reserialized) } : null);
  }, []);

  const refreshWorkspaces = useCallback(async () => {
    setWorkspaces(await client.request('workspaces.list', {}));
  }, [client]);

  const refreshServers = useCallback(async () => {
    setServers(await client.request('servers.list', {}));
  }, [client]);

  useEffect(() => {
    void (async () => {
      await refreshWorkspaces();
      setWorkspace(await client.request('workspaces.current', {}));
    })();
    const off = client.on((name, data) => {
      if (name === 'notice') setNotices((n) => [...n, data as WorkspaceNotice]);
      if (name === 'connection.state') {
        const { serverId, state } = data as { serverId: string; state: ServerRow['state'] };
        setServers((rows) => rows.map((r) => (r.id === serverId ? { ...r, state } : r)));
      }
    });
    window.mcpxShell?.onReadableClosed(() => setPoppedOut(false));
    window.mcpxShell?.onBackendExit((code) => {
      client.failPending('the backend process stopped');
      setBackendDown(code);
    });
    return off;
  }, [client, refreshWorkspaces]);

  useEffect(() => {
    if (workspace) void refreshServers();
    else setServers([]);
    setMain({ kind: 'none' });
    selectUnit(null);
  }, [workspace, refreshServers, selectUnit]);

  const opened = async (w: OpenedWorkspace) => {
    setCreating(false);
    setWorkspace(w);
    await refreshWorkspaces();
  };

  if (backendDown !== null) {
    return (
      <div className="center-screen">
        <h1>The backend stopped</h1>
        <p>It exited with code {backendDown}. Every server it had started has been stopped.</p>
        <button className="primary" onClick={() => window.mcpxShell?.restartBackend()}>Restart</button>
      </div>
    );
  }
  if (workspace === undefined) return <div className="boot">Loading</div>;
  if (!workspace || creating) {
    return (
      <div className="app">
        <Notices notices={notices} onDismiss={(i) => setNotices((n) => n.filter((_, j) => j !== i))} />
        {workspaces.length === 0 || creating
          ? <CreateWorkspace client={client} first={workspaces.length === 0} onCreated={opened} onCancel={workspaces.length ? () => setCreating(false) : undefined} />
          : <WorkspacePicker client={client} workspaces={workspaces} onOpened={opened} onCreate={() => setCreating(true)} />}
      </div>
    );
  }

  const selected = main.kind === 'server' || main.kind === 'edit' ? servers.find((s) => s.id === main.id) : undefined;
  return (
    <div className="app">
      <header className="app-header">
        <span className="app-title">MCP Explorer</span>
        <WorkspaceSwitcher client={client} current={workspace} workspaces={workspaces} onOpened={opened} onCreate={() => setCreating(true)} onClosed={async () => { setWorkspace(null); await refreshWorkspaces(); }} />
      </header>
      <Notices notices={notices} onDismiss={(i) => setNotices((n) => n.filter((_, j) => j !== i))} />
      <div className="app-body">
        <ServerList servers={servers} selectedId={selected?.id} onSelect={(id) => { if (id !== selected?.id) selectUnit(null); setMain({ kind: 'server', id }); }} onAdd={() => setMain({ kind: 'add' })} />
        <div className="app-column">
        <main className="app-main">
          {main.kind === 'none' && (
            <div className="empty">{servers.length ? 'Choose a server.' : 'No servers yet. Add one to connect to it.'}</div>
          )}
          {main.kind === 'add' && (
            <ServerEditor client={client} encrypted={workspace.encrypted} onSaved={async (row) => { await refreshServers(); setMain({ kind: 'server', id: row.id }); }} onCancel={() => setMain({ kind: 'none' })} />
          )}
          {main.kind === 'edit' && selected && (
            <ServerEditor client={client} encrypted={workspace.encrypted} serverId={selected.id} onSaved={async () => { await refreshServers(); setMain({ kind: 'server', id: selected.id }); }} onCancel={() => setMain({ kind: 'server', id: selected.id })} />
          )}
          {main.kind === 'server' && selected && (
            <ServerDetail
              key={selected.id}
              client={client}
              server={selected}
              onEdit={() => setMain({ kind: 'edit', id: selected.id })}
              onDeleted={async () => { await refreshServers(); setMain({ kind: 'none' }); }}
              onChanged={refreshServers}
            />
          )}
        </main>
        {main.kind === 'server' && selected && (
          <WireLog key={selected.id} client={client} serverId={selected.id} selected={selectedUnit} onSelect={selectUnit} />
        )}
        </div>
        <ReadablePane unit={selectedUnit} poppedOut={poppedOut} onPopOut={() => { setPoppedOut(true); window.mcpxShell?.popOutReadable(); }} />
      </div>
    </div>
  );
}
