// MODERN-era fixture MCP server (2026-07-28) over stdio.
// All response logic lives in modern-handler.mjs, shared with the HTTP servers.
import { appendFileSync } from 'node:fs';
import { readFrames, writer } from './stdio-lines.mjs';
import { handleModern } from './modern-handler.mjs';

if (process.env.SPAWN_LOG) appendFileSync(process.env.SPAWN_LOG, `${Date.now()} pid=${process.pid}\n`);

const { send } = writer(process.stdout);

readFrames(process.stdin, (msg, line) => {
  if (process.env.FRAME_LOG) appendFileSync(process.env.FRAME_LOG, `IN  ${line}\n`);
  const response = handleModern(msg);
  if (response !== undefined) send(response);
});
