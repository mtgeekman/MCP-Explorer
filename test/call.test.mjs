// The adapter's call(): one request as the user asked, the response exactly
// as the server sent it, progress, cancellation, and never a retry (P2;
// phase 07 decisions 1 and 2).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { connectStdio, connectHttp } from '../packages/protocol/dist/index.js';
import { fixtures, listen } from './support/fixture-servers.mjs';

const children = [];
after(() => { for (const c of children) c.kill(); });

const MODERN = join(fixtures, 'modern-server.mjs');
const LEGACY = join(fixtures, 'legacy-server.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function stdio(file, env = {}) {
  const frames = [];
  const units = [];
  const conn = await connectStdio({
    command: process.execPath, args: [file], env: { ...process.env, CALL_TOOLS: '1', ...env },
    onFrame: (direction, frame) => frames.push({ direction, frame }),
    onUnit: (u) => units.push(u),
  });
  return { conn, frames, units };
}

const sent = (frames, method) => frames.filter((f) => f.direction === 'out' && f.frame.method === method);

for (const [era, file] of [['modern', MODERN], ['legacy', LEGACY]]) {
  test(`${era}: a tool call returns the result as the server sent it, with the id it went out under`, async () => {
    const { conn, frames } = await stdio(file);
    try {
      const outcome = await conn.call({ kind: 'tool', target: 'add', args: { a: 2, b: 3 } });
      assert.equal(outcome.kind, 'result');
      assert.deepEqual(outcome.result.structuredContent, { sum: 5 });
      const [request] = sent(frames, 'tools/call');
      assert.equal(outcome.requestId, request.frame.id);
      assert.deepEqual(request.frame.params.arguments, { a: 2, b: 3 });
      if (era === 'modern') assert.equal(outcome.result.resultType, 'complete', 'resultType is the server\'s, not stripped');
    } finally {
      await conn.close();
    }
  });

  test(`${era}: a JSON-RPC error is an error outcome, not a thrown exception`, async () => {
    const { conn } = await stdio(file);
    try {
      const outcome = await conn.call({ kind: 'tool', target: 'throw', args: {} });
      assert.equal(outcome.kind, 'error');
      assert.equal(outcome.error.code, -32603);
    } finally {
      await conn.close();
    }
  });

  test(`${era}: progress arrives step by step, and every notification is a logged frame`, async () => {
    const { conn, frames } = await stdio(file);
    try {
      const seen = [];
      const outcome = await conn.call({ kind: 'tool', target: 'slow', args: { steps: 3, delayMs: 20 }, onProgress: (p) => seen.push(p) });
      assert.equal(outcome.kind, 'result');
      assert.deepEqual(seen.map((p) => [p.progress, p.total]), [[1, 3], [2, 3], [3, 3]]);
      assert.equal(seen[0].message, 'step 1 of 3');
      assert.equal(frames.filter((f) => f.direction === 'in' && f.frame.method === 'notifications/progress').length, 3);
    } finally {
      await conn.close();
    }
  });

  test(`${era}: progress read in the same chunk as the result still reaches onProgress`, async () => {
    const { conn, frames } = await stdio(file, { COALESCE: '1' });
    try {
      const seen = [];
      const outcome = await conn.call({ kind: 'tool', target: 'slow', args: { steps: 3, delayMs: 0 }, onProgress: (p) => seen.push(p) });
      assert.equal(outcome.kind, 'result');
      assert.equal(frames.filter((f) => f.direction === 'in' && f.frame.method === 'notifications/progress').length, 3);
      assert.deepEqual(seen.map((p) => [p.progress, p.total, p.message]), [[1, 3, 'step 1 of 3'], [2, 3, 'step 2 of 3'], [3, 3, 'step 3 of 3']]);
    } finally {
      await conn.close();
    }
  });

  test(`${era}: a progress notification without a numeric progress is logged, not delivered`, async () => {
    const { conn, frames } = await stdio(file, { BAD_PROGRESS: '1' });
    try {
      const seen = [];
      const outcome = await conn.call({ kind: 'tool', target: 'slow', args: { steps: 2, delayMs: 0 }, onProgress: (p) => seen.push(p) });
      assert.equal(outcome.kind, 'result');
      assert.equal(frames.filter((f) => f.direction === 'in' && f.frame.method === 'notifications/progress').length, 3);
      assert.deepEqual(seen.map((p) => p.progress), [1, 2]);
    } finally {
      await conn.close();
    }
  });

  test(`${era}: cancelling sends notifications/cancelled for that request and reports cancelled`, async () => {
    const { conn, frames } = await stdio(file);
    try {
      const abort = new AbortController();
      const pending = conn.call({ kind: 'tool', target: 'slow', args: { steps: 50, delayMs: 50 }, signal: abort.signal, onProgress: () => abort.abort('the user cancelled') });
      const outcome = await pending;
      assert.equal(outcome.kind, 'cancelled');
      const [cancel] = sent(frames, 'notifications/cancelled');
      assert.ok(cancel, 'a cancellation went out');
      assert.equal(cancel.frame.params.requestId, outcome.requestId);
    } finally {
      await conn.close();
    }
  });

  test(`${era}: getting a prompt and reading a resource`, async () => {
    const { conn } = await stdio(file);
    try {
      const prompt = await conn.call({ kind: 'prompt', target: 'review', args: { language: 'rust' } });
      assert.equal(prompt.kind, 'result');
      assert.match(prompt.result.messages[0].content.text, /rust/);
      const resource = await conn.call({ kind: 'resource', target: 'fixture://notes/monday' });
      assert.equal(resource.kind, 'result');
      assert.equal(resource.result.contents[0].text, 'Notes for monday.');
    } finally {
      await conn.close();
    }
  });
}

test('modern: a content type no revision defines is kept, and the SDK\'s objection is reported beside it', async () => {
  const { conn } = await stdio(MODERN);
  try {
    const outcome = await conn.call({ kind: 'tool', target: 'media', args: {} });
    assert.equal(outcome.kind, 'result');
    assert.deepEqual(outcome.result.content.map((c) => c.type), ['text', 'image', 'audio', 'resource', 'resource_link', 'hologram']);
    assert.ok(outcome.sdkRejected, 'the SDK refused this result; the app shows it anyway');
  } finally {
    await conn.close();
  }
});

test('legacy: the same result passes with no objection', async () => {
  const { conn } = await stdio(LEGACY);
  try {
    const outcome = await conn.call({ kind: 'tool', target: 'media', args: {} });
    assert.equal(outcome.kind, 'result');
    assert.equal(outcome.sdkRejected, undefined);
    assert.equal(outcome.result.content.length, 6);
  } finally {
    await conn.close();
  }
});

// P2, modern era: auto-retry is the shape of the defect (spec, Verifiers).
for (const [label, env] of [['with input requests', {}], ['with requestState only', { STATE_ONLY: '1' }]]) {
  test(`P2: an input_required result ${label} is returned as it came, and nothing is retried`, async () => {
    const { conn, frames } = await stdio(MODERN, env);
    try {
      const outcome = await conn.call({ kind: 'tool', target: 'needs_input', args: {} });
      assert.equal(outcome.kind, 'result');
      assert.equal(outcome.result.resultType, 'input_required');
      assert.equal(outcome.sdkRejected, undefined);
      // The SDK's own driver retries a requestState-only result after 250 ms.
      await sleep(700);
      assert.equal(sent(frames, 'tools/call').length, 1, 'exactly one tools/call: no retry without a human answer');
      assert.ok(!sent(frames, 'tools/call')[0].frame.params.inputResponses, 'no answers were made up');
    } finally {
      await conn.close();
    }
  });
}

test('a session that ends mid-call reports the call failed, not hung', async () => {
  const { conn } = await stdio(MODERN, { EXIT_ON: 'tools/call' });
  const outcome = await conn.call({ kind: 'tool', target: 'add', args: { a: 1, b: 1 } });
  assert.equal(outcome.kind, 'failed');
  assert.ok(outcome.requestId !== undefined);
  await conn.close().catch(() => undefined);
});

test('a reply line over the 10 MB cap ends the session, and the call fails with the reason', async () => {
  const { conn } = await stdio(MODERN);
  const outcome = await conn.call({ kind: 'tool', target: 'big', args: { bytes: 11 * 1024 * 1024 } });
  assert.equal(outcome.kind, 'failed');
  await conn.close().catch(() => undefined);
});

test('streamable HTTP, modern: a call works, and cancelling aborts the request and logs the abort', async () => {
  const url = await listen('http-server.mjs', children, { CALL_TOOLS: '1' });
  const units = [];
  const frames = [];
  const conn = await connectHttp({ url, onUnit: (u) => units.push(u), onFrame: (d, f) => frames.push({ direction: d, frame: f }) });
  try {
    const done = await conn.call({ kind: 'tool', target: 'add', args: { a: 1, b: 2 } });
    assert.equal(done.kind, 'result');
    assert.deepEqual(done.result.structuredContent, { sum: 3 });

    const abort = new AbortController();
    const pending = conn.call({ kind: 'tool', target: 'slow', args: { steps: 20, delayMs: 50 }, signal: abort.signal });
    setTimeout(() => abort.abort('the user cancelled'), 100);
    const outcome = await pending;
    assert.equal(outcome.kind, 'cancelled');
    const events = units.filter((u) => u.kind === 'app').map((u) => JSON.parse(Buffer.from(u.bytes).toString('utf8')));
    assert.ok(events.some((e) => e.event === 'request-aborted'), 'the abort is in the log (P1)');
    assert.equal(sent(frames, 'notifications/cancelled').length, 0, 'the modern era cancels by aborting, not by notification');
  } finally {
    await conn.close();
  }
});

for (const [label, file, env] of [['streamable HTTP, legacy', 'http-server.mjs', { LEGACY: '1' }], ['HTTP+SSE, legacy', 'sse-server.mjs', { LEGACY: '1' }], ['HTTP+SSE, modern', 'sse-server.mjs', {}]]) {
  test(`${label}: a tool call returns its result`, async () => {
    const url = await listen(file, children, { CALL_TOOLS: '1', ...env });
    const conn = await connectHttp({ url, kind: file === 'sse-server.mjs' ? 'sse' : 'streamable-http' });
    try {
      const outcome = await conn.call({ kind: 'tool', target: 'add', args: { a: 4, b: 5 } });
      assert.equal(outcome.kind, 'result');
      assert.deepEqual(outcome.result.structuredContent, { sum: 9 });
    } finally {
      await conn.close();
    }
  });
}
