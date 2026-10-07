// Pane sizing: the wire log's height and the readable pane's width. Imported
// as TypeScript; Node strips the types.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clamp, logBounds, readableBounds, listBounds, dragSize, growArrow, keySize, readSize, readFlag, remember, LOG_MIN, MAIN_MIN, READABLE_MIN, CENTER_MIN, LIST_MIN, ENTRY_MIN, KEY_STEP } from '../app/renderer/src/lib/panes.ts';

const memory = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), m };
};

test('clamp keeps a size inside its bounds, and a bound squeezed below its minimum yields the minimum', () => {
  assert.equal(clamp(50, { min: 100, max: 400 }), 100);
  assert.equal(clamp(500, { min: 100, max: 400 }), 400);
  assert.equal(clamp(250.6, { min: 100, max: 400 }), 251);
  assert.equal(clamp(300, { min: 100, max: 40 }), 100, 'a window too small for both panes keeps the pane at its minimum');
});

test('the log may grow until the server view has its minimum, and shrink to its header and three rows', () => {
  assert.deepEqual(logBounds(800), { min: LOG_MIN, max: 800 - MAIN_MIN });
  assert.deepEqual(readableBounds(1200), { min: READABLE_MIN, max: 1200 - CENTER_MIN });
  assert.deepEqual(listBounds(900), { min: LIST_MIN, max: 900 - ENTRY_MIN }, 'the surface list leaves the entry its minimum');
});

test('dragging toward a pane shrinks it; dragging away grows it; the result is clamped', () => {
  const b = { min: 110, max: 600 };
  assert.equal(dragSize(300, 500, 400, b), 400, 'the log handle dragged up 100 px grows the log');
  assert.equal(dragSize(300, 500, 600, b), 200, 'dragged down 100 px shrinks it');
  assert.equal(dragSize(300, 500, 900, b), 110);
  assert.equal(dragSize(300, 500, -900, b), 600);
});

test('a handle on the far edge (right of the surface list) grows its pane dragged away, and shrinks it dragged back', () => {
  const b = { min: 160, max: 600 };
  assert.equal(dragSize(260, 400, 480, b, 'far'), 340, 'dragged right 80 px grows the list');
  assert.equal(dragSize(260, 400, 350, b, 'far'), 210, 'dragged left 50 px shrinks it');
  assert.equal(dragSize(260, 400, 0, b, 'far'), 160);
  assert.equal(dragSize(260, 400, 2000, b, 'far'), 600);
  assert.equal(dragSize(260, 400, 480, b, 'near'), 180, 'the same move on a near edge shrinks');
});

test('the grow arrow follows the axis and the edge', () => {
  assert.equal(growArrow('y', 'near'), 'ArrowUp', 'the log');
  assert.equal(growArrow('x', 'near'), 'ArrowLeft', 'the readable pane');
  assert.equal(growArrow('x', 'far'), 'ArrowRight', 'the surface list');
  assert.equal(growArrow('y', 'far'), 'ArrowDown');
});

test('keys: the grow arrow grows, the other shrinks, Shift is four steps, Home and End go to the ends, other keys are ignored', () => {
  const b = { min: 110, max: 600 };
  assert.equal(keySize('ArrowUp', false, 300, b, 'ArrowUp'), 300 + KEY_STEP);
  assert.equal(keySize('ArrowDown', true, 300, b, 'ArrowUp'), 300 - 4 * KEY_STEP);
  assert.equal(keySize('ArrowLeft', false, 300, b, 'ArrowLeft'), 300 + KEY_STEP);
  assert.equal(keySize('ArrowRight', false, 300, b, 'ArrowLeft'), 300 - KEY_STEP);
  assert.equal(keySize('ArrowLeft', false, 300, b, 'ArrowUp'), undefined, 'the log handle ignores sideways keys');
  assert.equal(keySize('ArrowRight', false, 300, b, 'ArrowRight'), 300 + KEY_STEP, 'the surface list grows to the right');
  assert.equal(keySize('ArrowLeft', true, 300, b, 'ArrowRight'), 300 - 4 * KEY_STEP);
  assert.equal(keySize('ArrowUp', false, 300, b, 'ArrowRight'), undefined);
  assert.equal(keySize('Home', false, 300, b, 'ArrowUp'), 110);
  assert.equal(keySize('End', false, 300, b, 'ArrowUp'), 600);
  assert.equal(keySize('a', false, 300, b, 'ArrowUp'), undefined);
});

test('remembered sizes round-trip; junk, absence and a throwing store read as nothing', () => {
  const s = memory();
  remember(s, 'h', 312.4);
  remember(s, 'c', true);
  assert.equal(readSize(s, 'h'), 312);
  assert.equal(readFlag(s, 'c'), true);
  remember(s, 'c', false);
  assert.equal(readFlag(s, 'c'), false);
  assert.equal(readSize(s, 'missing'), undefined);
  s.setItem('bad', 'NaN');
  assert.equal(readSize(s, 'bad'), undefined);
  s.setItem('neg', '-5');
  assert.equal(readSize(s, 'neg'), undefined);
  const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('quota'); } };
  assert.equal(readSize(broken, 'h'), undefined);
  assert.equal(readFlag(broken, 'c'), false);
  assert.doesNotThrow(() => remember(broken, 'h', 5));
  assert.equal(readSize(undefined, 'h'), undefined);
});
