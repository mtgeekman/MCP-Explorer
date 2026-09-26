// Phase 10 in the adapter: list requests without the SDK's timeout, logging,
// ping and completions on each era (plan phase 10, decisions 4, 5 and 8).
import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { connectStdio } from '../packages/protocol/dist/index.js';
import { fixtures } from './support/fixture-servers.mjs';

const MODERN = join(fixtures, 'modern-server.mjs');
const LEGACY = join(fixtures, 'legacy-server.mjs');
const open = [];
after(async () => { for (const c of open) await c.close().catch(() => undefined); });

async function stdio(file, env = {}) {
  const frames = [];
  const conn = await connectStdio({
    command: process.execPath, args: [file], env: { ...process.env, ...env },
    onFrame: (direction, frame) => frames.push({ direction, frame }),
  });
  open.push(conn);
  return { conn, frames };
}

const sent = (frames, method) => frames.filter((f) => f.direction === 'out' && f.frame.method === method);

test('a list request never times out on its own: no cancellation after the SDK\'s 60 s (deferred phase 07, P2)', async () => {
  const { conn, frames } = await stdio(LEGACY, { HANG_ON_LIST: '1' });
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const listing = conn.source.listTools().catch((e) => e);
    // Let the request reach the transport before time moves.
    await new Promise((r) => setImmediate(r));
    assert.equal(sent(frames, 'tools/list').length, 1);
    mock.timers.tick(61_000);
    await new Promise((r) => setImmediate(r));
    assert.equal(sent(frames, 'notifications/cancelled').length, 0, 'the SDK cancelled a list the user is still waiting on');
    void listing;
  } finally {
    mock.timers.reset();
  }
});
