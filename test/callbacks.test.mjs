// The server asking the human, at the adapter (phase 08 decisions 1 to 3).
// Legacy era: every server-to-client request reaches onServerRequest raw and
// waits for it; nothing answers on the human's behalf. Modern era: an
// input_required result comes back untouched, is never retried by anyone but
// the caller, and the caller's retry carries requestState exactly.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { connectStdio, CLIENT_CAPABILITIES, TASKS_EXTENSION } from '../packages/protocol/dist/index.js';
import { BOTH_STATE } from '../scripts/fixture/call-handler.mjs';
import { fixtures } from './support/fixture-servers.mjs';

const MODERN = join(fixtures, 'modern-server.mjs');
const LEGACY = join(fixtures, 'legacy-server.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const conns = [];
after(async () => { for (const c of conns) await c.close().catch(() => undefined); });

async function stdio(file, { env = {}, onServerRequest } = {}) {
  const frames = [];
  const conn = await connectStdio({
    command: process.execPath, args: [file], env: { ...process.env, CALL_TOOLS: '1', ...env },
    onFrame: (direction, frame) => frames.push({ direction, frame }),
    ...(onServerRequest ? { onServerRequest } : {}),
  });
  conns.push(conn);
  return { conn, frames };
}

/** A listener that parks each request until the test answers it. */
function inbox() {
  const waiting = [];
  const arrived = [];
  let notify;
  const listener = (req) => new Promise((resolve) => {
    const entry = { req, resolve };
    arrived.push(entry);
    notify?.();
  });
  const next = async () => {
    while (arrived.length === 0) await new Promise((r) => { notify = r; });
    const e = arrived.shift();
    waiting.push(e);
    return e;
  };
  return { listener, next };
}

const out = (frames, pred) => frames.filter((f) => f.direction === 'out' && pred(f.frame));
const sampleAnswer = { role: 'assistant', content: { type: 'text', text: 'Ports carry the tide.' }, model: 'human', stopReason: 'endTurn' };

test('legacy, P2: with nobody to answer, a sampling request waits and nothing goes back', { timeout: 15000 }, async () => {
  const { conn, frames } = await stdio(LEGACY);
  const call = conn.call({ kind: 'tool', target: 'ask_sampling', args: {} });
  let settled = false;
  void call.then(() => { settled = true; });
  await sleep(600);
  const request = frames.find((f) => f.direction === 'in' && f.frame.method === 'sampling/createMessage');
  assert.ok(request, 'the server did ask');
  assert.equal(out(frames, (m) => m.id === request.frame.id).length, 0, 'no reply went out for the server\'s request (the SDK would send -32601)');
  assert.equal(settled, false, 'the call waits on the server, which waits on a human');
});

test('legacy: sampling reaches the listener raw and the human\'s answer goes back exactly', { timeout: 15000 }, async () => {
  const box = inbox();
  const { conn, frames } = await stdio(LEGACY, { onServerRequest: box.listener });
  const call = conn.call({ kind: 'tool', target: 'ask_sampling', args: {} });
  const { req, resolve } = await box.next();
  assert.equal(req.method, 'sampling/createMessage');
  assert.equal(req.params.maxTokens, 100);
  assert.equal(req.signal.aborted, false);
  resolve({ result: sampleAnswer });
  const outcome = await call;
  assert.equal(outcome.kind, 'result');
  assert.match(outcome.result.content[0].text, /Ports carry the tide/);
  const [reply] = out(frames, (m) => m.id === req.id && m.method === undefined);
  assert.deepEqual(reply.frame.result, sampleAnswer, 'the result is what the human wrote, nothing added or checked away');
});

test('legacy: a refusal goes back as the error the human chose', { timeout: 15000 }, async () => {
  const box = inbox();
  const { conn } = await stdio(LEGACY, { onServerRequest: box.listener });
  const call = conn.call({ kind: 'tool', target: 'ask_sampling', args: {} });
  const { resolve } = await box.next();
  resolve({ error: { code: -1, message: 'User rejected sampling request' } });
  const outcome = await call;
  assert.match(outcome.result.content[0].text, /"code":-1,"message":"User rejected sampling request"/);
});

test('legacy: URL-mode elicitation reaches the human, since the app declares it', { timeout: 15000 }, async () => {
  const box = inbox();
  const { conn } = await stdio(LEGACY, { onServerRequest: box.listener });
  const call = conn.call({ kind: 'tool', target: 'ask_elicit_url', args: {} });
  const { req, resolve } = await box.next();
  assert.equal(req.method, 'elicitation/create');
  assert.equal(req.params.mode, 'url');
  assert.equal(req.params.url, 'https://auth.example.com/authorize?client=fixture&state=abc123');
  resolve({ result: { action: 'decline' } });
  assert.match((await call).result.content[0].text, /"action":"decline"/);
});

test('legacy: form elicitation and roots reach the human, and a method no revision defines does too', { timeout: 15000 }, async () => {
  const box = inbox();
  const { conn } = await stdio(LEGACY, { onServerRequest: box.listener });
  for (const [tool, method, result] of [
    ['ask_elicit', 'elicitation/create', { action: 'accept', content: { publish: true } }],
    ['ask_roots', 'roots/list', { roots: [{ uri: 'file:///work', name: 'work' }] }],
    ['ask_unknown', 'fixture/custom', { fine: true }],
  ]) {
    const call = conn.call({ kind: 'tool', target: tool, args: {} });
    const { req, resolve } = await box.next();
    assert.equal(req.method, method);
    resolve({ result });
    assert.match((await call).result.content[0].text, new RegExp(JSON.stringify(result).replace(/[[\]{}]/g, '\\$&')));
  }
});

test('legacy: two requests at once are both held, and answered in any order', { timeout: 15000 }, async () => {
  const box = inbox();
  const { conn } = await stdio(LEGACY, { onServerRequest: box.listener });
  const call = conn.call({ kind: 'tool', target: 'ask_twice', args: {} });
  const a = await box.next();
  const b = await box.next();
  const [sampling, elicit] = a.req.method === 'sampling/createMessage' ? [a, b] : [b, a];
  elicit.resolve({ result: { action: 'cancel' } });
  sampling.resolve({ result: sampleAnswer });
  const text = (await call).result.content[0].text;
  assert.match(text, /"action":"cancel"/);
  assert.match(text, /Ports carry the tide/);
});

test('legacy: the server\'s cancellation aborts the request, and an answer after it sends nothing', { timeout: 15000 }, async () => {
  const box = inbox();
  const { conn, frames } = await stdio(LEGACY, { onServerRequest: box.listener });
  const call = conn.call({ kind: 'tool', target: 'ask_sampling', args: { cancelAfterMs: 100 } });
  const { req, resolve } = await box.next();
  const aborted = new Promise((r) => req.signal.addEventListener('abort', r, { once: true }));
  await aborted;
  assert.match((await call).result.content[0].text, /cancelled by the server/);
  resolve({ result: sampleAnswer });
  await sleep(100);
  assert.equal(out(frames, (m) => m.id === req.id).length, 0, 'no reply to a cancelled request');
});

test('legacy: a request outside any call (roots/list after initialize) reaches the human', { timeout: 15000 }, async () => {
  const box = inbox();
  await stdio(LEGACY, { env: { ROOTS_ON_INIT: '1' }, onServerRequest: box.listener });
  const { req, resolve } = await box.next();
  assert.equal(req.method, 'roots/list');
  resolve({ result: { roots: [] } });
});

test('both eras declare sampling with tools, elicitation in both modes, and roots', { timeout: 15000 }, async () => {
  assert.deepEqual(CLIENT_CAPABILITIES, { sampling: { tools: {} }, elicitation: { form: {}, url: {} }, roots: {} });
  const legacy = await stdio(LEGACY);
  const init = legacy.frames.find((f) => f.direction === 'out' && f.frame.method === 'initialize');
  assert.deepEqual(init.frame.params.capabilities, CLIENT_CAPABILITIES);
  const modern = await stdio(MODERN);
  await modern.conn.call({ kind: 'tool', target: 'add', args: { a: 1, b: 1 } });
  const [call] = out(modern.frames, (m) => m.method === 'tools/call');
  // Phase 10 decision 2: the modern era also declares the tasks extension.
  assert.deepEqual(call.frame.params._meta['io.modelcontextprotocol/clientCapabilities'], { ...CLIENT_CAPABILITIES, extensions: { [TASKS_EXTENSION]: {} } });
});

test('modern: sampling and elicitation in one result come back as a set, and nothing retries them', { timeout: 15000 }, async () => {
  const { conn, frames } = await stdio(MODERN);
  const outcome = await conn.call({ kind: 'tool', target: 'mrtr_both', args: {} });
  assert.equal(outcome.result.resultType, 'input_required');
  assert.deepEqual(Object.keys(outcome.result.inputRequests).sort(), ['confirm', 'draft']);
  assert.equal(outcome.result.inputRequests.draft.method, 'sampling/createMessage');
  assert.equal(outcome.result.inputRequests.confirm.method, 'elicitation/create');
  assert.equal(outcome.result.requestState, BOTH_STATE);
  await sleep(600);
  assert.equal(out(frames, (m) => m.method === 'tools/call').length, 1, 'no retry went out');
});

test('modern: the retry carries the answers under the server\'s keys, requestState exactly, and a new id', { timeout: 15000 }, async () => {
  const { conn, frames } = await stdio(MODERN);
  const first = await conn.call({ kind: 'tool', target: 'mrtr_both', args: { topic: 'ports' } });
  const inputResponses = { draft: sampleAnswer, confirm: { action: 'accept', content: { publish: true } } };
  const second = await conn.call({ kind: 'tool', target: 'mrtr_both', args: { topic: 'ports' }, inputResponses, requestState: first.result.requestState });
  assert.equal(second.kind, 'result');
  assert.equal(second.result.resultType, 'complete');
  assert.match(second.result.content[0].text, /requestState intact/);
  const calls = out(frames, (m) => m.method === 'tools/call');
  assert.equal(calls.length, 2);
  assert.notEqual(calls[1].frame.id, calls[0].frame.id);
  assert.equal(calls[1].frame.params.requestState, BOTH_STATE);
  assert.deepEqual(calls[1].frame.params.inputResponses, inputResponses);
  assert.deepEqual(calls[1].frame.params.arguments, { topic: 'ports' });
  assert.equal(calls[0].frame.params.requestState, undefined, 'the first request carries no state');
});

test('modern: an altered requestState is caught by the server, which is how the fixture proves the echo', { timeout: 15000 }, async () => {
  const { conn } = await stdio(MODERN);
  const first = await conn.call({ kind: 'tool', target: 'mrtr_both', args: {} });
  const bad = await conn.call({ kind: 'tool', target: 'mrtr_both', args: {}, inputResponses: { draft: sampleAnswer, confirm: { action: 'decline' } }, requestState: first.result.requestState.normalize('NFD') + ' ' });
  assert.equal(bad.kind, 'error');
  assert.match(String(bad.error.message), /altered/);
});

test('modern: a server that keeps asking gets a new input_required on every retry', { timeout: 15000 }, async () => {
  const { conn } = await stdio(MODERN);
  let state;
  for (let round = 1; round <= 4; round++) {
    const o = await conn.call({ kind: 'tool', target: 'mrtr_loop', args: {}, ...(state ? { inputResponses: { again: { action: 'accept', content: { ok: true } } }, requestState: state } : {}) });
    assert.equal(o.result.resultType, 'input_required', `round ${round}`);
    state = o.result.requestState;
  }
  assert.equal(state, 'loop:4');
});

test('modern: prompts/get can ask too, and its retry completes', { timeout: 15000 }, async () => {
  const { conn } = await stdio(MODERN);
  const first = await conn.call({ kind: 'prompt', target: 'confirm_prompt', args: {} });
  assert.equal(first.result.resultType, 'input_required');
  const second = await conn.call({ kind: 'prompt', target: 'confirm_prompt', args: {}, inputResponses: { sure: { action: 'accept', content: {} } }, requestState: first.result.requestState });
  assert.match(second.result.messages[0].content.text, /confirmed/);
});
