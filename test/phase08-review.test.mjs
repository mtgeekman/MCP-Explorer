// Pins for the phase 08 code review's findings (R08-n), each named. The
// pipeline and the request desk are driven directly, with a real workspace
// and a stand-in connection, so each timing is exact rather than raced.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createWorkspaceDb, saveServer, HistoryRecorder, readServerRequest } from '../packages/storage/dist/index.js';
import { CallPipeline, ServerRequests } from '../packages/backend/dist/index.js';
import { frame } from './support/units.mjs';

const root = mkdtempSync(join(tmpdir(), 'mcpx-r08-'));
const opened = [];
after(() => {
  for (const ws of opened) ws.close();
  rmSync(root, { recursive: true, force: true });
});
const noSecrets = { get: () => null, set: () => { throw new Error('unexpected keychain write'); }, delete: () => false };

function workspace({ persistResults = true } = {}) {
  const ws = createWorkspaceDb({ path: join(root, `${randomUUID()}.db`), workspaceId: randomUUID(), name: 'r08', custody: { kind: 'none' }, secrets: noSecrets });
  opened.push(ws);
  if (!persistResults) ws.db.prepare('UPDATE workspace_meta SET persist_results = 0').run();
  const serverId = randomUUID();
  saveServer(ws, { id: serverId, name: 'fixture', transport: 'stdio', command: 'node' });
  const rec = HistoryRecorder.open(ws, serverId);
  return { ws, rec, serverId };
}

/** A connection whose calls resolve only when the test says, one pending outcome per call. */
function standIn() {
  const calls = [];
  const conn = { call: (req) => new Promise((resolve) => calls.push({ req, resolve })) };
  return { conn, calls };
}

const tick = () => new Promise((r) => setTimeout(r, 10));
const inputRequired = (requestId) => ({
  kind: 'result', requestId,
  result: { resultType: 'input_required', inputRequests: { q: { method: 'elicitation/create', params: { message: '?', requestedSchema: { type: 'object', properties: {} } } } }, requestState: 's1' },
});

function pipeline({ persistResults } = {}) {
  const w = workspace({ persistResults });
  const { conn, calls } = standIn();
  const session = { conn, recorder: w.rec, connectionId: w.rec.connectionId };
  const p = new CallPipeline(w.ws, { session: () => session, partialCapture: () => undefined });
  return { ...w, p, calls };
}

const signal = (aborted = false) => { const c = new AbortController(); if (aborted) c.abort(); return c.signal; };
const sampling = (id) => ({ jsonrpc: '2.0', id, method: 'sampling/createMessage', params: { messages: [], maxTokens: 1 } });

test('R08-1: a request whose signal is already aborted when it reaches the desk ends cancelled, not pending', async () => {
  const { ws, rec, serverId } = workspace();
  const desk = new ServerRequests(ws, () => []);
  frame(rec, 'in', sampling(1));
  void desk.receive(serverId, rec, { id: 1, method: 'sampling/createMessage', params: {}, signal: signal(true) });
  await tick();
  const [row] = desk.list(serverId);
  assert.equal(row.status, 'cancelled');
  assert.equal(row.live, undefined, 'not answerable');
});

test('R08-2: a pending request is listed however many newer ones there are', async () => {
  const { ws, rec, serverId } = workspace();
  const desk = new ServerRequests(ws, () => []);
  frame(rec, 'in', sampling(0));
  void desk.receive(serverId, rec, { id: 0, method: 'roots/list', params: {}, signal: signal() });
  for (let i = 1; i <= 3; i++) {
    frame(rec, 'in', sampling(i));
    void desk.receive(serverId, rec, { id: i, method: 'sampling/createMessage', params: {}, signal: signal() });
    const newest = desk.list(serverId)[0];
    desk.answer(newest.id, { result: { ok: true } });
  }
  const page = desk.list(serverId, 2);
  assert.ok(page.some((r) => r.method === 'roots/list' && r.live), 'the old pending request is still there to answer');
  assert.equal(page.filter((r) => !r.live).length, 2, 'the page of ended ones keeps its limit');
});

test('R08-5: a request that cannot be recorded waits unanswered instead of rejecting (the SDK would answer -32603)', async () => {
  const { ws, rec, serverId } = workspace();
  const desk = new ServerRequests(ws, () => []);
  const broken = Object.create(rec, { receiveRequest: { value: () => { throw new Error('the workspace is closing'); } } });
  const warnings = [];
  const onWarning = (w) => warnings.push(w.message);
  process.on('warning', onWarning);
  try {
    let settled = false;
    let threw = false;
    try {
      desk.receive(serverId, broken, { id: 9, method: 'sampling/createMessage', params: {}, signal: signal() }).then(() => { settled = true; }, () => { settled = true; });
    } catch {
      threw = true;
    }
    await tick();
    assert.equal(threw, false, 'receive does not throw');
    assert.equal(settled, false, 'nothing goes back to the server');
    assert.ok(warnings.some((m) => /server request 9 .* could not be recorded/.test(m)), `warned: ${JSON.stringify(warnings)}`);
  } finally {
    process.off('warning', onWarning);
  }
});

test('R08-8: a refusal with -32002, which the client library would send as -32602, is refused with the reason', async () => {
  const { ws, rec, serverId } = workspace();
  const desk = new ServerRequests(ws, () => []);
  frame(rec, 'in', sampling(1));
  void desk.receive(serverId, rec, { id: 1, method: 'sampling/createMessage', params: {}, signal: signal() });
  const [row] = desk.list(serverId);
  assert.throws(() => desk.answer(row.id, { error: { code: -32002, message: 'no' } }), /-32602/);
  assert.equal(desk.list(serverId)[0].status, 'pending');
  desk.answer(row.id, { error: { code: -1, message: 'User rejected sampling request' } });
  assert.equal(desk.list(serverId)[0].status, 'refused', 'other codes still go');
});

test('R08-3: under the opt-out, a retry still running shows no result, not the input_required it answered', async () => {
  const { p, calls } = pipeline({ persistResults: false });
  const { callId } = await p.start({ serverId: 's', kind: 'tool', target: 't', args: {}, confirmed: true });
  calls[0].resolve(inputRequired(1));
  await tick();
  assert.equal((await p.view(callId)).live.status, 'awaiting-input');
  p.answer(callId, { q: { action: 'decline' } });
  const running = await p.view(callId);
  assert.equal(running.live.status, 'running');
  assert.equal(running.sessionResult, undefined, 'round 2 has no result yet');
  calls[1].resolve({ kind: 'result', requestId: 2, result: { content: [{ type: 'text', text: 'done' }] } });
  await tick();
  assert.deepEqual((await p.view(callId)).sessionResult, { content: [{ type: 'text', text: 'done' }] }, 'the finished round shows its own result');
});

test('R08-6: an answer whose round cannot begin leaves the call waiting, still stoppable', async () => {
  const { p, calls, rec } = pipeline();
  const { callId } = await p.start({ serverId: 's', kind: 'tool', target: 't', args: {}, confirmed: true });
  calls[0].resolve(inputRequired(1));
  await tick();
  rec.beginRound(callId, {}); // an unfinished round, so the retry's round cannot begin
  assert.throws(() => p.answer(callId, { q: { action: 'decline' } }), /unfinished round/);
  const v = await p.view(callId);
  assert.equal(v.live.status, 'awaiting-input');
  assert.equal(calls.length, 1, 'nothing was sent');
  p.stop(callId);
  assert.equal((await p.view(callId)).call.status, 'abandoned');
});

test('re-review 1: answers that cannot be stored are refused before a round begins, and a good answer still goes', async () => {
  const { p, calls } = pipeline();
  const { callId } = await p.start({ serverId: 's', kind: 'tool', target: 't', args: {}, confirmed: true });
  calls[0].resolve(inputRequired(1));
  await tick();
  // A BigInt survives the message port's structured clone and fails JSON.
  assert.throws(() => p.answer(callId, { q: { action: 'accept', content: { n: 1n } } }), /cannot be stored/);
  assert.equal((await p.view(callId)).call.rounds, 1, 'no round was begun');
  p.answer(callId, { q: { action: 'decline' } });
  assert.equal(calls.length, 2, 'the good answer went');
});

test('re-review 1, twin: a server request answer that cannot be stored is refused, and the request stays answerable', async () => {
  const { ws, rec, serverId } = workspace();
  const desk = new ServerRequests(ws, () => []);
  frame(rec, 'in', sampling(1));
  void desk.receive(serverId, rec, { id: 1, method: 'sampling/createMessage', params: {}, signal: signal() });
  const [row] = desk.list(serverId);
  assert.throws(() => desk.answer(row.id, { result: { n: 1n } }), /cannot be stored/);
  assert.ok(desk.list(serverId)[0].live, 'still pending and answerable');
  desk.answer(row.id, { result: { ok: true } });
  assert.equal(desk.list(serverId)[0].status, 'answered');
});

test('a call finishes in storage with no purge listener (an optional call skipped finishCall)', async () => {
  const { p, calls } = pipeline();
  const { callId } = await p.start({ serverId: 's', kind: 'tool', target: 't', args: {}, confirmed: true });
  calls[0].resolve({ kind: 'result', requestId: 1, result: { content: [] } });
  await tick();
  assert.equal((await p.view(callId)).call.status, 'completed');
});

test('R08-7: a request with no recorded unit is not given an earlier request\'s answer', () => {
  const { ws, rec } = workspace();
  frame(rec, 'in', sampling(0));
  const first = rec.receiveRequest(0, 'sampling/createMessage', {}, null);
  rec.finishRequest(first, 'answered', { ok: 1 });
  const answerUnit = frame(rec, 'out', { jsonrpc: '2.0', id: 0, result: { ok: 1 } });
  assert.equal(readServerRequest(ws, first).responseUnitId, answerUnit, 'old valid input: found as before');
  // The same id again, its request frame never recorded.
  const second = rec.receiveRequest(0, 'sampling/createMessage', {}, null);
  ws.db.prepare('UPDATE server_request SET request_unit_id = NULL WHERE id = ?').run(second);
  assert.equal(readServerRequest(ws, second).responseUnitId, null);
});
