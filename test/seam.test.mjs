// The P1 pillar gate: every JSON-RPC frame the app sends must pass through the
// app's own transport. The SDK's default stdio negotiation probes on a
// disposable SIBLING process, so the server/discover frame never touches a
// decorator the app installed -- invisible traffic, and a second spawn of a
// server whose startup may do real work.
//
// Deliberately duplicates a little of scripts/probe-seam.mjs: that script is a
// human measurement tool that prints numbers, this is the assertion CI runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const server = join(fileURLToPath(new URL('../scripts/fixture/', import.meta.url)), 'legacy-server.mjs');
const { Client } = await import('@modelcontextprotocol/client');
const { StdioClientTransport } = await import('@modelcontextprotocol/client/stdio');

// Shifting the prototype is what opts out of the sibling probe: the SDK's
// readStdioServerParams() requires an own `_dispose` on the immediate prototype.
class SeamStdioTransport extends StdioClientTransport {}

function tap(inner, seen) {
  return new Proxy(inner, {
    get(t, p, r) {
      if (p === 'send') {
        return async (m, o) => { for (const f of Array.isArray(m) ? m : [m]) seen.push(f); return t.send(m, o); };
      }
      const v = Reflect.get(t, p, r);
      return typeof v === 'function' ? v.bind(t) : v;
    },
    set(t, p, v) {
      if (p === 'onmessage') { t.onmessage = (m, x) => v?.(m, x); return true; }
      return Reflect.set(t, p, v);
    },
  });
}

async function connect({ hostile = false, Transport = SeamStdioTransport } = {}) {
  const work = mkdtempSync(join(tmpdir(), 'mcpx-seamtest-'));
  const spawnLog = join(work, 'spawns.log');
  const frameLog = join(work, 'frames.log');
  writeFileSync(spawnLog, ''); writeFileSync(frameLog, '');
  const opts = {
    command: process.execPath,
    args: [server],
    env: { ...process.env, SPAWN_LOG: spawnLog, FRAME_LOG: frameLog, ...(hostile ? { HOSTILE_PREINIT: '1' } : {}) },
  };
  const sent = [];
  let client = new Client({ name: 'seam-test', version: '0.0.0' }, { versionNegotiation: { mode: 'auto' } });
  try {
    await client.connect(tap(new Transport(opts), sent));
  } catch (e) {
    // D20: anything that is not a clean modern answer means legacy. Pin and retry.
    if (!/negotiation failed/i.test(e?.message ?? '')) throw e;
    client = new Client({ name: 'seam-test', version: '0.0.0' }, {});
    await client.connect(tap(new Transport(opts), sent));
  }
  const tools = await client.listTools();
  await client.close();
  const count = (f) => readFileSync(f, 'utf8').trim().split(String.fromCharCode(10)).filter(Boolean).length;
  return { sent: sent.length, received: count(frameLog), spawns: count(spawnLog), tools: tools.tools.length };
}

test('P1: every frame the client sends reaches the server through our transport', async () => {
  const r = await connect();
  assert.equal(r.tools, 1, 'the session actually worked');
  assert.equal(r.sent, r.received, `frames escaped the seam: tapped ${r.sent}, server received ${r.received}`);
});

test('D20: a tolerated probe costs exactly one process spawn', async () => {
  const r = await connect();
  assert.equal(r.spawns, 1, `expected one spawn, got ${r.spawns} (sibling probe reinstated?)`);
});

test('D20: a server that dies on the probe still connects, seam intact', async () => {
  const r = await connect({ hostile: true });
  assert.equal(r.tools, 1, 'fallback reconnected and listed tools');
  assert.equal(r.sent, r.received, `frames escaped the seam: tapped ${r.sent}, server received ${r.received}`);
});
