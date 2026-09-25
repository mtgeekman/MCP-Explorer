// Server definitions and their secrets (spec D31), and the phase 02
// acceptance test: no secret value appears in any file the app writes.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  createWorkspaceDb, openWorkspaceDb, workspaceKeyAccount, migrate, MIGRATIONS, SCHEMA_VERSION,
  addToRegistry, saveServer, loadServer, listServers, deleteServer,
  InvalidServerDefinitionError, SecretsRequireEncryptionError,
} from '../packages/storage/dist/index.js';
import { memoryStore } from './support/memory-store.mjs';

const root = mkdtempSync(join(tmpdir(), 'mcpx-srv-'));
const secrets = memoryStore();
const keyed = [];
after(() => {
  for (const id of keyed) { try { secrets.delete(workspaceKeyAccount(id)); } catch { /* a leftover entry names its test service */ } }
  rmSync(root, { recursive: true, force: true });
});

const noSecrets = { get: () => null, set: () => { throw new Error('unexpected keychain write'); }, delete: () => false };
function create(custody, dir = mkdtempSync(join(root, 'w-'))) {
  const workspaceId = randomUUID();
  const req = { path: join(dir, `${workspaceId}.db`), workspaceId, name: 'servers test', custody, secrets: custody.kind === 'keychain' ? secrets : noSecrets };
  if (custody.kind === 'keychain') keyed.push(workspaceId);
  return { req, ws: createWorkspaceDb(req), dir };
}

const stdio = (overrides = {}) => ({
  id: randomUUID(), name: 'filesystem', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
  env: { LOG_LEVEL: 'debug' }, secretEnv: { GITHUB_TOKEN: 'ghp_example' }, ...overrides,
});
const http = (overrides = {}) => ({
  id: randomUUID(), name: 'remote', transport: 'streamable-http', url: 'https://mcp.example.test/mcp',
  headers: { Accept: 'application/json' }, secretHeaders: { Authorization: 'Bearer example' }, ...overrides,
});

// --- definitions --------------------------------------------------------------

test('servers: a definition round-trips with its secrets', () => {
  const { ws } = create({ kind: 'keychain' });
  try {
    const a = stdio({ cwd: '/work' });
    const b = http();
    saveServer(ws, a);
    saveServer(ws, b);
    assert.deepEqual(loadServer(ws, a.id), a);
    assert.deepEqual(loadServer(ws, b.id), b);
    assert.equal(loadServer(ws, 'missing'), null);
  } finally {
    ws.close();
  }
});

test('servers: an OAuth-sized token is stored whole', () => {
  // The reason for D31: Credential Manager refuses values over 1280 UTF-16 units.
  const { ws } = create({ kind: 'keychain' });
  try {
    const token = 'eyJ' + 'x'.repeat(8000);
    const def = http({ secretHeaders: { Authorization: `Bearer ${token}` } });
    saveServer(ws, def);
    assert.equal(loadServer(ws, def.id).secretHeaders.Authorization.length, token.length + 7);
  } finally {
    ws.close();
  }
});

test('servers: saving again replaces secrets, including removing ones no longer given', () => {
  const { ws } = create({ kind: 'keychain' });
  try {
    const def = stdio({ secretEnv: { A: '1', B: '2' } });
    saveServer(ws, def);
    saveServer(ws, { ...def, secretEnv: { B: '3' } });
    assert.deepEqual(loadServer(ws, def.id).secretEnv, { B: '3' });
    saveServer(ws, { ...def, secretEnv: undefined });
    assert.equal(loadServer(ws, def.id).secretEnv, undefined);
  } finally {
    ws.close();
  }
});

test('servers: editing a definition keeps its detected protocol era (D20)', () => {
  const { ws } = create({ kind: 'keychain' });
  try {
    const def = stdio();
    saveServer(ws, def, () => 100);
    ws.db.prepare("UPDATE server SET detected_revision = '2026-07-28', detected_era = 'modern', era_detected_at = 200 WHERE id = ?").run(def.id);
    saveServer(ws, { ...def, name: 'renamed' }, () => 300);
    assert.deepEqual({ ...ws.db.prepare('SELECT name, detected_revision, detected_era, era_detected_at, created_at FROM server WHERE id = ?').get(def.id) },
      { name: 'renamed', detected_revision: '2026-07-28', detected_era: 'modern', era_detected_at: 200, created_at: 100 });
  } finally {
    ws.close();
  }
});

test('servers: list gives names and transports only, and delete removes secrets with the server', () => {
  const { ws } = create({ kind: 'keychain' });
  try {
    const a = stdio({ name: 'b-server' }); const b = http({ name: 'a-server' });
    saveServer(ws, a);
    saveServer(ws, b);
    assert.deepEqual(listServers(ws).map((s) => ({ ...s })), [
      { id: b.id, name: 'a-server', transport: 'streamable-http' },
      { id: a.id, name: 'b-server', transport: 'stdio' },
    ]);
    assert.equal(deleteServer(ws, a.id), true);
    assert.equal(deleteServer(ws, a.id), false);
    assert.equal(ws.db.prepare('SELECT count(*) AS n FROM server_secret WHERE server_id = ?').get(a.id).n, 0);
  } finally {
    ws.close();
  }
});

test('servers: malformed definitions are refused before anything is written', () => {
  const { ws } = create({ kind: 'keychain' });
  try {
    const cases = [
      [stdio({ command: undefined }), /needs a command/],
      [stdio({ url: 'https://x' }), /has no url/],
      [stdio({ secretHeaders: { Authorization: 'x' } }), /has no HTTP headers/],
      [http({ url: undefined }), /needs a url/],
      [http({ command: 'node' }), /has no command, args or cwd/],
      [stdio({ transport: 'websocket' }), /unknown transport/],
      [stdio({ env: { TOKEN: 'plain' }, secretEnv: { TOKEN: 'secret' } }), /TOKEN is both plain and secret/],
      [http({ headers: { Authorization: 'x' }, secretHeaders: { Authorization: 'y' } }), /Authorization is both plain and secret/],
      [stdio({ secretEnv: { '': 'x' } }), /empty name/],
      [stdio({ name: '' }), /name is empty/],
    ];
    for (const [def, reason] of cases) {
      assert.throws(() => saveServer(ws, def), (err) => err instanceof InvalidServerDefinitionError && reason.test(err.message), reason.source);
    }
    assert.deepEqual(listServers(ws), []);
  } finally {
    ws.close();
  }
});

test('servers: a failure part-way through a save leaves the previous definition whole', () => {
  const { ws } = create({ kind: 'keychain' });
  try {
    const def = stdio({ secretEnv: { A: 'old' } });
    saveServer(ws, def);
    ws.db.exec('CREATE TRIGGER no_b BEFORE INSERT ON server_secret WHEN NEW.name = \'B\' BEGIN SELECT RAISE(ABORT, \'refused\'); END');
    assert.throws(() => saveServer(ws, { ...def, name: 'changed', secretEnv: { A: 'new', B: 'x' } }), /refused/);
    assert.deepEqual(loadServer(ws, def.id), def);
  } finally {
    ws.close();
  }
});

// --- D31: never readable on disk ----------------------------------------------

test('servers: an unencrypted workspace refuses secrets and writes nothing', () => {
  const { ws, req } = create({ kind: 'none' });
  try {
    assert.throws(() => saveServer(ws, stdio()), SecretsRequireEncryptionError);
    assert.throws(() => saveServer(ws, http()), SecretsRequireEncryptionError);
    assert.deepEqual(listServers(ws), []);
    const plainOnly = stdio({ secretEnv: {} });
    saveServer(ws, plainOnly);
    assert.deepEqual(loadServer(ws, plainOnly.id).env, { LOG_LEVEL: 'debug' });
  } finally {
    ws.close();
  }
  assert.equal(readFileSync(req.path).includes('ghp_example'), false);
});

/** Every file under `dir`, recursively. */
function files(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

/** Where `needle` appears in any file, in the encodings a secret could be written in. */
function findOnDisk(dir, needle) {
  const forms = [Buffer.from(needle, 'utf8'), Buffer.from(needle, 'utf16le'), Buffer.from(Buffer.from(needle).toString('base64')), Buffer.from(Buffer.from(needle).toString('hex'))];
  return files(dir).filter((p) => { const bytes = readFileSync(p); return forms.some((f) => bytes.includes(f)); });
}

test('acceptance: no secret value appears in any file the app writes', () => {
  // Every file storage writes in one directory: two encrypted workspaces
  // (keychain and passphrase), the registry, and a pre-upgrade backup of each.
  // The plain env value is the positive control: it must be found, or the scan
  // is not looking at what it thinks it is.
  const dir = mkdtempSync(join(root, 'disk-'));
  const envSecret = `env-secret-${randomUUID()}`;
  const headerSecret = `header-secret-${randomUUID()}`;
  const plainValue = `plain-config-${randomUUID()}`;
  const registry = join(dir, 'workspaces.json');

  for (const custody of [{ kind: 'keychain' }, { kind: 'passphrase', passphrase: 'correct horse battery staple' }]) {
    const { req, ws } = create(custody, dir);
    try {
      saveServer(ws, stdio({ env: { NOT_SECRET: plainValue }, secretEnv: { TOKEN: envSecret } }));
      saveServer(ws, http({ secretHeaders: { Authorization: `Bearer ${headerSecret}` } }));
      migrate(ws.db, req.path, [...MIGRATIONS, { version: SCHEMA_VERSION + 1, name: 'probe', sql: 'CREATE TABLE probe (a INTEGER) STRICT;' }]);
      addToRegistry(registry, { id: req.workspaceId, path: req.path, custody: custody.kind, createdAt: 1, ...(custody.kind === 'keychain' ? { name: 'disk test' } : {}) });
    } finally {
      ws.close();
    }
  }
  const unencrypted = create({ kind: 'none' }, dir);
  saveServer(unencrypted.ws, stdio({ env: { NOT_SECRET: plainValue }, secretEnv: {} }));
  unencrypted.ws.close();

  const written = files(dir).map((p) => p.slice(dir.length + 1)).sort();
  assert.ok(written.some((f) => f.endsWith('.bak')), `no backup was written: ${written.join(', ')}`);
  assert.ok(written.includes('workspaces.json'));
  assert.deepEqual(findOnDisk(dir, envSecret), [], 'an environment secret is readable on disk');
  assert.deepEqual(findOnDisk(dir, headerSecret), [], 'a header secret is readable on disk');
  assert.deepEqual(findOnDisk(dir, plainValue).map((p) => p.slice(dir.length + 1)), [unencrypted.req.path.slice(dir.length + 1)],
    'positive control: the plain value must be found in the unencrypted workspace, and only there');
});

test('acceptance: the keychain holds workspace keys and no server secret', () => {
  const writes = [];
  const recording = { get: (a) => secrets.get(a), set: (a, v) => { writes.push([a, v]); secrets.set(a, v); }, delete: (a) => secrets.delete(a) };
  const workspaceId = randomUUID();
  keyed.push(workspaceId);
  const dir = mkdtempSync(join(root, 'kc-'));
  const ws = createWorkspaceDb({ path: join(dir, 'k.db'), workspaceId, name: 'kc', custody: { kind: 'keychain' }, secrets: recording });
  try {
    saveServer(ws, stdio({ secretEnv: { TOKEN: 'never-in-keychain' } }));
    ws.storeKeyInKeychain();
  } finally {
    ws.close();
  }
  assert.ok(writes.length >= 1);
  for (const [account, value] of writes) {
    assert.equal(account, workspaceKeyAccount(workspaceId));
    assert.match(value, /^[0-9a-f]{64}$/);
  }
});

test('servers: an encrypted workspace reopened with its key reads its secrets back', () => {
  const { req, ws } = create({ kind: 'passphrase', passphrase: 'pp-servers' });
  const def = http();
  saveServer(ws, def);
  ws.close();
  const again = openWorkspaceDb(req);
  try {
    assert.deepEqual(loadServer(again, def.id), def);
  } finally {
    again.close();
  }
});

// --- secrets without stored values (D31, amended 2026-09-24) ------------------------

test('servers: an unencrypted workspace keeps the names of the secrets a server needs, never their values', () => {
  const { ws, req } = create({ kind: 'none' });
  try {
    const { secretEnv: _e, ...a } = stdio({ unstoredSecrets: { env: ['API_KEY', 'GITHUB_TOKEN'] } });
    const { secretHeaders: _h, ...b } = http({ unstoredSecrets: { headers: ['Authorization'] } });
    saveServer(ws, a);
    saveServer(ws, b);
    assert.deepEqual(loadServer(ws, a.id), a);
    assert.deepEqual(loadServer(ws, b.id), b);
  } finally {
    ws.close();
  }
  assert.equal(readFileSync(req.path).includes('ghp_example'), false);
});

test('servers: saving again replaces the unstored names, and deleting the server removes them', () => {
  const { ws } = create({ kind: 'none' });
  try {
    const a = stdio({ secretEnv: undefined, unstoredSecrets: { env: ['OLD'] } });
    saveServer(ws, a);
    saveServer(ws, { ...a, unstoredSecrets: { env: ['NEW'] } });
    assert.deepEqual(loadServer(ws, a.id).unstoredSecrets, { env: ['NEW'] });
    deleteServer(ws, a.id);
    assert.equal(ws.db.prepare('SELECT count(*) AS n FROM server_secret_name').get().n, 0);
  } finally {
    ws.close();
  }
});

test('servers: an encrypted workspace can hold some values and ask for others', () => {
  const { ws } = create({ kind: 'keychain' });
  try {
    const a = stdio({ unstoredSecrets: { env: ['ASK_EACH_TIME'] } });
    saveServer(ws, a);
    assert.deepEqual(loadServer(ws, a.id), a);
  } finally {
    ws.close();
  }
});

test('servers: a secret name given twice, or also plain, is refused', () => {
  const { ws } = create({ kind: 'keychain' });
  try {
    assert.throws(() => saveServer(ws, stdio({ unstoredSecrets: { env: ['GITHUB_TOKEN'] } })), /GITHUB_TOKEN is given twice/);
    assert.throws(() => saveServer(ws, stdio({ secretEnv: undefined, unstoredSecrets: { env: ['LOG_LEVEL'] } })), /LOG_LEVEL is both plain and secret/);
    assert.throws(() => saveServer(ws, stdio({ secretEnv: undefined, unstoredSecrets: { env: ['X', 'X'] } })), /X is given twice/);
    assert.throws(() => saveServer(ws, stdio({ secretEnv: undefined, unstoredSecrets: { headers: ['Authorization'] } })), /has no HTTP headers/);
    assert.throws(() => saveServer(ws, stdio({ secretEnv: undefined, unstoredSecrets: { env: [''] } })), /empty name/);
    assert.deepEqual(listServers(ws), []);
  } finally {
    ws.close();
  }
});
