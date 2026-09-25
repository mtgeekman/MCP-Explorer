import { StorageError } from './errors.js';
import type { Database } from './sqlite.js';
import type { Workspace } from './workspace-db.js';

/**
 * Retention (D24): a per-workspace age threshold and size cap over calls,
 * wire units and frames. Snapshots and observations are never purged.
 *
 * - The unit of deletion is the whole call: its rounds and frames go with it
 *   (foreign-key cascade), because a partly purged call reads as a
 *   conversation with holes. Connection-level wire units (no call) go by age
 *   and size on their own, taking their frames with them; so do frames
 *   written before schema 3, which have no unit.
 * - A call still in progress is never purged, however old.
 * - The cap is measured in live bytes (dbstat: page size minus unused space in
 *   every page in use), not file size: SQLite keeps freed pages in the file,
 *   so a file-size cap would purge everything eligible and still read as over.
 *   dbstat scans the whole database (98 ms for 230 MB encrypted, measured
 *   2026-09-14), so it runs only when the constant-time upper bound -- pages in
 *   use times page size -- is already over the cap.
 * - A connection row goes once it was closed before the age threshold and
 *   nothing refers to it. An open connection is kept.
 * - Nothing here runs on a timer (P2). The triggers are opening a workspace
 *   and finishing a call.
 */

export interface PurgeResult {
  callsDeleted: number;
  /** Frames deleted directly: those written before schema 3, which have no unit. Later frames go with their unit or call. */
  framesDeleted: number;
  /** Connection-level wire units (D34). A call's units go with the call. */
  unitsDeleted: number;
  connectionsDeleted: number;
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
/**
 * A wire unit's storage beyond its bytes: its other columns, its frame rows
 * and index entries. An estimate that only sizes a purge batch; the cap is
 * checked by measuring after each batch.
 */
const UNIT_ROW_OVERHEAD = 200;

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
  /** Live bytes over the cap, or 0; the full dbstat scan runs only when the cheap bound is over. */
  const excess = () => {
    if (usedBytes(db) <= retentionMaxBytes) return 0;
    return Math.max(0, liveBytes(db) - retentionMaxBytes);
  };
  let callsDeleted = 0;
  let framesDeleted = 0;
  let unitsDeleted = 0;
  let connectionsDeleted = 0;

  db.transaction(() => {
    callsDeleted += db.prepare("DELETE FROM call WHERE status <> 'in_progress' AND started_at < ?").run(cutoff).changes;
    unitsDeleted += db.prepare('DELETE FROM wire_unit WHERE call_id IS NULL AND at < ?').run(cutoff).changes;
    framesDeleted += db.prepare('DELETE FROM frame WHERE call_id IS NULL AND unit_id IS NULL AND at < ?').run(cutoff).changes;
    // A connection row outlives its history otherwise: one per connect,
    // forever. It goes once it was closed before the threshold and no frame or
    // call refers to it; an observation that did loses the link (ON DELETE SET
    // NULL) and is kept. An open connection is never deleted, even with every
    // frame aged out: its recorder is still writing to it.
    connectionsDeleted += db.prepare(`
      DELETE FROM connection WHERE closed_at IS NOT NULL AND closed_at < ?
        AND NOT EXISTS (SELECT 1 FROM wire_unit WHERE wire_unit.connection_id = connection.id)
        AND NOT EXISTS (SELECT 1 FROM frame WHERE frame.connection_id = connection.id)
        AND NOT EXISTS (SELECT 1 FROM call WHERE call.connection_id = connection.id)
    `).run(cutoff).changes;
  })();

  let overCapWithNothingToPurge = false;
  for (let over = excess(); over > 0; over = excess()) {
    // Oldest first across every kind of history: whole calls by start time,
    // connection-level units and frames by their own time.
    const oldestCall = db.prepare("SELECT started_at AS at FROM call WHERE status <> 'in_progress' ORDER BY started_at, id LIMIT 1").get() as { at: number } | undefined;
    const oldestUnit = db.prepare('SELECT at FROM wire_unit WHERE call_id IS NULL ORDER BY at, id LIMIT 1').get() as { at: number } | undefined;
    // Frames written before schema 3 have no unit; later ones go with theirs.
    const oldestFrame = db.prepare('SELECT at FROM frame WHERE call_id IS NULL AND unit_id IS NULL ORDER BY at, id LIMIT 1').get() as { at: number } | undefined;
    const oldestLoose = [oldestUnit, oldestFrame].filter((r): r is { at: number } => r !== undefined).sort((a, b) => a.at - b.at)[0];
    if (!oldestCall && !oldestLoose) {
      overCapWithNothingToPurge = true;
      break;
    }
    db.transaction(() => {
      if (oldestCall && (!oldestLoose || oldestCall.at <= oldestLoose.at)) {
        // Oldest first across kinds: a batch of calls stops at the oldest
        // loose unit or frame, which goes before any call newer than it.
        callsDeleted += db.prepare(`DELETE FROM call WHERE id IN (SELECT id FROM call WHERE status <> 'in_progress' AND started_at <= ? ORDER BY started_at, id LIMIT ${SIZE_BATCH})`)
          .run(oldestLoose?.at ?? Number.MAX_SAFE_INTEGER).changes;
      } else if (oldestLoose === oldestUnit) {
        // Sized by the bytes still to free, not by a row count: small units
        // at 25 a scan took thousands of scans; many at once overshot the cap.
        // length() is answered from the record header, without the BLOB. The
        // batch stops at the oldest call or frame, which goes before anything
        // newer than it; rows are read only as far as the batch needs.
        const bound = Math.min(oldestCall?.at ?? Infinity, oldestFrame?.at ?? Infinity);
        const ids: number[] = [];
        let freed = 0;
        const oldestFirst = db.prepare('SELECT id, coalesce(length(bytes), 0) AS n FROM wire_unit WHERE call_id IS NULL AND at <= ? ORDER BY at, id');
        for (const u of oldestFirst.iterate(Number.isFinite(bound) ? bound : Number.MAX_SAFE_INTEGER) as Iterable<{ id: number; n: number }>) {
          ids.push(u.id);
          freed += u.n + UNIT_ROW_OVERHEAD;
          if (freed >= over) break;
        }
        unitsDeleted += db.prepare('DELETE FROM wire_unit WHERE id IN (SELECT value FROM json_each(?))').run(JSON.stringify(ids)).changes;
      } else {
        // The same bound for frames written before schema 3: none newer than
        // the oldest call or loose unit.
        const frameBound = Math.min(oldestCall?.at ?? Number.MAX_SAFE_INTEGER, oldestUnit?.at ?? Number.MAX_SAFE_INTEGER);
        framesDeleted += db.prepare(`DELETE FROM frame WHERE id IN (SELECT id FROM frame WHERE call_id IS NULL AND unit_id IS NULL AND at <= ? ORDER BY at, id LIMIT ${SIZE_BATCH * 20})`)
          .run(frameBound).changes;
      }
    })();
  }

  return { callsDeleted, framesDeleted, unitsDeleted, connectionsDeleted, usedBytesBefore, usedBytesAfter: usedBytes(db), overCapWithNothingToPurge };
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
