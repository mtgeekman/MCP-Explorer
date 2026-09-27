// Surface capture in the backend (plan phase 06): listed on connect and on
// Refresh, recorded as snapshots, never re-listed on the server's say-so (P2),
// and the workspace union built from each server's latest capture (D3).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Backend } from '../packages/backend/dist/index.js';
import { memoryStore } from './support/memory-store.mjs';
import { fixtures } from './support/fixture-servers.mjs';

const root = mkdtempSync(join(tmpdir(), 'mcpx-surface-'));
const backends = [];
after(async () => {
  for (const b of backends) await b.shutdown();
  rmSync(root, { recursive: true, force: true });
});

async function setup() {
  const backend = new Backend({ dataDir: mkdtempSync(join(root, 'data-')), secrets: memoryStore(), closeGraceMs: 300 });
  backends.push(backend);
  const events = [];
  backend.on((name, data) => { if (name === 'surface.changed') events.push(data.serverId); });
  const call = (method, params = {}) => backend.request(method, params);
  await call('workspaces.create', { name: 'Surfaces', protection: { kind: 'none' } });
  return { call, events };
}

const stdio = (name, file, env) => ({ name, transport: 'stdio', command: process.execPath, args: [join(fixtures, file)], ...(env ? { env } : {}) });

async function until(check, what, ms = 10000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Connects and waits for the capture that connecting starts. */
async function connected(call, server) {
  const row = await call('servers.save', { server });
  const state = await call('connections.connect', { serverId: row.id });
  assert.equal(state.status, 'connected');
  const view = await until(async () => {
    const v = await call('surface.get', { serverId: row.id });
    return !v.status.capturing && (v.capture || v.status.error) ? v : undefined;
  }, 'the capture on connect');
  return { id: row.id, view };
}

const outgoing = async (call, serverId, method) => (await call('log.units', { serverId }))
  .filter((u) => u.direction === 'out')
  .flatMap((u) => u.frames).filter((f) => f.method === method).length;

test('connecting captures the surface and records it, and the lists are in the wire log', async () => {
  const { call, events } = await setup();
  const { id, view } = await connected(call, stdio('modern', 'modern-server.mjs'));
  assert.equal(view.status.error, undefined);
  assert.deepEqual(view.capture.surface.tools.map((t) => t.name).sort(), ['echo', 'needs_input']);
  assert.equal(view.capture.surface.prompts[0].name, 'greet');
  assert.equal(view.capture.surface.revision, '2026-07-28');
  assert.ok(view.capture.connectionId > 0);
  assert.ok(events.includes(id), 'the renderer is told the capture changed');
  assert.equal(await outgoing(call, id, 'tools/list'), 1, 'P1: the capture went over the logged wire');
});

test('a server with nothing captured yet has no surface, and Refresh needs a connection', async () => {
  const { call } = await setup();
  const row = await call('servers.save', { server: stdio('never', 'modern-server.mjs') });
  const view = await call('surface.get', { serverId: row.id });
  assert.equal(view.capture, null);
  assert.deepEqual(view.status, { capturing: false, changed: [] });
  await assert.rejects(call('surface.refresh', { serverId: row.id }), /not connected/);
  await assert.rejects(call('surface.get', { serverId: 'nope' }), /no server nope/);
});

test('a change notice is shown, nothing is re-listed on its own, and Refresh records the new surface (P2)', async () => {
  const { call } = await setup();
  const { id, view } = await connected(call, stdio('changing', 'legacy-server.mjs', { LIST_CHANGED: '1' }));
  const first = view.capture.snapshotId;
  const noticed = await until(async () => {
    const v = await call('surface.get', { serverId: id });
    return v.status.changed.length ? v : undefined;
  }, 'the list_changed notice');
  assert.deepEqual(noticed.status.changed, ['tools']);
  // Give an automatic re-list every chance to happen; it must not.
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(await outgoing(call, id, 'tools/list'), 1, 'no tools/list the user did not ask for');

  const refreshed = await call('surface.refresh', { serverId: id });
  assert.deepEqual(refreshed.status.changed, []);
  assert.notEqual(refreshed.capture.snapshotId, first, 'a changed surface is a new snapshot');
  assert.deepEqual(refreshed.capture.surface.tools.map((t) => t.name), ['echo', 'added_later']);
  assert.equal(await outgoing(call, id, 'tools/list'), 2);
});

test('a session that ends in the middle of a capture records nothing', async () => {
  const { call } = await setup();
  const { id, view } = await connected(call, stdio('dies', 'legacy-server.mjs', { DIE_ON_LIST: '1' }));
  assert.equal(view.capture, null, 'no empty surface stored as a version');
  assert.match(view.status.error, /session ended during the capture/);
  await until(async () => (await call('servers.list')).find((s) => s.id === id).state.status === 'ended', 'the session to end');
});

test('two concurrent Refreshes share one capture', async () => {
  const { call } = await setup();
  const { id } = await connected(call, stdio('modern', 'modern-server.mjs'));
  await Promise.all([call('surface.refresh', { serverId: id }), call('surface.refresh', { serverId: id })]);
  assert.equal(await outgoing(call, id, 'tools/list'), 2, 'one on connect, one for both refreshes');
});

test('the workspace union: each latest capture, connected or not, an exclusion, the collision, and a server with none', async () => {
  const { call } = await setup();
  const legacy = await connected(call, stdio('b legacy', 'legacy-server.mjs'));
  const modern = await connected(call, stdio('a modern', 'modern-server.mjs'));
  const none = await call('servers.save', { server: stdio('c never', 'modern-server.mjs') });
  await call('connections.disconnect', { serverId: legacy.id });

  const all = await call('context.get', {});
  assert.deepEqual(all.servers.map((s) => [s.name, s.capturedAt !== null]), [['a modern', true], ['b legacy', true], ['c never', false]]);
  assert.deepEqual(all.cost.collisions, [{ name: 'echo', serverIds: [modern.id, legacy.id] }]);
  assert.equal(all.cost.tokenizer.id, 'o200k_base');
  assert.deepEqual(JSON.parse(all.text).tools.map((t) => t.name), ['echo', 'needs_input', 'echo']);
  assert.equal(all.cost.servers.length, 2, 'a server with no capture adds nothing');

  const some = await call('context.get', { excluded: [modern.id] });
  assert.equal(some.servers.length, 3, 'a server left out is still listed, so it can be put back');
  assert.deepEqual(some.cost.servers.map((s) => s.serverId), [legacy.id]);
  assert.deepEqual(JSON.parse(some.text).tools.map((t) => t.name), ['echo']);
  assert.deepEqual(some.cost.collisions, []);
  assert.equal(none.state.status, 'idle');
});

test('the backend never passes the SDK listChanged option (it re-lists on its own)', () => {
  const src = readFileSync(new URL('../packages/protocol/src/client.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src.replace(/\/\/.*$/gm, ''), /listChanged\s*:/);
});
