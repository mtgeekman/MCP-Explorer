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
import { SecretStoreUnavailableError, SecretWriteUnconfirmedError } from '../packages/storage/dist/index.js';

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

// --- confirm-and-retry ------------------------------------------------------

/**
 * A backend that misbehaves the ways Credential Manager was measured to:
 * refuse writes with error 8, accept a write and drop it, show a write late.
 * Every option counts calls from the start, and every call is recorded.
 */
function scripted({ dropSets = 0, refuseSets = 0, refuseGets = 0, lateReads = 0, dropDeletes = 0 } = {}) {
  const data = new Map();
  const calls = { set: 0, get: 0, delete: 0 };
  let staleReadsLeft = 0;
  let before = new Map();
  const error8 = () => Object.assign(new Error(WINDOWS_ERROR_8), { code: 'GenericFailure' });
  return {
    calls,
    data,
    backend: {
      get(account) {
        calls.get++;
        if (calls.get <= refuseGets) throw error8();
        if (staleReadsLeft > 0) { staleReadsLeft--; return before.get(account) ?? null; }
        return data.get(account) ?? null;
      },
      set(account, value) {
        calls.set++;
        if (calls.set <= refuseSets) throw error8();
        if (calls.set <= refuseSets + dropSets) return;
        before = new Map(data);
        data.set(account, value);
        staleReadsLeft = lateReads;
      },
      delete(account) {
        calls.delete++;
        if (calls.delete <= dropDeletes) return data.has(account);
        before = new Map(data);
        const had = data.delete(account);
        staleReadsLeft = lateReads;
        return had;
      },
    },
  };
}

function clock() {
  let t = 0;
  const slept = [];
  return { slept, policy: { attempts: 3, confirmMs: 2500, patienceMs: 6000, initialDelayMs: 25, maxDelayMs: 500, now: () => t, sleep: (ms) => { slept.push(ms); t += ms; } }, elapsed: () => t };
}

test('retry: a healthy store costs one write and one read-back, and never sleeps', () => {
  // Old-valid-input: the policy adds nothing when nothing goes wrong.
  const s = scripted(); const c = clock(); const store = storeOver(s.backend, c.policy);
  store.set('a', 'v');
  assert.deepEqual(s.calls, { set: 1, get: 1, delete: 0 });
  assert.equal(store.get('a'), 'v');
  assert.equal(store.get('missing'), null);
  assert.equal(store.delete('a'), true);
  assert.equal(store.delete('a'), false);
  assert.deepEqual(c.slept, []);
});

test('retry: a write that reads back late is waited for, not rewritten', () => {
  const s = scripted({ lateReads: 4 }); const c = clock(); const store = storeOver(s.backend, c.policy);
  store.set('a', 'v');
  assert.equal(s.calls.set, 1);
  assert.equal(s.calls.get, 5);
});

test('retry: a write the store drops is written again', () => {
  const s = scripted({ dropSets: 1 }); const c = clock(); const store = storeOver(s.backend, c.policy);
  store.set('a', 'v');
  assert.equal(s.calls.set, 2);
  assert.equal(s.data.get('a'), 'v');
});

test('retry: a write that is never confirmed throws, without the value in the message', () => {
  const s = scripted({ dropSets: 99 }); const c = clock(); const store = storeOver(s.backend, c.policy);
  assert.throws(() => store.set('workspace-key/x', 'SECRET-VALUE'), (err) =>
    err instanceof SecretWriteUnconfirmedError && !err.message.includes('SECRET-VALUE') && /3 attempts; it read back as absent/.test(err.message));
  assert.equal(s.calls.set, 3);
});

test('retry: error 8 on write is retried until the store accepts', () => {
  // 20 refusals outlast a fixed-count retry; the window is time, not tries.
  const s = scripted({ refuseSets: 20 }); const c = clock(); const store = storeOver(s.backend, c.policy);
  store.set('a', 'v');
  assert.equal(s.data.get('a'), 'v');
  assert.equal(s.calls.set, 21);
});

test('retry: error 8 on every write ends in SecretWriteUnconfirmedError naming the store error', () => {
  const s = scripted({ refuseSets: 1e9 }); const c = clock(); const store = storeOver(s.backend, c.policy);
  assert.throws(() => store.set('a', 'v'), (err) => err instanceof SecretWriteUnconfirmedError && /Windows error code 8/.test(err.message));
  // Bounded: three attempts of at most confirmMs each, plus one final sleep of maxDelayMs per attempt.
  assert.ok(c.elapsed() <= 3 * (2500 + 500), `blocked for ${c.elapsed()} ms`);
});

test('retry: error 8 on read is retried within confirmMs, even for an impatient get', () => {
  // Backoff 25+50+100+200+400+500 = 1275 ms for six refusals: inside 2500.
  const s = scripted({ refuseGets: 6 }); s.data.set('a', 'v');
  const c = clock(); const store = storeOver(s.backend, c.policy);
  assert.equal(store.get('a'), 'v');
  assert.equal(s.calls.get, 7);
});

test('retry: error 8 on read past confirmMs propagates as the store error', () => {
  const s = scripted({ refuseGets: 1e9 }); s.data.set('a', 'v');
  const c = clock(); const store = storeOver(s.backend, c.policy);
  assert.throws(() => store.get('a'), (err) => !(err instanceof SecretStoreUnavailableError) && /Windows error code 8/.test(err.message));
  assert.ok(c.elapsed() >= 2500 && c.elapsed() < 2500 + 500, `retried for ${c.elapsed()} ms`);
});

test('retry: an impatient get believes null at once', () => {
  const s = scripted(); const c = clock(); const store = storeOver(s.backend, c.policy);
  assert.equal(store.get('a'), null);
  assert.equal(s.calls.get, 1);
});

test('retry: a patient get re-reads a missing value, then gives up after patienceMs', () => {
  const s = scripted(); const c = clock(); const store = storeOver(s.backend, c.policy);
  assert.equal(store.get('a', { patient: true }), null);
  assert.ok(c.elapsed() >= 6000 && c.elapsed() < 6000 + 500, `waited ${c.elapsed()} ms`);
  assert.ok(s.calls.get > 1);
});

test('retry: a patient get returns a value that appears late', () => {
  const s = scripted({ lateReads: 6 }); const c = clock(); const store = storeOver(s.backend, c.policy);
  s.backend.set('a', 'v'); // straight to the backend: nothing has confirmed it
  assert.equal(store.get('a', { patient: true }), 'v');
});

test('retry: a delete the store drops is deleted again, and reports the entry existed', () => {
  const s = scripted({ dropDeletes: 1 }); s.data.set('a', 'v');
  const c = clock(); const store = storeOver(s.backend, c.policy);
  assert.equal(store.delete('a'), true);
  assert.equal(s.calls.delete, 2);
  assert.equal(s.data.has('a'), false);
});

test('retry: an unavailable store and a non-transient error are not retried', () => {
  for (const message of [LINUX_NO_KEYRING, WINDOWS_TOO_LONG]) {
    let sets = 0;
    const backend = { get: () => null, delete: () => false, set: () => { sets++; throw new Error(message); } };
    const c = clock();
    assert.throws(() => storeOver(backend, c.policy).set('a', 'v'));
    assert.equal(sets, 1, message);
    assert.deepEqual(c.slept, [], message);
  }
});
