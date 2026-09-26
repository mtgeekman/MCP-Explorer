// The readable pane's view of one unit (board 1A, round 4). Raw is the main
// view; this is the rendering beside it, so it may parse and indent. It says
// plainly when it cannot: a unit that is not JSON, one withheld, one too large.
import type { LogUnit } from '../../../../packages/backend/dist/index.js';
import { sseEventData } from '../../../../packages/protocol/dist/wire.js';
import { formatBytes } from './raw.ts';

/**
 * The largest unit the pane parses and indents: 10 MB, the SDK's stdio line
 * cap, so anything that can arrive can be read here (decided 2026-09-25, phase
 * 06 decision 5; it was 2 MB). The raw view holds any size whole (board 4.2B).
 * Measured in phase 07 (Windows, 2026-09-25): readable() takes 23 ms on a
 * 9.5 MB string and 70 ms on 6.6 MB of small rows; a 9.5 MB tool result is
 * shown in the pane and the transcript 1.3 s after Call (smoke test).
 */
export const READABLE_LIMIT = 10 * 1024 * 1024;

export type Readable =
  | { kind: 'withheld' }
  | { kind: 'too-large'; size: string }
  | { kind: 'json'; pretty: string; cacheHints: { name: string; value: unknown }[]; sse: boolean }
  | { kind: 'text'; text: string; why: string }
  | { kind: 'app'; fields: [string, string][] }
  | { kind: 'empty' };

const lossy = new TextDecoder('utf-8');

/**
 * Fields a list result carries that are server-chosen and change on every
 * response (spec: canonicalize by allowlist). Shown apart, so nobody reads
 * them as part of the surface.
 */
const CACHE_HINTS = ['ttlMs', 'cacheScope'];

export function readable(u: LogUnit): Readable {
  if (u.bytes === null) return { kind: 'withheld' };
  if (u.byteLength > READABLE_LIMIT) return { kind: 'too-large', size: formatBytes(u.byteLength) };
  if (u.byteLength === 0) return { kind: 'empty' };
  const text = lossy.decode(u.bytes);
  if (u.kind === 'stderr') return { kind: 'text', text, why: 'A line the server wrote to stderr.' };
  if (u.kind === 'app') {
    try {
      return { kind: 'app', fields: Object.entries(JSON.parse(text) as Record<string, unknown>).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]) };
    } catch {
      return { kind: 'text', text, why: 'An app event.' };
    }
  }
  const sse = u.http?.framing === 'sse-event';
  const payload = sse ? sseEventData(u.bytes) : text;
  if (payload === null) return { kind: 'text', text, why: 'An SSE event with no data.' };
  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return { kind: 'text', text, why: 'Not JSON, so not JSON-RPC.' };
  }
  const result = (value as { result?: Record<string, unknown> } | null)?.result;
  const cacheHints = result && typeof result === 'object' ? CACHE_HINTS.filter((k) => k in result).map((name) => ({ name, value: result[name] })) : [];
  return { kind: 'json', pretty: JSON.stringify(value, null, 2), cacheHints, sse };
}
