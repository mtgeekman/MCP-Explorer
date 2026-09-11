// A stdio child whose stderr is piped but never drained blocks in write() once
// the OS pipe buffer fills. The capture then hangs with no error at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectStdio, captureSurface } from '../packages/protocol/dist/index.js';

const fixtures = fileURLToPath(new URL('../scripts/fixture/', import.meta.url));

test('a server that floods stderr still completes its capture', async () => {
  const conn = await connectStdio({
    command: process.execPath,
    args: [join(fixtures, 'modern-server.mjs')],
    // 256KB: comfortably past the ~64KB pipe buffer on every platform we build for.
    env: { ...process.env, STDERR_FLOOD: String(256 * 1024) },
  });
  try {
    const surface = await captureSurface(conn.source);
    assert.equal(surface.tools.length, 2, 'the session completed despite the flood');
  } finally {
    await conn.close();
  }
});

test('a connect failure carries the child stderr that explains it', async () => {
  // A command that does not exist and a server that dies during negotiation
  // produce the SAME protocol-level message. The child's own output is the only
  // thing that tells them apart, so it must reach the error.
  await assert.rejects(
    () => connectStdio({
      command: process.execPath,
      args: [join(fixtures, 'definitely-not-a-server.mjs')],
    }),
    (e) => {
      assert.match(e.message, /server stderr:/, `no stderr in: ${e.message}`);
      assert.match(e.message, /Cannot find module/, `stderr not the child's: ${e.message}`);
      return true;
    },
  );
});

test('a healthy server still connects and reports no stderr (old valid input)', async () => {
  const conn = await connectStdio({
    command: process.execPath,
    args: [join(fixtures, 'modern-server.mjs')],
  });
  try {
    const surface = await captureSurface(conn.source);
    assert.equal(surface.tools.length, 2);
    assert.equal(surface.problems.length, 0);
  } finally {
    await conn.close();
  }
});
