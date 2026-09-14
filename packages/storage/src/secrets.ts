import { Entry } from '@napi-rs/keyring';
import { SecretStoreUnavailableError } from './errors.js';

/**
 * The secret store abstraction (D6). Implementations hold values in an OS
 * credential store and nowhere else: there is no file-backed implementation,
 * and there must never be one.
 */
export interface SecretStore {
  /** The stored value, or null when the store answers and holds none. */
  get(account: string): string | null;
  set(account: string, value: string): void;
  /** True when an entry existed and was removed. */
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
export type KeychainBackend = SecretStore;

export function entryBackend(service: string): KeychainBackend {
  const entry = (account: string) => new Entry(service, account, KEYRING_PIN);
  return {
    get: (account) => entry(account).getPassword() ?? null,
    set: (account, value) => entry(account).setPassword(value),
    delete: (account) => entry(account).deletePassword(),
  };
}

/** Error classification over a backend. Not exported from the package. */
export function storeOver(backend: KeychainBackend): SecretStore {
  return {
    get: (account) => guard(() => backend.get(account)),
    set: (account, value) => guard(() => backend.set(account, value)),
    delete: (account) => guard(() => backend.delete(account)),
  };
}

/** Windows Credential Manager, Linux Secret Service, or macOS Keychain. */
export function keychainStore(service: string = APP_SERVICE): SecretStore {
  return storeOver(entryBackend(service));
}
