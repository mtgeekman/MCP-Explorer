// A list is captured as the server sent it (phase 07, found building the
// call corpus). The SDK's listTools() validates the whole reply, so one tool
// with a string readOnlyHint or a non-object inputSchema failed the entire
// list, and the capture showed no tools at all: the malformed entries are the
// ones an explorer exists to show.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { connectStdio, captureSurface } from '../packages/protocol/dist/index.js';
import { fixtures } from './support/fixture-servers.mjs';

for (const [era, file] of [['modern', 'modern-server.mjs'], ['legacy', 'legacy-server.mjs']]) {
  test(`${era}: a tools/list with malformed entries is captured whole, malformed entries included`, async () => {
    const conn = await connectStdio({ command: process.execPath, args: [join(fixtures, file)], env: { ...process.env, CALL_TOOLS: '1' } });
    try {
      const surface = await captureSurface(conn.source);
      assert.deepEqual(surface.problems.filter((p) => p.kind === 'list-failed'), []);
      const byName = new Map(surface.tools.map((t) => [t.name, t]));
      assert.equal(byName.get('hint_readonly_string').annotations.readOnlyHint, 'true');
      assert.deepEqual(byName.get('schema_not_object').inputSchema, { type: 'string' });
      assert.deepEqual(byName.get('schema_no_type').inputSchema, {});
      assert.ok(byName.has('add'));
    } finally {
      await conn.close();
    }
  });
}

test('modern: a list answered with a JSON-RPC error is a failed list with the server\'s message', async () => {
  const conn = await connectStdio({ command: process.execPath, args: [join(fixtures, 'modern-server.mjs')], env: { ...process.env, LIE_ABOUT: 'prompts' } });
  try {
    const surface = await captureSurface(conn.source);
    const [problem] = surface.problems;
    assert.equal(problem.endpoint, 'prompts/list');
    assert.equal(problem.kind, 'list-failed');
    assert.match(problem.message, /Method not found: prompts\/list/);
  } finally {
    await conn.close();
  }
});
