// Freezes the version diff golden pairs for test/versions.test.mjs (plan
// phase 09): for each pair in test/golden/version-pairs.mjs,
//
//   test/golden/versions/<pair>.json            both surfaces as stored
//   test/golden/versions/<pair>.expected.json   compareVersions over them
//
// It refuses to overwrite: a golden file is changed by deleting it and
// freezing again, on purpose, with the reason in the commit.
//
//   npm run golden:versions
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareVersions, O200K } from '../packages/protocol/dist/index.js';
import { PAIRS, SERVER_NAME, capturePair } from '../test/golden/version-pairs.mjs';

const dir = fileURLToPath(new URL('../test/golden/versions/', import.meta.url));
mkdirSync(dir, { recursive: true });

let wrote = 0;
for (const [name, pair] of Object.entries(PAIRS)) {
  const stored = join(dir, `${name}.json`);
  const expected = join(dir, `${name}.expected.json`);
  if (existsSync(stored) || existsSync(expected)) {
    console.log(`kept ${name} (exists)`);
    continue;
  }
  const { before, after } = await capturePair(pair);
  writeFileSync(stored, `${JSON.stringify({ before, after }, null, 2)}\n`);
  writeFileSync(expected, `${JSON.stringify(compareVersions(before, after, { name: SERVER_NAME, tokenizer: O200K }), null, 2)}\n`);
  console.log(`froze ${name}`);
  wrote++;
}
console.log(`${wrote} pair(s) frozen`);
