// The stored fixture pairs the version diff golden tests read (plan phase 09
// acceptance). Shared by scripts/golden-versions.mjs, which freezes them, and
// test/versions.test.mjs, which checks against them, so the two cannot
// disagree about what a pair is.
//
// Each pair is two captures of one fixture under different knobs, stored and
// loaded back through storage, the path the app takes.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { connectStdio, captureSurface } from '../../packages/protocol/dist/index.js';
import { createWorkspaceDb, saveServer, recordCapture, loadSnapshot } from '../../packages/storage/dist/index.js';
import { memoryStore } from '../support/memory-store.mjs';

const fixtures = fileURLToPath(new URL('../../scripts/fixture/', import.meta.url));

export const PAIRS = {
  /** One tool description changed: exactly one changed item. */
  'modern-description': { file: 'modern-server.mjs', before: {}, after: { ECHO_DESCRIPTION: 'Echoes its input back, unchanged.' } },
  /** serverInfo.version bumped, nothing else: "version changed, surface identical". */
  'modern-server-version': { file: 'modern-server.mjs', before: { SERVER_VERSION: '1.0.0' }, after: { SERVER_VERSION: '1.0.1' } },
  /** The legacy era, a description and the version together. */
  'legacy-description': { file: 'legacy-server.mjs', before: {}, after: { ECHO_DESCRIPTION: 'Repeats the text it is given.', SERVER_VERSION: '0.1.0' } },
};

export const SERVER_NAME = 'fixture';

/** Both sides of a pair, captured, stored and loaded back. */
export async function capturePair(pair) {
  const root = mkdtempSync(join(tmpdir(), 'mcpx-versions-'));
  const ws = createWorkspaceDb({ path: join(root, 'w.db'), workspaceId: randomUUID(), name: 'versions', custody: { kind: 'keychain' }, secrets: memoryStore() });
  try {
    saveServer(ws, { id: 's', name: SERVER_NAME, transport: 'stdio', command: process.execPath, args: [join(fixtures, pair.file)] });
    const side = async (env) => {
      const conn = await connectStdio({ command: process.execPath, args: [join(fixtures, pair.file)], env: { ...process.env, ...env } });
      let surface;
      try { surface = await captureSurface(conn.source); } finally { await conn.close(); }
      return loadSnapshot(ws, recordCapture(ws, 's', surface).snapshotId);
    };
    return { before: await side(pair.before), after: await side(pair.after) };
  } finally {
    ws.close();
    rmSync(root, { recursive: true, force: true });
  }
}
