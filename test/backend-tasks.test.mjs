// Task calls through the backend (plan phase 10, decision 2): one call, its
// task requests as further rounds, sent only on the user's word.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Backend } from '../packages/backend/dist/index.js';
import { memoryStore } from './support/memory-store.mjs';
import { fixtures } from './support/fixture-servers.mjs';

const root = mkdtempSync(join(tmpdir(), 'mcpx-btasks-'));
const backends = [];
after(async () => {
  for (const b of backends) await b.shutdown();
  rmSync(root, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (check, what, ms = 10000) => {
  const end = Date.now() + ms;
  let v;
  while (!(v = await check())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
  return v;
};

async function connected(file) {
  const backend = new Backend({ dataDir: mkdtempSync(join(root, 'data-')), secrets: memoryStore(), closeGraceMs: 300 });
  backends.push(backend);
  const call = (method, params = {}) => backend.request(method, params);
  await call('workspaces.create', { name: 'Tasks', protection: { kind: 'none' } });
  const { id } = await call('servers.save', { server: { name: 'fixture', transport: 'stdio', command: process.execPath, args: [join(fixtures, file)], env: { EXTRAS: '1', LEGACY_REVISION: '2025-11-25' } } });
  await call('connections.connect', { serverId: id });
  await until(async () => (await call('surface.get', { serverId: id })).capture, 'the capture');
  return { call, id };
}

const view = (call, callId) => call('calls.get', { callId });
const waitStatus = (call, callId, status) => until(async () => { const v = await view(call, callId); return v.live?.status === status ? v : undefined; }, `live ${status}`);
const waitEnd = (call, callId) => until(async () => { const v = await view(call, callId); return v.call.status !== 'in_progress' ? v : undefined; }, 'the call to end');

test('legacy: a task call stays open, and get then result are rounds of it, each on request', async () => {
  const { call, id } = await connected('legacy-server.mjs');
  const confirm = await call('calls.start', { serverId: id, kind: 'tool', target: 'task_work', args: { ms: 150 }, asTask: { ttl: 30000 } });
  assert.equal(confirm.started, false);
  assert.deepEqual(confirm.confirm.params.task, { ttl: 30000 }, 'the confirm shows the task field it will send');
  const { callId } = await call('calls.start', { serverId: id, kind: 'tool', target: 'task_work', args: { ms: 150 }, asTask: { ttl: 30000 }, confirmed: true });
  const waiting = await waitStatus(call, callId, 'task');
  assert.equal(waiting.live.task.era, 'legacy');
  assert.equal(waiting.live.task.pollInterval, 500);
  await sleep(700);
  assert.equal((await view(call, callId)).call.roundRecords.length, 1, 'no polling while the user does nothing');

  // The fixture announces the end; the notice updates the task, sends nothing.
  await until(async () => (await view(call, callId)).live.task.status === 'completed', 'the status notice');
  await call('calls.task', { callId, op: 'get' });
  await until(async () => (await view(call, callId)).call.roundRecords.length === 2 && (await view(call, callId)).live?.status === 'task', 'the get round');
  await call('calls.task', { callId, op: 'result' });
  const done = await waitEnd(call, callId);
  assert.equal(done.call.status, 'completed');
  assert.deepEqual(done.call.roundRecords.map((r) => [r.method, r.resultType]), [[null, 'task'], ['tasks/get', null], ['tasks/result', null]]);
  assert.match(done.call.roundRecords[2].result.content[0].text, /done after 150 ms/);
  assert.ok(done.call.roundRecords[1].requestUnitId !== null, 'the get round is bound to its frames');
});

test('legacy: Cancel on a task call sends tasks/cancel and ends it cancelled', async () => {
  const { call, id } = await connected('legacy-server.mjs');
  const { callId } = await call('calls.start', { serverId: id, kind: 'tool', target: 'task_work', args: { ms: 5000 }, asTask: {}, confirmed: true });
  await waitStatus(call, callId, 'task');
  await call('calls.cancel', { callId });
  const done = await waitEnd(call, callId);
  assert.equal(done.call.status, 'cancelled');
  assert.equal(done.call.roundRecords[1].method, 'tasks/cancel');
  await assert.rejects(call('calls.task', { callId, op: 'get' }));
});

test('legacy: tasks/list through the session', async () => {
  const { call, id } = await connected('legacy-server.mjs');
  const { callId } = await call('calls.start', { serverId: id, kind: 'tool', target: 'task_work', args: { ms: 5000 }, asTask: {}, confirmed: true });
  const { live } = await waitStatus(call, callId, 'task');
  const listed = await call('session.tasks', { serverId: id });
  assert.ok(listed.result.tasks.some((t) => t.taskId === live.task.taskId));
});

test('modern: a task that asks for input is answered with tasks/update, then completes on get', async () => {
  const { call, id } = await connected('modern-server.mjs');
  const { callId } = await call('calls.start', { serverId: id, kind: 'tool', target: 'task_ask', args: { ms: 20 }, confirmed: true });
  const waiting = await waitStatus(call, callId, 'task');
  assert.equal(waiting.live.task.era, 'modern');
  await sleep(60);
  await call('calls.task', { callId, op: 'get' });
  const asked = await waitStatus(call, callId, 'awaiting-input');
  assert.deepEqual(Object.keys(asked.live.input.inputRequests), ['confirm']);
  await assert.rejects(call('calls.answer', { callId, inputResponses: {} }), /no answer for confirm/);
  await call('calls.answer', { callId, inputResponses: { confirm: { action: 'accept', content: { go: true } } } });
  await waitStatus(call, callId, 'task');
  await call('calls.task', { callId, op: 'get' });
  const done = await waitEnd(call, callId);
  assert.equal(done.call.status, 'completed');
  assert.deepEqual(done.call.roundRecords.map((r) => r.method), [null, 'tasks/get', 'tasks/update', 'tasks/get']);
  assert.deepEqual(done.call.roundRecords[1].inputResponses, { confirm: { action: 'accept', content: { go: true } } });
  assert.match(done.call.roundRecords[3].result.result.content[0].text, /"go":true/);
  await assert.rejects(call('calls.task', { callId, op: 'result' }));
});

test('a task call left waiting ends interrupted with its session', async () => {
  const { call, id } = await connected('modern-server.mjs');
  const { callId } = await call('calls.start', { serverId: id, kind: 'tool', target: 'task_work', args: { ms: 5000 }, confirmed: true });
  await waitStatus(call, callId, 'task');
  await call('connections.disconnect', { serverId: id });
  assert.equal((await waitEnd(call, callId)).call.status, 'interrupted');
});

test('legacy: a server request naming the task in related-task is linked to its call, even with another call running', async () => {
  const { call, id } = await connected('legacy-server.mjs');
  const { callId: other } = await call('calls.start', { serverId: id, kind: 'tool', target: 'task_work', args: { ms: 5000 }, asTask: {}, confirmed: true });
  await waitStatus(call, other, 'task');
  const { callId } = await call('calls.start', { serverId: id, kind: 'tool', target: 'task_elicit', args: {}, asTask: {}, confirmed: true });
  const request = await until(async () => (await call('requests.list', { serverId: id }))[0], 'the request');
  assert.equal(request.callId, callId);
  await call('requests.answer', { requestId: request.id, answer: { result: { action: 'accept', content: { name: 'x' } } } });
  await until(async () => (await view(call, callId)).live.task.status === 'completed', 'the task to complete');
  assert.equal((await view(call, callId)).serverRequests.length, 1);
});
