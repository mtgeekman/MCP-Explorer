// The wire log's rows and the readable pane's view of a unit (boards 1A, 4.1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { logRows, logCounts } from '../app/renderer/src/lib/logrows.ts';
import { readable, READABLE_LIMIT } from '../app/renderer/src/lib/readable.ts';

let n = 0;
const unit = (over) => {
  const text = over.text ?? '';
  const bytes = over.bytes === null ? null : over.bytes ?? new Uint8Array(Buffer.from(text, 'utf8'));
  return { id: ++n, serverId: 's', connectionId: 1, direction: 'in', kind: 'wire', at: 0, byteLength: bytes?.length ?? over.byteLength ?? 0, bytes, frames: [], ...over, text: undefined };
};
const frame = (method, jsonrpcId) => ({ method, jsonrpcId, resultWithheld: false });

test('rows are labelled from the indexed messages, and a reply carries its elapsed time', () => {
  const rows = logRows([
    unit({ direction: 'out', at: 1000, frames: [frame('server/discover', '1')], text: '{"jsonrpc":"2.0","id":1,"method":"server/discover"}\n' }),
    unit({ direction: 'in', at: 1042, frames: [frame('server/discover', '1')], text: '{"jsonrpc":"2.0","id":1,"result":{}}\n' }),
    unit({ direction: 'in', at: 1100, frames: [frame('sampling/createMessage', '"s1"')] }),
    unit({ direction: 'out', at: 1500, frames: [frame('sampling/createMessage', '"s1"')] }),
  ]);
  assert.deepEqual(rows.map((r) => [r.arrow, r.label, r.elapsedMs]), [
    ['→', 'server/discover #1', undefined],
    ['←', 'server/discover #1', 42],
    ['←', 'sampling/createMessage #"s1"', undefined],
    ['→', 'sampling/createMessage #"s1"', 400],
  ]);
  assert.equal(rows[0].preview, '{"jsonrpc":"2.0","id":1,"method":"server/discover"}\\n', 'the preview is the raw bytes, line ending shown');
});

test('units that carry no message say what they are, and stderr and app events are their own rows', () => {
  const rows = logRows([
    unit({ text: '<html>Bad Gateway</html>', http: { exchange: 1, status: 502 } }),
    unit({ text: '', http: { exchange: 2, status: 202 } }),
    unit({ direction: 'out', text: '', http: { exchange: 3, method: 'GET', url: 'http://x/sse' } }),
    unit({ text: ': keepalive\n\n', http: { exchange: 3, status: 200, framing: 'sse-event' } }),
    unit({ kind: 'stderr', text: 'listening\n' }),
    unit({ direction: 'local', kind: 'app', text: '{"event":"spawned","pid":7}' }),
    unit({ bytes: null, byteLength: 900, frames: [frame('tools/call', '4')] }),
  ]);
  assert.deepEqual(rows.map((r) => r.label), [
    'not JSON-RPC', 'HTTP 202, no body', 'GET http://x/sse', 'SSE event, no JSON-RPC', 'stderr', 'spawned', 'tools/call #4',
  ]);
  assert.equal(rows[0].preview, '<html>Bad Gateway</html>');
});

test('a long unit previews its first bytes and says there is more', () => {
  const [row] = logRows([unit({ text: 'x'.repeat(1000) })]);
  assert.equal(row.preview, 'x'.repeat(240) + ' ...');
});

test('a unit from before exact capture is labelled so', () => {
  const [row] = logRows([unit({ reserialized: true, frames: [frame('ping', null)], text: '{}' })]);
  assert.equal(row.label, 'ping (re-serialized, recorded before exact capture)');
});

test('counts keep frames, stderr, app events and other units apart', () => {
  assert.deepEqual(logCounts([
    unit({ frames: [frame('a', '1'), frame('b', null)] }),
    unit({ kind: 'stderr' }), unit({ kind: 'stderr' }),
    unit({ direction: 'local', kind: 'app' }),
    unit({ text: 'junk' }),
  ]), { frames: 2, stderr: 2, app: 1, other: 1 });
});

test('the readable pane indents JSON-RPC and sets cache hints apart from the surface', () => {
  const r = readable(unit({ text: '{"jsonrpc":"2.0","id":2,"result":{"tools":[],"ttlMs":4000,"cacheScope":"public"}}' }));
  assert.equal(r.kind, 'json');
  assert.deepEqual(r.cacheHints, [{ name: 'ttlMs', value: 4000 }, { name: 'cacheScope', value: 'public' }]);
  assert.match(r.pretty, /^\{\n {2}"jsonrpc": "2.0"/);
});

test('the readable pane reads an SSE event by its data', () => {
  const r = readable(unit({ text: 'event: message\r\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\r\n\r\n', http: { exchange: 1, framing: 'sse-event' } }));
  assert.equal(r.kind, 'json');
  assert.equal(r.sse, true);
});

test('the readable pane says what it cannot render, and why', () => {
  assert.deepEqual(readable(unit({ bytes: null, byteLength: 10 })), { kind: 'withheld' });
  assert.equal(READABLE_LIMIT, 10 * 1024 * 1024, 'phase 06 decision 5: the SDK stdio line cap');
  assert.equal(readable(unit({ bytes: new Uint8Array(READABLE_LIMIT + 1) })).kind, 'too-large');
  assert.equal(readable(unit({ text: '' })).kind, 'empty');
  assert.deepEqual(readable(unit({ text: '<html>' })), { kind: 'text', text: '<html>', why: 'Not JSON, so not JSON-RPC.' });
  assert.deepEqual(readable(unit({ direction: 'local', kind: 'app', text: '{"event":"exited","code":3}' })), { kind: 'app', fields: [['event', 'exited'], ['code', '3']] });
});
