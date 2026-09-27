// The connection lifecycle (plan phase 04; spec D20, D31, D34, D36): one
// honest state per server, every unit of traffic recorded, the era pinned,
// and nothing started that the user did not ask for (P2).
import {
  captureSurface, connectHttp, connectStdio, ConnectError,
  type ChangedList, type CloseInfo, type NormalizedSurface, type ConnectFailure, type Connection, type EraPreference, type ProcessExit, type WireUnit,
  type ServerAnswer, type ServerRequest, type ServerNotification, type UnitListener, type AuthFailure,
} from '../../protocol/dist/index.js';
import {
  HistoryRecorder, loadServer, pinEra, clearEra, readDetectedEra, recordCapture,
  type ServerDefinition, type SecretNames, type Workspace,
} from '../../storage/dist/index.js';
import { killServerTree, serverRoot, type ServerRoot } from '../../platform/dist/index.js';

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
  /** `auth`: the Connect's refresh was refused, so the tokens were forgotten and the user must sign in again (phase 11 decision 2). */
  | { status: 'failed'; failure: ConnectFailure; message: string; stderr: string; at: number; offer?: StartAgainOffer; connectionId?: number; auth?: AuthFailure }
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
  /** A server's capture status changed, or a capture was recorded. */
  surface(serverId: string): void;
  /** Every notification a live session received (phase 10). */
  notification(serverId: string, notification: ServerNotification): void;
}

/** Where a server's surface capture stands in this session. */
export interface CaptureStatus {
  capturing: boolean;
  /** Lists the server said changed since the last capture; the app does not re-list on its own (P2). */
  changed: ChangedList[];
  /** Why this session's last capture recorded nothing. */
  error?: string;
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
  /** Ends a server's process tree; the platform's killServerTree unless a test stands in. */
  killTree?: (root: ServerRoot) => Promise<unknown>;
  /**
   * A server's own request (legacy era), with the recorder of the session it
   * arrived on. Resolves with a person's answer. Without it a request waits
   * unanswered until the session ends (phase 08 decision 1).
   */
  onServerRequest?: (serverId: string, recorder: HistoryRecorder, request: ServerRequest) => Promise<ServerAnswer>;
  /** OAuth (phase 11): the token an HTTP connect sends, and the refresh a Connect may do first. */
  auth?: {
    accessToken(serverId: string): string | undefined;
    refreshIfDue(serverId: string, emit: UnitListener): Promise<void>;
  };
}

interface Slot {
  state: ConnectionState;
  conn?: Connection;
  recorder?: HistoryRecorder;
  /** Set while a connect or close is running, so a second one waits its turn rather than racing it. */
  busy?: Promise<unknown>;
  /** The stdio process this slot's current connect or session spawned. */
  root?: ServerRoot;
  capturing?: Promise<void>;
  changed: Set<ChangedList>;
  captureError?: string;
  /** This session's newest capture when a list failed: shown, never recorded (R06-11). */
  partial?: PartialCapture;
}

/** A capture with at least one failed list, kept for the session it was taken in. */
export interface PartialCapture {
  surface: NormalizedSurface;
  observedAt: number;
  connectionId: number;
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
/**
 * Room for the tree kill before the SDK's SIGTERM. Not always enough on
 * Windows: the PID-reuse check lists processes (about 700 ms) and taskkill
 * takes about 400 ms to start (both measured 2026-09-25), so the root can die
 * first. killServerTree then finds what it left behind by its parent.
 */
const TREE_KILL_MARGIN_MS = 500;

export class ConnectionManager {
  private readonly slots = new Map<string, Slot>();
  /**
   * Every server process root this manager spawned and has not seen ended,
   * by PID (D36). A root enters at its spawn and leaves only once its whole
   * tree was ended; one that could not be stays, is reported to the main
   * process, and is tried again by closeAll. This is the one record of what
   * the app is still running, and the processes report is exactly it. Held by
   * root, not PID: a new spawn can get the PID of a root not yet ended, and
   * the old root's leftovers are still ours to end.
   */
  private readonly owned = new Set<ServerRoot>();
  /** Attempts under way, by root: a PID can pass to a new root while an old one is still being ended. */
  private readonly ending = new Map<ServerRoot, Promise<void>>();
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

  /**
   * Ends every session, then every process root still owned, including ones
   * an earlier end could not finish: the app is quitting, or the workspace is
   * closing. One failure does not stop the rest, nor fail the quit or switch
   * that asked (R04-1); it is reported, and a root not ended stays reported.
   */
  async closeAll(): Promise<void> {
    const ids = [...this.slots.keys()];
    const results = await Promise.allSettled(ids.map((id) => this.disconnect(id)));
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        process.emitWarning(`server ${ids[i]} did not close cleanly: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`, 'MCPExplorerConnectionWarning');
      }
    });
    await Promise.all([...this.owned].map((root) => this.endTree(root)));
  }

  captureStatus(serverId: string): CaptureStatus {
    const slot = this.slots.get(serverId);
    return {
      capturing: Boolean(slot?.capturing),
      changed: slot ? [...slot.changed].sort() : [],
      ...(slot?.captureError ? { error: slot.captureError } : {}),
    };
  }

  /** The live session a call runs on, or undefined when the server is not connected. */
  session(serverId: string): { conn: Connection; recorder: HistoryRecorder; connectionId: number; era: 'legacy' | 'modern' } | undefined {
    const slot = this.slots.get(serverId);
    const state = slot?.state;
    if (!slot?.conn || !slot.recorder || state?.status !== 'connected') return undefined;
    return { conn: slot.conn, recorder: slot.recorder, connectionId: state.connectionId, era: state.era };
  }

  /**
   * Somewhere to record traffic that is not a call (a sign-in, a refresh):
   * the live session's log when the server is connected (and `own` is not
   * asked for), else a connection of its own, which `close` ends. Every unit is announced like any other.
   */
  record(serverId: string, own = false): { emit: UnitListener; close(): void } {
    // A sign-in waits on the browser for minutes; the session may end under
    // it, so it records as a connection of its own.
    const live = own ? undefined : this.session(serverId);
    const recorder = live?.recorder ?? HistoryRecorder.open(this.ws, serverId, this.now);
    const connectionId = recorder.connectionId;
    const emit: UnitListener = (u) => {
      const unitId = recorder.unit(u);
      this.opts.events.unit?.(serverId, connectionId, unitId, u);
    };
    return { emit, close: () => { if (!live) recorder.close(); } };
  }

  partialCapture(serverId: string): PartialCapture | undefined {
    return this.slots.get(serverId)?.partial;
  }

  /**
   * Lists the connected server's whole surface and records it (D8). Done on
   * connect and when the user presses Refresh (phase 06 decision 3); a
   * capture already running is shared, not doubled.
   */
  capture(serverId: string): Promise<void> {
    const slot = this.slots.get(serverId);
    const conn = slot?.conn;
    const state = slot?.state;
    if (!slot || !conn || state?.status !== 'connected') return Promise.reject(new Error(`server ${serverId} is not connected`));
    if (slot.capturing) return slot.capturing;
    const connectionId = state.connectionId;
    const run = (async () => {
      slot.captureError = undefined;
      // Cleared as the capture starts, not when it ends: a notice arriving
      // mid-capture may postdate a list already read, and must survive it.
      const noticed = [...slot.changed];
      slot.changed.clear();
      this.opts.events.surface?.(serverId);
      try {
        const surface = await captureSurface(conn.source);
        // A session that ended mid-capture fails every list, and recording
        // that would store an empty surface as a new version.
        if (slot.conn !== conn) throw new Error('the session ended during the capture; nothing was recorded');
        // A failed list reads as an empty one, and the hash cannot tell them
        // apart: recorded, it would be a new version with that list gone. So
        // history holds only whole surfaces (R06-3), and a partial one is kept
        // for this session only, so a server with one list that never works
        // still shows the rest (R06-11). Every frame of it is in the wire log.
        const failed = surface.problems.filter((p) => p.kind === 'list-failed');
        if (failed.length > 0) {
          slot.partial = { surface, observedAt: this.now(), connectionId };
          for (const list of noticed) {
            if (failed.some((p) => p.endpoint.startsWith(`${list}/`))) slot.changed.add(list);
          }
        } else {
          slot.partial = undefined;
          recordCapture(this.ws, serverId, surface, { connectionId, now: this.now });
        }
      } catch (e) {
        for (const list of noticed) slot.changed.add(list);
        slot.captureError = e instanceof Error ? e.message : String(e);
      } finally {
        slot.capturing = undefined;
        this.opts.events.surface?.(serverId);
      }
    })();
    slot.capturing = run;
    return run;
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
      s = { state: { status: 'idle' }, changed: new Set() };
      this.slots.set(serverId, s);
    }
    return s;
  }

  private set(serverId: string, state: ConnectionState): ConnectionState {
    this.slot(serverId).state = state;
    this.opts.events.state?.(serverId, state);
    return state;
  }

  /** A root this manager just spawned: owned, and reported, until its tree is ended. */
  private adopt(root: ServerRoot): void {
    this.owned.add(root);
    this.announceProcesses();
  }

  private announceProcesses(): void {
    this.opts.events.processes?.([...this.owned]);
  }

  /**
   * Ends a root's whole tree, the one way a server process is ended here. The
   * root leaves the registry only if that succeeded; otherwise the failure is
   * reported and the root stays owned. Concurrent calls for one root share one
   * attempt.
   */
  private endTree(root: ServerRoot): Promise<void> {
    if (!this.owned.has(root)) return Promise.resolve();
    const inFlight = this.ending.get(root);
    if (inFlight) return inFlight;
    const attempt = (async () => {
      try {
        await (this.opts.killTree ?? killServerTree)(root);
        // Only this root: its PID may have passed to a newer one meanwhile.
        this.owned.delete(root);
      } catch (e) {
        process.emitWarning(`server process ${root.pid} and what it started could not all be ended: ${e instanceof Error ? e.message : String(e)}`, 'MCPExplorerProcessWarning');
      } finally {
        this.ending.delete(root);
        this.announceProcesses();
      }
    })();
    this.ending.set(root, attempt);
    return attempt;
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
        slot.root = serverRoot(event.pid, this.now());
        this.adopt(slot.root);
      }
      if (event?.event === 'spawned' && this.state(serverId).status === 'connecting') {
        this.set(serverId, { status: 'connecting', step: 'negotiating', era, connectionId });
      }
    };
    const onClose = (info: CloseInfo) => this.sessionEnded(serverId, connectionId, info);
    // A change notice is read from every notification the tap saw, not from
    // the SDK's dispatch, so a modern notice on a listen stream counts the
    // same as a legacy one sent unasked. Nothing is re-listed (P2).
    const onNotification = (n: ServerNotification) => {
      if (slot.recorder !== recorder) return;
      const list = CHANGED_BY_METHOD[n.method];
      if (list) {
        slot.changed.add(list);
        this.opts.events.surface?.(serverId);
      }
      this.opts.events.notification?.(serverId, n);
    };
    const answer = this.opts.onServerRequest;
    const onServerRequest = answer ? (request: ServerRequest) => answer(serverId, recorder, request) : undefined;

    let conn: Connection;
    try {
      // Decision 2: a token that has expired is refreshed as part of this
      // Connect, the user's action, and recorded in this connection's log.
      if (def.transport !== 'stdio') await this.opts.auth?.refreshIfDue(serverId, onUnit);
      conn = def.transport === 'stdio'
        ? await connectStdio({
          command: def.command!, args: def.args, cwd: def.cwd,
          env: { ...inheritedEnv(), ...def.env, ...def.secretEnv, ...session?.env },
          era, onUnit, onClose, onNotification, onServerRequest, probeTimeoutMs: this.opts.probeTimeoutMs,
          // A failed connect ends the whole tree, not just its root (D36),
          // before the SDK's own close signals the root alone.
          terminate: (pid) => (slot.root?.pid === pid ? this.endTree(slot.root) : Promise.resolve()),
        })
        : await connectHttp({
          url: def.url!, kind: def.transport, era,
          headers: def.headers, secretHeaders: { ...def.secretHeaders, ...session?.headers },
          onUnit, onNotification, onServerRequest, probeTimeoutMs: this.opts.probeTimeoutMs,
          ...(this.opts.auth ? { accessToken: () => this.opts.auth!.accessToken(serverId) } : {}),
        });
    } catch (e) {
      recorder.close();
      slot.recorder = undefined;
      // A live root was ended through terminate, above; a root that exited on
      // its own is ended here, which on Windows finds what it left behind.
      if (slot.root) await this.endTree(slot.root);
      slot.root = undefined;
      const authFailure = (e as { name?: string; failure?: AuthFailure }).name === 'AuthError' ? (e as { failure: AuthFailure }).failure : undefined;
      if (authFailure) {
        return this.set(serverId, { status: 'failed', failure: { kind: 'unauthorized', challenge: { status: 401 } }, message: e instanceof Error ? e.message : String(e), stderr: '', at: this.now(), connectionId, auth: authFailure });
      }
      if (!(e instanceof ConnectError)) {
        return this.set(serverId, { status: 'failed', failure: { kind: 'protocol' }, message: e instanceof Error ? e.message : String(e), stderr: '', at: this.now(), connectionId });
      }
      return this.set(serverId, { status: 'failed', failure: e.failure, message: e.message, stderr: e.stderr, at: this.now(), connectionId, ...this.offerFor(serverId, def, era, e.failure) });
    }

    slot.conn = conn;
    recorder.negotiated(conn.revision, conn.era);
    if (pinned?.era !== conn.era || pinned.revision !== conn.revision) pinEra(this.ws, serverId, conn.era, conn.revision, this.now);
    slot.changed.clear();
    slot.partial = undefined;
    slot.captureError = undefined;
    const connected = this.set(serverId, { status: 'connected', era: conn.era, revision: conn.revision, pid: conn.pid, connectionId, connectedAt: this.now() });
    // Connecting includes listing what the server offers (decision 3). Not
    // awaited: a server slow to list must not hold the connect, or a
    // disconnect queued behind it.
    void this.capture(serverId);
    return connected;
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
    slot.changed.clear();
    slot.partial = undefined;
    slot.recorder?.close();
    slot.recorder = undefined;
    // A server that exited on its own may have left processes behind; this
    // ends them, and does nothing for a root already ended by a disconnect.
    const root = slot.root;
    slot.root = undefined;
    if (root) void this.endTree(root);
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
    // the root. The tree is ended after the grace, from that root, while it
    // can still be found (D36); a close that throws still ends the tree and
    // the session, and is reported.
    const root = slot.root;
    const grace = Math.min(this.opts.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS, SDK_STDIN_CLOSE_WAIT_MS - TREE_KILL_MARGIN_MS);
    const treeKill = root ? setTimeout(() => void this.endTree(root), grace) : undefined;
    try {
      await conn.close();
    } catch (e) {
      process.emitWarning(`server ${serverId} did not close cleanly: ${e instanceof Error ? e.message : String(e)}`, 'MCPExplorerConnectionWarning');
    } finally {
      if (treeKill) clearTimeout(treeKill);
    }
    if (root) await this.endTree(root);
    // onClose normally reports the end; a transport that never fires it (HTTP
    // fires it only from close()) is ended here.
    if (slot.conn) this.sessionEnded(serverId, connectionId, {});
    return this.state(serverId);
  }
}

const CHANGED_BY_METHOD: Record<string, ChangedList> = {
  'notifications/tools/list_changed': 'tools',
  'notifications/prompts/list_changed': 'prompts',
  'notifications/resources/list_changed': 'resources',
};

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
