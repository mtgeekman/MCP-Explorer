// Phase 09 code review findings, each pinned by name (R09-n).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createWorkspaceDb, saveServer, recordCapture, versionTimeline, latestCapture } from '../packages/storage/dist/index.js';
import { memoryStore } from './support/memory-store.mjs';

const root = mkdtempSync(join(tmpdir(), 'mcpx-p09r-'));
after(() => rmSync(root, { recursive: true, force: true }));

function setup() {
  const ws = createWorkspaceDb({ path: join(root, `${randomUUID()}.db`), workspaceId: randomUUID(), name: 'r09', custody: { kind: 'keychain' }, secrets: memoryStore() });
  const serverId = randomUUID();
  saveServer(ws, { id: serverId, name: 'fixture', transport: 'stdio', command: process.execPath, args: ['x'] });
  return { ws, serverId, at: (surface, t) => recordCapture(ws, serverId, surface, { now: () => t }) };
}

const surface = (o = {}) => ({
  revision: '2025-11-25', era: 'legacy', serverName: 'syn', serverVersion: '1.0.0', instructions: 'Use it.', capabilities: { tools: {} },
  tools: [{ name: 'echo', description: 'Echoes.', inputSchema: { type: 'object' } }],
  prompts: [], resources: [], resourceTemplates: [], unavailable: [], problems: [], ...o,
});

test('R09-2: a clock stepped back between captures does not reorder the history', () => {
  const { ws, serverId, at } = setup();
  try {
    const a = at(surface(), 2000);
    // The wall clock went back a second; these were recorded after A.
    const b = at(surface({ tools: [] }), 1000);
    at(surface({ tools: [] }), 900);
    assert.deepEqual(versionTimeline(ws, serverId).entries.map((e) => [e.snapshotId, e.kind, e.observations, e.firstObservedAt, e.lastObservedAt]),
      [[a.snapshotId, 'first', 1, 2000, 2000], [b.snapshotId, 'surface', 2, 900, 1000]]);
  } finally { ws.close(); }
});

test('R09-1: the timeline classifies from stored hashes and never reads an item body', () => {
  const { ws, serverId, at } = setup();
  try {
    at(surface(), 1);
    at(surface({ tools: [{ name: 'echo', description: 'Echoes, louder.', inputSchema: { type: 'object' } }] }), 2);
    const loud = [{ name: 'echo', description: 'Echoes, louder.', inputSchema: { type: 'object' } }];
    at(surface({ serverVersion: '2', tools: loud }), 3);
    at(surface({ serverVersion: '2', tools: loud, instructions: 'Other.' }), 4);
    at(surface({ serverVersion: '2', tools: loud, instructions: 'Other.', capabilities: { tools: {}, prompts: {} } }), 5);
    at(surface({ serverVersion: '2', tools: loud, instructions: 'Other.', capabilities: { tools: {}, prompts: {} }, prompts: [{ name: 'p' }], resourceTemplates: [{ uriTemplate: 'x://{a}' }] }), 6);
    at(surface({ serverVersion: '2', tools: [], instructions: 'Other.', capabilities: { tools: {}, prompts: {} }, prompts: [{ name: 'p' }], resourceTemplates: [{ uriTemplate: 'x://{a}' }] }), 7);
    // Bodies that are not items: a timeline that reads them fails.
    for (const t of ['snapshot_tool', 'snapshot_prompt', 'snapshot_resource', 'snapshot_resource_template']) ws.db.prepare(`UPDATE ${t} SET body_json = 'null'`).run();
    assert.deepEqual(versionTimeline(ws, serverId).entries.map((e) => [e.kind, e.changes]),
      [['first', 0], ['surface', 1], ['identity', 0], ['surface', 1], ['surface', 1], ['surface', 2], ['surface', 1]],
      'a description, a version, instructions, capabilities, a prompt and a template added, a tool removed');
  } finally { ws.close(); }
});

test('R09-2 twin: the latest capture is the last one recorded, not the latest by the clock', () => {
  const { ws, serverId, at } = setup();
  try {
    at(surface(), 2000);
    const b = at(surface({ tools: [] }), 1000);
    assert.equal(latestCapture(ws, serverId).snapshotId, b.snapshotId);
  } finally { ws.close(); }
});
