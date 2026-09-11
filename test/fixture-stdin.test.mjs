import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const server = join(fileURLToPath(new URL('../scripts/fixture/', import.meta.url)), 'legacy-server.mjs');

// A tools/list whose id carries a multi-byte character, so the frame is only
// parseable if the server decodes the stream rather than each chunk.
function frameWithMultibyte() {
  return JSON.stringify({ jsonrpc: '2.0', id: 'café-ééé', method: 'tools/list' }) + '\n';
}

test('a frame split mid-character is still parsed', async () => {
  const bytes = Buffer.from(frameWithMultibyte(), 'utf8');
  // Split INSIDE a multi-byte sequence: find the first lead byte (0xC3 for e-acute)
  // and cut one byte past it, so each half is invalid UTF-8 on its own.
  const lead = bytes.indexOf(0xc3);
  assert.ok(lead > 0, 'fixture frame must contain a multi-byte character');
  const cut = lead + 1;
  const child = spawn(process.execPath, [server], { stdio: ['pipe', 'pipe', 'pipe'] });

  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => { out += d; });

  child.stdin.write(bytes.subarray(0, cut));
  await new Promise((r) => setTimeout(r, 120));
  child.stdin.write(bytes.subarray(cut));

  const reply = await Promise.race([
    new Promise((resolve) => {
      const check = setInterval(() => {
        if (out.includes('\n')) { clearInterval(check); resolve(out); }
      }, 20);
    }),
    new Promise((resolve) => setTimeout(() => resolve(null), 3000)),
  ]);
  child.kill();

  assert.ok(reply, 'server never replied: the split frame was dropped');
  const msg = JSON.parse(reply.trim().split('\n')[0]);
  assert.equal(msg.id, 'café-ééé', 'id round-tripped intact');
  assert.equal(msg.result.tools.length, 1);
});

test('a plain ASCII frame in one write still works (old valid input)', async () => {
  const child = spawn(process.execPath, [server], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => { out += d; });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' }) + '\n');

  const reply = await Promise.race([
    new Promise((resolve) => {
      const t = setInterval(() => { if (out.includes('\n')) { clearInterval(t); resolve(out); } }, 20);
    }),
    new Promise((resolve) => setTimeout(() => resolve(null), 3000)),
  ]);
  child.kill();
  assert.ok(reply, 'server replied to an ordinary frame');
  const msg = JSON.parse(reply.trim().split('\n')[0]);
  assert.equal(msg.id, 7);
  assert.equal(msg.result.tools[0].name, 'echo');
});
