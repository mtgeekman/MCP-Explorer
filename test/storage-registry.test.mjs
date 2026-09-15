// The workspace registry (D29): a readable file that lists workspaces before
// any is unlocked, and never holds a protected workspace's name.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  readRegistry, writeRegistry, addToRegistry, removeFromRegistry, renameInRegistry, registryLabel,
  RegistryError, REGISTRY_FORMAT,
} from '../packages/storage/dist/index.js';

const root = mkdtempSync(join(tmpdir(), 'mcpx-reg-'));
after(() => rmSync(root, { recursive: true, force: true }));
const fresh = () => { const d = mkdtempSync(join(root, 'r-')); return { dir: d, file: join(d, 'workspaces.json') }; };

const open = (name = 'Daily servers') => ({ id: randomUUID(), path: 'C:/data/a.db', custody: 'keychain', createdAt: 1_757_808_000_000, name });
const protectedEntry = () => ({ id: randomUUID(), path: 'C:/data/p.db', custody: 'passphrase', createdAt: 1_757_808_000_000 });

test('registry: a missing file is an empty registry', () => {
  assert.deepEqual(readRegistry(fresh().file), []);
});

test('registry: entries round-trip in order', () => {
  const { file } = fresh();
  const a = open('A'); const p = protectedEntry(); const n = { ...open('N'), custody: 'none' };
  addToRegistry(file, a);
  addToRegistry(file, p);
  addToRegistry(file, n);
  assert.deepEqual(readRegistry(file), [a, p, n]);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).format, REGISTRY_FORMAT);
});

test('registry: a protected workspace\'s name is never written to the file', () => {
  const { file } = fresh();
  const named = { ...protectedEntry(), name: 'Payroll servers' };
  assert.throws(() => addToRegistry(file, named), RegistryError);
  assert.throws(() => writeRegistry(file, [named]), RegistryError);
  addToRegistry(file, protectedEntry());
  assert.equal(readFileSync(file, 'utf8').includes('Payroll'), false);
});

test('registry: a hand-edited file carrying a protected workspace\'s name is refused, not trusted', () => {
  const { file } = fresh();
  writeFileSync(file, JSON.stringify({ format: REGISTRY_FORMAT, workspaces: [{ ...protectedEntry(), name: 'Payroll servers' }] }));
  assert.throws(() => readRegistry(file), /passphrase-protected, and its name must not be in the registry/);
});

test('registry: an unprotected workspace must have a name', () => {
  const { file } = fresh();
  const { name: _dropped, ...nameless } = open();
  assert.throws(() => addToRegistry(file, nameless), /has no name/);
});

test('registry: corrupt, foreign or newer files are refused and left exactly as they are', () => {
  const cases = [
    ['{ not json', /cannot be read/],
    ['[]', /is not a registry/],
    [JSON.stringify({ format: REGISTRY_FORMAT + 1, workspaces: [] }), /has format 2; this version .* reads format 1/],
    [JSON.stringify({ format: REGISTRY_FORMAT, workspaces: [{ id: 'x' }] }), /has no path/],
    [JSON.stringify({ format: REGISTRY_FORMAT, workspaces: [{ ...open(), custody: 'cloud' }] }), /unknown custody cloud/],
    [JSON.stringify({ format: REGISTRY_FORMAT, workspaces: [{ ...open(), key: 'abc' }] }), /unexpected fields: key/],
    [JSON.stringify({ format: REGISTRY_FORMAT, workspaces: [{ ...open(), createdAt: 'yesterday' }] }), /no valid createdAt/],
  ];
  for (const [body, reason] of cases) {
    const { file } = fresh();
    writeFileSync(file, body);
    assert.throws(() => readRegistry(file), (err) => err instanceof RegistryError && reason.test(err.message), body);
    // A failed read must not be followed by a write that drops the entries it could not parse.
    assert.throws(() => addToRegistry(file, open()), RegistryError, body);
    assert.equal(readFileSync(file, 'utf8'), body, `the file was changed: ${body}`);
  }
});

test('registry: the same workspace cannot be listed twice', () => {
  const { file } = fresh();
  const a = open();
  addToRegistry(file, a);
  assert.throws(() => addToRegistry(file, { ...a, name: 'again' }), /already registered/);
  assert.throws(() => writeRegistry(file, [a, a]), /listed twice/);
});

test('registry: remove takes the entry out and reports whether it was there', () => {
  const { file } = fresh();
  const a = open('A'); const b = open('B');
  addToRegistry(file, a);
  addToRegistry(file, b);
  assert.equal(removeFromRegistry(file, a.id), true);
  assert.equal(removeFromRegistry(file, a.id), false);
  assert.deepEqual(readRegistry(file), [b]);
});

test('registry: rename changes an unprotected name and refuses a protected one', () => {
  const { file } = fresh();
  const a = open('Before'); const p = protectedEntry();
  addToRegistry(file, a);
  addToRegistry(file, p);
  renameInRegistry(file, a.id, 'After');
  assert.equal(readRegistry(file)[0].name, 'After');
  assert.throws(() => renameInRegistry(file, p.id, 'Leaked'), /name is stored inside its database/);
  assert.throws(() => renameInRegistry(file, 'nope', 'x'), /not registered/);
  assert.equal(readFileSync(file, 'utf8').includes('Leaked'), false);
});

test('registry: a write leaves no temporary file behind, and a failed write leaves the old registry', () => {
  const { dir, file } = fresh();
  addToRegistry(file, open('kept'));
  const before = readFileSync(file, 'utf8');
  assert.deepEqual(readdirSync(dir), ['workspaces.json']);
  assert.throws(() => writeRegistry(file, [{ ...open(), custody: 'cloud' }]), RegistryError);
  assert.equal(readFileSync(file, 'utf8'), before);
  assert.deepEqual(readdirSync(dir), ['workspaces.json']);
});

test('registry: a write that fails after creating its temporary file removes it', () => {
  // The target is a directory, so the final rename fails once the temporary
  // file has been written and flushed.
  const { dir } = fresh();
  const target = join(dir, 'workspaces.json');
  mkdirSync(target);
  mkdirSync(join(target, 'occupied'));
  assert.throws(() => writeRegistry(target, [open()]));
  assert.deepEqual(readdirSync(dir), ['workspaces.json']);
});

test('registry: a temporary file left by a crashed write does not affect reading', () => {
  const { dir, file } = fresh();
  const a = open();
  addToRegistry(file, a);
  writeFileSync(join(dir, 'workspaces.json.deadbeef0000.tmp'), '{ half written');
  assert.deepEqual(readRegistry(file), [a]);
});

test('registry: the picker label is the name, or a dated placeholder for a protected workspace', () => {
  assert.equal(registryLabel(open('Daily servers')), 'Daily servers');
  assert.match(registryLabel(protectedEntry()), /^Protected workspace, created \d{4}-\d{2}-\d{2}$/);
});

test('registry: the placeholder date is the local calendar date, not the UTC one', () => {
  // Run in zones far from UTC: in a UTC-zoned CI container local and UTC dates
  // agree, and a UTC-date bug would pass. 23:30 local on 2026-03-01 is already
  // 2026-03-02 in UTC west of Greenwich; 00:30 local on 2026-03-02 is still
  // 2026-03-01 in UTC east of it.
  const child = `
    const { registryLabel } = await import(${JSON.stringify(new URL('../packages/storage/dist/index.js', import.meta.url).href)});
    const at = (d, h, m) => registryLabel({ id: 'x', path: 'p', custody: 'passphrase', createdAt: new Date(2026, 2, d, h, m).getTime() });
    console.log(JSON.stringify([at(1, 23, 30), at(2, 0, 30)]));
  `;
  for (const tz of ['America/Los_Angeles', 'Pacific/Kiritimati']) {
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', child], { encoding: 'utf8', env: { ...process.env, TZ: tz } });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), ['Protected workspace, created 2026-03-01', 'Protected workspace, created 2026-03-02'], tz);
  }
});
