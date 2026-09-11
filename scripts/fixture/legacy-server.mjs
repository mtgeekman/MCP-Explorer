// Minimal LEGACY-era MCP server over stdio. Hand-rolled on purpose: the probe
// counts frames, so nothing between us and the wire may be a variable.
// Records every spawn so the sibling-probe behaviour is observable.
import { appendFileSync } from 'node:fs';

const spawnLog = process.env.SPAWN_LOG;
if (spawnLog) appendFileSync(spawnLog, `${Date.now()} pid=${process.pid}\n`);

const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

let buf = '';
// Decode the STREAM, not each chunk: `buf += chunk` coerces every Buffer
// independently, so a multi-byte character split across a chunk boundary
// becomes replacement characters and the frame is unparseable.
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (err) {
      // Never drop a frame silently -- an invisible drop is what hid the
      // chunk-decoding bug above: the client just waits forever.
      process.stderr.write(`fixture: unparseable frame (${err.message}): ${line}
`);
      continue;
    }
    if (process.env.FRAME_LOG) appendFileSync(process.env.FRAME_LOG, `IN  ${line}\n`);

    // Some real stdio servers die on any pre-initialize request. That is the
    // hazard the SDK's disposable sibling exists to absorb; reproduce it.
    if (process.env.HOSTILE_PREINIT && msg.method === 'server/discover') {
      process.exit(1);
    }

    if (msg.method === 'initialize') {
      reply(msg.id, {
        protocolVersion: '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'phase00-legacy-fixture', version: '0.0.0' },
        instructions: 'Phase 00 fixture. Legacy era.',
      });
    } else if (msg.method === 'tools/list') {
      reply(msg.id, {
        tools: [{
          name: 'echo',
          description: 'Echoes its input.',
          inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        }],
      });
    } else if (msg.id !== undefined) {
      // Unknown method, including server/discover -> the probe MUST read this as legacy.
      fail(msg.id, -32601, `Method not found: ${msg.method}`);
    }
  }
});
