// A server answering initialize with a revision the SDK accepts must get the
// era the SDK speaks to it, whatever the revision table lists (the deferred
// phase 01 finding: an unknown revision sorted as newest, so 2024-10-07 read
// as modern on a legacy connection).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { connectStdio, captureSurface } from '../packages/protocol/dist/index.js';
import { fixtures } from './support/fixture-servers.mjs';

const open = [];
after(async () => { for (const c of open) await c.close(); });

for (const revision of ['2024-10-07', '2024-11-05']) {
  test(`a legacy server answering ${revision} is connected on the legacy era, with the later fields unavailable`, async () => {
    const conn = await connectStdio({ command: process.execPath, args: [join(fixtures, 'legacy-server.mjs')], env: { ...process.env, LEGACY_REVISION: revision } });
    open.push(conn);
    assert.equal(conn.revision, revision);
    assert.equal(conn.era, 'legacy');
    const surface = await captureSurface(conn.source);
    assert.equal(surface.era, 'legacy');
    for (const f of ['tool.annotations', 'tool.outputSchema', 'capabilities.extensions']) assert.ok(surface.unavailable.includes(f), f);
  });
}
