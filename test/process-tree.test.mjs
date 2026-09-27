// D36: a server is killed as a tree, from the root the app spawned. The
// fixture tree ignores SIGTERM and a closed stdin at every level, so only a
// real tree kill passes.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { killProcessTree, isAlive, findOrphans, killServerTree, processStartToken, serverRoot } from '../packages/platform/dist/index.js';
import { fixtures } from './support/fixture-servers.mjs';

const work = mkdtempSync(join(tmpdir(), 'mcpx-tree-'));
const started = [];
after(() => {
  for (const pid of started) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone, which is the point */ } }
  rmSync(work, { recursive: true, force: true });
});

const tree = join(fixtures, 'tree.mjs');
let n = 0;

async function waitFor(check, what, ms = 10000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = check();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Starts a tree of `depth` node processes under `command`, and resolves to the root and every node PID. */
async function startTree(command, args, depth, spawnOptions = {}) {
  const pidLog = join(work, `${++n}.pids`);
  writeFileSync(pidLog, '');
  const root = spawn(command, args, { env: { ...process.env, PID_LOG: pidLog, DEPTH: String(depth) }, stdio: ['pipe', 'ignore', 'inherit'], windowsHide: true, ...spawnOptions });
  started.push(root.pid);
  const pids = await waitFor(() => {
    const p = readFileSync(pidLog, 'utf8').split('\n').filter(Boolean).map(Number);
    return p.length === depth ? p : null;
  }, `${depth} processes to start`);
  started.push(...pids);
  return { root: root.pid, pids };
}

const posixOnly = { skip: process.platform === 'win32' && 'POSIX only' };

/** A node process that runs until killed. */
const sleeper = () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)'], { stdio: 'ignore' });
  started.push(child.pid);
  return child;
};

// On Windows, libuv puts every process node spawns into a job object that
// ends with the parent, so a node-under-node tree dies from a root-only kill
// too and this test could not tell the difference (measured 2026-09-24: it
// passed with taskkill's /T removed). The cmd.exe test below is the Windows
// one; cmd.exe makes no such job.
test('a tree three deep that ignores SIGTERM and stdin EOF is gone after one kill of its root', { skip: process.platform === 'win32' && 'not discriminating on Windows; see the comment above' }, async () => {
  const { root, pids } = await startTree(process.execPath, [tree], 3);
  await killProcessTree(root, { graceMs: 200 });
  await waitFor(() => ![root, ...pids].some(isAlive), 'every process in the tree to exit');
});

test('a server behind a Windows cmd.exe shim, the npx shape, is killed with its node child', { skip: process.platform !== 'win32' && 'the cmd.exe shim is Windows only' }, async () => {
  const cmd = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe');
  // cmd /s strips the outer quotes, leaving the two quoted paths.
  const { root, pids } = await startTree(cmd, ['/d', '/s', '/c', `""${process.execPath}" "${tree}""`], 2, { windowsVerbatimArguments: true });
  assert.ok(!pids.includes(root), 'the root is cmd.exe, not a node process');
  await killProcessTree(root);
  await waitFor(() => ![root, ...pids].some(isAlive), 'cmd.exe and both node processes to exit');
});

test('a process the OS will not let us signal makes the kill fail, naming it and why', posixOnly, async () => {
  const child = sleeper();
  const refuse = () => { throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' }); };
  await assert.rejects(
    killProcessTree(child.pid, { graceMs: 50, signal: refuse }),
    (e) => { assert.match(e.message, new RegExp(`${child.pid} \\(EPERM\\).*still running after SIGKILL`)); return true; },
  );
  assert.ok(isAlive(child.pid), 'the refused process is still there to be reported');
});

test('killing a process that has already exited resolves', async () => {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((r) => child.on('exit', r));
  await killProcessTree(child.pid);
});

test('a zombie is not alive: it has exited, only its parent has not reaped it', { skip: process.platform !== 'linux' && 'zombie state is read from /proc' }, async () => {
  // The shell forks `sleep 0` and execs into a `sleep 5` that never waits,
  // so the finished `sleep 0` stays a zombie for five seconds. A container
  // whose PID 1 does not reap leaves every orphan like this (pipeline 567).
  const sh = spawn('/bin/sh', ['-c', 'sleep 0 & echo $!; exec sleep 5'], { stdio: ['ignore', 'pipe', 'ignore'] });
  started.push(sh.pid);
  const zombie = Number(await new Promise((r) => sh.stdout.once('data', (d) => r(String(d).trim()))));
  await waitFor(() => readFileSync(`/proc/${zombie}/stat`, 'utf8').split(') ')[1]?.startsWith('Z'), 'the child to become a zombie');
  assert.equal(isAlive(zombie), false);
  assert.equal(isAlive(sh.pid), true, 'old valid input: a running process is alive');
});

test('a PID that cannot be a process is refused rather than signalled', async () => {
  // process.kill(0) and process.kill(-1) signal a whole process group or every
  // process the user owns; neither may ever reach here.
  for (const pid of [0, -1, 1.5, Number.NaN]) await assert.rejects(killProcessTree(pid), RangeError);
});

// --- a root's PID reused on POSIX -----------------------------------------------------------

test('a stranger now holding a root\'s PID is not signalled: its start differs from the one recorded', posixOnly, async () => {
  const stranger = sleeper();
  await killServerTree({ pid: stranger.pid, startedAt: Date.now(), startToken: 'linux:0' });
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(isAlive(stranger.pid), 'the tree kill signalled a process that is not the recorded root');
});

test('old valid input: a root whose recorded start still matches is killed', posixOnly, async () => {
  const child = sleeper();
  const root = serverRoot(child.pid, Date.now());
  assert.ok(root.startToken, 'the start was recorded at spawn');
  await killServerTree(root);
  await waitFor(() => !isAlive(child.pid), 'the root to exit');
});

test('a start token is the same for one process, differs between two, and is absent for no process', posixOnly, async () => {
  const [a, b] = [sleeper(), sleeper()];
  const token = processStartToken(a.pid);
  assert.match(token, process.platform === 'linux' ? /^linux:\d+$/ : /^ps:/);
  assert.equal(processStartToken(a.pid), token);
  // Two spawns in one tick can share a clock tick; the second is started later to be sure.
  await new Promise((r) => setTimeout(r, 50));
  const c = sleeper();
  assert.notEqual(processStartToken(c.pid), token);
  assert.ok(processStartToken(b.pid));
  const gone = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((r) => gone.on('exit', r));
  assert.equal(processStartToken(gone.pid), undefined);
});

test('Windows records no start token: reuse is checked by creation time there', { skip: process.platform !== 'win32' && 'Windows only' }, () => {
  assert.equal(processStartToken(process.pid), undefined);
  assert.deepEqual(serverRoot(process.pid, 5), { pid: process.pid, startedAt: 5 });
});

// --- a tree whose root is already gone (D36, Windows) ---------------------------------------

test('orphans are found by their recorded parent, created no earlier than the root', () => {
  const t = 1_000_000;
  const procs = [
    { pid: 10, ppid: 1, created: t },              // the dead root's PID, still held by nobody
    { pid: 20, ppid: 10, created: t + 50 },        // its node child: ours
    { pid: 30, ppid: 20, created: t + 60 },        // a grandchild: ours
    { pid: 40, ppid: 10, created: t - 60_000 },    // older than the root: a child of some earlier holder of PID 10
    { pid: 50, ppid: 99, created: t + 70 },        // unrelated
  ].filter((p) => p.pid !== 10);
  assert.deepEqual(findOrphans(procs, { pid: 10, startedAt: t }).sort(), [20, 30]);
});

test('a stranger that reused the root PID is not ours, and neither are its children', () => {
  const t = 1_000_000;
  const procs = [
    { pid: 10, ppid: 1, created: t + 30_000 },     // PID 10 reused after the root died
    { pid: 20, ppid: 10, created: t + 50 },        // ours: made before the reuse
    { pid: 60, ppid: 10, created: t + 31_000 },    // the stranger's child
  ];
  assert.deepEqual(findOrphans(procs, { pid: 10, startedAt: t }), [20]);
});

test('a descendant created before its own parent is a reused PID and is not followed', () => {
  const t = 1_000_000;
  const procs = [{ pid: 20, ppid: 10, created: t + 50 }, { pid: 30, ppid: 20, created: t - 5_000 }];
  assert.deepEqual(findOrphans(procs, { pid: 10, startedAt: t }), [20]);
});

test('a server under a cmd.exe root that died alone is still ended, found by its parent', { skip: process.platform !== 'win32' && 'orphans are found by parent on Windows only' }, async () => {
  const cmd = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe');
  const startedAt = Date.now();
  const { root, pids } = await startTree(cmd, ['/d', '/s', '/c', `""${process.execPath}" "${tree}""`], 2, { windowsVerbatimArguments: true });
  // End the root alone, as the backend's death does: its children break away.
  process.kill(root, 'SIGKILL');
  await waitFor(() => !isAlive(root), 'the root to exit');
  assert.ok(pids.every(isAlive), 'the children died with the root; this test would prove nothing');
  const killed = await killServerTree({ pid: root, startedAt });
  assert.deepEqual(killed.sort(), [...pids].sort());
  await waitFor(() => !pids.some(isAlive), 'the orphans to exit');
});

// The D36 disconnect race: the root is alive when the tree kill starts, then
// the SDK's own SIGTERM ends it before taskkill has walked the tree. taskkill
// reports "not found" (code 128), which reads as success, and the server under
// the root is left running. The kill here stands in for that taskkill: it
// ends nothing and reports the root not found, as taskkill's 128 does.
test('a root that dies while its tree is being killed still has its orphans found and ended', { skip: process.platform !== 'win32' && 'orphans are found by parent on Windows only' }, async () => {
  const startedAt = Date.now();
  // A live PID this test owns, so the root reads as alive and not reused.
  const root = { pid: process.pid, startedAt };
  const listing = [
    { pid: process.pid, ppid: 1, created: startedAt },
    { pid: 999_991, ppid: process.pid, created: startedAt + 5 },
  ];
  const killed = [];
  const orphans = await killServerTree(root, { listProcesses: async () => listing, kill: async (pid) => { killed.push(pid); return 'not-found'; } });
  assert.deepEqual(killed, [process.pid, 999_991]);
  assert.deepEqual(orphans, [999_991]);
});

test('R05-5: a tree taskkill walked from its live root is not listed again for orphans', { skip: process.platform !== 'win32' && 'Windows only' }, async () => {
  const child = sleeper();
  let listings = 0;
  const orphans = await killServerTree({ pid: child.pid, startedAt: Date.now() }, { listProcesses: async () => { listings++; return []; } });
  assert.deepEqual(orphans, []);
  await waitFor(() => !isAlive(child.pid), 'the root to exit');
  assert.equal(listings, 1, 'only the PID-reuse check lists processes; the orphan search ran after a clean taskkill');
});

test('a root whose tree kill left nothing behind reports no orphans', { skip: process.platform !== 'win32' && 'orphans are found by parent on Windows only' }, async () => {
  const startedAt = Date.now();
  const killed = [];
  const orphans = await killServerTree({ pid: process.pid, startedAt }, {
    listProcesses: async () => [{ pid: process.pid, ppid: 1, created: startedAt }],
    kill: async (pid) => { killed.push(pid); },
  });
  assert.deepEqual(killed, [process.pid]);
  assert.deepEqual(orphans, []);
});
