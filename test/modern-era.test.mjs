// The modern era (2026-07-28) is a different protocol, not a dialect: no
// initialize handshake, server identity in _meta, and every request obliged to
// carry the client's version and capabilities.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixtures = fileURLToPath(new URL('../scripts/fixture/', import.meta.url));
const { Client } = await import('@modelcontextprotocol/client');
const { StdioClientTransport } = await import('@modelcontextprotocol/client/stdio');
class SeamStdioTransport extends StdioClientTransport {}

// D21: declaring these is what permits a server to ask for them at all.
const CAPABILITIES = { sampling: {}, elicitation: {}, roots: {} };

async function session(serverFile) {
  const frameLog = join(mkdtempSync(join(tmpdir(), 'mcpx-modern-')), 'frames.log');
  writeFileSync(frameLog, '');
  const client = new Client(
    { name: 'modern-era-test', version: '0.0.0' },
    { versionNegotiation: { mode: 'auto' }, capabilities: CAPABILITIES }
  );
  await client.connect(new SeamStdioTransport({
    command: process.execPath,
    args: [join(fixtures, serverFile)],
    env: { ...process.env, FRAME_LOG: frameLog },
  }));
  const tools = await client.listTools();
  await client.close();
  const frames = readFileSync(frameLog, 'utf8').trim().split(String.fromCharCode(10)).filter(Boolean)
    .map((l) => JSON.parse(l.replace(/^IN {2}/, '')));
  return { tools, frames };
}

test('a modern server is reached through server/discover, not initialize', async () => {
  const { tools, frames } = await session('modern-server.mjs');
  const methods = frames.map((f) => f.method);
  assert.ok(methods.includes('server/discover'), `expected server/discover, saw ${methods.join(', ')}`);
  assert.ok(!methods.includes('initialize'), 'initialize must not be sent to a modern server');
  assert.equal(tools.tools.length, 2);
});

test('every modern request carries the required _meta fields', async () => {
  const { frames } = await session('modern-server.mjs');
  const required = [
    'io.modelcontextprotocol/protocolVersion',
    'io.modelcontextprotocol/clientInfo',
    'io.modelcontextprotocol/clientCapabilities',
  ];
  assert.ok(frames.length >= 2, 'more than the probe was sent');
  for (const frame of frames) {
    const keys = Object.keys(frame.params?._meta ?? {});
    for (const field of required) {
      assert.ok(keys.includes(field), `${frame.method} is missing _meta.${field} (has: ${keys.join(', ') || 'nothing'})`);
    }
  }
});

test('the declared client capabilities reach the server', async () => {
  const { frames } = await session('modern-server.mjs');
  const declared = frames[0].params._meta['io.modelcontextprotocol/clientCapabilities'];
  // A server MUST NOT ask for a capability the client did not declare, so this
  // list is exactly what decides whether MRTR input requests can arrive at all.
  for (const cap of Object.keys(CAPABILITIES)) {
    assert.ok(cap in declared, `capability ${cap} was declared but not sent (sent: ${JSON.stringify(declared)})`);
  }
});
