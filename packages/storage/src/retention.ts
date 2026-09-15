import { StorageError } from './errors.js';
import type { Database } from './sqlite.js';
import type { Workspace } from './workspace-db.js';

/**
 * Retention (D24): a per-workspace age threshold and size cap over calls and
 * frames. Snapshots and observations are never purged.
 *
 * - The unit of deletion is the whole call: its rounds and frames go with it
 *   (foreign-key cascade), because a partly purged call reads as a
 *   conversation with holes. Connection-level frames (no call) go by age and
 *   size on their own.
 * - A call still in progress is never purged, however old.
 * - The cap is measured in live bytes (dbstat: page size minus unused space in
 *   every page in use), not file size: SQLite keeps freed pages in the file,
 *   so a file-size cap would purge everything eligible and still read as over.
 *   dbstat scans the whole database (98 ms for 230 MB encrypted, measured
 *   2026-09-14), so it runs only when the constant-time upper bound -- pages in
 *   use times page size -- is already over the cap.
 * - Nothing here runs on a timer (P2). The triggers are opening a workspace
 *   and finishing a call.
 */

export interface PurgeResult {
  callsDeleted: number;
  framesDeleted: number;
  /** Pages in use times page size: an upper bound on live bytes, cheap to read. */
  usedBytesBefore: number;
  usedBytesAfter: number;
  /** True when still over the cap with nothing left that retention may delete. */
  overCapWithNothingToPurge: boolean;
}

export interface WorkspaceSettings {
  persistResults: boolean;
  retentionMaxBytes: number;
  retentionMaxAgeDays: number;
}

export class InvalidSettingsError extends StorageError {}

const DAY_MS = 86_400_000;
// Rows deleted between size measurements: measuring is a full dbstat scan, so
// one row at a time is slow, and a large batch overshoots the cap.
const SIZE_BATCH = 25;

/** Pages in use (not on the freelist) times page size. Live bytes never exceed it. */
export function usedBytes(db: Database): number {
  return (db.prepare('SELECT (p.page_count - f.freelist_count) * s.page_size AS bytes FROM pragma_page_count() p, pragma_freelist_count() f, pragma_page_size() s').get() as { bytes: number }).bytes;
}

/** Bytes actually holding data. A full scan of the database: use usedBytes first. */
export function liveBytes(db: Database): number {
  return (db.prepare('SELECT coalesce(sum(pgsize - unused), 0) AS bytes FROM dbstat').get() as { bytes: number }).bytes;
}

export function readSettings(ws: Workspace): WorkspaceSettings {
  const row = ws.db.prepare('SELECT persist_results, retention_max_bytes, retention_max_age_days FROM workspace_meta WHERE id = 1').get() as
    { persist_results: number; retention_max_bytes: number; retention_max_age_days: number };
  return { persistResults: row.persist_results === 1, retentionMaxBytes: row.retention_max_bytes, retentionMaxAgeDays: row.retention_max_age_days };
}

/** Changes any of the workspace's settings (D4, D24). Applies from the next frame, round or purge. */
export function updateSettings(ws: Workspace, changes: Partial<WorkspaceSettings>): WorkspaceSettings {
  const positiveInt = (name: string, v: number | undefined) => {
    if (v !== undefined && (!Number.isSafeInteger(v) || v <= 0)) throw new InvalidSettingsError(`${name} must be a positive whole number, got ${v}`);
  };
  positiveInt('retentionMaxBytes', changes.retentionMaxBytes);
  positiveInt('retentionMaxAgeDays', changes.retentionMaxAgeDays);
  const current = readSettings(ws);
  const next = { ...current, ...changes };
  ws.db.prepare('UPDATE workspace_meta SET persist_results = ?, retention_max_bytes = ?, retention_max_age_days = ? WHERE id = 1')
    .run(next.persistResults ? 1 : 0, next.retentionMaxBytes, next.retentionMaxAgeDays);
  return next;
}

export function purgeHistory(ws: Workspace, now: () => number = Date.now): PurgeResult {
  const db = ws.db;
  const { retentionMaxBytes, retentionMaxAgeDays } = readSettings(ws);
  const cutoff = now() - retentionMaxAgeDays * DAY_MS;
  const usedBytesBefore = usedBytes(db);
  const overCap = () => usedBytes(db) > retentionMaxBytes && liveBytes(db) > retentionMaxBytes;
  let callsDeleted = 0;
  let framesDeleted = 0;

  db.transaction(() => {
    callsDeleted += db.prepare("DELETE FROM call WHERE status <> 'in_progress' AND started_at < ?").run(cutoff).changes;
    framesDeleted += db.prepare('DELETE FROM frame WHERE call_id IS NULL AND at < ?').run(cutoff).changes;
  })();

  let overCapWithNothingToPurge = false;
  while (overCap()) {
    // Oldest first across both kinds of history: whole calls by start time,
    // connection-level frames by their own time.
    const oldestCall = db.prepare("SELECT started_at AS at FROM call WHERE status <> 'in_progress' ORDER BY started_at, id LIMIT 1").get() as { at: number } | undefined;
    const oldestFrame = db.prepare('SELECT at FROM frame WHERE call_id IS NULL ORDER BY at, id LIMIT 1').get() as { at: number } | undefined;
    if (!oldestCall && !oldestFrame) {
      overCapWithNothingToPurge = true;
      break;
    }
    db.transaction(() => {
      if (oldestCall && (!oldestFrame || oldestCall.at <= oldestFrame.at)) {
        callsDeleted += db.prepare(`DELETE FROM call WHERE id IN (SELECT id FROM call WHERE status <> 'in_progress' ORDER BY started_at, id LIMIT ${SIZE_BATCH})`).run().changes;
      } else {
        framesDeleted += db.prepare(`DELETE FROM frame WHERE id IN (SELECT id FROM frame WHERE call_id IS NULL ORDER BY at, id LIMIT ${SIZE_BATCH * 20})`).run().changes;
      }
    })();
  }

  return { callsDeleted, framesDeleted, usedBytesBefore, usedBytesAfter: usedBytes(db), overCapWithNothingToPurge };
}

/**
 * Rewrites the file to drop the pages a purge freed (D24). An explicit user
 * command, never automatic: it rewrites the whole database and can take a
 * while. Returns the file size before and after, in bytes.
 */
export function compact(ws: Workspace): { before: number; after: number } {
  const size = () => {
    const r = ws.db.prepare('SELECT page_count * page_size AS bytes FROM pragma_page_count(), pragma_page_size()').get() as { bytes: number };
    return r.bytes;
  };
  const before = size();
  ws.db.exec('VACUUM');
  return { before, after: size() };
}
