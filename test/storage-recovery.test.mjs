// Recovery keys (D28 B): the encoding, and what a workspace does with one.
//
// Once a recovery key has been shown to a user, its format is a promise: a key
// written down today must open the workspace after any upgrade. The fixed
// vectors below pin the format; changing them is a format break, not a test
// update.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  encodeRecoveryKey, decodeRecoveryKey, InvalidRecoveryKeyError, StorageError,
  createWorkspaceDb, openWorkspaceDb, workspaceKeyAccount,
  WrongKeyError, KeyMissingError, InvalidWorkspaceRequestError,
} from '../packages/storage/dist/index.js';
import { memoryStore } from './support/memory-store.mjs';

// --- encoding ---------------------------------------------------------------

const FORMAT = /^MCPX1(-[0-9A-HJKMNP-TV-Z]{4}){14}$/;

test('recovery key: fixed vectors pin the format', () => {
  // Checked by hand for the first groups: bytes 00 01 02 are bits
  // 00000 00000 00000 10000 ... -> "000G"; the all-ones key ends in one
  // remaining 1 bit padded with four zeros -> "G".
  assert.equal(encodeRecoveryKey(Buffer.alloc(32)),
    'MCPX1-0000-0000-0000-0000-0000-0000-0000-0000-0000-0000-0000-0000-0000-CSM7');
  assert.equal(encodeRecoveryKey(Buffer.alloc(32, 0xff)),
    'MCPX1-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZG-NYB1');
  assert.equal(encodeRecoveryKey(Buffer.from('000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f', 'hex')),
    'MCPX1-000G-40R4-0M30-E209-185G-R38E-1W81-24GK-2GAH-C5RR-34D1-P70X-3RFG-CC6W');
});

test('recovery key: random keys round-trip and match the format', () => {
  for (let i = 0; i < 200; i++) {
    const key = randomBytes(32);
    const text = encodeRecoveryKey(key);
    assert.match(text, FORMAT);
    assert.ok(decodeRecoveryKey(text).equals(key), text);
  }
});

test('recovery key: case, spacing and Crockford look-alikes are forgiven', () => {
  const key = randomBytes(32);
  const text = encodeRecoveryKey(key);
  const variants = [
    text.toLowerCase(),
    text.replace(/-/g, ''),
    text.replace(/-/g, ' '),
    `  ${text.replace(/-/g, ' - ')}\n`,
    text.replace(/1/g, 'l').replace(/0/g, 'O'),
    text.replace(/1/g, 'I').replace(/0/g, 'o'),
  ];
  for (const v of variants) assert.ok(decodeRecoveryKey(v).equals(key), v);
});

test('recovery key: every single-character typo is reported as mistyped, never decoded', () => {
  // A mistyped key must not decode to some other key, which would surface as
  // WrongKeyError -- "this is not your workspace". Exhaustive for one key.
  const key = Buffer.from('7f3a9c21e84b56d0a1f2e3c4b5a69788796a5b4c3d2e1f00ffeeddccbbaa9988', 'hex');
  const compact = encodeRecoveryKey(key).replace(/-/g, '').slice('MCPX1'.length);
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let typos = 0;
  for (let i = 0; i < compact.length; i++) {
    for (const ch of alphabet) {
      if (ch === compact[i]) continue;
      const typo = `MCPX1${compact.slice(0, i)}${ch}${compact.slice(i + 1)}`;
      assert.throws(() => decodeRecoveryKey(typo), InvalidRecoveryKeyError, `position ${i} -> ${ch}`);
      typos++;
    }
  }
  assert.equal(typos, 56 * 31);
});

test('recovery key: a swapped pair of characters is reported as mistyped', () => {
  const key = Buffer.from('7f3a9c21e84b56d0a1f2e3c4b5a69788796a5b4c3d2e1f00ffeeddccbbaa9988', 'hex');
  const compact = encodeRecoveryKey(key).replace(/-/g, '').slice('MCPX1'.length);
  for (let i = 0; i + 1 < compact.length; i++) {
    if (compact[i] === compact[i + 1]) continue;
    const swapped = `MCPX1${compact.slice(0, i)}${compact[i + 1]}${compact[i]}${compact.slice(i + 2)}`;
    assert.throws(() => decodeRecoveryKey(swapped), InvalidRecoveryKeyError, `swap at ${i}`);
  }
});

test('recovery key: malformed input is refused with a reason', () => {
  const text = encodeRecoveryKey(randomBytes(32));
  const cases = [
    [text.replace('MCPX1', 'MCPX2'), /must start with MCPX1/],
    [text.slice(0, -1), /55 characters/],
    [`${text}0`, /57 characters/],
    [text.slice(0, -1) + 'U', /"U"/],
    ['', /must start with MCPX1/],
  ];
  for (const [input, reason] of cases) {
    assert.throws(() => decodeRecoveryKey(input), (err) => err instanceof InvalidRecoveryKeyError && reason.test(err.message), input);
  }
});

test('recovery key: a non-canonical final key character is refused, not ignored', () => {
  // The 52nd character carries one key bit and four padding bits. Setting a
  // padding bit changes the text without changing the key; accepting it would
  // make two different strings open the same workspace.
  const key = Buffer.alloc(32);
  const compact = encodeRecoveryKey(key).replace(/-/g, '').slice('MCPX1'.length);
  const padded = `MCPX1${compact.slice(0, 51)}1${compact.slice(52)}`;
  assert.throws(() => decodeRecoveryKey(padded), InvalidRecoveryKeyError);
});

test('recovery key: only a 32-byte key can be encoded', () => {
  assert.throws(() => encodeRecoveryKey(Buffer.alloc(16)), StorageError);
});

// --- workspaces -------------------------------------------------------------

const secrets = memoryStore();
const usedIds = [];
const dir = mkdtempSync(join(tmpdir(), 'mcpx-rec-'));
after(() => {
  for (const id of usedIds) {
    try { secrets.delete(workspaceKeyAccount(id)); } catch { /* reported by the store's own error; nothing to add here */ }
  }
  rmSync(dir, { recursive: true, force: true });
});

function req(custody, overrides = {}) {
  const workspaceId = randomUUID();
  usedIds.push(workspaceId);
  return { path: join(dir, `${workspaceId}.db`), workspaceId, name: `test ${workspaceId}`, custody, secrets, ...overrides };
}
const KEYCHAIN = { kind: 'keychain' };
const recovery = (recoveryKey) => ({ kind: 'recovery', recoveryKey });

function seed(ws) {
  ws.db.exec("CREATE TABLE t (v TEXT); INSERT INTO t VALUES ('kept')");
  return ws;
}
const read = (ws) => { try { return ws.db.prepare('SELECT v FROM t').get().v; } finally { ws.db.close(); } };

test('workspace: only keychain custody has a recovery key, and it encodes the stored key', () => {
  const r = req(KEYCHAIN);
  const ws = createWorkspaceDb(r);
  assert.match(ws.recoveryKey, FORMAT);
  assert.equal(decodeRecoveryKey(ws.recoveryKey).toString('hex'), secrets.get(workspaceKeyAccount(r.workspaceId)));
  ws.close();
  for (const custody of [{ kind: 'none' }, { kind: 'passphrase', passphrase: 'pp' }]) {
    const other = createWorkspaceDb(req(custody));
    assert.equal(other.recoveryKey, null);
    other.close();
  }
});

test('workspace: the recovery key opens it after the keychain entry is gone, and restores the entry', () => {
  const r = req(KEYCHAIN);
  const created = seed(createWorkspaceDb(r));
  const recoveryKey = created.recoveryKey;
  created.close();

  secrets.delete(workspaceKeyAccount(r.workspaceId));
  assert.throws(() => openWorkspaceDb(r), KeyMissingError);

  const rescued = openWorkspaceDb({ ...r, custody: recovery(recoveryKey) });
  assert.equal(rescued.recoveryKey, recoveryKey);
  assert.equal(secrets.get(workspaceKeyAccount(r.workspaceId)), null, 'opening with a recovery key must not write the keychain by itself');
  rescued.storeKeyInKeychain();
  assert.equal(read(rescued), 'kept');

  assert.equal(read(openWorkspaceDb(r)), 'kept');
});

test('workspace: another workspace\'s recovery key is WrongKeyError', () => {
  const a = createWorkspaceDb(req(KEYCHAIN));
  const b = req(KEYCHAIN);
  createWorkspaceDb(b).close();
  assert.throws(() => openWorkspaceDb({ ...b, custody: recovery(a.recoveryKey) }), WrongKeyError);
  a.close();
});

test('workspace: a mistyped recovery key is InvalidRecoveryKeyError', () => {
  const r = req(KEYCHAIN);
  const ws = createWorkspaceDb(r);
  const typo = ws.recoveryKey.slice(0, -1) + (ws.recoveryKey.endsWith('0') ? '1' : '0');
  ws.close();
  assert.throws(() => openWorkspaceDb({ ...r, custody: recovery(typo) }), InvalidRecoveryKeyError);
});

test('workspace: a recovery key cannot create a workspace', () => {
  const r = req(recovery(encodeRecoveryKey(randomBytes(32))));
  assert.throws(() => createWorkspaceDb(r), InvalidWorkspaceRequestError);
  assert.equal(existsSync(r.path), false);
});

test('workspace: storeKeyInKeychain replaces a wrong entry with the key that opened the database', () => {
  const r = req(KEYCHAIN);
  const created = createWorkspaceDb(r);
  const recoveryKey = created.recoveryKey;
  created.close();
  secrets.set(workspaceKeyAccount(r.workspaceId), randomBytes(32).toString('hex'));
  assert.throws(() => openWorkspaceDb(r), WrongKeyError);

  const rescued = openWorkspaceDb({ ...r, custody: recovery(recoveryKey) });
  rescued.storeKeyInKeychain();
  rescued.close();
  openWorkspaceDb(r).close();
});

test('workspace: storeKeyInKeychain refuses a workspace with no keychain-held key', () => {
  for (const custody of [{ kind: 'none' }, { kind: 'passphrase', passphrase: 'pp' }]) {
    const ws = createWorkspaceDb(req(custody));
    assert.throws(() => ws.storeKeyInKeychain(), InvalidWorkspaceRequestError);
    ws.close();
  }
});

test('workspace: closing never touches the keychain', () => {
  // Self-repair on close was dropped (spec D28 correction, 2026-09-14): the
  // entries it would have repaired were hidden by a full store, not lost.
  const calls = { get: 0, set: 0, delete: 0 };
  const data = new Map();
  const store = {
    get: (a) => { calls.get++; return data.get(a) ?? null; },
    set: (a, v) => { calls.set++; data.set(a, v); },
    delete: (a) => { calls.delete++; return data.delete(a); },
  };
  const ws = createWorkspaceDb(req(KEYCHAIN, { secrets: store }));
  const before = { ...calls };
  ws.close();
  assert.deepEqual(calls, before);
});
