import { Entry } from '@napi-rs/keyring';
import { SecretStoreUnavailableError, SecretWriteUnconfirmedError } from './errors.js';

/**
 * The secret store abstraction (D6). Implementations hold values in an OS
 * credential store and nowhere else: there is no file-backed implementation,
 * and there must never be one.
 */
export interface SecretStore {
  /**
   * The stored value, or null when the store answers and holds none. With
   * `patient`, a missing value is re-read for a while before null is
   * believed: use it wherever null means data loss, such as a workspace key.
   */
  get(account: string, options?: { patient?: boolean }): string | null;
  /** Returns only once the value has been read back from the store. */
  set(account: string, value: string): void;
  /**
   * True when an entry existed and was removed. Returns only once the entry
   * reads back as absent.
   */
  delete(account: string): boolean;
}

/** The keychain service every real entry is filed under. */
export const APP_SERVICE = 'mcp-explorer';

/**
 * D25: on Linux, Secret Service or nothing. Unpinned, the binding silently
 * falls back to the kernel keyutils keyring, which is in-memory and does not
 * survive a reboot -- a workspace key stored there would take the database
 * with it. The option is ignored on Windows and macOS.
 *
 * test/storage-gates.test.mjs fails any `new Entry(` in packages/ that does
 * not pass this constant.
 */
export const KEYRING_PIN = { linux: { store: 'secret-service' } } as const;

// The store itself is unreachable -- D22's case -- when keyring-rs reports
// NoStorageAccess, or a PlatformFailure that came from D-Bus (no session bus,
// or no Secret Service on it). A PlatformFailure carrying a Windows error code
// is NOT that: Credential Manager throws "Windows error code 8" under
// concurrent writers on a store that is present and working (measured
// 2026-09-14), and calling it unavailable tells the user their platform
// cannot hold secrets. Anything else -- a Windows error, a value over
// Credential Manager's size limit -- is a real error and propagates untouched.
//
// macOS Keychain's wording has never been observed (D11): its errors
// propagate unclassified until someone sees them.
const UNAVAILABLE = /^(Platform failure: DBus error|Couldn't access platform storage)/;

function guard<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof Error && UNAVAILABLE.test(err.message)) {
      throw new SecretStoreUnavailableError(`no OS credential store is available: ${err.message}`, { cause: err });
    }
    throw err;
  }
}

/**
 * The raw OS store, one call per operation, errors exactly as the binding
 * throws them. Separate from the policy in `storeOver` so that policy can be
 * tested against a backend that fails on command; the real store fails only
 * under load, and not on demand.
 */
export interface KeychainBackend {
  get(account: string): string | null;
  set(account: string, value: string): void;
  delete(account: string): boolean;
}

export function entryBackend(service: string): KeychainBackend {
  const entry = (account: string) => new Entry(service, account, KEYRING_PIN);
  return {
    get: (account) => entry(account).getPassword() ?? null,
    set: (account, value) => entry(account).setPassword(value),
    delete: (account) => entry(account).deletePassword(),
  };
}

// Windows Credential Manager under concurrent writers, measured 2026-09-14
// with six processes: writes throw "Windows error code 8"; writes succeed and
// read back seconds later (up to 4075 ms seen); and roughly one write in sixty
// never reads back at all within 10 s. The policy below is confirm-and-retry:
// no write is reported done until it reads back, a transient error or an
// unconfirmed write is retried, and a missing value is re-read before a caller
// that would lose data because of it is told null.
const TRANSIENT = /^Platform failure: Windows error code \d+$/;

export interface RetryPolicy {
  /** Writes (or deletes) attempted before giving up. */
  attempts: number;
  /** How long one attempt waits to see its own effect before rewriting. */
  confirmMs: number;
  /** How long a patient get re-reads a missing value. */
  patienceMs: number;
  /** First delay between reads; doubles up to maxDelayMs. */
  initialDelayMs: number;
  maxDelayMs: number;
  /**
   * Blocking: the storage API is synchronous, like the SQLite binding under
   * it. Whatever hosts this package must not be a thread that renders UI.
   */
  sleep(ms: number): void;
  now(): number;
}

const blockingSleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// A write can be lost outright, so each attempt waits a little over half the
// worst delay observed before rewriting; three attempts outlast it.
export const DEFAULT_RETRY: RetryPolicy = {
  attempts: 3,
  confirmMs: 2_500,
  patienceMs: 6_000,
  initialDelayMs: 25,
  maxDelayMs: 500,
  sleep: blockingSleep,
  now: Date.now,
};

const isTransient = (err: unknown) => err instanceof Error && TRANSIENT.test(err.message);

/** Error classification plus confirm-and-retry over a backend. Not exported from the package. */
export function storeOver(backend: KeychainBackend, policy: RetryPolicy = DEFAULT_RETRY): SecretStore {
  /**
   * Calls `op` until it succeeds or `windowMs` passes, sleeping between tries.
   * `accept` decides whether a result is final; a transient binding error is
   * never final. Returns the last result or transient error seen.
   */
  function retry<T>(op: () => T, accept: (value: T) => boolean, windowMs: number): { ok: boolean; last: T | Error } {
    const deadline = policy.now() + windowMs;
    let delay = policy.initialDelayMs;
    for (;;) {
      let last: T | Error;
      try {
        last = guard(op);
        if (accept(last)) return { ok: true, last };
      } catch (err) {
        if (!isTransient(err)) throw err;
        last = err as Error;
      }
      if (policy.now() >= deadline) return { ok: false, last };
      policy.sleep(delay);
      delay = Math.min(delay * 2, policy.maxDelayMs);
    }
  }

  const describe = (last: unknown) =>
    last instanceof Error ? `the store failed: ${last.message}` : last === null ? 'it read back as absent' : 'it read back as a different value';

  /**
   * Writes until the store shows the effect. Each attempt retries a transient
   * refusal for up to confirmMs, then reads back for up to confirmMs; an
   * attempt that sees neither is rewritten. No value appears in the error.
   */
  function writeConfirmed<T>(what: { verb: string; account: string }, write: () => T, shows: (read: string | null) => boolean): T[] {
    const results: T[] = [];
    let problem = 'no attempt was made';
    for (let attempt = 1; attempt <= policy.attempts; attempt++) {
      const wrote = retry(write, () => true, policy.confirmMs);
      if (!wrote.ok) {
        problem = describe(wrote.last);
        continue;
      }
      results.push(wrote.last as T);
      const seen = retry(() => backend.get(what.account), shows, policy.confirmMs);
      if (seen.ok) return results;
      problem = describe(seen.last);
    }
    throw new SecretWriteUnconfirmedError(`${what.verb} ${what.account} was not confirmed after ${policy.attempts} attempts; ${problem}`);
  }

  return {
    get(account, options) {
      // A null is believed at once unless patient. A transient error is never
      // an answer, so it is retried for at least confirmMs either way.
      const nullWindow = options?.patient ? policy.patienceMs : 0;
      const start = policy.now();
      const read = retry(() => backend.get(account), (v) => v !== null || policy.now() - start >= nullWindow,
        Math.max(nullWindow, policy.confirmMs));
      if (read.last instanceof Error) throw read.last;
      return read.last;
    },
    set(account, value) {
      writeConfirmed({ verb: 'writing', account }, () => backend.set(account, value), (v) => v === value);
    },
    delete(account) {
      return writeConfirmed({ verb: 'deleting', account }, () => backend.delete(account), (v) => v === null).some(Boolean);
    },
  };
}

/** Windows Credential Manager, Linux Secret Service, or macOS Keychain. */
export function keychainStore(service: string = APP_SERVICE): SecretStore {
  return storeOver(entryBackend(service));
}
