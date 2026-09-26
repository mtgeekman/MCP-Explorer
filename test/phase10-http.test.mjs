// Phase 10 over Streamable HTTP: log messages, listen streams, notices on the
// legacy GET stream, and a legacy server's own requests mid-call (deferred
// phase 08), all against the STREAMING front.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { connectHttp } from '../packages/protocol/dist/index.js';
import { listen } from './support/fixture-servers.mjs';

const children = [];
const open = [];
after(async () => {
  for (const c of open) await c.close().catch(() => undefined);
  for (const c of children) c.kill();
});

async function http(env, extra = {}) {
  const url = await listen('http-server.mjs', children, { EXTRAS: '1', STREAMING: '1', ...env });
  const frames = [];
  const notes = [];
  const conn = await connectHttp({
    url, era: env.LEGACY ? 'legacy' : 'auto',
    onFrame: (direction, frame) => frames.push({ direction, frame }),
    onNotification: (n) => notes.push(n),
    ...extra,
  });
  open.push(conn);
  return { conn, frames, notes };
}

const sent = (frames, method) => frames.filter((f) => f.direction === 'out' && f.frame.method === method);
const until = async (check, what, ms = 5000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

test('http, modern: log messages arrive on the request\'s own stream when the user set a level', async () => {
  const { conn, notes } = await http({});
  assert.equal(conn.era, 'modern');
  await conn.setLogLevel('critical');
  const outcome = await conn.call({ kind: 'tool', target: 'log_burst', args: {} });
  assert.equal(outcome.kind, 'result');
  assert.deepEqual(notes.filter((n) => n.method === 'notifications/message').map((n) => n.params.level), ['critical', 'alert', 'emergency']);
});

test('http, modern: a listen is acknowledged, carries its notices, and closing it aborts the stream', async () => {
  const { conn, frames, notes } = await http({});
  const handle = conn.listen({ toolsListChanged: true });
  await until(() => notes.some((n) => n.method === 'notifications/subscriptions/acknowledged'), 'the acknowledgement');
  await conn.call({ kind: 'tool', target: 'mutate', args: {} });
  await until(() => notes.some((n) => n.method === 'notifications/tools/list_changed'), 'the notice');
  handle.close();
  assert.deepEqual(await handle.ended, { kind: 'closed' });
  // Modern Streamable HTTP cancels by closing the stream, not with a message.
  assert.equal(sent(frames, 'notifications/cancelled').length, 0);
});

test('http, legacy: a change notice arrives unasked on the GET stream', async () => {
  const { conn, notes } = await http({ LEGACY: '1' });
  assert.equal(conn.era, 'legacy');
  // The SDK opens the GET stream after initialized; give it a moment.
  await new Promise((r) => setTimeout(r, 200));
  await conn.call({ kind: 'tool', target: 'mutate', args: {} });
  await until(() => notes.some((n) => n.method === 'notifications/tools/list_changed'), 'the notice');
});

test('http, legacy: a server\'s own request mid-call reaches the person, and the answer goes back in its own POST (deferred phase 08)', async () => {
  const asked = [];
  const { conn, frames } = await http({ LEGACY: '1', CALL_TOOLS: '1' }, {
    onServerRequest: async (request) => {
      asked.push(request.method);
      return { result: { action: 'accept', content: { publish: true } } };
    },
  });
  const outcome = await conn.call({ kind: 'tool', target: 'ask_elicit', args: {} });
  assert.deepEqual(asked, ['elicitation/create']);
  assert.equal(outcome.kind, 'result');
  assert.match(outcome.result.content[0].text, /"publish":true/);
  const answer = frames.find((f) => f.direction === 'out' && f.frame.method === undefined && f.frame.result?.action === 'accept');
  assert.ok(answer, 'the person\'s answer went out as a response frame');
});
