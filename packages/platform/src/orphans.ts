// Killing a server tree whose root is already gone (D36, amended by the
// phase 04 finding). On Windows the backend's death takes its direct children
// with it (libuv's job object), but lets their children break away: the node
// under a cmd.exe shim keeps running, and taskkill /T cannot walk from a root
// that no longer exists. Windows keeps each process's parent PID after the
// parent exits, so the orphans can still be found by it.
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { isAlive, killProcessTree } from './process-tree.js';

export interface ProcessInfo {
  pid: number;
  ppid: number;
  /** Creation time, milliseconds since the epoch. */
  created: number;
}

/** A server's root process as the backend spawned it. */
export interface ServerRoot {
  pid: number;
  /** When the backend saw it spawn, milliseconds since the epoch. */
  startedAt: number;
}

/**
 * How far before the recorded start a process may have been created and still
 * count: the backend stamps the spawn after the OS created the process.
 */
const START_SLACK_MS = 2000;

/**
 * The descendants of a dead root, from a snapshot of every process. A PID is
 * reused over time, so parent links alone are not enough:
 *
 * - a child of the root must have been created no earlier than the root was;
 * - if a live process now holds the root's PID and was created later, it is a
 *   stranger that reused it, and only children created before it are ours;
 * - each further level must have been created no earlier than its parent.
 */
export function findOrphans(processes: ProcessInfo[], root: ServerRoot): number[] {
  const byParent = new Map<number, ProcessInfo[]>();
  for (const p of processes) byParent.set(p.ppid, [...(byParent.get(p.ppid) ?? []), p]);
  const reuser = processes.find((p) => p.pid === root.pid && p.created > root.startedAt + START_SLACK_MS);
  const notBefore = root.startedAt - START_SLACK_MS;
  const before = reuser ? reuser.created : Number.POSITIVE_INFINITY;

  const found: number[] = [];
  const queue = (byParent.get(root.pid) ?? []).filter((p) => p.created >= notBefore && p.created < before && p.pid !== root.pid);
  while (queue.length) {
    const p = queue.shift()!;
    found.push(p.pid);
    for (const child of byParent.get(p.pid) ?? []) {
      if (child.created >= p.created && !found.includes(child.pid)) queue.push(child);
    }
  }
  return found;
}

/** Every process on this Windows machine, with parent and creation time. */
function windowsProcesses(): Promise<ProcessInfo[]> {
  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }";
  return new Promise((resolve, reject) => {
    execFile(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error) return reject(new Error(`could not list processes to find orphaned server processes: ${error.message}`));
      resolve(stdout.split(/\r?\n/).filter(Boolean).map((line) => {
        const [pid, ppid, created] = line.trim().split(' ').map(Number);
        return { pid, ppid, created };
      }));
    });
  });
}

/**
 * Ends a server's whole tree. While the root lives, from the root. Once it is
 * gone, on Windows, by finding what it left behind; elsewhere an orphan has
 * been re-parented and cannot be told apart, and D36 accepts that (POSIX keeps
 * the root alive when the backend dies, so the first path applies there).
 * Returns the PIDs killed as orphans.
 */
export async function killServerTree(root: ServerRoot, opts: { listProcesses?: () => Promise<ProcessInfo[]> } = {}): Promise<number[]> {
  const list = opts.listProcesses ?? windowsProcesses;
  if (isAlive(root.pid) && !(process.platform === 'win32' && (await rootWasReused(root, list)))) {
    await killProcessTree(root.pid);
    return [];
  }
  if (process.platform !== 'win32') return [];
  const orphans = findOrphans(await list(), root);
  await Promise.all(orphans.map((pid) => killProcessTree(pid).catch(() => undefined)));
  return orphans;
}

/** Whether the process now holding the root's PID was created after the root: a stranger. */
async function rootWasReused(root: ServerRoot, list: () => Promise<ProcessInfo[]>): Promise<boolean> {
  const holder = (await list()).find((p) => p.pid === root.pid);
  return holder !== undefined && holder.created > root.startedAt + START_SLACK_MS;
}
