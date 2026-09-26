// Reading calls back, the two endings migration 6 adds, and the repair of
// what a crash leaves in progress (D23, D24; phase 07 decision 7).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  createWorkspaceDb, openWorkspaceDb, saveServer, HistoryRecorder, listCalls, readCall, repairInterrupted, purgeHistory,
} from '../packages/storage/dist/index.js';
import { frame } from './support/units.mjs';

const root = mkdtempSync(join(tmpdir(), 'mcpx-calls-'));
after(() => rmSync(root, { recursive: true, force: true }));
const noSecrets = { get: () => null, set: () => { throw new Error('unexpected keychain write'); }, delete: () => false };

function setup({ persistResults = true } = {}) {
  const path = join(root, `${randomUUID()}.db`);
  const workspaceId = randomUUID();
  const ws = createWorkspaceDb({ path, workspaceId, name: 'calls', custody: { kind: 'none' }, secrets: noSecrets });
  if (!persistResults) ws.db.prepare('UPDATE workspace_meta SET persist_results = 0').run();
  const serverId = randomUUID();
  saveServer(ws, { id: serverId, name: 'fixture', transport: 'stdio', command: 'node' });
  let t = 1000;
  const clock = () => t++;
  const rec = HistoryRecorder.open(ws, serverId, clock);
  return { ws, rec, serverId, path, workspaceId, clock };
}

const call = (id, name, args) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
const reply = (id, result) => ({ jsonrpc: '2.0', id, result });

test('a finished call reads back with its round, its arguments, its result and the units that carried them', () => {
  const { ws, rec, serverId } = setup();
  const id = rec.beginCall('tool', 'add');
  const seq = rec.beginRound(id, { a: 1, b: 2 });
  const out = frame(rec, 'out', call(7, 'add', { a: 1, b: 2 }));
  const back = frame(rec, 'in', reply(7, { content: [{ type: 'text', text: '3' }] }));
  rec.finishRound(id, seq, { result: { content: [{ type: 'text', text: '3' }] }, resultType: 'complete' });
  rec.finishCall(id, 'completed');

  const [summary] = listCalls(ws, serverId);
  assert.equal(summary.id, id);
  assert.equal(summary.status, 'completed');
  assert.equal(summary.rounds, 1);
  const record = readCall(ws, id);
  assert.equal(record.roundRecords.length, 1);
  const r = record.roundRecords[0];
  assert.deepEqual(r.arguments, { a: 1, b: 2 });
  assert.deepEqual(r.result, { content: [{ type: 'text', text: '3' }] });
  assert.equal(r.requestUnitId, out);
  assert.equal(r.responseUnitId, back);
  assert.equal(r.resultWithheld, false);
  ws.close();
});

test('under the opt-out a call reads back with its result withheld, and says so', () => {
  const { ws, rec } = setup({ persistResults: false });
  const id = rec.beginCall('tool', 'add');
  const seq = rec.beginRound(id, { a: 1, b: 2 });
  frame(rec, 'out', call(1, 'add', { a: 1, b: 2 }));
  frame(rec, 'in', reply(1, { content: [] }));
  rec.finishRound(id, seq, { result: { content: [] }, resultType: 'complete' });
  rec.finishCall(id, 'completed');
  const r = readCall(ws, id).roundRecords[0];
  assert.equal(r.result, null);
  assert.equal(r.resultWithheld, true);
  assert.deepEqual(r.arguments, { a: 1, b: 2 }, 'what the user sent is kept');
  ws.close();
});

test('calls list newest first and page by id', () => {
  const { ws, rec, serverId } = setup();
  const ids = [1, 2, 3].map((n) => {
    const id = rec.beginCall('tool', `t${n}`);
    rec.finishCall(id, 'abandoned');
    return id;
  });
  assert.deepEqual(listCalls(ws, serverId).map((c) => c.id), [...ids].reverse());
  assert.deepEqual(listCalls(ws, serverId, { before: ids[2], limit: 1 }).map((c) => c.id), [ids[1]]);
  assert.equal(readCall(ws, 999), undefined);
  ws.close();
});

test('migration 6: a call can end cancelled or interrupted', () => {
  const { ws, rec } = setup();
  for (const status of ['cancelled', 'interrupted']) {
    const id = rec.beginCall('tool', 'slow');
    rec.beginRound(id, {});
    rec.finishCall(id, status);
    assert.equal(readCall(ws, id).status, status);
  }
  ws.close();
});

test('a call left in progress by a crash is marked interrupted at the next open, and retention can then purge it', () => {
  const { ws, rec, serverId, path, workspaceId } = setup();
  const id = rec.beginCall('tool', 'slow');
  rec.beginRound(id, {});
  frame(rec, 'out', call(1, 'slow', {}));
  // The app dies here: no finishRound, no finishCall, no close.
  ws.close();

  const again = openWorkspaceDb({ path, workspaceId, custody: { kind: 'none' }, secrets: noSecrets });
  assert.deepEqual(repairInterrupted(again), { calls: 1, connections: 1 });
  const record = readCall(again, id);
  assert.equal(record.status, 'interrupted');
  assert.notEqual(record.finishedAt, null);
  assert.notEqual(record.roundRecords[0].finishedAt, null);
  assert.ok(record.finishedAt >= record.startedAt, 'finished at its last unit, not before it started');
  const conn = again.db.prepare('SELECT closed_at FROM connection').get();
  assert.notEqual(conn.closed_at, null);
  assert.deepEqual(repairInterrupted(again), { calls: 0, connections: 0 }, 'a second open repairs nothing');

  // Before the repair, retention never purged an in-progress call; now it can.
  again.db.prepare('UPDATE workspace_meta SET retention_max_age_days = 1').run();
  purgeHistory(again, () => Date.now() + 10 * 86_400_000);
  assert.deepEqual(listCalls(again, serverId), []);
  again.close();
});
