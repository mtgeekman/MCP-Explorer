// The secret store's policy over the raw OS backend: how binding errors are
// classified, and (from the confirm-and-retry fix) how writes are confirmed.
//
// A scripted backend stands in for the OS store because the failures under
// test -- Credential Manager's transient errors and delayed or lost writes --
// happen only under concurrent load and cannot be produced on demand. The
// real-store evidence for the same failures is scripts/stress-keychain.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { storeOver } from '../packages/storage/dist/secrets.js';
import { SecretStoreUnavailableError } from '../packages/storage/dist/index.js';

/** A backend whose every operation throws `message`, as the binding would. */
function throwing(message) {
  const fail = () => {
    const err = new Error(message);
    err.code = 'GenericFailure';
    throw err;
  };
  return { get: fail, set: fail, delete: fail };
}

// Messages observed from @napi-rs/keyring 2.1.0, 2026-09-14.
const LINUX_NO_BUS = 'Platform failure: DBus error: Using X11 for dbus-daemon autolaunch was disabled at compile time, set your DBUS_SESSION_BUS_ADDRESS instead';
const LINUX_NO_KEYRING = 'Platform failure: DBus error: The name org.freedesktop.secrets was not provided by any .service files';
const NO_STORAGE_ACCESS = "Couldn't access platform storage: PermissionDenied";
const WINDOWS_ERROR_8 = 'Platform failure: Windows error code 8';
const WINDOWS_TOO_LONG = "Value of 'password encoded as UTF-16' is longer than the platform limit of 2560 chars";

for (const [label, message] of [
  ['Linux with no session bus', LINUX_NO_BUS],
  ['Linux with a bus and no keyring daemon', LINUX_NO_KEYRING],
  ['a store the process may not access', NO_STORAGE_ACCESS],
]) {
  test(`classification: ${label} is SecretStoreUnavailableError (D22)`, () => {
    const store = storeOver(throwing(message));
    for (const op of [() => store.get('a'), () => store.set('a', 'v'), () => store.delete('a')]) {
      assert.throws(op, SecretStoreUnavailableError);
    }
  });
}

test('classification: a Windows error code is not "no keychain on this machine"', () => {
  // Error 8 (ERROR_NOT_ENOUGH_MEMORY) is what Credential Manager throws under
  // concurrent writers, on a store that is present and working. Reporting it
  // as unavailable tells the user their platform cannot store secrets.
  const store = storeOver(throwing(WINDOWS_ERROR_8));
  for (const op of [() => store.get('a'), () => store.set('a', 'v'), () => store.delete('a')]) {
    assert.throws(op, (err) => !(err instanceof SecretStoreUnavailableError) && /Windows error code 8/.test(err.message));
  }
});

test('classification: an over-long value propagates as the binding error', () => {
  const store = storeOver(throwing(WINDOWS_TOO_LONG));
  assert.throws(() => store.set('a', 'v'), (err) => !(err instanceof SecretStoreUnavailableError) && /platform limit/.test(err.message));
});
