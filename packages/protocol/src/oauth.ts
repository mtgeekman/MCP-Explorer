// OAuth 2.1 for remote servers (plan phase 11), one step at a time. The SDK's
// auth() and its OAuthClientProvider discover, register, refresh and retry on
// their own, which P2 forbids (decision 4), so each step here calls one SDK
// helper and nothing else. Every request goes through the fetch the caller
// passes: the redacting logging fetch, never one carrying the MCP server's
// own configured headers.
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import type { AuthChallenge } from './client.js';
import { redactUrl } from './redact.js';

/** Why a sign-in or a refresh stopped, by the step that stopped it (decision 10). */
export type AuthFailure =
  /** No authorization server could be found or reached. */
  | { kind: 'no-authorization-server'; detail: string }
  /** Metadata was found and refused: its issuer did not match, or it does not offer PKCE S256. */
  | { kind: 'metadata-refused'; detail: string }
  /** No way to identify the app to this authorization server. */
  | { kind: 'no-registration'; detail: string }
  /** The registration endpoint refused the registration. */
  | { kind: 'registration-refused'; status?: number; error?: string; description?: string }
  /** The authorization server answered the browser with an error. */
  | { kind: 'authorization-denied'; error: string; description?: string }
  /** The callback's state was not the one sent: it is not the answer to this sign-in. */
  | { kind: 'state-mismatch' }
  /** The callback's iss did not name the authorization server the request went to (RFC 9207). */
  | { kind: 'issuer-mismatch'; expected?: string }
  /** The token endpoint refused the code. */
  | { kind: 'exchange-refused'; error?: string; description?: string }
  /** The token endpoint refused the refresh token: sign in again. */
  | { kind: 'refresh-refused'; error?: string; description?: string }
  /** No callback came in time, or the user cancelled. */
  | { kind: 'callback-ended'; reason: 'timeout' | 'cancelled' }
  /** The redirect URI's port is taken by something else. */
  | { kind: 'port-busy'; port: number };

export class AuthError extends Error {
  constructor(readonly failure: AuthFailure, message?: string, options?: { cause?: unknown }) {
    super(message ?? failureMessage(failure), options);
    this.name = 'AuthError';
  }
}

export function failureMessage(f: AuthFailure): string {
  switch (f.kind) {
    case 'no-authorization-server': return `No authorization server was found: ${f.detail}`;
    case 'metadata-refused': return `The authorization server's metadata was refused: ${f.detail}`;
    case 'no-registration': return `The app cannot identify itself to this authorization server: ${f.detail}`;
    case 'registration-refused': return `The authorization server refused to register the app${f.error ? ` (${f.error})` : ''}${f.description ? `: ${f.description}` : ''}`;
    case 'authorization-denied': return `The authorization server answered ${f.error}${f.description ? `: ${f.description}` : ''}`;
    case 'state-mismatch': return 'The browser came back with a state this sign-in did not send, so its answer was ignored';
    case 'issuer-mismatch': return 'The browser came back naming a different authorization server than the one asked, so its answer was ignored';
    case 'exchange-refused': return `The token endpoint refused the authorization code${f.error ? ` (${f.error})` : ''}${f.description ? `: ${f.description}` : ''}`;
    case 'refresh-refused': return `The authorization server refused the refresh token${f.error ? ` (${f.error})` : ''}${f.description ? `: ${f.description}` : ''}. Sign in again`;
    case 'callback-ended': return f.reason === 'timeout' ? 'No answer came back from the browser in time' : 'The sign-in was cancelled';
    case 'port-busy': return `Port ${f.port} on 127.0.0.1, which this registration's redirect URI names, is in use`;
  }
}

/** What discovery found (decision 9). Metadata documents are kept as the server sent them. */
export interface AuthServerInfo {
  /** The authorization server's URL: from protected resource metadata, else the MCP server's origin. */
  authorizationServerUrl: string;
  /** Where protected resource metadata was read from, when it was. */
  resourceMetadataUrl?: string;
  resourceMetadata?: Record<string, unknown>;
  /** RFC 8414 or OpenID metadata; absent means the 2025-03-26 fallback endpoints. */
  metadata?: Record<string, unknown>;
  /** The RFC 8707 resource to name; only when protected resource metadata exists. */
  resource?: string;
  /** The issuer registrations are kept under: the metadata's, else the server's URL. */
  issuer: string;
  /** Scopes to ask for when nothing else says: the challenge's, else the resource metadata's. */
  defaultScope?: string;
  /** What the explorer accepted that a strict client would refuse, in words. */
  warnings: string[];
}

/** A client as registered or as the user entered it. */
export interface ClientInfo {
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  /** How the client came to exist. */
  source: 'dynamic' | 'pre-registered';
  /** The whole registration response, when there was one; client_secret and the registration token included. */
  registration?: Record<string, unknown>;
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  scope?: string;
  /** Epoch ms, when the server said how long the token lives. */
  expiresAt?: number;
  /** Epoch ms, when the token endpoint answered. */
  obtainedAt: number;
}

type Fetch = typeof fetch;
const sdk = () => import('@modelcontextprotocol/client') as Promise<any>;
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Finds the authorization server for an MCP server: protected resource
 * metadata (from the challenge, else the path-inserted then the root
 * well-known URL), then RFC 8414 or OpenID metadata. Permissive where the
 * revisions differ, with each concession written down as a warning.
 */
export async function discoverAuth(serverUrl: string, opts: { challenge?: AuthChallenge; protocolVersion: string; fetchFn: Fetch }): Promise<AuthServerInfo> {
  const mod = await sdk();
  const warnings: string[] = [];
  let resourceMetadata: Record<string, unknown> | undefined;
  try {
    resourceMetadata = await mod.discoverOAuthProtectedResourceMetadata(serverUrl, { protocolVersion: opts.protocolVersion, resourceMetadataUrl: opts.challenge?.resourceMetadataUrl }, opts.fetchFn);
  } catch (e) {
    // A 2025-03-26 server has none; anything else is worth saying.
    if (!/does not implement/.test(messageOf(e))) warnings.push(`Protected resource metadata could not be read (${messageOf(e)}); the server's origin is used as the authorization server.`);
  }

  const servers = resourceMetadata?.authorization_servers;
  const authorizationServerUrl = Array.isArray(servers) && typeof servers[0] === 'string' ? servers[0] : new URL(serverUrl).origin;
  if (Array.isArray(servers) && servers.length > 1) warnings.push(`The resource names ${servers.length} authorization servers; the first is used.`);

  let resource: string | undefined;
  if (resourceMetadata) {
    const named = typeof resourceMetadata.resource === 'string' ? resourceMetadata.resource : undefined;
    if (named && !mod.checkResourceAllowed({ requestedResource: mod.resourceUrlFromServerUrl(serverUrl), configuredResource: named })) {
      throw new AuthError({ kind: 'metadata-refused', detail: `the protected resource metadata is for ${named}, not ${serverUrl}` });
    }
    // URL.href adds a slash to a bare origin; the canonical resource URI has
    // none (2025-06-18), and an authorization server may compare exactly.
    const url: URL = mod.resourceUrlFromServerUrl(named ?? serverUrl);
    resource = url.pathname === '/' && !url.search && !(named ?? serverUrl).endsWith('/') ? url.href.slice(0, -1) : url.href;
  }

  let metadata: Record<string, unknown> | undefined;
  try {
    metadata = await mod.discoverAuthorizationServerMetadata(authorizationServerUrl, { fetchFn: opts.fetchFn, protocolVersion: opts.protocolVersion });
  } catch (e) {
    const name = (e as { name?: string }).name;
    if (name === 'IssuerMismatchError' || (e as { kind?: string }).kind === 'metadata') {
      throw new AuthError({ kind: 'metadata-refused', detail: `its issuer does not match ${authorizationServerUrl}` }, undefined, { cause: e });
    }
    const issues = (e as { issues?: { path?: unknown[]; message?: string }[] }).issues;
    if (Array.isArray(issues)) {
      const fields = issues.map((i) => `${(i.path ?? []).join('.') || '(document)'}: ${i.message ?? 'invalid'}`).join('; ');
      throw new AuthError({ kind: 'metadata-refused', detail: `the metadata at ${authorizationServerUrl} is malformed (${fields})` }, undefined, { cause: e });
    }
    throw new AuthError({ kind: 'no-authorization-server', detail: `${authorizationServerUrl}: ${messageOf(e)}` }, undefined, { cause: e });
  }
  if (!metadata) {
    warnings.push(`No authorization server metadata at ${authorizationServerUrl}; the 2025-03-26 default endpoints /authorize, /token and /register are used.`);
  } else {
    const methods = metadata.code_challenge_methods_supported;
    if (methods === undefined) warnings.push('The metadata does not list code_challenge_methods_supported. From 2025-11-25 a client must refuse it; the explorer goes on with S256.');
    else if (!Array.isArray(methods) || !methods.includes('S256')) throw new AuthError({ kind: 'metadata-refused', detail: 'it does not offer PKCE S256' });
    if (metadata.client_id_metadata_document_supported === true && !metadata.registration_endpoint) {
      warnings.push('This server offers client ID metadata documents, which the app cannot use: it has no HTTPS URL to publish one at.');
    }
  }

  const supported = resourceMetadata?.scopes_supported;
  const defaultScope = opts.challenge?.scope ?? (Array.isArray(supported) && supported.length > 0 ? supported.join(' ') : undefined);
  const issuer = typeof metadata?.issuer === 'string' ? metadata.issuer : authorizationServerUrl;
  return {
    authorizationServerUrl, issuer, warnings,
    ...(resourceMetadata ? { resourceMetadata, resourceMetadataUrl: opts.challenge?.resourceMetadataUrl ?? undefined } : {}),
    ...(metadata ? { metadata } : {}),
    ...(resource ? { resource } : {}),
    ...(defaultScope ? { defaultScope } : {}),
  };
}

/** Registers the app by RFC 7591 (decision 6). Deprecated in 2026-07-28, and still the only route a desktop app has. */
export async function registerDynamically(info: AuthServerInfo, opts: { redirectUri: string; scope?: string; clientName?: string; fetchFn: Fetch }): Promise<ClientInfo> {
  const mod = await sdk();
  if (info.metadata && !info.metadata.registration_endpoint) {
    throw new AuthError({ kind: 'no-registration', detail: 'it has no registration endpoint; enter a client id registered with it in the server\'s settings' });
  }
  const clientMetadata = {
    client_name: opts.clientName ?? 'MCP Explorer',
    redirect_uris: [opts.redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    application_type: 'native',
  };
  let full: Record<string, unknown>;
  try {
    full = await mod.registerClient(info.authorizationServerUrl, { metadata: info.metadata, clientMetadata, scope: opts.scope, fetchFn: opts.fetchFn });
  } catch (e) {
    const x = e as { name?: string; status?: number; body?: string };
    let parsed: { error?: string; error_description?: string } = {};
    try { parsed = JSON.parse(x.body ?? '{}'); } catch { /* the body is shown in the log */ }
    if (x.name === 'RegistrationRejectedError' || typeof x.status === 'number') {
      throw new AuthError({ kind: 'registration-refused', status: x.status, error: parsed.error, description: parsed.error_description }, undefined, { cause: e });
    }
    const code = (e as { code?: string }).code;
    throw new AuthError({ kind: 'registration-refused', ...(code ? { error: code } : {}), description: messageOf(e) }, undefined, { cause: e });
  }
  return {
    clientId: String(full.client_id),
    ...(typeof full.client_secret === 'string' ? { clientSecret: full.client_secret } : {}),
    redirectUri: opts.redirectUri,
    source: 'dynamic',
    registration: full,
  };
}

const sdkClient = (c: ClientInfo) => ({
  client_id: c.clientId,
  ...(c.clientSecret ? { client_secret: c.clientSecret } : {}),
  redirect_uris: [c.redirectUri],
  ...(c.registration?.token_endpoint_auth_method ? { token_endpoint_auth_method: c.registration.token_endpoint_auth_method } : {}),
});

/** An authorization request ready for the browser: PKCE S256, a fresh state, the resource (decision 5). */
export interface AuthorizationRequest {
  url: string;
  state: string;
  codeVerifier: string;
  scope?: string;
}

export async function authorizationRequest(info: AuthServerInfo, client: ClientInfo, scope?: string): Promise<AuthorizationRequest> {
  const mod = await sdk();
  const state = randomBytes(24).toString('base64url');
  const { authorizationUrl, codeVerifier } = await mod.startAuthorization(info.authorizationServerUrl, {
    metadata: info.metadata, clientInformation: sdkClient(client), redirectUrl: client.redirectUri, state,
    ...(scope ? { scope } : {}),
    ...(info.resource ? { resource: new URL(info.resource) } : {}),
  });
  return { url: String(authorizationUrl), state, codeVerifier, ...(scope ? { scope } : {}) };
}

/** What the browser brought back to the loopback listener. */
export interface Callback {
  params: URLSearchParams;
  /** The callback URL with its code redacted, for the log. */
  loggedUrl: string;
}

/**
 * Checks a callback against the request it answers (decision 5): the state
 * first, then the issuer (RFC 9207), then any error. On a mismatch nothing the
 * callback said is shown, as 2026-07-28 requires of a mix-up.
 */
export async function checkCallback(info: AuthServerInfo, request: AuthorizationRequest, cb: URLSearchParams): Promise<{ code: string; iss?: string }> {
  if (cb.get('state') !== request.state) throw new AuthError({ kind: 'state-mismatch' });
  const iss = cb.get('iss') ?? undefined;
  const mod = await sdk();
  try {
    mod.validateAuthorizationResponseIssuer({ iss, expectedIssuer: typeof info.metadata?.issuer === 'string' ? info.metadata.issuer : undefined, issParameterSupported: info.metadata?.authorization_response_iss_parameter_supported === true });
  } catch (e) {
    throw new AuthError({ kind: 'issuer-mismatch', ...(typeof info.metadata?.issuer === 'string' ? { expected: info.metadata.issuer } : {}) }, undefined, { cause: e });
  }
  const error = cb.get('error');
  if (error) throw new AuthError({ kind: 'authorization-denied', error, ...(cb.get('error_description') ? { description: cb.get('error_description')! } : {}) });
  const code = cb.get('code');
  if (!code) throw new AuthError({ kind: 'authorization-denied', error: 'no_code', description: 'The callback carried neither a code nor an error' });
  return { code, ...(iss ? { iss } : {}) };
}

function tokenSet(t: Record<string, unknown>, now: number): TokenSet {
  const expiresIn = typeof t.expires_in === 'number' ? t.expires_in : undefined;
  return {
    accessToken: String(t.access_token),
    tokenType: typeof t.token_type === 'string' ? t.token_type : 'Bearer',
    ...(typeof t.refresh_token === 'string' ? { refreshToken: t.refresh_token } : {}),
    ...(typeof t.scope === 'string' ? { scope: t.scope } : {}),
    ...(expiresIn !== undefined ? { expiresAt: now + expiresIn * 1000 } : {}),
    obtainedAt: now,
  };
}

function oauthFailure(e: unknown): { error?: string; description?: string } {
  const code = (e as { code?: unknown }).code;
  return { ...(typeof code === 'string' ? { error: code } : {}), description: messageOf(e) };
}

export async function exchangeCode(info: AuthServerInfo, client: ClientInfo, opts: { code: string; iss?: string; codeVerifier: string; fetchFn: Fetch; now?: () => number }): Promise<TokenSet> {
  const mod = await sdk();
  try {
    const t = await mod.exchangeAuthorization(info.authorizationServerUrl, {
      metadata: info.metadata, clientInformation: sdkClient(client), authorizationCode: opts.code, codeVerifier: opts.codeVerifier,
      redirectUri: client.redirectUri, fetchFn: opts.fetchFn,
      ...(opts.iss ? { iss: opts.iss } : {}),
      ...(info.resource ? { resource: new URL(info.resource) } : {}),
    });
    return tokenSet(t, (opts.now ?? Date.now)());
  } catch (e) {
    throw new AuthError({ kind: 'exchange-refused', ...oauthFailure(e) }, undefined, { cause: e });
  }
}

/** One refresh, only ever inside a user's action (decision 2). A new refresh token replaces the old; none keeps it. */
export async function refreshTokens(info: AuthServerInfo, client: ClientInfo, refreshToken: string, opts: { fetchFn: Fetch; now?: () => number }): Promise<TokenSet> {
  const mod = await sdk();
  try {
    const t = await mod.refreshAuthorization(info.authorizationServerUrl, {
      metadata: info.metadata, clientInformation: sdkClient(client), refreshToken, fetchFn: opts.fetchFn,
      ...(info.resource ? { resource: new URL(info.resource) } : {}),
    });
    return tokenSet({ refresh_token: refreshToken, ...t }, (opts.now ?? Date.now)());
  } catch (e) {
    throw new AuthError({ kind: 'refresh-refused', ...oauthFailure(e) }, undefined, { cause: e });
  }
}

/** The scopes to ask for on a step-up: the union of what was granted and what the challenge names (2026-07-28). */
export async function stepUpScope(granted: string | undefined, challenged: string | undefined): Promise<string | undefined> {
  return (await sdk()).computeScopeUnion(granted, challenged);
}

/**
 * The loopback redirect (decision 8): a listener for one sign-in, on the
 * host and at the path its redirect URI names. The app's own registrations
 * use http://127.0.0.1:<port>/callback, port 0 letting the OS pick; a
 * registration's stored port, or a pre-registered client's redirect URI, is
 * asked for again exactly, and a busy port is a named failure, never a
 * different port.
 */
export class LoopbackListener {
  private servers: Server[] = [];
  private waiting?: { resolve: (cb: Callback) => void; reject: (e: unknown) => void; timer: NodeJS.Timeout };
  port = 0;
  private uri?: string;

  private constructor(private readonly path: string) {}

  static async open(port = 0): Promise<LoopbackListener> {
    const l = new LoopbackListener('/callback');
    await l.listen(['127.0.0.1'], port);
    return l;
  }

  /**
   * Listens where a redirect URI points: 127.0.0.1, [::1], or both for
   * localhost, since a browser may resolve it to either (RFC 8252 §8.3).
   */
  static async forRedirect(redirectUri: string): Promise<LoopbackListener> {
    const u = new URL(redirectUri);
    // URL.port is '' for no port and for :80 alike; either would bind a port
    // the OS picks, not the one the authorization server redirects to (R11-12).
    if (u.port === '') throw new Error(`the redirect URI ${redirectUri} names no port other than 80; a loopback redirect needs one`);
    const hosts = u.hostname === '[::1]' ? ['::1'] : u.hostname === 'localhost' ? ['127.0.0.1', '::1'] : [u.hostname];
    const l = new LoopbackListener(u.pathname);
    l.uri = redirectUri;
    await l.listen(hosts, Number(u.port));
    return l;
  }

  get redirectUri(): string {
    return this.uri ?? `http://127.0.0.1:${this.port}${this.path}`;
  }

  private async listen(hosts: string[], port: number): Promise<void> {
    try {
      for (const host of hosts) {
        try {
          await this.listenOn(host, port);
        } catch (e) {
          // localhost also listens on ::1 in case the browser resolves it
          // there; a machine without IPv6 has no ::1 for either side.
          const code = (e as NodeJS.ErrnoException).code;
          if (hosts.length > 1 && host === '::1' && (code === 'EADDRNOTAVAIL' || code === 'EAFNOSUPPORT')) continue;
          throw e;
        }
      }
    } catch (e) {
      await this.close();
      throw e;
    }
  }

  private listenOn(host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
        if (req.method !== 'GET' || url.pathname !== this.path || !this.waiting) {
          res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
          return res.end('Not found');
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end('<!doctype html><title>MCP Explorer</title><p>The sign-in answer reached MCP Explorer. You can close this tab.</p>');
        const w = this.waiting;
        this.waiting = undefined;
        clearTimeout(w.timer);
        w.resolve({ params: url.searchParams, loggedUrl: redactUrl(url.href).url });
      });
      server.once('error', (e: NodeJS.ErrnoException) => reject(e.code === 'EADDRINUSE' ? new AuthError({ kind: 'port-busy', port }) : e));
      server.listen(port, host, () => {
        this.servers.push(server);
        this.port = (server.address() as AddressInfo).port;
        resolve();
      });
    });
  }

  /** Resolves with the first callback; rejects on timeout or cancel. */
  wait(timeoutMs: number): Promise<Callback> {
    if (this.waiting) throw new Error('this listener is already waiting');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting = undefined;
        reject(new AuthError({ kind: 'callback-ended', reason: 'timeout' }));
      }, timeoutMs);
      this.waiting = { resolve, reject, timer };
    });
  }

  cancel(): void {
    const w = this.waiting;
    this.waiting = undefined;
    if (w) {
      clearTimeout(w.timer);
      w.reject(new AuthError({ kind: 'callback-ended', reason: 'cancelled' }));
    }
  }

  async close(): Promise<void> {
    this.cancel();
    const all = this.servers;
    this.servers = [];
    await Promise.all(all.map((s) => new Promise<void>((r) => s.close(() => r()))));
  }
}
