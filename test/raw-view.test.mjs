// The raw viewer's document (board 4.2B, D10): every byte on screen, rows by
// byte offset, a large unit whole, and find over the bytes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RawDocument, formatBytes } from '../app/renderer/src/lib/raw.ts';

const bytes = (s) => new Uint8Array(Buffer.from(s, 'utf8'));
const rows = (doc) => Array.from({ length: doc.rowCount }, (_, r) => doc.segments(r));
const shown = (doc) => rows(doc).map((segs) => segs.map((s) => s.text).join(''));

/** Rebuilds the bytes from what is on screen, to prove nothing was dropped or invented. */
function accountFor(doc) {
  const out = [];
  for (const segs of rows(doc)) {
    for (const s of segs) {
      if (s.kind === 'text') out.push(...Buffer.from(s.text, 'utf8'));
      else if (s.kind === 'eol') out.push(...(s.text === '\\r\\n' ? [13, 10] : [10]));
      else for (const m of s.text.matchAll(/\\x([0-9a-f]{2})/g)) out.push(parseInt(m[1], 16));
    }
  }
  return new Uint8Array(out);
}

test('lines end rows, and each ending is shown as it is on the wire', () => {
  const doc = new RawDocument(bytes('{"a":1}\r\n{"b":2}\nlast'));
  assert.deepEqual(shown(doc), ['{"a":1}\\r\\n', '{"b":2}\\n', 'last']);
  assert.deepEqual([0, 1, 2].map((r) => doc.rowStart(r)), [0, 9, 17]);
});

test('a long line wraps at the column width by bytes, never inside a character', () => {
  const doc = new RawDocument(bytes('abcé' + 'x'.repeat(10)), 4);
  assert.deepEqual(shown(doc), ['abc', 'éxx', 'xxxx', 'xxxx']);
  assert.deepEqual(accountFor(doc), doc.bytes);
});

test('bytes that are not valid UTF-8, and control bytes, are shown as escapes, never replaced', () => {
  const raw = Uint8Array.of(0x7b, 0xff, 0x41, 0xc3, 0x28, 0x1b, 0x09, 0xe2, 0x82, 0x0a);
  const doc = new RawDocument(raw);
  assert.deepEqual(shown(doc), ['{\\xffA\\xc3(\\x1b\t\\xe2\\x82\\n']);
  assert.ok(!shown(doc)[0].includes('�'), 'a replacement character would hide which bytes were there');
  assert.deepEqual(accountFor(doc), raw);
});

test('every byte is accounted for, whatever the content', () => {
  const noise = new Uint8Array(4096);
  for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) >>> 24;
  for (const cols of [4, 7, 160]) assert.deepEqual(accountFor(new RawDocument(noise, cols)), noise);
});

test('a 10 MB single-line result opens whole, and any offset finds its row', () => {
  const big = new Uint8Array(10 * 1024 * 1024).fill(0x61);
  big[big.length - 1] = 0x0a;
  const started = Date.now();
  const doc = new RawDocument(big, 160);
  assert.ok(Date.now() - started < 2000, `indexing took ${Date.now() - started} ms`);
  assert.equal(doc.rowCount, Math.ceil(big.length / 160));
  assert.equal(doc.rowStart(doc.rowCount - 1) + doc.segments(doc.rowCount - 1).reduce((n, s) => n + (s.kind === 'eol' ? 1 : s.text.length), 0), big.length);
  for (const offset of [0, 159, 160, 5_000_000, big.length - 1]) {
    const r = doc.rowOf(offset);
    assert.ok(doc.rowStart(r) <= offset && offset < (r + 1 < doc.rowCount ? doc.rowStart(r + 1) : big.length));
  }
});

test('find returns byte offsets, folds ASCII case on request, and says when it stopped early', () => {
  const doc = new RawDocument(bytes('Echo echo ECHO café café'));
  assert.deepEqual(doc.find('echo').offsets, [5]);
  assert.deepEqual(doc.find('echo', { caseSensitive: false }).offsets, [0, 5, 10]);
  assert.deepEqual(doc.find('café').offsets, [15, 21]);
  assert.deepEqual(doc.find('é').offsets, [18, 24]);
  assert.deepEqual(doc.find(''), { offsets: [], truncated: false });
  assert.deepEqual(doc.find('e', { caseSensitive: false, limit: 2 }), { offsets: [0, 5], truncated: true });
  assert.deepEqual(doc.find('zzz'), { offsets: [], truncated: false });
});

test('an empty unit is one empty row', () => {
  const doc = new RawDocument(new Uint8Array(0));
  assert.equal(doc.rowCount, 1);
  assert.deepEqual(doc.segments(0), []);
});

test('sizes read as people read them', () => {
  assert.deepEqual([0, 1023, 1024, 9.6 * 1024 * 1024].map(formatBytes), ['0 B', '1023 B', '1.0 KB', '9.6 MB']);
});
