// The phase 08 gaps phase 10 closes (deferred phase 08): sampling offering
// tools on both eras, and notifications/elicitation/complete after a URL-mode
// request, through the backend as a person would meet them.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Backend } from '../packages/backend/dist/index.js';
import { memoryStore } from './support/memory-store.mjs';
import { fixtures } from './support/fixture-servers.mjs';

const root = mkdtempSync(join(tmpdir(), 'mcpx-p10cb-'));
const backends = [];
after(async () => {
  for (const b of backends) await b.shutdown();
  rmSync(root, { recursive: true, force: true });
});

const until = async (check, what, ms = 10000) => {
  const end = Date.now() + ms;
  let v;
  while (!(v = await check())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
  return v;
};

async function connected(file, env = {}) {
  const backend = new Backend({ dataDir: mkdtempSync(join(root, 'data-')), secrets: memoryStore(), closeGraceMs: 300 });
  backends.push(backend);
  const call = (method, params = {}) => backend.request(method, params);
  await call('workspaces.create', { name: 'Callbacks', protection: { kind: 'none' } });
  const { id } = await call('servers.save', { server: { name: 'fixture', transport: 'stdio', command: process.execPath, args: [join(fixtures, file)], env: { CALL_TOOLS: '1', ...env } } });
  await call('connections.connect', { serverId: id });
  await until(async () => (await call('surface.get', { serverId: id })).capture, 'the capture');
  return { call, id };
}

const TOOL_USE = { role: 'assistant', content: { type: 'tool_use', id: 'use-1', name: 'lookup', input: { word: 'port' } }, model: 'human', stopReason: 'toolUse' };

test('legacy: a sampling request offering tools reaches the person with its tools, and a tool_use answer goes back', async () => {
  const { call, id } = await connected('legacy-server.mjs');
  const { callId } = await call('calls.start', { serverId: id, kind: 'tool', target: 'ask_sampling_tools', args: {}, confirmed: true });
  const request = await until(async () => (await call('requests.list', { serverId: id }))[0], 'the request');
  assert.equal(request.method, 'sampling/createMessage');
  assert.deepEqual(request.params.tools.map((t) => t.name), ['lookup']);
  assert.deepEqual(request.params.toolChoice, { mode: 'auto' });
  await call('requests.answer', { requestId: request.id, answer: { result: TOOL_USE } });
  const view = await until(async () => { const v = await call('calls.get', { callId }); return v.call.status === 'completed' ? v : undefined; }, 'the call');
  assert.match(view.call.roundRecords[0].result.content[0].text, /"type":"tool_use"/);
});

test('modern: sampling with tools arrives as an input request, and the retry carries the tool_use answer', async () => {
  const { call, id } = await connected('modern-server.mjs');
  const { callId } = await call('calls.start', { serverId: id, kind: 'tool', target: 'mrtr_sampling_tools', args: {}, confirmed: true });
  const waiting = await until(async () => { const v = await call('calls.get', { callId }); return v.live?.status === 'awaiting-input' ? v : undefined; }, 'the input request');
  assert.deepEqual(waiting.live.input.inputRequests.draft.params.tools.map((t) => t.name), ['lookup']);
  await call('calls.answer', { callId, inputResponses: { draft: TOOL_USE } });
  const done = await until(async () => { const v = await call('calls.get', { callId }); return v.call.status === 'completed' ? v : undefined; }, 'the call');
  assert.match(done.call.roundRecords[1].result.content[0].text, /"name":"lookup"/);
});

test('legacy 2025-11-25: notifications/elicitation/complete after a URL-mode answer lands in the timeline', async () => {
  const { call, id } = await connected('legacy-server.mjs', { LEGACY_REVISION: '2025-11-25' });
  const { callId } = await call('calls.start', { serverId: id, kind: 'tool', target: 'ask_url_complete', args: {}, confirmed: true });
  const request = await until(async () => (await call('requests.list', { serverId: id }))[0], 'the request');
  assert.equal(request.params.mode, 'url');
  await call('requests.answer', { requestId: request.id, answer: { result: { action: 'accept' } } });
  await until(async () => (await call('calls.get', { callId })).call.status === 'completed', 'the call');
  const notes = await until(async () => { const n = await call('notifications.list', { serverId: id }); return n.some((x) => x.method === 'notifications/elicitation/complete') ? n : undefined; }, 'the notice');
  assert.deepEqual(notes.find((x) => x.method === 'notifications/elicitation/complete').params, { elicitationId: 'fixture-elicit-complete' });
});
