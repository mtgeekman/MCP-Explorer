// Ending a server process and everything it started (spec D36).
//
// A stdio server is often not one process. `npx` on Windows is `cmd.exe`
// running `node`; a Python server may be a launcher over an interpreter.
// Killing only the process the app spawned leaves the rest running, so the app
// always kills the tree, from the root it spawned, while that root is alive:
// once it has exited, its children can no longer be found from it on Windows.
//
// Platform-specific by nature, which is why it lives here (CLAUDE.md: no
// platform-specific API outside the platform abstraction layer).
import { execFile, execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface KillTreeOptions {
  /** How long the tree gets to exit after SIGTERM before SIGKILL. POSIX only. */
  graceMs?: number;
  /** Sends one signal; process.kill unless a test stands in. POSIX only. */
  signal?: (pid: number, signal: NodeJS.Signals) => void;
}

/**
 * Whether a process with this PID is running. A PID can be reused; callers
 * hold PIDs only while they own the process.
 *
 * On Linux a zombie still answers kill(pid, 0) until its parent reaps it,
 * though it has exited and holds nothing. An orphan is re-parented to PID 1,
 * and a container whose PID 1 never reaps (a shell running a CI job) keeps it
 * that way for good, so a zombie counts as not alive (pipeline 567).
 */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (e) {
    // EPERM: it exists and belongs to someone else.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
  if (process.platform !== 'linux') return true;
  try {
    // The state follows the command name, which is parenthesized and may itself contain ") ".
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3);
    return state !== 'Z' && state !== 'X';
  } catch {
    // Gone between the signal and the read.
    return false;
  }
}

/**
 * When the process holding `pid` started, as a token that only the same
 * process reproduces: compared with the token recorded at spawn, it tells the
 * root from a stranger that later got its PID. POSIX only; undefined on
 * Windows, which checks reuse by creation time (orphans.ts), and for a PID no
 * process holds.
 *
 * Linux: /proc/<pid>/stat field 22, the start in clock ticks since boot. Other
 * POSIX (macOS): `ps -o lstart=`, to the second; written for the deferred
 * macOS build (D11) and not run in CI.
 */
export function processStartToken(pid: number): string | undefined {
  if (process.platform === 'win32') return undefined;
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      // Fields from the state (field 3) on; the command name before it may contain ") ".
      const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
      return start ? `linux:${start}` : undefined;
    } catch {
      return undefined;
    }
  }
  try {
    const start = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).trim();
    return start ? `ps:${start}` : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Ends `pid` and every process descended from it. Resolves once the tree is
 * gone; rejects naming what is still running (POSIX: after SIGKILL and a
 * short wait; Windows: what taskkill could not end). Never rejects for a
 * process that has already exited.
 */
export async function killProcessTree(pid: number, opts: KillTreeOptions = {}): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new RangeError(`not a process id: ${pid}`);
  if (process.platform === 'win32') return killWindowsTree(pid);
  return killPosixTree(pid, opts.graceMs ?? 2000, opts.signal ?? ((p, s) => process.kill(p, s)));
}

/** taskkill walks the tree from a live root and terminates it; /F because a console server ignores WM_CLOSE. */
function killWindowsTree(pid: number): Promise<void> {
  const taskkill = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe');
  return new Promise((resolve, reject) => {
    execFile(taskkill, ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, (error, _stdout, stderr) => {
      // 128: no such process. It exited on its own, which is the outcome wanted.
      if (!error || (error as { code?: unknown }).code === 128 || !isAlive(pid)) return resolve();
      reject(new Error(`taskkill could not end process tree ${pid}: ${stderr.trim() || error.message}`));
    });
  });
}

type Send = (pid: number, signal: NodeJS.Signals) => void;

async function killPosixTree(root: number, graceMs: number, send: Send): Promise<void> {
  // Snapshot the tree first: once a parent dies its children are re-parented
  // and can no longer be found from it.
  const tree = [root, ...(await descendants(root))];
  const refused = new Map<number, string>();
  signalAll(tree, 'SIGTERM', send, refused);
  await gone(tree, graceMs);
  signalAll(tree.filter(isAlive), 'SIGKILL', send, refused);
  // SIGKILL is not instant, and it can be refused (EPERM) or not land: what is
  // still running is named, so the root stays owned and reported (D36).
  await gone(tree, KILL_WAIT_MS);
  const survivors = tree.filter(isAlive);
  if (survivors.length) {
    const named = survivors.map((pid) => (refused.has(pid) ? `${pid} (${refused.get(pid)})` : String(pid)));
    throw new Error(`process tree ${root}: ${named.join(', ')} still running after SIGKILL`);
  }
}

/** How long a tree gets to be gone after SIGKILL before the kill is reported failed. */
const KILL_WAIT_MS = 1000;

async function gone(pids: number[], ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && pids.some(isAlive)) await new Promise((r) => setTimeout(r, 25));
}

/** Signals each PID; one the OS refused is kept in `refused` with the reason. */
function signalAll(pids: number[], signal: NodeJS.Signals, send: Send, refused: Map<number, string>): void {
  for (const pid of pids) {
    try {
      send(pid, signal);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      // ESRCH: gone between the snapshot and the signal, which is the outcome wanted.
      if (code !== 'ESRCH') refused.set(pid, code ?? (e instanceof Error ? e.message : String(e)));
    }
  }
}

/** Every process below `root`, from a snapshot of parent links. */
async function descendants(root: number): Promise<number[]> {
  const parentOf = process.platform === 'linux' ? linuxParents() : await psParents();
  const children = new Map<number, number[]>();
  for (const [pid, ppid] of parentOf) children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  const out: number[] = [];
  const queue = [root];
  while (queue.length) {
    for (const child of children.get(queue.shift()!) ?? []) {
      out.push(child);
      queue.push(child);
    }
  }
  return out;
}

/** Linux: /proc/<pid>/stat, field 4 is the parent. No `ps` needed, so it works in a minimal container. */
function linuxParents(): Map<number, number> {
  const parents = new Map<number, number>();
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
      // The command name is in parentheses and may itself contain ") ".
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      parents.set(Number(name), Number(fields[1]));
    } catch {
      // Exited while we were reading.
    }
  }
  return parents;
}

/**
 * Other POSIX systems (macOS): `ps`. Written for the deferred macOS build (D11)
 * and not run in CI; the Linux path above is the one tested.
 */
function psParents(): Promise<Map<number, number>> {
  return new Promise((resolve, reject) => {
    execFile('ps', ['-A', '-o', 'pid=,ppid='], (error, stdout) => {
      if (error) return reject(new Error(`ps failed while finding child processes: ${error.message}`));
      const parents = new Map<number, number>();
      for (const line of stdout.split('\n')) {
        const [pid, ppid] = line.trim().split(/\s+/).map(Number);
        if (pid > 0) parents.set(pid, ppid);
      }
      resolve(parents);
    });
  });
}
