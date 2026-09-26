// OAuth sign-in for remote servers (plan phase 11). Every step is the
// user's: Sign in runs discovery and registration and stops at the browser
// (decision 5), the code is exchanged when the browser comes back, and a
// refresh happens only inside a Connect or a "Refresh and retry" the user
// pressed (decision 2). Tokens live in an encrypted workspace's database, or
// in this manager's memory for an unencrypted one (decision 7), and never
// travel to the renderer (decision 12).
import {
  AuthError, LoopbackListener, authorizationRequest, checkCallback, discoverAuth, exchangeCode, loggingFetch, refreshTokens,
  registerDynamically, type AuthChallenge, type AuthFailure, type AuthServerInfo, type ClientInfo, type TokenSet, type UnitListener,
} from '../../protocol/dist/index.js';
import {
  dropGrant, forgetGrants, loadGrant, loadGrantFor, loadServer, readDetectedEra, saveGrant,
  type Workspace,
} from '../../storage/dist/index.js';

/** The revision discovery names when the server has never answered a handshake. */
const LATEST_REVISION = '2026-07-28';
/** How long a sign-in waits for the browser before it gives up and says so (decision 5). */
export const CALLBACK_TIMEOUT_MS = 10 * 60 * 1000;
/** A token this close to its expiry is refreshed by the Connect that would use it. */
const EXPIRY_MARGIN_MS = 60 * 1000;

/** One sign-in's result: how to reach the authorization server, who the app is to it, and the tokens. */
interface Grant {
  info: AuthServerInfo;
  client: ClientInfo;
  tokens?: TokenSet;
}

/** A sign-in waiting for the browser. */
interface Pending {
  authorizationUrl: string;
  listener: LoopbackListener;
  startedAt: number;
}

/** What the session panel shows (decision 12). No token value is ever in it. */
export interface AuthReport {
  /** Whether the server has an OAuth client of its own configured. */
  preRegistered: boolean;
  /** Where sign-ins are kept: the workspace database, or memory for this session. */
  storage: 'workspace' | 'session';
  signedIn: boolean;
  issuer?: string;
  authorizationServer?: string;
  resource?: string;
  endpoints?: { authorization?: string; token?: string; registration?: string };
  registration?: { kind: ClientInfo['source']; clientId: string; redirectUri: string };
  scope?: string;
  expiresAt?: number;
  /** When the tokens held were obtained: a sign-in or refresh newer than a failed connect. */
  obtainedAt?: number;
  hasRefreshToken?: boolean;
  warnings: string[];
  /** A sign-in waiting for the browser. */
  pending?: { authorizationUrl: string; startedAt: number };
  /** Why the last sign-in or refresh stopped, until the next one starts. */
  lastFailure?: { failure: AuthFailure; message: string; at: number };
}

export interface AuthHost {
  /**
   * Records a sign-in's or a refresh's traffic: on the live session when
   * there is one, else as a connection of its own. `close` ends the latter.
   */
  record(serverId: string, own?: boolean): { emit: UnitListener; close(): void };
  changed(serverId: string): void;
}

export class AuthManager {
  /** Grants for an unencrypted workspace, which cannot store them (D31). */
  private readonly sessionGrants = new Map<string, Grant>();
  private readonly pending = new Map<string, Pending>();
  private readonly failures = new Map<string, AuthReport['lastFailure']>();
  private readonly now: () => number;

  constructor(private readonly ws: Workspace, private readonly host: AuthHost, now?: () => number) {
    this.now = now ?? Date.now;
  }

  /** The access token a connect or a request sends, read before every request. */
  accessToken(serverId: string): string | undefined {
    return this.grant(serverId)?.tokens?.accessToken;
  }

  report(serverId: string): AuthReport {
    const def = this.server(serverId);
    const g = this.grant(serverId);
    const p = this.pending.get(serverId);
    const f = this.failures.get(serverId);
    const m = g?.info.metadata;
    const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
    return {
      preRegistered: def.oauthClient !== undefined,
      storage: this.ws.encrypted ? 'workspace' : 'session',
      signedIn: Boolean(g?.tokens),
      warnings: g?.info.warnings ?? [],
      ...(g ? {
        issuer: g.info.issuer,
        authorizationServer: g.info.authorizationServerUrl,
        ...(g.info.resource ? { resource: g.info.resource } : {}),
        endpoints: { authorization: str(m?.authorization_endpoint), token: str(m?.token_endpoint), registration: str(m?.registration_endpoint) },
        registration: { kind: g.client.source, clientId: g.client.clientId, redirectUri: g.client.redirectUri },
      } : {}),
      ...(g?.tokens ? {
        ...(g.tokens.scope ? { scope: g.tokens.scope } : {}),
        ...(g.tokens.expiresAt !== undefined ? { expiresAt: g.tokens.expiresAt } : {}),
        ...(typeof g.tokens.obtainedAt === 'number' ? { obtainedAt: g.tokens.obtainedAt } : {}),
        hasRefreshToken: Boolean(g.tokens.refreshToken),
      } : {}),
      ...(p ? { pending: { authorizationUrl: p.authorizationUrl, startedAt: p.startedAt } } : {}),
      ...(f ? { lastFailure: f } : {}),
    };
  }

  /**
   * The user pressed Sign in: discovery, the client, the authorization URL.
   * Resolves with the URL for the page to show; the code is exchanged when
   * the browser comes back to the listener. `challenge` is the 401 or 403 that
   * led here; `scope` overrides the scopes asked for (a step-up); `reregister`
   * drops the stored registration first (a busy port, a changed server).
   */
  async signIn(serverId: string, opts: { challenge?: AuthChallenge; scope?: string; reregister?: boolean } = {}): Promise<{ authorizationUrl: string }> {
    const def = this.server(serverId);
    if (!def.url || def.transport === 'stdio') throw new Error(`server ${serverId} is not an HTTP server`);
    await this.cancel(serverId);
    this.failures.delete(serverId);
    const rec = this.host.record(serverId, true);
    const fetchFn = loggingFetch(rec.emit, [], fetch, true);
    let listener: LoopbackListener | undefined;
    try {
      appEvent(rec.emit, { event: 'sign-in-started', ...(opts.scope ? { scope: opts.scope } : {}), ...(opts.reregister ? { reregister: true } : {}) });
      const info = await discoverAuth(def.url, { challenge: opts.challenge, protocolVersion: readDetectedEra(this.ws, serverId)?.revision ?? LATEST_REVISION, fetchFn });
      appEvent(rec.emit, { event: 'auth-discovered', issuer: info.issuer, authorizationServer: info.authorizationServerUrl, ...(info.resource ? { resource: info.resource } : {}), warnings: info.warnings });
      if (opts.reregister) this.dropRegistration(serverId, info.issuer);

      // Decision 6: the user's own client first, then a registration kept for
      // this issuer, then dynamic registration on a port the OS picks.
      let client: ClientInfo | undefined;
      if (def.oauthClient) {
        client = { clientId: def.oauthClient.clientId, redirectUri: def.oauthClient.redirectUri, source: 'pre-registered', ...(def.oauthClient.clientSecret ? { clientSecret: def.oauthClient.clientSecret } : {}) };
      } else {
        const kept = this.grantFor(serverId, info.issuer);
        if (kept?.client.source === 'dynamic') client = kept.client;
      }
      listener = client ? await LoopbackListener.forRedirect(client.redirectUri) : await LoopbackListener.open();
      const scope = opts.scope ?? info.defaultScope;
      if (!client) {
        client = await registerDynamically(info, { redirectUri: listener.redirectUri, ...(scope ? { scope } : {}), fetchFn });
        appEvent(rec.emit, { event: 'client-registered', clientId: client.clientId, redirectUri: client.redirectUri });
        // Kept at once, without tokens: the port it names is now this server's.
        this.store(serverId, { info, client });
      }
      const request = await authorizationRequest(info, client, scope);
      appEvent(rec.emit, { event: 'authorization-url', url: request.url });
      const pending: Pending = { authorizationUrl: request.url, listener, startedAt: this.now() };
      this.pending.set(serverId, pending);
      this.host.changed(serverId);
      const done = this.finish(serverId, pending, info, client, request, fetchFn, rec);
      void done;
      listener = undefined;
      return { authorizationUrl: request.url };
    } catch (e) {
      await listener?.close();
      this.fail(serverId, e, rec.emit);
      rec.close();
      this.host.changed(serverId);
      throw e;
    }
  }

  /** The browser came back, or the wait ended: check, exchange, store. */
  private async finish(serverId: string, pending: Pending, info: AuthServerInfo, client: ClientInfo, request: Awaited<ReturnType<typeof authorizationRequest>>, fetchFn: typeof fetch, rec: { emit: UnitListener; close(): void }): Promise<void> {
    try {
      const cb = await pending.listener.wait(CALLBACK_TIMEOUT_MS);
      appEvent(rec.emit, { event: 'authorization-callback', url: cb.loggedUrl });
      const { code, iss } = await checkCallback(info, request, cb.params);
      const tokens = await exchangeCode(info, client, { code, ...(iss ? { iss } : {}), codeVerifier: request.codeVerifier, fetchFn, now: this.now });
      this.store(serverId, { info, client, tokens });
      appEvent(rec.emit, { event: 'signed-in', issuer: info.issuer, ...(tokens.scope ? { scope: tokens.scope } : {}), ...(tokens.expiresAt !== undefined ? { expiresAt: tokens.expiresAt } : {}), refreshToken: Boolean(tokens.refreshToken) });
    } catch (e) {
      this.fail(serverId, e, rec.emit);
    } finally {
      await pending.listener.close();
      if (this.pending.get(serverId) === pending) this.pending.delete(serverId);
      rec.close();
      this.host.changed(serverId);
    }
  }

  /** The user pressed Cancel on a sign-in waiting for the browser. */
  async cancel(serverId: string): Promise<void> {
    const p = this.pending.get(serverId);
    if (!p) return;
    this.pending.delete(serverId);
    p.listener.cancel();
    await p.listener.close();
  }

  /** Sign out: the tokens go; with `registrations`, the app's registrations too. */
  async signOut(serverId: string, registrations = false): Promise<void> {
    await this.cancel(serverId);
    this.failures.delete(serverId);
    if (this.ws.encrypted) forgetGrants(this.ws, serverId, registrations);
    if (registrations) this.sessionGrants.delete(serverId);
    else {
      const g = this.sessionGrants.get(serverId);
      if (g) this.sessionGrants.set(serverId, { info: g.info, client: g.client });
    }
    this.host.changed(serverId);
  }

  /**
   * Inside a Connect the user pressed (decision 2): refreshes a token that
   * has expired or is about to, when a refresh token is held. A refused
   * refresh forgets the tokens and throws, so the Connect says "sign in
   * again" rather than sending a token that cannot work.
   */
  async refreshIfDue(serverId: string, emit: UnitListener): Promise<void> {
    const g = this.grant(serverId);
    if (!g?.tokens?.refreshToken || g.tokens.expiresAt === undefined) return;
    if (g.tokens.expiresAt - EXPIRY_MARGIN_MS > this.now()) return;
    await this.doRefresh(serverId, g, emit);
  }

  /** "Refresh and retry" (decision 2): one refresh, now, recorded on the live session when there is one. */
  async refresh(serverId: string): Promise<void> {
    const g = this.grant(serverId);
    if (!g?.tokens?.refreshToken) throw new Error('there is no refresh token to use; sign in again');
    const rec = this.host.record(serverId);
    try {
      await this.doRefresh(serverId, g, rec.emit);
    } finally {
      rec.close();
    }
  }

  private async doRefresh(serverId: string, g: Grant, emit: UnitListener): Promise<void> {
    appEvent(emit, { event: 'token-refresh', issuer: g.info.issuer });
    try {
      const tokens = await refreshTokens(g.info, g.client, g.tokens!.refreshToken!, { fetchFn: loggingFetch(emit, [], fetch, true), now: this.now });
      this.store(serverId, { ...g, tokens });
      this.failures.delete(serverId);
    } catch (e) {
      if (e instanceof AuthError && e.failure.kind === 'refresh-refused') this.store(serverId, { info: g.info, client: g.client });
      this.fail(serverId, e, emit);
      throw e;
    } finally {
      this.host.changed(serverId);
    }
  }

  /** Everything this manager holds for a server, as when the server is deleted. */
  async forget(serverId: string): Promise<void> {
    await this.cancel(serverId);
    this.sessionGrants.delete(serverId);
    this.failures.delete(serverId);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.pending.keys()].map((id) => this.cancel(id)));
  }

  private fail(serverId: string, e: unknown, emit: UnitListener): void {
    const failure: AuthFailure = e instanceof AuthError ? e.failure : { kind: 'no-authorization-server', detail: e instanceof Error ? e.message : String(e) };
    const message = e instanceof Error ? e.message : String(e);
    this.failures.set(serverId, { failure, message, at: this.now() });
    appEvent(emit, { event: 'auth-failed', failure: failure.kind, message });
  }

  private grant(serverId: string): Grant | undefined {
    if (!this.ws.encrypted) return this.sessionGrants.get(serverId);
    const stored = loadGrant(this.ws, serverId);
    return stored ? fromStored(stored) : undefined;
  }

  private grantFor(serverId: string, issuer: string): Grant | undefined {
    if (!this.ws.encrypted) {
      const g = this.sessionGrants.get(serverId);
      return g?.info.issuer === issuer ? g : undefined;
    }
    const stored = loadGrantFor(this.ws, serverId, issuer);
    return stored ? fromStored(stored) : undefined;
  }

  private dropRegistration(serverId: string, issuer: string): void {
    if (!this.ws.encrypted) {
      if (this.sessionGrants.get(serverId)?.info.issuer === issuer) this.sessionGrants.delete(serverId);
      return;
    }
    dropGrant(this.ws, serverId, issuer);
  }

  private store(serverId: string, g: Grant): void {
    if (!this.ws.encrypted) {
      this.sessionGrants.set(serverId, g);
      return;
    }
    saveGrant(this.ws, serverId, {
      issuer: g.info.issuer, authServer: g.info.authorizationServerUrl,
      ...(g.info.resource ? { resource: g.info.resource } : {}),
      client: { client: g.client, info: g.info },
      ...(g.tokens ? { tokens: g.tokens as unknown as Record<string, unknown> } : {}),
    }, this.now);
  }

  private server(serverId: string) {
    const def = loadServer(this.ws, serverId);
    if (!def) throw new Error(`no server ${serverId} in this workspace`);
    return def;
  }
}

function fromStored(s: { client: Record<string, unknown>; tokens?: Record<string, unknown> }): Grant {
  const kept = s.client as unknown as { client: ClientInfo; info: AuthServerInfo };
  return { client: kept.client, info: kept.info, ...(s.tokens ? { tokens: s.tokens as unknown as TokenSet } : {}) };
}

function appEvent(emit: UnitListener, event: Record<string, unknown>): void {
  emit({ direction: 'local', kind: 'app', bytes: Buffer.from(JSON.stringify(event), 'utf8') });
}
