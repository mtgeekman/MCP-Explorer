// Reading the wire log back (D34): exact-byte units, each with the JSON-RPC
// messages it carried, and the re-serialized frames of workspaces written
// before schema 3, labelled as such and ordered with everything else by time.
import type { HttpDetails } from '../../protocol/dist/index.js';
import type { Database } from '../../storage/dist/index.js';
import type { LogCursor, LogFrame, LogUnit } from './api.js';

interface Row {
  id: number; server_id: string; connection_id: number; direction: LogUnit['direction']; kind: LogUnit['kind']; at: number;
  byte_length: number; bytes: Uint8Array | null; http_json: string | null; reserialized: number;
  /** Re-serialized frames carry their own id and method. */
  jsonrpc_id: string | null; method: string | null; result_withheld: number;
}

// Units, and frames that have no unit, in one shape.
const UNION = `
  SELECT u.id, c.server_id, u.connection_id, u.direction, u.kind, u.at, u.byte_length, u.bytes, u.http_json,
         0 AS reserialized, NULL AS jsonrpc_id, NULL AS method, 0 AS result_withheld
  FROM wire_unit u JOIN connection c ON c.id = u.connection_id
  UNION ALL
  SELECT f.id, c.server_id, f.connection_id, f.direction, 'wire', f.at, coalesce(length(CAST(f.message_json AS BLOB)), 0),
         CAST(f.message_json AS BLOB), NULL, 1, f.jsonrpc_id, f.method, f.result_withheld
  FROM frame f JOIN connection c ON c.id = f.connection_id WHERE f.unit_id IS NULL
`;

// What a page is chosen by, and nothing else. wire_unit stores byte_length,
// withheld and http_json after its bytes, so reading any of them walks the
// row's whole BLOB overflow chain; choosing a page from these keys alone
// touches no BLOB, and only the page's own rows are then read in full.
const KEYS = `
  SELECT u.id, u.at, 0 AS reserialized FROM wire_unit u JOIN connection c ON c.id = u.connection_id WHERE c.server_id = @server
  UNION ALL
  SELECT f.id, f.at, 1 FROM frame f JOIN connection c ON c.id = f.connection_id WHERE c.server_id = @server AND f.unit_id IS NULL
`;

/**
 * The largest unit a list or a live event carries whole: 256 KB (phase 07
 * decision 9). A bigger one travels without its bytes, to every window, and
 * is fetched whole with log.get when someone selects it.
 */
export const LIST_BYTES_LIMIT = 256 * 1024;
const HEAD_BYTES = 512;

/** A unit as a list or a live event carries it: whole, or without its bytes when large. */
export function listed(u: LogUnit): LogUnit {
  if (u.bytes === null || u.bytes.length <= LIST_BYTES_LIMIT) return u;
  return { ...u, bytes: null, omitted: { head: u.bytes.slice(0, HEAD_BYTES) } };
}

/** A page of a server's log, oldest first, older than `before` when given. */
export function logPage(db: Database, serverId: string, before: LogCursor | undefined, limit: number): LogUnit[] {
  const cursor = before ? [before.at, before.reserialized ? 1 : 0, before.id] : [Number.MAX_SAFE_INTEGER, 1, Number.MAX_SAFE_INTEGER];
  const keys = db.prepare(`
    SELECT id, reserialized FROM (${KEYS})
    WHERE (at, reserialized, id) < (@at, @reserialized, @id)
    ORDER BY at DESC, reserialized DESC, id DESC
    LIMIT @limit
  `).all({ server: serverId, at: cursor[0], reserialized: cursor[1], id: cursor[2], limit }) as { id: number; reserialized: number }[];
  const byKey = db.prepare(`SELECT * FROM (${UNION}) WHERE id = ? AND reserialized = ?`);
  const rows = keys.reverse().map((k) => byKey.get(k.id, k.reserialized) as Row);
  return withFrames(db, rows).map(listed);
}

/** One unit by id, or null. `reserialized` picks a pre-schema-3 frame, whose ids are a separate sequence. */
export function logUnit(db: Database, id: number, reserialized = false): LogUnit | null {
  const row = db.prepare(`SELECT * FROM (${UNION}) WHERE id = ? AND reserialized = ?`).get(id, reserialized ? 1 : 0) as Row | undefined;
  return row ? withFrames(db, [row])[0] : null;
}

function withFrames(db: Database, rows: Row[]): LogUnit[] {
  const unitIds = rows.filter((r) => !r.reserialized).map((r) => r.id);
  const frames = new Map<number, LogFrame[]>();
  if (unitIds.length) {
    const found = db.prepare(`SELECT unit_id, jsonrpc_id, method, result_withheld FROM frame WHERE unit_id IN (SELECT value FROM json_each(?)) ORDER BY id`)
      .all(JSON.stringify(unitIds)) as { unit_id: number; jsonrpc_id: string | null; method: string | null; result_withheld: number }[];
    for (const f of found) frames.set(f.unit_id, [...(frames.get(f.unit_id) ?? []), frame(f)]);
  }
  return rows.map((r) => ({
    id: r.id, serverId: r.server_id, connectionId: r.connection_id, direction: r.direction, kind: r.kind, at: r.at,
    byteLength: r.byte_length, bytes: r.bytes === null ? null : new Uint8Array(r.bytes),
    frames: r.reserialized ? [frame(r)] : frames.get(r.id) ?? [],
    ...(r.http_json ? { http: JSON.parse(r.http_json) as HttpDetails } : {}),
    ...(r.reserialized ? { reserialized: true } : {}),
  }));
}

const frame = (f: { jsonrpc_id: string | null; method: string | null; result_withheld: number }): LogFrame =>
  ({ jsonrpcId: f.jsonrpc_id, method: f.method, resultWithheld: f.result_withheld === 1 });
