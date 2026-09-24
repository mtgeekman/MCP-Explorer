// The backend's message API (D32): workspaces (D3, D5, D28, D29), servers
// (D31), connections and the wire log (D34), all without Electron.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { MessageChannel } from 'node:worker_threads';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadServer, workspaceKeyAccount } from '../packages/storage/dist/index.js';
import { Backend, serve } from '../packages/backend/dist/index.js';
import { memoryStore } from './support/memory-store.mjs';
import { fixtures } from './support/fixture-servers.mjs';

const root = mkdtempSync(join(tmpdir(), 'mcpx-backend-'));
const backends = [];
after(async () => {
  for (const b of backends) await b.shutdown();
  rmSync(root, { recursive: true, force: true });
});

function setup({ secrets = memoryStore() } = {}) {
  const dataDir = mkdtempSync(join(root, 'data-'));
  const seen = { notices: [], states: [], units: [], processes: [] };
  const backend = new Backend({ dataDir, secrets, probeTimeoutMs: 1000, closeGraceMs: 300, onProcesses: (p) => seen.processes.push(p) });
  backend.on((name, data) => {
    if (name === 'notice') seen.notices.push(data);
    if (name === 'connection.state') seen.states.push(data);
    if (name === 'log.unit') seen.units.push(data);
  });
  backends.push(backend);
  const call = (method, params = {}) => backend.request(method, params);
  return { backend, call, seen, secrets, dataDir };
}

const modernServer = (extra = {}) => ({ name: 'modern', transport: 'stdio', command: process.execPath, args: [join(fixtures, 'modern-server.mjs')], ...extra });

// --- workspaces ---------------------------------------------------------------------------

test('first run: nothing is registered; a keychain workspace is created, opened, and its recovery key handed over once', async () => {
  const { call, secrets } = setup();
  assert.deepEqual(await call('workspaces.list'), []);
  assert.equal(await call('workspaces.current'), null);
  const created = await call('workspaces.create', { name: 'Work', protection: { kind: 'keychain' } });
  assert.match(created.recoveryKey, /^MCPX1-/);
  assert.equal(created.encrypted, true);
  assert.ok(secrets.get(workspaceKeyAccount(created.id)));
  assert.deepEqual((await call('workspaces.list')).map((w) => [w.label, w.custody]), [['Work', 'keychain']]);
  assert.deepEqual(await call('workspaces.current'), { id: created.id, name: 'Work', encrypted: true });
});

test('a passphrase workspace is listed without its name until opened, and a wrong passphrase is refused (D29)', async () => {
  const { call } = setup();
  const created = await call('workspaces.create', { name: 'Secret project', protection: { kind: 'passphrase', passphrase: 'correct horse' } });
  assert.equal(created.recoveryKey, undefined, 'the passphrase already is the recovery key (D28)');
  await call('workspaces.close');
  const [listed] = await call('workspaces.list');
  assert.match(listed.label, /^Protected workspace, created \d{4}-\d\d-\d\d$/);
  await assert.rejects(call('workspaces.open', { id: created.id, unlock: { kind: 'passphrase', passphrase: 'wrong' } }), { name: 'WrongKeyError' });
  const opened = await call('workspaces.open', { id: created.id, unlock: { kind: 'passphrase', passphrase: 'correct horse' } });
  assert.equal(opened.name, 'Secret project');
  assert.equal((await call('workspaces.list'))[0].label, 'Secret project', 'the open workspace shows its name');
});

test('an unlock that does not fit the workspace is refused before anything is opened', async () => {
  const { call } = setup();
  const created = await call('workspaces.create', { name: 'Plain', protection: { kind: 'none' } });
  await call('workspaces.close');
  await assert.rejects(call('workspaces.open', { id: created.id, unlock: { kind: 'keychain' } }), /cannot be opened with keychain/);
});

test('switching workspaces closes the first one\'s connections', async () => {
  const { call } = setup();
  await call('workspaces.create', { name: 'A', protection: { kind: 'none' } });
  const s = await call('servers.save', { server: modernServer() });
  const up = await call('connections.connect', { serverId: s.id });
  assert.equal(up.status, 'connected');
  const b = await call('workspaces.create', { name: 'B', protection: { kind: 'none' } });
  assert.equal((await call('workspaces.current')).id, b.id);
  assert.deepEqual(await call('servers.list'), []);
  await waitFor(() => { try { process.kill(up.pid, 0); return false; } catch { return true; } });
});

// --- D28: keychain self-repair ------------------------------------------------------------

test('D28: a lost keychain entry asks for the recovery key; opening with it restores the entry and says so', async () => {
  const { call, secrets, seen } = setup();
  const created = await call('workspaces.create', { name: 'Work', protection: { kind: 'keychain' } });
  await call('workspaces.close');
  secrets.delete(workspaceKeyAccount(created.id));
  await assert.rejects(call('workspaces.open', { id: created.id, unlock: { kind: 'keychain' } }), { name: 'NeedsRecoveryKeyError' });
  await call('workspaces.open', { id: created.id, unlock: { kind: 'recovery', recoveryKey: created.recoveryKey } });
  assert.deepEqual(seen.notices, [{ kind: 'keychain-restored', workspaceId: created.id, name: 'Work' }]);
  await call('workspaces.close');
  await call('workspaces.open', { id: created.id, unlock: { kind: 'keychain' } });
  assert.equal(seen.notices.length, 1, 'an entry that is there is not rewritten');
});

test('D28: an entry lost while the workspace is open is restored on close, and the user told', async () => {
  const { call, secrets, seen } = setup();
  const created = await call('workspaces.create', { name: 'Work', protection: { kind: 'keychain' } });
  secrets.delete(workspaceKeyAccount(created.id));
  await call('workspaces.close');
  assert.equal(seen.notices[0].kind, 'keychain-restored');
  assert.ok(secrets.get(workspaceKeyAccount(created.id)));
});

test('D28: a repair that fails says so, and is not retried behind the user\'s back', async () => {
  const store = memoryStore();
  let refuse = false;
  const secrets = { ...store, set: (a, v) => { if (refuse) throw new Error('Windows error code 8'); store.set(a, v); } };
  const { call, seen } = setup({ secrets });
  const created = await call('workspaces.create', { name: 'Work', protection: { kind: 'keychain' } });
  refuse = true;
  store.delete(workspaceKeyAccount(created.id));
  await call('workspaces.close');
  assert.deepEqual(seen.notices.map((n) => [n.kind, n.message]), [['keychain-restore-failed', 'Windows error code 8']]);
});

// --- servers (D31) ------------------------------------------------------------------------

test('D31: a stored secret never crosses back to the renderer, and saving it as null keeps it', async () => {
  const { backend, call } = setup();
  await call('workspaces.create', { name: 'Work', protection: { kind: 'keychain' } });
  const saved = await call('servers.save', { server: { name: 'remote', transport: 'streamable-http', url: 'http://127.0.0.1:1/mcp', secretHeaders: { Authorization: 'Bearer kept' } } });
  const form = await call('servers.get', { id: saved.id });
  assert.deepEqual(form.secretHeaders, { Authorization: null });
  assert.ok(!JSON.stringify(form).includes('Bearer kept'));
  await call('servers.save', { server: { ...form, name: 'renamed' } });
  assert.equal((await call('servers.list'))[0].name, 'renamed');
  // The value survived the round trip through a form that never held it.
  assert.deepEqual(loadServer(backend['workspaces'].open.ws, saved.id).secretHeaders, { Authorization: 'Bearer kept' });
});

test('D31: an unencrypted workspace refuses a secret value and keeps a secret name', async () => {
  const { call } = setup();
  await call('workspaces.create', { name: 'Plain', protection: { kind: 'none' } });
  await assert.rejects(call('servers.save', { server: modernServer({ secretEnv: { TOKEN: 'x' } }) }), { name: 'SecretsRequireEncryptionError' });
  const s = await call('servers.save', { server: modernServer({ unstoredSecrets: { env: ['TOKEN'] } }) });
  assert.deepEqual(await call('connections.connect', { serverId: s.id }), { status: 'needs-secrets', missing: { env: ['TOKEN'] } });
});

test('requests that need a workspace say so when none is open', async () => {
  const { call } = setup();
  await assert.rejects(call('servers.list'), { name: 'NoWorkspaceError' });
});

// --- connections and the log (D34) --------------------------------------------------------

test('a connect is announced as states and units, and the log reads back the same bytes in order', async () => {
  const { call, seen } = setup();
  await call('workspaces.create', { name: 'Work', protection: { kind: 'none' } });
  const s = await call('servers.save', { server: modernServer({ env: { ODD_BYTES: '1' } }) });
  const up = await call('connections.connect', { serverId: s.id });
  assert.equal(up.status, 'connected');
  assert.deepEqual(seen.states.map((x) => x.state.status), ['connecting', 'connecting', 'connected']);
  assert.deepEqual(seen.processes.at(-1), [up.pid]);
  const row = (await call('servers.list'))[0];
  assert.deepEqual(row.era, { era: 'modern', revision: '2026-07-28' });
  await call('connections.disconnect', { serverId: s.id });

  const log = await call('log.units', { serverId: s.id });
  assert.deepEqual(log.map((u) => u.id), seen.units.map((u) => u.id));
  assert.deepEqual(log.map((u) => Buffer.from(u.bytes).toString('hex')), seen.units.map((u) => Buffer.from(u.bytes).toString('hex')));
  assert.ok(log.some((u) => u.kind === 'app'), 'the spawn and exit are in the log');

  // Paging: the page before the last three is everything else, in order.
  const last = log.at(-3);
  const earlier = await call('log.units', { serverId: s.id, before: { at: last.at, id: last.id, reserialized: false } });
  assert.deepEqual(earlier.map((u) => u.id), log.slice(0, -3).map((u) => u.id));
  const tail = await call('log.units', { serverId: s.id, limit: 2 });
  assert.deepEqual(tail.map((u) => u.id), log.slice(-2).map((u) => u.id));
});

test('D34: a frame written before exact capture is listed from its message, marked re-serialized', async () => {
  const { backend, call } = setup();
  await call('workspaces.create', { name: 'Work', protection: { kind: 'none' } });
  const s = await call('servers.save', { server: modernServer() });
  // Written the way schema 2 wrote frames, as an upgraded workspace holds them.
  const db = backend['workspaces'].open.ws.db;
  const conn = db.prepare('INSERT INTO connection (server_id, opened_at) VALUES (?, 1)').run(s.id).lastInsertRowid;
  db.prepare("INSERT INTO frame (connection_id, direction, at, method, message_json) VALUES (?, 'out', 5, 'ping', '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}')").run(conn);
  const [unit] = await call('log.units', { serverId: s.id });
  assert.equal(unit.reserialized, true);
  assert.equal(Buffer.from(unit.bytes).toString(), '{"jsonrpc":"2.0","id":1,"method":"ping"}');
});

// --- the port -----------------------------------------------------------------------------

test('served over a message port: requests are answered, failures carry their name, events arrive', async () => {
  const { backend } = setup();
  const { port1, port2 } = new MessageChannel();
  serve(backend, { post: (m) => port1.postMessage(m), onMessage: (l) => port1.on('message', l) });
  const replies = new Map();
  const events = [];
  port2.on('message', (m) => (m.kind === 'response' ? replies.set(m.id, m) : events.push(m)));
  const ask = async (id, method, params = {}) => {
    port2.postMessage({ kind: 'request', id, method, params });
    return waitFor(() => replies.get(id));
  };
  const refused = await ask(1, 'servers.list');
  assert.deepEqual([refused.ok, refused.error.name], [false, 'NoWorkspaceError']);
  const created = await ask(2, 'workspaces.create', { name: 'Ported', protection: { kind: 'none' } });
  assert.equal(created.result.name, 'Ported');
  const s = await ask(3, 'servers.save', { server: modernServer() });
  await ask(4, 'connections.connect', { serverId: s.result.id });
  await ask(5, 'connections.disconnect', { serverId: s.result.id });
  assert.ok(events.some((e) => e.name === 'log.unit' && e.data.bytes instanceof Uint8Array), 'units cross the port with their bytes');
  assert.ok(events.some((e) => e.name === 'connection.state' && e.data.state.status === 'connected'));
  port1.close();
  port2.close();
});

async function waitFor(check, ms = 10000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = check();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}
