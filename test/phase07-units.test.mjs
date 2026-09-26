// Large units and purges in open views (phase 07 decision 9; deferred
// phase-04 review finding 10 and R05-9).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Backend } from '../packages/backend/dist/index.js';
import { memoryStore } from './support/memory-store.mjs';
import { fixtures } from './support/fixture-servers.mjs';
import { logRows } from '../app/renderer/src/lib/logrows.ts';

const root = mkdtempSync(join(tmpdir(), 'mcpx-units-'));
const backends = [];
after(async () => {
  for (const b of backends) await b.shutdown();
  rmSync(root, { recursive: true, force: true });
});

async function waitFor(check, ms = 15000) {
  const until = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > until) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function connected() {
  const backend = new Backend({ dataDir: mkdtempSync(join(root, 'data-')), secrets: memoryStore(), probeTimeoutMs: 1000, closeGraceMs: 300 });
  backends.push(backend);
  const events = [];
  backend.on((name, data) => events.push({ name, data }));
  const call = (method, params = {}) => backend.request(method, params);
  await call('workspaces.create', { name: 'Units', protection: { kind: 'none' } });
  const { id: serverId } = await call('servers.save', { server: { name: 'm', transport: 'stdio', command: process.execPath, args: [join(fixtures, 'modern-server.mjs')], env: { CALL_TOOLS: '1' } } });
  await call('connections.connect', { serverId });
  await waitFor(async () => (await call('surface.get', { serverId })).capture);
  const run = async (target, args) => {
    const { callId } = await call('calls.start', { serverId, kind: 'tool', target, args });
    return waitFor(async () => { const v = await call('calls.get', { callId }); return v.call.status !== 'in_progress' && !v.live ? v : null; });
  };
  return { call, events, serverId, run };
}

test('a unit over 256 KB is sent to the log without its bytes, with its head; log.get has it whole', async () => {
  const { call, events, serverId, run } = await connected();
  const view = await run('big', { bytes: 300_000 });
  const responseId = view.call.roundRecords[0].responseUnitId;
  const live = events.find((e) => e.name === 'log.unit' && e.data.id === responseId).data;
  assert.equal(live.bytes, null);
  assert.equal(live.omitted.head.length, 512);
  assert.ok(live.byteLength > 300_000);
  const listed = (await call('log.units', { serverId })).find((u) => u.id === responseId);
  assert.equal(listed.bytes, null, 'a page of the log leaves it out too');
  const whole = await call('log.get', { id: responseId });
  assert.equal(whole.bytes.length, whole.byteLength);
  assert.deepEqual(Buffer.from(whole.bytes.subarray(0, 512)), Buffer.from(live.omitted.head));
  const small = events.find((e) => e.name === 'log.unit' && e.data.id === view.call.roundRecords[0].requestUnitId).data;
  assert.ok(small.bytes, 'a small unit still travels whole');
  const [row] = logRows([live]);
  assert.match(row.preview, /^\{"jsonrpc"/, 'the row previews from the head');
});

test('R05-9: a purge that deletes anything tells open views to reload', async () => {
  const { call, events, run } = await connected();
  await run('add', { a: 1, b: 2 });
  assert.equal(events.filter((e) => e.name === 'log.purged').length, 0);
  await call('settings.update', { changes: { retentionMaxBytes: 1 } });
  const result = await call('history.purge');
  assert.ok(result.callsDeleted + result.unitsDeleted > 0);
  assert.equal(events.filter((e) => e.name === 'log.purged').length, 1);
});
