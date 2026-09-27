// The call pipeline through the backend API (phase 07): the confirm gate
// (D7), recording (D23), progress, cancel, the MRTR stop at round 1
// (decision 6), session end, validation, export and replay.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Backend } from '../packages/backend/dist/index.js';
import { memoryStore } from './support/memory-store.mjs';
import { fixtures, listen } from './support/fixture-servers.mjs';

const root = mkdtempSync(join(tmpdir(), 'mcpx-calls-backend-'));
const backends = [];
const children = [];
after(async () => {
  for (const b of backends) await b.shutdown();
  for (const c of children) c.kill();
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

async function setup(server) {
  const backend = new Backend({ dataDir: mkdtempSync(join(root, 'data-')), secrets: memoryStore(), closeGraceMs: 300 });
  backends.push(backend);
  const changed = [];
  backend.on((name, data) => { if (name === 'call.changed') changed.push(data); });
  const call = (method, params = {}) => backend.request(method, params);
  await call('workspaces.create', { name: 'Calls', protection: { kind: 'none' } });
  const row = await call('servers.save', { server: server });
  return { backend, call, changed, serverId: row.id };
}

async function connected(server, secrets) {
  const s = await setup(server);
  const state = await s.call('connections.connect', { serverId: s.serverId, ...(secrets ? { secrets } : {}) });
  assert.equal(state.status, 'connected', JSON.stringify(state));
  await waitFor(async () => (await s.call('surface.get', { serverId: s.serverId })).capture);
  return s;
}

const stdioServer = (file, env = {}) => ({ name: file, transport: 'stdio', command: process.execPath, args: [join(fixtures, file)], env: { CALL_TOOLS: '1', ...env } });

const finished = (s, callId) => waitFor(async () => {
  const v = await s.call('calls.get', { callId });
  return v && v.call.status !== 'in_progress' && !v.live ? v : null;
});

const sentMethods = async (s) => (await s.call('log.units', { serverId: s.serverId })).flatMap((u) => (u.direction === 'out' ? u.frames.map((f) => f.method) : []));

test('D7: every tool not declaring readOnlyHint true asks first, unannotated and hostile ones included', async () => {
  const s = await connected(stdioServer('modern-server.mjs'));
  const { capture } = await s.call('surface.get', { serverId: s.serverId });
  const tools = capture.surface.tools;
  assert.ok(tools.length > 20, 'the CALL_TOOLS surface was captured');
  for (const tool of tools) {
    const reply = await s.call('calls.start', { serverId: s.serverId, kind: 'tool', target: tool.name, args: {} });
    const readOnly = tool.annotations?.readOnlyHint === true;
    assert.equal(reply.started, readOnly, `${tool.name}: ${JSON.stringify(tool.annotations)}`);
    if (!readOnly) {
      assert.equal(reply.confirm.method, 'tools/call');
      assert.deepEqual(reply.confirm.params, { name: tool.name, arguments: {} });
      assert.ok(reply.confirm.why.length > 0);
    }
  }
  for (const name of ['hint_readonly_string', 'hint_none', 'hint_destructive', 'hint_readonly_false']) {
    assert.ok(tools.some((t) => t.name === name), `${name} is in the corpus`);
  }
  // Calls started above run; let them settle before the workspace closes.
  await waitFor(async () => (await s.call('calls.list', { serverId: s.serverId })).every((c) => !c.live || c.live.status === 'awaiting-input'));
});

test('D7: a tool the capture does not know asks first; "Ask before calls" off asks for nothing', async () => {
  const s = await connected(stdioServer('modern-server.mjs'));
  const unknown = await s.call('calls.start', { serverId: s.serverId, kind: 'tool', target: 'not_listed', args: {} });
  assert.equal(unknown.started, false);
  assert.match(unknown.confirm.why, /not in the latest capture/);
  await s.call('settings.update', { changes: { askBeforeCalls: false } });
  const bypassed = await s.call('calls.start', { serverId: s.serverId, kind: 'tool', target: 'hint_destructive', args: {} });
  assert.equal(bypassed.started, true);
  await finished(s, bypassed.callId);
});

test('P2: connecting and capturing never calls a tool, gets a prompt or reads a resource', async () => {
  const s = await connected(stdioServer('modern-server.mjs'));
  const methods = await sentMethods(s);
  for (const m of ['tools/call', 'prompts/get', 'resources/read']) assert.ok(!methods.includes(m), `${m} was sent with no user action`);
});

test('a confirmed call completes, is recorded as one round, and its structuredContent is checked against the outputSchema', async () => {
  const s = await connected(stdioServer('modern-server.mjs'));
  const reply = await s.call('calls.start', { serverId: s.serverId, kind: 'tool', target: 'add', args: { a: 2, b: 40 } });
  assert.equal(reply.started, true, 'add is read-only, so it runs at once');
  const view = await finished(s, reply.callId);
  assert.equal(view.call.status, 'completed');
  assert.equal(view.call.roundRecords.length, 1);
  assert.deepEqual(view.call.roundRecords[0].arguments, { a: 2, b: 40 });
  assert.deepEqual(view.call.roundRecords[0].result.structuredContent, { sum: 42 });
  assert.notEqual(view.call.roundRecords[0].requestUnitId, null);
  assert.deepEqual(view.outputCheck, { valid: true });
  assert.ok(s.changed.some((c) => c.callId === reply.callId));

  const wrong = await s.call('calls.start', { serverId: s.serverId, kind: 'tool', target: 'wrong_shape', args: {} });
  const bad = await finished(s, wrong.callId);
  assert.equal(bad.call.status, 'completed', 'a result that breaks its outputSchema is still the result');
  assert.equal(bad.outputCheck.valid, false);
  assert.match(bad.outputCheck.message, /count/);
});

test('a JSON-RPC error ends the call as error; a result with isError is a completed call that says so', async () => {
  const s = await connected(stdioServer('legacy-server.mjs'));
  const thrown = await finished(s, (await s.call('calls.start', { serverId: s.serverId, kind: 'tool', target: 'throw', args: {} })).callId);
  assert.equal(thrown.call.status, 'error');
  assert.equal(thrown.call.roundRecords[0].error.code, -32603);
  const failed = await finished(s, (await s.call('calls.start', { serverId: s.serverId, kind: 'tool', target: 'fail', args: {} })).callId);
  assert.equal(failed.call.status, 'completed');
  assert.equal(failed.call.roundRecords[0].result.isError, true);
});

test('progress is live while a call runs, and Cancel ends it cancelled', async () => {
  const s = await connected(stdioServer('legacy-server.mjs'));
  const { callId } = await s.call('calls.start', { serverId: s.serverId, kind: 'tool', target: 'slow', args: { steps: 100, delayMs: 30 } });
  const running = await waitFor(async () => {
    const v = await s.call('calls.get', { callId });
    return v.live?.progress ? v : null;
  });
  assert.equal(running.live.status, 'running');
  assert.equal(running.live.progress.total, 100);
  await s.call('calls.cancel', { callId });
  const view = await finished(s, callId);
  assert.equal(view.call.status, 'cancelled');
  assert.equal(view.call.roundRecords[0].error.cancelled, true);
  assert.ok((await sentMethods(s)).includes('notifications/cancelled'));
  await assert.rejects(s.call('calls.cancel', { callId }), /not running/);
});

test('decision 6: input_required stops at round 1 and waits; Stop ends it abandoned, and nothing is retried', async () => {
  const s = await connected(stdioServer('modern-server.mjs'));
  await s.call('settings.update', { changes: { askBeforeCalls: false } });
  const { callId } = await s.call('calls.start', { serverId: s.serverId, kind: 'tool', target: 'needs_input', args: {} });
  const waiting = await waitFor(async () => {
    const v = await s.call('calls.get', { callId });
    return v.live?.status === 'awaiting-input' ? v : null;
  });
  const round = waiting.call.roundRecords[0];
  assert.equal(round.resultType, 'input_required');
  assert.ok(round.inputRequests.who, 'the input requests are kept');
  assert.equal(Buffer.from(round.requestState).toString('utf8'), 'opaque-state-do-not-touch');
  await new Promise((r) => setTimeout(r, 400));
  assert.equal((await sentMethods(s)).filter((m) => m === 'tools/call').length, 1, 'no retry');
  await s.call('calls.stop', { callId });
  const ended = await s.call('calls.get', { callId });
  assert.equal(ended.call.status, 'abandoned');
  assert.equal(ended.live, undefined);
});

test('a session ending under a call interrupts it: one running, one waiting for input', async () => {
  const s = await connected(stdioServer('modern-server.mjs'));
  await s.call('settings.update', { changes: { askBeforeCalls: false } });
  const waiting = (await s.call('calls.start', { serverId: s.serverId, kind: 'tool', target: 'needs_input', args: {} })).callId;
  await waitFor(async () => (await s.call('calls.get', { callId: waiting })).live?.status === 'awaiting-input');
  const running = (await s.call('calls.start', { serverId: s.serverId, kind: 'tool', target: 'slow', args: { steps: 100, delayMs: 50 } })).callId;
  await s.call('connections.disconnect', { serverId: s.serverId });
  assert.equal((await finished(s, running)).call.status, 'interrupted');
  assert.equal((await finished(s, waiting)).call.status, 'interrupted');
});

test('a prompt get and a resource read run without a confirm, from a template too', async () => {
  const s = await connected(stdioServer('legacy-server.mjs'));
  const prompt = await s.call('calls.start', { serverId: s.serverId, kind: 'prompt', target: 'review', args: { language: 'go' } });
  assert.equal(prompt.started, true);
  assert.match((await finished(s, prompt.callId)).call.roundRecords[0].result.messages[0].content.text, /go/);
  const template = await s.call('resources.template', { uriTemplate: 'fixture://notes/{day}' });
  assert.deepEqual(template.variables, ['day']);
  const { uri } = await s.call('resources.template', { uriTemplate: 'fixture://notes/{day}', values: { day: 'fri day' } });
  const read = await s.call('calls.start', { serverId: s.serverId, kind: 'resource', target: uri });
  const view = await finished(s, read.callId);
  assert.equal(view.call.kind, 'resource');
  assert.equal(view.call.roundRecords[0].result.contents[0].text, 'Notes for fri day.');
});

test('a replay is a new call with its own history entry; the first is untouched', async () => {
  const s = await connected(stdioServer('modern-server.mjs'));
  const first = await finished(s, (await s.call('calls.start', { serverId: s.serverId, kind: 'tool', target: 'add', args: { a: 1, b: 1 } })).callId);
  const replay = await finished(s, (await s.call('calls.start', { serverId: s.serverId, kind: 'tool', target: 'add', args: first.call.roundRecords[0].arguments })).callId);
  assert.notEqual(replay.call.id, first.call.id);
  assert.deepEqual((await s.call('calls.get', { callId: first.call.id })).call, first.call);
  assert.deepEqual((await s.call('calls.list', { serverId: s.serverId })).map((c) => c.id), [replay.call.id, first.call.id]);
});

test('validation is advisory: arguments are checked and a call with invalid ones still goes out when confirmed', async () => {
  const s = await connected(stdioServer('modern-server.mjs'));
  const schema = { type: 'object', properties: { a: { type: 'number' } }, required: ['a'] };
  assert.deepEqual(await s.call('calls.validate', { schema, value: { a: 1 } }), { valid: true });
  assert.equal((await s.call('calls.validate', { schema, value: { a: 'x' } })).valid, false);
  assert.equal((await s.call('calls.validate', { schema: { $schema: 'https://example.com/other' }, value: 1 })).valid, null);
  const reply = await s.call('calls.start', { serverId: s.serverId, kind: 'tool', target: 'hint_none', args: { unexpected: true } });
  assert.equal(reply.started, false);
  const run = await s.call('calls.start', { serverId: s.serverId, kind: 'tool', target: 'hint_none', args: { unexpected: true }, confirmed: true });
  assert.equal((await finished(s, run.callId)).call.status, 'completed');
});

test('export over stdio is the request line exactly as sent', async () => {
  const s = await connected(stdioServer('modern-server.mjs'));
  const view = await finished(s, (await s.call('calls.start', { serverId: s.serverId, kind: 'tool', target: 'add', args: { a: 3, b: 4 } })).callId);
  const exported = await s.call('calls.export', { callId: view.call.id });
  const unit = await s.call('log.get', { id: view.call.roundRecords[0].requestUnitId });
  assert.deepEqual(Buffer.from(exported.bytes), Buffer.from(unit.bytes));
  const sent = JSON.parse(Buffer.from(exported.bytes).toString('utf8'));
  assert.equal(sent.method, 'tools/call');
  assert.deepEqual(sent.params.arguments, { a: 3, b: 4 });
  assert.equal(exported.curl, undefined, 'curl is for HTTP servers');
});

test('export over HTTP gives a curl command whose secret header is a variable, never the value', async () => {
  const url = await listen('http-server.mjs', children, { CALL_TOOLS: '1' });
  const s = await connected({ name: 'http', transport: 'streamable-http', url, unstoredSecrets: { headers: ['x-api-key'] } }, { headers: { 'x-api-key': 's3cret-value' } });
  const view = await finished(s, (await s.call('calls.start', { serverId: s.serverId, kind: 'tool', target: 'add', args: { a: 1, b: 2 } })).callId);
  const exported = await s.call('calls.export', { callId: view.call.id });
  assert.ok(exported.curl.startsWith(`curl -sS -X POST '${url}'`));
  assert.ok(exported.curl.includes('"x-api-key: $MCP_SECRET_X_API_KEY"'));
  assert.deepEqual(exported.secretVariables, ['MCP_SECRET_X_API_KEY']);
  assert.ok(!exported.curl.includes('s3cret-value'));
  assert.ok(exported.curl.includes(`--data-binary '${Buffer.from(exported.bytes).toString('utf8')}'`));
});
