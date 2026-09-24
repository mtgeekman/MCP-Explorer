// Surface version history (D8) wired to phase 01's capture.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { connectStdio, captureSurface, hashSurface, diffSurfaces, unavailableFields } from '../packages/protocol/dist/index.js';
import {
  createWorkspaceDb, saveServer, HistoryRecorder,
  recordCapture, loadSnapshot, surfaceHistory, listObservations, diffSnapshots, SnapshotNotFoundError,
} from '../packages/storage/dist/index.js';
import { memoryStore } from './support/memory-store.mjs';

const root = mkdtempSync(join(tmpdir(), 'mcpx-snap-'));
after(() => rmSync(root, { recursive: true, force: true }));
const fixture = fileURLToPath(new URL('../scripts/fixture/modern-server.mjs', import.meta.url));

function setup() {
  const ws = createWorkspaceDb({ path: join(root, `${randomUUID()}.db`), workspaceId: randomUUID(), name: 'snapshots', custody: { kind: 'keychain' }, secrets: memoryStore() });
  const serverId = randomUUID();
  saveServer(ws, { id: serverId, name: 'fixture', transport: 'stdio', command: process.execPath, args: [fixture] });
  return { ws, serverId };
}

async function capture(env = {}, onUnit) {
  const conn = await connectStdio({ command: process.execPath, args: [fixture], env: { ...process.env, ...env }, onUnit });
  try {
    return await captureSurface(conn.source);
  } finally {
    await conn.close();
  }
}

const surface = (overrides = {}) => ({
  revision: '2025-11-25', era: 'legacy', serverName: 'synthetic', serverVersion: '1.0.0', instructions: 'Use the tools. Café 中文.',
  capabilities: { tools: { listChanged: true }, prompts: {} },
  tools: [
    { name: 'b', description: 'second', inputSchema: { type: 'object', properties: { z: { type: 'string' }, a: { type: 'number' } } }, annotations: { readOnlyHint: true } },
    { name: 'a', title: 'First', inputSchema: { type: 'object' } },
  ],
  prompts: [{ name: 'greet', arguments: [{ name: 'who', required: true }] }],
  resources: [{ uri: 'file:///a.md', name: 'a', mimeType: 'text/markdown' }],
  resourceTemplates: [{ uriTemplate: 'file:///{p}.md', name: 'doc' }],
  unavailable: unavailableFields('2025-11-25'),
  problems: [],
  ...overrides,
});
let clock = 1000;
const tick = () => clock++;

// --- round trip -------------------------------------------------------------------

test('snapshots: a stored snapshot loads back to a surface with the same hash and the same items', () => {
  const { ws, serverId } = setup();
  try {
    const s = surface();
    const { snapshotId, contentHash } = recordCapture(ws, serverId, s, { now: tick });
    const loaded = loadSnapshot(ws, snapshotId);
    assert.equal(contentHash, hashSurface(s));
    assert.equal(hashSurface(loaded), contentHash, 'history and diff would disagree about this surface');
    assert.equal(diffSurfaces(s, loaded).identical, true);
    assert.deepEqual(loaded.tools.map((t) => t.name), ['b', 'a'], 'items keep the order the server listed them in');
    assert.deepEqual(loaded.unavailable, s.unavailable);
    assert.equal(loaded.instructions, s.instructions);
  } finally {
    ws.close();
  }
});

test('snapshots: absent optional fields stay absent, and empty strings stay empty', () => {
  const { ws, serverId } = setup();
  try {
    const bare = surface({ serverName: undefined, serverVersion: undefined, instructions: undefined });
    const empty = surface({ instructions: '' });
    const a = recordCapture(ws, serverId, bare, { now: tick });
    const b = recordCapture(ws, serverId, empty, { now: tick });
    assert.notEqual(a.contentHash, b.contentHash);
    const loaded = loadSnapshot(ws, a.snapshotId);
    for (const field of ['serverName', 'serverVersion', 'instructions']) assert.equal(field in loaded, false, `${field} came back present`);
    assert.equal(loadSnapshot(ws, b.snapshotId).instructions, '');
    assert.equal(hashSurface(loadSnapshot(ws, b.snapshotId)), b.contentHash);
  } finally {
    ws.close();
  }
});

test('snapshots: duplicate names are all kept, and the capture\'s problems go on its observation', () => {
  const { ws, serverId } = setup();
  try {
    const problems = [{ endpoint: 'tools/list', message: 'duplicate identity key(s): a -- only one of each survives hashing and diffing' }];
    const s = surface({ tools: [{ name: 'a', inputSchema: {} }, { name: 'a', description: 'twin', inputSchema: {} }], problems });
    const { snapshotId } = recordCapture(ws, serverId, s, { now: tick });
    assert.equal(loadSnapshot(ws, snapshotId).tools.length, 2);
    assert.deepEqual(listObservations(ws, serverId).map((o) => o.problems), [problems]);
    assert.deepEqual(loadSnapshot(ws, snapshotId).problems, [], 'problems describe a capture, not a surface');
  } finally {
    ws.close();
  }
});

test('snapshots: an unchanged item is stored as identical text in every version, however the server ordered its keys', () => {
  // The rendered text diff (D8) compares stored bodies; a server that shuffles
  // keys must not make an unchanged tool look rewritten.
  const { ws, serverId } = setup();
  try {
    const tool = { name: 'stable', description: 'unchanged', inputSchema: { type: 'object', properties: { b: {}, a: {} } }, annotations: { readOnlyHint: true, destructiveHint: false } };
    const shuffled = { annotations: { destructiveHint: false, readOnlyHint: true }, inputSchema: { properties: { a: {}, b: {} }, type: 'object' }, description: 'unchanged', name: 'stable' };
    const v1 = recordCapture(ws, serverId, surface({ tools: [tool], serverVersion: '1' }), { now: tick });
    const v2 = recordCapture(ws, serverId, surface({ tools: [shuffled], serverVersion: '2' }), { now: tick });
    const body = (id) => ws.db.prepare("SELECT body_json FROM snapshot_tool WHERE snapshot_id = ? AND key = 'stable'").get(id).body_json;
    assert.equal(body(v1.snapshotId), body(v2.snapshotId));
  } finally {
    ws.close();
  }
});

test('snapshots: a missing snapshot is SnapshotNotFoundError', () => {
  const { ws } = setup();
  try {
    assert.throws(() => loadSnapshot(ws, 999), SnapshotNotFoundError);
  } finally {
    ws.close();
  }
});

// --- history ------------------------------------------------------------------------

test('history: the same surface is one snapshot with one observation per capture', () => {
  const { ws, serverId } = setup();
  try {
    const first = recordCapture(ws, serverId, surface(), { now: tick });
    const again = recordCapture(ws, serverId, surface({ tools: [...surface().tools].reverse() }), { now: tick });
    assert.equal(first.isNew, true);
    assert.equal(again.isNew, false);
    assert.equal(again.snapshotId, first.snapshotId);
    assert.deepEqual(surfaceHistory(ws, serverId).map((h) => h.observations), [2]);
  } finally {
    ws.close();
  }
});

test('history: a surface that changes and changes back reuses the first snapshot', () => {
  const { ws, serverId } = setup();
  try {
    const a = recordCapture(ws, serverId, surface(), { now: tick });
    const b = recordCapture(ws, serverId, surface({ serverVersion: '1.1.0' }), { now: tick });
    const back = recordCapture(ws, serverId, surface(), { now: tick });
    assert.equal(back.snapshotId, a.snapshotId);
    assert.equal(back.isNew, false);
    const history = surfaceHistory(ws, serverId);
    assert.deepEqual(history.map((h) => [h.snapshotId, h.observations, h.serverVersion]), [[a.snapshotId, 2, '1.0.0'], [b.snapshotId, 1, '1.1.0']]);
    assert.ok(history[0].lastSeenAt > history[1].lastSeenAt, 'the older surface was seen most recently');
    assert.deepEqual(listObservations(ws, serverId).map((o) => o.snapshotId), [a.snapshotId, b.snapshotId, a.snapshotId]);
  } finally {
    ws.close();
  }
});

test('history: two servers with the same surface have separate histories', () => {
  const { ws, serverId } = setup();
  try {
    const other = randomUUID();
    saveServer(ws, { id: other, name: 'other', transport: 'stdio', command: 'node' });
    const a = recordCapture(ws, serverId, surface(), { now: tick });
    const b = recordCapture(ws, other, surface(), { now: tick });
    assert.notEqual(a.snapshotId, b.snapshotId);
    assert.equal(b.isNew, true);
    assert.equal(surfaceHistory(ws, serverId).length, 1);
  } finally {
    ws.close();
  }
});

test('history: a failure part-way through recording leaves no snapshot and no observation', () => {
  const { ws, serverId } = setup();
  try {
    ws.db.exec("CREATE TRIGGER no_templates BEFORE INSERT ON snapshot_resource_template BEGIN SELECT RAISE(ABORT, 'refused'); END");
    assert.throws(() => recordCapture(ws, serverId, surface(), { now: tick }), /refused/);
    for (const table of ['surface_snapshot', 'snapshot_tool', 'surface_observation']) {
      assert.equal(ws.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0, table);
    }
  } finally {
    ws.close();
  }
});

test('diff: stored snapshots diff the way live surfaces do', () => {
  const { ws, serverId } = setup();
  try {
    const before = surface();
    const after = surface({
      tools: [{ ...before.tools[0], description: 'changed' }, { name: 'c', inputSchema: {} }],
      instructions: 'New instructions.',
    });
    const a = recordCapture(ws, serverId, before, { now: tick });
    const b = recordCapture(ws, serverId, after, { now: tick });
    assert.deepEqual(diffSnapshots(ws, a.snapshotId, b.snapshotId), diffSurfaces(before, after));
    assert.deepEqual(diffSnapshots(ws, a.snapshotId, b.snapshotId).tools, [
      { key: 'a', kind: 'removed' }, { key: 'b', kind: 'changed' }, { key: 'c', kind: 'added' },
    ]);
  } finally {
    ws.close();
  }
});

// --- end to end against the fixture -------------------------------------------------

test('end to end: three captures of the shuffling fixture are one snapshot, a mutated server a second', async () => {
  const { ws, serverId } = setup();
  try {
    for (let i = 0; i < 3; i++) {
      const rec = HistoryRecorder.open(ws, serverId, tick);
      const s = await capture({}, rec.unit);
      rec.close();
      recordCapture(ws, serverId, s, { connectionId: rec.connectionId, now: tick });
    }
    assert.equal(surfaceHistory(ws, serverId).length, 1, 'key order and list order shuffle between captures, and must not make versions');

    // MUTATE_AFTER=1: the fixture changes its tools from the second tools/list
    // onward. A fresh process lists once, so a connection that lists twice sees it.
    const conn = await connectStdio({ command: process.execPath, args: [fixture], env: { ...process.env, MUTATE_AFTER: '1' } });
    let mutated;
    try {
      await captureSurface(conn.source);
      mutated = await captureSurface(conn.source);
    } finally {
      await conn.close();
    }
    const recorded = recordCapture(ws, serverId, mutated, { now: tick });
    assert.equal(recorded.isNew, true);
    const history = surfaceHistory(ws, serverId);
    assert.deepEqual(history.map((h) => h.observations), [3, 1]);
    const diff = diffSnapshots(ws, history[0].snapshotId, history[1].snapshotId);
    assert.equal(diff.identical, false);
    assert.equal(hashSurface(loadSnapshot(ws, recorded.snapshotId)), hashSurface(mutated));
    assert.ok(listObservations(ws, serverId).slice(0, 3).every((o) => o.connectionId !== null), 'captures made through a recorder link their connection');
  } finally {
    ws.close();
  }
});
