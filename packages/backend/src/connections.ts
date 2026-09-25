// The connection lifecycle (plan phase 04; spec D20, D31, D34, D36): one
// honest state per server, every unit of traffic recorded, the era pinned,
// and nothing started that the user did not ask for (P2).
import {
  connectHttp, connectStdio, ConnectError,
  type CloseInfo, type ConnectFailure, type Connection, type EraPreference, type ProcessExit, type WireUnit,
} from '../../protocol/dist/index.js';
import {
  HistoryRecorder, loadServer, pinEra, clearEra, readDetectedEra,
  type ServerDefinition, type SecretNames, type Workspace,
} from '../../storage/dist/index.js';
import { killProcessTree, isAlive, type ServerRoot } from '../../platform/dist/index.js';

/**
 * What the app offers after a stdio failure that a second spawn could get
 * past. Starting the process again is the user's decision (D20, revised and
 * clarified 2026-09-24).
 */
export type StartAgainOffer =
  /** It died on the era probe, and is now pinned legacy. */
  | 'as-legacy'
  /** It is pinned legacy and answered -32022; starting again re-detects. */
  | 'redetect';

export type ConnectionState =
  | { status: 'idle' }
  /** A server's secrets whose values are not stored, and not yet given this session (D31). */
  | { status: 'needs-secrets'; missing: SecretNames }
  | { status: 'connecting'; step: 'starting' | 'negotiating'; era: EraPreference; connectionId: number }
  | { status: 'connected'; era: 'legacy' | 'modern'; revision: string; pid?: number; connectionId: number; connectedAt: number }
  | { status: 'failed'; failure: ConnectFailure; message: string; stderr: string; at: number; offer?: StartAgainOffer; connectionId?: number }
  | { status: 'closing'; connectionId: number }
  /** A session that was up has ended: closed by the user, or the server went away. */
  | { status: 'ended'; exit?: ProcessExit; byUser: boolean; at: number; connectionId: number };

/** Session-only secret values for one server (D31): never written anywhere. */
export interface SecretValues {
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

export interface ConnectionEvents {
  state(serverId: string, state: ConnectionState): void;
  /** Every recorded unit, with the id it was stored under. */
  unit(serverId: string, connectionId: number, unitId: number, unit: WireUnit): void;
  /** Every live stdio server's root process, whenever the set changes: the main process kills these trees if the backend dies (D36). */
  processes(roots: ServerRoot[]): void;
}

export interface ConnectionManagerOptions {
  events: Partial<ConnectionEvents>;
  now?: () => number;
  probeTimeoutMs?: number;
  /**
   * How long a closed stdio server gets to exit before its tree is killed
   * (D36). Capped below the SDK's own wait, see SDK_STDIN_CLOSE_WAIT_MS.
   */
  closeGraceMs?: number;
}

interface Slot {
  state: ConnectionState;
  conn?: Connection;
  recorder?: HistoryRecorder;
  /** Set while a connect or close is running, so a second one waits its turn rather than racing it. */
  busy?: Promise<unknown>;
  /** A stdio process spawned by a connect still under way: reported from its spawn, so a backend that dies mid-connect leaves it findable (D36). */
  starting?: ServerRoot;
}

/**
 * How long the SDK's StdioClientTransport.close() waits after ending stdin
 * before it sends SIGTERM to the process it spawned, and only to that one
 * (@modelcontextprotocol/client 2.0.0, dist/stdio.mjs close()). On Windows
 * that SIGTERM ends a cmd.exe root at once and leaves the node under it
 * running, unfindable from the dead root. So the tree kill must land before
 * this, while the root is alive to be walked from.
 */
const SDK_STDIN_CLOSE_WAIT_MS = 2000;
const DEFAULT_CLOSE_GRACE_MS = 1000;
/** The tree kill must finish before the SDK's SIGTERM; taskkill takes tens of milliseconds. */
const TREE_KILL_MARGIN_MS = 500;

export class ConnectionManager {
  private readonly slots = new Map<string, Slot>();
  private readonly sessionSecrets = new Map<string, SecretValues>();
  private readonly now: () => number;

  constructor(private readonly ws: Workspace, private readonly opts: ConnectionManagerOptions) {
    this.now = opts.now ?? Date.now;
  }

  state(serverId: string): ConnectionState {
    return this.slots.get(serverId)?.state ?? { status: 'idle' };
  }

  /**
   * Connects a server as the user asked. A server pinned legacy gets no probe;
   * otherwise the era is probed in place and pinned on success (D20).
   */
  connect(serverId: string, secrets?: SecretValues): Promise<ConnectionState> {
    return this.serialize(serverId, () => this.doConnect(serverId, secrets));
  }

  /** The user accepted the offer on a failed stdio connect: start the process again. */
  startAgain(serverId: string): Promise<ConnectionState> {
    return this.serialize(serverId, async () => {
      const state = this.state(serverId);
      if (state.status !== 'failed' || !state.offer) throw new Error(`server ${serverId} has nothing to start again`);
      if (state.offer === 'redetect') clearEra(this.ws, serverId);
      return this.doConnect(serverId);
    });
  }

  /** The user's explicit re-detect (board 3.2): forget the pinned era and connect with a probe, restarting a live session. */
  redetect(serverId: string): Promise<ConnectionState> {
    return this.serialize(serverId, async () => {
      await this.doDisconnect(serverId);
      clearEra(this.ws, serverId);
      return this.doConnect(serverId);
    });
  }

  disconnect(serverId: string): Promise<ConnectionState> {
    return this.serialize(serverId, () => this.doDisconnect(serverId));
  }

  /** Ends every session: the app is quitting, or the workspace is closing. */
  async closeAll(): Promise<void> {
    await Promise.all([...this.slots.keys()].map((id) => this.disconnect(id)));
  }

  /** Session secrets are forgotten with the manager; this forgets one server's early, as when its definition changes. */
  forgetSecrets(serverId: string): void {
    this.sessionSecrets.delete(serverId);
  }

  private async serialize<T>(serverId: string, work: () => Promise<T>): Promise<T> {
    const slot = this.slot(serverId);
    while (slot.busy) await slot.busy.catch(() => undefined);
    const run = work();
    slot.busy = run;
    try {
      return await run;
    } finally {
      if (slot.busy === run) slot.busy = undefined;
    }
  }

  private slot(serverId: string): Slot {
    let s = this.slots.get(serverId);
    if (!s) {
      s = { state: { status: 'idle' } };
      this.slots.set(serverId, s);
    }
    return s;
  }

  private set(serverId: string, state: ConnectionState): ConnectionState {
    this.slot(serverId).state = state;
    this.opts.events.state?.(serverId, state);
    return state;
  }

  private announceProcesses(): void {
    const roots = [...this.slots.values()].flatMap((s) => (s.conn?.pid !== undefined ? [{ pid: s.conn.pid, startedAt: s.conn.startedAt ?? this.now() }] : s.starting ? [s.starting] : []));
    this.opts.events.processes?.(roots);
  }

  private async doConnect(serverId: string, given?: SecretValues): Promise<ConnectionState> {
    const current = this.state(serverId);
    if (current.status === 'connected') return current;
    const def = loadServer(this.ws, serverId);
    if (!def) throw new Error(`no server ${serverId} in this workspace`);

    if (given) this.sessionSecrets.set(serverId, mergeSecrets(this.sessionSecrets.get(serverId), given));
    const missing = missingSecrets(def, this.sessionSecrets.get(serverId));
    if (missing) return this.set(serverId, { status: 'needs-secrets', missing });
    const session = this.sessionSecrets.get(serverId);

    const pinned = readDetectedEra(this.ws, serverId);
    const era: EraPreference = pinned?.era === 'legacy' ? 'legacy' : 'auto';
    const recorder = HistoryRecorder.open(this.ws, serverId, this.now);
    const connectionId = recorder.connectionId;
    const slot = this.slot(serverId);
    slot.recorder = recorder;
    this.set(serverId, { status: 'connecting', step: def.transport === 'stdio' ? 'starting' : 'negotiating', era, connectionId });

    const onUnit = (u: WireUnit) => {
      const unitId = recorder.unit(u);
      this.opts.events.unit?.(serverId, connectionId, unitId, u);
      const event = u.kind === 'app' ? appEvent(u) : undefined;
      if (event?.event === 'spawned' && typeof event.pid === 'number') {
        slot.starting = { pid: event.pid, startedAt: this.now() };
        this.announceProcesses();
      }
      if (event?.event === 'spawned' && this.state(serverId).status === 'connecting') {
        this.set(serverId, { status: 'connecting', step: 'negotiating', era, connectionId });
      }
    };
    const onClose = (info: CloseInfo) => this.sessionEnded(serverId, connectionId, info);

    let conn: Connection;
    try {
      conn = def.transport === 'stdio'
        ? await connectStdio({
          command: def.command!, args: def.args, cwd: def.cwd,
          env: { ...inheritedEnv(), ...def.env, ...def.secretEnv, ...session?.env },
          era, onUnit, onClose, probeTimeoutMs: this.opts.probeTimeoutMs,
          // A failed connect ends the whole tree, not just its root (D36).
          terminate: (pid) => killProcessTree(pid),
        })
        : await connectHttp({
          url: def.url!, kind: def.transport, era,
          headers: def.headers, secretHeaders: { ...def.secretHeaders, ...session?.headers },
          onUnit, probeTimeoutMs: this.opts.probeTimeoutMs,
        });
    } catch (e) {
      recorder.close();
      slot.recorder = undefined;
      // The adapter has ended whatever it spawned (terminate, above).
      slot.starting = undefined;
      this.announceProcesses();
      if (!(e instanceof ConnectError)) {
        return this.set(serverId, { status: 'failed', failure: { kind: 'protocol' }, message: e instanceof Error ? e.message : String(e), stderr: '', at: this.now(), connectionId });
      }
      return this.set(serverId, { status: 'failed', failure: e.failure, message: e.message, stderr: e.stderr, at: this.now(), connectionId, ...this.offerFor(serverId, def, era, e.failure) });
    }

    slot.conn = conn;
    slot.starting = undefined;
    recorder.negotiated(conn.revision, conn.era);
    if (pinned?.era !== conn.era || pinned.revision !== conn.revision) pinEra(this.ws, serverId, conn.era, conn.revision, this.now);
    this.announceProcesses();
    return this.set(serverId, { status: 'connected', era: conn.era, revision: conn.revision, pid: conn.pid, connectionId, connectedAt: this.now() });
  }

  /**
   * D20: a stdio server that died on the probe is pinned legacy now, and the
   * user is asked before it starts again; one pinned legacy that answers
   * -32022 is offered a re-detect. HTTP needs neither: nothing was spawned,
   * and the adapter already fell back or re-probed on its own.
   */
  private offerFor(serverId: string, def: ServerDefinition, era: EraPreference, failure: ConnectFailure): { offer?: StartAgainOffer } {
    if (def.transport !== 'stdio') return {};
    if (failure.kind === 'exited' && failure.diedOnProbe && era === 'auto') {
      pinEra(this.ws, serverId, 'legacy', null, this.now);
      return { offer: 'as-legacy' };
    }
    if (failure.kind === 'unsupported-version' && era === 'legacy') return { offer: 'redetect' };
    return {};
  }

  private sessionEnded(serverId: string, connectionId: number, info: CloseInfo): void {
    const slot = this.slots.get(serverId);
    if (!slot || !slot.conn) return;
    const byUser = slot.state.status === 'closing';
    slot.conn = undefined;
    slot.recorder?.close();
    slot.recorder = undefined;
    this.announceProcesses();
    this.set(serverId, { status: 'ended', ...(info.exit ? { exit: info.exit } : {}), byUser, at: this.now(), connectionId });
  }

  private async doDisconnect(serverId: string): Promise<ConnectionState> {
    const slot = this.slots.get(serverId);
    if (!slot?.conn) {
      // Nothing is running: a failed or ended state is cleared, so the next
      // connect starts from rest.
      return slot && slot.state.status !== 'idle' ? this.set(serverId, { status: 'idle' }) : this.state(serverId);
    }
    const conn = slot.conn;
    const connectionId = (slot.state as { connectionId: number }).connectionId;
    this.set(serverId, { status: 'closing', connectionId });
    // The SDK ends stdin and waits before its own SIGTERM, which reaches only
    // the root. Whatever of the tree is still alive after the grace is killed
    // as a tree from that root, while it can still be found (D36).
    const pid = conn.pid;
    const grace = Math.min(this.opts.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS, SDK_STDIN_CLOSE_WAIT_MS - TREE_KILL_MARGIN_MS);
    const treeKill = pid === undefined ? undefined : setTimeout(() => { if (isAlive(pid)) void killProcessTree(pid).catch(() => undefined); }, grace);
    try {
      await conn.close();
    } finally {
      if (treeKill) clearTimeout(treeKill);
    }
    if (pid !== undefined && isAlive(pid)) await killProcessTree(pid).catch(() => undefined);
    // onClose normally reports the end; a transport that never fires it (HTTP
    // fires it only from close()) is ended here.
    if (slot.conn) this.sessionEnded(serverId, connectionId, {});
    return this.state(serverId);
  }
}

/** The environment a stdio server inherits: the app's own, as a shell would pass it. */
function inheritedEnv(): Record<string, string> {
  return Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
}

function mergeSecrets(a: SecretValues | undefined, b: SecretValues): SecretValues {
  return { env: { ...a?.env, ...b.env }, headers: { ...a?.headers, ...b.headers } };
}

/** The unstored secrets this server needs that the session has not been given, or undefined when none are missing. */
function missingSecrets(def: ServerDefinition, session: SecretValues | undefined): SecretNames | undefined {
  const env = (def.unstoredSecrets?.env ?? []).filter((n) => session?.env?.[n] === undefined);
  const headers = (def.unstoredSecrets?.headers ?? []).filter((n) => session?.headers?.[n] === undefined);
  if (env.length === 0 && headers.length === 0) return undefined;
  return { ...(env.length ? { env } : {}), ...(headers.length ? { headers } : {}) };
}

function appEvent(u: WireUnit): { event?: unknown; pid?: unknown } | undefined {
  try {
    return JSON.parse(Buffer.from(u.bytes).toString('utf8'));
  } catch {
    return undefined;
  }
}
