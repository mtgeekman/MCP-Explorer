// Phase 10 through the backend's API: the log level, subscriptions, the
// listen stream, the notifications timeline, and the change notice with its
// Refresh (decisions 1, 5 to 8), against real connects of the fixture.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Backend } from '../packages/backend/dist/index.js';
import { memoryStore } from './support/memory-store.mjs';
import { fixtures } from './support/fixture-servers.mjs';

const root = mkdtempSync(join(tmpdir(), 'mcpx-bsession-'));
const backends = [];
after(async () => {
  for (const b of backends) await b.shutdown();
  rmSync(root, { recursive: true, force: true });
});

const until = async (check, what, ms = 10000) => {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

async function connected(file, env = {}) {
  const backend = new Backend({ dataDir: mkdtempSync(join(root, 'data-')), secrets: memoryStore(), probeTimeoutMs: 1000, closeGraceMs: 300 });
  backends.push(backend);
  const events = [];
  backend.on((name, data) => events.push({ name, data }));
  const call = (method, params = {}) => backend.request(method, params);
  await call('workspaces.create', { name: 'Session', protection: { kind: 'none' } });
  const { id } = await call('servers.save', { server: { name: 'fixture', transport: 'stdio', command: process.execPath, args: [join(fixtures, file)], env: { EXTRAS: '1', ...env } } });
  await call('connections.connect', { serverId: id });
  await until(async () => (await call('surface.get', { serverId: id })).capture !== null, 'the first capture');
  return { call, id, events };
}

const toolNames = async (call, id) => (await call('surface.get', { serverId: id })).capture.surface.tools.map((t) => t.name);

for (const [era, file] of [['legacy', 'legacy-server.mjs'], ['modern', 'modern-server.mjs']]) {
  test(`acceptance (decision 1), ${era}: a mid-session tool change produces a new snapshot on the user's Refresh, with no reconnect`, async () => {
    const { call, id } = await connected(file);
    const connectionId = (await call('connections.connect', { serverId: id })).connectionId;
    if (era === 'modern') await call('session.listen', { serverId: id, filter: { toolsListChanged: true } });
    if (era === 'modern') await until(async () => (await call('session.get', { serverId: id })).listen?.acknowledged, 'the acknowledgement');
    await call('calls.start', { serverId: id, kind: 'tool', target: 'mutate', args: {}, confirmed: true });
    await until(async () => (await call('surface.get', { serverId: id })).status.changed.includes('tools'), 'the notice');
    assert.ok(!(await toolNames(call, id)).includes('mutated'), 'P2: nothing re-listed on the notice alone');
    const refreshed = await call('surface.refresh', { serverId: id });
    assert.ok(refreshed.capture.surface.tools.some((t) => t.name === 'mutated'));
    assert.deepEqual(refreshed.status.changed, []);
    const versions = await call('versions.list', { serverId: id });
    assert.equal(versions.entries.length, 2, 'a second snapshot');
    assert.equal((await call('connections.connect', { serverId: id })).connectionId, connectionId, 'the same session throughout');
  });

  test(`acceptance (decision 5), ${era}: a log level takes effect and messages appear in the timeline`, async () => {
    const { call, id } = await connected(file);
    const outcome = await call('session.setLogLevel', { serverId: id, level: 'alert' });
    if (era === 'legacy') assert.equal(outcome.kind, 'result'); else assert.equal(outcome, null);
    assert.equal((await call('session.get', { serverId: id })).logLevel, 'alert');
    await call('calls.start', { serverId: id, kind: 'tool', target: 'log_burst', args: {}, confirmed: true });
    await until(async () => (await call('notifications.list', { serverId: id })).filter((n) => n.method === 'notifications/message').length === 2, 'two messages');
    const rows = await call('notifications.list', { serverId: id });
    assert.deepEqual(rows.filter((n) => n.method === 'notifications/message').map((n) => n.params.level), ['alert', 'emergency']);
  });

  test(`acceptance (decision 7), ${era}: one subscribe control, and the update reaches the session`, async () => {
    const { call, id } = await connected(file);
    await call('session.subscribe', { serverId: id, uri: 'fixture://sized', on: true });
    const info = await call('session.get', { serverId: id });
    assert.deepEqual(info.subscribed, ['fixture://sized']);
    if (era === 'modern') {
      assert.deepEqual(info.listen.filter, { resourceSubscriptions: ['fixture://sized'] });
      await until(async () => (await call('session.get', { serverId: id })).listen.acknowledged, 'the acknowledgement');
    }
    await call('calls.start', { serverId: id, kind: 'tool', target: 'touch', args: { uri: 'fixture://sized' }, confirmed: true });
    await until(async () => (await call('session.get', { serverId: id })).updated['fixture://sized'] !== undefined, 'the update');
    await call('session.subscribe', { serverId: id, uri: 'fixture://sized', on: false });
    assert.deepEqual((await call('session.get', { serverId: id })).subscribed, []);
  });
}

test('ping and completion through the backend, and ping refused on modern', async () => {
  const legacy = await connected('legacy-server.mjs');
  assert.equal((await legacy.call('session.request', { serverId: legacy.id, method: 'ping' })).kind, 'result');
  const done = await legacy.call('session.request', { serverId: legacy.id, method: 'completion/complete', params: { ref: { type: 'ref/prompt', name: 'pick' }, argument: { name: 'language', value: 'r' } } });
  assert.deepEqual(done.result.completion.values, ['rust']);
  const modern = await connected('modern-server.mjs');
  assert.equal((await modern.call('session.request', { serverId: modern.id, method: 'ping' })).kind, 'failed');
  await assert.rejects(modern.call('session.request', { serverId: modern.id, method: 'logging/setLevel', params: { level: 'info' } }));
});

test('the session\'s settings end with it', async () => {
  const { call, id } = await connected('modern-server.mjs');
  await call('session.setLogLevel', { serverId: id, level: 'info' });
  await call('session.listen', { serverId: id, filter: { toolsListChanged: true } });
  await call('connections.disconnect', { serverId: id });
  assert.deepEqual(await call('session.get', { serverId: id }), { connected: false, logLevel: null, subscribed: [], updated: {}, listen: null });
});
