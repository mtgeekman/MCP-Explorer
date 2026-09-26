// The fixture authorization server (plan phase 11 decision 13), served from
// the HTTP fixture's own process under AUTH=1, which then protects its MCP
// endpoint with the tokens issued here. Plain node:http: the SDK's 2.0 server
// packages ship only the resource-server half.
//
// Authorization is approved at once: GET /authorize answers 302 to the
// redirect URI with a code, so a test follows the redirect itself and no
// browser opens.
//
// Modes (environment):
//   AUTH_PRM          where protected resource metadata is (RFC 9728):
//                     header (default; path-inserted, and named in the 401's
//                     resource_metadata), path (path-inserted, not named),
//                     root (at the origin's well-known URL only), none (a
//                     2025-03-26 server: the origin is the authorization server)
//   AUTH_AS_META      oauth (default; RFC 8414), oidc (OpenID discovery only),
//                     none (no metadata: /authorize, /token and /register at
//                     the origin, the 2025-03-26 fallback)
//   AUTH_ISSUER_PATH  a path issuer, such as /tenant; endpoints live under it
//   AUTH_ISS          on: advertise and send iss (RFC 9207); wrong: send
//                     another issuer; missing: advertise, then leave it out
//   AUTH_NO_DCR       no registration endpoint; only AUTH_CLIENT_ID (with
//                     AUTH_CLIENT_SECRET, if set, and AUTH_REDIRECT) exists
//   AUTH_TOKEN_TTL    access-token lifetime in seconds (default 3600)
//   AUTH_REFRESH      refuse: every refresh answers invalid_grant
//   AUTH_DENY         the authorization endpoint answers access_denied
//   AUTH_PKCE_META    none: the metadata omits code_challenge_methods_supported;
//                     plain: it lists plain only
//   AUTH_SCOPE_TOOL   a tool whose call needs scope `admin`: without it the
//                     MCP endpoint answers 403 insufficient_scope
//   AUTH_LOG          append each authorization-server request as one JSON line
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync } from 'node:fs';

const env = process.env;
const issuerPath = env.AUTH_ISSUER_PATH ?? '';
const prmMode = env.AUTH_PRM ?? 'header';
const metaMode = env.AUTH_AS_META ?? 'oauth';
const ttl = Number(env.AUTH_TOKEN_TTL ?? 3600);
const SCOPES = ['mcp', 'admin'];

const clients = new Map();
const codes = new Map();
const accessTokens = new Map();
const refreshTokens = new Map();

if (env.AUTH_CLIENT_ID) {
  clients.set(env.AUTH_CLIENT_ID, {
    client_id: env.AUTH_CLIENT_ID,
    ...(env.AUTH_CLIENT_SECRET ? { client_secret: env.AUTH_CLIENT_SECRET } : {}),
    redirect_uris: env.AUTH_REDIRECT ? [env.AUTH_REDIRECT] : [],
  });
}

const token = () => randomBytes(18).toString('base64url');
const log = (entry) => { if (env.AUTH_LOG) appendFileSync(env.AUTH_LOG, `${JSON.stringify(entry)}\n`); };

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

const oauthError = (res, status, error, description) => json(res, status, { error, ...(description ? { error_description: description } : {}) });

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { b += c; });
    req.on('end', () => resolve(b));
  });
}

/** Everything about the fixture's URLs, from the origin the server listens on. */
export function authUrls(origin, endpoint) {
  const issuer = metaMode === 'none' || prmMode === 'none' ? origin : origin + issuerPath;
  const base = metaMode === 'none' || prmMode === 'none' ? origin : issuer;
  return {
    issuer,
    authorize: `${base}/authorize`,
    token: `${base}/token`,
    register: `${base}/register`,
    resource: origin + endpoint,
    prmPath: `/.well-known/oauth-protected-resource${endpoint}`,
  };
}

function metadata(u) {
  const m = {
    issuer: u.issuer,
    authorization_endpoint: u.authorize,
    token_endpoint: u.token,
    ...(env.AUTH_NO_DCR ? {} : { registration_endpoint: u.register }),
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
    scopes_supported: SCOPES,
  };
  if (env.AUTH_PKCE_META === 'plain') m.code_challenge_methods_supported = ['plain'];
  else if (env.AUTH_PKCE_META !== 'none') m.code_challenge_methods_supported = ['S256'];
  if (env.AUTH_ISS) m.authorization_response_iss_parameter_supported = true;
  // OpenID Provider Metadata requires these three.
  if (metaMode === 'oidc') Object.assign(m, { jwks_uri: `${u.issuer}/jwks`, subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'] });
  return m;
}

/** The client's credentials from the token request: HTTP Basic or the body. */
function clientOf(req, params) {
  const basic = /^Basic (.+)$/i.exec(req.headers.authorization ?? '');
  if (basic) {
    const [id, secret] = Buffer.from(basic[1], 'base64').toString('utf8').split(':').map(decodeURIComponent);
    return { id, secret };
  }
  return { id: params.get('client_id') ?? undefined, secret: params.get('client_secret') ?? undefined };
}

function authenticate(req, params) {
  const { id, secret } = clientOf(req, params);
  const client = id ? clients.get(id) : undefined;
  if (!client) return undefined;
  if (client.client_secret && client.client_secret !== secret) return undefined;
  return client;
}

function issue(clientId, scope, resource) {
  const at = token();
  const rt = token();
  accessTokens.set(at, { clientId, scope, resource, expiresAt: Date.now() + ttl * 1000 });
  refreshTokens.set(rt, { clientId, scope, resource });
  return { access_token: at, token_type: 'Bearer', expires_in: ttl, refresh_token: rt, scope };
}

/**
 * Answers a request aimed at the authorization server, or returns false when
 * the request is not one. `origin` is the fixture's own origin.
 */
export async function handleAuth(req, res, origin, endpoint) {
  const u = authUrls(origin, endpoint);
  const url = new URL(req.url, origin);
  const path = url.pathname;
  const aspath = (p) => new URL(p).pathname;

  if (req.method === 'GET' && prmMode !== 'none') {
    const at = prmMode === 'root' ? '/.well-known/oauth-protected-resource' : u.prmPath;
    if (path === at) {
      log({ endpoint: 'prm', path });
      return json(res, 200, { resource: u.resource, authorization_servers: [u.issuer], scopes_supported: SCOPES, bearer_methods_supported: ['header'] }), true;
    }
  }
  if (req.method === 'GET' && metaMode !== 'none') {
    const suffix = new URL(u.issuer).pathname.replace(/\/$/, '');
    const candidates = metaMode === 'oidc'
      ? [`/.well-known/openid-configuration${suffix}`, `${suffix}/.well-known/openid-configuration`]
      : [`/.well-known/oauth-authorization-server${suffix}`];
    if (candidates.includes(path)) {
      log({ endpoint: 'metadata', path });
      return json(res, 200, metadata(u)), true;
    }
  }

  if (req.method === 'POST' && path === aspath(u.register) && !env.AUTH_NO_DCR) {
    const body = JSON.parse((await readBody(req)) || '{}');
    log({ endpoint: 'register', body });
    if (!Array.isArray(body.redirect_uris) || body.redirect_uris.length === 0) return oauthError(res, 400, 'invalid_redirect_uri', 'redirect_uris is required'), true;
    const client = { ...body, client_id: `client-${token()}`, client_id_issued_at: Math.floor(Date.now() / 1000), token_endpoint_auth_method: body.token_endpoint_auth_method ?? 'none' };
    if (client.token_endpoint_auth_method !== 'none') client.client_secret = token();
    clients.set(client.client_id, client);
    return json(res, 201, client), true;
  }

  if (req.method === 'GET' && path === aspath(u.authorize)) {
    const q = url.searchParams;
    log({ endpoint: 'authorize', query: Object.fromEntries(q) });
    const client = clients.get(q.get('client_id') ?? '');
    const redirect = q.get('redirect_uri') ?? '';
    if (!client || !client.redirect_uris.includes(redirect)) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      return res.end('unknown client or redirect_uri'), true;
    }
    const back = new URL(redirect);
    const state = q.get('state');
    if (state !== null) back.searchParams.set('state', state);
    if (env.AUTH_ISS === 'on' || env.AUTH_ISS === '1') back.searchParams.set('iss', u.issuer);
    if (env.AUTH_ISS === 'wrong') back.searchParams.set('iss', 'https://attacker.example');
    if (env.AUTH_DENY) {
      back.searchParams.set('error', 'access_denied');
      back.searchParams.set('error_description', 'The fixture denies every request');
    } else {
      if (q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) {
        back.searchParams.set('error', 'invalid_request');
        back.searchParams.set('error_description', 'PKCE S256 is required');
      } else {
        const code = token();
        codes.set(code, { clientId: client.client_id, redirect, challenge: q.get('code_challenge'), scope: q.get('scope') ?? 'mcp', resource: q.get('resource') ?? undefined });
        back.searchParams.set('code', code);
      }
    }
    res.writeHead(302, { location: back.href });
    return res.end(), true;
  }

  if (req.method === 'POST' && path === aspath(u.token)) {
    const params = new URLSearchParams(await readBody(req));
    log({ endpoint: 'token', grant_type: params.get('grant_type'), resource: params.get('resource'), scope: params.get('scope'), has_verifier: params.has('code_verifier') });
    const client = authenticate(req, params);
    if (!client) return oauthError(res, 401, 'invalid_client'), true;
    if (params.get('grant_type') === 'authorization_code') {
      const code = codes.get(params.get('code') ?? '');
      codes.delete(params.get('code') ?? '');
      if (!code || code.clientId !== client.client_id || code.redirect !== params.get('redirect_uri')) return oauthError(res, 400, 'invalid_grant', 'unknown code'), true;
      const challenge = createHash('sha256').update(params.get('code_verifier') ?? '').digest('base64url');
      if (challenge !== code.challenge) return oauthError(res, 400, 'invalid_grant', 'PKCE verification failed'), true;
      return json(res, 200, issue(client.client_id, code.scope, code.resource)), true;
    }
    if (params.get('grant_type') === 'refresh_token') {
      const old = refreshTokens.get(params.get('refresh_token') ?? '');
      if (env.AUTH_REFRESH === 'refuse' || !old || old.clientId !== client.client_id) return oauthError(res, 400, 'invalid_grant', 'The refresh token is expired or revoked'), true;
      refreshTokens.delete(params.get('refresh_token'));
      return json(res, 200, issue(client.client_id, old.scope, old.resource)), true;
    }
    return oauthError(res, 400, 'unsupported_grant_type'), true;
  }
  return false;
}

/** The WWW-Authenticate value for a refusal, with the resource metadata named when the mode says to. */
function challenge(origin, endpoint, extra = '') {
  const u = authUrls(origin, endpoint);
  const parts = ['Bearer realm="fixture"'];
  if (prmMode === 'header') parts.push(`resource_metadata="${origin}${u.prmPath}"`);
  if (extra) parts.push(extra);
  return parts.join(', ');
}

/**
 * Checks the bearer token on an MCP request. Answers 401 (or 403 for a tool
 * that needs more scope) and returns false when the request may not go on.
 * `frames` is the parsed request body, when there is one.
 */
export function checkBearer(req, res, origin, endpoint, frames = []) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
  const grant = m ? accessTokens.get(m[1]) : undefined;
  if (!grant || grant.expiresAt <= Date.now()) {
    const expired = grant ? ', error="invalid_token", error_description="The access token expired"' : '';
    res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': challenge(origin, endpoint, `scope="mcp"${expired}`) });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return false;
  }
  const scopeTool = env.AUTH_SCOPE_TOOL;
  const needsAdmin = scopeTool && frames.some((f) => f?.method === 'tools/call' && f?.params?.name === scopeTool);
  if (needsAdmin && !grant.scope.split(' ').includes('admin')) {
    res.writeHead(403, { 'content-type': 'application/json', 'www-authenticate': challenge(origin, endpoint, 'error="insufficient_scope", scope="mcp admin", error_description="This tool needs the admin scope"') });
    res.end(JSON.stringify({ error: 'insufficient_scope' }));
    return false;
  }
  return true;
}
