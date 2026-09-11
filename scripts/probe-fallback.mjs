// Phase 00: subclass-in-place probing WITH the fallback a hostile server forces.
// Proves the strategy is never worse than the SDK's sibling on process spawns
// and always better on P1 frame visibility.
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const server = join(here, 'fixture', 'legacy-server.mjs');
const { Client } = await import('@modelcontextprotocol/client');
const { StdioClientTransport } = await import('@modelcontextprotocol/client/stdio');

class SeamStdioTransport extends StdioClientTransport {}

function tap(inner, seen) {
  return new Proxy(inner, {
    get(t, p, r) {
      if (p === 'send') return async (m, o) => { for (const f of Array.isArray(m) ? m : [m]) seen.out.push(f); return t.send(m, o); };
      const v = Reflect.get(t, p, r);
      return typeof v === 'function' ? v.bind(t) : v;
    },
    set(t, p, v) {
      if (p === 'onmessage') { t.onmessage = (m, x) => { seen.in.push(m); v?.(m, x); }; return true; }
      return Reflect.set(t, p, v);
    },
  });
}

async function connectWithSeam(hostile) {
  const work = mkdtempSync(join(tmpdir(), 'mcpx-fb-'));
  const spawnLog = join(work, 'spawns.log');
  const frameLog = join(work, 'frames.log');
  writeFileSync(spawnLog, ''); writeFileSync(frameLog, '');
  const env = { ...process.env, SPAWN_LOG: spawnLog, FRAME_LOG: frameLog, ...(hostile ? { HOSTILE_PREINIT: '1' } : {}) };
  const opts = { command: process.execPath, args: [server], env };
  const seen = { out: [], in: [] };

  let era = 'modern-or-legacy (probed in place)';
  let client = new Client({ name: 'mcp-explorer-phase00', version: '0.0.0' }, { versionNegotiation: { mode: 'auto' } });
  try {
    await client.connect(tap(new SeamStdioTransport(opts), seen));
  } catch (e) {
    // The SDK reports this case explicitly. Anything that is not a clean modern
    // answer means legacy (D20), so pin and reconnect rather than give up.
    if (!/negotiation failed/i.test(e?.message ?? '')) throw e;
    era = 'legacy (probe killed the process; pinned and reconnected)';
    client = new Client({ name: 'mcp-explorer-phase00', version: '0.0.0' }, {});
    await client.connect(tap(new SeamStdioTransport(opts), seen));
  }
  const tools = await client.listTools();
  await client.close();

  const spawns = readFileSync(spawnLog, 'utf8').trim().split('\n').filter(Boolean).length;
  const received = readFileSync(frameLog, 'utf8').trim().split('\n').filter(Boolean).length;
  return { hostile, era, tools: tools.tools.length, framesTapped: seen.out.length, framesServerReceived: received, spawns, seamComplete: seen.out.length === received };
}

console.log(JSON.stringify([await connectWithSeam(false), await connectWithSeam(true)], null, 1));
