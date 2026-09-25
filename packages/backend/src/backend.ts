// The backend the renderer talks to (D32): workspaces, servers, connections
// and the wire log behind one message API. Plain Node, so every request is
// testable without Electron (D17); the utility-process entry only wires ports.
import { randomUUID } from 'node:crypto';
import { buildContext, costContext, renderContext, O200K, type ContextServer } from '../../protocol/dist/index.js';
import {
  compact, deleteServer, latestCapture, fileBytes, listServers, loadServer, previewPurge, purgeHistory, readDetectedEra, readSettings, saveServer, updateSettings, usedBytes,
  type ServerDefinition, type SecretStore,
} from '../../storage/dist/index.js';
import type { ServerRoot } from '../../platform/dist/index.js';
import { ConnectionManager } from './connections.js';
import { WorkspaceManager, type OpenWorkspace } from './workspaces.js';
import { logPage, logUnit } from './log.js';
import { listConfigLocations, readConfigs, saveImported } from './importer.js';
import type { ContextView, ErrorReply, Events, LogUnit, Message, Method, OpenedWorkspace, Requests, ServerForm, ServerRow, SurfaceView } from './api.js';

export interface BackendOptions {
  dataDir: string;
  secrets: SecretStore;
  /** The live stdio servers' root processes, whenever they change (D36). */
  onProcesses?: (roots: ServerRoot[]) => void;
  now?: () => number;
  probeTimeoutMs?: number;
  closeGraceMs?: number;
}

type Handler<M extends Method> = (params: Requests[M]['params']) => Promise<Requests[M]['result']> | Requests[M]['result'];

const DEFAULT_PAGE = 500;

export class Backend {
  private readonly workspaces: WorkspaceManager;
  private connections: ConnectionManager | undefined;
  private readonly listeners = new Set<<E extends keyof Events>(name: E, data: Events[E]) => void>();
  private readonly handlers: { [M in Method]: Handler<M> };

  constructor(private readonly opts: BackendOptions) {
    this.workspaces = new WorkspaceManager({ dataDir: opts.dataDir, secrets: opts.secrets, now: opts.now, onNotice: (n) => this.emit('notice', n) });
    this.handlers = {
      'workspaces.list': () => this.workspaces.list(),
      'workspaces.current': () => (this.workspaces.open ? this.opened(this.workspaces.open) : null),
      // The current workspace's sessions end only once the new one is open: a
      // wrong passphrase or a refused create must leave them running.
      'workspaces.create': async ({ name, protection }) => {
        const { workspace, recoveryKey } = await this.workspaces.create(name, protection, () => this.closeConnections());
        this.startConnections(workspace);
        return { ...this.opened(workspace), ...(recoveryKey ? { recoveryKey } : {}) };
      },
      'workspaces.open': async ({ id, unlock }) => {
        const workspace = await this.workspaces.openWorkspace(id, unlock, () => this.closeConnections());
        this.startConnections(workspace);
        return this.opened(workspace);
      },
      'workspaces.close': async () => {
        await this.closeConnections();
        this.workspaces.close();
        return null;
      },
      'servers.list': () => listServers(this.ws()).map((s) => this.row(s.id)),
      'servers.get': ({ id }) => toForm(this.server(id)),
      'servers.save': async ({ server }) => {
        const id = server.id ?? randomUUID();
        const existing = server.id ? loadServer(this.ws(), server.id) : null;
        saveServer(this.ws(), fromForm({ ...server, id }, existing), this.opts.now);
        // Which secrets are asked for may have changed; ask again rather than
        // send a server values it no longer names.
        this.conns().forgetSecrets(id);
        return this.row(id);
      },
      'servers.delete': async ({ id }) => {
        await this.conns().disconnect(id);
        return deleteServer(this.ws(), id);
      },
      'connections.connect': ({ serverId, secrets }) => this.conns().connect(serverId, secrets),
      'connections.startAgain': ({ serverId }) => this.conns().startAgain(serverId),
      'connections.redetect': ({ serverId }) => this.conns().redetect(serverId),
      'connections.disconnect': ({ serverId }) => this.conns().disconnect(serverId),
      'log.units': ({ serverId, before, limit }) => logPage(this.ws().db, serverId, before, limit ?? DEFAULT_PAGE),
      'log.get': ({ id, reserialized }) => logUnit(this.ws().db, id, reserialized),
      'settings.get': () => readSettings(this.ws()),
      'settings.update': ({ changes }) => updateSettings(this.ws(), changes),
      'history.size': () => ({ fileBytes: fileBytes(this.ws().db), usedBytes: usedBytes(this.ws().db) }),
      'history.previewPurge': () => previewPurge(this.ws(), this.opts.now),
      'history.purge': () => purgeHistory(this.ws(), this.opts.now),
      'history.compact': () => compact(this.ws()),
      'import.locations': ({ projectRoots }) => listConfigLocations(projectRoots),
      'import.read': ({ locations }) => readConfigs(locations),
      'import.save': ({ servers }) => {
        const ids = saveImported(this.ws(), servers, this.opts.now);
        // A replaced server may have been connected with secrets it no longer names.
        for (const id of ids) this.conns().forgetSecrets(id);
        return ids.map((id) => this.row(id));
      },
      'surface.get': ({ serverId }) => this.surface(serverId),
      'surface.refresh': async ({ serverId }) => {
        await this.conns().capture(serverId);
        return this.surface(serverId);
      },
      'context.get': ({ excluded }) => this.context(new Set(excluded ?? [])),
    };
  }

  /** Answers one request. Throws what the renderer should be told. */
  request<M extends Method>(method: M, params: Requests[M]['params']): Promise<Requests[M]['result']> {
    const handler = this.handlers[method] as Handler<M> | undefined;
    if (!handler) return Promise.reject(new Error(`unknown method ${String(method)}`));
    return Promise.resolve().then(() => handler(params));
  }

  on(listener: <E extends keyof Events>(name: E, data: Events[E]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Ends every session and closes the workspace: the app is quitting. */
  async shutdown(): Promise<void> {
    await this.closeConnections();
    this.workspaces.close();
  }

  private emit<E extends keyof Events>(name: E, data: Events[E]): void {
    for (const l of this.listeners) l(name, data);
  }

  private ws() {
    const open = this.workspaces.open;
    if (!open) throw new NoWorkspaceError('no workspace is open');
    return open.ws;
  }

  private conns(): ConnectionManager {
    if (!this.connections) throw new NoWorkspaceError('no workspace is open');
    return this.connections;
  }

  private startConnections(open: OpenWorkspace): void {
    this.connections = new ConnectionManager(open.ws, {
      now: this.opts.now,
      probeTimeoutMs: this.opts.probeTimeoutMs,
      closeGraceMs: this.opts.closeGraceMs,
      events: {
        state: (serverId, state) => this.emit('connection.state', { serverId, state }),
        unit: (_serverId, _connectionId, unitId) => this.emit('log.unit', this.liveUnit(unitId)),
        processes: (roots) => this.opts.onProcesses?.(roots),
        surface: (serverId) => this.emit('surface.changed', { serverId }),
      },
    });
  }

  private async closeConnections(): Promise<void> {
    const c = this.connections;
    this.connections = undefined;
    await c?.closeAll();
  }

  private opened(w: OpenWorkspace): OpenedWorkspace {
    return { id: w.id, name: w.name, encrypted: w.encrypted };
  }

  private server(id: string): ServerDefinition {
    const def = loadServer(this.ws(), id);
    if (!def) throw new Error(`no server ${id} in this workspace`);
    return def;
  }

  private row(id: string): ServerRow {
    const def = this.server(id);
    const era = readDetectedEra(this.ws(), id);
    return {
      id: def.id, name: def.name, transport: def.transport,
      state: this.conns().state(id),
      ...(era ? { era: { era: era.era, revision: era.revision } } : {}),
    };
  }

  private surface(serverId: string): SurfaceView {
    this.server(serverId);
    const latest = latestCapture(this.ws(), serverId);
    return { capture: latest ?? null, status: this.conns().captureStatus(serverId) };
  }

  private context(excluded: Set<string>): ContextView {
    const ws = this.ws();
    const rows = listServers(ws)
      .map((s) => ({ server: s, latest: latestCapture(ws, s.id) }))
      .sort((a, b) => (a.server.name < b.server.name ? -1 : a.server.name > b.server.name ? 1 : a.server.id < b.server.id ? -1 : 1));
    const included: ContextServer[] = rows
      .filter((r) => r.latest && !excluded.has(r.server.id))
      .map((r) => ({ id: r.server.id, name: r.server.name, surface: r.latest!.surface }));
    return {
      servers: rows.map((r) => ({
        id: r.server.id, name: r.server.name, included: !excluded.has(r.server.id),
        capturedAt: r.latest?.observedAt ?? null,
        ...(r.latest ? { revision: r.latest.surface.revision } : {}),
      })),
      text: renderContext(buildContext(included)),
      cost: costContext(included, O200K),
    };
  }

  private liveUnit(id: number): LogUnit {
    // Read back as stored: the opt-out may have withheld the bytes (D30).
    const unit = logUnit(this.ws().db, id);
    if (!unit) throw new Error(`unit ${id} was recorded and cannot be read back`);
    return unit;
  }
}

/** A request needs an open workspace and none is. */
export class NoWorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NoWorkspaceError';
  }
}

/** The definition as the renderer may see it: stored secret values replaced by null. */
function toForm(def: ServerDefinition): ServerForm {
  const { secretEnv, secretHeaders, ...rest } = def;
  const names = (m?: Record<string, string>) => (m ? Object.fromEntries(Object.keys(m).map((k) => [k, null])) : undefined);
  return { ...rest, ...(secretEnv ? { secretEnv: names(secretEnv) } : {}), ...(secretHeaders ? { secretHeaders: names(secretHeaders) } : {}) };
}

/** The definition to store: a secret given as null keeps the value already stored. */
function fromForm(form: ServerForm & { id: string }, existing: ServerDefinition | null): ServerDefinition {
  const resolve = (given: Record<string, string | null> | undefined, stored: Record<string, string> | undefined, what: string) => {
    if (!given) return undefined;
    return Object.fromEntries(Object.entries(given).map(([name, value]) => {
      const v = value ?? stored?.[name];
      if (v === undefined) throw new Error(`secret ${what} ${name} has no value to keep`);
      return [name, v];
    }));
  };
  const { secretEnv, secretHeaders, ...rest } = form;
  const def: ServerDefinition = { ...rest };
  const env = resolve(secretEnv, existing?.secretEnv, 'environment variable');
  const headers = resolve(secretHeaders, existing?.secretHeaders, 'header');
  if (env) def.secretEnv = env;
  if (headers) def.secretHeaders = headers;
  return def;
}

/**
 * Serves a Backend over a message port: requests in, responses and events
 * out. The port shape fits Electron's MessagePortMain and Node's MessagePort
 * once each is adapted to these two functions.
 */
export function serve(backend: Backend, port: { post(message: Message): void; onMessage(listener: (message: Message) => void): void }): () => void {
  const off = backend.on((name, data) => port.post({ kind: 'event', name, data }));
  port.onMessage((message) => {
    if (message.kind !== 'request') return;
    backend.request(message.method, message.params as never).then(
      (result) => port.post({ kind: 'response', id: message.id, ok: true, result }),
      (e: unknown) => port.post({ kind: 'response', id: message.id, ok: false, error: errorReply(e) }),
    );
  });
  return off;
}

function errorReply(e: unknown): ErrorReply {
  if (!(e instanceof Error)) return { name: 'Error', message: String(e) };
  const failure = (e as { failure?: ErrorReply['failure'] }).failure;
  return { name: e.name === 'Error' ? e.constructor.name : e.name, message: e.message, ...(failure ? { failure } : {}) };
}
