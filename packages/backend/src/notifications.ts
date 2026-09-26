// The notifications timeline (phase 10 decision 6): every notification a
// server sent, read back from the wire log. No table of its own: the frames
// index says which units carried one, and the unit's bytes say what it was.
import type { Database } from '../../storage/dist/index.js';

export interface NotificationRow {
  /** The wire unit it arrived in; the log's row for the same bytes. */
  unitId: number;
  connectionId: number;
  at: number;
  method: string;
  /** As sent. Null when the unit's bytes were purged or are not JSON. */
  params: unknown;
  /** Modern era: the listen stream it arrived on, from _meta. */
  subscriptionId?: string | number;
}

const SUBSCRIPTION_KEY = 'io.modelcontextprotocol/subscriptionId';

/**
 * A page of a server's notifications, oldest first, from units older than
 * `before` (a unit id) when given. Ordered by unit id, which is record order.
 */
export function notificationPage(db: Database, serverId: string, before: number | undefined, limit: number): NotificationRow[] {
  const units = db.prepare(`
    SELECT DISTINCT f.unit_id AS unitId, f.connection_id AS connectionId, f.at AS at
    FROM frame f JOIN connection c ON c.id = f.connection_id
    WHERE c.server_id = @server AND f.direction = 'in' AND f.jsonrpc_id IS NULL AND f.method IS NOT NULL
      AND f.unit_id IS NOT NULL AND f.unit_id < @before
    ORDER BY f.unit_id DESC
    LIMIT @limit
  `).all({ server: serverId, before: before ?? Number.MAX_SAFE_INTEGER, limit }) as { unitId: number; connectionId: number; at: number }[];
  const bytesOf = db.prepare('SELECT bytes FROM wire_unit WHERE id = ?');
  const rows: NotificationRow[] = [];
  for (const u of units.reverse()) {
    const { bytes } = bytesOf.get(u.unitId) as { bytes: Uint8Array | null };
    for (const n of notificationsIn(bytes)) rows.push({ ...u, ...n });
  }
  return rows;
}

/** The notifications in one unit's bytes, in order: one, or several in a batch. */
function notificationsIn(bytes: Uint8Array | null): { method: string; params: unknown; subscriptionId?: string | number }[] {
  if (bytes === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    return [];
  }
  const out: { method: string; params: unknown; subscriptionId?: string | number }[] = [];
  for (const m of Array.isArray(parsed) ? parsed : [parsed]) {
    if (!m || typeof m !== 'object') continue;
    const msg = m as { id?: unknown; method?: unknown; params?: unknown };
    if (typeof msg.method !== 'string' || (msg.id !== undefined && msg.id !== null)) continue;
    const sub = (msg.params as { _meta?: Record<string, unknown> } | undefined)?._meta?.[SUBSCRIPTION_KEY];
    out.push({ method: msg.method, params: msg.params ?? null, ...(typeof sub === 'string' || typeof sub === 'number' ? { subscriptionId: sub } : {}) });
  }
  return out;
}
