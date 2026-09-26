// Phase 11 code review, round 1: one regression test per finding, written
// before the fixes and seen failing on the phase code.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Backend, AuthManager } from '../packages/backend/dist/index.js';
import { LoopbackListener, discoverAuth } from '../packages/protocol/dist/index.js';
import { createWorkspaceDb, saveServer, saveGrant, loadGrant, workspaceKeyAccount } from '../packages/storage/dist/index.js';
import { memoryStore } from './support/memory-store.mjs';
import { listen } from './support/fixture-servers.mjs';

const root = mkdtempSync(join(tmpdir(), 'mcpx-p11r-'));
const backends = [];
const children = [];
after(async () => {
  for (const b of backends) await b.shutdown();
  for (const c of children) c.kill();
  rmSync(root, { recursive: true, force: true });
});
const file = (name) => {
  const p = join(root, `${randomUUID()}-${name}`);
  writeFileSync(p, '');
  return p;
};

async function waitFor(check, ms = 5000) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function backend(protection = { kind: 'none' }) {
  const b = new Backend({ dataDir: mkdtempSync(join(root, 'data-')), secrets: memoryStore(), probeTimeoutMs: 1000, closeGraceMs: 300 });
  backends.push(b);
  const call = (method, params = {}) => b.request(method, params);
  await call('workspaces.create', { name: 'Review', protection });
  return call;
}

async function browse(authorizationUrl) {
  const r = await fetch(authorizationUrl, { redirect: 'manual' });
  assert.equal(r.status, 302);
  await (await fetch(r.headers.get('location'))).text();
}

async function signIn(call, serverId, params = {}) {
  const { authorizationUrl } = await call('auth.signIn', { serverId, ...params });
  await browse(authorizationUrl);
  return waitFor(async () => {
    const r = await call('auth.get', { serverId });
    return !r.pending && (r.signedIn || r.lastFailure) ? r : undefined;
  });
}

const freePort = async () => {
  const l = await LoopbackListener.open();
  const port = l.port;
  await l.close();
  return port;
};

test('R11-1: a token is not sent to a server whose URL was changed after the sign-in', async () => {
  const call = await backend();
  const first = await listen('http-server.mjs', children, { AUTH: '1' });
  const headers = file('headers.log');
  const second = await listen('http-server.mjs', children, { AUTH: '1', HEADER_LOG: headers });
  const { id } = await call('servers.save', { server: { name: 'moved', transport: 'streamable-http', url: first } });
  assert.equal((await signIn(call, id)).signedIn, true);
  const form = await call('servers.get', { id });
  await call('servers.save', { server: { ...form, url: second } });
  const state = await call('connections.connect', { serverId: id });
  assert.equal(state.failure?.kind, 'unauthorized');
  const sent = readFileSync(headers, 'utf8').split('\n').filter(Boolean);
  assert.deepEqual(sent, [], 'no Authorization header reached the other server');
});

test('R11-1 (old valid input): the token still goes to the server it was issued for', async () => {
  const call = await backend();
  const url = await listen('http-server.mjs', children, { AUTH: '1' });
  const { id } = await call('servers.save', { server: { name: 'same', transport: 'streamable-http', url } });
  await signIn(call, id);
  assert.equal((await call('connections.connect', { serverId: id })).status, 'connected');
});

test('R11-2: a pre-registered redirect URI with its own path is served at that path', async () => {
  const redirectUri = `http://127.0.0.1:${await freePort()}/oauth/cb`;
  const url = await listen('http-server.mjs', children, { AUTH: '1', AUTH_NO_DCR: '1', AUTH_CLIENT_ID: 'pre-1', AUTH_REDIRECT: redirectUri });
  const call = await backend();
  const { id } = await call('servers.save', { server: { name: 'pre', transport: 'streamable-http', url, oauthClient: { clientId: 'pre-1', redirectUri } } });
  const report = await signIn(call, id);
  assert.equal(report.signedIn, true, JSON.stringify(report.lastFailure));
});

test('R11-3: a pre-registered redirect URI on [::1] is listened for on [::1]', async () => {
  const probe = createServer();
  await new Promise((r) => probe.listen(0, '::1', r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  const redirectUri = `http://[::1]:${port}/callback`;
  const url = await listen('http-server.mjs', children, { AUTH: '1', AUTH_NO_DCR: '1', AUTH_CLIENT_ID: 'pre-6', AUTH_REDIRECT: redirectUri });
  const call = await backend();
  const { id } = await call('servers.save', { server: { name: 'v6', transport: 'streamable-http', url, oauthClient: { clientId: 'pre-6', redirectUri } } });
  const report = await signIn(call, id);
  assert.equal(report.signedIn, true, JSON.stringify(report.lastFailure));
});

test('R11-4: an origin-only resource is named as the metadata names it, with no trailing slash', async (t) => {
  let origin = '';
  const server = createServer((req, res) => {
    const json = (b) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
    if (req.url === '/.well-known/oauth-protected-resource') return json({ resource: origin, authorization_servers: [origin] });
    if (req.url === '/.well-known/oauth-authorization-server') return json({ issuer: origin, authorization_endpoint: `${origin}/a`, token_endpoint: `${origin}/t`, response_types_supported: ['code'], code_challenge_methods_supported: ['S256'] });
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  origin = `http://127.0.0.1:${server.address().port}`;
  const info = await discoverAuth(origin, { protocolVersion: '2026-07-28', fetchFn: fetch });
  assert.equal(info.resource, origin);
  // Old valid input: a resource with a path is unchanged.
  assert.equal((await discoverAuth(`${origin}/`, { protocolVersion: '2026-07-28', fetchFn: fetch })).resource, origin);
});

test('R11-5: a sign-in whose recorder fails as it ends does not reject unhandled', async () => {
  const unhandled = [];
  const onUnhandled = (e) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  try {
    const url = await listen('http-server.mjs', children, { AUTH: '1' });
    const ws = createWorkspaceDb({ path: join(mkdtempSync(join(root, 'ws-')), 'w.db'), workspaceId: randomUUID(), name: 'r5', custody: { kind: 'none' }, secrets: memoryStore() });
    saveServer(ws, { id: 's1', name: 's1', transport: 'streamable-http', url });
    const auth = new AuthManager(ws, { record: () => ({ emit: () => undefined, close: () => { throw new Error('the recorder is closed'); } }), changed: () => undefined });
    await auth.signIn('s1');
    await auth.cancel('s1');
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(unhandled.map(String), []);
    assert.equal(auth.report('s1').lastFailure?.failure.reason, 'cancelled');
    ws.close();
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('R11-6: a newer registration without tokens does not hide a sign-in that has them', () => {
  const secrets = memoryStore();
  const workspaceId = randomUUID();
  const ws = createWorkspaceDb({ path: join(mkdtempSync(join(root, 'ws-')), 'w.db'), workspaceId, name: 'r6', custody: { kind: 'keychain' }, secrets });
  try {
    saveServer(ws, { id: 's', name: 's', transport: 'streamable-http', url: 'https://mcp.test/mcp' });
    const client = { clientId: 'c', redirectUri: 'http://127.0.0.1:1/callback', source: 'dynamic' };
    saveGrant(ws, 's', { issuer: 'https://old', authServer: 'https://old', client, tokens: { accessToken: 'at' } }, () => 1);
    saveGrant(ws, 's', { issuer: 'https://new', authServer: 'https://new', client }, () => 2);
    assert.equal(loadGrant(ws, 's').tokens?.accessToken, 'at');
    // Old valid input: with no tokens anywhere, the newest registration is the one.
    saveGrant(ws, 's', { issuer: 'https://old', authServer: 'https://old', client }, () => 3);
    assert.equal(loadGrant(ws, 's').issuer, 'https://old');
  } finally {
    ws.close();
    secrets.delete(workspaceKeyAccount(workspaceId));
  }
});

test('R11-7: a task round refused with 401 keeps its challenge', async () => {
  const url = await listen('http-server.mjs', children, { AUTH: '1', LEGACY: '1', LEGACY_REVISION: '2025-11-25', EXTRAS: '1', AUTH_TOKEN_TTL: '2' });
  const call = await backend();
  const { id } = await call('servers.save', { server: { name: 'tasks', transport: 'streamable-http', url } });
  await signIn(call, id);
  assert.equal((await call('connections.connect', { serverId: id })).status, 'connected');
  const { callId } = await call('calls.start', { serverId: id, kind: 'tool', target: 'task_work', args: { ms: 50 }, asTask: {}, confirmed: true });
  await waitFor(async () => (await call('calls.get', { callId })).live?.status === 'task');
  await new Promise((r) => setTimeout(r, 2100));
  await call('calls.task', { callId, op: 'get' });
  const view = await waitFor(async () => {
    const v = await call('calls.get', { callId });
    return v.call.roundRecords.length === 2 && v.call.roundRecords[1].finishedAt !== null ? v : undefined;
  });
  assert.equal(view.call.roundRecords[1].error?.auth?.status, 401);
});

test('R11-8: a connect refused with 403 signs in with the union of the granted and the challenged scopes', async () => {
  const { signInParams } = await import('../app/renderer/src/lib/auth.ts');
  const state = { status: 'failed', failure: { kind: 'unauthorized', challenge: { status: 403, error: 'insufficient_scope', scope: 'admin' } }, message: 'm', stderr: '', at: 1 };
  assert.deepEqual(signInParams('s', state, { signedIn: true, scope: 'mcp read' }), { serverId: 's', challenge: state.failure.challenge, scope: 'mcp read admin' });
  // Old valid input: a 401 passes its challenge and no scope.
  const s401 = { ...state, failure: { kind: 'unauthorized', challenge: { status: 401 } } };
  assert.deepEqual(signInParams('s', s401, null), { serverId: 's', challenge: { status: 401 } });
});
