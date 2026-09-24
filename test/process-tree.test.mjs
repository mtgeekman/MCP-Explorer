// D36: a server is killed as a tree, from the root the app spawned. The
// fixture tree ignores SIGTERM and a closed stdin at every level, so only a
// real tree kill passes.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { killProcessTree, isAlive } from '../packages/platform/dist/index.js';
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

test('killing a process that has already exited resolves', async () => {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  await new Promise((r) => child.on('exit', r));
  await killProcessTree(child.pid);
});

test('a PID that cannot be a process is refused rather than signalled', async () => {
  // process.kill(0) and process.kill(-1) signal a whole process group or every
  // process the user owns; neither may ever reach here.
  for (const pid of [0, -1, 1.5, Number.NaN]) await assert.rejects(killProcessTree(pid), RangeError);
});
