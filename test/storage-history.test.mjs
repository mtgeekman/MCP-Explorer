// Recording connections, calls, rounds and frames (D23, D30, P1).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { connectStdio, captureSurface } from '../packages/protocol/dist/index.js';
import {
  createWorkspaceDb, saveServer, HistoryRecorder, HistoryStateError, RESULT_METHODS,
} from '../packages/storage/dist/index.js';

const root = mkdtempSync(join(tmpdir(), 'mcpx-hist-'));
after(() => rmSync(root, { recursive: true, force: true }));
const noSecrets = { get: () => null, set: () => { throw new Error('unexpected keychain write'); }, delete: () => false };

function setup({ persistResults = true } = {}) {
  const ws = createWorkspaceDb({ path: join(root, `${randomUUID()}.db`), workspaceId: randomUUID(), name: 'history', custody: { kind: 'none' }, secrets: noSecrets });
  if (!persistResults) ws.db.prepare('UPDATE workspace_meta SET persist_results = 0').run();
  const serverId = randomUUID();
  saveServer(ws, { id: serverId, name: 'fixture', transport: 'stdio', command: 'node' });
  let t = 1000;
  const rec = HistoryRecorder.open(ws, serverId, () => t++);
  return { ws, rec, serverId };
}

const rows = (ws, sql, ...p) => ws.db.prepare(sql).all(...p).map((r) => ({ ...r }));
const frames = (ws) => rows(ws, 'SELECT call_id, round_seq, direction, jsonrpc_id, method, message_json, result_withheld FROM frame ORDER BY id');

const toolCall = (id, name, args) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
const reply = (id, result) => ({ jsonrpc: '2.0', id, result });
const COMPLETE = { resultType: 'complete', content: [{ type: 'text', text: 'hi' }] };
const INPUT_REQUIRED = {
  resultType: 'input_required', requestState: 'opaque-é-state',
  inputRequests: { who: { method: 'sampling/createMessage', params: { messages: [{ role: 'user', content: { type: 'text', text: 'tool output: 42' } }] } } },
};

// --- frames -----------------------------------------------------------------------

test('frames: requests, responses and notifications are all recorded, in order, with id and method', () => {
  const { ws, rec } = setup();
  rec.frame('out', { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  rec.frame('in', reply(1, { tools: [] }));
  rec.frame('in', { jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
  rec.frame('out', { jsonrpc: '2.0', id: 'abc', method: 'ping' });
  rec.frame('in', { jsonrpc: '2.0', id: 'abc', error: { code: -32601, message: 'nope' } });
  assert.deepEqual(frames(ws).map((f) => [f.direction, f.jsonrpc_id, f.method, f.result_withheld]), [
    ['out', '1', 'tools/list', 0],
    ['in', '1', 'tools/list', 0],
    ['in', null, 'notifications/tools/list_changed', 0],
    ['out', '"abc"', 'ping', 0],
    ['in', '"abc"', 'ping', 0],
  ]);
  assert.deepEqual(JSON.parse(frames(ws)[1].message_json), reply(1, { tools: [] }));
  ws.close();
});

test('frames: a numeric id and the same digits as a string are different ids', () => {
  const { ws, rec } = setup();
  rec.frame('out', { jsonrpc: '2.0', id: 7, method: 'tools/list' });
  rec.frame('out', { jsonrpc: '2.0', id: '7', method: 'prompts/list' });
  rec.frame('in', reply('7', { prompts: [] }));
  rec.frame('in', reply(7, { tools: [] }));
  assert.deepEqual(frames(ws).slice(2).map((f) => [f.jsonrpc_id, f.method]), [['"7"', 'prompts/list'], ['7', 'tools/list']]);
  ws.close();
});

test('frames: a batch is recorded as its members', () => {
  const { ws, rec } = setup();
  rec.frame('out', [{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }]);
  assert.deepEqual(frames(ws).map((f) => f.method), ['ping', 'notifications/initialized']);
  ws.close();
});

test('frames: a server-to-client request and our response are paired by id (legacy era)', () => {
  const { ws, rec } = setup();
  rec.frame('in', { jsonrpc: '2.0', id: 9, method: 'sampling/createMessage', params: {} });
  rec.frame('out', reply(9, { role: 'assistant', content: { type: 'text', text: 'typed by a human' } }));
  assert.deepEqual(frames(ws).map((f) => [f.direction, f.method]), [['in', 'sampling/createMessage'], ['out', 'sampling/createMessage']]);
  ws.close();
});

// --- calls and rounds --------------------------------------------------------------

test('calls: a round binds the request it declared and that request\'s response', () => {
  const { ws, rec } = setup();
  const call = rec.beginCall('tool', 'echo');
  const seq = rec.beginRound(call, { text: 'hi' });
  rec.frame('out', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  rec.frame('out', toolCall(2, 'echo', { text: 'hi' }));
  rec.frame('in', reply(1, { tools: [] }));
  rec.frame('in', reply(2, COMPLETE));
  rec.finishRound(call, seq, { result: COMPLETE, resultType: 'complete' });
  rec.finishCall(call, 'completed');
  assert.deepEqual(frames(ws).map((f) => [f.jsonrpc_id, f.call_id, f.round_seq]), [['1', null, null], ['2', call, 1], ['1', null, null], ['2', call, 1]]);
  assert.deepEqual(rows(ws, 'SELECT status, finished_at IS NOT NULL AS done FROM call'), [{ status: 'completed', done: 1 }]);
  assert.deepEqual(JSON.parse(rows(ws, 'SELECT result_json FROM call_round')[0].result_json), COMPLETE);
  ws.close();
});

test('calls: two calls to the same tool bind in the order their requests were sent', () => {
  const { ws, rec } = setup();
  const a = rec.beginCall('tool', 'echo'); rec.beginRound(a, { text: 'a' });
  const b = rec.beginCall('tool', 'echo'); rec.beginRound(b, { text: 'b' });
  rec.frame('out', toolCall(10, 'echo', { text: 'a' }));
  rec.frame('out', toolCall(11, 'echo', { text: 'b' }));
  rec.frame('in', reply(11, COMPLETE));
  rec.frame('in', reply(10, COMPLETE));
  assert.deepEqual(frames(ws).map((f) => [f.jsonrpc_id, f.call_id]), [['10', a], ['11', b], ['11', b], ['10', a]]);
  ws.close();
});

test('calls: a request for a different target is not bound to the round', () => {
  const { ws, rec } = setup();
  const call = rec.beginCall('tool', 'echo'); rec.beginRound(call, {});
  rec.frame('out', toolCall(1, 'other', {}));
  assert.equal(frames(ws)[0].call_id, null);
  rec.frame('out', toolCall(2, 'echo', {}));
  assert.equal(frames(ws)[1].call_id, call);
  ws.close();
});

test('calls: prompts bind by name and resources by uri', () => {
  const { ws, rec } = setup();
  const p = rec.beginCall('prompt', 'greet'); rec.beginRound(p, { who: 'x' });
  const r = rec.beginCall('resource', 'file:///a.md'); rec.beginRound(r, undefined);
  rec.frame('out', { jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: 'file:///a.md' } });
  rec.frame('out', { jsonrpc: '2.0', id: 2, method: 'prompts/get', params: { name: 'greet', arguments: { who: 'x' } } });
  assert.deepEqual(frames(ws).map((f) => f.call_id), [r, p]);
  ws.close();
});

test('calls: an MRTR sequence is rounds on one call, and request_state survives byte-exact', () => {
  const { ws, rec } = setup();
  const call = rec.beginCall('tool', 'needs_input');
  const r1 = rec.beginRound(call, {});
  rec.frame('out', toolCall(1, 'needs_input', {}));
  rec.frame('in', reply(1, INPUT_REQUIRED));
  rec.finishRound(call, r1, { result: INPUT_REQUIRED, resultType: 'input_required', inputRequests: INPUT_REQUIRED.inputRequests, requestState: INPUT_REQUIRED.requestState });
  rec.answerRound(call, r1, { who: { role: 'assistant', content: { type: 'text', text: 'human answer' } } });
  const r2 = rec.beginRound(call, {});
  rec.frame('out', toolCall(2, 'needs_input', {}));
  rec.frame('in', reply(2, COMPLETE));
  rec.finishRound(call, r2, { result: COMPLETE, resultType: 'complete' });
  rec.finishCall(call, 'completed');

  const rounds = rows(ws, 'SELECT seq, result_type, request_state, input_responses_json FROM call_round WHERE call_id = ? ORDER BY seq', call);
  assert.deepEqual(rounds.map((r) => [r.seq, r.result_type]), [[1, 'input_required'], [2, 'complete']]);
  assert.equal(Buffer.from(rounds[0].request_state).toString('utf8'), 'opaque-é-state');
  assert.ok(Buffer.isBuffer(rounds[0].request_state), 'request_state must be stored as bytes, not text');
  assert.equal(JSON.parse(rounds[0].input_responses_json).who.content.text, 'human answer');
  assert.deepEqual(frames(ws).map((f) => [f.jsonrpc_id, f.round_seq]), [['1', 1], ['1', 1], ['2', 2], ['2', 2]]);
  ws.close();
});

test('calls: out-of-order use is refused', () => {
  const { ws, rec } = setup();
  const call = rec.beginCall('tool', 'echo');
  const seq = rec.beginRound(call, {});
  assert.throws(() => rec.beginRound(call, {}), /already has an unfinished round/);
  assert.throws(() => rec.answerRound(call, seq, {}), /no finished round/);
  assert.throws(() => rec.finishCall(call, 'completed'), /round still waiting/);
  rec.finishRound(call, seq, { result: COMPLETE });
  assert.throws(() => rec.finishRound(call, seq, { result: COMPLETE }), /no unfinished round/);
  rec.finishCall(call, 'completed');
  assert.throws(() => rec.finishCall(call, 'completed'), HistoryStateError);
  assert.throws(() => rec.beginRound(call, {}), /not open/);
  ws.close();
});

test('calls: abandoning a call closes its waiting round and stops binding its request', () => {
  const { ws, rec } = setup();
  const call = rec.beginCall('tool', 'echo');
  rec.beginRound(call, {});
  rec.finishCall(call, 'abandoned');
  rec.frame('out', toolCall(1, 'echo', {}));
  assert.equal(frames(ws)[0].call_id, null, 'a late request must not bind to an abandoned call');
  assert.deepEqual(rows(ws, 'SELECT status FROM call'), [{ status: 'abandoned' }]);
  assert.equal(rows(ws, 'SELECT finished_at IS NULL AS open FROM call_round')[0].open, 0);
  ws.close();
});

// --- D30: the results opt-out -------------------------------------------------------

test('opt-out: result responses are withheld, their requests and other frames are kept', () => {
  const { ws, rec } = setup({ persistResults: false });
  const call = rec.beginCall('tool', 'echo'); const seq = rec.beginRound(call, { text: 'hi' });
  rec.frame('out', toolCall(1, 'echo', { text: 'hi' }));
  rec.frame('in', reply(1, COMPLETE));
  rec.frame('out', { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  rec.frame('in', reply(2, { tools: [] }));
  rec.finishRound(call, seq, { result: COMPLETE, resultType: 'complete' });
  assert.deepEqual(frames(ws).map((f) => [f.direction, f.method, f.message_json === null, f.result_withheld]), [
    ['out', 'tools/call', false, 0],
    ['in', 'tools/call', true, 1],
    ['out', 'tools/list', false, 0],
    ['in', 'tools/list', false, 0],
  ]);
  assert.equal(frames(ws)[1].jsonrpc_id, '1', 'a withheld frame still says what it answered');
  assert.equal(rows(ws, 'SELECT result_json FROM call_round')[0].result_json, null);
  ws.close();
});

test('opt-out: every result method is withheld', () => {
  const { ws, rec } = setup({ persistResults: false });
  RESULT_METHODS.forEach((method, i) => {
    rec.frame('out', { jsonrpc: '2.0', id: i, method, params: { name: 'n', uri: 'u' } });
    rec.frame('in', reply(i, { secret: 'data' }));
  });
  assert.deepEqual(frames(ws).filter((f) => f.direction === 'in').map((f) => [f.method, f.result_withheld]), RESULT_METHODS.map((m) => [m, 1]));
  ws.close();
});

test('opt-out: an input-required round withholds its requests and state, and keeps the human\'s answer', () => {
  const { ws, rec } = setup({ persistResults: false });
  const call = rec.beginCall('tool', 'needs_input'); const seq = rec.beginRound(call, {});
  rec.finishRound(call, seq, { result: INPUT_REQUIRED, resultType: 'input_required', inputRequests: INPUT_REQUIRED.inputRequests, requestState: INPUT_REQUIRED.requestState });
  rec.answerRound(call, seq, { who: 'typed' });
  const [round] = rows(ws, 'SELECT result_json, result_type, input_requests_json, request_state, input_responses_json FROM call_round');
  assert.deepEqual({ ...round, input_responses_json: JSON.parse(round.input_responses_json) },
    { result_json: null, result_type: 'input_required', input_requests_json: null, request_state: null, input_responses_json: { who: 'typed' } });
  const file = ws.db.name;
  ws.close();
  assert.equal(readFileSync(file).includes('tool output: 42'), false, 'the content of the sampling request reached the file');
});

test('opt-out: a response to a request the recorder never saw is withheld', () => {
  const { ws, rec } = setup({ persistResults: false });
  rec.frame('in', reply(99, { content: [{ type: 'text', text: 'maybe a result' }] }));
  assert.deepEqual(frames(ws).map((f) => [f.method, f.result_withheld]), [[null, 1]]);
  ws.close();
});

test('opt-out: turning it on or off applies to the next frame', () => {
  const { ws, rec } = setup();
  rec.frame('out', toolCall(1, 'echo', {}));
  rec.frame('out', toolCall(2, 'echo', {}));
  rec.frame('in', reply(1, COMPLETE));
  ws.db.prepare('UPDATE workspace_meta SET persist_results = 0').run();
  rec.frame('in', reply(2, COMPLETE));
  assert.deepEqual(frames(ws).filter((f) => f.direction === 'in').map((f) => f.result_withheld), [0, 1]);
  ws.close();
});

// --- P1 end to end --------------------------------------------------------------------

test('P1: every frame the transport tap emits in a real session is stored', async () => {
  const { ws, rec } = setup();
  const seen = [];
  try {
  const conn = await connectStdio({
    command: process.execPath,
    args: [fileURLToPath(new URL('../scripts/fixture/modern-server.mjs', import.meta.url))],
    onFrame: (direction, frame) => { seen.push([direction, frame]); rec.frame(direction, frame); },
  });
  try {
    rec.negotiated(conn.revision, conn.era);
    await captureSurface(conn.source);
  } finally {
    await conn.close();
    rec.close();
  }
  const stored = frames(ws);
  assert.ok(seen.length >= 4, `only ${seen.length} frames in a whole capture`);
  assert.equal(stored.length, seen.length);
  stored.forEach((f, i) => {
    assert.equal(f.direction, seen[i][0]);
    assert.deepEqual(JSON.parse(f.message_json), seen[i][1]);
  });
  assert.ok(stored.some((f) => f.method === 'server/discover'), 'negotiation traffic is part of the record');
  assert.ok(stored.every((f) => f.method !== null), 'every response was paired with its request');
  assert.deepEqual(rows(ws, 'SELECT negotiated_revision, era, closed_at IS NOT NULL AS closed FROM connection'), [{ negotiated_revision: conn.revision, era: conn.era, closed: 1 }]);
  } finally {
    ws.close();
  }
});
