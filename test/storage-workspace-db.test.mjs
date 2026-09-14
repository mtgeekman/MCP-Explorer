// Phase 02 step 2: opening workspace databases (D4, D5, D22, D26).
//
// Against the REAL keychain, under a service name unique to this run, because
// "a passphrase workspace is unreadable from the keychain alone" is a claim
// about the keychain, not about a stand-in for it. A fake store appears only
// where the point is to make the store fail on command.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  createWorkspaceDb, openWorkspaceDb, keychainStore, workspaceKeyAccount,
  WrongKeyError, KeyMissingError, SecretStoreUnavailableError, InvalidWorkspaceRequestError,
} from '../packages/storage/dist/index.js';

const Sqlite = createRequire(import.meta.url)('better-sqlite3-multiple-ciphers');

const secrets = keychainStore(`mcp-explorer-test-${randomUUID()}`);
const usedIds = [];
const dir = mkdtempSync(join(tmpdir(), 'mcpx-ws-'));
after(() => {
  for (const id of usedIds) secrets.delete(workspaceKeyAccount(id));
  rmSync(dir, { recursive: true, force: true });
});

function workspace(custody, overrides = {}) {
  const workspaceId = randomUUID();
  usedIds.push(workspaceId);
  return { path: join(dir, `${workspaceId}.db`), workspaceId, custody, secrets, ...overrides };
}

const KEYCHAIN = { kind: 'keychain' };
const pass = (passphrase) => ({ kind: 'passphrase', passphrase });
const SENTINEL = 'sentinel-7f3a-plaintext-must-not-appear';

function writeSentinel(db) {
  db.exec('CREATE TABLE t (v TEXT)');
  db.prepare('INSERT INTO t VALUES (?)').run(SENTINEL);
  db.close();
}
const readSentinel = (db) => {
  try { return db.prepare('SELECT v FROM t').get().v; } finally { db.close(); }
};
const header = (path) => readFileSync(path).subarray(0, 15).toString('latin1');

// --- keychain custody -------------------------------------------------------

test('keychain workspace: data round-trips, and the file holds no plaintext', () => {
  const req = workspace(KEYCHAIN);
  writeSentinel(createWorkspaceDb(req));

  const bytes = readFileSync(req.path);
  assert.equal(bytes.includes(SENTINEL), false, 'sentinel found in the file bytes');
  assert.notEqual(header(req.path), 'SQLite format 3', 'the SQLite header is readable');
  assert.match(secrets.get(workspaceKeyAccount(req.workspaceId)), /^[0-9a-f]{64}$/);

  assert.equal(readSentinel(openWorkspaceDb(req)), SENTINEL);
});

test('a freshly created workspace is already encrypted on disk, before any write', () => {
  // SQLite defers writing the file until the first write; create forces page 1
  // out, so no window exists in which an empty plaintext file sits on disk.
  const req = workspace(KEYCHAIN);
  createWorkspaceDb(req).close();
  assert.ok(readFileSync(req.path).length > 0, 'create left an empty file');
  assert.notEqual(header(req.path), 'SQLite format 3');
});

test('keychain workspace: the file is unreadable without its key', () => {
  const req = workspace(KEYCHAIN);
  writeSentinel(createWorkspaceDb(req));
  const db = new Sqlite(req.path, { fileMustExist: true });
  try {
    assert.throws(() => db.prepare('SELECT count(*) FROM sqlite_master').get(), { code: 'SQLITE_NOTADB' });
  } finally {
    db.close();
  }
});

test('keychain workspace: the file is SQLCipher v4, not the library default (D26)', () => {
  // Dies if the cipher pragma is dropped: the file would then be chacha20 and
  // the sqlcipher open below would fail, while the chacha20 one would succeed.
  const req = workspace(KEYCHAIN);
  writeSentinel(createWorkspaceDb(req));
  const key = Buffer.from(`x'${secrets.get(workspaceKeyAccount(req.workspaceId))}'`);

  const openAs = (cipher, extra) => {
    const db = new Sqlite(req.path, { fileMustExist: true });
    try {
      db.pragma(`cipher='${cipher}'`);
      if (extra) db.pragma(extra);
      db.key(key);
      return db.prepare('SELECT v FROM t').get().v;
    } finally {
      db.close();
    }
  };
  assert.equal(openAs('sqlcipher', 'legacy=4'), SENTINEL);
  assert.throws(() => openAs('chacha20'), { code: 'SQLITE_NOTADB' });
});

test('keychain workspace: a missing key is KeyMissingError, and no key is invented', () => {
  const req = workspace(KEYCHAIN);
  writeSentinel(createWorkspaceDb(req));
  secrets.delete(workspaceKeyAccount(req.workspaceId));

  assert.throws(() => openWorkspaceDb(req), KeyMissingError);
  assert.equal(secrets.get(workspaceKeyAccount(req.workspaceId)), null);
});

test('keychain workspace: a different key in the keychain is WrongKeyError', () => {
  const req = workspace(KEYCHAIN);
  writeSentinel(createWorkspaceDb(req));
  secrets.set(workspaceKeyAccount(req.workspaceId), randomBytes(32).toString('hex'));
  assert.throws(() => openWorkspaceDb(req), WrongKeyError);
});

test('create refuses to reuse a key already in the keychain for that id', () => {
  const req = workspace(KEYCHAIN);
  const existing = randomBytes(32).toString('hex');
  secrets.set(workspaceKeyAccount(req.workspaceId), existing);

  assert.throws(() => createWorkspaceDb(req), InvalidWorkspaceRequestError);
  assert.equal(existsSync(req.path), false);
  assert.equal(secrets.get(workspaceKeyAccount(req.workspaceId)), existing, 'the existing key was overwritten');
});

test('create refuses an existing file, and stores no key', () => {
  const req = workspace(KEYCHAIN);
  createWorkspaceDb(workspace({ kind: 'none' }, { path: req.path })).close();

  assert.throws(() => createWorkspaceDb(req), InvalidWorkspaceRequestError);
  assert.equal(secrets.get(workspaceKeyAccount(req.workspaceId)), null);
});

test('a failed create removes the key it stored', () => {
  const req = workspace(KEYCHAIN, { path: join(dir, 'no-such-directory', 'x.db') });
  assert.throws(() => createWorkspaceDb(req));
  assert.equal(secrets.get(workspaceKeyAccount(req.workspaceId)), null, 'an orphaned key was left in the keychain');
});

test('an unavailable secret store fails create before any file exists (D22)', () => {
  const unavailable = {
    get: () => null,
    set: () => { throw new SecretStoreUnavailableError('no Secret Service'); },
    delete: () => false,
  };
  const req = workspace(KEYCHAIN, { secrets: unavailable });
  assert.throws(() => createWorkspaceDb(req), SecretStoreUnavailableError);
  assert.equal(existsSync(req.path), false);
});

test('keychainStore reports a missing Secret Service as SecretStoreUnavailableError (D22)', {
  skip: process.platform !== 'linux' && 'Secret Service exists only on Linux',
}, () => {
  const child = `
    const { keychainStore, SecretStoreUnavailableError } = await import(${JSON.stringify(new URL('../packages/storage/dist/index.js', import.meta.url).href)});
    try { keychainStore('mcp-explorer-test-refusal').set('a', 'b'); console.log('STORED'); }
    catch (err) { console.log(err instanceof SecretStoreUnavailableError ? 'UNAVAILABLE' : 'OTHER ' + err.message); }
  `;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', child], {
    encoding: 'utf8',
    env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nonexistent/mcp-explorer-test-bus' },
  });
  assert.equal(run.stdout.trim(), 'UNAVAILABLE', run.stderr);
});

// --- passphrase custody -----------------------------------------------------

test('passphrase workspace: opens with the passphrase, not with a wrong one', () => {
  const req = workspace(pass('correct horse battery staple'));
  writeSentinel(createWorkspaceDb(req));
  assert.equal(readFileSync(req.path).includes(SENTINEL), false);

  assert.equal(readSentinel(openWorkspaceDb(req)), SENTINEL);
  assert.throws(() => openWorkspaceDb({ ...req, custody: pass('correct horse battery stapler') }), WrongKeyError);
});

test('passphrase workspace: stores nothing in the keychain, and the keychain alone cannot open it', () => {
  const req = workspace(pass('only in my head'));
  writeSentinel(createWorkspaceDb(req));
  assert.equal(secrets.get(workspaceKeyAccount(req.workspaceId)), null);

  // Even with a key planted under its id, a keychain open fails.
  secrets.set(workspaceKeyAccount(req.workspaceId), randomBytes(32).toString('hex'));
  assert.throws(() => openWorkspaceDb({ ...req, custody: KEYCHAIN }), WrongKeyError);
});

test('an empty passphrase is refused: SQLCipher would write plaintext', () => {
  const req = workspace(pass(''));
  assert.throws(() => createWorkspaceDb(req), InvalidWorkspaceRequestError);
  assert.equal(existsSync(req.path), false);
});

test('raw-key-shaped passphrases are refused: they would skip key derivation', () => {
  const hex = 'ab'.repeat(32);
  for (const p of [`x'${hex}'`, `X'${hex.toUpperCase()}'`, `raw:${hex}`, `RAW:${hex}`, "x''"]) {
    const req = workspace(pass(p));
    assert.throws(() => createWorkspaceDb(req), InvalidWorkspaceRequestError, p);
    assert.equal(existsSync(req.path), false, p);
  }
});

test('passphrases with quotes and non-ASCII characters round-trip', () => {
  const phrase = `it's "café" 中文 \u{1F600} x'`;
  const req = workspace(pass(phrase));
  writeSentinel(createWorkspaceDb(req));
  assert.equal(readSentinel(openWorkspaceDb(req)), SENTINEL);
});

// --- no encryption ----------------------------------------------------------

test('an unencrypted workspace is plain SQLite, and says so', () => {
  const req = workspace({ kind: 'none' });
  writeSentinel(createWorkspaceDb(req));
  assert.equal(header(req.path), 'SQLite format 3');
  assert.equal(readSentinel(openWorkspaceDb(req)), SENTINEL);
});

test('opening an encrypted workspace as unencrypted is WrongKeyError', () => {
  const req = workspace(KEYCHAIN);
  writeSentinel(createWorkspaceDb(req));
  assert.throws(() => openWorkspaceDb({ ...req, custody: { kind: 'none' } }), WrongKeyError);
});

test('opening an unencrypted workspace with a key is WrongKeyError', () => {
  const req = workspace({ kind: 'none' });
  writeSentinel(createWorkspaceDb(req));
  secrets.set(workspaceKeyAccount(req.workspaceId), randomBytes(32).toString('hex'));
  assert.throws(() => openWorkspaceDb({ ...req, custody: KEYCHAIN }), WrongKeyError);
});

test('opening a path with no database is refused', () => {
  assert.throws(() => openWorkspaceDb(workspace({ kind: 'none' })), InvalidWorkspaceRequestError);
});
