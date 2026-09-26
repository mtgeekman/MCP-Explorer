// How the wire log lists its units (board 4.1): one row each, raw first. The
// label comes from the messages the backend indexed, never from parsing a
// possibly huge unit here; the preview is the unit's own first bytes.
import type { LogUnit } from '../../../../packages/backend/dist/index.js';
import { RawDocument } from './raw.ts';

export interface LogRow {
  unit: LogUnit;
  /** Arrow for the direction: out, in, or a local app event. */
  arrow: '→' | '←' | '•';
  /** Methods and ids of the messages carried, or what the unit is when it carries none. */
  label: string;
  /** The first bytes, shown the way the raw viewer shows them. */
  preview: string;
  /** For a reply: milliseconds since the request it answers. */
  elapsedMs?: number;
}

export interface LogCounts {
  /** JSON-RPC messages, stderr lines and app events are counted apart (round 4 assumption). */
  frames: number;
  stderr: number;
  app: number;
  /** Wire units that carried no JSON-RPC: a page, a banner, an SSE comment, an empty body. */
  other: number;
}

const PREVIEW_BYTES = 240;
const ARROW = { out: '→', in: '←', local: '•' } as const;

function appEvent(u: LogUnit): string {
  try {
    return String(JSON.parse(new TextDecoder().decode(u.bytes ?? new Uint8Array())).event ?? 'app event');
  } catch {
    return 'app event';
  }
}

function describeEmpty(u: LogUnit): string {
  if (u.omitted) return 'large: loaded when selected';
  if (u.bytes === null) return 'withheld (results are not kept in this workspace)';
  if (u.http?.method && (u.byteLength === 0 || u.http.redacted?.length)) return `${u.http.method} ${u.http.url ?? ''}`.trim();
  if (u.http?.status !== undefined && u.http.redacted?.length) return `HTTP ${u.http.status}`;
  if (u.http?.status !== undefined && u.byteLength === 0) return `HTTP ${u.http.status}, no body`;
  if (u.http?.framing === 'sse-event') return 'SSE event, no JSON-RPC';
  return 'not JSON-RPC';
}

function preview(u: LogUnit): string {
  const bytes = u.bytes ?? u.omitted?.head ?? null;
  if (bytes === null) return '';
  const doc = new RawDocument(bytes.subarray(0, PREVIEW_BYTES), PREVIEW_BYTES);
  return doc.segments(0).map((s) => s.text).join('') + (u.byteLength > PREVIEW_BYTES ? ' ...' : '');
}

/**
 * Rows for a run of units, oldest first. A reply's elapsed time is measured
 * from the request on the same connection with the same id and method going
 * the other way, in either direction, since a legacy server sends requests too.
 */
export function logRows(units: LogUnit[]): LogRow[] {
  const sent = new Map<string, number>();
  return units.map((u) => {
    const row: LogRow = { unit: u, arrow: ARROW[u.direction], label: '', preview: preview(u) };
    // An OAuth exchange is stored with its secret values replaced (pillar
    // amendment 2026-09-26); the row says so, since its bytes are not the wire's.
    if (u.http?.redacted?.length) {
      row.label = `${describeEmpty(u)}, secrets redacted: ${u.http.redacted.join(', ')}`;
      return row;
    }
    if (u.kind === 'stderr') row.label = 'stderr';
    else if (u.kind === 'app') row.label = appEvent(u);
    else if (u.frames.length === 0) row.label = describeEmpty(u);
    else {
      row.label = u.frames.map((f) => [f.method ?? 'reply to an unknown request', f.jsonrpcId === null ? '' : `#${f.jsonrpcId}`].join(' ').trim()).join(', ');
      for (const f of u.frames) {
        if (f.jsonrpcId === null || f.method === null) continue;
        // Ids restart with every connection, and the log spans them all.
        const key = `${u.connectionId}\u0000${u.direction}\u0000${f.jsonrpcId}\u0000${f.method}`;
        const other = `${u.connectionId}\u0000${u.direction === 'out' ? 'in' : 'out'}\u0000${f.jsonrpcId}\u0000${f.method}`;
        const asked = sent.get(other);
        if (asked !== undefined) {
          row.elapsedMs = u.at - asked;
          sent.delete(other);
        } else {
          sent.set(key, u.at);
        }
      }
    }
    if (u.reserialized) row.label += ' (re-serialized, recorded before exact capture)';
    return row;
  });
}

export function logCounts(units: LogUnit[]): LogCounts {
  const c: LogCounts = { frames: 0, stderr: 0, app: 0, other: 0 };
  for (const u of units) {
    if (u.kind === 'stderr') c.stderr++;
    else if (u.kind === 'app') c.app++;
    else if (u.frames.length) c.frames += u.frames.length;
    else c.other++;
  }
  return c;
}

/** A time of day to the millisecond, local. */
export function clock(at: number): string {
  const d = new Date(at);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}
