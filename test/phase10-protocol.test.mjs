// Phase 10 in the adapter: list requests without the SDK's timeout, logging,
// ping and completions on each era (plan phase 10, decisions 4, 5 and 8).
import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { connectStdio, canonicalJson, hashTool, hashResource, hashResourceTemplate } from '../packages/protocol/dist/index.js';
import { fixtures } from './support/fixture-servers.mjs';

const MODERN = join(fixtures, 'modern-server.mjs');
const LEGACY = join(fixtures, 'legacy-server.mjs');
const open = [];
after(async () => { for (const c of open) await c.close().catch(() => undefined); });

async function stdio(file, env = {}) {
  const frames = [];
  const conn = await connectStdio({
    command: process.execPath, args: [file], env: { ...process.env, ...env },
    onFrame: (direction, frame) => frames.push({ direction, frame }),
  });
  open.push(conn);
  return { conn, frames };
}

const sent = (frames, method) => frames.filter((f) => f.direction === 'out' && f.frame.method === method);

test('a list request never times out on its own: no cancellation after the SDK\'s 60 s (deferred phase 07, P2)', async () => {
  const { conn, frames } = await stdio(LEGACY, { HANG_ON_LIST: '1' });
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const listing = conn.source.listTools().catch((e) => e);
    // Let the request reach the transport before time moves.
    await new Promise((r) => setImmediate(r));
    assert.equal(sent(frames, 'tools/list').length, 1);
    mock.timers.tick(61_000);
    await new Promise((r) => setImmediate(r));
    assert.equal(sent(frames, 'notifications/cancelled').length, 0, 'the SDK cancelled a list the user is still waiting on');
    void listing;
  } finally {
    mock.timers.reset();
  }
});

// Decision 9: four fields join the allowlist. An item without them keeps the
// hash it had, so no stored snapshot reads as changed.
const oldHash = (item, fields) => createHash('sha256').update(JSON.stringify(canonicalJson(Object.fromEntries(fields.filter((f) => item[f] !== undefined).map((f) => [f, item[f]]))))).digest('hex');

test('allowlist: an item without the new fields hashes exactly as before phase 10', () => {
  const tool = { name: 'echo', description: 'd', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } };
  assert.equal(hashTool(tool), oldHash(tool, ['name', 'title', 'description', 'icons', 'inputSchema', 'outputSchema', 'annotations']));
  const resource = { uri: 'file:///a', name: 'a', mimeType: 'text/plain' };
  assert.equal(hashResource(resource), oldHash(resource, ['uri', 'name', 'title', 'description', 'mimeType', 'icons']));
  const template = { uriTemplate: 'file:///{x}', name: 't' };
  assert.equal(hashResourceTemplate(template), oldHash(template, ['uriTemplate', 'name', 'title', 'description', 'mimeType', 'icons']));
});

test('allowlist: Tool.execution and both annotations are hashed; Resource.size is not (R10-3)', () => {
  const tool = { name: 'echo', inputSchema: { type: 'object' } };
  assert.notEqual(hashTool({ ...tool, execution: { taskSupport: 'optional' } }), hashTool(tool));
  const resource = { uri: 'file:///a' };
  assert.equal(hashResource({ ...resource, size: 12 }), hashResource(resource));
  assert.notEqual(hashResource({ ...resource, annotations: { priority: 1 } }), hashResource(resource));
  const template = { uriTemplate: 'file:///{x}' };
  assert.notEqual(hashResourceTemplate({ ...template, annotations: { audience: ['user'] } }), hashResourceTemplate(template));
});

async function extras(file, env = {}) {
  const notes = [];
  const frames = [];
  const conn = await connectStdio({
    command: process.execPath, args: [file], env: { ...process.env, EXTRAS: '1', ...env },
    onFrame: (direction, frame) => frames.push({ direction, frame }),
    onNotification: (n) => notes.push(n),
  });
  open.push(conn);
  return { conn, frames, notes };
}

const messages = (notes) => notes.filter((n) => n.method === 'notifications/message').map((n) => n.params.level);

test('logging, legacy: no messages until the user sets a level; then logging/setLevel goes out and the server filters by it', async () => {
  const { conn, frames, notes } = await extras(LEGACY);
  await conn.call({ kind: 'tool', target: 'log_burst', args: {} });
  assert.deepEqual(messages(notes), []);
  const outcome = await conn.setLogLevel('error');
  assert.equal(outcome.kind, 'result');
  assert.deepEqual(sent(frames, 'logging/setLevel').map((f) => f.frame.params), [{ level: 'error' }]);
  assert.equal(conn.logLevel, 'error');
  await conn.call({ kind: 'tool', target: 'log_burst', args: {} });
  assert.deepEqual(messages(notes), ['error', 'critical', 'alert', 'emergency']);
  const call = sent(frames, 'tools/call').at(-1).frame;
  assert.equal(call.params._meta?.['io.modelcontextprotocol/logLevel'], undefined, 'legacy requests carry no logLevel key');
});

test('logging, legacy: turning logging off is refused, not faked', async () => {
  const { conn } = await extras(LEGACY);
  const outcome = await conn.setLogLevel(undefined);
  assert.equal(outcome.kind, 'failed');
});

test('logging, modern: setting a level sends nothing, and every later request carries it in _meta', async () => {
  const { conn, frames, notes } = await extras(MODERN);
  await conn.call({ kind: 'tool', target: 'log_burst', args: {} });
  assert.deepEqual(messages(notes), [], 'no key, no messages');
  const before = frames.length;
  assert.equal(await conn.setLogLevel('warning'), undefined);
  assert.equal(frames.length, before, 'no frame went out');
  assert.equal(sent(frames, 'logging/setLevel').length, 0);
  await conn.call({ kind: 'tool', target: 'log_burst', args: {} });
  assert.deepEqual(messages(notes), ['warning', 'error', 'critical', 'alert', 'emergency']);
  await conn.source.listTools();
  assert.equal(sent(frames, 'tools/list').at(-1).frame.params._meta['io.modelcontextprotocol/logLevel'], 'warning', 'lists carry it too');
  await conn.setLogLevel(undefined);
  await conn.call({ kind: 'tool', target: 'log_burst', args: {} });
  assert.equal(sent(frames, 'tools/call').at(-1).frame.params._meta['io.modelcontextprotocol/logLevel'], undefined);
  assert.equal(messages(notes).length, 5, 'unset means no more messages');
});

test('ping: legacy sends it and times the round trip; modern refuses it without a frame', async () => {
  const legacy = await extras(LEGACY);
  const outcome = await legacy.conn.request({ method: 'ping' });
  assert.equal(outcome.kind, 'result');
  assert.ok(outcome.elapsedMs >= 0);
  assert.equal(sent(legacy.frames, 'ping').length, 1);

  const modern = await extras(MODERN);
  const refused = await modern.conn.request({ method: 'ping' });
  assert.equal(refused.kind, 'failed');
  assert.match(refused.message, /does not exist on 2026-07-28/);
  assert.equal(sent(modern.frames, 'ping').length, 0);
});

for (const [era, file] of [['legacy', LEGACY], ['modern', MODERN]]) {
  test(`completion, ${era}: one completion/complete per request, for a prompt argument and a template variable`, async () => {
    const { conn, frames } = await extras(file);
    const prompt = await conn.request({ method: 'completion/complete', params: { ref: { type: 'ref/prompt', name: 'pick' }, argument: { name: 'language', value: 'py' } } });
    assert.deepEqual(prompt.result.completion.values, ['python']);
    const template = await conn.request({ method: 'completion/complete', params: { ref: { type: 'ref/resource', uri: 'fixture://langs/{lang}' }, argument: { name: 'lang', value: 't' } } });
    assert.deepEqual(template.result.completion.values, ['typescript']);
    assert.equal(sent(frames, 'completion/complete').length, 2);
  });

  test(`capture, ${era}: the extras' capabilities and the new fields are captured`, async () => {
    const { conn } = await extras(file);
    const caps = conn.source.capabilities;
    assert.ok(caps.logging && caps.completions);
    assert.equal(caps.resources.subscribe, true);
    const resources = await conn.source.listResources();
    const sized = resources.items.find((r) => r.uri === 'fixture://sized');
    assert.equal(sized.size, 42);
    assert.deepEqual(sized.annotations, { audience: ['user'], priority: 0.5 });
  });
}

const until = async (check, what, ms = 3000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

test('subscriptions, legacy: resources/subscribe, then an update for that uri only; unsubscribe stops it', async () => {
  const { conn, frames, notes } = await extras(LEGACY);
  const updates = () => notes.filter((n) => n.method === 'notifications/resources/updated').map((n) => n.params.uri);
  await conn.call({ kind: 'tool', target: 'touch', args: { uri: 'fixture://sized' } });
  assert.deepEqual(updates(), [], 'nothing before subscribing');
  assert.equal((await conn.request({ method: 'resources/subscribe', params: { uri: 'fixture://sized' } })).kind, 'result');
  await conn.call({ kind: 'tool', target: 'touch', args: { uri: 'fixture://sized' } });
  await conn.call({ kind: 'tool', target: 'touch', args: { uri: 'fixture://other' } });
  await until(() => updates().length === 1, 'the update');
  assert.deepEqual(updates(), ['fixture://sized']);
  await conn.request({ method: 'resources/unsubscribe', params: { uri: 'fixture://sized' } });
  await conn.call({ kind: 'tool', target: 'touch', args: { uri: 'fixture://sized' } });
  assert.deepEqual(updates(), ['fixture://sized']);
  assert.equal(sent(frames, 'subscriptions/listen').length, 0);
});

test('change notice, legacy: a mid-session tool change arrives unasked, and nothing is re-listed', async () => {
  const { conn, frames, notes } = await extras(LEGACY);
  const lists = sent(frames, 'tools/list').length;
  await conn.call({ kind: 'tool', target: 'mutate', args: {} });
  await until(() => notes.some((n) => n.method === 'notifications/tools/list_changed'), 'the notice');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(sent(frames, 'tools/list').length, lists, 'P2: the app re-lists only on the user\'s Refresh');
});

test('subscriptions, modern: nothing arrives without a listen; a listen is acknowledged and carries only what it asked for', async () => {
  const { conn, frames, notes } = await extras(MODERN);
  await conn.call({ kind: 'tool', target: 'mutate', args: {} });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(notes.filter((n) => n.method === 'notifications/tools/list_changed').length, 0, 'no listen, no notice');

  const listen = conn.listen({ toolsListChanged: true, resourceSubscriptions: ['fixture://sized'] });
  await until(() => notes.some((n) => n.method === 'notifications/subscriptions/acknowledged'), 'the acknowledgement');
  const ack = notes.find((n) => n.method === 'notifications/subscriptions/acknowledged');
  assert.equal(ack.params._meta['io.modelcontextprotocol/subscriptionId'], listen.requestId);
  assert.deepEqual(ack.params.notifications, { toolsListChanged: true, resourceSubscriptions: ['fixture://sized'] });
  const [request] = sent(frames, 'subscriptions/listen');
  assert.equal(request.frame.id, listen.requestId);

  await conn.call({ kind: 'tool', target: 'mutate', args: {} });
  await conn.call({ kind: 'tool', target: 'touch', args: { uri: 'fixture://sized' } });
  await conn.call({ kind: 'tool', target: 'touch', args: { uri: 'fixture://other' } });
  await until(() => notes.some((n) => n.method === 'notifications/resources/updated'), 'the update');
  const changed = notes.filter((n) => n.method === 'notifications/tools/list_changed');
  assert.equal(changed.length, 1);
  assert.equal(changed[0].params._meta['io.modelcontextprotocol/subscriptionId'], listen.requestId);
  assert.deepEqual(notes.filter((n) => n.method === 'notifications/resources/updated').map((n) => n.params.uri), ['fixture://sized']);

  listen.close();
  assert.deepEqual(await listen.ended, { kind: 'closed' });
  const cancel = sent(frames, 'notifications/cancelled').at(-1);
  assert.equal(cancel.frame.params.requestId, listen.requestId, 'stdio closes a listen with notifications/cancelled');
});

test('subscriptions, modern: a listen stays open past the SDK\'s 60 s, and the server can end it with the result', async () => {
  const { conn, frames } = await extras(MODERN);
  const listen = conn.listen({ toolsListChanged: true });
  await until(() => listen.requestId !== undefined, 'the listen to go out');
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    mock.timers.tick(61_000);
    await new Promise((r) => setImmediate(r));
  } finally {
    mock.timers.reset();
  }
  assert.equal(sent(frames, 'notifications/cancelled').length, 0, 'nothing cancelled the listen on its own');
  await conn.call({ kind: 'tool', target: 'end_listen', args: {} });
  const end = await listen.ended;
  assert.equal(end.kind, 'result');
  assert.equal(end.result._meta['io.modelcontextprotocol/subscriptionId'], listen.requestId);
});

test('subscriptions, legacy: listen is refused without a frame', async () => {
  const { conn, frames } = await extras(LEGACY);
  const end = await conn.listen({ toolsListChanged: true }).ended;
  assert.equal(end.kind, 'failed');
  assert.equal(sent(frames, 'subscriptions/listen').length, 0);
});

test('subscriptions, modern: a listen the server cancels ends as cancelled-by-server, and nothing is sent back', { timeout: 10_000 }, async () => {
  const { conn, frames } = await extras(MODERN);
  const listen = conn.listen({ toolsListChanged: true });
  await until(() => listen.requestId !== undefined, 'the listen to go out');
  await conn.call({ kind: 'tool', target: 'cancel_listen', args: {} });
  const end = await listen.ended;
  assert.equal(end.kind, 'cancelled-by-server');
  assert.equal(end.reason, 'the fixture is shutting the stream');
  assert.equal(sent(frames, 'notifications/cancelled').length, 0);
});
