// The answer logic behind the input request cards (phase 08): which answer a
// request takes, what a sampling request shows, the answers as the shapes
// the server expects, a URL taken apart so its destination is plain, and
// nothing counted as answered before the person answers. Imported as
// TypeScript directly; Node strips the types.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  requestKind, deprecationNote, samplingView, samplingResult, HUMAN_MODEL, elicitResult, urlView, rootsResult, nonFileRoots,
  defaultRefusal, parseResult, allAnswered, urlElicitationsInError,
} from '../app/renderer/src/lib/inputRequests.ts';
import { serverRequestStatus, statusLabel } from '../app/renderer/src/lib/content.ts';

test('each request takes its answer; an elicitation with no mode is a form, and an unknown mode is not', () => {
  assert.equal(requestKind('sampling/createMessage', {}), 'sampling');
  assert.equal(requestKind('roots/list', undefined), 'roots');
  assert.equal(requestKind('elicitation/create', { message: 'x', requestedSchema: {} }), 'elicitation-form');
  assert.equal(requestKind('elicitation/create', { mode: 'form' }), 'elicitation-form');
  assert.equal(requestKind('elicitation/create', { mode: 'url', url: 'https://a' }), 'elicitation-url');
  assert.equal(requestKind('elicitation/create', { mode: 'telepathy' }), 'other');
  assert.equal(requestKind('fixture/custom', {}), 'other');
  assert.equal(requestKind(undefined, undefined), 'other');
});

test('sampling and roots are marked deprecated on the modern era only; elicitation never', () => {
  assert.match(deprecationNote('sampling', 'modern'), /2026-07-28/);
  assert.match(deprecationNote('roots', 'modern'), /2026-07-28/);
  assert.equal(deprecationNote('elicitation-form', 'modern'), null);
  assert.equal(deprecationNote('sampling', 'legacy'), null);
  assert.equal(deprecationNote('roots', 'legacy'), null);
});

test('a sampling request shows its messages, prompt, limits, hints and tools, and keeps what it does not render', () => {
  const v = samplingView({
    messages: [{ role: 'user', content: { type: 'text', text: 'hi' } }, { role: 'assistant', content: { type: 'image', data: 'AA', mimeType: 'image/png' } }],
    systemPrompt: 'Be brief.', maxTokens: 50, modelPreferences: { hints: [{ name: 'claude' }, { nope: 1 }] },
    tools: [{ name: 'search', inputSchema: {} }], toolChoice: { mode: 'auto' }, includeContext: 'thisServer', temperature: 0.2,
  });
  assert.deepEqual(v.messages[0], { role: 'user', text: 'hi', json: null });
  assert.equal(v.messages[1].text, null);
  assert.match(v.messages[1].json, /"type": "image"/);
  assert.equal(v.systemPrompt, 'Be brief.');
  assert.equal(v.maxTokens, 50);
  assert.deepEqual(v.modelHints, ['claude']);
  assert.deepEqual(v.tools, ['search']);
  assert.equal(v.toolChoice, 'auto');
  assert.equal(v.includeContext, 'thisServer');
  assert.match(v.other, /"temperature": 0.2/);
  assert.deepEqual(samplingView(null).messages, []);
});

test('a typed reply becomes a CreateMessageResult reporting the model "human" unless changed', () => {
  assert.equal(HUMAN_MODEL, 'human');
  assert.deepEqual(samplingResult('ok', HUMAN_MODEL), { role: 'assistant', content: { type: 'text', text: 'ok' }, model: 'human', stopReason: 'endTurn' });
  assert.equal(samplingResult('ok', 'me').model, 'me');
});

test('an elicitation answer carries content only when accepted', () => {
  assert.deepEqual(elicitResult('accept', { a: 1 }), { action: 'accept', content: { a: 1 } });
  assert.deepEqual(elicitResult('decline', { a: 1 }), { action: 'decline' });
  assert.deepEqual(elicitResult('cancel'), { action: 'cancel' });
});

test('a URL is taken apart: host, scheme, and warnings for what disguises a destination', () => {
  const ok = urlView('https://auth.example.com/authorize?x=1');
  assert.equal(ok.host, 'auth.example.com');
  assert.equal(ok.openable, true);
  assert.deepEqual(ok.warnings, []);
  assert.equal(ok.url, 'https://auth.example.com/authorize?x=1', 'the URL is kept exactly as sent');
  assert.match(urlView('http://example.com').warnings[0], /Not https/);
  assert.equal(urlView('http://example.com').openable, true);
  const js = urlView('javascript:alert(1)');
  assert.equal(js.openable, false);
  assert.match(js.warnings[0], /not http or https/);
  assert.equal(urlView('file:///etc/passwd').openable, false);
  assert.match(urlView('https://bank.com@evil.example/').warnings.join(' '), /user name or password/);
  assert.equal(urlView('https://bank.com@evil.example/').host, 'evil.example');
  assert.match(urlView('https://xn--pple-43d.com/').warnings.join(' '), /internationalized/);
  assert.equal(urlView('not a url').valid, false);
  assert.equal(urlView(42).openable, false);
});

test('roots are one URI per line with an optional name; a line that is not a URI is refused', () => {
  assert.deepEqual(rootsResult('file:///work  my work\n\nfile:///tmp\n'), { roots: [{ uri: 'file:///work', name: 'my work' }, { uri: 'file:///tmp' }] });
  assert.deepEqual(rootsResult(''), { roots: [] });
  assert.match(rootsResult('not-a-uri').error, /not a URI/);
  assert.deepEqual(nonFileRoots([{ uri: 'file:///a' }, { uri: 'https://b' }]), ['https://b']);
});

test('a refusal defaults to the error the legacy revisions name for sampling', () => {
  assert.deepEqual(defaultRefusal('sampling/createMessage'), { code: -1, message: 'User rejected sampling request' });
  assert.equal(defaultRefusal('roots/list').code, -1);
});

test('a raw result must be a JSON object', () => {
  assert.deepEqual(parseResult('{"a":1}'), { result: { a: 1 } });
  assert.ok('error' in parseResult('[1]'));
  assert.ok('error' in parseResult(''));
  assert.ok('error' in parseResult('{'));
});

test('a set is answered only when every key has an answer; an empty answer is not one', () => {
  const asked = { a: {}, b: {} };
  assert.equal(allAnswered(asked, {}), false);
  assert.equal(allAnswered(asked, { a: { x: 1 } }), false);
  assert.equal(allAnswered(asked, { a: { x: 1 }, b: undefined }), false);
  assert.equal(allAnswered(asked, { a: { x: 1 }, b: { action: 'decline' } }), true);
});

test('a -32042 error yields its URLs; any other error none', () => {
  const e = { code: -32042, message: 'URL required', data: { elicitations: [{ mode: 'url', url: 'https://a.example/', message: 'Sign in' }, { nope: true }] } };
  assert.deepEqual(urlElicitationsInError(e), [{ url: 'https://a.example/', message: 'Sign in' }]);
  assert.deepEqual(urlElicitationsInError({ code: -32603 }), []);
  assert.deepEqual(urlElicitationsInError(null), []);
});

test('a paused call and a server request read in words', () => {
  assert.equal(statusLabel('in_progress', { status: 'awaiting-input', paused: { rounds: 5, cap: 5 } }).text, 'Paused at the round limit');
  assert.equal(statusLabel('in_progress', { status: 'awaiting-input' }).text, 'Waiting for input');
  assert.equal(serverRequestStatus('pending').tone, 'busy');
  assert.equal(serverRequestStatus('cancelled').text, 'Cancelled by the server');
  assert.equal(serverRequestStatus('interrupted').tone, 'bad');
});
