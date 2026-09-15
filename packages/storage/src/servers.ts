import { StorageError } from './errors.js';
import type { Workspace } from './workspace-db.js';

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
  /** Stored as plain configuration: never put a credential here. */
  env?: Record<string, string>;
  headers?: Record<string, string>;
  /** Stored as secrets. Refused for an unencrypted workspace. */
  secretEnv?: Record<string, string>;
  secretHeaders?: Record<string, string>;
}

export interface ServerSummary {
  id: string;
  name: string;
  transport: Transport;
}

/** The definition is malformed: wrong fields for its transport, a name in both plain and secret maps. */
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
  for (const [plain, secret, what] of [[def.env, def.secretEnv, 'environment variable'], [def.headers, def.secretHeaders, 'header']] as const) {
    for (const name of Object.keys(secret ?? {})) {
      if (!name) throw bad(`a secret ${what} has an empty name`);
      // One name in both maps would leave the app to guess which value the
      // server gets, and the plain one is readable on disk.
      if (plain && Object.hasOwn(plain, name)) throw bad(`${what} ${name} is both plain and secret`);
    }
  }
}

/**
 * Creates or replaces a server definition and its secrets in one transaction.
 * Protocol-era detection (D20) is kept across edits: changing a server's
 * name does not make the app probe it again.
 */
export function saveServer(ws: Workspace, def: ServerDefinition, now: () => number = Date.now): void {
  validate(def);
  if (!ws.encrypted && (hasEntries(def.secretEnv) || hasEntries(def.secretHeaders))) {
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
  return def;
}

/** Every server, without configuration or secrets, in name order. */
export function listServers(ws: Workspace): ServerSummary[] {
  return ws.db.prepare('SELECT id, name, transport FROM server ORDER BY name, id').all() as ServerSummary[];
}

/** True when the server existed. Its secrets and its whole history go with it. */
export function deleteServer(ws: Workspace, id: string): boolean {
  return ws.db.prepare('DELETE FROM server WHERE id = ?').run(id).changes > 0;
}
