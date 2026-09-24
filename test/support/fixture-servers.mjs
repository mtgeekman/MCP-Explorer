// Starting the HTTP fixture servers from a test. Each announces its URL on
// stdout as `LISTENING <url>`, so no test guesses a port.
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const fixtures = fileURLToPath(new URL('../../scripts/fixture/', import.meta.url));

/**
 * Starts an HTTP fixture with extra environment and resolves to its URL. The
 * caller kills `children` when its tests are done.
 */
export function listen(file, children, env = {}) {
  const child = spawn(process.execPath, [join(fixtures, file)], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, ...env } });
  children.push(child);
  return new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`${file} never announced a port`)), 10000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      out += d;
      const m = out.match(/LISTENING (\S+)/);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
  });
}
