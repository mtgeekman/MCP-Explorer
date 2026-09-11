// D11 gate: macOS is not built, but it must stay buildable. Every native
// dependency must ship a darwin prebuild at the pinned version, or the seam
// has quietly closed. Runs on any platform; intended for CI on llama.
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
const failures = [];
const checked = [];

for (const dep of deps) {
  const root = join('node_modules', ...dep.split('/'));
  const prebuilds = join(root, 'prebuilds');
  const bindingGyp = join(root, 'binding.gyp');
  const isNative = existsSync(prebuilds) || existsSync(bindingGyp);
  if (!isNative) continue;

  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  if (!existsSync(prebuilds)) {
    failures.push(`${dep}@${version}: native (binding.gyp) but ships no prebuilds/ at all`);
    continue;
  }
  const files = readdirSync(prebuilds);
  const darwin = files.filter((f) => f.startsWith('darwin-'));
  checked.push(`${dep}@${version}: ${darwin.length ? darwin.join(', ') : 'NONE'}`);
  if (darwin.length === 0) {
    failures.push(`${dep}@${version}: no darwin prebuild — macOS seam is closed`);
  }
}

console.log('native dependencies checked:');
for (const line of checked) console.log('  ' + line);
if (failures.length) {
  console.error('\nmacOS prebuild gate FAILED:');
  for (const f of failures) console.error('  ' + f);
  process.exit(1);
}
console.log(`\nmacOS prebuild gate passed (${checked.length} native dependency/ies).`);
