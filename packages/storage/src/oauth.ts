import { SecretsRequireEncryptionError } from './servers.js';
import type { Workspace } from './workspace-db.js';

/**
 * What a sign-in produced for one server and one authorization server (plan
 * phase 11 decision 7). The client and tokens are kept as the protocol
 * package shapes them; storage does not read inside them.
 */
export interface StoredGrant {
  issuer: string;
  /** The authorization server's URL as discovery found it. */
  authServer: string;
  /** The RFC 8707 resource the tokens were issued for, when one was named. */
  resource?: string;
  client: Record<string, unknown>;
  /** Absent once the tokens are forgotten and the registration kept. */
  tokens?: Record<string, unknown>;
  updatedAt: number;
}

/**
 * Stores a grant, replacing the one for the same issuer. Tokens and a client
 * secret are secrets, so an unencrypted workspace refuses (D31); the backend
 * holds its grants in memory instead.
 */
export function saveGrant(ws: Workspace, serverId: string, grant: Omit<StoredGrant, 'updatedAt'>, now: () => number = Date.now): void {
  if (!ws.encrypted) throw new SecretsRequireEncryptionError(`server ${serverId}: this workspace is not encrypted, so a sign-in is kept for this session only`);
  ws.db.prepare(`
    INSERT INTO server_oauth (server_id, issuer, auth_server, resource, client_json, tokens_json, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (server_id, issuer) DO UPDATE SET
      auth_server = excluded.auth_server, resource = excluded.resource, client_json = excluded.client_json,
      tokens_json = excluded.tokens_json, updated_at = excluded.updated_at
  `).run(serverId, grant.issuer, grant.authServer, grant.resource ?? null, JSON.stringify(grant.client), grant.tokens ? JSON.stringify(grant.tokens) : null, now());
}

interface GrantRow { issuer: string; auth_server: string; resource: string | null; client_json: string; tokens_json: string | null; updated_at: number }

const fromRow = (r: GrantRow): StoredGrant => ({
  issuer: r.issuer, authServer: r.auth_server, client: JSON.parse(r.client_json), updatedAt: r.updated_at,
  ...(r.resource !== null ? { resource: r.resource } : {}),
  ...(r.tokens_json !== null ? { tokens: JSON.parse(r.tokens_json) } : {}),
});

/** The grant last written for this server, whichever issuer it is under, or null. */
export function loadGrant(ws: Workspace, serverId: string): StoredGrant | null {
  const row = ws.db.prepare('SELECT issuer, auth_server, resource, client_json, tokens_json, updated_at FROM server_oauth WHERE server_id = ? ORDER BY updated_at DESC, issuer LIMIT 1').get(serverId) as GrantRow | undefined;
  return row ? fromRow(row) : null;
}

/** The grant for one issuer: a registration to reuse with that authorization server. */
export function loadGrantFor(ws: Workspace, serverId: string, issuer: string): StoredGrant | null {
  const row = ws.db.prepare('SELECT issuer, auth_server, resource, client_json, tokens_json, updated_at FROM server_oauth WHERE server_id = ? AND issuer = ?').get(serverId, issuer) as GrantRow | undefined;
  return row ? fromRow(row) : null;
}

/**
 * Sign out: forgets every grant's tokens and, with `registrations`, the
 * registrations too. Returns how many rows it touched.
 */
export function forgetGrants(ws: Workspace, serverId: string, registrations = false): number {
  return registrations
    ? ws.db.prepare('DELETE FROM server_oauth WHERE server_id = ?').run(serverId).changes
    : ws.db.prepare('UPDATE server_oauth SET tokens_json = NULL WHERE server_id = ? AND tokens_json IS NOT NULL').run(serverId).changes;
}
