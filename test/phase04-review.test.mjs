// Regression tests for the phase 04 code review, one per finding: R04-1 to
// R04-9 from the review, RR-1 to RR-5 from the re-review of those fixes,
// RS-1 to RS-4 pin the registry restructure. Each was watched failing
// before its fix, or, where the test was rewritten
// after it, with the fix removed.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loggingFetch } from '../packages/protocol/dist/index.js';
import { createWorkspaceDb, saveServer, pinEra, HistoryRecorder, updateSettings, liveBytes, purgeHistory } from '../packages/storage/dist/index.js';
import { isAlive, killServerTree } from '../packages/platform/dist/index.js';
import { Backend, ConnectionManager } from '../packages/backend/dist/index.js';
import { matchLabel } from '../app/renderer/src/lib/raw.ts';
import { logRows } from '../app/renderer/src/lib/logrows.ts';
import { memoryStore } from './support/memory-store.mjs';
import { fixtures } from './support/fixture-servers.mjs';

const root = mkdtempSync(join(tmpdir(), 'mcpx-r04-'));
const cleanups = [];
after(async () => {
  for (const c of cleanups.reverse()) await c();
  rmSync(root, { recursive: true, force: true });
});

const noSecrets = { get: () => null, set: () => { throw new Error('unexpected keychain write'); }, delete: () => false };
const modern = join(fixtures, 'modern-server.mjs');
const legacy = join(fixtures, 'legacy-server.mjs');
const win = process.platform === 'win32';

async function waitFor(check, ms = 10_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = check();
    if (v) return v;
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

function workspace() {
  const ws = createWorkspaceDb({ path: join(root, `${randomUUID()}.db`), workspaceId: randomUUID(), name: 'r04', custody: { kind: 'none' }, secrets: noSecrets });
  cleanups.push(() => ws.close());
  return ws;
}

/** A stdio server behind a shell that stays its parent (the npx shape and its POSIX twin). */
function wrapped(script, env) {
  return win
    ? { command: join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'), args: ['/d', '/c', process.execPath, script], env }
    : { command: '/bin/sh', args: ['-c', `"${process.execPath}" "${script}"; exit $?`], env };
}

const spawnLog = () => { const p = join(root, `${randomUUID()}.spawns`); writeFileSync(p, ''); return p; };
const pidsIn = (log) => readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => Number(/pid=(\d+)/.exec(l)[1]));

test('R04-1: a failed switch to another workspace leaves the open one working, sessions included', async () => {
  const backend = new Backend({ dataDir: mkdtempSync(join(root, 'data-')), secrets: memoryStore(), closeGraceMs: 300 });
  cleanups.push(() => backend.shutdown());
  const call = (m, p = {}) => backend.request(m, p);
  const locked = await call('workspaces.create', { name: 'Locked', protection: { kind: 'passphrase', passphrase: 'right' } });
  await call('workspaces.create', { name: 'Open', protection: { kind: 'none' } });
  const s = await call('servers.save', { server: { name: 'm', transport: 'stdio', command: process.execPath, args: [modern] } });
  const up = await call('connections.connect', { serverId: s.id });
  await assert.rejects(call('workspaces.open', { id: locked.id, unlock: { kind: 'passphrase', passphrase: 'wrong' } }), { name: 'WrongKeyError' });
  await assert.rejects(call('workspaces.create', { name: 'Bad', protection: { kind: 'passphrase', passphrase: 'raw:x' } }), { name: 'InvalidWorkspaceRequestError' });
  const [row] = await call('servers.list');
  assert.equal(row.state.status, 'connected', 'the session was ended by a switch that never happened');
  assert.ok(isAlive(up.pid));
  assert.equal((await call('workspaces.current')).name, 'Open');
});

test('R04-2: a failed connect of a shell-wrapped server leaves no process of its tree running', async () => {
  const spawns = spawnLog();
  const ws = workspace();
  const s = { id: randomUUID(), name: 'w', transport: 'stdio', ...wrapped(modern, { STUBBORN: '1', INITIALIZE_UNSUPPORTED: '1', SPAWN_LOG: spawns }) };
  saveServer(ws, s);
  pinEra(ws, s.id, 'legacy', '2025-06-18');
  const manager = new ConnectionManager(ws, { events: {} });
  const failed = await manager.connect(s.id);
  assert.equal(failed.failure.kind, 'unsupported-version');
  const [server] = pidsIn(spawns);
  await waitFor(() => !isAlive(server), 8000).catch(() => { process.kill(server, 'SIGKILL'); assert.fail(`the node server ${server} outlived its failed connect`); });
});

test('R04-3: the find status line survives a match list that shrank under the current match', () => {
  assert.equal(matchLabel('x', { offsets: [4, 9], truncated: false }, 29), '2 of 2 at byte 9');
  assert.equal(matchLabel('x', { offsets: [4, 9], truncated: false }, 0), '1 of 2 at byte 4', 'old valid input');
});

test('R04-4: a live root is killed even when the process list cannot be read', { skip: !win && 'the process query runs on Windows only' }, async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)'], { stdio: 'ignore' });
  const startedAt = Date.now();
  cleanups.push(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } });
  const warnings = [];
  const onWarning = (w) => warnings.push(w.message);
  process.on('warning', onWarning);
  try {
    await killServerTree({ pid: child.pid, startedAt }, { listProcesses: () => Promise.reject(new Error('powershell is not available')) });
  } catch (e) {
    assert.fail(`killServerTree rejected (${e.message}) and left the live root ${child.pid} running`);
  } finally {
    await new Promise((r) => setImmediate(r));
    process.off('warning', onWarning);
  }
  await waitFor(() => !isAlive(child.pid));
  assert.ok(warnings.some((m) => m.includes('powershell is not available')), 'the fallback must say what it recovered from');
});

test('R04-5: a page of a large log reads only that page\'s bytes', () => {
  const ws = workspace();
  const s = { id: randomUUID(), name: 'big', transport: 'stdio', command: 'x' };
  saveServer(ws, s);
  const rec = HistoryRecorder.open(ws, s.id);
  const chunk = Buffer.alloc(256 * 1024, 0x61);
  for (let i = 0; i < 200; i++) rec.unit({ direction: 'in', kind: 'stderr', bytes: chunk });
  const backend = new Backend({ dataDir: root, secrets: noSecrets });
  // The query the log page runs, driven directly: logPage is not exported, so
  // measure through the request against a workspace the backend holds.
  backend['workspaces'].current = { id: 'x', name: 'x', custody: 'none', encrypted: false, ws };
  const started = performance.now();
  const page = backend['handlers']['log.units']({ serverId: s.id, limit: 5 });
  const elapsed = performance.now() - started;
  assert.equal(page.length, 5);
  // Measured 2026-09-25: the defective query took 66 to 80 ms here, because
  // it read columns stored after each row's BLOB and so walked every overflow
  // chain; the fixed one takes about 3 ms. The bound sits between them.
  assert.ok(elapsed < 20, `a 5-row page of a 50 MB log took ${elapsed.toFixed(0)} ms`);
});

test('R04-6: purging a cap\'s worth of small units does not rescan the database per 25 rows', () => {
  const ws = workspace();
  const s = { id: randomUUID(), name: 'chatty', transport: 'stdio', command: 'x' };
  saveServer(ws, s);
  let t = Date.now() - 60_000;
  const rec = HistoryRecorder.open(ws, s.id, () => t++);
  const line = Buffer.alloc(1024, 0x62);
  ws.db.transaction(() => { for (let i = 0; i < 3000; i++) rec.unit({ direction: 'in', kind: 'stderr', bytes: line }); })();
  const cap = Math.floor(liveBytes(ws.db) / 3);
  updateSettings(ws, { retentionMaxBytes: cap });
  let scans = 0;
  const prepare = ws.db.prepare.bind(ws.db);
  ws.db.prepare = (sql) => { if (/\bdbstat\b/.test(sql)) scans++; return prepare(sql); };
  const result = purgeHistory(ws, () => Date.now());
  ws.db.prepare = prepare;
  assert.ok(liveBytes(ws.db) <= cap, `still over the ${cap}-byte cap`);
  assert.ok(result.unitsDeleted > 1500, `only ${result.unitsDeleted} deleted`);
  // Measured on the defective loop: 80 scans for about 2,000 units. Sizing each
  // batch by the bytes still to free needs a handful.
  assert.ok(scans <= 8, `${scans} full dbstat scans`);
  assert.equal(result.overCapWithNothingToPurge, false);
});

test('R04-7: a request body the log cannot record does not cost the request', async () => {
  const units = [];
  let sent = false;
  const base = async () => { sent = true; return new Response('{}', { headers: { 'content-type': 'application/json' } }); };
  const f = loggingFetch((u) => units.push(u), [], base);
  const body = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"a":1}')); c.close(); } });
  const res = await f('http://127.0.0.1:1/mcp', { method: 'POST', body, duplex: 'half' });
  assert.equal(res.status, 200);
  assert.ok(sent, 'the request never reached the server');
  const note = units.find((u) => u.kind === 'app');
  assert.match(Buffer.from(note.bytes).toString(), /"event":"request-body-not-recorded"/);
  // Old valid input: a string body is still recorded as its bytes.
  await f('http://127.0.0.1:1/mcp', { method: 'POST', body: '{"b":2}' });
  assert.equal(Buffer.from(units.filter((u) => u.direction === 'out').at(-1).bytes).toString(), '{"b":2}');
});

test('R04-8: a server process is reported from its spawn, so one that never connects is known too', async () => {
  const ws = workspace();
  const s = { id: randomUUID(), name: 'dies', transport: 'stdio', command: process.execPath, args: [legacy], env: { HOSTILE_PREINIT: '1' } };
  saveServer(ws, s);
  const timeline = [];
  const manager = new ConnectionManager(ws, {
    probeTimeoutMs: 800,
    events: { state: (_id, st) => timeline.push(st.status), processes: (roots) => timeline.push(roots.length ? 'reported' : 'none') },
  });
  const failed = await manager.connect(s.id);
  assert.equal(failed.status, 'failed');
  // A backend that died during this connect would have left the main process
  // nothing to kill: the process must be reported while it lives, and cleared once it ends.
  assert.deepEqual(timeline.filter((e) => e === 'reported' || e === 'none'), ['reported', 'none'], `timeline: ${timeline.join(', ')}`);
  assert.ok(timeline.indexOf('reported') < timeline.indexOf('failed'));
});

test('R04-9: a reply is timed against the request of its own connection', () => {
  const unit = (connectionId, direction, at) => ({ id: at, serverId: 's', connectionId, direction, kind: 'wire', at, byteLength: 0, bytes: new Uint8Array(0), frames: [{ jsonrpcId: '3', method: 'tools/call', resultWithheld: false }] });
  // Connection 1's request was never answered; connection 2's reply has its
  // request on an earlier page. The two share an id and a method only.
  const rows = logRows([unit(1, 'out', 0), unit(2, 'in', 1050)]);
  assert.equal(rows[1].elapsedMs, undefined);
  assert.equal(logRows([unit(1, 'out', 0), unit(1, 'in', 30)])[1].elapsedMs, 30, 'old valid input');
});

// --- round 3: the re-review of the fix chain (RR-1 to RR-6) ---------------------------------

test('RR-1: a size purge still goes oldest first: a finished call older than a unit goes before it', () => {
  const ws = workspace();
  const s = { id: randomUUID(), name: 'mixed', transport: 'stdio', command: 'x' };
  saveServer(ws, s);
  const base = Date.now() - 60_000;
  let t = base;
  const rec = HistoryRecorder.open(ws, s.id, () => t);
  const kb = Buffer.alloc(1024, 0x63);
  rec.unit({ direction: 'in', kind: 'stderr', bytes: kb });            // oldest: a loose unit at base
  t = base + 10;
  // then a finished call big enough (1.5 MB of arguments) that deleting it
  // alone clears the excess below
  const call = rec.beginCall('tool', 'echo');
  rec.beginRound(call, { text: 'y'.repeat(1_500_000) });
  rec.finishCall(call, 'abandoned');
  t = base + 20;
  ws.db.transaction(() => { for (let i = 0; i < 2000; i++) rec.unit({ direction: 'in', kind: 'stderr', bytes: kb }); })();
  updateSettings(ws, { retentionMaxBytes: liveBytes(ws.db) - 1_200_000 });
  purgeHistory(ws, () => Date.now());
  assert.equal(ws.db.prepare('SELECT count(*) AS n FROM call WHERE id = ?').get(call).n, 0, 'the older call was kept');
  // Oldest first: the unit at base, then the call, and the excess is gone.
  // Every unit newer than the call must survive.
  assert.equal(ws.db.prepare('SELECT count(*) AS n FROM wire_unit WHERE at >= ?').get(base + 20).n, 2000, 'units newer than the call were purged before it');
});

test('RR-3: a session that fails to close does not stop the rest from closing, and says so', async () => {
  const ws = workspace();
  const manager = new ConnectionManager(ws, { events: {} });
  let closedOther = false;
  manager['slots'].set('bad', { state: { status: 'connected', connectionId: 1 }, conn: { close: () => Promise.reject(new Error('close failed')) } });
  manager['slots'].set('good', { state: { status: 'connected', connectionId: 2 }, conn: { close: async () => { closedOther = true; } } });
  const warnings = [];
  const onWarning = (w) => warnings.push(w.message);
  process.on('warning', onWarning);
  try {
    await manager.closeAll();
  } catch (e) {
    assert.fail(`closeAll rejected (${e.message}): a switch that ends sessions first would fail with it`);
  } finally {
    await new Promise((r) => setImmediate(r));
    process.off('warning', onWarning);
  }
  assert.ok(closedOther);
  assert.ok(warnings.some((m) => m.includes('close failed')), 'a session that did not close must be reported');
});

test('RR-5: a failed connect whose launcher root exited leaves nothing it started running', { skip: !win && 'a dead root is searched for its children on Windows only (D36)' }, async () => {
  const spawns = spawnLog();
  const ws = workspace();
  // The launcher starts the server detached and exits at once: the root is
  // gone before the handshake, and what it started is not.
  const s = { id: randomUUID(), name: 'detached', transport: 'stdio', command: process.execPath, args: [join(fixtures, 'detach.mjs')], env: { STUBBORN: '1', SPAWN_LOG: spawns } };
  saveServer(ws, s);
  const manager = new ConnectionManager(ws, { probeTimeoutMs: 800, events: {} });
  const failed = await manager.connect(s.id);
  assert.equal(failed.status, 'failed', JSON.stringify(failed));
  const [server] = await waitFor(() => { const p = pidsIn(spawns); return p.length ? p : null; });
  await waitFor(() => !isAlive(server), 8000).catch(() => { process.kill(server, 'SIGKILL'); assert.fail(`the server ${server} started by the exited launcher outlived the failed connect`); });
});

// --- round 4: one owner for server process roots (RS-1 to RS-4) ------------------------------

test('RS-1: a server tree that could not be killed is reported as a failure, not resolved', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)'], { stdio: 'ignore' });
  cleanups.push(() => { try { process.kill(child.pid, 'SIGKILL'); } catch { /* gone */ } });
  await assert.rejects(
    killServerTree({ pid: child.pid, startedAt: Date.now() }, { kill: () => Promise.reject(new Error('access denied')), listProcesses: async () => [] }),
    (e) => { assert.match(e.message, new RegExp(`${child.pid}.*access denied`)); return true; },
  );
  assert.ok(isAlive(child.pid), 'the injected kill did nothing; the process is still there to be reported');
});

test('RS-1b: an orphan that could not be killed makes the dead-root search fail too', { skip: !win && 'the dead-root search runs on Windows only' }, async () => {
  const startedAt = Date.now();
  const orphans = [{ pid: 999_991, ppid: 999_990, created: startedAt + 10 }];
  await assert.rejects(
    killServerTree({ pid: 999_990, startedAt }, { listProcesses: async () => orphans, kill: () => Promise.reject(new Error('access denied')) }),
    /999991.*access denied/,
  );
});

test('RS-2: a root whose tree could not be ended stays reported, survives the next connect, and is retried by closeAll', async () => {
  const ws = workspace();
  const s = { id: randomUUID(), name: 'm', transport: 'stdio', command: process.execPath, args: [modern] };
  saveServer(ws, s);
  const reports = [];
  // Every end fails until the switch is thrown; a disconnect tries twice.
  let failing = true;
  const manager = new ConnectionManager(ws, {
    closeGraceMs: 200,
    events: { processes: (roots) => reports.push(roots.map((r) => r.pid)) },
    killTree: async (root) => { if (failing) throw new Error('taskkill failed'); await killServerTree(root); },
  });
  const warnings = [];
  const onWarning = (w) => warnings.push(w.message);
  process.on('warning', onWarning);
  try {
    const first = await manager.connect(s.id);
    await manager.disconnect(s.id);
    assert.deepEqual(reports.at(-1), [first.pid], 'a root whose end failed left the report');
    const second = await manager.connect(s.id);
    assert.deepEqual([...reports.at(-1)].sort(), [first.pid, second.pid].sort(), 'the next connect dropped the survivor');
    failing = false;
    await manager.closeAll();
    assert.deepEqual(reports.at(-1), [], 'closeAll left roots unended');
  } finally {
    await new Promise((r) => setImmediate(r));
    process.off('warning', onWarning);
  }
  assert.ok(warnings.some((m) => m.includes('taskkill failed')));
});

test('RS-3: a session whose close throws is still ended, its tree killed, and the failure reported', async () => {
  const spawns = spawnLog();
  const ws = workspace();
  const s = { id: randomUUID(), name: 'w', transport: 'stdio', ...wrapped(modern, { STUBBORN: '1', SPAWN_LOG: spawns }) };
  saveServer(ws, s);
  const reports = [];
  const manager = new ConnectionManager(ws, { closeGraceMs: 200, events: { processes: (r) => reports.push(r.length) } });
  const up = await manager.connect(s.id);
  const conn = manager['slots'].get(s.id).conn;
  const close = conn.close;
  conn.close = async () => { await close(); throw new Error('close failed'); };
  const warnings = [];
  const onWarning = (w) => warnings.push(w.message);
  process.on('warning', onWarning);
  try {
    const ended = await manager.disconnect(s.id).catch((e) => assert.fail(`disconnect rejected: ${e.message}`));
    assert.equal(ended.status, 'ended');
  } finally {
    await new Promise((r) => setImmediate(r));
    process.off('warning', onWarning);
  }
  const [server] = pidsIn(spawns);
  await waitFor(() => !isAlive(up.pid) && !isAlive(server), 8000);
  assert.equal(reports.at(-1), 0);
  assert.ok(warnings.some((m) => m.includes('close failed')));
});

test('RS-4: a size purge takes calls oldest first too: calls newer than a unit wait for it', () => {
  const ws = workspace();
  const s = { id: randomUUID(), name: 'calls', transport: 'stdio', command: 'x' };
  saveServer(ws, s);
  const base = Date.now() - 60_000;
  let t = base;
  const rec = HistoryRecorder.open(ws, s.id, () => t);
  const finished = (arg) => { const c = rec.beginCall('tool', 'echo'); rec.beginRound(c, { text: arg }); rec.finishCall(c, 'abandoned'); return c; };
  const oldest = finished('');                                               // a small call at base
  t = base + 10;
  rec.unit({ direction: 'in', kind: 'stderr', bytes: Buffer.alloc(1_500_000, 0x64) }); // then a 1.5 MB unit
  t = base + 20;
  for (let i = 0; i < 30; i++) finished('z'.repeat(1000));                   // then 30 newer calls
  updateSettings(ws, { retentionMaxBytes: liveBytes(ws.db) - 1_200_000 });
  purgeHistory(ws, () => Date.now());
  assert.equal(ws.db.prepare('SELECT count(*) AS n FROM call WHERE id = ?').get(oldest).n, 0);
  assert.equal(ws.db.prepare('SELECT count(*) AS n FROM wire_unit').get().n, 0, 'the unit older than the newer calls was kept');
  assert.equal(ws.db.prepare('SELECT count(*) AS n FROM call WHERE started_at >= ?').get(base + 20).n, 30, 'calls newer than the unit went before it');
});

test('RS-5: an end still running for an old root does not end, or forget, a new root that got its PID', async () => {
  const ws = workspace();
  const slow = new Map();
  const ended = [];
  const manager = new ConnectionManager(ws, {
    events: {},
    killTree: (root) => { ended.push(root); return slow.has(root) ? new Promise((r) => slow.set(root, r)) : Promise.resolve(); },
  });
  const a = { pid: 4242, startedAt: 1 };
  const b = { pid: 4242, startedAt: 2 };
  // A's end is slow (a PowerShell listing); meanwhile B spawns with A's PID.
  slow.set(a, null);
  manager['owned'].add(a);
  const endingA = manager['endTree'](a);
  manager['owned'].add(b);
  const outcome = await Promise.race([manager['endTree'](b).then(() => 'ended'), new Promise((r) => setTimeout(() => r('stuck behind A'), 500))]);
  assert.equal(outcome, 'ended');
  assert.ok(ended.includes(b), 'B was never ended itself');
  // A finishing must not remove whatever holds its PID now.
  const c = { pid: 4242, startedAt: 3 };
  manager['owned'].add(c);
  slow.get(a)();
  await endingA;
  assert.ok(manager['owned'].has(c), 'A finishing removed the root that now holds its PID');
});
