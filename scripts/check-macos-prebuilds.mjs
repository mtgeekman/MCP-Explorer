// D11 gate: macOS is not built, but it must stay buildable. Every native
// dependency must ship a darwin prebuild at the pinned version, or the seam
// has quietly closed. Runs on any platform; intended for CI on llama.
//
// Native modules publish their binaries in one of two shapes, and the gate
// must recognise both or it passes a dependency it never looked at:
//
// - prebuildify: a `prebuilds/<platform>-<arch>/` directory inside the package
//   (better-sqlite3-multiple-ciphers). Visible in node_modules on any host.
// - napi-rs: one optional dependency per platform, `<name>-darwin-arm64` and so
//   on (@napi-rs/keyring). npm installs only the host's, so node_modules never
//   shows a darwin binary; the lockfile is the only record that one was
//   resolved at the pinned version.
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The platform name follows a hyphen ('@napi-rs/keyring-darwin-arm64') or a
// scope slash ('@esbuild/darwin-arm64'); both shapes are published.
const PLATFORM_PACKAGE = /[-/](darwin|linux|win32|freebsd|android|openbsd|sunos)-/;
// Apple Silicon and Intel both ship; a darwin-x64-only dependency is a closed
// seam on every Mac sold since 2020.
const DARWIN_ARCHES = ['darwin-x64', 'darwin-arm64'];

/**
 * @param {string} root project directory holding package.json, package-lock.json
 *   and node_modules
 * @returns {{checked: string[], failures: string[]}}
 */
export function checkPrebuilds(root) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const lockPath = join(root, 'package-lock.json');
  const lock = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, 'utf8')) : null;
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  const failures = [];
  const checked = [];

  for (const dep of deps) {
    const dir = join(root, 'node_modules', ...dep.split('/'));
    const manifestPath = join(dir, 'package.json');
    if (!existsSync(manifestPath)) {
      failures.push(`${dep}: not installed, so it cannot be checked (run npm ci first)`);
      continue;
    }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const version = manifest.version;

    const platformPackages = Object.keys(manifest.optionalDependencies ?? {})
      .filter((name) => PLATFORM_PACKAGE.test(name));
    if (platformPackages.length) {
      checkPlatformPackages(dep, version, platformPackages, lock, checked, failures);
      continue;
    }

    const prebuilds = join(dir, 'prebuilds');
    const isNative = existsSync(prebuilds) || existsSync(join(dir, 'binding.gyp'));
    if (!isNative) continue;
    if (!existsSync(prebuilds)) {
      failures.push(`${dep}@${version}: native (binding.gyp) but ships no prebuilds/ at all`);
      continue;
    }
    const darwin = readdirSync(prebuilds).filter((f) => f.startsWith('darwin-'));
    checked.push(`${dep}@${version}: ${darwin.length ? darwin.join(', ') : 'NONE'}`);
    if (darwin.length === 0) {
      failures.push(`${dep}@${version}: no darwin prebuild — macOS seam is closed`);
    }
  }
  return { checked, failures };
}

function checkPlatformPackages(dep, version, platformPackages, lock, checked, failures) {
  if (!lock) {
    failures.push(`${dep}@${version}: ships per-platform packages, and there is no package-lock.json to prove a darwin one resolves`);
    return;
  }
  const found = [];
  for (const arch of DARWIN_ARCHES) {
    const name = platformPackages.find((n) => n.endsWith(`-${arch}`) || n.endsWith(`/${arch}`));
    if (!name) {
      failures.push(`${dep}@${version}: declares no ${arch} package — macOS seam is closed`);
      continue;
    }
    const entry = lock.packages?.[`node_modules/${name}`];
    if (!entry || !entry.resolved) {
      failures.push(`${dep}@${version}: ${name} is not resolved in package-lock.json`);
    } else if (entry.version !== version) {
      failures.push(`${dep}@${version}: ${name} resolves at ${entry.version}, not the pinned ${version}`);
    } else {
      found.push(arch);
    }
  }
  checked.push(`${dep}@${version}: ${found.length ? found.join(', ') : 'NONE'} (per-platform packages)`);
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const { checked, failures } = checkPrebuilds(process.cwd());
  console.log('native dependencies checked:');
  for (const line of checked) console.log('  ' + line);
  if (failures.length) {
    console.error('\nmacOS prebuild gate FAILED:');
    for (const f of failures) console.error('  ' + f);
    process.exit(1);
  }
  console.log(`\nmacOS prebuild gate passed (${checked.length} native dependency/ies).`);
}
