// The backend the renderer talks to (D32): workspaces, servers, connections
// and the wire log behind one message API. Plain Node, so every request is
// testable without Electron (D17); the utility-process entry only wires ports.
import { randomUUID } from 'node:crypto';
import {
  deleteServer, listServers, loadServer, readDetectedEra, saveServer,
  type ServerDefinition, type SecretStore,
} from '../../storage/dist/index.js';
import type { HttpDetails, WireUnit } from '../../protocol/dist/index.js';
import { ConnectionManager } from './connections.js';
import { WorkspaceManager, type OpenWorkspace } from './workspaces.js';
import type { ErrorReply, Events, LogCursor, LogUnit, Message, Method, OpenedWorkspace, Requests, ServerForm, ServerRow } from './api.js';

export interface BackendOptions {
  dataDir: string;
  secrets: SecretStore;
  /** The live stdio server PIDs, whenever they change (D36). */
  onProcesses?: (pids: number[]) => void;
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
      'workspaces.create': async ({ name, protection }) => {
        await this.closeConnections();
        const { workspace, recoveryKey } = this.workspaces.create(name, protection);
        this.startConnections(workspace);
        return { ...this.opened(workspace), ...(recoveryKey ? { recoveryKey } : {}) };
      },
      'workspaces.open': async ({ id, unlock }) => {
        await this.closeConnections();
        const workspace = this.workspaces.openWorkspace(id, unlock);
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
      'log.units': ({ serverId, before, limit }) => this.logPage(serverId, before, limit ?? DEFAULT_PAGE),
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
        unit: (serverId, connectionId, unitId, unit) => this.emit('log.unit', this.liveUnit(serverId, connectionId, unitId, unit)),
        processes: (pids) => this.opts.onProcesses?.(pids),
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

  private liveUnit(serverId: string, connectionId: number, id: number, u: WireUnit): LogUnit {
    // The row as stored: the opt-out may have withheld the bytes (D30).
    const row = this.ws().db.prepare('SELECT at, bytes FROM wire_unit WHERE id = ?').get(id) as { at: number; bytes: Uint8Array | null };
    return {
      id, serverId, connectionId, direction: u.direction, kind: u.kind, at: row.at,
      byteLength: u.bytes.length, bytes: row.bytes === null ? null : new Uint8Array(row.bytes),
      ...(u.http ? { http: u.http } : {}),
    };
  }

  /**
   * A page of the log, oldest first. Frames written before schema 3 have no
   * unit and are listed from their re-serialized message, marked as such
   * (D34), in time order with everything else.
   */
  private logPage(serverId: string, before: LogCursor | undefined, limit: number): LogUnit[] {
    const cursor = before ? [before.at, before.reserialized ? 1 : 0, before.id] : [Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER];
    const rows = this.ws().db.prepare(`
      SELECT * FROM (
        SELECT u.id, u.connection_id, u.direction, u.kind, u.at, u.byte_length, u.bytes, u.http_json, 0 AS reserialized
        FROM wire_unit u JOIN connection c ON c.id = u.connection_id WHERE c.server_id = @server
        UNION ALL
        SELECT f.id, f.connection_id, f.direction, 'wire', f.at, coalesce(length(CAST(f.message_json AS BLOB)), 0),
               CAST(f.message_json AS BLOB), NULL, 1
        FROM frame f JOIN connection c ON c.id = f.connection_id WHERE c.server_id = @server AND f.unit_id IS NULL
      )
      WHERE (at, reserialized, id) < (@at, @reserialized, @id)
      ORDER BY at DESC, reserialized DESC, id DESC
      LIMIT @limit
    `).all({ server: serverId, at: cursor[0], reserialized: cursor[1], id: cursor[2], limit }) as {
      id: number; connection_id: number; direction: LogUnit['direction']; kind: LogUnit['kind']; at: number;
      byte_length: number; bytes: Uint8Array | null; http_json: string | null; reserialized: number;
    }[];
    return rows.reverse().map((r) => ({
      id: r.id, serverId, connectionId: r.connection_id, direction: r.direction, kind: r.kind, at: r.at,
      byteLength: r.byte_length, bytes: r.bytes === null ? null : new Uint8Array(r.bytes),
      ...(r.http_json ? { http: JSON.parse(r.http_json) as HttpDetails } : {}),
      ...(r.reserialized ? { reserialized: true } : {}),
    }));
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
