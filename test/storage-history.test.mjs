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
import { frame, wire } from './support/units.mjs';

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
const frames = (ws) => rows(ws, `
  SELECT f.call_id, f.round_seq, f.direction, f.jsonrpc_id, f.method, f.unit_id, u.bytes, u.withheld, f.result_withheld
  FROM frame f JOIN wire_unit u ON u.id = f.unit_id ORDER BY f.id`);
const units = (ws) => rows(ws, 'SELECT connection_id, call_id, direction, kind, bytes, byte_length, withheld, http_json FROM wire_unit ORDER BY id');

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
  frame(rec, 'out', { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  frame(rec, 'in', reply(1, { tools: [] }));
  frame(rec, 'in', { jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
  frame(rec, 'out', { jsonrpc: '2.0', id: 'abc', method: 'ping' });
  frame(rec, 'in', { jsonrpc: '2.0', id: 'abc', error: { code: -32601, message: 'nope' } });
  assert.deepEqual(frames(ws).map((f) => [f.direction, f.jsonrpc_id, f.method, f.result_withheld]), [
    ['out', '1', 'tools/list', 0],
    ['in', '1', 'tools/list', 0],
    ['in', null, 'notifications/tools/list_changed', 0],
    ['out', '"abc"', 'ping', 0],
    ['in', '"abc"', 'ping', 0],
  ]);
  assert.equal(frames(ws)[1].bytes.toString('utf8'), JSON.stringify(reply(1, { tools: [] })) + '\n');
  ws.close();
});

test('frames: a numeric id and the same digits as a string are different ids', () => {
  const { ws, rec } = setup();
  frame(rec, 'out', { jsonrpc: '2.0', id: 7, method: 'tools/list' });
  frame(rec, 'out', { jsonrpc: '2.0', id: '7', method: 'prompts/list' });
  frame(rec, 'in', reply('7', { prompts: [] }));
  frame(rec, 'in', reply(7, { tools: [] }));
  assert.deepEqual(frames(ws).slice(2).map((f) => [f.jsonrpc_id, f.method]), [['"7"', 'prompts/list'], ['7', 'tools/list']]);
  ws.close();
});

test('frames: a batch is one unit, recorded as its members', () => {
  const { ws, rec } = setup();
  frame(rec, 'out', [{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }]);
  assert.deepEqual(frames(ws).map((f) => f.method), ['ping', 'notifications/initialized']);
  assert.equal(units(ws).length, 1);
  assert.equal(new Set(frames(ws).map((f) => f.unit_id)).size, 1);
  ws.close();
});

// --- wire units (D34) -----------------------------------------------------------------

test('units: the bytes are stored exactly as they arrived, not re-serialized', () => {
  const { ws, rec } = setup();
  // Whitespace, key order, an escape, a duplicate key and a CRLF: everything
  // a parse-and-stringify would change.
  const raw = '{ "id":1,  "jsonrpc":"2.0", "result":{"a":1.50,"a":2,"t":"\\u00e9"} }\r\n';
  rec.unit({ direction: 'in', kind: 'wire', bytes: Buffer.from(raw, 'utf8') });
  const [u] = units(ws);
  assert.equal(u.bytes.toString('utf8'), raw);
  assert.equal(u.byte_length, Buffer.byteLength(raw));
  assert.deepEqual(frames(ws).map((f) => f.jsonrpc_id), ['1']);
  ws.close();
});

test('units: a unit that is not JSON-RPC is kept, with no frames', () => {
  const { ws, rec } = setup();
  const cases = ['<!doctype html><title>Sign in</title>\n', 'Server starting on stdio...\n', '42\n', '{"not":"jsonrpc"}\n', '', '{"jsonrpc":"2.0",'];
  for (const text of cases) rec.unit({ direction: 'in', kind: 'wire', bytes: Buffer.from(text, 'utf8') });
  rec.unit({ direction: 'in', kind: 'wire', bytes: Buffer.from([0xff, 0xfe, 0x7b]) });
  assert.deepEqual(units(ws).map((u) => u.bytes.toString('latin1')), [...cases, '\xff\xfe{']);
  assert.equal(frames(ws).length, 0);
  ws.close();
});

test('units: stderr lines and app events are stored as their own kinds, never parsed', () => {
  const { ws, rec } = setup();
  rec.unit({ direction: 'in', kind: 'stderr', bytes: Buffer.from('{"jsonrpc":"2.0","method":"looks/like/a/frame"}\n') });
  rec.unit({ direction: 'local', kind: 'app', bytes: Buffer.from('{"event":"exited","code":1}') });
  assert.deepEqual(units(ws).map((u) => [u.direction, u.kind]), [['in', 'stderr'], ['local', 'app']]);
  assert.equal(frames(ws).length, 0, 'stderr that happens to look like JSON-RPC is not a frame');
  ws.close();
});

test('units: the schema refuses an app event with a wire direction, and a length that does not match', () => {
  const { ws, rec } = setup();
  assert.throws(() => rec.unit({ direction: 'in', kind: 'app', bytes: Buffer.from('x') }), /CHECK/);
  assert.throws(() => ws.db.prepare("INSERT INTO wire_unit (connection_id, direction, kind, at, bytes, byte_length) VALUES (?, 'in', 'wire', 1, x'00', 2)").run(rec.connectionId), /CHECK/);
  ws.close();
});

test('units: HTTP details are stored beside the bytes', () => {
  const { ws, rec } = setup();
  const http = { method: 'POST', url: 'https://example.test/mcp', headers: { authorization: '<secret: token>' } };
  rec.unit({ ...wire('out', { jsonrpc: '2.0', id: 1, method: 'ping' }, ''), http });
  assert.deepEqual(JSON.parse(units(ws)[0].http_json), http);
  ws.close();
});

test('units: a unit whose messages all belong to one call goes with that call; a batch across calls does not', () => {
  const { ws, rec } = setup();
  const a = rec.beginCall('tool', 'a'); rec.beginRound(a, {});
  const b = rec.beginCall('tool', 'b'); rec.beginRound(b, {});
  frame(rec, 'out', toolCall(1, 'a', {}));
  frame(rec, 'out', [toolCall(2, 'b', {}), { jsonrpc: '2.0', method: 'notifications/progress' }]);
  assert.deepEqual(units(ws).map((u) => u.call_id), [a, null]);
  ws.close();
});

test('frames: a server-to-client request and our response are paired by id (legacy era)', () => {
  const { ws, rec } = setup();
  frame(rec, 'in', { jsonrpc: '2.0', id: 9, method: 'sampling/createMessage', params: {} });
  frame(rec, 'out', reply(9, { role: 'assistant', content: { type: 'text', text: 'typed by a human' } }));
  assert.deepEqual(frames(ws).map((f) => [f.direction, f.method]), [['in', 'sampling/createMessage'], ['out', 'sampling/createMessage']]);
  ws.close();
});

// --- calls and rounds --------------------------------------------------------------

test('calls: a round binds the request it declared and that request\'s response', () => {
  const { ws, rec } = setup();
  const call = rec.beginCall('tool', 'echo');
  const seq = rec.beginRound(call, { text: 'hi' });
  frame(rec, 'out', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  frame(rec, 'out', toolCall(2, 'echo', { text: 'hi' }));
  frame(rec, 'in', reply(1, { tools: [] }));
  frame(rec, 'in', reply(2, COMPLETE));
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
  frame(rec, 'out', toolCall(10, 'echo', { text: 'a' }));
  frame(rec, 'out', toolCall(11, 'echo', { text: 'b' }));
  frame(rec, 'in', reply(11, COMPLETE));
  frame(rec, 'in', reply(10, COMPLETE));
  assert.deepEqual(frames(ws).map((f) => [f.jsonrpc_id, f.call_id]), [['10', a], ['11', b], ['11', b], ['10', a]]);
  ws.close();
});

test('calls: a request for a different target is not bound to the round', () => {
  const { ws, rec } = setup();
  const call = rec.beginCall('tool', 'echo'); rec.beginRound(call, {});
  frame(rec, 'out', toolCall(1, 'other', {}));
  assert.equal(frames(ws)[0].call_id, null);
  frame(rec, 'out', toolCall(2, 'echo', {}));
  assert.equal(frames(ws)[1].call_id, call);
  ws.close();
});

test('calls: prompts bind by name and resources by uri', () => {
  const { ws, rec } = setup();
  const p = rec.beginCall('prompt', 'greet'); rec.beginRound(p, { who: 'x' });
  const r = rec.beginCall('resource', 'file:///a.md'); rec.beginRound(r, undefined);
  frame(rec, 'out', { jsonrpc: '2.0', id: 1, method: 'resources/read', params: { uri: 'file:///a.md' } });
  frame(rec, 'out', { jsonrpc: '2.0', id: 2, method: 'prompts/get', params: { name: 'greet', arguments: { who: 'x' } } });
  assert.deepEqual(frames(ws).map((f) => f.call_id), [r, p]);
  ws.close();
});

test('calls: an MRTR sequence is rounds on one call, and request_state survives byte-exact', () => {
  const { ws, rec } = setup();
  const call = rec.beginCall('tool', 'needs_input');
  const r1 = rec.beginRound(call, {});
  frame(rec, 'out', toolCall(1, 'needs_input', {}));
  frame(rec, 'in', reply(1, INPUT_REQUIRED));
  rec.finishRound(call, r1, { result: INPUT_REQUIRED, resultType: 'input_required', inputRequests: INPUT_REQUIRED.inputRequests, requestState: INPUT_REQUIRED.requestState });
  rec.answerRound(call, r1, { who: { role: 'assistant', content: { type: 'text', text: 'human answer' } } });
  const r2 = rec.beginRound(call, {});
  frame(rec, 'out', toolCall(2, 'needs_input', {}));
  frame(rec, 'in', reply(2, COMPLETE));
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
  frame(rec, 'out', toolCall(1, 'echo', {}));
  assert.equal(frames(ws)[0].call_id, null, 'a late request must not bind to an abandoned call');
  assert.deepEqual(rows(ws, 'SELECT status FROM call'), [{ status: 'abandoned' }]);
  assert.equal(rows(ws, 'SELECT finished_at IS NULL AS open FROM call_round')[0].open, 0);
  ws.close();
});

// --- D30: the results opt-out -------------------------------------------------------

test('opt-out: result responses are withheld, their requests and other frames are kept', () => {
  const { ws, rec } = setup({ persistResults: false });
  const call = rec.beginCall('tool', 'echo'); const seq = rec.beginRound(call, { text: 'hi' });
  frame(rec, 'out', toolCall(1, 'echo', { text: 'hi' }));
  frame(rec, 'in', reply(1, COMPLETE));
  frame(rec, 'out', { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  frame(rec, 'in', reply(2, { tools: [] }));
  rec.finishRound(call, seq, { result: COMPLETE, resultType: 'complete' });
  assert.deepEqual(frames(ws).map((f) => [f.direction, f.method, f.bytes === null, f.withheld, f.result_withheld]), [
    ['out', 'tools/call', false, 0, 0],
    ['in', 'tools/call', true, 1, 1],
    ['out', 'tools/list', false, 0, 0],
    ['in', 'tools/list', false, 0, 0],
  ]);
  assert.equal(units(ws)[1].byte_length, Buffer.byteLength(JSON.stringify(reply(1, COMPLETE)) + '\n'), 'a withheld unit still says how big it was');
  assert.equal(frames(ws)[1].jsonrpc_id, '1', 'a withheld frame still says what it answered');
  assert.equal(rows(ws, 'SELECT result_json FROM call_round')[0].result_json, null);
  ws.close();
});

test('opt-out: every result method is withheld', () => {
  const { ws, rec } = setup({ persistResults: false });
  RESULT_METHODS.forEach((method, i) => {
    frame(rec, 'out', { jsonrpc: '2.0', id: i, method, params: { name: 'n', uri: 'u' } });
    frame(rec, 'in', reply(i, { secret: 'data' }));
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
  frame(rec, 'in', reply(99, { content: [{ type: 'text', text: 'maybe a result' }] }));
  assert.deepEqual(frames(ws).map((f) => [f.method, f.result_withheld]), [[null, 1]]);
  ws.close();
});

test('opt-out: a batch carrying a result is withheld whole, and its other frames still say what they were', () => {
  const { ws, rec } = setup({ persistResults: false });
  frame(rec, 'out', toolCall(1, 'echo', {}));
  frame(rec, 'in', [reply(1, COMPLETE), { jsonrpc: '2.0', method: 'notifications/message', params: { data: 'log' } }]);
  const batch = frames(ws).slice(1);
  assert.deepEqual(batch.map((f) => [f.method, f.bytes, f.withheld, f.result_withheld]),
    [['tools/call', null, 1, 1], ['notifications/message', null, 1, 0]]);
  ws.close();
});

test('opt-out: an incoming unit that is not JSON-RPC is withheld; an outgoing one, an empty one, stderr and app events are not', () => {
  const { ws, rec } = setup({ persistResults: false });
  rec.unit({ direction: 'in', kind: 'wire', bytes: Buffer.from('<html>maybe a result</html>') });
  rec.unit({ direction: 'out', kind: 'wire', bytes: Buffer.from('not json') });
  rec.unit({ direction: 'in', kind: 'wire', bytes: Buffer.alloc(0) });
  rec.unit({ direction: 'in', kind: 'stderr', bytes: Buffer.from('warning\n') });
  rec.unit({ direction: 'local', kind: 'app', bytes: Buffer.from('{"event":"spawned"}') });
  assert.deepEqual(units(ws).map((u) => u.withheld), [1, 0, 0, 0, 0]);
  ws.close();
});

test('opt-out: turning it on or off applies to the next frame', () => {
  const { ws, rec } = setup();
  frame(rec, 'out', toolCall(1, 'echo', {}));
  frame(rec, 'out', toolCall(2, 'echo', {}));
  frame(rec, 'in', reply(1, COMPLETE));
  ws.db.prepare('UPDATE workspace_meta SET persist_results = 0').run();
  frame(rec, 'in', reply(2, COMPLETE));
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
    onFrame: (direction, message) => { seen.push([direction, message]); frame(rec, direction, message); },
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
    assert.deepEqual(JSON.parse(f.bytes.toString('utf8')), seen[i][1]);
  });
  assert.ok(stored.some((f) => f.method === 'server/discover'), 'negotiation traffic is part of the record');
  assert.ok(stored.every((f) => f.method !== null), 'every response was paired with its request');
  assert.deepEqual(rows(ws, 'SELECT negotiated_revision, era, closed_at IS NOT NULL AS closed FROM connection'), [{ negotiated_revision: conn.revision, era: conn.era, closed: 1 }]);
  } finally {
    ws.close();
  }
});

test('calls: a round finished without its request being sent does not capture the next round\'s request', () => {
  // Review finding: finishRound left the round's pending binding queued, so a
  // retry after a send that never happened bound to the dead round.
  const { ws, rec } = setup();
  try {
    const call = rec.beginCall('tool', 'echo');
    const r1 = rec.beginRound(call, {});
    rec.finishRound(call, r1, { error: { message: 'connection closed before send' } });
    const r2 = rec.beginRound(call, {});
    frame(rec, 'out', toolCall(5, 'echo', {}));
    frame(rec, 'in', reply(5, COMPLETE));
    assert.deepEqual(frames(ws).map((f) => f.round_seq), [r2, r2]);
  } finally {
    ws.close();
  }
});
