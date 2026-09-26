// MODERN-era fixture MCP server (2026-07-28) over stdio.
// All response logic lives in modern-handler.mjs, shared with the HTTP servers.
import { appendFileSync } from 'node:fs';
import { readFrames, writer } from './stdio-lines.mjs';
import { handleModern, serverMeta } from './modern-handler.mjs';
import { answerer } from './call-handler.mjs';

if (process.env.SPAWN_LOG) appendFileSync(process.env.SPAWN_LOG, `${Date.now()} pid=${process.pid}\n`);

const { send } = writer(process.stdout);
const answer = answerer(handleModern, () => ({ resultType: 'complete', ...serverMeta() }));

// STDERR_FLOOD: write more to stderr than an OS pipe buffer holds (~64KB)
// before answering. A parent that pipes stderr without reading it leaves the
// child blocked in write() forever. Real servers do this with verbose logging.
if (process.env.STDERR_FLOOD) {
  process.stderr.write('x'.repeat(Number(process.env.STDERR_FLOOD)));
}

// REQUIRE_ENV=<name>: exit with code 4 at startup unless that variable is set,
// as a server needing an API key does. Proves a session secret reached it.
if (process.env.REQUIRE_ENV && !process.env[process.env.REQUIRE_ENV]) {
  process.stderr.write(`missing ${process.env.REQUIRE_ENV}\n`);
  process.exit(4);
}

// STUBBORN: ignore SIGTERM and a closed stdin, so only a tree kill ends it (D36).
if (process.env.STUBBORN) {
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1 << 30);
}

// EXIT_AFTER_MS=<n>: crash with exit code 3 that long after starting.
if (process.env.EXIT_AFTER_MS) setTimeout(() => process.exit(3), Number(process.env.EXIT_AFTER_MS));

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
  void answer(msg, send).then((response) => { if (response !== undefined) send(response); });
});
