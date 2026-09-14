// Freezes the current schema version for test/storage-migrations.test.mjs
// (D27). Run once, when a new migration is added, and commit what it writes:
//
//   test/golden/v<N>.db            a database at schema N with a row in every table
//   test/golden/v<N>.json          the row counts that database must keep through every later migration
//   test/golden/schema-v<N>.sql    the schema a fresh database at N must have
//   test/golden/migration-checksums.json   gains an entry for N
//
// It refuses to overwrite anything that exists: a golden file changed after
// release would stop testing the upgrade real users take.
//
//   npm run golden:db
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkspaceDb, MIGRATIONS, SCHEMA_VERSION } from '../packages/storage/dist/index.js';
import { dumpSchema, rowCounts, seedEveryTable } from '../test/golden/golden-support.mjs';

const golden = fileURLToPath(new URL('../test/golden/', import.meta.url));
mkdirSync(golden, { recursive: true });
const v = SCHEMA_VERSION;
const outputs = [`v${v}.db`, `v${v}.json`, `schema-v${v}.sql`].map((f) => join(golden, f));
const existing = outputs.filter((p) => existsSync(p));
if (existing.length) {
  console.error(`refusing to overwrite golden files for schema ${v}:\n  ${existing.join('\n  ')}`);
  process.exit(1);
}

const checksumsPath = join(golden, 'migration-checksums.json');
const checksums = existsSync(checksumsPath) ? JSON.parse(readFileSync(checksumsPath, 'utf8')) : {};
for (const m of MIGRATIONS) {
  const sum = createHash('sha256').update(m.sql).digest('hex');
  if (checksums[m.version] === undefined) checksums[m.version] = sum;
  else if (checksums[m.version] !== sum) {
    console.error(`migration ${m.version} (${m.name}) changed after its checksum was recorded; add a new migration instead`);
    process.exit(1);
  }
}

const noSecrets = { get: () => null, set: () => { throw new Error('golden databases are unencrypted'); }, delete: () => false };
const dbPath = join(golden, `v${v}.db`);
const ws = createWorkspaceDb({ path: dbPath, workspaceId: randomUUID(), name: `golden v${v}`, custody: { kind: 'none' }, secrets: noSecrets, now: () => 1_757_808_000_000 });
try {
  seedEveryTable(ws.db);
  writeFileSync(join(golden, `v${v}.json`), JSON.stringify({ schemaVersion: v, rowCounts: rowCounts(ws.db) }, null, 2) + '\n');
  writeFileSync(join(golden, `schema-v${v}.sql`), dumpSchema(ws.db));
  writeFileSync(checksumsPath, JSON.stringify(checksums, null, 2) + '\n');
} catch (err) {
  ws.close();
  for (const p of outputs) rmSync(p, { force: true });
  throw err;
}
ws.close();
console.log(`wrote golden files for schema ${v}`);
