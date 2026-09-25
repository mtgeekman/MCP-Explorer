// Cutting a byte stream into wire units (D34): lines for stdio, events for
// Server-Sent Events. A unit must be the exact bytes, however the stream was
// chunked on its way in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LineSplitter, SseEventSplitter, sseEventData } from '../packages/protocol/dist/index.js';

const bytes = (s) => Buffer.from(s, 'utf8');
const text = (units) => units.map((u) => Buffer.from(u).toString('utf8'));

/** Every way to cut `input` into two chunks, plus one byte at a time. */
function chunkings(input) {
  const b = bytes(input);
  const out = [[b], Array.from(b, (x) => Uint8Array.of(x))];
  for (let i = 1; i < b.length; i++) out.push([b.subarray(0, i), b.subarray(i)]);
  return out;
}

function run(Splitter, chunks) {
  const s = new Splitter();
  const units = chunks.flatMap((c) => s.push(c));
  const rest = s.flush();
  return { units: text(units), rest: rest && Buffer.from(rest).toString('utf8') };
}

// --- lines --------------------------------------------------------------------------

test('lines: each line keeps its own terminator, CR included, whatever the chunking', () => {
  const input = '{"a":1}\n  {"b": 2}  \r\n\ncafé\ntail';
  for (const chunks of chunkings(input)) {
    assert.deepEqual(run(LineSplitter, chunks), { units: ['{"a":1}\n', '  {"b": 2}  \r\n', '\n', 'café\n'], rest: 'tail' });
  }
});

test('lines: a multi-byte character split across chunks is one line of the original bytes', () => {
  const b = bytes('é€\n');
  const s = new LineSplitter();
  assert.deepEqual(s.push(b.subarray(0, 1)), []);
  assert.deepEqual(s.push(b.subarray(1, 3)), []);
  const [line] = s.push(b.subarray(3));
  assert.deepEqual(Buffer.from(line), b);
});

test('lines: pending counts the bytes held without a terminator', () => {
  const s = new LineSplitter();
  s.push(bytes('abc\nde'));
  assert.equal(s.pending, 2);
  assert.equal(Buffer.from(s.flush()).toString(), 'de');
  assert.equal(s.pending, 0);
  assert.equal(s.flush(), undefined);
});

test('lines: a long line in many chunks comes out whole', () => {
  const s = new LineSplitter();
  const chunk = Buffer.alloc(64 * 1024, 0x61);
  for (let i = 0; i < 64; i++) assert.deepEqual(s.push(chunk), []);
  const [line] = s.push(bytes('\n'));
  assert.equal(line.length, 64 * 64 * 1024 + 1);
});

// --- SSE events -------------------------------------------------------------------------

test('sse: events end at a blank line under LF, CRLF and lone-CR endings, whatever the chunking', () => {
  const input = 'event: message\ndata: {"a":1}\n\n: keepalive\r\n\r\ndata: x\rdata: y\r\rid: 7\n';
  for (const chunks of chunkings(input)) {
    assert.deepEqual(run(SseEventSplitter, chunks), {
      units: ['event: message\ndata: {"a":1}\n\n', ': keepalive\r\n\r\n', 'data: x\rdata: y\r\r'],
      rest: 'id: 7\n',
    }, `chunked as ${chunks.map((c) => c.length).join('+')}`);
  }
});

test('sse: a blank line ending in CR waits to see whether an LF follows', () => {
  const s = new SseEventSplitter();
  assert.deepEqual(s.push(bytes('data: a\r\n\r')), []);
  assert.deepEqual(text(s.push(bytes('\ndata: b\n\n'))), ['data: a\r\n\r\n', 'data: b\n\n']);
  assert.deepEqual(s.push(bytes('data: c\r\r')), []);
  assert.deepEqual(text(s.push(bytes('data: d'))), ['data: c\r\r']);
  assert.equal(Buffer.from(s.flush()).toString(), 'data: d');
});

test('sse: an event ended by a final CR is flushed whole when the stream ends', () => {
  const s = new SseEventSplitter();
  s.push(bytes('data: a\r\r'));
  assert.equal(Buffer.from(s.flush()).toString(), 'data: a\r\r');
});

test('sse: a leading blank line is an event of its own bytes', () => {
  assert.deepEqual(run(SseEventSplitter, [bytes('\ndata: a\n\n')]).units, ['\n', 'data: a\n\n']);
});

test('sse: the data of an event is its data fields joined with LF', () => {
  assert.equal(sseEventData(bytes('event: message\r\ndata: {"a":\r\ndata:1}\r\n\r\n')), '{"a":\n1}');
  assert.equal(sseEventData(bytes('data:  two spaces\n\n')), ' two spaces');
  assert.equal(sseEventData(bytes('data\n\n')), '');
  assert.equal(sseEventData(bytes('﻿data: bom\n\n')), 'bom');
  assert.equal(sseEventData(bytes(': comment\n\n')), null);
  assert.equal(sseEventData(bytes('event: endpoint\n\n')), null);
  assert.equal(sseEventData(Uint8Array.of(0x64, 0x61, 0x74, 0x61, 0x3a, 0xff, 0x0a)), null);
});
