// D27: forward-only migrations, pinned by golden databases, schema dumps and
// checksums. The golden files are written by `npm run golden:db` when a
// migration is added, and never regenerated after that.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createWorkspaceDb, openWorkspaceDb, workspaceKeyAccount, migrate,
  MIGRATIONS, SCHEMA_VERSION, NewerSchemaError, MigrationFailedError,
} from '../packages/storage/dist/index.js';
import { memoryStore } from './support/memory-store.mjs';
import { dumpSchema, rowCounts, seedEveryTable, tableNames } from './golden/golden-support.mjs';

const Sqlite = createRequire(import.meta.url)('better-sqlite3-multiple-ciphers');
const golden = fileURLToPath(new URL('./golden/', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'mcpx-mig-'));
const secrets = memoryStore();
const keyed = [];
after(() => {
  for (const id of keyed) { try { secrets.delete(workspaceKeyAccount(id)); } catch { /* the test run is over; a leftover entry names its test service */ } }
  rmSync(dir, { recursive: true, force: true });
});

const noSecrets = { get: () => null, set: () => { throw new Error('unexpected keychain write'); }, delete: () => false };
function plain(overrides = {}) {
  const workspaceId = randomUUID();
  return { path: join(dir, `${workspaceId}.db`), workspaceId, name: 'migration test', custody: { kind: 'none' }, secrets: noSecrets, ...overrides };
}
const userVersion = (db) => db.pragma('user_version', { simple: true });

// --- the migration list itself ----------------------------------------------

test('migrations are numbered contiguously from 1, with unique names', () => {
  assert.deepEqual(MIGRATIONS.map((m) => m.version), MIGRATIONS.map((_, i) => i + 1));
  assert.equal(new Set(MIGRATIONS.map((m) => m.name)).size, MIGRATIONS.length);
  assert.equal(SCHEMA_VERSION, MIGRATIONS.length);
});

test('no released migration has been edited, and every migration is released', () => {
  // A mismatch means a migration's SQL changed after `npm run golden:db`
  // recorded it. Fix mistakes with a new migration; never edit the old one.
  const recorded = JSON.parse(readFileSync(join(golden, 'migration-checksums.json'), 'utf8'));
  for (const m of MIGRATIONS) {
    const sum = createHash('sha256').update(m.sql).digest('hex');
    assert.equal(recorded[m.version], sum, `migration ${m.version} (${m.name}): checksum ${recorded[m.version] ? 'changed' : 'not recorded -- run npm run golden:db'}`);
  }
  assert.deepEqual(Object.keys(recorded).map(Number).sort((a, b) => a - b), MIGRATIONS.map((m) => m.version));
});

test('every schema version has its golden files', () => {
  for (const m of MIGRATIONS) {
    for (const f of [`v${m.version}.db`, `v${m.version}.json`, `schema-v${m.version}.sql`]) {
      assert.ok(existsSync(join(golden, f)), `${f} missing -- run npm run golden:db`);
    }
  }
});

// --- fresh and golden databases ---------------------------------------------

test('a new workspace is at the newest schema, with the pinned schema and its settings row', () => {
  const ws = createWorkspaceDb(plain({ now: () => 42 }));
  try {
    assert.equal(userVersion(ws.db), SCHEMA_VERSION);
    assert.equal(dumpSchema(ws.db), readFileSync(join(golden, `schema-v${SCHEMA_VERSION}.sql`), 'utf8'));
    assert.deepEqual({ ...ws.db.prepare('SELECT * FROM workspace_meta').get() }, {
      id: 1, name: 'migration test', created_at: 42, persist_results: 1,
      retention_max_bytes: 524_288_000, retention_max_age_days: 90,
    });
  } finally {
    ws.close();
  }
});

test('a new workspace takes no backup: there was nothing to lose', () => {
  const r = plain();
  createWorkspaceDb(r).close();
  assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith(`${r.workspaceId}.db.`)), []);
});

for (const file of readdirSync(golden).filter((f) => /^v\d+\.db$/.test(f))) {
  const version = Number(file.slice(1, -3));
  test(`golden schema ${version} upgrades to the newest schema and keeps every row`, () => {
    const r = plain();
    copyFileSync(join(golden, file), r.path);
    const expected = JSON.parse(readFileSync(join(golden, `v${version}.json`), 'utf8'));
    const ws = openWorkspaceDb(r);
    try {
      assert.equal(userVersion(ws.db), SCHEMA_VERSION);
      const fresh = createWorkspaceDb(plain());
      try {
        assert.equal(dumpSchema(ws.db), dumpSchema(fresh.db), 'an upgraded database must match a new one exactly');
      } finally {
        fresh.close();
      }
      const counts = rowCounts(ws.db);
      for (const [table, n] of Object.entries(expected.rowCounts)) {
        assert.ok(table in counts, `table ${table} disappeared`);
        assert.ok(counts[table] >= n, `${table} had ${n} rows at schema ${version}, has ${counts[table]}`);
      }
      assert.equal(ws.db.prepare('SELECT request_state FROM call_round WHERE call_id = 1 AND seq = 1').get().request_state.toString('hex'), '00ff01',
        'request_state must survive migration byte-exact');
    } finally {
      ws.close();
    }
  });
}

// --- refusal, rollback, backups -----------------------------------------------

test('a workspace from a newer app is refused and left untouched', () => {
  const r = plain();
  createWorkspaceDb(r).close();
  const raw = new Sqlite(r.path);
  raw.pragma(`user_version = ${SCHEMA_VERSION + 1}`);
  raw.close();
  const before = readFileSync(r.path);

  assert.throws(() => openWorkspaceDb(r), (err) => err instanceof NewerSchemaError && new RegExp(`schema ${SCHEMA_VERSION + 1}`).test(err.message));
  assert.ok(readFileSync(r.path).equals(before), 'the file changed');
  assert.deepEqual(readdirSync(dir).filter((f) => f.startsWith(`${r.workspaceId}.db.`)), []);
});

const extra = (version, sql, name = `test-${version}`) => ({ version, name, sql });

test('a failing migration rolls back whole, keeps earlier ones, and names the backup', () => {
  const r = plain();
  const ws = createWorkspaceDb(r);
  try {
    const list = [
      ...MIGRATIONS,
      extra(SCHEMA_VERSION + 1, 'CREATE TABLE kept (a INTEGER) STRICT;'),
      extra(SCHEMA_VERSION + 2, 'CREATE TABLE half (a INTEGER) STRICT; CREATE TABLE broken ('),
    ];
    assert.throws(() => migrate(ws.db, r.path, list), (err) =>
      err instanceof MigrationFailedError
      && new RegExp(`still at schema ${SCHEMA_VERSION + 1}`).test(err.message)
      && err.message.includes(`${r.path}.v${SCHEMA_VERSION}.bak`));
    assert.equal(userVersion(ws.db), SCHEMA_VERSION + 1);
    const tables = tableNames(ws.db);
    assert.ok(tables.includes('kept'));
    assert.ok(!tables.includes('half'), 'a statement before the failing one in the same migration was not rolled back');
  } finally {
    ws.close();
  }

  const backup = new Sqlite(`${r.path}.v${SCHEMA_VERSION}.bak`, { fileMustExist: true });
  try {
    assert.equal(userVersion(backup), SCHEMA_VERSION);
    assert.ok(!tableNames(backup).includes('kept'), 'the backup was taken after migrating');
  } finally {
    backup.close();
  }
});

test('a second upgrade attempt does not overwrite the first backup', () => {
  const r = plain();
  const ws = createWorkspaceDb(r);
  try {
    const failing = [...MIGRATIONS, extra(SCHEMA_VERSION + 1, 'CREATE TABLE broken (')];
    assert.throws(() => migrate(ws.db, r.path, failing), MigrationFailedError);
    const first = readFileSync(`${r.path}.v${SCHEMA_VERSION}.bak`);
    ws.db.exec("UPDATE workspace_meta SET name = 'changed between attempts'");
    assert.throws(() => migrate(ws.db, r.path, failing), (err) => err.message.includes(`${r.path}.v${SCHEMA_VERSION}.2.bak`));
    assert.ok(readFileSync(`${r.path}.v${SCHEMA_VERSION}.bak`).equals(first));
  } finally {
    ws.close();
  }
});

test('the backup of an encrypted workspace is encrypted', () => {
  const r = { ...plain(), custody: { kind: 'keychain' }, secrets };
  keyed.push(r.workspaceId);
  const ws = createWorkspaceDb(r);
  try {
    migrate(ws.db, r.path, [...MIGRATIONS, extra(SCHEMA_VERSION + 1, 'CREATE TABLE later (a INTEGER) STRICT;')]);
  } finally {
    ws.close();
  }
  const bytes = readFileSync(`${r.path}.v${SCHEMA_VERSION}.bak`);
  assert.notEqual(bytes.subarray(0, 15).toString('latin1'), 'SQLite format 3');
  assert.equal(bytes.includes('migration test'), false, 'the workspace name is readable in the backup');
});

test('an up-to-date workspace migrates nothing and takes no backup', () => {
  const r = plain();
  const ws = createWorkspaceDb(r);
  try {
    assert.deepEqual(migrate(ws.db, r.path), { from: SCHEMA_VERSION, to: SCHEMA_VERSION, backupPath: null });
  } finally {
    ws.close();
  }
});

// --- the schema's own guarantees --------------------------------------------

test('schema: types, enumerations and shapes are enforced by the database', () => {
  const ws = createWorkspaceDb(plain());
  const t = 1;
  const rejects = (sql, ...params) => assert.throws(() => ws.db.prepare(sql).run(...params), /constraint|cannot store|datatype/i, sql);
  try {
    ws.db.prepare("INSERT INTO server (id, name, transport, command, created_at) VALUES ('s', 'n', 'stdio', 'node', ?)").run(t);
    rejects("INSERT INTO server (id, name, transport, command, created_at) VALUES ('x', 'n', 'stdio', 'node', 'yesterday')");
    rejects("INSERT INTO server (id, name, transport, command, created_at) VALUES ('x', 'n', 'websocket', 'node', ?)", t);
    rejects("INSERT INTO server (id, name, transport, url, created_at) VALUES ('x', 'n', 'stdio', 'https://a', ?)", t);
    rejects("INSERT INTO server (id, name, transport, command, args_json, created_at) VALUES ('x', 'n', 'stdio', 'node', 'not json', ?)", t);
    rejects("INSERT INTO workspace_meta (id, name, created_at) VALUES (2, 'second', ?)", t);
    rejects("INSERT INTO call (server_id, kind, target, status, started_at) VALUES ('s', 'tool', 'x', 'finished', ?)", t);
    rejects("INSERT INTO call (server_id, kind, target, status, started_at, finished_at) VALUES ('s', 'tool', 'x', 'in_progress', ?, ?)", t, t);
    ws.db.prepare("INSERT INTO connection (id, server_id, opened_at) VALUES (1, 's', ?)").run(t);
    rejects("INSERT INTO frame (connection_id, direction, at, message_json, result_withheld) VALUES (1, 'in', ?, NULL, 0)", t);
    rejects("INSERT INTO frame (connection_id, direction, at, message_json, result_withheld) VALUES (1, 'in', ?, '{}', 1)", t);
  } finally {
    ws.close();
  }
});

test('the SQLite binding enforces foreign keys by default', () => {
  // The storage package sets no foreign_keys pragma: the binding is compiled
  // with SQLITE_DEFAULT_FOREIGN_KEYS=1. If an upgrade changes that, cascades
  // and references silently stop working, so this pins it.
  const raw = new Sqlite(':memory:');
  try {
    assert.equal(raw.pragma('foreign_keys', { simple: true }), 1);
    assert.ok(raw.pragma('compile_options').some((r) => r.compile_options === 'DEFAULT_FOREIGN_KEYS'));
  } finally {
    raw.close();
  }
});

test('schema: foreign keys are enforced on every open, not just at create', () => {
  const r = plain();
  createWorkspaceDb(r).close();
  const ws = openWorkspaceDb(r);
  try {
    assert.equal(ws.db.pragma('foreign_keys', { simple: true }), 1);
    assert.throws(() => ws.db.prepare("INSERT INTO call_round (call_id, seq, started_at) VALUES (999, 1, 1)").run(), /FOREIGN KEY/);
  } finally {
    ws.close();
  }
});

test('schema: deleting a server removes its history', () => {
  // Retention (D24) deletes whole calls; a server removal must not orphan rows.
  // Seeded into a new database, not a golden copy: a golden file carries the
  // schema as it was when frozen, so it cannot test the migrations as they are.
  const ws = createWorkspaceDb(plain());
  try {
    seedEveryTable(ws.db);
    ws.db.prepare("DELETE FROM server WHERE id = 'srv-1'").run();
    const counts = rowCounts(ws.db);
    for (const table of ['connection', 'surface_snapshot', 'snapshot_tool', 'surface_observation', 'call', 'call_round', 'frame']) {
      assert.equal(counts[table], 0, `${table} kept rows of a deleted server`);
    }
    assert.equal(counts.server, 1);
  } finally {
    ws.close();
  }
});
