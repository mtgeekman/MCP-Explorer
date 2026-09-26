// The server asking the human, through the backend API (phase 08): MRTR
// answered and retried only on the person's word (decisions 6 and 8, D21),
// and a legacy server's own requests held, linked, answered, refused,
// cancelled and interrupted (decisions 4, 5 and 11).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Backend } from '../packages/backend/dist/index.js';
import { BOTH_STATE } from '../scripts/fixture/call-handler.mjs';
import { memoryStore } from './support/memory-store.mjs';
import { fixtures } from './support/fixture-servers.mjs';

const root = mkdtempSync(join(tmpdir(), 'mcpx-callbacks-backend-'));
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

const stdioServer = (file, env = {}) => ({ name: file, transport: 'stdio', command: process.execPath, args: [join(fixtures, file)], env: { CALL_TOOLS: '1', ...env } });

async function connected(server, settings) {
  const backend = new Backend({ dataDir: mkdtempSync(join(root, 'data-')), secrets: memoryStore(), probeTimeoutMs: 1000, closeGraceMs: 300 });
  backends.push(backend);
  const events = [];
  backend.on((name, data) => events.push({ name, data }));
  const call = (method, params = {}) => backend.request(method, params);
  await call('workspaces.create', { name: 'Callbacks', protection: { kind: 'none' } });
  if (settings) await call('settings.update', { changes: settings });
  const { id: serverId } = await call('servers.save', { server });
  const state = await call('connections.connect', { serverId });
  assert.equal(state.status, 'connected', JSON.stringify(state));
  await waitFor(async () => (await call('surface.get', { serverId })).capture);
  return { backend, call, events, serverId };
}

const start = async (s, target, args = {}, kind = 'tool') => {
  const reply = await s.call('calls.start', { serverId: s.serverId, kind, target, args, confirmed: true });
  assert.equal(reply.started, true);
  return reply.callId;
};
const view = (s, callId) => s.call('calls.get', { callId });
const waiting = (s, callId) => waitFor(async () => { const v = await view(s, callId); return v?.live?.status === 'awaiting-input' ? v : null; });
const finished = (s, callId) => waitFor(async () => { const v = await view(s, callId); return v && !v.live && v.call.status !== 'in_progress' ? v : null; });

/** The JSON-RPC messages the app sent with this method, parsed from the wire log's exact bytes. */
async function sentBodies(s, method) {
  const units = await s.call('log.units', { serverId: s.serverId });
  return units.filter((u) => u.direction === 'out' && u.bytes && u.frames.some((f) => f.method === method))
    .map((u) => JSON.parse(Buffer.from(u.bytes).toString('utf8')));
}

const sampleAnswer = { role: 'assistant', content: { type: 'text', text: 'A line about ports.' }, model: 'human', stopReason: 'endTurn' };

test('modern: both requests are shown, every key must be answered, and the retry completes the call', async () => {
  const s = await connected(stdioServer('modern-server.mjs'));
  const callId = await start(s, 'mrtr_both', { topic: 'ports' });
  const v = await waiting(s, callId);
  assert.deepEqual(Object.keys(v.live.input.inputRequests).sort(), ['confirm', 'draft']);
  assert.equal(v.live.input.hasRequestState, true);
  assert.equal(v.live.input.round, 1);
  assert.equal(v.live.paused, undefined);
  assert.equal(JSON.stringify(v).includes(BOTH_STATE), false, 'requestState never leaves the backend except in the round record');

  await assert.rejects(s.call('calls.answer', { callId, inputResponses: { draft: sampleAnswer } }), /no answer for confirm/);
  await assert.rejects(s.call('calls.answer', { callId, inputResponses: { draft: sampleAnswer, confirm: { action: 'accept' }, other: 1 } }), /did not ask for other/);
  assert.equal((await sentBodies(s, 'tools/call')).length, 1, 'a refused answer sends nothing');

  const answers = { draft: sampleAnswer, confirm: { action: 'accept', content: { publish: true } } };
  await s.call('calls.answer', { callId, inputResponses: answers });
  const done = await finished(s, callId);
  assert.equal(done.call.status, 'completed');
  assert.equal(done.call.roundRecords.length, 2);
  assert.deepEqual(done.call.roundRecords[0].inputResponses, answers);
  assert.deepEqual(done.call.roundRecords[1].arguments, { topic: 'ports' });
  assert.match(done.call.roundRecords[1].result.content[0].text, /requestState intact/);
  const [first, retry] = await sentBodies(s, 'tools/call');
  assert.equal(retry.params.requestState, BOTH_STATE);
  assert.deepEqual(retry.params.inputResponses, answers);
  assert.notEqual(retry.id, first.id);
});

test('modern, D30: with results withheld the call still answers, from what the session holds', async () => {
  const s = await connected(stdioServer('modern-server.mjs'), { persistResults: false });
  const callId = await start(s, 'mrtr_both');
  const v = await waiting(s, callId);
  assert.equal(v.call.roundRecords[0].inputRequests, null, 'storage withheld the requests');
  assert.ok(v.live.input.inputRequests.draft, 'the live view has them');
  await s.call('calls.answer', { callId, inputResponses: { draft: sampleAnswer, confirm: { action: 'decline' } } });
  const done = await finished(s, callId);
  assert.equal(done.call.status, 'completed');
});

test('modern, D21: the soft cap pauses the call, answering waits for Keep answering, and Stop there ends it capped', async () => {
  const s = await connected(stdioServer('modern-server.mjs'), { mrtrSoftCap: 2 });
  const callId = await start(s, 'mrtr_loop');
  const again = { again: { action: 'accept', content: { ok: true } } };
  let v = await waiting(s, callId);
  assert.equal(v.live.paused, undefined, 'round 1 of 2');
  await s.call('calls.answer', { callId, inputResponses: again });
  v = await waitFor(async () => { const x = await view(s, callId); return x.live?.input?.round === 2 ? x : null; });
  assert.deepEqual(v.live.paused, { rounds: 2, cap: 2 });
  await assert.rejects(s.call('calls.answer', { callId, inputResponses: again }), /paused at the round limit/);
  assert.equal((await sentBodies(s, 'tools/call')).length, 2, 'nothing more went out while paused');

  await s.call('calls.continue', { callId });
  v = await view(s, callId);
  assert.equal(v.live.paused, undefined);
  await s.call('calls.answer', { callId, inputResponses: again });
  v = await waitFor(async () => { const x = await view(s, callId); return x.live?.input?.round === 3 ? x : null; });
  assert.equal(v.live.paused, undefined, 'continued: two more rounds before the next pause');
  await s.call('calls.answer', { callId, inputResponses: again });
  v = await waitFor(async () => { const x = await view(s, callId); return x.live?.input?.round === 4 ? x : null; });
  assert.deepEqual(v.live.paused, { rounds: 4, cap: 2 });

  await s.call('calls.stop', { callId });
  const done = await finished(s, callId);
  assert.equal(done.call.status, 'capped');
  assert.equal(done.call.rounds, 4);
});

test('modern: stopped before the cap, a waiting call ends abandoned with nothing sent', async () => {
  const s = await connected(stdioServer('modern-server.mjs'));
  const callId = await start(s, 'mrtr_url');
  const v = await waiting(s, callId);
  assert.equal(v.live.input.inputRequests.visit.params.mode, 'url');
  await s.call('calls.stop', { callId });
  assert.equal((await finished(s, callId)).call.status, 'abandoned');
  assert.equal((await sentBodies(s, 'tools/call')).length, 1);
});

test('modern: a requestState-only result is retried only when asked, with the state and no answers', async () => {
  const s = await connected(stdioServer('modern-server.mjs', { STATE_ONLY: '1' }));
  const callId = await start(s, 'needs_input');
  const v = await waiting(s, callId);
  assert.equal(v.live.input.inputRequests, null);
  assert.equal(v.live.input.hasRequestState, true);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal((await sentBodies(s, 'tools/call')).length, 1, 'no retry by itself (the SDK default would after 250 ms)');
  await assert.rejects(s.call('calls.answer', { callId, inputResponses: { x: 1 } }), /asked for no input/);
  await s.call('calls.answer', { callId });
  await waitFor(async () => (await sentBodies(s, 'tools/call')).length === 2);
  const [, retry] = await sentBodies(s, 'tools/call');
  assert.equal(retry.params.requestState, 'state-only');
  assert.equal('inputResponses' in retry.params, false);
});

test('modern: a result with neither field is flagged malformed and can only be stopped', async () => {
  const s = await connected(stdioServer('modern-server.mjs'));
  const callId = await start(s, 'mrtr_empty');
  const v = await waiting(s, callId);
  assert.match(v.live.input.malformed, /neither inputRequests nor requestState/);
  await assert.rejects(s.call('calls.answer', { callId }), /cannot be answered/);
  await s.call('calls.stop', { callId });
  assert.equal((await finished(s, callId)).call.status, 'abandoned');
});

test('modern: getting a prompt that asks is answered the same way', async () => {
  const s = await connected(stdioServer('modern-server.mjs'));
  const callId = await start(s, 'confirm_prompt', {}, 'prompt');
  await waiting(s, callId);
  await s.call('calls.answer', { callId, inputResponses: { sure: { action: 'accept', content: {} } } });
  const done = await finished(s, callId);
  assert.equal(done.call.status, 'completed');
  assert.match(done.call.roundRecords[1].result.messages[0].content.text, /confirmed/);
});

const pendingRequest = (s) => waitFor(async () => (await s.call('requests.list', { serverId: s.serverId })).find((r) => r.status === 'pending'));

test('legacy: a sampling request mid-call is linked to the call, answered, and the call completes', async () => {
  const s = await connected(stdioServer('legacy-server.mjs'));
  const callId = await start(s, 'ask_sampling');
  const req = await pendingRequest(s);
  assert.equal(req.method, 'sampling/createMessage');
  assert.equal(req.callId, callId);
  assert.equal(req.live.params.maxTokens, 100);
  assert.ok(s.events.some((e) => e.name === 'request.changed' && e.data.requestId === req.id && e.data.callId === callId));
  assert.equal((await view(s, callId)).serverRequests[0].status, 'pending', 'the transcript lists it');

  await s.call('requests.answer', { requestId: req.id, answer: { result: sampleAnswer } });
  const done = await finished(s, callId);
  assert.equal(done.call.status, 'completed');
  assert.match(done.call.roundRecords[0].result.content[0].text, /A line about ports/);
  const [answered] = done.serverRequests;
  assert.equal(answered.status, 'answered');
  assert.deepEqual(answered.response, sampleAnswer);
  assert.ok(answered.requestUnitId && answered.responseUnitId, 'both units are found');
  assert.equal(answered.live, undefined);
  await assert.rejects(s.call('requests.answer', { requestId: req.id, answer: { result: sampleAnswer } }), /not waiting/);
});

test('legacy: a refusal sends the error chosen, and a malformed answer is refused before anything goes', async () => {
  const s = await connected(stdioServer('legacy-server.mjs'));
  const callId = await start(s, 'ask_sampling');
  const req = await pendingRequest(s);
  await assert.rejects(s.call('requests.answer', { requestId: req.id, answer: { result: 'text' } }), /JSON object/);
  await assert.rejects(s.call('requests.answer', { requestId: req.id, answer: { error: { code: 1.5, message: 'x' } } }), /whole-number code/);
  assert.equal((await s.call('requests.list', { serverId: s.serverId }))[0].status, 'pending');
  await s.call('requests.answer', { requestId: req.id, answer: { error: { code: -1, message: 'User rejected sampling request' } } });
  const done = await finished(s, callId);
  assert.match(done.call.roundRecords[0].result.content[0].text, /User rejected sampling request/);
  assert.equal(done.serverRequests[0].status, 'refused');
  assert.deepEqual(done.serverRequests[0].response, { error: { code: -1, message: 'User rejected sampling request' } });
});

test('legacy: the server cancelling its request ends it cancelled', async () => {
  const s = await connected(stdioServer('legacy-server.mjs'));
  const callId = await start(s, 'ask_sampling', { cancelAfterMs: 150 });
  const req = await pendingRequest(s);
  await finished(s, callId);
  const r = await waitFor(async () => (await s.call('requests.list', { serverId: s.serverId })).find((x) => x.id === req.id && x.status !== 'pending'));
  assert.equal(r.status, 'cancelled');
  await assert.rejects(s.call('requests.answer', { requestId: req.id, answer: { result: sampleAnswer } }), /not waiting/);
});

test('legacy: a request outside any call is linked to none, and ends interrupted with the session', async () => {
  const s = await connected(stdioServer('legacy-server.mjs', { ROOTS_ON_INIT: '1' }));
  const req = await pendingRequest(s);
  assert.equal(req.method, 'roots/list');
  assert.equal(req.callId, null);
  await s.call('connections.disconnect', { serverId: s.serverId });
  const r = await waitFor(async () => (await s.call('requests.list', { serverId: s.serverId })).find((x) => x.id === req.id && x.status !== 'pending'));
  assert.equal(r.status, 'interrupted');
});

test('legacy: with two calls running, a request is linked to neither', async () => {
  const s = await connected(stdioServer('legacy-server.mjs'));
  const slow = await start(s, 'slow', { steps: 20, delayMs: 100 });
  const asking = await start(s, 'ask_sampling');
  const req = await pendingRequest(s);
  assert.equal(req.callId, null);
  await s.call('requests.answer', { requestId: req.id, answer: { result: sampleAnswer } });
  await finished(s, asking);
  await s.call('calls.cancel', { callId: slow });
  await finished(s, slow);
});
