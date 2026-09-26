// The health check (phase 10 decision 12): one button that connects if
// needed, lists everything, pings a legacy server, and reports what the
// server is, what it supports, what it advertises and does not deliver, and
// every malformed element. Every request in it is one the user's press asked
// for; the report is shown, never stored.
import { validateAgainst, type Connection, type NormalizedSurface, type UtilityOutcome } from '../../protocol/dist/index.js';
import type { ConnectionState } from './connections.js';

export type ListState = { endpoint: string; state: 'listed'; count: number } | { endpoint: string; state: 'not-advertised' } | { endpoint: string; state: 'failed'; message: string };

export interface HealthReport {
  at: number;
  /** How the connection stands after the check tried to reach the server. */
  connection: { status: 'connected'; era: 'legacy' | 'modern'; revision: string } | { status: 'not-connected'; state: ConnectionState['status']; message: string };
  server?: { name?: string; version?: string };
  /** Each top-level capability the server declared, as declared. */
  capabilities: { name: string; value: unknown }[];
  /** Extension identifiers the server advertises (2026-07-28). */
  extensions: string[];
  /** Each list endpoint: read, not advertised, or advertised and failed. */
  lists: ListState[];
  /** Entries that break a structural rule, and repeated identity keys. */
  malformed: { endpoint: string; key?: string; message: string }[];
  /** Schemas the SDK's Ajv cannot compile. */
  schemas: { tool: string; field: 'inputSchema' | 'outputSchema'; message: string }[];
  ping: { status: 'ok'; ms: number } | { status: 'failed'; message: string } | { status: 'unavailable'; reason: string };
  /** Fields the connected revision cannot express (P3). */
  unavailable: string[];
  /** Why the capture recorded nothing, when it did not. */
  captureError?: string;
}

const LISTS: [endpoint: string, capability: string, field: keyof Pick<NormalizedSurface, 'tools' | 'prompts' | 'resources' | 'resourceTemplates'>][] = [
  ['tools/list', 'tools', 'tools'],
  ['prompts/list', 'prompts', 'prompts'],
  ['resources/list', 'resources', 'resources'],
  ['resources/templates/list', 'resources', 'resourceTemplates'],
];

/** The report for a session whose capture has run. */
export async function healthReport(conn: Connection, surface: NormalizedSurface, now: number, captureError?: string): Promise<HealthReport> {
  const caps = (surface.capabilities ?? {}) as Record<string, unknown>;
  const failed = new Map(surface.problems.filter((p) => p.kind === 'list-failed').map((p) => [p.endpoint, p.message]));
  const lists: ListState[] = LISTS.map(([endpoint, capability, field]) => {
    if (failed.has(endpoint)) return { endpoint, state: 'failed', message: failed.get(endpoint)! };
    if (caps[capability] === undefined) return { endpoint, state: 'not-advertised' };
    return { endpoint, state: 'listed', count: surface[field].length };
  });
  const schemas: HealthReport['schemas'] = [];
  for (const tool of surface.tools) {
    for (const field of ['inputSchema', 'outputSchema'] as const) {
      const schema = tool[field];
      if (schema === undefined || schema === null || typeof schema !== 'object') continue;
      const verdict = await validateAgainst(schema, {});
      if (verdict.valid === null) schemas.push({ tool: tool.name, field, message: verdict.message });
    }
  }
  let ping: HealthReport['ping'];
  if (conn.era === 'modern') {
    ping = { status: 'unavailable', reason: `ping does not exist on ${conn.revision}` };
  } else {
    const outcome: UtilityOutcome = await conn.request({ method: 'ping' });
    ping = outcome.kind === 'result' ? { status: 'ok', ms: Math.round(outcome.elapsedMs) } : { status: 'failed', message: outcome.kind === 'error' ? String(outcome.error.message) : outcome.kind === 'failed' ? outcome.message : 'cancelled' };
  }
  const extensions = caps.extensions && typeof caps.extensions === 'object' ? Object.keys(caps.extensions as object).sort() : [];
  return {
    at: now,
    connection: { status: 'connected', era: conn.era, revision: conn.revision },
    server: { ...(surface.serverName === undefined ? {} : { name: surface.serverName }), ...(surface.serverVersion === undefined ? {} : { version: surface.serverVersion }) },
    capabilities: Object.keys(caps).sort().map((name) => ({ name, value: caps[name] })),
    extensions,
    lists,
    malformed: surface.problems.filter((p) => p.kind === 'malformed' || p.kind === 'duplicate-keys').map((p) => ({ endpoint: p.endpoint, ...(p.key === undefined ? {} : { key: p.key }), message: p.message })),
    schemas,
    ping,
    unavailable: surface.unavailable,
    ...(captureError ? { captureError } : {}),
  };
}
