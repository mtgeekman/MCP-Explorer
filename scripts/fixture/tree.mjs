// A process tree that will not die politely, for the process-tree kill tests
// (spec D36). Each level ignores SIGTERM and a closed stdin, starts the next
// level, and appends its PID to PID_LOG. DEPTH levels in all (default 2: this
// process and one child), so a kill that ends only the root leaves the rest.
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const depth = Number(process.env.DEPTH ?? 2);
process.on('SIGTERM', () => {});
process.stdin.resume();
process.stdin.on('end', () => {});
// On Windows a parent's death breaks the pipe with an error rather than an
// end; unhandled, that error would kill this process and make a root-only
// kill look like a tree kill.
process.stdin.on('error', () => {});
appendFileSync(process.env.PID_LOG, `${process.pid}\n`);
if (depth > 1) {
  spawn(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, DEPTH: String(depth - 1) }, stdio: ['pipe', 'ignore', 'inherit'] });
}
setInterval(() => {}, 1 << 30);
