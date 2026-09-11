// Phase 00: does ONE transport decorator see every JSON-RPC frame (P1), and does
// auto negotiation spawn the stdio server twice (D20)?
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const server = join(here, 'fixture', 'legacy-server.mjs');
const work = mkdtempSync(join(tmpdir(), 'mcpx-probe-'));
const spawnLog = join(work, 'spawns.log');
const frameLog = join(work, 'frames.log');
writeFileSync(spawnLog, ''); writeFileSync(frameLog, '');

const { Client } = await import('@modelcontextprotocol/client');
const { StdioClientTransport } = await import('@modelcontextprotocol/client/stdio');

const seen = { out: [], in: [] };
function tap(inner) {
  return new Proxy(inner, {
    get(t, prop, recv) {
      if (prop === 'send') {
        return async (msg, opts) => {
          for (const f of Array.isArray(msg) ? msg : [msg]) seen.out.push(f);
          return t.send(msg, opts);
        };
      }
      const v = Reflect.get(t, prop, recv);
      return typeof v === 'function' ? v.bind(t) : v;
    },
    set(t, prop, value) {
      if (prop === 'onmessage') {
        t.onmessage = (m, extra) => { seen.in.push(m); value?.(m, extra); };
        return true;
      }
      return Reflect.set(t, prop, value);
    },
  });
}

const mode = process.argv[2] ?? 'auto';
const transport = tap(new StdioClientTransport({
  command: process.execPath,
  args: [server],
  env: { ...process.env, SPAWN_LOG: spawnLog, FRAME_LOG: frameLog },
}));

const client = new Client(
  { name: 'mcp-explorer-phase00', version: '0.0.0' },
  mode === 'auto' ? { versionNegotiation: { mode: 'auto' } } : {}
);

await client.connect(transport);
const tools = await client.listTools();
await client.close();

const spawns = readFileSync(spawnLog, 'utf8').trim().split('\n').filter(Boolean).length;
const serverSaw = existsSync(frameLog)
  ? readFileSync(frameLog, 'utf8').trim().split('\n').filter(Boolean).length
  : 0;

const methods = seen.out.map((f) => f.method).filter(Boolean);
console.log(JSON.stringify({
  mode,
  negotiatedVersion: client.getServerVersion?.() ?? null,
  serverInfo: client.getServerVersion?.(),
  toolCount: tools.tools.length,
  framesOut: seen.out.length,
  framesIn: seen.in.length,
  outboundMethods: methods,
  serverProcessSpawns: spawns,
  framesServerReceived: serverSaw,
  serverFrameLog: existsSync(frameLog) ? readFileSync(frameLog,'utf8').trim().split(String.fromCharCode(10)) : [],
  tappedOutbound: seen.out.map(f => JSON.stringify(f).slice(0,100)),
}, null, 2));
