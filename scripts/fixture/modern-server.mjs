// MODERN-era fixture MCP server (2026-07-28) over stdio.
// All response logic lives in modern-handler.mjs, shared with the HTTP servers.
import { appendFileSync } from 'node:fs';
import { readFrames, writer } from './stdio-lines.mjs';
import { handleModern } from './modern-handler.mjs';

if (process.env.SPAWN_LOG) appendFileSync(process.env.SPAWN_LOG, `${Date.now()} pid=${process.pid}\n`);

const { send } = writer(process.stdout);

// STDERR_FLOOD: write more to stderr than an OS pipe buffer holds (~64KB)
// before answering. A parent that pipes stderr without reading it leaves the
// child blocked in write() forever. Real servers do this with verbose logging.
if (process.env.STDERR_FLOOD) {
  process.stderr.write('x'.repeat(Number(process.env.STDERR_FLOOD)));
}

// NO_FINAL_NEWLINE: when stdin closes, write a last line with no newline and
// exit. The SDK never sees such bytes; the wire log must.
if (process.env.NO_FINAL_NEWLINE) {
  process.stdin.on('end', () => {
    if (process.env.WIRE_LOG) appendFileSync(process.env.WIRE_LOG, 'goodbye');
    process.stdout.write('goodbye', () => process.exit(0));
  });
}

readFrames(process.stdin, (msg, line) => {
  if (process.env.FRAME_LOG) appendFileSync(process.env.FRAME_LOG, `IN  ${line}\n`);
  // MALFORMED: emit a line that is not JSON before the real answer. A client
  // that cannot survive junk on the wire cannot explore a broken server, which
  // is the case this app exists for. console.log, not stdout.write, so there is
  // no escape sequence to get wrong.
  if (process.env.MALFORMED) console.log('this is not json');
  // EXIT_ON=<method>: crash with exit code 3 on receiving that method, as a
  // server with a bug in one handler would, after the session is up.
  if (process.env.EXIT_ON && msg.method === process.env.EXIT_ON) process.exit(3);
  const response = handleModern(msg);
  if (response !== undefined) send(response);
});
