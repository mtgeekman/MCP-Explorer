// One surface entry's exact bytes, cut from the list reply it arrived in
// (board 5.1A): tool detail opens on the raw definition, not a re-serialized
// one (D10). The reply is found in the wire log by the capture's connection;
// jsonc-parser gives the entry's offsets, which are then turned into byte
// offsets in the unit as stored (D34).
import { parseTree, type Node } from 'jsonc-parser';
import { sseEventData } from '../../protocol/dist/index.js';
import type { Database } from '../../storage/dist/index.js';
import type { EntryList, RawEntry } from './api.js';

const METHOD: Record<EntryList, string> = {
  tools: 'tools/list',
  prompts: 'prompts/list',
  resources: 'resources/list',
  resourceTemplates: 'resources/templates/list',
};

/** The identity field of each list's entries, as capture keys them. */
export const ENTRY_KEY: Record<EntryList, string> = {
  tools: 'name',
  prompts: 'name',
  resources: 'uri',
  resourceTemplates: 'uriTemplate',
};

const utf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * The newest reply, received on the capture's connection no later than the
 * capture, that lists the entry. Newest, because a Refresh on one connection
 * leaves earlier replies in the log that may hold an older definition.
 */
export function rawEntry(db: Database, capture: { connectionId: number | null; observedAt: number }, list: EntryList, key: string): RawEntry {
  if (capture.connectionId === null) return { found: false, reason: 'This capture was recorded without a connection, so there is no reply to cut it from.' };
  const units = db.prepare(`
    SELECT DISTINCT u.id, u.bytes, u.http_json FROM frame f JOIN wire_unit u ON u.id = f.unit_id
    WHERE f.connection_id = ? AND f.direction = 'in' AND f.method = ? AND u.at <= ?
    ORDER BY u.id DESC
  `).all(capture.connectionId, METHOD[list], capture.observedAt) as { id: number; bytes: Uint8Array | null; http_json: string | null }[];
  let withheld = false;
  for (const unit of units) {
    if (unit.bytes === null) { withheld = true; continue; }
    const bytes = new Uint8Array(unit.bytes);
    const range = findEntry(bytes, unit.http_json, list, key);
    if (range) return { found: true, unitId: unit.id, offset: range[0], bytes: bytes.slice(range[0], range[1]) };
  }
  if (withheld) return { found: false, reason: 'The reply was withheld under this workspace\'s results setting, so its bytes were not kept.' };
  return { found: false, reason: 'The wire log no longer holds the reply this entry was listed in; it may have been purged.' };
}

/** The entry's [start, end) byte range within the unit, or undefined. */
function findEntry(bytes: Uint8Array, httpJson: string | null, list: EntryList, key: string): [number, number] | undefined {
  let whole: string;
  try {
    whole = utf8.decode(bytes);
  } catch {
    return undefined;
  }
  // An SSE event carries its JSON after `data: `; only a one-line data field
  // maps back to contiguous bytes, which is how servers send a message.
  let json = whole;
  let base = 0;
  const framing = httpJson ? (JSON.parse(httpJson) as { framing?: string }).framing : undefined;
  if (framing === 'sse-event') {
    const data = sseEventData(bytes);
    if (data === null || data.includes('\n')) return undefined;
    base = whole.indexOf(data);
    if (base === -1) return undefined;
    json = data;
  }
  const root = parseTree(json);
  if (!root) return undefined;
  const messages = root.type === 'array' ? root.children ?? [] : [root];
  for (const message of messages) {
    const entries = property(property(message, 'result'), list);
    for (const entry of entries?.type === 'array' ? entries.children ?? [] : []) {
      const id = property(entry, ENTRY_KEY[list]);
      if (id?.type !== 'string' || id.value !== key) continue;
      // Offsets are in UTF-16 units of the decoded text; the bytes are UTF-8.
      const at = byteLength(whole.slice(0, base + entry.offset));
      return [at, at + byteLength(json.slice(entry.offset, entry.offset + entry.length))];
    }
  }
  return undefined;
}

function property(node: Node | undefined, name: string): Node | undefined {
  if (node?.type !== 'object') return undefined;
  const pair = node.children?.find((p) => p.children?.[0]?.value === name);
  return pair?.children?.[1];
}

const byteLength = (s: string) => Buffer.byteLength(s, 'utf8');
