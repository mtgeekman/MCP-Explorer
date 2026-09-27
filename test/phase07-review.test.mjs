// Pins for the phase 07 code review's findings (R07-n), each named.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectHttp, connectStdio } from '../packages/protocol/dist/index.js';
import { Backend } from '../packages/backend/dist/index.js';
import { memoryStore } from './support/memory-store.mjs';
import { fixtures, listen } from './support/fixture-servers.mjs';

const root = mkdtempSync(join(tmpdir(), 'mcpx-r07-'));
const children = [];
const backends = [];
after(async () => {
  for (const b of backends) await b.shutdown();
  for (const c of children) c.kill();
  rmSync(root, { recursive: true, force: true });
});

const appEvents = (units) => units.filter((u) => u.kind === 'app').map((u) => JSON.parse(Buffer.from(u.bytes).toString('utf8')));

test('R07-2: closing a Streamable HTTP session logs no abort for requests that already finished', async () => {
  const url = await listen('http-server.mjs', children, { CALL_TOOLS: '1' });
  const units = [];
  const conn = await connectHttp({ url, onUnit: (u) => units.push(u) });
  for (let i = 0; i < 3; i++) assert.equal((await conn.call({ kind: 'tool', target: 'add', args: { a: i, b: 1 } })).kind, 'result');
  await conn.close();
  assert.deepEqual(appEvents(units).filter((e) => e.event === 'request-aborted'), []);
});

test('R07-2: a user cancel over Streamable HTTP is still logged as an abort (old valid behavior)', async () => {
  const url = await listen('http-server.mjs', children, { CALL_TOOLS: '1' });
  const units = [];
  const conn = await connectHttp({ url, onUnit: (u) => units.push(u) });
  try {
    const abort = new AbortController();
    const pending = conn.call({ kind: 'tool', target: 'slow', args: { steps: 20, delayMs: 50 }, signal: abort.signal });
    setTimeout(() => abort.abort('the user cancelled'), 100);
    assert.equal((await pending).kind, 'cancelled');
    assert.equal(appEvents(units).filter((e) => e.event === 'request-aborted').length, 1);
  } finally {
    await conn.close();
  }
});

test('R07-4: a cancel pressed after the response arrived reports the result, and sends no cancellation', async () => {
  const frames = [];
  const abort = new AbortController();
  const conn = await connectStdio({
    command: process.execPath, args: [join(fixtures, 'modern-server.mjs')], env: { ...process.env, CALL_TOOLS: '1' },
    onFrame: (direction, frame) => {
      frames.push({ direction, frame });
      // The user's Cancel lands after the response, before the caller sees it.
      if (direction === 'in' && frame.result?.structuredContent) queueMicrotask(() => abort.abort('late cancel'));
    },
  });
  try {
    const outcome = await conn.call({ kind: 'tool', target: 'add', args: { a: 1, b: 2 }, signal: abort.signal });
    assert.equal(outcome.kind, 'result');
    assert.deepEqual(outcome.result.structuredContent, { sum: 3 });
    assert.equal(frames.filter((f) => f.direction === 'out' && f.frame.method === 'notifications/cancelled').length, 0);
  } finally {
    await conn.close();
  }
});

async function backendWith(server) {
  const backend = new Backend({ dataDir: mkdtempSync(join(root, 'data-')), secrets: memoryStore(), closeGraceMs: 300 });
  backends.push(backend);
  const call = (method, params = {}) => backend.request(method, params);
  await call('workspaces.create', { name: 'R07', protection: { kind: 'none' } });
  const { id: serverId } = await call('servers.save', { server });
  await call('connections.connect', { serverId });
  for (let i = 0; i < 200 && !(await call('surface.get', { serverId })).capture; i++) await new Promise((r) => setTimeout(r, 25));
  const finished = async (callId) => {
    for (;;) {
      const v = await call('calls.get', { callId });
      if (v.call.status !== 'in_progress' && !v.live) return v;
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  return { backend, call, serverId, finished };
}

test('R07-3: a result storage keeps is not also held in memory; a withheld one is', async () => {
  const s = await backendWith({ name: 'm', transport: 'stdio', command: process.execPath, args: [join(fixtures, 'modern-server.mjs')], env: { CALL_TOOLS: '1' } });
  const held = () => s.backend.calls.session.size;
  await s.finished((await s.call('calls.start', { serverId: s.serverId, kind: 'tool', target: 'add', args: { a: 1, b: 1 } })).callId);
  assert.equal(held(), 0, 'storage has this result; memory need not');
  await s.call('settings.update', { changes: { persistResults: false } });
  const withheld = await s.finished((await s.call('calls.start', { serverId: s.serverId, kind: 'tool', target: 'add', args: { a: 2, b: 2 } })).callId);
  assert.equal(held(), 1);
  assert.deepEqual(withheld.sessionResult.structuredContent, { sum: 4 }, 'old valid behavior: the withheld result is still readable this session');
});

test('R07-3: the SDK\'s objection is kept for this session even when the result is stored', async () => {
  const s = await backendWith({ name: 'm', transport: 'stdio', command: process.execPath, args: [join(fixtures, 'modern-server.mjs')], env: { CALL_TOOLS: '1' } });
  const view = await s.finished((await s.call('calls.start', { serverId: s.serverId, kind: 'tool', target: 'media', args: {} })).callId);
  assert.ok(view.sdkRejected);
});

test('R07-9: export over HTTP+SSE gives the request but no curl, and says why', async () => {
  const url = await listen('sse-server.mjs', children, { CALL_TOOLS: '1' });
  const s = await backendWith({ name: 'sse', transport: 'sse', url });
  const view = await s.finished((await s.call('calls.start', { serverId: s.serverId, kind: 'tool', target: 'add', args: { a: 1, b: 2 } })).callId);
  const exported = await s.call('calls.export', { callId: view.call.id });
  assert.ok(exported.bytes);
  assert.equal(exported.curl, undefined);
  assert.match(exported.reason, /event stream/);
});

test('R07-2 (re-review): an event stream that dies mid-event is logged, and leaves no abort listener for close to fire', async () => {
  const url = await listen('http-server.mjs', children, { CALL_TOOLS: '1', SSE_CUT: '1' });
  const units = [];
  const conn = await connectHttp({ url, onUnit: (u) => units.push(u) });
  // Since phase 10 (decision 13) the request fails when its stream dies; the
  // session is closed under it here all the same, which is what this pins.
  const pending = conn.call({ kind: 'tool', target: 'add', args: { a: 1, b: 2 } });
  let post;
  for (let i = 0; i < 100 && !post; i++) {
    post = units.find((x) => x.direction === 'out' && x.kind === 'wire' && Buffer.from(x.bytes).includes('tools/call'));
    await new Promise((r) => setTimeout(r, 20));
  }
  await new Promise((r) => setTimeout(r, 500));
  await conn.close();
  await Promise.race([pending, new Promise((r) => setTimeout(r, 2000))]);
  const exchange = post.http.exchange;
  const partial = units.find((x) => x.direction === 'in' && x.http?.exchange === exchange && Buffer.from(x.bytes).includes('{"jsonrpc":"2.0"'));
  assert.ok(partial, 'P1: the bytes the server sent before it died are in the log');
  const aborted = appEvents(units).filter((e) => e.event === 'request-aborted' && e.exchange === exchange);
  assert.deepEqual(aborted, [], 'the dead POST is not reported aborted at close');
});
