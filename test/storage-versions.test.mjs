// The version history (plan phase 09, decisions 1, 2 and 7): runs of
// captures, what each entry is, and the unstable flag.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { connectStdio, captureSurface } from '../packages/protocol/dist/index.js';
import { createWorkspaceDb, saveServer, recordCapture, versionTimeline, UNSTABLE_RUN } from '../packages/storage/dist/index.js';
import { memoryStore } from './support/memory-store.mjs';

const root = mkdtempSync(join(tmpdir(), 'mcpx-versions-'));
after(() => rmSync(root, { recursive: true, force: true }));
const fixtures = fileURLToPath(new URL('../scripts/fixture/', import.meta.url));

function setup() {
  const ws = createWorkspaceDb({ path: join(root, `${randomUUID()}.db`), workspaceId: randomUUID(), name: 'versions', custody: { kind: 'keychain' }, secrets: memoryStore() });
  const serverId = randomUUID();
  saveServer(ws, { id: serverId, name: 'fixture', transport: 'stdio', command: process.execPath, args: ['x'] });
  let t = 1_000_000;
  const record = (surface, step = 1000) => { t += step; return recordCapture(ws, serverId, surface, { now: () => t }); };
  return { ws, serverId, record, timeline: () => versionTimeline(ws, serverId) };
}

const surface = (o = {}) => ({
  revision: '2025-11-25', era: 'legacy', serverName: 'syn', serverVersion: '1.0.0', instructions: 'Use it.',
  capabilities: { tools: {} },
  tools: [{ name: 'echo', description: 'Echoes.', inputSchema: { type: 'object' } }],
  prompts: [], resources: [], resourceTemplates: [], unavailable: [], problems: [],
  ...o,
});
const A = surface();
const B = surface({ tools: [{ name: 'echo', description: 'Echoes, louder.', inputSchema: { type: 'object' } }] });
const C = surface({ tools: [] });
const shape = (tl) => tl.entries.map((e) => [e.kind, e.version, e.underVersion, e.changes, e.observations, e.sameAs]);

test('no captures, no entries', () => {
  const { ws, timeline } = setup();
  try { assert.deepEqual(timeline(), { entries: [] }); } finally { ws.close(); }
});

test('repeated captures of one surface are one entry with a count', () => {
  const { ws, record, timeline } = setup();
  try {
    record(A); record(A); record(A);
    const tl = timeline();
    assert.deepEqual(shape(tl), [['first', 1, 1, 0, 3, undefined]]);
    assert.equal(tl.entries[0].firstObservedAt, 1_001_000);
    assert.equal(tl.entries[0].lastObservedAt, 1_003_000);
  } finally { ws.close(); }
});

test('a surface change is a new version; a version bump alone is an identity entry under the old one', () => {
  const { ws, record, timeline } = setup();
  try {
    record(A); record(A);
    record(surface({ serverVersion: '1.0.1' }));
    record(surface({ serverVersion: '1.0.1', tools: B.tools }));
    record(surface({ serverVersion: '1.0.1', tools: B.tools }));
    assert.deepEqual(shape(timeline()), [
      ['first', 1, 1, 0, 2, undefined],
      ['identity', null, 1, 0, 1, undefined],
      ['surface', 2, 2, 1, 2, undefined],
    ]);
    assert.deepEqual(timeline().entries.map((e) => e.serverVersion), ['1.0.0', '1.0.1', '1.0.1']);
  } finally { ws.close(); }
});

test('a revision change with the surface identical is its own kind, and a version', () => {
  const { ws, record, timeline } = setup();
  try {
    record(A); record(A);
    record(surface({ revision: '2026-07-28', era: 'modern' })); record(surface({ revision: '2026-07-28', era: 'modern' }));
    assert.deepEqual(shape(timeline()), [['first', 1, 1, 0, 2, undefined], ['revision', 2, 2, 0, 2, undefined]]);
    record(surface({ revision: '2025-06-18', tools: [] }));
    assert.equal(timeline().entries[2].kind, 'surface', 'surface and revision together: surface, with the revision on the row');
    assert.equal(timeline().entries[2].revision, '2025-06-18');
  } finally { ws.close(); }
});

test('a surface that changes back is a third entry, marked the same as the first', () => {
  const { ws, record, timeline } = setup();
  try {
    record(A); record(A); record(B); record(B); record(A); record(A);
    assert.deepEqual(shape(timeline()), [
      ['first', 1, 1, 0, 2, undefined],
      ['surface', 2, 2, 1, 2, undefined],
      ['surface', 3, 3, 1, 2, 0],
    ]);
  } finally { ws.close(); }
});

test(`the unstable flag needs the newest ${UNSTABLE_RUN} entries each captured once`, () => {
  const { ws, record, timeline } = setup();
  try {
    record(A); record(A); record(B); record(C);
    assert.equal(timeline().unstable, undefined, 'two single-capture entries: not yet');
    record(surface({ serverVersion: '9' }));
    assert.deepEqual(timeline().unstable, { entries: 3, since: 1_003_000, until: 1_005_000 });
    record(surface({ serverVersion: '9' }));
    assert.equal(timeline().unstable, undefined, 'a surface that held for two captures is stable again');
  } finally { ws.close(); }
});

test('captures at the same instant keep the order they were recorded in', () => {
  const { ws, record, timeline } = setup();
  try {
    const a = record(A); record(A, 0); const b = record(B, 0);
    assert.deepEqual(timeline().entries.map((e) => [e.snapshotId, e.observations]), [[a.snapshotId, 2], [b.snapshotId, 1]]);
  } finally { ws.close(); }
});

async function captureFixture(file, env) {
  const conn = await connectStdio({ command: process.execPath, args: [join(fixtures, file)], env: { ...process.env, ...env } });
  try { return await captureSurface(conn.source); } finally { await conn.close(); }
}

test('acceptance, on the fixture: a changed description is version 2 with one change; a version bump is identity', async () => {
  const { ws, record, timeline } = setup();
  try {
    record(await captureFixture('modern-server.mjs', {}));
    record(await captureFixture('modern-server.mjs', {}));
    record(await captureFixture('modern-server.mjs', { ECHO_DESCRIPTION: 'Echoes, revised.' }));
    record(await captureFixture('modern-server.mjs', { ECHO_DESCRIPTION: 'Echoes, revised.', SERVER_VERSION: '2.0.0' }));
    assert.deepEqual(shape(timeline()), [
      ['first', 1, 1, 0, 2, undefined],
      ['surface', 2, 2, 1, 1, undefined],
      ['identity', null, 2, 0, 1, undefined],
    ], 'the shuffling fixture captured twice is still one entry');
  } finally { ws.close(); }
});
