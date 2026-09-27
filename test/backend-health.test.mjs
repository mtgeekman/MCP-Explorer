// The health check and Mcp-Param-* headers through the backend (plan phase
// 10, decisions 11 and 12).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Backend } from '../packages/backend/dist/index.js';
import { lintTool, lintPrompt, lintResource, lintResourceTemplate } from '../packages/protocol/dist/index.js';
import { memoryStore } from './support/memory-store.mjs';
import { fixtures, listen } from './support/fixture-servers.mjs';

const root = mkdtempSync(join(tmpdir(), 'mcpx-bhealth-'));
const backends = [];
const children = [];
after(async () => {
  for (const b of backends) await b.shutdown();
  for (const c of children) c.kill();
  rmSync(root, { recursive: true, force: true });
});

async function workspace() {
  const backend = new Backend({ dataDir: mkdtempSync(join(root, 'data-')), secrets: memoryStore(), closeGraceMs: 300 });
  backends.push(backend);
  const call = (method, params = {}) => backend.request(method, params);
  await call('workspaces.create', { name: 'Health', protection: { kind: 'none' } });
  return call;
}

const stdioServer = (file, env) => ({ name: 'fixture', transport: 'stdio', command: process.execPath, args: [join(fixtures, file)], env });

for (const [era, file] of [['legacy', 'legacy-server.mjs'], ['modern', 'modern-server.mjs']]) {
  test(`acceptance (decision 12), ${era}: one press connects, lists, and reports the era, capabilities, extensions and every malformed element`, async () => {
    const call = await workspace();
    const { id } = await call('servers.save', { server: stdioServer(file, { EXTRAS: '1', MALFORMED_SURFACE: '1', LEGACY_REVISION: '2025-11-25' }) });
    assert.equal((await call('connections.connect', { serverId: id })).status, 'connected');
    await call('connections.disconnect', { serverId: id });

    const report = await call('health.check', { serverId: id });
    assert.equal(report.connection.status, 'connected', 'the press connected it');
    assert.equal(report.connection.era, era);
    const names = report.capabilities.map((c) => c.name);
    for (const c of ['completions', 'logging', 'prompts', 'resources', 'tools']) assert.ok(names.includes(c), `capability ${c}`);
    assert.ok(names.includes(era === 'legacy' ? 'tasks' : 'extensions'));
    assert.deepEqual(report.extensions, era === 'modern' ? ['io.modelcontextprotocol/tasks'] : []);
    assert.ok(report.lists.every((l) => l.state === 'listed'));

    const flagged = report.malformed.map((m) => `${m.endpoint} ${m.key}`);
    for (const k of ['tools/list no_schema', 'tools/list bad_hint', 'tools/list bad_header', 'prompts/list bad_args', 'resources/list fixture://nameless', 'resources/templates/list fixture://{open']) {
      assert.ok(flagged.includes(k), `flags ${k}; got ${flagged.join(', ')}`);
    }
    assert.ok(report.malformed.some((m) => m.endpoint === 'tools/list' && /^#\d+$/.test(m.key) && /name is not a string/.test(m.message)), 'the tool named 42');
    assert.deepEqual(report.schemas.map((s) => [s.tool, s.field]), [['bad_schema', 'inputSchema']]);
    if (era === 'legacy') assert.equal(report.ping.status, 'ok'); else assert.deepEqual(report.ping, { status: 'unavailable', reason: 'ping does not exist on 2026-07-28' });
  });
}

test('health: an advertised list that fails is reported as such, and a clean fixture flags nothing', async () => {
  const call = await workspace();
  const { id } = await call('servers.save', { server: stdioServer('modern-server.mjs', { LIE_ABOUT: 'prompts' }) });
  const report = await call('health.check', { serverId: id });
  const prompts = report.lists.find((l) => l.endpoint === 'prompts/list');
  assert.equal(prompts.state, 'failed');
  assert.match(prompts.message, /-32601/);
  assert.deepEqual(report.malformed, []);
  assert.deepEqual(report.schemas, []);
});

test('health: a server that cannot start is reported, not thrown', async () => {
  const call = await workspace();
  const { id } = await call('servers.save', { server: { name: 'gone', transport: 'stdio', command: 'mcpx-no-such-command-anywhere' } });
  const report = await call('health.check', { serverId: id });
  assert.equal(report.connection.status, 'not-connected');
  assert.equal(report.connection.state, 'failed');
});

test('Mcp-Param headers (decision 11): a modern Streamable HTTP tool call carries its declared header, shown in the confirm', async () => {
  const log = join(root, `headers-${Date.now()}.log`);
  const url = await listen('http-server.mjs', children, { EXTRAS: '1', MCP_HEADER_LOG: log });
  const call = await workspace();
  const { id } = await call('servers.save', { server: { name: 'http', transport: 'streamable-http', url } });
  await call('connections.connect', { serverId: id });
  const until = Date.now() + 5000;
  while (!(await call('surface.get', { serverId: id })).capture) {
    if (Date.now() > until) throw new Error('no capture');
    await new Promise((r) => setTimeout(r, 20));
  }
  await call('settings.update', { changes: { askBeforeCalls: true } });
  const reply = await call('calls.start', { serverId: id, kind: 'tool', target: 'routed', args: { region: 'eu-west-1', text: 'hi' } });
  assert.equal(reply.started, true, 'routed is read-only, so no confirm');
  const done = Date.now() + 5000;
  let lines = [];
  while (!lines.some((h) => h['mcp-name'] === 'routed')) {
    if (Date.now() > done) throw new Error('the call never went out');
    await new Promise((r) => setTimeout(r, 20));
    try { lines = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)); } catch { lines = []; }
  }
  assert.equal(lines.find((h) => h['mcp-name'] === 'routed')['mcp-param-region'], 'eu-west-1');
});

test('Mcp-Param headers: none on stdio, and a value that is not safe ASCII is base64-wrapped', async () => {
  const { mcpParamHeaders, scanHeaderDeclarations } = await import('../packages/protocol/dist/index.js');
  const scan = scanHeaderDeclarations({ type: 'object', properties: { region: { type: 'string', 'x-mcp-header': 'Region' }, n: { type: 'integer', 'x-mcp-header': 'N' } } });
  assert.equal(scan.valid, true);
  assert.deepEqual(mcpParamHeaders(scan.declarations, { region: 'zürich', n: 3 }), { 'Mcp-Param-Region': `=?base64?${Buffer.from('zürich').toString('base64')}?=`, 'Mcp-Param-N': '3' });
  assert.deepEqual(mcpParamHeaders(scan.declarations, { region: null }), {});
  assert.equal(scanHeaderDeclarations({ type: 'object', properties: { a: { type: 'string', 'x-mcp-header': 'A' }, b: { type: 'string', 'x-mcp-header': 'a' } } }).valid, false, 'case-insensitively unique');
});

test('lint: each rule on its own element', () => {
  assert.deepEqual(lintTool({ name: 'ok', inputSchema: { type: 'object' } }), []);
  assert.match(lintTool({ name: 'x', inputSchema: { type: 'string' } }).join(), /inputSchema does not have type "object"/);
  assert.match(lintTool({ name: 'x', inputSchema: { type: 'object' }, execution: { taskSupport: 'sometimes' } }).join(), /taskSupport/);
  assert.deepEqual(lintPrompt({ name: 'p', arguments: [{ name: 'a', required: true }] }), []);
  assert.match(lintPrompt({ name: 'p', arguments: [{ required: 'yes' }] }).join(), /arguments\[0\]\.name.*arguments\[0\]\.required/);
  assert.deepEqual(lintResource({ uri: 'file:///a', name: 'a', size: 3, annotations: { audience: ['user'], priority: 1 } }), []);
  assert.match(lintResource({ uri: 'file:///a', name: 'a', size: -1, annotations: { priority: 2 } }).join(), /size.*priority/);
  assert.deepEqual(lintResourceTemplate({ uriTemplate: 'file:///{a}/{b}', name: 't' }), []);
  assert.match(lintResourceTemplate({ uriTemplate: 'file:///{a{b}}', name: 't' }).join(), /unbalanced/);
});
