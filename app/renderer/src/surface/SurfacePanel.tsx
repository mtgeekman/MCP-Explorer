// A server's captured surface (round 5): instructions, tools, prompts,
// resources and templates. Each entry opens on its exact bytes from the list
// reply (board 5.1A); the readable pane beside it is where a person reads.
// Refresh is the only way anything is listed again (P2, phase 06 decision 3).
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { EntryList, RawEntry, ServerRow, SurfaceView } from '../../../../packages/backend/dist/index.js';
import type { BackendClient } from '../lib/client';
import { LISTS, entryKey, listLabel, listState, reselect, type Selection } from '../lib/surface';
import { latestOnly } from '../lib/latest';
import { RawViewer } from '../log/RawViewer';

export type SelectedItem = Selection;

type Tab = 'instructions' | EntryList;

const LIST_NOUN: Record<string, string> = { tools: 'tools', prompts: 'prompts', resources: 'resources' };

export function SurfacePanel({ client, server, selected, onSelect }: {
  client: BackendClient; server: ServerRow; selected: SelectedItem | null; onSelect: (item: SelectedItem | null) => void;
}) {
  const [view, setView] = useState<SurfaceView | null>(null);
  const [tab, setTab] = useState<Tab>('tools');
  const [error, setError] = useState<string | null>(null);

  // Loads overlap (a capture's start and end each announce a change); only
  // the newest reply is shown (R06-5).
  const latest = useMemo(() => latestOnly(), [server.id]);
  const failed = (e: unknown) => setError(e instanceof Error ? e.message : String(e));

  const load = useCallback(() => {
    latest(client.request('surface.get', { serverId: server.id }), setView).catch(failed);
  }, [client, server.id, latest]);

  // A new capture replaces the definition the pane shows, as the raw view's
  // fetch does (R06-4).
  useEffect(() => {
    if (!view || !selected || selected.serverId !== server.id) return;
    const next = reselect(selected, view.capture?.surface);
    if (next?.item !== selected.item) onSelect(next);
    // Only a new view re-reads the selection; a new selection is already current.
  }, [view]);

  useEffect(() => {
    load();
    return client.on((name, data) => {
      if (name === 'surface.changed' && (data as { serverId: string }).serverId === server.id) load();
    });
  }, [client, server.id, load]);

  const refresh = async () => {
    setError(null);
    await latest(client.request('surface.refresh', { serverId: server.id }), setView).catch(failed);
  };

  const live = server.state.status === 'connected';
  const capture = view?.capture ?? null;
  const status = view?.status;
  const surface = capture?.surface;

  return (
    <section className="surface">
      <div className="surface-head">
        <h3>Surface</h3>
        <span className="muted">
          {capture ? `Captured ${new Date(capture.observedAt).toLocaleString()} on revision ${surface!.revision}` : 'Nothing captured yet. Connecting captures it.'}
        </span>
        <span className="header-spacer" />
        {status?.capturing && <span className="muted">Capturing</span>}
        {live && <button disabled={status?.capturing} onClick={refresh} title="List the server's tools, prompts and resources again">Refresh</button>}
      </div>
      {error && <p className="error">{error}</p>}
      {status?.error && <p className="error">The last capture recorded nothing: {status.error}</p>}
      {status && status.changed.length > 0 && (
        <div className="banner">
          <span>The server says its {status.changed.map((c) => LIST_NOUN[c]).join(', ')} changed. Nothing has been listed again.</span>
          {live && <button className="primary" disabled={status.capturing} onClick={refresh}>Refresh</button>}
        </div>
      )}
      {surface?.era === 'modern' && (
        <p className="hint">On this revision a server sends change notices only on a subscription, which this version of the app does not open. Refresh to see changes.</p>
      )}
      {surface && surface.problems.length > 0 && (
        <ul className="problems">
          {surface.problems.map((p) => <li key={`${p.endpoint}:${p.message}`}><code className="mono">{p.endpoint}</code> {p.message}</li>)}
        </ul>
      )}
      {surface && (
        <>
          <div className="tabs" role="tablist">
            <button role="tab" aria-selected={tab === 'instructions'} className={tab === 'instructions' ? 'tab on' : 'tab'} onClick={() => { setTab('instructions'); onSelect(null); }}>
              Instructions
            </button>
            {LISTS.map((l) => (
              <button key={l.list} role="tab" aria-selected={tab === l.list} className={tab === l.list ? 'tab on' : 'tab'} onClick={() => { setTab(l.list); onSelect(null); }}>
                {listLabel(l.label, listState(surface, l.list))}
              </button>
            ))}
          </div>
          {tab === 'instructions'
            ? (surface.instructions === undefined
              ? <p className="muted">None sent. The server gave no instructions.</p>
              : <pre className="mono instructions">{surface.instructions}</pre>)
            : <ListTab client={client} serverId={server.id} list={tab} surface={surface} selected={selected} onSelect={onSelect} />}
        </>
      )}
    </section>
  );
}

function ListTab({ client, serverId, list, surface, selected, onSelect }: {
  client: BackendClient; serverId: string; list: EntryList; surface: NonNullable<SurfaceView['capture']>['surface'];
  selected: SelectedItem | null; onSelect: (item: SelectedItem | null) => void;
}) {
  const state = listState(surface, list);
  if (state.kind === 'not-advertised') return <p className="muted">Not advertised: the server's capabilities do not include this, so nothing was asked.</p>;
  if (state.kind === 'failed') return <p className="error">Advertised, and the list failed: {state.message}</p>;
  if (state.kind === 'empty') return <p className="muted">Asked, and the server listed none.</p>;
  const items = surface[list] as unknown as Record<string, unknown>[];
  const current = selected && selected.serverId === serverId && selected.list === list ? selected.key : null;
  return (
    <div className="surface-split">
      <ul className="surface-items">
        {items.map((item, i) => {
          const key = entryKey(list, item);
          const title = typeof item.title === 'string' ? item.title : undefined;
          return (
            <li key={`${key}:${i}`}>
              <button className={key === current ? 'item on' : 'item'} onClick={() => onSelect({ serverId, list, key, item, revision: surface.revision })}>
                <span className="mono">{key}</span>
                {title && <small>{title}</small>}
              </button>
            </li>
          );
        })}
      </ul>
      <div className="surface-entry">
        {current === null ? <p className="muted pad">Choose an entry to see it exactly as the server listed it.</p> : <EntryRaw client={client} serverId={serverId} list={list} entryKey={current} />}
      </div>
    </div>
  );
}

function EntryRaw({ client, serverId, list, entryKey: key }: { client: BackendClient; serverId: string; list: EntryList; entryKey: string }) {
  const [entry, setEntry] = useState<RawEntry | null>(null);
  useEffect(() => {
    let stale = false;
    setEntry(null);
    client.request('surface.entry', { serverId, list, key }).then(
      (e) => { if (!stale) setEntry(e); },
      (e: unknown) => { if (!stale) setEntry({ found: false, reason: e instanceof Error ? e.message : String(e) }); },
    );
    return () => { stale = true; };
  }, [client, serverId, list, key]);
  if (!entry) return <p className="muted pad">Loading</p>;
  if (!entry.found) return <p className="muted pad">{entry.reason} The readable pane shows what was captured.</p>;
  return (
    <>
      <p className="muted entry-source">Exact bytes from wire log unit {entry.unitId}, offset {entry.offset.toLocaleString()}</p>
      <RawViewer bytes={entry.bytes} height={360} />
    </>
  );
}
