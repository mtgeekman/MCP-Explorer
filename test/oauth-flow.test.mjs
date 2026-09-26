// Phase 11, the protocol half: the OAuth flow step by step against the
// fixture authorization server, in each of its modes. A test stands in for the
// browser: it follows the authorization server's redirect itself, which lands
// on the loopback listener exactly as a browser would.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  connectHttp, ConnectError, loggingFetch, discoverAuth, registerDynamically, authorizationRequest,
  checkCallback, exchangeCode, refreshTokens, stepUpScope, LoopbackListener, AuthError,
} from '../packages/protocol/dist/index.js';
import { listen } from './support/fixture-servers.mjs';

const work = mkdtempSync(join(tmpdir(), 'mcpx-oauth-'));
const children = [];
after(() => {
  for (const c of children) c.kill();
  rmSync(work, { recursive: true, force: true });
});
let n = 0;
const file = (name) => {
  const p = join(work, `${++n}-${name}`);
  writeFileSync(p, '');
  return p;
};
const lines = (p) => readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const LATEST = '2026-07-28';

/** The browser's part: GET the authorization URL, follow its one redirect to the loopback listener. */
async function browse(url) {
  const r = await fetch(url, { redirect: 'manual' });
  assert.equal(r.status, 302, `the authorization endpoint redirects (got ${r.status}: ${await r.text()})`);
  await (await fetch(r.headers.get('location'))).text();
}

/** A whole sign-in, step by step, as the backend will run it. Returns everything it made. */
async function signIn(url, { challenge, units = [], scope, client: given } = {}) {
  const fetchFn = loggingFetch((u) => units.push(u), [], fetch, true);
  const info = await discoverAuth(url, { challenge, protocolVersion: LATEST, fetchFn });
  const listener = await LoopbackListener.open(given ? new URL(given.redirectUri).port : 0);
  try {
    const client = given ?? await registerDynamically(info, { redirectUri: listener.redirectUri, scope: scope ?? info.defaultScope, fetchFn });
    const request = await authorizationRequest(info, client, scope ?? info.defaultScope);
    const waiting = listener.wait(5000);
    await browse(request.url);
    const cb = await waiting;
    const { code, iss } = await checkCallback(info, request, cb.params);
    const tokens = await exchangeCode(info, client, { code, iss, codeVerifier: request.codeVerifier, fetchFn });
    return { info, client, request, tokens, units, cb, fetchFn };
  } finally {
    await listener.close();
  }
}

/** A connection error's failure, or fails the test when it connects. */
async function refusal(opts) {
  try {
    const c = await connectHttp(opts);
    await c.close();
  } catch (e) {
    assert.ok(e instanceof ConnectError, `a ConnectError, not ${e}`);
    return e.failure;
  }
  assert.fail('connected without a token');
}

test('without a token the connect fails as unauthorized, names the resource metadata, and sends nothing more', async () => {
  const url = await listen('http-server.mjs', children, { AUTH: '1' });
  const units = [];
  const failure = await refusal({ url, onUnit: (u) => units.push(u) });
  assert.equal(failure.kind, 'unauthorized');
  assert.equal(failure.challenge.status, 401);
  assert.equal(failure.challenge.resourceMetadataUrl, `${new URL(url).origin}/.well-known/oauth-protected-resource/mcp`);
  assert.equal(failure.challenge.scope, 'mcp');
  const out = units.filter((u) => u.direction === 'out' && u.kind === 'wire');
  // The probe, then (being unauthorized, not a timeout) nothing: no legacy
  // fallback, no discovery, no retry (P2).
  assert.equal(out.length, 1, `one request went out, not ${out.length}`);
  assert.ok(!units.some((u) => u.http?.url?.includes('.well-known')), 'the connect does no discovery of its own');
});

test('the whole flow: discovery, registration, the browser, the code exchange; then the token connects', async () => {
  const log = file('auth.log');
  const url = await listen('http-server.mjs', children, { AUTH: '1', AUTH_ISS: 'on', AUTH_LOG: log });
  const failure = await refusal({ url });
  const { info, client, request, tokens, units, cb } = await signIn(url, { challenge: failure.challenge });

  assert.equal(info.issuer, new URL(url).origin);
  assert.equal(info.resource, url, 'the resource is the MCP endpoint (RFC 8707)');
  assert.deepEqual(info.warnings, []);
  assert.equal(client.source, 'dynamic');
  assert.match(client.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  const authUrl = new URL(request.url);
  assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authUrl.searchParams.get('resource'), url);
  assert.equal(authUrl.searchParams.get('scope'), 'mcp');
  assert.equal(authUrl.searchParams.get('state'), request.state);
  assert.equal(authUrl.searchParams.get('prompt'), null, 'no offline_access, so no prompt=consent');
  assert.ok(tokens.accessToken && tokens.refreshToken);
  assert.ok(tokens.expiresAt > Date.now());
  assert.ok(!cb.loggedUrl.includes(cb.params.get('code')), 'the callback as logged has no code');

  const reg = lines(log).find((l) => l.endpoint === 'register');
  assert.equal(reg.body.application_type, 'native', 'DCR sends application_type native (2026-07-28)');
  const tok = lines(log).find((l) => l.endpoint === 'token');
  assert.equal(tok.resource, url, 'the token request names the resource');

  // Redaction (decision 1): every token and registration secret is out of the log.
  const logged = units.map((u) => Buffer.from(u.bytes).toString('utf8')).join('\n');
  for (const secret of [tokens.accessToken, tokens.refreshToken, request.codeVerifier, cb.params.get('code')]) {
    assert.ok(!logged.includes(secret), 'a secret value reached the log');
  }
  assert.ok(units.some((u) => u.http?.redacted?.includes('access_token')));

  const conn = await connectHttp({ url, accessToken: () => tokens.accessToken });
  try {
    const out = await conn.call({ kind: 'tool', target: 'add', args: { a: 1, b: 2 } });
    assert.equal(out.kind, 'result');
  } finally {
    await conn.close();
  }
});

test('refresh: a new access token, the refresh token rotated, and the old one refused afterwards', async () => {
  const url = await listen('http-server.mjs', children, { AUTH: '1' });
  const { info, client, tokens, fetchFn } = await signIn(url);
  const next = await refreshTokens(info, client, tokens.refreshToken, { fetchFn });
  assert.notEqual(next.accessToken, tokens.accessToken);
  assert.notEqual(next.refreshToken, tokens.refreshToken);
  await assert.rejects(refreshTokens(info, client, tokens.refreshToken, { fetchFn }), (e) => e instanceof AuthError && e.failure.kind === 'refresh-refused' && e.failure.error === 'invalid_grant');
});

test('a refused refresh is a named failure that says to sign in again', async () => {
  const url = await listen('http-server.mjs', children, { AUTH: '1', AUTH_REFRESH: 'refuse' });
  const { info, client, tokens, fetchFn } = await signIn(url);
  await assert.rejects(refreshTokens(info, client, tokens.refreshToken, { fetchFn }), (e) => {
    assert.equal(e.failure.kind, 'refresh-refused');
    assert.match(e.message, /Sign in again/);
    return true;
  });
});

test('an expired access token is refused with invalid_token, and the challenge says so', async () => {
  const url = await listen('http-server.mjs', children, { AUTH: '1', AUTH_TOKEN_TTL: '1' });
  const { tokens } = await signIn(url);
  const conn = await connectHttp({ url, accessToken: () => tokens.accessToken });
  try {
    await new Promise((r) => setTimeout(r, 1100));
    const out = await conn.call({ kind: 'tool', target: 'add', args: { a: 1, b: 2 } });
    assert.equal(out.kind, 'failed');
    assert.equal(out.auth.status, 401);
    assert.equal(out.auth.error, 'invalid_token');
    assert.match(out.auth.errorDescription, /expired/);
  } finally {
    await conn.close();
  }
});

test('a tool that needs more scope fails with 403 insufficient_scope, and step-up asks for the union', async () => {
  const url = await listen('http-server.mjs', children, { AUTH: '1', AUTH_SCOPE_TOOL: 'add' });
  const first = await signIn(url, { scope: 'mcp' });
  const conn = await connectHttp({ url, accessToken: () => first.tokens.accessToken });
  let out;
  try {
    out = await conn.call({ kind: 'tool', target: 'add', args: { a: 1, b: 2 } });
  } finally {
    await conn.close();
  }
  assert.equal(out.kind, 'failed');
  assert.deepEqual(out.auth, { status: 403, error: 'insufficient_scope', scope: 'mcp admin', resourceMetadataUrl: `${new URL(url).origin}/.well-known/oauth-protected-resource/mcp`, errorDescription: 'This tool needs the admin scope' });
  const scope = await stepUpScope(first.tokens.scope, out.auth.scope);
  assert.equal(scope, 'mcp admin');
  const second = await signIn(url, { scope, client: first.client });
  const again = await connectHttp({ url, accessToken: () => second.tokens.accessToken });
  try {
    assert.equal((await again.call({ kind: 'tool', target: 'add', args: { a: 1, b: 2 } })).kind, 'result');
  } finally {
    await again.close();
  }
});

test('2025-03-26: no resource metadata and no AS metadata; the default endpoints at the origin, and no resource sent', async () => {
  const log = file('auth.log');
  const url = await listen('http-server.mjs', children, { AUTH: '1', AUTH_PRM: 'none', AUTH_AS_META: 'none', AUTH_LOG: log });
  const { info, tokens } = await signIn(url);
  assert.equal(info.authorizationServerUrl, new URL(url).origin);
  assert.equal(info.resource, undefined);
  assert.equal(info.metadata, undefined);
  assert.match(info.warnings.join(' '), /2025-03-26 default endpoints/);
  assert.ok(tokens.accessToken);
  assert.equal(lines(log).find((l) => l.endpoint === 'token').resource, null);
});

test('resource metadata found without the challenge naming it: path-inserted, then root', async () => {
  for (const mode of ['path', 'root']) {
    const url = await listen('http-server.mjs', children, { AUTH: '1', AUTH_PRM: mode });
    const failure = await refusal({ url });
    assert.equal(failure.challenge.resourceMetadataUrl, undefined, `${mode}: the 401 names no metadata`);
    const { info, tokens } = await signIn(url, { challenge: failure.challenge });
    assert.equal(info.resource, url, `${mode}: found`);
    assert.ok(tokens.accessToken);
  }
});

test('OpenID discovery only, under a path issuer', async () => {
  const url = await listen('http-server.mjs', children, { AUTH: '1', AUTH_AS_META: 'oidc', AUTH_ISSUER_PATH: '/tenant' });
  const { info, tokens } = await signIn(url);
  assert.equal(info.issuer, `${new URL(url).origin}/tenant`);
  assert.ok(tokens.accessToken);
});

test('metadata without code_challenge_methods_supported is used, with a warning; without S256 it is refused', async () => {
  const lax = await listen('http-server.mjs', children, { AUTH: '1', AUTH_PKCE_META: 'none' });
  const { info } = await signIn(lax);
  assert.match(info.warnings.join(' '), /code_challenge_methods_supported/);
  const plain = await listen('http-server.mjs', children, { AUTH: '1', AUTH_PKCE_META: 'plain' });
  await assert.rejects(discoverAuth(plain, { protocolVersion: LATEST, fetchFn: fetch }), (e) => e.failure?.kind === 'metadata-refused' && /S256/.test(e.message));
});

test('a callback naming another issuer is refused, and its error is not shown', async () => {
  const url = await listen('http-server.mjs', children, { AUTH: '1', AUTH_ISS: 'wrong' });
  await assert.rejects(signIn(url), (e) => {
    assert.equal(e.failure.kind, 'issuer-mismatch');
    assert.ok(!e.message.includes('attacker'), 'the received issuer is not displayed');
    return true;
  });
});

test('a callback with another state is refused before anything else is read', async () => {
  const url = await listen('http-server.mjs', children, { AUTH: '1' });
  const info = await discoverAuth(url, { protocolVersion: LATEST, fetchFn: fetch });
  const request = { url: '', state: 'expected', codeVerifier: 'v' };
  await assert.rejects(checkCallback(info, request, new URLSearchParams('code=c&state=other&error=boom')), (e) => e.failure.kind === 'state-mismatch');
});

test('a denied authorization is named with the server\'s error and description', async () => {
  const url = await listen('http-server.mjs', children, { AUTH: '1', AUTH_DENY: '1' });
  await assert.rejects(signIn(url), (e) => {
    assert.deepEqual(e.failure, { kind: 'authorization-denied', error: 'access_denied', description: 'The fixture denies every request' });
    return true;
  });
});

test('no registration endpoint: DCR is a named failure; a pre-registered client signs in', async () => {
  const redirect = 'http://127.0.0.1:0/callback';
  const probe = await LoopbackListener.open();
  const port = probe.port;
  await probe.close();
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const url = await listen('http-server.mjs', children, { AUTH: '1', AUTH_NO_DCR: '1', AUTH_CLIENT_ID: 'pre-1', AUTH_CLIENT_SECRET: 'pre-secret', AUTH_REDIRECT: redirectUri });
  const info = await discoverAuth(url, { protocolVersion: LATEST, fetchFn: fetch });
  await assert.rejects(registerDynamically(info, { redirectUri: redirect, fetchFn: fetch }), (e) => e.failure.kind === 'no-registration');
  const units = [];
  const { tokens } = await signIn(url, { units, client: { clientId: 'pre-1', clientSecret: 'pre-secret', redirectUri, source: 'pre-registered' } });
  assert.ok(tokens.accessToken);
  const tokenRequest = units.find((u) => u.direction === 'out' && u.http?.url?.endsWith('/token'));
  assert.equal(tokenRequest.http.headers.authorization, '<secret: authorization>', 'client_secret_basic stays out of the log (D35)');
});

test('a busy loopback port is a named failure, never a different port', async () => {
  const held = await LoopbackListener.open();
  try {
    await assert.rejects(LoopbackListener.open(held.port), (e) => e instanceof AuthError && e.failure.kind === 'port-busy' && e.failure.port === held.port);
  } finally {
    await held.close();
  }
});

test('the listener times out and cancels with named failures, and answers only /callback', async () => {
  const l = await LoopbackListener.open();
  try {
    const other = await fetch(`http://127.0.0.1:${l.port}/elsewhere`);
    assert.equal(other.status, 404);
    await assert.rejects(l.wait(20), (e) => e.failure.kind === 'callback-ended' && e.failure.reason === 'timeout');
    const w = l.wait(5000);
    l.cancel();
    await assert.rejects(w, (e) => e.failure.reason === 'cancelled');
  } finally {
    await l.close();
  }
});
