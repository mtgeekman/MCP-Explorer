// Retention (D24): age threshold and size cap over calls and frames, whole
// calls at a time, snapshots exempt, triggered by open and by finishing a call.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  createWorkspaceDb, openWorkspaceDb, saveServer, HistoryRecorder, recordCapture,
  purgeHistory, compact, liveBytes, readSettings, updateSettings, InvalidSettingsError,
} from '../packages/storage/dist/index.js';
import { unavailableFields } from '../packages/protocol/dist/index.js';
import { memoryStore } from './support/memory-store.mjs';

const root = mkdtempSync(join(tmpdir(), 'mcpx-ret-'));
after(() => rmSync(root, { recursive: true, force: true }));
const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 14);

function setup() {
  const req = { path: join(root, `${randomUUID()}.db`), workspaceId: randomUUID(), name: 'retention', custody: { kind: 'keychain' }, secrets: memoryStore(), now: () => NOW };
  const ws = createWorkspaceDb(req);
  const serverId = randomUUID();
  saveServer(ws, { id: serverId, name: 'fixture', transport: 'stdio', command: 'node' });
  return { ws, req, serverId };
}

const count = (ws, table) => ws.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
const padding = (bytes) => 'x'.repeat(bytes);

/** A finished call with one round and a request and response frame, started `at`. */
function seedCall(ws, rec, at, { bytes = 100, status = 'completed' } = {}) {
  const clock = () => at;
  const r = HistoryRecorder.open(ws, rec.serverId, clock);
  const call = r.beginCall('tool', 'echo');
  const seq = r.beginRound(call, { text: padding(bytes) });
  r.frame('out', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'echo', arguments: { text: padding(bytes) } } });
  r.frame('in', { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: padding(bytes) }] } });
  if (status === 'in_progress') return call;
  r.finishRound(call, seq, { result: { content: [] }, resultType: 'complete' });
  // finishCall applies retention too, but against the seeded clock, at which
  // this call is brand new; the tests then purge at NOW explicitly.
  r.finishCall(call, status);
  return call;
}

function seedSnapshot(ws, serverId, at, bytes = 100) {
  // The time is part of the instructions so each seeded surface is distinct:
  // identical surfaces are, correctly, one snapshot.
  recordCapture(ws, serverId, {
    revision: '2025-11-25', era: 'legacy', capabilities: {}, instructions: `${at} ${padding(bytes)}`,
    tools: [], prompts: [], resources: [], resourceTemplates: [], unavailable: unavailableFields('2025-11-25'), problems: [],
  }, { now: () => at });
}

// --- age ---------------------------------------------------------------------------

test('age: calls older than the threshold go with their rounds and frames; newer ones stay', () => {
  const { ws, serverId } = setup();
  try {
    const old = seedCall(ws, { serverId }, NOW - 91 * DAY);
    const recent = seedCall(ws, { serverId }, NOW - 89 * DAY);
    const result = purgeHistory(ws, () => NOW);
    assert.equal(result.callsDeleted, 1);
    assert.deepEqual(ws.db.prepare('SELECT id FROM call').all().map((r) => r.id), [recent]);
    assert.equal(ws.db.prepare('SELECT count(*) AS n FROM call_round WHERE call_id = ?').get(old).n, 0);
    assert.equal(ws.db.prepare('SELECT count(*) AS n FROM frame WHERE call_id = ?').get(old).n, 0);
    assert.equal(ws.db.prepare('SELECT count(*) AS n FROM frame WHERE call_id = ?').get(recent).n, 2);
  } finally {
    ws.close();
  }
});

test('age: a call exactly at the threshold is kept', () => {
  const { ws, serverId } = setup();
  try {
    seedCall(ws, { serverId }, NOW - 90 * DAY);
    assert.equal(purgeHistory(ws, () => NOW).callsDeleted, 0);
  } finally {
    ws.close();
  }
});

test('age: a call still in progress is never purged, however old', () => {
  const { ws, serverId } = setup();
  try {
    seedCall(ws, { serverId }, NOW - 400 * DAY, { status: 'in_progress' });
    const result = purgeHistory(ws, () => NOW);
    assert.equal(result.callsDeleted, 0);
    assert.equal(count(ws, 'call'), 1);
    assert.equal(count(ws, 'frame'), 2);
  } finally {
    ws.close();
  }
});

test('age: connection-level frames go by their own time', () => {
  const { ws, serverId } = setup();
  try {
    const oldConn = HistoryRecorder.open(ws, serverId, () => NOW - 100 * DAY);
    oldConn.frame('out', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const newConn = HistoryRecorder.open(ws, serverId, () => NOW - DAY);
    newConn.frame('out', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const result = purgeHistory(ws, () => NOW);
    assert.equal(result.framesDeleted, 1);
    assert.deepEqual(ws.db.prepare('SELECT connection_id FROM frame').all().map((r) => r.connection_id), [newConn.connectionId]);
  } finally {
    ws.close();
  }
});

test('age: snapshots and observations are never purged', () => {
  const { ws, serverId } = setup();
  try {
    seedSnapshot(ws, serverId, NOW - 3650 * DAY);
    purgeHistory(ws, () => NOW);
    assert.equal(count(ws, 'surface_snapshot'), 1);
    assert.equal(count(ws, 'surface_observation'), 1);
  } finally {
    ws.close();
  }
});

test('age: the threshold is the workspace setting', () => {
  const { ws, serverId } = setup();
  try {
    seedCall(ws, { serverId }, NOW - 10 * DAY);
    assert.equal(purgeHistory(ws, () => NOW).callsDeleted, 0);
    updateSettings(ws, { retentionMaxAgeDays: 7 });
    assert.equal(purgeHistory(ws, () => NOW).callsDeleted, 1);
  } finally {
    ws.close();
  }
});

// --- size ----------------------------------------------------------------------------

test('size: over the cap, the oldest whole calls go first until live bytes fit', () => {
  const { ws, serverId } = setup();
  try {
    const calls = [];
    for (let i = 0; i < 120; i++) calls.push(seedCall(ws, { serverId }, NOW - (120 - i) * 60_000, { bytes: 2000 }));
    const before = liveBytes(ws.db);
    const cap = Math.floor(before / 2);
    updateSettings(ws, { retentionMaxBytes: cap });
    const result = purgeHistory(ws, () => NOW);
    assert.ok(liveBytes(ws.db) <= cap, `still ${liveBytes(ws.db)} live bytes over a ${cap} cap`);
    assert.ok(result.usedBytesAfter >= liveBytes(ws.db), 'used bytes must bound live bytes from above');
    assert.ok(result.callsDeleted > 0 && result.callsDeleted < 120);
    const kept = ws.db.prepare('SELECT id FROM call ORDER BY id').all().map((r) => r.id);
    assert.deepEqual(kept, calls.slice(calls.length - kept.length), 'kept calls must be the newest ones');
    const orphans = ws.db.prepare('SELECT count(*) AS n FROM frame WHERE call_id IS NOT NULL AND call_id NOT IN (SELECT id FROM call)').get().n;
    assert.equal(orphans, 0);
  } finally {
    ws.close();
  }
});

test('size: under the cap nothing is deleted', () => {
  const { ws, serverId } = setup();
  try {
    for (let i = 0; i < 5; i++) seedCall(ws, { serverId }, NOW - i * 1000);
    const result = purgeHistory(ws, () => NOW);
    assert.deepEqual([result.callsDeleted, result.framesDeleted, result.overCapWithNothingToPurge], [0, 0, false]);
  } finally {
    ws.close();
  }
});

test('size: when only snapshots remain over the cap, the purge stops and says so', () => {
  const { ws, serverId } = setup();
  try {
    for (let i = 0; i < 40; i++) seedSnapshot(ws, serverId, NOW - i, 4000);
    seedCall(ws, { serverId }, NOW - 1000);
    updateSettings(ws, { retentionMaxBytes: 10_000 });
    const result = purgeHistory(ws, () => NOW);
    assert.equal(result.overCapWithNothingToPurge, true);
    assert.equal(count(ws, 'call'), 0);
    assert.equal(count(ws, 'surface_snapshot'), 40);
  } finally {
    ws.close();
  }
});

// --- triggers --------------------------------------------------------------------------

test('triggers: opening a workspace purges, and reports what it purged', () => {
  const { ws, req, serverId } = setup();
  seedCall(ws, { serverId }, NOW - 200 * DAY);
  ws.close();
  const reopened = openWorkspaceDb({ ...req, now: () => NOW });
  try {
    assert.equal(reopened.purgedOnOpen.callsDeleted, 1);
    assert.equal(count(reopened, 'call'), 0);
  } finally {
    reopened.close();
  }
});

test('triggers: finishing a call purges, and returns what it purged', () => {
  const { ws, serverId } = setup();
  try {
    seedCall(ws, { serverId }, NOW - 200 * DAY);
    const rec = HistoryRecorder.open(ws, serverId, () => NOW);
    const call = rec.beginCall('tool', 'echo');
    rec.finishRound(call, rec.beginRound(call, {}), { result: {} });
    const result = rec.finishCall(call, 'completed');
    assert.equal(result.callsDeleted, 1);
    assert.deepEqual(ws.db.prepare('SELECT id FROM call').all().map((r) => r.id), [call]);
  } finally {
    ws.close();
  }
});

test('triggers: creating a workspace reports no purge', () => {
  const { ws } = setup();
  try {
    assert.equal(ws.purgedOnOpen, null);
  } finally {
    ws.close();
  }
});

// --- settings and compaction ------------------------------------------------------------

test('settings: defaults are 500 MB, 90 days and results kept, and changes persist', () => {
  const { ws, req } = setup();
  assert.deepEqual(readSettings(ws), { persistResults: true, retentionMaxBytes: 524_288_000, retentionMaxAgeDays: 90 });
  updateSettings(ws, { persistResults: false, retentionMaxBytes: 1_000_000 });
  ws.close();
  const reopened = openWorkspaceDb({ ...req, now: () => NOW });
  try {
    assert.deepEqual(readSettings(reopened), { persistResults: false, retentionMaxBytes: 1_000_000, retentionMaxAgeDays: 90 });
  } finally {
    reopened.close();
  }
});

test('settings: non-positive or fractional limits are refused and nothing changes', () => {
  const { ws } = setup();
  try {
    for (const bad of [{ retentionMaxBytes: 0 }, { retentionMaxBytes: -5 }, { retentionMaxAgeDays: 1.5 }, { retentionMaxAgeDays: Number.NaN }]) {
      assert.throws(() => updateSettings(ws, bad), InvalidSettingsError, JSON.stringify(bad));
    }
    assert.deepEqual(readSettings(ws), { persistResults: true, retentionMaxBytes: 524_288_000, retentionMaxAgeDays: 90 });
  } finally {
    ws.close();
  }
});

test('compact: the file shrinks only when asked, after a purge freed pages', () => {
  const { ws, serverId } = setup();
  try {
    for (let i = 0; i < 80; i++) seedCall(ws, { serverId }, NOW - 200 * DAY, { bytes: 3000 });
    const pages = () => ws.db.pragma('page_count', { simple: true });
    const full = pages();
    purgeHistory(ws, () => NOW);
    assert.equal(pages(), full, 'a purge must not shrink the file by itself');
    const { before, after } = compact(ws);
    assert.ok(after < before, `compact did not shrink the file: ${before} -> ${after}`);
  } finally {
    ws.close();
  }
});

test('size: a purge under the cap never scans the whole database', () => {
  // Review finding: purgeHistory ran a full dbstat scan before, at every loop
  // check and after -- on every finished call. A scan of a 230 MB encrypted
  // workspace was measured at 98 ms. Pages in use times page size bounds live
  // bytes from above in constant time, so an under-cap purge needs no scan.
  const { ws, serverId } = setup();
  try {
    for (let i = 0; i < 5; i++) seedCall(ws, { serverId }, NOW - i * 1000);
    const prepare = ws.db.prepare.bind(ws.db);
    let scans = 0;
    ws.db.prepare = (sql) => { if (/dbstat/i.test(sql)) scans++; return prepare(sql); };
    try {
      purgeHistory(ws, () => NOW);
    } finally {
      ws.db.prepare = prepare;
    }
    assert.equal(scans, 0);
  } finally {
    ws.close();
  }
});

test('age: a connection goes once it is past the threshold and nothing refers to it', () => {
  // Review finding: calls and frames were purged, connection rows never were,
  // one per connect, forever.
  const { ws, serverId } = setup();
  try {
    const emptied = HistoryRecorder.open(ws, serverId, () => NOW - 100 * DAY);
    emptied.frame('out', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const stillUsed = HistoryRecorder.open(ws, serverId, () => NOW - 100 * DAY);
    const recentFrameClock = () => NOW - DAY;
    HistoryRecorder.open(ws, serverId, recentFrameClock);
    ws.db.prepare("INSERT INTO frame (connection_id, direction, at, method, message_json) VALUES (?, 'out', ?, 'ping', '{}')").run(stillUsed.connectionId, NOW - DAY);
    const withCall = HistoryRecorder.open(ws, serverId, () => NOW - 100 * DAY);
    ws.db.prepare("INSERT INTO call (server_id, connection_id, kind, target, status, started_at, finished_at) VALUES (?, ?, 'tool', 'echo', 'completed', ?, ?)")
      .run(serverId, withCall.connectionId, NOW - DAY, NOW - DAY);
    seedSnapshot(ws, serverId, NOW - 100 * DAY);
    ws.db.prepare('UPDATE surface_observation SET connection_id = ?').run(emptied.connectionId);
    const recent = HistoryRecorder.open(ws, serverId, () => NOW - DAY);

    purgeHistory(ws, () => NOW);
    const left = ws.db.prepare('SELECT id FROM connection ORDER BY id').all().map((r) => r.id);
    assert.ok(!left.includes(emptied.connectionId), 'an old connection with nothing left was kept');
    assert.ok(left.includes(stillUsed.connectionId), 'an old connection with a recent frame was purged');
    assert.ok(left.includes(recent.connectionId), 'a recent connection was purged');
    assert.ok(left.includes(withCall.connectionId), 'an old connection with a recent call was purged');
    assert.equal(count(ws, 'surface_observation'), 1, 'the observation must survive its connection');
    assert.equal(ws.db.prepare('SELECT connection_id FROM surface_observation').get().connection_id, null);
  } finally {
    ws.close();
  }
});
