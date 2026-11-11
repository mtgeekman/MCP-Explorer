// Phase 02 acceptance: a keychain round trip on Windows and Linux in CI (D6,
// D25). These tests talk to the REAL OS store -- Credential Manager on Windows,
// Secret Service on Linux -- because the property under test is that the store
// exists and works on the machine, which no mock can say.
//
// They never skip for want of a keychain. A CI job without one must fail here,
// not pass with nothing checked. On Linux the job provides one: a D-Bus session
// with an unlocked gnome-keyring, started by gnome-keyring-daemon --unlock
// inside dbus-run-session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Entry } from '@napi-rs/keyring';

// D25: every entry pins Linux to Secret Service. Unpinned, the binding falls
// back to the kernel keyutils keyring, which does not survive a reboot.
const PIN = { linux: { store: 'secret-service' } };

// A fresh service name per run: a crashed run cannot leave an entry that makes
// the next run pass, and nothing collides with the app's real entries.
const service = `mcp-explorer-test-${randomUUID()}`;

function withEntry(account, fn) {
  const entry = new Entry(service, account, PIN);
  try {
    return fn(entry);
  } finally {
    entry.deletePassword();
  }
}

test('keychain: a secret round-trips through the OS store', () => {
  withEntry('round-trip', (entry) => {
    entry.setPassword('s3cret-value');
    assert.equal(entry.getPassword(), 's3cret-value');
  });
});

test('keychain: a missing entry reads as null, not as an error', () => {
  const entry = new Entry(service, 'never-written', PIN);
  assert.equal(entry.getPassword(), null);
});

test('keychain: writing again replaces the value', () => {
  withEntry('overwrite', (entry) => {
    entry.setPassword('first');
    entry.setPassword('second');
    assert.equal(entry.getPassword(), 'second');
  });
});

test('keychain: delete removes the entry and reports whether one existed', () => {
  const entry = new Entry(service, 'delete', PIN);
  entry.setPassword('doomed');
  assert.equal(entry.deletePassword(), true);
  assert.equal(entry.getPassword(), null);
  assert.equal(entry.deletePassword(), false);
});

// Windows Credential Manager holds at most 2560 bytes of UTF-16: 1280 code
// units. Measured 2026-09-14 on @napi-rs/keyring 2.1.0. Secret Service has no
// comparable limit, so every value in the portable tests stays inside it.
const WINDOWS_MAX_UNITS = 1280;

test('keychain: non-ASCII values survive byte-exact', () => {
  // Server env values and bearer tokens are arbitrary strings; a store that
  // mangles encoding would corrupt a credential silently. The astral character
  // is two UTF-16 code units, the case most likely to be split or replaced.
  const value = 'café-中文-\u{1F600}-'.repeat(100);
  assert.ok(value.length <= WINDOWS_MAX_UNITS);
  withEntry('unicode', (entry) => {
    entry.setPassword(value);
    assert.equal(entry.getPassword(), value);
  });
});

test('keychain: Windows refuses a value longer than 1280 UTF-16 code units', {
  skip: process.platform !== 'win32' && 'the limit is a Credential Manager property',
}, () => {
  // Pinned because it constrains the secret store's design: an OAuth access
  // token can exceed it. If the binding lifts or lowers the limit, this fails
  // and the design note gets revisited rather than discovered in the field.
  withEntry('limit', (entry) => {
    entry.setPassword('x'.repeat(WINDOWS_MAX_UNITS));
    assert.equal(entry.getPassword().length, WINDOWS_MAX_UNITS);
    assert.throws(() => entry.setPassword('x'.repeat(WINDOWS_MAX_UNITS + 1)), /platform limit/);
  });
});

test('keychain: accounts under one service are independent', () => {
  // Every workspace key shares the one app service name (spec D31 keeps server
  // secrets out of the keychain), so accounts must not collide.
  const a = new Entry(service, 'account-a', PIN);
  const b = new Entry(service, 'account-b', PIN);
  try {
    a.setPassword('alpha');
    b.setPassword('beta');
    assert.equal(a.getPassword(), 'alpha');
    assert.equal(b.getPassword(), 'beta');
  } finally {
    a.deletePassword();
    b.deletePassword();
  }
});

// D22: with no Secret Service, the pinned store refuses. Run in a child so the
// broken D-Bus address cannot leak into the round-trip tests above.
const refusalChild = `
  import { Entry } from '@napi-rs/keyring';
  try {
    new Entry('mcp-explorer-test-refusal', 'acct', { linux: { store: 'secret-service' } })
      .setPassword('must-not-be-stored');
    console.log('STORED');
  } catch (err) {
    console.log('REFUSED ' + err.message);
  }
`;

test('keychain: with no Secret Service, the pinned store refuses (D22)', {
  skip: process.platform !== 'linux' && 'Secret Service exists only on Linux',
}, () => {
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', refusalChild], {
    encoding: 'utf8',
    // An -e module resolves bare specifiers from the working directory.
    cwd: new URL('../', import.meta.url),
    env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: 'unix:path=/nonexistent/mcp-explorer-test-bus' },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^REFUSED /, `expected a refusal, got: ${run.stdout}${run.stderr}`);
});

// --- workspaces against the real store ----------------------------------------
//
// The storage tests use an in-memory store (test/support/memory-store.mjs):
// test files run in parallel, and Credential Manager loses updates under
// concurrent writers. The one end-to-end check that a keychain-custody
// workspace works against the real OS store lives here, in the only file that
// writes the real store, so it never races another file.

test('keychain: a keychain-custody workspace is created, reopened and restored through the real store', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { createWorkspaceDb, openWorkspaceDb, keychainStore, workspaceKeyAccount, KeyMissingError } = await import('../packages/storage/dist/index.js');
  const store = keychainStore(service);
  const dir = mkdtempSync(join(tmpdir(), 'mcpx-kcws-'));
  const workspaceId = randomUUID();
  const req = { path: join(dir, 'w.db'), workspaceId, name: 'real store', custody: { kind: 'keychain' }, secrets: store };
  try {
    const created = createWorkspaceDb(req);
    created.db.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('kept')");
    const recoveryKey = created.recoveryKey;
    created.close();

    const reopened = openWorkspaceDb(req);
    assert.equal(reopened.db.prepare('SELECT v FROM t').get().v, 'kept');
    reopened.close();

    store.delete(workspaceKeyAccount(workspaceId));
    assert.throws(() => openWorkspaceDb(req), KeyMissingError);
    const rescued = openWorkspaceDb({ ...req, custody: { kind: 'recovery', recoveryKey } });
    rescued.storeKeyInKeychain();
    rescued.close();
    openWorkspaceDb(req).close();
  } finally {
    try { store.delete(workspaceKeyAccount(workspaceId)); } catch { /* the entry names this run's test service */ }
    rmSync(dir, { recursive: true, force: true });
  }
});
