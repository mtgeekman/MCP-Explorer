// LEGACY-era fixture MCP server over stdio. All response logic lives in
// legacy-handler.mjs, shared with the HTTP servers.
//
// Records every spawn so the probe's process behaviour is observable.
import { appendFileSync } from 'node:fs';
import { readFrames, writer } from './stdio-lines.mjs';
import { handleLegacy, afterLegacy, DIE, SILENT } from './legacy-handler.mjs';

const spawnLog = process.env.SPAWN_LOG;
if (spawnLog) appendFileSync(spawnLog, `${Date.now()} pid=${process.pid}\n`);

const { send } = writer(process.stdout);

readFrames(process.stdin, (msg, line) => {
  if (process.env.FRAME_LOG) appendFileSync(process.env.FRAME_LOG, `IN  ${line}\n`);
  const response = handleLegacy(msg);
  if (response === DIE) process.exit(1);
  if (response === SILENT || response === undefined) return;
  send(response);
  for (const note of afterLegacy(msg)) send(note);
});
