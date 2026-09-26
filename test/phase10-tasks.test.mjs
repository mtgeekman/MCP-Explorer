// Tasks in the adapter, on both eras (plan phase 10, decision 2): the
// extension declared on modern only, legacy task-augmented calls and the four
// core methods, the modern task methods framed outside the SDK's refusal, and
// nothing ever polled.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { connectStdio, connectHttp, requiredCapabilities, TASKS_EXTENSION } from '../packages/protocol/dist/index.js';
import { fixtures, listen } from './support/fixture-servers.mjs';

const MODERN = join(fixtures, 'modern-server.mjs');
const LEGACY = join(fixtures, 'legacy-server.mjs');
const open = [];
const children = [];
const dir = mkdtempSync(join(tmpdir(), 'mcpx-tasks-'));
after(async () => {
  for (const c of open) await c.close().catch(() => undefined);
  for (const c of children) c.kill();
  rmSync(dir, { recursive: true, force: true });
});

async function stdio(file, env = {}) {
  const frames = [];
  const notes = [];
  const conn = await connectStdio({
    command: process.execPath, args: [file], env: { ...process.env, EXTRAS: '1', LEGACY_REVISION: '2025-11-25', ...env },
    onFrame: (direction, frame) => frames.push({ direction, frame }),
    onNotification: (n) => notes.push(n),
  });
  open.push(conn);
  return { conn, frames, notes };
}

const sent = (frames, method) => frames.filter((f) => f.direction === 'out' && f.frame.method === method);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('the tasks extension is declared on modern requests and never on a legacy handshake', async () => {
  const modern = await stdio(MODERN);
  await modern.conn.call({ kind: 'tool', target: 'echo', args: { text: 'x' } });
  const call = sent(modern.frames, 'tools/call').at(-1).frame;
  assert.deepEqual(call.params._meta['io.modelcontextprotocol/clientCapabilities'].extensions, { [TASKS_EXTENSION]: {} });

  const legacy = await stdio(LEGACY);
  const init = sent(legacy.frames, 'initialize')[0].frame;
  assert.equal(init.params.capabilities.extensions, undefined);
});

test('legacy: a task-augmented call returns the task; get, list, result each go out once, on request', async () => {
  const { conn, frames, notes } = await stdio(LEGACY);
  assert.deepEqual((await conn.source.listTools()).items.find((t) => t.name === 'task_work').execution, { taskSupport: 'optional' });
  const created = await conn.call({ kind: 'tool', target: 'task_work', args: { ms: 150 }, task: { ttl: 60000 } });
  assert.equal(sent(frames, 'tools/call').at(-1).frame.params.task.ttl, 60000);
  const task = created.result.task;
  assert.equal(task.status, 'working');

  const got = await conn.task({ method: 'tasks/get', params: { taskId: task.taskId } });
  assert.equal(got.result.status, 'working');
  const listed = await conn.task({ method: 'tasks/list', params: {} });
  assert.ok(listed.result.tasks.some((t) => t.taskId === task.taskId));
  const result = await conn.task({ method: 'tasks/result', params: { taskId: task.taskId } });
  assert.match(result.result.content[0].text, /done after 150 ms/);

  await sleep(100);
  assert.equal(sent(frames, 'tasks/get').length, 1, 'nothing polled');
  assert.ok(notes.some((n) => n.method === 'notifications/tasks/status' && n.params.taskId === task.taskId && n.params.status === 'completed'));
});

test('legacy: tasks/cancel, and tasks/update refused as not on this revision', async () => {
  const { conn, frames } = await stdio(LEGACY);
  const { result } = await conn.call({ kind: 'tool', target: 'task_work', args: { ms: 5000 }, task: {} });
  const cancelled = await conn.task({ method: 'tasks/cancel', params: { taskId: result.task.taskId } });
  assert.equal(cancelled.result.status, 'cancelled');
  const refused = await conn.task({ method: 'tasks/update', params: { taskId: result.task.taskId, inputResponses: {} } });
  assert.equal(refused.kind, 'failed');
  assert.equal(sent(frames, 'tasks/update').length, 0);
});

test('modern: the server answers resultType task, and tasks/get goes out framed by the adapter and comes back paired', async () => {
  const { conn, frames } = await stdio(MODERN);
  const created = await conn.call({ kind: 'tool', target: 'task_work', args: { ms: 100 } });
  assert.equal(created.kind, 'result', 'the task handle is kept, whatever the SDK thinks of it');
  assert.equal(created.result.resultType, 'task');
  const { taskId } = created.result;

  await sleep(150);
  const got = await conn.task({ method: 'tasks/get', params: { taskId } });
  assert.equal(got.kind, 'result');
  assert.equal(got.result.status, 'completed');
  assert.match(got.result.result.content[0].text, /done after 100 ms/);
  const frame = sent(frames, 'tasks/get')[0].frame;
  assert.equal(typeof frame.id, 'string');
  assert.equal(frame.id, got.requestId);
  assert.equal(frame.params._meta['io.modelcontextprotocol/protocolVersion'], '2026-07-28', 'the SDK\'s own envelope');
  assert.deepEqual(frame.params._meta['io.modelcontextprotocol/clientCapabilities'].extensions, { [TASKS_EXTENSION]: {} });
});

test('modern: a task at input_required is answered with tasks/update, and a task can be cancelled', async () => {
  const { conn } = await stdio(MODERN);
  const { result } = await conn.call({ kind: 'tool', target: 'task_ask', args: { ms: 20 } });
  await sleep(80);
  const waiting = await conn.task({ method: 'tasks/get', params: { taskId: result.taskId } });
  assert.equal(waiting.result.status, 'input_required');
  assert.ok(waiting.result.inputRequests.confirm);
  const updated = await conn.task({ method: 'tasks/update', params: { taskId: result.taskId, inputResponses: { confirm: { action: 'accept', content: { go: true } } } } });
  assert.equal(updated.kind, 'result');
  const done = await conn.task({ method: 'tasks/get', params: { taskId: result.taskId } });
  assert.equal(done.result.status, 'completed');

  const second = (await conn.call({ kind: 'tool', target: 'task_work', args: { ms: 5000 } })).result;
  assert.equal((await conn.task({ method: 'tasks/cancel', params: { taskId: second.taskId } })).kind, 'result');
  assert.equal((await conn.task({ method: 'tasks/get', params: { taskId: second.taskId } })).result.status, 'cancelled');
  assert.equal((await conn.task({ method: 'tasks/result', params: { taskId: second.taskId } })).kind, 'failed', 'tasks/result is legacy only');
});

test('modern: notifications/tasks arrives on a listen naming the task', async () => {
  const { conn, notes } = await stdio(MODERN);
  const { result } = await conn.call({ kind: 'tool', target: 'task_work', args: { ms: 100 } });
  const handle = conn.listen({ taskIds: [result.taskId] });
  const end = Date.now() + 3000;
  while (!notes.some((n) => n.method === 'notifications/tasks' && n.params.status === 'completed')) {
    if (Date.now() > end) throw new Error('no task notice');
    await sleep(10);
  }
  handle.close();
});

test('modern: a pending framed request fails when the session ends, rather than hanging', async () => {
  const { conn } = await stdio(MODERN, { EXIT_ON: 'tasks/get' });
  const { result } = await conn.call({ kind: 'tool', target: 'task_work', args: { ms: 10 } });
  const outcome = await conn.task({ method: 'tasks/get', params: { taskId: result.taskId } });
  assert.equal(outcome.kind, 'failed');
});

test('-32021: accepted when the app declares what the server needs, and named when it does not (deferred phase 08)', async () => {
  const declared = await stdio(MODERN);
  assert.equal((await declared.conn.call({ kind: 'tool', target: 'needs_tasks', args: {} })).kind, 'result');
  const { conn } = await stdio(MODERN, { REQUIRED_EXTENSION: 'com.example/unheard-of' });
  const outcome = await conn.call({ kind: 'tool', target: 'needs_tasks', args: {} });
  assert.equal(outcome.kind, 'error');
  assert.equal(outcome.error.code, -32021);
  assert.deepEqual(requiredCapabilities(outcome.error), ['extensions.com.example/unheard-of']);
});

test('requiredCapabilities reads nested capabilities and ignores other errors', () => {
  assert.deepEqual(requiredCapabilities({ code: -32021, data: { requiredCapabilities: { sampling: { tools: {} }, roots: {}, extensions: { 'a.b/c': { deep: 1 } } } } }), ['extensions.a.b/c', 'roots', 'sampling.tools']);
  assert.deepEqual(requiredCapabilities({ code: -32021 }), []);
  assert.equal(requiredCapabilities({ code: -32602, data: { requiredCapabilities: { roots: {} } } }), undefined);
});

test('modern over HTTP: a task request carries Mcp-Name equal to its taskId', async () => {
  const log = join(dir, 'headers.log');
  const url = await listen('http-server.mjs', children, { EXTRAS: '1', MCP_HEADER_LOG: log });
  const conn = await connectHttp({ url });
  open.push(conn);
  const { result } = await conn.call({ kind: 'tool', target: 'task_work', args: { ms: 10 } });
  await conn.task({ method: 'tasks/get', params: { taskId: result.taskId } });
  const lines = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const get = lines.find((h) => h['mcp-method'] === 'tasks/get');
  assert.equal(get['mcp-name'], result.taskId);
});
