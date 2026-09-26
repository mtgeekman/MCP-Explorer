// The call views' pure logic: every content type read as what it is, the
// unknown kept as JSON, media only as data it can safely be, and a call's
// state in words. Imported as TypeScript directly; Node strips the types.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { part, readableResult, statusLabel, progressText } from '../app/renderer/src/lib/content.ts';

test('every defined content type becomes its part; one no revision defines is kept whole as JSON', () => {
  assert.deepEqual(part({ type: 'text', text: 'hi' }), { kind: 'text', text: 'hi' });
  const img = part({ type: 'image', mimeType: 'image/png', data: 'AAAA' });
  assert.equal(img.src, 'data:image/png;base64,AAAA');
  assert.equal(img.bytes, 3);
  assert.equal(part({ type: 'audio', mimeType: 'audio/wav', data: 'AA==' }).src, 'data:audio/wav;base64,AA==');
  assert.deepEqual(part({ type: 'resource', resource: { uri: 'x://a', mimeType: 'text/plain', text: 't' } }), { kind: 'resource', uri: 'x://a', mimeType: 'text/plain', text: 't' });
  assert.deepEqual(part({ type: 'resource_link', uri: 'x://b', name: 'b' }), { kind: 'resource_link', uri: 'x://b', name: 'b' });
  const odd = part({ type: 'hologram', data: 'z' });
  assert.equal(odd.kind, 'unknown');
  assert.equal(odd.type, 'hologram');
  assert.deepEqual(JSON.parse(odd.json), { type: 'hologram', data: 'z' });
  assert.equal(part({ type: 'text', text: 7 }).kind, 'unknown', 'a malformed text block is not silently rendered');
});

test('media is shown only as what it claims to be, from base64', () => {
  assert.equal(part({ type: 'image', mimeType: 'text/html', data: 'AAAA' }).src, null, 'an image that says it is HTML');
  assert.equal(part({ type: 'image', mimeType: 'image/png', data: 'AA"onerror="x' }).src, null, 'data that is not base64');
  assert.equal(part({ type: 'audio', mimeType: 'image/png', data: 'AAAA' }).src, null, 'audio with an image MIME type');
});

test('a tool result: content, structuredContent, isError, and any other field shown rather than dropped', () => {
  const r = readableResult('tool', { resultType: 'complete', content: [{ type: 'text', text: '3' }], structuredContent: { sum: 3 }, isError: true, extra: 1 });
  assert.equal(r.isError, true);
  assert.equal(r.sections[0].parts[0].text, '3');
  assert.deepEqual(JSON.parse(r.structuredContent), { sum: 3 });
  assert.deepEqual(JSON.parse(r.other), { extra: 1 });
});

test('a prompt result reads as its messages under their roles; a resource read as its contents', () => {
  const p = readableResult('prompt', { description: 'd', messages: [{ role: 'user', content: { type: 'text', text: 'hi' } }] });
  assert.deepEqual(p.sections.map((s) => s.heading), ['Description', 'user']);
  const r = readableResult('resource', { contents: [{ uri: 'x://1', mimeType: 'text/plain', text: 'one' }, { uri: 'x://2', blob: 'AAAA' }] });
  assert.deepEqual(r.sections.map((s) => s.heading), ['x://1', 'x://2']);
  assert.equal(r.sections[1].parts[0].blobBytes, 3);
});

test('a call\'s state in words: live state wins, and every ending is named', () => {
  assert.equal(statusLabel('in_progress', { status: 'running' }).text, 'Running');
  assert.equal(statusLabel('in_progress', { status: 'awaiting-input' }).text, 'Waiting for input');
  for (const s of ['completed', 'error', 'cancelled', 'interrupted', 'abandoned', 'capped']) assert.notEqual(statusLabel(s).text, s);
  assert.equal(progressText({ progress: 3, total: 10, message: 'm' }), '3 of 10 (30%): m');
  assert.equal(progressText({ progress: 4 }), '4');
});
