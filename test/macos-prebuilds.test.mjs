// The D11 gate itself. It passed for a year's worth of dependencies in its
// first shape and would have passed @napi-rs/keyring without ever looking at
// it, because napi-rs packages ship neither prebuilds/ nor binding.gyp.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkPrebuilds } from '../scripts/check-macos-prebuilds.mjs';

function project({ deps, packages = {}, lock }) {
  const root = mkdtempSync(join(tmpdir(), 'mcpx-gate-'));
  const json = (path, value) => {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), JSON.stringify(value));
  };
  json('package.json', { dependencies: Object.fromEntries(deps.map((d) => [d, '*'])) });
  for (const [name, spec] of Object.entries(packages)) {
    json(`node_modules/${name}/package.json`, { name, version: spec.version, optionalDependencies: spec.optional });
    for (const dir of spec.prebuilds ?? []) mkdirSync(join(root, 'node_modules', name, 'prebuilds', dir), { recursive: true });
    if (spec.gyp) writeFileSync(join(root, 'node_modules', name, 'binding.gyp'), '{}');
  }
  if (lock) json('package-lock.json', { lockfileVersion: 3, packages: lock });
  return root;
}

function run(spec) {
  const root = project(spec);
  try { return checkPrebuilds(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

const lockEntry = (version) => ({ version, resolved: `https://registry.npmjs.org/x/-/x-${version}.tgz` });
const napi = (version, arches = ['darwin-x64', 'darwin-arm64', 'win32-x64-msvc']) => ({
  version,
  optional: Object.fromEntries(arches.map((a) => [`@scope/mod-${a}`, version])),
});

test('a prebuildify module with a darwin prebuild passes', () => {
  const r = run({ deps: ['sql'], packages: { sql: { version: '1.0.0', prebuilds: ['darwin-arm64', 'linux-x64'] } } });
  assert.deepEqual(r.failures, []);
  assert.equal(r.checked.length, 1);
});

test('a prebuildify module without a darwin prebuild fails', () => {
  const r = run({ deps: ['sql'], packages: { sql: { version: '1.0.0', prebuilds: ['linux-x64', 'win32-x64'] } } });
  assert.match(r.failures.join('\n'), /no darwin prebuild/);
});

test('binding.gyp with no prebuilds fails', () => {
  const r = run({ deps: ['gyp'], packages: { gyp: { version: '1.0.0', gyp: true } } });
  assert.match(r.failures.join('\n'), /ships no prebuilds/);
});

test('a pure-JS dependency is not a native dependency', () => {
  const r = run({ deps: ['plain'], packages: { plain: { version: '1.0.0' } } });
  assert.deepEqual(r, { checked: [], failures: [] });
});

test('a napi-rs module is checked, not skipped', () => {
  // The regression: the first gate returned checked=[] failures=[] here.
  const r = run({
    deps: ['@scope/mod'],
    packages: { '@scope/mod': napi('2.1.0') },
    lock: {
      'node_modules/@scope/mod-darwin-x64': lockEntry('2.1.0'),
      'node_modules/@scope/mod-darwin-arm64': lockEntry('2.1.0'),
    },
  });
  assert.deepEqual(r.failures, []);
  assert.match(r.checked.join('\n'), /@scope\/mod@2\.1\.0: darwin-x64, darwin-arm64/);
});

test('a napi-rs module missing darwin-arm64 fails', () => {
  const r = run({
    deps: ['@scope/mod'],
    packages: { '@scope/mod': napi('2.1.0', ['darwin-x64', 'win32-x64-msvc']) },
    lock: { 'node_modules/@scope/mod-darwin-x64': lockEntry('2.1.0') },
  });
  assert.match(r.failures.join('\n'), /declares no darwin-arm64 package/);
});

test('a napi-rs darwin package absent from the lockfile fails', () => {
  const r = run({
    deps: ['@scope/mod'],
    packages: { '@scope/mod': napi('2.1.0') },
    lock: { 'node_modules/@scope/mod-darwin-x64': lockEntry('2.1.0') },
  });
  assert.match(r.failures.join('\n'), /mod-darwin-arm64 is not resolved/);
});

test('a napi-rs darwin package at a different version fails', () => {
  const r = run({
    deps: ['@scope/mod'],
    packages: { '@scope/mod': napi('2.1.0') },
    lock: {
      'node_modules/@scope/mod-darwin-x64': lockEntry('2.1.0'),
      'node_modules/@scope/mod-darwin-arm64': lockEntry('2.0.0'),
    },
  });
  assert.match(r.failures.join('\n'), /resolves at 2\.0\.0, not the pinned 2\.1\.0/);
});

test('a napi-rs module with no lockfile fails rather than passing unchecked', () => {
  const r = run({ deps: ['@scope/mod'], packages: { '@scope/mod': napi('2.1.0') } });
  assert.match(r.failures.join('\n'), /no package-lock\.json/);
});

test('a declared dependency that is not installed fails rather than being skipped', () => {
  const r = run({ deps: ['ghost'], packages: {} });
  assert.match(r.failures.join('\n'), /ghost: not installed/);
});

test('the real project passes, and checks both native dependencies', () => {
  const r = checkPrebuilds(join(import.meta.dirname, '..'));
  assert.deepEqual(r.failures, []);
  const names = r.checked.map((line) => line.split('@').slice(0, -1).join('@'));
  assert.ok(names.includes('better-sqlite3-multiple-ciphers'), r.checked.join('\n'));
  assert.ok(names.includes('@napi-rs/keyring'), r.checked.join('\n'));
});
