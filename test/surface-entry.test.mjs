// Tool detail opens on the entry's exact bytes, cut from the list reply it
// arrived in (board 5.1A, D10, D34): never a re-serialization.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createWorkspaceDb, saveServer, HistoryRecorder } from '../packages/storage/dist/index.js';
import { Backend, rawEntry } from '../packages/backend/dist/index.js';
import { memoryStore } from './support/memory-store.mjs';
import { fixtures, listen } from './support/fixture-servers.mjs';

const root = mkdtempSync(join(tmpdir(), 'mcpx-entry-'));
const backends = [];
const children = [];
const databases = [];
after(async () => {
  for (const b of backends) await b.shutdown();
  for (const ws of databases) ws.close();
  for (const c of children) c.kill();
  rmSync(root, { recursive: true, force: true });
});

const text = (bytes) => Buffer.from(bytes).toString('utf8');
const enc = (s) => new Uint8Array(Buffer.from(s, 'utf8'));

async function connectedBackend(server) {
  const backend = new Backend({ dataDir: mkdtempSync(join(root, 'data-')), secrets: memoryStore(), closeGraceMs: 300 });
  backends.push(backend);
  const call = (method, params = {}) => backend.request(method, params);
  await call('workspaces.create', { name: 'Entries', protection: { kind: 'none' } });
  const row = await call('servers.save', { server });
  assert.equal((await call('connections.connect', { serverId: row.id })).status, 'connected');
  const end = Date.now() + 10000;
  while (!(await call('surface.get', { serverId: row.id })).capture) {
    if (Date.now() > end) throw new Error('no capture');
    await new Promise((r) => setTimeout(r, 25));
  }
  return { call, id: row.id };
}

/** The entry is a contiguous slice of a logged unit, and it parses to the listed item. */
async function assertExact(call, serverId, list, key, field) {
  const entry = await call('surface.entry', { serverId, list, key });
  assert.equal(entry.found, true, entry.reason);
  const unit = await call('log.get', { id: entry.unitId });
  assert.deepEqual(Buffer.from(unit.bytes).subarray(entry.offset, entry.offset + entry.bytes.length), Buffer.from(entry.bytes));
  assert.equal(JSON.parse(text(entry.bytes))[field], key);
  return entry;
}

test('over stdio, every list entry of the modern fixture is cut exactly from its reply, in the server\'s own key order', async () => {
  const { call, id } = await connectedBackend({ name: 'modern', transport: 'stdio', command: process.execPath, args: [join(fixtures, 'modern-server.mjs')] });
  const tool = await assertExact(call, id, 'tools', 'echo', 'name');
  // The fixture shuffles keys: the bytes shown are the server's, not a canonical form.
  const surface = (await call('surface.get', { serverId: id })).capture.surface;
  assert.notEqual(text(tool.bytes), JSON.stringify(surface.tools.find((t) => t.name === 'echo')));
  await assertExact(call, id, 'prompts', 'greet', 'name');
  await assertExact(call, id, 'resources', 'file:///fixture/readme.md', 'uri');
  await assertExact(call, id, 'resourceTemplates', 'file:///fixture/{name}.md', 'uriTemplate');
  const missing = await call('surface.entry', { serverId: id, list: 'tools', key: 'nope' });
  assert.equal(missing.found, false);
});

test('over Streamable HTTP and the SSE transport the entry is cut from the body or the event', async () => {
  for (const [kind, file] of [['streamable-http', 'http-server.mjs'], ['sse', 'sse-server.mjs']]) {
    const url = await listen(file, children);
    const { call, id } = await connectedBackend({ name: kind, transport: kind, url });
    await assertExact(call, id, 'tools', 'echo', 'name');
  }
});

// Synthetic units, for what the fixtures do not send.
function recorded(units) {
  const ws = createWorkspaceDb({ path: join(root, `${randomUUID()}.db`), workspaceId: randomUUID(), name: 'synthetic', custody: { kind: 'keychain' }, secrets: memoryStore() });
  const serverId = randomUUID();
  databases.push(ws);
  saveServer(ws, { id: serverId, name: 's', transport: 'stdio', command: 'x' });
  let t = 1000;
  const rec = HistoryRecorder.open(ws, serverId, () => t++);
  const ids = units.map((u) => rec.unit(u));
  return { ws, rec, ids, at: t };
}

test('multi-byte text before the entry still gives byte offsets, and an SSE event is cut past its data prefix', () => {
  const request = { direction: 'out', kind: 'wire', bytes: enc('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n') };
  const reply = '{"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"café","description":"中文 ✓"},{"name":"target","inputSchema":{}}]}}';
  const { ws, rec, at } = recorded([request, { direction: 'in', kind: 'wire', bytes: enc(`${reply}\n`) }]);
  const entry = rawEntry(ws.db, { connectionId: rec.connectionId, observedAt: at }, 'tools', 'target');
  assert.equal(text(entry.bytes), '{"name":"target","inputSchema":{}}');
  assert.equal(entry.offset, Buffer.byteLength(reply.slice(0, reply.indexOf('{"name":"target"'))));
  assert.equal(text(rawEntry(ws.db, { connectionId: rec.connectionId, observedAt: at }, 'tools', 'café').bytes), '{"name":"café","description":"中文 ✓"}');

  const sse = `event: message\ndata: ${reply}\n\n`;
  const s = recorded([request, { direction: 'in', kind: 'wire', bytes: enc(sse), http: { framing: 'sse-event' } }]);
  const fromSse = rawEntry(s.ws.db, { connectionId: s.rec.connectionId, observedAt: s.at }, 'tools', 'target');
  assert.equal(text(fromSse.bytes), '{"name":"target","inputSchema":{}}');
  assert.equal(text(enc(sse).subarray(fromSse.offset, fromSse.offset + fromSse.bytes.length)), text(fromSse.bytes));
});

test('the newest reply before the capture wins, a reply after it is ignored, and a batch is searched', () => {
  const req = (id) => ({ direction: 'out', kind: 'wire', bytes: enc(`{"jsonrpc":"2.0","id":${id},"method":"tools/list"}\n`) });
  const res = (id, d) => ({ direction: 'in', kind: 'wire', bytes: enc(`{"jsonrpc":"2.0","id":${id},"result":{"tools":[{"name":"t","description":"${d}"}]}}\n`) });
  const { ws, rec, ids } = recorded([req(1), res(1, 'old'), req(2), res(2, 'new'), req(3), res(3, 'later')]);
  const unitAt = (id) => ws.db.prepare('SELECT at FROM wire_unit WHERE id = ?').get(id).at;
  const entry = rawEntry(ws.db, { connectionId: rec.connectionId, observedAt: unitAt(ids[3]) }, 'tools', 't');
  assert.match(text(entry.bytes), /"new"/);

  const batch = recorded([
    { direction: 'out', kind: 'wire', bytes: enc('[{"jsonrpc":"2.0","id":7,"method":"prompts/list"}]\n') },
    { direction: 'in', kind: 'wire', bytes: enc('[{"jsonrpc":"2.0","id":7,"result":{"prompts":[{"name":"p"}]}}]\n') },
  ]);
  assert.equal(text(rawEntry(batch.ws.db, { connectionId: batch.rec.connectionId, observedAt: batch.at }, 'prompts', 'p').bytes), '{"name":"p"}');
});

test('with no connection or no reply left in the log, it says why instead of inventing bytes', () => {
  const { ws, rec, at } = recorded([]);
  assert.match(rawEntry(ws.db, { connectionId: null, observedAt: at }, 'tools', 'x').reason, /without a connection/);
  assert.match(rawEntry(ws.db, { connectionId: rec.connectionId, observedAt: at }, 'tools', 'x').reason, /no longer holds/);
});
