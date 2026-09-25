// The context preview and token cost (plan phase 06). The block is pinned by a
// golden file built from the two fixture servers through storage, the path the
// app takes; the count is pinned so a tokenizer change is visible in CI.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  connectStdio, captureSurface, buildContext, renderContext, costContext, findCollisions, O200K, INSTRUCTIONS_HEADING,
} from '../packages/protocol/dist/index.js';
import { createWorkspaceDb, saveServer, recordCapture, loadSnapshot } from '../packages/storage/dist/index.js';
import { memoryStore } from './support/memory-store.mjs';

const root = mkdtempSync(join(tmpdir(), 'mcpx-context-'));
after(() => rmSync(root, { recursive: true, force: true }));
const fixtures = fileURLToPath(new URL('../scripts/fixture/', import.meta.url));
const golden = fileURLToPath(new URL('./golden/context-block.json', import.meta.url));

/** Both fixtures captured, stored and loaded back: the surfaces the context screen reads. */
async function storedFixtures() {
  const ws = createWorkspaceDb({ path: join(root, `${randomUUID()}.db`), workspaceId: randomUUID(), name: 'context', custody: { kind: 'keychain' }, secrets: memoryStore() });
  const servers = [];
  for (const [id, name, file] of [['s-legacy', 'legacy fixture', 'legacy-server.mjs'], ['s-modern', 'modern fixture', 'modern-server.mjs']]) {
    saveServer(ws, { id, name, transport: 'stdio', command: process.execPath, args: [join(fixtures, file)] });
    const conn = await connectStdio({ command: process.execPath, args: [join(fixtures, file)] });
    let surface;
    try { surface = await captureSurface(conn.source); } finally { await conn.close(); }
    const { snapshotId } = recordCapture(ws, id, surface);
    servers.push({ id, name, surface: loadSnapshot(ws, snapshotId) });
  }
  ws.close();
  return servers;
}

const tool = (name, extra = {}) => ({ name, description: `${name} tool`, inputSchema: { type: 'object' }, ...extra });
const surface = (tools, instructions) => ({
  revision: '2025-11-25', era: 'legacy', capabilities: {}, instructions,
  tools, prompts: [], resources: [], resourceTemplates: [], unavailable: [], problems: [],
});

test('the block for the two fixtures matches the golden file byte for byte', async () => {
  const servers = await storedFixtures();
  assert.equal(renderContext(buildContext(servers)), readFileSync(golden, 'utf8'));
});

test('the fixture surfaces have a pinned o200k_base count', async () => {
  // A change here means the tokenizer, its version, or the serialization
  // changed. Update the numbers only on purpose, and say why in the commit.
  const cost = costContext(await storedFixtures(), O200K);
  assert.equal(cost.tokenizer.id, 'o200k_base');
  assert.deepEqual(
    { total: cost.total, shared: cost.shared, servers: cost.servers.map((s) => [s.serverId, s.instructions, s.tools]) },
    { total: 137, shared: 4, servers: [['s-legacy', 12, 33], ['s-modern', 12, 76]] },
  );
});

test('two fixture servers sharing a tool name show the collision', async () => {
  assert.deepEqual(findCollisions(await storedFixtures()), [{ name: 'echo', serverIds: ['s-legacy', 's-modern'] }]);
});

test('every number adds up: tools to servers, servers and the heading to the total', () => {
  const cost = costContext([
    { id: 'a', name: 'A', surface: surface([tool('x'), tool('y')], 'Use A.') },
    { id: 'b', name: 'B', surface: surface([tool('z')], undefined) },
  ], O200K);
  for (const s of cost.servers) {
    assert.equal(s.total, s.instructions + s.tools);
    assert.equal(s.tools, cost.tools.filter((t) => t.serverId === s.serverId).reduce((n, t) => n + t.tokens, 0));
  }
  assert.equal(cost.total, cost.shared + cost.servers.reduce((n, s) => n + s.total, 0));
  assert.equal(cost.shared, O200K.count(INSTRUCTIONS_HEADING));
  assert.equal(cost.servers[1].instructions, 0);
});

test('with no instructions anywhere there is no system text and no heading cost', () => {
  const servers = [{ id: 'a', name: 'A', surface: surface([tool('x')], '') }];
  assert.equal(buildContext(servers).system, '');
  assert.equal(costContext(servers, O200K).shared, 0);
});

test('the system text is the heading, then each server with instructions in the order given', () => {
  const block = buildContext([
    { id: 'a', name: 'Alpha', surface: surface([], 'First.') },
    { id: 'b', name: 'Beta', surface: surface([], undefined) },
    { id: 'c', name: 'Gamma', surface: surface([], 'Third.') },
  ]);
  assert.equal(block.system, `${INSTRUCTIONS_HEADING}\n\n## Alpha\n\nFirst.\n\n## Gamma\n\nThird.`);
});

test('a tool entry is name, description, input_schema, and what the server omitted stays omitted', () => {
  const block = buildContext([{ id: 'a', name: 'A', surface: surface([
    { name: 'bare', inputSchema: undefined },
    tool('full', { title: 'Full', outputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }),
  ]) }]);
  assert.deepEqual(block.tools.map((t) => JSON.stringify(t)), [
    '{"name":"bare"}',
    '{"name":"full","description":"full tool","input_schema":{"type":"object"}}',
  ]);
});

test('the listed order does not change the block', () => {
  const tools = [tool('c'), tool('a'), tool('b')];
  const one = renderContext(buildContext([{ id: 'a', name: 'A', surface: surface(tools) }]));
  const two = renderContext(buildContext([{ id: 'a', name: 'A', surface: surface([...tools].reverse()) }]));
  assert.equal(one, two);
  assert.deepEqual(JSON.parse(one).tools.map((t) => t.name), ['a', 'b', 'c']);
});

test('worst offenders come first, ties in block order', () => {
  const cost = costContext([{ id: 'a', name: 'A', surface: surface([
    tool('small'), tool('big', { description: 'word '.repeat(200) }), tool('also_small'),
  ]) }], O200K);
  assert.equal(cost.tools[0].name, 'big');
  const rest = cost.tools.slice(1);
  if (rest[0].tokens === rest[1].tokens) assert.deepEqual(rest.map((t) => t.name), ['also_small', 'small']);
});

test('a description holding special-token text counts as ordinary text', () => {
  // Server text is untrusted; the encoder throws on `<|endoftext|>` by default.
  const hostile = [{ id: 'a', name: 'A', surface: surface([tool('x', { description: 'before <|endoftext|> <|im_start|> after' })], '<|endoftext|>') }];
  const cost = costContext(hostile, O200K);
  assert.ok(cost.total > 0);
  // As a special token it would be one token; as text it is several.
  assert.ok(O200K.count('<|endoftext|>') > 1);
});

test('a name repeated within one server is not a cross-server collision', () => {
  assert.deepEqual(findCollisions([{ id: 'a', name: 'A', surface: surface([tool('x'), tool('x')]) }]), []);
});
