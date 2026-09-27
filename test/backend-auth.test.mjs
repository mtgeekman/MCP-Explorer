// Phase 11 through the backend: Sign in, the browser's return, tokens used on
// Connect, refresh inside a Connect or a "Refresh and retry" only, step-up,
// sign-out, and no token value in the log or the renderer's replies.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Backend } from '../packages/backend/dist/index.js';
import { LoopbackListener } from '../packages/protocol/dist/index.js';
import { memoryStore } from './support/memory-store.mjs';
import { listen } from './support/fixture-servers.mjs';

const root = mkdtempSync(join(tmpdir(), 'mcpx-bauth-'));
const backends = [];
const children = [];
after(async () => {
  for (const b of backends) await b.shutdown();
  for (const c of children) c.kill();
  rmSync(root, { recursive: true, force: true });
});
let n = 0;
const file = (name) => {
  const p = join(root, `${++n}-${name}`);
  writeFileSync(p, '');
  return p;
};
const lines = (p) => readFileSync(p, 'utf8').split('\n').filter(Boolean);

async function waitFor(check, ms = 15000) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** A workspace with one HTTP server behind the fixture authorization server. */
async function setup(env = {}, protection = { kind: 'none' }) {
  const authLog = file('auth.log');
  const headerLog = file('headers.log');
  const url = await listen('http-server.mjs', children, { AUTH: '1', AUTH_LOG: authLog, HEADER_LOG: headerLog, ...env });
  const backend = new Backend({ dataDir: mkdtempSync(join(root, 'data-')), secrets: memoryStore(), closeGraceMs: 300 });
  backends.push(backend);
  const events = [];
  backend.on((name, data) => events.push({ name, data }));
  const call = (method, params = {}) => backend.request(method, params);
  await call('workspaces.create', { name: 'Auth', protection });
  const { id } = await call('servers.save', { server: { name: 'remote', transport: 'streamable-http', url } });
  return { call, events, serverId: id, url, authLog, headerLog };
}

/** The browser: follow the authorization server's redirect to the loopback listener. */
async function browse(authorizationUrl) {
  const r = await fetch(authorizationUrl, { redirect: 'manual' });
  assert.equal(r.status, 302);
  await (await fetch(r.headers.get('location'))).text();
}

/** Sign in from the failed connect's challenge and wait until the backend says it is done. */
async function signIn(s, params = {}) {
  const { authorizationUrl } = await s.call('auth.signIn', { serverId: s.serverId, ...params });
  const pending = await s.call('auth.get', { serverId: s.serverId });
  assert.equal(pending.pending.authorizationUrl, authorizationUrl, 'the page shows the URL while it waits');
  await browse(authorizationUrl);
  return waitFor(async () => {
    const r = await s.call('auth.get', { serverId: s.serverId });
    return !r.pending && (r.signedIn || r.lastFailure) ? r : undefined;
  });
}

const tokensSent = (s) => lines(s.headerLog).map((l) => l.replace(/^Bearer /, '')).filter(Boolean);

async function finished(s, callId) {
  return waitFor(async () => {
    const v = await s.call('calls.get', { callId });
    return v.live ? undefined : v;
  });
}

test('acceptance: connect fails as unauthorized, Sign in completes through the browser, and the token connects', async () => {
  const s = await setup();
  const failed = await s.call('connections.connect', { serverId: s.serverId });
  assert.equal(failed.status, 'failed');
  assert.equal(failed.failure.kind, 'unauthorized');
  assert.equal(failed.failure.challenge.status, 401);

  const report = await signIn(s, { challenge: failed.failure.challenge });
  assert.equal(report.signedIn, true, JSON.stringify(report.lastFailure));
  assert.equal(report.storage, 'session', 'an unencrypted workspace keeps the sign-in in memory');
  assert.equal(report.registration.kind, 'dynamic');
  assert.equal(report.hasRefreshToken, true);
  assert.equal(report.scope, 'mcp');
  assert.ok(report.expiresAt > Date.now());
  assert.ok(s.events.some((e) => e.name === 'auth.changed'));

  const state = await s.call('connections.connect', { serverId: s.serverId });
  assert.equal(state.status, 'connected', JSON.stringify(state));
  const [token] = tokensSent(s);
  assert.ok(token, 'the MCP request carried a bearer token');

  // Decision 12 and D35: no token value in anything the renderer is sent, or in the log.
  assert.ok(!JSON.stringify(await s.call('auth.get', { serverId: s.serverId })).includes(token));
  const units = await s.call('log.units', { serverId: s.serverId });
  const text = units.map((u) => (u.bytes ? Buffer.from(u.bytes).toString('utf8') : '') + JSON.stringify(u.http ?? {})).join('\n');
  assert.ok(!text.includes(token), 'the access token is not in the wire log');
  assert.ok(units.some((u) => u.http?.redacted?.includes('access_token')), 'the token response is there, redacted');
  const events = units.filter((u) => u.kind === 'app').map((u) => JSON.parse(Buffer.from(u.bytes).toString('utf8')).event);
  for (const e of ['sign-in-started', 'auth-discovered', 'client-registered', 'authorization-url', 'authorization-callback', 'signed-in']) assert.ok(events.includes(e), `the log records ${e}`);
});

test('an encrypted workspace keeps the sign-in; sign-out forgets the tokens and keeps the registration', async () => {
  const s = await setup({}, { kind: 'keychain' });
  await s.call('connections.connect', { serverId: s.serverId });
  assert.equal((await signIn(s)).storage, 'workspace');
  assert.equal((await s.call('connections.connect', { serverId: s.serverId })).status, 'connected');
  await s.call('connections.disconnect', { serverId: s.serverId });

  const out = await s.call('auth.signOut', { serverId: s.serverId });
  assert.equal(out.signedIn, false);
  assert.equal(out.registration.kind, 'dynamic', 'the registration is kept');
  assert.equal((await s.call('connections.connect', { serverId: s.serverId })).failure?.kind, 'unauthorized');

  const again = await signIn(s);
  assert.equal(again.signedIn, true);
  assert.equal(lines(s.authLog).filter((l) => JSON.parse(l).endpoint === 'register').length, 1, 'signing in again reuses the registration');
});

test('decision 2: an expired token is refreshed by the Connect the user pressed, and recorded in its log', async () => {
  const s = await setup({ AUTH_TOKEN_TTL: '1' });
  await s.call('connections.connect', { serverId: s.serverId });
  await signIn(s);
  const state = await s.call('connections.connect', { serverId: s.serverId });
  assert.equal(state.status, 'connected', JSON.stringify(state));
  const grants = lines(s.authLog).map((l) => JSON.parse(l)).filter((l) => l.endpoint === 'token').map((l) => l.grant_type);
  assert.deepEqual(grants, ['authorization_code', 'refresh_token']);
  const units = await s.call('log.units', { serverId: s.serverId });
  assert.ok(units.some((u) => u.connectionId === state.connectionId && u.http?.url?.endsWith('/token')), 'the refresh is in the connect\'s own log');
});

test('acceptance: a refused refresh is a clear "sign in again", with the tokens forgotten', async () => {
  const s = await setup({ AUTH_TOKEN_TTL: '1', AUTH_REFRESH: 'refuse' });
  await s.call('connections.connect', { serverId: s.serverId });
  await signIn(s);
  const state = await s.call('connections.connect', { serverId: s.serverId });
  assert.equal(state.status, 'failed');
  assert.equal(state.auth.kind, 'refresh-refused');
  assert.match(state.message, /Sign in again/);
  const report = await s.call('auth.get', { serverId: s.serverId });
  assert.equal(report.signedIn, false);
  assert.equal(report.lastFailure.failure.kind, 'refresh-refused');
  assert.equal(report.registration.kind, 'dynamic', 'the registration survives; only the tokens went');
});

test('decision 2: a 401 mid-session fails the call with its challenge; Refresh and retry makes the next call work', async () => {
  const s = await setup({ AUTH_TOKEN_TTL: '2' });
  await s.call('connections.connect', { serverId: s.serverId });
  await signIn(s);
  assert.equal((await s.call('connections.connect', { serverId: s.serverId })).status, 'connected');
  await new Promise((r) => setTimeout(r, 2100));
  const refusedBefore = lines(s.authLog).length;
  const first = await finished(s, (await s.call('calls.start', { serverId: s.serverId, kind: 'tool', target: 'add', args: { a: 1, b: 2 }, confirmed: true })).callId);
  assert.equal(first.call.status, 'error');
  const error = first.call.roundRecords[0].error;
  assert.equal(error.auth.status, 401);
  assert.equal(error.auth.error, 'invalid_token');
  assert.equal(lines(s.authLog).length, refusedBefore, 'nothing refreshed on its own');

  const report = await s.call('auth.refresh', { serverId: s.serverId });
  assert.equal(report.signedIn, true);
  const second = await finished(s, (await s.call('calls.start', { serverId: s.serverId, kind: 'tool', target: 'add', args: { a: 1, b: 2 }, confirmed: true })).callId);
  assert.equal(second.call.status, 'completed', 'the live session uses the refreshed token without a reconnect');
});

test('decision 11: a 403 insufficient_scope names the scopes; signing in with them lets the call through', async () => {
  const s = await setup({ AUTH_SCOPE_TOOL: 'add' });
  const failed = await s.call('connections.connect', { serverId: s.serverId });
  await signIn(s, { challenge: failed.failure.challenge });
  assert.equal((await s.call('connections.connect', { serverId: s.serverId })).status, 'connected');
  const first = await finished(s, (await s.call('calls.start', { serverId: s.serverId, kind: 'tool', target: 'add', args: { a: 1, b: 2 }, confirmed: true })).callId);
  const auth = first.call.roundRecords[0].error.auth;
  assert.equal(auth.status, 403);
  assert.equal(auth.scope, 'mcp admin');
  const report = await signIn(s, { scope: 'mcp admin' });
  assert.equal(report.scope, 'mcp admin');
  const second = await finished(s, (await s.call('calls.start', { serverId: s.serverId, kind: 'tool', target: 'add', args: { a: 1, b: 2 }, confirmed: true })).callId);
  assert.equal(second.call.status, 'completed');
});

test('Cancel ends a sign-in that is waiting for the browser, and says so', async () => {
  const s = await setup();
  await s.call('auth.signIn', { serverId: s.serverId });
  await s.call('auth.cancel', { serverId: s.serverId });
  const report = await waitFor(async () => {
    const r = await s.call('auth.get', { serverId: s.serverId });
    return r.lastFailure ? r : undefined;
  });
  assert.equal(report.pending, undefined);
  assert.deepEqual(report.lastFailure.failure, { kind: 'callback-ended', reason: 'cancelled' });
});

test('a registration whose port is taken is a named failure; Register again picks a new port', async () => {
  const s = await setup({}, { kind: 'keychain' });
  await signIn(s);
  const port = Number(new URL((await s.call('auth.get', { serverId: s.serverId })).registration.redirectUri).port);
  const held = await LoopbackListener.open(port);
  try {
    await assert.rejects(s.call('auth.signIn', { serverId: s.serverId }), (e) => e.failure?.kind === 'port-busy' && e.failure.port === port);
    assert.equal((await s.call('auth.get', { serverId: s.serverId })).lastFailure.failure.kind, 'port-busy');
    const again = await signIn(s, { reregister: true });
    assert.equal(again.signedIn, true);
    assert.notEqual(Number(new URL(again.registration.redirectUri).port), port);
  } finally {
    await held.close();
  }
});

test('a pre-registered client is used before registration, and its secret never comes back to the renderer', async () => {
  const probe = await LoopbackListener.open();
  const redirectUri = probe.redirectUri;
  await probe.close();
  const s = await setup({ AUTH_NO_DCR: '1', AUTH_CLIENT_ID: 'pre-1', AUTH_CLIENT_SECRET: 'pre-secret', AUTH_REDIRECT: redirectUri }, { kind: 'keychain' });
  const form = await s.call('servers.get', { id: s.serverId });
  await s.call('servers.save', { server: { ...form, oauthClient: { clientId: 'pre-1', redirectUri, clientSecret: 'pre-secret' } } });
  const back = await s.call('servers.get', { id: s.serverId });
  assert.deepEqual(back.oauthClient, { clientId: 'pre-1', redirectUri, clientSecret: null });
  await s.call('servers.save', { server: back });
  const report = await signIn(s);
  assert.equal(report.signedIn, true, JSON.stringify(report.lastFailure));
  assert.equal(report.registration.kind, 'pre-registered');
  assert.equal(report.preRegistered, true);
});

test('no registration route is a named failure that says what to enter', async () => {
  const s = await setup({ AUTH_NO_DCR: '1' });
  await assert.rejects(s.call('auth.signIn', { serverId: s.serverId }), (e) => e.failure?.kind === 'no-registration' && /client id/.test(e.message));
});

test('decision 14: the deprecated HTTP+SSE transport reports the 401 the same way, and connects once signed in', async () => {
  const url = await listen('sse-server.mjs', children, { AUTH: '1' });
  const backend = new Backend({ dataDir: mkdtempSync(join(root, 'data-')), secrets: memoryStore(), closeGraceMs: 300 });
  backends.push(backend);
  const call = (method, params = {}) => backend.request(method, params);
  await call('workspaces.create', { name: 'SSE auth', protection: { kind: 'none' } });
  const { id } = await call('servers.save', { server: { name: 'sse', transport: 'sse', url } });
  const s = { call, serverId: id };
  const failed = await call('connections.connect', { serverId: id });
  assert.equal(failed.failure?.kind, 'unauthorized', JSON.stringify(failed));
  const report = await signIn(s, { challenge: failed.failure.challenge });
  assert.equal(report.signedIn, true, JSON.stringify(report.lastFailure));
  assert.equal(report.resource, url);
  assert.equal((await call('connections.connect', { serverId: id })).status, 'connected');
});
