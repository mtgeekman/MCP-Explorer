import { StorageError } from './errors.js';
import type { Workspace } from './workspace-db.js';
import { isAlwaysSecretHeader } from '../../protocol/dist/index.js';

/**
 * Server definitions (spec D31). Plain configuration is stored in `server`;
 * secret environment variables and headers are stored in `server_secret`,
 * which exists only to be written inside an encrypted database.
 */
export type Transport = 'stdio' | 'streamable-http' | 'sse';

export interface ServerDefinition {
  id: string;
  name: string;
  transport: Transport;
  /** stdio only. */
  command?: string;
  args?: string[];
  cwd?: string;
  /** streamable-http and sse only. */
  url?: string;
  /**
   * Stored as plain configuration: never put a credential here. A header in
   * ALWAYS_SECRET_HEADERS (Authorization, Cookie, ...) is refused.
   */
  env?: Record<string, string>;
  headers?: Record<string, string>;
  /** Stored as secrets. Refused for an unencrypted workspace. */
  secretEnv?: Record<string, string>;
  secretHeaders?: Record<string, string>;
  /**
   * Secrets this server needs whose values are not stored: every secret of a
   * server in an unencrypted workspace, whose values the app asks for each
   * session (D31, amended 2026-09-24). Names only; a name is not a secret.
   */
  unstoredSecrets?: SecretNames;
  /**
   * streamable-http and sse only: a client registered with the server's
   * authorization server by hand (plan phase 11 decision 6). Its secret is
   * a secret: refused for an unencrypted workspace.
   */
  oauthClient?: OAuthClientConfig;
}

export interface OAuthClientConfig {
  clientId: string;
  /** A loopback redirect, http://127.0.0.1:<port>/..., exactly as registered. */
  redirectUri: string;
  clientSecret?: string;
}

/** A loopback redirect with an explicit port: RFC 8252 §7.3, and the MCP rule that allows plain http there. */
function isLoopbackRedirect(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  return u.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(u.hostname) && u.port !== '';
}

export interface SecretNames {
  env?: string[];
  headers?: string[];
}

export interface ServerSummary {
  id: string;
  name: string;
  transport: Transport;
}

/** The definition is malformed: wrong fields for its transport, a name in both plain and secret maps, a credential header stored plain. */
export class InvalidServerDefinitionError extends StorageError {}

/** A secret was about to be written to a workspace that is not encrypted (D31). */
export class SecretsRequireEncryptionError extends StorageError {}

const hasEntries = (m?: Record<string, string>) => m !== undefined && Object.keys(m).length > 0;

function validate(def: ServerDefinition): void {
  const bad = (why: string) => new InvalidServerDefinitionError(`server ${def.id || '(no id)'}: ${why}`);
  if (!def.id) throw bad('id is empty');
  if (!def.name) throw bad('name is empty');
  if (def.transport === 'stdio') {
    if (!def.command) throw bad('a stdio server needs a command');
    if (def.url !== undefined) throw bad('a stdio server has no url');
    if (def.headers !== undefined || def.secretHeaders !== undefined) throw bad('a stdio server has no HTTP headers');
  } else if (def.transport === 'streamable-http' || def.transport === 'sse') {
    if (!def.url) throw bad(`a ${def.transport} server needs a url`);
    if (def.command !== undefined || def.args !== undefined || def.cwd !== undefined) throw bad(`a ${def.transport} server has no command, args or cwd`);
  } else {
    throw bad(`unknown transport ${String(def.transport)}`);
  }
  if (def.transport === 'stdio' && hasNames(def.unstoredSecrets?.headers)) throw bad('a stdio server has no HTTP headers');
  if (def.oauthClient !== undefined) {
    if (def.transport === 'stdio') throw bad('a stdio server has no OAuth client');
    if (!def.oauthClient.clientId) throw bad('an OAuth client needs a client id');
    if (!isLoopbackRedirect(def.oauthClient.redirectUri)) throw bad('the OAuth client redirect URI must be http on 127.0.0.1, [::1] or localhost, with a port');
  }
  const lists = [
    [def.env, def.secretEnv, def.unstoredSecrets?.env, 'environment variable'],
    [def.headers, def.secretHeaders, def.unstoredSecrets?.headers, 'header'],
  ] as const;
  for (const [plain, secret, unstored, what] of lists) {
    // Header names are case-insensitive (RFC 9110 §5.1): fetch merges X-Key
    // and x-key into one "a, b" value. Environment names are not, as on Linux.
    const key = what === 'header' ? (n: string) => n.trim().toLowerCase() : (n: string) => n;
    const plainKeys = new Set<string>();
    for (const name of Object.keys(plain ?? {})) {
      if (plainKeys.has(key(name))) throw bad(`${what} ${name} is given twice`);
      plainKeys.add(key(name));
    }
    const seen = new Set<string>();
    for (const name of [...Object.keys(secret ?? {}), ...(unstored ?? [])]) {
      if (!name) throw bad(`a secret ${what} has an empty name`);
      // One name in two places would leave the app to guess which value the
      // server gets, and a plain one is readable on disk.
      if (plainKeys.has(key(name))) throw bad(`${what} ${name} is both plain and secret`);
      if (seen.has(key(name))) throw bad(`secret ${what} ${name} is given twice`);
      seen.add(key(name));
    }
  }
  // The wire log redacts these whether or not they were marked (D35); stored
  // plain, the value would be readable on disk in an unencrypted workspace.
  for (const name of Object.keys(def.headers ?? {})) {
    if (isAlwaysSecretHeader(name)) throw bad(`header ${name} is a credential, so it can only be stored as a secret`);
  }
}

const hasNames = (names?: string[]) => names !== undefined && names.length > 0;

/**
 * Creates or replaces a server definition and its secrets in one transaction.
 * Protocol-era detection (D20) is kept across edits: changing a server's
 * name does not make the app probe it again.
 */
export function saveServer(ws: Workspace, def: ServerDefinition, now: () => number = Date.now): void {
  validate(def);
  if (!ws.encrypted && (hasEntries(def.secretEnv) || hasEntries(def.secretHeaders) || def.oauthClient?.clientSecret)) {
    throw new SecretsRequireEncryptionError(`server ${def.id}: this workspace is not encrypted, so its secrets cannot be saved; enter them when connecting instead`);
  }
  const at = now();
  const json = (v: unknown) => (v === undefined ? null : JSON.stringify(v));
  ws.db.transaction(() => {
    ws.db.prepare(`
      INSERT INTO server (id, name, transport, command, args_json, cwd, url, env_json, headers_json, created_at)
      VALUES (@id, @name, @transport, @command, @args, @cwd, @url, @env, @headers, @at)
      ON CONFLICT (id) DO UPDATE SET
        name = excluded.name, transport = excluded.transport, command = excluded.command,
        args_json = excluded.args_json, cwd = excluded.cwd, url = excluded.url,
        env_json = excluded.env_json, headers_json = excluded.headers_json
    `).run({
      id: def.id, name: def.name, transport: def.transport, command: def.command ?? null,
      args: json(def.args), cwd: def.cwd ?? null, url: def.url ?? null,
      env: json(def.env), headers: json(def.headers), at,
    });
    ws.db.prepare('DELETE FROM server_secret WHERE server_id = ?').run(def.id);
    const insert = ws.db.prepare('INSERT INTO server_secret (server_id, kind, name, value, updated_at) VALUES (?, ?, ?, ?, ?)');
    for (const [name, value] of Object.entries(def.secretEnv ?? {})) insert.run(def.id, 'env', name, value, at);
    for (const [name, value] of Object.entries(def.secretHeaders ?? {})) insert.run(def.id, 'header', name, value, at);
    ws.db.prepare('DELETE FROM server_secret_name WHERE server_id = ?').run(def.id);
    const insertName = ws.db.prepare('INSERT INTO server_secret_name (server_id, kind, name) VALUES (?, ?, ?)');
    for (const name of def.unstoredSecrets?.env ?? []) insertName.run(def.id, 'env', name);
    for (const name of def.unstoredSecrets?.headers ?? []) insertName.run(def.id, 'header', name);
    ws.db.prepare('DELETE FROM server_oauth_client WHERE server_id = ?').run(def.id);
    const c = def.oauthClient;
    if (c) ws.db.prepare('INSERT INTO server_oauth_client (server_id, client_id, redirect_uri, client_secret) VALUES (?, ?, ?, ?)').run(def.id, c.clientId, c.redirectUri, c.clientSecret ?? null);
  })();
}

interface ServerRow {
  id: string; name: string; transport: Transport; command: string | null; args_json: string | null;
  cwd: string | null; url: string | null; env_json: string | null; headers_json: string | null;
}

/** The full definition with its secrets, or null when no such server exists. */
export function loadServer(ws: Workspace, id: string): ServerDefinition | null {
  const row = ws.db.prepare('SELECT id, name, transport, command, args_json, cwd, url, env_json, headers_json FROM server WHERE id = ?').get(id) as ServerRow | undefined;
  if (!row) return null;
  const def: ServerDefinition = { id: row.id, name: row.name, transport: row.transport };
  if (row.command !== null) def.command = row.command;
  if (row.args_json !== null) def.args = JSON.parse(row.args_json);
  if (row.cwd !== null) def.cwd = row.cwd;
  if (row.url !== null) def.url = row.url;
  if (row.env_json !== null) def.env = JSON.parse(row.env_json);
  if (row.headers_json !== null) def.headers = JSON.parse(row.headers_json);
  const secrets = ws.db.prepare('SELECT kind, name, value FROM server_secret WHERE server_id = ? ORDER BY kind, name').all(id) as { kind: 'env' | 'header'; name: string; value: string }[];
  for (const s of secrets) {
    const map = s.kind === 'env' ? (def.secretEnv ??= {}) : (def.secretHeaders ??= {});
    map[s.name] = s.value;
  }
  const names = ws.db.prepare('SELECT kind, name FROM server_secret_name WHERE server_id = ? ORDER BY kind, name').all(id) as { kind: 'env' | 'header'; name: string }[];
  for (const n of names) {
    const unstored = (def.unstoredSecrets ??= {});
    (n.kind === 'env' ? (unstored.env ??= []) : (unstored.headers ??= [])).push(n.name);
  }
  const client = ws.db.prepare('SELECT client_id, redirect_uri, client_secret FROM server_oauth_client WHERE server_id = ?').get(id) as { client_id: string; redirect_uri: string; client_secret: string | null } | undefined;
  if (client) def.oauthClient = { clientId: client.client_id, redirectUri: client.redirect_uri, ...(client.client_secret !== null ? { clientSecret: client.client_secret } : {}) };
  return def;
}

/** Every server, without configuration or secrets, in name order. */
export function listServers(ws: Workspace): ServerSummary[] {
  return ws.db.prepare('SELECT id, name, transport FROM server ORDER BY name, id').all() as ServerSummary[];
}

/** The protocol era a server was last seen to speak, pinned on its definition (D20). */
export interface DetectedEra {
  era: 'legacy' | 'modern';
  /** Null when the era was inferred without a handshake: a server that died on the probe is pinned legacy before it has answered one. */
  revision: string | null;
  detectedAt: number;
}

export function readDetectedEra(ws: Workspace, id: string): DetectedEra | null {
  const row = ws.db.prepare('SELECT detected_era, detected_revision, era_detected_at FROM server WHERE id = ?').get(id) as
    { detected_era: 'legacy' | 'modern' | null; detected_revision: string | null; era_detected_at: number | null } | undefined;
  if (!row || row.detected_era === null) return null;
  return { era: row.detected_era, revision: row.detected_revision, detectedAt: row.era_detected_at ?? 0 };
}

/** Pins the era; later connects use it instead of probing (D20). */
export function pinEra(ws: Workspace, id: string, era: 'legacy' | 'modern', revision: string | null, now: () => number = Date.now): void {
  ws.db.prepare('UPDATE server SET detected_era = ?, detected_revision = ?, era_detected_at = ? WHERE id = ?').run(era, revision, now(), id);
}

/** Forgets the pinned era, so the next connect probes: the user's explicit re-detect (D20). */
export function clearEra(ws: Workspace, id: string): void {
  ws.db.prepare('UPDATE server SET detected_era = NULL, detected_revision = NULL, era_detected_at = NULL WHERE id = ?').run(id);
}

/** True when the server existed. Its secrets and its whole history go with it. */
export function deleteServer(ws: Workspace, id: string): boolean {
  return ws.db.prepare('DELETE FROM server WHERE id = ?').run(id).changes > 0;
}
