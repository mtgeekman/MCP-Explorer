// Requests a legacy-era server sends the client, recorded (phase 08
// decision 4; D23 amended; migration 7): linked to a call only when the
// caller says so, withheld under the opt-out (D30), ended once, found with
// the units that carried them, and repaired after a crash.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  createWorkspaceDb, saveServer, HistoryRecorder, HistoryStateError, listServerRequests, readServerRequest, repairInterrupted, purgeHistory,
} from '../packages/storage/dist/index.js';
import { frame } from './support/units.mjs';

const root = mkdtempSync(join(tmpdir(), 'mcpx-srvreq-'));
after(() => rmSync(root, { recursive: true, force: true }));
const noSecrets = { get: () => null, set: () => { throw new Error('unexpected keychain write'); }, delete: () => false };

function setup({ persistResults = true } = {}) {
  const ws = createWorkspaceDb({ path: join(root, `${randomUUID()}.db`), workspaceId: randomUUID(), name: 'requests', custody: { kind: 'none' }, secrets: noSecrets });
  if (!persistResults) ws.db.prepare('UPDATE workspace_meta SET persist_results = 0').run();
  const serverId = randomUUID();
  saveServer(ws, { id: serverId, name: 'fixture', transport: 'stdio', command: 'node' });
  let t = 1000;
  const rec = HistoryRecorder.open(ws, serverId, () => t++);
  return { ws, rec, serverId };
}

const sampling = (id) => ({ jsonrpc: '2.0', id, method: 'sampling/createMessage', params: { messages: [{ role: 'user', content: { type: 'text', text: 'hi' } }], maxTokens: 5 } });
const answer = { role: 'assistant', content: { type: 'text', text: 'hello' }, model: 'human', stopReason: 'endTurn' };

test('a request linked to a running call reads back with its params, its answer and both units', () => {
  const { ws, rec, serverId } = setup();
  const callId = rec.beginCall('tool', 'ask_sampling');
  rec.beginRound(callId, {});
  const inUnit = frame(rec, 'in', sampling(0));
  const id = rec.receiveRequest(0, 'sampling/createMessage', sampling(0).params, callId);
  assert.equal(readServerRequest(ws, id).status, 'pending');
  rec.finishRequest(id, 'answered', answer);
  const outUnit = frame(rec, 'out', { jsonrpc: '2.0', id: 0, result: answer });

  const r = readServerRequest(ws, id);
  assert.equal(r.callId, callId);
  assert.equal(r.serverId, serverId);
  assert.equal(r.jsonrpcId, '0');
  assert.equal(r.status, 'answered');
  assert.deepEqual(r.params, sampling(0).params);
  assert.deepEqual(r.response, answer);
  assert.equal(r.requestUnitId, inUnit);
  assert.equal(r.responseUnitId, outUnit);
  assert.notEqual(r.finishedAt, null);
  assert.deepEqual(listServerRequests(ws, { callId }).map((x) => x.id), [id]);
  ws.close();
});

test('an outgoing request of the client that reuses the server id is not taken for the answer', () => {
  const { ws, rec } = setup();
  frame(rec, 'in', sampling(3));
  const id = rec.receiveRequest(3, 'sampling/createMessage', {}, null);
  // The client's own request id 3 goes out before the human answers.
  frame(rec, 'out', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'x' } });
  assert.equal(readServerRequest(ws, id).responseUnitId, null);
  rec.finishRequest(id, 'answered', answer);
  const outUnit = frame(rec, 'out', { jsonrpc: '2.0', id: 3, result: answer });
  assert.equal(readServerRequest(ws, id).responseUnitId, outUnit);
  ws.close();
});

test('a call id the recorder does not have open is not linked', () => {
  const { ws, rec } = setup();
  frame(rec, 'in', sampling('a'));
  const id = rec.receiveRequest('a', 'sampling/createMessage', {}, 999);
  const r = readServerRequest(ws, id);
  assert.equal(r.callId, null);
  assert.equal(r.jsonrpcId, '"a"', 'a string id keeps its type');
  ws.close();
});

test('under the opt-out the params and the answer are withheld, and the row says so', () => {
  const { ws, rec, serverId } = setup({ persistResults: false });
  frame(rec, 'in', sampling(1));
  const id = rec.receiveRequest(1, 'sampling/createMessage', sampling(1).params, null);
  rec.finishRequest(id, 'answered', answer);
  const [r] = listServerRequests(ws, { serverId });
  assert.equal(r.withheld, true);
  assert.equal(r.params, null);
  assert.equal(r.response, null);
  ws.close();
});

test('the opt-out turned on while a request is pending withholds its answer and marks the row', () => {
  const { ws, rec } = setup();
  frame(rec, 'in', sampling(1));
  const id = rec.receiveRequest(1, 'sampling/createMessage', sampling(1).params, null);
  ws.db.prepare('UPDATE workspace_meta SET persist_results = 0').run();
  rec.finishRequest(id, 'answered', answer);
  const r = readServerRequest(ws, id);
  assert.equal(r.withheld, true);
  assert.equal(r.response, null);
  ws.close();
});

test('a request ends once', () => {
  const { ws, rec } = setup();
  frame(rec, 'in', sampling(1));
  const id = rec.receiveRequest(1, 'sampling/createMessage', {}, null);
  rec.finishRequest(id, 'cancelled');
  assert.throws(() => rec.finishRequest(id, 'answered', answer), HistoryStateError);
  assert.equal(readServerRequest(ws, id).status, 'cancelled');
  ws.close();
});

test('a server list is newest first and capped', () => {
  const { ws, rec, serverId } = setup();
  const ids = [1, 2, 3].map((n) => { frame(rec, 'in', sampling(n)); return rec.receiveRequest(n, 'sampling/createMessage', {}, null); });
  assert.deepEqual(listServerRequests(ws, { serverId }).map((r) => r.id), [...ids].reverse());
  assert.equal(listServerRequests(ws, { serverId, limit: 2 }).length, 2);
  ws.close();
});

test('a pending request is marked interrupted at the next open, and a finished one is left alone', () => {
  const { ws, rec } = setup();
  frame(rec, 'in', sampling(1));
  const pending = rec.receiveRequest(1, 'sampling/createMessage', {}, null);
  frame(rec, 'in', sampling(2));
  const done = rec.receiveRequest(2, 'sampling/createMessage', {}, null);
  rec.finishRequest(done, 'refused', { error: { code: -1, message: 'User rejected sampling request' } });
  const repaired = repairInterrupted(ws);
  assert.equal(repaired.serverRequests, 1);
  assert.equal(readServerRequest(ws, pending).status, 'interrupted');
  assert.notEqual(readServerRequest(ws, pending).finishedAt, null);
  assert.equal(readServerRequest(ws, done).status, 'refused');
  ws.close();
});

test('a linked request goes when retention purges its call', () => {
  const { ws, rec } = setup();
  const callId = rec.beginCall('tool', 'ask_sampling');
  const seq = rec.beginRound(callId, {});
  frame(rec, 'in', sampling(1));
  const id = rec.receiveRequest(1, 'sampling/createMessage', {}, callId);
  rec.finishRequest(id, 'answered', answer);
  rec.finishRound(callId, seq, { result: { content: [] } });
  rec.finishCall(callId, 'completed');
  ws.db.prepare('UPDATE workspace_meta SET retention_max_age_days = 1').run();
  purgeHistory(ws, () => 1000 + 3 * 86_400_000);
  assert.equal(readServerRequest(ws, id), undefined);
  ws.close();
});
