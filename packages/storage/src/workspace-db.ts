import { randomBytes } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { InvalidWorkspaceRequestError, KeyMissingError, StorageError, WrongKeyError } from './errors.js';
import { decodeRecoveryKey, encodeRecoveryKey } from './recovery.js';
import type { SecretStore } from './secrets.js';
import { constructDatabase, type Database } from './sqlite.js';

/**
 * How a workspace database's key is held (D4, D5).
 *
 * - `none`: the user turned encryption off for this workspace (D4 makes it
 *   their call). The file is plain SQLite.
 * - `keychain`: a random 256-bit key, generated at creation, held in the OS
 *   credential store and nowhere else.
 * - `passphrase`: SQLCipher derives the key from a passphrase typed at open.
 *   Nothing is stored, so the keychain alone cannot open it.
 * - `recovery`: open only. A keychain-custody workspace opened with its
 *   recovery key instead of the keychain (D28 B), for when the keychain entry
 *   is gone.
 */
export type Custody =
  | { kind: 'none' }
  | { kind: 'keychain' }
  | { kind: 'passphrase'; passphrase: string }
  | { kind: 'recovery'; recoveryKey: string };

/** An open workspace database, and the key it was opened with. */
export interface Workspace {
  readonly db: Database;
  /**
   * The recovery key for a keychain-custody workspace (also when opened with
   * its recovery key), null for other custodies. Encoded from the key held in
   * memory, so it is available whenever the workspace is open.
   */
  readonly recoveryKey: string | null;
  /**
   * Writes this workspace's key to the keychain, replacing whatever entry is
   * there. For a workspace opened with its recovery key, this is the step that
   * makes the keychain open it again; it runs only when called. Confirmed like
   * every write (secrets.ts). Throws for a workspace with no keychain-held key.
   */
  storeKeyInKeychain(): void;
  close(): void;
}

export interface WorkspaceDbRequest {
  path: string;
  workspaceId: string;
  custody: Custody;
  secrets: SecretStore;
}

export function workspaceKeyAccount(workspaceId: string): string {
  return `workspace-key/${workspaceId}`;
}

// SQLite3 Multiple Ciphers reads these key strings as RAW keys and skips the
// KDF (measured 2026-09-14: 0.9 ms to open instead of 137 ms). A passphrase of
// that shape would silently get no stretching at all, so it is refused. The
// keychain path uses the x'' form deliberately.
const RAW_KEY_SHAPE = /^(x'.*'|raw:)/is;

function validate(req: WorkspaceDbRequest): void {
  if (!req.workspaceId) throw new InvalidWorkspaceRequestError('workspace id is empty');
  if (req.custody.kind !== 'passphrase') return;
  // An empty key is SQLCipher's "no encryption": the file would be written in
  // plaintext while the workspace claimed to be protected.
  if (req.custody.passphrase.length === 0) {
    throw new InvalidWorkspaceRequestError('passphrase is empty');
  }
  if (RAW_KEY_SHAPE.test(req.custody.passphrase)) {
    throw new InvalidWorkspaceRequestError("passphrase cannot start with raw: or be wrapped in x'...'; SQLCipher would treat it as a raw key and skip key derivation");
  }
}

function keyMaterial(custody: Custody, keychainHex: string | null): Buffer | null {
  switch (custody.kind) {
    case 'none':
      return null;
    case 'keychain':
      return Buffer.from(`x'${keychainHex}'`, 'utf8');
    case 'recovery':
      return Buffer.from(`x'${keychainHex}'`, 'utf8');
    case 'passphrase':
      return Buffer.from(custody.passphrase, 'utf8');
  }
}

function workspace(db: Database, secrets: SecretStore, workspaceId: string, keyHex: string | null): Workspace {
  return {
    db,
    recoveryKey: keyHex === null ? null : encodeRecoveryKey(Buffer.from(keyHex, 'hex')),
    storeKeyInKeychain() {
      if (keyHex === null) throw new InvalidWorkspaceRequestError(`workspace ${workspaceId} has no keychain-held key`);
      secrets.set(workspaceKeyAccount(workspaceId), keyHex);
    },
    close() {
      db.close();
    },
  };
}

/**
 * D26. The cipher is set before the key on every encrypted open, and read back
 * afterwards: the library default is chacha20, so a missed pragma produces a
 * database that opens today and fails to open under the pinned configuration.
 */
function applyKey(db: Database, key: Buffer | null): void {
  if (key === null) return;
  db.pragma(`cipher='sqlcipher'`);
  db.pragma('legacy=4');
  db.key(key);
  const cipher = db.pragma('cipher', { simple: true });
  if (cipher !== 'sqlcipher') {
    throw new StorageError(`cipher configuration did not apply: connection reports ${String(cipher)}`);
  }
}

/** Reads the schema table, which is the first thing that needs the right key. */
function verifyReadable(db: Database, custody: Custody): void {
  try {
    db.prepare('SELECT count(*) FROM sqlite_master').get();
  } catch (err) {
    if ((err as { code?: string }).code === 'SQLITE_NOTADB') {
      const why = custody.kind === 'none'
        ? 'the file is encrypted, or is not a database'
        : 'the key does not open this database, or the file is not one';
      throw new WrongKeyError(why, { cause: err });
    }
    throw err;
  }
}

/**
 * Creates a new workspace database file. Refuses to touch an existing file,
 * and refuses to reuse a keychain key left behind under the same workspace id:
 * overwriting it could lock another database out, and adopting it would open
 * a database the caller did not mean to.
 */
export function createWorkspaceDb(req: WorkspaceDbRequest): Workspace {
  if (req.custody.kind === 'recovery') {
    throw new InvalidWorkspaceRequestError('a recovery key opens an existing workspace; it cannot create one');
  }
  validate(req);
  if (existsSync(req.path)) {
    throw new InvalidWorkspaceRequestError(`a file already exists at ${req.path}`);
  }

  const account = workspaceKeyAccount(req.workspaceId);
  let keychainHex: string | null = null;
  if (req.custody.kind === 'keychain') {
    if (req.secrets.get(account) !== null) {
      throw new InvalidWorkspaceRequestError(`the keychain already holds a key for workspace ${req.workspaceId}`);
    }
    keychainHex = randomBytes(32).toString('hex');
    // set() returns only once the key reads back (confirm-and-retry, see
    // secrets.ts), so nothing below encrypts with a key the store did not keep.
    // An unconfirmed write may still land later, so it is removed too.
    try {
      req.secrets.set(account, keychainHex);
    } catch (err) {
      throw withKeyRemoved(req.secrets, account, err);
    }
  }

  let db: Database | null = null;
  try {
    db = constructDatabase(req.path, { fileMustExist: false });
    applyKey(db, keyMaterial(req.custody, keychainHex));
    // SQLite writes nothing until the first write. Force page 1 out now, so
    // the file on disk is already encrypted before anyone else can see it.
    db.pragma('user_version = 0');
    return workspace(db, req.secrets, req.workspaceId, keychainHex);
  } catch (err) {
    db?.close();
    rmSync(req.path, { force: true });
    throw keychainHex !== null ? withKeyRemoved(req.secrets, account, err) : err;
  }
}

/**
 * Removes a key after a failed create and returns the error to throw. If the
 * removal fails too, both failures are reported: a key left in the keychain
 * with no database is invisible to the user otherwise.
 */
function withKeyRemoved(secrets: SecretStore, account: string, original: unknown): unknown {
  try {
    secrets.delete(account);
    return original;
  } catch (cleanup) {
    return new StorageError(`creating the workspace failed, and its key could not be removed from the keychain (${account})`, {
      cause: new AggregateError([original, cleanup]),
    });
  }
}

/**
 * Opens an existing workspace database, failing with a typed error. Opening
 * with a recovery key does not touch the keychain; call storeKeyInKeychain()
 * to put the key back.
 */
export function openWorkspaceDb(req: WorkspaceDbRequest): Workspace {
  validate(req);
  if (!existsSync(req.path)) {
    throw new InvalidWorkspaceRequestError(`no workspace database at ${req.path}`);
  }

  let keychainHex: string | null = null;
  if (req.custody.kind === 'keychain') {
    // Patient: a key written moments ago can read back as absent for seconds
    // on Windows, and KeyMissingError tells the user their data is gone.
    keychainHex = req.secrets.get(workspaceKeyAccount(req.workspaceId), { patient: true });
    if (keychainHex === null) {
      // Not necessarily gone: a full Windows Credential Manager reads some
      // existing entries as absent until space is freed (measured 2026-09-14).
      throw new KeyMissingError(`the keychain returned no key for workspace ${req.workspaceId}; if the credential store is full, freeing space may bring it back, otherwise open it with its recovery key`);
    }
  } else if (req.custody.kind === 'recovery') {
    keychainHex = decodeRecoveryKey(req.custody.recoveryKey).toString('hex');
  }

  const db = constructDatabase(req.path, { fileMustExist: true });
  try {
    applyKey(db, keyMaterial(req.custody, keychainHex));
    verifyReadable(db, req.custody);
    return workspace(db, req.secrets, req.workspaceId, keychainHex);
  } catch (err) {
    db.close();
    throw err;
  }
}
