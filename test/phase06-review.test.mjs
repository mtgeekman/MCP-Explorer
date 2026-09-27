// Phase 06 code-review findings, pinned (R06-n). Each test names its finding.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { captureSurface } from '../packages/protocol/dist/index.js';
import { createWorkspaceDb, saveServer, HistoryRecorder } from '../packages/storage/dist/index.js';
import { Backend, rawEntry } from '../packages/backend/dist/index.js';
import { memoryStore } from './support/memory-store.mjs';
import { fixtures, listen } from './support/fixture-servers.mjs';

const root = mkdtempSync(join(tmpdir(), 'mcpx-r06-'));
const backends = [];
const children = [];
const databases = [];
after(async () => {
  for (const b of backends) await b.shutdown();
  for (const c of children) c.kill();
  for (const ws of databases) ws.close();
  rmSync(root, { recursive: true, force: true });
});

async function setup() {
  const backend = new Backend({ dataDir: mkdtempSync(join(root, 'data-')), secrets: memoryStore(), closeGraceMs: 300 });
  backends.push(backend);
  const call = (method, params = {}) => backend.request(method, params);
  await call('workspaces.create', { name: 'R06', protection: { kind: 'none' } });
  return call;
}

async function until(check, what, ms = 10000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const legacyStdio = (env) => ({ name: 'legacy', transport: 'stdio', command: process.execPath, args: [join(fixtures, 'legacy-server.mjs')], env });
const settled = (call, serverId) => until(async () => {
  const v = await call('surface.get', { serverId });
  return v.status.capturing ? undefined : v;
}, 'the capture to settle');

// R06-1 and R06-2 are pins, not regression tests: both findings were refuted,
// passing on the code as reviewed. They hold the property against later change.
test('R06-1: a capture still running from an earlier session does not stand in for the next session\'s', async () => {
  const call = await setup();
  const row = await call('servers.save', { server: legacyStdio({ HANG_ONCE_FILE: join(root, `${randomUUID()}.once`) }) });
  await call('connections.connect', { serverId: row.id });
  await until(async () => (await call('surface.get', { serverId: row.id })).status.capturing, 'the first capture to hang');
  await call('connections.redetect', { serverId: row.id });
  const view = await settled(call, row.id);
  assert.equal(view.status.error, undefined, 'the new session\'s capture is its own');
  assert.deepEqual(view.capture?.surface.tools.map((t) => t.name), ['echo']);
  assert.deepEqual(view.status.changed, []);
});

test('R06-2: disconnecting an HTTP server in the middle of a capture records no surface', async () => {
  const call = await setup();
  const url = await listen('http-server.mjs', children, { LEGACY: '1', HANG_ON_LIST: '1' });
  const row = await call('servers.save', { server: { name: 'http', transport: 'streamable-http', url } });
  assert.equal((await call('connections.connect', { serverId: row.id })).status, 'connected');
  await until(async () => (await call('surface.get', { serverId: row.id })).status.capturing, 'the capture to hang');
  await call('connections.disconnect', { serverId: row.id });
  const view = await settled(call, row.id);
  assert.equal(view.capture, null, 'no empty surface stored as a version');
});

test('R06-3: a capture where a list failed is not recorded, and the last good capture stays', async () => {
  const call = await setup();
  const row = await call('servers.save', { server: legacyStdio({ FAIL_LIST_AFTER: '1' }) });
  await call('connections.connect', { serverId: row.id });
  const good = await settled(call, row.id);
  assert.deepEqual(good.capture.surface.tools.map((t) => t.name), ['echo']);
  const after = await call('surface.refresh', { serverId: row.id });
  assert.equal(after.capture.snapshotId, good.capture.snapshotId, 'no new version from a failed list');
  assert.equal(after.capture.observedAt, good.capture.observedAt, 'not even a new observation');
  // Shown as this session's partial capture since R06-11, never recorded.
  assert.deepEqual(after.partial.surface.problems.map((p) => [p.endpoint, p.kind]), [['tools/list', 'list-failed']]);
  assert.match(after.partial.surface.problems[0].message, /tools\/list failed on purpose/);
});

test('R06-3: capture tells a failed list from duplicate keys, and a surface with duplicates is still whole', async () => {
  const s = await captureSurface({
    revision: '2025-06-18', era: 'legacy', capabilities: { tools: {}, prompts: {} },
    listTools: async () => ({ items: [{ name: 'a' }, { name: 'a' }] }),
    listPrompts: async () => { throw new Error('nope'); },
  });
  assert.deepEqual(s.problems.filter((p) => p.kind !== 'malformed').map((p) => [p.endpoint, p.kind]), [['prompts/list', 'list-failed'], ['tools/list', 'duplicate-keys']]);
});

test('R06-4: after a new capture the selected entry is re-read from it, or dropped when it is gone', async () => {
  const { reselect } = await import('../app/renderer/src/lib/surface.ts');
  const selected = { serverId: 's', list: 'tools', key: 'echo', item: { name: 'echo', description: 'old' }, revision: '2025-06-18' };
  const surface = (tools) => ({ revision: '2025-11-25', tools, prompts: [], resources: [], resourceTemplates: [] });
  const next = reselect(selected, surface([{ name: 'echo', description: 'new' }]));
  assert.deepEqual(next, { ...selected, item: { name: 'echo', description: 'new' }, revision: '2025-11-25' });
  assert.equal(reselect(selected, surface([{ name: 'other' }])), null);
  assert.equal(reselect(selected, undefined), null);
});

test('R06-5: only the newest request\'s answer is applied', async () => {
  const { latestOnly } = await import('../app/renderer/src/lib/latest.ts');
  const applied = [];
  const run = latestOnly();
  let resolveFirst;
  const first = run(new Promise((r) => { resolveFirst = r; }), (v) => applied.push(v), () => {});
  const second = run(Promise.resolve('new'), (v) => applied.push(v), () => {});
  await second;
  resolveFirst('old');
  await first;
  assert.deepEqual(applied, ['new']);
});

test('R06-9: an entry in a multi-line SSE event is not reported as purged', () => {
  const ws = createWorkspaceDb({ path: join(root, `${randomUUID()}.db`), workspaceId: randomUUID(), name: 'sse', custody: { kind: 'keychain' }, secrets: memoryStore() });
  databases.push(ws);
  const serverId = randomUUID();
  saveServer(ws, { id: serverId, name: 's', transport: 'sse', url: 'http://x' });
  let t = 1;
  const rec = HistoryRecorder.open(ws, serverId, () => t++);
  const enc = (s) => new Uint8Array(Buffer.from(s, 'utf8'));
  rec.unit({ direction: 'out', kind: 'wire', bytes: enc('{"jsonrpc":"2.0","id":1,"method":"tools/list"}') });
  rec.unit({ direction: 'in', kind: 'wire', http: { framing: 'sse-event' },
    bytes: enc('event: message\ndata: {"jsonrpc":"2.0","id":1,\ndata: "result":{"tools":[{"name":"t"}]}}\n\n') });
  const entry = rawEntry(ws.db, { connectionId: rec.connectionId, observedAt: t }, 'tools', 't');
  assert.equal(entry.found, false);
  assert.doesNotMatch(entry.reason, /purged/);
  assert.match(entry.reason, /several data lines/);
});

test('R06-10: the context view lists servers without an included flag the screen no longer reads', async () => {
  const call = await setup();
  await call('servers.save', { server: legacyStdio() });
  const [row] = (await call('context.get', {})).servers;
  assert.equal('included' in row, false);
});

// --- Re-review of the fix chain (R06-11 to R06-15) ---------------------------------------

test('R06-11: a server whose prompts/list always fails still shows what it did list, for the session, marked partial', async () => {
  const call = await setup();
  const row = await call('servers.save', { server: { name: 'liar', transport: 'stdio', command: process.execPath, args: [join(fixtures, 'modern-server.mjs')], env: { LIE_ABOUT: 'prompts' } } });
  await call('connections.connect', { serverId: row.id });
  const view = await settled(call, row.id);
  assert.equal(view.capture, null, 'history holds only whole surfaces');
  assert.deepEqual(view.partial.surface.tools.map((t) => t.name).sort(), ['echo', 'needs_input']);
  assert.deepEqual(view.partial.surface.problems.map((p) => [p.endpoint, p.kind]), [['prompts/list', 'list-failed']]);
  assert.equal(view.status.error, undefined, 'a partial capture is not an error');
  const entry = await call('surface.entry', { serverId: row.id, list: 'tools', key: 'echo' });
  assert.equal(entry.found, true, 'the partial capture\'s entries open on their bytes');
  assert.equal((await call('context.get', {})).cost.servers.length, 0, 'the context preview uses whole captures only');
  await call('connections.disconnect', { serverId: row.id });
  assert.equal((await call('surface.get', { serverId: row.id })).partial, null, 'session only');
});

test('R06-12: the failed state reads the problem kind, and duplicates never read as failed', async () => {
  const { listState } = await import('../app/renderer/src/lib/surface.ts');
  const s = (problems) => ({ revision: '2026-07-28', capabilities: { tools: {} }, tools: [{ name: 'a' }], prompts: [], resources: [], resourceTemplates: [], problems });
  assert.equal(listState(s([{ endpoint: 'tools/list', kind: 'duplicate-keys', message: 'x' }]), 'tools').kind, 'items');
  assert.equal(listState(s([{ endpoint: 'tools/list', kind: 'list-failed', message: 'duplicate identity key lookalike' }]), 'tools').kind, 'failed');
  assert.equal(listState(s([{ endpoint: 'tools/list', message: 'stored before kinds' }]), 'tools').kind, 'failed');
});

test('R06-13: a superseded request\'s failure is dropped too', async () => {
  const { latestOnly } = await import('../app/renderer/src/lib/latest.ts');
  const errors = [];
  const run = latestOnly();
  let rejectFirst;
  const first = run(new Promise((_, rej) => { rejectFirst = rej; }), () => {}, (e) => errors.push(e.message));
  await run(Promise.resolve('new'), () => {}, (e) => errors.push(e.message));
  rejectFirst(new Error('old'));
  await first;
  await run(Promise.reject(new Error('current')), () => {}, (e) => errors.push(e.message));
  assert.deepEqual(errors, ['current']);
});

test('R06-15: reselect keeps the same selection when the entry did not change', async () => {
  const { reselect } = await import('../app/renderer/src/lib/surface.ts');
  const selected = { serverId: 's', list: 'tools', key: 'echo', item: { name: 'echo', description: 'same' }, revision: '2025-06-18' };
  const surface = { revision: '2025-06-18', tools: [{ name: 'echo', description: 'same' }], prompts: [], resources: [], resourceTemplates: [] };
  assert.equal(reselect(selected, surface), selected);
});
