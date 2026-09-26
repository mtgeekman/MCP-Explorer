// The line diff under the version views (phase 09 decisions 4 and 6). Minimal
// by construction is checked against a dynamic-programming LCS on random
// inputs, so a wrong backtrack cannot pass by producing a longer valid diff.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffText, diffLines, splitLines } from '../packages/protocol/dist/index.js';

function lcs(a, b) {
  const t = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) {
    t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
  }
  return t[0][0];
}

let seed = 7;
const rand = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
const randomLines = () => Array.from({ length: rand(12) }, () => 'abcd'[rand(4)]);

test('random inputs: the ops rebuild both texts, and the diff is minimal', () => {
  for (let run = 0; run < 400; run++) {
    const a = randomLines();
    const b = randomLines();
    const ops = diffLines(a, b, 1000);
    assert.deepEqual(ops.filter((o) => o.op !== 'added').map((o) => o.text), a, 'before is rebuilt');
    assert.deepEqual(ops.filter((o) => o.op !== 'removed').map((o) => o.text), b, 'after is rebuilt');
    const edits = ops.filter((o) => o.op !== 'same').length;
    assert.equal(edits, a.length + b.length - 2 * lcs(a, b), `minimal for ${a.join('')} -> ${b.join('')}`);
    for (const o of ops) {
      if (o.before !== undefined) assert.equal(a[o.before - 1], o.text, 'before numbers are 1-based and right');
      if (o.after !== undefined) assert.equal(b[o.after - 1], o.text, 'after numbers are 1-based and right');
    }
  }
});

test('identical texts have no hunks; empty text has no lines', () => {
  assert.deepEqual(diffText('a\nb', 'a\nb'), { complete: true, removed: 0, added: 0, hunks: [] });
  assert.deepEqual(splitLines(''), []);
  const d = diffText('', 'x\ny');
  assert.equal(d.added, 2);
  assert.deepEqual(d.hunks[0], {
    beforeStart: 0, beforeCount: 0, afterStart: 1, afterCount: 2,
    lines: [{ op: 'added', text: 'x', after: 1 }, { op: 'added', text: 'y', after: 2 }],
  });
});

test('hunks carry three lines of context; distant changes are separate hunks, near ones merge', () => {
  const a = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
  const far = [...a]; far[4] = 'five'; far[24] = 'twenty-five';
  const d = diffText(a.join('\n'), far.join('\n'));
  assert.equal(d.hunks.length, 2);
  assert.deepEqual(d.hunks.map((h) => [h.beforeStart, h.beforeCount, h.afterStart, h.afterCount]), [[2, 7, 2, 7], [22, 7, 22, 7]]);
  const near = [...a]; near[4] = 'five'; near[11] = 'twelve';
  assert.equal(diffText(a.join('\n'), near.join('\n')).hunks.length, 1, 'six unchanged lines between: the contexts touch');
  const apart = [...a]; apart[4] = 'five'; apart[12] = 'thirteen';
  assert.equal(diffText(a.join('\n'), apart.join('\n')).hunks.length, 2, 'seven unchanged lines between: two hunks');
});

test('past the edit limit the diff says it is incomplete, and at the limit it is not', () => {
  const a = Array.from({ length: 10 }, (_, i) => `a${i}`).join('\n');
  const b = Array.from({ length: 10 }, (_, i) => `b${i}`).join('\n');
  assert.deepEqual(diffText(a, b, { maxEdits: 19 }), { complete: false, removed: 0, added: 0, hunks: [] });
  assert.equal(diffText(a, b, { maxEdits: 20 }).complete, true);
  assert.equal(diffText('x', Array(50).fill('y').join('\n'), { maxEdits: 10 }).complete, false, 'the length difference alone exceeds it');
});

test('a paired removed and added line mark the span that differs', () => {
  const [line] = diffText('"description": "Echoes its input."', '"description": "Echoes the input."').hunks[0].lines.slice(0, 1);
  assert.deepEqual(line.mark, [23, 26], '"its" against "the"');
  const d = diffText('keep\nold one\nold two', 'keep\nnew one\nnew two\nextra');
  const marks = d.hunks[0].lines.map((l) => [l.op, l.mark]);
  assert.deepEqual(marks, [
    ['same', undefined], ['removed', [0, 3]], ['removed', [0, 3]], ['added', [0, 3]], ['added', [0, 3]], ['added', undefined],
  ]);
});

test('a mark never splits a surrogate pair', () => {
  // U+1F600 and U+1F601 share their high surrogate; the mark must take both halves.
  const [del, add] = diffText('x\u{1F600}y', 'x\u{1F601}y').hunks[0].lines;
  assert.deepEqual(del.mark, [1, 3]);
  assert.deepEqual(add.mark, [1, 3]);
  // U+10000 and U+10400 share their low surrogate; the mark must not end between the halves.
  const [d2, a2] = diffText('x𐀀', 'x𐐀').hunks[0].lines;
  assert.deepEqual(d2.mark, [1, 3]);
  assert.deepEqual(a2.mark, [1, 3]);
});
