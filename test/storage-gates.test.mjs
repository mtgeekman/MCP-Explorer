// Build gates for the storage package. Like pillar-gates.test.mjs, these check
// the SOURCE: the defects they prevent -- a database opened without the cipher
// configuration, a keychain entry without the Secret Service pin -- look fine
// in every session until a reboot or a dependency upgrade, and then lose data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

function sources(dir, acc = []) {
  for (const entry of readdirSync(join(root, dir))) {
    const rel = `${dir}/${entry}`;
    if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
    if (statSync(join(root, rel)).isDirectory()) sources(rel, acc);
    else if (/\.(ts|tsx|mts|cts|mjs|js)$/.test(entry)) acc.push(rel);
  }
  return acc;
}

// First-party product and tooling source. test/ is excluded: the storage tests
// open databases and keychain entries directly, by design, to check the files
// and entries the package produced.
const FIRST_PARTY = ['packages', 'app', 'scripts'].flatMap((d) => sources(d));
const read = (rel) => readFileSync(join(root, rel), 'utf8');

// Comments name these modules and constructors in prose; only code counts.
const code = (rel) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const loads = (specifier) => new RegExp(`(\\bfrom\\s*|\\brequire\\(\\s*|\\bimport\\(\\s*|\\bimport\\s+|require\\.resolve\\(\\s*)['"]${specifier}['"]`);

// Modules allowed to load the SQLite binding outside sqlite.ts. Empty since
// the app shell replaced the Phase 00 spike harness, which loaded it raw; the
// test below fails for any entry that no longer needs to be one.
const SQLITE_EXCEPTIONS = [];

const SQLITE_MODULE = 'packages/storage/src/sqlite.ts';
const WORKSPACE_DB = 'packages/storage/src/workspace-db.ts';
const SECRETS = 'packages/storage/src/secrets.ts';

test('gates see the files they guard', () => {
  // A renamed module would otherwise make every gate below pass vacuously.
  for (const f of [SQLITE_MODULE, WORKSPACE_DB, SECRETS]) assert.ok(FIRST_PARTY.includes(f), f);
});

test('D26: the SQLite module is loaded in exactly one place', () => {
  const sqlite = loads('better-sqlite3-multiple-ciphers');
  assert.match(code(SQLITE_MODULE), sqlite, 'the gate no longer recognises the one legitimate load');
  const offenders = FIRST_PARTY
    .filter((f) => f !== SQLITE_MODULE && !SQLITE_EXCEPTIONS.includes(f))
    .filter((f) => sqlite.test(code(f)));
  assert.deepEqual(offenders, [], 'load the database only through packages/storage/src/sqlite.ts');
});

test('D26: every exception to the single-load rule still needs to be one', () => {
  for (const f of SQLITE_EXCEPTIONS) {
    assert.ok(FIRST_PARTY.includes(f) && loads('better-sqlite3-multiple-ciphers').test(code(f)),
      `${f} is listed as an exception but no longer loads the module; remove it from SQLITE_EXCEPTIONS`);
  }
});

test('D26: only workspace-db.ts constructs a database handle', () => {
  const offenders = FIRST_PARTY
    .filter((f) => f !== SQLITE_MODULE && f !== WORKSPACE_DB)
    .filter((f) => /\bconstructDatabase\b/.test(code(f)));
  assert.deepEqual(offenders, [], 'every handle must come from createWorkspaceDb/openWorkspaceDb, which apply the cipher');
});

test('D26: the package does not export the raw constructor', () => {
  assert.doesNotMatch(read('packages/storage/src/index.ts'), /constructDatabase/);
});

test('D25: the keyring binding is loaded in exactly one place', () => {
  const keyring = loads('@napi-rs/keyring');
  assert.match(code(SECRETS), keyring, 'the gate no longer recognises the one legitimate load');
  const offenders = FIRST_PARTY.filter((f) => f !== SECRETS && keyring.test(code(f)));
  assert.deepEqual(offenders, [], 'reach the keychain only through packages/storage/src/secrets.ts');
});

test('D25: every keyring Entry is pinned to Secret Service', () => {
  const calls = [...code(SECRETS).matchAll(/new Entry\(([^)]*)\)/g)].map((m) => m[1]);
  assert.ok(calls.length > 0, 'no Entry construction found; the gate is looking at the wrong thing');
  for (const args of calls) {
    assert.match(args, /,\s*KEYRING_PIN\s*$/, `Entry(${args}) does not pass KEYRING_PIN as its last argument`);
  }
  for (const other of ['withTarget', 'AsyncEntry', 'findCredentials', 'findCredentialsAsync']) {
    assert.doesNotMatch(code(SECRETS), new RegExp(`\\b${other}\\b`), `${other} is not covered by this gate; extend it before using it`);
  }
});

test('D25: KEYRING_PIN is the Secret Service pin', () => {
  assert.match(read(SECRETS), /KEYRING_PIN = \{ linux: \{ store: 'secret-service' \} \} as const/);
});
