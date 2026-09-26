// What the user set on a live session (phase 10 decisions 5, 7 and 8): the
// log level, legacy resource subscriptions, the modern listen stream, and the
// one-off utility requests (ping, completions). Every request here is one the
// user asked for; nothing is re-sent, re-opened or polled on its own (P2).
import type {
  CallOutcome, Connection, ListenEnd, ListenHandle, LogLevel, ServerNotification, SubscriptionFilter, UtilityMethod, UtilityOutcome,
} from '../../protocol/dist/index.js';

/** The modern listen stream as the user sees it. */
export interface ListenView {
  /** Null until the request is out. */
  requestId: string | number | null;
  /** What the user asked for. */
  filter: SubscriptionFilter;
  /** What the server said it will honour; null until it acknowledges. */
  acknowledged: SubscriptionFilter | null;
  status: 'open' | 'ended';
  end?: ListenEnd;
}

export interface SessionInfo {
  connected: boolean;
  era?: 'legacy' | 'modern';
  revision?: string;
  logLevel: LogLevel | null;
  /**
   * Resources the user subscribed to: on legacy by resources/subscribe, on
   * modern in the listen's filter. Sorted.
   */
  subscribed: string[];
  /** When each subscribed resource was last announced as updated, this session. */
  updated: Record<string, number>;
  listen: ListenView | null;
}

interface Live {
  conn: Connection;
  era: 'legacy' | 'modern';
  subscribed: Set<string>;
  updated: Map<string, number>;
  listen?: { handle: ListenHandle; view: ListenView };
}

export interface SessionSource {
  session(serverId: string): { conn: Connection; era: 'legacy' | 'modern' } | undefined;
}

export class SessionControls {
  private readonly live = new Map<string, Live>();

  constructor(private readonly source: SessionSource, private readonly changed: (serverId: string) => void, private readonly now: () => number = Date.now) {}

  info(serverId: string): SessionInfo {
    const s = this.current(serverId);
    if (!s) return { connected: false, logLevel: null, subscribed: [], updated: {}, listen: null };
    return {
      connected: true, era: s.era, revision: s.conn.revision,
      logLevel: s.conn.logLevel ?? null,
      subscribed: [...s.subscribed].sort(),
      updated: Object.fromEntries(s.updated),
      listen: s.listen ? { ...s.listen.view } : null,
    };
  }

  async setLogLevel(serverId: string, level: LogLevel | null): Promise<UtilityOutcome | null> {
    const s = this.require(serverId);
    const outcome = await s.conn.setLogLevel(level ?? undefined);
    this.changed(serverId);
    return outcome ?? null;
  }

  /** Ping, a completion, or any other utility request: sent once. */
  request(serverId: string, method: UtilityMethod, params?: Record<string, unknown>): Promise<UtilityOutcome> {
    return this.require(serverId).conn.request({ method, ...(params ? { params } : {}) });
  }

  /** Legacy: tasks/list, once. */
  tasks(serverId: string, cursor?: string): Promise<CallOutcome> {
    return this.require(serverId).conn.task({ method: 'tasks/list', params: cursor === undefined ? {} : { cursor } });
  }

  /**
   * Subscribe or unsubscribe one resource. Legacy: resources/subscribe or
   * unsubscribe. Modern: the listen's filter gains or loses the uri, so the
   * stream is opened, or closed and opened again with the new filter.
   */
  async subscribe(serverId: string, uri: string, on: boolean): Promise<UtilityOutcome | null> {
    const s = this.require(serverId);
    if (s.era === 'legacy') {
      const outcome = await s.conn.request({ method: on ? 'resources/subscribe' : 'resources/unsubscribe', params: { uri } });
      if (outcome.kind === 'result') {
        if (on) s.subscribed.add(uri); else s.subscribed.delete(uri);
      }
      this.changed(serverId);
      return outcome;
    }
    const filter: SubscriptionFilter = { ...(s.listen?.view.status === 'open' ? s.listen.view.filter : {}) };
    const uris = new Set(filter.resourceSubscriptions ?? []);
    if (on) uris.add(uri); else uris.delete(uri);
    filter.resourceSubscriptions = [...uris].sort();
    this.openListen(serverId, s, filter);
    return null;
  }

  /** Modern: open the listen with this filter, replacing any open one; null closes it. */
  listen(serverId: string, filter: SubscriptionFilter | null): void {
    const s = this.require(serverId);
    if (s.era !== 'modern') throw new Error('subscriptions/listen does not exist on ' + s.conn.revision);
    if (filter === null) {
      s.listen?.handle.close();
      return;
    }
    this.openListen(serverId, s, filter);
  }

  /** Every notification a session received, for the state it changes here. */
  notification(serverId: string, n: ServerNotification): void {
    const s = this.live.get(serverId);
    if (!s) return;
    const params = (n.params ?? {}) as { uri?: unknown; notifications?: SubscriptionFilter; _meta?: Record<string, unknown> };
    if (n.method === 'notifications/resources/updated' && typeof params.uri === 'string') {
      s.updated.set(params.uri, this.now());
      this.changed(serverId);
    }
    if (n.method === 'notifications/subscriptions/acknowledged' && s.listen) {
      const sub = params._meta?.['io.modelcontextprotocol/subscriptionId'];
      if (sub === s.listen.view.requestId) {
        s.listen.view.acknowledged = params.notifications ?? {};
        this.changed(serverId);
      }
    }
  }

  /** The session ended: everything set on it goes with it. */
  sessionEnded(serverId: string): void {
    if (this.live.delete(serverId)) this.changed(serverId);
  }

  private openListen(serverId: string, s: Live, filter: SubscriptionFilter): void {
    // One stream per connection: the old one closes as the new one opens.
    s.listen?.handle.close();
    const handle = s.conn.listen(filter);
    const view: ListenView = { requestId: handle.requestId ?? null, filter, acknowledged: null, status: 'open' };
    const entry = { handle, view };
    s.listen = entry;
    s.subscribed = new Set(filter.resourceSubscriptions ?? []);
    void handle.ended.then((end) => {
      view.status = 'ended';
      view.end = end;
      if (s.listen === entry) s.subscribed = new Set();
      this.changed(serverId);
    });
    this.changed(serverId);
  }

  /** The live state for the session now up, started fresh when the session is new. */
  private current(serverId: string): Live | undefined {
    const session = this.source.session(serverId);
    if (!session) return undefined;
    let s = this.live.get(serverId);
    if (!s || s.conn !== session.conn) {
      s = { conn: session.conn, era: session.era, subscribed: new Set(), updated: new Map() };
      this.live.set(serverId, s);
    }
    return s;
  }

  private require(serverId: string): Live {
    const s = this.current(serverId);
    if (!s) throw new Error(`server ${serverId} is not connected`);
    return s;
  }
}
