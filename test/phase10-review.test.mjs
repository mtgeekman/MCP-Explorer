// Phase 10 code review, round 1: one test per finding (R10-n), written
// before the fixes and watched failing on the phase's code.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectHttp, hashResource, hashResourceTemplate } from '../packages/protocol/dist/index.js';
import { Backend } from '../packages/backend/dist/index.js';
import { memoryStore } from './support/memory-store.mjs';
import { fixtures, listen } from './support/fixture-servers.mjs';

const root = mkdtempSync(join(tmpdir(), 'mcpx-r10-'));
const children = [];
const backends = [];
const open = [];
after(async () => {
  for (const c of open) await c.close().catch(() => undefined);
  for (const b of backends) await b.shutdown();
  for (const c of children) c.kill();
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

async function connected(file, env) {
  const backend = new Backend({ dataDir: mkdtempSync(join(root, 'data-')), secrets: memoryStore(), closeGraceMs: 300 });
  backends.push(backend);
  const call = (method, params = {}) => backend.request(method, params);
  await call('workspaces.create', { name: 'R10', protection: { kind: 'none' } });
  const { id } = await call('servers.save', { server: { name: 'fixture', transport: 'stdio', command: process.execPath, args: [join(fixtures, file)], env: { EXTRAS: '1', ...env } } });
  await call('connections.connect', { serverId: id });
  await until(async () => (await call('surface.get', { serverId: id })).capture, 'the capture');
  return { call, id };
}
const view = (call, callId) => call('calls.get', { callId });

test('R10-1: a stream that sent an event id and closed is resumed by the SDK; the request is not failed early', { timeout: 20_000 }, async () => {
  const url = await listen('http-server.mjs', children, { CALL_TOOLS: '1', SSE_PRIMED_CUT: '1' });
  const units = [];
  const conn = await connectHttp({ url, onUnit: (u) => units.push(u) });
  open.push(conn);
  const outcome = await conn.call({ kind: 'tool', target: 'add', args: { a: 2, b: 3 } });
  assert.equal(outcome.kind, 'result', `the resumed response is the outcome, got ${outcome.kind}: ${outcome.message ?? ''}`);
  assert.deepEqual(outcome.result.structuredContent, { sum: 5 });
  const events = units.filter((u) => u.kind === 'app').map((u) => JSON.parse(Buffer.from(u.bytes).toString('utf8')));
  assert.deepEqual(events.filter((e) => e.event === 'stream-ended-without-response'), []);
});

test('R10-2: a legacy task at input_required stays a task after Get status; its input comes by server request', async () => {
  const { call, id } = await connected('legacy-server.mjs', { LEGACY_REVISION: '2025-11-25' });
  const { callId } = await call('calls.start', { serverId: id, kind: 'tool', target: 'task_elicit', args: {}, asTask: {}, confirmed: true });
  await until(async () => (await view(call, callId)).live?.status === 'task', 'the task');
  await call('calls.task', { callId, op: 'get' });
  const after = await until(async () => { const v = await view(call, callId); return v.live && v.live.status !== 'running' ? v : undefined; }, 'the get round');
  assert.equal(after.live.status, 'task');
  assert.equal(after.live.task.status, 'input_required');
  assert.equal(after.live.input, undefined);
});

test('R10-3: a resource\'s size and annotations.lastModified are not hashed; the rest of annotations is', () => {
  const r = { uri: 'file:///log', name: 'log' };
  assert.equal(hashResource({ ...r, size: 1 }), hashResource({ ...r, size: 2 }));
  assert.equal(hashResource({ ...r, annotations: { priority: 1, lastModified: '2026-01-01T00:00:00Z' } }), hashResource({ ...r, annotations: { priority: 1, lastModified: '2026-09-26T00:00:00Z' } }));
  assert.notEqual(hashResource({ ...r, annotations: { priority: 1 } }), hashResource({ ...r, annotations: { priority: 0.5 } }), 'old valid input: priority still counts');
  const t = { uriTemplate: 'file:///{x}', name: 't' };
  assert.equal(hashResourceTemplate({ ...t, annotations: { lastModified: 'a' } }), hashResourceTemplate({ ...t, annotations: { lastModified: 'b' } }));
  assert.equal(hashResource({ ...r, annotations: { lastModified: 'a' } }), hashResource(r), 'an annotations object holding only lastModified hashes as none');
});

test('R10-4: a timeline row carries the exact bytes it arrived in', async () => {
  const { call, id } = await connected('legacy-server.mjs', { ODD_BYTES: '1' });
  await call('session.setLogLevel', { serverId: id, level: 'emergency' });
  await call('calls.start', { serverId: id, kind: 'tool', target: 'log_burst', args: {}, confirmed: true });
  const rows = await until(async () => { const n = await call('notifications.list', { serverId: id }); return n.length ? n : undefined; }, 'the message');
  const unit = await call('log.get', { id: rows[0].unitId });
  assert.equal(rows[0].raw, Buffer.from(unit.bytes).toString('utf8'), 'byte for byte, odd spacing and all');
});

test('R10-5: the timeline reloads only while it is open, and only for its own server\'s notifications', async () => {
  const { reloadsTimeline } = await import('../app/renderer/src/lib/session.ts');
  const unit = (o) => ({ serverId: 's', direction: 'in', frames: [{ method: 'notifications/message', jsonrpcId: null, resultWithheld: false }], ...o });
  assert.equal(reloadsTimeline(false, 's', unit({})), false, 'hidden: nothing is read');
  assert.equal(reloadsTimeline(true, 's', unit({})), true);
  assert.equal(reloadsTimeline(true, 'other', unit({})), false);
  assert.equal(reloadsTimeline(true, 's', unit({ frames: [{ method: 'tools/call', jsonrpcId: '1', resultWithheld: false }] })), false);
});

test('R10-6 (refutation): cancelling a task waiting for input leaves nothing to answer, and Get status ends it', async () => {
  const { call, id } = await connected('modern-server.mjs');
  const { callId } = await call('calls.start', { serverId: id, kind: 'tool', target: 'task_ask', args: { ms: 10 }, confirmed: true });
  await until(async () => (await view(call, callId)).live?.status === 'task', 'the task');
  await sleep(50);
  await call('calls.task', { callId, op: 'get' });
  await until(async () => (await view(call, callId)).live?.status === 'awaiting-input', 'the input');
  await call('calls.cancel', { callId });
  await until(async () => (await view(call, callId)).live?.status === 'task', 'the cancel round');
  await assert.rejects(call('calls.answer', { callId, inputResponses: { confirm: { action: 'accept', content: { go: true } } } }), /not waiting for input/);
  await call('calls.task', { callId, op: 'get' });
  assert.equal((await until(async () => { const v = await view(call, callId); return v.call.status !== 'in_progress' ? v : undefined; }, 'the end')).call.status, 'cancelled');
});

test('R10-7: a legacy result carrying a task field, from a call not made as a task, is an ordinary result', async () => {
  const { call, id } = await connected('legacy-server.mjs', { LEGACY_REVISION: '2025-11-25' });
  const { callId } = await call('calls.start', { serverId: id, kind: 'tool', target: 'task_shaped', args: {}, confirmed: true });
  const done = await until(async () => { const v = await view(call, callId); return v.call.status !== 'in_progress' ? v : undefined; }, 'the call to end');
  assert.equal(done.call.status, 'completed');
  assert.equal(done.call.roundRecords[0].resultType, null);
});

test('R10-4 twin: notifications that arrived as HTTP event-stream events reach the timeline too', async () => {
  const url = await listen('http-server.mjs', children, { EXTRAS: '1', STREAMING: '1' });
  const backend = new Backend({ dataDir: mkdtempSync(join(root, 'data-')), secrets: memoryStore(), closeGraceMs: 300 });
  backends.push(backend);
  const call = (method, params = {}) => backend.request(method, params);
  await call('workspaces.create', { name: 'R10 http', protection: { kind: 'none' } });
  const { id } = await call('servers.save', { server: { name: 'http', transport: 'streamable-http', url } });
  await call('connections.connect', { serverId: id });
  await until(async () => (await call('surface.get', { serverId: id })).capture, 'the capture');
  await call('session.setLogLevel', { serverId: id, level: 'emergency' });
  await call('calls.start', { serverId: id, kind: 'tool', target: 'log_burst', args: {}, confirmed: true });
  const rows = await until(async () => { const n = await call('notifications.list', { serverId: id }); return n.length ? n : undefined; }, 'the message in the timeline');
  assert.equal(rows[0].method, 'notifications/message');
  assert.match(rows[0].raw, /^event: message\ndata: /, 'the raw column is the event as it arrived');
});

// Round 2: the re-review of the round 1 fixes.

const settles = (p, ms) => Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error(`still pending after ${ms} ms`)), ms))]);
const orphanEvents = (units) => units.filter((u) => u.kind === 'app').map((u) => JSON.parse(Buffer.from(u.bytes).toString('utf8'))).filter((e) => e.event === 'stream-ended-without-response');

test('R10-9: an event with an id and no data is nothing the SDK resumes from, so the request fails rather than hangs', { timeout: 20_000 }, async () => {
  const url = await listen('http-server.mjs', children, { CALL_TOOLS: '1', SSE_ID_ONLY_CUT: '1' });
  const units = [];
  const conn = await connectHttp({ url, onUnit: (u) => units.push(u) });
  open.push(conn);
  const outcome = await settles(conn.call({ kind: 'tool', target: 'add', args: { a: 1, b: 1 } }), 5000);
  assert.equal(outcome.kind, 'failed');
  assert.match(outcome.message, /event stream ended without a response/);
  assert.equal(orphanEvents(units).length, 1);
});

test('R10-10: a resumable stream whose resume the server refuses fails the request once the SDK gives up', { timeout: 20_000 }, async () => {
  const url = await listen('http-server.mjs', children, { CALL_TOOLS: '1', SSE_PRIMED_CUT: '1', RESUME_REFUSED: '1' });
  const units = [];
  const conn = await connectHttp({ url, onUnit: (u) => units.push(u) });
  open.push(conn);
  const outcome = await settles(conn.call({ kind: 'tool', target: 'add', args: { a: 1, b: 1 } }), 8000);
  assert.equal(outcome.kind, 'failed');
  assert.equal(orphanEvents(units).length, 1);
});

test('R10-11: a resource\'s empty annotations and annotations holding only lastModified hash alike, as no annotations', () => {
  const r = { uri: 'file:///a', name: 'a' };
  assert.equal(hashResource({ ...r, annotations: {} }), hashResource({ ...r, annotations: { lastModified: 'x' } }));
  assert.equal(hashResource({ ...r, annotations: {} }), hashResource(r));
  const t = { uriTemplate: 'file:///{x}', name: 't' };
  assert.equal(hashResourceTemplate({ ...t, annotations: {} }), hashResourceTemplate(t));
});

test('R10-11 (old valid input): a tool\'s empty annotations still hash as present, as stored since phase 01', async () => {
  const { hashTool } = await import('../packages/protocol/dist/index.js');
  const tool = { name: 'x', inputSchema: { type: 'object' } };
  assert.notEqual(hashTool({ ...tool, annotations: {} }), hashTool(tool));
});

test('R10-10 (old valid input): an event stream that delivered its response records no stream-ended event', { timeout: 20_000 }, async () => {
  const url = await listen('http-server.mjs', children, { CALL_TOOLS: '1', SSE_REPLIES: '1' });
  const units = [];
  const conn = await connectHttp({ url, onUnit: (u) => units.push(u) });
  open.push(conn);
  for (let i = 0; i < 5; i++) assert.equal((await conn.call({ kind: 'tool', target: 'add', args: { a: i, b: 1 } })).kind, 'result');
  await sleep(100);
  assert.deepEqual(orphanEvents(units), []);
});
