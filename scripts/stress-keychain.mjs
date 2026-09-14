// Stress the keychain-custody path the way Windows Credential Manager broke
// it: several processes creating workspaces at once. Measures what matters to
// a user -- whether a workspace that create reported as created can be opened
// again -- rather than the store's raw read-after-write behaviour.
//
// Real OS store, real files. Every entry and file this creates is removed at
// the end, including after failures. Not part of `npm test`: it takes tens of
// seconds and deliberately loads the store.
//
//   npm run stress:keychain -- [workers=6] [workspacesPerWorker=40]
//
// Exit 1 when any workspace was lost (created, then unopenable after a settle
// period), when an open straight after create failed, or when a transient
// store error was reported as "no keychain on this machine".
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  createWorkspaceDb, openWorkspaceDb, keychainStore, workspaceKeyAccount, SecretStoreUnavailableError,
} from '../packages/storage/dist/index.js';

const SETTLE_MS = 10_000;

if (process.argv[2] === '--worker') {
  const [, , , service, dir, count] = process.argv;
  const secrets = keychainStore(service);
  const r = { created: 0, createFailed: {}, immediateOpenFailed: {}, ids: [] };
  for (let i = 0; i < Number(count); i++) {
    const workspaceId = randomUUID();
    const req = { path: join(dir, `${workspaceId}.db`), workspaceId, custody: { kind: 'keychain' }, secrets };
    try {
      const db = createWorkspaceDb(req);
      db.exec('CREATE TABLE t (v TEXT)');
      db.prepare('INSERT INTO t VALUES (?)').run(workspaceId);
      db.close();
      r.created++;
      r.ids.push(workspaceId);
    } catch (err) {
      // Account names differ per workspace; drop them so identical failures group.
      const message = err.message.replace(/workspace-key\/[0-9a-f-]+/g, 'workspace-key/<id>');
      const kind = err instanceof SecretStoreUnavailableError ? `MISCLASSIFIED ${err.name}: ${message}` : `${err.name}: ${message}`;
      r.createFailed[kind] = (r.createFailed[kind] ?? 0) + 1;
      continue;
    }
    try {
      openWorkspaceDb(req).close();
    } catch (err) {
      r.immediateOpenFailed[err.name] = (r.immediateOpenFailed[err.name] ?? 0) + 1;
    }
  }
  process.stdout.write(JSON.stringify(r));
  process.exit(0);
}

const workers = Number(process.argv[2] ?? 6);
const perWorker = Number(process.argv[3] ?? 40);
const service = `mcp-explorer-stress-${randomUUID()}`;
const dir = mkdtempSync(join(tmpdir(), 'mcpx-stress-'));
const self = fileURLToPath(import.meta.url);

function runWorker() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [self, '--worker', service, dir, String(perWorker)], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.on('exit', (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`worker exited ${code}`))));
  });
}

const secrets = keychainStore(service);
let ids = [];
let failed = false;
try {
  const results = await Promise.all(Array.from({ length: workers }, runWorker));
  ids = results.flatMap((r) => r.ids);
  const merge = (key) => results.reduce((acc, r) => {
    for (const [k, v] of Object.entries(r[key])) acc[k] = (acc[k] ?? 0) + v;
    return acc;
  }, {});
  const createFailed = merge('createFailed');
  const immediateOpenFailed = merge('immediateOpenFailed');

  await new Promise((r) => setTimeout(r, SETTLE_MS));
  const lost = {};
  for (const workspaceId of ids) {
    try {
      openWorkspaceDb({ path: join(dir, `${workspaceId}.db`), workspaceId, custody: { kind: 'keychain' }, secrets }).close();
    } catch (err) {
      lost[err.name] = (lost[err.name] ?? 0) + 1;
    }
  }

  const count = (o) => Object.values(o).reduce((a, b) => a + b, 0);
  const misclassified = Object.keys(createFailed).filter((k) => k.startsWith('MISCLASSIFIED')).length > 0;
  console.log(JSON.stringify({
    workers, perWorker, attempted: workers * perWorker, created: ids.length,
    createFailed, immediateOpenFailed, lostAfterSettle: lost,
  }, null, 2));
  failed = count(lost) > 0 || count(immediateOpenFailed) > 0 || misclassified;
  console.log(failed ? 'FAIL: a created workspace was not openable, or an error was misclassified' : 'PASS: every created workspace opened');
} finally {
  for (const workspaceId of ids) secrets.delete(workspaceKeyAccount(workspaceId));
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
