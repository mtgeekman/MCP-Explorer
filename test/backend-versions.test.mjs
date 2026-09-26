// The version history through the backend's API (plan phase 09): the
// acceptance criteria end to end, across real connects of the fixture with
// its definition edited between them, as a user would.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { O200K } from '../packages/protocol/dist/index.js';
import { Backend } from '../packages/backend/dist/index.js';
import { memoryStore } from './support/memory-store.mjs';
import { fixtures } from './support/fixture-servers.mjs';

const root = mkdtempSync(join(tmpdir(), 'mcpx-bversions-'));
const backends = [];
after(async () => {
  for (const b of backends) await b.shutdown();
  rmSync(root, { recursive: true, force: true });
});

async function setup() {
  const backend = new Backend({ dataDir: mkdtempSync(join(root, 'data-')), secrets: memoryStore(), probeTimeoutMs: 1000, closeGraceMs: 300 });
  backends.push(backend);
  const call = (method, params = {}) => backend.request(method, params);
  await call('workspaces.create', { name: 'Versions', protection: { kind: 'none' } });
  return call;
}

const server = (env, id) => ({ ...(id ? { id } : {}), name: 'echo server', transport: 'stdio', command: process.execPath, args: [join(fixtures, 'modern-server.mjs')], env });

/** Connect, let the capture land, disconnect: one observation. */
async function connectOnce(call, serverId) {
  const before = (await call('versions.list', { serverId })).entries.reduce((n, e) => n + e.observations, 0);
  await call('connections.connect', { serverId });
  const deadline = Date.now() + 10000;
  while ((await call('versions.list', { serverId })).entries.reduce((n, e) => n + e.observations, 0) === before) {
    if (Date.now() > deadline) throw new Error('the capture never landed');
    await new Promise((r) => setTimeout(r, 20));
  }
  await call('connections.disconnect', { serverId });
}

test('acceptance: a changed description, then a version bump, across three connects', async () => {
  const call = await setup();
  const { id } = await call('servers.save', { server: server({}) });
  await connectOnce(call, id);
  await call('servers.save', { server: server({ ECHO_DESCRIPTION: 'Echoes what it is given.' }, id) });
  await connectOnce(call, id);
  await call('servers.save', { server: server({ ECHO_DESCRIPTION: 'Echoes what it is given.', SERVER_VERSION: '1.1.0' }, id) });
  await connectOnce(call, id);

  const { entries, unstable } = await call('versions.list', { serverId: id });
  assert.deepEqual(entries.map((e) => [e.kind, e.version, e.changes, e.serverVersion]), [
    ['first', 1, 0, '0.0.0'], ['surface', 2, 1, '0.0.0'], ['identity', null, 0, '1.1.0'],
  ]);
  assert.deepEqual(unstable, { entries: 3, since: entries[0].firstObservedAt, until: entries[2].lastObservedAt }, 'three connects, three entries');

  const change = await call('versions.diff', { serverId: id, before: entries[0].snapshotId, after: entries[1].snapshotId });
  assert.deepEqual(change.structured.tools.map((t) => [t.key, t.kind, t.fields.map((f) => [f.path, f.before, f.after])]), [
    ['echo', 'changed', [['/description', 'Echoes its input.', 'Echoes what it is given.']]],
  ]);
  const cost = (d) => O200K.count(JSON.stringify({ name: 'echo', description: d, input_schema: { properties: { text: { description: 'What to echo.', type: 'string' } }, required: ['text'], type: 'object' } }));
  assert.equal(change.tokens.delta, cost('Echoes what it is given.') - cost('Echoes its input.'));
  assert.ok(JSON.parse(change.model.before).system.includes('\n## echo server\n'), 'the block uses the workspace\'s name for the server');

  const bump = await call('versions.diff', { serverId: id, before: entries[1].snapshotId, after: entries[2].snapshotId });
  assert.equal(bump.structured.tools.length, 0);
  assert.deepEqual(bump.structured.identityChanged, [{ field: 'serverVersion', from: '0.0.0', to: '1.1.0' }]);
  assert.deepEqual(bump.model.diff.hunks, []);
  assert.equal(bump.tokens.delta, 0);
});

test('a snapshot is compared only under its own server', async () => {
  const call = await setup();
  const a = await call('servers.save', { server: server({}) });
  const b = await call('servers.save', { server: { ...server({}), name: 'other' } });
  await connectOnce(call, a.id);
  const [entry] = (await call('versions.list', { serverId: a.id })).entries;
  await assert.rejects(call('versions.diff', { serverId: b.id, before: entry.snapshotId, after: entry.snapshotId }), { name: 'SnapshotNotFoundError' });
  await assert.rejects(call('versions.diff', { serverId: a.id, before: entry.snapshotId, after: 999999 }), { name: 'SnapshotNotFoundError' });
  assert.deepEqual(await call('versions.list', { serverId: b.id }), { entries: [] });
  await assert.rejects(call('versions.list', { serverId: 'nope' }));
});
