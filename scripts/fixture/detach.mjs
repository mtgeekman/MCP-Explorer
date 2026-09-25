// A launcher that starts the modern server detached, holding none of its own
// pipes, and exits with code 1 at once: the connect fails with its root gone
// while the process it started keeps running (spec D36, review RR-5). The
// environment, SPAWN_LOG and STUBBORN included, is passed through.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const child = spawn(process.execPath, [fileURLToPath(new URL('./modern-server.mjs', import.meta.url))], { detached: true, stdio: 'ignore' });
child.unref();
process.exit(1);
