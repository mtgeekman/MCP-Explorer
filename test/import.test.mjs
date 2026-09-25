// Config import end to end through the backend (phase 05): where the four
// clients' files are looked for, reading only what was picked, and saving
// only what was kept. The acceptance line: a secret found in an imported
// entry is stored as a workspace secret and appears in no file the app writes
// outside the encrypted database.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { userConfigLocations, projectConfigLocations } from '../packages/platform/dist/index.js';
import { loadServer, readDetectedEra, pinEra } from '../packages/storage/dist/index.js';
import { Backend } from '../packages/backend/dist/index.js';
import { memoryStore } from './support/memory-store.mjs';

const root = mkdtempSync(join(tmpdir(), 'mcpx-import-'));
const backends = [];
after(async () => {
  for (const b of backends) await b.shutdown();
  rmSync(root, { recursive: true, force: true });
});

async function setup(protection = { kind: 'keychain' }) {
  const dataDir = mkdtempSync(join(root, 'data-'));
  const backend = new Backend({ dataDir, secrets: memoryStore() });
  backends.push(backend);
  const call = (method, params = {}) => backend.request(method, params);
  const opened = await call('workspaces.create', { name: 'W', protection });
  return { backend, call, dataDir, opened };
}

/** A project folder holding the given files, relative path to contents. */
function project(files) {
  const dir = mkdtempSync(join(root, 'project-'));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

/** Every file under `dir`, with its bytes. */
function filesUnder(dir) {
  return readdirSync(dir, { recursive: true }).map((rel) => join(dir, rel)).filter((p) => statSync(p).isFile()).map((p) => [p, readFileSync(p)]);
}

const SECRET = 'sk-live-0123456789abcdef-import-test';
const withSecret = JSON.stringify({ mcpServers: { api: { command: 'node', args: ['api.js'], env: { API_KEY: SECRET, MODE: 'dev', TOKEN_FROM_ENV: '${env:T}' } } } });

// --- where files are looked for -------------------------------------------------------

test('locations: Windows user files, including the Microsoft Store Claude Desktop and managed Claude Code', () => {
  const l = userConfigLocations({ platform: 'win32', home: 'C:\\Users\\me', env: { APPDATA: 'C:\\Users\\me\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local', ProgramFiles: 'C:\\Program Files' } });
  assert.deepEqual(l.map((x) => [x.client, x.layout, x.scope, x.path]), [
    ['claude-desktop', 'mcpServers', 'user', 'C:\\Users\\me\\AppData\\Roaming\\Claude\\claude_desktop_config.json'],
    ['claude-desktop', 'mcpServers', 'user', 'C:\\Users\\me\\AppData\\Local\\Packages\\Claude_pzs8sxrjxfjjc\\LocalCache\\Roaming\\Claude\\claude_desktop_config.json'],
    ['claude-code', 'claude-code-user', 'user', 'C:\\Users\\me\\.claude.json'],
    ['claude-code', 'mcpServers', 'managed', 'C:\\Program Files\\ClaudeCode\\managed-mcp.json'],
    ['vscode', 'vscode', 'user', 'C:\\Users\\me\\AppData\\Roaming\\Code\\User\\mcp.json'],
    ['vscode', 'vscode-settings', 'user', 'C:\\Users\\me\\AppData\\Roaming\\Code\\User\\settings.json'],
    ['vscode', 'mcpServers', 'user', 'C:\\Users\\me\\.copilot\\mcp-config.json'],
    ['cursor', 'mcpServers', 'user', 'C:\\Users\\me\\.cursor\\mcp.json'],
  ]);
});

test('locations: Linux honours XDG_CONFIG_HOME and falls back to ~/.config; macOS is listed though not built', () => {
  const xdg = userConfigLocations({ platform: 'linux', home: '/home/me', env: { XDG_CONFIG_HOME: '/cfg' } });
  assert.equal(xdg[0].path, '/cfg/Claude/claude_desktop_config.json');
  assert.equal(xdg.find((x) => x.layout === 'vscode').path, '/cfg/Code/User/mcp.json');
  assert.equal(xdg.find((x) => x.scope === 'managed').path, '/etc/claude-code/managed-mcp.json');
  const plain = userConfigLocations({ platform: 'linux', home: '/home/me', env: {} });
  assert.equal(plain[0].path, '/home/me/.config/Claude/claude_desktop_config.json');
  const mac = userConfigLocations({ platform: 'darwin', home: '/Users/me', env: {} });
  assert.equal(mac[0].path, '/Users/me/Library/Application Support/Claude/claude_desktop_config.json');
});

test('locations: a project folder offers its Claude Code, VS Code, dev container and Cursor files', () => {
  const l = projectConfigLocations('/src/app', 'linux');
  assert.deepEqual(l.map((x) => [x.client, x.layout, x.path, x.projectRoot]), [
    ['claude-code', 'mcpServers', '/src/app/.mcp.json', '/src/app'],
    ['vscode', 'vscode', '/src/app/.vscode/mcp.json', '/src/app'],
    ['vscode', 'devcontainer', '/src/app/.devcontainer/devcontainer.json', '/src/app'],
    ['vscode', 'devcontainer', '/src/app/.devcontainer.json', '/src/app'],
    ['cursor', 'mcpServers', '/src/app/.cursor/mcp.json', '/src/app'],
  ]);
});

// --- through the backend ------------------------------------------------------------------

test('import.locations marks which files exist and reads none of them', async () => {
  const { call } = await setup();
  const dir = project({ '.cursor/mcp.json': withSecret, '.vscode/mcp.json': '{ not json' });
  const found = (await call('import.locations', { projectRoots: [dir] })).filter((l) => l.projectRoot === dir);
  assert.deepEqual(found.map((l) => [l.client, l.found]), [['claude-code', false], ['vscode', true], ['vscode', false], ['vscode', false], ['cursor', true]]);
  assert.ok(found.every((l) => l.unreadable === undefined));
  assert.ok(found.every((l) => !('entries' in l)), 'listing must not parse');
});

test('import.read parses the picked files; a corrupt, missing or directory path is a problem, not a crash', async () => {
  const { call } = await setup();
  const dir = project({ '.cursor/mcp.json': withSecret, '.vscode/mcp.json': '{ not json' });
  const [cursor, vscode] = projectConfigLocations(dir, process.platform).filter((l) => l.path.includes('mcp.json') && !l.path.endsWith('.mcp.json')).reverse();
  const read = await call('import.read', { locations: [cursor, vscode, { ...cursor, path: join(dir, 'missing.json') }, { ...cursor, path: dir }] });
  assert.deepEqual(read[0].entries.map((e) => e.name), ['api']);
  assert.match(read[1].problems[0], /not valid JSON/);
  assert.deepEqual(read[2].problems, ['The file could not be read: ENOENT.']);
  assert.deepEqual(read[3].problems, ['This is not a file.']);
});

test('acceptance: a marked secret is stored encrypted and its value is in no file the app wrote', async () => {
  const { call, dataDir, backend } = await setup({ kind: 'keychain' });
  const dir = project({ '.cursor/mcp.json': withSecret });
  const [read] = await call('import.read', { locations: [projectConfigLocations(dir, process.platform).at(-1)] });
  const draft = read.entries[0].server;
  assert.deepEqual(draft.suggestedSecrets.env, ['API_KEY']);
  const [row] = await call('import.save', { servers: [{ draft, name: draft.name, secrets: { env: ['API_KEY'], headers: [] } }] });
  const form = await call('servers.get', { id: row.id });
  assert.deepEqual(form.secretEnv, { API_KEY: null }, 'the secret is stored, and its value never crosses back');
  assert.deepEqual(form.env, { MODE: 'dev' });
  assert.deepEqual(form.unstoredSecrets, { env: ['TOKEN_FROM_ENV'] });
  await backend.shutdown();
  for (const [path, bytes] of filesUnder(dataDir)) assert.ok(!bytes.includes(SECRET), `the secret's value is readable in ${path}`);
});

test('an unencrypted workspace keeps a marked secret by name only, and its value is nowhere', async () => {
  const { call, dataDir, backend } = await setup({ kind: 'none' });
  const dir = project({ '.cursor/mcp.json': withSecret });
  const [read] = await call('import.read', { locations: [projectConfigLocations(dir, process.platform).at(-1)] });
  const draft = read.entries[0].server;
  const [row] = await call('import.save', { servers: [{ draft, name: 'renamed', secrets: { env: ['API_KEY'], headers: [] } }] });
  const form = await call('servers.get', { id: row.id });
  assert.equal(form.name, 'renamed');
  assert.equal(form.secretEnv, undefined);
  assert.deepEqual(form.unstoredSecrets, { env: ['API_KEY', 'TOKEN_FROM_ENV'] }, 'names come back sorted');
  await backend.shutdown();
  for (const [path, bytes] of filesUnder(dataDir)) assert.ok(!bytes.includes(SECRET), `the secret's value is readable in ${path}`);
});

test('a plain value left unmarked is saved as plain configuration, as the user chose', async () => {
  const { call } = await setup({ kind: 'keychain' });
  const draft = { name: 'p', transport: 'stdio', command: 'node', env: { API_KEY: 'k' }, headers: {}, askFor: { env: [], headers: [] }, suggestedSecrets: { env: ['API_KEY'], headers: [] } };
  const [row] = await call('import.save', { servers: [{ draft, name: 'p', secrets: { env: [], headers: [] } }] });
  assert.deepEqual((await call('servers.get', { id: row.id })).env, { API_KEY: 'k' });
});

test('replacing an existing server keeps its id, takes the new definition, and forgets its pinned era', async () => {
  const { call, backend } = await setup({ kind: 'keychain' });
  const old = await call('servers.save', { server: { name: 'x', transport: 'stdio', command: 'old' } });
  pinEra(backend['workspaces'].open.ws, old.id, 'modern', '2026-07-28');
  const draft = { name: 'x', transport: 'streamable-http', url: 'https://example.com/mcp', env: {}, headers: {}, askFor: { env: [], headers: [] }, suggestedSecrets: { env: [], headers: [] } };
  const [row] = await call('import.save', { servers: [{ draft, name: 'x', replaceId: old.id, secrets: { env: [], headers: [] } }] });
  assert.equal(row.id, old.id);
  const ws = backend['workspaces'].open.ws;
  assert.equal(loadServer(ws, old.id).url, 'https://example.com/mcp');
  assert.equal(readDetectedEra(ws, old.id), null);
  assert.equal((await call('servers.list')).length, 1);
});

test('a save with one bad choice saves none of them, and says which', async () => {
  const { call } = await setup({ kind: 'keychain' });
  const good = { name: 'a', transport: 'stdio', command: 'node', env: {}, headers: {}, askFor: { env: [], headers: [] }, suggestedSecrets: { env: [], headers: [] } };
  await assert.rejects(
    call('import.save', { servers: [
      { draft: good, name: 'a', secrets: { env: [], headers: [] } },
      { draft: { ...good, name: 'b' }, name: 'b', secrets: { env: ['NOPE'], headers: [] } },
    ] }),
    { name: 'ImportError', message: /b: environment variable NOPE was marked secret but has no value/ },
  );
  await assert.rejects(call('import.save', { servers: [{ draft: good, name: '  ', secrets: { env: [], headers: [] } }] }), { name: 'ImportError' });
  await assert.rejects(call('import.save', { servers: [{ draft: good, name: 'c', replaceId: 'gone', secrets: { env: [], headers: [] } }] }), /no longer exists/);
  assert.deepEqual(await call('servers.list'), []);
});
