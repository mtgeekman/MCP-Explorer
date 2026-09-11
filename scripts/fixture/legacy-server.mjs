// LEGACY-era fixture MCP server (initialize handshake, 2025-06-18 shaped) over
// stdio. Hand-rolled on purpose: the tests count frames, so nothing between us
// and the wire may be a variable.
//
// Records every spawn so the probe's process behaviour is observable, and can
// simulate a server that dies on any pre-initialize request -- the hazard the
// SDK's disposable sibling probe exists to absorb.
import { appendFileSync } from 'node:fs';
import { readFrames, writer } from './stdio-lines.mjs';

const spawnLog = process.env.SPAWN_LOG;
if (spawnLog) appendFileSync(spawnLog, `${Date.now()} pid=${process.pid}\n`);

const { reply, fail } = writer(process.stdout);

readFrames(process.stdin, (msg, line) => {
  if (process.env.FRAME_LOG) appendFileSync(process.env.FRAME_LOG, `IN  ${line}\n`);

  // Some real stdio servers die on any pre-initialize request. Reproduce it.
  if (process.env.HOSTILE_PREINIT && msg.method === 'server/discover') {
    process.exit(1);
  }

  if (msg.method === 'initialize') {
    return reply(msg.id, {
      protocolVersion: '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'phase00-legacy-fixture', version: '0.0.0' },
      instructions: 'Phase 00 fixture. Legacy era.',
    });
  }

  if (msg.method === 'tools/list') {
    return reply(msg.id, {
      tools: [{
        name: 'echo',
        description: 'Echoes its input.',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      }],
    });
  }

  // Unknown method, including server/discover -> the probe MUST read this as legacy.
  if (msg.id !== undefined) fail(msg.id, -32601, `Method not found: ${msg.method}`);
});
