// The app icon files packaging uses (npm run icons writes them from
// build/icon.svg): an ICO with every Windows shell size as PNG, and a
// 1024 px PNG with transparent corners, both committed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const build = (f) => fileURLToPath(new URL(`../build/${f}`, import.meta.url));
const PNG_MAGIC = '89504e470d0a1a0a';
const pngSize = (b) => ({ width: b.readUInt32BE(16), height: b.readUInt32BE(20), colorType: b.readUInt8(25) });

test('build/icon.ico holds a PNG at each Windows shell size, 16 to 256', () => {
  const b = readFileSync(build('icon.ico'));
  assert.equal(b.readUInt16LE(0), 0);
  assert.equal(b.readUInt16LE(2), 1, 'an icon, not a cursor');
  const count = b.readUInt16LE(4);
  const sizes = [];
  for (let i = 0; i < count; i++) {
    const e = 6 + 16 * i;
    const size = b.readUInt8(e) || 256;
    const length = b.readUInt32LE(e + 8);
    const offset = b.readUInt32LE(e + 12);
    const png = b.subarray(offset, offset + length);
    assert.equal(png.subarray(0, 8).toString('hex'), PNG_MAGIC, `entry ${size} is a PNG`);
    assert.deepEqual([pngSize(png).width, pngSize(png).height], [size, size], `entry ${size} is ${size} px square`);
    sizes.push(size);
  }
  assert.deepEqual(sizes, [16, 20, 24, 32, 40, 48, 64, 128, 256]);
});

test('build/icon.png is 1024 px square with an alpha channel', () => {
  const b = readFileSync(build('icon.png'));
  assert.equal(b.subarray(0, 8).toString('hex'), PNG_MAGIC);
  const { width, height, colorType } = pngSize(b);
  assert.deepEqual([width, height], [1024, 1024]);
  assert.equal(colorType, 6, 'RGBA, so the rounded corners are transparent');
});
