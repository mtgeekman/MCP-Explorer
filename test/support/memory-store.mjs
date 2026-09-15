// An in-memory SecretStore for tests whose subject is the database, not the
// OS keychain.
//
// Why not the real keychain: node --test runs test files in parallel
// processes, and Windows Credential Manager loses updates under concurrent
// writers (measured 2026-09-14, spec D28: with 8 processes, 32 of 1,200
// confirmed deletes came back). Every test file writing the real store at
// once made the suite flaky by its own hand. Tests of the real store live in
// test/keychain.test.mjs, one file, so they run one at a time.
export function memoryStore() {
  const data = new Map();
  return {
    data,
    get: (account) => data.get(account) ?? null,
    set: (account, value) => { data.set(account, value); },
    delete: (account) => data.delete(account),
  };
}
