// Process ownership (D36): the deferred phase 04 and phase 05 findings on
// ending server trees, one test per mechanism. Each was watched failing
// before its fix.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createWorkspaceDb } from '../packages/storage/dist/index.js';
import { ConnectionManager } from '../packages/backend/dist/index.js';

const root = mkdtempSync(join(tmpdir(), 'mcpx-own-'));
const cleanups = [];
after(async () => {
  for (const c of cleanups.reverse()) await c();
  rmSync(root, { recursive: true, force: true });
});

const noSecrets = { get: () => null, set: () => { throw new Error('unexpected keychain write'); }, delete: () => false };

function workspace() {
  const ws = createWorkspaceDb({ path: join(root, `${randomUUID()}.db`), workspaceId: randomUUID(), name: 'own', custody: { kind: 'none' }, secrets: noSecrets });
  cleanups.push(() => ws.close());
  return ws;
}

test('a spawn that reuses an owned root\'s PID does not forget the old root: both are ended and reported', async () => {
  const reports = [];
  const ended = [];
  const manager = new ConnectionManager(workspace(), {
    events: { processes: (roots) => reports.push(roots) },
    killTree: async (r) => { ended.push(r); },
  });
  const old = { pid: 4242, startedAt: 1 };
  const reuser = { pid: 4242, startedAt: 2 };
  manager['adopt'](old);
  manager['adopt'](reuser);
  assert.deepEqual(reports.at(-1), [old, reuser], 'the report lost the old root');
  await manager.closeAll();
  assert.ok(ended.includes(old), 'the old root, and what it left behind, was never ended');
  assert.ok(ended.includes(reuser));
  assert.deepEqual(reports.at(-1), []);
});
