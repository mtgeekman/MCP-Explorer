// The app frame (board 1A): the workspace switcher in the header, servers on
// the left, the selected server in the main area. First run is workspace
// first (board 2C, spec D3 revised 2026-09-24).
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CallView, LogUnit, OpenedWorkspace, ServerRow, WorkspaceListing, WorkspaceNotice } from '../../../packages/backend/dist/index.js';
import type { BackendClient } from './lib/client';
import { CreateWorkspace } from './workspace/CreateWorkspace';
import { WorkspacePicker } from './workspace/WorkspacePicker';
import { WorkspaceSwitcher } from './workspace/WorkspaceSwitcher';
import { ServerList } from './servers/ServerList';
import { ServerDetail, type ServerTab } from './servers/ServerDetail';
import { ServerEditor } from './servers/ServerEditor';
import { ImportServers } from './servers/ImportServers';
import { Notices } from './Notices';
import { WireLog } from './log/WireLog';
import { ReadablePane, type ReadableContent } from './log/ReadablePane';
import type { SelectedItem } from './surface/SurfacePanel';
import { Settings } from './settings/Settings';
import { ContextScreen } from './context/ContextScreen';
import { Splitter } from './layout/Splitter';
import { KEYS, LOG_HEAD, READABLE_DEFAULT, logBounds, readFlag, readSize, readableBounds, remember } from './lib/panes';
import { paneStore } from './layout/paneStore';

type Main = { kind: 'server'; id: string } | { kind: 'add' } | { kind: 'edit'; id: string } | { kind: 'settings' } | { kind: 'import' } | { kind: 'context' } | { kind: 'none' };

export function App({ client }: { client: BackendClient }) {
  const [workspace, setWorkspace] = useState<OpenedWorkspace | null | undefined>(undefined);
  const [workspaces, setWorkspaces] = useState<WorkspaceListing[]>([]);
  const [servers, setServers] = useState<ServerRow[]>([]);
  const [main, setMain] = useState<Main>({ kind: 'none' });
  const [notices, setNotices] = useState<WorkspaceNotice[]>([]);
  const [backendDown, setBackendDown] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [readable, setReadable] = useState<ReadableContent | null>(null);
  const [poppedOut, setPoppedOut] = useState(false);
  // Pane sizes: the log's height (undefined keeps the default share of the
  // column), whether it is collapsed, and the readable pane's width.
  const [logHeight, setLogHeight] = useState<number | undefined>(() => readSize(paneStore(), KEYS.logHeight));
  const [logCollapsed, setLogCollapsed] = useState(() => readFlag(paneStore(), KEYS.logCollapsed));
  const [readableWidth, setReadableWidth] = useState(() => readSize(paneStore(), KEYS.readableWidth) ?? READABLE_DEFAULT);
  const [measuredLog, setMeasuredLog] = useState(0);
  const column = useRef<HTMLDivElement | null>(null);
  const logSlot = useRef<HTMLDivElement | null>(null);

  const selectUnit = useCallback((u: LogUnit | null) => {
    setReadable(u ? { kind: 'unit', unit: u } : null);
    window.mcpxShell?.selectReadable(u ? { id: u.id, reserialized: Boolean(u.reserialized) } : null);
  }, []);

  // The surface entry chosen is its own state, not whatever the pane shows:
  // reading a call's result or a log row must not close the entry's call view.
  const [surfaceItem, setSurfaceItem] = useState<SelectedItem | null>(null);
  // The server view's tab stays as chosen when another server is chosen.
  const [serverTab, setServerTab] = useState<ServerTab>('surface');

  const selectItem = useCallback((item: SelectedItem | null) => {
    setSurfaceItem(item);
    setReadable(item ? { kind: 'item', item } : null);
    window.mcpxShell?.selectReadable(item ? { serverId: item.serverId, list: item.list, key: item.key } : null);
  }, []);

  const readCall = useCallback((view: CallView) => {
    setReadable({ kind: 'call', view });
    window.mcpxShell?.selectReadable({ callId: view.call.id });
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
    setSurfaceItem(null);
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
  const showLog = main.kind === 'server' && Boolean(selected);
  const logSize = logCollapsed ? LOG_HEAD : logHeight ?? measuredLog;
  const setCollapsed = (c: boolean) => { setLogCollapsed(c); remember(paneStore(), KEYS.logCollapsed, c); };
  const resizeLog = (h: number) => { setLogCollapsed(false); setLogHeight(h); };
  const commitLog = (h: number) => { remember(paneStore(), KEYS.logHeight, h); remember(paneStore(), KEYS.logCollapsed, false); };
  return (
    <div className="app">
      <header className="app-header">
        <span className="app-title">MCP Explorer</span>
        <WorkspaceSwitcher client={client} current={workspace} workspaces={workspaces} onOpened={opened} onCreate={() => setCreating(true)} onClosed={async () => { setWorkspace(null); await refreshWorkspaces(); }} />
        <span className="header-spacer" />
        <button onClick={() => { selectUnit(null); setMain({ kind: 'context' }); }} title="What a model would be handed from this workspace, and what it costs">Context</button>
        <button onClick={() => { selectUnit(null); setMain({ kind: 'settings' }); }}>Settings</button>
      </header>
      <Notices notices={notices} onDismiss={(i) => setNotices((n) => n.filter((_, j) => j !== i))} />
      <div className="app-body">
        <ServerList servers={servers} selectedId={selected?.id} onSelect={(id) => { if (id !== selected?.id) selectUnit(null); setMain({ kind: 'server', id }); }} onAdd={() => setMain({ kind: 'add' })} onImport={() => setMain({ kind: 'import' })} />
        <div className="app-column" ref={column}>
        <main className="app-main">
          {main.kind === 'none' && (
            <div className="empty">{servers.length ? 'Choose a server.' : 'No servers yet. Add one to connect to it.'}</div>
          )}
          {main.kind === 'settings' && (
            <Settings client={client} workspaceName={workspace.name} onClose={() => setMain({ kind: 'none' })} />
          )}
          {main.kind === 'context' && <ContextScreen client={client} onClose={() => setMain({ kind: 'none' })} />}
          {main.kind === 'import' && (
            <ImportServers client={client} encrypted={workspace.encrypted} servers={servers} onImported={refreshServers} onClose={() => setMain({ kind: 'none' })} />
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
              selectedItem={surfaceItem}
              onSelectItem={selectItem}
              onReadCall={readCall}
              tab={serverTab}
              onTab={setServerTab}
            />
          )}
        </main>
        {showLog && selected && (
          <>
            <Splitter axis="y" label="Wire log height" size={logSize} bounds={() => logBounds(column.current?.clientHeight ?? 0)}
              onResize={resizeLog} onCommit={commitLog} onToggle={() => setCollapsed(!logCollapsed)} />
            <LogSlot slot={logSlot} height={logCollapsed ? LOG_HEAD : logHeight} onMeasured={setMeasuredLog}>
              <WireLog key={selected.id} client={client} serverId={selected.id} selected={readable?.kind === 'unit' ? readable.unit : null} onSelect={selectUnit}
                collapsed={logCollapsed} onToggleCollapsed={() => setCollapsed(!logCollapsed)} />
            </LogSlot>
          </>
        )}
        </div>
        <Splitter axis="x" label="Readable pane width" size={readableWidth}
          bounds={() => readableBounds((column.current?.offsetWidth ?? 0) + readableWidth)}
          onResize={setReadableWidth} onCommit={(w) => remember(paneStore(), KEYS.readableWidth, w)} />
        <ReadablePane width={readableWidth} content={readable} poppedOut={poppedOut} onPopOut={() => { setPoppedOut(true); window.mcpxShell?.popOutReadable(); }} />
      </div>
    </div>
  );
}

/**
 * Where the wire log sits: its default share of the column until the user
 * sizes it, then that height, never so tall that the server view goes below
 * its minimum. Reports its height, so the handle's first drag starts from it.
 */
function LogSlot({ slot, height, onMeasured, children }: {
  slot: React.MutableRefObject<HTMLDivElement | null>; height: number | undefined; onMeasured: (h: number) => void; children: React.ReactNode;
}) {
  useLayoutEffect(() => {
    const el = slot.current;
    if (!el) return;
    const report = () => onMeasured(el.offsetHeight);
    report();
    const observer = new ResizeObserver(report);
    observer.observe(el);
    return () => observer.disconnect();
  }, [slot, onMeasured]);
  return (
    <div className="log-slot" ref={slot} style={height === undefined ? undefined : { flex: '0 0 auto', height, minHeight: 0 }}>
      {children}
    </div>
  );
}
