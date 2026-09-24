// The connection manager (plan phase 04): honest states, the era pinned and
// used, no second spawn without the user (D20), session-only secrets (D31),
// and a closed server gone as a tree (D36).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createWorkspaceDb, saveServer, readDetectedEra, pinEra } from '../packages/storage/dist/index.js';
import { isAlive } from '../packages/platform/dist/index.js';
import { ConnectionManager } from '../packages/backend/dist/index.js';
import { fixtures, listen } from './support/fixture-servers.mjs';

const root = mkdtempSync(join(tmpdir(), 'mcpx-conn-'));
const children = [];
const managers = [];
const workspaces = [];
after(async () => {
  for (const m of managers) await m.closeAll();
  for (const w of workspaces) w.close();
  for (const c of children) c.kill();
  rmSync(root, { recursive: true, force: true });
});

const noSecrets = { get: () => null, set: () => { throw new Error('unexpected keychain write'); }, delete: () => false };
const modern = join(fixtures, 'modern-server.mjs');
const legacy = join(fixtures, 'legacy-server.mjs');

function setup(servers) {
  const path = join(root, `${randomUUID()}.db`);
  const ws = createWorkspaceDb({ path, workspaceId: randomUUID(), name: 'connections', custody: { kind: 'none' }, secrets: noSecrets });
  workspaces.push(ws);
  for (const s of servers) saveServer(ws, s);
  const log = { states: [], units: [], processes: [] };
  const manager = new ConnectionManager(ws, {
    probeTimeoutMs: 1000,
    closeGraceMs: 300,
    events: {
      state: (id, s) => log.states.push([id, s]),
      unit: (id, connectionId, unitId, u) => log.units.push({ id, connectionId, unitId, u }),
      processes: (pids) => log.processes.push(pids),
    },
  });
  managers.push(manager);
  return { ws, path, manager, log };
}

const stdio = (script, env = {}, extra = {}) => ({ id: randomUUID(), name: 'fixture', transport: 'stdio', command: process.execPath, args: [script], env, ...extra });
const spawnLog = () => { const p = join(root, `${randomUUID()}.spawns`); writeFileSync(p, ''); return p; };
const spawns = (p) => readFileSync(p, 'utf8').split('\n').filter(Boolean).length;
const sentMethods = (log, connectionId) => log.units
  .filter((x) => x.connectionId === connectionId && x.u.kind === 'wire' && x.u.direction === 'out')
  .map((x) => JSON.parse(Buffer.from(x.u.bytes).toString('utf8')).method);

async function waitFor(check, ms = 10000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = check();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('a modern server connects through honest states, is recorded, and has its era pinned', async () => {
  const s = stdio(modern);
  const { ws, manager, log } = setup([s]);
  const state = await manager.connect(s.id);
  assert.equal(state.status, 'connected');
  assert.equal(state.era, 'modern');
  assert.deepEqual(log.states.map(([, st]) => st.status + (st.step ? `:${st.step}` : '')), ['connecting:starting', 'connecting:negotiating', 'connected']);
  assert.deepEqual({ ...readDetectedEra(ws, s.id), detectedAt: 0 }, { era: 'modern', revision: '2026-07-28', detectedAt: 0 });
  const stored = ws.db.prepare('SELECT count(*) AS n FROM wire_unit WHERE connection_id = ?').get(state.connectionId).n;
  assert.equal(stored, log.units.length, 'every unit the UI was told about is stored');
  assert.deepEqual(log.processes.at(-1), [state.pid]);
  await manager.disconnect(s.id);
  assert.deepEqual(log.processes.at(-1), []);
});

test('D20: a server that dies on the probe is pinned legacy and waits for the user; starting again spawns it once more', async () => {
  const log1 = spawnLog();
  const s = stdio(legacy, { HOSTILE_PREINIT: '1', SPAWN_LOG: log1 });
  const { ws, manager, log } = setup([s]);
  const failed = await manager.connect(s.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.offer, 'as-legacy');
  assert.equal(failed.failure.kind, 'exited');
  assert.equal(readDetectedEra(ws, s.id).era, 'legacy');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(spawns(log1), 1, 'nothing was started again without the user');

  const up = await manager.startAgain(s.id);
  assert.equal(up.status, 'connected');
  assert.equal(up.era, 'legacy');
  assert.equal(spawns(log1), 2);
  assert.deepEqual(sentMethods(log, up.connectionId).slice(0, 1), ['initialize']);
  await manager.disconnect(s.id);

  // The pin holds: the next connect never probes.
  const again = await manager.connect(s.id);
  assert.equal(again.status, 'connected');
  assert.ok(!sentMethods(log, again.connectionId).includes('server/discover'));
  await manager.disconnect(s.id);
});

test('D20: a server pinned legacy that answers -32022 is offered a re-detect, which pins it modern', async () => {
  const s = stdio(modern, { INITIALIZE_UNSUPPORTED: '1' });
  const { ws, manager } = setup([s]);
  pinEra(ws, s.id, 'legacy', '2025-06-18');
  const failed = await manager.connect(s.id);
  assert.deepEqual([failed.status, failed.offer, failed.failure.kind], ['failed', 'redetect', 'unsupported-version']);
  assert.equal(readDetectedEra(ws, s.id).era, 'legacy', 'the pin is not changed until the user decides');
  const up = await manager.startAgain(s.id);
  assert.equal(up.era, 'modern');
  assert.equal(readDetectedEra(ws, s.id).era, 'modern');
  await manager.disconnect(s.id);
});

test('a failure with nothing a second spawn could fix offers nothing', async () => {
  const s = stdio(join(fixtures, 'no-such-server.mjs'));
  const { ws, manager } = setup([s]);
  pinEra(ws, s.id, 'legacy', '2025-06-18');
  const failed = await manager.connect(s.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.offer, undefined);
  assert.match(failed.stderr, /Cannot find module/);
  await assert.rejects(manager.startAgain(s.id), /nothing to start again/);
});

test('re-detect forgets the pin and probes again', async () => {
  const s = stdio(modern);
  const { ws, manager, log } = setup([s]);
  pinEra(ws, s.id, 'legacy', '2025-06-18');
  const up = await manager.redetect(s.id);
  assert.equal(up.era, 'modern');
  assert.equal(sentMethods(log, up.connectionId)[0], 'server/discover');
  await manager.disconnect(s.id);
});

test('D31: an unstored secret is asked for, reaches the server, and never reaches the workspace file', async () => {
  const token = `tok-${randomUUID()}`;
  const s = stdio(modern, { REQUIRE_ENV: 'FIXTURE_TOKEN' }, { unstoredSecrets: { env: ['FIXTURE_TOKEN'] } });
  const { path, manager } = setup([s]);
  assert.deepEqual(await manager.connect(s.id), { status: 'needs-secrets', missing: { env: ['FIXTURE_TOKEN'] } });
  const up = await manager.connect(s.id, { env: { FIXTURE_TOKEN: token } });
  assert.equal(up.status, 'connected', JSON.stringify(up));
  await manager.disconnect(s.id);
  // Given once, kept for the session.
  assert.equal((await manager.connect(s.id)).status, 'connected');
  await manager.disconnect(s.id);
  assert.equal(readFileSync(path).includes(token), false);
});

test('D36: disconnecting a server that ignores stdin EOF and SIGTERM still ends it', async () => {
  const s = stdio(modern, { STUBBORN: '1' });
  const { manager } = setup([s]);
  const up = await manager.connect(s.id);
  const ended = await manager.disconnect(s.id);
  assert.equal(ended.status, 'ended');
  assert.equal(ended.byUser, true);
  await waitFor(() => !isAlive(up.pid));
});

test('a server that crashes mid-session ends in a state that says so', async () => {
  const s = stdio(modern, { EXIT_AFTER_MS: '400' });
  const { manager } = setup([s]);
  await manager.connect(s.id);
  const ended = await waitFor(() => (manager.state(s.id).status === 'ended' ? manager.state(s.id) : null));
  assert.equal(ended.byUser, false);
  assert.equal(ended.exit.code, 3);
});

test('two connects at once start the server once', async () => {
  const log1 = spawnLog();
  const s = stdio(modern, { SPAWN_LOG: log1 });
  const { manager } = setup([s]);
  const [a, b] = await Promise.all([manager.connect(s.id), manager.connect(s.id)]);
  assert.equal(a.connectionId, b.connectionId);
  assert.equal(spawns(log1), 1);
  await manager.disconnect(s.id);
});

test('an HTTP legacy server connects and is pinned legacy, over both transports', async () => {
  const servers = [];
  for (const [file, transport] of [['http-server.mjs', 'streamable-http'], ['sse-server.mjs', 'sse']]) {
    servers.push({ id: randomUUID(), name: transport, transport, url: await listen(file, children, { LEGACY: '1' }) });
  }
  const { ws, manager } = setup(servers);
  for (const s of servers) {
    const up = await manager.connect(s.id);
    assert.equal(up.status, 'connected', `${s.transport}: ${JSON.stringify(up)}`);
    assert.equal(readDetectedEra(ws, s.id).era, 'legacy');
    const ended = await manager.disconnect(s.id);
    assert.equal(ended.status, 'ended');
  }
});

test('D36: disconnecting a server behind a shell ends the shell and the server under it, at the default grace', async () => {
  // Review of the smoke test's quit case: the tree kill fired as the SDK's own
  // close sent its SIGTERM to the root, and when the SDK won, cmd.exe was gone
  // before taskkill /T could find the node under it. Run at the default grace,
  // which is the one the app uses.
  const spawns = spawnLog();
  const env = { STUBBORN: '1', SPAWN_LOG: spawns };
  const s = process.platform === 'win32'
    ? { ...stdio(modern, env), command: join(process.env.SystemRoot ?? 'C:\Windows', 'System32', 'cmd.exe'), args: ['/d', '/c', process.execPath, modern] }
    : { ...stdio(modern, env), command: '/bin/sh', args: ['-c', `"${process.execPath}" "${modern}"; exit $?`] };
  const path = join(root, `${randomUUID()}.db`);
  const ws = createWorkspaceDb({ path, workspaceId: randomUUID(), name: 'tree', custody: { kind: 'none' }, secrets: noSecrets });
  workspaces.push(ws);
  saveServer(ws, s);
  const manager = new ConnectionManager(ws, { probeTimeoutMs: 1000, events: {} });
  managers.push(manager);
  const up = await manager.connect(s.id);
  assert.equal(up.status, 'connected', JSON.stringify(up));
  const server = Number(/pid=(\d+)/.exec(readFileSync(spawns, 'utf8'))[1]);
  assert.notEqual(server, up.pid, 'the root is the shell');
  await manager.disconnect(s.id);
  await waitFor(() => !isAlive(up.pid));
  await waitFor(() => !isAlive(server), 8000);
});
