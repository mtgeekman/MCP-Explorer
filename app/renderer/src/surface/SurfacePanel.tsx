// A server's captured surface (round 5): instructions, tools, prompts,
// resources and templates. A list's entries sit in a column, left of the
// entry chosen; the column's width is dragged and kept per machine. Each
// entry opens on its exact bytes from the list reply (board 5.1A); the
// readable pane beside it is where a person reads.
// Refresh is the only way anything is listed again (P2, phase 06 decision 3).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CallView, EntryList, RawEntry, ServerRow, SessionInfo, SurfaceView } from '../../../../packages/backend/dist/index.js';
import type { NormalizedTool } from '../../../../packages/protocol/dist/index.js';
import { CallPanel, type CallTarget } from '../calls/CallPanel';
import type { BackendClient } from '../lib/client';
import { LISTS, entryKey, listLabel, listState, reselect, type Selection } from '../lib/surface';
import { latestOnly } from '../lib/latest';
import { RawViewer } from '../log/RawViewer';
import { JsonView } from '../log/JsonView';
import type { JsonMode } from '../lib/json';
import { Splitter } from '../layout/Splitter';
import { paneStore } from '../layout/paneStore';
import { KEYS, LIST_DEFAULT, listBounds, readSize, remember } from '../lib/panes';

export type SelectedItem = Selection;

type Tab = 'instructions' | 'capabilities' | EntryList;

const LIST_NOUN: Record<string, string> = { tools: 'tools', prompts: 'prompts', resources: 'resources' };

export function SurfacePanel({ client, server, selected, onSelect, onReadCall }: {
  client: BackendClient; server: ServerRow; selected: SelectedItem | null; onSelect: (item: SelectedItem | null) => void;
  onReadCall: (view: CallView) => void;
}) {
  const [view, setView] = useState<SurfaceView | null>(null);
  const [tab, setTab] = useState<Tab>('tools');
  const [error, setError] = useState<string | null>(null);
  // One width for every list's column, so a switch of list does not move it.
  const [listWidth, setListWidth] = useState(() => readSize(paneStore(), KEYS.surfaceListWidth) ?? LIST_DEFAULT);

  // Loads overlap (a capture's start and end each announce a change); only
  // the newest reply is shown (R06-5).
  const latest = useMemo(() => latestOnly(), [server.id]);
  const failed = (e: unknown) => setError(e instanceof Error ? e.message : String(e));
  const shown = (v: SurfaceView) => { setView(v); setError(null); };

  const load = useCallback(() => {
    void latest(client.request('surface.get', { serverId: server.id }), shown, failed);
  }, [client, server.id, latest]);

  // A new capture replaces the definition the pane shows, as the raw view's
  // fetch does (R06-4).
  useEffect(() => {
    if (!view || !selected || selected.serverId !== server.id) return;
    const next = reselect(selected, (view.partial ?? view.capture)?.surface);
    if (next !== selected) onSelect(next);
    // Only a new view re-reads the selection; a new selection is already current.
  }, [view]);

  useEffect(() => {
    load();
    return client.on((name, data) => {
      if (name === 'surface.changed' && (data as { serverId: string }).serverId === server.id) load();
    });
  }, [client, server.id, load]);

  const refresh = async () => {
    await latest(client.request('surface.refresh', { serverId: server.id }), shown, failed);
  };

  const live = server.state.status === 'connected';
  // A partial capture from this session is newer than the last whole one (R06-11).
  const partial = view?.partial ?? null;
  const capture = partial ?? view?.capture ?? null;
  const status = view?.status;
  const surface = capture?.surface;
  const failedLists = partial ? partial.surface.problems.filter((p) => p.kind === 'list-failed').map((p) => p.endpoint) : [];

  return (
    <section className="surface">
      <div className="surface-head">
        <span className="muted">
          {capture ? `Captured ${new Date(capture.observedAt).toLocaleString()} on revision ${surface!.revision}` : 'Nothing captured yet. Connecting captures it.'}
        </span>
        <span className="header-spacer" />
        {status?.capturing && <span className="muted">Capturing</span>}
        {live && <button disabled={status?.capturing} onClick={refresh} title="List the server's tools, prompts and resources again">Refresh</button>}
      </div>
      {error && <p className="error">{error}</p>}
      {status?.error && <p className="error">The last capture failed: {status.error}</p>}
      {partial && (
        <p className="warn">
          Partial: {failedLists.join(', ')} failed. What the server did list is shown for this session only; version history and the context preview keep {view?.capture ? 'the last whole capture' : 'nothing until a whole capture'}.
        </p>
      )}
      {status && status.changed.length > 0 && (
        <div className="banner">
          <span>The server says its {status.changed.map((c) => LIST_NOUN[c]).join(', ')} changed. Nothing has been listed again.</span>
          {live && <button className="primary" disabled={status.capturing} onClick={refresh}>Refresh</button>}
        </div>
      )}
      {surface?.era === 'modern' && (
        <p className="hint">On this revision a server sends change notices only on a listen stream: open one under Session. A notice is reported; Refresh lists again.</p>
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
            <button role="tab" aria-selected={tab === 'capabilities'} className={tab === 'capabilities' ? 'tab on' : 'tab'} onClick={() => { setTab('capabilities'); onSelect(null); }}>
              Capabilities
            </button>
            {LISTS.map((l) => (
              <button key={l.list} role="tab" aria-selected={tab === l.list} className={tab === l.list ? 'tab on' : 'tab'} onClick={() => { setTab(l.list); onSelect(null); }}>
                {listLabel(l.label, listState(surface, l.list))}
              </button>
            ))}
          </div>
          {tab === 'capabilities' && <Capabilities surface={surface} />}
          {tab === 'capabilities' ? null : tab === 'instructions'
            ? (surface.instructions === undefined
              ? <p className="muted">None sent. The server gave no instructions.</p>
              : <pre className="mono instructions">{surface.instructions}</pre>)
            : <ListTab client={client} serverId={server.id} serverName={server.name} connected={live} list={tab} surface={surface} selected={selected} onSelect={onSelect} onReadCall={onReadCall}
              width={listWidth} onResize={setListWidth} />}
        </>
      )}
    </section>
  );
}

/** The capabilities exactly as declared (D10), and the extensions named on their own (phase 10 decision 10). */
function Capabilities({ surface }: { surface: NonNullable<SurfaceView['capture']>['surface'] }) {
  const caps = (surface.capabilities ?? {}) as Record<string, unknown>;
  const extensions = caps.extensions && typeof caps.extensions === 'object' ? Object.keys(caps.extensions as object).sort() : [];
  return (
    <div className="pad">
      <p>
        <strong>Extensions:</strong>{' '}
        {surface.unavailable.includes('capabilities.extensions')
          ? <span className="muted">unavailable on {surface.revision}: extensions arrived in 2026-07-28.</span>
          : extensions.length ? <span className="mono">{extensions.join(', ')}</span> : <span className="muted">none advertised.</span>}
      </p>
      <pre className="mono json">{JSON.stringify(caps, null, 2)}</pre>
    </div>
  );
}

function ListTab({ client, serverId, serverName, connected, list, surface, selected, onSelect, onReadCall, width, onResize }: {
  client: BackendClient; serverId: string; serverName: string; connected: boolean; list: EntryList; surface: NonNullable<SurfaceView['capture']>['surface'];
  selected: SelectedItem | null; onSelect: (item: SelectedItem | null) => void; onReadCall: (view: CallView) => void;
  width: number; onResize: (width: number) => void;
}) {
  const split = useRef<HTMLDivElement | null>(null);
  const state = listState(surface, list);
  if (state.kind === 'not-advertised') return <p className="muted">Not advertised: the server's capabilities do not include this, so nothing was asked.</p>;
  if (state.kind === 'failed') return <p className="error">Advertised, and the list failed: {state.message}</p>;
  if (state.kind === 'empty') return <p className="muted">Asked, and the server listed none.</p>;
  const items = surface[list] as unknown as Record<string, unknown>[];
  const current = selected && selected.serverId === serverId && selected.list === list ? selected.key : null;
  return (
    <div className="surface-split" ref={split}>
      <ul className="surface-items" style={{ flexBasis: width }}>
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
      <Splitter axis="x" edge="far" label="Surface list width" size={width} bounds={() => listBounds(split.current?.clientWidth ?? 0)}
        onResize={onResize} onCommit={(w) => remember(paneStore(), KEYS.surfaceListWidth, w)} />
      <div className="surface-entry">
        {current === null
          ? <p className="muted pad">Choose an entry to see it exactly as the server listed it.</p>
          : <Entry key={current} client={client} serverId={serverId} serverName={serverName} connected={connected} list={list} entryKey={current}
            item={items.find((i) => entryKey(list, i) === current)} onReadCall={onReadCall} surface={surface} />}
      </div>
    </div>
  );
}

const VERB: Record<EntryList, string> = { tools: 'Call', prompts: 'Get', resources: 'Read', resourceTemplates: 'Read' };

function callTarget(list: EntryList, item: Record<string, unknown>): CallTarget {
  if (list === 'tools') return { kind: 'tool', tool: item as unknown as NormalizedTool };
  if (list === 'prompts') return { kind: 'prompt', name: String(item.name), arguments: item.arguments };
  if (list === 'resources') return { kind: 'resource', uri: String(item.uri) };
  return { kind: 'template', uriTemplate: String(item.uriTemplate) };
}

type EntryMode = 'definition' | 'call' | 'response';

/**
 * An entry opens on its definition (board 5.1A); the call view is one click
 * over (board 6.1), and the response a third tab once a call has started.
 * The call panel mounts on the first visit to Call and then only hides, so
 * the arguments typed and the call's transcript survive a switch of tab.
 * Choosing another entry starts afresh; the call stays under Calls.
 */
function Entry({ client, serverId, serverName, connected, list, entryKey: key, item, onReadCall, surface }: {
  client: BackendClient; serverId: string; serverName: string; connected: boolean; list: EntryList; entryKey: string;
  item: Record<string, unknown> | undefined; onReadCall: (view: CallView) => void; surface: NonNullable<SurfaceView['capture']>['surface'];
}) {
  const caps = (surface.capabilities ?? {}) as { resources?: { subscribe?: unknown }; completions?: unknown };
  const [mode, setMode] = useState<EntryMode>('definition');
  const [callOpened, setCallOpened] = useState(false);
  const [callId, setCallId] = useState<number | null>(null);
  const show = (m: EntryMode) => { setMode(m); if (m !== 'definition') setCallOpened(true); };
  const tab = (m: EntryMode, label: string) => (
    <button role="tab" aria-selected={mode === m} className={mode === m ? 'tab on' : 'tab'} onClick={() => show(m)}>{label}</button>
  );
  return (
    <>
      <div className="tabs small" role="tablist">
        {tab('definition', 'Definition')}
        {item && tab('call', VERB[list])}
        {item && callId !== null && tab('response', 'Response')}
        {list === 'resources' && connected && caps.resources?.subscribe === true && <Subscribe client={client} serverId={serverId} uri={key} />}
      </div>
      <div className="entry-definition" hidden={mode !== 'definition'}><EntryRaw client={client} serverId={serverId} list={list} entryKey={key} /></div>
      {item && callOpened && (
        <div hidden={mode === 'definition'}>
          <CallPanel client={client} serverId={serverId} serverName={serverName} connected={connected} target={callTarget(list, item)} onRead={onReadCall}
            era={surface.era} revision={surface.revision} completions={caps.completions !== undefined}
            view={mode === 'response' ? 'response' : 'form'} callId={callId}
            onStarted={(id) => { setCallId(id); setMode('response'); }} onShowForm={() => setMode('call')} />
        </div>
      )}
    </>
  );
}

/**
 * Subscribe to one resource's updates (phase 10 decision 7): legacy
 * resources/subscribe, modern the listen stream's filter. One press, one change.
 */
function Subscribe({ client, serverId, uri }: { client: BackendClient; serverId: string; uri: string }) {
  const [info, setInfo] = useState<SessionInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const load = () => void client.request('session.get', { serverId }).then(setInfo, () => undefined);
    load();
    return client.on((name, data) => { if (name === 'session.changed' && (data as { serverId: string }).serverId === serverId) load(); });
  }, [client, serverId]);
  if (!info?.connected) return null;
  const on = info.subscribed.includes(uri);
  const updated = info.updated[uri];
  return (
    <span className="subscribe">
      <button onClick={() => { setError(null); client.request('session.subscribe', { serverId, uri, on: !on }).then((o) => { if (o && o.kind !== 'result') setError(o.kind === 'error' ? String(o.error.message) : o.kind === 'failed' ? o.message : 'cancelled'); }, (e: unknown) => setError(e instanceof Error ? e.message : String(e))); }}>
        {on ? 'Unsubscribe' : 'Subscribe'}
      </button>
      {updated !== undefined && <span className="muted">Updated {new Date(updated).toLocaleTimeString()}</span>}
      {error && <span className="error">{error}</span>}
    </span>
  );
}

type DefinitionView = 'raw' | JsonMode;

const DEFINITION_VIEWS: { view: DefinitionView; label: string; title: string }[] = [
  { view: 'raw', label: 'Raw', title: 'The exact bytes from the list reply' },
  { view: 'pretty', label: 'Pretty', title: 'Parsed, indented and colored; JSON inside a string is shown decoded' },
  { view: 'compact', label: 'Compact', title: 'Parsed, one line, every string as it is' },
];

/**
 * The definition's exact bytes, with a Raw / Pretty / Compact switch (spec
 * D10, amended 2026-10-07). It opens on Raw for every entry chosen and is
 * not remembered: Pretty and Compact are readings of the bytes, never them.
 */
function EntryRaw({ client, serverId, list, entryKey: key }: { client: BackendClient; serverId: string; list: EntryList; entryKey: string }) {
  const [entry, setEntry] = useState<RawEntry | null>(null);
  const [view, setView] = useState<DefinitionView>('raw');
  const text = useMemo(() => (entry?.found ? new TextDecoder().decode(entry.bytes) : ''), [entry]);
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
      <div className="entry-source-row">
        <p className="muted entry-source">
          {view === 'raw'
            ? `Exact bytes from wire log unit ${entry.unitId}, offset ${entry.offset.toLocaleString()}`
            : `Wire log unit ${entry.unitId}, offset ${entry.offset.toLocaleString()}, parsed: not the bytes as sent`}
        </p>
        <span className="json-toggle" role="group" aria-label="Definition view">
          {DEFINITION_VIEWS.map((d) => (
            <button key={d.view} aria-pressed={view === d.view} title={d.title} onClick={() => setView(d.view)}>{d.label}</button>
          ))}
        </span>
      </div>
      {view === 'raw'
        ? <RawViewer bytes={entry.bytes} height={360} />
        : <div className="entry-json"><JsonView text={text} mode={view} /></div>}
    </>
  );
}
