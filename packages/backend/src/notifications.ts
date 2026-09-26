// The notifications timeline (phase 10 decision 6): every notification a
// server sent, read back from the wire log. No table of its own: the frames
// index says which units carried one, and the unit's bytes say what it was.
import { sseEventData, SUBSCRIPTION_ID_META_KEY } from '../../protocol/dist/index.js';
import type { Database } from '../../storage/dist/index.js';

export interface NotificationRow {
  /** The wire unit it arrived in; the log's row for the same bytes. */
  unitId: number;
  connectionId: number;
  at: number;
  method: string;
  /** As sent. Null when the unit's bytes were purged or are not JSON. */
  params: unknown;
  /**
   * The unit exactly as it arrived, as text (D10, R10-4): a stdio line, or an
   * HTTP event with its field lines. Shared by every notification of a batch.
   */
  raw: string | null;
  /** Modern era: the listen stream it arrived on, from _meta. */
  subscriptionId?: string | number;
}

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
  const unitOf = db.prepare('SELECT bytes, http_json FROM wire_unit WHERE id = ?');
  const rows: NotificationRow[] = [];
  for (const u of units.reverse()) {
    const { bytes, http_json } = unitOf.get(u.unitId) as { bytes: Uint8Array | null; http_json: string | null };
    // An HTTP event carries its message in its data lines, as the recorder
    // indexed it (R10-4); a stdio line is the message itself.
    const sse = http_json !== null && (JSON.parse(http_json) as { framing?: string }).framing === 'sse-event';
    const raw = bytes === null ? null : Buffer.from(bytes).toString('utf8');
    const text = bytes === null ? null : sse ? sseEventData(bytes) : raw;
    for (const n of notificationsIn(text)) rows.push({ ...u, ...n, raw });
  }
  return rows;
}

/** The notifications in one message text, in order: one, or several in a batch. */
function notificationsIn(text: string | null): { method: string; params: unknown; subscriptionId?: string | number }[] {
  if (text === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const out: { method: string; params: unknown; subscriptionId?: string | number }[] = [];
  for (const m of Array.isArray(parsed) ? parsed : [parsed]) {
    if (!m || typeof m !== 'object') continue;
    const msg = m as { id?: unknown; method?: unknown; params?: unknown };
    if (typeof msg.method !== 'string' || (msg.id !== undefined && msg.id !== null)) continue;
    const sub = (msg.params as { _meta?: Record<string, unknown> } | undefined)?._meta?.[SUBSCRIPTION_ID_META_KEY];
    out.push({ method: msg.method, params: msg.params ?? null, ...(typeof sub === 'string' || typeof sub === 'number' ? { subscriptionId: sub } : {}) });
  }
  return out;
}
